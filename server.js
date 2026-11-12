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
const zlib = require('node:zlib');
const { URL } = require('node:url');

const { Sites, SITE_META } = require('./lib/adapters');
const { aggregate, buildVerdict } = require('./lib/aggregate');
// 学名旁那几个查询小标用的模块（从聚合台并进来）：
//   INAT 属名→taxon_id、PPBC 地区→植物智参数、EBIRD 本地区近14天记录、
//   GNAT 自然在线名录里某属有哪些种、GBIFDS 某属在 GBIF 本地区有哪些种。
// 注意 GNAT 与下面的 NAT 不是一回事：NAT 是登录自然在线管相册的账号客户端。
const INAT = require('./lib/inat');
const PPBC = require('./lib/ppbc');
const EBIRD = require('./lib/ebird');
const GNAT = require('./lib/nature');
const GBIFDS = require('./lib/gbifds');
const IMG = require('./lib/imgmeta');
const EX = require('./lib/exif');
const secure = require('./lib/secure');
const SEED_CIPHER = require('./lib/seed');
const LC = require('./lib/labelcache');
const TAXO = require('./lib/taxonomy');
const STATS = require('./lib/stats');
const LIB = require('./lib/library');
const REGIONS = require('./lib/regions');
const ASSETS = require('./lib/assets');
// 自然在线（账号相册）—— 复用 nature-client 项目里那套模块，本文件只管路由和任务
const NAT = require('./lib/nature-store');
// 内置「识别账号」：只给识别用，相册/写回鉴定仍走 NAT（用户自己登录）
const NATSHARE = require('./lib/nat-share');
// 照片评分（内置）：算法在浏览器 Worker 里跑，这里只管缓存、星级、连拍分组和 AI 设置
const SCORE = require('./lib/score-store');
const SCAI = require('./lib/score-ai');
// 本地大模型运行库（llama-server）：内置 Windows CPU 包，第一次用时自己解压再拉起
const LLAMA = require('./lib/llama');
// 识别结果缓存（省站点额度、重复识别秒回）
const IDC = require('./lib/identify-cache');
// 合并中文名 → 大陆规范名（《中国生物物种名录》CoL China / 物种2000中国节点）。
// 名录索引内置在程序里，按学名本地查表、覆盖识别站点回的中文名（台名/英名）；
// 不联网、不要 API Key、不要 R，纯本地、不向外上报。
const COLCN = require('./lib/colcn');
// 三个目录都由 env 统一裁决：源码跑是项目根目录，exe 跑是 exe 所在目录
const { isSea, isAppBundle, APP_DIR, DATA_DIR: DATA, DATA_NOTE } = require('./lib/env');

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
// 浏览器把本机文件夹拖进来时，文件先落在这儿，再交给上传任务；跑完就删
const NAT_DROP = path.join(CACHE, 'nature-drop');
const CFG_FILE = path.join(DATA, 'config.json');
const UNDO_FILE = path.join(DATA, 'undo.json');
// 本机日志：双击 exe 时控制台会一闪而过，崩溃/接口错误只能靠这个排查。
// 只记版本、路径和异常，不记账号、令牌和请求体。
const LOG_DIR = path.join(DATA, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'app.log');
LC.init(path.join(CACHE, 'labels'));
// 分类阶元（学名 → 界门纲目科属）缓存，查过就不再联网
TAXO.init(path.join(CACHE, 'taxonomy'));
// 自然在线：令牌跟 config.json 一起放 data/，图片缓存跟缩略图一起放本机缓存目录
NAT.init({ dataDir: DATA, cacheDir: CACHE });
// 照片评分：缓存放 CACHE/score/，AI 的 Key 加密放 data/score-ai.json
SCORE.init({ dataDir: DATA, cacheDir: CACHE });
// 本地大模型运行库：解压到 CACHE/llama-runtime/，pid 记在 data/llama.pid
LLAMA.init({ cacheDir: CACHE });
IDC.init({ dir: path.join(CACHE, 'identify') });
LIB.init({ cacheDir: CACHE });
try {
  fs.mkdirSync(THUMBS, { recursive: true });
} catch {}

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.tif', '.tiff', '.bmp', '.gif']);
const MAX_STAT_FILES = 5000; // 统计扫描上限，防止超大目录把主程序卡死
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

/*
 * 内嵌默认账号（lib/seed.js）
 *
 * 和聚合台一样，种子是「机器无关」的密文（kdf=port，只用 lib/secure.js 的内嵌主密钥），
 * 所以换一台电脑第一次打开也能解开 —— 拿到 exe 的人不用先去设置里填一堆账号就能识别。
 *
 * 优先级：本机 config.json 里填过的 > 内嵌种子。种子只补「空着的字段」，
 * 用户自己改过的一律不动。换账号时用 tools/seal.js 重新生成 seed.js 再打包。
 */
let SEED = { sites: {} };
try {
  const opened = secure.open(SEED_CIPHER);
  if (opened.ok && opened.value) SEED = opened.value;
  else console.log(`  [!!] 内嵌默认账号解密失败：${opened.error || '未知原因'}（照常启动，只是不带默认账号）`);
} catch (err) {
  console.log(`  [!!] 内嵌默认账号读取失败：${err.message}（照常启动，只是不带默认账号）`);
}

/** 把种子里有、本机没填的字段补上；本机已有值永远优先 */
function applySeed(sites) {
  const out = sites && typeof sites === 'object' ? sites : {};
  for (const [site, def] of Object.entries(SEED.sites || {})) {
    if (!def || typeof def !== 'object') continue;
    const cur = out[site];
    if (!cur || typeof cur !== 'object') {
      out[site] = { ...def };
      continue;
    }
    for (const [k, v] of Object.entries(def)) {
      if (cur[k] === undefined || cur[k] === '' || cur[k] === null) cur[k] = v;
    }
  }
  return out;
}

function loadConfig() {
  const fresh = { port: APP_PORT, sites: {}, sessions: {}, ui: { preset: 'plant', sources: null } };
  let merged = fresh;
  if (fs.existsSync(CFG_FILE)) {
    const raw = fs.readFileSync(CFG_FILE, 'utf8');
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
  }
  // 端口不采信配置里的旧值：两个便携版共用一份配置时，这里可能已经被另一个软件
  // 写成了它的端口（8791），照着用就会两个软件抢同一个端口。
  merged.port = APP_PORT;
  // 新用户第一次打开：账号由内嵌种子补齐，直接就能用
  merged.sites = applySeed(merged.sites);
  return merged;
}

const config = loadConfig();
// 用户在「自然在线」里退出过登录的话，种子里烧的那枚旧令牌不许再顶上：
// 不然退出后识别模块（xingse 站点）还接着用这个账号，重启后还会被种子悄悄登回去。
if (NAT.loggedOut()) {
  config.sites.xingse = { ...(config.sites.xingse || {}), token: '', tokenAt: 0 };
}

/* 老版本（≤0.6.14）把一枚共用的自然在线账号烧进种子当「登录态」用，随 exe 分发（谁都能提取出来用）。
   0.6.15 起这枚账号不再出现在配置里：登录框让用户填自己的账号密码。
   0.6.20 起它改成「识别专用」重新进种子（lib/seed.js 的 natureShare 键），只给识别，
   不参与相册，所以这里该清的还是清。
   升级上来的老用户，本机配置里残留的共用账号/令牌按 SHA-256 指纹清一次
   ——只留指纹不存原文，且打上标记只清一次，用户之后登录自己的账号不会再被清。 */
let configDirty = false;
let persistTimer = null;

const SEED_XINGSE_FP = {  user: 'a5564000ec86e69ccd928a109e15f5f5edbbae1f637ff16aa0d5feadb0b4e642',
  pass: '420aadc19d0d12c197d143fc3b34389ea1f0968d0b7dc2cb63e9c770cb9ad763',
  token: '4e05084e0d48d362c0e6c9ddb8f69daac36e6c1a13986c6e50ba6eedbed2e8c7',
};
const sha256hex = (s) => require('node:crypto').createHash('sha256').update(String(s), 'utf8').digest('hex');
if (!config.seedXingsePurged) {
  const xs = config.sites && config.sites.xingse;
  let purged = false;
  if (xs && typeof xs === 'object') {
    const next = { ...xs };
    if (next.token && sha256hex(next.token) === SEED_XINGSE_FP.token) { next.token = ''; next.tokenAt = 0; purged = true; }
    if (next.username && sha256hex(next.username) === SEED_XINGSE_FP.user) { next.username = ''; purged = true; }
    if (next.password && sha256hex(next.password) === SEED_XINGSE_FP.pass) { next.password = ''; purged = true; }
    if (purged) config.sites.xingse = next;
  }
  const fileTok = NAT.readToken();
  if (fileTok && sha256hex(fileTok) === SEED_XINGSE_FP.token) {
    NAT.writeToken('');
    purged = true;
  }
  if (purged) console.log('  [i] 已清除旧版本内置的自然在线共用账号，请在「自然在线」页用你自己的账号登录');
  config.seedXingsePurged = true;
  persistConfig();
}
// GBIF 面板的中文名补全 / 归纳用 DeepSeek。GBIF 自己的读取接口是公开的、不需要 Key，
// 要 Key 的是这一步；跟站点账号一起加密落在 data/config.json，浏览器端只拿得到 hasApiKey。
config.deepseek = { apiKey: '', model: 'deepseek-chat', ...(config.deepseek || {}) };
let sites = new Sites(config);

// 大陆中文名录随程序内置，不需要任何配置，也不写进 config.json。
// 这里只预热一次，让启动日志和 /api/state 就能报出版本与收录条数；真正查表是同步的。
COLCN.init();

function persistConfig() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  configDirty = true;
  fs.mkdirSync(DATA, { recursive: true });
  const payload = { port: config.port, sites: config.sites, sessions: config.sessions, ui: config.ui, deepseek: config.deepseek, seedXingsePurged: config.seedXingsePurged };
  const tmp = `${CFG_FILE}.tmp`;
  fs.writeFileSync(tmp, secure.seal(payload), 'utf8');
  fs.renameSync(tmp, CFG_FILE);
  configDirty = false;
}

/**
 * 配置加密要走一次系统凭据（每次几百毫秒），而「列目录」这种高频操作每次都会
 * 顺手把 lastDir 记下来。全部立刻落盘的话，光是翻文件夹就要等半秒。
 * 折中：合并 1.2 秒后再写，翻得快时只写最后一次。
 */
function schedulePersist(delay = 1200) {
  configDirty = true;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      persistConfig();
    } catch (err) {
      // 写不进去下次还会再试，但至少留一条线索
      logLine('warn', '配置落盘失败（稍后重试）：' + (err.stack || err.message));
    }
  }, delay);
  if (persistTimer.unref) persistTimer.unref();
}

/**
 * 退出前把攒着没写的配置立刻落盘。
 * 关闭窗口的时间点常常落在 1.2 秒的合并窗口里，不 flush 的话最后一次改的偏好会丢。
 */
function flushConfig() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (!configDirty) return false;
  try {
    persistConfig();
    return true;
  } catch (err) {
    logLine('error', '退出前配置落盘失败：' + (err.stack || err.message));
    return false;
  }
}

/**
 * 「检索地区」：只决定结果里 iNat / PPBC / 自然在线 / GBIF 那几个小标跳到什么范围，
 * 不参与识别。前端传了就整体替换，没传才用存下来的那份 —— 三项必须一起换，
 * 不能逐项兜底（选了「全世界」只传 code 时，placeId 一兜底就变回上次的武夷山，
 * 于是按福建算了）。
 */
