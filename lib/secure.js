'use strict';

/**
 * 凭据加密模块
 *
 * 两种密文形态（文件头部 BID1.<方式>.<...> 标识）：
 *
 *   dpapi  —— Windows 数据保护 API，密钥由系统 LSA 保管，只有「同一台机器的同一个
 *             用户账户」能解开。落盘的 config.json 用这个，文件被拷到别处等于废纸。
 *   dev    —— AES-256-GCM，密钥 = 内嵌主密钥 + 本机指纹（主机名/用户名/家目录）。
 *             不依赖外部程序、耗时 1ms 级，用于会话缓存这种高频写入。
 *   port   —— AES-256-GCM，只用内嵌主密钥，与机器无关。用于内嵌在 exe 里的默认账号，
 *             这样换一台电脑首次运行也能解密出来。
 *
 * 说明：port 形态的安全性来自「密钥没有以明文形式出现在文件里」，属于防窥级别；
 * 因为程序必须能自己解开，任何内嵌密钥的方案都无法对抗完整的逆向分析。
 * 真正需要抗逆向的是落盘数据，所以那里用的是 dpapi。
 */

const crypto = require('node:crypto');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const PREFIX = 'BID1';
const TAG_LEN = 16;
const IV_LEN = 12;

// 主密钥碎片：运行时拼接，避免整串可读常量直接出现在二进制里被 strings 搜到
const SHARDS = [
  '9f3c1a7e5b2d8406',
  'c48e0b91d7a25f36',
  '7a1d9e4c6b803f52',
  'e05b8d3a71c9624f',
];

function masterKey() {
  return crypto.createHash('sha256').update(SHARDS.join('') + '|bio-id-hub|v1', 'utf8').digest();
}

/** 本机指纹：换机器/换用户就解不开 dev 密文 */
function deviceSecret() {
  let user = 'unknown';
  let home = '';
  try {
    user = os.userInfo().username;
    home = os.homedir();
  } catch {
    /* 极端环境下取不到，退化为空值 */
  }
  return crypto
    .createHash('sha256')
    .update([os.hostname(), user, home, process.platform, os.arch()].join('\u0001'))
    .digest();
}

function deriveKey(ikm, salt, scope) {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from(scope, 'utf8'), 32));
}

function aesSeal(key, plain) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

function aesOpen(key, sealed) {
  if (sealed.length < IV_LEN + TAG_LEN) throw new Error('密文长度不足');
  const iv = sealed.subarray(0, IV_LEN);
  const tag = sealed.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const body = sealed.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/* ---------------- Windows DPAPI ---------------- */

const PS_PROTECT =
  "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;" +
  '$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());' +
  "$p=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser');" +
  '[Console]::Out.Write([Convert]::ToBase64String($p))';

const PS_UNPROTECT =
  "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;" +
  '$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());' +
  "$p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');" +
  '[Console]::Out.Write([Convert]::ToBase64String($p))';

function runPowershell(script, inputBase64, failure) {
  try {
    return execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      {
        input: inputBase64,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 20000,
        maxBuffer: 8 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'ignore'], // 丢弃 stderr：PowerShell 中文报错常是 GBK 乱码
      },
    ).trim();
  } catch {
    throw new Error(failure);
  }
}

let dpapiOk = null; // null=未探测，true/false=已知结果

function dpapiProtect(buf) {
  return Buffer.from(
    runPowershell(PS_PROTECT, buf.toString('base64'), '无法调用 Windows 加密服务'),
    'base64',
  );
}

function dpapiUnprotect(buf) {
  return Buffer.from(
    runPowershell(PS_UNPROTECT, buf.toString('base64'), '无法解开这份密文'),
    'base64',
  );
}

/** 加密：默认优先 DPAPI，不可用（非 Windows / 被策略拦）时退回本机指纹方案 */
function seal(obj, opts = {}) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const portable = !!opts.portable;
  const useDpapi = !portable && opts.dpapi !== false;

  if (useDpapi && dpapiOk !== false && process.platform === 'win32' && !process.env.BIOID_NO_DPAPI) {
    try {
      const packed = dpapiProtect(json);
      dpapiOk = true;
      return [PREFIX, 'dpapi', '-', packed.toString('base64')].join('.');
    } catch {
      dpapiOk = false;
      // 落到 dev，不中断流程
    }
  }

  const salt = crypto.randomBytes(16);
  const ikm = portable ? masterKey() : Buffer.concat([masterKey(), deviceSecret()]);
  const scope = portable ? 'portable' : 'device';
  const key = deriveKey(ikm, salt, scope);
  return [PREFIX, portable ? 'port' : 'dev', salt.toString('base64'), aesSeal(key, json).toString('base64')].join('.');
}

/** 解密：返回 { ok, value, kdf, error } */
function open(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, error: '内容为空' };
  }
  const body = text.trim();
  if (!body.startsWith(PREFIX + '.')) {
    return { ok: false, error: '不是本程序的密文格式' };
  }
  const parts = body.split('.');
  if (parts.length !== 4) return { ok: false, error: '密文结构损坏' };

  const kdf = parts[1];
  const saltB64 = parts[2];
  const dataB64 = parts[3];

  try {
    const data = Buffer.from(dataB64, 'base64');
    if (kdf === 'dpapi') {
      const plain = dpapiUnprotect(data);
      return { ok: true, kdf, value: JSON.parse(plain.toString('utf8')) };
    }
    const portable = kdf === 'port';
    if (!portable && kdf !== 'dev') return { ok: false, error: '未知的加密方式 ' + kdf };
    const ikm = portable ? masterKey() : Buffer.concat([masterKey(), deviceSecret()]);
    const key = deriveKey(ikm, Buffer.from(saltB64, 'base64'), portable ? 'portable' : 'device');
    return { ok: true, kdf, value: JSON.parse(aesOpen(key, data).toString('utf8')) };
  } catch (err) {
    // DPAPI 场景下最常见的原因是「文件来自别的电脑 / 别的用户账户」
    const hint =
      kdf === 'dpapi'
        ? '（只能在生成它的那台电脑、同一个 Windows 账户下解开）'
        : kdf === 'dev'
          ? '（与当前电脑或账户绑定，换机器后解不开）'
          : '';
    const msg = /authenticate|Unsupported state/i.test(err.message || '')
      ? '密文校验失败'
      : err.message || String(err);
    return { ok: false, kdf, error: msg + hint };
  }
}

module.exports = { seal, open, PREFIX, dpapiAvailable: () => dpapiOk !== false && process.platform === 'win32' };
