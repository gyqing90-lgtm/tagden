'use strict';

/**
 * 极简打包器（和聚合台同一个套路）：把服务端模块合成一个 CJS 文件，网页资源内联成字符串。
 *
 * 为什么不直接把 server.js 丢进 SEA：
 *   SEA 只认一个入口脚本，`require('./lib/xxx')` 在二进制里没有磁盘可查；
 *   而内联成字符串最省事，还能顺手把 public/ 一起装进去，成品就是真·单文件。
 */

const fs = require('node:fs');
const path = require('node:path');

const MODULES = [
  'server.js',
  'lib/env.js',
  'lib/datadir.js',
  'lib/version.js',
  'lib/updater.js',
  'lib/update-sign.js',
  'lib/delta.js',
  'lib/assets.js',
  'lib/http.js',
  'lib/parse.js',
  'lib/adapters.js',
  'lib/aggregate.js',
  // 识别结果缓存（同图同站点复用上次结果）：漏了它，exe 会报「模块未打包」
  'lib/identify-cache.js',
  // 大陆中文名（内置《中国生物物种名录》索引）：漏了它，exe 会报「模块未打包」
  'lib/colcn.js',
  'lib/regions.js',
  'lib/ebird.js',
  'lib/inat.js',
  'lib/ppbc.js',
  'lib/baidu.js',
  'lib/secure.js',
  'lib/seed.js',
  'lib/exif.js',
  'lib/imgmeta.js',
  'lib/labelcache.js',
  'lib/taxonomy.js',
  'lib/stats.js',
  // 图库索引/搜索/重复文件：漏了它，exe 打开图库页会报「模块未打包」
  'lib/library.js',
  // 自然在线（账号相册）：漏了这两个，源码跑得好好的，打出来的 exe 会报「模块未打包」
  'lib/nature-client.js',
  'lib/nature-store.js',
  // 内置识别账号（只给识别用）：漏了它，exe 里自然在线识别会报「模块未打包」
  'lib/nat-share.js',
  // 从聚合台并进来的两个查询模块：nature.js 查「某属在本地名录里有哪些种」，
  // gbifds.js 查「某属在 GBIF 本地区有哪些种」。都随结果页的学名小标一起用。
  'lib/nature.js',
  'lib/gbifds.js',
  // 照片评分（内置）：store 会 require '../public/score-engine.js'，这一份也必须列进来
  'lib/score-store.js',
  'lib/score-ai.js',
  'public/score-engine.js',
  // 内置本地大模型运行库（llama.cpp）：漏了它，exe 启动时会报「模块未打包」
  'lib/llama.js',
];

/** 文本资源：按 utf8 内联成字符串 */
const ASSETS = ['index.html', 'style.css', 'app.js', 'score-engine.js', 'score-worker.js'];
/** 二进制资源：按 base64 内联（作者的微信二维码，在 public/ 下） */
const BIN_ASSETS = [
  'author-qr.png',
  // 内置《中国生物物种名录》学名→中文名索引（gzip，~1.7 MB）。
  // 必须内联：绿色版 exe 旁边不会带 public/，索引不能靠外部文件。
  'colcn.bin',
  // 离线行政区划索引（GeoNames，gzip，约 24 KB）
  'regions.bin',
];
/**
 * 二进制资源（在 vendor/ 下，不在 public/）：内置 llama.cpp 运行库整包
 * （lib/llama.js 启动时解压）。key 用文件名，与 lib/llama.js 的 ZIP_KEY 一致。
 *
 * sea: true 表示「别 base64 塞进 JS」，改由 build-exe.js 交给 Node SEA 的
 * 原生 assets 带走。这个包 23.6 MB，base64 后要 31.5 MB，会把 SEA blob 撑到
 * postject 注入不动的地步（libpe 的 WASM 堆得涨到 800 MB+，机器一紧张就
 * Array buffer allocation failed）。mac 版不打包这个 zip（只在 Windows 用），
 * 走 main.js 直接跑，所以没有 SEA assets 也不影响。
 */
const VENDOR_BIN = [{ rel: 'vendor/llama/llama-win-cpu-x64.zip', key: 'llama-win-cpu-x64.zip', sea: true }];

/** 需要写进 sea-config.json 的 assets（key → 绝对路径由 build-exe.js 拼） */
const SEA_ASSETS = VENDOR_BIN.filter((v) => v.sea);

function buildBundle(root, meta = {}) {
  const mods = MODULES.map((rel) => {
    const code = fs.readFileSync(path.join(root, rel), 'utf8');
    return `__mods[${JSON.stringify(rel)}] = function (module, exports, require) {\n${code}\n};`;
  }).join('\n\n');

  const assets = {};
  for (const name of ASSETS) {
    assets[name] = fs.readFileSync(path.join(root, 'public', name), 'utf8');
  }
  const bin = {};
  for (const name of BIN_ASSETS) {
    const file = path.join(root, 'public', name);
    if (fs.existsSync(file)) bin[name] = fs.readFileSync(file).toString('base64');
  }
  for (const v of VENDOR_BIN) {
    if (v.sea) continue; // 走 SEA 原生 assets，不进 JS 字符串
    const file = path.join(root, v.rel);
    if (fs.existsSync(file)) bin[v.key] = fs.readFileSync(file).toString('base64');
  }

  return `'use strict';
/* 单文件构建产物：由 build/bundle.js 生成，请勿手改 */
global.__APP_META__ = ${JSON.stringify(meta)};
global.__EMBEDDED__ = ${JSON.stringify(assets)};
global.__EMBEDDED_BIN__ = ${JSON.stringify(bin)};

(function () {
  const __nativeRequire = require;
  const __mods = Object.create(null);
  const __cache = Object.create(null);

  ${mods}

  function __load(id) {
    if (__cache[id]) return __cache[id].exports;
    const mod = { exports: {} };
    __cache[id] = mod;
    __mods[id](mod, mod.exports, __makeRequire(id));
    return mod.exports;
  }

  function __makeRequire(id) {
    return function (request) {
      if (!request.startsWith('.')) return __nativeRequire(request);
      const dir = id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '';
      const segs = ((dir ? dir + '/' : '') + request).split('/');
      const out = [];
      for (const seg of segs) {
        if (seg === '' || seg === '.') continue;
        if (seg === '..') out.pop();
        else out.push(seg);
      }
      let key = out.join('/');
      if (!key.endsWith('.js')) key += '.js';
      if (!__mods[key]) {
        throw new Error('模块未打包：' + request + '（来自 ' + id + '）');
      }
      return __load(key);
    };
  }

  __load('server.js');
})();
`;
}

module.exports = { buildBundle, MODULES, ASSETS, BIN_ASSETS, VENDOR_BIN, SEA_ASSETS };
