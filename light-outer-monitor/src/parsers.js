// ============================================================
// 텍스트 / 숫자 파싱 유틸
// ------------------------------------------------------------
// 화면에 표시된 "문구"에서 숫자를 뽑아내는 규칙을 모아둔 파일입니다.
// 무신사가 문구를 바꾸면(예: "명이 보는 중" → "명이 보고 있어요")
// 아래 METRIC_RULES 의 정규식만 고치면 됩니다.
//
// 원칙
//  - 화면에 없는 값은 만들지 않는다 → 못 찾으면 null
//  - 숫자로 바꾼 값과 함께 "원문 문구"와 "어디서 찾았는지(위치)"를 같이 반환
// ============================================================

// 숫자 패턴: 1,234 / 1.2 / 1.2천 / 3만 / 999+ / 1.2k
const NUM = '(\\d[\\d,]*(?:\\.\\d+)?)\\s*(천|만|k|K)?\\s*(\\+)?';

/**
 * "1,234" → 1234, "1.2천" → 1200, "3만" → 30000, "999+" → 999
 * 숫자가 없으면 null
 */
function parseKoreanNumber(text) {
  if (text === null || text === undefined) return null;
  const m = String(text).match(new RegExp(NUM));
  if (!m) return null;
  let n = parseFloat(m[1].replace(/,/g, ''));
  if (Number.isNaN(n)) return null;
  const unit = m[2];
  if (unit === '천' || unit === 'k' || unit === 'K') n *= 1000;
  if (unit === '만') n *= 10000;
  return Math.round(n);
}

/**
 * 지표 분류 규칙
 * ------------------------------------------------------------
 * 조회수 / 실시간 보는 사람 / 누적 구매 인원 / 구매 건수 는 서로 다른 지표이므로
 * 각각 따로 찾습니다. 위에서부터 순서대로 검사하며, 한 문구가 두 지표로
 * 중복 분류되지 않도록 "명 구매"(인원)를 "구매 N건"(건수)보다 먼저 검사합니다.
 *
 * ✏️ 무신사 문구가 바뀌면 여기 정규식을 수정하세요.
 */
const METRIC_RULES = [
  {
    key: 'liveViewers', // 실시간(현재) 보는 사람 수
    label: '실시간 보는 사람 수',
    patterns: [
      new RegExp(`${NUM}\\s*명(?:이|의)?\\s*(?:지금\\s*)?(?:보는\\s*중|보고\\s*있|보고있|조회\\s*중|구경\\s*중)`),
      new RegExp(`(?:지금|현재|실시간)\\s*${NUM}\\s*명(?:이)?\\s*(?:보|구경)`),
    ],
  },
  {
    key: 'viewCount', // 조회수 (누적 조회)
    label: '조회수',
    patterns: [new RegExp(`조회(?:수)?\\s*${NUM}`), new RegExp(`${NUM}\\s*회\\s*조회`)],
  },
  {
    key: 'liveBuyers', // 실시간 구매 중 인원 (랭킹 카드 "1.2만명이 구매 중")
    label: '실시간 구매중 인원',
    patterns: [new RegExp(`${NUM}\\s*명(?:이)?\\s*구매\\s*중`)],
  },
  {
    key: 'buyerCount', // 누적 구매 인원 (N명이 구매했어요)
    label: '누적 구매 인원',
    patterns: [new RegExp(`${NUM}\\s*명(?:이|의)?\\s*(?:\\S+\\s*)?(?:구매|샀)`)],
  },
  {
    key: 'purchaseCount', // 구매 건수 (구매 N건 / N개 구매 / 구매 1.2천+)
    label: '구매 건수',
    patterns: [
      new RegExp(`구매\\s*${NUM}\\s*(?:건|개|회)?`),
      new RegExp(`${NUM}\\s*(?:건|개)\\s*(?:구매|판매)`),
      new RegExp(`판매\\s*${NUM}`),
    ],
  },
  {
    key: 'reviewCount', // 리뷰(후기) 수
    label: '리뷰 수',
    patterns: [new RegExp(`(?:리뷰|후기)\\s*\\(?\\s*${NUM}`), new RegExp(`${NUM}\\s*개?\\s*(?:리뷰|후기)`)],
  },
  {
    key: 'likeCount', // 좋아요 수 (문구로 표시된 경우)
    label: '좋아요 수',
    patterns: [new RegExp(`(?:좋아요|찜|♥|❤|♡)\\s*${NUM}`)],
  },
];

/**
 * 여러 줄의 텍스트에서 지표들을 찾아 반환
 * - 한 줄에 여러 문구가 붙어 있어도("21명이 보는 중14명이 구매 중") 문구 단위로 따로 인식
 * - 한 문구가 두 지표로 중복 분류되지 않도록, 이미 사용한 글자 범위는 건너뜀
 * @param {string[]} lines     화면에서 읽은 텍스트 줄 목록
 * @param {string}   location  찾은 위치 설명 (예: "랭킹목록 카드", "상세페이지 화면")
 * @returns {Object} { liveViewers: {value, raw, location} | null, ... }
 *          raw = 화면 문구 원문(매칭된 부분), 못 찾으면 null
 */
