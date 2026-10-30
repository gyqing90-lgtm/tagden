'use strict';
/* 物种标注工坊 —— 前端 */

const $ = (id) => document.getElementById(id);
const enc = encodeURIComponent;

const S = {
  state: null,
  dir: '',
  files: [],
  dirs: [], // 当前目录的子文件夹，和图片一起铺在中间
  parent: null, // 上一级路径（服务端给的，比字符串截断可靠）
  filter: 'all',
  sel: new Set(),
  active: null,
  results: new Map(), // path -> 识别结果
  labels: new Map(), // path -> 已写入的标签
  pending: new Set(), // path -> 标签还没读出来（大文件夹后台补读中）
  byPath: new Map(), // path -> 文件对象，补读标签时别用数组 find 扫 2000 次
  byName: new Map(), // 文件名 -> 文件对象，补读接口只回名字
  els: new Map(), // path -> 卡片 DOM，改一张只动一张
  scanGen: 0,
  scanDone: 0,
  meta: new Map(), // path -> 图片里现有的完整标签（含原始文件名），重命名预览用
  busy: new Set(),
  queue: 0,
  // 重命名偏好：order=物种名在前/在后，pick=用中文名/学名/两个都要
  opt: { rename: false, order: 'first', pick: 'cn', archive: false },
};

/* ---------------- 基础 ---------------- */

function toast(msg, ms = 2200) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('on'), ms);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const json = await res.json().catch(() => ({ ok: false, error: '返回的不是 JSON' }));
  if (!res.ok || json.ok === false) {
    const err = new Error(json.error || `HTTP ${res.status}`);
    err.status = res.status;
    // 错误里带的信息有时是要拿来继续做工的（比如聚合台没装时附的下载直链），别丢
    err.payload = json;
    throw err;
  }
  return json;
}

const post = (path, body) =>
  api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** 路径太长时只留盘符和最后两级，中间省略 */
function shortenPath(p) {
  if (p.length <= 46) return p;
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  if (parts.length <= 3) return p;
  return `${parts[0]}\\…\\${parts.slice(-2).join('\\')}`;
}

const kb = (n) => (n == null ? '—' : n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

/* ---------------- 文件名（和服务端 server.js 同一套规则，这里只用于预览） ---------------- */

function safeName(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 80);
}

function speciesLabel(cn, latin, pick) {
  const c = safeName(cn);
  const l = safeName(latin);
  if (pick === 'latin') return l || c;
  if (pick === 'both') return c && l ? `${c}_${l}` : c || l;
  return c || l;
}

/**
 * first = 物种名_原名，last = 原名_物种名。和服务端同一套规则：
 * labels 传多个（当前名 + 上次写过的旧名），先把它们剥干净再造，避免层层叠加。
 */
function buildName(base, labels, order) {
  const list = [...new Set((Array.isArray(labels) ? labels : [labels]).map(safeName).filter(Boolean))];
  if (!list.length) return base;
  const primary = list[0];
  if (base === primary) return primary;
  let stem = base;
  for (let round = 0; round < 4; round += 1) {
    let changed = false;
    for (const lab of list) {
      const pref = `${lab}_`;
      const suf = `_${lab}`;
      if (stem.startsWith(pref)) {
        stem = stem.slice(pref.length);
        changed = true;
      } else if (stem.endsWith(suf)) {
        stem = stem.slice(0, -suf.length);
        changed = true;
      }
    }
    if (!changed) break;
  }
  if (!stem) stem = base;
  return order === 'last' ? `${stem}_${primary}` : `${primary}_${stem}`;
}

function splitName(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? { base: name.slice(0, dot), ext: name.slice(dot) } : { base: name, ext: '' };
}

/** 面板里实时显示「改完叫什么」，省得写完才发现顺序不对 */
function updateRenamePreview() {
  const el = $('renamePrev');
  if (!el) return;
  const p = S.active;
  const f = p ? S.files.find((x) => x.path === p) : null;
  if (!f) {
    el.textContent = '—';
    return;
  }
  const meta = S.meta.get(p) || {};
  // 以「最初的名字」为基准，和写入时的算法一致，预览才可信
  const orig = meta.origName || f.name;
  const { base } = splitName(orig);
  const { ext } = splitName(f.name);
  const prevLatin = (meta.keywords || []).find((k) => k && k !== meta.title) || '';
  const label = speciesLabel($('inCn').value, $('inLatin').value, S.opt.pick);
  el.textContent = label ? `${buildName(base, [label, meta.title, prevLatin], S.opt.order)}${ext}` : '先选候选或填物种名';
}

/* ---------------- 启动 ---------------- */

async function boot() {
  try {
    S.state = await api('/api/state');
  } catch (err) {
    document.body.innerHTML = `<div style="padding:40px;font:14px/1.7 'Microsoft YaHei'">连不上本机服务：${err.message}<br>请在项目目录里运行 <code>node server.js</code></div>`;
    return;
  }
  renderPresets();
  renderChips();
  renderPlaces();
  applyUiOptions(S.state.ui);
  $('pathInput').value = S.state.lastDir || '';

  $('chkRename').onchange = () => {
    S.opt.rename = $('chkRename').checked;
    $('renameOpts').hidden = !S.opt.rename;
    updateRenamePreview();
    post('/api/config', { rename: S.opt.rename }).catch(() => {});
  };
  $('chkArchive').onchange = () => {
    S.opt.archive = $('chkArchive').checked;
    post('/api/config', { archive: S.opt.archive }).catch(() => {});
    toast(S.opt.archive ? '写入后会归档到「物种名」文件夹' : '已关闭自动归档');
  };
  bindRenameSegs();
  bindEngineChips();
  bindAuthor();
  bindUpdate();
  bindHubHelp();
  $('hubBtn').onclick = openInHub;

  bindToolbar();
  bindTree();
  loadTree();
  await loadDir(S.state.lastDir || S.state.places[0]?.path);
}

/** 把保存过的偏好刷到界面上 */
function applyUiOptions(ui) {
  S.opt.archive = !!ui.archive;
  $('chkArchive').checked = S.opt.archive;
  S.opt.rename = !!ui.rename;
  S.opt.order = ui.renameOrder === 'last' ? 'last' : 'first';
  S.opt.pick = ['cn', 'latin', 'both'].includes(ui.renamePick) ? ui.renamePick : 'cn';
  $('chkRename').checked = S.opt.rename;
  $('renameOpts').hidden = !S.opt.rename;
  syncSeg('segOrder', S.opt.order);
  syncSeg('segPick', S.opt.pick);
  updateRenamePreview();
}

function syncSeg(id, value) {
  const box = $(id);
  if (!box) return;
  [...box.children].forEach((b) => b.classList.toggle('on', b.dataset.v === value));
}

function bindRenameSegs() {
  $('segOrder').onclick = (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    S.opt.order = b.dataset.v;
    syncSeg('segOrder', S.opt.order);
    updateRenamePreview();
    post('/api/config', { renameOrder: S.opt.order }).catch(() => {});
  };
  $('segPick').onclick = (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    S.opt.pick = b.dataset.v;
    syncSeg('segPick', S.opt.pick);
    updateRenamePreview();
    post('/api/config', { renamePick: S.opt.pick }).catch(() => {});
  };
  // 手打中文名/学名时预览也要跟着变；顺便把「写入」按钮放开，
  // 否则纯手填的用户会看到一个永远灰着的按钮
  ['inCn', 'inLatin'].forEach((id) =>
    $(id)?.addEventListener('input', () => {
      $('writeBtn').disabled = !($('inCn').value.trim() || $('inLatin').value.trim());
      updateRenamePreview();
    }),
  );
}

