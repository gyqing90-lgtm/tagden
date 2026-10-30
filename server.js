'use strict';
/**
 * 物种标注工坊（tagden）—— 本地图片批量识别 + 人工确认 + 写回图片
 *
 * 设计原则和聚合台一致：纯本地、零依赖、不向外上传任何统计。
 * 图片只在点「识别」时按需发给识别站点，结果落回本机文件的元数据里。
 *
 *   node server.js            默认端口 7801
 *   node server.js --port 8080
 */

// 必须在任何异步文件操作之前设：补读标签是 8 路并发，而 libuv 默认只有 4 个线程，
// 不调大的话后 4 路会排队，USB 机械盘上白白多等一倍。
if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = '16';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const { Sites, SITE_META } = require('./lib/adapters');
const { aggregate } = require('./lib/aggregate');
const IMG = require('./lib/imgmeta');
const EX = require('./lib/exif');
const secure = require('./lib/secure');
const LC = require('./lib/labelcache');
const ASSETS = require('./lib/assets');
// 三个目录都由 env 统一裁决：源码跑是项目根目录，exe 跑是 exe 所在目录
const { isSea, isAppBundle, DATA_DIR: DATA, DATA_NOTE } = require('./lib/env');

/**
 * 端口写死 7801。
 *
 * 两个软件（聚合台 8791 / 标注工坊 7801）要能同时开着，端口就必须各归各的。
 * 早先端口是存在 config.json 里的，两个便携版 exe 放在同一个文件夹时会共用一份
 * 配置，被聚合台的 8791 带跑，结果两边抢同一个端口。现在端口是常量，
 * --port 只留着调试用，不会被旧的配置文件左右。
 */
const APP_PORT = 7801;
const updater = require('./lib/updater');
// 版本号与更新源：打包时由 build/bundle.js 注入（global.__APP_META__），源码跑用默认值
const { APP_VERSION: VERSION, UPDATE_URL } = require('./lib/version');
// 清掉上一版更新时留下的 ~old-*.exe、半截下载包
updater.cleanup();
// 缓存（标签索引 + 缩略图）放本机 AppData / macOS 的 Caches 目录，不进 OneDrive：
// 一是几十 MB 的缩略图没必要同步上云，二是缓存本来就是「本机可重建」的东西。
// 想放回程序目录里（比如做绿色版），设 TAGDEN_CACHE 环境变量指过去即可。
const CACHE =
  process.env.TAGDEN_CACHE ||
  (process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'tagden', 'cache')
    : process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Caches', 'tagden')
      : path.join(DATA, 'cache'));
const THUMBS = path.join(CACHE, 'thumbs');
const CFG_FILE = path.join(DATA, 'config.json');
LC.init(path.join(CACHE, 'labels'));
try {
  fs.mkdirSync(THUMBS, { recursive: true });
} catch {}

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.tif', '.tiff', '.bmp', '.gif']);
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

/* ---------------- 配置 ---------------- */

function loadConfig() {
  const fresh = { port: 7801, sites: {}, sessions: {}, ui: { preset: 'auto', sources: null } };
  if (!fs.existsSync(CFG_FILE)) return fresh;
  const raw = fs.readFileSync(CFG_FILE, 'utf8');
  let merged;
  try {
    const opened = secure.open(raw);
    merged = { ...fresh, ...(opened.value || opened) };
  } catch {
    try {
      merged = { ...fresh, ...JSON.parse(raw) };
    } catch {
      merged = fresh;
    }
  }
  // 端口不采信配置里的旧值：两个便携版共用一份配置时，这里可能已经被另一个软件
  // 写成了它的端口（8791），照着用就会两个软件抢同一个端口。
  merged.port = APP_PORT;
  return merged;
}

const config = loadConfig();
let sites = new Sites(config);

function persistConfig() {
  fs.mkdirSync(DATA, { recursive: true });
  const payload = { port: config.port, sites: config.sites, sessions: config.sessions, ui: config.ui };
  const tmp = `${CFG_FILE}.tmp`;
  fs.writeFileSync(tmp, secure.seal(payload), 'utf8');
  fs.renameSync(tmp, CFG_FILE);
}

/**
 * 配置加密要走一次系统凭据（每次几百毫秒），而「列目录」这种高频操作每次都会
 * 顺手把 lastDir 记下来。全部立刻落盘的话，光是翻文件夹就要等半秒。
 * 折中：合并 1.2 秒后再写，翻得快时只写最后一次。
 */
let persistTimer = null;
function schedulePersist(delay = 1200) {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      persistConfig();
    } catch {
      /* 写不进去就算了，下次还会再试 */
    }
  }, delay);
  if (persistTimer.unref) persistTimer.unref();
}

/** 这个站点现在能不能用（有账号 / 不需要账号） */
function siteReady(key) {
  const m = SITE_META[key];
  if (!m) return false;
  if (m.verify) return false; // eBird 只查记录，不认图
  if (m.auth === 'none') return true;
  const acc = m.account || key;
  const c = config.sites?.[acc] || config.sites?.[key] || {};
  if (m.auth === 'key') return (m.fields || [{ key: 'apiKey' }]).some((f) => f.secret && c[f.key]);
  if (m.auth === 'login') return !!(c.username && c.password);
  if (m.auth === 'captcha') return !!c.token;
  if (m.auth === 'manual') return (m.fields || []).some((f) => c[f.key]);
  return false;
}

/* 识别方案：一次把「这批照片大概是什么」说清楚，背后自动挑站点
 *
 * sources  —— 这个类群该问的站（按「本门类 → 动物兜底 → 通用」排），默认全开
 * optional —— 能问但默认关的。目前只有豆包：它靠大模型自由发挥，结论容易发散，
 *             而且按次计费，所以不进默认名单，需要的人自己点开。
 */
const PRESETS = [
  {
    key: 'auto',
    name: '自动（混合）',
    hint: '各门类都问一遍，最慢但最不容易漏',
    sources: [
      'quarryman', 'butterflyai', 'butterflyai-butterfly',
      'iplant', 'quarryman-plant', 'quarryman-rose', 'xingse',
      'quarryman-fungi', 'quarryman-snake', 'quarryman-mollusk',
      'duoshi', 'duoshi-bird', 'duoshi-plant', 'baidu-animal', 'baidu-plant',
      'dongniao', 'kuaitong', 'dongniao-herp', 'inaturalist',
    ],
    optional: ['doubao'],
  },
  {
    key: 'insect',
    name: '昆虫',
    hint: '专问昆虫，动物站兜底',
    sources: ['quarryman', 'butterflyai', 'butterflyai-butterfly', 'duoshi', 'baidu-animal', 'inaturalist'],
    optional: ['doubao'],
  },
  {
    key: 'plant',
    name: '植物',
    hint: '专问植物，通用站兜底',
    sources: ['iplant', 'quarryman-plant', 'quarryman-rose', 'duoshi-plant', 'baidu-plant', 'xingse', 'inaturalist'],
    optional: ['doubao'],
  },
  {
    key: 'bird',
    name: '鸟类',
    hint: '专问鸟类，动物站兜底',
    sources: ['dongniao', 'kuaitong', 'duoshi-bird', 'duoshi', 'baidu-animal', 'inaturalist'],
    optional: ['doubao'],
  },
  {
    key: 'fungi',
    name: '菌物',
    hint: '专问菌物',
    sources: ['quarryman-fungi', 'inaturalist'],
    optional: ['doubao'],
  },
  {
    key: 'herp',
    name: '两栖爬行',
    hint: '专问两栖爬行，动物站兜底',
    sources: ['dongniao-herp', 'quarryman-snake', 'duoshi', 'baidu-animal', 'inaturalist'],
    optional: ['doubao'],
  },
];

/** 某个方案下「可以问的所有站」与「默认问哪些站」 */
function presetAll(presetKey) {
  const p = PRESETS.find((x) => x.key === presetKey) || PRESETS[0];
  return { preset: p.key, def: p.sources, all: [...p.sources, ...(p.optional || [])] };
}

