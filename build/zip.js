'use strict';

/**
 * 极简 ZIP 写入器（不依赖任何第三方包）
 *
 * 之所以自己写：Windows 上自带的压缩工具会把文件的 Unix 权限位丢掉，
 * 解压到 macOS 后 `node` 和 `start.command` 就没有执行权限，双击打不开。
 * 这里显式写入 external attributes（mode << 16），并给中文文件名打上 UTF-8 标记。
 */

const zlib = require('node:zlib');

function dosTime(date) {
  const t =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((date.getSeconds() / 2) & 0x1f);
  const d =
    (((date.getFullYear() - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f);
  return { t, d };
}

/**
 * entries: [{ name, data?: Buffer|string, mode?: number(默认 0644), mtime?: Date }]
 * 目录用 name 结尾加 '/'，mode 传 0o40755
 */
function createZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const stamp = new Date();

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const isDir = entry.name.endsWith('/');
    const raw = isDir ? Buffer.alloc(0) : Buffer.from(entry.data ?? '');
    const mode = entry.mode ?? (isDir ? 0o40755 : 0o100644);
    const mtime = entry.mtime || stamp;
    const { t, d } = dosTime(mtime);

    const deflated = isDir ? raw : zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = !isDir && deflated.length < raw.length;
    const payload = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = isDir ? 0 : zlib.crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // bit 11: 文件名为 UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(t, 10);
    local.writeUInt16LE(d, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, name, payload);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(0x031e, 4); // 由 Unix 系统生成（3.0），解压时按 Unix 权限处理
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(t, 12);
    cd.writeUInt16LE(d, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(((mode & 0xffff) << 16) >>> 0, 38); // external attrs：权限位
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);

    offset += local.length + name.length + payload.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, eocd]);
}

module.exports = { createZip };
