'use strict';
/**
 * taxo-fetch.js — 「把本地物种名录（Chinese-Latin）弄到本机」这件事的落地实现。
 *
 * 背景：归档/统计默认走本地名录（backbone_中文.sqlite，774 万行），但名录是用户
 * 另外分享的 2.6 GB 数据，别人拿到程序时本机往往没有。没有名录时归档会逐张联网
 * 查 iNat/GBIF —— 几千张就是几十分钟，断网还会全掉进「未分类」。
 *
 * 所以走这条链路：
 *   ① 界面点「从百度网盘下载」→ 后端记下当前下载目录里的文件快照，进入「等待」；
 *   ② 同时在浏览器里打开分享页（百度的大文件必须登录/客户端才能下，没有公开直链）；
 *   ③ 用户下完（百度客户端默认落在 ~/Downloads/BaiduNetdiskDownload），
 *      这边每 2 秒扫一次下载目录，发现「名字像名录、大小连续 4 秒没变」的新文件；
 *   ④ 是 zip/7z/rar 就解压，是文件夹就直接用，找到 backbone 数据库后交给
 *      LOCAL_TAXO.init() 注册 —— 界面随即变成「已接入」，可以立刻归档。
 *
 * 不做的事：不碰用户的其它文件（只认名字像名录的条目），不删除源文件，
 * 解压失败/没有解压工具都给出人话提示，绝不让归档流程崩掉。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

/** 用户分享的百度网盘链接（提取码已带上，点开就能保存/下载） */
const BAIDU = {
  href: 'https://pan.baidu.com/s/1USs8WsrECEt64Nk8VxW9KQ?pwd=591g',
  pwd: '591g',
  label: 'Chinese-Latin',
  size: '约 2.6 GB',
};

/** 数据库候选文件名，和 lib/local-taxo.js 保持一致 */
const DB_NAMES = ['backbone_中文.sqlite', 'backbone.sqlite', 'backbone_cn.sqlite'];
/** 认得出的压缩包 */
const ARCHIVE_EXT = new Set(['.zip', '.7z', '.rar', '.tar', '.gz', '.tgz']);
/** 还在下载中的临时后缀：百度客户端是 .baiduyun.downloading */
const TEMP_SUFFIX = /(\.part|\.partial|\.download|\.crdownload|\.baiduyun\.downloading|\.!ut|\.tmp)$/i;
/** 名字里带这些词的才算「名录」，避免把用户随手下的其它大文件当成名录 */
const NAME_HINT = /(chinese[\s_-]*latin|backbone|species[\s_-]*list|物种名录|名录)/i;
/** 稳定判定：连续几次扫描大小不变才动手（2 秒一次 → 约 4 秒） */
const STABLE_TICKS = 2;
/** 名录文件最小体积，太小的肯定不对（2.6 GB 的库，压缩后也远超这个数）；测试里可调小 */
const MIN_BYTES = Number(process.env.TAGDEN_TAXO_MIN_BYTES) || 50 * 1024 * 1024;
/** 等待上限：一小时还没下完就停，别一直占着定时器 */
const MAX_WAIT_MS = 60 * 60 * 1000;
const TICK_MS = 2000;

let storeRoot = '';
let storeReady = false;
let onInstalled = null;

/** 对外的状态。前端轮询它来画进度。 */
const ST = {
  watching: false,
  phase: 'idle', // idle | waiting | extract | done | error
  file: '',
  got: 0,
  msg: '',
  dir: '',
  error: '',
  startedAt: 0,
  finishedAt: 0,
};

let timer = null;
let ticker = null;
let busy = false;
/** 点「下载」那一刻已经存在的条目 → 不自动导入，只在界面上列出来让用户点 */
let baseline = new Map();
/** path → { size, ticks } 用来判「大小稳住了」 */
let seen = new Map();

/* ---------------- 目录 ---------------- */

/**
 * 装到哪儿：本机的应用数据目录，**不放进程序目录**。
 * 程序可能在 OneDrive 里（用户那份就是），2.6 GB 数据库同步上云既慢又占配额。
 */
function defaultStoreDir() {
  if (process.env.TAGDEN_TAXO_DIR) return path.resolve(process.env.TAGDEN_TAXO_DIR);
  const home = os.homedir();
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return path.join(base, 'tagden', 'Chinese-Latin');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'tagden', 'Chinese-Latin');
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'tagden', 'Chinese-Latin');
}

/**
 * 可能落下载文件的地方。百度网盘客户端默认建 ~/Downloads/BaiduNetdiskDownload，
 * Windows 上还常见 %USERPROFILE%\BaiduNetdiskDownload。
 */
