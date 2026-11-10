#!/usr/bin/env node
'use strict';

/**
 * 生成更新清单签名用的 Ed25519 密钥对。
 *
 *   node tools/update-keygen.js
 *   node tools/update-keygen.js --out ~/safe/update-signing-key.pem --pub ./update-pubkey.pem
 *
 * 私钥默认写到用户目录（不进仓库）：~/.tagden/update-signing-key.pem
 * 公钥默认写到项目根：update-pubkey.pem（这个要提交 / 随源码交接）
 *
 * 重要：
 *   - 私钥只生成一次，丢了就只能换钥；换钥后旧版本客户端认不了新签名，
 *     所以要备份到离线介质（U 盘 / 密码管理器）。
 *   - 私钥不要放进仓库、不要发群里、不要和 oss.config.json 放同一台联网机器上。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { fingerprint } = require('../build/signing');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const argOf = (name, fallback = '') => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const force = argv.includes('--force');
const out = path.resolve(argOf('--out', path.join(os.homedir(), '.tagden', 'update-signing-key.pem')));
const pub = path.resolve(argOf('--pub', path.join(ROOT, 'update-pubkey.pem')));

if (fs.existsSync(out) && !force) {
  console.error(`私钥已存在：${out}`);
  console.error('为免覆盖导致旧版本永远收不到更新，这里不自动覆盖；确实要换钥请加 --force，并先备份旧钥。');
  process.exit(1);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const pubPem = publicKey.export({ type: 'spki', format: 'pem' });

fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
fs.writeFileSync(out, privPem, { encoding: 'utf8', mode: 0o600 });
fs.mkdirSync(path.dirname(pub), { recursive: true });
fs.writeFileSync(pub, pubPem, 'utf8');

console.log('');
console.log('  已生成更新签名密钥');
console.log(`  私钥  ${out}   （0600，务必备份到离线位置）`);
console.log(`  公钥  ${pub}   （提交进仓库 / 随源码交接）`);
console.log(`  指纹  ${fingerprint(pubPem)}`);
console.log('');
console.log('  下一步：');
console.log('    1. 备份私钥，并把 update-pubkey.pem 提交');
console.log('    2. 打包：node build-exe.js <版本> && node build-mac.js <版本>');
console.log('    3. 签名：node tools/sign-manifest.js');
console.log('    4. 发布：node tools/publish-oss.js --with-mac --verify');
console.log('');
