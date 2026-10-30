'use strict';

/**
 * 从 .tar.gz 里取出单个文件（只支持普通文件，够用）
 *
 * 用途：从 node 官方 macOS 压缩包里取出 bin/node。
 * 之所以不用系统 tar：Windows 上的 GNU tar 会把 "C:\" 当成远程主机名，
 * 处理盘符路径时容易出错，自己解析反而更稳、且跨平台一致。
 */

const zlib = require('node:zlib');

function cstr(buf) {
  const end = buf.indexOf(0);
  return (end === -1 ? buf : buf.subarray(0, end)).toString('utf8');
}

function extractFile(tarGzBuffer, wantPath) {
  const tar = zlib.gunzipSync(tarGzBuffer);
  let off = 0;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    // 全零块 = 归档结束
    if (header.every((b) => b === 0)) break;

    const name = cstr(header.subarray(0, 100));
    const prefix = cstr(header.subarray(345, 500));
    const full = prefix ? `${prefix}/${name}` : name;
    const size = parseInt(cstr(header.subarray(124, 136)).trim() || '0', 8) || 0;
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);

    const dataStart = off + 512;
    if (full === wantPath && (type === '0' || type === '7')) {
      return tar.subarray(dataStart, dataStart + size);
    }
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

module.exports = { extractFile };