function renderPresets() {
  const sel = $('presetSel');
  sel.innerHTML = S.state.presets
    .map((p) => `<option value="${p.key}"${p.key === S.state.ui.preset ? ' selected' : ''}>${p.name}</option>`)
    .join('');
  const cur = S.state.presets.find((p) => p.key === S.state.ui.preset) || S.state.presets[0];
  $('presetHint').textContent = cur ? cur.hint : '';
  sel.onchange = async () => {
    try {
      S.state = await post('/api/config', { preset: sel.value });
      const p = S.state.presets.find((x) => x.key === sel.value);
      $('presetHint').textContent = p ? p.hint : '';
      renderChips();
    } catch (err) {
      toast(err.message);
    }
  };
}

/**
 * 顶部那排小开关：这次用哪几个模型识别。
 *
 * 默认按方案的名单全开（豆包除外，它默认关），点一下关、再点一下开，
 * 开关按方案各存一份——换到植物再换回昆虫，还是你上次那套。
 */
function renderChips() {
  const cur = S.state.current;
  // 老服务端没有 available，退化成「只看已选中的」
  const avail = cur.available || (cur.sources || []).map((k) => ({ key: k, on: true, ready: true }));
  const on = new Set(cur.sources || []);
  const parts = avail.map((a) => {
    const m = S.state.siteMeta.find((x) => x.key === a.key) || {};
    const name = m.name || a.key;
    if (!a.ready) {
      return `<button class="chip na" data-site="${a.key}" disabled title="${esc(name)}：还没填账号或密钥，暂时问不了">${esc(name)}</button>`;
    }
    const isOn = on.has(a.key);
    const tip = `${name}${m.note ? '｜' + m.note : ''}｜点一下${isOn ? '关掉' : '打开'}`;
    return `<button class="chip ${isOn ? 'on' : 'off'}" data-site="${a.key}" aria-pressed="${isOn}" title="${esc(tip)}">${esc(name)}</button>`;
  });
  parts.push(`<span class="chip count" title="当前参与识别的模型数量">共 ${on.size} 站</span>`);
  $('engineChips').innerHTML = parts.join('');
}

function bindEngineChips() {
  $('engineChips').onclick = async (e) => {
    const b = e.target.closest('button.chip[data-site]');
    if (!b || b.disabled) return;
    const cur = S.state.current;
    const picked = new Set(cur.requested || cur.sources || []);
    const key = b.dataset.site;
    if (picked.has(key)) {
      // 全关掉就没人认了，服务端也会悄悄退回默认值——不如在这里拦下
      if ((cur.sources || []).length <= 1) return toast('至少留一个模型，全关掉就没人认了', { ms: 2400 });
      picked.delete(key);
    } else {
      picked.add(key);
    }
    try {
      S.state = await post('/api/config', { picks: [...picked] });
      renderChips();
      toast(`这次用 ${S.state.current.sources.length} 个模型识别`, { ms: 1500 });
    } catch (err) {
      toast(err.message);
    }
  };
}

function renderPlaces() {
  // 盘符已经在下面的树里了，这里只留系统快捷入口，省得占两行
  const quick = S.state.places.filter((p) => !/^[A-Za-z]:\\$/.test(p.path));
  $('places').innerHTML = quick.map((p) => `<button data-p="${esc(p.path)}">${esc(p.label)}</button>`).join('');
  $('places').onclick = (e) => {
    const b = e.target.closest('button');
    if (b) loadDir(b.dataset.p);
  };
}

/* ---------------- 左侧文件夹树 ---------------- */

/**
 * 树的状态。
 *
 * 和「点一下就把左边换成这个文件夹的子目录」不同，这里树是一直在的：
 * 展开/折叠只影响树，中间那块才是这个文件夹的内容。这样翻到很深的目录
 * 也能一眼看到自己在整台机器的哪个位置。
 */
const T = {
  drives: [], // 根：C:\ D:\ E:\ …
  kids: new Map(), // path -> [子文件夹]，读过就记住，反复折叠不重复请求
  open: new Set(), // 展开了的路径
  loading: new Set(),
  errs: new Map(), // path -> 打不开的原因（权限/已拔出）
  sel: '', // 当前正在看的目录
};

