'use strict';
/**
 * 标签索引缓存 —— 让「打开 2671 张的文件夹」不用每次都去读 2671 个文件头。
 *
 * 为什么要它：E 盘是 USB 机械盘，冷读一个文件头 ~30ms，2671 张就是 80 多秒。
 * 而「这文件标没标注」只看 (大小, 修改时间) 就能判断有没有变过，所以：
 *
 *   - 第一次打开：列表立刻返回（只 stat），标签在后台分窗口补；
 *   - 第二次打开：命中缓存，一个文件都不读；
 *   - 外部工具改过某张（mtime 变了）：只有那一张会重读。
 *
 * 存在 data/cache/labels/<目录哈希>.json，形如
 *   { "v":1, "dir":"E:\\...", "files": { "441A7676.JPG": [size, mtime, 0|1, "标题", ["关键词"], 方向] } }
 * 用数组而不是对象，2671 条约 200KB，读一次几毫秒。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let cacheRoot = null;
const mem = new Map(); // dir -> { NAME: [size, mtime, labeled, title, keys, orient] }
const saving = new Map(); // dir -> timer

function init(dir) {
  cacheRoot = dir;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
}

function fileOf(dir) {
  const h = crypto.createHash('sha1').update(dir).digest('hex').slice(0, 16);
  return path.join(cacheRoot, `${h}.json`);
}

function load(dir) {
  let m = mem.get(dir);
  if (m) return m;
  m = {};
  try {
    const j = JSON.parse(fs.readFileSync(fileOf(dir), 'utf8'));
    if (j && j.files && typeof j.files === 'object') m = j.files;
  } catch {
    /* 没有缓存或缓存坏了都当空的，重扫一遍就好 */
  }
  mem.set(dir, m);
  return m;
}

/** 取一条缓存记录；没有就返回 null */
function get(dir, name) {
  return load(dir)[name] || null;
}

/** 缓存是否对得上这个文件（大小 + 修改时间都没变） */
function fresh(rec, st) {
  return !!rec && rec[0] === st.size && Math.abs(rec[1] - st.mtimeMs) < 1;
}

function set(dir, name, rec) {
  load(dir)[name] = rec;
  scheduleSave(dir);
}

/** 从 readLabelFast 的结果生成一条记录 */
function pack(st, label) {
  return [
    st.size,
    st.mtimeMs,
    label && label.has ? 1 : 0,
    (label && label.title) || '',
    ((label && label.keywords) || []).slice(0, 8),
    (label && label.orient) || 1,
  ];
}

/** 把记录还原成前端用的字段 */
function unpack(rec) {
  return {
    labeled: !!rec[2],
    labelTitle: rec[3] || '',
    labelKeywords: rec[4] || [],
    orient: rec[5] || 1,
  };
}

function scheduleSave(dir) {
  if (saving.has(dir)) return;
  saving.set(
    dir,
    setTimeout(() => {
      saving.delete(dir);
      save(dir);
    }, 1500)
  );
  if (saving.get(dir).unref) saving.get(dir).unref();
}

function save(dir) {
  if (!cacheRoot) return;
  const body = JSON.stringify({ v: 1, dir, at: verified.get(dir) || 0, files: load(dir) });
  const file = fileOf(dir);
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
  } catch {
    /* 缓存写不进去不影响功能，下次重扫而已 */
  }
}

/* ---------------- 校验时间戳 ---------------- */

const verified = new Map(); // dir -> 上次核对（stat 全目录）的时间

/** 这个目录上次核对是什么时候（毫秒时间戳）；没记录就返回 0 */
function verifiedAt(dir) {
  if (verified.has(dir)) return verified.get(dir);
  try {
    const j = JSON.parse(fs.readFileSync(fileOf(dir), 'utf8'));
    const at = Number(j.at) || 0;
    verified.set(dir, at);
    return at;
  } catch {
    verified.set(dir, 0);
    return 0;
  }
}

function markVerified(dir) {
  verified.set(dir, Date.now());
  scheduleSave(dir);
}

/** 进程退出前把没落盘的攒批写掉 */
function flushAll() {
  for (const [dir, t] of saving) {
    clearTimeout(t);
    saving.delete(dir);
    save(dir);
  }
}

/** 丢掉某个文件（改名/归档后用） */
function drop(dir, name) {
  delete load(dir)[name];
  scheduleSave(dir);
}

module.exports = { init, get, set, pack, unpack, fresh, drop, save, flushAll, verifiedAt, markVerified };
