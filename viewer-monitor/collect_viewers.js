// viewer-monitor/collect_viewers.js
// GitHub Actions 자동 실행용. 로컬 credentials.json 대신
// 환경변수(GitHub Secrets)로 인증정보를 받습니다.
//
// 필요한 환경변수:
//   GOOGLE_SERVICE_ACCOUNT_JSON  -> 서비스계정 키 파일 내용 전체(JSON 텍스트)
//   VIEWER_SPREADSHEET_ID        -> 이 모니터링 전용 새 스프레드시트 ID
//   SLACK_WEBHOOK_URL            -> 슬랙 알림용 (없으면 알림만 건너뜀)

const { chromium } = require('playwright');
const { google } = require('googleapis');

// ===== 설정 =====
const LISTING_URLS = [
  'https://www.musinsa.com/brand/codegraphy/products?tag=26FALL&gf=A',
  'https://www.musinsa.com/brand/codegraphy/products?tag=26WINTER&gf=A',
];
const SPREADSHEET_ID = process.env.VIEWER_SPREADSHEET_ID;
// (이 아래 SHEET_NAME, SNAPSHOT_SHEET 등은 그대로 두세요)
const SHEET_NAME = '시트1';              // 기록용 탭 (A~H열)
const SNAPSHOT_SHEET = '좋아요_현황';     // 직전 좋아요 값 보관 탭 (없으면 자동 생성)
const VIEWER_THRESHOLD = 50;             // 보는인원 알림 기준
const LIKE_SPIKE_THRESHOLD = 10;         // 30분간 좋아요가 이만큼 늘면 별도 알림
const BRAND_LABEL = '코드그라피';
const LIKE_API = 'https://like.musinsa.com/like/api/v2/liketypes/goods/counts';
const LIKE_CHUNK = 30;                   // 좋아요 API 한 번에 물어볼 상품 수
// ================

function productUrl(code) {
  return `https://www.musinsa.com/products/${code}`;
}

function numOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function nowKST() {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return { date: now.toISOString().slice(0, 10), time: now.toISOString().slice(11, 16) };
}

// 'YYYY-MM-DD' -> 'MM/DD'
function shortDate(date) {
  return date.slice(5).replace('-', '/');
}

// 증감을 '+7' / '-2' / '0' 형태로
function signed(n) {
  if (n === null) return '';
  return n > 0 ? `+${n}` : String(n);
}

// ─────────────────────────────────────────────────────────
// 1. 리스팅 페이지에서 상품 목록(코드+이름) 수집 (가상 스크롤 대응)
// ─────────────────────────────────────────────────────────
async function getProductList(page) {
  console.log('[1/4] 상품 목록 수집 중...');
  await page.goto(LISTING_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  try {
    await page.waitForSelector('a[href*="/products/"]', { timeout: 20000 });
  } catch (e) {
    console.log('   [경고] 20초 내에 상품 링크를 못 찾았어요.');
  }

  const products = new Map();
  let prevCount = 0;
  let stableRounds = 0;
  let round = 0;

  while (stableRounds < 4 && round < 40) {
    round++;
    const items = await page.$$eval('a[href*="/products/"]', (links) => {
      return links.map((a) => {
        const href = a.getAttribute('href') || '';
        const match = href.match(/\/products\/(\d+)/);
        if (!match) return null;
        const img = a.querySelector('img');
        const name = img ? img.getAttribute('alt') : null;
        return { code: match[1], name: name || '' };
      }).filter(Boolean);
    });

    items.forEach((item) => {
      if (item.code && !products.has(item.code)) {
        products.set(item.code, item.name);
      }
    });

    if (products.size === prevCount) {
      stableRounds++;
    } else {
      stableRounds = 0;
      prevCount = products.size;
    }

    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.5));
    await page.waitForTimeout(1200);
  }

  console.log(`   -> 최종 ${products.size}개 상품 수집 완료`);
  return Array.from(products.entries()).map(([code, name]) => ({ code, name }));
}

