// ============================================================
// 로그 + 실행 통계
// ------------------------------------------------------------
// - 콘솔 로그에 [KST 시각] 을 붙여 출력 (GitHub Actions 로그에서 확인)
// - 성공/실패 건수와 실패 원인을 모아서 마지막에 요약 출력 + CSV 에 기록
// ============================================================

const { kstString } = require('./time');

const stats = {
  listCollected: 0, // 랭킹 목록에서 수집한 상품 수 (광고 제외, 중복 제거)
  listMaxRank: 0, // 확인된 최대 순위
  adsExcluded: 0, // 광고/추천으로 판단해 제외한 카드 수
  candidates: 0, // "경량" 후보 수
  detailTargets: 0, // 이번 회차 상세 수집 대상 수
  detailSuccess: 0,
  detailFailed: 0,
  detailSkipped: 0, // 상한/시간초과로 이번 회차에 상세를 건너뛴 수
  rowsSaved: 0, // 최종 저장된 행 수 (경량 아우터)
  failures: [], // { stage, goodsNo, reason }
  missingFields: {}, // { 필드명: 누락 건수 }
  warnings: [],
};

function log(...args) {
  console.log(`[${kstString()}]`, ...args);
}

function warn(msg) {
  stats.warnings.push(msg);
  console.log(`[${kstString()}] ⚠️ ${msg}`);
}

function fail(stage, goodsNo, reason) {
  stats.failures.push({ stage, goodsNo, reason: String(reason).slice(0, 200) });
  console.log(`[${kstString()}] ❌ [${stage}] ${goodsNo || ''} ${reason}`);
}

function countMissing(field) {
  stats.missingFields[field] = (stats.missingFields[field] || 0) + 1;
}

/** 실패 원인을 "원인: 건수" 형태로 요약 */
function failureSummary() {
  const byReason = {};
  stats.failures.forEach((f) => {
    const key = `${f.stage}: ${f.reason.split('\n')[0].slice(0, 80)}`;
    byReason[key] = (byReason[key] || 0) + 1;
  });
  return Object.entries(byReason).map(([k, v]) => `${k} (${v}건)`).join(' / ');
}

module.exports = { stats, log, warn, fail, countMissing, failureSummary };