/** 统一成「E:\a\b」：盘符大写、反斜杠，免得同一个文件夹因为大小写不同变成两个节点 */
function normPath(p) {
  let s = String(p || '').replace(/\//g, '\\');
  if (/^[a-z]:/i.test(s)) s = s[0].toUpperCase() + s.slice(1);
  return s;
}

const ICON_DRIVE =
  '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><rect x="1.5" y="4" width="13" height="8" rx="1.6" fill="#cfd8d1"/><circle cx="11.4" cy="8" r="1.1" fill="#7e8d83"/></svg>';
const iconFolder = (open) =>
  open
    ? '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M1.6 4.3a1 1 0 0 1 1-1h3.1l1.3 1.5h5.4a1 1 0 0 1 1 1v.9H3.5z" fill="#dfae5c"/><path d="M1.6 6.2h13l-1.4 5.9a1 1 0 0 1-1 .8H2.9a1 1 0 0 1-1-.8z" fill="#f2c877"/></svg>'
    : '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M1.6 4.3a1 1 0 0 1 1-1h3.1l1.3 1.5h5.4a1 1 0 0 1 1 1v6.3a1 1 0 0 1-1 1H2.6a1 1 0 0 1-1-1z" fill="#eabf6c"/></svg>';

/** 读一层子文件夹。同一个路径只请求一次，折叠再展开不会重新读盘 */
async function treeKids(p) {
  const key = normPath(p);
  if (T.kids.has(key)) return T.kids.get(key);
  if (T.loading.has(key)) return null;
  T.loading.add(key);
  renderTree();
  try {
    const r = await api(`/api/dirs?path=${enc(key)}`);
    T.kids.set(key, r.dirs);
    T.errs.delete(key);
  } catch (err) {
    T.kids.set(key, []);
    T.errs.set(key, err.message);
  } finally {
    T.loading.delete(key);
    // 数据到了要自己重绘一次：renderTree 里的自动补读是「发起后不管」的，
    // 少了这一句，节点会一直停在「读取中…」
    renderTree();
  }
  return T.kids.get(key);
}

function treeNodeHtml(d, depth) {
  const key = normPath(d.path);
  const open = T.open.has(key);
  const kids = T.kids.get(key);
  const known = kids !== undefined;
  const leaf = known && kids.length === 0;
  const cls = ['tn'];
  if (key === T.sel) cls.push('on');
  if (open) cls.push('open');

  let html = `<div class="${cls.join(' ')}" data-path="${esc(key)}" style="padding-left:${5 + depth * 13}px">
    <span class="tw${leaf ? ' leaf' : ''}">${leaf ? '' : open ? '▾' : '▸'}</span>
    <span class="ti">${depth === 0 ? ICON_DRIVE : iconFolder(open && !leaf)}</span>
    <span class="tt" title="${esc(key)}">${esc(d.label || d.name)}</span>
    ${T.loading.has(key) ? '<span class="tl">…</span>' : ''}
  </div>`;

  if (open) {
    const pad = 5 + (depth + 1) * 13 + 18;
    if (!known) html += `<div class="thint" style="padding-left:${pad}px">读取中…</div>`;
    else if (!kids.length) {
      const why = T.errs.get(key);
      html += `<div class="thint" style="padding-left:${pad}px">${why ? esc(why.replace(/^.*：/, '')) : '（空文件夹）'}</div>`;
    } else html += kids.map((k) => treeNodeHtml(k, depth + 1)).join('');
  }
  return html;
}

function renderTree() {
  const box = $('tree');
  if (!T.drives.length) {
    box.innerHTML = '<div class="thint">正在读取磁盘…</div>';
    return;
  }
  box.innerHTML = T.drives.map((d) => treeNodeHtml(d, 0)).join('');
  const cur = box.querySelector('.tn.on');
  if (cur) cur.scrollIntoView({ block: 'nearest' });
  // 展开了却还没读过的节点（刷新后、或者开局恢复展开状态时），顺手补读一次
  for (const p of T.open) {
    if (!T.kids.has(p) && !T.loading.has(p)) treeKids(p);
  }
}

/** 展开 / 折叠一个节点（只动树，不动中间的图片） */
async function toggleNode(p) {
  const key = normPath(p);
  if (T.open.has(key)) {
    T.open.delete(key);
    renderTree();
    return;
  }
  T.open.add(key);
  renderTree();
  if (!T.kids.has(key)) await treeKids(key);
  renderTree();
}

/**
 * 让树同步到某个目录：把祖先一路展开、高亮当前节点。
 *
 * 逐级读一遍父目录（每级只有一次 readdir，几毫秒），这样无论用户是从中间点进来的、
 * 还是在地址栏敲的路径，左边都能准确定位到它在树里的位置。
 */
async function revealInTree(dir) {
  const target = normPath(dir);
  T.sel = target;
  if (!T.drives.length) return;

  const m = target.match(/^([A-Z]:\\)(.*)$/);
  const root = m ? m[1] : `${target.slice(0, 1)}\\`;
  const rest = m ? m[2] : '';
  const parts = rest.split('\\').filter(Boolean);
  const chain = [root];
  let cur = root;
  for (const part of parts) {
    cur = cur.endsWith('\\') ? cur + part : `${cur}\\${part}`;
    chain.push(cur);
  }
  // 只展开祖先：当前这一层在中间已经展示内容了，左边不必再展开一层
  for (let i = 0; i < chain.length - 1; i += 1) {
    T.open.add(chain[i]);
    if (!T.kids.has(chain[i])) await treeKids(chain[i]); // eslint-disable-line no-await-in-loop
  }
  renderTree();
}

function bindTree() {
  $('tree').onclick = (e) => {
    const row = e.target.closest('.tn');
    if (!row) return;
    const p = row.dataset.path;
    // 点小三角只管展开/折叠；点名字才真的打开这个文件夹
    if (e.target.closest('.tw')) {
      toggleNode(p);
      return;
    }
    loadDir(p);
  };
  // 树的内容是缓存的（同一个文件夹不会反复读盘）。插了新 U 盘、在外部建了文件夹，
  // 点这里重读一遍：保留展开状态，只把「有哪些盘、哪些文件夹」重新问一次。
  $('treeRefresh').onclick = async () => {
    T.kids.clear();
    T.errs.clear();
    await loadTree(true);
    await revealInTree(S.dir);
    toast('文件夹已刷新');
  };
}

/** 首次进页面：拉盘符，卷标是后台查的，晚一秒再来拿一次 */
async function loadTree(fresh = false) {
  try {
    const r = await api(`/api/drives${fresh ? '?fresh=1' : ''}`);
    T.drives = r.drives;
    renderTree();
    if (r.labelsPending) {
      setTimeout(async () => {
        try {
          const r2 = await api('/api/drives');
          T.drives = r2.drives;
          renderTree();
        } catch {
          /* 拿不到卷标就用「本地磁盘」，不影响使用 */
        }
      }, 1200);
    }
  } catch {
    $('tree').innerHTML = '<div class="thint">读不到磁盘列表</div>';
  }
}

/* ---------------- 目录 ---------------- */

async function loadDir(dir) {
  try {
    const t0 = performance.now();
    const data = await api(`/api/list?path=${enc(dir)}`);
    S.dir = data.path;
    S.files = data.files;
    S.sel.clear();
    S.active = null;
    S.results.clear();
    S.labels.clear();
    S.pending.clear();
    S.meta.clear();
    S.byPath.clear();
    S.byName.clear();
    S.scanDone = 0;
    for (const f of data.files) {
      S.byPath.set(f.path, f);
      S.byName.set(f.name, f);
      // labeled 是三态：true=已标注，false=确实没标，null=还没读出来
      if (f.labeled === null || f.labeled === undefined) S.pending.add(f.path);
      else if (f.labeled) S.labels.set(f.path, { title: f.labelTitle, kw: f.labelKeywords || [] });
    }
    $('curPath').textContent = shortenPath(data.path);
    $('curPath').title = data.path;
    $('pathInput').value = data.path;
    S.dirs = data.dirs || [];
    S.parent = data.parent || null;
    // 左边树跟着定位，但不挡住中间的图：树是逐级展开的，可能比图片慢一点点
    revealInTree(data.path).catch(() => {});
    render();
    $('panelBody').hidden = true;
    $('panelEmpty').hidden = false;
    if (data.files.length) console.log(`[tagden] 列表 ${data.files.length} 张，${Math.round(performance.now() - t0)} ms，待读标签 ${data.pending || 0}`);
    // 界面已经铺好了，再回头去补标签：大文件夹第一次打开就靠这个「不阻塞」
    if (S.pending.size) scanLabels(data.path, ++S.scanGen);
    // 缓存超过 5 分钟就先照旧显示，再悄悄核对一遍：照片被别的软件改过也不会一直显示旧状态
    else if (data.stale) verifyLabels(data.path, ++S.scanGen);
  } catch (err) {
    toast(err.message);
  }
}

/**
 * 后台分窗补读标签。
 *
 * 全部读完之前用户就能翻图、能选图；徽标从「…」一张张变成「✓ 物种名」，
 * 顶部同时显示进度。读完的数据在服务端落盘缓存，下次打开这个文件夹一个文件都不读。
 */
async function scanLabels(dir, gen) {
  const WINDOW = 120;
  let from = 0;
  for (;;) {
    if (gen !== S.scanGen) return;
    let r;
    try {
      r = await api(`/api/labels?path=${enc(dir)}&from=${from}&n=${WINDOW}`);
    } catch {
      S.pending.clear();
      updateDirStat();
      return;
    }
    if (gen !== S.scanGen) return;
    for (const it of r.items) {
      if (it.missing) continue;
      const f = S.byName.get(it.name);
      if (!f) continue;
      S.pending.delete(f.path);
      if (it.labeled) S.labels.set(f.path, { title: it.labelTitle, kw: it.labelKeywords || [] });
      f.labeled = !!it.labeled;
      if (it.size != null) f.size = it.size;
      if (it.orient && it.orient !== f.orient) f.orient = it.orient;
      S.scanDone += 1;
      patchCard(f.path);
    }
    from += r.items.length;
    updateDirStat();
    if (!r.items.length || from >= r.total) break;
  }
  S.pending.clear();
  updateDirStat();
  // 在「没有学名 / 未标注 / 已标注」这类视图里，标签刚补出来的卡片要马上归位
  // （补出学名的图应当从「没有学名」里消失）。「全部」不用重排，省一次全量重绘。
  if (S.filter !== 'all') render();
}

/**
 * 后台核对：缓存已经过 5 分钟，照片可能被别的软件改过。
 *
 * 只 stat（不重读整批内容），把变了的那几张的标签重读回来，然后只刷新受影响的卡片。
 * 用户看到的是「秒开 + 偶尔有一两张徽标自己变准」，而不是「一进来就等 8 秒」。
 */
async function verifyLabels(dir, gen) {
  let r;
  try {
    r = await api(`/api/verify?path=${enc(dir)}`);
  } catch {
    return;
  }
  if (gen !== S.scanGen || !r.changed?.length) return;
  for (const it of r.changed) {
    const f = S.byName.get(it.name);
    if (!f) continue;
    if (it.labeled) S.labels.set(f.path, { title: it.labelTitle, kw: it.labelKeywords || [] });
    else S.labels.delete(f.path);
    f.labeled = !!it.labeled;
    if (it.size != null) f.size = it.size;
    if (it.orient) f.orient = it.orient;
    patchCard(f.path);
  }
  updateDirStat();
  console.log(`[tagden] 核对完成：${r.changed.length} 张有变化`);
}

/* ---------------- 网格 ---------------- */

/**
 * 标签里有没有拉丁学名。
 *
 * 写入图片时的约定是 keywords = [中文名, 学名]，所以只要标题或关键词里出现
 * 「属名 + 种加词」的形态（Papilio xuthus / P. xuthus）就算有学名；
 * 只有中文名、或者只写了备注的，都不带这种形态，自然判为「没有学名」。
 *
 * 用这个而不是「有没有标签」来判断：用户只想找没鉴定到种的图，
 * 一张只填了「柑橘凤蝶」没填学名的图，同样属于他要找的目标。
 */
const LATIN_RE = /(?:^|[\s;,，；])(?:[A-Z][a-z]{2,}|[A-Z]\.)\s+(?:sp{1,2}\b|[a-z]{3,}\b)/;

/**
 * 文件名也当证据：很多人的图在拍完、归档时就自带学名了，
 * `Papilio xuthus 001.jpg`、`Papilio_xuthus.jpg` 这种没必要再识别一遍。
 * 去扩展名、把 _ 和 - 当空格（下划线是下载/批处理最常见的分隔符），
 * 点号留着 —— `P. xuthus` 这种缩写属名要靠它。
 */
function fileNameText(name) {
  return String(name || '')
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 一张图有没有学名。看两处：
 *   1. 图片里的标签（标题 + 关键词）
 *   2. 文件名本身
 *
 * 用这个而不是「有没有标签」来判断：用户只想找没鉴定到种的图，
 * 一张只填了「柑橘凤蝶」没填学名、文件名又是 IMG_1234 的图，同样属于他要找的目标；
 * 反过来，文件名写着 `Papilio xuthus` 的图哪怕还没写标签，也已经不需要再认了。
 */
function hasLatinName(f) {
  const lab = S.labels.get(f.path);
  const parts = [fileNameText(f.name)];
  if (lab) parts.push(lab.title || '', (lab.kw || []).join(' '));
  return LATIN_RE.test(parts.join(' '));
}

function visible() {
  return S.files.filter((f) => {
    // 标签还没读出来的先算「未标注」，读完自然归位
    if (S.filter === 'todo') return !S.labels.has(f.path);
    if (S.filter === 'nolatin') return !hasLatinName(f);
    if (S.filter === 'done') return S.labels.has(f.path);
    if (S.filter === 'cand') return S.results.has(f.path);
    return true;
  });
}

/** EXIF 缩略图不带方向信息，按 orientation 自己转正 */
function rotCls(o) {
  if (o === 6 || o === 8) return 'rot';
  if (o === 3) return 'rot180';
  return '';
}

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** 一张卡片右上角的徽标：状态优先级 识别中 > 已标注 > 有候选 > 待读标签 */
function badgeOf(f) {
  const lab = S.labels.get(f.path);
  const r = S.results.get(f.path);
  if (S.busy.has(f.path)) return '<span class="badge busy"><span class="spin"></span> 识别中</span>';
  if (lab) return `<span class="badge done">✓ ${esc(lab.title || '已标注')}</span>`;
  if (r) {
    const top = r.rows?.[0];
    return top
      ? `<span class="badge cand">${esc(top.cn || top.latin)} ${top.pct}%</span>`
      : '<span class="badge cand">没认出来</span>';
  }
  if (S.pending.has(f.path)) return '<span class="badge unknown">…</span>';
  return '';
}

/**
 * 只更新一张卡片。
 *
 * 以前点一张图会把 2000 多张卡片的 innerHTML 整个重建一遍，点一下卡一下；
 * 现在选中、识别中、标签补全都走这里，动的只有一个 DOM 节点。
 */
function patchCard(p) {
  const el = S.els.get(p);
  const f = S.byPath.get(p);
  if (!el || !f) return;
  el.classList.toggle('sel', S.sel.has(p));
  el.classList.toggle('active', S.active === p);
  const tick = el.querySelector('.tick');
  if (tick) tick.textContent = S.sel.has(p) ? '✓' : '';
  const badge = el.querySelector('.badge');
  const html = badgeOf(f);
  // 没有徽标可显示时要把节点删掉，不能留一个空的 —— 空 .badge 既占位又会被测试当成「有结论」
  if (badge && html) badge.outerHTML = html;
  else if (badge) badge.remove();
  else if (html) el.querySelector('.thumb')?.insertAdjacentHTML('beforeend', html);
  const img = el.querySelector('img');
  if (img && img.className !== rotCls(f.orient)) img.className = rotCls(f.orient);
  const sz = el.querySelector('.sz');
  if (sz) sz.textContent = kb(f.size);
}

/**
 * 「没有学名」按钮上的实时数量。
 * 标签是后台边读边补的，所以这个数字会从「全部」一路减下来 ——
 * 用户扫一眼就知道这个文件夹还剩多少张没鉴定。
 */
function updateFilterCounts() {
  const el = $('nolatinCount');
  if (!el) return;
  let n = 0;
  for (const f of S.files) if (!hasLatinName(f)) n += 1;
  el.textContent = String(n);
}

function updateDirStat() {
  const parts = [];
  if (S.dirs.length) parts.push(`${S.dirs.length} 个文件夹`);
  parts.push(`${S.files.length} 张`, `已标注 ${S.labels.size}`);
  if (S.pending.size) parts.push(`读取标签 ${S.scanDone}/${S.files.length}`);
  $('dirStat').textContent = parts.join(' · ');
  updateFilterCounts();
}

/** 中间那块的文件夹卡片：和图片同一个网格，点一下就进去 */
function folderCardHtml(d) {
  return `<div class="card folder" data-d="${esc(d.path)}">
        <div class="thumb fold">
          <svg viewBox="0 0 48 48" width="46" height="46" aria-hidden="true">
            <path d="M6 14a3 3 0 0 1 3-3h9l4 4.5h17a3 3 0 0 1 3 3v3H6z" fill="#dcae5d"/>
            <path d="M6 19h36l-4 16.5a3 3 0 0 1-3 2.5H12a3 3 0 0 1-3-2.6z" fill="#f0c877"/>
          </svg>
        </div>
        <div class="meta"><div class="nm" title="${esc(d.path)}">${esc(d.name)}</div><div class="sz">文件夹</div></div>
      </div>`;
}

function cardHtml(f) {
  return `<div class="card${S.sel.has(f.path) ? ' sel' : ''}${S.active === f.path ? ' active' : ''}" data-p="${esc(f.path)}">
        <div class="thumb">
          <img loading="lazy" decoding="async" class="${rotCls(f.orient)}" src="/img?path=${enc(f.path)}&amp;thumb=1" alt="">
          <span class="tick">${S.sel.has(f.path) ? '✓' : ''}</span>
          ${badgeOf(f)}
        </div>
        <div class="meta"><div class="nm" title="${esc(f.name)}">${esc(f.name)}</div><div class="sz">${kb(f.size)}</div></div>
      </div>`;
}

let renderSeq = 0;

/**
 * 铺网格。
 *
 * 试过「分批 append」来抢先出图，但在 Chrome 里把 2671 个卡片分批塞进同一个 grid 时，
 * 行高会被算成 4px（卡片被 overflow:hidden 压成细条，图片全看不见）——
 * 一次性 innerHTML 反而稳。真正费时间的是「点一下重建 2671 张」，那个用 patchCard 解决了。
 */
function render() {
  const seq = ++renderSeq;
  const list = visible();
  const grid = $('grid');
  S.els.clear();
  // 文件夹排在图片前面；筛选「未标注/已标注/有候选」时只谈图片，就不掺文件夹了
  const showDirs = S.filter === 'all' ? S.dirs : [];
  grid.innerHTML = showDirs.map(folderCardHtml).join('') + list.map(cardHtml).join('');

  // 建 path -> 卡片 的索引，后面只改单个节点
  for (const el of grid.children) {
    const p = el.dataset.p;
    if (p) S.els.set(p, el);
  }

  grid.onclick = (e) => {
    const folder = e.target.closest('.card.folder');
    if (folder) {
      loadDir(folder.dataset.d);
      return;
    }
    const card = e.target.closest('.card');
    if (!card) return;
    toggle(card.dataset.p);
  };

  updateDirStat();
  const total = list.length + showDirs.length;
  $('empty').hidden = total > 0;
  if (!total) {
    let msg;
    if (!S.files.length) msg = '<b>这个文件夹是空的</b>没有子文件夹，也没有图片';
    else if (S.filter === 'nolatin')
      msg = S.dirs.length
        ? `<b>这一层的图都有学名了</b>还有 ${S.dirs.length} 个子文件夹，可能有没标的，切到「全部」点进去看看`
        : '<b>这个文件夹里的图都有学名了</b>标签或文件名里已经写了学名，不用再识别了';
    else msg = '<b>这个筛选下没有图片</b>换个筛选看看';
    $('empty').innerHTML = msg;
  }

  updateCount();
  return Promise.resolve(seq);
}

function toggle(p, jump = true) {
  if (S.sel.has(p)) S.sel.delete(p);
  else S.sel.add(p);
  S.active = p;
  patchCard(p);
  updateCount();
  if (jump) openPanel(p);
}

function updateCount() {
  const n = S.sel.size;
  const btn = $('runBtn');
  // 注意：下面这行会重建按钮内部，所以 #selCount 必须一起重建，否则下次拿不到这个节点
  btn.innerHTML = S.queue > 0 ? `识别中 ${S.queue}…` : `识别选中 <b id="selCount">${n}</b>`;
  const c = $('selCount');
  if (c) c.textContent = n;
  btn.disabled = n === 0 || S.queue > 0;
}

function bindToolbar() {
  $('upBtn').onclick = () => {
    // 用服务端算好的父级：C:\ 再往上就没有了，字符串截断会截出「C:」这种半截路径
    if (S.parent) loadDir(S.parent);
  };
  $('goBtn').onclick = () => {
    const p = $('pathInput').value.trim();
    if (p) loadDir(p);
  };
  $('pathInput').onkeydown = (e) => {
    if (e.key === 'Enter') $('goBtn').click();
  };
  $('filterSeg').onclick = (e) => {
    const b = e.target.closest('button[data-f]');
    if (!b) return;
    S.filter = b.dataset.f;
    [...$('filterSeg').children].forEach((x) => x.classList.toggle('on', x === b));
    $('selAll').textContent = S.filter === 'nolatin' ? '全选没有学名' : '全选未标注';
    render();
  };
  $('selAll').onclick = () => {
    const touched = [];
    // 「没有学名」视图里看到的每一张都是待鉴定的，直接全选；
    // 其他视图沿用「只选还没标注的」，免得把已标注的图又送去识别一遍。
    const pickAll = S.filter === 'nolatin';
    for (const f of visible())
      if (pickAll || !S.labels.has(f.path)) {
        S.sel.add(f.path);
        touched.push(f.path);
      }
    for (const p of touched) patchCard(p);
    updateCount();
  };
  $('selNone').onclick = () => {
    const touched = [...S.sel];
    S.sel.clear();
    for (const p of touched) patchCard(p);
    updateCount();
  };
  $('archiveBtn').onclick = doArchive;
  $('exportBtn').onclick = doExport;
  $('runBtn').onclick = runIdentify;
  $('writeBtn').onclick = doWrite;
}

/* ---------------- 识别 ---------------- */

async function runIdentify() {
  const targets = [...S.sel];
  if (!targets.length) return;
  S.queue = targets.length;
  updateCount();
  let done = 0;

  const worker = async () => {
    while (targets.length) {
      const p = targets.shift();
      await identifyOne(p);
      done += 1;
      S.queue = targets.length + 0;
      updateCount();
    }
  };
  await Promise.all([worker(), worker()]);
  S.queue = 0;
  updateCount();
  render();
  toast(`识别完成 ${done} 张`);
}

async function identifyOne(p) {
  S.busy.add(p);
  patchCard(p);
  try {
    const variants = await makeVariants(p);
    const body = { path: p, sources: S.state.current.sources, ...variants };
    const r = await post('/api/identify', body);
    S.results.set(p, r);
    if (S.active === p) openPanel(p);
  } catch (err) {
    S.results.set(p, { rows: [], error: err.message });
    if (S.active === p) openPanel(p);
  } finally {
    S.busy.delete(p);
    patchCard(p);
  }
}

/** 生成两种尺寸的 JPEG 副本给站点用（多识要 ≤640，植物智只收 JPG） */
function makeVariants(p) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        resolve({ dataJpeg: draw(img, 1600, 0.9), dataSmall: draw(img, 640, 0.85) });
      } catch {
        resolve({});
      }
    };
    img.onerror = () => resolve({});
    img.src = `/img?path=${enc(p)}`;
  });
}

