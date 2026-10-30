'use strict';

/**
 * 自动更新：检查清单 → 下载 → 校验 → 原地替换自身。
 *
 * 这一段是从「物种鉴定聚合台」那套打过仗的实现搬过来的，规则一模一样。
 * 两种打包形态，替换的东西不一样：
 *
 *   ① Windows 单文件 exe（SEA 注入）
 *      清单 latest.json，待装包是一只新 exe（80 多 MB）。
 *      运行中的 exe 不允许被覆盖或删除，但**允许改名**（同卷 rename 只是改目录项）。
 *      所以流程是：先把老 exe 改名让位 → 把新文件放到原名 → 启动新进程 → 老进程退出。
 *      老文件要等进程真正退出后才能删，由新进程启动时的 cleanup() 收拾。
 *
 *   ② macOS 目录版（原装 node + app/main.js）
 *      清单 latest-mac.json，待装包只是一个 main.js（几百 KB，几秒下完）。
 *      node 运行时**一个字都不改**，所以官方签名一直有效；只替换 app/main.js，
 *      POSIX 下 rename 覆盖原文件是原子的，替换完再 spawn 一个 node 把新 main.js 跑起来。
 *      两个架构（arm64/x64）共用同一份 main.js，所以 mac 只有一份更新包。
 *
 * 安全约束：
 *   - 只接受 https（本地调试可用 http）
 *   - 下载完必须校验 SHA-256，对不上直接丢弃，不碰原文件
 *   - 新文件先在目标同目录落地再 rename，避免跨卷 rename 失败
 *   - 任何一步失败都回滚，绝不留「程序不见了」的状态
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { Readable, Transform } = require('node:stream');
const { isSea, isAppBundle, APP_MAIN, APP_DIR, PROGRAM_DIR, DATA_DIR } = require('./env');
const { APP_VERSION, UPDATE_URL } = require('./version');

/** 能不能自动装：单文件 exe 或 macOS 目录版 */
const INSTALLABLE = isSea || isAppBundle;
/** 要被替换的那个文件（exe 本体 / app/main.js） */
const TARGET = isSea ? process.execPath : isAppBundle ? APP_MAIN : '';
const TARGET_EXT = isSea ? '.exe' : '.js';
/**
 * exe 模式下程序本体「当前」的路径。
 * 不能用常量 process.execPath：文件名会被同步成新版本号（见 syncExeName），
 * 而 process.execPath 是进程启动那一刻的旧路径，改名后它就指向不存在的文件了。
 */
let currentExe = isSea ? process.execPath : '';
/** 两种形态用不同的清单，免得 Windows 拿到 mac 的更新包（反之亦然） */
const MANIFEST_NAME = isSea ? 'latest.json' : 'latest-mac.json';

const UPDATE_DIR = path.join(DATA_DIR, 'update');
const INCOMING = path.join(UPDATE_DIR, `incoming${TARGET_EXT}`);
const MANIFEST_CACHE = path.join(UPDATE_DIR, 'manifest.json');

const STATE = {
  phase: 'idle', // idle | checking | downloading | ready | applying | error | done
  received: 0,
  total: 0,
  error: '',
};

let lastManifest = null;
let lastCheckAt = 0;

/* ---------------- 小工具 ---------------- */

