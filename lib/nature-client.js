'use strict';
/**
 * 自然在线（ecp.ibiodiversity.cn）客户端内核 —— 可独立复用的模块。
 *
 * 本文件不依赖本项目的 server.js / 配置格式，只依赖同目录的 http.js。
 * 另一个项目（如标注工坊）要接入时，只需：
 *
 *   const { createClient } = require('nature-client/lib/xingse');
 *   const xs = createClient({
 *     username: '…', password: '…',
 *     token: 已存的令牌,
 *     save: (s) => { 存 s.token 到自己的配置里 },
 *   });
 *   const albums = await xs.albums();
 *
 * 站点没有公开 API，下面全部是站内私有接口（与站点前端 app.js / 懒加载 chunk 里的一致）：
 *   鉴权      Bearer 令牌，账号密码 + 图形验证码换取；令牌长期复用，失效再登。
 *   相册      /myNature/album/home（列表）· /album/add（新建）· /album/delete/{id}
 *   相册照片  /myNature/album/photo/home（分页）· /album/photo/deletes（删除）
 *   上传      /utils/file/upload/album/photo?albumId=…&fileType=1&timeZone=37&useAI=…
 *             （表单只放 file，其余走 query —— 与站点前端完全一致）
 *   我的文件  /myNature/domain/my/files/page（分页，fileTypes）
 *             /myNature/domain/my/files/download（{ids,nameFields} → zip 二进制）
 *             /myNature/domain/my/files/deletes（[ids]）
 *   图片地址  {filePath}/Thumb/{photoId}.{ext}（缩略图），{filePath}/{fileName}（原图）
 *
 * 站点接口全部要求 origin / referer 指向自己，缺了会 403 或 B0001。
 */

const { request, requestJson, SiteError, DEFAULT_UA } = require('./http');

const DEFAULT_BASE = 'https://ecp.ibiodiversity.cn';

/** 新建相册时站点要求的地址字段（沿用聚合台里验证过的一组） */
const ALBUM_ADDR = {
  countryId: '2013010535',
  country: '中华人民共和国',
  regionID: '2013358038',
  region: '华东',
  provinceId: '2013036373',
  province: '福建省',
  cityId: '2013036374',
  city: '福州市',
  countyID: '2013036375',
  county: '福州市鼓楼区',
};

/** 站点前端默认的上传参数 */
const UPLOAD_DEFAULTS = {
  fileType: 1, // 图片
  timeZone: 37,
  useAI: 0, // 0=不让站方自动识别；1=上传后自动识别
};

/** 批量下载时可选的命名字段（站点前端那套） */
const NAME_FIELDS = ['cname', 'lname', 'author', 'place', 'date', 'fileName'];

function isAuthError(msg, status) {
  return status === 401 || /登录|令牌|token|未授权|授权|失效/i.test(String(msg || ''));
}

function trimBase(u) {
  return String(u || DEFAULT_BASE).replace(/\/+$/, '');
}

function toIdList(ids) {
  return (Array.isArray(ids) ? ids : [ids]).map((x) => String(x == null ? '' : x)).filter(Boolean);
}

class Xingse {
  /**
   * 两种调用方式都支持：
   *
   *   1) 新写法（推荐，跨项目复用）
   *      new Xingse({ baseUrl, username, password, token, save, fetchImpl })
   *        save(snapshot) 在令牌变化时被调用，snapshot = { username, password, token, tokenAt }
   *
   *   2) 旧写法（本项目 server.js 一直在用）
   *      new Xingse(config, persist)   // config.sites.xingse 是活的配置对象，persist() 落盘
   */
  constructor(opts, save) {
    let o = opts || {};
    this._legacy = false;

    if (o.sites && typeof o.sites === 'object') {
      // 旧写法：直接操作外部配置对象
      this._legacy = true;
      if (!o.sites.xingse) o.sites.xingse = {};
      this.site = o.sites.xingse;
      this._save = typeof save === 'function' ? save : () => {};
      this.base = trimBase(o.baseUrl);
    } else {
      this.base = trimBase(o.baseUrl);
      this.site = {
        username: String(o.username || ''),
        password: String(o.password || ''),
        token: String(o.token || ''),
        tokenAt: Number(o.tokenAt || 0),
      };
      this._save = typeof o.save === 'function' ? o.save : () => {};
    }

    this.fetchImpl = typeof o.fetchImpl === 'function' ? o.fetchImpl : null;
    this.timeout = Number(o.timeout) || 180000;
    this.loggedIn = false;
    this.lastError = '';
  }

