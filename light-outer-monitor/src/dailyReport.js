// ============================================================
// 하루 1번 슬랙 요약 (그날 수집분 정리)
// ------------------------------------------------------------
// 실행: npm run daily   (GitHub Actions: light-outer-daily.yml, 매일 23:55 KST)
//       특정 날짜: REPORT_DATE=2026-10-16 npm run daily
//
// 드라이브의 그날 CSV(경량아우터_YYYY-MM-DD.csv + _v2 …)와 수집로그를 받아서
//   - 수집 회차 수 / 문제 있었던 회차 수 / 경량 아우터 상품 수
//   - 상품별: 최고 순위, 마지막 순위, 보는 사람(평균·최대), 좋아요 증가, 누적판매, 판매가
// 를 정리해 슬랙으로 보냅니다.
// ============================================================

const config = require('../config');
const csv = require('./storage/csvWriter');
const drive = require('./storage/googleDrive');
const { sendSlack, runUrl } = require('./slack');
const { problemOf } = require('./notify');
const { kstString } = require('./time');
const { log } = require('./logger');

const num = (v) => (v === undefined || v === null || v === '' || v === config.NULL_TEXT || Number.isNaN(Number(v)) ? null : Number(v));
const fmt = (n) => (n === null ? '-' : Number(n).toLocaleString('ko-KR'));
const short = (n) => (n === null ? '-' : n >= 10000 ? `${(n / 10000).toFixed(1).replace(/\.0$/, '')}만` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}천` : String(n));

/** 하루치 행 → 상품별 요약 */
function summarize(rows) {
  const byGoods = new Map();
  for (const r of rows) {
    const no = r['상품코드'];
    if (!no) continue;
    if (!byGoods.has(no)) byGoods.set(no, []);
    byGoods.get(no).push(r);
  }
  const items = [];
  for (const [no, list] of byGoods) {
    list.sort((a, b) => String(a['수집슬롯_KST']).localeCompare(String(b['수집슬롯_KST'])));
    const first = list[0];
    const last = list[list.length - 1];
    const ranks = list.map((r) => num(r['랭킹순위'])).filter((n) => n !== null);
    const viewers = list.map((r) => num(r['목록_실시간보는사람수']) ?? num(r['상세_현재보는사람수'])).filter((n) => n !== null);
    const likeFirst = num(first['좋아요수']);
    const likeLast = num(last['좋아요수']);
    items.push({
      goodsNo: no,
      name: last['상품명'],
      brand: last['브랜드명'],
      url: last['상품URL'],
      count: list.length,
      bestRank: ranks.length ? Math.min(...ranks) : null,
      lastRank: num(last['랭킹순위']),
      avgViewers: viewers.length ? Math.round(viewers.reduce((a, b) => a + b, 0) / viewers.length) : null,
      maxViewers: viewers.length ? Math.max(...viewers) : null,
      likeLast,
      likeDelta: likeFirst !== null && likeLast !== null ? likeLast - likeFirst : null,
      sales: num(last['상세_누적판매']) ?? num(last['목록_누적판매']),
      price: num(last['목록_판매가']) ?? num(last['상세_할인가']),
      discount: num(last['목록_할인율']) ?? num(last['상세_할인율']),
      plus: last['무배당여부'] === 'Y',
    });
  }
  return items.sort((a, b) => (a.bestRank ?? 9999) - (b.bestRank ?? 9999));
}

function buildMessage(date, items, logs) {
  const runs = logs.length;
  const problemRuns = logs.filter((r) => problemOf(r));
  const folder = `<https://drive.google.com/drive/folders/${config.DRIVE_FOLDER_ID}|드라이브 폴더>`;
  const lines = [
    `📊 *무신사 경량 아우터 일일 요약* (${date})`,
    `수집 ${runs}회 / 예정 48회 · 문제 ${problemRuns.length}회 · 경량 아우터 ${items.length}종 · ${folder}`,
  ];
  if (problemRuns.length) {
    const reasons = Array.from(new Set(problemRuns.map((r) => problemOf(r).replace(/\d+/g, '#')))).slice(0, 3);
    lines.push(`⚠️ 문제 내용: ${reasons.join(' / ').slice(0, 300)}`);
  }
  if (!items.length) {
    lines.push('_이날 저장된 경량 아우터가 없습니다._');
    return lines.join('\n');
  }

  lines.push('', `*최고 순위 TOP ${Math.min(config.DAILY_REPORT_TOP_N, items.length)}* (최고순위→마지막순위 · 보는중 평균/최대 · 좋아요 · 누적판매 · 판매가)`);
  items.slice(0, config.DAILY_REPORT_TOP_N).forEach((it, i) => {
    const like = it.likeDelta ? `♥${short(it.likeLast)}(${it.likeDelta > 0 ? '+' : ''}${fmt(it.likeDelta)})` : `♥${short(it.likeLast)}`;
    lines.push(
      `${i + 1}. ${it.brand || ''} <${it.url}|${String(it.name || it.goodsNo).slice(0, 40)}>${it.plus ? ' 🚚무배당' : ''}\n` +
        `      ${it.bestRank ?? '-'}위→${it.lastRank ?? '-'}위 · 👀${short(it.avgViewers)}/${short(it.maxViewers)} · ${like} · 판매 ${short(it.sales)} · ${fmt(it.price)}원${it.discount ? `(${it.discount}%)` : ''}`
    );
  });

  // 오늘 좋아요가 가장 많이 늘어난 상품
  const likeTop = items.filter((it) => it.likeDelta > 0).sort((a, b) => b.likeDelta - a.likeDelta).slice(0, 3);
  if (likeTop.length) {
    lines.push('', `💗 *좋아요 증가 TOP*: ${likeTop.map((it) => `${String(it.name).slice(0, 20)} +${fmt(it.likeDelta)}`).join(' / ')}`);
  }
  return lines.join('\n');
}

/**
 * 요약할 날짜(KST): 기본은 오늘.
 * 예약 실행이 늦어져 자정을 넘겨 시작되면(새벽 6시 전) 전날로 계산
 */
function reportDate(now) {
  const today = kstString(now).slice(0, 10);
  if (Number(kstString(now).slice(11, 13)) >= 6) return today;
  return kstString(new Date(now.getTime() - 24 * 3600 * 1000)).slice(0, 10);
}

async function main() {
  const date = process.env.REPORT_DATE || reportDate(new Date());
  const slotOfDay = `${date} 00:00`;
  const rels = [csv.dailyRelPath(slotOfDay), csv.logRelPath(slotOfDay)];
  if (drive.enabled()) {
    for (const rel of rels) await drive.pullAll(rel, config.DATA_DIR);
  } else {
    log('드라이브 설정이 없어 로컬 DATA_DIR 의 CSV 로 요약합니다.');
  }
  const rows = csv.readAll(rels[0]);
  const logs = csv.readAll(rels[1]).filter((r) => String(r['수집슬롯_KST']).startsWith(date));
  const msg = buildMessage(date, summarize(rows), logs) + (runUrl() ? `\n<${runUrl()}|실행 로그>` : '');
  await sendSlack(msg);
}

if (require.main === module) {
  main().catch(async (e) => {
    console.error('❌ 일일 요약 실패:', e);
    await sendSlack(`🚨 *경량 아우터 일일 요약 생성 실패*\n${e.message}${runUrl() ? `\n<${runUrl()}|실행 로그>` : ''}`);
    process.exit(1);
  });
}

module.exports = { summarize, buildMessage, reportDate };