function presetSources(presetKey) {
  const { preset, def, all } = presetAll(presetKey);
  // 用户在这个方案里手动关掉/打开过的，优先于默认；换方案再换回来还认得
  const picked = config.ui?.picks?.[preset];
  const chosen = Array.isArray(picked) ? picked.filter((k) => all.includes(k)) : def;
  const ready = chosen.filter(siteReady);
  return {
    preset,
    requested: chosen.length ? chosen : def,
    sources: ready.length ? ready : ['quarryman'].filter(siteReady),
    // 按方案顺序把每个站摊开，前端据此画一排可点的小开关
    available: all.map((k) => ({ key: k, on: chosen.includes(k), ready: siteReady(k) })),
  };
}

/* ---------------- 小工具 ---------------- */

function sendJson(res, code, obj, after) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
  res.end(body);
  // 更新安装这类「回完就得让自己退出」的接口要用：响应真的发出去之后再动手
  if (typeof after === 'function') res.once('finish', () => setImmediate(after));
}

function readBody(req, limit = 40 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体太大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.length) return {};
  return JSON.parse(raw.toString('utf8'));
}

/** 用户输入类错误：带上状态码，别一律 500 */
function bad(msg, status = 400) {
  return Object.assign(new Error(msg), { status });
}

/** 目录安全：必须是存在的绝对路径，且是文件夹 */
function asDir(p) {
  if (!p) throw bad('缺少路径');
  const full = path.resolve(String(p));
  if (!fs.existsSync(full)) throw bad(`文件夹不存在：${full}`);
  if (!fs.statSync(full).isDirectory()) throw bad(`这不是文件夹：${full}`);
  return full;
}

function asImage(p) {
  const full = path.resolve(String(p || ''));
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw bad(`图片不存在：${full}`);
  if (!IMAGE_EXT.has(path.extname(full).toLowerCase())) throw bad('不是支持的图片格式');
  return full;
}

/* ---------------- 盘符 ---------------- */

/**
 * 盘符列表，给左侧文件夹树当根。
 *
 * 拿盘符有三条路，按「快 + 不卡」排序：
 *   1. `fsutil fsinfo drives`（约 190ms，只给盘符，但**不会卡在空光驱上**）
 *   2. 直接 statSync 探 C:～Z:（正常情况下 0ms，但机器上有空光驱时会卡上一两秒）
 *   3. 卷标：PowerShell 的 Win32_LogicalDisk（约 700ms），只为了显示「Elements SE (E:)」
 * 所以盘符走 1、失败退回 2；卷标在后台异步补，补不到就用「本地磁盘」。
 */
let drivesCache = null; // { at, list }
let labelPromise = null; // 卷标只查一次
const LABELS = new Map();

function driveLetters() {
  if (process.platform !== 'win32') return ['/'];
  try {
    const out = require('node:child_process').execFileSync('fsutil', ['fsinfo', 'drives'], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
    });
    // 输出形如「驱动器: C:\ D:\ E:\」，中英文系统都一样，直接抓 X:\
    const letters = [...out.matchAll(/\b([A-Za-z]):\\/g)].map((m) => m[1].toUpperCase());
    if (letters.length) return letters.map((l) => `${l}:\\`);
  } catch {
    /* 没 fsutil（精简系统）就走下面的探测 */
  }
  const out = [];
  for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    try {
      if (fs.statSync(`${l}:\\`).isDirectory()) out.push(`${l}:\\`);
    } catch {
      /* 这个盘不存在（或没插） */
    }
  }
  return out;
}

/** 卷标查询放后台，绝不阻塞 /api/drives —— 七百毫秒对首屏来说太贵了 */
function loadDriveLabels() {
  if (labelPromise || process.platform !== 'win32') return labelPromise;
  labelPromise = new Promise((resolve) => {
    const { execFile } = require('node:child_process');
    const cmd =
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;' +
      'Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,VolumeName | ConvertTo-Json -Compress';
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeout: 6000, windowsHide: true }, (err, stdout) => {
      if (!err) {
        try {
          const raw = JSON.parse(String(stdout).trim());
          for (const d of [].concat(raw)) {
            if (d && d.DeviceID && d.VolumeName) LABELS.set(String(d.DeviceID).toUpperCase(), String(d.VolumeName));
          }
        } catch {
          /* 卷标是锦上添花，解析不出来就算了 */
        }
      }
      resolve();
    });
  });
  return labelPromise;
}

/**
 * macOS 的「根」：个人文件夹、挂着的外接盘、整台电脑。
 * 只给一个 / 会让人从 vol 里一层层点到 Users/xxx/Pictures，多绕三步；
 * 大多数人的照片就在「个人文件夹」或外接硬盘里，直接摆出来。
 */
function macDrives() {
  const now = Date.now();
  if (drivesCache && now - drivesCache.at < 60_000) return drivesCache.list;

  const size = (root) => {
    try {
      const s = fs.statfsSync(root);
      return { total: s.blocks * s.bsize, free: s.bfree * s.bsize, fs: '' };
    } catch {
      return { total: 0, free: 0, fs: '' };
    }
  };

  const home = os.homedir();
  const base = path.basename(home) || '家目录';
  const list = [
    { name: base, path: home, label: `${base}（个人文件夹）`, volume: '', isSystem: true, ...size(home) },
  ];

  // 外接硬盘、U 盘、网络卷都挂在 /Volumes 下面
  try {
    for (const name of fs.readdirSync('/Volumes')) {
      if (name.startsWith('.')) continue;
      const root = path.join('/Volumes', name);
      try {
        if (!fs.statSync(root).isDirectory()) continue;
        // 系统盘有时会以「Macintosh HD」出现在这里，别和 / 重复
        if (fs.realpathSync(root) === '/') continue;
      } catch {
        continue;
      }
      list.push({ name, path: root, label: name, volume: name, isSystem: false, ...size(root) });
    }
  } catch {
    /* 没有 /Volumes 就只给个人文件夹和 / */
  }

  list.push({ name: '/', path: '/', label: '整台电脑 (/)', volume: '', isSystem: false, ...size('/') });

  drivesCache = { at: now, list };
  return list;
}

function drives() {
  if (process.platform === 'darwin') return macDrives();
  if (process.platform !== 'win32') {
    return [{ name: '/', path: '/', label: '根目录', fs: '' }];
  }
  const now = Date.now();
  if (drivesCache && now - drivesCache.at < 60_000) return drivesCache.list;
  const sys = (process.env.SystemDrive || 'C:').replace(/\\$/, '').toUpperCase();
  const list = driveLetters().map((root) => {
    const letter = root.slice(0, 2).toUpperCase();
    let total = 0;
    let free = 0;
    let fsName = '';
    try {
      const st = fs.statfsSync(root);
      total = st.blocks * st.bsize;
      free = st.bfree * st.bsize;
    } catch {
      /* 光驱/网络盘取不到容量 */
    }
    const vol = LABELS.get(letter);
    const fallback = letter === sys ? '系统' : '本地磁盘';
    // 卷标跟盘符同名（很多人把 D 盘卷标就叫 D）时没必要显示「D (D:)」
    const bare = letter.replace(/:$/, '');
    const show = vol && vol.toUpperCase() !== bare ? vol : fallback;
    return {
      name: letter,
      path: root,
      label: `${show} (${letter})`,
      volume: vol || '',
      total,
      free,
      isSystem: letter === sys,
    };
  });
  drivesCache = { at: now, list };
  return list;
}

function places() {
  const home = os.homedir();
  const list = [
    { label: '桌面', path: path.join(home, 'Desktop') },
    { label: '图片', path: path.join(home, 'Pictures') },
    { label: '下载', path: path.join(home, 'Downloads') },
    { label: '文档', path: path.join(home, 'Documents') },
    { label: 'OneDrive', path: path.join(home, 'OneDrive') },
  ].filter((x) => fs.existsSync(x.path));
  for (const d of 'CDEFGH'.split('')) {
    const p = `${d}:\\`;
    if (fs.existsSync(p)) list.push({ label: `${d}: 盘`, path: p });
  }
  return list;
}

/** 自然排序：IMG_2 排在 IMG_10 前面 */
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

/* ---------------- 文件名 ---------------- */

/** 文件名里不能出现的字符换成下划线；Windows 还不允许结尾是点或空格 */
function safeName(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 80);
}

/**
 * 物种名部分：
 *   cn    只用中文名（没有就退到学名）
 *   latin 只用学名（没有就退到中文名）
 *   both  中文名_学名
 */
