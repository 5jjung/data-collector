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

// ── [1] 브랜드 진입 메시지 ────────────────────────────────
function buildBrandMessage(items, brands) {
  const hits = items.filter(isTarget).sort((a, b) => a.rank - b.rank);
  const stamp = `_${kstNow()} KST_`;
  const label = BRAND_NAMES.join(' / ') || '대상 브랜드';

  if (!hits.length) {
    return `📉 *${label} — 무신사 실시간 랭킹 TOP${TARGET} 진입 없음*\n${stamp}`;
  }

  // 브랜드별로 묶어서 출력 (여러 브랜드를 동시에 볼 때 구분되도록)
  const grouped = new Map();
  for (const i of hits) {
    const key = i.brandName || i.brandCode;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(i);
  }

  const blocks = [...grouped.entries()].map(([brand, list]) => {
    // 이 브랜드가 전체 브랜드 중 몇 번째로 상품을 많이 올렸는지
    const bi = brands.findIndex(
      (b) => b.name === brand || b.code === (list[0].brandCode || '')
    );
    const exposure =
      bi >= 0 ? ` · 브랜드 노출 ${bi + 1}위/${brands.length}개` : '';

    // 무배당발: 없으면 "여부 : 없음", 있으면 "N개 중 M개"
    const plusN = list.filter((i) => i.plusDelivery).length;
    const plusLine = plusN
      ? `_무배당 상품 : 진입 ${list.length}개 중 ${plusN}개_`
      : `_무배당 상품 여부 : 없음_`;

    const head =
      `*${brand}* — TOP${TARGET} 내 ${list.length}개 · 최고 ${list[0].rank}위` +
      `${exposure}\n${plusLine}`;

    const body = list
      .map((i) => {
        // 소비자가(정가) → 할인가. 할인이 없으면 가격 하나만.
        const priceLine =
          i.originalPrice && i.originalPrice > i.price
            ? `${won(i.originalPrice)}원 → *${won(i.price)}원* (${i.discountRate}%)`
            : `*${won(i.price)}원*`;

        const stat =
          `👀 ${i.watching.toLocaleString('ko-KR')}명 보는 중` +
          ` · 🛒 ${i.buying.toLocaleString('ko-KR')}명 구매 중`;

        // 슬랙에서 <주소|글자> 로 쓰면 상품명이 클릭되는 링크가 된다
        const title = i.name ? `<${i.url}|${i.name}>` : `<${i.url}|상품 ${i.goodsNo}>`;

        return (
          `${title}  /  *${i.rank}위*${i.plusDelivery ? ' 🚚무배당발' : ''}\n` +
          `  ${priceLine}\n` +
          `  ${stat}`
        );
      })
      .join('\n\n');

    return `${head}\n\n${body}`;
  });

  // 맨 아래 용어 설명 — 처음 보는 사람도 바로 이해하도록
  const legend =
    `\n\n_📖 보는 법_\n` +
    `_• 브랜드 노출 순위 = TOP${TARGET} 안에 상품을 많이 올린 브랜드끼리 매긴 순위 (전체 ${brands.length}개 브랜드 중)_\n` +
    `_• 무배당 상품 = 무료배송·당일발송 배지가 붙은 상품_\n` +
    `_• 👀 / 🛒 = 알림 발송 시점의 무신사 실시간 표시값_`;

  return (
    `🏆 *무신사 실시간 랭킹 TOP${TARGET} — ${label} ${hits.length}개 진입*\n` +
    `${stamp}\n\n` +
    blocks.join('\n\n────────────\n\n') +
    legend
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
    `_TOP${TARGET} 안에 상품을 많이 올린 브랜드 순_\n` +
    lines.join('\n') +
    `\n\n_📖 무배당발 = 무료배송·당일발송 배지가 붙은 상품. ` +
    `모든 수치는 알림 발송 시점의 실시간 랭킹 기준입니다._`
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
