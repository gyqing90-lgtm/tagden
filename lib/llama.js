'use strict';
/**
 * 本地大模型运行库（llama.cpp 的 llama-server）—— 内置版。
 *
 * 为什么内置：用户只想下个 GGUF 模型就能用，不希望再去 GitHub 找「对应系统的预编译包」、
 * 解压、配 PATH、开命令行。所以这里把 Windows CPU 版运行库整包塞进 exe（构建时 base64 内联），
 * 第一次用的时候自己解压到缓存目录，然后由本模块拉起 llama-server。
 *
 * 优先级（先用户后内置）：
 *   1. <程序目录>/llama/llama-server(.exe)  —— 想用 CUDA / Vulkan 加速版的人，把整个包丢这儿就行
 *   2. <缓存>/llama-runtime/llama-server(.exe) —— 由内置 zip 解压出来（只解压一次）
 *
 * 解压不依赖系统命令：自己解析 zip 中央目录 + zlib.inflateRawSync。
 * 这样在 Git Bash、PowerShell、mac 终端、以及 exe 里跑都一个样，不会被 tar/unzip 的方言坑。
 *
 * 本模块只服务本机 127.0.0.1；不下载模型、不改用户照片、不上报任何东西。
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { APP_DIR, DATA_DIR } = require('./env');

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? 'llama-server.exe' : 'llama-server';
/** 内置包在 build/bundle.js 里登记的名字 */
const ZIP_KEY = 'llama-win-cpu-x64.zip';

let CACHE = '';
let RUNTIME = '';      // 解压后的运行库目录
let MODEL_DIRS = [];   // 找模型的默认目录

let child = null;
let starting = false;
let st = {
  running: false,
  port: 0,
  model: '',
  mmproj: '',
  startedAt: 0,
  error: '',
  log: '',
};

function init(opt) {
  CACHE = opt.cacheDir;
  RUNTIME = path.join(CACHE, 'llama-runtime');
  MODEL_DIRS = [
    path.join(APP_DIR, 'models'),
    path.join(DATA_DIR, 'models'),
  ];
  // 上次没退干净的话，先把老进程收掉，免得端口/文件被占
  killStale();
}

/* ---------------------------------------------------------------- 运行库 */

/** 内置 zip 的字节（打包后从内存取，源码运行时读 vendor/） */
function embeddedZip() {
  const bin = global.__EMBEDDED_BIN__ || null;
  if (bin && typeof bin[ZIP_KEY] === 'string') return Buffer.from(bin[ZIP_KEY], 'base64');
  // 打包时这个 zip 走的是 SEA 原生 asset（不 base64，省 8 MB）
  try {
    const fromSea = require('./assets').seaAsset(ZIP_KEY);
    if (fromSea) return fromSea;
  } catch {
    /* assets 模块缺失就当没有，下面回落到磁盘 */
  }
  const dev = path.join(APP_DIR, 'vendor', 'llama', ZIP_KEY);
  try { return fs.readFileSync(dev); } catch { return null; }
}

/**
 * 极简 zip 解包：只认 stored / deflate，够用且不引依赖。
 * 返回解出来的文件数；遇到不认识的条目直接跳过，不抛。
 */
function unzip(buf, destDir) {
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i -= 1) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('内置运行库不是有效的 zip');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  fs.mkdirSync(destDir, { recursive: true });
  let made = 0;
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nlen = buf.readUInt16LE(off + 28);
    const elen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nlen).replace(/\\/g, '/');
    off += 46 + nlen + elen + clen;
    if (name.endsWith('/')) continue;              // 目录条目，写文件时自然建
    if (name.includes('..') || name.startsWith('/')) continue; // 路径穿越，跳过
    if (buf.readUInt32LE(lho) !== 0x04034b50) continue;
    const lnlen = buf.readUInt16LE(lho + 26);
    const lelen = buf.readUInt16LE(lho + 28);
    const dataAt = lho + 30 + lnlen + lelen;
    const raw = buf.subarray(dataAt, dataAt + csize);
    let out;
    try {
      out = method === 0 ? raw : zlib.inflateRawSync(raw);
    } catch { continue; }
    const file = path.join(destDir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, out);
    made += 1;
  }
  return made;
}

