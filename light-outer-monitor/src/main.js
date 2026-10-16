// ============================================================
// 실행 진입점: 무신사 랭킹 1~500위 중 "경량 아우터" 수집
// ------------------------------------------------------------
// 실행: (light-outer-monitor 폴더에서)  npm start
//
// 전체 흐름
//   1) [목록]  랭킹 1~500위 수집               → src/rankingList.js
//   2) [필터]  상품명에 "경량" 포함 후보 선정    → src/filter.js
//   3) [상세]  후보 상품 상세 페이지 수집        → src/productDetail.js
//   4) [좋아요] 좋아요 API 조회                  → src/likes.js
//   5) [판정]  아우터 여부 최종 판정 (카테고리 002)
//   6) [저장]  CSV(항상) + 구글 시트(설정 시)    → src/storage/
//   7) [로그]  성공/실패 건수, 실패 원인, 누락 항목 요약
// ============================================================

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { launchBrowser } = require('./browser');
const { collectRankingList } = require('./rankingList');
const { collectDetails } = require('./productDetail');
const { fetchLikes } = require('./likes');
const { isCandidate, judgeOuter, planDetailTargets } = require('./filter');
const { HEADERS, toRow } = require('./record');
const { kstString, kstSlot, slotFileStamp, slotIndex } = require('./time');
const { stats, log, warn, fail, failureSummary } = require('./logger');
const { elapsedSec } = require('./utils');
const csv = require('./storage/csvWriter');
const sheets = require('./storage/googleSheets');

const LOG_HEADERS = [
  '수집슬롯_KST', '시작_KST', '종료_KST', '소요초', '상태',
  '랭킹수집건수', '최대순위', '광고추천제외', '경량후보', '상세대상', '상세성공', '상세실패', '상세건너뜀',
  '저장행수', '누락항목통계', '실패원인', '경고',
];

