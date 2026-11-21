'use strict';

/**
 * 生成内嵌的默认模型 Key（lib/builtin-ds.js）
 *
 * 为什么要多这一层：Key 直接写进 server.js 会跟着仓库上 GitHub，任何人搜一下就拿到；
 * 打成 portable 密文模块后，仓库里只有密文，exe 里也是密文（strings 扫不出明文 Key）。
 * 这是提高提取门槛，不是密码学意义上的保密 —— portable 密文的主密钥在程序里，
 * 有心想拆的人终究能解出来。所以只放免费额度、定期更换的 Key，别放绑了卡的主账号。
 *
 * 用法：
 *   node tools/seal-ds.js tp-xxxx                     默认云知声 MaaS + u2-flash
 *   node tools/seal-ds.js --model u2-med tp-xxxx      换个默认模型
 *   node tools/seal-ds.js --base https://xxx/v1 tp-x  换服务商
 *   node tools/seal-ds.js --clear                      清掉内置 Key（回到让用户自己填）
 *   node tools/seal-ds.js --show                       只打印当前内置 Key 的摘要，不输出明文
 *
 * 换新 Key 的完整流程：跑一次这个脚本 → node build-exe.js 与 node build-mac.js → 发布。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const secure = require('../lib/secure');

const ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(ROOT, 'lib', 'builtin-ds.js');

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes('--' + name);

const DEFAULT_BASE = 'https://maas-api.unisound.com/v1';
const DEFAULT_MODEL = 'u2-flash';

function readBuiltin() {
  if (!fs.existsSync(TARGET)) return null;
  try {
    const r = secure.open(require(TARGET));
    return r.ok && r.value ? r.value : null;
  } catch {
    return null;
  }
}

/* --show：只报摘要，方便换 Key 前确认现在烧的是哪一枚 */
if (has('show')) {
  const cur = readBuiltin();
  if (!cur) {
    console.log('当前没有内置模型 Key（用户需自己填）。');
    process.exit(0);
  }
  const k = String(cur.apiKey || '');
  const fp = crypto.createHash('sha256').update(k).digest('hex').slice(0, 12);
  console.log(`内置 Key 开头 ${k.slice(0, 6)}… 结尾 …${k.slice(-4)}，指纹 ${fp}`);
  console.log(`服务商 ${cur.baseUrl || '(DeepSeek 官方)'}  默认模型 ${cur.model || '-'}`);
  process.exit(0);
}

/* --clear：把这个文件删掉，打包时就当没有内置 Key */
if (has('clear')) {
  if (fs.existsSync(TARGET)) {
    fs.unlinkSync(TARGET);
    console.log('已删除 lib/builtin-ds.js，下次打包不含内置 Key。');
  } else {
    console.log('本来就没有 lib/builtin-ds.js。');
  }
  process.exit(0);
}

const baseUrl = String(flag('base', DEFAULT_BASE)).trim();
const model = String(flag('model', DEFAULT_MODEL)).trim();
/* 位置参数里非 -- 开头的那一个就是 Key */
const inline = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

let apiKey = String(inline || readStdin() || '').trim();
/* 允许直接从提示里粘「Key + 空白」或带引号，去掉首尾杂字符 */
apiKey = apiKey.replace(/^[\s"'`]+|[\s"'`]+$/g, '');

if (!apiKey) {
  console.error('没拿到 Key。用法：node tools/seal-ds.js tp-xxxxxxxx');
  process.exit(1);
}
if (apiKey.length < 16) {
  console.error('这个 Key 看着太短，确认一下是不是粘全了。');
  process.exit(1);
}

const data = { apiKey, baseUrl, model };
const cipher = secure.seal(data, { portable: true });

const chunks = [];
for (let i = 0; i < cipher.length; i += 96) chunks.push(cipher.slice(i, i + 96));
const body = chunks.map((c) => `  '${c}',`).join('\n');

const mod = `'use strict';

/**
 * 内嵌的默认模型 Key（portable 密文，任何机器都能解开）
 *
 * 由 tools/seal-ds.js 生成，**不要手改**。这个文件在 .gitignore 里，不进版本库。
 * 换 Key：node tools/seal-ds.js tp-新Key  然后重新打包两个平台。
 * 查询现状：node tools/seal-ds.js --show
 * 恢复成「用户自己填」：node tools/seal-ds.js --clear
 */

module.exports = [
${body}
].join('');
`;

fs.writeFileSync(TARGET, mod, 'utf8');
const fp = crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 12);
console.log(`已写入 ${path.relative(ROOT, TARGET)}`);
console.log(`  服务商 ${baseUrl}  默认模型 ${model}`);
console.log(`  Key 指纹 ${fp}（密文 ${cipher.length} 字符，仓库里只有密文）`);
console.log('');
console.log('下一步：node build-exe.js <版本> --out /tmp/tagden-out && node build-mac.js <版本>');