function downloadDirs() {
  const home = os.homedir();
  const out = [
    path.join(home, 'Downloads'),
    path.join(home, 'Downloads', 'BaiduNetdiskDownload'),
    path.join(home, 'Desktop'),
    path.join(home, 'Documents'),
  ];
  if (process.platform === 'win32') {
    out.push(path.join(home, 'BaiduNetdiskDownload'));
    if (process.env.USERPROFILE) {
      out.push(path.join(process.env.USERPROFILE, 'Downloads'));
      out.push(path.join(process.env.USERPROFILE, 'Downloads', 'BaiduNetdiskDownload'));
    }
  }
  // 去重 + 只留真实存在的
  const uniq = [];
  for (const d of out) {
    if (!d || uniq.includes(d)) continue;
    try {
      if (fs.statSync(d).isDirectory()) uniq.push(d);
    } catch {}
  }
  return uniq;
}

function fileSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

/** 在目录里（最多往下 3 层）找 backbone 数据库，返回文件路径 */
function findDbDeep(dir, depth = 3) {
  let st;
  try {
    st = fs.statSync(dir);
  } catch {
    return '';
  }
  if (st.isFile()) {
    const base = path.basename(dir).toLowerCase();
    if (DB_NAMES.some((n) => n.toLowerCase() === base) || /\.sqlite$/i.test(base)) return dir;
    return '';
  }
  if (!st.isDirectory() || depth < 0) return '';
  for (const name of DB_NAMES) {
    const p = path.join(dir, name);
    if (fileSize(p) > 0) return p;
  }
  let ents = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return '';
  }
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.') || /^(__MACOSX|System Volume Information)$/i.test(e.name)) continue;
    const p = findDbDeep(path.join(dir, e.name), depth - 1);
    if (p) return p;
  }
  return '';
}

/* ---------------- 识别候选 ---------------- */

function looksLikeName(name) {
  const n = String(name || '');
  if (!n || n.startsWith('.')) return false;
  if (TEMP_SUFFIX.test(n)) return false;
  return NAME_HINT.test(n.replace(/\.[^.]+$/, ''));
}

/** 一个条目的「体积」：文件取文件大小，文件夹取里面数据库的大小（没库就是 0） */
function entrySize(p) {
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    return 0;
  }
  if (st.isFile()) return st.size;
  const db = findDbDeep(p, 3);
  return db ? fileSize(db) : 0;
}

/**
 * 扫一遍下载目录，返回「看起来是名录」的条目。
 * 只看第一层（+ 百度客户端那个子目录），不做全盘搜索 —— 快，也不会误伤。
 * roots 只在测试里传，正常走 downloadDirs()。
 */
function scan(roots) {
  const out = [];
  for (const root of roots || downloadDirs()) {
    let ents = [];
    try {
      ents = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (!e.isDirectory() && !e.isFile()) continue;
      if (!looksLikeName(e.name)) continue;
      const full = path.join(root, e.name);
      const ext = path.extname(e.name).toLowerCase();
      let kind = 'folder';
      if (e.isFile()) kind = ext === '.sqlite' || ext === '.db' ? 'db' : ARCHIVE_EXT.has(ext) ? 'archive' : 'file';
      const size = entrySize(full);
      if (size && size < MIN_BYTES && kind !== 'db') continue;
      let mtime = 0;
      try {
        mtime = fs.statSync(full).mtimeMs;
      } catch {}
      out.push({ path: full, name: e.name, kind, size, mtime, dir: root });
    }
  }
  // 同样名字的多份（比如下过两次），按修改时间新的在前
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/* ---------------- 解压 ---------------- */

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    let err = '';
    let p;
    try {
      p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    } catch (e) {
      reject(e);
      return;
    }
    p.on('error', reject);
    p.stderr.on('data', (b) => {
      err = (err + b.toString('utf8')).slice(-4000);
    });
    p.on('close', (code) => resolve({ code, err }));
  });
}