function linkPlaceOf(sp) {
  const conf = config.ui?.linkPlace || {};
  const qCode = String(sp.get('place') || '').trim();
  const qId = Number(sp.get('placeId')) || 0;
  const qName = String(sp.get('placeName') || '').trim();
  const explicit = Boolean(qCode || qId || qName);
  return {
    code: explicit ? qCode : String(conf.code || ''),
    placeId: explicit ? qId : Number(conf.placeId) || 0,
    placeName: explicit ? qName : String(conf.placeName || ''),
  };
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
  // 自然在线：识别走包里内置的账号（lib/nat-share.js），所以没登录自己的账号也算可用；
  // 相册/写回鉴定才需要登录，那一块在 /api/nat/status 里单独判断。
  if (key === 'xingse') return !!(c.token || NATSHARE.has());
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
    key: 'plant',
    name: '植物',
    hint: '专问植物，通用站兜底',
    sources: ['iplant', 'plantnet', 'quarryman-plant', 'quarryman-rose', 'duoshi-plant', 'baidu-plant', 'xingse', 'inaturalist'],
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

/**
 * 「点一次算一轮」的模型（目前只有豆包，就是各方案的 optional）。
 *
 * 规矩：默认灰着，**用户点一下才亮**；一换方案（= 换类群）就自动收回，要再用得再点一次。
 * 做法是**不写进 `config.ui.picks`**，只记在这个进程的内存里 ——
 * 一旦落盘，下次打开程序、或者换个方案再切回来，它就自己亮着了，
 * 等于在用户没点的情况下又悄悄开始按次计费。
 */
const ONE_SHOT_SITES = new Set(PRESETS.flatMap((p) => p.optional || []));
let oneShotOn = new Set();

function presetSources(presetKey) {
  const { preset, def, all } = presetAll(presetKey);
  // 用户在这个方案里手动关掉/打开过的，优先于默认；换方案再换回来还认得
  const picked = config.ui?.picks?.[preset];
  const stored = Array.isArray(picked) ? picked.filter((k) => all.includes(k)) : def;
  // 一次性模型（豆包）不看历史，只认内存里这一轮点开的 → 换方案/重启自动变灰
  const chosen = all.filter((k) => (ONE_SHOT_SITES.has(k) ? oneShotOn.has(k) : stored.includes(k)));
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

/* ---------------- 日志 ---------------- */

const LOG_MAX_BYTES = 2 * 1024 * 1024;
let logBytes = -1;

/**
 * 追加一行日志到 data/logs/app.log。
 *
 * 同步写：崩溃/退出路径上也能落盘；失败就静默 —— 日志本身绝不能拖垮程序。
 * 超过 2 MB 轮转成 app.log.1（只留一代，桌面工具不需要长期归档）。
 */
function logLine(level, msg) {
  try {
    const line = `[${new Date().toISOString()}] [${level}] ${String(msg == null ? '' : msg)}\n`;
    fs.mkdirSync(LOG_DIR, { recursive: true });
    if (logBytes < 0) {
      try { logBytes = fs.statSync(LOG_FILE).size; } catch { logBytes = 0; }
    }
    const bytes = Buffer.byteLength(line);
    if (logBytes + bytes > LOG_MAX_BYTES) {
      try { fs.rmSync(`${LOG_FILE}.1`, { force: true }); } catch {}
      try { fs.renameSync(LOG_FILE, `${LOG_FILE}.1`); } catch {}
      logBytes = 0;
    }
    fs.appendFileSync(LOG_FILE, line, 'utf8');
    logBytes += bytes;
  } catch {
    /* 只读盘 / 权限不足：日志写不进去不影响主流程 */
  }
}

/**
 * 本机 API 的同源校验。
 *
 * 只监听 127.0.0.1 挡不住 CSRF：任意网页都能让浏览器向本机发 POST。
 * 现代浏览器会带 Sec-Fetch-Site / Origin，这里只要发现是跨站就直接拒绝；
 * curl、更新探活这类非浏览器请求没有这两个头，照常放行。
 */
function isSameOrigin(req) {
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = String(req.headers.origin || '');
  if (!origin) return true;
  try {
    return new URL(origin).host.toLowerCase() === String(req.headers.host || '').toLowerCase();
  } catch {
    return false;
  }
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
  const raw = String(p);
  let full = path.resolve(raw);
  // 兼容旧前端：早期 mac 版把 /Users/… 写成 \Users\…（前端无条件把 / 换成 \），
  // 在 POSIX 上反斜杠只是普通字符，整棵文件夹树会全部打不开。这里救一次，
  // 让没重新打包的老 .app 也能恢复；Windows 上绝不做这个转换。
  if (!fs.existsSync(full) && process.platform !== 'win32' && raw.includes('\\')) {
    const fixed = raw.replace(/\\/g, '/');
    if (fs.existsSync(fixed)) full = path.resolve(fixed);
  }
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
 *   cn      只用中文名（没有就退到学名）
 *   latin   只用学名（没有就退到中文名）
 *   both    中文名_学名
 *   latinCn 学名_中文名（和 both 反过来）
 */
function speciesLabel(cn, latin, pick) {
  const c = safeName(cn);
  const l = safeName(latin);
  if (pick === 'latin') return l || c;
  if (pick === 'both') return c && l ? `${c}_${l}` : c || l;
  if (pick === 'latinCn') return c && l ? `${l}_${c}` : l || c;
  return c || l;
}

/** 「只要物种名」时目标重名：在后面加 _2、_3…，绝不覆盖别人的照片 */
function uniquePathNumbered(target) {
  if (!fs.existsSync(target)) return target;
  const ext = path.extname(target);
  const stem = path.basename(target, ext);
  const dir = path.dirname(target);
  for (let i = 2; i < 200; i += 1) {
    const p = path.join(dir, `${stem}_${i}${ext}`);
    if (!fs.existsSync(p)) return p;
  }
  throw bad('同名文件太多，没有可用的新名字');
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
 * 「每个种一个文件夹」时的物种文件夹名：中文 + 学名，和分类阶元文件夹「中文 拉丁」保持一致；
 * 只有一种就只留那一种。种名靠它区分同属的不同物种，所以能凑出「中文 拉丁」就尽量凑。
 */
function speciesSegName(cn, latin) {
  const c = safeName(cn);
  const l = safeName(latin);
  if (c && l) return `${c} ${l}`;
  return c || l;
}

/**
 * 把文件挪进 rootDir/<分段1>/<分段2>/…/ 。已经在里面就原地不动。
 * 目标位置有同名文件时加序号，绝不覆盖别人的照片。
 */
function moveIntoDir(file, rootDir, segments) {
  const parts = (Array.isArray(segments) ? segments : [segments]).map(safeName).filter(Boolean);
  if (!parts.length) return { path: file, moved: false, folder: '' };
  const box = path.join(rootDir, ...parts);
  const rel = parts.join('/');
  if (path.dirname(file).toLowerCase() === box.toLowerCase()) return { path: file, moved: false, folder: rel };
  fs.mkdirSync(box, { recursive: true });
  const target = uniquePath(path.join(box, path.basename(file)));
  fs.renameSync(file, target);
  return { path: target, moved: true, folder: rel };
}

/**
 * 和 moveIntoDir 一样，只是复制过去、源文件留着。
 * 用在「归并到指定的总文件夹」：把散落各处的照片收进同一棵分类树，原来的目录不动。
 * 目标重名照样加序号，不会覆盖已有文件。
 */
function copyIntoDir(file, rootDir, segments) {
  const parts = (Array.isArray(segments) ? segments : [segments]).map(safeName).filter(Boolean);
  if (!parts.length) return { path: file, copied: false, folder: '' };
  const box = path.join(rootDir, ...parts);
  const rel = parts.join('/');
  fs.mkdirSync(box, { recursive: true });
  const target = uniquePath(path.join(box, path.basename(file)));
  fs.copyFileSync(file, target);
  return { path: target, copied: true, folder: rel };
}

/**
 * 归档的目录层级：界/门/纲/目/科/属，文件夹名写成「中文 拉丁」（见 lib/taxonomy.js）。
 * 默认只到属 —— 同属的物种归进同一个属文件夹，种名靠文件名区分。
 * bySpecies=true 时再往下一级到 种（界/门/纲/目/科/属/种），每个物种一个文件夹。
 * 查不到分类（没学名、没联网、iNat 和 GBIF 都没有）时退回「未分类/<物种名>」，
 * 照片照样搬得动，只是位置不理想，界面上会提示有多少张是这样。
 */
function archiveSegments(rec, t, bySpecies) {
  const segs = TAXO.pathSegments(rec);
  if (segs.length) {
    if (bySpecies) {
      const sp = speciesSegName(t.cn, t.latin);
      if (sp) segs.push(sp);
    }
    return segs;
  }
  return ['未分类', t.species];
}

/** 从关键词里挑学名：首字母大写的拉丁词，挑不到就用第一个关键词 */
function pickLatin(keywords) {
  const list = (keywords || []).map((k) => String(k || '').trim()).filter(Boolean);
  return list.find((k) => /^[A-Z][a-z]+\b/.test(k)) || list[0] || '';
}

/** 分类缓存的键：有学名用学名，只有中文名就用 'cn:中文名'（和 lib/taxonomy.js 一致） */
function taxoKey(latin, cn) {
  const l = String(latin || '').trim();
  if (l) return l.toLowerCase();
  const c = String(cn || '').trim();
  return c ? `cn:${c.toLowerCase()}` : '';
}

/** 单个物种查分类（命中缓存就不联网）。查不到返回 null，绝不抛错 —— 归档不能被网络拖垮。 */
async function lookupTaxonomy(latin, cn) {
  const key = taxoKey(latin, cn);
  if (!key) return null;
  try {
    const m = await TAXO.resolve([{ latin: String(latin || '').trim(), cn: String(cn || '').trim() }]);
    return m.get(key) || null;
  } catch {
    return null;
  }
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
function buildName(base, labels, order, suffix = '') {
  const list = [...new Set((Array.isArray(labels) ? labels : [labels]).map((x) => safeName(x)).filter(Boolean))];
  if (!list.length) return base;
  const primary = list[0];
  // 「只要物种名」：不拼原名；填了自定后缀就带上，没填则由 uniquePathNumbered 加 _2、_3…
  if (order === 'only') {
    const tail = safeName(suffix);
    return tail ? `${primary}_${tail}` : primary;
  }
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

/* ---------------- 哪些目录不进树 ----------------
 * 两类：
 *   ① 名字有规律的系统目录 —— 以 . 开头的隐藏目录（.photo_cache、.Trashes）、
 *      以 $ 开头的（$RECYCLE.BIN、$SysReset）；
 *   ② 名字固定的系统/安装目录 —— 回收站、系统卷信息、恢复分区、性能日志、
 *      MSI 安装临时目录等。这些点了只会报「没有权限」，白占位置还容易被误点。
 *
 * 只藏「身份明确」的：Windows、Program Files、Users、ProgramData 这些还留着，
 * 用户想翻还是能翻进去。判断一律用小写比较，Windows 上大小写不敏感。
 */
const HIDDEN_PREFIX = /^[.$]/;
const HIDDEN_NAMES = new Set([
  'system volume information', // 系统还原/索引
  'recycler', // 老版 Windows 回收站
  'recycled', // 更老的回收站
  'krecycle', // 金山（WPS/毒霸）的回收站
  'recovery', // 恢复分区里的还原点
  'perflogs', // 性能监视器的日志
  'config.msi', // 安装程序临时目录，装完也不删
  'msocache', // Office 安装缓存，权限受限
  'documents and settings', // 老用户目录的联接点，点进去没权限
]);

/** 这个目录名要不要藏起来 */
function isHiddenDir(name) {
  return HIDDEN_PREFIX.test(name) || HIDDEN_NAMES.has(name.toLowerCase());
}

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
    .filter((e) => e.isDirectory() && !isHiddenDir(e.name))
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
async function apiDirs(q) {
  const dir = asDir(q.get('path'));
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory() && !isHiddenDir(e.name))
    .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
    .sort((a, b) => collator.compare(a.name, b.name));
  const parent = path.dirname(dir);
  return { ok: true, path: dir, parent: parent === dir ? null : parent, dirs };
}

/**
 * 列出某个目录下面所有子文件夹（递归，默认 6 层、最多 500 个）。
 * 归档弹层用它给用户勾选「要重排哪几个文件夹」—— 只列目录，不读图片，很快。
 */
async function apiSubdirs(q) {
  const dir = asDir(q.get('path'));
  const maxDepth = Math.min(Math.max(Number(q.get('depth')) || 6, 1), 10);
  const list = [];
  const queue = [{ d: dir, rel: '', depth: 0 }];
  while (queue.length) {
    const { d, rel, depth } = queue.shift();
    let ents = [];
    try {
      ents = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (!e.isDirectory() || isHiddenDir(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      list.push({ name: e.name, rel: r, path: path.join(d, e.name), depth: depth + 1 });
      if (list.length >= 500) return { ok: true, path: dir, dirs: list, truncated: true };
      if (depth + 1 < maxDepth) queue.push({ d: path.join(d, e.name), rel: r, depth: depth + 1 });
    }
  }
  return { ok: true, path: dir, dirs: list, truncated: false };
}

/**
 * 列一个文件夹里的图片绝对路径，deep=1 时连子文件夹一起。
 *
 * 只给「把左边文件夹拖到右边相册」用：拖拽上传不需要体积/标签，一次 readdir
 * 拿完就走，USB 机械盘上也不会因为逐张 stat 而卡住。
 */
async function apiImages(q) {
  const dir = asDir(q.get('path'));
  const deep = q.get('deep') === '1';
  const max = Math.min(Math.max(Number(q.get('max')) || 4000, 1), 20000);
  const out = [];
  let truncated = false;
  const queue = [dir];
  let guard = 0;
  while (queue.length && !truncated) {
    const d = queue.shift();
    if (guard > 3000) break; // 目录数兜底，别被奇怪的结构拖死
    guard += 1;
    let ents;
    try {
      ents = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (e.isDirectory()) {
        if (deep && !isHiddenDir(e.name)) queue.push(path.join(d, e.name));
        continue;
      }
      if (e.name.startsWith('.') || !IMAGE_EXT.has(path.extname(e.name).toLowerCase())) continue;
      if (out.length >= max) { truncated = true; break; }
      out.push(path.join(d, e.name));
    }
  }
  out.sort((a, b) => collator.compare(a, b));
  return { ok: true, path: dir, name: path.basename(dir) || dir, count: out.length, truncated, files: out };
}

/**
 * 评分页的「上一层 / 本层图片数 / 子文件夹」。
 * 子文件夹带上本层图片数，让用户一眼知道哪个还没评；只 readdir，不 stat。
 */
async function apiScoreDirs(q) {
  const dir = asDir(q.get('dir'));
  let ents = [];
  try {
    ents = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return { ok: false, error: '读不了这个文件夹' };
  }
  let files = 0;
  const subs = [];
  for (const e of ents) {
    if (e.isDirectory()) {
      if (isHiddenDir(e.name) || subs.length >= 300) continue;
      subs.push({ name: e.name, path: path.join(dir, e.name), count: 0 });
    } else if (e.isFile() && !e.name.startsWith('.') && IMAGE_EXT.has(path.extname(e.name).toLowerCase())) {
      files += 1;
    }
  }
  for (const s of subs) {
    try {
      const list = await fsp.readdir(s.path, { withFileTypes: true });
      s.count = list.filter((x) => x.isFile() && !x.name.startsWith('.') && IMAGE_EXT.has(path.extname(x.name).toLowerCase())).length;
    } catch { s.count = 0; }
  }
  subs.sort((a, b) => collator.compare(a.name, b.name));
  const parent = path.dirname(dir);
  return { ok: true, dir, parent: parent === dir ? null : parent, name: path.basename(dir) || dir, files, dirs: subs };
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
  const out = await identifyImage({
    buffer,
    mime,
    filename: path.basename(file),
    // 前端用 canvas 压好的副本：多识要 ≤640，植物智只收 JPEG
    small: body.dataSmall ? Buffer.from(body.dataSmall, 'base64') : null,
    jpeg: body.dataJpeg ? Buffer.from(body.dataJpeg, 'base64') : null,
    sources: body.sources,
    force: body.force === true,
  });
  return { ...out, file, name: path.basename(file) };
}

/**
 * 「自然在线」相册里的照片走这里：图不在本机，先用带令牌的代理把原图取回来，
 * 再走和本地图片完全一样的一套识别。前端同样会把 640 / 1600 两个副本一起带上。
 */
async function apiIdentifyRemote(body) {
  const url = String(body.url || '').trim();
  if (!url) throw bad('没有图片地址');
  const got = await NAT.fetchImage(url);
  const out = await identifyImage({
    buffer: got.buffer,
    mime: got.contentType,
    filename: body.name || 'online.jpg',
    small: body.dataSmall ? Buffer.from(body.dataSmall, 'base64') : null,
    jpeg: body.dataJpeg ? Buffer.from(body.dataJpeg, 'base64') : null,
    sources: body.sources,
    force: body.force === true,
  });
  return { ...out, url, name: body.name || '' };
}

/** 真正的识别：本地文件和站点照片共用这一段 */
async function identifyImage({ buffer, mime, filename, small, jpeg, sources, force }) {
  const img = {
    buffer,
    mime,
    filename,
    small: small || null,
    jpeg: jpeg || null,
  };

  const asked = Array.isArray(sources) && sources.length ? sources : presetSources(config.ui?.preset).sources;
  // 同一个网站的多个模型互斥（多识三分组、懂鸟三类、晓虫各分区、文浩蝶/蛾、百度动/植物）。
  // 前端已经保证一次只开一个，这里再兜一层，防止旧缓存或直接调接口时把同一站请求两遍。
  const usedVendor = new Set();
  const keys = asked
    .filter((k) => SITE_META[k] && !SITE_META[k].verify)
    .filter((k) => {
      const v = SITE_META[k]?.vendor;
      if (!v) return true;
      if (usedVendor.has(v)) return false;
      usedVendor.add(v);
      return true;
    });
  if (!keys.length) throw bad('没有可用的识别站点，请先选一个方案或填好账号');

  const started = Date.now();
  const cacheKey = IDC.keyFor(img, keys, COLCN.stat().version);
  if (!force) {
    const hit = IDC.read(cacheKey);
    if (hit) return { ...hit, cached: true, ms: Date.now() - started };
  }

  // 需要账号的站点：没登录过就先登一次（多识在 identify 内部自己处理）
  await Promise.all(
    keys
      .filter((k) => SITE_META[k].auth === 'login' && SITE_META[k].account !== 'duoshi' && !sites.state[k]?.ok)
      .map((k) => sites.login(k).catch(() => {})),
  );

  // 同一引擎的站点（文浩识蛾 / 识蝶）只真请求一次，另一个直接复用结果 ——
  // 否则同一份 Top5 会被数两遍票，把并不占优的候选顶上来。
  const engineOwner = new Map();
  const plan = keys.map((k) => {
    const engine = SITE_META[k]?.engine;
    if (!engine) return { key: k, mirrorOf: '' };
    if (engineOwner.has(engine)) return { key: k, mirrorOf: engineOwner.get(engine) };
    engineOwner.set(engine, k);
    return { key: k, mirrorOf: '' };
  });

  const results = {};
  const list = await Promise.all(
    plan
      .filter((p) => !p.mirrorOf)
      .map(async (p) => {
        try {
          return { key: p.key, res: await sites.identify(p.key, img) };
        } catch (err) {
          return { key: p.key, res: { site: p.key, ok: false, items: [], error: err.message || String(err) } };
        }
      }),
  );
  for (const { key, res } of list) results[key] = res;
  for (const p of plan) {
    if (!p.mirrorOf) continue;
    const src = results[p.mirrorOf] || null;
    results[p.key] = {
      site: p.key,
      ok: !!src?.ok,
      ms: 0,
      items: src?.items || [],
      error: src?.error,
      mirrorOf: p.mirrorOf,
    };
  }
  // 保持用户勾选的顺序，结果页的站点卡片顺序才可预期
  const ordered = {};
  for (const k of keys) if (results[k]) ordered[k] = results[k];

  const agg = aggregate(ordered);
  // 合并结果里的中文名换成《中国生物物种名录》的大陆规范名 —— 内置索引本地查表，
  // 没命中（名录未收录 / 本来就没有中文名）就保留站点原名，不用空串覆盖。
  // 覆盖 row.cn 后，下游「结果页展示 + 写回文件名」都自然用上大陆名，无需各改一处。
  try {
    COLCN.resolve(agg.rows);
    // best 是 agg.rows[0] 的引用，cn 已被改；重建一句话结论里的名字
    agg.verdict = buildVerdict(agg.best, agg.genusConsensus, agg.siteCount);
  } catch (err) {
    // 任何异常都不该拖垮识别：中文名不强增强而已
    console.log(`  [i] 大陆中文名增强失败（不影响识别）：${err && err.message ? err.message : err}`);
  }
  const bySite = {};
  for (const [k, r] of Object.entries(ordered)) {
    bySite[k] = {
      ok: !!r.ok,
      items: (r.items || []).slice(0, 5),
      error: r.error || '',
      ms: r.ms || 0,
      mirrorOf: r.mirrorOf || '',
    };
  }
  const out = {
    ok: true,
    ms: Date.now() - started,
    // sites = 每站明细（原站点 key → {ok, items, error, ms, mirrorOf}）
    sites: bySite,
    // aggSites = 真正计了票的站点（有结果、且不是同引擎镜像），顺序同用户勾选；
    // 「完整结果」那张表的列顺序、站数分母都按它，别看 sites 的 key 数
    aggSites: agg.sites,
    siteCount: agg.siteCount,
    // 15 行：完整结果表要，右侧候选列表自己再截前 8
    rows: agg.rows.slice(0, 15).map((r) => ({
      cn: r.cn,
      latin: r.latin,
      pct: r.pct,
      support: r.support,
      unanimous: !!r.unanimous,
      bySite: r.bySite,
      // 学名首词推出来的属，候选悬停时先拿它兜底；科要联网查 taxonomy 才补得上
      genus: r.genus || '',
    })),
    verdict: agg.verdict,
    genusConsensus: agg.genusConsensus,
  };

  // 有站点给出结果才缓存；全失败说明是网络/账号问题，留给下次重试。
  // 有站点失败的结果只留 7 天，免得一次抖动把缺站的结果锁一个月。
  if (out.siteCount > 0) {
    const allOk = Object.values(out.sites).every((s) => s.ok);
    IDC.write(cacheKey, out, allOk ? IDC.TTL : IDC.PARTIAL_TTL);
  }
  return out;
}

/* ---------------- 配置导出 / 导入（口令加密） ----------------
 * 只导出「账号、Key、界面设置」，不含自然在线令牌缓存/识别缓存/日志。
 * 文件用 scrypt + AES-256-GCM 加密，口令不落盘；导入前自动备份当前 config.json。
 */
function configForExport() {
  return {
    sites: config.sites || {},
    sessions: config.sessions || {},
    ui: config.ui || {},
    deepseek: config.deepseek || {},
    seedXingsePurged: config.seedXingsePurged === true,
  };
}

function configEnvelope(passphrase) {
  const pass = String(passphrase || '');
  if (pass.length < 4) throw bad('口令至少 4 个字符');
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(pass, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plain = Buffer.from(JSON.stringify({
    app: 'tagden',
    version: VERSION,
    exportedAt: Date.now(),
    config: configForExport(),
  }), 'utf8');
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return {
    v: 1,
    app: 'tagden',
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

function openConfigEnvelope(envelope, passphrase) {
  const env = typeof envelope === 'string' ? JSON.parse(envelope) : envelope;
  if (!env || env.v !== 1 || env.app !== 'tagden' || env.kdf !== 'scrypt') throw bad('不是本程序的配置备份文件');
  const pass = String(passphrase || '');
  if (pass.length < 4) throw bad('口令至少 4 个字符');
  let plain;
  try {
    const salt = Buffer.from(String(env.salt || ''), 'base64');
    const iv = Buffer.from(String(env.iv || ''), 'base64');
    const tag = Buffer.from(String(env.tag || ''), 'base64');
    const key = crypto.scryptSync(pass, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(Buffer.from(String(env.data || ''), 'base64')), decipher.final()]);
  } catch {
    throw bad('口令不对，或配置文件已损坏');
  }
  const j = JSON.parse(plain.toString('utf8'));
  if (!j || j.app !== 'tagden' || !j.config || typeof j.config !== 'object') throw bad('配置内容不完整');
  return j;
}

function importConfig(envelope, passphrase) {
  const j = openConfigEnvelope(envelope, passphrase);
  const next = j.config;
  try {
    fs.copyFileSync(CFG_FILE, `${CFG_FILE}.backup-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}`);
  } catch {
    /* 首次安装还没有 config.json，无所谓 */
  }
  config.sites = next.sites && typeof next.sites === 'object' ? next.sites : {};
  config.sessions = next.sessions && typeof next.sessions === 'object' ? next.sessions : {};
  config.ui = next.ui && typeof next.ui === 'object' ? next.ui : config.ui;
  config.deepseek = next.deepseek && typeof next.deepseek === 'object' ? next.deepseek : config.deepseek;
  config.seedXingsePurged = next.seedXingsePurged === true;
  config.port = APP_PORT;
  sites = new Sites(config);
  persistConfig();
  return {
    ok: true,
    sites: Object.keys(config.sites || {}).length,
    restart: true,
    note: '配置已导入；自然在线登录态可能要在「自然在线」页重新登录一次',
  };
}

/* ---------------- 撤销本机写标签 / 重命名 ----------------
 * 只保留最近 20 次写操作；撤销时把文件挪回原路径，并把原来的中文名/学名写回去。
 * 不备份整张原图，所以只恢复“名字/位置”，不恢复像素内容（写标签本来就只改 XMP）。
 */
function readUndo() {
  try {
    const j = JSON.parse(fs.readFileSync(UNDO_FILE, 'utf8'));
    return Array.isArray(j.items) ? j.items : [];
  } catch {
    return [];
  }
}

function writeUndo(items) {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    const tmp = `${UNDO_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ items: items.slice(0, 20) }, null, 2), 'utf8');
    fs.renameSync(tmp, UNDO_FILE);
  } catch {
    /* 撤销日志写失败不影响标注 */
  }
}

function pushUndo(entry) {
  const list = readUndo();
  list.unshift(entry);
  writeUndo(list);
}

function undoStatus() {
  const list = readUndo();
  const last = list[0] || null;
  return {
    ok: true,
    has: Boolean(last),
    last: last ? {
      id: last.id,
      at: last.at,
      beforeName: last.beforeName,
      afterName: last.afterName,
      cn: last.cn,
      latin: last.latin,
    } : null,
  };
}

async function apiUndoLast() {
  const list = readUndo();
  const entry = list[0];
  if (!entry) throw bad('没有可撤销的操作');
  const after = String(entry.afterPath || '');
  const before = String(entry.beforePath || '');
  if (!after || !before) throw bad('撤销记录损坏');
  if (!fs.existsSync(after)) throw bad('要撤销的文件已经不在了');
  if (path.resolve(after) !== path.resolve(before) && fs.existsSync(before)) {
    throw bad(`原位置已经有同名文件：${before}`);
  }
  let moved = false;
  if (path.resolve(after) !== path.resolve(before)) {
    fs.mkdirSync(path.dirname(before), { recursive: true });
    fs.renameSync(after, before);
    moved = true;
  }
  let labelRestored = false;
  let warn = '';
  try {
    IMG.writeLabel(before, { cn: entry.cn || '', latin: entry.latin || '', note: '', source: '撤销恢复' });
    labelRestored = true;
  } catch (err) {
    warn = `位置已恢复，但标签恢复失败：${err.message}`;
  }
  try {
    LC.drop(path.dirname(before), path.basename(before));
    LC.drop(path.dirname(after), path.basename(after));
  } catch {}
  list.shift();
  writeUndo(list);
  return {
    ok: true,
    path: before,
    dir: path.dirname(before),
    name: path.basename(before),
    moved,
    labelRestored,
    warn,
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
  // 上一轮写进去的学名（改错重标时用来剥旧名、也用来查分类）
  const prevLatin = (before.keywords || []).find((k) => k && k !== before.title) || '';
  if (body.rename) {
    const label = speciesLabel(cn, latin, body.renamePick);
    const only = body.renameOrder === 'only';
    const renameOrder = only ? 'only' : body.renameOrder === 'last' ? 'last' : 'first';
    const ext = path.extname(file);
    // 基于「最初的名字」拼，而不是当前名字：连着改几次标也不会越叠越长。
    // 老文件里没记原始名的，退到当前文件名。
    const origName = result.origName || path.basename(file);
    const origExt = path.extname(origName);
    const base = path.basename(origName, origExt) || path.basename(file, ext);
    // 把上一轮写进去的旧物种名也一起剥掉，改错重标时不留残渣
    const nextBase = buildName(base, [label, before.title, prevLatin], renameOrder, only ? body.renameSuffix : '');
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
        target = only ? uniquePathNumbered(target) : uniquePath(target);
        fs.renameSync(file, target);
        finalPath = target;
        renamed = true;
      }
    }
  }

  // 归档：写完之后把文件挪进「界/门/纲/目/科/属」分类文件夹。挪之前已经把标签写进像素文件本身，
  // 所以就算移动失败，标注也不会丢。
  let archived = false;
  let folder = '';
  if (body.archive) {
    const species = speciesFolder(cn, latin);
    if (species) {
      try {
        const latinForTaxo = latin || pickLatin(before.keywords) || prevLatin;
        const rec = await lookupTaxonomy(latinForTaxo, cn);
        // 写入时自动归档沿用「到属」：每个种单独成夹是「按分类归档」里的可选项，这里不默认开
        const mv = moveIntoDir(finalPath, rootDir, archiveSegments(rec, { cn, latin, species }, false));
        if (mv.moved) {
          finalPath = mv.path;
          archived = true;
        }
        folder = mv.folder;
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

  const oldName = splitNameFields(before);
  const undoId = crypto.randomUUID();
  pushUndo({
    id: undoId,
    at: Date.now(),
    beforePath: file,
    afterPath: finalPath,
    beforeName: path.basename(file),
    afterName: path.basename(finalPath),
    cn: oldName.cn,
    latin: oldName.latin,
    renamed,
    archived,
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
    undoId,
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

/* ---------------- 文件名里的物种名（很多图还没写标签，名字只在文件名上） ----------------
 * 验收照片常见的几种写法：
 *   东亚豆粉蝶(Colias poliographus)_441A8990   中文名(拉丁名)_编号
 *   卷蛾科(Tortricidae)_204515               (科名单词)
 *   平爪鳃金龟属(Ectinohoplia)_441A8045       (属名单词)
 *   八字地老虎(Xestia c-nigrum)_204330       种加词带连字符
 *   Argyresthia subreticulata_205118         拉丁名_编号
 *   豹弄蝶 thymelicus leoninus                中文名 斜写学名（属名可能小写）
 * 判据和前端「没有学名」筛选保持一致：括号里有拉丁词就算；否则要相邻两个拉丁词。
 * 认不出拉丁名就返回空 —— 纯中文名（如「棕翅肖斑背天牛」）和相机默认名（IMG_/DSC/picture_）
 * 都算「没有学名」。
 */
const LATIN_WORD_RE = /[A-Za-z][A-Za-z-]{2,}/;
const PAREN_GROUP_RE = /[（(][^（()）]*[)）]/g;

function nameFieldsFromFile(name) {
  const base = String(name || '').replace(/\.[^.]+$/, '').trim();
  let latin = '';
  // ① 括号里的拉丁名（中文名(拉丁名)，或单科/属/目名单词）
  const groups = base.match(PAREN_GROUP_RE) || [];
  for (const g of groups) {
    const inner = g.replace(/^[（(]/, '').replace(/[)）]$/, '').trim();
    if (LATIN_WORD_RE.test(inner)) {
      latin = inner;
      break;
    }
  }
  // ② 括号外相邻的两个拉丁词（属名 + 种加词，允许连字符/小写属名）
  if (!latin) {
    const m = base.match(/(?:^|[^A-Za-z-])([A-Za-z][A-Za-z-]{2,})\s+([a-z][A-Za-z-]{1,})/);
    if (m) latin = `${m[1]} ${m[2]}`;
  }
  // ③ 中文名后面紧跟一个拉丁属名（只到属也算鉴定过）：邻烁甲Plesiophthalmus (2)
  //    归档后每个属一个文件夹，里面大量是这种写法，漏了它们就不认了。
  if (!latin) {
    const m = base.match(/[\u4e00-\u9fa5][\s]*([A-Z][a-z]{2,})(?=$|[\s\d（()）.,;])/);
    if (m) latin = m[1];
  }
  if (!latin) return { cn: '', latin: '' };
  // 中文名：去掉括号拉丁段后剩下的连续中文
  const cnMatch = base.replace(PAREN_GROUP_RE, ' ').match(/[\u4e00-\u9fa5·]{2,}/);
  return { cn: cnMatch ? cnMatch[0] : '', latin };
}

/** 只要文件名里的中文名（不管有没有学名）。纯中文名的照片靠它进入「物种名核对」。 */
// 调查批次、相机默认名里的中文不是物种名，别拿去反查学名制造一堆噪声
const GENERIC_CN_RE = /调查|照片|样地|样方|采集|记录|第|图片|图库|未命名|批次|截图/;
function cnFromFile(name) {
  const base = String(name || '').replace(/\.[^.]+$/, '').replace(/[（(][^（()）]*[)）]/g, ' ');
  const m = base.match(/[\u4e00-\u9fa5·]{2,}/);
  return m && !GENERIC_CN_RE.test(m[0]) ? m[0] : '';
}

/* ---------------- 物种名核对：把只有中文名 / 只有学名的补齐 ----------------
 * 这里**只算建议，不写任何文件**：写回由界面确认后统一走 /api/write（本机端）
 * 或 /api/nat/renames（相册端，先存本机待上传鉴定）。
 * 内置名录离线可查 14.8 万条；查不到且勾选「联网补查」时才去自然在线分类库，
 * 且最多 40 次、每次 3.5 秒超时，断网/没登录一律静默跳过。
 */
async function siteTaxaPick(keyword, side) {
  const kw = String(keyword || '').trim();
  if (!kw) return null;
  let timer = 0;
  try {
    const X = NAT.client();
    const raw = await Promise.race([
      X.searchTaxa(kw, 10),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('超时')), 3500); }),
    ]);
    const list = Array.isArray(raw) ? raw : [];
    const pick = (fn) => {
      const t = list.find(fn);
      return t ? { nameZh: String(t.nameZh || '').trim(), spName: String(t.spName || '').trim() } : null;
    };
    if (side === 'latin') {
      const key = COLCN.normLatin(kw);
      return pick((t) => COLCN.normLatin(t.spName) === key)
        || (key.length >= 6 ? pick((t) => COLCN.normLatin(t.spName).startsWith(key)) : null);
    }
    return pick((t) => String(t.nameZh || '').trim() === kw)
      || (kw.length >= 3 ? pick((t) => String(t.nameZh || '').trim().includes(kw)) : null);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function apiSpeciesComplete(body) {
  COLCN.init();
  const list = Array.isArray(body.items) ? body.items.slice(0, 600) : [];
  const online = body.online === true;
  const cache = new Map();
  let onlineTried = 0;
  const out = [];
  for (const it of list) {
    const key = String((it && it.key) || '');
    const fileName = String((it && it.fileName) || (it && it.name) || '').slice(0, 300);
    const fromLabel = splitNameFields({
      title: String((it && it.labelTitle) || ''),
      keywords: Array.isArray(it && it.labelKeywords) ? it.labelKeywords : [],
    });
    const fromFile = nameFieldsFromFile(fileName);
    const bareCn = cnFromFile(fileName);
    let cn = String((it && it.cn) || '').trim() || fromLabel.cn || '';
    let latin = String((it && it.latin) || '').trim() || fromLabel.latin || '';
    if (!latin) latin = fromFile.latin || '';
    if (!cn) {
      // 已经有学名时，只认「中文名(学名)」这种成对写法；没有学名才允许纯中文文件名
      cn = fromFile.latin || !latin ? fromFile.cn || bareCn : '';
    }
    cn = cn.replace(/\s+/g, ' ').trim().slice(0, 120);
    latin = latin.replace(/\s+/g, ' ').trim().slice(0, 160);
    const row = {
      key, fileName, cn, latin, fillCn: cn, fillLatin: latin,
      state: '', source: '', candidates: [], suggestions: [], note: '',
    };
    if (!cn && !latin) {
      row.state = 'empty';
      row.note = '没有物种名，先识别或双击卡片名称手填';
      out.push(row);
      continue;
    }
    if (cn && latin) {
      row.state = 'complete';
      const std = COLCN.lookup(latin);
      // 两侧都齐：只提示名录规范名，不擅自覆盖用户写好的中文名
      if (std && std !== cn) row.note = `名录里 ${latin} 写作「${std}」，可顺手核对`;
      out.push(row);
      continue;
    }
    const ck = latin ? `la:${latin.toLowerCase()}` : `cn:${cn}`;
    let got = cache.get(ck);
    if (!got) {
      if (latin) {
        const std = COLCN.lookup(latin);
        if (std) got = { state: 'filled', fillCn: std, source: '中国生物物种名录' };
        if (!got && online && onlineTried < 40) {
          onlineTried += 1;
          const hit = await siteTaxaPick(latin, 'latin');
          if (hit && hit.nameZh) got = { state: 'filled', fillCn: hit.nameZh, source: '自然在线分类库' };
        }
      } else {
        const r = COLCN.lookupLatin(cn);
        if (r.latin) got = { state: 'filled', fillLatin: r.latin, source: '中国生物物种名录' };
        else if (r.ambiguous) {
          got = { state: 'ambiguous', candidates: r.candidates, note: '名录里多个学名共用这个中文名，请挑一个' };
        } else if (online && onlineTried < 40) {
          onlineTried += 1;
          const hit = await siteTaxaPick(cn, 'cn');
          if (hit && hit.spName) got = { state: 'filled', fillLatin: hit.spName, source: '自然在线分类库' };
        }
      }
      if (!got && !latin) {
        // 中文名可能是异名/错字：只在精确和联网都失败时，给编辑距离 1 的候选让人点选
        const near = COLCN.suggestCn(cn, 6);
        if (near.length) {
          got = {
            state: 'ambiguous',
            candidates: [],
            suggestions: near,
            note: '名录里没有完全匹配，可能是异名/错字；从下面候选里选一个',
          };
        }
      }
      got = got || {
        state: 'unresolved',
        note: latin ? '内置名录没有收录这个学名' : '内置名录里没有这个中文名',
      };
      cache.set(ck, got);
    }
    row.fillCn = got.fillCn || cn;
    row.fillLatin = got.fillLatin || latin;
    row.state = got.state;
    row.source = got.source || '';
    row.candidates = got.candidates || [];
    row.suggestions = got.suggestions || [];
    row.note = got.note || '';
    out.push(row);
  }
  const summary = { total: out.length };
  for (const s of ['filled', 'ambiguous', 'unresolved', 'complete', 'empty']) {
    summary[s] = out.filter((x) => x.state === s).length;
  }
  return { ok: true, items: out, summary, dict: COLCN.stat(), online, onlineTried };
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

/* ---------------- 递归扫描与「已归档」判定 ---------------- */

// 一次最多处理这么多张：重排常常整棵树几十万个文件，宁可分批让用户自己切，
// 也不要在 USB 机械盘上卡住十分钟还不给反馈。
const MAX_ARCHIVE_FILES = 30000;

/** child 是否在 parent 里面（含自身），比较时统一小写 —— Windows 路径不分大小写 */
function isUnder(child, parent) {
  const c = path.resolve(child).toLowerCase();
  const p = path.resolve(parent).toLowerCase();
  return c === p || c.startsWith(p + path.sep);
}

/**
 * 这个文件是不是已经躺在「界/门/纲/目/科/属」这串分类目录里了。
 *
 * 用「整条路径里是否存在连续的这几级」来判，而不是只看最后几级：
 * 用户可能选的是树中间的某一层（比如 .../动物界 Animalia/节肢动物门 Arthropoda），
 * 这时文件本身已经在归档结构里，再归档一次只会套娃成 .../节肢动物门 Arthropoda/动物界 Animalia/…，
 * 所以只要路径里已经出现过这条分类链，就认定「已归档」，不参与重排。
 */
function dirHasSegments(dirPath, segs) {
  const want = (Array.isArray(segs) ? segs : [segs]).map((s) => safeName(s).toLowerCase()).filter(Boolean);
  if (!want.length) return false;
  const have = path.resolve(dirPath).split(path.sep).map((s) => s.toLowerCase());
  for (let i = 0; i + want.length <= have.length; i += 1) {
    let hit = true;
    for (let j = 0; j < want.length; j += 1) {
      if (have[i + j] !== want[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
}

/**
 * 递归收图片。返回绝对路径数组；到上限就停（truncated 由调用方看长度判断）。
 * 用同步 IO：归档是用户主动触发的一步操作，宁可整段跑完也不要和缩略图请求抢盘。
 */
function walkImageFiles(root, maxDepth) {
  const out = [];
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth >= maxDepth || isHiddenDir(e.name)) continue;
        stack.push({ dir: full, depth: depth + 1 });
      } else if (e.isFile()) {
        if (e.name.startsWith('.')) continue;
        if (!IMAGE_EXT.has(path.extname(e.name).toLowerCase())) continue;
        out.push(full);
        if (out.length >= MAX_ARCHIVE_FILES) return out;
      }
    }
  }
  return out;
}

/**
 * 批量归档 / 重排：把「已命名」的图片按 界/门/纲/目/科/属 分进分类文件夹
 * （同属的物种进同一个属文件夹，文件夹名「中文 拉丁」）。
 *
 * 三个模式：
 *   ① 默认：只处理 path 这一层（原来的行为）。
 *   ② deep:true：连子文件夹一起扫，全部重排到 path 下的分类树里。
 *   ③ folders:[..]：只重排勾选的那几个文件夹（含它们自己的子文件夹）。
 * 另外 files:[..] 只处理点名的这几张（界面上勾选的图片），不再扫目录。
 *
 * 无论哪种模式，**已经归档过的图片都不参与重排**（见 dirHasSegments），
 * 所以可以反复点，不会越搬越深。
 *
 * 默认只算不动手（preview），前端确认后再带 apply:true 回来 —— 移动文件不可逆，
 * 不能让用户点错一下就搬走一整批照片。
 */
/* ---------------- 归并任务（带进度回报，避免大批量移动卡死界面） ---------------- */

const ARCH_JOBS = new Map();

function startArchiveJob(body) {
  const id = 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const job = { id, phase: 'queued', total: 0, done: 0, startedAt: 0, finished: false, result: null, error: null };
  ARCH_JOBS.set(id, job);
  (async () => {
    try {
      const r = await apiArchive(body, (p) => {
        if (p.phase) job.phase = p.phase;
        if (p.total != null) job.total = p.total;
        if (p.done != null) job.done = p.done;
      });
      job.phase = 'done';
      job.result = r;
    } catch (e) {
      job.phase = 'error';
      job.error = e && e.message ? e.message : String(e);
    }
    job.finished = true;
    job.total = job.total || 0;
  })();
  return id;
}

function getArchiveJob(id) {
  const job = ARCH_JOBS.get(id);
  if (!job) return { ok: false, error: '任务不存在或已结束' };
  const out = { ok: true, id: job.id, phase: job.phase, total: job.total, done: job.done, finished: job.finished };
  if (job.finished) {
    if (job.error) out.error = job.error;
    else out.result = job.result;
    ARCH_JOBS.delete(id); // 取过最终结果就销毁，不占内存
  }
  return out;
}

async function apiArchive(body, onProgress) {
  const dir = asDir(body.path);
  const apply = body.apply === true;
  const deep = body.deep === true;
  // 每个种一个文件夹（否则同属一个文件夹，默认）
  const bySpecies = body.bySpecies === true;
  const picked = Array.isArray(body.folders) ? body.folders.filter((x) => typeof x === 'string' && x.trim()) : [];
  const chosen = Array.isArray(body.files) ? body.files.filter((x) => typeof x === 'string' && x.trim()) : [];

  // 目标根目录：默认就是当前目录（就地归档）。指定到别处就是「归并」——
  // 把散落在各个文件夹里的照片统一收进同一棵分类树。
  const dest = body.dest ? asDir(body.dest) : dir;
  const toOther = path.resolve(dest).toLowerCase() !== path.resolve(dir).toLowerCase();
  // 复制只在「搬到另一个目录」时才有意义：就地复制等于在自己下面再放一份，纯属噪音
  const copyMode = body.copy === true && toOther;
  const includeOwn = body.includeOwn === true;

  // 扫描起点：点名的图片（界面勾选）> 勾选文件夹（含其子目录）> 递归当前目录 > 只当前目录
  let roots = [dir];
  let recursive = deep;
  let files = [];
  if (chosen.length) {
    // 只动用户勾中的那几张：不再扫目录，别把同文件夹其它的图一起搬走
    for (const p of chosen) {
      let f;
      try {
        f = asImage(p);
      } catch {
        continue;
      }
      if (!isUnder(f, dir)) continue;
      files.push(f);
    }
    if (!files.length) throw bad('勾选的图片不在当前目录里');
    recursive = false;
  } else if (picked.length) {
    roots = [];
    for (const p of picked) {
      let r;
      try {
        r = asDir(p);
      } catch {
        continue;
      }
      // 只认当前目录里面的，防止前端传错路径把别处的照片搬过来
      if (!isUnder(r, dir)) continue;
      roots.push(r);
    }
    if (!roots.length) throw bad('勾选的文件夹不在当前目录里');
    recursive = true;
  }

  if (!files.length) {
    for (const r of roots) files = files.concat(recursive ? walkImageFiles(r, 12) : walkImageFilesShallow(r));
    // 「含本层图片」：只加当前目录自己的图，不往下走（下面那些由勾选的文件夹负责）
    if (includeOwn) files = files.concat(walkImageFilesShallow(dir));
  }
  const truncated = !chosen.length && files.length >= MAX_ARCHIVE_FILES;

  const todo = [];
  let skipped = 0;
  if (onProgress) onProgress({ phase: '扫描与读取标签', total: files.length, done: 0 });
  let scanIdx = 0;
  for (const full of files) {
    scanIdx += 1;
    // 每 50 张让出一次事件循环：读标签是同步 IO，不 yield 的话轮询接口读不到进度
    if (onProgress && scanIdx % 50 === 0) {
      onProgress({ done: scanIdx });
      await new Promise((r) => setImmediate(r));
    }
    let label = null;
    try {
      label = IMG.readLabel(full);
    } catch {
      skipped += 1;
      continue;
    }
    // 先看写进图的标签；没有标签就退回文件名 —— 很多人的图从相机/别的软件出来时就叫
    // 「东亚豆粉蝶(Colias poliographus)_441A8990」，文件名本身就是鉴定证据。
    let { cn, latin } = splitNameFields(label || {});
    if (!cn && !latin) {
      const f = nameFieldsFromFile(path.basename(full));
      cn = f.cn;
      latin = f.latin;
    }
    const species = speciesFolder(cn, latin);
    if (!species) {
      skipped += 1;
      continue;
    }
    todo.push({ file: full, species, cn, latin: latin || pickLatin(label?.keywords) });
  }

  // 分类阶元：同一学名只查一次（lib/taxonomy.js 里还有落盘缓存，查过就不联网）。
  // 这一步可能要几秒（首次），之后全走缓存。
  // 查分类这一步没法细分进度（批量联网），用不确定进度条表示
  if (onProgress) onProgress({ phase: '查询分类（首次要联网）', total: 0, done: 0 });
  const taxo = await TAXO.resolve(todo.map((t) => ({ latin: t.latin, cn: t.cn || t.species })));

  const move = [];
  const groups = new Map();
  let unknown = 0;
  let already = 0;
  let exists = 0;
  for (const t of todo) {
    const rec = taxo.get(taxoKey(t.latin, t.cn || t.species));
    t.segs = archiveSegments(rec, t, bySpecies);
    if (t.segs[0] === '未分类') unknown += 1;
    if (toOther) {
      // 归并到别的树：目标位置已有同名同大小的，就认为这份已经搬过了，不重复弄一份
      const target = path.join(dest, ...t.segs.map(safeName), path.basename(t.file));
      try {
        if (fs.statSync(target).size === fs.statSync(t.file).size) {
          exists += 1;
          continue;
        }
      } catch {}
    } else if (dirHasSegments(path.dirname(t.file), t.segs)) {
      // 已经在这一串分类文件夹里了 —— 不重复搬，也不算进「将搬动」
      already += 1;
      continue;
    }
    move.push(t);
    const key = t.segs.join('/');
    groups.set(key, (groups.get(key) || 0) + 1);
  }

  let moved = 0;
  let copied = 0;
  let pruned = 0;
  const failed = [];
  if (apply) {
    if (onProgress) onProgress({ phase: copyMode ? '复制中' : '移动中', total: move.length, done: 0 });
    const emptied = new Set();
    let processed = 0;
    for (const t of move) {
      const from = path.dirname(t.file);
      try {
        if (copyMode) {
          if (copyIntoDir(t.file, dest, t.segs).copied) copied += 1;
        } else if (moveIntoDir(t.file, dest, t.segs).moved) {
          moved += 1;
          if (toOther || from.toLowerCase() !== path.resolve(dir).toLowerCase()) emptied.add(from);
        }
      } catch (err) {
        failed.push(`${path.basename(t.file)}：${err.message}`);
      }
      processed += 1;
      // 每 25 张让出事件循环，否则大目录移动时进度条会卡在 0 直到全部完成
      if (onProgress && processed % 25 === 0) {
        onProgress({ done: processed });
        await new Promise((r) => setImmediate(r));
      }
    }
    if (onProgress) onProgress({ done: processed });
    // 搬空的旧文件夹顺手删掉（rmdir 只删空目录，非空一律失败，所以不会误伤）。
    // 复制不动源文件夹，所以只有移动模式才清。
    if (!copyMode) {
      const root = path.resolve(dir).toLowerCase();
      for (const d of [...emptied].sort((a, b) => b.length - a.length)) {
        let cur = d;
        while (!isHiddenDir(path.basename(cur)) && path.resolve(cur).toLowerCase() !== root) {
          try {
            fs.rmdirSync(cur);
            pruned += 1;
          } catch {
            break;
          }
          cur = path.dirname(cur);
        }
      }
    }
  }

  return {
    ok: true,
    applied: apply,
    deep: recursive,
    bySpecies,
    dest,
    copy: copyMode,
    mode: chosen.length ? 'files' : recursive ? (picked.length ? 'folders' : 'deep') : 'dir',
    scanned: files.length,
    truncated,
    willMove: move.length,
    moved,
    copied,
    pruned,
    failed,
    skipped,
    // 已经在分类文件夹里、这次不参与重排的张数
    already,
    // 归并时目标位置本来就有的张数
    exists,
    species: new Set(move.map((t) => t.species)).size,
    // 查不到分类、只能落到「未分类」的张数
    unknown,
    groups: [...groups.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh')),
  };
}

/** 只扫一层：非递归模式用，行为和原来的归档完全一致 */
function walkImageFilesShallow(dir) {
  let ents = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    throw bad('读不了这个文件夹');
  }
  const out = [];
  for (const e of ents) {
    if (!e.isFile() || e.name.startsWith('.')) continue;
    if (!IMAGE_EXT.has(path.extname(e.name).toLowerCase())) continue;
    out.push(path.join(dir, e.name));
  }
  return out;
}

/* ---------------- 自然在线（nature-client 作为标注工坊的一个模块） ----------------
 *
 * 这一段是「另一个软件变成这里的一个标签页」的胶水层，真正干活的是 lib/nature-client.js
 * （从 nature-client 项目原样拷过来，只依赖 lib/http.js），账号与令牌由 lib/nature-store.js 管。
 *
 * 分工，别越界：
 *   · 识别还是走 lib/adapters.js 里的 xingse 适配器 —— 那是「传图换候选物种」，
 *     用的是包里内置的识别账号（lib/nat-share.js），不需要用户登录；
 *   · 这里管的是**账号里的相册**：新建、上传、浏览、批量下载、删除，
 *     用的是用户自己登录的自然在线账号（lib/nature-store.js）。
 * 两套账号互不干涉：用户没登录也能识别；登录了才能碰自己的相册。
 *
 * 一条硬规则：账号密码和令牌绝不出本机。浏览器只跟 127.0.0.1 的这一层说话，
 * 图片也走本机代理（/api/nat/img）—— 直连站点会同时撞上 CORS、防盗链和令牌泄露。
 */

const NAT_JOBS = new Map();

/* ---------------- 纯 Node 的 ZIP 打包（store，无压缩，零依赖） ----------------
 * 「下载原图」用：站点只给一张张原图地址，本机逐张取回后自己打成一个 zip，
 * 不引入第三方库（单文件 exe 也要能跑）。和 nature-client 里同一套实现。 */

let _zipCrcTable = null;
function zipCrc32(buf) {
  if (!_zipCrcTable) {
    _zipCrcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      _zipCrcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) crc = _zipCrcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStore(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(String(f.name || 'file'), 'utf8');
    const data = f.data;
    const crc = zipCrc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);   // UTF-8 文件名
    local.writeUInt16LE(0, 8);        // store
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, end]);
}

/** 图片代理：带 referer + Bearer 取回来，落盘缓存（同一个 URL 只联一次网） */
async function serveNatureImage(req, res, q) {
  const u = String(q.get('u') || '');
  if (!u.startsWith(NAT.SITE_BASE + '/')) throw bad('非法的图片地址');
  const fp = NAT.imgCachePath(u);
  if (q.get('refresh') !== '1') {
    try {
      const buf = fs.readFileSync(fp);
      if (buf.length) {
        res.writeHead(200, {
          'content-type': NAT.IMG_TYPES[NAT.imgExt(u)] || 'image/jpeg',
          'content-length': buf.length,
          'cache-control': 'private, max-age=86400',
        });
        return res.end(buf);
      }
    } catch {
      /* 没缓存就去联网 */
    }
  }
  const { buffer, contentType } = await NAT.fetchImage(u);
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, buffer);
  } catch {
    /* 缓存写不进去不影响返回 */
  }
  res.writeHead(200, { 'content-type': contentType, 'content-length': buffer.length, 'cache-control': 'private, max-age=86400' });
  return res.end(buffer);
}

/**
 * 上传任务：串行 + 进度回调。
 *
 * 为什么必须后台跑：一批几十张、每张走一次 multipart 上传，同步做的话前端只能干等，
 * 中途也没有任何反馈。和归档任务同一个套路（ARCH_JOBS），前端轮询读进度。
 *
 * 两种模式：
 *   album    —— 全部进同一个相册（用户在界面上选好的）
 *   species  —— 按图片标签里的物种名各建一个相册（「确认完物种就归档到物种名相册」）
 *              没有物种名的图跳过并记进 skipped，不静默丢。
 */
function startNatUpload({ files, mode, albumId }) {
  const id = 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const job = {
    id,
    phase: 'running',
    mode,
    total: files.length,
    done: 0,
    ok: 0,
    current: '',
    failed: [],
    skipped: [],
    albums: [],
    finished: false,
    error: null,
  };
  NAT_JOBS.set(id, job);

  (async () => {
    const X = NAT.client();
    const albumByName = new Map(); // 物种名 → 相册 id，同一个种只查/建一次
    try {
      for (const file of files) {
        job.current = path.basename(file);
        try {
          let target = albumId;
          if (mode === 'species') {
            // 标签优先，文件名兜底 —— 和「没有学名」筛选用的是同一套口径
            const label = (() => {
              try {
                return IMG.readLabel(file) || {};
              } catch {
                return {};
              }
            })();
            let { cn, latin } = splitNameFields(label);
            if (!cn && !latin) ({ cn, latin } = nameFieldsFromFile(path.basename(file)));
            const title = [cn, latin].filter(Boolean).join(' ').trim();
            if (!title) {
              job.skipped.push({ file, reason: '没有物种名' });
              job.done += 1;
              continue;
            }
            target = albumByName.get(title);
            if (!target) {
              const r = await X.ensureAlbum(title);
              target = r.id;
              albumByName.set(title, target);
              if (r.created) job.albums.push({ id: target, title });
            }
          }
          const photoId = await X.uploadFile(target, file, { useAI: 0 });
          job.ok += 1;
          if (photoId) job.lastPhotoId = photoId;
        } catch (err) {
          job.failed.push({ file, error: err && err.message ? err.message : String(err) });
        }
        job.done += 1;
        // 让出事件循环，否则前端轮询永远读到「done 还是 0」
        await new Promise((r) => setImmediate(r));
      }
      job.phase = 'done';
    } catch (err) {
      job.phase = 'error';
      job.error = err && err.message ? err.message : String(err);
    }
    job.current = '';
    job.finished = true;
    // 拖拽上传的临时文件用完就删，别在缓存里堆一堆重复的图片
    try {
      const dirs = new Set(
        files
          .filter((f) => f.startsWith(NAT_DROP + path.sep))
          .map((f) => path.dirname(f)),
      );
      for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* 清不掉就算了，下次重启再攒，不影响上传结果 */
    }
  })();

  return id;
}

function getNatUpload(id) {
  const job = NAT_JOBS.get(id);
  if (!job) return { ok: false, error: '任务不存在或已结束' };
  const out = {
    ok: true,
    id: job.id,
    phase: job.phase,
    mode: job.mode,
    total: job.total,
    done: job.done,
    okCount: job.ok,
    current: job.current,
    failed: job.failed.slice(0, 200),
    skipped: job.skipped.slice(0, 200),
    albums: job.albums,
    finished: job.finished,
  };
  if (job.error) out.error = job.error;
  if (job.finished) NAT_JOBS.delete(id); // 取过最终结果就销毁
  return out;
}

async function handleNature(req, res, pathname, q) {
  const X = NAT.client();

  /* 本机待上传的鉴定结果（逐张命名记录）。
   * 只存「照片 id + 中文名/学名 + 状态」，不存图片、不上传图片。
   * 标注页相册端选好候选点「写入鉴定」先落到这里；用户再点「重新鉴定上传」
   * 才由 /api/nat/reidentify 把纯 JSON 提交给站点，成功后回写状态并重新拉照片。 */
  if (pathname === '/api/nat/renames' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, records: NAT.readRenames() });
  }
  if (pathname === '/api/nat/renames' && req.method === 'POST') {
    const b = await readJson(req);
    const incoming = Array.isArray(b.records) ? b.records : [];
    const map = new Map(NAT.readRenames().map((r) => [String(r.photoId), r]));
    for (const r of incoming) {
      if (!r || !r.photoId) continue;
      const id = String(r.photoId);
      const old = map.get(id) || {};
      map.set(id, {
        ...old,
        ...r,
        photoId: id,
        status: String(r.status || old.status || 'pending'),
        savedAt: Number(r.savedAt) || Date.now(),
      });
    }
    const out = [...map.values()];
    NAT.writeRenames(out);
    return sendJson(res, 200, { ok: true, records: out });
  }
  if (pathname === '/api/nat/renames/delete' && req.method === 'POST') {
    const b = await readJson(req);
    const ids = new Set((Array.isArray(b.ids) ? b.ids : []).map(String));
    const out = NAT.readRenames().filter((r) => !ids.has(String(r.photoId)));
    NAT.writeRenames(out);
    return sendJson(res, 200, { ok: true, records: out });
  }

  /* 状态：顺带验一下令牌还有没有效 */
  if (pathname === '/api/nat/status' && req.method === 'GET') {
    const info = NAT.info();
    let me = { ok: false, reason: '未登录' };
    if (info.hasToken) {
      try {
        me = await X.check();
      } catch (err) {
        me = { ok: false, reason: err.message || String(err) };
      }
    }
    return sendJson(res, 200, {
      ok: true,
      loggedIn: !!me.ok,
      username: me.username || (config.sites && config.sites.xingse && config.sites.xingse.username) || info.username,
      nickName: me.nickName || '',
      reason: me.ok ? '' : me.reason || '未登录',
      host: info.host,
      central: info.central, // false 表示指的是本地假站点（联调中）
      hasCreds: info.hasCreds,
      // 识别用的内置账号在不在（只说有没有，账号和令牌都不出本机）
      share: NATSHARE.info(),
    });
  }

  if (pathname === '/api/nat/captcha' && req.method === 'GET') {
    const c = await X.captcha();
    return sendJson(res, 200, { ok: true, ...c });
  }

  if (pathname === '/api/nat/login' && req.method === 'POST') {
    const b = await readJson(req);
    // 这里登录的是**用户自己的**账号（相册用）；识别用的是包里内置的那一枚，与这里无关
    const u = String(b.username || '').trim();
    const p = String(b.password || '');
    if (!u || !p) return sendJson(res, 400, { ok: false, error: '请填写自然在线的账号和密码' });
    X.setCredentials(u, p);
    await X.login(b.captcha, b.key);
    // 把新令牌同步给识别模块，作为内置账号失效时的备胎（主用仍是种子里那枚）。
    // 账号密码也落进本机配置（config.json 本来就是加密的），下次令牌失效只要再输验证码。
    config.sites.xingse = { ...(config.sites.xingse || {}), username: u, password: p, token: X.token, tokenAt: Date.now() };
    persistConfig();
    const me = await X.check().catch(() => ({ ok: true }));
    return sendJson(res, 200, { ok: true, username: me.username || '' });
  }

  if (pathname === '/api/nat/logout' && req.method === 'POST') {
    X.logout();
    // 退出只退「相册」这一套（用户自己的账号）；识别用的内置账号不受影响，
    // 退出后照样能识别。落盘标记留着，重启后启动时的 NAT.loggedOut() 也不会把旧令牌顶回来。
    config.sites.xingse = { ...(config.sites.xingse || {}), token: '', tokenAt: 0 };
    persistConfig();
    return sendJson(res, 200, { ok: true });
  }

  /* 相册 */
  if (pathname === '/api/nat/albums' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, albums: await X.albums() });
  }

  if (pathname === '/api/nat/albums' && req.method === 'POST') {
    const b = await readJson(req);
    const id = await X.addAlbum({ title: b.title, description: b.description || '' });
    return sendJson(res, 200, { ok: true, id });
  }

  if (pathname === '/api/nat/albums/delete' && req.method === 'POST') {
    const b = await readJson(req);
    await X.deleteAlbum(b.id);
    return sendJson(res, 200, { ok: true });
  }

  /* 相册里的照片 */
  if (pathname === '/api/nat/photos' && req.method === 'GET') {
    const album = String(q.get('album') || '');
    if (!album) throw bad('缺少相册 id');
    const page = Number(q.get('page')) || 1;
    const size = Number(q.get('size')) || 60;
    const r = await X.albumPhotos(album, page, size);
    return sendJson(res, 200, { ok: true, ...r });
  }

  if (pathname === '/api/nat/photos/delete' && req.method === 'POST') {
    const b = await readJson(req);
    const n = await X.deletePhotos(b.ids);
    return sendJson(res, 200, { ok: true, deleted: n });
  }

  /* 批量把照片移到另一个相册（站点原生接口，photoId 不变、不重传） */
  if (pathname === '/api/nat/photos/move' && req.method === 'POST') {
    const b = await readJson(req);
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(String).filter(Boolean);
    if (!ids.length) throw bad('没有选中照片');
    await X.movePhotos(b.albumId, ids);
    return sendJson(res, 200, { ok: true, moved: ids.length });
  }

  /* 拖进来的本机文件：浏览器直接把二进制 POST 上来，落盘后交给已有的上传任务 */
  if (pathname === '/api/nat/drop-file' && req.method === 'POST') {
    return sendJson(res, 200, await apiNatDropFile(req, q));
  }

  if (pathname === '/api/nat/img' && req.method === 'GET') {
    return serveNatureImage(req, res, q);
  }

  /* 站点分类库：把「名字」解析成提交鉴定要用的 NameID。
   * 站点这个接口是 GET + query（不是 POST body），和别处不一样，原独立版已在真站验证过。 */
  if (pathname === '/api/nat/taxa' && req.method === 'GET') {
    const taxa = await X.searchTaxa(q.get('keyword') || '', Number(q.get('limit')) || 20);
    return sendJson(res, 200, { ok: true, taxa });
  }

  /* 重新鉴定：把工坊里改好的名字写回自然在线网页端，只改鉴定结果、不动原图。
   * 底层 X.reidentify() 提交的是纯 JSON（photoId + NameID + 中文名/学名），
   * 图片一个字节都不传；站点收到后覆盖这张照片的鉴定结果，也不会新增照片。
   * 这和「上传」是两条完全不同的链路：上传 = 新增一张照片。 */
  if (pathname === '/api/nat/reidentify' && req.method === 'POST') {
    const b = await readJson(req);
    const records = Array.isArray(b.records) ? b.records : [];
    if (!records.length) throw bad('没有要写回的照片');
    const out = [];
    for (const rec of records) {
      const photoId = rec && rec.photoId ? String(rec.photoId) : '';
      try {
        if (!photoId) throw new Error('缺少照片 id');
        const nameId = rec.nameId ? String(rec.nameId) : '';
        if (!nameId) throw new Error('缺少鉴定 ID（NameID）');
        const chinese = String(rec.chinese || '').trim();
        const latin = String(rec.latin || '').trim();
        if (!chinese && !latin) throw new Error('中文名与学名至少填一项');
        const r = await X.reidentify({
          ids: [photoId],
          nameChinese: chinese,
          nameLatin: latin,
          nameId,
          type: Number(b.type || 1),
          signature: String(b.signature || ''),
          description: String(b.description || ''),
        });
        out.push({ photoId, ok: true, chinese, latin, data: r && r.data !== undefined ? r.data : true });
      } catch (err) {
        out.push({ photoId, ok: false, error: err.message || String(err) });
      }
    }
    return sendJson(res, 200, { ok: true, results: out });
  }

  /* 对站点上的照片跑识别：图先经代理取回，再走和本地图片一样的识别管线 */
  if (pathname === '/api/nat/identify' && req.method === 'POST') {
    return sendJson(res, 200, await apiIdentifyRemote(await readJson(req)));
  }

  /* 上传（后台任务）*/
  if (pathname === '/api/nat/upload' && req.method === 'POST') {
    const b = await readJson(req);
    const files = (Array.isArray(b.files) ? b.files : []).map((f) => asImage(f));
    if (!files.length) throw bad('没有要上传的图片');
    const mode = b.mode === 'species' ? 'species' : 'album';
    if (mode === 'album' && !b.albumId) throw bad('请先选一个目标相册');
    const id = startNatUpload({ files, mode, albumId: String(b.albumId || '') });
    return sendJson(res, 200, { ok: true, jobId: id, total: files.length });
  }

  if (pathname.startsWith('/api/nat/upload/') && req.method === 'GET') {
    return sendJson(res, 200, getNatUpload(pathname.slice('/api/nat/upload/'.length)));
  }

  /* 批量下载：站点给的是 zip 二进制，原样转发给浏览器存盘 */
  if (pathname === '/api/nat/download' && req.method === 'POST') {
    const b = await readJson(req);
    const { buffer, contentType } = await X.downloadFiles(b.ids, b.nameFields);
    const stamp = new Date().toISOString().slice(0, 10);
    res.writeHead(200, {
      'content-type': contentType || 'application/zip',
      'content-length': buffer.length,
      'content-disposition': `attachment; filename="nature-photos-${stamp}.zip"`,
      'cache-control': 'no-store',
    });
    res.end(buffer);
    return;
  }

  /* 下载真·原图：勾选（或本页）照片的原始文件逐张取回，本机打成 zip。
   * 和上面的「站点打包下载」不是一回事：这里拿到的是原图字节，不经站点压缩/改名。 */
  if (pathname === '/api/nat/original-zip' && req.method === 'POST') {
    const b = await readJson(req);
    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) throw bad('没有要下载的图片');
    const out = [];
    for (const it of items) {
      const u = String((it && it.url) || '');
      // 只允许本站地址，别把本地服务当成任意 URL 的代理
      if (!u.startsWith(NAT.SITE_BASE + '/')) continue;
      const rawName = String((it && it.name) || ('photo_' + (out.length + 1)));
      const name = rawName.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || ('photo_' + (out.length + 1));
      try {
        const { buffer: data } = await NAT.fetchImage(u);
        if (data && data.length) out.push({ name, data });
      } catch {
        /* 单张取不到不中断，最后提示缺了几张 */
      }
    }
    if (!out.length) throw bad('没有取到任何原图（地址可能已失效或需要重新登录）');
    const zip = zipStore(out);
    const stamp = new Date().toISOString().slice(0, 10);
    res.writeHead(200, {
      'content-type': 'application/zip',
      'content-length': zip.length,
      'content-disposition': `attachment; filename="nature-originals-${stamp}.zip"`,
      'cache-control': 'no-store',
    });
    return res.end(zip);
  }

  /* 清除本机缓存的自然在线图片（CACHE/nature-img）和拖入上传的临时文件。
   * 只删可重建的字节：账号令牌、待上传鉴定记录、评分结果一律不动。 */
  if (pathname === '/api/nat/cache/clear' && req.method === 'POST') {
    let files = 0;
    let bytes = 0;
    const dir = path.join(CACHE, 'nature-img');
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        try { bytes += fs.statSync(path.join(dir, e.name)).size; files += 1; } catch { /* ignore */ }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* 目录还不存在 */ }
    try { fs.rmSync(NAT_DROP, { recursive: true, force: true }); } catch { /* ignore */ }
    return sendJson(res, 200, { ok: true, files, bytes });
  }

  throw bad('未知接口：' + pathname, 404);
}

/**
 * 浏览器把本机文件夹拖进来时，文件没法直接拿到路径，只能把二进制 POST 上来。
 * 这里按批次落到缓存里，返回临时路径，再由 /api/nat/upload 走已有的后台上传任务。
 * 只取 basename + 扩展名白名单，挡住 ../../ 之类的路径穿越。
 */
async function apiNatDropFile(req, q) {
  const batch = String(q.get('batch') || '').trim();
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(batch)) throw bad('缺少有效的批次号');
  const raw = await readBody(req, 200 * 1024 * 1024);
  if (!raw.length) throw bad('文件是空的');
  let name = path.basename(String(q.get('name') || 'photo.jpg').replace(/[\\/]/g, '/'));
  name = name.replace(/[^\w.\- ()（）\u4e00-\u9fa5]/g, '_').slice(0, 120);
  const ext = path.extname(name).toLowerCase();
  if (!IMAGE_EXT.has(ext)) throw bad('不是支持的图片格式：' + ext);
  const dir = path.join(NAT_DROP, batch);
  fs.mkdirSync(dir, { recursive: true });
  let out = path.join(dir, name);
  let i = 1;
  while (fs.existsSync(out)) {
    out = path.join(dir, `${path.parse(name).name}_${i++}${ext}`);
  }
  fs.writeFileSync(out, raw);
  return { ok: true, path: out, name: path.basename(out) };
}

/* ---------------- 静态资源 ---------------- */

// 只允许同源脚本/样式；图片额外允许 data: 与 blob:（粘贴预览、大图查看用）。
// 页面里没有内联 <script>，所以 script-src 不需要 'unsafe-inline'。
const CSP =
  "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; " +
  "script-src 'self'; worker-src 'self' blob:; connect-src 'self'; font-src 'self'; " +
  "base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'";

const STATIC_GZ = new Map(); // 内容 sha1 → gzip Buffer，最多留 24 份
const TEXTUAL = /^(?:text\/|application\/(?:javascript|json)|image\/svg\+xml)/i;

function gzipCached(buf) {
  const key = crypto.createHash('sha1').update(buf).digest('hex');
  let gz = STATIC_GZ.get(key);
  if (!gz) {
    gz = zlib.gzipSync(buf, { level: 9 });
    if (STATIC_GZ.size >= 24) STATIC_GZ.delete(STATIC_GZ.keys().next().value);
    STATIC_GZ.set(key, gz);
  }
  return { key, gz };
}

/** If-None-Match 可能是一串、带 W/ 前缀，也可能直接是 * */
function etagMatched(req, etag) {
  const raw = String(req.headers['if-none-match'] || '');
  if (!raw) return false;
  return raw.split(',').some((part) => {
    const v = part.trim();
    return v === '*' || v === etag || v === `W/${etag}`;
  });
}

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
  const raw = hit.body;
  const mime = hit.mime || MIME[path.extname(rel).toLowerCase()] || 'application/octet-stream';
  const textual = TEXTUAL.test(mime);

  // 文本资源先 gzip 再发（首屏 app.js 325 KB → 约 106 KB）；图片已经是压缩格式，不动。
  // 缓存键是内容 sha1：源码模式下改了文件会立刻换新键，不会拿到上一次的旧压缩结果。
  let key;
  let gz = null;
  if (textual) ({ key, gz } = gzipCached(raw));
  else key = crypto.createHash('sha1').update(raw).digest('hex');
  const acceptsGzip = textual && /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''));
  const useGzip = Boolean(gz) && acceptsGzip && gz.length < raw.length;
  const body = useGzip ? gz : raw;
  const etag = `"${key}${useGzip ? '-gz' : ''}"`;

  const headers = {
    'content-type': mime,
    'cache-control': 'no-cache',
    etag,
    vary: 'Accept-Encoding',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  };
  if (useGzip) headers['content-encoding'] = 'gzip';
  if (/^text\/html/i.test(mime)) {
    headers['content-security-policy'] = CSP;
    headers['x-frame-options'] = 'DENY';
  }

  // 浏览器再次打开同一版页面只回 304，不重传几百 KB
  if (etagMatched(req, etag)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  headers['content-length'] = body.length;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') res.end();
  else res.end(body);
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
      // 用 src.preset（已经做过回落）而不是原始配置：老配置里存着 auto 的，这里要变植物
      preset: src.preset,
      rename: !!config.ui?.rename,
      renameOrder: ['first', 'last', 'only'].includes(config.ui?.renameOrder) ? config.ui.renameOrder : 'first',
      renamePick: ['cn', 'latin', 'both', 'latinCn'].includes(config.ui?.renamePick) ? config.ui.renamePick : 'cn',
      renameSuffix: String(config.ui?.renameSuffix || '').slice(0, 40),
      archive: !!config.ui?.archive,
      lastDir: config.ui?.lastDir || '',
    },
    // 检索地区：只给结果里那几个学名小标用，不影响识别
    linkPlace: {
      code: String(config.ui?.linkPlace?.code || ''),
      placeId: Number(config.ui?.linkPlace?.placeId) || 0,
      placeName: String(config.ui?.linkPlace?.placeName || ''),
    },
    ebird: {
      ready: Boolean(config.sites?.ebird?.apiKey),
      region: String(config.sites?.ebird?.region || ''),
    },
    // 只回「有没有」，不回明文 Key：GBIF 面板据此决定要不要走模型补中文名
    deepseek: {
      hasApiKey: Boolean(String(config.deepseek?.apiKey || '').trim()),
      model: String(config.deepseek?.model || 'deepseek-chat'),
    },
    // 内置大陆中文名录状态：设置页显示版本 / 收录条数，无需任何配置
    colcn: COLCN.stat(),
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

/* ---------------- 统计分析（bio-file 统计模块整合进标注工坊） ----------------
 * 完全复用标注工坊自己的数据层：imgmeta 读标签、exif 读拍摄时间/GPS、taxonomy 解分类。
 * 递归扫一个文件夹及其所有子文件夹，把每张「已标注 / 未标注」图喂给 lib/stats.js。
 */

/** 把数组按并发上限跑一遍，结果保持原顺序。统计页几千张图靠它把串行 IO 摊开。 */
async function mapLimit(list, limit, fn) {
  const arr = Array.from(list);
  const out = new Array(arr.length);
  let next = 0;
  const workers = Math.max(1, Math.min(Number(limit) || 1, arr.length || 1));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (;;) {
        const i = next++;
        if (i >= arr.length) return;
        out[i] = await fn(arr[i], i);
      }
    }),
  );
  return out;
}

// 行政区划改为离线索引（lib/regions.js + public/regions.bin）：
// 统计页不再联网反查 GPS，不会把坐标发给第三方；离最近城市超过 80 km 时
// 返回空，回落到文件夹名，避免把边远地区标到相邻省份。
async function walkStats(dir, root, out) {
  if (out.length >= MAX_STAT_FILES) return;
  let ents;
  try {
    ents = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    if (out.length >= MAX_STAT_FILES) return;
    if (e.name.startsWith('.')) continue; // 点开头的隐藏文件/目录（.git/.cache…）
    const full = path.join(dir, e.name);
    try {
      if (e.isDirectory()) {
        if (!isHiddenDir(e.name)) await walkStats(full, root, out);
      } else if (e.isFile() && IMAGE_EXT.has(path.extname(e.name).toLowerCase())) {
        const rel = path.relative(root, full).split(path.sep).join('/');
        const top = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : '';
        const folder = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '根目录';
        out.push({ full, name: e.name, stem: path.basename(e.name, path.extname(e.name)), top, folder });
      }
    } catch {
      /* 坏项跳过 */
    }
  }
}

async function analyzeStats(dir) {
  const root = path.resolve(dir);
  const files = [];
  await walkStats(root, root, files);

  // 1) 并发读标签 + EXIF：同一次读头把 XMP 和拍摄时间/GPS 一起拿回来。
  //    以前是串行 await，5000 张能拖到几十分钟；这里 8 路并发，且不再为 EXIF 二次开文件。
  const STAT_CONC = 8;
  const items = await mapLimit(files, STAT_CONC, async (f) => {
    let label = null;
    try {
      label = await IMG.readLabelFastAsync(f.full, { withMeta: true });
    } catch {}
    let { cn, latin } = splitNameFields(label || {});
    // 没写标签的图，名字往往就在文件名上（验收照片十有八九如此）。
    // 不回退读文件名的话，这些「文件名里有拉丁名」的图会被全算成未鉴定。
    if (!cn && !latin) {
      const nf = nameFieldsFromFile(f.name);
      cn = nf.cn;
      latin = nf.latin;
    }
    // 统计只用到时间/坐标；缩略图丢掉，5000 张能省几十 MB
    const ex = label && label.meta ? { ...label.meta, thumb: null } : { ...EX.EMPTY };
    let taken = null;
    if (ex.dateTime) {
      const d = new Date(String(ex.dateTime).replace(' ', 'T'));
      if (!Number.isNaN(d.getTime())) taken = d;
    }
    // 仿 bio-file：无 EXIF 拍摄时间时退回文件修改时间，让时间维度不至于全空
    if (!taken) {
      try {
        taken = new Date((await fsp.stat(f.full)).mtimeMs);
      } catch {
        taken = null;
      }
    }
    return { f, cn, latin, ex, taken };
  });

  // 2) 批量解析分类（复用标注工坊真实的分类缓存 + iNat/GBIF）
  const taxoMap = await TAXO.resolve(items.map((it) => ({ latin: it.latin, cn: it.cn })));

  // 3) 组装 records。GPS 用本地索引查省/市，不再联网；
  //    TAGDEN_NO_GEOCODE=1 时连本地标签也不用，只保留文件夹名。
  const records = [];
  for (const it of items) {
    const key = it.latin ? it.latin.toLowerCase() : `cn:${it.cn.toLowerCase()}`;
    const rec = taxoMap.get(key) || { ok: false, ranks: {} };
    const rk = (r) => (rec.ranks && rec.ranks[r]) || {};
    const labeled = !!(it.cn || it.latin);
    let region = it.f.top || '根目录';
    if (it.ex && it.ex.lat != null && it.ex.lon != null && process.env.TAGDEN_NO_GEOCODE !== '1') {
      const g = REGIONS.labelFor(it.ex.lat, it.ex.lon);
      if (g) region = g;
    }
    records.push({
      labeled,
      taxon: {
        resolved: !!rec.ok,
        kingdom: rk('kingdom').latin, kingdomCn: rk('kingdom').cn,
        phylum: rk('phylum').latin, phylumCn: rk('phylum').cn,
        class: rk('class').latin, classCn: rk('class').cn,
        order: rk('order').latin, orderCn: rk('order').cn,
        family: rk('family').latin, familyCn: rk('family').cn,
        genus: rk('genus').latin, genusCn: rk('genus').cn,
        cn: it.cn, latin: it.latin,
      },
      taken: it.taken,
      regionLabel: region,
      project: it.f.top || '根目录',
      folder: it.f.folder,
      stem: it.f.stem,
      path: it.f.full,
    });
  }

  // 4) 统计（已鉴定才进分类树/维度；未鉴定单独给数字+分组）
  const level = STATS.levelCounts(records);
  const labeledRecords = records.filter((r) => r.labeled);
  const dims = {};
  for (const [dim] of STATS.DIMENSIONS) dims[dim] = STATS.byDimension(labeledRecords, dim);
  const tree = STATS.buildTree(records);
  const unidentified = STATS.unidentifiedGroup(records);

  return {
    ok: true,
    path: root,
    total: records.length,
    truncated: files.length >= MAX_STAT_FILES,
    level,
    dimensions: STATS.DIMENSIONS.map(([dim, label]) => ({ dim, label, data: dims[dim] })),
    tree,
    unidentified,
  };
}

/* ---------------- 图库索引 / 搜索 / 重复文件 ---------------- */

const LIB_JOBS = new Map();

function libJobView(job) {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    phase: job.phase,
    done: job.done,
    total: job.total,
    current: job.current,
    error: job.error,
    result: job.status === 'done' ? job.result : null,
  };
}

function startLibJob(kind, fn) {
  const job = {
    id: crypto.randomUUID(),
    kind,
    status: 'running',
    phase: 'starting',
    done: 0,
    total: 0,
    current: '',
    error: '',
    cancelled: false,
    result: null,
    startedAt: Date.now(),
  };
  LIB_JOBS.set(job.id, job);
  for (const [id, j] of LIB_JOBS) {
    if (Date.now() - j.startedAt > 3600000) LIB_JOBS.delete(id);
  }
  Promise.resolve()
    .then(() => fn(job))
    .then((result) => {
      if (job.cancelled) {
        job.status = 'cancelled';
        return;
      }
      job.status = 'done';
      job.result = result;
      job.phase = 'done';
    })
    .catch((err) => {
      job.status = job.cancelled ? 'cancelled' : 'error';
      job.error = err && err.message ? err.message : String(err);
    });
  return job.id;
}

async function handleLibrary(req, res, pathname, q) {
  if (pathname === '/api/library/status' && req.method === 'GET') {
    return sendJson(res, 200, LIB.status());
  }

  if (pathname === '/api/library/search' && req.method === 'GET') {
    return sendJson(res, 200, LIB.search({
      q: q.get('q') || '',
      filter: q.get('filter') || 'all',
      limit: q.get('limit') || 120,
      offset: q.get('offset') || 0,
    }));
  }

  if (pathname === '/api/library/scan' && req.method === 'POST') {
    const b = await readJson(req);
    const root = String(b.root || '').trim();
    if (!root) throw bad('请填写要索引的文件夹路径');
    const id = startLibJob('scan', async (job) => {
      job.phase = 'walking';
      return LIB.scan(root, {
        isCancelled: () => job.cancelled,
        onProgress: (p) => {
          job.phase = p.phase;
          job.done = p.done;
          job.total = p.total || 0;
          job.current = p.current || '';
        },
      });
    });
    return sendJson(res, 200, { ok: true, id });
  }

  if (pathname === '/api/library/duplicates' && req.method === 'POST') {
    const id = startLibJob('duplicates', async (job) => {
      job.phase = 'hashing';
      return LIB.duplicates({
        isCancelled: () => job.cancelled,
        onProgress: (p) => {
          job.phase = p.phase;
          job.done = p.done;
          job.total = p.total || 0;
          job.current = p.current || '';
        },
      });
    });
    return sendJson(res, 200, { ok: true, id });
  }

  const scanJob = /^\/api\/library\/scan\/([^/]+)$/.exec(pathname);
  if (scanJob && req.method === 'GET') {
    const job = LIB_JOBS.get(scanJob[1]);
    if (!job) throw bad('任务不存在或已过期');
    return sendJson(res, 200, { ok: true, ...libJobView(job) });
  }
  if (scanJob && req.method === 'POST' && pathname.endsWith('/cancel')) {
    // 不会走到这里（路径多了一段 /cancel），保留给下面的显式匹配
  }
  const cancelJob = /^\/api\/library\/(scan|duplicates)\/([^/]+)\/cancel$/.exec(pathname);
  if (cancelJob && req.method === 'POST') {
    const job = LIB_JOBS.get(cancelJob[2]);
    if (!job) throw bad('任务不存在或已过期');
    job.cancelled = true;
    return sendJson(res, 200, { ok: true });
  }

  const dupJob = /^\/api\/library\/duplicates\/([^/]+)$/.exec(pathname);
  if (dupJob && req.method === 'GET') {
    const job = LIB_JOBS.get(dupJob[1]);
    if (!job) throw bad('任务不存在或已过期');
    return sendJson(res, 200, { ok: true, ...libJobView(job) });
  }

  throw bad('未知的图库接口');
}

async function apiStats(q) {
  let dir;
  try {
    dir = asDir(q.get('path'));
  } catch (err) {
    return { ok: false, error: err.message };
  }
  try {
    return await analyzeStats(dir);
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}


/**
 * 「照片评分」内置接口。
 *
 * 分工：JPEG 解码和 v2 算法都在浏览器 Web Worker（public/score-worker.js）里，
 * 服务端只做持久化、批内星级、连拍分组、AI 设置与 AI 请求转发。
 * 这样既保住「零依赖单文件 exe」，又让 SV=2 的分数和 bio-image 完全一致。
 */
async function handleScore(req, res, pathname, q) {
  const fallbackDir = () => config.ui?.lastDir || places()[0]?.path;
  const dirOf = (v) => asDir(v || fallbackDir());

  // 读取整个目录的评分（含星级分布）。切到评分页 / 换文件夹时调一次
  if (pathname === '/api/score/view' && req.method === 'GET') {
    return sendJson(res, 200, SCORE.view(dirOf(q.get('dir'))));
  }
  // Worker 一批算完就提交，服务端合并后重算星级
  if (pathname === '/api/score/put' && req.method === 'POST') {
    const b = await readJson(req);
    const dir = dirOf(b.dir);
    const data = SCORE.put(dir, b.entries || {});
    return sendJson(res, 200, { ok: true, updated: data.updated, scored: Object.keys(data.scores).length });
  }
  if (pathname === '/api/score/clear' && req.method === 'POST') {
    const b = await readJson(req);
    const dir = dirOf(b.dir);
    // names 为空 = 整个目录清空；给了就是只清这几张（界面上勾了几张就清几张）
    const names = Array.isArray(b.names) ? b.names : null;
    const r = SCORE.clear(dir, names);
    return sendJson(res, 200, { ok: true, cleared: r.cleared || 0, scope: names && names.length ? 'names' : 'dir' });
  }
  // 评分分组里的「搬到某个文件夹」：按低于多少分筛，或直接给一组文件名。
  // 和「按分类归档」不同，这里是平铺搬过去、不建分类树；评分记录跟着照片一起走。
  if (pathname === '/api/score/move' && req.method === 'POST') {
    const b = await readJson(req);
    const dir = dirOf(b.dir);
    const dest = asDir(String(b.dest || '').trim());
    if (path.resolve(dest).toLowerCase() === path.resolve(dir).toLowerCase()) {
      throw bad('目标文件夹不能就是当前文件夹');
    }
    const view = SCORE.view(dir);
    let names;
    if (Array.isArray(b.files) && b.files.length) {
      names = [...new Set(b.files.map(String).filter((n) =>
        n && !n.startsWith('.') && !n.includes('/') && !n.includes('\\') && !n.includes('..') && SCORE.isImage(n)))];
    } else {
      const below = Number(b.below);
      if (!Number.isFinite(below)) throw bad('请填一个 0–100 的分数');
      names = Object.keys(view.scores).filter((n) => {
        const r = view.scores[n] || {};
        const v = r.final !== undefined && r.final !== null ? Number(r.final) : Number(r.total);
        return Number.isFinite(v) && v < below;
      });
    }
    fs.mkdirSync(dest, { recursive: true });
    const movedNames = [];
    const moving = {};
    const failed = [];
    for (const n of names) {
      const src = path.join(dir, n);
      if (!fs.existsSync(src)) continue;
      const target = uniquePath(path.join(dest, n));
      try {
        try { fs.renameSync(src, target); }
        catch (e) {
          if (e.code !== 'EXDEV') throw e;
          fs.copyFileSync(src, target);
          fs.unlinkSync(src);
        }
        const landed = path.basename(target);
        movedNames.push(n);
        if (view.scores[n]) moving[landed] = view.scores[n];
      } catch (e) {
        failed.push({ name: n, error: e.message });
      }
    }
    // 先搬文件再写评分：put 会按「目标目录里确实存在这张图」重算星级
    if (Object.keys(moving).length) {
      try { SCORE.put(dest, moving); } catch { /* 评分没跟上不影响照片已经搬走 */ }
    }
    if (movedNames.length) SCORE.clear(dir, movedNames);
    return sendJson(res, 200, { ok: true, dest, moved: movedNames.length, names: movedNames, failed });
  }
  // 评分前一次拿齐 ISO / 拍摄时间 / 体积，别让 Worker 一张一张回来问
  if (pathname === '/api/score/meta' && req.method === 'POST') {
    const b = await readJson(req);
    const dir = dirOf(b.dir);
    const names = (Array.isArray(b.names) ? b.names : []).slice(0, 5000).map(String);
    const out = {};
    for (const n of names) {
      if (!n || n.startsWith('.') || n.includes('/') || n.includes('\\') || n.includes('..')) continue;
      if (!SCORE.isImage(n)) continue;
      const full = path.join(dir, n);
      if (!fs.existsSync(full)) continue;
      out[n] = SCORE.fileMeta(full);
    }
    return sendJson(res, 200, { ok: true, dir, meta: out });
  }
  if (pathname === '/api/score/bursts' && req.method === 'GET') {
    return sendJson(res, 200, SCORE.bursts(dirOf(q.get('dir')), q.get('gap')));
  }
  // 评分页的子文件夹条：上一层 / 本层张数 / 子文件夹（带各层张数）
  if (pathname === '/api/score/dirs' && req.method === 'GET') {
    return sendJson(res, 200, await apiScoreDirs(q));
  }

  // ---- 本地大模型：内置运行库 + 一键拉起 llama-server ----
  if (pathname === '/api/score/llama/status' && req.method === 'GET') {
    return sendJson(res, 200, LLAMA.status());
  }
  if (pathname === '/api/score/llama/models' && req.method === 'GET') {
    return sendJson(res, 200, LLAMA.listModels(q.get('dir') || ''));
  }
  if (pathname === '/api/score/llama/start' && req.method === 'POST') {
    const b = await readJson(req);
    const r = await LLAMA.start({
      model: b.model,
      mmproj: b.mmproj,
      ctx: b.ctx,
      ngl: b.ngl,
      threads: b.threads,
    });
    return sendJson(res, 200, r);
  }
  if (pathname === '/api/score/llama/stop' && req.method === 'POST') {
    return sendJson(res, 200, LLAMA.stop());
  }
  // 在文件管理器里打开 models 文件夹（用户自己下的 gguf 直接丢进去就行）
  if (pathname === '/api/score/llama/open-models' && req.method === 'POST') {
    const b = await readJson(req);
    return sendJson(res, 200, LLAMA.openModelDir(b.dir));
  }
  // ---- 模型在线下载：清单 / 开始 / 取消 / 删除 ----
  // 只下到本机 models 目录，不下别的东西；进度靠前端轮询同一个清单接口
  if (pathname === '/api/score/llama/catalog' && req.method === 'GET') {
    return sendJson(res, 200, LLAMA.catalogState());
  }
  if (pathname === '/api/score/llama/download' && req.method === 'POST') {
    const b = await readJson(req);
    return sendJson(res, 200, LLAMA.startDownload(String(b.id || '')));
  }
  if (pathname === '/api/score/llama/download/cancel' && req.method === 'POST') {
    const b = await readJson(req);
    return sendJson(res, 200, LLAMA.cancelDownload(String(b.id || '')));
  }
  if (pathname === '/api/score/llama/remove' && req.method === 'POST') {
    const b = await readJson(req);
    return sendJson(res, 200, LLAMA.removeDownload(String(b.id || '')));
  }

  // ---- AI 设置：明文 Key 只在服务端内存里，永远不回浏览器 ----
  if (pathname === '/api/score/ai' && req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      cfg: SCORE.aiPublic(),
      cloudModels: SCAI.CLOUD_MODELS,
      localGuide: SCAI.LOCAL_GUIDE,
      taxa: SCAI.TAXA,
    });
  }
  if (pathname === '/api/score/ai' && req.method === 'POST') {
    const b = await readJson(req);
    return sendJson(res, 200, { ok: true, cfg: SCORE.aiSet(b) });
  }
  if (pathname === '/api/score/ai/test' && req.method === 'POST') {
    const b = await readJson(req);
    const r = await SCAI.test({ engine: b.engine, cfg: SCORE.aiPublic(), key: SCORE.aiRaw().key });
    return sendJson(res, 200, r);
  }
  // 浏览器压好图再传，服务端转发到云端 / 本地 llama-server，并把结果写回评分缓存
  if (pathname === '/api/score/ai/run' && req.method === 'POST') {
    const b = await readJson(req);
    const cfg = SCORE.aiPublic();
    // 本地引擎以「真正在跑的那个 llama-server」为准：设置里存的地址可能是上一次的端口，
    // 端口漂移（18080 被占会往后顺延）或程序重启后没同步，请求就会打到空气里。
    if (b.engine === 'local') {
      const live = LLAMA.status();
      if (live && live.running && live.baseUrl && (!cfg.local || cfg.local.baseUrl !== live.baseUrl)) {
        cfg.local = { ...(cfg.local || {}), baseUrl: live.baseUrl };
        try { SCORE.aiSet({ local: { baseUrl: live.baseUrl } }); } catch { /* 存不上不挡这次请求 */ }
      }
    }
    const r = await SCAI.run({
      engine: b.engine,
      cfg,
      key: SCORE.aiRaw().key,
      images: b.images || [],
      taxon: b.taxon,
      strict: b.strict,
    });
    // 落盘时带上这次用的判据（哪个类群、是否严格模式）：详情面板要显示
    // 「按植物判据」还是「专用昆虫检测」，不然用户没法确认选择到底生效没。
    const aiRec = (one) => ({
      ai: one.ai,
      ai_taxon: r.taxon || '',
      ...(r.strict ? { strict: true } : {}),
      ...(r.strict && r.taxon === '昆虫' ? { insect_strict: true } : {}),
    });
    if (b.dir && r.results) {
      const entries = {};
      for (const one of r.results) {
        if (!one.ai) continue;
        entries[one.name] = aiRec(one);
      }
      if (Object.keys(entries).length) SCORE.put(dirOf(b.dir), entries);
    }
    // 相册照片（相册端）：结果按 photoId 合并进 remote 记录，不动本机目录的评分
    if (b.remote && r.results) {
      const patch = {};
      for (const one of r.results) {
        if (!one.ai || !one.name) continue;
        patch[String(one.name)] = aiRec(one);
      }
      if (Object.keys(patch).length) SCORE.remoteAi(patch);
    }
    // 跑挂了也要把真实错误带出来：api() 抛错时只认顶层 error，而 SCAI.run 把错误
    // 放在 errors[] 里；不搬一层，前端就只能看到没用的「HTTP 200」。
    if (r.ok === false && !r.error && r.errors && r.errors.length) r.error = r.errors[0];
    return sendJson(res, 200, r);
  }

  // ---- 自然在线相册里的照片也能评分：按 photoId 存，不参与本机目录的批内星级 ----
  if (pathname === '/api/score/remote' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, items: SCORE.remoteGet() });
  }
  if (pathname === '/api/score/remote' && req.method === 'POST') {
    const b = await readJson(req);
    const key = String(b.key || '').slice(0, 120);
    if (!key) throw bad('缺少照片编号');
    SCORE.remotePut(key, { rec: b.rec || {}, name: String(b.name || ''), source: String(b.source || '') });
    return sendJson(res, 200, { ok: true });
  }
  // 评分页相册端「清除评分」：只清所选 photoId 的评分记录，站点照片和本机目录评分都不动
  if (pathname === '/api/score/remote/clear' && req.method === 'POST') {
    const b = await readJson(req);
    const keys = Array.isArray(b.keys) ? b.keys.map(String).slice(0, 5000) : [];
    return sendJson(res, 200, { ok: true, cleared: SCORE.remoteClear(keys) });
  }
  return sendJson(res, 404, { ok: false, error: '未知的照片评分接口' });
}

async function handleApi(req, res, pathname, q) {
  if (pathname === '/api/state') return sendJson(res, 200, apiState());

  // 候选物种悬停时的科属信息：一次把 8 个候选批量查了，命中缓存就不联网。
  // 只回科、属两级 —— 界面上够用，也不把整条分类链塞进前端。
  if (pathname === '/api/taxonomy' && req.method === 'POST') {
    const b = await readJson(req);
    const items = (Array.isArray(b.items) ? b.items : []).slice(0, 24)
      .map((x) => ({
        latin: String((x && x.latin) || '').trim().slice(0, 120),
        cn: String((x && x.cn) || '').trim().slice(0, 120),
      }))
      .filter((x) => x.latin || x.cn);
    let m = new Map();
    try { m = await TAXO.resolve(items); } catch { /* 断网就当查不到，绝不影响识别 */ }
    const out = {};
    for (const [k, rec] of m) {
      const f = rec && rec.ok && rec.ranks && rec.ranks.family;
      const g = rec && rec.ok && rec.ranks && rec.ranks.genus;
      out[k] = {
        family: f ? { latin: String(f.latin || ''), cn: String(f.cn || '') } : null,
        genus: g ? { latin: String(g.latin || ''), cn: String(g.cn || '') } : null,
      };
    }
    return sendJson(res, 200, { ok: true, items: out });
  }

  // 自然在线（账号相册）：整块交给 handleNature，动静大，单独一个文件级的分支
  if (pathname.startsWith('/api/nat/')) return handleNature(req, res, pathname, q);
  // 照片评分（内置）：整块交给 handleScore
  if (pathname.startsWith('/api/score/')) return handleScore(req, res, pathname, q);

  // 统计分析：递归扫当前文件夹及其子文件夹下所有已标注/未标注物种图
  if (pathname === '/api/stats') return sendJson(res, 200, await apiStats(q));

  // 图库：全库索引 / 搜索 / 重复文件
  if (pathname.startsWith('/api/library/')) return handleLibrary(req, res, pathname, q);

  // 盘符（左侧树的根）。卷标是后台查的，第一次可能还没到，前端据此再拉一次
  if (pathname === '/api/drives') {
    if (q.get('fresh') === '1') drivesCache = null; // 插拔了 U 盘，不要用一分钟前的缓存
    const labelsPending = !LABELS.size && process.platform === 'win32';
    if (labelsPending) loadDriveLabels().then(() => { drivesCache = null; });
    return sendJson(res, 200, { ok: true, drives: drives(), labelsPending });
  }

  // 树展开：只列子文件夹
  if (pathname === '/api/dirs') return sendJson(res, 200, await apiDirs(q));

  if (pathname === '/api/subdirs') return sendJson(res, 200, await apiSubdirs(q));

  // 某个文件夹里的图片路径（可递归）：给「左侧文件夹拖到相册」用
  if (pathname === '/api/images') return sendJson(res, 200, await apiImages(q));

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

  /* 单张图直接粘贴识别：图不在磁盘上，前端把压好的两份 JPEG 送过来即可。
   * 走的是和本地文件完全一样的 identifyImage，站点开关、去重、聚合都不用另写一套。 */
  if (pathname === '/api/identify/paste' && req.method === 'POST') {
    const body = await readJson(req);
    const raw = String(body.dataJpeg || '');
    const b64 = raw.replace(/^data:image\/[^;]+;base64,/, '');
    if (!b64) throw bad('没有图片数据');
    const jpeg = Buffer.from(b64, 'base64');
    const smallRaw = String(body.dataSmall || '').replace(/^data:image\/[^;]+;base64,/, '');
    const small = smallRaw ? Buffer.from(smallRaw, 'base64') : null;
    const name = String(body.name || '').trim() || '粘贴图片.jpg';
    const out = await identifyImage({
      buffer: jpeg,
      mime: 'image/jpeg',
      filename: name,
      small,
      jpeg,
      sources: body.sources,
      force: body.force === true,
    });
    return sendJson(res, 200, { ...out, name, pasted: true });
  }

  if (pathname === '/api/write' && req.method === 'POST') {
    return sendJson(res, 200, await apiWrite(await readJson(req)));
  }

  if (pathname === '/api/undo' && req.method === 'GET') {
    return sendJson(res, 200, undoStatus());
  }
  if (pathname === '/api/undo' && req.method === 'POST') {
    return sendJson(res, 200, await apiUndoLast());
  }

  if (pathname === '/api/config/export' && req.method === 'POST') {
    const b = await readJson(req);
    return sendJson(res, 200, { ok: true, envelope: configEnvelope(b.passphrase) });
  }
  if (pathname === '/api/config/import' && req.method === 'POST') {
    const b = await readJson(req);
    return sendJson(res, 200, importConfig(b.envelope, b.passphrase));
  }

  if (pathname === '/api/export' && req.method === 'POST') {
    return sendJson(res, 200, await apiExport(await readJson(req)));
  }

  if (pathname === '/api/archive' && req.method === 'POST') {
    const body = await readJson(req);
    // 实际归并（apply:true）改成后台任务，前端轮询进度条；预览（apply:false）仍同步返回
    if (body.apply === true) {
      try {
        const id = startArchiveJob(body);
        return sendJson(res, 200, { ok: true, jobId: id });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: e.message });
      }
    }
    return sendJson(res, 200, await apiArchive(body));
  }

  if (pathname.startsWith('/api/archive/job/') && req.method === 'GET') {
    const id = pathname.slice('/api/archive/job/'.length);
    return sendJson(res, 200, getArchiveJob(id));
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

  /* ---------------- 学名旁的查询小标（从聚合台并进来） ----------------
   * 结果里每个候选学名旁边都会挂 iNat / PPBC / 自然在线 / GBIF 几个小标，点开是
   * 「拿这个属名去别处查一眼」。它们不参与打分，所以哪一个查不动都不该影响识别，
   * 接口一律回 200，只把 ok:false 和原因带回去。
   *
   * 「检索地区」只决定深链跳到哪个范围（福建 / 全世界），不影响识别本身；
   * 存在 config.ui.linkPlace。三项必须整体替换 —— 选了「全世界」只传 code 时，
   * placeId 一兜底就变回上一次的武夷山，结果按福建算了。
   */
  if (pathname === '/api/inat/taxa' && req.method === 'POST') {
    const body = await readJson(req);
    const names = Array.isArray(body.names) ? body.names.slice(0, 30) : [];
    try {
      const taxa = await INAT.resolveTaxa(names, String(body.hint || ''));
      return sendJson(res, 200, { ok: true, taxa });
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: err.message || 'iNaturalist 查询失败', taxa: {} });
    }
  }

  if (pathname === '/api/inat/places' && req.method === 'GET') {
    const kw = String(q.get('q') || '').trim();
    if (kw.length < 2) return sendJson(res, 200, { ok: true, results: [] });
    try {
      const results = await INAT.searchPlaces(kw, 8);
      return sendJson(res, 200, { ok: true, results });
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: err.message || '地区搜索失败', results: [] });
    }
  }

  // 手动验证 / 调试用：一条 GET 就能看到拼出来的 iNat 深链
  if (pathname === '/api/inat/link' && req.method === 'GET') {
    const genus = INAT.genusOf(q.get('latin') || '');
    if (!genus) return sendJson(res, 200, { ok: false, error: '学名里认不出属名' });
    const taxa = await INAT.resolveTaxa([genus], q.get('hint') || '').catch(() => ({}));
    const hit = taxa[genus.toLowerCase()];
    const customId = Number(q.get('placeId')) || 0;
    const lp = linkPlaceOf(q);
    const resolved = INAT.resolvePlace(
      customId > 0 ? { placeId: customId, placeName: q.get('placeName') || '' } : { place: lp.code },
    );
    return sendJson(res, 200, {
      ok: true,
      genus,
      taxonId: hit ? hit.id : 0,
      place: resolved.name,
      placeId: resolved.placeId,
      custom: resolved.custom,
      url: INAT.buildUrl({ genus, taxonId: hit ? hit.id : 0, placeId: resolved.placeId }),
    });
  }

  // 植物智：地区 → pro（省）+ didian（地点）两个参数，同时给出人类可读的范围
  if (pathname === '/api/ppbc/region' && req.method === 'GET') {
    try {
      const r = await PPBC.resolveRegion(linkPlaceOf(q));
      return sendJson(res, 200, { ok: true, ...r, scope: PPBC.scopeLabel(r) });
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: err.message || '换算地区失败' });
    }
  }

  if (pathname === '/api/ppbc/link' && req.method === 'GET') {
    const genus = INAT.genusOf(q.get('latin') || q.get('genus') || '');
    if (!genus) return sendJson(res, 200, { ok: false, error: '学名里认不出属名' });
    const region = await PPBC.resolveRegion(linkPlaceOf(q));
    return sendJson(res, 200, {
      ok: true,
      genus,
      place: region.name,
      pro: region.pro,
      didian: region.didian,
      scope: PPBC.scopeLabel(region),
      url: PPBC.buildUrl({ genus, pro: region.pro, didian: region.didian }),
    });
  }

  /* 自然在线：按地区查「这个属在本地名录里有哪些种」。和看图识别共用同一张令牌。
   * 站点搜索用中文标题模糊匹配，关键词由检索地区名推（「南平市武夷山市」→「武夷山」），
   * 面板里也能手填。名录接口只能整份拉，所以 lib/nature.js 里按站点缓存 30 分钟。 */
  if (pathname === '/api/nature/sites' && req.method === 'GET') {
    const genus = INAT.genusOf(q.get('genus') || q.get('latin') || '');
    if (!genus) return sendJson(res, 200, { ok: false, error: '学名里认不出属名' });
    // 关键词优先级：手填的 q > 检索地区推出来的
    let keyword = String(q.get('q') || '').trim();
    let scope = '';
    if (!keyword) {
      const region = await PPBC.resolveRegion(linkPlaceOf(q)).catch(() => null);
      keyword = GNAT.keywordOf(region?.didian || region?.pro || region?.name || '');
      scope = PPBC.scopeLabel(region || {});
    }
    // 名录是只读查询、与账号无关：用户自己的令牌优先，没登录就用内置识别账号的
    const token = String(config.sites?.xingse?.token || '') || NATSHARE.token();
    try {
      const out = await GNAT.genusBySites(token, { genus, keyword });
      return sendJson(res, 200, { ok: true, scope, ...out });
    } catch (err) {
      return sendJson(res, 200, {
        ok: false,
        genus,
        keyword,
        scope,
        error: err.message || '自然在线查询失败',
      });
    }
  }

  /* 自然在线「照片高级搜索」：按「目标类群（属名）+ 地名」查站内照片。
   * 站方这个接口是私有 POST（/api/online/natureInquiry/inquiry/photo/advanced），
   * 表单在站内是个弹窗、不吃 URL 参数，所以这里先在服务端问一次数量，
   * 再把用户送到站内的搜索结果页（/msearch?kw=属名 会自动执行搜索）。
   * 只回照片数和几张样本，令牌不出服务端。 */
  if (pathname === '/api/nature/photo-adv' && req.method === 'GET') {
    const genus = INAT.genusOf(q.get('genus') || q.get('latin') || '');
    if (!genus) return sendJson(res, 200, { ok: false, error: '学名里认不出属名' });
    const lp = linkPlaceOf(q);
    const region = await PPBC.resolveRegion(lp).catch(() => null);
    // 前端 aggPlaceQS() 传的 place 是省代码（CN-35），站方高级搜索只认中文地名。
    // 先经 resolveRegion 换成「福建」，自定义地区则用用户填的地名；全国范围不按地区筛。
    let place =
      GNAT.keywordOf(region?.didian || region?.pro || '') ||
      String(lp.placeName || '').trim() ||
      GNAT.keywordOf(region?.name || '');
    if (!lp.code && !lp.placeId) place = '';
    const token = String(config.sites?.xingse?.token || '') || NATSHARE.token();
    const url =
      'https://ecp.ibiodiversity.cn/msearch?kw=' + encodeURIComponent(genus) +
      (place ? '&place=' + encodeURIComponent(place) : '');
    let total = 0;
    let sample = [];
    let err = '';
    try {
      const body = {
        keyword: genus,
        userScope: 'all',
        users: [],
        years: [],
        months: [],
        countryId: '',
        regionId: '',
        provinceId: '',
        cityId: '',
        countyId: '',
        placeKeyword: place,
        pageNum: 1,
        pageSize: 3,
      };
      const resp = await fetch('https://ecp.ibiodiversity.cn/api/online/natureInquiry/inquiry/photo/advanced', {
        method: 'POST',
        headers: {
          'content-type': 'application/json;charset=UTF-8',
          accept: 'application/json, text/plain, */*',
          origin: 'https://ecp.ibiodiversity.cn',
          referer: 'https://ecp.ibiodiversity.cn/',
          ...(token ? { authorization: 'Bearer ' + token } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
      const j = await resp.json();
      if (j.code !== '00000') err = String(j.msg || '站方返回了错误');
      else {
        const out = j.data?.result || {};
        total = Number(out.total) || 0;
        sample = (Array.isArray(out.records) ? out.records : []).map((r) => ({
          photoId: String(r.photoId || ''),
          cn: String(r.cname || ''),
          latin: String(r.lname || ''),
          location: String(r.location || ''),
        }));
      }
    } catch (e) {
      err = e.message || '连不上自然在线';
    }
    return sendJson(res, 200, { ok: true, genus, place, total, sample, url, error: err });
  }

  /* GBIF：这个属在这个地区有哪些种。
   * GBIF 自己的 REST 接口是公开的（只读不需要任何 Key）；中文名先取 iNaturalist，
   * 配了 DeepSeek Key 才补剩下的 + 写归纳。模型归纳单独一块并标明「未经核实」。 */
  if (pathname === '/api/gbifds/query' && req.method === 'GET') {
    const genus = INAT.genusOf(q.get('genus') || q.get('latin') || '');
    if (!genus) return sendJson(res, 200, { ok: false, error: '学名里认不出属名' });
    // 同名属在动植物里都有（Ficus 桑科/䗉螺、Pieris 马醉木/粉蝶），不带界 GBIF 匹配不到；
    // 通用组不知道是哪一类，交给 lib/gbifds.js 依次试。
    const group = String(q.get('group') || '').trim();
    const kingdom =
      group === 'plant' ? 'Plantae' : group === 'fungi' ? 'Fungi' : group === 'general' ? '' : 'Animalia';
    const lp = linkPlaceOf(q);
    const region = await PPBC
      .resolveRegion(lp)
      .catch(() => ({ pro: '', didian: '', inChina: true, name: '', custom: false }));
    // resolveRegion 只回 pro/didian，国家码得自己补 —— GBIF 靠它筛境外
    region.code = lp.code;

    let data;
    try {
      data = await GBIFDS.query({ genus, kingdom, region });
    } catch (err) {
      return sendJson(res, 200, { ok: false, genus, error: err.message || 'GBIF 查询失败' });
    }
    // 记录没查成 ≠ 该地区没有分布，这两种情况必须分开
    if (data.facetError) {
      return sendJson(res, 200, {
        ok: false,
        genus: data.genus,
        error: `GBIF 的记录没能取到（${data.facetError}）。这不代表该地区没有分布，过一会儿再试一次。`,
      });
    }
    const area = data.scope || region.name || '全球';
    const question = `请通过 GBIF 查询 ${data.genus} 属在 ${area} 的全部种有哪些？`;

    // 中文名问 iNaturalist（志愿者投票出来的俗名，可追溯），取不到再让 DeepSeek 补。
    // iNaturalist 的优先级永远高于模型 —— 模型爱「顺手纠正」已有名字，这里不让它改。
    let inat = { map: {}, tried: 0, stopped: false };
    try {
      inat = await GBIFDS.inatChineseNames(data.species);
    } catch {
      /* 网络不通就当没拿到，不影响 GBIF 的表 */
    }
    const dsKey = String(config.deepseek?.apiKey || '').trim();
    const dsModel = String(config.deepseek?.model || 'deepseek-chat');
    let answer = null;
    let warning = '';
    if (!dsKey) {
      warning = 'GBIF 的读取接口是公开的、不需要 API Key；这里缺的是补中文名和归纳用的 DeepSeek Key。到「照片评分 → AI 设置」里填一个就能补齐。';
    } else {
      try {
        answer = await GBIFDS.ask({ apiKey: dsKey, model: dsModel, question, data, known: inat.map });
      } catch (err) {
        warning = 'DeepSeek 没答上来：' + (err.message || '未知错误') + '（GBIF 记录和 iNaturalist 中文名不受影响）';
      }
    }
    let nInat = 0;
    let nDs = 0;
    const species = (data.species || []).map((s) => {
      const fromInat = GBIFDS.lookupCn(inat.map, s.latin);
      const cn = fromInat || GBIFDS.lookupCn(answer && answer.cn, s.latin);
      if (fromInat) nInat += 1;
      else if (cn) nDs += 1;
      return { ...s, cn: cn || '', cnFrom: cn ? (fromInat ? 'inat' : 'ds') : '' };
    });
    const named = species.filter((s) => s.cn).length;
    if (!warning) {
      warning = named
        ? `中文名 ${named}/${species.length} 个：iNaturalist ${nInat} · DeepSeek ${nDs}，学名一律以 GBIF 为准。`
        : 'GBIF 有记录，但两处都没配出中文名；下面就是原始记录。';
    }
    return sendJson(res, 200, {
      ok: true,
      question,
      kingdom,
      regionName: data.scope,
      regionNote: data.note,
      genus: data.genus,
      family: data.family,
      usageKey: data.usageKey,
      isSynonym: Boolean(data.isSynonym),
      acceptedGenus: data.acceptedGenus || '',
      globalTotal: data.globalTotal,
      records: data.records,
      species,
      level: data.level,
      // 模型归纳单独一块，前端会标明「未经核实」，别和 GBIF 记录混在一张表里
      answer: answer
        ? { ...answer, cnStats: { inat: nInat, ds: nDs, missing: species.length - named } }
        : { summary: '', cn: {}, extra: [], cnStats: { inat: nInat, ds: nDs, missing: species.length - named } },
      warning,
      cnLookup: { tried: inat.tried || 0, stopped: Boolean(inat.stopped) },
      deepseek: { hasApiKey: Boolean(dsKey), model: dsModel },
    });
  }

  /* eBird：坐标 → 地区码（前端点开 eBird 时先要一次定位） */
  if (pathname === '/api/ebird/region' && req.method === 'GET') {
    const cfg = config.sites?.ebird || {};
    if (!cfg.apiKey) return sendJson(res, 200, { ok: false, error: 'eBird 未配置 API key' });
    try {
      const out = await EBIRD.regionAt(cfg, Number(q.get('lat')), Number(q.get('lng')));
      return sendJson(res, 200, { ok: Boolean(out.code), ...out });
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: err.message || '定位换算失败' });
    }
  }

  /* eBird：候选学名在本地区近 14 天有没有记录。不参与打分，只作旁证。 */
  if (pathname === '/api/ebird/check' && req.method === 'POST') {
    const body = await readJson(req);
    const names = Array.isArray(body.sciNames) ? body.sciNames : [];
    const cfg = { ...(config.sites?.ebird || {}) };
    if (body.region) cfg.region = String(body.region).trim();
    if (!cfg.apiKey) {
      return sendJson(res, 200, { ok: false, error: 'eBird 未配置 API key', skipped: true });
    }
    try {
      const out = await EBIRD.check(cfg, names);
      return sendJson(res, 200, { ok: true, ...out });
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: err.message || 'eBird 查询失败' });
    }
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

  // 物种名核对：只回补齐建议，不写文件、不改名字；写回由界面确认后自行提交。
  if (pathname === '/api/species/complete' && req.method === 'POST') {
    return sendJson(res, 200, await apiSpeciesComplete(await readJson(req)));
  }

  // 内置大陆中文名录自检：拿一个学名查一下内置索引，确认名录随程序带上了。
  // 只读、不联网、不改动任何状态。
  if (pathname === '/api/colcn/test' && req.method === 'POST') {
    const body = await readJson(req);
    return sendJson(res, 200, COLCN.test(body && body.scientificName ? body.scientificName : ''));
  }

  if (pathname === '/api/config' && req.method === 'POST') {
    const body = await readJson(req);
    if (body.preset) {
      const hit = PRESETS.find((p) => p.key === body.preset);
      if (!hit) return sendJson(res, 400, { ok: false, error: '未知方案' });
      config.ui = { ...(config.ui || {}), preset: body.preset };
      // 换方案 = 换类群，豆包这类按次计费的收回（要再用得再点一次）
      oneShotOn = new Set();
    }
    // 用户点了某个站点的开关：按方案记一份，换回来还是他上次那套
    if (Array.isArray(body.picks)) {
      const { preset, all } = presetAll(config.ui?.preset);
      // 一次性模型不落盘，只记在内存里（见 ONE_SHOT_SITES 的说明）
      const picks = body.picks.filter((k) => all.includes(k) && !ONE_SHOT_SITES.has(k));
      oneShotOn = new Set(body.picks.filter((k) => ONE_SHOT_SITES.has(k)));
      config.ui = { ...(config.ui || {}), picks: { ...(config.ui?.picks || {}), [preset]: picks } };
    }
    if (Array.isArray(body.sources)) config.ui = { ...(config.ui || {}), sources: body.sources };
    if (typeof body.rename === 'boolean') config.ui = { ...(config.ui || {}), rename: body.rename };
    if (['first', 'last', 'only'].includes(body.renameOrder)) {
      config.ui = { ...(config.ui || {}), renameOrder: body.renameOrder };
    }
    if (['cn', 'latin', 'both', 'latinCn'].includes(body.renamePick)) {
      config.ui = { ...(config.ui || {}), renamePick: body.renamePick };
    }
    if (typeof body.renameSuffix === 'string') {
      config.ui = { ...(config.ui || {}), renameSuffix: safeName(body.renameSuffix).slice(0, 40) };
    }
    if (typeof body.archive === 'boolean') {
      config.ui = { ...(config.ui || {}), archive: body.archive };
    }
    // 检索地区：三项整体写入（前端选完地区一次发全），不做逐项合并
    if (body.linkPlace && typeof body.linkPlace === 'object') {
      const p = body.linkPlace;
      config.ui = {
        ...(config.ui || {}),
        linkPlace: {
          code: String(p.code || '').trim(),
          placeId: Number(p.placeId) || 0,
          placeName: String(p.placeName || '').trim(),
        },
      };
    }
    // GBIF 面板的中文名补全：Key 留空表示「不改」，clear=true 才清掉。明文不回浏览器。
    if (body.deepseek && typeof body.deepseek === 'object') {
      const d = body.deepseek;
      const next = { ...(config.deepseek || {}) };
      const k = String(d.apiKey || '').trim();
      if (k) next.apiKey = k;
      if (typeof d.model === 'string' && d.model.trim()) next.model = d.model.trim();
      if (d.clear === true) next.apiKey = '';
      config.deepseek = next;
    }
    persistConfig();
    return sendJson(res, 200, apiState());
  }

  return sendJson(res, 404, { ok: false, error: '未知接口' });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = u.pathname;
  // 所有响应都带的基础安全头；CSP 只加在 HTML 上（见 serveStatic）
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  try {
    // 只服务本机：挡掉 DNS rebinding 之类的跨站访问
    const host = String(req.headers.host || '');
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('只允许本机访问');
      return;
    }
    // 跨站网页不许借浏览器调本机 API / 读本机图片。
    // 非浏览器客户端（curl、更新探活）没有 Origin / Sec-Fetch-Site，照常放行。
    if ((pathname.startsWith('/api/') || pathname === '/img') && !isSameOrigin(req)) {
      if (pathname.startsWith('/api/')) sendJson(res, 403, { ok: false, error: '跨站请求已拒绝' });
      else res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('跨站请求已拒绝');
      return;
    }
    // 带 body 的 POST 必须是 JSON：跨站表单/简单请求过不了这一关（拖文件的原始字节接口例外）。
    if (pathname.startsWith('/api/') && req.method === 'POST' && pathname !== '/api/nat/drop-file') {
      const len = Number(req.headers['content-length'] || 0);
      if (len > 0) {
        const ct = String(req.headers['content-type'] || '').toLowerCase();
        if (!ct.startsWith('application/json')) {
          sendJson(res, 415, { ok: false, error: '请求体必须是 application/json' });
          return;
        }
      }
    }
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname, u.searchParams);
    if (pathname === '/img') return serveImage(req, res, u.searchParams);
    return serveStatic(req, res, pathname);
  } catch (err) {
    const code = err.status || 500;
    // 4xx 是用户输入问题，只记一行；5xx 连堆栈一起记，方便用户把日志发回来
    const detail = code >= 500 ? (err.stack || err.message) : (err.message || String(err));
    logLine(code >= 500 ? 'error' : 'warn', `${req.method} ${pathname} -> ${code} ${detail}`);
    // payload 是给前端做后续动作用的（比如「聚合台没装」时附上下载直链），不覆盖 ok/error
    if (!res.headersSent) sendJson(res, code, { ok: false, error: err.message || '服务器内部错误', ...(err.payload || {}) });
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
      logLine('info', `端口 ${port} 已有本程序在运行（v${who.version || '?'}），打开浏览器后退出`);
      console.log(`  端口 ${port} 上已经开着一个标注工坊${who.version ? `（v${who.version}）` : ''}，直接给你打开浏览器。`);
      console.log('  如果那个窗口是旧的、想换成现在这个，先把它关掉再启动。');
      if (!process.env.TAGDEN_NO_BROWSER) openBrowser(`http://127.0.0.1:${port}`);
      setTimeout(() => process.exit(0), 1500);
      return;
    }
    if (who) {
      logLine('warn', `端口 ${port} 被「${who.name}」占用`);
      console.log(`  ⚠ 端口 ${port} 被「${who.name}」占着 —— 两个软件不能用同一个端口。`);
      console.log('    请先关掉那个软件的窗口，再重新双击本程序。');
    } else {
      logLine('warn', `端口 ${port} 被未知程序占用`);
      console.log(`  ⚠ 端口 ${port} 被别的程序占用了（不是本程序）。`);
      console.log('    关掉占用的程序再启动，或用  --port 7802  换个端口。');
    }
    console.log('');
    setTimeout(() => process.exit(1), 1500);
    return;
  }
  logLine('fatal', '启动失败：' + (err.stack || err.message));
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
  console.log(`  日志文件     ${LOG_FILE}`);
  console.log('');
  console.log('  Ctrl+C 退出（关掉这个黑窗口也会退出）');
  console.log('');
  logLine('info', `启动 v${VERSION} · ${process.platform}/${process.arch} · ${isSea ? 'exe' : isAppBundle ? 'bundle' : 'source'} · data=${DATA} · cache=${CACHE}`);

  // 需要账号的两个站点静默登录一次，省得第一次识别才现登。
  // 自动化测试 / 离线环境用 TAGDEN_NO_LOGIN=1 跳过，避免启动时打外网。
  if (process.env.TAGDEN_NO_LOGIN === '1') {
    console.log('  [i] 已跳过启动登录（TAGDEN_NO_LOGIN=1）');
  } else {
    (async () => {
      for (const key of ['inaturalist', 'duoshi']) {
        try {
          await sites.login(key);
          console.log(`  [ok] ${SITE_META[key].name} 已登录`);
        } catch (err) {
          console.log(`  [!!] ${SITE_META[key].name} 登录失败：${err.message}`);
          logLine('warn', `${SITE_META[key].name} 登录失败：${err.message}`);
        }
      }
    })();
  }

  if (!process.env.TAGDEN_NO_BROWSER) openBrowser(`http://127.0.0.1:${port}`);

  // 缩略图缓存攒太多会拖慢目录列举，后台慢慢清（不阻塞启动）
  setTimeout(() => {
    const n = pruneThumbs();
    if (n) console.log(`  清理缩略图缓存 ${n} 个`);
  }, 5000).unref?.();

  // 识别结果缓存攒到几千条就按时间和条数清一批，同样不挡启动
  setTimeout(() => {
    const n = IDC.prune();
    if (n) console.log(`  清理识别缓存 ${n} 条`);
  }, 7000).unref?.();
});

/* 退出前把攒着没落盘的配置和标签缓存写掉，下次打开少读一遍硬盘 */
function shutdownNow(exitCode = 0) {
  try {
    flushConfig();
  } catch {}
  try {
    LC.flushAll();
  } catch {}
  try {
    LLAMA.shutdown(); // 别把 llama-server 留在后台吃内存
  } catch {}
  process.exit(exitCode);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    logLine('info', `收到 ${sig}，正在退出`);
    shutdownNow(0);
  });
}
// 黑窗口被直接关掉时不一定给 SIGINT，exit 里再兜一次（这里必须是同步操作）
process.on('exit', () => {
  try {
    flushConfig();
  } catch {}
  try {
    LC.flushAll();
  } catch {}
  try {
    LLAMA.shutdown();
  } catch {}
});

// 未捕获异常：先落盘再退出。双击 exe 时窗口一闪而过，没有日志就完全没法排查。
process.on('uncaughtException', (err) => {
  logLine('fatal', '未捕获异常：' + (err && (err.stack || err.message) || err));
  try {
    console.error('');
    console.error('  程序遇到未处理的错误，已写入日志：' + LOG_FILE);
    console.error('  ' + (err && (err.message || err) || err));
    console.error('');
  } catch {}
  shutdownNow(1);
});

// 未处理的 Promise 拒绝不一定致命（很多站点请求失败都走这里），记下来继续跑。
process.on('unhandledRejection', (reason) => {
  logLine('warn', '未处理的 Promise 拒绝：' + (reason && (reason.stack || reason.message) || reason));
});

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