// ─────────────────────────────────────────────────────────
// 2. 좋아요 수를 API로 한 번에 수집 (페이지 열지 않음, 로그인 불필요)
//    화면 표시값은 "1.7천"처럼 축약되므로 반드시 API로 가져와야 정확함
// ─────────────────────────────────────────────────────────
async function fetchLikes(codes) {
  console.log('[2/4] 좋아요 수 수집 중 (API)...');
  const result = new Map();

  for (let i = 0; i < codes.length; i += LIKE_CHUNK) {
    const chunk = codes.slice(i, i + LIKE_CHUNK).map(Number);
    try {
      const res = await fetch(LIKE_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relationIds: chunk }),
      });
      if (!res.ok) {
        console.log(`   [경고] 좋아요 API 응답 오류 (status: ${res.status})`);
        continue;
      }
      const json = await res.json();
      const items = json?.data?.contents?.items || [];
      items.forEach((it) => result.set(String(it.relationId), it.count));
    } catch (e) {
      console.log(`   [경고] 좋아요 API 호출 실패: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 300)); // 서버 배려용 짧은 간격
  }

  console.log(`   -> ${result.size}/${codes.length}개 좋아요 수집 완료`);
  return result;
}

// ─────────────────────────────────────────────────────────
// 3. 상품 상세페이지에서 "N명이 보고 있어요" 값 추출
// ─────────────────────────────────────────────────────────
async function checkViewer(page, code) {
  try {
    await page.goto(productUrl(code), { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    const bodyText = await page.evaluate(() => document.body.innerText);
    const match = bodyText.match(/(\d+)\s*명이\s*보고\s*있어요/);
    return match ? parseInt(match[1], 10) : 0;
  } catch (e) {
    console.log(`   [경고] ${code} 확인 실패: ${e.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────
// 구글시트 공통
// ─────────────────────────────────────────────────────────
function getSheets() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

// 좋아요_현황 탭이 없으면 만들어 줍니다
async function ensureSnapshotSheet(sheets) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const exists = (meta.data.sheets || []).some(
    (s) => s.properties && s.properties.title === SNAPSHOT_SHEET
  );
  if (exists) return;

  console.log(`   [안내] '${SNAPSHOT_SHEET}' 탭이 없어서 새로 만듭니다.`);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title: SNAPSHOT_SHEET } } }] },
  });
}

// 직전 회차 좋아요 값 읽기
async function readSnapshot(sheets) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SNAPSHOT_SHEET}!A2:J`,
    });
    const map = new Map();
    (res.data.values || []).forEach((r) => {
      const code = String(r[0] || '').trim();
      if (!code) return;
      map.set(code, {
        date: r[2] || '',
        like: numOrNull(r[4]),      // E열: 그때의 현재 좋아요
        todayBase: numOrNull(r[7]), // H열: 오늘 00시 기준값
      });
    });
    console.log(`   -> 직전 기록 ${map.size}개 불러옴`);
    return map;
  } catch (e) {
    console.log(`   [안내] 직전 기록을 못 읽었어요 (첫 실행이면 정상): ${e.message}`);
    return new Map();
  }
}

// 좋아요_현황 탭 통째로 덮어쓰기 (61행 고정이라 용량이 안 늘어남)
async function writeSnapshot(sheets, all) {
  const header = [
    '상품번호', '상품명', '날짜', '시간',
    '현재 좋아요', '직전 좋아요', '30분 증감',
    '오늘 00시 좋아요', '오늘 증가분', '최근 보는 사람 수',
  ];
  const rows = all.map((p) => [
    p.code, p.name, p.date, p.time,
    p.like ?? '', p.prevLike ?? '', p.delta ?? '',
    p.todayBase ?? '', p.todayDelta ?? '', p.viewers ?? '',
  ]);

  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SNAPSHOT_SHEET}!A:J`,
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SNAPSHOT_SHEET}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [header, ...rows] },
  });
  console.log(`   -> '${SNAPSHOT_SHEET}' 탭 ${rows.length}행 갱신 완료`);
}

