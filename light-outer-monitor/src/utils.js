// ============================================================
// 공통 유틸: 대기, 재시도, 시간 예산
// ============================================================

const config = require('../config');
const { log } = require('./logger');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 실패하면 RETRY_COUNT 만큼 다시 시도 (대기시간은 3초 → 6초 ... 로 증가)
 * 네트워크 오류 / 타임아웃 대응용
 */
async function withRetry(label, fn, retries = config.RETRY_COUNT) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        const wait = config.RETRY_BASE_DELAY_MS * (attempt + 1);
        log(`   ↻ ${label} 실패 (${e.message.split('\n')[0]}) → ${wait / 1000}초 후 재시도 ${attempt + 1}/${retries}`);
        await sleep(wait);
      }
    }
  }
  throw lastErr;
}

/** 실행 시간 예산 관리: 시작 후 RUN_BUDGET_MINUTES 가 지나면 true */
const startedAt = Date.now();
function overBudget() {
  return Date.now() - startedAt > config.RUN_BUDGET_MINUTES * 60 * 1000;
}
function elapsedSec() {
  return Math.round((Date.now() - startedAt) / 1000);
}

module.exports = { sleep, withRetry, overBudget, elapsedSec };
