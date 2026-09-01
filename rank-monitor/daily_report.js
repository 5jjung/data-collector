// rank-monitor/daily_report.js
// 매일 18:00 KST 1회 실행 — 랭킹 TOP500을 한 번만 수집해서 슬랙 메시지 2건 전송.
//   [1] 코드그라피 랭킹 진입 현황 (순위 / 보는 인원 / 구매 인원 / 링크)
//   [2] TOP500 시장 요약 (무배당발 비중 / 최다 노출 브랜드)

const { collectRanking, sendSlack, kstNow } = require('./collect_rank');

const TARGET = Number(process.env.RANK_TARGET || 500);
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

// ── [1] 코드그라피 메시지 ────────────────────────────────
function buildBrandMessage(items) {
  const hits = items.filter(isTarget).sort((a, b) => a.rank - b.rank);
  const stamp = `_${kstNow()} KST_`;

  if (!hits.length) {
    return (
      `📉 *코드그라피 — 무신사 실시간 랭킹 TOP${TARGET} 진입 없음*\n${stamp}`
    );
  }

  const body = hits
    .map((i) => {
      const dc = i.discountRate ? ` (${i.discountRate}%)` : '';
      const stat = [
        i.watching ? `👀 ${i.watching}명 보는 중` : null,
        i.buying ? `🛒 ${i.buying}명 구매 중` : null,
      ]
        .filter(Boolean)
        .join(' · ');
      return (
        `*${i.rank}위* ${i.name}\n` +
        `  ${won(i.price)}원${dc}${stat ? ' · ' + stat : ''}\n` +
        `  ${i.url}`
      );
    })
    .join('\n\n');

  const totalWatch = hits.reduce((s, i) => s + i.watching, 0);
  const totalBuy = hits.reduce((s, i) => s + i.buying, 0);

  return (
    `🏆 *코드그라피 — 무신사 실시간 랭킹 TOP${TARGET} ${hits.length}개 진입*\n` +
    `${stamp} · 최고 ${hits[0].rank}위 · 합계 👀 ${totalWatch}명 / 🛒 ${totalBuy}명\n\n` +
    body
  );
}

// ── [2] 시장 요약 메시지 ────────────────────────────────
function buildMarketMessage(items) {
  const total = items.length;

  const plus = items.filter((i) => i.plusDelivery).length;
  const top100 = items.filter((i) => i.rank <= 100);
  const plusTop100 = top100.filter((i) => i.plusDelivery).length;

  const byBrand = new Map();
  for (const i of items) {
    const key = i.brandCode || i.brandName;
    const cur = byBrand.get(key) || { name: i.brandName || key, count: 0, best: 9999 };
    cur.count += 1;
    cur.best = Math.min(cur.best, i.rank);
    byBrand.set(key, cur);
  }
  const top5 = [...byBrand.values()]
    .sort((a, b) => b.count - a.count || a.best - b.best)
    .slice(0, 5);

  return (
    `📊 *무신사 실시간 랭킹 TOP${TARGET} 요약*\n` +
    `_${kstNow()} KST · 수집 ${total}개 · 브랜드 ${byBrand.size}개_\n\n` +
    `*① 무배당발 비중*\n` +
    `• TOP${TARGET}: ${plus}개 (*${pct(plus, total)}%*)\n` +
    `• TOP100: ${plusTop100}개 (${pct(plusTop100, top100.length)}%)\n\n` +
    `*② 최다 노출 브랜드*\n` +
    `🥇 *${top5[0]?.name}* — ${top5[0]?.count}개 (${pct(top5[0]?.count, total)}%, 최고 ${top5[0]?.best}위)\n` +
    top5
      .slice(1)
      .map((b, n) => `${n + 2}위 ${b.name} — ${b.count}개 (최고 ${b.best}위)`)
      .join('\n')
  );
}

(async () => {
  const items = await collectRanking({ target: TARGET, debug: true });
  if (!items.length) {
    throw new Error('랭킹 수집 결과가 0건입니다. 셀렉터/페이지 구조를 확인하세요.');
  }
  console.log(`수집 ${items.length}개 / 코드그라피 ${items.filter(isTarget).length}개`);

  await sendSlack(buildBrandMessage(items));
  await sendSlack(buildMarketMessage(items));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
