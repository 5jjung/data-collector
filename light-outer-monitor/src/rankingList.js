// ============================================================
// [모듈 1] 랭킹 목록 수집 (1 ~ MAX_RANK 위)
// ------------------------------------------------------------
// 동작 순서
//  1) 랭킹 페이지를 연다
//  2) 화면을 아래로 스크롤하며(무한 스크롤 / 동적 로딩 대응) 상품 카드를 계속 읽는다
//     - 화면에서 카드가 사라지는 "가상 스크롤" 구조여도 누적 저장하므로 안전
//     - "더보기" 버튼이 있으면 눌러서 다음 목록을 불러온다
//  3) 동시에 페이지가 호출하는 내부 API(JSON) 응답도 가로채서 보조 데이터로 사용
//  4) 광고/추천 카드 제외 → 상품코드 기준 중복 제거 → 순위 정렬
//
// 데이터 우선순위
//  - 화면(DOM) 에 보이는 값이 1순위, 화면에서 못 읽은 값만 API(JSON) 값으로 보충
//  - 어떤 값을 어디서 읽었는지는 *_위치 컬럼에 기록됨
// ============================================================

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { newContext } = require('./browser');
const { log, warn, fail, stats } = require('./logger');
const { sleep, withRetry } = require('./utils');
const { findGoodsInJson, shortUrl } = require('./jsonGoods');
const {
  extractMetrics, extractDeliveryBadges, extractPrices, looksLikeAd, extractRank, goodsNoFromUrl,
} = require('./parsers');

const METRIC_KEYS = ['liveViewers', 'viewCount', 'liveBuyers', 'buyerCount', 'purchaseCount', 'reviewCount', 'likeCount'];

/**
 * 브라우저 안에서 실행되는 함수: 현재 화면에 있는 상품 카드들을 읽어서 반환
 * (page.evaluate 로 전달되므로 바깥 변수/함수를 사용할 수 없음)
 *
 * [확인된 무신사 랭킹 카드 구조] (rank-monitor/collect_rank.js 에서 실제 동작 확인)
 *   <div data-item-id="상품코드" data-index="순위" data-price="판매가"
 *        data-original-price="정상가" data-discount-rate="할인율"
 *        data-item-brand="브랜드코드" data-item-flag="...plusdelivery..."
 *        class="... gtm-view-item-list">          ← 바깥 카드 (이것을 사용)
 *     <a class="gtm-select-item" href="/products/..">상품명</a>   ← 안쪽(상품명만 있음)
 *     <a data-brand-id="브랜드코드"><p>브랜드명</p></a>
 *     "N명이 보는 중" / "N명이 구매 중" 문구
 *   </div>
 * 위 구조가 없으면(무신사 개편 시) 상품 링크 기준의 범용 방식으로 자동 전환합니다.
 */
