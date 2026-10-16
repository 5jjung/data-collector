// 필터 / 순환 수집 단위 테스트
const test = require('node:test');
const assert = require('node:assert');
const f = require('../src/filter');

const det = (categoryName, categoryCode = '002') => ({ ok: true, categoryCode, categoryName });
const LIGHT_CAT = 'Clothing > 패딩/헤비 아우터 > 경량 패딩';
const SHORT_CAT = 'Clothing > 패딩/헤비 아우터 > 숏패딩/헤비 아우터';

test('1단계 후보: 경량 외에도 라이트/패딩/다운/패디드 이름은 상세 확인 대상', () => {
  [
    '[씬라이트] 여성 후드 재킷_SPJPG4TG24',
    '[10주년기획] © 모두의 Comfortemp® 미드웨이트 패딩_4 COLOR',
    '[시티 레저] 시어 후디드 라이트 다운 재킷 (9 colors)',
    '프리즘 패디드 레이어 자켓(4colors) NPD1596',
    '엑스 퓨즈 후디드 다운 자켓 V2_LD0275400',
    '컬러라마 코델 패딩 자켓 LGREY',
    '초경량 패딩 자켓',
  ].forEach((n) => assert.ok(f.isCandidate({ goodsName: n }), n));
  assert.ok(!f.isCandidate({ goodsName: '반팔 티셔츠' }));
});

test('경량 판정: 상품명 키워드 (씬라이트 / 미드웨이트 / 라이트 다운)', () => {
  assert.ok(f.judgeTarget({ goodsName: '[씬라이트] 여성 후드 재킷' }, det('Clothing > 점퍼/재킷 > 후드 집업')).include);
  assert.ok(f.judgeTarget({ goodsName: '모두의 미드웨이트 패딩' }, det(SHORT_CAT)).include);
  assert.ok(f.judgeTarget({ goodsName: '[시티 레저] 후디드 라이트 다운 재킷' }, det(SHORT_CAT)).include);
});

test('경량 판정: 이름에 키워드가 없어도 카테고리가 "경량 패딩"이면 포함', () => {
  const r = f.judgeTarget({ goodsName: '프리즘 패디드 레이어 자켓' }, det(LIGHT_CAT));
  assert.ok(r.include);
  assert.ok(r.reason.includes('카테고리 "경량"'));
});

test('헤비 패딩(숏패딩 카테고리 + 경량 키워드 없음)은 제외', () => {
  const r = f.judgeTarget({ goodsName: '헤비 구스 다운 파카' }, det(SHORT_CAT));
  assert.ok(!r.include);
});

test('아우터 아님(경량 슬랙스)은 제외, 스포츠웨어 안의 아우터는 포함', () => {
  assert.ok(!f.judgeTarget({ goodsName: '경량 슬랙스' }, det('Clothing > 바지 > 슬랙스', '003')).include);
  assert.ok(f.judgeTarget({ goodsName: '경량 후드 자켓' }, det('Sportswear > 아우터 > 후드 집업', '027')).include);
});

test('상세를 못 연 경우: 상품명으로만 판정', () => {
  assert.ok(f.judgeTarget({ goodsName: '경량 패딩 베스트' }, null).include);
  assert.ok(!f.judgeTarget({ goodsName: '컬러라마 코델 패딩 자켓' }, null).include); // 카테고리 확인 전에는 경량 근거 없음
});

test('상세 상한 초과 시 슬롯별 순환', () => {
  const c = Array.from({ length: 250 }, (_, i) => ({ rank: i + 1 }));
  const a = f.planDetailTargets(c, 0).targets;
  const b = f.planDetailTargets(c, 1).targets;
  assert.strictEqual(a[0].rank, 1);
  assert.strictEqual(b[0].rank, 121);
});
