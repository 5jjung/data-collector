// ============================================================
// 네트워크 응답(JSON) 안에서 "상품 정보"를 찾아내는 유틸
// ------------------------------------------------------------
// 무신사 랭킹/상세 페이지는 화면을 그릴 때 내부 API(JSON)를 호출합니다.
// JSON 구조가 바뀌어도 최대한 버틸 수 있도록, 특정 경로를 고정하지 않고
// "상품코드처럼 생긴 필드가 있는 객체"를 전부 찾아 아래 별칭(KEY_ALIASES)으로 값을 읽습니다.
//
// ✏️ 무신사가 필드 이름을 바꾸면 KEY_ALIASES 에 새 이름을 추가하세요.
// ============================================================

const { extractMetrics, extractDeliveryBadges, parseKoreanNumber } = require('./parsers');

const KEY_ALIASES = {
  goodsNo: ['goodsNo', 'goodsNumber', 'productNo', 'productId', 'itemId', 'id'],
  goodsName: ['goodsName', 'goodsNm', 'productName', 'itemName', 'name', 'title'],
  brandName: ['brandName', 'brandNm', 'brandNameKor', 'brand'],
  rank: ['rank', 'ranking', 'currentRank', 'rankNo', 'rankNum'],
  normalPrice: ['normalPrice', 'originalPrice', 'consumerPrice', 'listPrice', 'price'],
  salePrice: ['finalPrice', 'salePrice', 'sellPrice', 'discountPrice', 'goodsPrice'],
  discountRate: ['discountRate', 'discountRatio', 'saleRate', 'discount'],
  reviewCount: ['reviewCount', 'reviewCnt', 'totalReviewCount'],
  isAd: ['isAd', 'ad', 'adYn', 'isAdvertisement', 'advertisement'],
};

// 객체에서 별칭 목록 중 처음으로 값이 있는 키를 찾아 반환
function pick(obj, aliases) {
  for (const k of aliases) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return { key: k, value: obj[k] };
  }
  return null;
}

// 객체 안의 모든 문자열을 모음 (화면 표시용 문구를 찾기 위함)
function collectStrings(node, out, depth = 0) {
  if (depth > 6 || node === null || node === undefined) return;
  if (typeof node === 'string') {
    if (node.length <= 80) out.push(node);
    return;
  }
  if (typeof node !== 'object') return;
  Object.values(node).forEach((v) => collectStrings(v, out, depth + 1));
}

function toNumberOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'object') return null;
  return parseKoreanNumber(v);
}

/**
 * JSON 전체를 돌며 상품 객체를 찾아 표준 형태로 반환
 * @param {any}    json
 * @param {string} sourceUrl  이 JSON을 받은 API 주소 (위치 기록용)
 * @returns {Array<Object>}
 */
function findGoodsInJson(json, sourceUrl) {
  const out = [];
  const walk = (node, path, depth) => {
    if (!node || typeof node !== 'object' || depth > 14) return;
    if (Array.isArray(node)) {
      node.forEach((n, i) => walk(n, `${path}[${i}]`, depth + 1));
      return;
    }

    const idHit = pick(node, KEY_ALIASES.goodsNo);
    const nameHit = pick(node, KEY_ALIASES.goodsName);
    // 'id' 같은 흔한 키는 오탐이 많으므로: 숫자 4자리 이상 + 이름/브랜드/가격 중 하나가 같이 있어야 상품으로 인정
    const looksLikeGoods =
      idHit &&
      /^\d{4,}$/.test(String(idHit.value)) &&
      (nameHit || pick(node, KEY_ALIASES.brandName) || pick(node, KEY_ALIASES.salePrice) || idHit.key !== 'id');

    if (looksLikeGoods) {
      const strings = [];
      collectStrings(node, strings);
      const loc = `API응답 ${shortUrl(sourceUrl)} ${path}`;
      const brand = pick(node, KEY_ALIASES.brandName);
      const ad = pick(node, KEY_ALIASES.isAd);
      out.push({
        goodsNo: String(idHit.value),
        goodsName: nameHit && typeof nameHit.value === 'string' ? nameHit.value : null,
        brandName: brand && typeof brand.value === 'string' ? brand.value : brand?.value?.name || null,
        rank: toNumberOrNull(pick(node, KEY_ALIASES.rank)?.value),
        normalPrice: toNumberOrNull(pick(node, KEY_ALIASES.normalPrice)?.value),
        salePrice: toNumberOrNull(pick(node, KEY_ALIASES.salePrice)?.value),
        discountRate: toNumberOrNull(pick(node, KEY_ALIASES.discountRate)?.value),
        reviewCount: toNumberOrNull(pick(node, KEY_ALIASES.reviewCount)?.value),
        isAd: ad ? ad.value === true || ad.value === 'Y' || ad.value === 'true' : false,
        textMetrics: extractMetrics(strings, loc), // 표시용 문구에서 찾은 지표
        delivery: extractDeliveryBadges(strings, loc),
        location: loc,
      });
    }
    Object.entries(node).forEach(([k, v]) => walk(v, `${path}.${k}`, depth + 1));
  };
  walk(json, '$', 0);
  return out;
}

function shortUrl(u) {
  try {
    const x = new URL(u);
    return x.host + x.pathname;
  } catch (e) {
    return String(u).slice(0, 80);
  }
}

module.exports = { findGoodsInJson, KEY_ALIASES, shortUrl };