  /* ---------------- 内部：请求与鉴权 ---------------- */

  get token() {
    return String(this.site.token || '');
  }

  setToken(t) {
    this.site.token = String(t || '');
    this.site.tokenAt = t ? Date.now() : 0;
    this._persist();
  }

  _persist() {
    if (this._legacy) {
      this._save();
    } else {
      this._save({
        username: this.site.username || '',
        password: this.site.password || '',
        token: this.site.token || '',
        tokenAt: this.site.tokenAt || 0,
      });
    }
  }

  headers(tk) {
    const h = {
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      origin: this.base,
      referer: this.base + '/myNature',
      'user-agent': DEFAULT_UA,
    };
    if (tk) h.authorization = 'Bearer ' + tk;
    return h;
  }

  /** 底层 JSON 请求；code !== 00000 抛 SiteError。token 传 '' 表示匿名请求。 */
  async api(pathname, { method = 'POST', body, token, form = false, timeout, params } = {}) {
    const tk = token === undefined ? this.token : token;
    const headers = this.headers(tk);
    let payload;
    if (body !== undefined) {
      if (form) {
        payload = body; // FormData：交给 fetch 自己带 boundary
      } else {
        headers['content-type'] = 'application/json;charset=UTF-8';
        payload = JSON.stringify(body);
      }
    }
    const url = new URL(this.base + pathname);
    if (params) {
      for (const k of Object.keys(params)) {
        if (params[k] != null && params[k] !== '') url.searchParams.set(k, String(params[k]));
      }
    }
    const { res, json } = await requestJson(url.toString(), {
      method,
      headers,
      body: payload,
      timeout: timeout || this.timeout,
      fetchImpl: this.fetchImpl || undefined,
    });
    if (!json) {
      throw new SiteError(`自然在线接口未返回 JSON（HTTP ${res.status}）`, { status: res.status });
    }
    const ok = json.code === '00000' || json.code === 0 || json.code === '0';
    if (!ok) {
      const msg = String(json.msg || '');
      if (isAuthError(msg, res.status)) {
        this.loggedIn = false;
        this.lastError = '登录已过期';
        throw new SiteError('自然在线登录已过期，请重新输入验证码登录', { status: 401 });
      }
      throw new SiteError(msg || '自然在线接口报错', { status: res.status, code: json.code });
    }
    return json;
  }

  /* ---------------- 登录 ---------------- */

  /** 取一张图形验证码：{ key, image(dataURL) } */
  async captcha() {
    const j = await this.api('/api/online/authentication/getCaptcha', { method: 'GET', token: '' });
    const d = j.data || {};
    if (!d.captcha || !d.key) throw new SiteError(j.msg || '验证码获取失败');
    return { key: d.key, image: d.captcha };
  }

  /** 账号密码 + 人工看出的验证码 → 令牌 */
  /** 用户在登录框里填的账号密码，运行时替换（新版本种子不再带自然在线账号，登录全靠用户自己填） */
  setCredentials(username, password) {
    this.site.username = String(username || '').trim();
    this.site.password = String(password || '');
  }

  async login(captcha, key) {
    const s = this.site;
    if (!s.username || !s.password) throw new SiteError('没有配置自然在线账号密码');
    if (!captcha || !key) throw new SiteError('请先获取并填写验证码');
    const j = await this.api('/api/online/authentication/login', {
      method: 'POST',
      token: '',
      body: { userName: s.username, password: s.password, captcha: String(captcha).trim(), key },
    });
    const d = j.data || {};
    const t = typeof d === 'string' ? d : d.token || d.accessToken;
    if (!t) throw new SiteError(j.msg || '登录失败（没有拿到令牌）');
    this.setToken(t);
    this.loggedIn = true;
    this.lastError = '';
    return true;
  }

