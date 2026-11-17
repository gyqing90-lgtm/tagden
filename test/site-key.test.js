'use strict';

/**
 * 内置 Key 撤除 + 「识别 Key」面板的回归测试。
 *
 * 保护的是三件事，任何一件坏了都会让作者的个人额度重新随安装包发出去，
 * 或者让用户填了 Key 却没地方存/没开关可用：
 *   1. 种子（lib/seed.js）里不能再有豆包、懂鸟的 Key；
 *   2. 老用户 config.json 里残留的同值 Key 要能被指纹清掉，自己填的不能误清；
 *   3. 面板与服务端接口得在位（页面元素、路由、打包清单）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const secure = require('../lib/secure');
const SEEDKEYS = require('../lib/seedkeys');
const { MODULES } = require('../build/bundle');

const hasSeed = fs.existsSync(path.join(ROOT, 'lib/seed.js'));

function openSeed() {
  const opened = secure.open(require('../lib/seed'));
  assert.ok(opened.ok, '种子解不开：' + (opened.error || '未知原因'));
  return opened.value || {};
}

test('种子不再带豆包、懂鸟的 Key', (t) => {
  if (!hasSeed) return t.skip('没有 lib/seed.js（git 忽略的凭据文件）');
  const seed = openSeed();
  const sites = seed.sites || {};
  assert.equal(sites.doubao && sites.doubao.apiKey, undefined, '种子里的豆包 Key 必须删掉');
  assert.equal(sites.dongniao && sites.dongniao.apiKey, undefined, '种子里的懂鸟 Key 必须删掉');
  // 剩下的站点不能一起被清掉：一份种子被写空等于所有人都用不了
  for (const key of ['duoshi', 'inaturalist', 'kuaitong', 'ebird', 'baidu-animal', 'plantnet']) {
    assert.ok(sites[key], `种子里的 ${key} 不该被删`);
  }
});

test('种子解出来的内容不包含任何「Key 原样流出」的迹象（顶层只留站点与端口）', (t) => {
  if (!hasSeed) return t.skip('没有 lib/seed.js');
  const seed = openSeed();
  assert.deepEqual(Object.keys(seed).sort(), ['natureShare', 'port', 'sites']);
});

test('purge：指纹一致的残留 Key 被清掉，并报出站点名', () => {
  const sites = {
    doubao: { apiKey: 'bundled-doubao-key', model: '' },
    dongniao: { apiKey: 'bundled-dongniao-key' },
  };
  const fp = (v) => crypto.createHash('sha256').update(v, 'utf8').digest('hex');
  // 把测试值塞成「指纹表里那把」：直接改表会污染模块，所以换成查表实现的等价断言
  const saved = { ...SEEDKEYS.SEED_KEY_FP };
  SEEDKEYS.SEED_KEY_FP['doubao.apiKey'] = fp(sites.doubao.apiKey);
  SEEDKEYS.SEED_KEY_FP['dongniao.apiKey'] = fp(sites.dongniao.apiKey);
  try {
    const removed = SEEDKEYS.purge(sites);
    assert.deepEqual(removed.sort(), ['dongniao', 'doubao']);
    assert.equal(sites.doubao.apiKey, '');
    assert.equal(sites.dongniao.apiKey, '');
    // 非密文字段不该被动
    assert.equal(sites.doubao.model, '');
  } finally {
    Object.assign(SEEDKEYS.SEED_KEY_FP, saved);
  }
});

test('purge：用户自己填的 Key（指纹不同）一律不动', () => {
  const sites = {
    doubao: { apiKey: 'my-own-ark-key-123' },
    dongniao: { apiKey: 'my-own-hho-key-456' },
  };
  assert.deepEqual(SEEDKEYS.purge(sites), []);
  assert.equal(sites.doubao.apiKey, 'my-own-ark-key-123');
  assert.equal(sites.dongniao.apiKey, 'my-own-hho-key-456');
});

test('purge：空配置 / 脏数据不炸', () => {
  assert.deepEqual(SEEDKEYS.purge(null), []);
  assert.deepEqual(SEEDKEYS.purge({}), []);
  assert.deepEqual(SEEDKEYS.purge({ doubao: null, dongniao: 'x' }), []);
  assert.deepEqual(SEEDKEYS.purge({ doubao: { apiKey: '' } }), []);
});

test('stillBundled：能认出「还填着内置那把」的值', () => {
  const fp = (v) => crypto.createHash('sha256').update(v, 'utf8').digest('hex');
  const saved = { ...SEEDKEYS.SEED_KEY_FP };
  SEEDKEYS.SEED_KEY_FP['doubao.apiKey'] = fp('legacy-key');
  try {
    assert.equal(SEEDKEYS.stillBundled('doubao', 'legacy-key'), true);
    assert.equal(SEEDKEYS.stillBundled('doubao', 'other-key'), false);
    assert.equal(SEEDKEYS.stillBundled('dongniao', 'legacy-key'), false);
    assert.equal(SEEDKEYS.stillBundled('unknown', 'legacy-key'), false);
  } finally {
    Object.assign(SEEDKEYS.SEED_KEY_FP, saved);
  }
});

test('服务端：有保存 Key 的接口，且启动时会清一次残留', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(src, /'\/api\/site-key'/, '缺少 /api/site-key 路由');
  assert.match(src, /function apiSaveSiteKey/, '缺少 apiSaveSiteKey 实现');
  assert.match(src, /SEEDKEYS\.purge\(config\.sites\)/, '启动时没有清残留 Key');
  assert.match(src, /seedKeysPurged/, '缺少「只清一次」的标记');
  // 明文 Key 永远不回浏览器：siteMeta 只回 has（布尔）
  assert.match(src, /has: Object\.fromEntries/, 'siteMeta 应只回「填了没」');
});

test('前端：识别 Key 面板的入口、弹层与渲染函数都在', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
  assert.match(html, /id="siteKeyBtn"/, '顶栏没有「识别 Key」入口');
  assert.match(html, /id="siteKeyMask"/, '缺少识别 Key 弹层');
  assert.match(html, /id="siteKeyList"/, '缺少识别 Key 列表容器');
  assert.match(js, /function renderSiteKeys/, '缺少 renderSiteKeys');
  assert.match(js, /function openSiteKey/, '缺少 openSiteKey');
  assert.match(js, /data-needkey/, '灰着的 Key 站点应可点击去填 Key');
  assert.match(css, /\.sk-item/, '缺少识别 Key 面板样式');
});

test('打包清单包含 lib/seedkeys.js（漏了 exe 会报「模块未打包」）', () => {
  assert.ok(MODULES.includes('lib/seedkeys.js'), 'build/bundle.js 的 MODULES 少了 lib/seedkeys.js');
});
