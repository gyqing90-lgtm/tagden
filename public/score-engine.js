/* global globalThis, module */
/*
 * 照片技术评分内核 v2 —— 纯 JS 1:1 复现 bio-image / score_photos.py (SV=2)
 *
 * 为什么放在 public/ 而不是 lib/：
 *   这一份代码要同时在两处跑 —— 浏览器 Web Worker 里做真实评分，Node 里跑
 *   golden 回归（本机 Chromium 的 CDP 全挂，验收不能依赖浏览器）。
 *   底部用 UMD 双导出：require() 拿 module.exports，importScripts() 拿 self.ScoreEngine。
 *
 * 不碰图像解码：JPEG/PNG 由浏览器 Canvas 解成 RGBA 原尺寸像素再喂进来，
 * 缩放必须由本文件的 interArea() 做 —— Canvas 的 drawImage 缩放是双线性/双三次，
 * 和 cv2.INTER_AREA 不是一回事，直接用会让锐度整体漂掉。
 *
 * 口径对照（改动前请先看 %TEMP%/natdemo/golden.py + js-probe.js 的 36 项回归）：
 *   Sobel / Laplacian 边界 = BORDER_REFLECT_101
 *   medianBlur 边界        = BORDER_REPLICATE
 *   灰度定点              = cv2 COLOR_BGR2GRAY 的 (4899,9617,1868) / 16384
 *   SV = 2，与评分器 app.py 的 SCORE_SV 一致 —— 历史 .photo_scores.json 不用重评
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ScoreEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SV = 2;
  const MAX_SIDE = 1400;
  const GRID = 8;
  const TOPK = 0.10;
  const CAL_LO = 400.0;
  const CAL_HI = 7000.0;
  const NOISE_LIMIT = 10.0;
  const FLAT_LIMIT = 12.0;

  const clamp = (x, lo, hi) => Math.max(lo === undefined ? 0 : lo, Math.min(hi === undefined ? 100 : hi, x));

  /* ------------------------------------------------------------------ *
   * 图像预处理：INTER_AREA 缩放 + RGBA → 灰度 / BGR
   * ------------------------------------------------------------------ */

  /**
   * cv2.INTER_AREA 精确实现（缩小时按像素覆盖面积加权平均）。
   * 目标尺寸沿用 score_photos.resize_max 的写法：int(w*s) 截断，不四舍五入。
   * 返回 { rgba: Uint8ClampedArray, w, h }。
   */
  function interArea(src, sw, sh, maxSide) {
    const side = maxSide || MAX_SIDE;
    const long = Math.max(sw, sh);
    let dw = sw; let dh = sh;
    if (long > side) {
      const s = side / long;
      dw = Math.max(1, Math.floor(sw * s));
      dh = Math.max(1, Math.floor(sh * s));
    }
    if (dw === sw && dh === sh) {
      return { rgba: src, w: sw, h: sh };
    }
    const rx = sw / dw; const ry = sh / dh;
    const out = new Uint8ClampedArray(dw * dh * 4);
    for (let dy = 0; dy < dh; dy += 1) {
      const y0 = dy * ry; const y1 = (dy + 1) * ry;
      const iy0 = Math.floor(y0); const iy1 = Math.min(sh, Math.ceil(y1));
      for (let dx = 0; dx < dw; dx += 1) {
        const x0 = dx * rx; const x1 = (dx + 1) * rx;
        const ix0 = Math.floor(x0); const ix1 = Math.min(sw, Math.ceil(x1));
        let r = 0; let g = 0; let b = 0; let a = 0; let wsum = 0;
        for (let y = iy0; y < iy1; y += 1) {
          const wy = Math.min(y + 1, y1) - Math.max(y, y0);
          if (wy <= 0) continue;
          const row = y * sw;
          for (let x = ix0; x < ix1; x += 1) {
            const wx = Math.min(x + 1, x1) - Math.max(x, x0);
            if (wx <= 0) continue;
            const w = wx * wy;
            const i = (row + x) * 4;
            r += src[i] * w;
            g += src[i + 1] * w;
            b += src[i + 2] * w;
            a += src[i + 3] * w;
            wsum += w;
          }
        }
        const o = (dy * dw + dx) * 4;
        const inv = wsum > 0 ? 1 / wsum : 0;
        out[o] = r * inv;
        out[o + 1] = g * inv;
        out[o + 2] = b * inv;
        out[o + 3] = a * inv;
      }
    }
    return { rgba: out, w: dw, h: dh };
  }

  /** RGBA → { gray: Uint8Array, bgr: Uint8Array }，灰度用 cv2 的定点系数 */
  function toGrayBgr(rgba, w, h) {
    const n = w * h;
    const gray = new Uint8Array(n);
    const bgr = new Uint8Array(n * 3);
    for (let i = 0; i < n; i += 1) {
      const p = i * 4;
      const r = rgba[p]; const g = rgba[p + 1]; const b = rgba[p + 2];
      // cv2 COLOR_BGR2GRAY: (B*1868 + G*9617 + R*4899 + 8192) >> 14
      gray[i] = (b * 1868 + g * 9617 + r * 4899 + 8192) >> 14;
      bgr[i * 3] = b;
      bgr[i * 3 + 1] = g;
      bgr[i * 3 + 2] = r;
    }
    return { gray, bgr };
  }

  /* ------------------------------------------------------------------ *
   * OpenCV 滤波器：边界模式必须照抄，漏一个锐度就漂
   * ------------------------------------------------------------------ */

  function reflect101(i, n) {
    if (n <= 1) return 0;
    let k = i;
    while (k < 0 || k >= n) {
      if (k < 0) k = -k;
      if (k >= n) k = 2 * (n - 1) - k;
    }
    return k;
  }
  const replicate = (i, n) => (i < 0 ? 0 : i >= n ? n - 1 : i);

  /** cv2.medianBlur(ksize=3)：BORDER_REPLICATE */
  function medianBlur3(g, w, h) {
    const out = new Float32Array(w * h);
    const win = new Float32Array(9);
    for (let y = 0; y < h; y += 1) {
      const rm = replicate(y - 1, h) * w;
      const r0 = replicate(y, h) * w;
      const rp = replicate(y + 1, h) * w;
      for (let x = 0; x < w; x += 1) {
        const cm = replicate(x - 1, w);
        const c0 = replicate(x, w);
        const cp = replicate(x + 1, w);
        win[0] = g[rm + cm]; win[1] = g[rm + c0]; win[2] = g[rm + cp];
        win[3] = g[r0 + cm]; win[4] = g[r0 + c0]; win[5] = g[r0 + cp];
        win[6] = g[rp + cm]; win[7] = g[rp + c0]; win[8] = g[rp + cp];
        win.sort();
        out[y * w + x] = win[4];
      }
    }
    return out;
  }

  /** cv2.Sobel(ksize=3, CV_32F) 梯度幅值：BORDER_REFLECT_101 */
  function sobelMag(sm, w, h) {
    const KX = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
    const KY = [-1, -2, -1, 0, 0, 0, 1, 2, 1];
    const mag = new Float32Array(w * h);
    const rows = new Int32Array(3);
    const cols = new Int32Array(3);
    for (let y = 0; y < h; y += 1) {
      for (let d = 0; d < 3; d += 1) rows[d] = reflect101(y + d - 1, h) * w;
      for (let x = 0; x < w; x += 1) {
        for (let d = 0; d < 3; d += 1) cols[d] = reflect101(x + d - 1, w);
        let sx = 0; let sy = 0; let k = 0;
        for (let dy = 0; dy < 3; dy += 1) {
          const row = rows[dy];
          for (let dx = 0; dx < 3; dx += 1, k += 1) {
            const v = sm[row + cols[dx]];
            sx += v * KX[k];
            sy += v * KY[k];
          }
        }
        mag[y * w + x] = Math.sqrt(sx * sx + sy * sy);
      }
    }
    return mag;
  }

  /** cv2.Laplacian(ksize=1, CV_32F).var() */
  function lapVar(blk, w, h) {
    const out = new Float64Array(w * h);
    const rows = new Int32Array(3);
    const cols = new Int32Array(3);
    for (let y = 0; y < h; y += 1) {
      const ru = reflect101(y - 1, h) * w;
      const r0 = y * w;
      const rd = reflect101(y + 1, h) * w;
      rows[0] = ru; rows[1] = r0; rows[2] = rd;
      for (let x = 0; x < w; x += 1) {
        cols[0] = reflect101(x - 1, w);
        cols[1] = x;
        cols[2] = reflect101(x + 1, w);
        out[y * w + x] = blk[ru + cols[1]] + blk[r0 + cols[0]] - 4 * blk[r0 + cols[1]]
          + blk[r0 + cols[2]] + blk[rd + cols[1]];
      }
    }
    let sum = 0; let sum2 = 0;
    for (let i = 0; i < out.length; i += 1) { sum += out[i]; sum2 += out[i] * out[i]; }
    const m = sum / out.length;
    return sum2 / out.length - m * m;
  }

  function lapBlockTopk(sub, w, h, n, k) {
    const bh = Math.max(Math.floor(h / n), 8);
    const bw = Math.max(Math.floor(w / n), 8);
    const vals = [];
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        const y0 = i * bh; const x0 = j * bw;
        if (y0 >= h || x0 >= w) continue;
        const hh = Math.min(bh, h - y0); const ww = Math.min(bw, w - x0);
        if (hh <= 0 || ww <= 0) continue;
        const blk = new Float32Array(hh * ww);
        for (let y = 0; y < hh; y += 1) {
          for (let x = 0; x < ww; x += 1) blk[y * ww + x] = sub[(y0 + y) * w + (x0 + x)];
        }
        vals.push(lapVar(blk, ww, hh));
      }
    }
    if (!vals.length) return 0;
    vals.sort((a, b) => a - b);
    const take = Math.max(1, Math.floor(vals.length * k));
    let s = 0;
    for (let i = vals.length - take; i < vals.length; i += 1) s += vals[i];
    return s / take;
  }

  /** 14×14 分块 Sobel 能量 → 中心先验 → 区域生长 → 主体外接框 */
  function subjectBox(gray, w, h, grid, growRatio, minFrac) {
    const G = grid || 14;
    const grow = growRatio === undefined ? 0.30 : growRatio;
    const mf = minFrac === undefined ? 0.18 : minFrac;
    if (h < G * 2 || w < G * 2) return [0, 0, w, h, 1.0];
    const sm = medianBlur3(gray, w, h);
    const mag = sobelMag(sm, w, h);
    const bh = Math.floor(h / G); const bw = Math.floor(w / G);
    const cells = new Float64Array(G * G);
    for (let y = 0; y < bh * G; y += 1) {
      const cy = Math.floor(y / bh) * G;
      for (let x = 0; x < bw * G; x += 1) cells[cy + Math.floor(x / bw)] += mag[y * w + x];
    }
    for (let i = 0; i < cells.length; i += 1) cells[i] /= (bh * bw);
    let maxCell = 0;
    for (let i = 0; i < cells.length; i += 1) if (cells[i] > maxCell) maxCell = cells[i];
    if (maxCell <= 0) return [0, 0, w, h, 1.0];

    const c = (G - 1) / 2.0;
    let best = -Infinity; let seed = 0;
    for (let y = 0; y < G; y += 1) {
      for (let x = 0; x < G; x += 1) {
        const dist = Math.sqrt((y - c) ** 2 + (x - c) ** 2) / (Math.SQRT2 * c);
        const sc = cells[y * G + x] * (1.0 - 0.18 * dist);
        if (sc > best) { best = sc; seed = y * G + x; }
      }
    }
    const thr = cells[seed] * grow;
    const mask = new Uint8Array(G * G);
    mask[seed] = 1;
    let changed = true;
    while (changed) {
      changed = false;
      for (let y = 0; y < G; y += 1) {
        for (let x = 0; x < G; x += 1) {
          const idx = y * G + x;
          if (mask[idx] || cells[idx] < thr) continue;
          if ((y > 0 && mask[idx - G]) || (y < G - 1 && mask[idx + G])
            || (x > 0 && mask[idx - 1]) || (x < G - 1 && mask[idx + 1])) {
            mask[idx] = 1; changed = true;
          }
        }
      }
    }
    let ymin = Infinity; let ymax = -Infinity; let xmin = Infinity; let xmax = -Infinity;
    for (let y = 0; y < G; y += 1) {
      for (let x = 0; x < G; x += 1) {
        if (!mask[y * G + x]) continue;
        if (y < ymin) ymin = y;
        if (y > ymax) ymax = y;
        if (x < xmin) xmin = x;
        if (x > xmax) xmax = x;
      }
    }
    if (ymax < 0) return [0, 0, w, h, 1.0];
    let y0 = ymin * bh; let y1 = (ymax + 1) * bh;
    let x0 = xmin * bw; let x1 = (xmax + 1) * bw;
    const minSide = Math.floor(Math.min(h, w) * mf);
    if (y1 - y0 < minSide) {
      const cc = Math.floor((y0 + y1) / 2);
      y0 = Math.max(0, cc - Math.floor(minSide / 2));
      y1 = Math.min(h, cc + Math.floor(minSide / 2));
    }
    if (x1 - x0 < minSide) {
      const cc = Math.floor((x0 + x1) / 2);
      x0 = Math.max(0, cc - Math.floor(minSide / 2));
      x1 = Math.min(w, cc + Math.floor(minSide / 2));
    }
    return [x0, y0, x1, y1, (y1 - y0) * (x1 - x0) / (h * w)];
  }

  function extractSub(gray, w, box) {
    const [x0, y0, x1, y1] = box;
    const sw = x1 - x0; const sh = y1 - y0;
    const sub = new Float32Array(sw * sh);
    for (let y = 0; y < sh; y += 1) {
      for (let x = 0; x < sw; x += 1) sub[y * sw + x] = gray[(y0 + y) * w + (x0 + x)];
    }
    return { sub, sw, sh };
  }

  const logCalibrate = (v, lo, hi) => {
    if (v <= 0) return 0;
    return clamp(100 * (Math.log(Math.max(v, 1.0)) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)));
  };

  /* ------------------------------------------------------------------ *
   * 感知哈希（连拍分组用）：dHash / aHash / pHash，输出 16 位 hex 字符串
   * ------------------------------------------------------------------ */

  /** 把灰度图按面积平均缩到指定尺寸（哈希用的小图，cv2 那边是双线性，
   *  这里复用 INTER_AREA；阈值宽松，差异不影响分组结果） */
  function grayResize(gray, sw, sh, dw, dh) {
    const rx = sw / dw; const ry = sh / dh;
    const out = new Float32Array(dw * dh);
    for (let dy = 0; dy < dh; dy += 1) {
      const y0 = dy * ry; const y1 = (dy + 1) * ry;
      const iy0 = Math.floor(y0); const iy1 = Math.min(sh, Math.ceil(y1));
      for (let dx = 0; dx < dw; dx += 1) {
        const x0 = dx * rx; const x1 = (dx + 1) * rx;
        const ix0 = Math.floor(x0); const ix1 = Math.min(sw, Math.ceil(x1));
        let s = 0; let wsum = 0;
        for (let y = iy0; y < iy1; y += 1) {
          const wy = Math.min(y + 1, y1) - Math.max(y, y0);
          if (wy <= 0) continue;
          const row = y * sw;
          for (let x = ix0; x < ix1; x += 1) {
            const wx = Math.min(x + 1, x1) - Math.max(x, x0);
            if (wx <= 0) continue;
            const w = wx * wy;
            s += gray[row + x] * w;
            wsum += w;
          }
        }
        out[dy * dw + dx] = wsum > 0 ? s / wsum : 0;
      }
    }
    return out;
  }

  function bitsToHex(bits) {
    let hex = '';
    for (let i = 0; i < bits.length; i += 4) {
      let v = 0;
      for (let j = 0; j < 4; j += 1) v = (v << 1) | (bits[i + j] ? 1 : 0);
      hex += v.toString(16);
    }
    return hex.padStart(16, '0');
  }

  function hashes(gray, w, h) {
    // dHash: 9×8，逐行比较右邻
    const d9 = grayResize(gray, w, h, 9, 8);
    const db = [];
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) db.push(d9[y * 9 + x + 1] > d9[y * 9 + x] ? 1 : 0);
    }
    // aHash: 8×8，与均值比
    const a8 = grayResize(gray, w, h, 8, 8);
    let mean = 0;
    for (let i = 0; i < a8.length; i += 1) mean += a8[i];
    mean /= a8.length;
    const ab = [];
    for (let i = 0; i < 64; i += 1) ab.push(a8[i] > mean ? 1 : 0);
    // pHash: 32×32 → DCT → 左上 8×8 去 DC → 中值
    const p32 = grayResize(gray, w, h, 32, 32);
    const COS = new Float32Array(8 * 32);
    for (let v = 0; v < 8; v += 1) {
      for (let x = 0; x < 32; x += 1) {
        COS[v * 32 + x] = Math.cos((2 * x + 1) * v * Math.PI / 64) * (v === 0 ? Math.SQRT1_2 : 1);
      }
    }
    const dct = new Float32Array(64);
    for (let v = 0; v < 8; v += 1) {
      for (let u = 0; u < 8; u += 1) {
        let s = 0;
        for (let y = 0; y < 32; y += 1) {
          const cv = COS[v * 32 + y];
          let row = 0;
          for (let x = 0; x < 32; x += 1) row += p32[y * 32 + x] * COS[u * 32 + x];
          s += row * cv;
        }
        dct[v * 8 + u] = s * 0.25 * 0.25;
      }
    }
    const low = Array.from(dct).slice(1);
    const sorted = low.slice().sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    const pb = low.map((v) => (v > med ? 1 : 0));
    return { d: bitsToHex(db), a: bitsToHex(ab), p: bitsToHex(pb) };
  }

  const HEXPOP = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];
  function ham(a, b) {
    if (!a || !b) return 64;
    let n = 0;
    for (let i = 0; i < 16; i += 1) {
      const x = parseInt(a[i] || '0', 16) ^ parseInt(b[i] || '0', 16);
      n += HEXPOP[x] || 0;
    }
    return n;
  }

  /** 与 app.py similar_pair 同一套阈值 */
  function similarPair(m1, m2) {
    if (!m1 || !m2 || !m1.d || !m2.d || !m1.a || !m2.a) return false;
    const dh = ham(m1.d, m2.d);
    const ah = ham(m1.a, m2.a);
    const ph = m1.p && m2.p ? ham(m1.p, m2.p) : 64;
    if (dh <= 10) return true;
    if (ah <= 8) return true;
    if (ph <= 8) return true;
    if (dh <= 16 && ah <= 12) return true;
    if (ph <= 10 && ah <= 14) return true;
    return false;
  }

  /* ------------------------------------------------------------------ *
   * 主入口：与 score_photos.analyze() 返回结构完全一致（sv=2）
   * ------------------------------------------------------------------ */

  /**
   * @param {object} o
   * @param {Uint8Array}   o.rgba   原尺寸 RGBA（Canvas getImageData）
   * @param {number}       o.sw o.sh 原尺寸
   * @param {number}       [o.iso]      EXIF ISO
   * @param {number}       [o.width]    原图像素宽（文件头口径）
   * @param {number}       [o.height]   原图像素高
   * @param {number}       [o.filesizeKb]
   * @param {boolean}      [o.withHash] 是否算感知哈希（连拍分组）
   */
  function analyze(o) {
    const sw = o.sw; const sh = o.sh;
    if (!sw || !sh || !o.rgba) throw new Error('没有图片像素');
    const scaled = interArea(o.rgba, sw, sh, MAX_SIDE);
    const { rgba, w, h } = scaled;
    const { gray, bgr } = toGrayBgr(rgba, w, h);
    const N = w * h;
    const grayF = new Float32Array(N);
    for (let i = 0; i < N; i += 1) grayF[i] = gray[i];

    const med = medianBlur3(grayF, w, h);
    let noiseRaw = 0; let sum = 0; let sum2 = 0; let over = 0; let under = 0;
    let satSum = 0; let bSum = 0; let gSum = 0; let rSum = 0;
    for (let i = 0; i < N; i += 1) {
      const v = grayF[i];
      noiseRaw += Math.abs(v - med[i]);
      sum += v; sum2 += v * v;
      if (v >= 235) over += 1;
      if (v <= 15) under += 1;
      const b = bgr[i * 3]; const g = bgr[i * 3 + 1]; const r = bgr[i * 3 + 2];
      bSum += b; gSum += g; rSum += r;
      const mx = Math.max(b, g, r); const mn = Math.min(b, g, r);
      satSum += mx === 0 ? 0 : ((mx - mn) / mx) * 255;
    }
    noiseRaw /= N;
    const meanL = sum / N;
    const std = Math.sqrt(Math.max(0, sum2 / N - meanL * meanL));
    over = over / N * 100; under = under / N * 100;
    const sat = satSum / N;
    const bb = bSum / N; const gg = gSum / N; const rr = rSum / N;
    const cast = (Math.max(rr, gg, bb) - Math.min(rr, gg, bb)) / Math.max((rr + gg + bb) / 3, 1) * 100;

    const box = subjectBox(grayF, w, h);
    const { sub, sw: subW, sh: subH } = extractSub(grayF, w, box);
    const sharpSubRaw = lapBlockTopk(sub, subW, subH, GRID, TOPK);
    const sharpWholeRaw = lapVar(grayF, w, h);
    const cover = box[4];

    const sharpness = logCalibrate(sharpSubRaw, CAL_LO, CAL_HI);
    const sharpWhole = logCalibrate(sharpWholeRaw, CAL_LO, CAL_HI);
    const focusRatio = sharpSubRaw / Math.max(sharpWholeRaw, 1.0);
    const focusScore = focusRatio >= 1.0
      ? clamp(60 + 40 * Math.min(1.0, (focusRatio - 1.0) / 2.0))
      : clamp(60 * focusRatio);
    const focusFail = focusRatio < 0.9 && sharpness < 45;

    let expoScore = 100.0;
    expoScore -= Math.min(60.0, Math.max(0.0, under - 10.0) * 2.5 + Math.max(0.0, over - 10.0) * 2.5);
    if (meanL < 60) expoScore -= (60 - meanL) * 0.5;
    if (meanL > 200) expoScore -= (meanL - 200) * 1.0;
    expoScore = clamp(expoScore);

    const contrastScore = clamp(std / 70.0 * 100);
    const satScore = clamp(sat / 110.0 * 100);
    const castScore = clamp(100 - Math.max(0.0, cast - 18) * 3);
    const noiseScore = clamp(100 - Math.max(0.0, noiseRaw - 2.0) * 15);
    const subjectScore = clamp(cover / 0.45 * 100);

    let invalid = false; let invalidReason = '';
    if (noiseRaw > NOISE_LIMIT) { invalid = true; invalidReason = '噪声图'; }
    else if (sharpSubRaw < FLAT_LIMIT) { invalid = true; invalidReason = '无主体/纯色'; }

    const iso = Number(o.iso) || 0;
    let isoFactor = 1.0;
    if (iso > 800) isoFactor = Math.max(0.5, 1.0 - 0.05 * Math.log2(iso / 800.0));
    const sharpAdj = sharpness * isoFactor;

    let total = sharpAdj * 0.62 + focusScore * 0.08 + expoScore * 0.14
      + contrastScore * 0.06 + satScore * 0.03 + castScore * 0.03 + noiseScore * 0.04;
    if (invalid) total = Math.min(total, 20.0);
    total = clamp(total);

    const tags = [];
    if (invalid) tags.push(invalidReason);
    else if (focusFail) tags.push('疑似失焦');
    else if (sharpness < 35) tags.push('清晰度低');
    if (over > 10) tags.push('过曝');
    if (under > 15) tags.push('欠曝');
    if (meanL < 55) tags.push('偏暗');
    if (meanL > 205) tags.push('偏亮');
    if (std < 25) tags.push('低对比');
    if (cast > 38) tags.push('偏色');
    if (noiseRaw > 6) tags.push('噪点高');
    if (cover < 0.03) tags.push('主体偏小');

    const out = {
      sv: SV,
      sharpness: +sharpness.toFixed(1),
      sharpness_whole: +sharpWhole.toFixed(1),
      sharp_sub_raw: +sharpSubRaw.toFixed(1),
      focus: +focusScore.toFixed(1),
      focus_ratio: +focusRatio.toFixed(2),
      exposure: +expoScore.toFixed(1),
      mean_lum: +meanL.toFixed(1),
      overexp_pct: +over.toFixed(2),
      underexp_pct: +under.toFixed(2),
      contrast: +contrastScore.toFixed(1),
      saturation: +satScore.toFixed(1),
      color_cast: +castScore.toFixed(1),
      noise: +noiseScore.toFixed(1),
      noise_raw: +noiseRaw.toFixed(2),
      subject: +subjectScore.toFixed(1),
      subject_cover: +cover.toFixed(3),
      box: box.slice(0, 4).map((v) => Math.round(v)),
      iso: iso || null,
      iso_factor: +isoFactor.toFixed(3),
      invalid,
      invalid_reason: invalidReason,
      total: +total.toFixed(1),
      tags: tags.join(';'),
      width: o.width || sw,
      height: o.height || sh,
      filesize_kb: o.filesizeKb || 0,
      w,
      h,
    };
    if (o.withHash) out.hash = hashes(gray, w, h);
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 批内百分位定星级（与 app.py batch_star 一致）
   * ------------------------------------------------------------------ */

  /**
   * @param {object} scores  { [filename]: rec }
   * @param {function} exists (filename) => boolean
   * @returns {number} 参与排名的「唯一图」组数
   */
  function batchStar(scores, exists) {
    const items = [];
    for (const [name, rec] of Object.entries(scores)) {
      if (!rec || typeof rec !== 'object') continue;
      if (exists && !exists(name)) continue;
      if (rec.invalid) { rec.star = 0; rec.pct = 0.0; continue; }
      const v = rec.total;
      if (rec.sv !== SV) rec.stale = true;
      else delete rec.stale;
      if (v === undefined || v === null) continue;
      const key = rec.sharp_sub_raw === undefined ? Number(v) : Number(rec.sharp_sub_raw);
      items.push([Number(v), key, rec]);
    }
    items.sort((a, b) => b[0] - a[0]);
    const n = items.length;
    const same = (a, b) => Math.abs(a - b) <= Math.max(0.5, Math.abs(a) * 0.004);

    let m = 0; let i = 0;
    while (i < n) {
      const k0 = items[i][1]; let j = i;
      while (j < n && same(items[j][1], k0)) j += 1;
      m += 1; i = j;
    }
    i = 0;
    let gi = 0;
    while (i < n) {
      const k0 = items[i][1]; let j = i;
      while (j < n && same(items[j][1], k0)) j += 1;
      const pct = m > 1 ? 1.0 - gi / Math.max(m - 1, 1) : 1.0;
      const star = pct >= 0.70 ? 3 : (pct >= 0.45 ? 2 : (pct >= 0.15 ? 1 : 0));
      for (let k = i; k < j; k += 1) {
        const rec = items[k][2];
        rec.pct = +pct.toFixed(3);
        rec.rank_in = gi + 1;
        let st = star;
        if ((rec.overexp_pct || 0) > 10 || (rec.underexp_pct || 0) > 15) {
          st = Math.max(0, st - 1);
          rec.expo_flag = true;
        } else delete rec.expo_flag;
        rec.star = st;
      }
      gi += 1; i = j;
    }
    return m;
  }

  const starText = (s) => '★'.repeat(Math.max(0, s || 0)) + '☆'.repeat(Math.max(0, 3 - (s || 0)));
  const groupIndex = (rec, levels) => {
    const st = rec.star || 0;
    const inv = !!rec.invalid;
    if (levels === 5) return inv ? 4 : ({ 3: 0, 2: 1, 1: 2 }[st] ?? 3);
    return inv ? 2 : ({ 3: 0, 2: 1 }[st] ?? 2);
  };
  const sortValue = (rec) => (rec && rec.final !== undefined && rec.final !== null ? rec.final : rec && rec.total);

  return {
    SV, MAX_SIDE, GRID, TOPK, CAL_LO, CAL_HI, NOISE_LIMIT, FLAT_LIMIT,
    interArea, toGrayBgr, analyze, batchStar,
    hashes, ham, similarPair,
    starText, groupIndex, sortValue,
  };
});
