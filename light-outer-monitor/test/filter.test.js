// 필터 / 순환 수집 단위 테스트
const test = require('node:test');
const assert = require('node:assert');
const f = require('../src/filter');

test('"경량" 후보 판정 (띄어쓰기 무시)', () => {
  assert.ok(f.isCandidate({ goodsName: '초경량 패딩 자켓' }));
  assert.ok(!f.isCandidate({ goodsName: '헤비 다운 파카' }));
});

test('아우터 판정: 카테고리 우선, 없으면 상품명 키워드', () => {
  const d = { ok: true, categoryCode: '002', categoryName: '아우터', categoryLocation: 'x' };
  assert.ok(f.judgeOuter({ goodsName: '경량 패딩' }, d).isOuter);
  assert.ok(!f.judgeOuter({ goodsName: '경량 패딩' }, { ...d, categoryCode: '001', categoryName: '상의' }).isOuter);
  assert.ok(f.judgeOuter({ goodsName: '경량 패딩 베스트' }, null).isOuter);
  assert.ok(!f.judgeOuter({ goodsName: '경량 슬랙스' }, null).isOuter);
});

test('상세 상한 초과 시 슬롯별 순환', () => {
  const c = Array.from({ length: 130 }, (_, i) => ({ rank: i + 1 }));
  const a = f.planDetailTargets(c, 0).targets;
  const b = f.planDetailTargets(c, 1).targets;
  assert.strictEqual(a[0].rank, 1);
  assert.strictEqual(b[0].rank, 61);
});
