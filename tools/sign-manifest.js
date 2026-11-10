#!/usr/bin/env node
'use strict';

/**
 * 给 dist/latest.json / dist-mac/latest-mac.json 加 Ed25519 签名。
 *
 *   node tools/sign-manifest.js
 *   node tools/sign-manifest.js dist/latest.json dist-mac/latest-mac.json
 *   node tools/sign-manifest.js --key ~/safe/update-signing-key.pem
 *
 * 私钥来源：--key > 环境变量 TAGDEN_UPDATE_SK（PEM 或路径）> ~/.tagden/update-signing-key.pem
 * 公钥来源：--update-pubkey / 环境变量 TAGDEN_UPDATE_PUBKEY / 项目根 update-pubkey.pem
 *
 * 签完会立刻用公钥验一遍；公私钥不配对会直接报错，不会把坏清单发出去。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const updateSign = require('../lib/update-sign');
const { resolvePublicKey, fingerprint } = require('../build/signing');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const argOf = (name, fallback = '') => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

function readPrivateKey() {
  const given = argOf('--key') || process.env.TAGDEN_UPDATE_SK || '';
  if (given) {
    if (String(given).includes('BEGIN PRIVATE KEY')) return String(given);
    const file = path.resolve(ROOT, String(given));
    if (!fs.existsSync(file)) throw new Error(`私钥文件不存在：${file}`);
    return fs.readFileSync(file, 'utf8');
  }
  const fallback = path.join(os.homedir(), '.tagden', 'update-signing-key.pem');
  if (!fs.existsSync(fallback)) {
    throw new Error(
      `找不到私钥：${fallback}\n` +
        '先跑 node tools/update-keygen.js 生成，或用 --key / TAGDEN_UPDATE_SK 指定。',
    );
  }
  return fs.readFileSync(fallback, 'utf8');
}

function main() {
  const priv = readPrivateKey();
  const pub = resolvePublicKey(ROOT, argv);
  if (!pub) {
    throw new Error('找不到公钥：请确认项目根有 update-pubkey.pem，或用 --update-pubkey 指定。');
  }

  const explicit = argv.filter((a) => /\.json$/i.test(a));
  const files = explicit.length
    ? explicit.map((f) => path.resolve(ROOT, f))
    : [path.join(ROOT, 'dist', 'latest.json'), path.join(ROOT, 'dist-mac', 'latest-mac.json')].filter((f) =>
        fs.existsSync(f),
      );
  if (!files.length) throw new Error('没有找到要签名的清单（dist/latest.json 或 dist-mac/latest-mac.json）');

  const fp = fingerprint(pub);
  console.log(`  公钥指纹  ${fp}`);
  for (const file of files) {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!manifest.keyId) {
      throw new Error(`${path.relative(ROOT, file)} 没有 keyId，说明打包时还没配置公钥；请先放好 update-pubkey.pem 再重新打包`);
    }
    if (manifest.keyId !== fp) {
      throw new Error(`${path.relative(ROOT, file)} 的 keyId ${manifest.keyId} 与当前公钥 ${fp} 不一致，请先重新打包`);
    }
    manifest.signature = updateSign.sign(manifest, priv);
    const check = updateSign.verify(manifest, pub);
    if (!check.ok) throw new Error(`${path.relative(ROOT, file)} 验签失败：${check.reason}`);

    // 增量补丁单独签：老客户端只认 signature，不认识 deltas；新客户端两个都验
    if (Array.isArray(manifest.deltas) && manifest.deltas.length) {
      manifest.deltasSignature = updateSign.signDeltas(manifest, priv);
      const dcheck = updateSign.verifyDeltas(manifest, pub);
      if (!dcheck.ok) throw new Error(`${path.relative(ROOT, file)} 增量补丁验签失败：${dcheck.reason}`);
    } else {
      delete manifest.deltasSignature;
    }

    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const extra = manifest.deltas ? `  deltas ${manifest.deltas.length}` : '';
    console.log(`  [ok] ${path.relative(ROOT, file)}  v${manifest.version}  ${manifest.signature.slice(0, 16)}…${extra}`);
  }
  console.log('');
  console.log('  下一步：node tools/publish-oss.js --with-mac --verify');
}

main();