// 기록용 탭에 추가 (A~H열)
async function appendLog(sheets, rows) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:H`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rows },
  });
  console.log(`   -> '${SHEET_NAME}' 탭에 ${rows.length}개 행 기록 완료`);
}

// ─────────────────────────────────────────────────────────
// 4. 슬랙 알림
// ─────────────────────────────────────────────────────────
async function sendSlackAlert(hot, spikes, stamp) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    console.log('   [안내] SLACK_WEBHOOK_URL이 없어서 슬랙 알림은 건너뜁니다.');
    return;
  }
  if (hot.length === 0 && spikes.length === 0) return;

  console.log('[슬랙] 알림 발송 중...');
  const blocks = [];

  if (hot.length > 0) {
    const sorted = [...hot].sort((a, b) => b.viewers - a.viewers);
    const totalViewers = sorted.reduce((sum, h) => sum + h.viewers, 0);

    const lines = sorted.map((h, i) => {
      const likePart =
        h.like === null ? '' :
        `  ·  ♥ ${h.like.toLocaleString('ko-KR')}${h.delta ? ` (${signed(h.delta)})` : ''}`;
      return `${i + 1}. *<${h.url}|${h.name}>* — *${h.viewers}명*${likePart}`;
    }).join('\n');

    blocks.push(
      `🔥 ${BRAND_LABEL} 실시간 시청자 ${VIEWER_THRESHOLD}명 이상 (${shortDate(stamp.date)} ${stamp.time} 기준)\n\n` +
      `총 ${sorted.length}개 상품 · 합계 ${totalViewers.toLocaleString('ko-KR')}명\n\n${lines}`
    );
  }

  if (spikes.length > 0) {
    const sorted = [...spikes].sort((a, b) => b.delta - a.delta);
    const lines = sorted.map((h, i) =>
      `${i + 1}. *<${h.url}|${h.name}>* — ♥ ${h.like.toLocaleString('ko-KR')} *(${signed(h.delta)})*  ·  ${h.viewers ?? '-'}명 보는 중`
    ).join('\n');

    blocks.push(
      `💗 좋아요 급등 (30분간 +${LIKE_SPIKE_THRESHOLD} 이상)\n\n${lines}`
    );
  }

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: blocks.join('\n\n───────────────\n\n') }),
  });

  if (res.ok) console.log('   -> 슬랙 알림 발송 완료');
  else console.log(`   [경고] 슬랙 발송 실패 (status: ${res.status})`);
}

// ─────────────────────────────────────────────────────────
async function main() {
  if (!SPREADSHEET_ID) throw new Error('VIEWER_SPREADSHEET_ID 환경변수가 없습니다.');
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON 환경변수가 없습니다.');

  const sheets = getSheets();
  await ensureSnapshotSheet(sheets);
  const prevMap = await readSnapshot(sheets);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  const productList = await getProductList(page);
  const likeMap = await fetchLikes(productList.map((p) => p.code));

  console.log('[3/4] 각 상품 보는인원 확인 중...');
  const stamp = nowKST();
  const all = [];

  for (let i = 0; i < productList.length; i++) {
    const { code, name } = productList[i];
    const viewers = await checkViewer(page, code);
    const like = likeMap.has(code) ? likeMap.get(code) : null;

    const prev = prevMap.get(code);
    const prevLike = prev ? prev.like : null;
    const delta = (like !== null && prevLike !== null) ? like - prevLike : null;

    // 오늘 00시 기준값: 날짜가 바뀌었거나 기록이 없으면 지금 값으로 새로 잡음
    let todayBase;
    if (!prev || prev.date !== stamp.date || prev.todayBase === null) {
      todayBase = like;
    } else {
      todayBase = prev.todayBase;
    }
    const todayDelta = (like !== null && todayBase !== null) ? like - todayBase : null;

    const likeLog = like === null ? '?' : `♥${like}${delta !== null ? `(${signed(delta)})` : ''}`;
    console.log(`   (${i + 1}/${productList.length}) ${code} ${name} -> ${viewers}명  ${likeLog}`);

    all.push({
      code, name, viewers, like, prevLike, delta, todayBase, todayDelta,
      date: stamp.date, time: stamp.time, url: productUrl(code),
    });
  }

  await browser.close();

  console.log('[4/4] 구글시트에 기록 중...');

  // 보는인원 기준 통과한 상품만 기록용 탭에 남김 (전체를 다 쌓으면 너무 빨리 커짐)
  const hot = all.filter((p) => typeof p.viewers === 'number' && p.viewers >= VIEWER_THRESHOLD);
  const logRows = hot.map((p) => [
    p.code, p.name, p.date, p.time, p.viewers,
    p.like ?? '', p.delta ?? '', p.todayDelta ?? '',
  ]);

  if (logRows.length > 0) await appendLog(sheets, logRows);
  else console.log(`   -> ${VIEWER_THRESHOLD}명 이상인 상품이 없어서 기록은 건너뜁니다.`);

  await writeSnapshot(sheets, all);

  // 보는인원은 기준 미달이지만 좋아요가 확 붙은 상품
  const spikes = all.filter(
    (p) => p.delta !== null && p.delta >= LIKE_SPIKE_THRESHOLD && !hot.includes(p)
  );

  if (hot.length > 0) {
    const totalViewers = hot.reduce((sum, h) => sum + h.viewers, 0);
    console.log(`\n🔥 ${VIEWER_THRESHOLD}명 이상 보는 상품 ${hot.length}개 · 합계 ${totalViewers}명`);
  } else {
    console.log(`\n${VIEWER_THRESHOLD}명 이상 보는 상품 없음`);
  }
  if (spikes.length > 0) console.log(`💗 좋아요 급등 상품 ${spikes.length}개`);

  await sendSlackAlert(hot, spikes, stamp);
}

main().catch((err) => {
  console.error('에러 발생:', err);
  process.exit(1);
});