function speciesLabel(cn, latin, pick) {
  const c = safeName(cn);
  const l = safeName(latin);
  if (pick === 'latin') return l || c;
  if (pick === 'both') return c && l ? `${c}_${l}` : c || l;
  return c || l;
}

/** 目标重名时加 (2) (3)…，绝不覆盖别人的照片 */
function uniquePath(target) {
  if (!fs.existsSync(target)) return target;
  const ext = path.extname(target);
  const stem = path.basename(target, ext);
  const dir = path.dirname(target);
  for (let i = 2; i < 200; i += 1) {
    const p = path.join(dir, `${stem} (${i})${ext}`);
    if (!fs.existsSync(p)) return p;
  }
  throw bad('同名文件太多，没有可用的新名字');
}

/**
 * 归档用的文件夹名：中文名优先，没有中文名就用学名。
 * 两者都没有就返回空串 —— 调用方据此跳过，不会造出一个叫「未命名」的垃圾目录。
 */
function speciesFolder(cn, latin) {
  return safeName(cn) || safeName(latin);
}

/**
 * 把文件挪进 rootDir/<物种名>/。已经在里面就原地不动。
 * 目标位置有同名文件时加序号，绝不覆盖别人的照片。
 */
function moveIntoSpeciesDir(file, rootDir, label) {
  const box = path.join(rootDir, safeName(label));
  if (path.dirname(file).toLowerCase() === box.toLowerCase()) return { path: file, moved: false };
  fs.mkdirSync(box, { recursive: true });
  const target = uniquePath(path.join(box, path.basename(file)));
  fs.renameSync(file, target);
  return { path: target, moved: true, folder: path.basename(box) };
}

/** 相对 root 的路径，统一用正斜杠 —— 写进 CSV 以后不管在 Win 还是 mac 打开都能认 */
function relPath(root, full) {
  return path.relative(root, full).split(path.sep).join('/');
}

/**
 * 把物种名拼到原名上：first = 物种名_原名，last = 原名_物种名。
 * labels 可以给多个（当前物种名 + 上次写过的物种名 + 学名），先把它们从 base 上剥干净，
 * 免得改一次标就多叠一层「金斑喙凤蝶_中华虎凤蝶_原名」。
 */
function buildName(base, labels, order) {
  const list = [...new Set((Array.isArray(labels) ? labels : [labels]).map((x) => safeName(x)).filter(Boolean))];
  if (!list.length) return base;
  const primary = list[0];
  if (base === primary) return primary;
  let stem = base;
  for (let round = 0; round < 4; round += 1) {
    let changed = false;
    for (const lab of list) {
      const pref = `${lab}_`;
      const suf = `_${lab}`;
      if (stem.startsWith(pref)) {
        stem = stem.slice(pref.length);
        changed = true;
      } else if (stem.endsWith(suf)) {
        stem = stem.slice(0, -suf.length);
        changed = true;
      }
    }
    if (!changed) break;
  }
  if (!stem) stem = base;
  return order === 'last' ? `${stem}_${primary}` : `${primary}_${stem}`;
}

/* ---------------- 业务接口 ---------------- */

/** 目录里所有图片的名字，按前端显示顺序排好（列表和标签补读必须用同一套顺序） */
function imageNames(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.') && IMAGE_EXT.has(path.extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort((a, b) => collator.compare(a, b));
}

/**
 * 列目录 —— 默认一次 stat 都不做。
 *
 * 以前这里是「逐张读 128KB 标签」，在 USB 机械盘上 2671 张要 80 多秒；就算只 stat
 * 一遍，冷缓存下也要 8 秒多（每张元数据都要去盘上捞）。所以现在：
 *   - 有缓存 → 直接用缓存里的 大小/时间/标签
 *   - 没缓存 → 大小和标签都先空着（labeled:null），交给 /api/labels 后台补
 * 2671 张的文件夹 20 毫秒就能把界面铺出来，其余信息一路补着走。
 *
 * 例外：文件不多的目录（≤200 张）直接 stat 一遍再比对。几十毫秒的事，
 * 却能保证「刚用别的软件改过 / 刚替换过的图」一进来就是对的 —— 缓存再快，
 * 给用户看到过期的「已标注」也是错的。
 */
async function apiList(q) {
  const dir = asDir(q.get('path') || config.ui?.lastDir || places()[0]?.path);
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory() && !HIDDEN_DIR.test(e.name))
    .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
    .sort((a, b) => collator.compare(a.name, b.name));

  const imgs = entries.filter(
    (e) => e.isFile() && !e.name.startsWith('.') && IMAGE_EXT.has(path.extname(e.name).toLowerCase()),
  );
  const statAll = imgs.length <= STAT_UNDER;

  const files = [];
  let pending = 0;
  for (const e of imgs) {
    const full = path.join(dir, e.name);
    const ext = path.extname(e.name).toLowerCase();
    let st = null;
    if (statAll) {
      try {
        st = fs.statSync(full);
      } catch {
        continue; // 刚被删掉
      }
    }
    let rec = LC.get(dir, e.name);
    // 小目录：记录和真实文件对不上就当作没缓存，下面重读
    if (rec && st && !LC.fresh(rec, st)) rec = null;
    if (!rec) pending += 1;
    files.push({
      name: e.name,
      path: full,
      ext,
      size: rec ? rec[0] : st ? st.size : null,
      mtime: rec ? rec[1] : st ? st.mtimeMs : null,
      ...(rec ? LC.unpack(rec) : { labeled: null, labelTitle: '', labelKeywords: [], orient: 1 }),
      pending: !rec,
    });
  }
  files.sort((a, b) => collator.compare(a.name, b.name));

  config.ui = { ...(config.ui || {}), lastDir: dir };
  schedulePersist();

  const parent = path.dirname(dir);
  return {
    ok: true,
    path: dir,
    parent: parent === dir ? null : parent,
    name: path.basename(dir) || dir,
    dirs,
    files,
    // pending > 0 时前端知道还有多少张的大小/徽标没出来，可以显示进度
    pending,
    known: files.length - pending,
    // 缓存太老：界面照旧秒开，前端再去 /api/verify 悄悄核对一遍（外部工具改过图时靠它纠偏）
    stale: Date.now() - LC.verifiedAt(dir) > STALE_MS,
    places: places(),
  };
}

/** 缓存多久算「可能过期」—— 超过就先给旧数据，再后台核对 */
const STALE_MS = 60 * 1000;

/**
 * 文件数不超过这个值时，列目录时直接 stat 一遍。
 * USB 机械盘上单次 stat 约 3ms（同一目录的 MFT 是连着读的），200 张不到 1 秒；
 * 换来的是「刚替换/刚被别的软件改过的图」立刻正确，不用等缓存过期。
 */
const STAT_UNDER = 200;

/**
 * 只列子文件夹，给左侧树的「展开」用。
 *
 * 和 /api/list 分开是有意的：树只需要「这一层有哪些文件夹」，不需要图片，
 * 更不能顺手去 stat 几百张图。USB 盘上这差别是 20ms 和 8 秒。
 */
/**
 * 这些目录不该出现在树里：回收站、系统卷信息、以及各种以 . 开头的隐藏目录。
 * 它们点了也只会报「没有权限」，白占位置还容易被误点。
 */
const HIDDEN_DIR = /^(\$|\.|System Volume Information$)/i;

async function apiDirs(q) {
  const dir = asDir(q.get('path'));
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory() && !HIDDEN_DIR.test(e.name))
    .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
    .sort((a, b) => collator.compare(a.name, b.name));
  const parent = path.dirname(dir);
  return { ok: true, path: dir, parent: parent === dir ? null : parent, dirs };
}

/**
 * 后台核对：把目录里每个文件 stat 一遍，和缓存比对，变了的重新读标签。
 *
 * 为什么需要：列表为了快，完全信任缓存；但照片可能被 Lightroom / ExifTool / 资源管理器
 * 改过（覆盖、改标签）。不核对的话，界面会一直显示旧的「已标注」状态。
 * 核对只 stat 不读内容，除个别变化的文件外不再碰硬盘数据区。
 */