  /** 令牌是否还能用（顺带拿用户名） */
  async check() {
    if (!this.token) {
      this.loggedIn = false;
      return { ok: false, reason: '未登录' };
    }
    try {
      const j = await this.api('/api/online/user/info', { method: 'GET' });
      this.loggedIn = true;
      this.lastError = '';
      const u = j.data || {};
      return {
        ok: true,
        username: u.userName || u.username || u.nickName || u.name || this.site.username,
        nickName: u.nickName || '',
      };
    } catch (err) {
      this.loggedIn = false;
      this.lastError = err.message || String(err);
      return { ok: false, reason: this.lastError };
    }
  }

  logout() {
    this.setToken('');
    this.loggedIn = false;
  }

  /* ---------------- 相册 ---------------- */

  /** 拉全部相册（按页聚合成一个数组） */
  async albums({ maxPages = 50, pageSize = 100 } = {}) {
    const all = [];
    for (let pageNum = 1; pageNum <= maxPages; pageNum += 1) {
      const j = await this.api('/api/online/myNature/album/home', {
        body: { pageNum, pageSize, keyWords: '' },
      });
      const pg = (j.data && j.data.albumPage) || {};
      const recs = pg.records || [];
      all.push(...recs);
      const total = Number(pg.total) || all.length;
      if (!recs.length || all.length >= total) break;
    }
    return all.map(mapAlbum).filter((a) => a.id);
  }

  /** 只取一页（相册很多时用） */
  async albumsPage(pageNum = 1, pageSize = 30) {
    const j = await this.api('/api/online/myNature/album/home', {
      body: { pageNum, pageSize, keyWords: '' },
    });
    const pg = (j.data && j.data.albumPage) || {};
    const recs = (pg.records || []).map(mapAlbum).filter((a) => a.id);
    return { total: Number(pg.total || recs.length), records: recs };
  }

  /** 新建相册 → 返回相册 id */
  async addAlbum({ title, description = '', useAI = 2, shareMode = 0, addr = null } = {}) {
    const t = String(title || '').trim();
    if (!t) throw new SiteError('请填写相册名称');
    const j = await this.api('/api/online/myNature/album/add', {
      body: {
        title: t,
        description: String(description || ''),
        shareMode: Number(shareMode) || 0,
        useAI,
        ...ALBUM_ADDR,
        ...(addr || {}),
        cultivated: 0,
        specimensDeposition: 0,
      },
    });
    const id = typeof j.data === 'string' ? j.data : j.data && (j.data.id || j.data.albumId);
    if (!id) throw new SiteError('新建相册成功但没拿到相册 id');
    return String(id);
  }

  /** 有同名相册就复用，没有就建 —— 便于批处理时「传到一个固定相册」 */
  async ensureAlbum(title, opt = {}) {
    const t = String(title || '').trim();
    if (!t) throw new SiteError('请填写相册名称');
    const list = await this.albums();
    const hit = list.find((a) => a.title === t);
    if (hit) return { id: hit.id, created: false, album: hit };
    const id = await this.addAlbum({ ...opt, title: t });
    return { id, created: true, album: { id, title: t } };
  }

  async deleteAlbum(id) {
    if (!id) throw new SiteError('缺少相册 id');
    await this.api('/api/online/myNature/album/delete/' + encodeURIComponent(id), { method: 'GET' });
    return true;
  }

  /* ---------------- 相册里的照片 ---------------- */

