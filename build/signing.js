'use strict';

/**
 * 构建期的更新签名辅助（不打包进 exe）：
 * 从命令行 / 环境变量 / 项目根找 update-pubkey.pem，供 build-exe.js / build-mac.js
 * 注入到 __APP_META__，也供 tools/sign-manifest.js 和 publish-oss.js 验签。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * @param {string} root 项目根
 * @param {string[]} [argv] 命令行参数
 * @returns {string} PEM 内容，没有配置时返回空串
 */
function resolvePublicKey(root, argv = []) {
  const idx = argv.indexOf('--update-pubkey');
  const given = (idx >= 0 && argv[idx + 1]) || process.env.TAGDEN_UPDATE_PUBKEY || '';
  if (given) {
    if (String(given).includes('BEGIN PUBLIC KEY')) return String(given).trim();
    const file = path.resolve(root, String(given));
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
    throw new Error(`--update-pubkey 指向的文件不存在：${file}`);
  }
  const local = path.join(root, 'update-pubkey.pem');
  try {
    return fs.readFileSync(local, 'utf8').trim();
  } catch {
    return '';
  }
}

function fingerprint(pem) {
  const text = String(pem || '').trim();
  if (!text) return '';
  const der = crypto.createPublicKey(text).export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex').slice(0, 16);
}

module.exports = { resolvePublicKey, fingerprint };