async function apiVerify(q) {
  const dir = asDir(q.get('path'));
  const names = imageNames(dir);
  const changed = [];
  let cursor = 0;
  const CONC = 4; // 比补标签更轻：别跟正在滚动的缩略图抢盘
  const worker = async () => {
    while (cursor < names.length) {
      const name = names[cursor++];
      const full = path.join(dir, name);
      let st;
      try {
        st = await fsp.stat(full);
      } catch {
        continue;
      }
      const rec = LC.get(dir, name);
      if (LC.fresh(rec, st)) continue;
      let label = null;
      try {
        label = await IMG.readLabelFastAsync(full);
      } catch {}
      const packed = LC.pack(st, label);
      LC.set(dir, name, packed);
      changed.push({ name, size: st.size, ...LC.unpack(packed) });
    }
  };
  await Promise.all(Array.from({ length: CONC }, worker));
  LC.markVerified(dir);
  return { ok: true, checked: names.length, changed };
}

/** 缩略图在 SSD 上的缓存文件名：带「大小 + 修改时间」，原图一改自然失效，不会串图 */
function thumbCacheFile(full, st) {
  const key = crypto.createHash('sha1').update(`${full}|${st.size}|${Math.round(st.mtimeMs)}`).digest('hex');
  return path.join(THUMBS, `${key}.jpg`);
}

/** 一次补读多少个文件的标签。窗口太大单请求变慢，太小请求次数多。 */
const LABEL_WINDOW = 120;
/** 同时在读的文件数。机械盘靠队列深度提速，8 路差不多是性价比拐点。 */
const LABEL_CONC = 8;

/**
 * 分窗口补读标签 —— /api/labels?path=目录&from=0&n=120
 *
 * 前端按显示顺序一窗一窗地要，拿到就点亮对应的卡片。第一次打开大文件夹时，
 * 界面早就出来了，这里慢慢在后台跑；跑完写进 labelcache，下次打开整个目录零 IO。
 */
async function apiLabels(q) {
  const dir = asDir(q.get('path'));
  const from = Math.max(0, Number(q.get('from')) || 0);
  const n = Math.min(400, Math.max(1, Number(q.get('n')) || LABEL_WINDOW));
  const names = imageNames(dir);
  const slice = names.slice(from, from + n);
  const items = new Array(slice.length);

  let cursor = 0;
  const worker = async () => {
    while (cursor < slice.length) {
      const k = cursor++;
      const name = slice[k];
      const full = path.join(dir, name);
      const rec = LC.get(dir, name);
      let st;
      try {
        // 注意必须是异步 stat：同步 stat 会把事件循环占住，用户这会儿点儿别的文件夹
        // /api/list 就得排队等（实测能拖到 1.2 秒）
        st = await fsp.stat(full);
      } catch {
        items[k] = { name, missing: true };
        continue;
      }
      if (LC.fresh(rec, st)) {
        items[k] = { name, size: st.size, mtime: st.mtimeMs, ...LC.unpack(rec) };
        continue;
      }
      let label = null;
      try {
        label = await IMG.readLabelFastAsync(full);
      } catch {
        /* 坏图就当没标签，不能让它拖垮整窗 */
      }
      // 补标签时头已经在内存里了，顺手把 EXIF 缩略图存进缓存：
      // 用户等下滚到这个位置，缩略图直接从 SSD 出，不用再开一次 USB 盘上的原图。
      if (label && label.thumb) {
        const cf = thumbCacheFile(full, st);
        try {
          if (!fs.existsSync(cf)) fs.writeFileSync(cf, label.thumb);
        } catch {
          /* 缓存目录不可写就算了，退回到现抽 */
        }
      }
      const packed = LC.pack(st, label);
      LC.set(dir, name, packed);
      items[k] = { name, size: st.size, mtime: st.mtimeMs, ...LC.unpack(packed) };
    }
  };
  await Promise.all(Array.from({ length: LABEL_CONC }, worker));

  // 整目录都补完了：等于顺手核对了一遍，把校验时间记下来，下次不用再急着复查
  if (from + slice.length >= names.length) LC.markVerified(dir);

  return { ok: true, from, count: slice.length, total: names.length, items };
}

async function apiIdentify(body) {
  const file = asImage(body.path);
  // 一张原图十几 MB，从 USB 盘同步整读会把整个服务卡住一两秒（列表、缩略图全排队）
  const buffer = await fsp.readFile(file);
  const ext = path.extname(file).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  const img = {
    buffer,
    mime,
    filename: path.basename(file),
    // 前端用 canvas 压好的副本：多识要 ≤640，植物智只收 JPEG
    small: body.dataSmall ? Buffer.from(body.dataSmall, 'base64') : null,
    jpeg: body.dataJpeg ? Buffer.from(body.dataJpeg, 'base64') : null,
  };

  const asked = Array.isArray(body.sources) && body.sources.length ? body.sources : presetSources(config.ui?.preset).sources;
  const keys = asked.filter((k) => SITE_META[k] && !SITE_META[k].verify);
  if (!keys.length) throw bad('没有可用的识别站点，请先选一个方案或填好账号');

  // 需要账号的站点：没登录过就先登一次（多识在 identify 内部自己处理）
  await Promise.all(
    keys
      .filter((k) => SITE_META[k].auth === 'login' && SITE_META[k].account !== 'duoshi' && !sites.state[k]?.ok)
      .map((k) => sites.login(k).catch(() => {})),
  );

  const started = Date.now();
  const results = {};
  await Promise.all(
    keys.map(async (k) => {
      try {
        results[k] = await sites.identify(k, img);
      } catch (err) {
        results[k] = { site: k, ok: false, items: [], error: err.message || String(err) };
      }
    }),
  );

  const agg = aggregate(results);
  const bySite = {};
  for (const [k, r] of Object.entries(results)) {
    bySite[k] = { ok: !!r.ok, items: (r.items || []).slice(0, 5), error: r.error || '', ms: r.ms || 0 };
  }
  return {
    ok: true,
    file,
    name: path.basename(file),
    ms: Date.now() - started,
    sites: bySite,
    rows: agg.rows.slice(0, 8).map((r) => ({
      cn: r.cn,
      latin: r.latin,
      pct: r.pct,
      support: r.support,
      bySite: r.bySite,
    })),
    verdict: agg.verdict,
    siteCount: agg.siteCount,
  };
}

async function apiWrite(body) {
  const file = asImage(body.path);
  // 用户正在浏览的这个文件夹：CSV 永远写在这里，文件被归档进子目录也不跟着跑
  const rootDir = path.dirname(file);
  const cn = String(body.cn || '').trim();
  const latin = String(body.latin || '').trim();
  if (!cn && !latin) throw bad('物种名为空');

  const before = (() => {
    try {
      return IMG.readLabel(file);
    } catch {
      return { title: '', description: '', keywords: [], origName: '' };
    }
  })();

  let result;
  try {
    result = IMG.writeLabel(file, { cn, latin, note: body.note || '', source: body.source || '' });
  } catch (err) {
    // 格式不支持、标签超 64KB 之类都算用户可修的错，别报 500
    throw bad(err.message);
  }

  let finalPath = file;
  let renamed = false;
  if (body.rename) {
    const label = speciesLabel(cn, latin, body.renamePick);
    const ext = path.extname(file);
    // 基于「最初的名字」拼，而不是当前名字：连着改几次标也不会越叠越长。
    // 老文件里没记原始名的，退到当前文件名。
    const origName = result.origName || path.basename(file);
    const origExt = path.extname(origName);
    const base = path.basename(origName, origExt) || path.basename(file, ext);
    // 把上一轮写进去的旧物种名也一起剥掉，改错重标时不留残渣
    const prevLatin = (before.keywords || []).find((k) => k && k !== before.title) || '';
    const nextBase = buildName(base, [label, before.title, prevLatin], body.renameOrder === 'last' ? 'last' : 'first');
    if (nextBase && nextBase !== path.basename(file, ext)) {
      let target = path.join(path.dirname(file), `${nextBase}${ext}`);
      // 只是大小写不同 = 同一个文件，Windows 上 existsSync 会误判成重名
      if (path.resolve(target).toLowerCase() === path.resolve(file).toLowerCase()) {
        if (target !== file) {
          fs.renameSync(file, target);
          finalPath = target;
          renamed = true;
        }
      } else {
        target = uniquePath(target);
        fs.renameSync(file, target);
        finalPath = target;
        renamed = true;
      }
    }
  }

  // 归档：写完之后把文件挪进「物种名」子文件夹。挪之前已经把标签写进像素文件本身，
  // 所以就算移动失败，标注也不会丢。
  let archived = false;
  let folder = '';
  if (body.archive) {
    const label = speciesFolder(cn, latin);
    if (label) {
      try {
        const mv = moveIntoSpeciesDir(finalPath, rootDir, label);
        if (mv.moved) {
          finalPath = mv.path;
          archived = true;
          folder = mv.folder;
        }
      } catch (err) {
        // 归档失败不该让整次标注算失败：标签已经写进去了，只是没搬动
        folder = `移动失败：${err.message}`;
      }
    }
  }

  appendRecord(rootDir, {
    file: relPath(rootDir, finalPath),
    orig: renamed ? path.basename(file) : '',
    cn,
    latin,
    source: body.source || '',
    note: body.note || '',
    prev: before.title || '',
    at: new Date().toLocaleString('zh-CN', { hour12: false }),
  });

  // 刚写过的那张直接把新状态记进缓存：不然用户接下去翻文件夹，
  // 这一张会显示成「未知」再被重新读一遍。
  try {
    const dirNow = path.dirname(finalPath);
    LC.drop(path.dirname(file), path.basename(file));
    if (renamed || archived) LC.drop(rootDir, path.basename(file));
    LC.set(dirNow, path.basename(finalPath), LC.pack(fs.statSync(finalPath), IMG.readLabelFast(finalPath)));
  } catch {
    /* 缓存不是关键路径，失败就下次重读 */
  }

  return {
    ok: true,
    path: finalPath,
    name: path.basename(finalPath),
    rel: relPath(rootDir, finalPath),
    renamed,
    archived,
    folder,
    ...result,
    label: IMG.readLabel(finalPath),
  };
}

