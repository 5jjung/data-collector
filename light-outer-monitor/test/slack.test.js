// 슬랙 알림 / 일일 요약 테스트 (실제 전송 없음: 웹후크 미설정 시 로그만 출력)
const test = require('node:test');
const assert = require('node:assert');
const { problemOf } = require('../src/notify');
const { summarize, buildMessage, reportDate } = require('../src/dailyReport');

test('문제 판정: 정상 / 실패원인 / 누락 / 랭킹 부족', () => {
  const ok = { 랭킹수집건수: '500', 실패원인: '-', 누락항목통계: '-' };
  assert.strictEqual(problemOf(ok), '');
  assert.ok(problemOf({ ...ok, 실패원인: '상세: HTTP 404 (1건)' }).includes('실패'));
  assert.ok(problemOf({ ...ok, 누락항목통계: '상세_소비자가:7' }).includes('누락'));
  assert.ok(problemOf({ ...ok, 랭킹수집건수: '120' }).includes('120/500'));
});

test('일일 요약: 상품별 최고순위·좋아요 증가·평균 보는중', () => {
  const rows = [
    { 수집슬롯_KST: '2026-10-16 13:00', 상품코드: '1', 상품명: 'A 경량 패딩', 브랜드명: 'X', 상품URL: 'u', 랭킹순위: '20', 목록_실시간보는사람수: '100', 좋아요수: '1000', 상세_누적판매: '2400', 목록_판매가: '93740', 목록_할인율: '14', 무배당여부: 'N' },
    { 수집슬롯_KST: '2026-10-16 13:30', 상품코드: '1', 상품명: 'A 경량 패딩', 브랜드명: 'X', 상품URL: 'u', 랭킹순위: '15', 목록_실시간보는사람수: '300', 좋아요수: '1050', 상세_누적판매: '2500', 목록_판매가: '93740', 목록_할인율: '14', 무배당여부: 'N' },
    { 수집슬롯_KST: '2026-10-16 13:30', 상품코드: '2', 상품명: 'B 라이트 다운', 브랜드명: 'Y', 상품URL: 'u2', 랭킹순위: '40', 목록_실시간보는사람수: 'NULL', 좋아요수: 'NULL', 상세_누적판매: 'NULL', 목록_판매가: '139900', 목록_할인율: '0', 무배당여부: 'Y' },
  ];
  const items = summarize(rows);
  assert.strictEqual(items[0].goodsNo, '1');
  assert.strictEqual(items[0].bestRank, 15);
  assert.strictEqual(items[0].lastRank, 15);
  assert.strictEqual(items[0].avgViewers, 200);
  assert.strictEqual(items[0].likeDelta, 50);
  assert.strictEqual(items[1].avgViewers, null); // NULL 은 0 으로 계산하지 않음
  const msg = buildMessage('2026-10-16', items, [{ 수집슬롯_KST: '2026-10-16 13:00', 랭킹수집건수: '500', 실패원인: '-', 누락항목통계: '-' }]);
  assert.ok(msg.includes('수집 1회'));
  assert.ok(msg.includes('경량 아우터 2종'));
  assert.ok(msg.includes('15위→15위'));
});

test('요약 날짜: 자정 넘겨 실행되면 전날', () => {
  assert.strictEqual(reportDate(new Date('2026-10-16T14:55:00Z')), '2026-10-16'); // 23:55 KST
  assert.strictEqual(reportDate(new Date('2026-10-16T15:20:00Z')), '2026-10-16'); // 다음날 00:20 KST → 전날
});