async function main() {
  const now = new Date();
  const slot = kstSlot(now);
  const startedAt = kstString(now);
  const stamp = slotFileStamp(slot);
  const debugDir = path.join(config.OUTPUT_DIR, 'debug');
  fs.mkdirSync(debugDir, { recursive: true });

  log(`===== 수집 시작: 슬롯 ${slot} (실제 ${startedAt}) =====`);
  let records = [];
  let fatal = null;
  const browser = await launchBrowser();

  try {
    // 1) 랭킹 목록
    const { items, diagnostics } = await collectRankingList(browser, debugDir);
    log(`랭킹 목록: ${items.length}개 (최대 ${stats.listMaxRank}위, 광고/추천 제외 ${stats.adsExcluded}개) / ${elapsedSec()}초`);
    log(`   감지된 내부 API: ${JSON.stringify(diagnostics.apiEndpoints)}`);

    // 전체 500위 목록도 참고용 CSV 로 저장 (경량 여부와 무관, 순위 검증용)
    csv.writeCsv(
      path.join(config.OUTPUT_DIR, 'data', `랭킹전체_${stamp}.csv`),
      ['랭킹순위', '순위출처', '상품코드', '브랜드명', '상품명', '판매가', '할인율', '카드원문'],
      items.map((i) => [i.rank, i.rankSource, i.goodsNo, i.brandName, i.goodsName, i.salePrice, i.discountRate, i.cardText])
    );

    // 2) "경량" 후보
    const candidates = items.filter(isCandidate);
    stats.candidates = candidates.length;
    log(`"경량" 후보: ${candidates.length}개 → ${candidates.map((c) => `${c.rank}위`).join(', ')}`);

    // 3) 상세 페이지 (후보만, 상한 초과 시 순환)
    const plan = planDetailTargets(candidates, slotIndex(now));
    stats.detailTargets = plan.targets.length;
    log(`상세 수집 계획: ${plan.note}`);
    const details = await collectDetails(browser, plan.targets);
    log(`상세 수집 완료: 성공 ${stats.detailSuccess} / 실패 ${stats.detailFailed} / 건너뜀 ${stats.detailSkipped} / ${elapsedSec()}초`);

    // 4) 좋아요
    const likes = await fetchLikes(candidates.map((c) => c.goodsNo));

    // 5) 아우터 판정 + 레코드 생성
    const collectedAt = kstString();
    for (const item of candidates) {
      const detail = details.get(item.goodsNo) || null;
      const { isOuter, reason } = judgeOuter(item, detail);
      if (!isOuter) {
        log(`   - 제외(아우터 아님): ${item.rank}위 ${item.goodsName} [${reason}]`);
        continue;
      }
      const listDelivery = item.delivery;
      records.push({
        slot,
        collectedAt,
        list: item,
        detail,
        detailNote: detail ? null : '이번 회차 상세 미대상(순환 수집)',
        likeCount: likes.has(item.goodsNo) ? likes.get(item.goodsNo) : null,
        outerReason: reason,
        // 무배당 판정은 랭킹 카드 기준(속성/아이콘), 카드에서 판정 못 했을 때만 상세 문구 사용
        delivery: listDelivery.decided || listDelivery.raw || !(detail && detail.ok) ? listDelivery : detail.delivery,
        missing: [],
      });
    }
  } catch (e) {
    fatal = e;
    fail('전체', null, e.stack || e.message);
  } finally {
    await browser.close().catch(() => {});
  }

  // 6) 저장
  const rows = records.map(toRow);
  stats.rowsSaved = rows.length;
  const csvFile = csv.saveRunCsv(stamp, HEADERS, rows);
  log(`CSV 저장: ${csvFile} (${rows.length}행)`);

  const status = fatal ? '실패' : stats.failures.length || stats.warnings.length ? '부분성공' : '성공';
  const missingText = Object.entries(stats.missingFields).map(([k, v]) => `${k}:${v}`).join(', ');
  const logRow = [
    slot, startedAt, kstString(), elapsedSec(), status,
    stats.listCollected, stats.listMaxRank, stats.adsExcluded, stats.candidates, stats.detailTargets,
    stats.detailSuccess, stats.detailFailed, stats.detailSkipped, stats.rowsSaved,
    missingText || '-', failureSummary() || '-', stats.warnings.join(' / ').slice(0, 1000) || '-',
  ];
  csv.saveRunLog(stamp, { ...Object.fromEntries(LOG_HEADERS.map((h, i) => [h, logRow[i]])), 실패상세: stats.failures });

  if (sheets.enabled()) {
    try {
      const added = await sheets.appendData(HEADERS, rows);
      await sheets.appendLog(LOG_HEADERS, logRow);
      log(`구글 시트 저장: ${added}행 추가 + 로그 1줄`);
    } catch (e) {
      fail('시트저장', null, e.message);
    }
  } else {
    log('구글 시트 설정(LIGHT_OUTER_SPREADSHEET_ID / GOOGLE_SERVICE_ACCOUNT_JSON)이 없어 CSV만 저장했습니다.');
  }

  // 7) 요약
  log('===== 수집 요약 =====');
  LOG_HEADERS.forEach((h, i) => log(`   ${h}: ${logRow[i]}`));
  writeGithubSummary(LOG_HEADERS, logRow, records);

  if (elapsedSec() > 25 * 60) warn(`실행 시간 ${elapsedSec()}초 — 30분 주기에 가깝습니다. MAX_DETAIL_PER_RUN 을 줄이세요.`);
  // 목록을 아예 못 가져온 경우만 "실패"로 종료 → GitHub 에서 빨간불로 알림
  if (fatal || stats.listCollected === 0) process.exit(1);
}

/** GitHub Actions 실행 화면(Summary)에 표로 결과 표시 */
function writeGithubSummary(headers, row, records) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  let md = `## 무신사 경량 아우터 수집 결과\n\n| 항목 | 값 |\n|---|---|\n`;
  headers.forEach((h, i) => (md += `| ${h} | ${String(row[i]).replace(/\|/g, '/')} |\n`));
  if (records.length) {
    md += `\n| 순위 | 브랜드 | 상품명 | 판매가 | 좋아요 | 누락 |\n|---|---|---|---|---|---|\n`;
    records.forEach((r) => {
      md += `| ${r.list.rank} | ${r.list.brandName ?? 'NULL'} | ${r.list.goodsName ?? 'NULL'} | ${r.list.salePrice ?? 'NULL'} | ${r.likeCount ?? 'NULL'} | ${r.missing.join(', ') || '-'} |\n`;
    });
  }
  fs.appendFileSync(file, md);
}

main().catch((e) => {
  console.error('❌ 예기치 못한 오류:', e);
  process.exit(1);
});
