// ============================================================
// [모듈 2] 상품 상세 페이지 수집
// ------------------------------------------------------------
// 랭킹 목록에서 얻은 상품 URL 로 상세 페이지를 열어 아래 값을 수집합니다.
//   상품코드 / 상품명 / 카테고리(아우터 판정용) / 소비자가 / 할인가 / 할인율
//   현재 보는 사람 수 / 리뷰(후기) 수 / 좋아요(문구로 보이는 경우) / 배송 배지
//
// 읽는 곳 (실제 페이지에서 확인된 위치, 2026-10 기준)
//   - 소비자가/할인가/할인율, 리뷰 수, 무배당, 카테고리
//       → 페이지 내장데이터 __NEXT_DATA__ 의 goodsPrice / goodsReview / isPlusDelivery / baseCategoryFullPath
//         (화면의 "원" 금액은 추천상품 가격이 섞여 있어 사용하지 않음)
//   - 조회수, 누적판매 → 화면 상품정보의 "조회수 / 2.6천 회 이상 (최근 1개월)", "누적판매 / 50개 이상"
//   - 현재 보는 사람 → 화면 "N명이 보고 있어요" (표시되지 않는 상품은 NULL)
// ============================================================

const config = require('../config');
const { newContext } = require('./browser');
const { log, fail, stats } = require('./logger');
const { sleep, withRetry, overBudget } = require('./utils');
const { findGoodsInJson } = require('./jsonGoods');
const { extractDeliveryBadges, parseKoreanNumber } = require('./parsers');

/** 브라우저 안에서 실행: 화면 텍스트 + 내장 데이터 + 카테고리 링크 읽기 */
function readDetailInBrowser() {
  // 페이지 상단(상품 정보 영역) 텍스트만 사용: 하단 추천상품/정책 문구에 섞인 "무료배송" 등 오탐 방지
  const main = document.querySelector('main') || document.body;
  const lines = (main.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 250);

  // 내장 상품 데이터 (무신사 상세페이지는 window.__MSS__ 에 상품 상태를 넣어두는 구조가 있었음)
  let state = null;
  try {
    const mss = window.__MSS__;
    state = (mss && mss.product && mss.product.state) || null;
    if (state) state = JSON.parse(JSON.stringify(state)); // 함수 등 제거
  } catch (e) {
    state = null;
  }
  // Next.js 형태로 바뀐 경우 대비
  if (!state) {
    const nd = document.getElementById('__NEXT_DATA__');
    if (nd) {
      try { state = JSON.parse(nd.textContent); } catch (e) { /* 무시 */ }
    }
  }

  // 빵부스러기(카테고리 경로) 링크: /category/002... 형태
  const crumbs = [];
  document
    .querySelectorAll('[class*="readcrumb"] a[href*="/category/"], nav a[href*="/category/"], [class*="ategory"] a[href*="/category/"]')
    .forEach((a) => {
      const m = a.href.match(/\/category\/(\d{3,})/);
      if (m) crumbs.push({ code: m[1], text: (a.innerText || '').trim() });
    });

  // 페이지 전체 텍스트 (상단 고정영역의 "N명이 보고 있어요" 문구가 main 밖에 있을 수 있음)
  const bodyText = (document.body.innerText || '').slice(0, 30000);

  const h1 = document.querySelector('h1, h2[class*="title"], [class*="GoodsName"], [class*="product-title"]');
  const og = document.querySelector('meta[property="og:title"]');
  return {
    lines,
    bodyText,
    state,
    crumbs: crumbs.slice(0, 10),
    title: h1 ? h1.innerText.trim() : null,
    ogTitle: og ? og.getAttribute('content') : null,
    url: location.href,
  };
}

/** JSON 안에서 카테고리 코드/이름 찾기 (전체 경로 baseCategoryFullPath 우선) */
function findCategory(json) {
  let code = null;
  let name = null;
  // 1순위: 전체 경로 "Clothing > 패딩/헤비 아우터 > 경량 패딩" (경량 판정에 필요)
  const findPath = (n, d) => {
    if (name || !n || typeof n !== 'object' || d > 14) return;
    if (typeof n.baseCategoryFullPath === 'string' && n.baseCategoryFullPath) {
      name = n.baseCategoryFullPath;
      return;
    }
    Object.values(n).forEach((v) => findPath(v, d + 1));
  };
  findPath(json, 0);
  const walk = (n, d) => {
    if (!n || typeof n !== 'object' || d > 10 || (code && name)) return;
    for (const [k, v] of Object.entries(n)) {
      if (!code && /^(baseCategory|categoryDepth1Code|category1DepthCode|depth1Code|baseCategoryCode|representativeCategoryCode)$/i.test(k) && (typeof v === 'string' || typeof v === 'number') && /^\d{3,}$/.test(String(v))) code = String(v).slice(0, 3);
      // 예: baseCategoryFullPath = "Sportswear > 아우터 > 후드 집업" (스포츠웨어 안의 아우터도 판정 가능)
      if (!name && /^(baseCategoryFullPath|categoryDepth1Name|category1DepthName|depth1Name|categoryDepth1Title)$/i.test(k) && typeof v === 'string' && v) name = v;
      if (v && typeof v === 'object') walk(v, d + 1);
    }
  };
  walk(json, 0);
  return { code, name };
}

