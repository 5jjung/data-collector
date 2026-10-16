// ============================================================
// 좋아요 수 수집 (무신사 좋아요 API)
// ------------------------------------------------------------
// 상세 페이지 하트(♡) 옆 숫자와 같은 원천 데이터입니다.
// viewer-monitor/collect_viewers.js 에서 사용 중인 API 를 그대로 사용 (로그인 불필요).
// 화면에는 "1.7천"처럼 축약 표시되므로 정확한 숫자는 API 로 가져옵니다.
// 실패한 상품은 0 이 아니라 결과에서 빠지며 → 최종 저장 시 NULL 로 기록됩니다.
// ============================================================

const config = require('../config');
const { log, fail } = require('./logger');
const { sleep, withRetry } = require('./utils');

async function fetchLikes(goodsNos) {
  const result = new Map();
  for (let i = 0; i < goodsNos.length; i += config.LIKE_CHUNK) {
    const chunk = goodsNos.slice(i, i + config.LIKE_CHUNK);
    try {
      await withRetry('좋아요 API', async () => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15000); // 15초 타임아웃
        try {
          const res = await fetch(config.LIKE_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': config.USER_AGENT },
            body: JSON.stringify({ relationIds: chunk.map(Number) }),
            signal: ctrl.signal,
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const json = await res.json();
          (json?.data?.contents?.items || []).forEach((it) => result.set(String(it.relationId), it.count));
        } finally {
          clearTimeout(timer);
        }
      });
    } catch (e) {
      // 묶음 단위로 1번만 기록 (해당 상품들의 좋아요수는 NULL 로 저장됨)
      fail('좋아요', `${chunk[0]} 외 ${chunk.length - 1}개`, e.message);
    }
    await sleep(300);
  }
  log(`좋아요 수집: ${result.size}/${goodsNos.length}개`);
  return result;
}

module.exports = { fetchLikes };