function readCardsInBrowser() {
  const re = /\/(?:products|goods|app\/goods)\/(\d{4,})(?:[/?#]|$)/;
  const linesOf = (el) =>
    (el.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const pos = (el) => {
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top + window.scrollY), left: Math.round(r.left + window.scrollX) };
  };
  const cards = [];

  // ── 방식 1: 확인된 data-* 속성 카드 ──
  let nodes = [...document.querySelectorAll('[data-item-id].gtm-view-item-list')];
  if (!nodes.length) {
    nodes = [...document.querySelectorAll('[data-item-id][data-item-brand]')].filter((n) => n.tagName !== 'A');
  }
  if (nodes.length) {
    nodes.forEach((el) => {
      const attr = (k) => el.getAttribute(k);
      const brandA = el.querySelector('a[data-brand-id], a[href*="/brand/"]');
      let name = '';
      for (const a of el.querySelectorAll('a[href*="/products/"]')) {
        const t = (a.innerText || '').trim();
        if (t) { name = t.split('\n')[0]; break; }
      }
      const img = el.querySelector('img[alt]');
      const plusImg = el.querySelector('img[src*="plusdelivery"], img[alt*="무배당"]');
      const flag = attr('data-item-flag') || '';
      cards.push({
        mode: 'data-attr',
        goodsNo: attr('data-item-id'),
        lines: linesOf(el),
        imgAlt: img ? img.getAttribute('alt') : null,
        adAttr: /(^|[^a-z])ad([^a-z]|$)/i.test(flag),
        data: {
          index: attr('data-index') ?? attr('data-item-list-index'),
          price: attr('data-price'),
          originalPrice: attr('data-original-price'),
          discountRate: attr('data-discount-rate'),
          brandCode: (brandA && brandA.getAttribute('data-brand-id')) || attr('data-item-brand') || '',
          brandName: ((brandA && brandA.innerText) || '').trim().split('\n')[0] || null,
          name: name || null,
          flag,
          plusDelivery: /plusdelivery/i.test(flag) || !!plusImg,
          plusDeliveryRaw: /plusdelivery/i.test(flag)
            ? `data-item-flag="${flag}"`
            : plusImg ? `무배당 아이콘(${plusImg.getAttribute('alt') || plusImg.getAttribute('src')})` : null,
        },
        ...pos(el),
      });
    });
    return cards;
  }

  // ── 방식 2(예비): 상품 링크 기준 범용 탐색 ──
  const seen = new Set();
  document.querySelectorAll('a[href]').forEach((a) => {
    const m = a.href.match(re);
    if (!m) return;
    const no = m[1];
    // 카드 영역 찾기: 같은 상품코드 링크만 포함하는 가장 바깥쪽 부모까지 올라감
    let card = a;
    for (let el = a.parentElement, i = 0; el && i < 8; el = el.parentElement, i++) {
      const ids = new Set();
      el.querySelectorAll('a[href]').forEach((x) => {
        const mm = x.href.match(re);
        if (mm) ids.add(mm[1]);
      });
      if (ids.size > 1) break;
      card = el;
    }
    if (seen.has(card)) return;
    seen.add(card);
    const img = card.querySelector('img[alt]');
    // 광고 표시가 아이콘/속성으로만 되어 있는 경우 대비
    const adAttr = !!card.querySelector('[class*="ad-badge"],[class*="AdBadge"],[data-ad],[aria-label="광고"]');
    cards.push({
      mode: 'generic',
      goodsNo: no,
      lines: linesOf(card),
      imgAlt: img ? img.getAttribute('alt') : null,
      adAttr,
      data: null,
      ...pos(card),
    });
  });
  return cards;
}

/**
 * 카드의 순위: data-index 속성 → 카드 안 순위 숫자 순
 * offset: data-index 가 0부터 시작하는 구조라면 1을 더함 (buildItems 에서 자동 판단)
 */
function cardRank(c, offset = 0) {
  if (c.data && c.data.index !== null && c.data.index !== undefined && /^\d+$/.test(String(c.data.index))) {
    const n = Number(c.data.index) + offset;
    return n >= 1 ? n : null;
  }
  return extractRank(c.lines, config.MAX_RANK);
}

/** 화면 카드 텍스트에서 브랜드명/상품명 추정 */
function guessNames(card) {
  const isNoise = (l) =>
    /^\d{1,3}$/.test(l) || /원$/.test(l) || /%$/.test(l) || /^(AD|광고|추천|NEW|단독|무료배송)$/i.test(l) ||
    /명|구매|조회|리뷰|후기|좋아요|쿠폰|배송|출고/.test(l);
  const text = card.lines.filter((l) => !isNoise(l));
  let goodsName = card.imgAlt && card.imgAlt.length > 1 ? card.imgAlt.trim() : null;
  let brandName = null;
  if (goodsName) {
    const idx = card.lines.findIndex((l) => l === goodsName);
    if (idx > 0 && !isNoise(card.lines[idx - 1])) brandName = card.lines[idx - 1];
  }
  if (!goodsName && text.length >= 2) [brandName, goodsName] = [text[0], text[1]];
  if (!brandName && text.length >= 2 && text[1] === goodsName) brandName = text[0];
  return { brandName, goodsName };
}

/**
 * 랭킹 목록 수집 메인 함수
 * @returns {Promise<{items: Array, diagnostics: Object}>}
 */
async function collectRankingList(browser, debugDir) {
  const context = await newContext(browser);
  const page = await context.newPage();

  // ── (A) 내부 API 응답 가로채기 ─────────────────────
  const jsonByGoods = new Map(); // goodsNo → JSON 에서 찾은 정보
  const apiLog = new Map(); // API 주소 → 상품 건수 (진단용)
  page.on('response', async (res) => {
    try {
      const url = res.url();
      if (!/musinsa\.com/.test(url)) return;
      if (!(res.headers()['content-type'] || '').includes('json')) return;
      const json = await res.json();
      const found = findGoodsInJson(json, url);
      apiLog.set(shortUrl(url), (apiLog.get(shortUrl(url)) || 0) + found.length);
      found.forEach((g) => {
        const prev = jsonByGoods.get(g.goodsNo);
        // 순위 정보가 있는 쪽을 우선 보관
        if (!prev || (prev.rank === null && g.rank !== null)) jsonByGoods.set(g.goodsNo, g);
      });
    } catch (e) {
      /* 본문 없는 응답 등은 무시 */
    }
  });

  // ── (B) 페이지 열기 (네트워크 오류/타임아웃 시 재시도) ──
  log(`랭킹 페이지 접속: ${config.RANKING_URL}`);
  await withRetry('랭킹 페이지 접속', async () => {
    const resp = await page.goto(config.RANKING_URL, { waitUntil: 'domcontentloaded', timeout: config.PAGE_TIMEOUT_MS });
    const status = resp ? resp.status() : 0;
    if (status >= 400) throw new Error(`HTTP ${status}`);
    await page.waitForSelector('[data-item-id], a[href*="/products/"]', { timeout: 30000 });
  });
  await sleep(2000);

  // ── (C) 스크롤하며 카드 누적 수집 ──────────────────
  const domCards = new Map(); // goodsNo → 카드 (처음 본 것 유지, 위치 기준 정렬용)
  const mergeCards = async () => {
    const cards = await page.evaluate(readCardsInBrowser);
    cards.forEach((c) => {
      const prev = domCards.get(c.goodsNo);
      // 같은 상품이 여러 번 나오면(상단 배너 + 랭킹 목록 등) 순위 숫자가 있는 카드를 우선
      if (!prev || (cardRank(prev) === null && cardRank(c) !== null)) {
        domCards.set(c.goodsNo, c);
      }
    });
  };

  let last = -1;
  let stable = 0;
  for (let round = 0; round < config.SCROLL_MAX_ROUNDS; round++) {
    await mergeCards();
    await page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.9)));
    await sleep(config.SCROLL_WAIT_MS);

    // "더보기" 버튼이 보이면 클릭 (페이지네이션형 대응)
    const more = page.locator('button:has-text("더보기"), a:has-text("더보기")').last();
    if (await more.isVisible().catch(() => false)) {
      await more.click({ timeout: 3000 }).catch(() => {});
      await sleep(config.SCROLL_WAIT_MS);
    }

    await mergeCards();
    const ranked = Array.from(domCards.values()).filter((c) => cardRank(c) !== null).length;
    if (round % 10 === 0) log(`   스크롤 ${round}회: 카드 ${domCards.size}개 (순위표시 ${ranked}개), API 상품 ${jsonByGoods.size}개`);
    if (ranked >= config.MAX_RANK) break; // 목표 순위까지 다 모음

    const total = domCards.size + jsonByGoods.size;
    stable = total === last ? stable + 1 : 0;
    last = total;
    const atBottom = await page.evaluate(() => window.innerHeight + window.scrollY >= document.body.scrollHeight - 50);
    if (stable >= config.SCROLL_STABLE_ROUNDS && atBottom) break;
  }

  // ── (D) 진단 파일 저장 (구조 변경 시 원인 파악용) ─────
  const diagnostics = {
    pageTitle: await page.title().catch(() => ''),
    finalUrl: page.url(),
    domCardCount: domCards.size,
    jsonGoodsCount: jsonByGoods.size,
    apiEndpoints: Object.fromEntries(apiLog),
  };
  if (debugDir) {
    try {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: path.join(debugDir, 'ranking_top.png'), timeout: 10000 });
      fs.writeFileSync(
        path.join(debugDir, 'ranking_cards_sample.json'),
        JSON.stringify(Array.from(domCards.values()).slice(0, 40), null, 2)
      );
      fs.writeFileSync(path.join(debugDir, 'ranking_api_endpoints.json'), JSON.stringify(diagnostics, null, 2));
    } catch (e) {
      warn(`진단 파일 저장 실패: ${e.message}`);
    }
  }
  await context.close();

  // ── (E) 화면 + API 데이터 합치기 ──────────────────
  const items = buildItems(domCards, jsonByGoods);
  return { items, diagnostics };
}