function draw(img, maxSide, q) {
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  return cv.toDataURL('image/jpeg', q).split(',')[1];
}

/* ---------------- 右侧详情 ---------------- */

const SITE_NAME = () => Object.fromEntries((S.state?.siteMeta || []).map((m) => [m.key, m.name]));

function openPanel(p) {
  const f = S.files.find((x) => x.path === p);
  if (!f) return;
  ensureMeta(p);
  $('panelEmpty').hidden = true;
  $('panelBody').hidden = false;
  $('pvImg').src = `/img?path=${enc(p)}`;
  $('pvName').textContent = f.name;
  $('writeMsg').textContent = '';
  $('writeMsg').className = 'msg';

  const lab = S.labels.get(p);
  $('pvLabel').textContent = lab?.title
    ? `已写入：${lab.title}`
    : lab?.kw?.length
      ? `已有关键词：${lab.kw.join('、')}（没有标题，多半是别的软件写的）`
      : '尚未写入标签';
  loadExif(p);

  const r = S.results.get(p);
  const list = $('candList');
  if (!r) {
    list.innerHTML = `<div class="dim" style="padding:6px 2px">还没识别。勾上这张图，点右上「识别选中」。</div>`;
    $('pvVerdict').textContent = '';
  } else if (r.error) {
    list.innerHTML = `<div class="msg err">${r.error}</div>`;
    $('pvVerdict').textContent = '';
  } else if (!r.rows?.length) {
    const failed = Object.entries(r.sites || {})
      .filter(([, v]) => !v.ok)
      .map(([k, v]) => `${SITE_NAME()[k] || k}：${v.error}`);
    list.innerHTML = `<div class="dim" style="padding:6px 2px">没有站点给出结果</div>${
      failed.length ? `<ul class="dim" style="padding-left:16px;font-size:11.5px">${failed.map((x) => `<li>${x}</li>`).join('')}</ul>` : ''
    }`;
    $('pvVerdict').textContent = '';
  } else {
    const names = SITE_NAME();
    list.innerHTML = r.rows
      .map((row, i) => {
        const srcs = Object.keys(row.bySite || {}).map((k) => names[k] || k).join('、');
        return `<button class="cand" data-i="${i}">
          <span class="pct">${row.pct}%</span>
          <span class="nm"><div class="cn">${row.cn || '（无中文名）'}</div><div class="la">${row.latin || ''}</div></span>
          <span class="src" title="${srcs}">${row.support} 票</span>
        </button>`;
      })
      .join('');
    list.onclick = (e) => {
      const b = e.target.closest('.cand');
      if (!b) return;
      [...list.children].forEach((x) => x.classList.toggle('on', x === b));
      const row = r.rows[Number(b.dataset.i)];
      $('inCn').value = row.cn || '';
      $('inLatin').value = row.latin || '';
      $('writeBtn').disabled = false;
      $('writeMsg').textContent = '';
      updateRenamePreview();
    };
    $('pvVerdict').textContent = r.verdict || '';
    // 默认把第一候选填进手动框，用户直接点写入也能成
    const top = r.rows[0];
    $('inCn').value = top.cn || '';
    $('inLatin').value = top.latin || '';
    [...list.children][0]?.classList.add('on');
  }
  $('writeBtn').disabled = !($('inCn').value.trim() || $('inLatin').value.trim());
  updateRenamePreview();
}

