// CSV 누적 저장 테스트: 이어 붙이기 / 같은 수집키 중복 방지 / 컬럼 변경 시 새 파일
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { appendCsv } = require('../src/storage/csvWriter');

test('누적 CSV: 이어 붙이기 + 중복 방지 + 컬럼 변경 시 _v2', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csvtest-'));
  const file = path.join(dir, 'a.csv');
  const H = ['수집키', '상품명', '값'];

  assert.strictEqual(appendCsv(file, H, [['k1', '경량, 패딩', 'NULL']]).added, 1);
  assert.strictEqual(appendCsv(file, H, [['k1', 'x', '1'], ['k2', '"따옴표"', '2']]).added, 1); // k1 중복 제외
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.startsWith('﻿수집키,상품명,값\r\n'));
  assert.strictEqual(text.split('\r\n').filter(Boolean).length, 3);
  assert.ok(text.includes('"경량, 패딩"') && text.includes('"""따옴표"""'));

  const r = appendCsv(file, [...H, '새컬럼'], [['k3', 'y', '3', '4']]);
  assert.ok(r.file.endsWith('a_v2.csv'));
});
