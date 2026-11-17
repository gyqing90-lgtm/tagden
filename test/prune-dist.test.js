'use strict';
/**
 * 旧发布物清理：只留最近 N 版 + 升到当前版的补丁。
 * 关键是「别删错」——最新的包和 to-latest 的补丁一个都不能少，
 * 否则下次打补丁没基线、老客户端升不上来。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { plan, cmpVer } = require('../tools/prune-dist.js');

function fixture(vers, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tagden-prune-'));
  const dist = path.join(dir, 'dist');
  const mac = path.join(dir, 'dist-mac');
  fs.mkdirSync(dist, { recursive: true });
  fs.mkdirSync(mac, { recursive: true });
  for (const v of vers) fs.writeFileSync(path.join(dist, `tagden-${v}.exe`), 'x');
  for (const p of opts.patches || []) fs.writeFileSync(path.join(dist, p), 'p');
  for (const v of vers) fs.writeFileSync(path.join(mac, `main-${v}.js`), 'm');
  fs.writeFileSync(path.join(dist, 'latest.json'), JSON.stringify({ version: opts.latest || vers[vers.length - 1] }));
  fs.writeFileSync(path.join(dist, 'tagden-win.exe'), 'alias');
  fs.writeFileSync(path.join(mac, 'tagden-mac-arm64.zip'), 'zip');
  fs.writeFileSync(path.join(mac, 'latest-mac.json'), '{}');
  return { dist, mac };
}

test('版本比较按数字，不按字典序', () => {
  assert.ok(cmpVer('0.9.10', '0.9.9') > 0, '0.9.10 必须大于 0.9.9');
  assert.ok(cmpVer('0.10.0', '0.9.99') > 0);
  assert.equal(cmpVer('1.2.3', '1.2.3'), 0);
  assert.ok(cmpVer('1.2.2', '1.2.3') < 0);
});

test('保留最近 3 版，更早的 exe 进删除名单', () => {
  const { dist, mac } = fixture(['0.9.9', '0.9.10', '0.9.11', '0.9.12']);
  const { latest, del } = plan({ dist, mac }, 3);
  assert.equal(latest, '0.9.12');
  const names = del.map((d) => d.name);
  assert.ok(names.includes('tagden-0.9.9.exe'), '第 4 版应删');
  assert.ok(!names.includes('tagden-0.9.12.exe'), '最新版不能删');
  assert.ok(!names.includes('tagden-0.9.11.exe'));
  assert.ok(!names.includes('tagden-0.9.10.exe'));
  assert.ok(names.includes('main-0.9.9.js'), 'mac 老包同规则');
});

test('补丁只删「升到旧版」的，to-latest 全留', () => {
  const { dist, mac } = fixture(['0.9.9', '0.9.10', '0.9.11', '0.9.12'], {
    patches: [
      'tagden-0.6.21-to-0.9.12.patch', // 起点早被删了，但老客户端要用 → 留
      'tagden-0.9.9-to-0.9.12.patch',
      'tagden-0.9.11-to-0.9.12.patch',
      'tagden-0.9.10-to-0.9.11.patch', // 升到旧版 → 删
      'tagden-0.8.0-to-0.9.10.patch',
    ],
  });
  const names = plan({ dist, mac }, 3).del.map((d) => d.name);
  assert.ok(!names.includes('tagden-0.6.21-to-0.9.12.patch'), 'to-latest 必须留');
  assert.ok(!names.includes('tagden-0.9.9-to-0.9.12.patch'));
  assert.ok(names.includes('tagden-0.9.10-to-0.9.11.patch'), 'to 旧版应删');
  assert.ok(names.includes('tagden-0.8.0-to-0.9.10.patch'));
});

test('没有版本号的产物一律不碰（清单、别名、zip 都保留）', () => {
  const { dist, mac } = fixture(['0.9.9', '0.9.10', '0.9.11', '0.9.12']);
  const names = plan({ dist, mac }, 3).del.map((d) => d.name);
  for (const keep of ['latest.json', 'tagden-win.exe', 'tagden-mac-arm64.zip', 'latest-mac.json']) {
    assert.ok(!names.includes(keep), `${keep} 不能被删`);
  }
});

test('版本不够 3 个时什么都不删', () => {
  const { dist, mac } = fixture(['0.9.11', '0.9.12']);
  assert.equal(plan({ dist, mac }, 3).del.length, 0);
});