  /**
   * 相册照片分页 → { total, records, album }
   *
   * 注意：真站这里要的字段名是 **id**（不是 albumId），传 albumId 会报 A0400「相册ID不能为空」。
   * 已用真站验证（2026-11-04）：body `{id,pageNum,pageSize}` → data.photoPage{total,records}，
   * 同时 data.albumInfo 里带相册元信息（地点、张数、创建日）。
   */
  async albumPhotos(albumId, pageNum = 1, pageSize = 60) {
    if (!albumId) throw new SiteError('缺少相册 id');
    const j = await this.api('/api/online/myNature/album/photo/home', {
      body: { id: String(albumId), pageNum, pageSize: pageSize || 60 },
    });
    const d = j.data || {};
    const pg = d.photoPage || {};
    const recs = (pg.records || []).map((p) => this._photo(p));
    return {
      total: Number(pg.total || recs.length),
      records: recs,
      album: d.albumInfo ? mapAlbum(d.albumInfo) : null,
    };
  }

  _photo(p) {
    const photoId = String(p.photoId || p.id || '');
    // 真站给的是 imageUrl 一个相对目录（如 Data/2025/202501/20250110），不是 filePath
    const dir = String(p.imageUrl || p.filePath || '');
    const fileName = String(p.fileName || p.name || '');
    return {
      photoId,
      fileName,
      filePath: dir,
      thumb: this.derivativeUrl(dir, photoId, fileName, 'Thumb'),
      full: this.derivativeUrl(dir, photoId, fileName, 'Norm'),
      original: this.originalUrl(dir, fileName),
      cname: String(p.cname || '').trim(),
      lname: String(p.lname || p.scientificName || '').trim(),
      place: String(p.place || p.location || p.address || '').trim(),
      date: String(p.date || p.takeTime || p.createTime || '').slice(0, 10),
      albumId: String(p.albumId || ''),
      size: Number(p.fileSize || p.size || 0),
      author: String(p.author || '').trim(),
      gps:
        p.longitude != null && p.latitude != null && p.hasGPSInfo
          ? { lng: Number(p.longitude), lat: Number(p.latitude) }
          : null,
    };
  }

  /** 把某个相册的照片全部翻完 */
  async albumPhotosAll(albumId, { pageSize = 60, maxPages = 200, onPage } = {}) {
    const all = [];
    for (let pageNum = 1; pageNum <= maxPages; pageNum += 1) {
      const r = await this.albumPhotos(albumId, pageNum, pageSize);
      all.push(...r.records);
      if (typeof onPage === 'function') onPage(r, pageNum, all.length);
      if (!r.records.length || all.length >= r.total) break;
    }
    return all;
  }

  /* ---------------- 上传 ---------------- */

  /** 上传一张（Buffer 或 Uint8Array）到指定相册 → photoId */
  async upload(albumId, buffer, filename, opt = {}) {
    if (!albumId) throw new SiteError('请先选择目标相册');
    if (!buffer || !buffer.length) throw new SiteError('空文件');
    const qs = new URLSearchParams({
      albumId: String(albumId),
      fileType: String(opt.fileType != null ? opt.fileType : UPLOAD_DEFAULTS.fileType),
      timeZone: String(opt.timeZone != null ? opt.timeZone : UPLOAD_DEFAULTS.timeZone),
      useAI: String(opt.useAI != null ? opt.useAI : UPLOAD_DEFAULTS.useAI),
      author: String(opt.author || ''),
    });
    const fd = new FormData();
    const name = String(filename || 'photo.jpg');
    fd.append('file', new Blob([buffer]), name);
    const j = await this.api('/api/online/utils/file/upload/album/photo?' + qs.toString(), {
      body: fd,
      form: true,
      timeout: Number(opt.timeout) || 300000,
    });
    const d = j.data;
    const photoId = typeof d === 'string' ? d : d && (d.photoId || d.id);
    return String(photoId || '');
  }

  /** 上传本地文件（标注工坊里最常用） */
  async uploadFile(albumId, localPath, opt = {}) {
    const fs = require('node:fs');
    const path = require('node:path');
    const buf = fs.readFileSync(localPath);
    const name = opt.filename || path.basename(localPath);
    return this.upload(albumId, buf, name, opt);
  }

