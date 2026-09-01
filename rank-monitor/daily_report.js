// rank-monitor/daily_report.js
// 매일 18:00 KST 1회 실행 — 랭킹 TOP500을 한 번만 수집해서 슬랙 메시지 2건 전송.
//   [1] 코드그라피 랭킹 진입 현황
//   [2] TOP500 시장 요약 (무배당발 비중 / 브랜드별 노출·무배당발 현황)

const { collectRanking, sendSlack, kstNow } = require('./collect_rank');

const TARGET = Number(process.env.RANK_TARGET || 500);
const TOP_N_BRANDS = Number(process.env.TOP_N_BRANDS || 10);

const BRAND_CODES = (process.env.BRAND_CODES || 'codegraphy')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const BRAND_NAMES = (process.env.BRAND_NAMES || '코드그라피')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) : '0.0');
const won = (n) => Number(n || 0).toLocaleString('ko-KR');

function isTarget(i) {
  return (
    BRAND_CODES.includes(i.brandCode) ||
    BRAND_NAMES.some((n) => i.brandName && i.brandName.includes(n))
  );
}

// 브랜드별 집계: 상품 수 / 무배당발 수 / 최고 순위
function groupByBrand(items) {
  const map = new Map();
  for (const i of items) {
    const key = i.brandCode || i.brandName;
    const cur =
      map.get(key) || { code: key, name: i.brandName || key, count: 0, plus: 0, best: 9999 };
    cur.count += 1;
    if (i.plusDelivery) cur.plus += 1;
    cur.best = Math.min(cur.best, i.rank);
    if (!cur.name && i.brandName) cur.name = i.brandName;
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.best - b.best);
}

// ── [1] 코드그라피 메시지 ────────────────────────────────
function buildBrandMessage(items, brands) {
  const hits = items.filter(isTarget).sort((a, b) => a.rank - b.rank);
  const stamp = `_${kstNow()} KST_`;

  if (!hits.length) {
    return `📉 *코드그라피 — 무신사 실시간 랭킹 TOP${TARGET} 진입 없음*\n${stamp}`;
  }

  const body = hits
    .map((i) => {
      const dc = i.discountRate ? ` (${i.discountRate}%)` : '';
      const tags = [
        i.plusDelivery ? '🚚 무배당발' : null,
        i.watching ? `👀 ${i.watching.toLocaleString('ko-KR')}명 보는 중` : null,
        i.buying ? `🛒 ${i.buying.toLocaleString('ko-KR')}명 구매 중` : null,
      ]
        .filter(Boolean)
        .join(' · ');
      return (
        `*${i.rank}위* ${i.name}\n` +
        `  ${won(i.price)}원${dc}${tags ? '\n  ' + tags : ''}\n` +
        `  ${i.url}`
      );
    })
    .join('\n\n');

  const totalWatch = hits.reduce((s, i) => s + i.watching, 0);
  const totalBuy = hits.reduce((s, i) => s + i.buying, 0);
  const plusCount = hits.filter((i) => i.plusDelivery).length;
  const brandRank = brands.findIndex((b) => BRAND_CODES.includes(b.code)) + 1;

  return (
    `🏆 *코드그라피 — 무신사 실시간 랭킹 TOP${TARGET} ${hits.length}개 진입*\n` +
    `${stamp}\n` +
    `최고 ${hits[0].rank}위` +
    (brandRank ? ` · 브랜드 노출 순위 ${brandRank}위/${brands.length}개` : '') +
    ` · 무배당발 ${plusCount}/${hits.length}개\n` +
    `합계 👀 ${totalWatch.toLocaleString('ko-KR')}명 / 🛒 ${totalBuy.toLocaleString('ko-KR')}명\n\n` +
    body
  );
}

// ── [2] 시장 요약 메시지 ────────────────────────────────
function buildMarketMessage(items, brands) {
  const total = items.length;

  const plus = items.filter((i) => i.plusDelivery).length;
  const top100 = items.filter((i) => i.rank <= 100);
  const plusTop100 = top100.filter((i) => i.plusDelivery).length;

  const medal = ['🥇', '🥈', '🥉'];
  const lines = brands.slice(0, TOP_N_BRANDS).map((b, n) => {
    const head = medal[n] || `${n + 1}위`;
    return (
      `${head} *${b.name}* — ${b.count}개 (${pct(b.count, total)}%)\n` +
      `      └ 무배당발 ${b.plus}개 (${pct(b.plus, b.count)}%) · 최고 ${b.best}위`
    );
  });

  return (
    `📊 *무신사 실시간 랭킹 TOP${TARGET} 요약*\n` +
    `_${kstNow()} KST · 수집 ${total}개 · 브랜드 ${brands.length}개_\n\n` +
    `*① 무배당발 비중*\n` +
    `• TOP${TARGET}: ${plus}개 (*${pct(plus, total)}%*)\n` +
    `• TOP100: ${plusTop100}개 (${pct(plusTop100, top100.length)}%)\n\n` +
    `*② 브랜드별 노출 TOP${TOP_N_BRANDS}*\n` +
    lines.join('\n')
  );
}

(async () => {
  const items = await collectRanking({ target: TARGET, debug: true });
  if (!items.length) {
    throw new Error('랭킹 수집 결과가 0건입니다. 셀렉터/페이지 구조를 확인하세요.');
  }

  const brands = groupByBrand(items);
  console.log(`수집 ${items.length}개 / 브랜드 ${brands.length}개`);
  console.log(`1위 브랜드: ${brands[0].name} (${brands[0].count}개)`);

  await sendSlack(buildBrandMessage(items, brands));
  await sendSlack(buildMarketMessage(items, brands));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