/** 依次尝试几种解压命令，前一个不存在/失败就换下一个 */
async function extract(file, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const ext = path.extname(file).toLowerCase();
  const plan = [];
  if (ext === '.zip') {
    if (process.platform === 'darwin') plan.push(['/usr/bin/ditto', ['-x', '-k', file, dest]]);
    if (process.platform === 'win32') plan.push(['tar', ['-xf', file, '-C', dest]]);
    plan.push(['unzip', ['-o', '-q', file, '-d', dest]]);
    plan.push(['7z', ['x', '-y', `-o${dest}`, file]]);
  } else {
    plan.push(['7z', ['x', '-y', `-o${dest}`, file]]);
    plan.push(['7zz', ['x', '-y', `-o${dest}`, file]]);
    plan.push(['unar', ['-o', dest, '-f', file]]);
    plan.push(['bsdtar', ['-xf', file, '-C', dest]]);
    plan.push(['tar', ['-xf', file, '-C', dest]]);
  }
  let lastErr = '';
  for (const [cmd, args] of plan) {
    try {
      const r = await run(cmd, args);
      if (r.code === 0) return;
      lastErr = String(r.err || '').trim();
      // 「找不到命令」这类直接换下一个；真正解压报错也换，最后统一抛
    } catch (e) {
      lastErr = e && e.code === 'ENOENT' ? `${cmd} 没装` : String(e && e.message ? e.message : e);
    }
  }
  const extName = ext.replace('.', '').toUpperCase() || '压缩包';
  throw new Error(
    `解不开这个 ${extName}：${lastErr || '没有可用的解压工具'}。`
      + '可以先手动解压，再把里面的 Chinese-Latin 文件夹用「选择…」指过来。',
  );
}

/** 解压过程中的进度：解压到目标目录后，目录整体大小会一路往上走 */
function dirSize(dir, depth = 6) {
  if (depth < 0) return 0;
  let total = 0;
  let ents = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(p, depth - 1);
    else if (e.isFile()) total += fileSize(p);
  }
  return total;
}

/* ---------------- 安装 ---------------- */

function finish(dir) {
  ST.phase = 'done';
  ST.dir = dir;
  ST.error = '';
  ST.watching = false;
  ST.finishedAt = Date.now();
  stopTimers();
  if (typeof onInstalled === 'function') {
    try {
      onInstalled(dir);
    } catch {}
  }
}

function fail(msg) {
  ST.phase = 'error';
  ST.error = msg;
  ST.watching = false;
  ST.finishedAt = Date.now();
  stopTimers();
}

/**
 * 把下载目录里的名录文件夹收进「名录目录」，免得用户清空下载文件夹时把它一起删了。
 * 同卷 rename 是瞬间完成、不占双份空间；跨卷/没权限就原样留着（能用比好看重要）。
 * 只有在 init() 指定过落地目录时才动手 —— 单测里不乱搬用户的文件。
 */
function settleFolder(dir) {
  const src = path.resolve(dir);
  if (!storeReady) return src;
  storeRoot = storeRoot || defaultStoreDir();
  const root = path.resolve(storeRoot);
  if (src === root || src.startsWith(root + path.sep)) return src;
  const dbHere = (d) => {
    const db = findDbDeep(d, 4);
    return db ? path.dirname(db) : d;
  };
  try {
    if (!fs.existsSync(root)) {
      fs.mkdirSync(path.dirname(root), { recursive: true });
      fs.renameSync(src, root); // 目标不存在时可以直接改名过去
      return dbHere(root);
    }
    const dest = path.join(root, path.basename(src));
    if (!fs.existsSync(dest)) {
      fs.renameSync(src, dest);
      return dbHere(dest);
    }
  } catch {
    /* 跨卷、只读、被占用：留在原地 */
  }
  return src;
}

/**
 * 装一个下载下来的东西：文件夹 / 数据库文件 / 压缩包。
 * 成功返回 { ok:true, dir }，失败返回 { ok:false, error }（不抛，界面直接显示）。
 */
