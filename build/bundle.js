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
  'lib/assets.js',
  'lib/http.js',
  'lib/parse.js',
  'lib/adapters.js',
  'lib/aggregate.js',
  'lib/ebird.js',
  'lib/inat.js',
  'lib/ppbc.js',
  'lib/baidu.js',
  'lib/secure.js',
  'lib/exif.js',
  'lib/imgmeta.js',
  'lib/labelcache.js',
];

/** 文本资源：按 utf8 内联成字符串 */
const ASSETS = ['index.html', 'style.css', 'app.js'];
/** 二进制资源：按 base64 内联（作者的微信二维码） */
const BIN_ASSETS = ['author-qr.png'];

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

module.exports = { buildBundle, MODULES, ASSETS, BIN_ASSETS };
