'use strict';

/**
 * 配置目录归属。
 *
 * 两个软件（物种鉴定聚合台 / 物种标注工坊）都是「便携」的：配置写在程序同级的
 * data 目录。可用户很可能把两个 exe 一起丢在桌面或下载文件夹里，于是两边共用
 * 一份 data —— 后启动的会读到前一个的 config.json（连端口一起读走，结果两个
 * 软件抢同一个端口），落盘时还会把对方的字段整个覆盖掉。
 *
 * 所以给目录插一个归属标记 data/.app：
 *   - 标记是自己 → 继续用自己的 data（老用户不受影响）
 *   - 标记是别人 → 改用 data-<自己的 id>，两边互不打扰
 *   - 没有标记（老版本留下的）→ 看 config.json 的结构猜主人，猜不出来就谁先来归谁
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const MARK = '.app';

function ensureWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function readMark(dir) {
  try {
    return fs.readFileSync(path.join(dir, MARK), 'utf8').trim();
  } catch {
    return '';
  }
}

function writeMark(dir, id) {
  try {
    fs.writeFileSync(path.join(dir, MARK), id + '\n', 'utf8');
  } catch {
    /* 写不进去也不影响使用，下次再试 */
  }
}

/**
 * 老版本没有标记文件，只能看 config.json 的结构猜主人：
 * 聚合台独有 deepseek 段，标注工坊独有 ui / sessions 段。
 * 认不出来（空目录、解密失败、换了电脑）就当空目录处理，谁先来归谁。
 */
function sniffOwner(dir, secure) {
  let raw = '';
  try {
    raw = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
  } catch {
    return '';
  }
  let value = null;
  try {
    const opened = secure && secure.open ? secure.open(raw) : null;
    value = opened && opened.ok ? opened.value : JSON.parse(raw);
  } catch {
    try {
      value = JSON.parse(raw);
    } catch {
      value = null;
    }
  }
  if (!value || typeof value !== 'object') return '';
  if (value.deepseek) return 'bio-id-hub';
  if (value.ui || value.sessions) return 'tagden';
  return '';
}

/** 这个 data 目录能不能归自己用 */
function claimable(dir, appId, secure) {
  if (!ensureWritable(dir)) return false;
  const mark = readMark(dir);
  if (mark) return mark === appId;
  const owner = sniffOwner(dir, secure);
  return !owner || owner === appId;
}

/**
 * 决定配置目录。
 *
 * @param {object} o
 * @param {string} o.appId       本程序的标识（bio-id-hub / tagden）
 * @param {string} o.appDir      程序所在目录
 * @param {string} [o.override]  环境变量指定的目录（调试/绿色版用），优先级最高
 * @param {object} o.secure      本程序的 secure 模块（用来解老配置、猜主人）
 * @param {string} [o.home]      用户目录（测试用）
 * @returns {{ dir: string, note: string }}
 */
function resolveDataDir({ appId, appDir, override, secure, home }) {
  if (override) {
    ensureWritable(override);
    return { dir: override, note: '' };
  }

  const shared = path.join(appDir, 'data');
  const own = path.join(appDir, `data-${appId}`);

  if (claimable(shared, appId, secure)) {
    writeMark(shared, appId);
    return { dir: shared, note: '' };
  }

  // 同一个文件夹里还放着另一个软件 —— 各用各的目录
  if (ensureWritable(own)) {
    writeMark(own, appId);
    return { dir: own, note: `同目录的 data 属于另一个软件，本程序改用 ${path.basename(own)}` };
  }

  // 程序目录本身写不了（Program Files、只读 U 盘）—— 退回用户目录
  for (const dir of [path.join(home || os.homedir(), `.${appId}`, 'data'), path.join(os.tmpdir(), appId)]) {
    if (ensureWritable(dir)) return { dir, note: `程序目录不可写，配置改放到 ${dir}` };
  }
  return { dir: os.tmpdir(), note: '只能用临时目录保存配置，重启后可能要重新填写' };
}

module.exports = { resolveDataDir, MARK };
