// 파서 단위 테스트: npm test
// 무신사 문구 규칙(parsers.js)을 수정한 뒤 이 테스트로 기존 문구가 여전히 잘 읽히는지 확인하세요.

const test = require('node:test');
const assert = require('node:assert');
const p = require('../src/parsers');

test('숫자 파싱: 쉼표/천/만/+', () => {
  assert.strictEqual(p.parseKoreanNumber('1,234명'), 1234);
  assert.strictEqual(p.parseKoreanNumber('1.2천+'), 1200);
  assert.strictEqual(p.parseKoreanNumber('3만'), 30000);
  assert.strictEqual(p.parseKoreanNumber('999+'), 999);
  assert.strictEqual(p.parseKoreanNumber('없음'), null);
});

test('지표 분류: 보는사람 / 구매인원 / 구매건수 / 조회수 / 리뷰는 서로 다른 칸', () => {
  const m = p.extractMetrics(
    ['1,234명이 보는 중', '320명이 구매했어요', '구매 1.2천+', '조회 5,600', '후기 87', '좋아요 1.5만'],
    '테스트'
  );
  assert.strictEqual(m.liveViewers.value, 1234);
  assert.strictEqual(m.buyerCount.value, 320);
  assert.strictEqual(m.purchaseCount.value, 1200);
  assert.strictEqual(m.viewCount.value, 5600);
  assert.strictEqual(m.reviewCount.value, 87);
  assert.strictEqual(m.likeCount.value, 15000);
  assert.strictEqual(m.liveViewers.raw, '1,234명이 보는 중');
  assert.strictEqual(m.liveViewers.location, '테스트');
});

test('화면에 없는 지표는 0 이 아니라 null', () => {
  const m = p.extractMetrics(['브랜드', '상품명', '39,900원'], '테스트');
  assert.strictEqual(m.liveViewers, null);
  assert.strictEqual(m.purchaseCount, null);
});

test('가격: 2개면 정상가/판매가, 1개면 판매가만', () => {
  assert.deepStrictEqual(p.extractPrices(['30%', '27,930원', '39,900원']), { normalPrice: 39900, salePrice: 27930, discountRate: 30 });
  assert.deepStrictEqual(p.extractPrices(['15% 59,000원']), { normalPrice: null, salePrice: 59000, discountRate: 15 });
});

test('광고 / 순위 / 상품코드', () => {
  assert.ok(p.looksLikeAd(['AD', '브랜드']));
  assert.ok(!p.looksLikeAd(['ADIDAS', '브랜드']));
  assert.strictEqual(p.extractRank(['12', '브랜드', '상품'], 500), 12);
  assert.strictEqual(p.extractRank(['브랜드', '상품'], 500), null);
  assert.strictEqual(p.goodsNoFromUrl('https://www.musinsa.com/products/4123456?x=1'), '4123456');
});

test('실시간 구매중 인원은 누적 구매 인원과 다른 칸', () => {
  const m = p.extractMetrics(['1.9만명이 보는 중', '1,234명이 구매 중'], '카드');
  assert.strictEqual(m.liveViewers.value, 19000);
  assert.strictEqual(m.liveBuyers.value, 1234);
  assert.strictEqual(m.buyerCount, null);
});

test('무배당: "무배당발" 문구 또는 무료배송+당일출고', () => {
  assert.strictEqual(p.extractDeliveryBadges(['무배당발'], 'x').isMuBaeDang, 'Y');
  assert.strictEqual(p.extractDeliveryBadges(['무료배송', '당일출고'], 'x').isMuBaeDang, 'Y');
  assert.strictEqual(p.extractDeliveryBadges(['무료배송'], 'x').isMuBaeDang, 'N');
});

test('랭킹 카드 data-index 순위 (0부터 시작하면 +1 보정)', () => {
  const { cardRank } = require('../src/rankingList');
  assert.strictEqual(cardRank({ data: { index: '0' }, lines: [] }, 1), 1);
  assert.strictEqual(cardRank({ data: { index: '12' }, lines: [] }, 0), 12);
  assert.strictEqual(cardRank({ data: null, lines: ['7', '브랜드'] }), 7);
});

test('한 줄에 붙은 문구도 각각 인식 (원문은 해당 문구만)', () => {
  const m = p.extractMetrics(['초경량 패딩 30%27,930원21명이 보는 중14명이 구매 중'], '카드');
  assert.strictEqual(m.liveViewers.value, 21);
  assert.strictEqual(m.liveViewers.raw, '21명이 보는 중');
  assert.strictEqual(m.liveBuyers.value, 14);
  assert.strictEqual(m.liveBuyers.raw, '14명이 구매 중');
});
