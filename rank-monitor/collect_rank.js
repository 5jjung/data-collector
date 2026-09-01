// rank-monitor/collect_rank.js
// 무신사 실시간 랭킹 페이지에서 TOP N 상품 정보를 수집한다.
// 상세페이지 방문 없이, 랭킹 리스팅 페이지의 data-* 속성 + 카드 텍스트만 사용.

const { chromium } = require('playwright');

const RANK_URL =
  'https://www.musinsa.com/main/musinsa/ranking' +
  '?gf=A&storeCode=musinsa&sectionId=200&contentsId=' +
  '&categoryCode=000&ageBand=AGE_BAND_ALL&plusDelivery=false';

const CARD_SELECTOR = '[data-item-id][data-item-brand]';

async function collectRanking({ target = 500, headless = true, debug = false } = {}) {
  const browser = await chromium.launch({ headless });
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    locale: 'ko-KR',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  });
  const page = await ctx.newPage();

  try {
    await page.goto(RANK_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector(CARD_SELECTOR, { timeout: 30000 });
    await page.waitForTimeout(1500);

    const collected = new Map(); // rank -> item
    let stall = 0;
    let lastSize = 0;
    let loops = 0;

    while (collected.size < target && stall < 10 && loops < 400) {
      loops += 1;

      const batch = await page.evaluate((sel) => {
        const num = (v) => Number(String(v ?? '').replace(/[^\d]/g, '')) || 0;

        return [...document.querySelectorAll(sel)].map((el) => {
          const text = el.innerText || '';
          const pick = (re) => {
            const m = text.match(re);
            return m ? Number(m[1].replace(/,/g, '')) : 0;
          };

          const goodsNo = el.getAttribute('data-item-id') || '';
          const flag = (el.getAttribute('data-item-flag') || '').toLowerCase();

          // 순위: data-index 우선, 없으면 data-item-list-index
          const rawRank =
            el.getAttribute('data-index') ?? el.getAttribute('data-item-list-index');

          // 브랜드 한글명: /brand/ 링크 텍스트 → 없으면 카드 첫 줄
          const brandLink = el.querySelector('a[href*="/brand/"]');
          const brandName = brandLink
            ? brandLink.innerText.trim()
            : (text.split('\n')[0] || '').trim();

          const img = el.querySelector('img[alt]');

          return {
            rank: num(rawRank),
            goodsNo,
            brandCode: (el.getAttribute('data-item-brand') || '').toLowerCase(),
            brandName,
            name: img ? (img.getAttribute('alt') || '').trim() : '',
            price: num(el.getAttribute('data-price')),
            originalPrice: num(el.getAttribute('data-original-price')),
            discountRate: num(el.getAttribute('data-discount-rate')),
            // 무배당발(무료배송+당일발송) 여부
            plusDelivery:
              flag.includes('plusdelivery') ||
              !!el.querySelector('img[alt*="무배당"], img[src*="plusdelivery"]'),
            watching: pick(/([\d,]+)\s*명이\s*보는\s*중/),
            buying: pick(/([\d,]+)\s*명이\s*구매\s*중/),
            url: goodsNo ? `https://www.musinsa.com/products/${goodsNo}` : '',
          };
        });
      }, CARD_SELECTOR);

      for (const item of batch) {
        if (!item.goodsNo || !item.rank) continue;
        if (item.rank > target) continue;
        // 같은 순위를 다시 만나면 최신값(보는/구매 인원)으로 갱신
        collected.set(item.rank, item);
      }

      if (collected.size === lastSize) stall += 1;
      else stall = 0;
      lastSize = collected.size;

      if (debug && loops % 10 === 0) {
        console.log(`  ...scroll ${loops}회 / 수집 ${collected.size}개`);
      }

      // 가상 스크롤이라 조금씩 내리면서 누적 수집
      await page.evaluate(() => window.scrollBy(0, 1200));
      await page.waitForTimeout(600);
    }

    const items = [...collected.values()].sort((a, b) => a.rank - b.rank);
    if (debug) {
      console.log(
        `수집 완료: ${items.length}개 (최소 ${items[0]?.rank} ~ 최대 ${items[items.length - 1]?.rank}위)`
      );
    }
    return items;
  } finally {
    await browser.close();
  }
}

async function sendSlack(text) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) {
    console.log('[SLACK_WEBHOOK_URL 없음 — 콘솔 출력만]\n' + text);
    return;
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`슬랙 전송 실패: ${res.status} ${await res.text()}`);
  console.log('슬랙 전송 완료');
}

function kstNow() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 16);
}

module.exports = { collectRanking, sendSlack, kstNow, RANK_URL };

// 단독 실행: node rank-monitor/collect_rank.js  → 상위 20개 미리보기
if (require.main === module) {
  collectRanking({ target: 500, headless: process.env.HEADFUL !== '1', debug: true })
    .then((items) => {
      console.table(
        items.slice(0, 20).map((i) => ({
          순위: i.rank,
          브랜드: i.brandName,
          코드: i.brandCode,
          상품: i.name.slice(0, 20),
          무배당발: i.plusDelivery ? 'O' : '',
          보는중: i.watching,
          구매중: i.buying,
        }))
      );
      console.log(`총 ${items.length}개`);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