/* CSV 列顺序固定：老版本只有前 7 列，新加的「原文件名」一律追加到末尾，历史记录一行都不动 */
const CSV_COLS = ['文件名', '中文名', '学名', '识别来源', '备注', '原标签', '标注时间', '原文件名'];

/** 老表少一列时补上表头和空值，再往里追加，不丢已有记录 */
function ensureCsv(file) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `\uFEFF${CSV_COLS.map((c) => `"${c}"`).join(',')}\n`, 'utf8');
    return;
  }
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.replace(/^\uFEFF/, '').split('\n');
  if (!lines.length || lines[0].includes('原文件名')) return;
  const out = lines.map((line, i) => {
    const clean = line.replace(/\r$/, '');
    if (i === 0) return `${clean},"原文件名"`;
    return clean.trim() ? `${clean},""` : clean;
  });
  fs.writeFileSync(file, `\uFEFF${out.join('\n')}`, 'utf8');
}

function appendRecord(dir, row) {
  const file = path.join(dir, '物种标注记录.csv');
  const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  ensureCsv(file);
  fs.appendFileSync(
    file,
    [esc(row.file), esc(row.cn), esc(row.latin), esc(row.source), esc(row.note), esc(row.prev), esc(row.at), esc(row.orig)].join(',') +
      '\n',
    'utf8',
  );
  return file;
}

/* ---------------- 导出：带拍摄时间与坐标的清单 ---------------- */

const isLatin = (s) => /^[A-Z][a-z]+ [a-z-]+/.test(String(s || '').trim());

/** 从写进图的标签里还原中文名/学名：关键词里那个不像学名的就是中文名 */
function splitNameFields(label) {
  const title = String(label.title || '').trim();
  const kws = (label.keywords || []).map((k) => String(k).trim()).filter(Boolean);
  const latin = kws.find(isLatin) || (isLatin(title) ? title : '');
  const cn = kws.find((k) => !isLatin(k)) || (isLatin(title) ? '' : title);
  return { cn, latin };
}

/**
 * 扫一个文件夹里所有「已标注」的图片。
 * 只往下走一层 —— 那一层正是归档出来的物种文件夹，再深就不归这个目录管了。
 */
function scanLabeled(dir) {
  const rows = [];
  const visit = (d, depth) => {
    let ents = [];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (depth === 0 && !e.name.startsWith('.')) visit(full, 1);
        continue;
      }
      if (!IMAGE_EXT.has(path.extname(e.name).toLowerCase())) continue;
      let label;
      try {
        label = IMG.readLabel(full);
      } catch {
        continue;
      }
      if (!label.has && !label.title) continue; // 没标过的跳过
      const ex = EX.meta(full);
      const { note, source } = EX.splitDescription(label.description);
      const { cn, latin } = splitNameFields(label);
      const rel = relPath(dir, full);
      rows.push({
        file: e.name,
        rel,
        folder: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '',
        cn,
        latin,
        taken: ex.dateTime || '',
        lat: ex.lat,
        lon: ex.lon,
        alt: ex.alt,
        note,
        source,
      });
    }
  };
  visit(dir, 0);
  return rows;
}

const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

