'use strict';

/**
 * Windows exe 的增量补丁：内容定义分块（CDC）+ 复制/新增指令。
 *
 * 为什么不用整包：exe 约 110 MB，但相邻版本真正变的主要是内联的 main.js/资源；
 * 用固定块对齐会被 PE 段位移带偏，所以按内容切块（gear hash），未变的段无论
 * 偏移多少都能按 SHA-256 匹配回来。实测 0.6.23 → 0.6.24 的补丁只有约 0.24 MB。
 *
 * 补丁格式：
 *   'TGDP1' + zlib( 4 字节 header 长度 + JSON header + 指令流 )
 *   header = { v, oldSize, newSize, oldSha256, newSha256, ops }
 *   指令：0x01 COPY(offset u32, len u32) / 0x00 ADD(len u32, bytes)
 *
 * 安全：应用前校验旧文件 SHA-256，应用后校验新文件 SHA-256；补丁本身的
 * SHA-256 由已签名的更新清单约束。任何一步不匹配都抛错，调用方回退完整包。
 */

const crypto = require('node:crypto');
const zlib = require('node:zlib');

const MAGIC = Buffer.from('TGDP1', 'ascii');
const CHUNK_MIN = 2048;
const CHUNK_MAX = 64 * 1024;
const CHUNK_MASK = (1 << 13) - 1; // 平均 8 KB 一块

/** 确定性 gear 表：同一个字节序列在任何机器上切出同样的块 */
const GEAR = (() => {
  const table = new Uint32Array(256);
  let seed = 0x9e3779b9;
  for (let i = 0; i < 256; i += 1) {
    seed ^= seed << 13;
    seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    table[i] = seed >>> 0;
  }
  return table;
})();

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 返回 [{off, len}]，块边界只由内容决定 */
function chunkBounds(buf) {
  const out = [];
  if (!buf || !buf.length) return out;
  let start = 0;
  let hash = 0;
  for (let i = 0; i < buf.length; i += 1) {
    hash = ((hash << 1) + GEAR[buf[i]]) >>> 0;
    const len = i - start + 1;
    if (len >= CHUNK_MIN && ((hash & CHUNK_MASK) === 0 || len >= CHUNK_MAX)) {
      out.push({ off: start, len });
      start = i + 1;
      hash = 0;
    }
  }
  if (start < buf.length) out.push({ off: start, len: buf.length - start });
  return out;
}

/**
 * 生成补丁。
 * @param {Buffer} oldBuf 老 exe
 * @param {Buffer} newBuf 新 exe
 * @returns {Buffer}
 */
function createPatch(oldBuf, newBuf) {
  if (!Buffer.isBuffer(oldBuf) || !Buffer.isBuffer(newBuf)) throw new Error('增量补丁需要两个 Buffer');
  if (!oldBuf.length || !newBuf.length) throw new Error('增量补丁的输入不能为空');

  const oldIndex = new Map();
  for (const c of chunkBounds(oldBuf)) {
    const key = sha256(oldBuf.subarray(c.off, c.off + c.len));
    if (!oldIndex.has(key)) oldIndex.set(key, c.off);
  }

  const ops = [];
  for (const c of chunkBounds(newBuf)) {
    const key = sha256(newBuf.subarray(c.off, c.off + c.len));
    const off = oldIndex.get(key);
    if (off === undefined) ops.push({ type: 0, off: c.off, len: c.len });
    else ops.push({ type: 1, off, len: c.len });
  }

  const header = {
    v: 1,
    oldSize: oldBuf.length,
    newSize: newBuf.length,
    oldSha256: sha256(oldBuf),
    newSha256: sha256(newBuf),
    ops: ops.length,
  };
  const head = Buffer.from(JSON.stringify(header), 'utf8');
  const parts = [Buffer.alloc(4), head];
  parts[0].writeUInt32LE(head.length, 0);
  for (const op of ops) {
    if (op.type === 1) {
      const b = Buffer.alloc(9);
      b.writeUInt8(1, 0);
      b.writeUInt32LE(op.off, 1);
      b.writeUInt32LE(op.len, 5);
      parts.push(b);
    } else {
      const b = Buffer.alloc(5);
      b.writeUInt8(0, 0);
      b.writeUInt32LE(op.len, 1);
      parts.push(b, newBuf.subarray(op.off, op.off + op.len));
    }
  }
  const raw = Buffer.concat(parts);
  return Buffer.concat([MAGIC, zlib.deflateSync(raw, { level: 9 })]);
}

/**
 * 应用补丁；旧文件或结果对不上都会抛错。
 * @param {Buffer} oldBuf 当前 exe
 * @param {Buffer} patchBuf 补丁
 * @returns {Buffer} 新 exe
 */
function applyPatch(oldBuf, patchBuf) {
  if (!Buffer.isBuffer(oldBuf) || !Buffer.isBuffer(patchBuf)) throw new Error('增量补丁需要两个 Buffer');
  if (patchBuf.length < MAGIC.length + 4 || !patchBuf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('不是本程序的增量补丁');
  }
  // maxOutputLength 防解压炸弹；上限按旧文件 2 倍 + 64 MB（头/指令开销）
  const raw = zlib.inflateSync(patchBuf.subarray(MAGIC.length), {
    maxOutputLength: Math.max(16 * 1024 * 1024, oldBuf.length * 2 + 64 * 1024 * 1024),
  });
  if (raw.length < 4) throw new Error('补丁头部不完整');
  const headLen = raw.readUInt32LE(0);
  if (headLen <= 0 || 4 + headLen > raw.length) throw new Error('补丁头部损坏');
  let head;
  try {
    head = JSON.parse(raw.subarray(4, 4 + headLen).toString('utf8'));
  } catch {
    throw new Error('补丁头部不是合法 JSON');
  }
  if (!head || head.v !== 1) throw new Error('不支持的补丁版本');
  if (head.oldSize !== oldBuf.length) throw new Error('当前程序大小和补丁不匹配');
  if (sha256(oldBuf) !== head.oldSha256) throw new Error('当前程序内容和补丁不匹配');

  const out = Buffer.alloc(head.newSize);
  let p = 4 + headLen;
  let w = 0;
  for (let i = 0; i < head.ops; i += 1) {
    if (p >= raw.length) throw new Error('补丁指令流被截断');
    const type = raw[p];
    p += 1;
    if (type === 1) {
      if (p + 8 > raw.length) throw new Error('补丁 COPY 指令被截断');
      const off = raw.readUInt32LE(p);
      const len = raw.readUInt32LE(p + 4);
      p += 8;
      if (off + len > oldBuf.length || w + len > out.length) throw new Error('补丁 COPY 越界');
      oldBuf.copy(out, w, off, off + len);
      w += len;
    } else if (type === 0) {
      if (p + 4 > raw.length) throw new Error('补丁 ADD 指令被截断');
      const len = raw.readUInt32LE(p);
      p += 4;
      if (p + len > raw.length || w + len > out.length) throw new Error('补丁 ADD 越界');
      raw.copy(out, w, p, p + len);
      p += len;
      w += len;
    } else {
      throw new Error('未知的补丁指令');
    }
  }
  if (w !== out.length || p !== raw.length) throw new Error('补丁指令流长度不匹配');
  if (sha256(out) !== head.newSha256) throw new Error('补丁结果校验失败');
  return out;
}

module.exports = { createPatch, applyPatch, chunkBounds, MAGIC, CHUNK_MIN, CHUNK_MAX };