function ensureDir() {
  try {
    fs.mkdirSync(UPDATE_DIR, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/** 语义化版本比较：返回 -1 / 0 / 1。容忍 v 前缀与 -demo 后缀 */
function compareVersions(a, b) {
  const norm = (v) =>
    String(v || '')
      .trim()
      .replace(/^v/i, '')
      .split('-')[0]
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const x = norm(a);
  const y = norm(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

function resolveManifestUrl() {
  if (!UPDATE_URL) return '';
  if (/\.json(\?|$)/i.test(UPDATE_URL)) return UPDATE_URL;
  return UPDATE_URL.replace(/\/+$/, '') + '/' + MANIFEST_NAME;
}

function resolveAssetUrl(raw) {
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  // 相对路径：以 manifest 所在目录为基准
  try {
    return new URL(raw, resolveManifestUrl()).toString();
  } catch {
    return raw;
  }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (c) => hash.update(c));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/** 程序本体所在目录能否真正写入（Program Files、/Applications 会拒绝） */
function canWriteAppDir() {
  const probe = path.join(PROGRAM_DIR, `.~write-test-${process.pid}`);
  try {
    fs.writeFileSync(probe, 'x');
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/* ---------------- 清理上次遗留 ---------------- */

/**
 * 删掉上一版留下的大文件。
 * 注意：这一步是在**新进程刚起来**时跑的，而老进程可能还没完全退出，
 * exe 还被系统锁着删不掉（Windows 上 rename 成功但 delete 会失败）。
 * 所以启动时扫一遍，8 秒后再补扫一遍 —— 否则用户目录里会一直留着一个 83MB 的 ~old-*.exe。
 */
function sweepOld() {
  try {
    for (const name of fs.readdirSync(PROGRAM_DIR)) {
      if (!name.startsWith('~old-') || !/\.(exe|js)$/i.test(name)) continue;
      try {
        fs.rmSync(path.join(PROGRAM_DIR, name), { force: true });
      } catch {
        /* 正被占用就等下一轮 */
      }
    }
  } catch {
    /* 目录读不了就算了 */
  }
}

/**
 * 我们自己产出的版本化文件名，例如 tagden-0.5.3.exe / tagden-0.5.4.exe。
 * 只认这种「名字里带版本号」的文件 —— 用户自己起的 tagden-win.exe、
 * 物种标注工坊.exe 不带版本，也就没有「版本对不上」的问题，一律不动。
 */
const VERSIONED_NAME = /^(tagden)-v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?(\.exe)$/i;

/**
 * 把 exe 文件名同步成它真正的版本号。
 *
 * 背景：自动更新是「原地替换内容、沿用原文件名」，所以从 tagden-0.5.3.exe
 * 一路升上来，文件名会一直停在 0.5.3，跟界面里的版本号对不上。
 * 这里在启动时（以及安装完新版后）把文件名改成 tagden-<当前版本>.exe。
 *
 * 只对「版本化命名」生效；改名失败（目录只读、被占用等）就保持原样，不影响使用。
 * 返回 exe 的当前路径（没改就原样返回）。
 *
 * @param {string} version 目标版本号（形如 0.5.4）
 */
function syncExeName(version) {
  if (!isSea || !version) return currentExe;
  const base = path.basename(currentExe);
  const m = base.match(VERSIONED_NAME);
  if (!m) return currentExe;

  const desired = `${m[1]}-${version}${m[2]}`;
  if (desired === base) return currentExe;

  const next = path.join(path.dirname(currentExe), desired);
  try {
    // 目标名已经被别的文件占着（比如用户自己还留着一份），就别覆盖，保持现状
    if (fs.existsSync(next)) return currentExe;
    fs.renameSync(currentExe, next); // 运行中的 exe 允许改名
    currentExe = next;
  } catch {
    /* 改不了就算了，不影响使用 */
  }
  return currentExe;
}

/** 启动时调用：清掉上一版留下的旧文件、半截下载、过期缓存 */
function cleanup() {
  // 先把文件名同步成真正的版本号（老用户从 tagden-0.5.3.exe 升上来的情况）
  syncExeName(APP_VERSION);
  if (!ensureDir()) return;

  sweepOld();
  // 老进程退出需要一点时间，隔几秒再扫一次（unref：不拖住进程退出）
  const t = setTimeout(sweepOld, 8000);
  if (typeof t.unref === 'function') t.unref();

  // 半截下载
  try {
    if (fs.existsSync(INCOMING + '.part')) fs.rmSync(INCOMING + '.part', { force: true });
  } catch {
    /* ignore */
  }

  // 上次已经把新版落地但没来得及重启 → 说明现在跑的就是新版，清掉待装包
  try {
    if (fs.existsSync(INCOMING) && fs.existsSync(MANIFEST_CACHE)) {
      const m = JSON.parse(fs.readFileSync(MANIFEST_CACHE, 'utf8'));
      if (m?.version && compareVersions(APP_VERSION, m.version) >= 0) {
        fs.rmSync(INCOMING, { force: true });
        fs.rmSync(MANIFEST_CACHE, { force: true });
      }
    }
  } catch {
    /* ignore */
  }
}

/* ---------------- 检查更新 ---------------- */

async function fetchManifest() {
  const url = resolveManifestUrl();
  if (!url) throw new Error('尚未配置更新地址');
  if (!/^https:\/\//i.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)/i.test(url)) {
    throw new Error('更新地址必须是 https');
  }
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'cache-control': 'no-cache' },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`清单请求失败 HTTP ${res.status}`);
  const json = await res.json();
  if (!json || typeof json !== 'object' || !json.version) throw new Error('清单格式不正确');
  return json;
}

/**
 * 检查是否有新版。任何网络错误都吞掉——更新检查失败不该影响正常使用。
 * @param {{force?: boolean}} opts
 */
async function check(opts = {}) {
  const base = {
    current: APP_VERSION,
    configured: Boolean(UPDATE_URL),
    // 打包形态：exe（Windows 单文件）/ bundle（mac 目录版）/ source（源码）
    mode: isSea ? 'exe' : isAppBundle ? 'bundle' : 'source',
    supported: Boolean(UPDATE_URL) && INSTALLABLE,
    // 能不能自动装：打包形态 + 程序目录可写。下载前就能判断，省得下完才发现装不了
    canApply: INSTALLABLE && canWriteAppDir(),
  };

  if (!UPDATE_URL) {
    return { ...base, ok: true, hasUpdate: false, reason: '未配置更新地址' };
  }

  // 30 分钟内复用上次结果，避免频繁打扰
  if (!opts.force && lastManifest && Date.now() - lastCheckAt < 30 * 60 * 1000) {
    return buildResult(lastManifest, base);
  }

  STATE.phase = 'checking';
  try {
    const m = await fetchManifest();
    lastManifest = m;
    lastCheckAt = Date.now();
    STATE.phase = 'idle';
    return buildResult(m, base);
  } catch (err) {
    STATE.phase = 'idle';
    return { ...base, ok: false, hasUpdate: false, reason: err.message || '检查失败' };
  }
}

function buildResult(m, base) {
  const cmp = compareVersions(m.version, APP_VERSION);
  const hasUpdate = cmp > 0;
  const ready = hasUpdate && fs.existsSync(INCOMING);

  let pending = null;
  if (ready) {
    try {
      const cached = JSON.parse(fs.readFileSync(MANIFEST_CACHE, 'utf8'));
      if (cached?.version === m.version) pending = cached;
    } catch {
      /* ignore */
    }
  }

  return {
    ...base,
    ok: true,
    hasUpdate,
    latest: m.version,
    notes: m.notes || '',
    pubDate: m.pubDate || '',
    size: Number(m.size) || 0,
    // 已经下好、等重启即可生效
    ready: Boolean(pending) && pending.version === m.version,
    reason: hasUpdate ? '' : '已是最新版本',
  };
}

/* ---------------- 下载 ---------------- */

async function download() {
  // 下载前强制刷新清单：缓存里的 sha256 可能已经过期，拿旧清单校验等于没校验
  const fresh = await check({ force: true });
  if (!fresh.ok) throw new Error(fresh.reason || '无法获取更新清单');
  if (!fresh.hasUpdate) throw new Error(fresh.reason || '没有可用更新');

  const m = lastManifest;
  const url = resolveAssetUrl(m.url);
  if (!url) throw new Error('清单里没有下载地址');
  if (!/^https:\/\//i.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)/i.test(url)) {
    throw new Error('下载地址必须是 https');
  }
  if (!ensureDir()) throw new Error('更新缓存目录不可写');

  const partPath = INCOMING + '.part';
  try {
    if (fs.existsSync(partPath)) fs.rmSync(partPath, { force: true });
  } catch {
    /* ignore */
  }

  STATE.phase = 'downloading';
  STATE.received = 0;
  STATE.total = Number(m.size) || 0;
  STATE.error = '';

  const hash = crypto.createHash('sha256');
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk);
      STATE.received += chunk.length;
      cb(null, chunk);
    },
  });

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30 * 60 * 1000) });
    if (!res.ok || !res.body) throw new Error(`下载失败 HTTP ${res.status}`);
    if (!STATE.total) STATE.total = Number(res.headers.get('content-length')) || 0;

    await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(partPath));

    const got = hash.digest('hex');
    const want = String(m.sha256 || '').toLowerCase();
    if (want && got !== want) {
      throw new Error(`校验失败（期望 ${want.slice(0, 12)}…，实得 ${got.slice(0, 12)}…）`);
    }

    // 完整包才改名到正式位置
    if (fs.existsSync(INCOMING)) fs.rmSync(INCOMING, { force: true });
    fs.renameSync(partPath, INCOMING);
    fs.writeFileSync(MANIFEST_CACHE, JSON.stringify({ ...m, sha256: got }), 'utf8');

    STATE.phase = 'ready';
    return { ok: true, version: m.version, bytes: STATE.received };
  } catch (err) {
    STATE.phase = 'error';
    STATE.error = err.message || '下载失败';
    // 失败时连旧的待装包一起清掉：留着可能让 apply() 装上一个过期版本
    for (const f of [partPath, INCOMING, MANIFEST_CACHE]) {
      try {
        if (fs.existsSync(f)) fs.rmSync(f, { force: true });
      } catch {
        /* ignore */
      }
    }
    throw err;
  }
}