/** 读一次这张图现有的标签，主要为了拿原始文件名（重命名预览要用） */
async function ensureMeta(p) {
  if (S.meta.has(p)) {
    updateRenamePreview();
    return;
  }
  try {
    const r = await api(`/api/label?path=${enc(p)}`);
    S.meta.set(p, r.label || {});
  } catch {
    S.meta.set(p, {});
  }
  if (S.active === p) updateRenamePreview();
}

/** 面板底下那行：拍摄时间 + 坐标。导出的清单就是靠它们。 */
async function loadExif(p) {
  const el = $('pvExif');
  if (!el) return;
  el.innerHTML = '';
  try {
    const e = await api(`/api/exif?path=${enc(p)}`);
    if (S.active !== p) return; // 用户已经点别的图了
    const bits = [];
    if (e.dateTime) bits.push(`<b>拍摄</b> ${e.dateTime}`);
    if (e.lat != null) {
      bits.push(`<b>坐标</b> ${e.lat.toFixed(5)}, ${e.lon.toFixed(5)}${e.alt != null ? `（${Math.round(e.alt)} m）` : ''}`);
    }
    el.innerHTML = bits.length ? bits.join(' &nbsp;·&nbsp; ') : '<span style="opacity:.75">这张图没有拍摄时间/坐标</span>';
  } catch {
    /* 读不到就不显示，不影响标注 */
  }
}

