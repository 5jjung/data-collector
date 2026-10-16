// ============================================================
// 슬랙 전송 (Incoming Webhook)
// ------------------------------------------------------------
// GitHub Secret: SLACK_WEBHOOK_LIGHT_OUTER  (경량 아우터 전용 채널의 웹후크 주소)
// 설정이 없으면 보내지 않고 로그에만 출력합니다.
// ============================================================

const config = require('../config');
const { log, warn } = require('./logger');

async function sendSlack(text) {
  if (!config.SLACK_WEBHOOK_URL) {
    log(`[슬랙 웹후크 없음 → 전송 생략]\n${text}`);
    return false;
  }
  try {
    const res = await fetch(config.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
    log('슬랙 전송 완료');
    return true;
  } catch (e) {
    warn(`슬랙 전송 실패: ${e.message}`); // 알림 실패는 수집 결과에 영향 없음
    return false;
  }
}

/** 현재 GitHub Actions 실행 화면 주소 (알림에 링크로 첨부) */
function runUrl() {
  const { GITHUB_SERVER_URL: s, GITHUB_REPOSITORY: r, GITHUB_RUN_ID: id } = process.env;
  return s && r && id ? `${s}/${r}/actions/runs/${id}` : null;
}

module.exports = { sendSlack, runUrl };
