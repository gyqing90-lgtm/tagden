'use strict';

/**
 * 离线行政区划查询：GPS → 「省·市」。
 *
 * 数据来自 GeoNames cities15000 + admin1CodesASCII（CC BY 4.0），由
 * tools/build-regions.js 压成 public/regions.bin（约 24 KB gzip），随程序内联。
 * 完全本地：统计几千张带 GPS 的照片也不会请求第三方，更不会把坐标发出去。
 *
 * 口径：只取最近的城市；离最近城市超过 maxKm（默认 80 km）就返回空，
 * 由统计页回落到文件夹名 —— 宁可少标一个省，也不把羌塘标成新疆。
 * 直辖市只显示「北京市 / 上海市 / 天津市 / 重庆市」，不再拼区名。
 */

const zlib = require('node:zlib');
const ASSETS = require('./assets');

const FILE = 'regions.bin';
const MUNI = new Set(['北京市', '上海市', '天津市', '重庆市']);

let ready = false;
let cities = [];
let maxKm = 80;
let source = '';
let error = '';
const cache = new Map();

function init() {
  if (ready) return;
  ready = true;
  try {
    const hit = ASSETS.get(`/${FILE}`);
    if (!hit || !hit.body || !hit.body.length) throw new Error('没有内置 regions.bin');
    const j = JSON.parse(zlib.gunzipSync(hit.body).toString('utf8'));
    if (!j || !Array.isArray(j.cities) || !j.cities.length) throw new Error('regions.bin 结构不正确');
    cities = j.cities;
    maxKm = Number(j.maxKm) || 80;
    source = String(j.source || '');
  } catch (err) {
    cities = [];
    error = err.message || String(err);
  }
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** 返回「福建省·福州市」/「北京市」；查不到或离城市太远返回 '' */
function labelFor(lat, lon) {
  init();
  if (!cities.length) return '';
  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return '';
  const key = `${la.toFixed(2)},${lo.toFixed(2)}`;
  if (cache.has(key)) return cache.get(key);

  let best = null;
  let bestKm = Infinity;
  for (const c of cities) {
    const km = haversine(la, lo, c[0], c[1]);
    if (km < bestKm) {
      bestKm = km;
      best = c;
      if (bestKm < 1) break; // 已经贴着城市，不用再找
    }
  }

  let label = '';
  if (best && bestKm <= maxKm) {
    label = MUNI.has(best[3]) ? best[3] : `${best[3]}·${best[2]}`;
  }
  if (cache.size > 20000) cache.clear();
  cache.set(key, label);
  return label;
}

function stat() {
  init();
  return { ready: cities.length > 0, count: cities.length, maxKm, source, error };
}

module.exports = { init, labelFor, stat };