/* ---------------- 归档与导出 ---------------- */

/** 先统计再确认：移动文件没有撤销，不能让用户点一下就搬走一批照片 */
async function doArchive() {
  if (!S.dir) return;
  const btn = $('archiveBtn');
  const text = btn.textContent;
  btn.disabled = true;
  btn.textContent = '统计中…';
  try {
    const pre = await post('/api/archive', { path: S.dir, apply: false });
    if (!pre.willMove) {
      toast('这个文件夹里没有已标注的图片');
      return;
    }
    const lines = pre.groups.slice(0, 12).map((g) => `${g.name}  ${g.count} 张`).join('\n');
    const more = pre.groups.length > 12 ? `\n… 还有 ${pre.groups.length - 12} 个物种` : '';
    const ask = `会把 ${pre.willMove} 张图片分别移进同名子文件夹：\n\n${lines}${more}\n\n移动后不能撤销，继续吗？`;
    if (!confirm(ask)) return;
    btn.textContent = '归档中…';
    const r = await post('/api/archive', { path: S.dir, apply: true });
    await loadDir(S.dir);
    const bad = r.failed?.length ? `，${r.failed.length} 张失败` : '';
    toast(`已归档 ${r.moved} 张到 ${r.groups.length} 个物种文件夹${bad}`, 3600);
  } catch (err) {
    toast(err.message, 4000);
  } finally {
    btn.disabled = false;
    btn.textContent = text;
  }
}

async function doExport() {
  if (!S.dir) return;
  const btn = $('exportBtn');
  const text = btn.textContent;
  btn.disabled = true;
  btn.textContent = '导出中…';
  try {
    const r = await post('/api/export', { path: S.dir });
    const gps = r.withGps ? `，其中 ${r.withGps} 张带坐标` : '，都没找到坐标';
    toast(`已导出 ${r.names.join(' 和 ')}：${r.detail} 张 / ${r.species} 个物种${gps}`, 4600);
  } catch (err) {
    toast(err.message, 4000);
  } finally {
    btn.disabled = false;
    btn.textContent = text;
  }
}

/* ---------------- 写入 ---------------- */

