'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { MODULES, ASSETS, BIN_ASSETS } = require('../build/bundle');

const ROOT = path.resolve(__dirname, '..');

test('打包清单里的模块文件都存在', (t) => {
  // lib/seed.js 是 .gitignore 里的凭据文件：git 克隆出来的源码树没有它。
  // 没有它本来也跑不了服务，但纯模块测试不该因此全红，这里跳过。
  if (!fs.existsSync(path.join(ROOT, 'lib/seed.js'))) {
    t.skip('没有 lib/seed.js（git 忽略的凭据文件），跳过打包清单检查');
    return;
  }
  // 交接说明坑⑤：漏列一个 lib/*.js，源码能跑、exe 报「模块未打包」。
  // 这里不真正构建（避免把 seed 读进测试进程），只校验清单和磁盘一致。
  for (const rel of MODULES) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `缺少模块：${rel}`);
  }
});

test('内联的网页资源都在 public/ 下', () => {
  for (const name of [...ASSETS, ...BIN_ASSETS]) {
    assert.ok(fs.existsSync(path.join(ROOT, 'public', name)), `缺少资源：public/${name}`);
  }
});