/** 带 BOM 的 UTF-8，Excel 双击不乱码 */
function writeCsv(file, header, rows) {
  const body = [header.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\r\n');
  fs.writeFileSync(file, `\uFEFF${body}\r\n`, 'utf8');
  return file;
}

async function apiExport(body) {
  const dir = asDir(body.path);
  const rows = scanLabeled(dir);
  if (!rows.length) throw bad('这个文件夹里还没有已标注的图片');

  const detailFile = writeCsv(
    path.join(dir, '标注明细_含坐标.csv'),
    ['文件名', '相对路径', '中文名', '学名', '拍摄时间', '纬度', '经度', '海拔(m)', '识别来源', '备注', '有坐标'],
    rows.map((r) => [
      r.file,
      r.rel,
      r.cn,
      r.latin,
      r.taken,
      r.lat == null ? '' : r.lat.toFixed(6),
      r.lon == null ? '' : r.lon.toFixed(6),
      r.alt == null ? '' : Math.round(r.alt),
      r.source,
      r.note,
      r.lat == null ? '' : '是',
    ]),
  );

  // 按物种汇总：一个物种一行，给的是第一个有坐标的点 + 坐标点数
  const map = new Map();
  for (const r of rows) {
    const key = `${r.cn}||${r.latin}`;
    let s = map.get(key);
    if (!s) {
      s = { cn: r.cn, latin: r.latin, n: 0, gps: [], times: [], folders: new Set() };
      map.set(key, s);
    }
    s.n += 1;
    if (r.lat != null && r.lon != null) s.gps.push([r.lat, r.lon, r.alt]);
    if (r.taken) s.times.push(r.taken);
    if (r.folder) s.folders.add(r.folder);
  }
  const species = [...map.values()].sort((a, b) => b.n - a.n || String(a.cn).localeCompare(String(b.cn), 'zh'));

  const speciesFile = writeCsv(
    path.join(dir, '物种清单_带坐标.csv'),
    ['物种名', '学名', '照片数', '有坐标数', '纬度', '经度', '海拔(m)', '坐标点数', '最早拍摄', '最晚拍摄', '归档文件夹'],
    species.map((s) => {
      const g = s.gps[0];
      const t = [...s.times].sort();
      return [
        s.cn,
        s.latin,
        s.n,
        s.gps.length,
        g ? g[0].toFixed(6) : '',
        g ? g[1].toFixed(6) : '',
        g && g[2] != null ? Math.round(g[2]) : '',
        s.gps.length,
        t[0] || '',
        t[t.length - 1] || '',
        [...s.folders].join(' / '),
      ];
    }),
  );

  return {
    ok: true,
    files: [detailFile, speciesFile],
    names: [path.basename(detailFile), path.basename(speciesFile)],
    detail: rows.length,
    species: species.length,
    withGps: rows.filter((r) => r.lat != null && r.lon != null).length,
  };
}

/**
 * 批量归档：把这个文件夹里「已标注」的图片按物种名分进子文件夹。
 * 默认只算不动手（preview），前端确认后再带 apply:true 回来 —— 移动文件是不可逆的，
 * 不能让用户点错一下就搬走一整批照片。
 */
async function apiArchive(body) {
  const dir = asDir(body.path);
  const apply = body.apply === true;

  let ents = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    throw bad('读不了这个文件夹');
  }

  const todo = [];
  const skip = [];
  const groups = new Map();
  for (const e of ents) {
    if (!e.isFile() || e.name.startsWith('.')) continue;
    if (!IMAGE_EXT.has(path.extname(e.name).toLowerCase())) continue;
    const full = path.join(dir, e.name);
    let label;
    try {
      label = IMG.readLabel(full);
    } catch {
      skip.push(e.name);
      continue;
    }
    const kw = (label.keywords || []).filter((k) => k !== label.title);
    const name = speciesFolder(label.title, kw[0] || '');
    if (!name) {
      skip.push(e.name);
      continue;
    }
    groups.set(name, (groups.get(name) || 0) + 1);
    todo.push({ file: full, name });
  }

  let moved = 0;
  const failed = [];
  if (apply) {
    for (const t of todo) {
      try {
        if (moveIntoSpeciesDir(t.file, dir, t.name).moved) moved += 1;
      } catch (err) {
        failed.push(`${path.basename(t.file)}：${err.message}`);
      }
    }
  }

  return {
    ok: true,
    applied: apply,
    willMove: todo.length,
    moved,
    failed,
    skipped: skip.length,
    groups: [...groups.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh')),
  };
}

/* ---------------- 和聚合台联动 ---------------- */

/**
 * 聚合台的端口。
 *
 * 用户很可能是在别的文件夹里双击聚合台的 exe，也可能同时开着一个源码版，
 * 端口不一定是 8791，所以这里按常见端口挨个探（并行，各自 800ms 超时，总共不到 1 秒）。
 * `--hub 8900` 明确指定了就只认那一个 —— 调试时不要被别的实例串了。
 */
const HUB_PORTS = (() => {
  const i = process.argv.indexOf('--hub');
  const fixed = i > -1 ? Number(process.argv[i + 1]) : 0;
  return fixed ? [fixed] : [8791, 8899, 8792];
})();
const HUB_HOME_DEFAULT = `http://127.0.0.1:${HUB_PORTS[0]}`;

/** 聚合台发布清单。装不上聚合台的人点「下载」时，用它换出当前版本的 exe 直链 */
const HUB_MANIFEST = (process.env.TAGDEN_HUB_MANIFEST || 'https://bioidhub-fsw.oss-cn-hangzhou.aliyuncs.com/latest.json').trim();

/** 命中的实例缓存 10 秒：连点两下按钮不用探两遍 */
let HUB_HIT = { at: 0, value: null };

async function probeHubPort(port) {
  const home = `http://127.0.0.1:${port}`;
  try {
    const r = await fetch(`${home}/api/status`, { signal: AbortSignal.timeout(800) });
    if (!r.ok) return { ok: false, port, reason: `HTTP ${r.status}` };
    const j = await r.json();
    const app = j.app || {};
    return {
      ok: true,
      port,
      home,
      name: app.name || '物种聚合台',
      version: app.version || '',
      openLocalImage: !!app.openLocalImage,
      // 认 ?sites=a,b,c 精确模型清单（1.0.40 起）。老版本只认 ?group=，那就退回按类群切
      openLocalSites: !!app.openLocalSites,
      // 认 postMessage 送图（1.0.44 起）：已经开着那一页时就不用再开新标签页
      acceptImageMessage: !!app.acceptImageMessage,
      sites: Array.isArray(j.sites) ? j.sites.map((s) => s.key).filter(Boolean) : [],
    };
  } catch {
    return { ok: false, port, reason: '连不上' };
  }
}

/** 探一下聚合台起没起、在哪个端口、是不是认 ?img= 的新版 */
async function hubProbe() {
  if (HUB_HIT.value && Date.now() - HUB_HIT.at < 10000) return HUB_HIT.value;
  const hits = await Promise.all(HUB_PORTS.map(probeHubPort));
  const ok = hits.find((h) => h.ok);
  if (ok) {
    HUB_HIT = { at: Date.now(), value: ok };
    return ok;
  }
  return { ok: false, tried: HUB_PORTS, error: `聚合台没在运行（试了 ${HUB_PORTS.map((p) => `127.0.0.1:${p}`).join('、')}）` };
}

/**
 * 聚合台最新版的下载信息：读它的清单，拼出**这台机器上能直接装的那一份**的绝对直链。
 *
 * Windows 给 exe（固定别名 bio-id-hub-win.exe，永远指向最新版，群发文案里贴一次就够）；
 * macOS 按芯片给 arm64 / x64 的 zip（也是固定名）。
 * 拿不到就回 null —— 界面上就只说「联系作者」，绝不给一个 404 链接。
 */
let HUB_DL = { at: 0, value: null };

function headOk(url) {
  return fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(1500) }).then(
    (r) => r.ok,
    () => false,
  );
}

async function hubDownloadInfo() {
  const ttl = HUB_DL.value ? 10 * 60 * 1000 : 60 * 1000;
  if (Date.now() - HUB_DL.at < ttl) return HUB_DL.value;

  const mac = process.platform === 'darwin';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  // mac 的清单是 latest-mac.json（只描述 main.js），版本号两边同步，取它只是为了不张冠李戴
  const manifestUrl = mac ? HUB_MANIFEST.replace(/latest(-mac)?\.json$/i, 'latest-mac.json') : HUB_MANIFEST;

  try {
    const r = await fetch(manifestUrl, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const m = await r.json();
    if (!m || !m.version) throw new Error('清单里没有 version');

    const base = new URL(manifestUrl).origin;
    const stable = mac ? `${base}/bio-id-hub-mac-${arch}.zip` : `${base}/bio-id-hub-win.exe`;
    // 固定别名没传过（老发布）就退回清单里那个带版本号的文件
    const fallback = m.url ? new URL(String(m.url), manifestUrl).href : '';
    const url = (await headOk(stable)) ? stable : fallback;
    if (!url) throw new Error('没有可用的下载地址');

    const info = {
      version: String(m.version || ''),
      // mac 的清单记的是 main.js 的大小，不是 zip 的；宁可不显示也别报个错的
      size: mac ? 0 : Number(m.size) || 0,
      pubDate: String(m.pubDate || ''),
      url,
      kind: mac ? 'zip' : 'exe',
      arch: mac ? arch : '',
    };
    HUB_DL = { at: Date.now(), value: info };
    return info;
  } catch {
    HUB_DL = { at: Date.now(), value: null };
    return null;
  }
}

/**
 * 「在聚合台查看这张」的链接。
 * 不光把图送过去，还要把两样东西一起带过去：
 *   group —— 这批照片是什么类群，不然聚合台会拿上次留下的模型（比如植物）跑昆虫照片；
 *   sites —— 标注工坊里现在**开着哪几个模型**，聚合台照着开，两边的结论才对得上。
 * 同站互斥和类群互斥交给聚合台自己压（它最清楚哪些能同时开），这里原样送过去。
 */
const PRESET_TO_GROUP = { insect: 'insect', plant: 'plant', bird: 'bird', fungi: 'fungi', herp: 'herp' };

async function apiHubLink(q) {
  const file = asImage(q.get('path'));
  const hub = await hubProbe();
  if (!hub.ok) {
    // 装上聚合台这件事不该让整个功能「报错就完了」：告诉用户为什么、去哪拿、怎么回来
    const err = bad('这一步要先装「物种鉴定聚合台」', 503);
    err.payload = { code: 'HUB_DOWN', tried: hub.tried, download: await hubDownloadInfo() };
    throw err;
  }
  if (!hub.openLocalImage) {
    const err = bad(`聚合台 v${hub.version || '?'} 还不支持从外部打开本地图片，升到最新版就有了`, 409);
    err.payload = { code: 'HUB_OLD', hub: { port: hub.port, version: hub.version }, download: await hubDownloadInfo() };
    throw err;
  }
  // 显式传 group 就听它的；否则用当前预置方案。auto 不带类群，保持聚合台原样
  const asked = String(q.get('group') || '').trim();
  const group = asked || PRESET_TO_GROUP[config.ui?.preset] || '';
  const preset = PRESETS.find((p) => p.key === config.ui?.preset);
  // 参与识别的模型（已按「有没有配好账号」过滤过），老版本聚合台不认这个参数就不带
  const carried = hub.openLocalSites ? presetSources(config.ui?.preset).sources : [];
  const qs = new URLSearchParams({ img: file });
  if (group) qs.set('group', group);
  if (carried.length) qs.set('sites', carried.join(','));
  return {
    ok: true,
    url: `${hub.home}/?${qs.toString()}`,
    hub,
    file,
    group,
    groupName: group ? preset?.name || group : '',
    sites: carried,
  };
}

/* ---------------- 静态资源 ---------------- */

function serveStatic(req, res, pathname) {
  let rel = pathname;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('bad path');
    return;
  }
  if (rel === '/') rel = '/index.html';
  // 打包成 exe 后 public/ 在内存里，源码运行才读磁盘 —— 由 lib/assets 统一处理
  const hit = ASSETS.get(rel);
  if (!hit) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
    return;
  }
  const buf = hit.body;
  res.writeHead(200, {
    'content-type': hit.mime || MIME[path.extname(rel).toLowerCase()] || 'application/octet-stream',
    'content-length': buf.length,
    'cache-control': 'no-cache',
  });
  res.end(buf);
}

