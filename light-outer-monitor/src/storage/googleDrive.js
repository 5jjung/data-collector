// ============================================================
// 구글 드라이브 저장
// ------------------------------------------------------------
// 지정한 드라이브 폴더(config.DRIVE_FOLDER_ID) 아래에 CSV 를 누적 저장합니다.
//
//   [드라이브 폴더]
//   ├─ 2026-10/경량아우터_2026-10-16.csv   ← 하루 1파일, 30분마다 아래로 이어 붙임
//   └─ 수집로그/수집로그_2026-10.csv       ← 회차별 성공/실패 요약
//
// 이어 붙이는 방법: 드라이브의 기존 파일을 받아옴(pull) → 새 행 추가 → 다시 올림(push)
//   ※ 기존 파일을 받아오지 못하면(네트워크 오류 등) 덮어써서 데이터가 사라지지 않도록
//     올리기를 하지 않고 실패로 기록합니다. (그 회차 CSV 는 Artifacts 에 남음)
//
// 인증 (둘 중 하나, 위에 있는 것이 우선)
//   1) 사용자 계정 OAuth  : GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET / GDRIVE_REFRESH_TOKEN
//      → "내 드라이브" 폴더에 저장 가능 (README 3-1 참고)
//   2) 서비스계정         : GOOGLE_SERVICE_ACCOUNT_JSON
//      → 폴더가 "공유 드라이브"에 있을 때만 가능 (서비스계정은 내 드라이브 저장 용량이 없음)
// ============================================================

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const config = require('../../config');
const { withRetry } = require('../utils');

const FOLDER_MIME = 'application/vnd.google-apps.folder';
let driveClient = null;
let authMode = null;

/** 드라이브 저장 설정이 되어 있는지 */
function enabled() {
  const oauth = config.GDRIVE_CLIENT_ID && config.GDRIVE_CLIENT_SECRET && config.GDRIVE_REFRESH_TOKEN;
  return !!(config.DRIVE_FOLDER_ID && (oauth || config.GOOGLE_SERVICE_ACCOUNT_JSON));
}

function client() {
  if (driveClient) return driveClient;
  let auth;
  if (config.GDRIVE_CLIENT_ID && config.GDRIVE_CLIENT_SECRET && config.GDRIVE_REFRESH_TOKEN) {
    auth = new google.auth.OAuth2(config.GDRIVE_CLIENT_ID, config.GDRIVE_CLIENT_SECRET);
    auth.setCredentials({ refresh_token: config.GDRIVE_REFRESH_TOKEN });
    authMode = '사용자 계정(OAuth)';
  } else {
    auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(config.GOOGLE_SERVICE_ACCOUNT_JSON),
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
    authMode = '서비스계정';
  }
  driveClient = google.drive({ version: 'v3', auth });
  return driveClient;
}

const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/** 부모 폴더 안에서 이름으로 파일/폴더 찾기 → id 또는 null */
async function findChild(parentId, name, isFolder) {
  const q = [
    `'${esc(parentId)}' in parents`,
    `name = '${esc(name)}'`,
    'trashed = false',
    isFolder ? `mimeType = '${FOLDER_MIME}'` : `mimeType != '${FOLDER_MIME}'`,
  ].join(' and ');
  const res = await withRetry(`드라이브 검색 ${name}`, () =>
    client().files.list({ q, fields: 'files(id,name)', pageSize: 5, supportsAllDrives: true, includeItemsFromAllDrives: true })
  );
  return res.data.files.length ? res.data.files[0].id : null;
}

/** "2026-10/경량아우터_….csv" → 하위 폴더를 (없으면 만들어서) 찾고 { parentId, name } 반환 */
async function resolve(relPath, create) {
  const parts = relPath.split(/[\\/]/).filter(Boolean);
  const name = parts.pop();
  let parentId = config.DRIVE_FOLDER_ID;
  for (const dir of parts) {
    let id = await findChild(parentId, dir, true);
    if (!id && create) {
      const res = await withRetry(`드라이브 폴더 생성 ${dir}`, () =>
        client().files.create({
          requestBody: { name: dir, mimeType: FOLDER_MIME, parents: [parentId] },
          fields: 'id',
          supportsAllDrives: true,
        })
      );
      id = res.data.id;
    }
    if (!id) return null;
    parentId = id;
  }
  return { parentId, name };
}

/**
 * 드라이브의 기존 파일을 로컬로 받아옴 (이어 붙이기 전에 호출)
 * @returns {Promise<boolean>} 드라이브에 파일이 있었으면 true, 없으면 false
 *          (오류가 나면 throw → 호출한 쪽에서 올리기를 중단해야 함)
 */
async function pull(relPath, localRoot) {
  const loc = await resolve(relPath, false);
  const local = path.join(localRoot, relPath);
  const fileId = loc ? await findChild(loc.parentId, loc.name, false) : null;
  if (!fileId) {
    if (fs.existsSync(local)) fs.unlinkSync(local); // 드라이브에 없으면 새로 시작
    return false;
  }
  const res = await withRetry(`드라이브 받기 ${loc.name}`, () =>
    client().files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' })
  );
  fs.mkdirSync(path.dirname(local), { recursive: true });
  fs.writeFileSync(local, Buffer.from(res.data));
  return true;
}

/** 로컬 파일을 드라이브에 올림 (있으면 내용 교체, 없으면 새로 생성) */
async function push(relPath, localRoot) {
  const local = path.join(localRoot, relPath);
  if (!fs.existsSync(local)) return null;
  const loc = await resolve(relPath, true);
  const fileId = await findChild(loc.parentId, loc.name, false);
  const media = () => ({ mimeType: 'text/csv', body: fs.createReadStream(local) });
  if (fileId) {
    await withRetry(`드라이브 올리기 ${loc.name}`, () =>
      client().files.update({ fileId, media: media(), supportsAllDrives: true })
    );
  } else {
    await withRetry(`드라이브 생성 ${loc.name}`, () =>
      client().files.create({
        requestBody: { name: loc.name, parents: [loc.parentId], mimeType: 'text/csv' },
        media: media(),
        fields: 'id',
        supportsAllDrives: true,
      })
    );
  }
  return loc.name;
}

module.exports = { enabled, pull, push, authMode: () => authMode };
