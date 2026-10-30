'use strict';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 极简 cookie 容器：一个站点一个，整包发给该站点所有请求 */
class Jar {
  constructor(entries = []) {
    this.cookies = new Map(entries);
  }

  absorb(res) {
    const list =
      typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const line of list) {
      const parts = line.split(';');
      const pair = parts[0] || '';
      const idx = pair.indexOf('=');
      if (idx <= 0) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      let dead = false;
      for (const attr of parts.slice(1)) {
        const [k, ...v] = attr.split('=');
        const key = k.trim().toLowerCase();
        if (key === 'max-age') {
          const s = Number(v.join('='));
          if (Number.isFinite(s) && s <= 0) dead = true;
        }
        if (key === 'expires') {
          const t = Date.parse(v.join('='));
          if (!Number.isNaN(t) && t < Date.now()) dead = true;
        }
      }
      if (dead) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  clear() {
    this.cookies.clear();
  }

  size() {
    return this.cookies.size;
  }

  toJSON() {
    return [...this.cookies];
  }
}

/** 带 UA / cookie / 超时的 fetch */
async function request(url, opts = {}) {
  const { jar, timeout = 90000, headers = {}, ...rest } = opts;
  const h = {
    'user-agent': DEFAULT_UA,
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    ...headers,
  };
  if (jar) {
    const cookie = jar.header();
    if (cookie) h.cookie = cookie;
  }
  const res = await fetch(url, { ...rest, headers: h, signal: AbortSignal.timeout(timeout) });
  if (jar) jar.absorb(res);
  return res;
}

async function requestJson(url, opts = {}) {
  const res = await request(url, opts);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { res, text, json };
}

class SiteError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'SiteError';
    Object.assign(this, extra);
  }
}

module.exports = { Jar, request, requestJson, SiteError, DEFAULT_UA };