  /** 批量上传本地文件，串行 + 可回调进度；单张失败不中断 */
  async uploadFiles(albumId, files, { onProgress, ...opt } = {}) {
    const list = (files || []).slice();
    const out = { ok: 0, failed: [], photoIds: [] };
    await this.uploadBegin();
    for (let i = 0; i < list.length; i += 1) {
      const f = list[i];
      try {
        const id = await this.uploadFile(albumId, typeof f === 'string' ? f : f.path, {
          ...opt,
          filename: typeof f === 'string' ? undefined : f.name || opt.filename,
        });
        out.ok += 1;
        if (id) out.photoIds.push(id);
      } catch (err) {
        out.failed.push({ file: typeof f === 'string' ? f : f.path, error: err.message || String(err) });
      }
      if (typeof onProgress === 'function') onProgress(i + 1, list.length, out);
      await new Promise((r) => setImmediate(r)); // 让出事件循环，前端能读到进度
    }
    await this.uploadEnd();
    return out;
  }

  async uploadBegin() {
    try {
      await this.api('/api/online/myNature/album/photo/uploadBatch/begin', {});
    } catch {
      /* 站点前端也说可以忽略 */
    }
  }

  async uploadEnd() {
    try {
      await this.api('/api/online/myNature/album/photo/uploadBatch/end', {});
    } catch {
      /* 同上 */
    }
  }

  /* ---------------- 删除相册照片 ---------------- */

  async deletePhotos(ids) {
    const list = toIdList(ids);
    if (!list.length) throw new SiteError('没有选中照片');
    await this.api('/api/online/myNature/album/photo/deletes', { body: list });
    return list.length;
  }

  /* ---------------- 我的文件（全部图片） ---------------- */

  /**
   * 分页列出账号里的文件；fileTypes 默认只图片。
   *
   * ⚠️ 真站实测（2026-11-04）：
   *   · 返回的 `total` 不是本账号的数量（会给到两千万级，像是全站口径），**不能用来算页数**；
   *     判断是否到底请用「本页是否满」或「本页条数」。
   *   · 记录里**没有图片路径**（只有 id / fileName / albumName / takeTime …），所以缩略图为空，
   *     要么只做列表，要么按 id 走下载接口拿图。
   *   · 单页查询偏慢（2 条约 6 秒，冷启动更久），pageSize 别开太大。
   */
  async files({ pageNum = 1, pageSize = 60, keyword = '', fileTypes = ['Image'] } = {}) {
    const j = await this.api('/api/online/myNature/domain/my/files/page', {
      body: { pageNum, pageSize, fileTypes, keyword },
      timeout: 300000,
    });
    const d = j.data || {};
    const raw = d.list || d.records || [];
    const list = raw.map((f) => {
      const id = String(f.id || f.photoId || '');
      const filePath = String(f.imageUrl || f.filePath || '');
      const fileName = String(f.fileName || '');
      return {
        id,
        photoId: id,
        fileName,
        filePath,
        fileType: String(f.fileType || ''),
        cname: String(f.cname || '').trim(),
        lname: String(f.lname || '').trim(),
        albumName: String(f.albumName || '').trim(),
        place: String(f.place || f.location || '').trim(),
        date: String(f.takeTime || f.uploadTime || f.date || f.createTime || '').slice(0, 10),
        size: Number(f.fileSize || f.size || 0),
        // 站点这条接口不给图片路径，只有拿到路径的才拼缩略图
        thumb: filePath ? this.derivativeUrl(filePath, id, fileName, 'Thumb') : '',
        // 原图地址（{filePath}/{fileName}），下载原图用
        original: filePath ? this.originalUrl(filePath, fileName) : '',
      };
    });
    return {
      total: Number(d.total || 0), // 站点口径偏大，仅供参考
      records: list,
      pageNum: Number(pageNum) || 1,
      /** 本页是否已到底（站点 total 不可信，用它判断） */
      reachedEnd: raw.length < Number(pageSize || 60),
    };
  }

