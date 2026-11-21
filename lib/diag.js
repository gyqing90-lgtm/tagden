'use strict';

/**
 * 诊断包：把「出问题时需要看的东西」收成几个纯文本文件，交给用户发给开发者。
 *
 * 一条硬规则：**只报「有没有填」，绝不输出值**。
 *   账号、密码、令牌、API Key 一律变成 true/false；
 *   文件名不列（只报数量），避免把用户的研究对象、地点清单带出去。
 * 这样用户可以放心把这个包发给任何人。
 */

const fs = require('node:fs');
const path = require('node:path');

/** 值 → 是否非空（空串 / null / undefined / 0 长度数组都算没填） */
function filled(v) {
  if (v == null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  if (typeof v === 'number') return v !== 0;
  return !!v;
}

/**
 * 站点配置脱敏：{ xingse: {username:true, password:true, token:false} }
 * 键名保留（知道哪些字段该填），值全部换成布尔。
 */
/**
 * baseUrl 只留域名进诊断包：能看出走的是哪家接口，又不带路径参数或多余的凭据。
 * 解析失败就原样截断，反正诊断包里多一行不致命。
 */
function endpointHost(baseUrl) {
  const s = String(baseUrl || '').trim();
  if (!s) return 'api.deepseek.com（默认）';
  try {
    return new URL(s).host;
  } catch {
    return s.slice(0, 60);
  }
}

function maskSites(sites) {
  const out = {};
  for (const [name, cfg] of Object.entries(sites || {})) {
    if (!cfg || typeof cfg !== 'object') {
      out[name] = { configured: filled(cfg) };
      continue;
    }
    const fields = {};
    for (const [k, v] of Object.entries(cfg)) {
      // tokenAt 这类时间戳没有诊断价值，只用来说明「有没有」
      fields[k] = filled(v);
    }
    out[name] = fields;
  }
  return out;
}

/** 目录概览：只数数量，不列名字 */
function dirStats(dir, maxMs = 4000) {
  if (!dir) return null;
  const t0 = Date.now();
  let files = 0;
  let dirs = 0;
  let labeled = 0;
  let images = 0;
  let bytes = 0;
  const IMG = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.tif', '.tiff', '.bmp', '.gif']);
  const walk = (d, depth) => {
    if (Date.now() - t0 > maxMs) return; // 大目录别把诊断包拖死
    let ents = [];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        dirs += 1;
        if (depth < 2) walk(full, depth + 1);
        continue;
      }
      files += 1;
      const ext = path.extname(e.name).toLowerCase();
      if (IMG.has(ext)) images += 1;
      try {
        bytes += fs.statSync(full).size;
      } catch {
        /* 读不到就不算体积 */
      }
    }
  };
  walk(dir, 0);
  return { path: dir, files, images, dirs, bytes, truncated: Date.now() - t0 > maxMs };
}

/** 递归算目录体积（只用于缓存目录，最大的几千个文件，限制深度避免扫穿） */
function dirSize(dir, maxDepth = 3, depth = 0) {
  let total = 0;
  let count = 0;
  if (depth > maxDepth) return { bytes: 0, files: 0 };
  let ents = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { bytes: 0, files: 0 };
  }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const sub = dirSize(full, maxDepth, depth + 1);
      total += sub.bytes;
      count += sub.files;
    } else {
      try {
        total += fs.statSync(full).size;
        count += 1;
      } catch {
        /* 忽略 */
      }
    }
  }
  return { bytes: total, files: count };
}

function mb(bytes) {
  return `${(Number(bytes || 0) / 1048576).toFixed(1)} MB`;
}

/**
 * 收集诊断信息，返回可直接写进 zip 的条目（都是文本）。
 * @param {object} ctx
 * @returns {{entries: Array<{name:string,data:string}>, summary: object}}
 */
