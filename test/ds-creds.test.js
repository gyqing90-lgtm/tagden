'use strict';

/**
 * 模型接口凭据优先级（lib/ds-creds.js）
 *
 * 这段逻辑管着「会不会悄悄烧作者的免费额度」，每一次改都要有测试兜住：
 * 优先级错一位，用户点过「清除」也照样在花别人的钱。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { pick, FACTORY_MODEL } = require('../lib/ds-creds');

const BUILTIN = {
  apiKey: 'tp-builtin-key',
  baseUrl: 'https://maas-api.unisound.com/v1',
  model: 'u2-flash',
};

test('既没自填也没内置：三个字段全空，不假装能用', () => {
  const r = pick({ cfg: {}, builtin: null });
  assert.equal(r.apiKey, '');
  assert.equal(r.baseUrl, '');
  assert.equal(r.model, FACTORY_MODEL);
  assert.equal(r.usingBuiltin, false);
  assert.equal(r.userKey, false);
});

test('只有内置：直接用，标记 usingBuiltin', () => {
  const r = pick({ cfg: { apiKey: '', model: FACTORY_MODEL, baseUrl: '' }, builtin: BUILTIN });
  assert.equal(r.apiKey, 'tp-builtin-key');
  assert.equal(r.baseUrl, 'https://maas-api.unisound.com/v1');
  assert.equal(r.model, 'u2-flash');
  assert.equal(r.usingBuiltin, true);
});

test('用户自填的 Key 优先于内置，且不再算 usingBuiltin', () => {
  const r = pick({ cfg: { apiKey: 'sk-mine', model: FACTORY_MODEL }, builtin: BUILTIN });
  assert.equal(r.apiKey, 'sk-mine');
  assert.equal(r.usingBuiltin, false);
  assert.equal(r.userKey, true);
});

test('用户自填了 Key 但没填地址：不要硬套内置的云知声地址', () => {
  // 用户拿的是 DeepSeek 官方 Key，baseUrl 留空＝官方。此时若沿用内置地址必然 401
  const r = pick({ cfg: { apiKey: 'sk-mine', baseUrl: '', model: 'deepseek-chat' }, builtin: BUILTIN });
  assert.equal(r.apiKey, 'sk-mine');
  assert.equal(r.baseUrl, '');
  assert.equal(r.model, 'deepseek-chat');
});

test('清除过（optOutBuiltin）：内置 Key 在也不能用', () => {
  const r = pick({ cfg: { apiKey: '', optOutBuiltin: true }, builtin: BUILTIN });
  assert.equal(r.apiKey, '');
  assert.equal(r.baseUrl, '');
  assert.equal(r.usingBuiltin, false);
});

test('清除过之后又填了自己的 Key：正常用自填的', () => {
  const r = pick({ cfg: { apiKey: 'sk-mine', optOutBuiltin: true }, builtin: BUILTIN });
  assert.equal(r.apiKey, 'sk-mine');
  assert.equal(r.usingBuiltin, false);
});

test('用户把模型改成 u2-med：听用户的，不被内置的 u2-flash 盖掉', () => {
  const r = pick({ cfg: { apiKey: '', model: 'u2-med' }, builtin: BUILTIN });
  assert.equal(r.model, 'u2-med');
  assert.equal(r.apiKey, 'tp-builtin-key');
});

test('配置里还是出厂默认 deepseek-chat 时，让位给内置的模型名', () => {
  // 出厂默认写死 deepseek-chat，但内置 Key 是云知声的：拿它问 deepseek-chat 必 404
  const r = pick({ cfg: { apiKey: '', model: FACTORY_MODEL }, builtin: BUILTIN });
  assert.equal(r.model, 'u2-flash');
});

test('内置的就是 DeepSeek 官方时，模型名保持 deepseek-chat', () => {
  const r = pick({
    cfg: { model: FACTORY_MODEL },
    builtin: { apiKey: 'sk-builtin', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  });
  assert.equal(r.model, 'deepseek-chat');
});

test('临时指定的 Key 不落盘也能生效（列模型按钮用）', () => {
  const r = pick({ cfg: {}, builtin: BUILTIN, explicitKey: 'sk-temp' });
  assert.equal(r.apiKey, 'sk-temp');
  assert.equal(r.usingBuiltin, false);
});

test('没有内置 Key 时，optOutBuiltin 不影响自填的 Key', () => {
  const r = pick({ cfg: { apiKey: 'sk-mine', optOutBuiltin: true }, builtin: null });
  assert.equal(r.apiKey, 'sk-mine');
});

test('内置对象缺 apiKey 时当成没有内置，不返回半截地址', () => {
  const r = pick({ cfg: {}, builtin: { apiKey: '   ', baseUrl: 'https://x/v1' } });
  assert.equal(r.apiKey, '');
  assert.equal(r.baseUrl, '');
  assert.equal(r.usingBuiltin, false);
});

test('cfg 传 null / undefined 也不崩', () => {
  assert.equal(pick({}).apiKey, '');
  assert.equal(pick({ cfg: null }).apiKey, '');
  assert.equal(pick({ cfg: undefined, builtin: BUILTIN }).apiKey, 'tp-builtin-key');
});