function fileExists(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

/**
 * 可能放运行库的目录，按优先级排：
 *   1. <程序目录>/llama          —— 自带 / 加速版（CUDA、Vulkan、Metal 定制包）都丢这儿
 *   2. <程序目录>/models/_runtime —— macOS 版 llama.cpp 包直接解到这儿（包里就是 llama-server + dylib）
 *   3. <数据目录>/models/_runtime —— 程序装在只读位置时，模型和运行库放用户目录这份
 *   4. <缓存>/llama-runtime       —— 由内置 Windows zip 解压出来
 * 前三个是「用户/发行包自己带的」，第四个是内置包解出来的。
 */
function runtimeDirs() {
  return [
    { dir: path.join(APP_DIR, 'llama'), kind: 'custom' },
    { dir: path.join(APP_DIR, 'models', '_runtime'), kind: 'mac' },
    { dir: path.join(DATA_DIR, 'models', '_runtime'), kind: 'mac' },
    { dir: RUNTIME, kind: 'builtin' },
  ];
}

/** 找一个现成的 llama-server，只 stat 文件，不解压、不启动 */
function findRuntime() {
  for (const c of runtimeDirs()) {
    const exe = path.join(c.dir, EXE);
    if (fileExists(exe)) return { dir: c.dir, exe, kind: c.kind };
  }
  return null;
}

/** 用户自带的运行库优先；没有再解压内置包 */
function ensureRuntime() {
  const hit = findRuntime();
  if (hit) return hit;

  if (!IS_WIN) return null; // 内置 zip 只有 Windows 版
  const zip = embeddedZip();
  if (!zip) return null;
  // 解到临时目录再改名，解一半被杀掉也不会留下半个运行库
  const tmp = `${RUNTIME}.tmp`;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  const n = unzip(zip, tmp);
  if (!n || !fileExists(path.join(tmp, EXE))) throw new Error('内置运行库解压失败');
  try { fs.rmSync(RUNTIME, { recursive: true, force: true }); } catch { /* ignore */ }
  fs.renameSync(tmp, RUNTIME);
  return { dir: RUNTIME, exe: path.join(RUNTIME, EXE), kind: 'builtin' };
}

/** 运行库状态：给界面显示用，不触发解压（解压要几秒，别在打开设置时就卡） */
function runtimeInfo() {
  const hit = findRuntime();
  if (hit) {
    return { ok: true, bundled: true, kind: hit.kind, dir: hit.dir, exe: hit.exe, platform: process.platform };
  }
  const hasZip = IS_WIN && !!embeddedZip();
  return {
    ok: false,
    bundled: hasZip,
    kind: 'none',
    platform: process.platform,
    dirs: runtimeDirs().map((d) => d.dir),
  };
}

/* ---------------------------------------------------------------- 模型 */

function scanGguf(dir, deep = 1, out = [], guard = { n: 0 }) {
  if (guard.n > 60 || out.length > 200) return out;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  guard.n += 1;
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (deep > 0 && !e.name.startsWith('.') && e.name !== 'node_modules') scanGguf(full, deep - 1, out, guard);
      continue;
    }
    if (!/\.gguf$/i.test(e.name)) continue;
    // split 分片（-00002-of-00003）只登记第一片，避免同一个模型列好几遍
    if (/-\d{5}-of-\d{5}\.gguf$/i.test(e.name) && !/-00001-of-\d{5}\.gguf$/i.test(e.name)) continue;
    let size = 0;
    try { size = fs.statSync(full).size; } catch { /* ignore */ }
    out.push({ name: e.name, path: full, size, mmproj: /mmproj|projector|vision/i.test(e.name) });
  }
  return out;
}

/**
 * 在文件管理器里打开「放模型」的文件夹（不存在就先建好）。
 * 用户从网上下的 gguf 直接复制进去，回头点「↻」就能扫到。
 * 只允许打开自己登记过的那两个目录，传别的路径一律回落到主目录。
 */
function openModelDir(dir) {
  const want = String(dir || '').trim();
  const target = MODEL_DIRS.includes(want) ? want : MODEL_DIRS[0];
  try {
    fs.mkdirSync(target, { recursive: true });
  } catch (err) {
    return { ok: false, error: '建立模型文件夹失败：' + err.message, dir: target };
  }
  const cmd = IS_WIN ? 'explorer' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
  // 自动验收 / 无人值守时不要真弹窗口（和 TAGDEN_NO_BROWSER 一个路数）
  if (process.env.TAGDEN_NO_OPEN === '1') return { ok: true, dir: target, spawned: false };
  try {
    // explorer 成功也常常返回 1，所以不判退出码，也不等它
    const p = spawn(cmd, [target], { detached: true, stdio: 'ignore' });
    p.on('error', () => { /* 打不开不影响把路径回给界面 */ });
    p.unref();
  } catch (err) {
    return { ok: false, error: '打开文件管理器失败：' + err.message, dir: target };
  }
  return { ok: true, dir: target };
}