function serveImage(req, res, q) {
  let full;
  try {
    full = asImage(q.get('path'));
  } catch (err) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end(err.message);
    return;
  }
  const st = fs.statSync(full);

  // 列表用的小图：优先吐相机自己嵌在 EXIF 里的缩略图（几 KB～几十 KB），
  // 没有就自动回退原图。像素没变过，所以可以放心让浏览器缓存一整天。
  if (q.get('thumb') === '1') {
    const tag = `"t${st.size}-${Math.round(st.mtimeMs)}"`;
    const cacheFile = thumbCacheFile(full, st);

    // 缩略图落 SSD 缓存：原图在 USB 机械盘上，每吐一张要开文件、找 EXIF 缩略图（冷读 ~30ms）。
    // 缓存以后滚动列表是毫秒级；文件名带大小+时间，原图一改缓存自然失效，不会串图。
    let buf = null;
    try {
      buf = fs.readFileSync(cacheFile);
    } catch {
      /* 没缓存，去原图里抽 */
    }
    if (!buf) {
      // 坏图/怪格式一律当作「没有缩略图」，回退原图，绝不让列表接口跟着 500
      const t = (() => {
        try {
          return EX.thumb(full);
        } catch {
          return null;
        }
      })();
      if (t && t.thumb) {
        buf = t.thumb;
        try {
          fs.writeFileSync(cacheFile, buf);
        } catch {
          /* 缓存目录不可写就每次现读，功能不受影响 */
        }
      }
    }
    if (buf) {
      if (req.headers['if-none-match'] === tag) {
        res.writeHead(304, { etag: tag, 'cache-control': 'private, max-age=604800, immutable' }).end();
        return;
      }
      res.writeHead(200, {
        'content-type': 'image/jpeg',
        'content-length': buf.length,
        'cache-control': 'private, max-age=604800, immutable',
        etag: tag,
        'x-thumb': '1',
      });
      res.end(buf);
      return;
    }
  }

  const etag = `"${st.size}-${Math.round(st.mtimeMs)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag }).end();
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
    'content-length': st.size,
    'cache-control': 'private, max-age=3600',
    etag,
  });
  fs.createReadStream(full).pipe(res);
}

/* ---------------- 路由 ---------------- */

function apiState() {
  const src = presetSources(config.ui?.preset);
  return {
    ok: true,
    version: VERSION,
    // 认自己用的唯一标识：端口被占时靠它分清「是另开的一个我」还是「另一个软件」
    app: { id: 'tagden', name: '物种标注工坊', version: VERSION },
    port: config.port,
    presets: PRESETS.map((p) => ({
      ...p,
      sources: p.sources,
      optional: p.optional || [],
      // 「默认开几个」按当前账号配置算，前端选方案时先给个预期
      ready: p.sources.filter(siteReady).length,
    })),
    current: { preset: src.preset, sources: src.sources, requested: src.requested, available: src.available },
    siteMeta: Object.values(SITE_META)
      .filter((m) => !m.verify)
      .map((m) => ({ key: m.key, name: m.name, group: m.group, auth: m.auth, ready: siteReady(m.key), note: m.note || '' })),
    ui: {
      preset: config.ui?.preset || 'auto',
      rename: !!config.ui?.rename,
      renameOrder: config.ui?.renameOrder === 'last' ? 'last' : 'first',
      renamePick: ['cn', 'latin', 'both'].includes(config.ui?.renamePick) ? config.ui.renamePick : 'cn',
      archive: !!config.ui?.archive,
      lastDir: config.ui?.lastDir || '',
    },
    hub: { port: HUB_PORTS[0], ports: HUB_PORTS, home: HUB_HOME_DEFAULT },
    // 更新：前端据此决定「要不要查、查出新版能不能自己装」
    update: {
      configured: Boolean(UPDATE_URL),
      mode: isSea ? 'exe' : isAppBundle ? 'bundle' : 'source',
      supported: Boolean(UPDATE_URL) && (isSea || isAppBundle),
    },
    secure: secure.dpapiAvailable(),
    lastDir: config.ui?.lastDir || '',
    places: places(),
  };
}

async function handleApi(req, res, pathname, q) {
  if (pathname === '/api/state') return sendJson(res, 200, apiState());

  // 盘符（左侧树的根）。卷标是后台查的，第一次可能还没到，前端据此再拉一次
  if (pathname === '/api/drives') {
    if (q.get('fresh') === '1') drivesCache = null; // 插拔了 U 盘，不要用一分钟前的缓存
    const labelsPending = !LABELS.size && process.platform === 'win32';
    if (labelsPending) loadDriveLabels().then(() => { drivesCache = null; });
    return sendJson(res, 200, { ok: true, drives: drives(), labelsPending });
  }

  // 树展开：只列子文件夹
  if (pathname === '/api/dirs') return sendJson(res, 200, await apiDirs(q));

  if (pathname === '/api/list') return sendJson(res, 200, await apiList(q));

  if (pathname === '/api/labels') return sendJson(res, 200, await apiLabels(q));

  if (pathname === '/api/verify') return sendJson(res, 200, await apiVerify(q));

  if (pathname === '/api/label') {
    const file = asImage(q.get('path'));
    return sendJson(res, 200, { ok: true, label: IMG.readLabel(file) });
  }

  if (pathname === '/api/identify' && req.method === 'POST') {
    return sendJson(res, 200, await apiIdentify(await readJson(req)));
  }

  if (pathname === '/api/write' && req.method === 'POST') {
    return sendJson(res, 200, await apiWrite(await readJson(req)));
  }

  if (pathname === '/api/export' && req.method === 'POST') {
    return sendJson(res, 200, await apiExport(await readJson(req)));
  }

  if (pathname === '/api/archive' && req.method === 'POST') {
    return sendJson(res, 200, await apiArchive(await readJson(req)));
  }

  // 单张图的拍摄时间 / 坐标，面板上显示用（不带缩略图，别把几 KB 的图塞进 JSON）
  if (pathname === '/api/exif') {
    const file = asImage(q.get('path'));
    const m = EX.meta(file);
    return sendJson(res, 200, {
      ok: true,
      file,
      hasExif: !!m.ok,
      dateTime: m.dateTime || '',
      lat: m.lat,
      lon: m.lon,
      alt: m.alt,
      orientation: m.orientation || 1,
      make: m.make || '',
      model: m.model || '',
      hasThumb: !!m.thumb,
    });
  }

  if (pathname === '/api/hub/link') {
    return sendJson(res, 200, await apiHubLink(q));
  }

  /* ---------------- 自动更新 ----------------
   * 和聚合台同一套：查清单 → 下载校验 → 换掉自身 → 重启。
   * 源码运行时 supported=false，前端只会提示「这是源码版，不自动更新」。
   */
  if (pathname === '/api/update/check' && req.method === 'GET') {
    updater.resetError();
    const info = await updater.check({ force: q.get('force') === '1' });
    return sendJson(res, 200, { ...info, progress: updater.status() });
  }

  if (pathname === '/api/update/progress' && req.method === 'GET') {
    return sendJson(res, 200, updater.status());
  }

  if (pathname === '/api/update/download' && req.method === 'POST') {
    try {
      const r = await updater.download();
      return sendJson(res, 200, r);
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: err.message || '下载失败' });
    }
  }

  if (pathname === '/api/update/apply' && req.method === 'POST') {
    try {
      const r = await updater.apply();
      // 先把响应发回去，再让进程退出 —— 反过来的话浏览器只会看到连接被重置
      return sendJson(res, 200, r, () => {
        setTimeout(() => process.exit(0), 300);
      });
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: err.message || '安装失败' });
    }
  }

  if (pathname === '/api/config' && req.method === 'POST') {
    const body = await readJson(req);
    if (body.preset) {
      const hit = PRESETS.find((p) => p.key === body.preset);
      if (!hit) return sendJson(res, 400, { ok: false, error: '未知方案' });
      config.ui = { ...(config.ui || {}), preset: body.preset };
    }
    // 用户点了某个站点的开关：按方案记一份，换回来还是他上次那套
    if (Array.isArray(body.picks)) {
      const { preset, all } = presetAll(config.ui?.preset);
      const picks = body.picks.filter((k) => all.includes(k));
      config.ui = { ...(config.ui || {}), picks: { ...(config.ui?.picks || {}), [preset]: picks } };
    }
    if (Array.isArray(body.sources)) config.ui = { ...(config.ui || {}), sources: body.sources };
    if (typeof body.rename === 'boolean') config.ui = { ...(config.ui || {}), rename: body.rename };
    if (body.renameOrder === 'first' || body.renameOrder === 'last') {
      config.ui = { ...(config.ui || {}), renameOrder: body.renameOrder };
    }
    if (['cn', 'latin', 'both'].includes(body.renamePick)) {
      config.ui = { ...(config.ui || {}), renamePick: body.renamePick };
    }
    if (typeof body.archive === 'boolean') {
      config.ui = { ...(config.ui || {}), archive: body.archive };
    }
    persistConfig();
    return sendJson(res, 200, apiState());
  }

  return sendJson(res, 404, { ok: false, error: '未知接口' });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = u.pathname;
  try {
    // 只服务本机：挡掉 DNS rebinding 之类的跨站访问
    const host = String(req.headers.host || '');
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('只允许本机访问');
      return;
    }
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname, u.searchParams);
    if (pathname === '/img') return serveImage(req, res, u.searchParams);
    return serveStatic(req, res, pathname);
  } catch (err) {
    // payload 是给前端做后续动作用的（比如「聚合台没装」时附上下载直链），不覆盖 ok/error
    if (!res.headersSent) sendJson(res, err.status || 500, { ok: false, error: err.message || '服务器内部错误', ...(err.payload || {}) });
    else res.end();
  }
});

const portArg = process.argv.indexOf('--port');
const port = (portArg > -1 ? Number(process.argv[portArg + 1]) : 0) || Number(process.env.TAGDEN_PORT) || APP_PORT;

// 更新后新进程启动时，老进程可能还没退干净、端口仍被占着 —— 这时要等一下重试，
// 不能像「重复双击」那样直接退出。
let bindRetries = 0;
const IS_UPDATED = process.env.TAGDEN_UPDATED === '1';

/**
 * 谁占着这个端口？
 *
 * 认两种就够了：同一个程序（重复双击 / 更新后新旧进程交叠）、
 * 以及另一个程序（聚合台 ↔ 标注工坊）。两个软件的探活接口不一样，都试一遍；
 * 老版本没有 app.id，退回靠返回体的结构认。
 */
async function identifyOccupant(p) {
  const probes = [
    { path: '/api/state', fallback: { id: 'tagden', name: '物种标注工坊' } },
    { path: '/api/status', fallback: { id: 'bio-id-hub', name: '物种鉴定聚合台' } },
  ];
  for (const pr of probes) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}${pr.path}`, { signal: AbortSignal.timeout(700) });
      if (!r.ok) continue;
      const j = await r.json();
      const app = (j && j.app) || {};
      if (app.id) return { id: app.id, name: app.name || pr.fallback.name, version: app.version || '' };
      if (j && Array.isArray(j.presets) && j.hub) return { id: 'tagden', name: '物种标注工坊', version: j.version || '' };
      if (j && j.deepseek && j.config) return { id: 'bio-id-hub', name: '物种鉴定聚合台', version: app.version || '' };
    } catch {
      /* 换下一个接口 */
    }
  }
  return null;
}