async function doWrite() {
  const p = S.active;
  if (!p) return;
  const cn = $('inCn').value.trim();
  const latin = $('inLatin').value.trim();
  if (!cn && !latin) {
    toast('先选一个候选，或手填物种名');
    return;
  }
  const r = S.results.get(p);
  const top = r?.rows?.[0];
  const source = top ? Object.keys(top.bySite || {}).map((k) => SITE_NAME()[k] || k).join(' + ') : '手工填写';

  $('writeBtn').disabled = true;
  $('writeBtn').textContent = '写入中…';
  try {
    const out = await post('/api/write', {
      path: p,
      cn,
      latin,
      note: $('inNote').value.trim(),
      source,
      rename: S.opt.rename,
      renameOrder: S.opt.order,
      renamePick: S.opt.pick,
      archive: S.opt.archive,
    });

    // 归档把文件挪进了子文件夹，它已经不属于「当前这一层」了，
    // 留着卡片只会点出一张坏图 —— 直接从列表里摘掉，并告诉用户去哪了。
    if (out.archived) {
      const gone = S.byPath.get(p);
      S.files = S.files.filter((x) => x.path !== p);
      S.sel.delete(p);
      S.results.delete(p);
      S.labels.delete(p);
      S.pending.delete(p);
      S.meta.delete(p);
      S.byPath.delete(p);
      if (gone) S.byName.delete(gone.name);
      S.els.delete(p);
      S.active = null;
      render();
      $('panelBody').hidden = true;
      $('panelEmpty').hidden = false;
      toast(`已写入并归档到「${out.folder}」文件夹`, 3200);
      return;
    }

    // 重命名成功后文件路径变了：卡片、选中集合、识别结果都要跟着搬家，
    // 否则旧路径还会留在列表里，点它只会「图片不存在」。
    const next = out.path || p;
    S.labels.delete(p);
    // kw 一定要带上：写进图片的关键词就是 [中文名, 学名]，
    // 少了学名，「没有学名」筛选会把刚标好的图又算回未鉴定。
    S.labels.set(next, { title: cn || latin, kw: [cn, latin].filter(Boolean) });
    S.pending.delete(p);
    if (next !== p) {
      const f = S.byPath.get(p) || S.files.find((x) => x.path === p);
      if (f) {
        S.byPath.delete(p);
        S.byName.delete(f.name);
        f.path = next;
        f.name = out.name;
        f.labeled = true;
        S.byPath.set(next, f);
        S.byName.set(f.name, f);
      }
      if (S.sel.delete(p)) S.sel.add(next);
      if (S.results.has(p)) {
        S.results.set(next, S.results.get(p));
        S.results.delete(p);
      }
      S.active = next;
    } else if (S.byPath.get(p)) {
      S.byPath.get(p).labeled = true;
    }
    // 刚写进去的标签里就带着原始文件名，直接拿来用，不用再问一次服务端
    if (out.label) S.meta.set(next, out.label);

    render();
    openPanel(S.active);
    // openPanel 会清掉提示，所以放在它后面再写一次
    $('writeMsg').className = 'msg ok';
    $('writeMsg').innerHTML =
      `已写入 ${out.kind.toUpperCase()}（+${out.delta} 字节）· 标题：${out.title}` +
      (out.renamed ? `<br>文件已改名为 ${out.name}` : '');
  } catch (err) {
    $('writeMsg').className = 'msg err';
    $('writeMsg').textContent = err.message;
  } finally {
    $('writeBtn').textContent = '确认并写入图片';
    $('writeBtn').disabled = false;
  }
}

/* ---------------- 送到聚合台 ---------------- */

/**
 * 聚合台那一页的句柄。
 *
 * 以前每点一次就 window.open 一个新标签页，连点十张图就是十个聚合台，越堆越多。
 * 现在：第一次开一个**固定名字**的标签页（HUB_TARGET），浏览器遇到同名窗口会复用而不是再加一个；
 * 之后每次点都往那一页 postMessage 塞图（聚合台 1.0.44 起认这个消息），那一页自己入队识别。
 */
const HUB_TARGET = 'bioidhub';
let HUB_WIN = null;

/** 等聚合台回 ack：它那边真把图入队了才算送到，光 postMessage 过去不保险 */
function waitHubAck(timeout, origin) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', on);
      resolve(false);
    }, timeout);
    function on(e) {
      if (origin && e.origin !== origin) return;
      if (!e.data || e.data.type !== 'bioidhub:ack') return;
      clearTimeout(timer);
      window.removeEventListener('message', on);
      resolve(e.data.ok !== false);
    }
    window.addEventListener('message', on);
  });
}

/**
 * 把这张图塞进已经开着的聚合台页面。
 * 返回 false 的三种情况：没开过、已经关了、那页还不认 postMessage（1.0.44 之前）。
 * 都退回「开/复用标签页 + ?img=」那条老路，功能不受影响。
 */
async function pushToOpenHub(r) {
  const w = HUB_WIN;
  if (!w || w.closed || !r.hub || !r.hub.acceptImageMessage) return false;
  try {
    w.postMessage(
      { type: 'bioidhub:open-image', path: r.file, group: r.group, sites: (r.sites || []).join(',') },
      r.hub.home,
    );
    w.focus();
  } catch {
    return false;
  }
  return waitHubAck(1600, r.hub.home);
}

/** 把当前这张图交给物种聚合台，直接看它那边的多站完整结果 */
async function openInHub() {
  const p = S.active;
  if (!p) return;
  const btn = $('hubBtn');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '正在连接聚合台…';
  $('writeMsg').className = 'msg';
  $('writeMsg').textContent = '';
  try {
    const r = await api(`/api/hub/link?path=${enc(p)}`);

    // 这一页已经开着：直接把图递过去，不新开标签页，也不刷新那一页
    if (await pushToOpenHub(r)) {
      toast('已送到聚合台正开着的那一页，接着识别', 3200);
      return;
    }

    // 没开着（或那页还不认消息）：开一个。target 写死，浏览器会复用同名标签页而不是再开新的
    const w = window.open(r.url, HUB_TARGET);
    if (!w) {
      toast('浏览器把新窗口拦了，允许弹窗后再点一次', 3600);
    } else {
      HUB_WIN = w;
      // 源码跑的聚合台版本号是 0.0.0-dev，别拿这个吓用户
      const v = r.hub.version && r.hub.version !== '0.0.0-dev' ? `v${r.hub.version}` : '源码版';
      // 带过去的模型数就是上面那排开关开着的数量，两边对得上才这么说
      const n = (r.sites || []).length;
      const same = n ? `，带过去 ${n} 个模型` : '';
      toast(r.groupName ? `已在聚合台按「${r.groupName}」打开${same}（${v}）` : `已在聚合台打开${same}（${v}）`);
    }
  } catch (err) {
    // 聚合台没装、版本太旧这两件事都是可解释的，给一张能照着做的卡片，
    // 别把一句「连不上」甩在面板里让用户自己猜
    const info = err.payload || {};
    if (info.code === 'HUB_DOWN' || info.code === 'HUB_OLD') {
      showHubHelp(info);
    } else {
      $('writeMsg').className = 'msg err';
      $('writeMsg').textContent = err.message;
    }
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

/* ---------------- 聚合台没装 / 太旧时的引导 ---------------- */

/** 说明卡片：没装、装了但太旧，要说的话不一样，所以文案按情况换 */
function showHubHelp(info) {
  const old = info.code === 'HUB_OLD';
  const dl = info.download;
  // mac 上给的是 zip（解压后双击 start.command），Windows 上是单个 exe，步骤不能混着说
  const mac = Boolean(dl && dl.kind === 'zip');
  $('hubTitle').textContent = old ? '聚合台版本太旧了' : '这一步要先装「物种鉴定聚合台」';

  $('hubTip').textContent = old
    ? `你这边跑的聚合台是 v${(info.hub && info.hub.version) || '?'}，还不支持从外部直接打开图片。升到最新版就能用，账号和设置都保留。`
    : '识别、确认候选、写入标注、导出、按物种归档 —— 这些在这个工坊里都能自己完成，不需要聚合台。只有「在聚合台查看这张」是把同一张图交给它，看那边的多站完整结果。';

  const steps = old
    ? mac
      ? ['下载最新版 zip，解压后用它替换掉旧的整个文件夹', '关掉旧的终端窗口，双击新的 start.command', '回到这里再点一次「在聚合台查看这张」']
      : ['下载最新版，覆盖掉旧的 exe 即可', '关掉正在跑的旧版，双击新的', '回到这里再点一次「在聚合台查看这张」']
    : mac
      ? [
          '下载后解压，放到一个固定文件夹（mac 免安装）',
          '双击 <code>start.command</code>，它会自己打开 <code>127.0.0.1:8791</code>',
          '回到这里，再点一次「在聚合台查看这张」',
        ]
      : [
          '下载后放到一个固定文件夹（Windows 免安装，一个 exe 就够）',
          '双击运行，它会自己打开 <code>127.0.0.1:8791</code>',
          '回到这里，再点一次「在聚合台查看这张」',
        ];
  $('hubSteps').innerHTML = steps.map((t) => `<li>${t}</li>`).join('');

  const tried = info.tried || [];
  $('hubTried').textContent = tried.length
    ? `已在 ${tried.map((p) => `127.0.0.1:${p}`).join('、')} 找过，都没有在运行。`
    : '';

  const btn = $('hubGet');
  if (dl && dl.url) {
    const piece = mac ? ` ${dl.arch === 'arm64' ? 'Apple 芯片' : 'Intel'}版` : '';
    $('hubDlLine').textContent = `当前最新版 v${dl.version}${piece}${dl.size ? ` · ${kb(dl.size)}` : ''}`;
    btn.hidden = false;
    btn.textContent = `下载 v${dl.version}`;
    btn.onclick = () => {
      window.open(dl.url, '_blank', 'noopener');
      toast(mac ? '开始下载了，解压后双击 start.command，装好再回来点一次' : '开始下载了，装好再回来点一次', 5200);
    };
  } else {
    $('hubDlLine').textContent = '暂时读不到下载地址（网络不通），可以点顶栏「联系作者」直接向我要安装包。';
    btn.hidden = true;
    btn.onclick = null;
  }
  $('hubMask').classList.add('show');
}

function bindHubHelp() {
  const mask = $('hubMask');
  const close = () => mask.classList.remove('show');
  $('hubClose').onclick = close;
  mask.addEventListener('click', (e) => {
    if (e.target === mask) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && mask.classList.contains('show')) close();
  });
}

/* ---------------- 联系作者 ---------------- */

/** 顶栏那颗小按钮：二维码就是作者本人的微信（public/author-qr.png，打包后内联在 exe 里） */
function bindAuthor() {
  const mask = $('authorMask');
  const close = () => mask.classList.remove('show');
  $('authorBtn').onclick = () => mask.classList.add('show');
  $('authorClose').onclick = close;
  mask.addEventListener('click', (e) => {
    if (e.target === mask) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && mask.classList.contains('show')) close();
  });
}