/**
 * 상세페이지 내장데이터(__NEXT_DATA__)에서 상품 객체 찾기
 * [확인된 구조] { goodsNo, goodsNm, goodsPrice: { normalPrice, salePrice, discountRate, couponPrice, finalPrice },
 *                goodsReview: { totalCount, satisfactionScore }, isPlusDelivery, baseCategoryFullPath, ... }
 */
function findGoodsState(json) {
  let found = null;
  const walk = (n, d) => {
    if (found || !n || typeof n !== 'object' || d > 14) return;
    if (!Array.isArray(n) && n.goodsPrice && typeof n.goodsPrice === 'object' && 'normalPrice' in n.goodsPrice) {
      found = n;
      return;
    }
    Object.values(n).forEach((v) => walk(v, d + 1));
  };
  walk(json, 0);
  return found;
}

/**
 * 화면의 "라벨 줄 → 값 줄" 구조에서 값 읽기
 * 예) "조회수" 다음 줄 "2.6천 회 이상 (최근 1개월)", "누적판매" 다음 줄 "50개 이상"
 */
function labelValue(lines, label, location) {
  const i = lines.findIndex((l) => l.replace(/\s+/g, '') === label);
  if (i < 0 || i + 1 >= lines.length) return null;
  const rawValue = lines[i + 1];
  const value = parseKoreanNumber(rawValue);
  return value === null ? null : { value, raw: `${label} ${rawValue}`, location };
}