// 端口被占多半是「已经开着一个了」：双击 exe 第二次、或者源码版还没关。
// 这时候不该甩一段堆栈让用户害怕；但也要分清占端口的是自己还是另一个软件 ——
// 是另一个软件就得说清楚，别把用户扔到别人的页面上。
server.on('error', async (err) => {
  if (err.code === 'EADDRINUSE') {
    if (IS_UPDATED && bindRetries < 40) {
      bindRetries += 1;
      setTimeout(() => server.listen(port, '127.0.0.1'), 250);
      return;
    }

    const who = await identifyOccupant(port);
    console.log('');
    if (who && who.id === 'tagden') {
      console.log(`  端口 ${port} 上已经开着一个标注工坊${who.version ? `（v${who.version}）` : ''}，直接给你打开浏览器。`);
      console.log('  如果那个窗口是旧的、想换成现在这个，先把它关掉再启动。');
      openBrowser(`http://127.0.0.1:${port}`);
      setTimeout(() => process.exit(0), 1500);
      return;
    }
    if (who) {
      console.log(`  ⚠ 端口 ${port} 被「${who.name}」占着 —— 两个软件不能用同一个端口。`);
      console.log('    请先关掉那个软件的窗口，再重新双击本程序。');
    } else {
      console.log(`  ⚠ 端口 ${port} 被别的程序占用了（不是本程序）。`);
      console.log('    关掉占用的程序再启动，或用  --port 7802  换个端口。');
    }
    console.log('');
    setTimeout(() => process.exit(1), 1500);
    return;
  }
  console.error('');
  console.error('  启动失败：' + err.message);
  console.error('');
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  console.log('');
  console.log('  物种标注工坊 tagden  v' + VERSION + (isSea ? '  （单文件 exe）' : ''));
  console.log('  ────────────────────────────────────');
  console.log(`  打开浏览器   http://127.0.0.1:${port}`);
  console.log(`  配置目录     ${DATA}`);
  if (DATA_NOTE) console.log(`               （${DATA_NOTE}）`);
  console.log(`  缓存目录     ${CACHE}`);
  console.log('');
  console.log('  Ctrl+C 退出（关掉这个黑窗口也会退出）');
  console.log('');

  // 需要账号的两个站点静默登录一次，省得第一次识别才现登
  (async () => {
    for (const key of ['inaturalist', 'duoshi']) {
      try {
        await sites.login(key);
        console.log(`  [ok] ${SITE_META[key].name} 已登录`);
      } catch (err) {
        console.log(`  [!!] ${SITE_META[key].name} 登录失败：${err.message}`);
      }
    }
  })();

  openBrowser(`http://127.0.0.1:${port}`);

  // 缩略图缓存攒太多会拖慢目录列举，后台慢慢清（不阻塞启动）
  setTimeout(() => {
    const n = pruneThumbs();
    if (n) console.log(`  清理缩略图缓存 ${n} 个`);
  }, 5000).unref?.();
});

/* 退出前把攒着没落盘的标签缓存写掉，下次打开少读一遍硬盘 */
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try {
      LC.flushAll();
    } catch {}
    process.exit(0);
  });
}

/**
 * 缩略图缓存清理：一张图一个文件，翻过的文件夹多了会攒出几万个小文件。
 * 超过上限就按「最久没被读过」删一批，简单粗暴但不影响正确性（删了下次现抽）。
 */
function pruneThumbs(limit = 40000) {
  let names;
  try {
    names = fs.readdirSync(THUMBS);
  } catch {
    return 0;
  }
  if (names.length <= limit) return 0;
  const stat = names.map((n) => {
    const p = path.join(THUMBS, n);
    try {
      return { p, at: fs.statSync(p).atimeMs || 0 };
    } catch {
      return null;
    }
  });
  const dead = stat
    .filter(Boolean)
    .sort((a, b) => a.at - b.at)
    .slice(0, names.length - limit);
  for (const d of dead) {
    try {
      fs.unlinkSync(d.p);
    } catch {}
  }
  return dead.length;
}

/** 双击 start.bat 时顺手把浏览器叫起来；带 --no-open 就不开 */
function openBrowser(url) {
  if (process.argv.includes('--no-open')) return;
  try {
    if (process.platform === 'win32') {
      require('node:child_process').spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      require('node:child_process').spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      require('node:child_process').spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    /* 打不开就让用户手动点 */
  }
}
