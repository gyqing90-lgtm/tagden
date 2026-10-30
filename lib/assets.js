'use strict';

/**
 * 前端静态文件的统一入口。
 *
 * 源码运行：从 public/ 目录读。
 * 打包成 exe 后：public/ 已经内联进二进制（构建时塞进 global.__EMBEDDED__），从内存取。
 *
 * 这么做的原因不只是「单文件好看」：exe 旁边如果散着一堆 public/*.js，
 * 用户随手改一个字节，界面就和程序对不上了，排查问题时会怀疑人生。
 */

const fs = require('node:fs');
const path = require('node:path');
const { PUBLIC_DIR } = require('./env');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

/** 打包时由 build/bundle.js 注入，源码运行时为空 */
function embedded() {
  return global.__EMBEDDED__ || null;
}

/** 二进制资源（base64 内联的那几个），同样由打包时注入 */
function embeddedBin() {
  return global.__EMBEDDED_BIN__ || null;
}

/**
 * 取一个静态文件。返回 { body, mime } 或 null（不存在 / 越界）。
 */
function get(relPath) {
  const clean = String(relPath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  if (clean.includes('..')) return null;

  const mime = MIME[path.extname(clean).toLowerCase()] || 'application/octet-stream';

  const mem = embedded();
  if (mem) {
    // 打包模式下只认内联资源，不再回落到磁盘 —— 否则「改了 public 却没生效」会很难查
    if (typeof mem[clean] === 'string') return { body: Buffer.from(mem[clean], 'utf8'), mime };
    // 图片走另一张 base64 表，当 utf8 解会把图弄坏
    const bin = embeddedBin();
    if (bin && typeof bin[clean] === 'string') return { body: Buffer.from(bin[clean], 'base64'), mime };
    return null;
  }

  const file = path.join(PUBLIC_DIR, clean);
  const rootAbs = path.resolve(PUBLIC_DIR);
  if (!path.resolve(file).startsWith(rootAbs)) return null;
  try {
    if (!fs.statSync(file).isFile()) return null;
  } catch {
    return null;
  }
  return {
    body: fs.readFileSync(file),
    mime,
  };
}

module.exports = { get };
