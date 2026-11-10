#!/usr/bin/env node
'use strict';

/**
 * 全量语法检查：递归找 .js，逐个跑 `node --check`。
 *
 * 为什么不用 `node --check server.js`：服务端模块是分开 require 的，
 * 只查入口会漏掉 lib/ 和 public/ 里的语法错。构建前的回归第一步就跑这个。
 *
 *   node tools/check-syntax.js
 *   npm run check
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SKIP = new Set([
  '.git',
  '.build-tools',
  '.cache',
  'node_modules',
  'dist',
  'dist-mac',
  'release-mac',
  'vendor',
  'data',
  'data-tagden',
]);

const files = [];
(function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP.has(e.name)) walk(full);
    } else if (e.isFile() && e.name.endsWith('.js')) {
      files.push(full);
    }
  }
})(ROOT);

let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    failed += 1;
    const rel = path.relative(ROOT, file);
    const detail = String(err.stderr || err.message || '').trim();
    console.error(`✗ ${rel}\n${detail}\n`);
  }
}

if (failed) {
  console.error(`语法检查失败：${failed} / ${files.length} 个文件`);
  process.exitCode = 1;
} else {
  console.log(`语法检查通过：${files.length} 个 .js 文件`);
}
