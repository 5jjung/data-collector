// ============================================================
// 저장할 컬럼(열) 정의
// ------------------------------------------------------------
// ✏️ 컬럼 순서/이름을 바꾸고 싶으면 COLUMNS 배열만 수정하세요.
//    컬럼 구성을 바꾸면 그날 CSV 는 "_v2" 새 파일로 자동 분리되어 기존 데이터와 섞이지 않습니다.
//
// 값이 없으면 null → 저장 시 config.NULL_TEXT("NULL") 로 기록 (0 으로 채우지 않음)
// ============================================================

const config = require('../config');
const { countMissing } = require('./logger');

// 지표 3종 세트(값/원문/위치) 를 만드는 도우미
const metricCols = (header, getter) => [
  [header, (r) => getter(r)?.value ?? null],
  [`${header}_원문`, (r) => getter(r)?.raw ?? null],
  [`${header}_위치`, (r) => getter(r)?.location ?? null],
];

const L = (k) => (r) => r.list.metrics[k]; // 목록 지표
const D = (k) => (r) => (r.detail && r.detail.ok ? r.detail.metrics[k] : null); // 상세 지표
const det = (fn) => (r) => (r.detail && r.detail.ok ? fn(r.detail) : null);

const COLUMNS = [
  // ── 기본 정보 ──
  ['수집키', (r) => `${r.slot}|${r.list.goodsNo}`], // 중복 저장 방지용 (슬롯 + 상품코드)
  ['수집슬롯_KST', (r) => r.slot], // 정각/30분 기준
  ['수집일시_KST', (r) => r.collectedAt], // 실제 수집 시각
  ['랭킹순위', (r) => r.list.rank],
  ['순위출처', (r) => r.list.rankSource],
  ['상품코드', (r) => r.list.goodsNo],
  ['상품명', (r) => r.list.goodsName],
  ['브랜드명', (r) => r.list.brandName],
  ['브랜드코드', (r) => r.list.brandCode],
  ['상품URL', (r) => r.list.productUrl],
  ['판정근거', (r) => r.outerReason], // 아우터/경량 판정 근거 (카테고리 또는 상품명 키워드)

  // ── 랭킹 목록에 표시된 값 ──
  ['목록_정상가', (r) => r.list.normalPrice],
  ['목록_판매가', (r) => r.list.salePrice],
  ['목록_할인율', (r) => r.list.discountRate],
  ['목록_가격위치', (r) => r.list.priceSource],
  ...metricCols('목록_실시간보는사람수', L('liveViewers')),
  ...metricCols('목록_실시간구매중인원', L('liveBuyers')),
  ...metricCols('목록_조회수', L('viewCount')),
  ...metricCols('목록_누적구매인원', L('buyerCount')),
  ...metricCols('목록_누적판매', L('purchaseCount')), // 예: "판매 2.4천"
  ...metricCols('목록_리뷰수', L('reviewCount')),

  // ── 좋아요 (무신사 좋아요 API = 상세페이지 하트 숫자) ──
  ['좋아요수', (r) => r.likeCount],
  ['좋아요_위치', (r) => (r.likeCount !== null ? '좋아요 API(상세페이지 하트 숫자)' : null)],

  // ── 무배당(무배당발) : 랭킹 카드의 plusdelivery 플래그/아이콘 기준 ──
  ['무배당여부', (r) => r.delivery.isMuBaeDang],
  ['무배당_원문', (r) => r.delivery.raw],
  ['무배당_위치', (r) => r.delivery.location],
  ['무료배송문구', (r) => r.delivery.freeShipping],
  ['당일출고문구', (r) => r.delivery.sameDayShip],

  // ── 상세 페이지 값 ──
  ['상세_수집상태', (r) => (r.detail ? (r.detail.ok ? '성공' : `실패: ${r.detail.error}`) : r.detailNote || '미대상')],
  ['상세_상품코드', det((d) => d.goodsNo)],
  ['상세_상품명', det((d) => d.goodsName)],
  ['상세_카테고리', det((d) => [d.categoryCode, d.categoryName].filter(Boolean).join(' ') || null)],
  ['상세_소비자가', det((d) => d.price.normalPrice)],
  ['상세_할인가', det((d) => d.price.salePrice)],
  ['상세_할인율', det((d) => d.price.discountRate)],
  ['상세_가격위치', det((d) => d.price.location)],
  ...metricCols('상세_현재보는사람수', D('liveViewers')), // "N명이 보고 있어요"
  ...metricCols('상세_조회수', D('viewCount')), // "조회수 2.6천 회 이상 (최근 1개월)"
  ...metricCols('상세_누적판매', D('purchaseCount')), // "누적판매 50개 이상"
  ...metricCols('상세_리뷰수', D('reviewCount')), // 내장데이터 goodsReview.totalCount
  ['상세_무배당', det((d) => (d.delivery.decided ? d.delivery.isMuBaeDang : null))],

  // ── 누락 점검 ──
  ['누락항목', (r) => r.missing.join(', ') || null],
];

// "누락항목" 점검 대상: 이 값들이 비어 있으면 누락으로 기록 (오류 수정 포인트)
// ✏️ 화면에 원래 표시되지 않는 지표(예: 조회수)는 여기 넣지 않아야 오탐이 없습니다.
// (리뷰수는 랭킹 카드에 표시되지 않을 수 있어 상세에서만 필수로 점검)
const REQUIRED_FIELDS = ['랭킹순위', '상품코드', '상품명', '브랜드명', '목록_판매가', '좋아요수'];
const REQUIRED_IF_DETAIL = ['상세_상품명', '상세_소비자가', '상세_할인가', '상세_리뷰수'];

const HEADERS = COLUMNS.map((c) => c[0]);

/** 수집 결과 1건 → 저장용 배열 (빈 값은 NULL_TEXT) */
function toRow(rec) {
  const values = {};
  COLUMNS.forEach(([h, fn]) => {
    if (h === '누락항목') return;
    const v = fn(rec);
    values[h] = v === undefined || v === '' ? null : v;
  });
  const required = REQUIRED_FIELDS.concat(rec.detail && rec.detail.ok ? REQUIRED_IF_DETAIL : []);
  rec.missing = required.filter((h) => values[h] === null);
  rec.missing.forEach(countMissing);
  values['누락항목'] = rec.missing.join(', ') || null;
  return HEADERS.map((h) => (values[h] === null ? config.NULL_TEXT : values[h]));
}

module.exports = { HEADERS, toRow, COLUMNS };
