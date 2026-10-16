// ============================================================
// "경량 아우터" 필터 + 상세 수집 대상 선정
// ------------------------------------------------------------
// 1단계(목록): 상품명에 INCLUDE_KEYWORDS("경량") 가 들어간 상품만 후보로 선정
// 2단계(상세): 상세 페이지의 카테고리 대분류가 아우터(002)인지 확인
//             카테고리를 못 읽은 경우에만 상품명 키워드(패딩/자켓 등)로 보조 판정
// 판정 결과와 근거는 "아우터판정", "아우터판정근거" 컬럼에 기록됩니다.
// ============================================================

const config = require('../config');
const { normalize } = require('./parsers');

/** 1단계: 상품명에 "경량" 포함 여부 */
function isCandidate(item) {
  const name = normalize(item.goodsName);
  return config.INCLUDE_KEYWORDS.some((k) => name.includes(normalize(k)));
}

/**
 * 2단계: 아우터 판정
 * @returns {{ isOuter: boolean, reason: string }}
 */
function judgeOuter(item, detail) {
  if (detail && detail.ok && (detail.categoryCode || detail.categoryName)) {
    const byCode = detail.categoryCode && config.OUTER_CATEGORY_CODES.includes(detail.categoryCode);
    const byName = detail.categoryName && config.OUTER_CATEGORY_NAMES.some((n) => detail.categoryName.includes(n));
    const desc = `카테고리 ${detail.categoryCode || ''} ${detail.categoryName || ''} (${detail.categoryLocation})`.replace(/\s+/g, ' ');
    return { isOuter: !!(byCode || byName), reason: desc };
  }
  const name = normalize(item.goodsName);
  const kw = config.OUTER_NAME_KEYWORDS.find((k) => name.includes(normalize(k)));
  if (kw) return { isOuter: true, reason: `상품명 키워드 "${kw}" (카테고리 미확인 → 추정)` };
  return { isOuter: false, reason: '카테고리 미확인 + 아우터 키워드 없음' };
}

/**
 * 이번 회차에 상세 페이지를 열 대상 선정
 *  - 후보가 MAX_DETAIL_PER_RUN 이하이면 전부
 *  - 초과하면 순위순으로 묶음을 나누고, 슬롯마다 다른 묶음을 수집 (순환)
 *    → 랭킹 목록 값(순위/가격/보는사람/구매)은 매 회차 전 상품 기록, 상세값만 순환
 */
function planDetailTargets(candidates, slotIdx) {
  const max = config.MAX_DETAIL_PER_RUN;
  if (candidates.length <= max) return { targets: candidates, note: '전체 상세 수집' };
  const groups = Math.ceil(candidates.length / max);
  const g = slotIdx % groups;
  const sorted = candidates.slice().sort((a, b) => a.rank - b.rank);
  return {
    targets: sorted.slice(g * max, (g + 1) * max),
    note: `후보 ${candidates.length}개 > 상한 ${max} → ${groups}개 묶음 중 ${g + 1}번째 수집 (순환)`,
  };
}

module.exports = { isCandidate, judgeOuter, planDetailTargets };
