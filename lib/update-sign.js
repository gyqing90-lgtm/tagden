'use strict';

/**
 * 更新清单签名（Ed25519）。
 *
 * 为什么需要：更新器只校验 SHA-256，而清单和安装包都在同一个 OSS 桶里；
 * 拿到写桶权限的人可以同时换包和换 SHA，所有老用户下次启动就会自动装上。
 * 签名把「能改桶」和「能发版」拆开：桶里只有被私钥签过的清单才会被接受。
 *
 * 签的是清单里会影响安装的字段（version / url / size / sha256 / pubDate / notes），
 * 用固定顺序的 JSON 做 canonical，避免不同序列化方式导致验签失败。
 *
 * 公钥从三处取，优先级从高到低：
 *   1. 打包时注入的 global.__APP_META__.updatePublicKey
 *   2. 环境变量 TAGDEN_UPDATE_PUBKEY（PEM 内容，或指向 PEM 的路径）
 *   3. 程序目录下的 update-pubkey.pem（源码模式方便调试）
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { APP_DIR } = require('./env');

const meta = (typeof global.__APP_META__ === 'object' && global.__APP_META__) || {};

function publicKeyText() {
  if (meta.updatePublicKey) return String(meta.updatePublicKey).trim();
  const env = String(process.env.TAGDEN_UPDATE_PUBKEY || '').trim();
  if (env) {
    if (env.includes('BEGIN PUBLIC KEY')) return env;
    try {
      return fs.readFileSync(env, 'utf8').trim();
    } catch {
      return '';
    }
  }
  try {
    return fs.readFileSync(path.join(APP_DIR, 'update-pubkey.pem'), 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * 固定字段 + 固定顺序：签名端和验签端必须用同一份。
 *
 * 注意：**这个函数不能再加字段**。0.6.24 及更早的客户端就是按这份 canonical 验签的，
 * 加一个字段会让所有旧签名/旧客户端同时失效。增量补丁的元数据单独走
 * deltasSignature（见下），老客户端不认识就忽略，只下完整包。
 */
function canonical(manifest) {
  const m = manifest || {};
  return JSON.stringify({
    version: String(m.version || ''),
    url: String(m.url || ''),
    size: Number(m.size) || 0,
    sha256: String(m.sha256 || '').toLowerCase(),
    pubDate: String(m.pubDate || ''),
    notes: String(m.notes || ''),
    keyId: String(m.keyId || ''),
  });
}

function normalizedDeltas(manifest) {
  const list = Array.isArray(manifest && manifest.deltas) ? manifest.deltas : [];
  return list.map((d) => ({
    from: String((d && d.from) || ''),
    url: String((d && d.url) || ''),
    size: Number((d && d.size) || 0),
    sha256: String((d && d.sha256) || '').toLowerCase(),
    baseSha256: String((d && d.baseSha256) || '').toLowerCase(),
    resultSha256: String((d && d.resultSha256) || '').toLowerCase(),
  }));
}

/**
 * 增量补丁单独签：把基础清单的 canonical 和 deltas 一起包进去。
 * 这样老客户端只验 signature、不认识 deltas；新客户端两个都验。
 */
function deltasCanonical(manifest) {
  return JSON.stringify({
    v: 1,
    base: JSON.parse(canonical(manifest)),
    deltas: normalizedDeltas(manifest),
  });
}

function sign(manifest, privateKeyPem) {
  if (!privateKeyPem) throw new Error('缺少更新签名私钥');
  const key = crypto.createPrivateKey(privateKeyPem);
  return crypto.sign(null, Buffer.from(canonical(manifest), 'utf8'), key).toString('base64');
}

/** 给 deltas 单独签名；没有 deltas 时返回空串 */
function signDeltas(manifest, privateKeyPem) {
  if (!normalizedDeltas(manifest).length) return '';
  if (!privateKeyPem) throw new Error('缺少更新签名私钥');
  const key = crypto.createPrivateKey(privateKeyPem);
  return crypto.sign(null, Buffer.from(deltasCanonical(manifest), 'utf8'), key).toString('base64');
}

/**
 * @returns {{ok: boolean, reason?: string}}
 */
function verify(manifest, publicKeyPem) {
  const signature = String((manifest && manifest.signature) || '').trim();
  if (!signature) return { ok: false, reason: '清单没有 signature 字段' };
  const pem = String(publicKeyPem || publicKeyText() || '').trim();
  if (!pem) return { ok: false, reason: '本程序没有内置更新公钥' };
  try {
    const ok = crypto.verify(
      null,
      Buffer.from(canonical(manifest), 'utf8'),
      crypto.createPublicKey(pem),
      Buffer.from(signature, 'base64'),
    );
    return ok ? { ok: true } : { ok: false, reason: '签名不匹配（清单可能被改过）' };
  } catch (err) {
    return { ok: false, reason: err.message || '签名校验失败' };
  }
}

/**
 * 验证增量补丁签名。
 * @returns {{ok: boolean, reason?: string}}
 */
function verifyDeltas(manifest, publicKeyPem) {
  const signature = String((manifest && manifest.deltasSignature) || '').trim();
  if (!signature) return { ok: false, reason: '清单没有 deltasSignature 字段' };
  if (!normalizedDeltas(manifest).length) return { ok: false, reason: '清单没有 deltas' };
  const pem = String(publicKeyPem || publicKeyText() || '').trim();
  if (!pem) return { ok: false, reason: '本程序没有内置更新公钥' };
  try {
    const ok = crypto.verify(
      null,
      Buffer.from(deltasCanonical(manifest), 'utf8'),
      crypto.createPublicKey(pem),
      Buffer.from(signature, 'base64'),
    );
    return ok ? { ok: true } : { ok: false, reason: '增量补丁签名不匹配（deltas 可能被改过）' };
  } catch (err) {
    return { ok: false, reason: err.message || '增量补丁签名校验失败' };
  }
}

/** 这个构建是否强制要求签名清单（打包时有公钥就自动打开） */
function required() {
  return meta.requireSignedUpdates === true || process.env.TAGDEN_REQUIRE_UPDATE_SIGNATURE === '1';
}

/** 公钥指纹：换钥/排障时对一下，不需要暴露完整公钥 */
function keyFingerprint(pem) {
  const text = String(pem || publicKeyText() || '').trim();
  if (!text) return '';
  const der = crypto.createPublicKey(text).export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex').slice(0, 16);
}

module.exports = { canonical, deltasCanonical, sign, signDeltas, verify, verifyDeltas, required, publicKeyText, keyFingerprint };