function extractMetrics(lines, location) {
  const result = {};
  METRIC_RULES.forEach((r) => (result[r.key] = null));
  const used = lines.map(() => []); // 줄별로 이미 분류된 [시작, 끝] 범위

  for (const rule of METRIC_RULES) {
    for (let i = 0; i < lines.length && !result[rule.key]; i++) {
      const line = String(lines[i] || '').replace(/\s+/g, ' ').trim();
      if (!line || line.length > 200) continue; // 너무 긴 줄은 설명문일 가능성이 커서 제외
      for (const p of rule.patterns) {
        const g = new RegExp(p.source, 'g');
        let m;
        while ((m = g.exec(line))) {
          const [a, b] = [m.index, m.index + m[0].length];
          if (used[i].some(([x, y]) => a < y && b > x)) continue; // 다른 지표가 이미 쓴 문구
          result[rule.key] = { value: parseKoreanNumber(m[0]), raw: m[0].trim(), location };
          used[i].push([a, b]);
          break;
        }
        if (result[rule.key]) break;
      }
    }
  }
  return result;
}

/**
 * 배송 관련 문구(무료배송 / 당일출고 / 무배당발) 탐지 — 텍스트 기준 보조 판정
 * 랭킹 카드는 data-item-flag="plusdelivery"(무배당발 아이콘) 속성으로 먼저 판정하고
 * (rankingList.js), 속성이 없을 때만 이 문구 판정을 사용합니다.
 * ✏️ "무배당" 판정 기준을 바꾸려면 isMuBaeDang 계산식을 수정하세요.
 */
function extractDeliveryBadges(lines, location) {
  const free = lines.find((l) => /무료\s*배송|무배/.test(l));
  const today = lines.find((l) => /당일\s*(?:출고|발송|배송)|오늘\s*출발|오늘\s*도착/.test(l));
  const plus = lines.find((l) => /무배당/.test(l)); // "무배당발" 문구
  const raw = [plus, free, today].filter(Boolean).map((s) => s.trim());
  return {
    freeShipping: free ? 'Y' : 'N',
    sameDayShip: today ? 'Y' : 'N',
    isMuBaeDang: plus || (free && today) ? 'Y' : 'N',
    raw: raw.length ? Array.from(new Set(raw)).join(' | ') : null,
    location: raw.length ? location : null,
  };
}

/**
 * 카드 텍스트에서 가격 / 할인율 추출
 *  - "원"이 붙은 금액이 2개 이상이면: 큰 값 = 정상가, 작은 값 = 판매가
 *  - 1개뿐이면: 판매가만 (정상가는 화면에 없으므로 null)
 */
function extractPrices(lines) {
  const prices = [];
  let discount = null;
  for (const line of lines) {
    const s = String(line);
    for (const m of s.matchAll(/(\d{1,3}(?:,\d{3})+|\d{3,})\s*원/g)) {
      prices.push(Number(m[1].replace(/,/g, '')));
    }
    if (discount === null) {
      const d = s.match(/(\d{1,2})\s*%/);
      if (d) discount = Number(d[1]);
    }
  }
  const uniq = Array.from(new Set(prices)).filter((p) => p >= 100);
  if (uniq.length === 0) return { normalPrice: null, salePrice: null, discountRate: discount };
  if (uniq.length === 1) return { normalPrice: null, salePrice: uniq[0], discountRate: discount };
  return { normalPrice: Math.max(...uniq), salePrice: Math.min(...uniq), discountRate: discount };
}

/** 광고 / 추천 카드 여부 (카드 텍스트 기준) */
function looksLikeAd(lines) {
  return lines.some((l) => /^(AD|Ad|광고|추천|SPONSORED|Sponsored)$/.test(String(l).trim()));
}

/** 랭킹 순위 숫자 찾기: 카드 맨 앞쪽의 1~3자리 숫자 단독 줄 */
function extractRank(lines, maxRank) {
  for (const l of lines.slice(0, 4)) {
    const t = String(l).trim();
    if (/^\d{1,3}$/.test(t)) {
      const n = Number(t);
      if (n >= 1 && n <= maxRank) return n;
    }
  }
  return null;
}

/** 상품 URL에서 상품코드 추출 */
function goodsNoFromUrl(url) {
  const m = String(url || '').match(/\/(?:products|goods|app\/goods)\/(\d{4,})(?:[/?#]|$)/);
  return m ? m[1] : null;
}

/** 비교용 정규화: 공백 제거 + 소문자 */
function normalize(s) {
  return String(s || '').replace(/\s+/g, '').toLowerCase();
}

module.exports = {
  parseKoreanNumber,
  extractMetrics,
  extractDeliveryBadges,
  extractPrices,
  looksLikeAd,
  extractRank,
  goodsNoFromUrl,
  normalize,
  METRIC_RULES,
};
