'use strict';

/**
 * 版本号与更新源。
 *
 * 源码运行：读环境变量 TAGDEN_VERSION / TAGDEN_UPDATE_URL，缺省为开发版。
 * 打包运行：build/bundle.js 会把 global.__APP_META__ 注入到产物最顶部。
 *
 * 更新源指向一个目录即可（例如 https://桶域名/tagden），程序自己拼 latest.json。
 */

const meta = (typeof global.__APP_META__ === 'object' && global.__APP_META__) || {};

/**
 * 源码运行时读 package.json 的版本号。
 * 以前这里缺省 '0.5.0-demo'，结果诊断包、更新提示里报的都是这个假版本，
 * 排查问题时反而被它误导（打出来的 exe 才是 meta.version，两边对不上）。
 */
function pkgVersion() {
  try {
    if (typeof __dirname !== 'string') return '';
    const file = require('node:path').join(__dirname, '..', 'package.json');
    return String(JSON.parse(require('node:fs').readFileSync(file, 'utf8')).version || '').trim();
  } catch {
    return '';
  }
}

const APP_VERSION = (process.env.TAGDEN_VERSION || meta.version || pkgVersion() || '0.5.0-demo').trim();

/**
 * 更新源：打包后由构建脚本写进 meta；源码运行时读项目根的 update.json。
 * 源码模式下也能「查更新」（只是装不了），这样改完打包前就能先验证一遍链路。
 */
function updateUrlFromFile() {
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const { APP_DIR, isSea } = require('./env');
    if (isSea) return '';
    const file = path.join(APP_DIR, 'update.json');
    return String(JSON.parse(fs.readFileSync(file, 'utf8')).url || '').trim();
  } catch {
    return '';
  }
}

const UPDATE_URL = (process.env.TAGDEN_UPDATE_URL || meta.updateUrl || updateUrlFromFile()).trim();

const APP_NAME = (meta.name || '物种标注工坊').trim();

module.exports = { APP_VERSION, UPDATE_URL, APP_NAME };
