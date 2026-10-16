// ============================================================
// CSV 저장 (구글 시트 사용 안 함)
// ------------------------------------------------------------
// [누적 데이터]  DATA_DIR (GitHub Actions 에서는 데이터 브랜치 "light-outer-data")
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
  if (target !== filePath) warn(`컬럼 구성이 바뀌어 새 파일에 저장합니다: ${path.basename(target)}`);

  if (!fs.existsSync(target)) {
    writeCsv(target, headers, rows);
    return { file: target, added: rows.length };
  }
  const { keys } = readExisting(target);
  const fresh = dedupe ? rows.filter((r) => !keys.has(String(r[0]))) : rows;
  if (fresh.length) fs.appendFileSync(target, fresh.map(toLine).join('\r\n') + '\r\n', 'utf8');
  return { file: target, added: fresh.length };
}

/** 누적 데이터 저장: DATA_DIR/YYYY-MM/경량아우터_YYYY-MM-DD.csv */
function appendDaily(slot, headers, rows) {
  const day = slot.slice(0, 10); // "2026-10-16"
  const file = path.join(config.DATA_DIR, day.slice(0, 7), `경량아우터_${day}.csv`);
  return appendCsv(file, headers, rows, true);
}

/** 실행 로그 저장: DATA_DIR/수집로그/수집로그_YYYY-MM.csv */
function appendRunLog(slot, headers, row) {
  const file = path.join(config.DATA_DIR, '수집로그', `수집로그_${slot.slice(0, 7)}.csv`);
  return appendCsv(file, headers, [row], false);
}

/** 회차별 상세 실패 로그(JSON) — Artifacts 용 */
function saveRunJson(stamp, summary) {
  const file = path.join(config.OUTPUT_DIR, 'logs', `수집로그_${stamp}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(summary, null, 2), 'utf8');
  return file;
}

module.exports = { writeCsv, appendCsv, appendDaily, appendRunLog, saveRunJson };
