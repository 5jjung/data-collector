// ============================================================
// CSV 저장
// ------------------------------------------------------------
// [누적 데이터]  DATA_DIR 에 만든 뒤 구글 드라이브 폴더로 올림 (storage/googleDrive.js)
//   2026-10/경량아우터_2026-10-16.csv     ← 하루 1파일, 30분마다 아래에 이어 붙임
//   수집로그/수집로그_2026-10.csv          ← 한 달 1파일, 회차별 성공/실패 요약 1줄씩
//
// [회차별 임시 파일]  OUTPUT_DIR (GitHub Actions Artifacts 로 30일 보관)
//   data/랭킹전체_YYYYMMDD_HHMM.csv       ← 랭킹 500위 전체 (순위 검증용)
//   logs/수집로그_YYYYMMDD_HHMM.json       ← 실패 상품별 상세 원인
//   debug/                                ← 페이지 구조 진단 파일
//
// 엑셀에서 한글이 깨지지 않도록 새 파일을 만들 때 UTF-8 BOM 을 붙입니다.
// 같은 수집키(슬롯|상품코드)가 이미 파일에 있으면 다시 쓰지 않습니다 (재실행 중복 방지).
// ============================================================

const fs = require('fs');
const path = require('path');
const config = require('../../config');
const { warn } = require('../logger');

const BOM = '﻿';

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const toLine = (row) => row.map(csvEscape).join(',');

/** 새 CSV 파일 통째로 쓰기 */
function writeCsv(filePath, headers, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, BOM + [headers, ...rows].map(toLine).join('\r\n') + '\r\n', 'utf8');
}

/** 기존 파일의 첫 줄(헤더)과 첫 칸(수집키) 목록 읽기 */
function readExisting(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '');
  const lines = text.split(/\r?\n/).filter(Boolean);
  const keys = new Set(lines.slice(1).map((l) => (l.startsWith('"') ? l.slice(1, l.indexOf('"', 1)) : l.split(',')[0])));
  return { header: lines[0] || '', keys };
}

/**
 * 누적 CSV 에 행 추가 (파일이 없으면 헤더와 함께 생성)
 * - 헤더(컬럼 구성)가 기존 파일과 다르면 컬럼이 밀리지 않도록 "_v2" 등 새 파일에 저장
 * @param {boolean} dedupe  첫 칸(수집키) 기준 중복 제거 여부
 * @returns {{ file: string, added: number }}
 */
function appendCsv(filePath, headers, rows, dedupe = true) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let target = filePath;
  for (let v = 2; fs.existsSync(target) && readExisting(target).header !== toLine(headers); v++) {
    target = filePath.replace(/\.csv$/, `_v${v}.csv`);
  }
  // 새 버전 파일을 처음 만들 때만 알림 (이후 회차는 그 파일에 이어 붙임)
  if (target !== filePath && !fs.existsSync(target)) warn(`컬럼 구성이 바뀌어 새 파일에 저장합니다: ${path.basename(target)}`);

  if (!fs.existsSync(target)) {
    writeCsv(target, headers, rows);
    return { file: target, added: rows.length };
  }
  const { keys } = readExisting(target);
  const fresh = dedupe ? rows.filter((r) => !keys.has(String(r[0]))) : rows;
  if (fresh.length) fs.appendFileSync(target, fresh.map(toLine).join('\r\n') + '\r\n', 'utf8');
  return { file: target, added: fresh.length };
}

// 누적 파일의 상대 경로 (로컬 DATA_DIR / 드라이브 폴더 공통)
// ✏️ 파일 이름 규칙을 바꾸려면 여기만 수정
const dailyRelPath = (slot) => `${slot.slice(0, 7)}/경량아우터_${slot.slice(0, 10)}.csv`; // "2026-10/경량아우터_2026-10-16.csv"
const logRelPath = (slot) => `수집로그/수집로그_${slot.slice(0, 7)}.csv`;

/** 누적 데이터 저장: DATA_DIR/YYYY-MM/경량아우터_YYYY-MM-DD.csv */
function appendDaily(slot, headers, rows) {
  return appendCsv(path.join(config.DATA_DIR, dailyRelPath(slot)), headers, rows, true);
}

/** 실행 로그 저장: DATA_DIR/수집로그/수집로그_YYYY-MM.csv */
function appendRunLog(slot, headers, row) {
  return appendCsv(path.join(config.DATA_DIR, logRelPath(slot)), headers, [row], false);
}

/** CSV 문자열 → 2차원 배열 (따옴표/쉼표/줄바꿈 처리) */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/**
 * 누적 CSV(기본 파일 + _v2, _v3 …)를 모두 읽어 객체 배열로 반환
 * (컬럼 구성이 달라도 헤더 이름으로 값을 찾을 수 있도록 {컬럼명: 값} 형태)
 */
function readAll(relPath) {
  const out = [];
  for (let v = 1; v < 50; v++) {
    const rel = v === 1 ? relPath : relPath.replace(/\.csv$/, `_v${v}.csv`);
    const file = path.join(config.DATA_DIR, rel);
    if (!fs.existsSync(file)) { if (v > 1) break; else continue; }
    const [header, ...rows] = parseCsv(fs.readFileSync(file, 'utf8'));
    rows.forEach((r) => out.push(Object.fromEntries(header.map((h, i) => [h, r[i] ?? '']))));
  }
  return out;
}

/** 직전 회차 수집로그 한 줄 (없으면 null) — 실패 알림 중복 방지용 */
function lastLogRow(slot) {
  const rows = readAll(logRelPath(slot));
  return rows.length ? rows[rows.length - 1] : null;
}

/** 회차별 상세 실패 로그(JSON) — Artifacts 용 */
function saveRunJson(stamp, summary) {
  const file = path.join(config.OUTPUT_DIR, 'logs', `수집로그_${stamp}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(summary, null, 2), 'utf8');
  return file;
}

module.exports = {
  writeCsv, appendCsv, appendDaily, appendRunLog, saveRunJson, dailyRelPath, logRelPath, parseCsv, readAll, lastLogRow,
};