/** 列默认目录里的 gguf；dir 传了就先看那儿 */
function listModels(dir) {
  const dirs = dir ? [dir, ...MODEL_DIRS] : MODEL_DIRS.slice();
  const seen = new Set();
  const files = [];
  for (const d of dirs) {
    for (const f of scanGguf(d, 1)) {
      if (seen.has(f.path)) continue;
      seen.add(f.path);
      files.push(f);
    }
  }
  return { ok: true, dirs: MODEL_DIRS, files };
}

/* ---------------------------------------------------------------- 进程 */

function freePort(prefer = 18080) {
  return new Promise((resolve) => {
    const tryPort = (p, left) => {
      const srv = net.createServer();
      srv.once('error', () => {
        if (left <= 0) return resolve(prefer);
        tryPort(p + 1, left - 1);
      });
      srv.once('listening', () => srv.close(() => resolve(p)));
      srv.listen(p, '127.0.0.1');
    };
    tryPort(prefer, 25);
  });
}

function pidFile() { return path.join(DATA_DIR, 'llama.pid'); }

function killStale() {
  try {
    const pid = Number(fs.readFileSync(pidFile(), 'utf8').trim());
    if (pid > 0) { try { process.kill(pid); } catch { /* 早没了 */ } }
  } catch { /* 没有 pid 文件 */ }
  try { fs.rmSync(pidFile(), { force: true }); } catch { /* ignore */ }
}

function pushLog(s) {
  st.log = (st.log + s).slice(-4000);
}

async function waitReady(port, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (child && child.exitCode !== null) return false;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2500) });
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 600));
  }
  return false;
}

/**
 * 没指定视觉投影时，去模型同目录里找一个。
 * Qwen-VL 这类包的惯例是把 mmproj 和主模型放在一起（mmproj-F16.gguf），
 * 用户只选了主模型也能直接跑多模态，不用再回来点一次下拉。
 */
function guessMmproj(model) {
  try {
    const dir = path.dirname(model);
    const rank = (p) => (/(f16|bf16)/i.test(p) ? 0 : 1);
    const cands = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.gguf$/i.test(e.name) && /mmproj|projector|vision/i.test(e.name))
      .map((e) => path.join(dir, e.name))
      .sort((a, b) => rank(a) - rank(b) || a.length - b.length);
    return cands[0] || '';
  } catch {
    return '';
  }
}

/**
 * 启动本地服务。
 * @param {object} o { model, mmproj, ctx, ngl, threads }
 */
