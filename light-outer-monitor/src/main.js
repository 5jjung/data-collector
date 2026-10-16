// ============================================================
// 실행 진입점: 무신사 랭킹 1~500위 중 "경량 아우터" 수집
// ------------------------------------------------------------
// 실행: (light-outer-monitor 폴더에서)  npm start
//
// 전체 흐름
//   1) [목록]  랭킹 1~500위 수집               → src/rankingList.js
//   2) [필터]  상품명 키워드로 후보 선정 → 상세에서 아우터+경량 판정 → src/filter.js
//   3) [상세]  후보 상품 상세 페이지 수집        → src/productDetail.js
//   4) [좋아요] 좋아요 API 조회                  → src/likes.js
//   5) [판정]  아우터 여부 최종 판정 (카테고리 002)
//   6) [저장]  누적 CSV (하루 1파일) → 구글 드라이브 → src/storage/csvWriter.js, googleDrive.js
//   7) [로그]  성공/실패 건수, 실패 원인, 누락 항목 요약
// ============================================================

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { launchBrowser } = require('./browser');
const { collectRankingList } = require('./rankingList');
const { collectDetails } = require('./productDetail');
const { fetchLikes } = require('./likes');
const { isCandidate, judgeTarget, planDetailTargets } = require('./filter');
const { HEADERS, toRow } = require('./record');
const { kstString, kstSlot, slotFileStamp, slotIndex } = require('./time');
const { stats, log, warn, fail, failureSummary } = require('./logger');
const { elapsedSec } = require('./utils');
const csv = require('./storage/csvWriter');
const drive = require('./storage/googleDrive');

const LOG_HEADERS = [
  '수집슬롯_KST', '시작_KST', '종료_KST', '소요초', '상태',
  '랭킹수집건수', '최대순위', '광고추천제외', '후보', '상세대상', '상세성공', '상세실패', '상세건너뜀',
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

    // 2) 후보 (상품명에 경량/라이트/패딩/다운 등 — 최종 판정은 상세 카테고리로)
    const candidates = items.filter(isCandidate);
    stats.candidates = candidates.length;
    log(`후보(상세 확인 대상): ${candidates.length}개 → ${candidates.map((c) => `${c.rank}위`).join(', ')}`);

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
      const { include, reason } = judgeTarget(item, detail);
      if (!include) {
        log(`   - 제외: ${item.rank}위 ${item.goodsName} [${reason}]`);
        continue;
      }
      log(`   + 포함: ${item.rank}위 ${item.goodsName} [${reason}]`);
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

  // 6) 저장: 드라이브의 기존 누적 파일 받기 → 새 행 이어 붙이기 → 드라이브에 다시 올리기
  const rows = records.map(toRow);
  const relPaths = [csv.dailyRelPath(slot), csv.logRelPath(slot)];
  let driveReady = drive.enabled();
  if (!driveReady) {
    warn('구글 드라이브 설정(GDRIVE_* Secrets)이 없어 드라이브 저장을 건너뜁니다. CSV 는 Artifacts 에만 남습니다.');
  } else {
    try {
      for (const rel of relPaths) await drive.pullAll(rel, config.DATA_DIR);
    } catch (e) {
      // 기존 파일을 못 받은 상태에서 올리면 드라이브 데이터를 덮어쓰게 되므로 올리기 중단
      driveReady = false;
      fail('드라이브', null, `기존 파일 받기 실패 → 이번 회차는 드라이브에 올리지 않음: ${e.message}`);
    }
  }

  const savedFiles = []; // 드라이브에 올릴 실제 파일 (컬럼 변경 시 _v2 등)
  try {
    const saved = csv.appendDaily(slot, HEADERS, rows);
    savedFiles.push(saved.file);
    stats.rowsSaved = saved.added;
    log(`CSV 저장: ${saved.file} (${saved.added}행 추가${saved.added < rows.length ? `, 중복 ${rows.length - saved.added}행 제외` : ''})`);
  } catch (e) {
    fail('CSV저장', null, e.message);
  }

  const status = fatal ? '실패' : stats.failures.length || stats.warnings.length ? '부분성공' : '성공';
  const missingText = Object.entries(stats.missingFields).map(([k, v]) => `${k}:${v}`).join(', ');
  const logRow = [
    slot, startedAt, kstString(), elapsedSec(), status,
    stats.listCollected, stats.listMaxRank, stats.adsExcluded, stats.candidates, stats.detailTargets,
    stats.detailSuccess, stats.detailFailed, stats.detailSkipped, stats.rowsSaved,
    missingText || '-', failureSummary() || '-', stats.warnings.join(' / ').slice(0, 1000) || '-',
  ];
  savedFiles.push(csv.appendRunLog(slot, LOG_HEADERS, logRow).file);
  csv.saveRunJson(stamp, { ...Object.fromEntries(LOG_HEADERS.map((h, i) => [h, logRow[i]])), 실패상세: stats.failures });

  if (driveReady) {
    try {
      const uploadRels = savedFiles.map((f) => path.relative(config.DATA_DIR, f).split(path.sep).join('/'));
      for (const rel of uploadRels) await drive.push(rel, config.DATA_DIR);
      log(`구글 드라이브 저장 완료 (${drive.authMode()}): ${uploadRels.join(', ')}`);
    } catch (e) {
      const hint =
        drive.authMode() === '서비스계정' && /quota|not found/i.test(e.message)
          ? ' (서비스계정은 "내 드라이브" 폴더에 저장할 수 없음 → README 3-1 의 GDRIVE_* Secrets 를 넣으세요)'
          : '';
      fail('드라이브', null, `올리기 실패: ${e.message}${hint}`);
      // 요약/Summary 에 드라이브 실패가 보이도록 상태·실패원인 갱신 (CSV 사본은 Artifacts 에 남음)
      logRow[4] = '부분성공';
      logRow[15] = failureSummary();
    }
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
