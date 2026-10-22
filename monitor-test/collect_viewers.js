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

// 실행 진입점은 파일 맨 아래의 통합 실행 관리자가 담당합니다.


// =============== 신규: 무신사 품절 모니터링 ===============
const runStockMonitor = (function () {
'use strict';
// Independent stock monitor. Uses the SAME spreadsheet as collect_viewers.js.
const {google} = require('googleapis');
const ID = process.env.VIEWER_SPREADSHEET_ID;
const API = 'https://goods-detail.musinsa.com/api2/goods/';
const HEAD = {'Accept':'application/json','Referer':'https://www.musinsa.com/','User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36'};
// 품절 설정은 이 파일에서만 관리 (GitHub에서 변경)
const STOCK_CONFIG = Object.freeze({
  // 한국시간 기준: 평일 09:00~12:00 / 13:30~18:00만 Slack 알림
  notifyStart: 9, notifyEnd: 18, lunchStart: 12, lunchEndHour: 13, lunchEndMinute: 30,
  urgentHour: 15, urgentWindowMinutes: 60,
  stockIntervalMinutes: 30,
  // 반복 알림은 15시 긴급 점검으로 대체 (일반 상태변동 알림은 계속 사용)
  remindHours: 0,
  sizeRemind: true, restockAlert: true,
  // 첫 조회 시 품절 상태는 상태 저장만 하고, 다음 실행부터 변동 감지
});
const NAMES = {legacyProducts:'품절_상품목록',legacySettings:'품절_설정',log:'품절_알림기록',state:'품절_상태저장',seasons:'시즌설정',owners:'담당자 관리',registry:'상품등록',pending:'품절_대기알림',history:'통합이력'};
const REG_HEADER=['시즌','상품번호','상품명','감시 ON/OFF','URL'];
const SOURCE_SHEET_ID='1TJJhGn4IQzA0uYnoeHJhJdlJGrjn6T2uxJZrtUbotgo';
const SOURCE_GID=1547145187;
const IMPORT_SEASON='26FW';
const SEASON_HEADER=['시즌','감시 ON/OFF','설명'];
const OWNER_HEADER=['담당자명','Slack 멤버 ID','사용 여부'];
const SEASON_RE=/^\d{2}(SS|FW)$/;
const BASE_SEASON_HEADER=['상품번호','상품명','감시 여부','판매 상태','품절 옵션','판매중 옵션','문제 발생 시각','마지막 알림','마지막 확인','현재 좋아요','직전 좋아요','좋아요 증감','오늘 좋아요 증가','최근 보는 사람 수','리스팅 이탈 여부','이탈 구분','이탈 날짜','마지막 좋아요'];
const SEASON_LOG_HEADER=['시각','종류','상품번호','상품명','내용','상품 URL'];
const OPTION_START=5; // 상품등록 F열부터 실제 옵션명 헤더를 동적으로 추가 (E열 URL)
const STATE_HEADER=['상품번호','이전 상태 JSON','옵션 캐시 JSON','업데이트 시각'];
const LOG_HEADER=['시각','종류','상품명','내용','URL'];
const TZ='Asia/Seoul';
const fmt=d=>new Intl.DateTimeFormat('sv-SE',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(d).replace(' ',' ');
const hour=d=>Number(new Intl.DateTimeFormat('en-US',{timeZone:TZ,hour:'numeric',hourCycle:'h23'}).format(d));
const kstParts=d=>{const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(d).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));return {date:`${p.year}-${p.month}-${p.day}`,weekday:p.weekday,hour:Number(p.hour),minute:Number(p.minute)};};
const alertAllowed=(d)=>{const p=kstParts(d);const min=p.hour*60+p.minute;return !['Sat','Sun'].includes(p.weekday)&&min>=STOCK_CONFIG.notifyStart*60&&min<STOCK_CONFIG.notifyEnd*60&&!(min>=STOCK_CONFIG.lunchStart*60&&min<STOCK_CONFIG.lunchEndHour*60+STOCK_CONFIG.lunchEndMinute);};
const inHours=(h,a,b)=>a===b?false:(a<b?h>=a&&h<b:h>=a||h<b);
const truth=v=>/^(예|y|yes|o|true|on|1)$/i.test(String(v||'').trim());
const split=v=>String(v||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
const watched=(w,k)=>{const tokens=[k.toLowerCase().trim(),...k.toLowerCase().split('/').map(s=>s.trim())];return !tokens.some(t=>w.skip.includes(t))&&(!w.only.length||tokens.some(t=>w.only.includes(t)));};
const url=g=>`https://www.musinsa.com/products/${g}`;
const esc=s=>String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\|/g,'¦');
const ko={SALE:'판매중',SOLDOUT:'전체 품절',STOP_SALE:'판매 중지',GONE:'상품 삭제됨',STAND_BY_SALE:'판매 대기'};
const safeJSON=(v,def=null)=>{try{return JSON.parse(v);}catch{return def;}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function request(endpoint,body){for(let attempt=0;attempt<3;attempt++){try{const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),15000);let res;try{res=await fetch(endpoint,{method:body?'POST':'GET',headers:{...HEAD,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:controller.signal});}finally{clearTimeout(timer);}if(res.status===404)return {gone:true};if([429,500,502,503,504].includes(res.status)&&attempt<2){await sleep(700*(attempt+1));continue;}if(!res.ok)return {error:`HTTP ${res.status}`};const json=await res.json();return {data:json.data};}catch(e){if(attempt===2)return {error:e.message};await sleep(700*(attempt+1));}}}
async function getProduct(g,cache){const detail=await request(API+g);if(detail.error)return {error:detail.error};if(detail.gone||!detail.data)return {name:g,status:'GONE',sizes:{},cache};const d=detail.data;let status=d.goodsSaleType||'UNKNOWN';if(status==='SALE'&&d.isOutOfStock)status='SOLDOUT';const saleType=d.goodsSaleType||'SALE';let options=cache&&cache.saleType===saleType&&Date.now()-cache.t<3600000?cache.items:null;
if(!options){const r=await request(`${API}${g}/options?goodsSaleType=${encodeURIComponent(saleType)}`);if(r.error||r.gone)return {error:r.error||'옵션 조회 실패'};options=((r.data||{}).optionItems||[]).filter(x=>!x.isDeleted).map(x=>({no:x.no,label:(x.optionValues||[]).map(v=>v.name).join(' / ')||x.managedCode||String(x.no),values:x.optionValueNos||[],active:x.activated!==false}));cache={saleType,t:Date.now(),items:options};}
const sizes={};if(options.length){const inv=await request(`${API}${g}/options/v2/prioritized-inventories`,{optionValueNos:options.flatMap(x=>x.values)});if(inv.error||inv.gone)return {error:inv.error||'재고 조회 실패'};const stock=new Map((inv.data||[]).map(x=>[String(x.productVariantId),x.outOfStock===false]));for(const o of options)sizes[o.label]=o.active&&stock.get(String(o.no))===true;}
return {name:d.goodsNm||g,status,sizes,cache};}
function issue(st,w,sizeRemind){if(st.status==='STAND_BY_SALE'||st.status==='UNKNOWN')return null;if(st.status!=='SALE')return '🚫 '+(ko[st.status]||st.status);if(!sizeRemind)return null;const missing=Object.keys(st.sizes).filter(k=>watched(w,k)&&!st.sizes[k]);return missing.length?'❌ '+missing.join(', ')+' 품절':null;}
function diff(old,cur,w,restock){const out=[];if(old.status!==cur.status){if(cur.status==='SALE'){if(restock)out.push('✅ 판매 재개');}else out.push('🚫 '+(ko[cur.status]||cur.status));}if(cur.status==='GONE')return out;for(const [k,v] of Object.entries(cur.sizes)){if(!watched(w,k))continue;if(old.sizes?.[k]===true&&!v)out.push(`❌ ${k} 품절`);else if(old.sizes?.[k]===false&&v&&restock)out.push(`✅ ${k} 재입고`);}for(const [k,v] of Object.entries(old.sizes||{})){if(!(k in cur.sizes)&&v&&old.status!=='GONE'&&watched(w,k))out.push(`❌ ${k} 옵션 삭제`);}return out;}
async function main(){if(!ID||!process.env.GOOGLE_SERVICE_ACCOUNT_JSON)throw Error('GOOGLE_SERVICE_ACCOUNT_JSON / VIEWER_SPREADSHEET_ID 필수');const credentials=JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);const auth=new google.auth.GoogleAuth({credentials,scopes:['https://www.googleapis.com/auth/spreadsheets']});const sheets=google.sheets({version:'v4',auth});const meta=await sheets.spreadsheets.get({spreadsheetId:ID});const byName=new Map((meta.data.sheets||[]).map(x=>[x.properties.title,x.properties.sheetId]));const needed=[NAMES.log,NAMES.state,NAMES.seasons,NAMES.owners,NAMES.registry,NAMES.pending,NAMES.history];const missing=needed.filter(n=>!byName.has(n));if(missing.length){const r=await sheets.spreadsheets.batchUpdate({spreadsheetId:ID,requestBody:{requests:missing.map(title=>({addSheet:{properties:{title}}}))}});for(const s of r.data.replies)byName.set(s.addSheet.properties.title,s.addSheet.properties.sheetId);}
const read=async(range)=>((await sheets.spreadsheets.values.get({spreadsheetId:ID,range})).data.values||[]);
const put=async(range,values)=>sheets.spreadsheets.values.update({spreadsheetId:ID,range,valueInputOption:'RAW',requestBody:{values}});
const ensureHeader=async(name,header)=>{const rows=await read(`'${name}'!A1:${String.fromCharCode(64+header.length)}1`);if(!rows.length||!rows[0].some(x=>String(x).trim()))await put(`'${name}'!A1`,[header]);else if(header.some((h,i)=>rows[0][i]!==h))throw Error(`${name} 헤더가 예상 구조와 다릅니다. 기존 데이터를 보호하기 위해 중단합니다.`);};
// 기존 시트는 절대 삭제/초기화하지 않는다. 기존 이름 탭도 보존한다.
// 기존 상품등록 A:D는 보존하고 E열이 비어 있을 때만 URL 헤더 추가.
const oldRegistryHeader=(await read(`'${NAMES.registry}'!A1:ZZ1`))[0]||[];
if(oldRegistryHeader[4]&&oldRegistryHeader[4]!=='URL')throw Error('상품등록 E열에 기존 옵션이 있어 자동 이전을 중단합니다.');
// 기존 A:D가 정상이고 E1이 비어 있다면 E1만 안전하게 채운다.
// 기존 행과 옵션 데이터는 삭제하거나 덮어쓰지 않는다.
const originalPrefix=REG_HEADER.slice(0,4);
if(oldRegistryHeader.some(x=>String(x||'').trim())){
  if(originalPrefix.some((h,i)=>String(oldRegistryHeader[i]||'').trim()!==h)){
    throw Error(`상품등록 A:D 헤더 불일치. 실제: ${JSON.stringify(oldRegistryHeader.slice(0,5))}`);
  }
  if(!oldRegistryHeader[4])await put(`'${NAMES.registry}'!E1`,[['URL']]);
}
await ensureHeader(NAMES.registry,REG_HEADER);
await ensureHeader(NAMES.seasons,SEASON_HEADER);
await ensureHeader(NAMES.owners,OWNER_HEADER);
await ensureHeader(NAMES.pending,['시각','상품번호','메시지']);
// 기존 상품등록 탭을 새 양식으로 덮어쓰지 않는다. 기존 데이터가 있으면 안전하게 중단한다.
const regHeader=(await read(`'${NAMES.registry}'!A1:ZZ1`))[0]||[];
if(REG_HEADER.some((h,i)=>regHeader[i]!==h))throw Error('상품등록 헤더 불일치: 자동 이전하지 않고 중단합니다.');
const seasonRows=await read(`'${NAMES.seasons}'!A2:C`);
const seasonMap=new Map(seasonRows.filter(r=>SEASON_RE.test(String(r[0]||'').trim())).map(r=>[String(r[0]).trim(),truth(r[1])]));
const suggested=['26FW']; // 새 시즌은 26FW만 추가; 기존 시즌설정 행은 삭제하지 않음
const newSeasons=suggested.filter(x=>!seasonMap.has(x)).map(x=>[x,'OFF','필요한 시즌만 ON으로 변경']);
if(newSeasons.length){await put(`'${NAMES.seasons}'!A${seasonRows.length+2}`,newSeasons);for(const r of newSeasons)seasonMap.set(r[0],false);}
const ownerRows=await read(`'${NAMES.owners}'!A2:C`);
const memberId=/^[UW][A-Z0-9]{6,}$/;
const activeOwners=ownerRows.filter(r=>r[0]&&!['OFF','FALSE','아니오','0'].includes(String(r[2]||'ON').trim().toUpperCase()));
const ownerMentions=()=>activeOwners.map(r=>memberId.test(String(r[1]||''))?`<@${r[1]}>`:esc(r[0])).join(' ');
const now=new Date(),stamp=fmt(now),kst=kstParts(now);
const changeOpen=alertAllowed(now);
const remindOpen=false; // 일반 재알림은 비활성화, 15시 긴급 점검만 사용
const remindMs=Infinity;
const urgentOpen=changeOpen&&kst.hour===STOCK_CONFIG.urgentHour&&kst.minute<STOCK_CONFIG.urgentWindowMinutes;
// 원본 문서에서 gid로 정확한 탭을 찾아 읽는다. 원본 문서는 수정하지 않는다.
// 원본 상품번호는 URL / 숫자 / HYPERLINK 문자열 중 어느 형식이어도 숫자만 추출한다.
const sourceMeta=await sheets.spreadsheets.get({spreadsheetId:SOURCE_SHEET_ID,fields:'sheets(properties(sheetId,title))'});
const sourceTab=(sourceMeta.data.sheets||[]).find(x=>x.properties.sheetId===SOURCE_GID)?.properties.title;
if(!sourceTab)throw Error(`원본 상품목록 gid ${SOURCE_GID}를 찾을 수 없습니다.`);
const sourceValues=(await sheets.spreadsheets.values.get({spreadsheetId:SOURCE_SHEET_ID,range:`'${sourceTab.replace(/'/g,"''")}'!A1:Z`,valueRenderOption:'FORMATTED_VALUE'})).data.values||[];
const existingRegistry=await read(`'${NAMES.registry}'!A2:E`);
const parseNo=v=>{const x=String(v??'').trim();const m=x.match(/(?:musinsa\.com\/(?:products|app\/goods)\/|goodsNo[=:]|^)(\d{5,})(?!\d)/i);return m?m[1]:null;};
const seen=new Set(existingRegistry.map(r=>parseNo(r[1])).filter(Boolean));
const incoming=[];
for(const row of sourceValues.slice(1)){
  const goodsNo=parseNo(row[0])||parseNo(row[1]);
  if(!goodsNo||seen.has(goodsNo))continue;
  // 원본: A 상품 URL, F 상품명 (기존 품절_상품목록 구조)
  const name=String(row[5]||'').trim()||String(row[1]||'').trim().replace(/^\d{5,}$/,'');
  incoming.push([IMPORT_SEASON,goodsNo,name,false,`=IF(B${existingRegistry.length+incoming.length+2}=\"\",\"\",\"https://www.musinsa.com/products/\"&B${existingRegistry.length+incoming.length+2})`]);
  seen.add(goodsNo);
}
if(incoming.length){
  await sheets.spreadsheets.values.update({spreadsheetId:ID,range:`'${NAMES.registry}'!A${existingRegistry.length+2}`,valueInputOption:'USER_ENTERED',requestBody:{values:incoming}});
}
console.log(`원본 상품목록 읽기 성공: 신규 ${incoming.length}개 등록 (기본 감시 OFF)`);
// 이미 등록된 상품에도 URL 수식을 채우되 기존 사용자 입력은 덮어쓰지 않는다.
const currentRegistry=await read(`'${NAMES.registry}'!A2:E`);
const urlUpdates=[];
for(let i=0;i<currentRegistry.length;i++)if(parseNo(currentRegistry[i][1])&&!currentRegistry[i][4])urlUpdates.push({range:`'${NAMES.registry}'!E${i+2}`,values:[[ `=IF(B${i+2}=\"\",\"\",\"https://www.musinsa.com/products/\"&B${i+2})` ]]});
for(let i=0;i<urlUpdates.length;i+=100)await sheets.spreadsheets.values.batchUpdate({spreadsheetId:ID,requestBody:{valueInputOption:'USER_ENTERED',data:urlUpdates.slice(i,i+100)}});
const rows=await read(`'${NAMES.registry}'!A2:ZZ`);
const stateRows=await read(`'${NAMES.state}'!A2:D`);
const state=new Map(stateRows.filter(r=>r[0]).map(r=>[String(r[0]),{old:safeJSON(r[1]),cache:safeJSON(r[2])}]));
const productRows=rows.map((r,i)=>({index:i,season:String(r[0]||'').trim().toUpperCase(),goodsNo:/^\d{5,}$/.test(String(r[1]||'').trim())?String(r[1]).trim():null,enteredName:String(r[2]||'').trim(),enabled:r[3]===true||truth(r[3]),raw:r}));
const allSeasons=['26FW']; // 다른 시즌 탭을 새로 만들지 않음
const seasonTitles=['26FW'];
const toCreate=seasonTitles.filter(x=>!byName.has(x));
if(toCreate.length){const added=await sheets.spreadsheets.batchUpdate({spreadsheetId:ID,requestBody:{requests:toCreate.map(title=>({addSheet:{properties:{title}}}))}});for(const r of added.data.replies)byName.set(r.addSheet.properties.title,r.addSheet.properties.sheetId);}
for(const season of allSeasons)await ensureHeader(season,BASE_SEASON_HEADER);
await ensureHeader(NAMES.history,['시각','시즌','종류','상품번호','상품명','내용','상품 URL']);
// 상품등록: 옵션은 상품 API가 제공한 실제 옵션명으로만 열을 추가한다.
// 옵션별 체크는 기본 TRUE로 초기화하고, 사용자가 해제하면 이후 자동 실행에서 유지한다.
let optionHeaders=(await read(`'${NAMES.registry}'!F1:ZZ1`))[0]||[];
const optionColumn=new Map(optionHeaders.map((v,i)=>[String(v),OPTION_START+i]).filter(x=>x[0]));
const candidate=productRows.filter(r=>r.goodsNo&&r.enabled&&r.season==='26FW'&&seasonMap.get('26FW')===true); // 감시 OFF 대량 이관 상품은 API 조회하지 않음
console.log('[진단] 시즌설정 26FW:', JSON.stringify({value:seasonMap.get('26FW'),raw:seasonRows.find(r=>String(r[0]).trim()==='26FW')}));
console.log('[진단] 상품등록:', JSON.stringify({total:productRows.length, validNumbers:productRows.filter(r=>r.goodsNo).length, checked:productRows.filter(r=>r.enabled).length, checked26FW:productRows.filter(r=>r.enabled&&r.season==='26FW').length, candidates:candidate.length}));
console.log('[진단] 6885281:', JSON.stringify(productRows.find(r=>r.goodsNo==='6885281')||{message:'상품등록에서 번호를 찾지 못함'}));
if(!candidate.length) console.warn('[진단] 실제 조회 대상 0개: 시즌 ON, 상품 감시 ON, 시즌 26FW, 상품번호 조건을 확인하세요.');
const fetched=new Map();
for(const g of [...new Set(candidate.map(r=>r.goodsNo))]){
  const cur=await getProduct(g,state.get(g)?.cache);
  fetched.set(g,cur);
  console.log(`[진단] 옵션조회 ${g}: ${JSON.stringify({status:cur.status,error:cur.error||null,optionCount:Object.keys(cur.sizes||{}).length,options:Object.keys(cur.sizes||{}).slice(0,25)})}`);
  if(cur.error){console.warn(`상품 ${g} 조회 실패: ${cur.error}`);continue;}
  for(const opt of Object.keys(cur.sizes||{}))if(!optionColumn.has(opt)){
    const idx=OPTION_START+optionHeaders.length;
    if(idx>=702)throw Error('상품등록 옵션 컬럼이 ZZ를 초과했습니다.');
    optionHeaders.push(opt);optionColumn.set(opt,idx);
    const col=(n)=>{let out='';for(n++;n;n=Math.floor((n-1)/26))out=String.fromCharCode(65+(n-1)%26)+out;return out;};
    await put(`'${NAMES.registry}'!${col(idx)}1`,[[opt]]);
  }
}
// 체크박스는 실제 상품 옵션에만 적용. 옵션이 없는 셀에는 체크박스를 넣지 않는다.
// 사용자가 해제한 FALSE 값은 절대로 다시 TRUE로 바꾸지 않는다.
const checkboxRequests=[];
// 상품 감시 ON/OFF (D열) 및 시즌설정 (B열) 체크박스
for(const [sheetName,col,start,end] of [[NAMES.registry,3,1,Math.max(2,rows.length+1)],[NAMES.seasons,1,1,Math.max(2,seasonRows.length+newSeasons.length+1)]]){
  checkboxRequests.push({setDataValidation:{range:{sheetId:byName.get(sheetName),startRowIndex:start,endRowIndex:end,startColumnIndex:col,endColumnIndex:col+1},rule:{condition:{type:'BOOLEAN'},strict:true,showCustomUi:true}}});
}

const optionCellWrites=[];
for(const r of candidate)if(r.raw[3]===undefined||r.raw[3]==='')optionCellWrites.push({range:`'${NAMES.registry}'!D${r.index+2}`,values:[[false]]});
// 기존 시즌설정에 ON/OFF 텍스트가 있으면 체크박스 표시를 위해 TRUE/FALSE로 변환.
for(let i=0;i<seasonRows.length;i++)if(SEASON_RE.test(String(seasonRows[i][0]||'').trim())){
  const v=seasonRows[i][1];if(v!==true&&v!==false)optionCellWrites.push({range:`'${NAMES.seasons}'!B${i+2}`,values:[[truth(v)]]});
}
for(let i=0;i<newSeasons.length;i++)optionCellWrites.push({range:`'${NAMES.seasons}'!B${seasonRows.length+i+2}`,values:[[false]]});

for(const r of candidate){const cur=fetched.get(r.goodsNo);if(!cur||cur.error||cur.status==='GONE')continue;
  for(const [opt,idx] of optionColumn){
    if(opt in (cur.sizes||{}))continue;
    checkboxRequests.push({setDataValidation:{range:{sheetId:byName.get(NAMES.registry),startRowIndex:r.index+1,endRowIndex:r.index+2,startColumnIndex:idx,endColumnIndex:idx+1}}});
    if(r.raw[idx]!==undefined&&r.raw[idx]!=='')optionCellWrites.push({range:`'${NAMES.registry}'!${(function(n){let o='';for(n++;n;n=Math.floor((n-1)/26))o=String.fromCharCode(65+(n-1)%26)+o;return o;})(idx)}${r.index+2}`,values:[['']]});
  }
  for(const opt of Object.keys(cur.sizes||{})){
    const idx=optionColumn.get(opt);const prev=r.raw[idx];
    const cellRow=r.index+1;
    checkboxRequests.push({setDataValidation:{range:{sheetId:byName.get(NAMES.registry),startRowIndex:cellRow,endRowIndex:cellRow+1,startColumnIndex:idx,endColumnIndex:idx+1},rule:{condition:{type:'BOOLEAN'},strict:true,showCustomUi:true}}});
    if(prev===undefined||prev==='')optionCellWrites.push({range:`'${NAMES.registry}'!${(function(n){let o='';for(n++;n;n=Math.floor((n-1)/26))o=String.fromCharCode(65+(n-1)%26)+o;return o;})(idx)}${r.index+2}`,values:[[true]]});
  }
}
for(let i=0;i<checkboxRequests.length;i+=100)await sheets.spreadsheets.batchUpdate({spreadsheetId:ID,requestBody:{requests:checkboxRequests.slice(i,i+100)}});
for(let i=0;i<optionCellWrites.length;i+=100)await sheets.spreadsheets.values.batchUpdate({spreadsheetId:ID,requestBody:{valueInputOption:'RAW',data:optionCellWrites.slice(i,i+100)}});
// 시즌 OFF 또는 상품 OFF면 감시 중단. 사이즈는 실제 옵션 중 체크된 항목만 감시.
for(const r of productRows){const cur=fetched.get(r.goodsNo);r.w={only:[],skip:[]};if(cur&&!cur.error){for(const opt of Object.keys(cur.sizes||{})){const idx=optionColumn.get(opt);const v=r.raw[idx];if(v===false||String(v).toUpperCase()==='FALSE')r.w.skip.push(opt.toLowerCase());else r.w.only.push(opt.toLowerCase());}if(Object.keys(cur.sizes||{}).length&&!r.w.only.length)r.w.only=['__NO_OPTIONS_SELECTED__'];}}
const grouped=new Map();for(const r of productRows){if(r.goodsNo&&r.enabled&&r.season==='26FW'&&seasonMap.get(r.season)===true){if(!grouped.has(r.goodsNo))grouped.set(r.goodsNo,[]);grouped.get(r.goodsNo).push(r);}}
const alerts=[],reminders=[],urgents=[],urgentGoods=[],logs=[],seasonLogs=new Map();let pending=(await read(`'${NAMES.pending}'!A2:C`)).filter(r=>r[1]&&r[2]).map(r=>({g:String(r[1]),line:String(r[2])}));const nextState=new Map(state);
for(const [g,group] of grouped){const stored=state.get(g)||{};const cur=fetched.get(g)||await getProduct(g,stored.cache);if(cur.error){console.warn(`상품 ${g} 조회 실패: ${cur.error}`);for(const r of group)r.out=[stored.old?.name||'',`❓ 확인 실패 (${cur.error})`,'','','','',stamp];continue;}
const old=stored.old;
// 단발성 404는 삭제로 확정하지 않는다. 2회 연속 404일 때만 확정.
if(cur.status==='GONE'&&old?.status!=='GONE'&&(old?.goneCount||0)<1){const pendingOld={...old,goneCount:(old.goneCount||0)+1};nextState.set(g,{old:pendingOld,cache:stored.cache});for(const r of group)r.out=[old?.name||'','❓ 삭제 여부 재확인 중','','','','',stamp];continue;}
const merged={name:cur.status==='GONE'&&old?old.name:(cur.name||group[0].enteredName||g),status:cur.status,sizes:cur.status==='GONE'&&old?old.sizes:cur.sizes,issueSince:old?.issueSince||null,lastAlert:old?.lastAlert||null,goneCount:cur.status==='GONE'?(old?.goneCount||0)+1:0,lastUrgentDate:old?.lastUrgentDate||null};const watch={only:[],skip:[]}; // All monitored rows contribute; each row retains its own filtering.
const issues=group.map(r=>issue(merged,r.w,STOCK_CONFIG.sizeRemind)).filter(Boolean);const hasIssue=issues.length>0;if(!hasIssue){merged.issueSince=null;merged.lastAlert=null;}else if(!merged.issueSince)merged.issueSince=now.getTime();
const messages=old?[...new Set(group.flatMap(r=>diff(old,merged,r.w,STOCK_CONFIG.restockAlert)))]:[];const who=ownerMentions();const line=(message)=>`• <${url(g)}|${esc(merged.name)}> — ${message}${who?' '+who:''}`;
if(messages.length){const message=messages.join(' · ');const item=line(message);if(changeOpen){alerts.push(item);if(hasIssue)merged.lastAlert=now.getTime();}else{pending.push({g,line:`• [${new Intl.DateTimeFormat('en-GB',{timeZone:TZ,hour:'2-digit',minute:'2-digit'}).format(now)}] ${item.slice(2)}`});}logs.push([stamp,changeOpen?'변동':'변동(시간 외)',merged.name,message,url(g)]);for(const r of group){if(!seasonLogs.has(r.season))seasonLogs.set(r.season,[]);seasonLogs.get(r.season).push([stamp,changeOpen?'변동':'변동(시간 외)',g,merged.name,message,url(g),'']);}}
if(hasIssue&&remindOpen&&(!merged.lastAlert||now.getTime()-merged.lastAlert>=remindMs)&&!(changeOpen&&pending.some(p=>p.g===g))){const hours=Math.floor((now.getTime()-merged.issueSince)/3600000);const msg=[...new Set(issues)].join(' · ')+(hours>=1?` (${hours}시간째 미해결)`:'');reminders.push(line(msg));logs.push([stamp,'재알림',merged.name,msg,url(g)]);for(const r of group){if(!seasonLogs.has(r.season))seasonLogs.set(r.season,[]);seasonLogs.get(r.season).push([stamp,'재알림',g,merged.name,msg,url(g),'']);}merged.lastAlert=now.getTime();}
// 15:00 KST 최종 점검: 감시 ON + 시즌 ON + 미해결 상태만, 상품별 하루 한 번.
if(urgentOpen&&hasIssue&&merged.lastUrgentDate!==kst.date){
  const summary=[...new Set(issues)].join(' · ');
  urgents.push(line(`🚨 *15시 MD 최종 확인 필요* — ${summary}`));
  urgentGoods.push(g);
}
nextState.set(g,{old:merged,cache:cur.cache});for(const r of group){const keys=Object.keys(merged.sizes).filter(k=>watched(r.w,k));const sold=merged.status==='GONE'?[]:keys.filter(k=>!merged.sizes[k]);const available=merged.status==='GONE'?[]:keys.filter(k=>merged.sizes[k]);const status=merged.status==='SALE'&&sold.length?'사이즈 품절':ko[merged.status]||merged.status;r.out=[merged.name,(merged.status==='SALE'&&!sold.length?'✅ ':'🚫 ')+status,sold.join(', '),available.join(', '),merged.issueSince?fmt(new Date(merged.issueSince)):'',merged.lastAlert?fmt(new Date(merged.lastAlert)):'',stamp];}}
// 기존 좋아요/리스팅 추적 탭은 읽기 전용. 시즌별 탭에 결합한다.
const likeRows=byName.has('좋아요_현황')?await read(`'좋아요_현황'!A2:J`):[];
const likeMap=new Map(likeRows.filter(r=>r[0]).map(r=>[String(r[0]),r]));
const missingRows=byName.has('품절_추적')?await read(`'품절_추적'!A2:F`):[];
const missingMap=new Map(missingRows.filter(r=>r[0]).map(r=>[String(r[0]),r]));
// 26FW 통합 현황: 기존 좋아요_현황/품절_추적 데이터를 먼저 합치고, 신규 등록 상품은 끝 행에 추가.
// 기존 26FW 행을 절대 삭제하거나 순서를 재배열하지 않는다. 상품번호 중복은 최초 행만 갱신한다.
for(const season of allSeasons){
  const title=season;
  const previous=await read(`'${title}'!A2:R`);
  const previousIndex=new Map();
  previous.forEach((r,i)=>{const g=String(r[0]||'').trim();if(g&&!previousIndex.has(g))previousIndex.set(g,i);});
  const updates=[];
  const registered=new Map(productRows.filter(r=>r.season==='26FW'&&r.goodsNo).map(r=>[r.goodsNo,r]));
  const codes=[...new Set([...previousIndex.keys(),...likeMap.keys(),...missingMap.keys(),...registered.keys()])].filter(g=>/^\d{5,}$/.test(g));
  for(const goodsNo of codes){
    const r=registered.get(goodsNo);
    const cur=nextState.get(goodsNo)?.old||fetched.get(goodsNo);
    const isActive=!!r&&seasonMap.get('26FW')===true&&r.enabled;
    const keys=cur&&r?Object.keys(cur.sizes||{}).filter(k=>watched(r.w,k)):[];
    const sold=cur&&cur.status!=='GONE'?keys.filter(k=>!cur.sizes[k]):[];
    const available=cur&&cur.status!=='GONE'?keys.filter(k=>cur.sizes[k]):[];
    const l=likeMap.get(goodsNo)||[],m=missingMap.get(goodsNo)||[];
    const prior=previousIndex.has(goodsNo)?previous[previousIndex.get(goodsNo)]:[];
    const status=!r?'미등록 (기존 데이터)':!seasonMap.get('26FW')?'⏸ 시즌 OFF':!r.enabled?'⏸ 감시 OFF':!cur||cur.error?'대기 / 조회 실패':cur.status==='SALE'&&sold.length?'사이즈 품절':ko[cur.status]||cur.status;
    const v=[goodsNo,cur?.name||r?.enteredName||l[1]||m[1]||prior[1]||'',isActive?'ON':'OFF',status,sold.join(', ')||prior[4]||'',available.join(', ')||prior[5]||'',cur?.issueSince?fmt(new Date(cur.issueSince)):prior[6]||'',cur?.lastAlert?fmt(new Date(cur.lastAlert)):prior[7]||'',isActive?stamp:prior[8]||'',l[4]??prior[9]??'',l[5]??prior[10]??'',l[6]??prior[11]??'',l[8]??prior[12]??'',l[9]??prior[13]??'',m.length?'이탈':(prior[14]||''),m[4]||prior[15]||'',m[2]||prior[16]||'',m[5]??prior[17]??''];
    if(previousIndex.has(goodsNo))updates.push({row:previousIndex.get(goodsNo)+2,v});
    else {const row=previous.length+2;previousIndex.set(goodsNo,previous.length);previous.push(v);updates.push({row,v});}
  }
  for(let i=0;i<updates.length;i+=100){
    const data=updates.slice(i,i+100).map(u=>({range:`'${title}'!A${u.row}:R${u.row}`,values:[u.v]}));
    await sheets.spreadsheets.values.batchUpdate({spreadsheetId:ID,requestBody:{valueInputOption:'RAW',data}});
  }
  console.log(`26FW 통합 현황: 기존 행 보존, ${updates.length}개 상품 연결/갱신`);
}
// Keep prior rows for excluded products, remove rows for deleted products only.
// 상태 저장은 Slack 긴급 알림 전송 결과를 반영한 후 수행한다.
const webhook=process.env.SLACK_WEBHOOK_STOCK||process.env.SLACK_WEBHOOK_URL||'';async function send(title,lines){if(!lines.length)return true;if(!webhook){console.warn('Slack Webhook 없음: 알림 미발송');return false;}for(let i=0;i<lines.length;i+=30){const res=await fetch(webhook,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:(i===0?title+'\n':'')+lines.slice(i,i+30).join('\n'),unfurl_links:false})});if(!res.ok){console.error(`Slack 오류 HTTP ${res.status}`);return false;}}return true;}
let delivered=[];if(changeOpen&&pending.length){const held=pending.slice(0,30).map(x=>x.line);if(pending.length>30)held.push(`…외 ${pending.length-30}건`);if(await send(`🌙 *알림 시간 외 변동* (${pending.length}건)`,held)){delivered=pending;pending=[];}}
await send(`🔔 *무신사 상품 변동* (${alerts.length}건)`,alerts);await send(`⏰ *아직 해결 안 된 상품* (${reminders.length}건)`,reminders);
const urgentDelivered=await send(`🚨 *15:00 MD 승인/조치 최종 확인* (${urgents.length}건)`,urgents);
if(urgentDelivered&&urgents.length){for(const g of urgentGoods){const item=nextState.get(g);if(item?.old)item.old.lastUrgentDate=kst.date;}
  const urgentLog=urgentGoods.map(g=>[stamp,'15시 긴급 점검',nextState.get(g)?.old?.name||g,'미해결 상태 MD 확인 요청',url(g)]);logs.push(...urgentLog);
  for(const g of urgentGoods){seasonLogs.set('26FW',[...(seasonLogs.get('26FW')||[]),[stamp,'15시 긴급 점검',g,nextState.get(g)?.old?.name||g,'미해결 상태 MD 확인 요청',url(g),'']]);}
}
const all=Array.from(nextState.entries()).map(([g,v])=>[g,JSON.stringify(v.old||null),JSON.stringify(v.cache||null),stamp]);await sheets.spreadsheets.values.clear({spreadsheetId:ID,range:`'${NAMES.state}'!A2:D`});if(all.length)await put(`'${NAMES.state}'!A2`,all);
// 대기 알림은 별도 탭에 저장 (기존 품절_설정 탭은 읽거나 수정하지 않는다).
await sheets.spreadsheets.values.clear({spreadsheetId:ID,range:`'${NAMES.pending}'!A2:C`});
if(pending.length)await put(`'${NAMES.pending}'!A2`,pending.slice(-100).map(p=>[stamp,p.g,p.line]));
for(const [season,entries] of seasonLogs){if(entries.length&&season==='26FW')await sheets.spreadsheets.values.append({spreadsheetId:ID,range:`'${NAMES.history}'!A:G`,valueInputOption:'RAW',insertDataOption:'INSERT_ROWS',requestBody:{values:entries.map(x=>[x[0],season,x[1],x[2],x[3],x[4],x[5]])}});}
if(logs.length)await sheets.spreadsheets.values.append({spreadsheetId:ID,range:`'${NAMES.log}'!A:E`,valueInputOption:'RAW',insertDataOption:'INSERT_ROWS',requestBody:{values:logs}});
console.log(`품절 모니터링 완료: ${grouped.size}개 상품, 변동 ${alerts.length}건, 재알림 ${reminders.length}건, 대기 ${pending.length}건`);
}


return main;
})();

// =============== 단일 파일 실행 관리자 ===============
// 예약 실행: 30분마다 품절/시청자 체크. 알림 발송은 KST 평일 업무시간만
// 수동 실행: mode=both/viewer/stock (기본 both)
async function runIntegrated() {
  const mode = (process.env.MONITOR_MODE || 'auto').toLowerCase();
  const minute = new Date().getUTCMinutes();
  const doViewer = mode === 'both' || mode === 'viewer' || (mode === 'auto' && minute % 30 < 10);
  const doStock = mode === 'both' || mode === 'stock' || (mode === 'auto' && minute % 30 < 10);
  const errors = [];
  if (doViewer) {
    try { await main(); } catch (e) { console.error('[시청자 모니터링 실패]', e); errors.push(e); }
  }
  if (doStock) {
    try { await runStockMonitor(); } catch (e) { console.error('[품절 모니터링 실패]', e); errors.push(e); }
  }
  if (errors.length) process.exitCode = 1;
}
runIntegrated().catch(e => { console.error(e); process.exitCode = 1; });