/* ---------------- 替换并重启 ---------------- */

/**
 * 把待装的新版替换到当前程序的位置，然后启动新进程并退出自己。
 * 只做「预订」动作，真正退出由调用方安排（先回响应给前端）。
 */
async function apply() {
  if (!INSTALLABLE) throw new Error('源码模式下不支持自动替换，请直接用源码运行');
  if (!fs.existsSync(INCOMING)) throw new Error('没有待安装的新版本，请先下载');
  if (!canWriteAppDir()) {
    throw new Error(
      isSea
        ? '程序所在目录不可写（可能在 Program Files 下），请把程序移到 D 盘或用户目录再更新'
        : '程序所在目录不可写（可能在「应用程序」文件夹里），请把整个文件夹移到桌面或用户目录再更新',
    );
  }

  STATE.phase = 'applying';

  const exePath = isSea ? currentExe : TARGET;
  const dir = path.dirname(exePath);
  const stagingPath = path.join(dir, `~incoming-${process.pid}${TARGET_EXT}`);
  const backupPath = path.join(dir, `~old-${Date.now()}${TARGET_EXT}`);

  // 1. 先校验一次待装包（防止拿到损坏/被篡改的文件）
  let want = '';
  let stagedVersion = '';
  try {
    const cached = JSON.parse(fs.readFileSync(MANIFEST_CACHE, 'utf8'));
    want = String(cached.sha256 || '').toLowerCase();
    stagedVersion = String(cached.version || '');
  } catch {
    /* 没有记录就不比对 */
  }

  // 待装包必须是「比当前更新」的那一版，否则宁可不让装
  if (stagedVersion && compareVersions(stagedVersion, APP_VERSION) <= 0) {
    STATE.phase = 'error';
    throw new Error(`待装包是 v${stagedVersion}，不比当前 v${APP_VERSION} 新，已放弃安装`);
  }

  if (want) {
    const got = await sha256File(INCOMING);
    if (got !== want) {
      try {
        fs.rmSync(INCOMING, { force: true });
      } catch {
        /* ignore */
      }
      STATE.phase = 'error';
      throw new Error('待安装包校验不通过，已删除，请重新下载');
    }
  }

  // 2. 落到 exe 同目录的临时名（跨卷 copy 允许，rename 不允许，所以先 copy）
  try {
    fs.copyFileSync(INCOMING, stagingPath);
  } catch (err) {
    STATE.phase = 'error';
    throw new Error(`无法写入程序目录：${err.message}`);
  }

  // 3. 老 exe 改名让位（运行中的 exe 允许改名）
  let renamed = false;
  try {
    fs.renameSync(exePath, backupPath);
    renamed = true;
  } catch (err) {
    try {
      fs.rmSync(stagingPath, { force: true });
    } catch {
      /* ignore */
    }
    STATE.phase = 'error';
    throw new Error(`无法替换正在运行的程序（${err.code || 'rename 失败'}），请手动下载新版本覆盖`);
  }

  // 4. 新文件顶替原名；失败则把老文件改回来
  try {
    fs.renameSync(stagingPath, exePath);
  } catch (err) {
    if (renamed) {
      try {
        fs.renameSync(backupPath, exePath);
      } catch {
        /* 尽力回滚 */
      }
    }
    try {
      fs.rmSync(stagingPath, { force: true });
    } catch {
      /* ignore */
    }
    STATE.phase = 'error';
    throw new Error(`新版本就位失败（${err.code || 'rename 失败'}），已回滚`);
  }

  // 4.5 把文件名同步成新版版本号：只对版本化命名生效
  //     （tagden-0.5.3.exe → tagden-0.5.4.exe）。不改动用户自定义的名字。
  const launchPath = isSea
    ? syncExeName(stagedVersion || (lastManifest && lastManifest.version) || '')
    : exePath;

  // 5. 启动新进程
  // 输出重定向到日志文件而不是继承父进程的 stdio：继承管道会因为父进程退出而 EPIPE
  const logPath = path.join(UPDATE_DIR, 'launch.log');
  let logFd = null;
  try {
    logFd = fs.openSync(logPath, 'a');
    fs.writeSync(logFd, `\n=== ${new Date().toISOString()} 由 v${APP_VERSION} 启动 ${path.basename(launchPath)} ===\n`);
  } catch {
    logFd = null;
  }

  let child = null;
  try {
    // exe 模式：新 exe 直接跑（用 launchPath，文件名可能刚被同步成新版）；
    // mac 目录版：还是同一个 node 运行时，只是把参数换成新的 app/main.js
    const args = isSea ? ['--no-open'] : [launchPath, '--no-open'];
    child = spawn(isSea ? launchPath : process.execPath, args, {
      cwd: isSea ? dir : APP_DIR,
      detached: true,
      stdio: logFd !== null ? ['ignore', logFd, logFd] : 'ignore',
      windowsHide: false,
      // --no-open 让新进程别再开一次浏览器（旧页面会自己轮询重连）；TAGDEN_UPDATED 让新进程知道自己刚更新过
      env: { ...process.env, TAGDEN_UPDATED: '1' },
    });
    child.on('error', (e) => {
      try {
        fs.appendFileSync(logPath, `[spawn error] ${e.code || ''} ${e.message}\n`, 'utf8');
      } catch {
        /* ignore */
      }
    });
    child.unref();
    // 子进程已复制句柄，父进程这边可以关了
    if (logFd !== null) {
      try {
        fs.closeSync(logFd);
      } catch {
        /* ignore */
      }
    }
  } catch (err) {
    if (logFd !== null) {
      try {
        fs.closeSync(logFd);
      } catch {
        /* ignore */
      }
    }
    STATE.phase = 'error';
    throw new Error(`新版本已就位，但自动重启失败：${err.message}。请手动重新打开程序`);
  }

  STATE.phase = 'done';
  return { ok: true, version: lastManifest?.version || '', exePath: launchPath };
}

function status() {
  return { ...STATE };
}

function resetError() {
  if (STATE.phase === 'error') {
    STATE.phase = 'idle';
    STATE.error = '';
  }
}

module.exports = {
  check,
  download,
  apply,
  cleanup,
  status,
  resetError,
  compareVersions,
  UPDATE_DIR,
  INCOMING,
};
