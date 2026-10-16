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
  assert.ok(f.judgeTarget({ goodsName: '[씬라이트] 여성 후드 재킷' }, det(SHORT_CAT)).include); // 패딩 카테고리 + 씬라이트
  assert.ok(!f.judgeTarget({ goodsName: '라이트웨이트 후드 집업' }, det('Clothing > 후드 집업')).include); // 패딩류 아님
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

// ── 2026-10-16 14:10 실제 수집 결과로 만든 회귀 테스트 (상품명, 카테고리 경로, 기대 결과) ──
const REAL = [
  ['컨투어 크롭 다운 자켓_LD0396800', 'Sportswear > 아우터 > 숏 패딩/숏 헤비 아우터', false],
  ['NJ1DS51K 칼릭스 LT 다운 자켓 (RDS) STEEL GRAY', 'Sportswear > 아우터 > 경량 패딩', true],
  ['멘즈 라이트웨이트 신칠라 스냅-티 풀오버 / 25551R7', 'Sportswear > 아우터 > 플리스', false],
  ['(우먼)라이트 시어쉘 패딩 점퍼 - 6 COLOR', 'Clothing > 패딩/헤비 아우터 > 경량 패딩', true],
  ['[시티 레저] 시어 후디드 라이트 다운 재킷 (9 colors)', 'Clothing > 패딩/헤비 아우터 > 경량 패딩', true],
  ['[10주년기획] © 모두의 Comfortemp® 미드웨이트 패딩_4 COLOR', 'Clothing > 패딩/헤비 아우터 > 경량 패딩', true],
  ['[씬라이트] 여성 후드 재킷_SPJPG4TG24', 'Clothing > 패딩/헤비 아우터 > 경량 패딩', true],
  ['페이크퍼 후드 패딩_MIWJPGV51C', 'Clothing > 패딩/헤비 아우터 > 숏 패딩/숏 헤비 아우터', false],
  ['1958 MA-1 3rd Model Flight Jacket (Black Label)', 'Clothing > 점퍼/재킷 > 항공 점퍼/블루종/MA-1', false],
  ['SYMBOL B LIGHTWEIGHT PADDED JACKET [BLACK]', 'Sportswear > 아우터 > 하프 패딩/하프 헤비 아우터', true],
  ['[시티 레저] 그리드 폴라 플리스 바라클라바 후디드 집업 [라이트 그레이]', 'Clothing > 점퍼/재킷 > 플리스', false],
  ['ACG 파이브 타워스 UV 프로텍션 재킷 - 라이트 크림슨:서밋 화이트 / IF0960-696', 'Sportswear > 아우터 > 나일론/코치 재킷', false],
  ['Curly fluffy fur jacket_Light gray', 'Clothing > 무스탕/퍼', false],
  ['LIGHTWEIGHT LOOSE HOODIE ZIP-UP BLACK', 'Clothing > 후드 집업', false],
  ['프리즘 패디드 레이어 자켓(4colors) NPD1596', 'Clothing > 패딩/헤비 아우터 > 경량 패딩', true],
  ['엑스 퓨즈 후디드 다운 자켓 V2_LD0275400', 'Sportswear > 아우터 > 숏 패딩/숏 헤비 아우터', true],
  ['[핑거홀]하이넥 크롭 경량 플리스 집업 4COLOR', 'Clothing > 점퍼/재킷 > 플리스', true],
  ['컬러라마 코델 패딩 자켓 LGREY', 'Sportswear > 아우터 > 경량 패딩', true],
  ['[시티 레저] 후디드 라이트 다운 재킷 [블루 그레이]', 'Clothing > 패딩/헤비 아우터 > 경량 패딩', true],
  ['멘즈 피츠 로이 다운 후디 / 85501R7', 'Sportswear > 아우터 > 하프 패딩/하프 헤비 아우터', false],
  ['아스트랄라이트 네온라이터 미니 5Color', 'Beauty > 베이스 메이크업 > 하이라이터', false],
];

test('실제 수집 결과 회귀 테스트 (색상명 "라이트 그레이"/Flight 오탐 제거, 사용자 예시 포함)', () => {
  for (const [name, cat, expected] of REAL) {
    const code = /아우터|점퍼|무스탕|후드 집업/.test(cat) ? '002' : '104';
    const r = f.judgeTarget({ goodsName: name, goodsNo: '1' }, det(cat, code));
    assert.strictEqual(r.include, expected, `${name} → ${r.reason}`);
  }
});
