// ============================================================
// 무신사 랭킹 "경량 아우터" 크롤러 - 설정 파일
// ------------------------------------------------------------
// ✏️ 수정이 필요한 값은 대부분 이 파일에서 바꾸면 됩니다.
//    (코드 로직 파일(src/)은 건드리지 않아도 되도록 분리해 두었습니다)
//
// 환경변수(GitHub Secrets / Variables)로 덮어쓸 수 있는 값은
// process.env.XXX 로 표시되어 있습니다.
// ============================================================

module.exports = {
  // ─────────────────────────────────────────
  // 1. 수집 대상
  // ─────────────────────────────────────────
  // 무신사 랭킹 페이지 (sectionId / categoryCode / ageBand 를 바꾸면 다른 랭킹 수집 가능)
  RANKING_URL:
    process.env.RANKING_URL ||
    'https://www.musinsa.com/main/musinsa/ranking?gf=A&storeCode=musinsa&sectionId=200&contentsId=&categoryCode=000&ageBand=AGE_BAND_ALL',

  // 랭킹을 몇 위까지 볼 것인지
  MAX_RANK: Number(process.env.MAX_RANK || 500),

  // 상품 상세 페이지 주소 형식 ({goodsNo} 자리에 상품코드가 들어감)
  PRODUCT_URL_TEMPLATE: process.env.PRODUCT_URL_TEMPLATE || 'https://www.musinsa.com/products/{goodsNo}',

  // 좋아요 수 API (viewer-monitor 에서 이미 사용 중인 무신사 API)
  LIKE_API: 'https://like.musinsa.com/like/api/v2/liketypes/goods/counts',
  LIKE_CHUNK: 30, // 한 번에 조회할 상품 수

  // ─────────────────────────────────────────
  // 2. "경량 아우터" 필터 조건
  // ─────────────────────────────────────────
  // [1단계 후보] 상품명에 아래 단어 중 하나라도 있으면 상세 페이지를 열어 카테고리 확인 (대소문자/띄어쓰기 무시)
  //   넓게 잡아도 최종 저장은 아래 ① 아우터 + ② 경량 판정을 통과한 상품만
  CANDIDATE_KEYWORDS: [
    '경량', '라이트', 'light', '씬', '미드웨이트', '에어리', 'airy',
    '패딩', '패디드', 'padded', '다운', 'down', '푸퍼', '퍼퍼', 'puffer', '구스', '덕다운',
  ],

  // [2단계 ② 경량 판정]
  //   카테고리 경로에 이 단어가 있으면 경량 (예: "Clothing > 패딩/헤비 아우터 > 경량 패딩")
  LIGHT_CATEGORY_KEYWORDS: ['경량'],
  //   또는 상품명에 "경량" 이 있으면 경량 (카테고리 무관, 예: "경량 플리스 집업")
  //   또는 상품명에 아래 단어 + 패딩류(패딩 카테고리 또는 이름에 패딩/다운/패디드/푸퍼) 이면 경량
  //     예) "라이트 다운 재킷", "미드웨이트 패딩", "LIGHTWEIGHT PADDED JACKET"
  //     ※ "라이트 그레이", "Light gray" 같은 색상명과 "Flight" 는 제외 처리됨 (filter.js)
  LIGHT_NAME_KEYWORDS: ['라이트', 'light', '씬', '미드웨이트', 'midweight', '에어리', 'airy'],
  PADDING_KEYWORDS: ['패딩', '패디드', 'padded', '다운', 'down', '푸퍼', '퍼퍼', 'puffer'],

  // [수동 포함] 카테고리가 "숏 패딩" 등이라 자동 판정에서 빠지지만 경량으로 보고 싶은 상품
  //   상품명 일부 또는 상품코드 (아우터 판정은 그대로 적용)
  FORCE_INCLUDE: ['엑스 퓨즈'],

  // [2단계 ① 아우터 판정]: 상세 페이지의 카테고리 코드/경로
  //   무신사 대분류 코드 002 = 아우터, 경로에 "아우터" 포함 (예: "Sportswear > 아우터 > …")
  OUTER_CATEGORY_CODES: ['002'],
  OUTER_CATEGORY_NAMES: ['아우터'],

  // 아우터 판정 ②: 카테고리 정보를 못 얻었을 때 상품명으로 보조 판정
  //   (상품명에 아래 단어가 있으면 아우터로 간주, 판정근거 컬럼에 "상품명 키워드"로 기록됨)
  OUTER_NAME_KEYWORDS: [
    '패딩', '다운', '푸퍼', '점퍼', '자켓', '재킷', '집업', '베스트', '조끼',
    '코트', '바람막이', '아노락', '블루종', '항공', '야상', '파카', '후리스', '플리스', '아우터',
  ],

  // ─────────────────────────────────────────
  // 3. 상세 페이지 수집량 제한
  // ─────────────────────────────────────────
  // 1회 실행에서 상세 페이지를 최대 몇 개까지 열 것인지.
  // "경량" 후보가 이 수보다 많으면 순위 상위부터 나누어 회차별로 돌아가며(rotation) 수집.
  // (랭킹 500위 목록 자체는 매번 전부 수집합니다)
  MAX_DETAIL_PER_RUN: Number(process.env.MAX_DETAIL_PER_RUN || 120),
  DETAIL_CONCURRENCY: 2, // 동시에 여는 상세 페이지 수 (서버 부담을 줄이려면 1~2 권장)
  DETAIL_DELAY_MS: 1500, // 상세 페이지 사이 대기 시간(ms)

  // ─────────────────────────────────────────
  // 4. 시간 / 재시도 / 타임아웃
  // ─────────────────────────────────────────
  TIMEZONE: 'Asia/Seoul',
  SLOT_MINUTES: 30, // 수집 슬롯 단위 (정각/30분 기준)

  // 전체 실행 시간 예산(분). 이 시간을 넘기면 남은 상세 수집을 중단하고 지금까지 결과를 저장.
  // GitHub Actions 30분 주기와 겹치지 않도록 25분보다 작게 유지.
  RUN_BUDGET_MINUTES: Number(process.env.RUN_BUDGET_MINUTES || 20),

  PAGE_TIMEOUT_MS: 45000, // 페이지 1개 로딩 제한 시간
  RETRY_COUNT: 2, // 실패 시 재시도 횟수 (총 시도 = 1 + RETRY_COUNT)
  RETRY_BASE_DELAY_MS: 3000, // 재시도 대기 (3초, 6초 ... 로 증가)

  // 랭킹 목록 스크롤 설정
  SCROLL_WAIT_MS: 1200, // 스크롤 1번 후 로딩 대기
  SCROLL_MAX_ROUNDS: 400, // 최대 스크롤 횟수
  SCROLL_STABLE_ROUNDS: 10, // 이 횟수만큼 새 상품이 안 늘면 끝으로 판단

  // ─────────────────────────────────────────
  // 5. 저장 설정
  // ─────────────────────────────────────────
  // 화면에 없는 값은 0 대신 이 문자열로 저장 (요청사항: NULL)
  NULL_TEXT: 'NULL',

  // 회차별 파일(랭킹 500위 전체, 실패 상세, 진단) 폴더 → GitHub Actions Artifacts 로 30일 보관
  OUTPUT_DIR: process.env.OUTPUT_DIR || 'output',

  // 누적 CSV 작업 폴더 (드라이브에서 받아와 → 이어 붙이고 → 다시 올림)
  //   OUTPUT_DIR 안에 두어 Artifacts 에도 백업되도록 함
  DATA_DIR: process.env.DATA_DIR || 'output/누적',

  // 구글 드라이브 저장 폴더 ID (폴더 주소 .../folders/<이 부분>)
  //   ✏️ 저장 폴더를 바꾸려면 GitHub Variables 의 GDRIVE_FOLDER_ID 또는 아래 기본값 수정
  DRIVE_FOLDER_ID: process.env.GDRIVE_FOLDER_ID || '1I8n7B6jjNo2crHRObdub_UZdrEDcyU9g',

  // 드라이브 인증 (GitHub Secrets 로만 넣을 것 — 코드에 직접 쓰지 말 것)
  GDRIVE_CLIENT_ID: process.env.GDRIVE_CLIENT_ID || '',
  GDRIVE_CLIENT_SECRET: process.env.GDRIVE_CLIENT_SECRET || '',
  GDRIVE_REFRESH_TOKEN: process.env.GDRIVE_REFRESH_TOKEN || '',
  GOOGLE_SERVICE_ACCOUNT_JSON: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '', // 공유 드라이브일 때만 사용 가능

  // ─────────────────────────────────────────
  // 6. 슬랙 알림 (GitHub Secret SLACK_WEBHOOK_LIGHT_OUTER → 워크플로에서 SLACK_WEBHOOK_URL 로 전달)
  // ─────────────────────────────────────────
  //   - 수집 문제가 새로 생기면 즉시 알림 / 정상 복구되면 알림 (src/notify.js)
  //   - 매일 아침 전날 요약 (src/dailyReport.js, 워크플로 light-outer-daily.yml)
  SLACK_WEBHOOK_URL: process.env.SLACK_WEBHOOK_URL || '',
  DAILY_REPORT_TOP_N: 20, // 일일 요약에 보여줄 상품 수

  // ─────────────────────────────────────────
  // 7. 브라우저
  // ─────────────────────────────────────────
  USER_AGENT:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  HEADLESS: process.env.HEADLESS !== 'false',
};
