'use strict';
/**
 * 自然在线账号 —— 标注工坊里的「存储层」。
 *
 * 职责只有三件：
 *   1. 从内嵌种子（lib/seed.js）里取账号密码；
 *   2. 把登录换来的令牌单独落在 <data>/nature-token.json（和 config.json 一样用 secure.seal 加密）；
 *   3. 给出一个进程内单例客户端，其它模块直接用，不要各自 new。
 *
 * 为什么令牌不写回种子：种子是只读常量（打进了 exe），回写等于改代码；
 * 而且换账号时要重新跑 tools/seal.js 才能更新种子，令牌明显不该掺进去。
 *
 * 站点地址默认官方；NATURE_BASE 环境变量可以指到别处（离线联调用的假站点）：
 *   NATURE_BASE=http://127.0.0.1:7812 node server.js
 */

const fs = require('node:fs');
const path = require('node:path');

const secure = require('./secure');
const SEED_CIPHER = require('./seed');
const { createClient, BASE } = require('./nature-client');

/** 站点地址：默认官方，可被 NATURE_BASE 覆盖（本地 mock 联调用） */
const SITE_BASE = String(process.env.NATURE_BASE || BASE).replace(/\/+$/, '');

let dataDir = '';
let cacheDir = '';
let clientInstance = null;

function init(opt = {}) {
  dataDir = opt.dataDir || '';
  cacheDir = opt.cacheDir || '';
  clientInstance = null;
}

function tokenFile() {
  return path.join(dataDir, 'nature-token.json');
}

/** 本机是否落过令牌文件（登录或退出都会落）——存在即代表用户对会话表过态 */
function hasTokenFile() {
  try {
    return fs.existsSync(tokenFile());
  } catch {
    return false;
  }
}

function readToken() {
  try {
    const r = secure.open(fs.readFileSync(tokenFile(), 'utf8'));
    if (r.ok && r.value) return String(r.value.token || '');
  } catch {
    /* 没登过就是没有 */
  }
  return '';
}

function writeToken(token) {
  if (!dataDir) return;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(tokenFile(), secure.seal({ token: String(token || '') }), 'utf8');
  } catch (err) {
    console.log(`  [!!] 自然在线令牌保存失败：${err.message}`);
  }
}

/** 种子里的 xingse 账号（解不开就当没配，界面会提示要登录） */
function seedSite() {
  try {
    const r = secure.open(SEED_CIPHER);
    if (r.ok && r.value && r.value.sites && r.value.sites.xingse) return r.value.sites.xingse;
  } catch {
    /* 种子坏了 */
  }
  return {};
}

/** 进程内单例：令牌变了会通过 save 回调自动落盘 */
function client() {
  if (clientInstance) return clientInstance;
  const site = seedSite();
  clientInstance = createClient({
    baseUrl: SITE_BASE,
    username: String(site.username || ''),
    password: String(site.password || ''),
    // 令牌优先级：本机落盘的 > 种子里带的（种子里的 token 是打包时那台机器上的）。
    // 落盘文件存在却没令牌 = 用户明确退出过，这时不能再拿种子的旧令牌顶上，
    // 否则「退出登录」在重启后又被种子悄悄登录回去（识别模块也一样）。
    token: hasTokenFile() ? readToken() : String(site.token || ''),
    save: (s) => writeToken(s.token),
  });
  return clientInstance;
}

/** 给界面看的信息（不含任何密钥） */
function info() {
  const site = seedSite();
  return {
    host: SITE_BASE,
    central: SITE_BASE === BASE,
    username: String(site.username || ''),
    hasCreds: Boolean(site.username && site.password),
    hasToken: Boolean(hasTokenFile() ? readToken() : site.token),
  };
}

/** 用户是否明确退出过（令牌文件在、里面却没令牌）——调用方据此压制种子里的旧令牌 */
function loggedOut() {
  return hasTokenFile() && !readToken();
}

/* ---------------- 图片代理（缩略图带 referer + Bearer 取回来） ---------------- */

const IMG_TYPES = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
};

function imgExt(u) {
  const m = /\.(jpe?g|png|gif|bmp|webp|tiff?)(?:[?#]|$)/i.exec(String(u || ''));
  return m ? m[1].toLowerCase() : 'jpg';
}

function imgCachePath(u) {
  const key = require('node:crypto').createHash('sha1').update(String(u || '')).digest('hex');
  return path.join(cacheDir || dataDir, 'nature-img', key + '.' + imgExt(u));
}

/** 地址必须是本站，避免把本地服务当成任意 URL 的代理 */
function sameSite(u) {
  return String(u || '').startsWith(SITE_BASE + '/');
}

async function fetchImage(u) {
  if (!sameSite(u)) throw Object.assign(new Error('非法的图片地址'), { status: 400 });
  const X = client();
  const r = await fetch(u, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      referer: SITE_BASE + '/myNature',
      origin: SITE_BASE,
      authorization: X.token ? 'Bearer ' + X.token : '',
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`图片加载失败（HTTP ${r.status}）`);
  return {
    buffer: Buffer.from(await r.arrayBuffer()),
    contentType: r.headers.get('content-type') || IMG_TYPES[imgExt(u)] || 'image/jpeg',
  };
}

module.exports = {
  init,
  client,
  info,
  loggedOut,
  readToken,
  writeToken,
  fetchImage,
  imgCachePath,
  imgExt,
  IMG_TYPES,
  SITE_BASE,
};
