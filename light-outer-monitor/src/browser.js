// ============================================================
// 브라우저(Playwright Chromium) 실행 / 컨텍스트 생성
// ============================================================

const { chromium } = require('playwright');
const config = require('../config');

async function launchBrowser() {
  return chromium.launch({
    headless: config.HEADLESS,
    // 로컬에서 브라우저 경로를 직접 지정하고 싶을 때: CHROMIUM_PATH 환경변수
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });
}

async function newContext(browser) {
  const context = await browser.newContext({
    userAgent: config.USER_AGENT,
    viewport: { width: 1400, height: 1000 },
    locale: 'ko-KR',
    timezoneId: config.TIMEZONE,
    extraHTTPHeaders: { 'Accept-Language': 'ko-KR,ko;q=0.9' },
  });
  // 이미지/폰트/영상은 불러오지 않아 속도와 트래픽을 줄임 (텍스트 수집에는 불필요)
  await context.route('**/*', (route) => {
    const t = route.request().resourceType();
    if (t === 'image' || t === 'font' || t === 'media') return route.abort();
    return route.continue();
  });
  return context;
}

module.exports = { launchBrowser, newContext };
