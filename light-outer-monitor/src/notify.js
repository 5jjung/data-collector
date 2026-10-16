// ============================================================
// 수집 실패 알림 (슬랙)
// ------------------------------------------------------------
// 30분마다 같은 실패 알림이 반복되지 않도록:
//   - 문제가 "새로 생기거나 내용이 바뀐" 회차에만 🚨 알림
//   - 직전 회차에 문제가 있었는데 이번에 정상이면 ✅ 복구 알림
// 직전 회차 상태는 드라이브의 수집로그 CSV 마지막 줄로 판단합니다.
//
// "문제"로 보는 것 (✏️ 기준을 바꾸려면 problemOf 수정)
//   - 실패원인이 있음 (페이지 접속/상세/좋아요/드라이브 저장 실패 등)
//   - 누락항목이 있음 (화면 구조가 바뀌어 값이 NULL 로 나오기 시작)
//   - 랭킹이 MAX_RANK(500)개보다 적게 수집됨
// ============================================================

const config = require('../config');
const { sendSlack, runUrl } = require('./slack');

/** 수집로그 한 줄(객체) → 문제 요약 문자열 (문제 없으면 '') */
function problemOf(row) {
  if (!row) return '';
  const parts = [];
  const count = Number(row['랭킹수집건수']);
  if (Number.isFinite(count) && count < config.MAX_RANK) parts.push(`랭킹 ${count}/${config.MAX_RANK}개만 수집`);
  if (row['실패원인'] && row['실패원인'] !== '-') parts.push(`실패: ${row['실패원인']}`);
  if (row['누락항목통계'] && row['누락항목통계'] !== '-') parts.push(`누락: ${row['누락항목통계']}`);
  return parts.join('\n');
}

// 숫자만 다른 같은 문제(예: 상세 실패 1건 → 2건)는 같은 문제로 보고 다시 알리지 않음
const problemKey = (p) => p.replace(/\d+/g, '#');

/**
 * 이번 회차 결과로 알림 보낼지 판단 후 전송
 * @param {Object|null} prevRow  직전 회차 수집로그 (없으면 null)
 * @param {Object} curRow        이번 회차 수집로그
 */
async function notifyIfNeeded(prevRow, curRow) {
  const prev = problemOf(prevRow);
  const cur = problemOf(curRow);
  const link = runUrl() ? `\n<${runUrl()}|실행 로그 보기>` : '';
  const folder = `<https://drive.google.com/drive/folders/${config.DRIVE_FOLDER_ID}|드라이브 폴더>`;

  if (cur && problemKey(cur) !== problemKey(prev)) {
    return sendSlack(
      `🚨 *경량 아우터 수집 문제* (${curRow['수집슬롯_KST']})\n` +
        `상태: ${curRow['상태']} · 랭킹 ${curRow['랭킹수집건수']}개 · 상세 ${curRow['상세성공']}/${curRow['상세대상']} · 저장 ${curRow['저장행수']}행\n` +
        `${cur}${link}\n` +
        '_같은 문제가 계속되면 다시 알리지 않고, 정상으로 돌아오면 복구 알림을 보냅니다._'
    );
  }
  if (!cur && prev) {
    return sendSlack(
      `✅ *경량 아우터 수집 정상 복구* (${curRow['수집슬롯_KST']})\n` +
        `랭킹 ${curRow['랭킹수집건수']}개 · 저장 ${curRow['저장행수']}행 · ${folder}${link}`
    );
  }
  return false;
}

module.exports = { notifyIfNeeded, problemOf };
