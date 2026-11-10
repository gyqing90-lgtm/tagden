'use strict';
/**
 * 自然在线「识别账号」—— 打包时烧进 lib/seed.js 的那一枚，**只给识别用**。
 *
 * 为什么分两套账号
 * --------------
 *   · 识别（传图换候选）是所有人都会用、而且要花站方额度的能力，必须开箱即用；
 *   · 相册是「我自己的照片」，必须用用户自己的账号登录，不能共用一个号。
 * 所以这里只管识别：读完种子就完事，不落盘、不改配置，也不出现在界面的账号栏里。
 *
 * 令牌过期怎么办
 * --------------
 * 令牌是打包那台机器登录换来的，站方会过期。过期后识别会自动退回用户自己登录的
 * 令牌（见 lib/adapters.js 的 identifyXingse）；两者都没有才报「未登录」。
 * 要更新内置账号：在工具机上重新登录一次，取出令牌，重跑
 *   node tools/seal.js --out lib/seed.js '<含 natureShare 的 JSON>'
 * 或者用 tools/reseal-share.js（会从 data/config.json 里取现成的令牌）。
 */

const secure = require('./secure');

// seed 是 .gitignore 里的凭据文件：CI / 纯源码树可能没有，别让模块加载直接炸
let SEED_CIPHER = null;
try { SEED_CIPHER = require('./seed'); } catch { /* 没有种子：识别账号视为未配置 */ }

let cache = null;

function read() {
  if (cache) return cache;
  const out = { username: '', password: '', token: '' };
  if (!SEED_CIPHER) return out;
  try {
    const r = secure.open(SEED_CIPHER);
    const s = r.ok && r.value && r.value.natureShare;
    if (s && typeof s === 'object') {
      out.username = String(s.username || '');
      out.password = String(s.password || '');
      out.token = String(s.token || '');
    }
  } catch {
    /* 种子坏了就当没配，别让整个服务起不来 */
  }
  cache = out;
  return cache;
}

/** 给界面看的信息：只报「有没有」，账号和令牌都不出本机 */
function info() {
  const s = read();
  return { hasToken: Boolean(s.token), hasCreds: Boolean(s.username && s.password) };
}

function token() {
  return read().token;
}

function has() {
  return Boolean(read().token);
}

module.exports = { info, token, has };
