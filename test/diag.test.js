'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collect, maskSites, dirStats, stampName, filled } = require('../lib/diag');

const SECRET_USER = 'zhangsan@example.com';
const SECRET_PASS = 'P@ssw0rd-very-secret';
const SECRET_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.secret-token-value';
const SECRET_KEY = 'sk-deepseek-abcdef123456';

const SITES = {
  xingse: { username: SECRET_USER, password: SECRET_PASS, token: SECRET_TOKEN, tokenAt: 1730000000000 },
  ppbc: { username: '', password: '', token: '' },
  baidu: { apiKey: SECRET_KEY, secret: 'baidu-secret-xyz' },
};

test('filled：空值都算没填（空串 / null / [] / 0）', () => {
  assert.strictEqual(filled(''), false);
  assert.strictEqual(filled('  '), false);
  assert.strictEqual(filled(null), false);
  assert.strictEqual(filled([]), false);
  assert.strictEqual(filled(0), false);
  assert.strictEqual(filled('x'), true);
  assert.strictEqual(filled([1]), true);
});

test('maskSites：字段值全部变成布尔，键名保留', () => {
  const m = maskSites(SITES);
  assert.strictEqual(m.xingse.username, true);
  assert.strictEqual(m.xingse.password, true);
  assert.strictEqual(m.xingse.token, true);
  assert.strictEqual(m.ppbc.username, false);
  assert.strictEqual(m.baidu.apiKey, true);
  // 键名还在，开发者知道「这个站点该填哪些字段」
  assert.deepStrictEqual(Object.keys(m.xingse).sort(), ['password', 'token', 'tokenAt', 'username']);
});

test('安全底线：诊断包里不能出现任何凭据原文', () => {
  const { entries } = collect({
    version: '0.9.1',
    sites: SITES,
    sessions: { xingse: { token: SECRET_TOKEN } },
    deepseek: { apiKey: SECRET_KEY, model: 'deepseek-chat' },
    ui: { preset: 'plant' },
  });
  const all = entries.map((e) => String(e.data)).join('\n');
  for (const secret of [SECRET_USER, SECRET_PASS, SECRET_TOKEN, SECRET_KEY, 'baidu-secret-xyz']) {
    assert.ok(!all.includes(secret), `诊断包里泄露了凭据：${secret}`);
  }
  // 但「有没有填」要看得出来
  assert.match(all, /"username": true/);
  assert.match(all, /"configured": true/);
});

test('dirStats：只数数量，不返回任何文件名', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tagden-diag-'));
  try {
    fs.writeFileSync(path.join(dir, 'Papilio machaon 001.jpg'), 'x');
    fs.writeFileSync(path.join(dir, '菜粉蝶.jpg'), 'x');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
    fs.mkdirSync(path.join(dir, '子文件夹'));
    fs.writeFileSync(path.join(dir, '子文件夹', 'a.png'), 'x');

    const st = dirStats(dir);
    assert.strictEqual(st.files, 4); // 3 个直接 + 子目录里 1 个
    assert.strictEqual(st.images, 3);
    assert.strictEqual(st.dirs, 1);
    const json = JSON.stringify(st);
    assert.ok(!json.includes('Papilio'), '不该带出文件名');
    assert.ok(!json.includes('菜粉蝶'), '不该带出文件名');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('collect：必备条目齐全，info.txt 含版本与运行形态', () => {
  const { entries, summary } = collect({ version: '0.9.1', isSea: true, port: 7801 });
  const names = entries.map((e) => e.name);
  assert.ok(names.includes('info.txt'));
  assert.ok(names.includes('config-redacted.json'));
  assert.ok(names.includes('features.json'));
  const info = entries.find((e) => e.name === 'info.txt').data;
  assert.match(info, /0\.9\.1/);
  assert.match(info, /exe \(SEA\)/);
  assert.match(info, /7801/);
  assert.ok(summary.bytes > 0);
});

test('collect：给了目录才出 folder-stats.txt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tagden-diag-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.jpg'), 'xx');
    const withDir = collect({ version: 'x', dir }).entries.map((e) => e.name);
    assert.ok(withDir.includes('folder-stats.txt'));
    const noDir = collect({ version: 'x' }).entries.map((e) => e.name);
    assert.ok(!noDir.includes('folder-stats.txt'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stampName：形如 tagden-diagnose-20261117-0606', () => {
  const name = stampName(new Date(2026, 10, 17, 6, 6));
  assert.strictEqual(name, 'tagden-diagnose-20261117-0606');
});
