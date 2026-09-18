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
const SHEET_NAME = '시트1';              // 기록용 탭 (A~H열)
const SNAPSHOT_SHEET = '좋아요_현황';     // 직전 좋아요 값 보관 탭 (없으면 자동 생성)
const MISSING_SHEET = '품절_추적';        // 리스팅에서 사라진 상품 보관 탭 (없으면 자동 생성)
const VIEWER_THRESHOLD = 50;             // 보는인원 알림 기준
const LIKE_SPIKE_THRESHOLD = 10;         // 30분간 좋아요가 이만큼 늘면 별도 알림
const MISSING_KEEP_DAYS = 30;            // 이 기간 넘게 안 돌아오면 추적 목록에서 제거
const DROP_GUARD_RATIO = 0.2;            // 상품 수가 직전 대비 이 비율 넘게 줄면 품절 판정 건너뜀
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

// 두 날짜 사이 일수
function daysBetween(fromDate, toDate) {
  const a = new Date(`${fromDate}T00:00:00Z`);
  const b = new Date(`${toDate}T00:00:00Z`);
  if (isNaN(a) || isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

// 증감을 '+7' / '-2' / '0' 형태로
function signed(n) {
  if (n === null) return '';
  return n > 0 ? `+${n}` : String(n);
}

// ─────────────────────────────────────────────────────────
// 1. 리스팅 페이지에서 상품 목록(코드+이름) 수집 (가상 스크롤 대응)
// ─────────────────────────────────────────────────────────
async function getProductList(page, listingUrl) {
  console.log(`[1/5] 상품 목록 수집 중... (${listingUrl})`);
  await page.goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

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
  console.log('[2/5] 좋아요 수 수집 중 (API)...');
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

// 리스팅에서 사라진 상품이 "품절"인지 다른 사유인지 상세페이지로 판별
async function classifyMissing(page, code) {
  try {
    const res = await page.goto(productUrl(code), { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2500);

    if (res && res.status() >= 400) return '페이지없음';

    const bodyText = await page.evaluate(() => document.body.innerText);
    if (/품절|재입고\s*알림|SOLD\s*OUT/i.test(bodyText)) return '전체품절';
    if (/판매\s*(중지|종료)|판매하지\s*않는|존재하지\s*않/i.test(bodyText)) return '판매중지';
    return '확인필요';
  } catch (e) {
    return '확인필요';
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

// 필요한 탭이 없으면 만들어 줍니다
async function ensureSheets(sheets, titles) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const existing = (meta.data.sheets || []).map((s) => s.properties && s.properties.title);
  const missing = titles.filter((t) => !existing.includes(t));
  if (missing.length === 0) return;

  console.log(`   [안내] 없는 탭을 새로 만듭니다: ${missing.join(', ')}`);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: missing.map((title) => ({ addSheet: { properties: { title } } })),
    },
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
        name: r[1] || '',
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

// 좋아요_현황 탭 통째로 덮어쓰기 (행 수가 고정이라 용량이 안 늘어남)
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

// 품절_추적 탭 읽기 (현재 리스팅에서 빠져있는 상품들)
async function readMissing(sheets) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${MISSING_SHEET}!A2:F`,
    });
    const map = new Map();
    (res.data.values || []).forEach((r) => {
      const code = String(r[0] || '').trim();
      if (!code) return;
      map.set(code, {
        name: r[1] || '',
        date: r[2] || '',
        time: r[3] || '',
        reason: r[4] || '',
        like: numOrNull(r[5]),
      });
    });
    return map;
  } catch (e) {
    return new Map();
  }
}

// 품절_추적 탭 덮어쓰기
async function writeMissing(sheets, missingMap) {
  const header = ['상품번호', '상품명', '사라진 날짜', '사라진 시간', '구분', '마지막 좋아요'];
  const rows = Array.from(missingMap.entries()).map(([code, m]) => [
    code, m.name, m.date, m.time, m.reason, m.like ?? '',
  ]);

  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: `${MISSING_SHEET}!A:F`,
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${MISSING_SHEET}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [header, ...rows] },
  });
  console.log(`   -> '${MISSING_SHEET}' 탭 ${rows.length}행 갱신 완료`);
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
async function sendSlackAlert({ hot, spikes, soldOut, needCheck, returned, stamp }) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    console.log('   [안내] SLACK_WEBHOOK_URL이 없어서 슬랙 알림은 건너뜁니다.');
    return;
  }
  const nothing =
    hot.length === 0 && spikes.length === 0 &&
    soldOut.length === 0 && needCheck.length === 0 && returned.length === 0;
  if (nothing) return;

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

    blocks.push(`💗 좋아요 급등 (30분간 +${LIKE_SPIKE_THRESHOLD} 이상)\n\n${lines}`);
  }

  if (soldOut.length > 0) {
    const sorted = [...soldOut].sort((a, b) => (b.like ?? 0) - (a.like ?? 0));
    const lines = sorted.map((m, i) =>
      `${i + 1}. *<${productUrl(m.code)}|${m.name}>*` +
      (m.like !== null ? `  ·  ♥ ${m.like.toLocaleString('ko-KR')}` : '')
    ).join('\n');

    blocks.push(`🚨 전체 품절로 내려감 — 재고 추가 검토\n\n${lines}`);
  }

  if (needCheck.length > 0) {
    const lines = needCheck.map((m, i) =>
      `${i + 1}. *<${productUrl(m.code)}|${m.name}>* — ${m.reason}`
    ).join('\n');

    blocks.push(`⚠️ 리스팅에서 사라짐 — 사유 확인 필요\n\n${lines}`);
  }

  if (returned.length > 0) {
    const lines = returned.map((m, i) => {
      const days = daysBetween(m.date, stamp.date);
      const gap = days === null ? '' : (days === 0 ? ' (당일)' : ` (${days}일 만에)`);
      return `${i + 1}. *<${productUrl(m.code)}|${m.name}>*${gap}`;
    }).join('\n');

    blocks.push(`↩️ 다시 올라옴 — 재입고 반영됨\n\n${lines}`);
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
  await ensureSheets(sheets, [SNAPSHOT_SHEET, MISSING_SHEET]);
  const prevMap = await readSnapshot(sheets);
  const missingMap = await readMissing(sheets);
  console.log(`   -> 현재 추적 중인 사라진 상품 ${missingMap.size}개`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  // ★ 다중 URL 처리: 26FALL과 26WINTER 모두 수집
  const productList = [];
  for (const listingUrl of LISTING_URLS) {
    const products = await getProductList(page, listingUrl);
    productList.push(...products);
  }

  // ★ 중복 제거 (같은 상품이 여러 태그에 있을 수 있음)
  const uniqueProducts = Array.from(
    new Map(productList.map((p) => [p.code, p])).values()
  );
  console.log(`   -> 총 ${uniqueProducts.length}개 상품 (중복 제거 후)\n`);

  const likeMap = await fetchLikes(uniqueProducts.map((p) => p.code));

  console.log('[3/5] 각 상품 보는인원 확인 중...');
  const stamp = nowKST();
  const all = [];

  for (let i = 0; i < uniqueProducts.length; i++) {
    const { code, name } = uniqueProducts[i];
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
    console.log(`   (${i + 1}/${uniqueProducts.length}) ${code} ${name} -> ${viewers}명  ${likeLog}`);

    all.push({
      code, name, viewers, like, prevLike, delta, todayBase, todayDelta,
      date: stamp.date, time: stamp.time, url: productUrl(code),
    });
  }

  // ─── 사라진 상품 / 돌아온 상품 판정 ───────────────────────
  console.log('[4/5] 사라진 상품 확인 중...');
  const currentCodes = new Set(uniqueProducts.map((p) => p.code));
  const soldOut = [];
  const needCheck = [];
  const returned = [];

  // 돌아온 상품: 추적 목록에 있었는데 이번 리스팅에 다시 나타남
  for (const [code, m] of Array.from(missingMap.entries())) {
    if (currentCodes.has(code)) {
      returned.push({ code, ...m });
      missingMap.delete(code);
    }
  }

  // 새로 사라진 상품 (단, 수집이 덜 된 회차에서는 건너뜀)
  const prevCount = prevMap.size;
  const dropRatio = prevCount > 0 ? (prevCount - uniqueProducts.length) / prevCount : 0;

  if (prevCount === 0) {
    console.log('   [안내] 직전 기록이 없어 품절 판정은 다음 회차부터 합니다.');
  } else if (dropRatio > DROP_GUARD_RATIO) {
    console.log(
      `   [주의] 상품 수가 직전 ${prevCount}개 → ${uniqueProducts.length}개로 크게 줄어` +
      ` 수집 실패로 보고 품절 판정을 건너뜁니다.`
    );
  } else {
    const disappeared = Array.from(prevMap.entries()).filter(
      ([code]) => !currentCodes.has(code) && !missingMap.has(code)
    );

    for (const [code, prev] of disappeared) {
      const reason = await classifyMissing(page, code);
      const entry = {
        name: prev.name || code,
        date: stamp.date,
        time: stamp.time,
        reason,
        like: prev.like,
      };
      missingMap.set(code, entry);
      console.log(`   - ${code} ${entry.name} -> ${reason}`);

      if (reason === '전체품절') soldOut.push({ code, ...entry });
      else needCheck.push({ code, ...entry });
    }
    if (disappeared.length === 0) console.log('   -> 새로 사라진 상품 없음');
  }

  // 오래된 추적 항목 정리
  for (const [code, m] of Array.from(missingMap.entries())) {
    const days = daysBetween(m.date, stamp.date);
    if (days !== null && days > MISSING_KEEP_DAYS) {
      missingMap.delete(code);
      console.log(`   - ${code} ${m.name}: ${MISSING_KEEP_DAYS}일 경과로 추적 종료`);
    }
  }

  await browser.close();

  // ─── 시트 기록 ──────────────────────────────────────────
  console.log('[5/5] 구글시트에 기록 중...');

  // 보는인원 기준 통과한 상품만 기록용 탭에 남김 (전체를 다 쌓으면 너무 빨리 커짐)
  const hot = all.filter((p) => typeof p.viewers === 'number' && p.viewers >= VIEWER_THRESHOLD);
  const logRows = hot.map((p) => [
    p.code, p.name, p.date, p.time, p.viewers,
    p.like ?? '', p.delta ?? '', p.todayDelta ?? '',
  ]);

  if (logRows.length > 0) await appendLog(sheets, logRows);
  else console.log(`   -> ${VIEWER_THRESHOLD}명 이상인 상품이 없어서 기록은 건너뜁니다.`);

  await writeSnapshot(sheets, all);
  await writeMissing(sheets, missingMap);

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
  if (soldOut.length > 0) console.log(`🚨 전체 품절로 내려감 ${soldOut.length}개`);
  if (needCheck.length > 0) console.log(`⚠️ 사유 확인 필요 ${needCheck.length}개`);
  if (returned.length > 0) console.log(`↩️ 다시 올라옴 ${returned.length}개`);

  await sendSlackAlert({ hot, spikes, soldOut, needCheck, returned, stamp });
}

main().catch((err) => {
  console.error('에러 발생:', err);
  process.exit(1);
});
