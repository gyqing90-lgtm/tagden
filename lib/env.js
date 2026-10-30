'use strict';

/**
 * 路径解析：源码运行、单文件 exe、mac 目录版三种形态都从这儿拿目录。
 *
 * 一条规矩：**配置永远跟着程序走**（便携优先），走不通才退回用户目录。
 * 所以 exe 放在 tagden 目录里，用的就是你原来那套 data（账号不用重填）；
 * 拷到别的机器上，会在同目录新建一个 data。
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const secure = require('./secure.js');
const { resolveDataDir } = require('./datadir.js');

/** 是否运行在打包后的单文件 exe 里 */
function detectSea() {
  try {
    const sea = require('node:sea');
    return typeof sea.isSea === 'function' ? sea.isSea() : false;
  } catch {
    return false;
  }
}

const isSea = detectSea();

/**
 * macOS 目录版：node 运行时原样不动（官方签名有效），程序是 <根目录>/app/main.js，
 * 由同目录的 start.command 调起来。判定看启动脚本的路径就够了，
 * 源码运行（node server.js）不会命中。
 */
const MAIN_SCRIPT = process.argv[1] || '';
const isAppBundle = !isSea && /[\\/]app[\\/]main\.js$/.test(MAIN_SCRIPT);

// 源码运行时是项目根目录；exe / 目录版运行时是程序所在目录
const APP_DIR = isSea
  ? path.dirname(process.execPath)
  : isAppBundle
    ? path.dirname(path.dirname(MAIN_SCRIPT))
    : path.join(__dirname, '..');

// 程序本体（可执行文件或 main.js）所在的目录
const PROGRAM_DIR = isSea ? APP_DIR : isAppBundle ? path.dirname(MAIN_SCRIPT) : APP_DIR;

// 自动更新要替换的那个文件：exe 是自身路径，mac 目录版是 app/main.js
const APP_MAIN = isAppBundle ? MAIN_SCRIPT : '';

/**
 * 配置与登录缓存：TAGDEN_DATA > 程序同级 data > 自己的专属目录 > 用户目录 > 临时目录。
 *
 * 同目录的 data 若已被另一个软件（聚合台）占用，就改用 data-tagden ——
 * 否则两个便携版 exe 放在一起时，会共用一份配置、互相把端口带跑（见 lib/datadir.js）。
 */
const resolved = resolveDataDir({
  appId: 'tagden',
  appDir: APP_DIR,
  override: process.env.TAGDEN_DATA,
  secure,
});

const DATA_DIR = resolved.dir;
const DATA_NOTE = resolved.note;
const PUBLIC_DIR = path.join(APP_DIR, 'public');

module.exports = {
  isSea,
  isAppBundle,
  APP_MAIN,
  APP_DIR,
  PROGRAM_DIR,
  DATA_DIR,
  DATA_NOTE,
  PUBLIC_DIR,
};

