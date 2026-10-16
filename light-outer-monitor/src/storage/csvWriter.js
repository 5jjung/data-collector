// ============================================================
// CSV 저장
// ------------------------------------------------------------
// output/
//   data/경량아우터_YYYYMMDD_HHMM.csv   ← 회차별 결과 (엑셀에서 바로 열림, UTF-8 BOM)
//   logs/수집로그_YYYYMMDD_HHMM.json    ← 회차별 성공/실패 요약
//   debug/                              ← 페이지 구조 진단 파일(스크린샷, 카드 샘플)
// GitHub Actions 에서는 이 폴더가 실행 결과 "Artifacts" 로 업로드됩니다.
// ============================================================

const fs = require('fs');
const path = require('path');
const config = require('../../config');

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(filePath, headers, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = [headers, ...rows].map((r) => r.map(csvEscape).join(',')).join('\r\n');
  fs.writeFileSync(filePath, '﻿' + body, 'utf8'); // BOM: 엑셀 한글 깨짐 방지
}

function saveRunCsv(stamp, headers, rows) {
  const file = path.join(config.OUTPUT_DIR, 'data', `경량아우터_${stamp}.csv`);
  writeCsv(file, headers, rows);
  return file;
}

function saveRunLog(stamp, summary) {
  const file = path.join(config.OUTPUT_DIR, 'logs', `수집로그_${stamp}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(summary, null, 2), 'utf8');
  return file;
}

module.exports = { saveRunCsv, saveRunLog, writeCsv };