async function start(o = {}) {
  if (starting) return { ok: false, error: '正在启动，请稍等' };
  if (child) return { ok: true, port: st.port, baseUrl: `http://127.0.0.1:${st.port}/v1`, model: st.model, reused: true };

  const model = String(o.model || '').trim();
  if (!model) return { ok: false, error: '请先选一个 .gguf 模型文件' };
  if (!fileExists(model)) return { ok: false, error: `模型文件不存在：${model}` };
  // 没选视觉投影就在模型旁边找：Qwen-VL 这些包都是把 mmproj 跟主模型放一块的
  let mmproj = String(o.mmproj || '').trim();
  const guessed = !mmproj ? guessMmproj(model) : '';
  if (guessed) mmproj = guessed;
  if (mmproj && !fileExists(mmproj)) return { ok: false, error: `mmproj 文件不存在：${mmproj}` };

  let rt;
  try {
    starting = true;
    rt = ensureRuntime();
  } catch (err) {
    starting = false;
    return { ok: false, error: '准备运行库失败：' + err.message };
  }
  if (!rt) {
    starting = false;
    return {
      ok: false,
      error: IS_WIN
        ? '没找到运行库：请把 llama.cpp 的 Windows 包解压到程序目录下的 llama 文件夹'
        : '没找到 llama-server：把 llama.cpp 的 macOS 包解压到 models/_runtime（包里本来就有 llama-server 和一堆 dylib，整个解到这一层），或者自己起一个 llama-server 再把地址填到「AI 设置」里',
    };
  }

  const port = await freePort(Number(o.port) || 18080);
  const args = [
    '-m', model,
    '--host', '127.0.0.1',
    '--port', String(port),
    '--alias', 'tagden-ai',
    '-c', String(Math.max(2048, Math.min(32768, Number(o.ctx) || 8192))),
    '-ngl', String(Number.isFinite(Number(o.ngl)) ? Number(o.ngl) : 99),
    '--jinja',
  ];
  if (mmproj) args.push('--mmproj', mmproj);
  if (Number(o.threads) > 0) args.push('-t', String(Number(o.threads)));

  st = { running: false, port, model, mmproj, startedAt: Date.now(), error: '', log: '' };
  pushLog(`$ ${path.basename(rt.exe)} ${args.join(' ')}\n`);

  try {
    child = spawn(rt.exe, args, { cwd: rt.dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    starting = false;
    child = null;
    return { ok: false, error: '启动失败：' + err.message };
  }
  try { fs.writeFileSync(pidFile(), String(child.pid)); } catch { /* ignore */ }

  child.stdout.on('data', (b) => pushLog(String(b)));
  child.stderr.on('data', (b) => pushLog(String(b)));
  child.on('exit', (code) => {
    pushLog(`\n[进程结束 code=${code}]\n`);
    st.running = false;
    st.error = code ? `llama-server 退出（code ${code}）` : '';
    child = null;
    try { fs.rmSync(pidFile(), { force: true }); } catch { /* ignore */ }
  });

  const ok = await waitReady(port, 180000);
  starting = false;
  if (!ok) {
    const tail = st.log.split('\n').slice(-12).join('\n');
    // mac 上跑不起来，八成是系统把这个二进制拦了（下载来的包带 quarantine 属性）
    const blocked = !IS_WIN && /Bad CPU type|code signature|not opened|killed|dyld|Operation not permitted/i.test(st.log);
    const hint = blocked
      ? `\n提示：macOS 可能拦住了 ${path.join(rt.dir, EXE)}，在终端执行  xattr -dr com.apple.quarantine "${rt.dir}"  再试一次`
      : '';
    stop();
    return { ok: false, error: '模型加载超时或失败。' + hint + (tail ? `\n${tail}` : ''), log: st.log.slice(-1500) };
  }

  st.running = true;
  return {
    ok: true,
    port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: 'tagden-ai',
    mmproj,
    runtime: rt.kind,
  };
}

function stop() {
  if (child) {
    try { child.kill(); } catch { /* ignore */ }
    child = null;
  }
  killStale();
  st.running = false;
  st.port = 0;
  return { ok: true };
}

function status() {
  return {
    ok: true,
    running: !!child && st.running,
    starting,
    port: st.port || 0,
    baseUrl: st.port ? `http://127.0.0.1:${st.port}/v1` : '',
    model: st.model,
    mmproj: st.mmproj,
    startedAt: st.startedAt,
    error: st.error,
    log: st.log.slice(-2000),
    runtime: runtimeInfo(),
  };
}

/** 程序退出时收尾：不收的话每次用完都留一个 llama-server 占着内存 */
function shutdown() {
  if (child) { try { child.kill(); } catch { /* ignore */ } }
  try { fs.rmSync(pidFile(), { force: true }); } catch { /* ignore */ }
}

/* ---------------------------------------------------------------- 在线下载模型 */

/**
 * 可以直接在程序里下的模型清单。
 * 只放「确定能跑多模态」的 Qwen-VL 系列：主模型 + 配套 mmproj 一起下，
 * 下完就落在模型目录里，用户不用再去网页上找文件、也不用自己搬文件夹。
 *
 * 地址走 HF 镜像优先（国内直连 huggingface.co 基本不通），镜像失败再回源站。
 */
const CATALOG = [
  {
    id: 'qwen3-vl-4b',
    label: 'Qwen3-VL-4B（推荐）',
    note: '中文最稳、速度也够快，6 GB 内存能跑；日常物种判别首选',
    repo: 'unsloth/Qwen3-VL-4B-Instruct-GGUF',
    size: 3333462976,
    files: [
      { name: 'Qwen3-VL-4B-Instruct-Q4_K_M.gguf', size: 2497282336, role: 'main' },
      { name: 'mmproj-F16.gguf', size: 836180640, role: 'mmproj' },
    ],
  },
  {
    id: 'qwen2.5-vl-3b',
    label: 'Qwen2.5-VL-3B（轻量）',
    note: '最省资源，老笔记本 / 只有 4 GB 空闲内存时用它，认得稍弱',
    repo: 'unsloth/Qwen2.5-VL-3B-Instruct-GGUF',
    size: 3268329664,
    files: [
      { name: 'Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf', size: 1929901408, role: 'main' },
      { name: 'mmproj-F16.gguf', size: 1338428256, role: 'mmproj' },
    ],
  },
  {
    id: 'qwen3-vl-8b',
    label: 'Qwen3-VL-8B（高质量）',
    note: '判得最细，但要 12 GB 以上内存、下载也大，机器够强再用',
    repo: 'unsloth/Qwen3-VL-8B-Instruct-GGUF',
    size: 6186815904,
    files: [
      { name: 'Qwen3-VL-8B-Instruct-Q4_K_M.gguf', size: 5027785568, role: 'main' },
      { name: 'mmproj-F16.gguf', size: 1159030336, role: 'mmproj' },
    ],
  },
];

/** 镜像优先，回源站兜底 */
const MIRROR_HOSTS = ['hf-mirror.com', 'huggingface.co'];

/** 下载状态：id → { state, got, total, file, speed, error, cancel } */
const DL = new Map();

/** 模型往哪儿下：优先程序目录下那份，不可写就落到用户数据目录 */
function modelTargetDir() {
  for (const d of MODEL_DIRS) {
    try {
      fs.mkdirSync(d, { recursive: true });
      fs.accessSync(d, fs.constants.W_OK);
      return d;
    } catch {
      /* 换下一个 */
    }
  }
  return MODEL_DIRS[0];
}

/** 每个模型下到自己的子目录里：两个模型的 mmproj 同名（mmproj-F16.gguf），
 *  平铺在同一个目录会互相覆盖；分开放也正好让「自动找 mmproj」在同目录里命中。 */
function modelSubDir(id) {
  return path.join(modelTargetDir(), String(id || '').replace(/[^\w.-]/g, ''));
}

function fileSize(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

/** 单个文件的落盘大小（主模型按 99.5% 容差认，避免最后几个字节的误差反复重下） */
function enough(have, want) {
  if (!want) return have > 0;
  return have >= want * 0.995;
}

/**
 * 把 url 列表里的文件流式写到 dest。支持 .part 续传：
 * 已经有半截就用 Range 接着下，服务器不认 Range（回 200）就从头写。
 */
async function fetchFile(urls, dest, onBytes, isCancelled) {
  const part = dest + '.part';
  let lastErr = null;
  for (const url of urls) {
    let have = fileSize(part);
    try {
      const res = await fetch(url, {
        headers: have > 0 ? { Range: `bytes=${have}-` } : {},
        redirect: 'follow',
      });
      // 续传点已经等于文件长度：服务器回 416，当作下完了
      if (res.status === 416 && have > 0) return have;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const append = res.status === 206 && have > 0;
      if (!append) have = 0;
      const fh = await fs.promises.open(part, append ? 'a' : 'w');
      let got = have;
      try {
        for await (const chunk of res.body) {
          if (isCancelled()) throw new Error('已取消');
          await fh.write(chunk);
          got += chunk.length;
          if (onBytes) onBytes(got);
        }
      } finally {
        await fh.close();
      }
      // 服务器没给 content-length 时没法预先判断，落盘后交给调用方按大小复核
      fs.renameSync(part, dest);
      return got;
    } catch (err) {
      lastErr = err;
      if (isCancelled()) throw new Error('已取消');
      /* 换下一个镜像 */
    }
  }
  throw lastErr || new Error('所有下载地址都不通');
}

/**
 * 已经在别处下过的同名文件（用户之前自己下的、或者装在不同子目录里）。
 * 名字一样、大小对得上就直接认，不为了一份一模一样的权重再重下 3 GB。
 */
function findExisting(name, want) {
  const lower = String(name || '').toLowerCase();
  for (const d of MODEL_DIRS) {
    for (const f of scanGguf(d, 2)) {
      if (f.name.toLowerCase() !== lower) continue;
      if (enough(fileSize(f.path), want)) return f.path;
    }
  }
  return '';
}

/** 清单 + 本机状态：给「下载模型」那一块渲染用 */
function catalogState() {
  const items = CATALOG.map((c) => {
    const dir = modelSubDir(c.id);
    const st = DL.get(c.id) || null;
    const files = c.files.map((f) => {
      const local = path.join(dir, f.name);
      let p = local;
      let have = fileSize(local);
      if (!enough(have, f.size)) {
        const alt = findExisting(f.name, f.size);
        if (alt) { p = alt; have = fileSize(alt); }
      }
      return { name: f.name, role: f.role, want: f.size, have, ok: enough(have, f.size), path: p, reused: p !== local };
    });
    const installed = files.every((f) => f.ok);
    const main = files.find((f) => f.role === 'main');
    const proj = files.find((f) => f.role === 'mmproj');
    return {
      id: c.id,
      label: c.label,
      note: c.note,
      size: c.size,
      files,
      installed,
      state: st ? st.state : (installed ? 'done' : 'idle'),
      got: st ? st.got : (installed ? c.size : 0),
      total: st ? st.total : c.size,
      speed: st ? st.speed : 0,
      file: st ? st.file : '',
      error: st ? st.error : '',
      modelPath: main ? main.path : '',
      mmprojPath: proj ? proj.path : '',
    };
  });
  return { ok: true, dir: modelTargetDir(), mirrors: MIRROR_HOSTS, items };
}

/** 开始下载：立刻返回，进度靠 catalogState() 轮询 */
function startDownload(id) {
  const c = CATALOG.find((x) => x.id === id);
  if (!c) return { ok: false, error: '没有这个模型' };
  const cur = DL.get(id);
  if (cur && cur.state === 'running') return { ok: true, state: 'running', dir: modelSubDir(id) };

  const dir = modelSubDir(id);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { ok: false, error: '建不了模型目录：' + err.message };
  }

  const total = c.files.reduce((s, f) => s + f.size, 0);
  const st = { state: 'running', got: 0, total, file: '', speed: 0, error: '', cancel: false, at: Date.now() };
  DL.set(id, st);

  (async () => {
    let done = 0;
    try {
      for (const f of c.files) {
        const dest = path.join(dir, f.name);
        const have = fileSize(dest);
        // 本机已经有这份权重（同名同大小，哪怕在别的子目录里）就别再下一遍
        if (enough(have, f.size) || findExisting(f.name, f.size)) { done += f.size; st.got = done; continue; }
        st.file = f.name;
        const urls = MIRROR_HOSTS.map((h) => `https://${h}/${c.repo}/resolve/main/${f.name}`);
        let tickAt = Date.now();
        let tickGot = st.got;
        await fetchFile(urls, dest, (gotThis) => {
          st.got = done + gotThis;
          const now = Date.now();
          if (now - tickAt > 900) {
            st.speed = Math.max(0, ((st.got - tickGot) * 1000) / (now - tickAt));
            tickAt = now;
            tickGot = st.got;
          }
        }, () => st.cancel);
        const got = fileSize(dest);
        if (!enough(got, f.size)) throw new Error(`${f.name} 下完只有 ${got} 字节，文件不完整`);
        done += f.size;
        st.got = done;
      }
      st.state = 'done';
      st.file = '';
      st.speed = 0;
    } catch (err) {
      st.state = st.cancel ? 'cancel' : 'error';
      st.error = st.cancel ? '已取消' : (err.message || '下载失败');
      st.speed = 0;
    }
  })();

  return { ok: true, state: 'running', dir };
}

function cancelDownload(id) {
  const st = DL.get(id);
  if (!st) return { ok: true, state: 'idle' };
  st.cancel = true;
  st.state = 'cancel';
  st.speed = 0;
  st.error = '已取消';
  return { ok: true, state: 'cancel' };
}

/** 删掉某个模型已经下下来的文件（.part 半截一起清），腾空间用 */
function removeDownload(id) {
  const c = CATALOG.find((x) => x.id === id);
  if (!c) return { ok: false, error: '没有这个模型' };
  const st = DL.get(id);
  if (st && st.state === 'running') return { ok: false, error: '正在下载，先取消再删' };
  const dir = modelSubDir(id);
  const removed = [];
  for (const f of c.files) {
    const p = path.join(dir, f.name);
    for (const t of [p, p + '.part']) {
      try {
        if (fs.existsSync(t)) { fs.rmSync(t, { force: true }); removed.push(path.basename(t)); }
      } catch { /* 占着就先留着 */ }
    }
  }
  DL.delete(id);
  return { ok: true, removed };
}

module.exports = {
  init, listModels, start, stop, status, runtimeInfo, shutdown, openModelDir,
  catalogState, startDownload, cancelDownload, removeDownload,
  modelDirs: () => MODEL_DIRS.slice(),
  modelTargetDir,
  catalog: () => CATALOG.map((c) => ({ id: c.id, label: c.label, size: c.size })),
  // 纯函数，导出只为回归测试能单独验「内置 zip 解不解得开」
  unzip,
};
