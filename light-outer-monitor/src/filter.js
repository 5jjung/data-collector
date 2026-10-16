// ============================================================
// "경량 아우터" 필터 + 상세 수집 대상 선정
// ------------------------------------------------------------
// 1단계(목록) 후보: 상품명에 CANDIDATE_KEYWORDS(경량/라이트/패딩/다운/패디드 …) 중 하나라도 있으면 후보
//                  → 후보만 상세 페이지를 열어 카테고리를 확인
// 2단계(상세) 판정: 아래 두 조건을 모두 만족하면 저장
//   ① 아우터인가  : 카테고리 경로에 "아우터" 또는 대분류 002 (못 읽으면 상품명 아우터 키워드로 추정)
//   ② 경량인가    : 카테고리 경로에 "경량" (예: "패딩/헤비 아우터 > 경량 패딩")
//                   또는 상품명에 LIGHT_NAME_KEYWORDS(경량/라이트/씬/미드웨이트 …)
// 판정 근거는 "판정근거" 컬럼에 기록됩니다. (예: "아우터: 카테고리 … / 경량: 카테고리 경량 패딩")
//
// ✏️ 키워드는 config.js 에서 수정
// ============================================================

const config = require('../config');
const { normalize } = require('./parsers');

const findKeyword = (text, keywords) => {
  const t = normalize(text);
  return keywords.find((k) => t.includes(normalize(k))) || null;
};

/** 1단계: 상세 페이지를 열어 볼 후보인가 (상품명 기준, 넓게) */
function isCandidate(item) {
  return !!findKeyword(item.goodsName, config.CANDIDATE_KEYWORDS);
}

/** ① 아우터 판정 */
function judgeOuter(item, detail) {
  if (detail && detail.ok && (detail.categoryCode || detail.categoryName)) {
    const byCode = detail.categoryCode && config.OUTER_CATEGORY_CODES.includes(detail.categoryCode);
    const byName = detail.categoryName && config.OUTER_CATEGORY_NAMES.some((n) => detail.categoryName.includes(n));
    const desc = `카테고리 ${detail.categoryCode || ''} ${detail.categoryName || ''}`.replace(/\s+/g, ' ').trim();
    return { ok: !!(byCode || byName), reason: desc };
  }
  const kw = findKeyword(item.goodsName, config.OUTER_NAME_KEYWORDS);
  if (kw) return { ok: true, reason: `상품명 "${kw}" (카테고리 미확인 → 추정)` };
  return { ok: false, reason: '카테고리 미확인 + 아우터 키워드 없음' };
}

/** ② 경량 판정 */
function judgeLight(item, detail) {
  const catName = detail && detail.ok ? detail.categoryName : null;
  const catKw = catName ? config.LIGHT_CATEGORY_KEYWORDS.find((k) => catName.includes(k)) : null;
  if (catKw) return { ok: true, reason: `카테고리 "${catKw}"` };
  const kw = findKeyword(item.goodsName, config.LIGHT_NAME_KEYWORDS);
  if (kw) return { ok: true, reason: `상품명 "${kw}"` };
  return { ok: false, reason: catName ? `카테고리 "${catName}" + 상품명에 경량 키워드 없음` : '상품명에 경량 키워드 없음' };
}

/**
 * 최종 판정: 아우터 AND 경량
 * @returns {{ include: boolean, reason: string }}
 */
function judgeTarget(item, detail) {
  const outer = judgeOuter(item, detail);
  const light = judgeLight(item, detail);
  return {
    include: outer.ok && light.ok,
    reason: `아우터: ${outer.ok ? '' : '아님 - '}${outer.reason} / 경량: ${light.ok ? '' : '아님 - '}${light.reason}`,
  };
}

/**
 * 이번 회차에 상세 페이지를 열 대상 선정
 *  - 후보가 MAX_DETAIL_PER_RUN 이하이면 전부
 *  - 초과하면 순위순으로 묶음을 나누고, 슬롯마다 다른 묶음을 수집 (순환)
 *    → 이번 회차에 상세를 못 연 후보는 상품명 키워드로만 판정
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

module.exports = { isCandidate, judgeOuter, judgeLight, judgeTarget, planDetailTargets };
