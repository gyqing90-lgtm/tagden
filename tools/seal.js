'use strict';

/**
 * 生成内嵌默认凭据的密文模块（lib/seed.js）
 *
 * 用法：
 *   node tools/seal.js --out lib/seed.js '{"port":8791,"sites":{...}}'
 *   echo '{...}' | node tools/seal.js --out lib/seed.js
 *
 * 不带 --out 时只把密文打印到屏幕，方便贴到别处。
 * 明文用完即弃，不会写进仓库。
 */

const fs = require('node:fs');
const path = require('node:path');
const secure = require('../lib/secure');

const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const outPath = outIdx >= 0 ? argv[outIdx + 1] : null;
const inline = argv.find((a, i) => !a.startsWith('--') && i !== outIdx + 1);

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

const text = (inline || readStdin()).trim();
if (!text) {
  console.error('没有拿到 JSON。用法：node tools/seal.js --out lib/seed.js \'{"sites":{...}}\'');
  process.exit(1);
}

let data;
try {
  data = JSON.parse(text);
} catch (err) {
  console.error('JSON 解析失败：' + err.message);
  process.exit(1);
}

const cipher = secure.seal(data, { portable: true });

if (!outPath) {
  console.log(cipher);
  process.exit(0);
}

const chunks = [];
for (let i = 0; i < cipher.length; i += 96) chunks.push(cipher.slice(i, i + 96));
const body = chunks.map((c) => `  '${c}',`).join('\n');

const mod = `'use strict';

/**
 * 内嵌默认凭据（AES-256-GCM 密文，机器无关，随 exe 一起分发也能解开）
 *
 * 由 tools/seal.js 生成，明文密码不在代码库中出现。
 * 更换账号时重新生成：
 *   node tools/seal.js --out lib/seed.js '{"port":8791,"sites":{"duoshi":{"username":"","password":""}}}'
 */

module.exports = [
${body}
].join('');
`;

const target = path.resolve(__dirname, '..', outPath);
fs.writeFileSync(target, mod, 'utf8');
console.log(`已写入 ${target}`);
console.log(`密文长度 ${cipher.length} 字符，默认账号：${Object.entries(data.sites || {}).filter(([, v]) => v && v.username).map(([k]) => k).join(', ') || '无'}`);