function collect(ctx = {}) {
  const now = new Date();
  const uptime = Math.max(0, Math.round((Date.now() - (ctx.startedAt || Date.now())) / 1000));
  const mem = process.memoryUsage();

  const info = [
    '=== tagden 诊断信息 ===',
    `生成时间      ${now.toLocaleString('zh-CN')} (${now.toISOString()})`,
    `版本          ${ctx.version || '?'}`,
    `运行形态      ${ctx.isSea ? 'exe (SEA)' : ctx.isAppBundle ? 'macOS app' : '源码 node'}`,
    '',
    '--- 运行环境 ---',
    `平台          ${process.platform} ${process.arch}`,
    `Node          ${process.versions.node}`,
    `CPU 核心      ${require('node:os').cpus().length}`,
    `总内存        ${mb(require('node:os').totalmem())}`,
    `进程内存      rss ${mb(mem.rss)} / heap ${mb(mem.heapUsed)}`,
    `已运行        ${Math.floor(uptime / 3600)} 时 ${Math.floor((uptime % 3600) / 60)} 分`,
    `监听端口      ${ctx.port || '?'}`,
    '',
    '--- 目录 ---',
    `程序目录      ${ctx.appDir || '?'}`,
    `数据目录      ${ctx.dataDir || '?'}`,
    `缓存目录      ${ctx.cacheDir || '?'}`,
    '',
    '--- 配置落盘 ---',
    `config.json   ${ctx.cfgExists ? '存在' : '不存在'}`,
    `加密形态      ${ctx.cfgSealed ? '已加密（BID1 信封）' : ctx.cfgExists ? '明文 JSON' : '-'}`,
    `配置项        ${(ctx.cfgKeys || []).join(', ') || '(空)'}`,
    '',
    '--- 本地名录 ---',
    `${(ctx.localTaxo && ctx.localTaxo.text) || '未接入'}`,
    '',
    '--- 中文名归并（CoL China）---',
    `${(ctx.colcn && ctx.colcn.text) || '未初始化'}`,
    '',
    '--- 本地大模型 ---',
    `${(ctx.llama && ctx.llama.text) || '未安装'}`,
    '',
  ].join('\n');

  const sites = {
    _说明: '这里只有「该字段有没有填」，不含任何账号、密码、令牌、Key 的实际值。',
    generatedAt: now.toISOString(),
    sites: maskSites(ctx.sites),
    deepseek: {
      configured: !!(ctx.deepseek && ctx.deepseek.apiKey),
      model: (ctx.deepseek && ctx.deepseek.model) || '',
      // 只记域名，用来区分「官方 / 云知声 / 自定义」，不带任何凭据
      endpoint: endpointHost(ctx.deepseek && ctx.deepseek.baseUrl),
    },
    ui: ctx.ui || {},
    sessions: maskSites(ctx.sessions),
  };

  const features = {
    generatedAt: now.toISOString(),
    version: ctx.version || '',
    cache: ctx.cacheInfo || null,
    models: ctx.models || [],
    library: ctx.library || null,
    counts: ctx.counts || {},
  };

  const entries = [
    { name: 'info.txt', data: info },
    { name: 'config-redacted.json', data: JSON.stringify(sites, null, 2) },
    { name: 'features.json', data: JSON.stringify(features, null, 2) },
  ];

  if (ctx.dir) {
    const st = dirStats(ctx.dir);
    entries.push({
      name: 'folder-stats.txt',
      data: [
        `目录          ${st.path}`,
        `文件总数      ${st.files}（其中图片 ${st.images}）`,
        `子目录        ${st.dirs}`,
        `总体积        ${mb(st.bytes)}`,
        st.truncated ? '（目录太大，统计提前结束）' : '',
      ]
        .filter(Boolean)
        .join('\n'),
    });
  }

  return {
    entries,
    summary: {
      files: entries.length,
      bytes: entries.reduce((n, e) => n + Buffer.byteLength(e.data), 0),
    },
  };
}

/** 文件名：tagden-diagnose-20261117-0606 */
function stampName(at = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `tagden-diagnose-${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}`;
}

module.exports = { collect, maskSites, dirStats, dirSize, stampName, filled, mb };
