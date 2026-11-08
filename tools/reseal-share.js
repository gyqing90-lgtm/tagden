'use strict';

/**
 * 刷新内置的「自然在线识别账号」（lib/seed.js 里的 natureShare 键）
 *
 * 背景：自然在线的识别要靠一枚 Bearer 令牌，令牌是登录换来的、会过期。程序里内置的
 * 那枚令牌过期后，识别会自动退回用户自己登录的账号；但如果想让所有人都能开箱识别，
 * 就得隔一段时间把这枚令牌换新。这个脚本就是干这个的。
 *
 * 三种用法（都会重新封装 lib/seed.js，其余站点凭据原样保留）：
 *
 *   1) 本机已经登录过自然在线 —— 直接借 data/config.json 里的账号和令牌：
 *        node tools/reseal-share.js
 *
 *   2) 手动给账号密码和令牌（比如在别的机器上登录完，把令牌贴过来）：
 *        node tools/reseal-share.js --user 13800000000 --pass 'xxxx' --token 'eyJ0eXAi...'
 *
 *   3) 只改账号密码、不动令牌：
 *        node tools/reseal-share.js --user 13800000000 --pass 'xxxx'
 *
 *   加 --dry 只打印结果，不写文件。
 *
 * 明文不会落盘：直接进 secure.seal 的密文，命令行历史里那串自己注意清一下。
 */

const fs = require('node:fs');
const path = require('node:path');

const secure = require('../lib/secure');
const ROOT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
function opt(name) {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? String(argv[i + 1] || '') : '';
}
const dry = argv.includes('--dry');

/** 读当前种子（解不开就报错，别静默覆盖掉别的站点凭据） */
function readSeed() {
  const r = secure.open(require(path.join(ROOT, 'lib/seed')));
  if (!r.ok || !r.value || typeof r.value !== 'object') {
    throw new Error('解不开 lib/seed.js（secure.js 的 SHARDS 改过？），先手工确认再说');
  }
  return r.value;
}

/** 本机已登录的账号（data/config.json 的 sites.xingse） */
function readLocal() {
  const p = path.join(ROOT, 'data/config.json');
  if (!fs.existsSync(p)) return {};
  try {
    const r = secure.open(fs.readFileSync(p, 'utf8'));
    const x = r.ok && r.value && r.value.sites && r.value.sites.xingse;
    return x && typeof x === 'object' ? x : {};
  } catch {
    return {};
  }
}

const seed = readSeed();
const local = readLocal();
const cur = seed.natureShare && typeof seed.natureShare === 'object' ? seed.natureShare : {};

const next = {
  username: opt('user') || String(cur.username || local.username || ''),
  password: opt('pass') || String(cur.password || local.password || ''),
  token: opt('token') || String(cur.token || local.token || ''),
  tokenAt: Number(opt('token') ? Date.now() : cur.tokenAt || local.tokenAt || 0),
};

if (!next.username || !next.token) {
  console.error('缺东西：账号和令牌至少要有（--user / --token，或本机 data/config.json 已登录）');
  process.exit(1);
}

seed.natureShare = next;
const cipher = secure.seal(seed, { portable: true });
const chunks = [];
for (let i = 0; i < cipher.length; i += 96) chunks.push(cipher.slice(i, i + 96));
const body = chunks.map((c) => `  '${c}',`).join('\n');
const mod = `'use strict';

/**
 * 内嵌默认凭据（AES-256-GCM 密文，机器无关，随 exe 一起分发也能解开）
 *
 * 由 tools/seal.js / tools/reseal-share.js 生成，明文密码不在代码库中出现。
 * 更换账号时重新生成：
 *   node tools/seal.js --out lib/seed.js '{"port":7801,"sites":{"duoshi":{"username":"","password":""}}}'
 */

module.exports = [
${body}
].join('');
`;

console.log(`账号 ${next.username} · 令牌 ${next.token.slice(0, 8)}…（${next.token.length} 字符）· 其余 ${Object.keys(seed.sites || {}).length} 个站点凭据原样保留`);

if (dry) {
  console.log('--dry：没有写文件');
  process.exit(0);
}

fs.writeFileSync(path.join(ROOT, 'lib/seed.js'), mod, 'utf8');
console.log('已写入 lib/seed.js —— 记得 node build-exe.js <版本> 重新打包，否则线上包还是旧令牌');
