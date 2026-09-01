// rank-monitor/collect_rank.js
// 무신사 실시간 랭킹 페이지에서 TOP N 상품 정보를 수집한다.
//
// [중요] 카드 하나에 data-item-id 가 두 군데 붙어 있음
//   - 바깥 <div class="... gtm-view-item-list">  ← 브랜드명·가격·"N명이 보는 중" 전부 포함 (이걸 써야 함)
//   - 안쪽 <a class="... gtm-select-item">       ← 상품명만 있음
// 안쪽 <a>를 잡으면 브랜드명 자리에 상품명이 들어가고 관심고객수가 0으로 나온다.

const { chromium } = require('playwright');

const RANK_URL =
  'https://www.musinsa.com/main/musinsa/ranking' +
  '?gf=A&storeCode=musinsa&sectionId=200&contentsId=' +
  '&categoryCode=000&ageBand=AGE_BAND_ALL&plusDelivery=false';

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
    await page.waitForSelector('[data-item-id]', { timeout: 30000 });
    await page.waitForTimeout(1500);

    const collected = new Map(); // rank -> item
    let stall = 0;
    let lastSize = 0;
    let loops = 0;

    while (collected.size < target && stall < 10 && loops < 400) {
      loops += 1;

      const batch = await page.evaluate(() => {
        const num = (v) => Number(String(v ?? '').replace(/[^\d]/g, '')) || 0;

        // 바깥 카드(div)만 선택. 안쪽 <a>(gtm-select-item)는 제외.
        let nodes = [...document.querySelectorAll('[data-item-id].gtm-view-item-list')];
        if (!nodes.length) {
          nodes = [...document.querySelectorAll('[data-item-id][data-item-brand]')].filter(
            (n) => n.tagName !== 'A'
          );
        }

        return nodes.map((el) => {
          const text = el.innerText || '';
          const pick = (re) => {
            const m = text.match(re);
            return m ? Number(m[1].replace(/,/g, '')) : 0;
          };

          const goodsNo = el.getAttribute('data-item-id') || '';

          // 브랜드: <a data-brand-id="thenorthface"><p>노스페이스</p></a>
          const brandA = el.querySelector('a[data-brand-id], a[href*="/brand/"]');
          const brandCode = (
            (brandA && brandA.getAttribute('data-brand-id')) ||
            el.getAttribute('data-item-brand') ||
            ''
          ).toLowerCase();
          const brandName =
            ((brandA && brandA.innerText) || '').trim().split('\n')[0] || brandCode;

          // 상품명: 상품 링크 <a href="/products/...">
          const prodA = el.querySelector('a[href*="/products/"]');
          const name = ((prodA && prodA.innerText) || '').trim().split('\n')[0];

          const flag = (el.getAttribute('data-item-flag') || '').toLowerCase();

          return {
            rank: num(el.getAttribute('data-index') ?? el.getAttribute('data-item-list-index')),
            goodsNo,
            brandCode,
            brandName,
            name,
            price: num(el.getAttribute('data-price')),
            originalPrice: num(el.getAttribute('data-original-price')),
            discountRate: num(el.getAttribute('data-discount-rate')),
            // 무배당발: data-item-flag 또는 mdbb 심볼 아이콘으로 판정
            plusDelivery:
              flag.includes('plusdelivery') ||
              !!el.querySelector('img[src*="plusdelivery"], img[alt*="무배당"]'),
            watching: pick(/([\d,.]+만?)\s*명이\s*보는\s*중/) || pickMan(text, '보는'),
            buying: pick(/([\d,.]+만?)\s*명이\s*구매\s*중/) || pickMan(text, '구매'),
            url: goodsNo ? `https://www.musinsa.com/products/${goodsNo}` : '',
          };

          // "1.9만명이 보는 중" 같은 만 단위 표기 처리
          function pickMan(t, kind) {
            const m = t.match(new RegExp(`([\\d.]+)만명이\\s*${kind}\\s*중`));
            return m ? Math.round(Number(m[1]) * 10000) : 0;
          }
        });
      });

      for (const item of batch) {
        if (!item.goodsNo || !item.rank || item.rank > target) continue;
        collected.set(item.rank, item);
      }

      if (collected.size === lastSize) stall += 1;
      else stall = 0;
      lastSize = collected.size;

      if (debug && loops % 10 === 0) {
        console.log(`  ...scroll ${loops}회 / 수집 ${collected.size}개`);
      }

      await page.evaluate(() => window.scrollBy(0, 1200));
      await page.waitForTimeout(600);
    }

    const items = [...collected.values()].sort((a, b) => a.rank - b.rank);
    if (debug) {
      console.log(`수집 완료: ${items.length}개 (1위 ~ ${items[items.length - 1]?.rank}위)`);
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

// 단독 실행: node rank-monitor/collect_rank.js → 상위 20개 미리보기
if (require.main === module) {
  collectRanking({ target: 500, headless: process.env.HEADFUL !== '1', debug: true })
    .then((items) => {
      console.table(
        items.slice(0, 20).map((i) => ({
          순위: i.rank,
          브랜드: i.brandName,
          코드: i.brandCode,
          상품: i.name.slice(0, 22),
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
