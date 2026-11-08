/* global importScripts, ScoreEngine, OffscreenCanvas, FileReaderSync */
/*
 * 照片评分 Worker。
 *
 * Node 侧没有 JPEG 解码器，也不许引第三方依赖，所以解码交给浏览器：
 *   /img 原图 → createImageBitmap（imageOrientation: 'none'，与 cv2.imdecode 一致，
 *   不应用 EXIF 旋转）→ OffscreenCanvas 原尺寸取 ImageData → ScoreEngine.analyze()。
 *
 * 缩放绝不交给 drawImage（那是双线性/双三次，不是 cv2.INTER_AREA）——
 * 内核里的 interArea() 会自己按像素覆盖面积算，已用 golden3.py 逐像素验证过。
 *
 * 消息：
 *   主 → W  { id, type:'score',  items:[{name,path,meta}] }
 *   主 → W  { id, type:'remote', items:[{key,name,url,meta}] }
 *   主 → W  { id, type:'encode', items:[{name,path}], side }   // 给 AI 压图
 *   主 → W  { id, type:'cancel' }
 *   W → 主  { id, type:'progress', done, total, name, rec?, error? }
 *   W → 主  { id, type:'done', entries|images, cancelled }
 */
'use strict';

importScripts('/score-engine.js');
const E = ScoreEngine;

let cancelled = false;

function post(msg) { self.postMessage(msg); }

/** 取一张原图的 RGBA 与尺寸；用完立刻 close()，别让大图堆在内存里 */
async function decode(url, maxBytes) {
  const r = await fetch(url, { cache: 'force-cache' });
  if (!r.ok) throw new Error(`取图失败 HTTP ${r.status}`);
  const blob = await r.blob();
  if (maxBytes && blob.size > maxBytes) throw new Error(`原图超过 ${Math.round(maxBytes / 1048576)} MB，跳过`);
  let bmp;
  try {
    // imageOrientation:'none' 对应 cv2.imdecode 不应用 EXIF 旋转
    bmp = await createImageBitmap(blob, { imageOrientation: 'none' });
  } catch {
    bmp = await createImageBitmap(blob);
  }
  const w = bmp.width; const h = bmp.height;
  if (!w || !h) { bmp.close?.(); throw new Error('图片尺寸为 0'); }
  const cv = new OffscreenCanvas(w, h);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data;
  bmp.close?.();
  // 让 OffscreenCanvas 尽快被回收：5568×3712 一张就是 82MB
  cv.width = 0; cv.height = 0;
  return { rgba: new Uint8Array(data.buffer.slice(0)), sw: w, sh: h, bytes: blob.size };
}

async function scoreOne(item, remote) {
  const url = remote ? item.url : `/img?path=${encodeURIComponent(item.path)}`;
  const px = await decode(url, 64 * 1024 * 1024);
  const m = item.meta || {};
  const rec = E.analyze({
    rgba: px.rgba, sw: px.sw, sh: px.sh,
    iso: m.iso, width: px.sw, height: px.sh,
    filesizeKb: m.sizeKb || Math.round(px.bytes / 1024),
    withHash: true,
  });
  rec.at = Date.now();
  return rec;
}

async function runScore(id, items, remote) {
  const entries = {};
  for (let i = 0; i < items.length; i += 1) {
    if (cancelled) break;
    const it = items[i];
    try {
      const rec = await scoreOne(it, remote);
      const key = remote ? it.key : it.name;
      entries[key] = rec;
      post({ id, type: 'progress', done: i + 1, total: items.length, key, name: it.name, rec });
    } catch (err) {
      post({ id, type: 'progress', done: i + 1, total: items.length,
        key: remote ? it.key : it.name, name: it.name, error: err.message || String(err) });
    }
    // 每张之间让出一次，取消消息才有机会被处理
    await new Promise((r) => setTimeout(r, 0));
  }
  post({ id, type: 'done', entries, cancelled });
}

/** AI 用图：等比缩到 side，压成 JPEG data URL。这里可以用 drawImage，不要求像素级一致 */
async function encodeOne(item, side) {
  const url = `/img?path=${encodeURIComponent(item.path)}`;
  const px = await decode(url, 64 * 1024 * 1024);
  const s = Math.min(1, side / Math.max(px.sw, px.sh));
  const w = Math.max(1, Math.round(px.sw * s));
  const h = Math.max(1, Math.round(px.sh * s));
  const cv = new OffscreenCanvas(w, h);
  const ctx = cv.getContext('2d');
  const src = new OffscreenCanvas(px.sw, px.sh);
  src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px.rgba), px.sw, px.sh), 0, 0);
  ctx.drawImage(src, 0, 0, w, h);
  const blob = await cv.convertToBlob({ type: 'image/jpeg', quality: side <= 768 ? 0.88 : 0.85 });
  const dataUrl = new FileReaderSync().readAsDataURL(blob);
  cv.width = 0; cv.height = 0; src.width = 0; src.height = 0;
  return dataUrl;
}

async function runEncode(id, items, side) {
  const images = [];
  for (let i = 0; i < items.length; i += 1) {
    if (cancelled) break;
    const it = items[i];
    try {
      images.push({ name: it.name, dataUrl: await encodeOne(it, side || 768) });
      post({ id, type: 'progress', done: i + 1, total: items.length, name: it.name });
    } catch (err) {
      post({ id, type: 'progress', done: i + 1, total: items.length, name: it.name, error: err.message || String(err) });
    }
    await new Promise((r) => setTimeout(r, 0));
  }
  post({ id, type: 'done', images, cancelled });
}

self.onmessage = (ev) => {
  const m = ev.data || {};
  if (m.type === 'cancel') { cancelled = true; return; }
  cancelled = false;
  const id = m.id || 0;
  const items = Array.isArray(m.items) ? m.items : [];
  if (m.type === 'score') runScore(id, items, false).catch((e) => post({ id, type: 'done', entries: {}, error: e.message }));
  else if (m.type === 'remote') runScore(id, items, true).catch((e) => post({ id, type: 'done', entries: {}, error: e.message }));
  else if (m.type === 'encode') runEncode(id, items, m.side).catch((e) => post({ id, type: 'done', images: [], error: e.message }));
  else post({ id, type: 'done', error: '未知的评分任务' });
};