async function install(src) {
  const p = path.resolve(String(src || ''));
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    return { ok: false, error: '找不到这个路径：' + p };
  }

  // ① 已经是数据库文件：直接注册（不复制 2.6 GB）
  if (st.isFile() && /\.(sqlite|db)$/i.test(p)) {
    if (st.size < 1024) return { ok: false, error: '这个数据库文件是空的' };
    finish(p);
    return { ok: true, dir: p };
  }

  // ② 文件夹：里面找数据库，顺手收进名录目录
  if (st.isDirectory()) {
    const db = findDbDeep(p, 3);
    if (!db) {
      return { ok: false, error: '这个文件夹里没找到 backbone 数据库（backbone_中文.sqlite）' };
    }
    const kept = settleFolder(path.dirname(db));
    finish(kept);
    return { ok: true, dir: kept };
  }

  // ③ 压缩包：解压到名录目录，再找库
  const ext = path.extname(p).toLowerCase();
  if (!ARCHIVE_EXT.has(ext)) {
    return { ok: false, error: '只认文件夹、.sqlite 数据库和 zip/7z/rar 压缩包' };
  }
  storeRoot = storeRoot || defaultStoreDir();
  storeReady = true;
  ST.phase = 'extract';
  ST.file = p;
  ST.got = 0;
  ST.msg = `正在解压 ${path.basename(p)}…`;
  ticker = setInterval(() => {
    const n = dirSize(storeRoot);
    if (n > ST.got) ST.got = n; // 只增不减：解压过程中目录里可能先出现再删掉的临时文件
  }, 600);
  if (ticker.unref) ticker.unref();
  try {
    await extract(p, storeRoot);
  } catch (err) {
    clearInterval(ticker);
    ticker = null;
    fail(String(err && err.message ? err.message : err));
    return { ok: false, error: ST.error };
  }
  clearInterval(ticker);
  ticker = null;
  ST.got = dirSize(storeRoot);
  const db = findDbDeep(storeRoot, 4);
  if (!db) {
    fail('解压完了，但里面没找到 backbone_中文.sqlite（可能不是这份名录）');
    return { ok: false, error: ST.error };
  }
  finish(path.dirname(db));
  return { ok: true, dir: path.dirname(db) };
}

/* ---------------- 等待下载 ---------------- */

function stopTimers() {
  if (timer) clearInterval(timer);
  timer = null;
}

async function tick() {
  if (busy || !ST.watching) return;
  if (Date.now() - ST.startedAt > MAX_WAIT_MS) {
    fail('等了一小时还没看到下载好的名录。下完之后点「已有文件，导入…」手动选一下也行。');
    return;
  }
  const list = scan();
  // 更新稳定计数
  for (const it of list) {
    const prev = seen.get(it.path);
    if (!prev || prev.size !== it.size) seen.set(it.path, { size: it.size, ticks: 1 });
    else prev.ticks += 1;
  }
  for (const it of list) {
    const s = seen.get(it.path) || { size: 0, ticks: 0 };
    if (s.ticks < STABLE_TICKS) continue; // 还在写入
    if (s.size && s.size < MIN_BYTES) continue;
    const base = baseline.get(it.path);
    // 点下载之前就存在的：不自动导入（可能是旧文件/半截文件），留给界面上的「导入」
    if (base !== undefined && base === it.size) continue;
    busy = true;
    ST.file = it.path;
    ST.msg = it.kind === 'folder' ? '找到名录文件夹，正在接入…' : '找到下载好的名录，正在处理…';
    try {
      const r = await install(it.path);
      if (r.ok) return; // finish() 已经改了 phase
      // 这一份不行就继续等下一份
      ST.phase = 'waiting';
      ST.msg = r.error || '这一份装不上，换个文件试试';
      baseline.set(it.path, it.size);
    } finally {
      busy = false;
    }
  }
  if (!ST.msg) ST.msg = '正在等待下载完成…';
}

function start() {
  stopTimers();
  baseline = new Map(scan().map((it) => [it.path, it.size]));
  seen = new Map();
  ST.watching = true;
  ST.phase = 'waiting';
  ST.file = '';
  ST.got = 0;
  ST.dir = '';
  ST.error = '';
  ST.msg = '正在等待下载完成…（下好会自动接入，不用管）';
  ST.startedAt = Date.now();
  ST.finishedAt = 0;
  timer = setInterval(() => {
    tick().catch(() => {});
  }, TICK_MS);
  if (timer.unref) timer.unref();
  return info();
}

function stop() {
  stopTimers();
  ST.watching = false;
  if (ST.phase === 'waiting' || ST.phase === 'extract') {
    ST.phase = 'idle';
    ST.msg = '已取消等待';
  }
  return info();
}

/* ---------------- 对外 ---------------- */

function init(opts = {}) {
  if (opts.dir) storeRoot = path.resolve(String(opts.dir));
  if (!storeRoot) storeRoot = defaultStoreDir();
  if (opts.onInstalled) onInstalled = opts.onInstalled;
  storeReady = true;
  return info();
}

function info() {
  const found = scan();
  return {
    ok: true,
    baidu: BAIDU,
    target: storeRoot || defaultStoreDir(),
    // 已经存在的候选（点下载之前就有的），界面上列出来让用户一键导入
    found: found.slice(0, 8),
    state: {
      ...ST,
      elapsed: ST.startedAt ? Date.now() - ST.startedAt : 0,
    },
  };
}

module.exports = {
  init,
  start,
  stop,
  install,
  info,
  scan,
  defaultStoreDir,
  downloadDirs,
  findDbDeep,
  looksLikeName,
  BAIDU,
};