/** 상세 페이지 1개 수집 */
async function fetchOneDetail(context, item) {
  const page = await context.newPage();
  const apiGoods = [];
  const apiCats = [];
  page.on('response', async (res) => {
    try {
      const url = res.url();
      if (!/musinsa\.com/.test(url) || !(res.headers()['content-type'] || '').includes('json')) return;
      const json = await res.json();
      findGoodsInJson(json, url).filter((g) => g.goodsNo === item.goodsNo).forEach((g) => apiGoods.push(g));
      const c = findCategory(json);
      if (c.code || c.name) apiCats.push(c);
    } catch (e) { /* 무시 */ }
  });

  try {
    const resp = await page.goto(item.productUrl, { waitUntil: 'domcontentloaded', timeout: config.PAGE_TIMEOUT_MS });
    const status = resp ? resp.status() : 0;
    if (status === 404) throw Object.assign(new Error('HTTP 404 (판매종료/삭제 상품)'), { noRetry: true });
    if (status >= 400) throw new Error(`HTTP ${status}`);
    // 가격(원) 문구가 뜰 때까지 대기 = 상품 정보 영역 로딩 완료로 판단
    await page.waitForFunction(() => /\d[\d,]*\s*원/.test(document.body.innerText), null, { timeout: 20000 });
    await sleep(1500); // "보는 사람 수" 같은 지연 로딩 문구 대기

    const raw = await page.evaluate(readDetailInBrowser);
    const screenLoc = '상세페이지 화면';
    const stateLoc = '상세페이지 내장데이터';

    // 내장 데이터에서 상품 정보 찾기 (가격/리뷰수/무배당은 화면 문구보다 정확)
    const gs = raw.state ? findGoodsState(raw.state) : null;
    const stateGoods = raw.state ? findGoodsInJson(raw.state, 'state').filter((g) => g.goodsNo === item.goodsNo) : [];
    const sg = stateGoods[0] || apiGoods[0] || null;
    const sgLoc = stateGoods[0] ? stateLoc : sg ? sg.location : null;

    // 카테고리: 내장데이터 → API → 빵부스러기 링크 순
    let cat = raw.state ? findCategory(raw.state) : { code: null, name: null };
    let catLoc = cat.code || cat.name ? stateLoc : null;
    if (!cat.code && !cat.name && apiCats.length) [cat, catLoc] = [apiCats[0], 'API응답'];
    if (!cat.code && !cat.name && raw.crumbs.length) {
      cat = { code: raw.crumbs[0].code.slice(0, 3), name: raw.crumbs[0].text || null };
      catLoc = '상세페이지 카테고리 경로';
    }

    // 가격: 내장데이터 goodsPrice (소비자가 = normalPrice, 할인가 = salePrice)
    //   ※ 화면 텍스트의 "원" 금액은 추천상품 가격이 섞여 있어 사용하지 않음
    const gp = gs ? gs.goodsPrice : null;
    const num = (v) => (typeof v === 'number' ? v : v != null && /^\d+$/.test(String(v)) ? Number(v) : null);
    const price = gp
      ? {
          normalPrice: num(gp.normalPrice),
          salePrice: num(gp.salePrice),
          discountRate: num(gp.discountRate),
          location: `${stateLoc} goodsPrice`,
        }
      : {
          normalPrice: sg?.normalPrice ?? null,
          salePrice: sg?.salePrice ?? null,
          discountRate: sg?.discountRate ?? null,
          location: sg?.salePrice != null ? sgLoc : null,
        };

    // 지표 (각각 확인된 위치에서만 읽음 — 추천상품 문구 오인 방지)
    const m = { liveViewers: null, viewCount: null, liveBuyers: null, buyerCount: null, purchaseCount: null, reviewCount: null, likeCount: null };
    //  - 현재 보는 사람: "52명이 보고 있어요" (viewer-monitor 에서 확인된 문구)
    const lv = raw.bodyText.match(/(\d[\d,.]*\s*(?:천|만)?)\s*명이\s*(?:지금\s*)?보고\s*있어요/);
    if (lv) m.liveViewers = { value: parseKoreanNumber(lv[1]), raw: lv[0], location: screenLoc };
    //  - 조회수 / 누적판매: 상품정보의 "라벨 → 값" 줄
    m.viewCount = labelValue(raw.lines, '조회수', `${screenLoc} 상품정보`);
    m.purchaseCount = labelValue(raw.lines, '누적판매', `${screenLoc} 상품정보`);
    //  - 리뷰 수: 내장데이터 goodsReview.totalCount
    if (gs && gs.goodsReview && gs.goodsReview.totalCount != null) {
      m.reviewCount = { value: num(gs.goodsReview.totalCount), raw: `goodsReview.totalCount=${gs.goodsReview.totalCount}`, location: stateLoc };
    } else if (sg && sg.reviewCount !== null) {
      m.reviewCount = { value: sg.reviewCount, raw: String(sg.reviewCount), location: sgLoc };
    }

    // 무배당: 내장데이터 isPlusDelivery
    const delivery = extractDeliveryBadges([], screenLoc);
    if (gs && typeof gs.isPlusDelivery === 'boolean') {
      Object.assign(delivery, {
        isMuBaeDang: gs.isPlusDelivery ? 'Y' : 'N',
        raw: `isPlusDelivery=${gs.isPlusDelivery}`,
        location: stateLoc,
        decided: true,
      });
    }

    return {
      ok: true,
      goodsNo: (gs && gs.goodsNo != null ? String(gs.goodsNo) : null) || sg?.goodsNo || item.goodsNo,
      goodsName: (gs && (gs.goodsNm || gs.goodsName)) || sg?.goodsName || raw.title || (raw.ogTitle ? raw.ogTitle.replace(/\s*[-|]\s*무신사.*$/, '') : null),
      categoryCode: cat.code,
      categoryName: cat.name,
      categoryLocation: catLoc,
      price,
      metrics: m,
      delivery,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * 여러 상품의 상세 페이지 수집 (동시 실행 수 제한 + 재시도 + 시간 예산)
 * @returns {Promise<Map<string, Object>>} goodsNo → 상세 결과 ({ok:false, error} 포함)
 */
async function collectDetails(browser, items) {
  const results = new Map();
  if (items.length === 0) return results;
  const context = await newContext(browser);
  const queue = items.slice();

  const worker = async () => {
    while (queue.length) {
      const item = queue.shift();
      if (overBudget()) {
        results.set(item.goodsNo, { ok: false, error: '시간 예산 초과로 이번 회차 건너뜀' });
        stats.detailSkipped++;
        continue;
      }
      try {
        const r = await withRetry(`상세 ${item.goodsNo}`, async () => {
          try {
            return await fetchOneDetail(context, item);
          } catch (e) {
            if (e.noRetry) return { ok: false, error: e.message };
            throw e;
          }
        });
        results.set(item.goodsNo, r);
        if (r.ok) {
          stats.detailSuccess++;
          const v = (x) => (x ? x.value : 'NULL');
          log(
            `   ✔ 상세 ${item.rank}위 ${item.goodsNo} ${r.goodsName || ''} | 소비자가 ${r.price.normalPrice ?? 'NULL'} 할인가 ${r.price.salePrice ?? 'NULL'}` +
              ` | 보는중 ${v(r.metrics.liveViewers)} 조회 ${v(r.metrics.viewCount)} 누적판매 ${v(r.metrics.purchaseCount)} 리뷰 ${v(r.metrics.reviewCount)}` +
              ` | 무배당 ${r.delivery.isMuBaeDang} | ${r.categoryName || r.categoryCode || '카테고리?'}`
          );
        } else {
          stats.detailFailed++;
          fail('상세', item.goodsNo, r.error);
        }
      } catch (e) {
        stats.detailFailed++;
        results.set(item.goodsNo, { ok: false, error: e.message.split('\n')[0] });
        fail('상세', item.goodsNo, e.message.split('\n')[0]);
      }
      await sleep(config.DETAIL_DELAY_MS);
    }
  };

  await Promise.all(Array.from({ length: config.DETAIL_CONCURRENCY }, worker));
  await context.close();
  return results;
}

module.exports = { collectDetails, findCategory, findGoodsState, labelValue };