/** 화면 카드와 API 데이터를 상품코드 기준으로 합치고 광고 제외 / 순위 결정 */
function buildItems(domCards, jsonByGoods) {
  const cards = Array.from(domCards.values()).sort((a, b) => a.top - b.top || a.left - b.left);
  // data-index 가 0부터 시작하면 +1 보정
  const offset = cards.some((c) => c.data && String(c.data.index) === '0') ? 1 : 0;
  const domRankedCount = cards.filter((c) => cardRank(c, offset) !== null).length;
  const useDomRank = domRankedCount >= Math.min(20, cards.length * 0.5); // 대부분 카드에 순위 숫자가 있으면 그것을 신뢰

  const items = [];
  let order = 0;
  for (const c of cards) {
    const j = jsonByGoods.get(c.goodsNo) || null;

    // 광고 / 추천 제외
    if (looksLikeAd(c.lines) || c.adAttr || (j && j.isAd)) {
      stats.adsExcluded++;
      continue;
    }
    const domRank = cardRank(c, offset);
    // 순위 숫자가 대부분 표시되는 구조인데 이 카드만 없다면 → 랭킹 외 영역(추천/배너)으로 보고 제외
    if (useDomRank && domRank === null && !(j && j.rank)) {
      stats.adsExcluded++;
      continue;
    }
    order++;

    let rank = null;
    let rankSource = null;
    if (domRank !== null) [rank, rankSource] = [domRank, c.data ? '카드 data-index 속성' : '화면 순위 숫자'];
    else if (j && j.rank) [rank, rankSource] = [j.rank, 'API 응답 rank'];
    else [rank, rankSource] = [order, '화면 노출 순서(추정)'];

    const loc = '랭킹목록 카드';
    const names = c.data && c.data.name ? { goodsName: c.data.name, brandName: c.data.brandName } : guessNames(c);
    // 가격: 카드 data-* 속성(정상가/판매가/할인율이 명확히 구분됨) → 카드 텍스트 순
    const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
    const textPrice = extractPrices(c.lines);
    const attrPrice = c.data
      ? { normalPrice: num(c.data.originalPrice), salePrice: num(c.data.price), discountRate: num(c.data.discountRate) }
      : { normalPrice: null, salePrice: null, discountRate: null };
    const domPrice = attrPrice.salePrice !== null ? attrPrice : textPrice;
    const priceLoc = attrPrice.salePrice !== null ? '랭킹목록 카드 data-price 속성' : loc;
    const domMetrics = extractMetrics(c.lines, loc);
    const textDelivery = extractDeliveryBadges(c.lines, loc);
    // 무배당(무배당발): 카드의 data-item-flag="plusdelivery" 또는 무배당 아이콘 → 없으면 문구 판정
    const domDelivery = c.data
      ? {
          ...textDelivery,
          isMuBaeDang: c.data.plusDelivery ? 'Y' : 'N',
          raw: [c.data.plusDeliveryRaw, textDelivery.raw].filter(Boolean).join(' | ') || null,
          location: c.data.plusDeliveryRaw ? '랭킹목록 카드 속성/아이콘' : textDelivery.location,
          decided: true,
        }
      : textDelivery;

    // 지표: 화면 값 우선, 없으면 API 응답의 "표시 문구"에서 찾은 값
    const metrics = {};
    METRIC_KEYS.forEach((k) => (metrics[k] = domMetrics[k] || (j && j.textMetrics[k]) || null));
    // 리뷰 수: 문구가 없으면 API 의 reviewCount 숫자 필드 사용
    if (!metrics.reviewCount && j && j.reviewCount !== null) {
      metrics.reviewCount = { value: j.reviewCount, raw: String(j.reviewCount), location: j.location };
    }

    items.push({
      rank,
      rankSource,
      goodsNo: c.goodsNo,
      goodsName: names.goodsName || (j && j.goodsName) || null,
      brandName: names.brandName || (j && j.brandName) || null,
      brandCode: c.data ? c.data.brandCode || null : null,
      productUrl: config.PRODUCT_URL_TEMPLATE.replace('{goodsNo}', c.goodsNo),
      normalPrice: domPrice.normalPrice ?? (j ? j.normalPrice : null),
      salePrice: domPrice.salePrice ?? (j ? j.salePrice : null),
      discountRate: domPrice.discountRate ?? (j ? j.discountRate : null),
      priceSource: domPrice.salePrice !== null ? priceLoc : j && j.salePrice !== null ? j.location : null,
      metrics,
      delivery: domDelivery.decided || domDelivery.raw ? domDelivery : j && j.delivery.raw ? j.delivery : domDelivery,
      cardText: c.lines.join(' | ').slice(0, 300),
    });
  }

  // API 에만 있고 화면 카드로는 못 읽은 랭킹 상품 (가상 스크롤로 놓친 경우) 보충
  const have = new Set(items.map((i) => i.goodsNo));
  for (const j of jsonByGoods.values()) {
    if (have.has(j.goodsNo) || j.isAd || !j.rank || j.rank > config.MAX_RANK) continue;
    if (items.some((i) => i.rank === j.rank && i.rankSource !== '화면 노출 순서(추정)')) continue;
    items.push({
      rank: j.rank,
      rankSource: 'API 응답 rank (화면 카드 미확인)',
      goodsNo: j.goodsNo,
      goodsName: j.goodsName,
      brandName: j.brandName,
      productUrl: config.PRODUCT_URL_TEMPLATE.replace('{goodsNo}', j.goodsNo),
      normalPrice: j.normalPrice,
      salePrice: j.salePrice,
      discountRate: j.discountRate,
      priceSource: j.location,
      metrics: Object.fromEntries(METRIC_KEYS.map((k) => [k, j.textMetrics[k] || null])),
      delivery: j.delivery,
      cardText: null,
    });
  }

  // 같은 상품코드 중복 제거(이미 Map 으로 처리) → 순위 정렬 → MAX_RANK 까지만
  items.sort((a, b) => a.rank - b.rank);
  const result = items.filter((i) => i.rank <= config.MAX_RANK);

  stats.listCollected = result.length;
  stats.listMaxRank = result.length ? result[result.length - 1].rank : 0;
  if (result.length < config.MAX_RANK) {
    warn(`랭킹 목록이 ${config.MAX_RANK}개보다 적게 수집됨: ${result.length}개 (최대 순위 ${stats.listMaxRank}위). 진단 파일을 확인하세요.`);
  }
  if (!useDomRank) {
    warn('화면 카드에서 순위 숫자를 찾지 못해 "API rank" 또는 "노출 순서"로 순위를 정했습니다. rank_source 컬럼을 확인하세요.');
  }
  if (result.length === 0) fail('목록', null, '랭킹 상품을 1개도 수집하지 못함');
  return result;
}

module.exports = { collectRankingList, buildItems, guessNames, readCardsInBrowser, cardRank };
