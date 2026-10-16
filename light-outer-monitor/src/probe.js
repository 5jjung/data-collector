// ============================================================
// 페이지 구조 진단 도구 (수집 X, 구조 확인용)
// ------------------------------------------------------------
// 실행: npm run probe   (또는 GitHub Actions 에서 mode=probe 로 수동 실행)
//
// 무신사 화면 구조가 바뀌어 값이 NULL 로 나오기 시작하면 이 도구를 먼저 실행하세요.
// output/probe/ 폴더에 아래 파일이 생깁니다.
//   ranking_full.png          랭킹 페이지 스크린샷
//   ranking_api_samples.json  페이지가 호출한 내부 API 주소 + 응답 앞부분
//   ranking_cards.json        화면 카드 텍스트 샘플 (순위/가격/보는사람 문구 확인)
//   ranking_scroll.json       스크롤 횟수별 카드 수 → 무한스크롤/페이지네이션 여부, 500위 도달 여부
//   detail_*.json / .png      상세 페이지 텍스트 / 내장데이터 키 / 스크린샷
// ============================================================

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { launchBrowser, newContext } = require('./browser');
const { readCardsInBrowser } = require('./rankingList');
const { sleep } = require('./utils');
const { log } = require('./logger');

const OUT = path.join(config.OUTPUT_DIR, 'probe');

async function probe() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await launchBrowser();
  const context = await newContext(browser);
  const page = await context.newPage();

  const apis = [];
  page.on('response', async (res) => {
    const ct = res.headers()['content-type'] || '';
    if (!ct.includes('json')) return;
    try {
      const text = await res.text();
      apis.push({ url: res.url(), status: res.status(), size: text.length, head: text.slice(0, 3000) });
    } catch (e) { /* 무시 */ }
  });

  log(`[probe] 랭킹 페이지: ${config.RANKING_URL}`);
  const resp = await page.goto(config.RANKING_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  log(`[probe] HTTP ${resp && resp.status()} / ${page.url()}`);
  await sleep(4000);
  await page.screenshot({ path: path.join(OUT, 'ranking_top.png') });

  // 스크롤하며 카드 수 변화 기록
  const scrollLog = [];
  const all = new Map();
  for (let i = 0; i < 150; i++) {
    const cards = await page.evaluate(readCardsInBrowser);
    cards.forEach((c) => all.has(c.goodsNo) || all.set(c.goodsNo, c));
    const info = await page.evaluate(() => ({
      y: window.scrollY,
      h: document.body.scrollHeight,
      domLinks: document.querySelectorAll('a[href*="/products/"]').length,
      moreBtn: !!Array.from(document.querySelectorAll('button,a')).find((b) => /더보기/.test(b.innerText || '')),
      pager: !!document.querySelector('[class*="pagination"],[class*="Pagination"]'),
    }));
    scrollLog.push({ round: i, visibleCards: cards.length, accumulated: all.size, ...info });
    if (i % 10 === 0) log(`[probe] 스크롤 ${i}: 화면카드 ${cards.length} / 누적 ${all.size} / 높이 ${info.h}`);
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await sleep(1200);
  }

  fs.writeFileSync(path.join(OUT, 'ranking_scroll.json'), JSON.stringify(scrollLog, null, 2));
  fs.writeFileSync(path.join(OUT, 'ranking_cards.json'), JSON.stringify(Array.from(all.values()), null, 2));
  fs.writeFileSync(path.join(OUT, 'ranking_api_samples.json'), JSON.stringify(apis, null, 2));
  log(`[probe] 누적 카드 ${all.size}개, JSON 응답 ${apis.length}개`);

  // 상세 페이지 2개 진단 (상위 1개 + "경량" 포함 1개)
  const list = Array.from(all.values());
  const targets = [list[0], list.find((c) => c.lines.join(' ').includes('경량'))].filter(Boolean);
  for (const c of targets) {
    const p = await context.newPage();
    const dApis = [];
    p.on('response', async (res) => {
      if (!(res.headers()['content-type'] || '').includes('json')) return;
      try { dApis.push({ url: res.url(), head: (await res.text()).slice(0, 3000) }); } catch (e) { /* 무시 */ }
    });
    const url = config.PRODUCT_URL_TEMPLATE.replace('{goodsNo}', c.goodsNo);
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(5000);
    const info = await p.evaluate(() => {
      const mss = window.__MSS__;
      const st = mss && mss.product && mss.product.state;
      return {
        lines: document.body.innerText.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 250),
        mssStateKeys: st ? Object.keys(st) : null,
        mssState: st ? JSON.stringify(st).slice(0, 20000) : null,
        hasNextData: !!document.getElementById('__NEXT_DATA__'),
        categoryLinks: Array.from(document.querySelectorAll('a[href*="/category/"]')).slice(0, 20).map((a) => [a.innerText.trim(), a.getAttribute('href')]),
      };
    });
    await p.screenshot({ path: path.join(OUT, `detail_${c.goodsNo}.png`) });
    fs.writeFileSync(path.join(OUT, `detail_${c.goodsNo}.json`), JSON.stringify({ url, ...info, apis: dApis }, null, 2));
    log(`[probe] 상세 ${c.goodsNo}: 텍스트 ${info.lines.length}줄, 내장데이터 ${info.mssStateKeys ? '있음' : '없음'}`);
    await p.close();
  }

  await browser.close();
  log(`[probe] 완료 → ${OUT}`);
}

probe().catch((e) => {
  console.error(e);
  process.exit(1);
});
