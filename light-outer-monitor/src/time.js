// ============================================================
// 시간 유틸 (모든 시간은 Asia/Seoul 기준)
// ------------------------------------------------------------
// GitHub Actions 는 정각/30분에 예약해도 실제 시작이 몇 분 늦어지는 경우가 많습니다.
// 그래서 "실제 수집 시각"과 별도로 "수집 슬롯"(정각 또는 30분으로 내림한 시각)을 같이 기록합니다.
//   예) 실제 13:07 에 실행 → 슬롯 13:00 / 실제 13:41 → 슬롯 13:30
// 분석할 때는 슬롯 컬럼 기준으로 묶으면 30분 단위로 깔끔하게 비교할 수 있습니다.
// ============================================================

const config = require('../config');

// Date → { y, mo, d, h, mi, s } (서울 시간 기준)
function kstParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const p = {};
  fmt.formatToParts(date).forEach((x) => (p[x.type] = x.value));
  return { y: p.year, mo: p.month, d: p.day, h: p.hour, mi: p.minute, s: p.second };
}

/** "2026-10-16 13:07:42" 형식 */
function kstString(date = new Date()) {
  const p = kstParts(date);
  return `${p.y}-${p.mo}-${p.d} ${p.h}:${p.mi}:${p.s}`;
}

/** 정각/30분 단위로 내림한 슬롯 "2026-10-16 13:00" */
function kstSlot(date = new Date()) {
  const p = kstParts(date);
  const m = Math.floor(Number(p.mi) / config.SLOT_MINUTES) * config.SLOT_MINUTES;
  return `${p.y}-${p.mo}-${p.d} ${p.h}:${String(m).padStart(2, '0')}`;
}

/** 파일명용 "20261016_1300" */
function slotFileStamp(slot) {
  return slot.replace(/[-:]/g, '').replace(' ', '_');
}

/** 슬롯 번호 (하루 48칸 중 몇 번째인지 + 날짜) — 상세 수집 순환(rotation)에 사용 */
function slotIndex(date = new Date()) {
  return Math.floor(date.getTime() / (config.SLOT_MINUTES * 60 * 1000));
}

module.exports = { kstString, kstSlot, slotFileStamp, slotIndex };
