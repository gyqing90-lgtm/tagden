'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const updateSign = require('../lib/update-sign');

function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    pub: publicKey.export({ type: 'spki', format: 'pem' }),
    priv: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

const base = {
  version: '0.6.24',
  url: 'tagden-0.6.24.exe',
  size: 123456,
  sha256: 'ABCDEF0123456789',
  pubDate: '2026-11-10',
  notes: '测试更新说明',
  keyId: 'test-key',
};

test('签名后能验过；改任何一个受保护字段都会失败', () => {
  const { pub, priv } = keypair();
  const m = { ...base, signature: updateSign.sign(base, priv) };

  assert.equal(updateSign.verify(m, pub).ok, true);

  for (const patch of [
    { version: '0.6.25' },
    { url: 'evil.exe' },
    { size: 1 },
    { sha256: 'deadbeef' },
    { notes: '被改过的说明' },
    { keyId: 'other-key' },
  ]) {
    assert.equal(updateSign.verify({ ...m, ...patch }, pub).ok, false, JSON.stringify(patch));
  }
});

test('增量补丁用独立的 deltasSignature 覆盖，不改基础签名', () => {
  const { pub, priv } = keypair();
  const withDelta = {
    ...base,
    deltas: [{ from: '0.6.23', url: 'tagden-0.6.23-to-0.6.24.patch', size: 250000, sha256: 'a'.repeat(64), baseSha256: 'b'.repeat(64), resultSha256: 'c'.repeat(64) }],
  };
  const signed = {
    ...withDelta,
    signature: updateSign.sign(withDelta, priv),
    deltasSignature: updateSign.signDeltas(withDelta, priv),
  };
  assert.equal(updateSign.verify(signed, pub).ok, true);
  assert.equal(updateSign.verifyDeltas(signed, pub).ok, true);

  const tampered = { ...signed, deltas: [{ ...signed.deltas[0], url: 'evil.patch' }] };
  // 基础清单没变，老客户端仍能验过；新客户端会发现补丁签名不对
  assert.equal(updateSign.verify(tampered, pub).ok, true);
  assert.equal(updateSign.verifyDeltas(tampered, pub).ok, false);
});

test('没有签名 / 没有公钥都返回 ok:false，不抛异常', () => {
  const { pub, priv } = keypair();
  const signed = { ...base, signature: updateSign.sign(base, priv) };

  assert.equal(updateSign.verify({ ...base }, pub).ok, false);
  assert.equal(updateSign.verify(signed, '').ok, false);
  // 用另一把公钥验，必须失败
  const other = keypair();
  assert.equal(updateSign.verify(signed, other.pub).ok, false);
});

test('canonical 对字段顺序不敏感，对值敏感', () => {
  const a = updateSign.canonical({ ...base });
  const b = updateSign.canonical({ keyId: base.keyId, notes: base.notes, pubDate: base.pubDate, sha256: base.sha256, size: base.size, url: base.url, version: base.version });
  assert.equal(a, b);
  assert.notEqual(a, updateSign.canonical({ ...base, version: '0.6.25' }));
  assert.notEqual(a, updateSign.canonical({ ...base, keyId: 'other-key' }));
});
