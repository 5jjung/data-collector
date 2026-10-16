// 상세 페이지 파싱 테스트 (2026-10 실제 페이지 구조 기준)
const test = require('node:test');
const assert = require('node:assert');
const { findGoodsState, labelValue, findCategory } = require('../src/productDetail');

const nextData = {
  props: { pageProps: { meta: { data: {
    goodsNo: 7159260, goodsNm: '[에어클라우드]사선지퍼 경량 패딩 자켓',
    goodsPrice: { salePrice: 93740, normalPrice: 109000, discountRate: 14, couponPrice: 89000, finalPrice: 93740 },
    goodsReview: { totalCount: 17, satisfactionScore: 4.8 },
    isPlusDelivery: false,
    baseCategory: '027001016',
    baseCategoryFullPath: 'Sportswear > 아우터 > 후드 집업',
  } } } },
};

test('내장데이터에서 가격/리뷰 찾기', () => {
  const g = findGoodsState(nextData);
  assert.strictEqual(g.goodsPrice.normalPrice, 109000);
  assert.strictEqual(g.goodsPrice.salePrice, 93740);
  assert.strictEqual(g.goodsReview.totalCount, 17);
});

test('카테고리 전체 경로로 아우터 판정 가능', () => {
  const c = findCategory(nextData);
  assert.strictEqual(c.code, '027');
  assert.ok(c.name.includes('아우터'));
});

test('라벨 다음 줄 값 읽기 (조회수/누적판매)', () => {
  const lines = ['시즌', '2026 FW', '조회수', '2.6천 회 이상 (최근 1개월)', '누적판매', '50개 이상'];
  assert.deepStrictEqual(labelValue(lines, '조회수', 'x'), { value: 2600, raw: '조회수 2.6천 회 이상 (최근 1개월)', location: 'x' });
  assert.strictEqual(labelValue(lines, '누적판매', 'x').value, 50);
  assert.strictEqual(labelValue(lines, '없는라벨', 'x'), null);
});