/* ---------------- 自动更新 ----------------
 * 流程和聚合台一样：查清单 → 下载校验 → 换掉自身 → 新进程接管 → 页面自动刷新。
 * 源码运行时服务端会回 supported=false，这里只提示一句，不做任何替换。
 */

const UPD_SKIP = 'tagdenSkipVersion';
const UPD = { info: null, busy: false };
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const mbText = (n) => (n / 1048576).toFixed(1);

function upbarShow(cls, text, note = '', goLabel = '') {
  const bar = $('upbar');
  bar.hidden = false;
  bar.className = `upbar ${cls}`.trim();
  $('upbarText').textContent = text;
  $('upbarNotes').textContent = note || '';
  const go = $('upbarGo');
  go.hidden = !goLabel;
  if (goLabel) go.textContent = goLabel;
}

async function checkUpdate(force = false) {
  if (!S.state?.update?.configured) return false;
  let r = null;
  try {
    r = await fetch(`/api/update/check${force ? '?force=1' : ''}`).then((x) => x.json());
  } catch {
    return false; // 网络不通就不打扰，下次启动再试
  }
  if (!r || !r.ok || !r.hasUpdate) return false;
  UPD.info = r;
  // 用户点过「稍后再说」的版本，启动时不再弹；手动检查仍然要给出来
  if (!force && localStorage.getItem(UPD_SKIP) === r.latest) return true;
  renderUpdatePrompt(r);
  return true;
}

function renderUpdatePrompt(r) {
  if (UPD.busy) return;
  const size = r.size ? ` · ${mbText(r.size)} MB` : '';
  const notes = (r.notes || '').replace(/\s+/g, ' ').trim();
  const moveTip =
    r.mode === 'bundle'
      ? '可能在「应用程序」文件夹里（没有写权限），把整个文件夹移到桌面或用户目录后重开'
      : '程序可能在 Program Files 等不可写目录，请移到 D 盘或用户目录后重开';

  if (!r.ready) {
    if (r.supported && r.canApply === false) {
      upbarShow('fail', `发现新版本 v${r.latest}，但这台机器上无法自动更新`, moveTip, '');
    } else if (!r.supported) {
      upbarShow('', `发现新版本 v${r.latest}（当前 v${r.current}）${size}`, '这是源码运行的版本，请双击 exe 版才会自动更新', '');
    } else {
      upbarShow('', `发现新版本 v${r.latest}（当前 v${r.current}）${size}`, notes, '立即更新');
    }
  } else if (!r.canApply) {
    upbarShow('fail', `新版 v${r.latest} 已下载，但程序目录不可写`, moveTip, '重试');
  } else {
    upbarShow('', `新版 v${r.latest} 已就绪`, '重启后即生效，正在识别时请稍后', '重启并更新');
  }
  $('upbarX').hidden = false;
}

async function pollUpProgress() {
  try {
    const p = await fetch('/api/update/progress').then((r) => r.json());
    if (p.phase === 'downloading') {
      const text = p.total
        ? `正在下载新版 ${mbText(p.received)} / ${mbText(p.total)} MB`
        : `正在下载新版 ${mbText(p.received)} MB`;
      $('upbarText').textContent = text;
    }
  } catch {
    /* 服务正忙，下次再问 */
  }
}

async function runUpdate() {
  if (UPD.busy || !UPD.info) return;
  UPD.busy = true;
  $('upbarX').hidden = true;

  try {
    if (!UPD.info.ready) {
      upbarShow('busy', '正在下载新版…', '下载期间可以继续标注，不影响使用');
      const timer = setInterval(pollUpProgress, 500);
      try {
        await api('/api/update/download', { method: 'POST' });
      } finally {
        clearInterval(timer);
      }
    }

    upbarShow('busy', '正在替换程序并重启…', '大约需要几秒，请不要关闭窗口');
    try {
      await api('/api/update/apply', { method: 'POST' });
    } catch {
      /* 服务可能已经先退出了，交给下面的探测判断 */
    }

    upbarShow('done', '更新完成，正在重新加载…', '');
    await waitForRestart();
  } catch (err) {
    UPD.busy = false;
    upbarShow('fail', '更新没成功', err.message || '未知错误', '重试');
    $('upbarX').hidden = false;
  }
}

/** 等新进程把端口接回来，并且版本号确实变了，再刷新页面 */
async function waitForRestart() {
  const before = UPD.info?.current || S.state?.version || '';
  await sleepMs(1200); // 先让老进程退干净
  for (let i = 0; i < 90; i += 1) {
    try {
      const r = await fetch('/api/state', { cache: 'no-store' });
      if (r.ok) {
        const d = await r.json();
        if (d?.version && d.version !== before) {
          location.reload();
          return;
        }
      }
    } catch {
      /* 还没起来，继续等 */
    }
    await sleepMs(400);
  }
  upbarShow('fail', '新版本已装好，但服务没有自动恢复', '请手动重新打开程序', '');
}

function bindUpdate() {
  $('upbarGo').onclick = runUpdate;
  $('upbarX').onclick = () => {
    if (UPD.info?.latest) localStorage.setItem(UPD_SKIP, UPD.info.latest);
    $('upbar').hidden = true;
  };
  // 页面起来后安静地查一次，不打扰
  setTimeout(() => checkUpdate(false), 1600);
}

boot();
