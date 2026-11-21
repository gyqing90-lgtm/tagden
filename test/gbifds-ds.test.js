'use strict';
/**
 * GBIF 面板补中文名用的模型接口：地址归一化 + 请求体。
 *
 * 重点不是「能不能连上」，而是别把两家的参数搅在一起：
 *   · DeepSeek 官方：json_object，不带 thinking
 *   · 云知声：思考模式和 json_object 互斥，能关思考的关掉、关不掉的干脆不带
 * 外加 listModels 要能吃下 data[].id / models[] 两种形状。
 */

const test = require('node:test');
const assert = require('node:assert');
const G = require('../lib/gbifds');

const UNI = 'https://maas-api.unisound.com/v1';
const data = { genus: 'Papilio', globalTotal: 3, records: 2, species: [] };
const known = {};

test('chatUrl：根地址 / 带 v1 / 写全三种写法都归一到一个地址', () => {
  assert.strictEqual(G.chatUrl(''), 'https://api.deepseek.com/chat/completions', '留空回落到官方');
  assert.strictEqual(G.chatUrl('https://api.deepseek.com'), 'https://api.deepseek.com/chat/completions');
  assert.strictEqual(G.chatUrl('https://api.deepseek.com/'), 'https://api.deepseek.com/chat/completions');
  assert.strictEqual(G.chatUrl(UNI), UNI + '/chat/completions');
  assert.strictEqual(G.chatUrl(UNI + '/'), UNI + '/chat/completions');
  // 已经写全的不重复拼
  assert.strictEqual(G.chatUrl(UNI + '/chat/completions'), UNI + '/chat/completions');
  // 用户从文档里复制时带的空格要吃掉
  assert.strictEqual(G.chatUrl('  ' + UNI + '  '), UNI + '/chat/completions');
});

test('providerOf / providerLabel / defaultModel：只认域名', () => {
  assert.strictEqual(G.providerOf(''), 'deepseek');
  assert.strictEqual(G.providerOf('https://api.deepseek.com/v1'), 'deepseek');
  assert.strictEqual(G.providerOf(UNI), 'unisound');
  assert.strictEqual(G.providerOf('https://maas-api.unisound.com/v1/chat/completions'), 'unisound', '带完整路径也认得');
  assert.strictEqual(G.providerOf('https://api.moonshot.cn/v1'), 'custom');

  assert.strictEqual(G.providerLabel(UNI), '云知声 MaaS');
  assert.strictEqual(G.providerLabel(''), 'DeepSeek 官方');
  assert.strictEqual(G.providerLabel('https://api.moonshot.cn/v1'), '自定义接口');

  assert.strictEqual(G.defaultModel(''), 'deepseek-chat');
  assert.strictEqual(G.defaultModel(UNI), 'u2-flash', '云知声默认给 u2-flash，不硬塞 deepseek 模型');
});

test('buildPayload：DeepSeek 官方带 json_object、不带 thinking', () => {
  const p = G.buildPayload({ model: 'deepseek-chat', baseUrl: '', question: 'q', data, known });
  assert.deepStrictEqual(p.response_format, { type: 'json_object' });
  assert.strictEqual(p.thinking, undefined);
  assert.strictEqual(p.stream, false);
  assert.strictEqual(p.messages.length, 2);
  assert.strictEqual(p.messages[0].role, 'system');
});

test('buildPayload：云知声 u2-flash 关思考 + json_object（实测这个组合 200）', () => {
  const p = G.buildPayload({ model: 'u2-flash', baseUrl: UNI, question: 'q', data, known });
  assert.deepStrictEqual(p.thinking, { type: 'disabled' });
  assert.deepStrictEqual(p.response_format, { type: 'json_object' });
  assert.strictEqual(p.model, 'u2-flash');
});

test('buildPayload：云端 deepseek 系列默认开思考，同样要显式关', () => {
  const p = G.buildPayload({ model: 'deepseek-v4.1-flash', baseUrl: UNI, question: 'q', data, known });
  assert.deepStrictEqual(p.thinking, { type: 'disabled' });
  assert.deepStrictEqual(p.response_format, { type: 'json_object' });
});

test('buildPayload：关不掉思考的模型不带 response_format（否则必报错）', () => {
  for (const m of ['u2', 'kimi-k3', 'glm-5.3', 'MiniMax-M2.5']) {
    const p = G.buildPayload({ model: m, baseUrl: UNI, question: 'q', data, known });
    assert.strictEqual(p.response_format, undefined, m + ' 不该带 response_format');
    assert.strictEqual(p.thinking, undefined, m + ' 不该带 thinking');
  }
});

test('buildPayload：没填模型时按服务商兜底，不会出现「云地址 + deepseek-chat」', () => {
  assert.strictEqual(G.buildPayload({ model: '', baseUrl: UNI, question: 'q', data, known }).model, 'u2-flash');
  assert.strictEqual(G.buildPayload({ model: '   ', baseUrl: '', question: 'q', data, known }).model, 'deepseek-chat');
});

test('listModels：data[].id 与 models[] 两种形状都能读', async () => {
  const realFetch = global.fetch;
  try {
    global.fetch = async () => new Response(JSON.stringify({ data: [{ id: 'u2-flash' }, { id: 'u2-med' }] }), { status: 200 });
    assert.deepStrictEqual(await G.listModels({ apiKey: 'k', baseUrl: UNI }), ['u2-flash', 'u2-med']);

    global.fetch = async () => new Response(JSON.stringify({ models: ['deepseek-chat', { name: 'deepseek-reasoner' }] }), { status: 200 });
    assert.deepStrictEqual(await G.listModels({ apiKey: 'k', baseUrl: '' }), ['deepseek-chat', 'deepseek-reasoner']);
  } finally {
    global.fetch = realFetch;
  }
});

test('listModels：请求打到 /models 而不是 /chat/completions，且带 Bearer', async () => {
  const realFetch = global.fetch;
  let seen = null;
  try {
    global.fetch = async (url, opt) => {
      seen = { url, auth: opt.headers.authorization };
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    };
    await G.listModels({ apiKey: 'sk-test', baseUrl: UNI });
    assert.strictEqual(seen.url, UNI + '/models');
    assert.strictEqual(seen.auth, 'Bearer sk-test');
  } finally {
    global.fetch = realFetch;
  }
});

test('listModels：没 Key / 报错都给中文原因，不抛英文堆栈', async () => {
  await assert.rejects(() => G.listModels({ apiKey: '', baseUrl: UNI }), /还没配置/);
  const realFetch = global.fetch;
  try {
    global.fetch = async () => new Response('nope', { status: 401 });
    await assert.rejects(() => G.listModels({ apiKey: 'k', baseUrl: UNI }), /云知声 MaaS HTTP 401/);
  } finally {
    global.fetch = realFetch;
  }
});
