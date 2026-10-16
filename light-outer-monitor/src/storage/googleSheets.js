// ============================================================
// 구글 스프레드시트 저장
// ------------------------------------------------------------
// - 데이터 탭(SHEET_DATA_TAB): 회차마다 행을 "아래로 추가"(append) → 시계열 누적
// - 로그 탭(SHEET_LOG_TAB): 회차마다 성공/실패 요약 1줄 추가
// - 탭이 없으면 자동 생성 + 헤더 입력
// - 같은 수집키(슬롯|상품코드)가 이미 있으면 다시 넣지 않음 → 재실행 시 중복 방지
//
// 필요한 Secrets: LIGHT_OUTER_SPREADSHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON
// (서비스계정 이메일을 시트에 "편집자"로 공유해야 함)
// ============================================================

const { google } = require('googleapis');
const config = require('../../config');
const { log, warn } = require('../logger');
const { withRetry } = require('../utils');

function enabled() {
  return !!(config.SPREADSHEET_ID && config.GOOGLE_SERVICE_ACCOUNT_JSON);
}

async function client() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(config.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

/** 탭이 없으면 만들고, 비어 있으면 헤더를 넣음 */
async function ensureTab(sheets, title, headers) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: config.SPREADSHEET_ID });
  const exists = meta.data.sheets.some((s) => s.properties.title === title);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } } }] },
    });
    log(`시트 탭 생성: "${title}"`);
  }
  const head = await sheets.spreadsheets.values.get({ spreadsheetId: config.SPREADSHEET_ID, range: `'${title}'!1:1` });
  const cur = (head.data.values && head.data.values[0]) || [];
  if (cur.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.SPREADSHEET_ID,
      range: `'${title}'!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] },
    });
  } else if (cur.join('|') !== headers.join('|')) {
    warn(`"${title}" 탭의 헤더가 현재 코드의 컬럼 정의와 다릅니다. 컬럼이 밀릴 수 있으니 새 탭 이름을 사용하세요.`);
  }
}

/** 데이터 행 추가 (수집키 중복 제외) */
async function appendData(headers, rows) {
  const sheets = await client();
  const tab = config.SHEET_DATA_TAB;
  await withRetry('시트 탭 준비', () => ensureTab(sheets, tab, headers));

  // 중복 방지: A열(수집키) 중 최근 5000행만 확인
  const keys = await sheets.spreadsheets.values.get({ spreadsheetId: config.SPREADSHEET_ID, range: `'${tab}'!A:A` });
  const existing = new Set((keys.data.values || []).slice(-5000).map((r) => r[0]));
  const fresh = rows.filter((r) => !existing.has(r[0]));
  if (fresh.length < rows.length) log(`이미 저장된 수집키 ${rows.length - fresh.length}건은 건너뜀 (중복 실행 방지)`);
  if (fresh.length === 0) return 0;

  await withRetry('시트 데이터 추가', () =>
    sheets.spreadsheets.values.append({
      spreadsheetId: config.SPREADSHEET_ID,
      range: `'${tab}'!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: fresh },
    })
  );
  return fresh.length;
}

/** 실행 로그 1줄 추가 */
async function appendLog(headers, row) {
  const sheets = await client();
  const tab = config.SHEET_LOG_TAB;
  await withRetry('로그 탭 준비', () => ensureTab(sheets, tab, headers));
  await withRetry('시트 로그 추가', () =>
    sheets.spreadsheets.values.append({
      spreadsheetId: config.SPREADSHEET_ID,
      range: `'${tab}'!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    })
  );
}

module.exports = { enabled, appendData, appendLog };
