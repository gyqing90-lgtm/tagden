#!/usr/bin/env node
'use strict';

/**
 * 生成统计页的**离线**行政区划索引 public/regions.bin。
 *
 * 数据源：GeoNames cities15000 + admin1CodesASCII（CC BY 4.0）
 *   https://download.geonames.org/export/dump/cities15000.zip
 *   https://download.geonames.org/export/dump/admin1CodesASCII.txt
 *
 *   node tools/build-regions.js --download
 *   node tools/build-regions.js --dir .cache/geonames
 *
 * 为什么不用在线反查：统计几千张带 GPS 的照片时，逐个请求第三方服务会慢到几十分钟，
 * 也把坐标发给了外部。这里只保留「最近城市 + 所属省」的紧凑表（约 25 KB gzip），
 * 查询完全本地；离最近城市超过 MAX_KM 的点返回空，让统计页回落到文件夹名，
 * 宁可少标一个省，也不把羌塘标成新疆。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { unzip } = require('../lib/llama');

const ROOT = path.join(__dirname, '..');
const CACHE = path.join(ROOT, '.cache', 'geonames');
const OUT = path.join(ROOT, 'public', 'regions.bin');
const MAX_KM = 80;

const argv = process.argv.slice(2);
const argOf = (name, fallback = '') => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const DIR = path.resolve(ROOT, argOf('--dir', CACHE));
const DOWNLOAD = argv.includes('--download');

const PROVINCE = {
  Anhui: '安徽省',
  Beijing: '北京市',
  Chongqing: '重庆市',
  Fujian: '福建省',
  Gansu: '甘肃省',
  Guangdong: '广东省',
  Guangxi: '广西壮族自治区',
  Guizhou: '贵州省',
  Hainan: '海南省',
  Hebei: '河北省',
  Heilongjiang: '黑龙江省',
  Henan: '河南省',
  Hubei: '湖北省',
  Hunan: '湖南省',
  'Inner Mongolia': '内蒙古自治区',
  Jiangsu: '江苏省',
  Jiangxi: '江西省',
  Jilin: '吉林省',
  Liaoning: '辽宁省',
  Ningxia: '宁夏回族自治区',
  Qinghai: '青海省',
  Shaanxi: '陕西省',
  Shandong: '山东省',
  Shanghai: '上海市',
  Shanxi: '山西省',
  Sichuan: '四川省',
  Tianjin: '天津市',
  Tibet: '西藏自治区',
  Xinjiang: '新疆维吾尔自治区',
  Yunnan: '云南省',
  Zhejiang: '浙江省',
};

// GeoNames 的 alternatenames 不标语言；用少量常见繁体/日文字做降权，优先选简体候选。
const TRAD = new Set('薩廈門爾齊龍鳳陽東寧遼蘇魯陝肅濱滿灣廣慶興義烏蘭銀鐵錦臺島嶼縣區鎮鄉莊溝嶺峯巖壩橋瀋蘆葦撫順滿'.split(''));
const JP_ONLY = new Set('満沢広辺図竜桜塩浜県駅円気戸児剣険検験権観関覧徳圧'.split(''));

async function download(file, url) {
  const target = path.join(DIR, file);
  if (fs.existsSync(target) && fs.statSync(target).size > 1024) return target;
  fs.mkdirSync(DIR, { recursive: true });
  console.log(`下载 ${url}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(30 * 60 * 1000) });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(target, buf);
  console.log(`  ${file}  ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
  return target;
}

async function ensureSources() {
  const cityTxt = path.join(DIR, 'cities15000.txt');
  const adminTxt = path.join(DIR, 'admin1CodesASCII.txt');
  if (fs.existsSync(cityTxt) && fs.existsSync(adminTxt)) return { cityTxt, adminTxt };

  if (!DOWNLOAD) {
    throw new Error(
      `找不到 ${cityTxt} / ${adminTxt}\n` +
        '加 --download 自动下载（约 3 MB），或把这两个文件放进 --dir 指定的目录。',
    );
  }

  const zip = await download('cities15000.zip', 'https://download.geonames.org/export/dump/cities15000.zip');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tagden-regions-'));
  try {
    unzip(fs.readFileSync(zip), tmp);
    const found = path.join(tmp, 'cities15000.txt');
    if (!fs.existsSync(found)) throw new Error('cities15000.zip 里没有 cities15000.txt');
    fs.copyFileSync(found, cityTxt);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  await download('admin1CodesASCII.txt', 'https://download.geonames.org/export/dump/admin1CodesASCII.txt');
  return { cityTxt, adminTxt };
}

function pickCityName(alternates) {
  const cands = String(alternates || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[\u4e00-\u9fa5]+$/.test(s))
    .filter((s) => ![...s].some((ch) => JP_ONLY.has(ch)));
  if (!cands.length) return '';

  const tradScore = (s) => [...s].filter((ch) => TRAD.has(ch)).length;
  const rank = (s) => {
    if (s.endsWith('市')) return 5;
    if (s.endsWith('县')) return 4;
    if (s.endsWith('区')) return 3;
    if (s.endsWith('旗') || s.endsWith('州') || s.endsWith('盟') || s.endsWith('地区')) return 2;
    if (s.endsWith('镇')) return 1;
    return 0;
  };
  cands.sort((a, b) => tradScore(a) - tradScore(b) || rank(b) - rank(a) || b.length - a.length);
  return cands[0];
}

async function main() {
  const { cityTxt, adminTxt } = await ensureSources();

  const admin = {};
  for (const line of fs.readFileSync(adminTxt, 'utf8').split('\n')) {
    const p = line.split('\t');
    if (p[0] && p[0].startsWith('CN.')) admin[p[0].slice(3)] = p[1];
  }

  const byKey = new Map();
  let raw = 0;
  let noCn = 0;
  for (const line of fs.readFileSync(cityTxt, 'utf8').split('\n')) {
    const p = line.split('\t');
    if (p[8] !== 'CN' || p[6] !== 'P') continue;
    raw += 1;
    const province = PROVINCE[admin[p[10]]];
    if (!province) continue;
    const city = pickCityName(p[3]);
    if (!city) {
      noCn += 1;
      continue;
    }
    const lat = Number(p[4]);
    const lon = Number(p[5]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const pop = Number(p[14]) || 0;
    const key = `${province}|${city}`;
    const old = byKey.get(key);
    if (!old || pop > old.pop) byKey.set(key, { lat, lon, city, province, pop });
  }

  const cities = [...byKey.values()].map((c) => [
    Math.round(c.lat * 10000) / 10000,
    Math.round(c.lon * 10000) / 10000,
    c.city,
    c.province,
  ]);
  if (!cities.length) throw new Error('没有解析出任何城市，检查数据源格式');

  const data = {
    v: 1,
    source: 'GeoNames cities15000 + admin1CodesASCII (CC BY 4.0)',
    updated: new Date().toISOString().slice(0, 10),
    maxKm: MAX_KM,
    cities,
  };
  const json = Buffer.from(JSON.stringify(data), 'utf8');
  const gz = zlib.gzipSync(json, { level: 9 });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, gz);

  console.log(`原始 CN 地点 ${raw}，无中文候选 ${noCn}`);
  console.log(`城市 ${cities.length}，gzip ${(gz.length / 1024).toFixed(1)} KB -> ${path.relative(ROOT, OUT)}`);
  console.log('数据来源：GeoNames（CC BY 4.0），发布时保留署名。');
}

main().catch((err) => {
  console.error('生成失败：' + err.message);
  process.exit(1);
});