  /** 批量下载 → zip 的二进制（Buffer） */
  async downloadFiles(ids, nameFields = NAME_FIELDS) {
    const list = toIdList(ids);
    if (!list.length) throw new SiteError('没有选中文件');
    const res = await request(this.base + '/api/online/myNature/domain/my/files/download', {
      method: 'POST',
      headers: { ...this.headers(this.token), 'content-type': 'application/json;charset=UTF-8' },
      body: JSON.stringify({ ids: list, nameFields: nameFields || NAME_FIELDS }),
      timeout: 300000,
      fetchImpl: this.fetchImpl || undefined,
    });
    if (!res.ok) {
      let msg = `下载失败（HTTP ${res.status}）`;
      try {
        const j = JSON.parse(await res.text());
        msg = j.msg || msg;
      } catch {
        /* 二进制或空体 */
      }
      if (isAuthError(msg, res.status)) throw new SiteError('登录已过期，请重新登录', { status: 401 });
      throw new SiteError(msg, { status: res.status });
    }
    return {
      buffer: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get('content-type') || 'application/zip',
    };
  }

  /** 批量下载并直接落盘，返回文件路径 */
  async downloadTo(ids, destPath, nameFields) {
    const fs = require('node:fs');
    const path = require('node:path');
    const { buffer } = await this.downloadFiles(ids, nameFields);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, buffer);
    return { path: destPath, bytes: buffer.length };
  }

  async deleteFiles(ids) {
    const list = toIdList(ids);
    if (!list.length) throw new SiteError('没有选中文件');
    await this.api('/api/online/myNature/domain/my/files/deletes', { body: list });
    return list.length;
  }

  /* ---------------- 鉴定（重新鉴定） ---------------- */

  /**
   * 按关键词在站点分类库（NameTree）里检索候选物种，用于把「名字」解析成站点要求的 NameID。
   *   GET /api/online/nametree/taxa?keyword=<kw>&limit=<n>
   * 返回数组，每项含 { nameId, nameZh, spName, levelName, photoCount }。
   * ⚠️ 这是 GET + query（不是 POST body），和站点其它接口不同，已用真站验证（2026-11-04）。
   */
  async searchTaxa(keyword, limit = 20) {
    const kw = String(keyword || '').trim();
    if (!kw) return [];
    const j = await this.api('/api/online/nametree/taxa', {
      method: 'GET',
      params: { keyword: kw, limit: Number(limit) || 20 },
    });
    return Array.isArray(j.data) ? j.data : [];
  }

  /**
   * 在候选里挑一个最贴近给定中文名/学名的 NameID。
   * 优先级：学名精确 > 中文名精确 > 学名前缀 > 首个。
   */
  pickTaxon(taxa, { chinese = '', latin = '' } = {}) {
    const list = Array.isArray(taxa) ? taxa : [];
    if (!list.length) return null;
    const zh = String(chinese || '').trim();
    const la = String(latin || '').trim().toLowerCase();
    const byZh = zh && list.find((t) => String(t.nameZh || '').trim() === zh);
    if (byZh) return byZh;
    const byLa = la && list.find((t) => String(t.spName || '').trim().toLowerCase() === la);
    if (byLa) return byLa;
    const byLaPrefix = la && list.find((t) => String(t.spName || '').trim().toLowerCase().startsWith(la));
    if (byLaPrefix) return byLaPrefix;
    return list[0];
  }

  /**
   * 重新鉴定（submit identification）：把命名结果写回自然在线，**不动原图**。
   *   POST /api/online/myNature/album/photo/identify/submit
   *   body: { nameChinese, nameLatin, ids:[photoId…], id:<nameId>, type, signature, description, itemID }
   * ids 可传单张或多张（批量同一鉴定）。等价于站点里「对文件重新鉴定一次」。
   */
  /**
   * 批量把照片**移动**到另一个相册（不是复制、不是重传）。
   *   POST /api/online/myNature/album/photo/move  body: { albumId, ids:[photoId...] }
   * 站点前端的「选择调查 → 移动」就是走这里，photoId 和鉴定记录都不变。
   * 非本人上传的照片站点会自己跳过。
   */
  async movePhotos(albumId, ids) {
    const list = toIdList(ids);
    if (!list.length) throw new SiteError('没有选中照片');
    const target = String(albumId || '').trim();
    if (!target) throw new SiteError('没有选择目标相册');
    return this.api('/api/online/myNature/album/photo/move', {
      method: 'POST',
      body: { albumId: target, ids: list },
    });
  }

  async reidentify(opt = {}) {
    const ids = toIdList(opt.ids);
    if (!ids.length) throw new SiteError('没有选中照片');
    const nameId = String(opt.nameId || '').trim();
    if (!nameId) throw new SiteError('缺少鉴定 ID（NameID）');
    const body = {
      nameChinese: String(opt.nameChinese || ''),
      nameLatin: String(opt.nameLatin || ''),
      signature: String(opt.signature || ''),
      description: String(opt.description || ''),
      type: Number(opt.type || 1), // 1=正常鉴定 2=临时鉴定
      ids,
      id: nameId,
      itemID: '',
    };
    const j = await this.api('/api/online/myNature/album/photo/identify/submit', { method: 'POST', body });
    return j;
  }

  /* ---------------- 图片地址 ---------------- */

  /**
   * 把 filePath 解析成可访问的绝对地址。
   * 站点规则（app.js getFullPath）：带 http 原样用；以 / 开头拼 baseUrl；否则拼 baseUrl + '/'。
   */
  resolve(filePath) {
    const p = String(filePath || '').trim();
    if (!p) return '';
    if (/^https?:/i.test(p)) return p;
    if (p.startsWith('/')) return this.base + p;
    return this.base + '/' + p;
  }

  /** 派生图地址：{filePath}/Thumb|Norm/{photoId}.{ext} */
  derivativeUrl(filePath, photoId, fileName, kind = 'Thumb') {
    if (!filePath || !photoId) return '';
    const base = this.resolve(filePath).replace(/\/+$/, '');
    return `${base}/${kind}/${photoId}.${this._ext(fileName)}`;
  }

  _ext(fileName) {
    const n = String(fileName || '');
    const i = n.lastIndexOf('.');
    let ext = i > 0 ? n.slice(i + 1) : 'jpg';
    if (/^(heic|heif)$/i.test(ext)) ext = 'JPG';
    else if (!/^(jpe?g|png|gif|bmp|webp|tiff?)$/i.test(ext)) ext = 'jpg';
    return ext;
  }

  /** 原图地址：{filePath}/{fileName} */
  originalUrl(filePath, fileName) {
    if (!filePath || !fileName) return '';
    return this.resolve(filePath).replace(/\/+$/, '') + '/' + encodeURIComponent(fileName);
  }
}

function mapAlbum(a) {
  const share = a.shareMode;
  const isPublic = typeof share === 'string' ? /public|1/i.test(share) && share !== '0' : Number(share || 0) > 0;
  return {
    id: String(a.id || ''),
    title: String(a.title || '').trim() || '（未命名相册）',
    description: String(a.description || '').trim(),
    count: Number(a.photoCount || a.count || 0),
    cover: a.imageUrl || a.coverUrl || a.faceFile || '',
    place: String(a.place || '').trim(),
    province: String(a.province || '').trim(),
    city: String(a.city || '').trim(),
    useAI: Number(a.useAI || 0),
    updated: String(a.updateTime || a.createTime || a.createDay || '').slice(0, 19).replace('T', ' '),
    isPublic,
  };
}

/**
 * 统一入口（跨项目复用请用这个）：
 *   createClient({ baseUrl, username, password, token, save, fetchImpl })
 */
function createClient(opts = {}) {
  return new Xingse(opts);
}

module.exports = {
  Xingse,
  createClient,
  SiteError,
  BASE: DEFAULT_BASE,
  ALBUM_ADDR,
  UPLOAD_DEFAULTS,
  NAME_FIELDS,
};
