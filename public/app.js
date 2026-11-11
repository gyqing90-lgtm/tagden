'use strict';
/* 物种标注工坊 —— 前端 */

const $ = (id) => document.getElementById(id);
const enc = encodeURIComponent;

/* ---------------- 翻页参数 ----------------
 * 必须在 S 之前声明：S.pageSize 初始化时就要读它们（const 有 TDZ，放到后面会炸）。
 */

const PAGE_SIZES = [60, 120, 240, 0];
const PAGE_KEY = 'tagdenPageSize';

/** 每页张数记在 localStorage：换电脑、换文件夹都保留上一次的选择 */
function readPageSize() {
  const raw = localStorage.getItem(PAGE_KEY);
  // 注意别用 Number(null)：那是 0，而 0 正是「全部」的取值，会把默认值误判成不分页
  if (raw === null) return 120;
  const v = Number(raw);
  return PAGE_SIZES.includes(v) ? v : 120;
}

const S = {
  state: null,
  dir: '',
  tab: 'annotate', // 当前标签页：annotate=标注，stats=统计分析
  files: [],
  dirs: [], // 当前目录的子文件夹，和图片一起铺在中间
  parent: null, // 上一级路径（服务端给的，比字符串截断可靠）
  filter: 'all',
  sel: new Set(),
  active: null,
  results: new Map(), // path -> 识别结果
  labels: new Map(), // path -> 已写入的标签
  written: new Set(), // 本次会话里已经点过「确认并写入」的照片，自动跳下一张时跳过它们
  taxo: new Map(), // 学名 -> { family, genus }；候选悬停时用，跨照片复用
  pending: new Set(), // path -> 标签还没读出来（大文件夹后台补读中）
  byPath: new Map(), // path -> 文件对象，补读标签时别用数组 find 扫 2000 次
  byName: new Map(), // 文件名 -> 文件对象，补读接口只回名字
  els: new Map(), // path -> 卡片 DOM，改一张只动一张
  scanGen: 0,
  scanDone: 0,
  meta: new Map(), // path -> 图片里现有的完整标签（含原始文件名），重命名预览用
  busy: new Set(),
  queue: 0,
  // 翻页：page 从 1 开始；pageSize=0 表示不分页（一页全铺，老行为）
  page: 1,
  pageSize: readPageSize(),
  // 重命名偏好：order=物种名在前/在后/只要物种名，pick=中文/学名/中文+拉丁/拉丁+中文，
  // suffix=「只要物种名」时自己填的后缀（留空则重名由服务端加 _2、_3…）
  opt: { rename: false, order: 'first', pick: 'cn', suffix: '' },
  // 照片从哪来：local=本机文件夹，album=自然在线账号里的相册（走 S.files 的伪文件）
  mode: 'local',
  albumPick: null, // 相册端右侧面板选中的候选
  localSnap: null, // 切到相册端时存的本机快照，切回来原样还回去
};
// jsdom 验收要拿得到状态（和 SCR / NAT 一个理由）
if (typeof window !== 'undefined') window.S = S;

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

/** 这条路径是不是 Windows 形态（盘符 / UNC）；mac、Linux 一律按 POSIX 处理 */
function isWinPath(p) {
  const s = String(p || '');
  return /^[A-Za-z]:[\\/]/.test(s) || /^[A-Za-z]:$/.test(s) || /^\\\\/.test(s);
}

/** 路径太长时只留根和最后两级，中间省略；分隔符按平台来，mac 上别显示成反斜杠 */
function shortenPath(p) {
  if (p.length <= 46) return p;
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  if (parts.length <= 3) return p;
  const tail = parts.slice(-2);
  return isWinPath(p) ? `${parts[0]}\\…\\${tail.join('\\')}` : `/…/${tail.join('/')}`;
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
  if (pick === 'latinCn') return c && l ? `${l}_${c}` : l || c;
  return c || l;
}

/**
 * first = 物种名_原名，last = 原名_物种名。和服务端同一套规则：
 * labels 传多个（当前名 + 上次写过的旧名），先把它们剥干净再造，避免层层叠加。
 */
function buildName(base, labels, order, suffix = '') {
  const list = [...new Set((Array.isArray(labels) ? labels : [labels]).map(safeName).filter(Boolean))];
  if (!list.length) return base;
  const primary = list[0];
  // 「只要物种名」：不拼原名；填了自定后缀就带上，没填则由服务端在重名时加 _2、_3…
  if (order === 'only') {
    const tail = safeName(suffix);
    return tail ? `${primary}_${tail}` : primary;
  }
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
  el.textContent = label
    ? `${buildName(base, [label, meta.title, prevLatin], S.opt.order, S.opt.suffix)}${ext}`
    : '先选候选或填物种名';
}

/* ---------------- 启动 ---------------- */

/**
 * 启动时选哪个文件夹：
 *  mac 打包版第一次跑时 cwd 在 xxx.app/Contents/MacOS，别把程序包内部当照片目录；
 *  上次的目录被删、外接盘拔了、或配置从 Windows 带过来，也别卡在空界面。
 *  先用最轻的 /api/dirs 探一下存在性，再决定真正加载谁。
 */
async function pickStartDir() {
  const last = String(S.state.lastDir || '');
  const bad = !last || /\.app[/\\]Contents[/\\]MacOS/i.test(last) || (/[\\]/.test(last) && !isWinPath(last));
  const cands = [...(bad ? [] : [last]), ...(S.state.places || []).slice(0, 2).map((p) => p.path)].filter(Boolean);
  for (const d of cands) {
    try {
      await api(`/api/dirs?path=${enc(d)}`);
      return d;
    } catch { /* 这个目录打不开，换下一个 */ }
  }
  return cands[0] || last;
}

async function boot() {
  try {
    S.state = await api('/api/state');
  } catch (err) {
    document.body.innerHTML = `<div style="padding:40px;font:14px/1.7 'Microsoft YaHei'">连不上本机服务：${esc(err.message)}<br>请在项目目录里运行 <code>node server.js</code></div>`;
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
  bindRenameSegs();
  bindEngineChips();
  bindAuthor();
  bindUpdate();
  bindAggSheet();
  bindGenusSheet();
  bindPaste();
  bindZoom();

  bindToolbar();
  bindNameCheck();
  bindArchiveSheet();
  bindArchiveTab();
  bindTree();
  bindTabs();
  bindNature();
  bindScore();
  bindTaxoTip();
  bindGutters();
  loadTree();
  await loadDir(await pickStartDir());
  // 标注页的「自然在线相册」下拉：启动后静默拉一次，别阻塞主界面
  setTimeout(() => {
    natEnsureAlbums();
    natRenamesLoad();
    scLoad();
    api('/api/score/remote').then((r) => { SCR.remote = r.items || {}; }).catch(() => {});
  }, 1200);
}

/** 把保存过的偏好刷到界面上 */
function applyUiOptions(ui) {
  S.opt.rename = !!ui.rename;
  S.opt.order = ['first', 'last', 'only'].includes(ui.renameOrder) ? ui.renameOrder : 'first';
  S.opt.pick = ['cn', 'latin', 'both', 'latinCn'].includes(ui.renamePick) ? ui.renamePick : 'cn';
  S.opt.suffix = String(ui.renameSuffix || '').slice(0, 40);
  $('chkRename').checked = S.opt.rename;
  $('renameOpts').hidden = !S.opt.rename;
  $('renameSuffix').value = S.opt.suffix;
  $('renameSuffixRow').hidden = S.opt.order !== 'only';
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
    $('renameSuffixRow').hidden = S.opt.order !== 'only';
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
  // 「只要物种名」时可以自己填后缀（地点、序号、批次都行）；留空则由服务端自动编号。
  // 边打边存，稍作防抖免得每敲一个字就写一次配置。
  let suffixTimer = 0;
  $('renameSuffix')?.addEventListener('input', () => {
    S.opt.suffix = $('renameSuffix').value;
    updateRenamePreview();
    clearTimeout(suffixTimer);
    suffixTimer = setTimeout(() => post('/api/config', { renameSuffix: S.opt.suffix }).catch(() => {}), 400);
  });
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
      if ((cur.sources || []).length <= 1) return toast('至少留一个模型，全关掉就没人认了', 2400);
      picked.delete(key);
    } else {
      picked.add(key);
    }
    try {
      S.state = await post('/api/config', { picks: [...picked] });
      renderChips();
      toast(`这次用 ${S.state.current.sources.length} 个模型识别`, 1500);
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

/** 统一成「E:\a\b」或「/Users/a/b」：同一个文件夹不因大小写/分隔符不同变成两个节点。
 *  Windows 盘符大写、分隔符统一 `\`；mac/Linux 统一 `/`，并把老版本误写的 `\` 纠正回来。
 *  （早期版本无条件把 / 换成 \\，mac 上整棵树点不开，就是栽在这儿。） */
function normPath(p) {
  const s = String(p || '');
  if (isWinPath(s)) {
    const w = s.replace(/\//g, '\\');
    return /^[a-z]:/i.test(w) ? w[0].toUpperCase() + w.slice(1) : w;
  }
  const u = s.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  return u.length > 1 ? u.replace(/\/+$/, '') : u;
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

  let html = `<div class="${cls.join(' ')}" data-path="${esc(key)}" draggable="true" style="padding-left:${5 + depth * 13}px">
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

  // 先找「离目标最近的那个根」：Windows 的根是 C:\ D:\，mac 的根是
  // 个人文件夹 / 外接盘 / 整台电脑(/)，不能一律按盘符或 / 从头算。
  let root = null;
  for (const d of T.drives) {
    const r = normPath(d.path);
    const sep = isWinPath(r) ? '\\' : '/';
    const hit = target === r || (r.endsWith(sep) ? target.startsWith(r) : target.startsWith(r + sep));
    if (hit && (!root || r.length > root.length)) root = r;
  }
  if (!root) {
    renderTree();
    return;
  }

  const sep = isWinPath(root) ? '\\' : '/';
  const parts = target.slice(root.length).split(/[\\/]/).filter(Boolean);
  const chain = [root];
  let cur = root;
  for (const part of parts) {
    cur = cur.endsWith(sep) ? cur + part : `${cur}${sep}${part}`;
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
  // 文件夹可以拖到右边「自然在线」的相册区：拖到「＋ 新建」按文件夹名建相册，
  // 拖到某个相册行就传进那个相册。这里只放路径，不复制文件。
  $('tree').addEventListener('dragstart', (e) => {
    const row = e.target.closest('.tn');
    if (!row) return;
    const p = row.dataset.path;
    if (!p) return;
    e.dataTransfer.setData('application/x-tagden-dir', p);
    e.dataTransfer.setData('text/plain', p);
    e.dataTransfer.effectAllowed = 'copy';
    row.classList.add('dragging');
    if (typeof toast === 'function' && $('natView') && !$('natView').hidden) {
      toast('拖到右边的相册上新传：放到「＋ 拖到这里新建相册」按文件夹名建相册', 2600);
    }
  });
  $('tree').addEventListener('dragend', (e) => {
    const row = e.target.closest('.tn');
    if (row) row.classList.remove('dragging');
    for (const el of document.querySelectorAll('.drop-on')) el.classList.remove('drop-on');
  });
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
    S.page = 1; // 换文件夹从第一页开始
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
    // 在「统计分析」/「按分类归档」标签页时，换了文件夹就把范围切成新文件夹
    if (S.tab === 'stats') statsLanding();
    else if (S.tab === 'archive') runArchiveTab();
    // 自然在线页：点左栏文件夹 / 树节点就是在看本机，切回本机视图并换照片
    else if (S.tab === 'nature') {
      NAT.side = 'local';
      syncNatSideUI(false);
      renderNatLocal();
    }
    // 换了文件夹，评分页的缓存跟着失效；当前就在评分页就立刻重读
    SCR.dir = '';
    SCR.sel.clear();
    SCR.bursts = null;
    SCR.groupMode = false;
    if (S.tab === 'score') scoreOpen();
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
    // 筛选视图（没有学名 / 未标注 / 已标注…）要在标签**每补出一窗**就重新过滤，
    // 否则刚补出「✓ 已标注」的图会一直赖在「没有学名」列表里，直到整批扫完才消失 ——
    // 看起来就像「已经命名的没被排除」。「全部」不用重排，省一次全量重绘。
    if (S.filter !== 'all') render();
    if (!r.items.length || from >= r.total) break;
  }
  S.pending.clear();
  updateDirStat();
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
/**
 * 一段文字里有没有拉丁学名。
 *
 * 真实照片的命名五花八门，只认「空格分隔的属名+种加词」会漏掉一大片：
 *   东亚豆粉蝶(Colias poliographus)   学名在括号里
 *   卷蛾科(Tortricidae)              只有科名（单个词）
 *   平爪鳃金龟属(Ectinohoplia)        只有属名
 *   八字地老虎(Xestia c-nigrum)       种加词带连字符
 *   豹弄蝶 thymelicus leoninus        属名写成小写
 * 所以分两步判：①括号里有拉丁词就算；②括号外要有相邻的两个拉丁词（属名+种加词）。
 * 这样又能把 IMG_2025…、DSC2177、picture_2024…、retouch_… 这些相机默认名排除掉。
 */
const LATIN_WORD_RE = /[A-Za-z][A-Za-z-]{2,}/; // 3 个以上字母/连字符，不含数字
const PAREN_GROUP_RE = /[（(][^（()）]*[)）]/g;
// 括号外相邻两个拉丁词（属名 + 种加词，第二词小写开头）
const BARE_PAIR_RE = /(?:^|[^A-Za-z-])[A-Za-z][A-Za-z-]{2,}\s+[a-z][A-Za-z-]{1,}/;
// 缩写属名：P. xuthus
const ABBR_PAIR_RE = /[A-Z]\.\s*[a-z]{2,}/;
// 中文名后面紧跟一个拉丁词（只有属名也算鉴定过）：邻烁甲Plesiophthalmus、切叶野螟属 Herpetogramma
const CN_THEN_LATIN_RE = /[\u4e00-\u9fa5][\s]*([A-Z][a-z]{2,})(?=$|[\s\d（()）.,;])/;

function hasLatinInText(text) {
  const s = String(text || '');
  // ① 括号里的：中文名(拉丁名) 最常见；单个词也算（科/属/目名）
  const groups = s.match(PAREN_GROUP_RE) || [];
  for (const g of groups) if (LATIN_WORD_RE.test(g)) return true;
  // ② 括号外：相邻两个拉丁词，或缩写属名 P. xuthus
  const bare = s.replace(PAREN_GROUP_RE, ' ');
  return BARE_PAIR_RE.test(bare) || ABBR_PAIR_RE.test(bare);
}

/**
 * 文件名专用的额外判定：中文名 + 单个拉丁属名。
 * 归档后每个属一个文件夹，里面常是「邻烁甲Plesiophthalmus (2).jpg」这种写到属的写法，
 * 它们确实已经鉴定过了，不能算「没有学名」。
 * 只对文件名用（标签里的标题可能是「福建 Fujian 2020」这类，套这条会误判）。
 */
function hasLatinInFileName(text) {
  return CN_THEN_LATIN_RE.test(String(text || ''));
}

/**
 * 文件名也当证据：很多人的图在拍完、归档时就自带学名了，
 * `Papilio xuthus 001.jpg`、`Papilio_xuthus.jpg` 这种没必要再识别一遍。
 * 去扩展名、把 _ 和 - 当空格（下划线是下载/批处理最常见的分隔符），
 * 点号留着 —— `P. xuthus` 这种缩写属名要靠它。
 */
function fileNameText(name) {
  return String(name || '')
    .replace(/\.[^.]+$/, '')
    // 只把下划线当分隔符；连字符要留着 —— 种加词本身就带连字符（c-aureum、w-album），
    // 拆开就变成「c aureum」，两个词都不足 3 个字母，学名就判不出来了。
    .replace(/_+/g, ' ')
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
  const name = fileNameText(f.name);
  const labelText = lab ? `${lab.title || ''} ${(lab.kw || []).join(' ')}` : '';
  return hasLatinInText(name) || hasLatinInText(labelText) || hasLatinInFileName(name);
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
  // 相册照片（nat: 前缀）走相册端那份：本机这边没有 byPath 记录
  if (isNatKey(p)) return patchAlbumCard(p);
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

/** 卡片右下角的放大镜按钮：只有点它才打开大图，避免点缩略图误触 */
function zoomBtnHtml(key) {
  return `<button type="button" class="zoom-btn" data-zoom="${esc(key)}" draggable="false" title="放大查看" aria-label="放大查看">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.2"></circle><path d="m15.2 15.2 4.6 4.6M10.5 7.7v5.6M7.7 10.5h5.6"></path></svg>
        </button>`;
}

function cardHtml(f) {
  return `<div class="card${S.sel.has(f.path) ? ' sel' : ''}${S.active === f.path ? ' active' : ''}" data-p="${esc(f.path)}">
        <div class="thumb" title="单击选中；点右下角放大镜看大图；点左上角圆圈勾选">
          <img loading="lazy" decoding="async" class="${rotCls(f.orient)}" src="/img?path=${enc(f.path)}&amp;thumb=1" alt="">
          <span class="tick" title="单击勾选">${S.sel.has(f.path) ? '✓' : ''}</span>
          ${badgeOf(f)}
          ${scoreBadge(f)}
          ${zoomBtnHtml(f.path)}
        </div>
        <div class="meta" title="单击勾选；双击手写中文名 / 拉丁名"><div class="nm" title="${esc(f.name)}">${esc(f.name)}</div><div class="sz">${kb(f.size)}</div></div>
      </div>`;
}

let renderSeq = 0;

/**
 * 算出这一页该显示哪几张。
 *
 * 筛选结果是全量的（「没有学名」的数量、全选都还要看全量），只有**渲染**分页：
 * 一页 120 张的话，DOM 里永远只有 120 个卡片，2000 多张的文件夹也不会卡。
 * 页数越界时钳回来（删了图、切了筛选、改了每页张数都可能越界）。
 */
function pageView() {
  const all = visible();
  const size = S.pageSize > 0 ? S.pageSize : Math.max(all.length, 1);
  const pages = Math.max(1, Math.ceil(all.length / size));
  if (S.page > pages) S.page = pages;
  if (S.page < 1) S.page = 1;
  const from = (S.page - 1) * size;
  return { all, size, pages, from, items: all.slice(from, from + size) };
}

/** 换页：滚回顶部再重画，否则会停在上一页的滚动位置 */
function gotoPage(n) {
  // 相册端的分页在站点侧：页码交给 NAT，重新拉一页
  if (S.mode === 'album') {
    const size = NAT.size || 120;
    const pages = Math.max(1, Math.ceil(NAT.total / size));
    const t = Math.min(Math.max(1, n), pages);
    if (t === NAT.page) return;
    NAT.page = t;
    S.sel.clear();
    S.active = null;
    $('grid').scrollTop = 0;
    loadAlbumPhotos();
    return;
  }
  const v = pageView();
  const target = Math.min(Math.max(1, n), v.pages);
  if (target === S.page) return;
  S.page = target;
  $('grid').scrollTop = 0;
  render();
}

function renderPager(v) {
  const bar = $('pager');
  // 没有图片时整条藏掉（文件夹卡片不需要翻页）
  const show = v.all.length > 0;
  bar.hidden = !show;
  if (!show) return;
  const paging = S.pageSize > 0 && v.pages > 1;
  $('pgNow').textContent = String(S.page);
  $('pgTotal').textContent = String(v.pages);
  $('pgPrev').disabled = !paging || S.page <= 1;
  $('pgNext').disabled = !paging || S.page >= v.pages;
  // 选中是跨页的，所以这里把「本页」和「总共」都写出来，免得以为只选了这一页
  $('pgStat').textContent =
    `${v.from + 1}–${v.from + v.items.length} 张 / 共 ${v.all.length} 张` +
    (S.sel.size ? ` · 已选 ${S.sel.size}` : '');
  const sel = $('pgSize');
  if (sel.value !== String(S.pageSize)) sel.value = String(S.pageSize);
}

/**
 * 铺网格。
 *
 * 试过「分批 append」来抢先出图，但在 Chrome 里把 2671 个卡片分批塞进同一个 grid 时，
 * 行高会被算成 4px（卡片被 overflow:hidden 压成细条，图片全看不见）——
 * 一次性 innerHTML 反而稳。现在改成一次只铺一页（默认 120 张），
 * 「点一下重建 2000 张」的问题也就不存在了。
 */
function render() {
  // 相册端走自己那套（图片在站点上，没有文件夹、没有标签），网格和翻页都另算
  if (S.mode === 'album') {
    renderAlbum();
    return Promise.resolve(++renderSeq);
  }
  const seq = ++renderSeq;
  const view = pageView();
  const list = view.items;
  const grid = $('grid');
  S.els.clear();
  // 文件夹排在图片前面；筛选「未标注/已标注/有候选」时只谈图片，就不掺文件夹了。
  // 文件夹只放在第 1 页：每页都重复一遍会让人以为有多份。
  const showDirs = S.filter === 'all' && S.page === 1 ? S.dirs : [];
  grid.innerHTML = showDirs.map(folderCardHtml).join('') + list.map(cardHtml).join('');

  // 建 path -> 卡片 的索引，后面只改单个节点
  for (const el of grid.children) {
    const p = el.dataset.p;
    if (p) S.els.set(p, el);
  }

  bindGridEvents(grid, true);

  updateDirStat();
  renderPager(view);
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
  // 「自然在线」页的上传按钮跟着这里的勾选数走
  if ($('natUpBtn')) natSyncUpBtn();
  if ($('tagBatchBtn')) $('tagBatchBtn').disabled = n === 0 || S.mode !== 'album';
}

/* ---------------- 卡片交互：点图看大图 / 双击名字手填 / 物种名核对 ----------------
 * 单击缩略图 = 看大图；左上角小圆圈、名称区 = 勾选；双击名称区 = 手填中文名/拉丁名。
 * 勾选做成 220ms 延迟，是为了让双击的第二下不会顺手把勾去掉再勾回来。
 */
const NAME_EDIT = { box: null, timer: 0, onDoc: null };
const NC = { rows: [], targets: [], mode: 'local', applying: false };

const looksLatin = (s) => /^[A-Za-z][A-Za-z.\- ]{2,}$/.test(String(s || '').trim());
const PAIR_CAPTURE_RE = /(?:^|[^A-Za-z-])([A-Za-z][A-Za-z-]{2,})\s+([a-z][A-Za-z-]{1,})/;
// 调查批次、相机默认名里的中文不是物种名，别拿去反查学名
const GENERIC_CN_RE = /调查|照片|样地|样方|采集|记录|第|图片|图库|未命名|批次|截图/;

/** 从文件名里拆出中文名 / 学名；和服务端同口径，但纯中文名（没有学名）也认 */
function parseSpeciesPair(name) {
  const base = fileNameText(name);
  let latin = '';
  for (const g of base.match(PAREN_GROUP_RE) || []) {
    const inner = g.replace(/^[（(]/, '').replace(/[)）]$/, '').trim();
    if (LATIN_WORD_RE.test(inner)) { latin = inner; break; }
  }
  if (!latin) {
    const m = base.replace(PAREN_GROUP_RE, ' ').match(PAIR_CAPTURE_RE);
    if (m) latin = `${m[1]} ${m[2]}`;
  }
  if (!latin) {
    const m = base.match(CN_THEN_LATIN_RE);
    if (m) latin = m[1];
  }
  const cnMatch = base.replace(PAREN_GROUP_RE, ' ').match(/[\u4e00-\u9fa5·]{2,}/);
  const cn = cnMatch && !GENERIC_CN_RE.test(cnMatch[0]) ? cnMatch[0] : '';
  return { cn, latin };
}

/** 一张照片现在的物种名：站点/标签优先，文件名兜底；相册端还要读本机待上传的鉴定 */
function speciesPairOf(f) {
  let cn = '';
  let latin = '';
  if (isNatKey(f.path)) {
    const rec = NAT.renames.get(String(f.path).slice(NAT_KEY.length));
    if (rec && rec.status !== 'done') {
      cn = String(rec.chinese || '').trim();
      latin = String(rec.latin || '').trim();
    }
    const p = f.nat || {};
    if (!cn) cn = String(p.cname || '').trim();
    if (!latin) latin = String(p.lname || '').trim();
  } else {
    const lab = S.labels.get(f.path);
    if (lab) {
      const kws = (lab.kw || []).map((x) => String(x).trim()).filter(Boolean);
      latin = kws.find(looksLatin) || '';
      cn = kws.find((x) => !looksLatin(x)) || '';
      if (!cn && !looksLatin(lab.title)) cn = String(lab.title || '').trim();
      if (!latin && looksLatin(lab.title)) latin = String(lab.title || '').trim();
    }
  }
  const ff = parseSpeciesPair(f.name);
  if (!latin) latin = ff.latin;
  // 标签里已经有学名、文件名却只有中文时，不拿文件名里的中文硬凑成一个物种
  if (!cn && (!latin || ff.latin)) cn = ff.cn;
  return { cn, latin };
}

/** 只把某张图设为「当前」并刷右栏，不动勾选集合 */
function activateCard(p) {
  const prev = S.active;
  S.active = p;
  if (prev && prev !== p) patchCard(prev);
  patchCard(p);
  openPanel(p);
}

/** 本机端 / 相册端共用一套网格事件 */
function bindGridEvents(grid, withFolders) {
  grid.onclick = (e) => {
    if (withFolders) {
      const folder = e.target.closest('.card.folder');
      if (folder) { loadDir(folder.dataset.d); return; }
    }
    const card = e.target.closest('.card');
    if (!card || !card.dataset.p) return;
    const p = card.dataset.p;
    // 只有右下角放大镜打开大图；点缩略图本身只是选中
    if (e.target.closest('.zoom-btn')) {
      e.preventDefault();
      activateCard(p);
      openZoom();
      return;
    }
    if (e.target.closest('.thumb')) {
      // 小圆圈和状态徽标仍是勾选；点照片本身 = 选中
      if (e.target.closest('.tick') || e.target.closest('.badge')) { toggle(p); return; }
      activateCard(p);
      return;
    }
    if (e.detail > 1) return; // 双击的第二下不要重复勾选
    if (NAME_EDIT.timer) clearTimeout(NAME_EDIT.timer);
    NAME_EDIT.timer = setTimeout(() => { NAME_EDIT.timer = 0; toggle(p); }, 220);
  };
  grid.ondblclick = (e) => {
    const meta = e.target.closest('.meta');
    if (!meta) return;
    const card = meta.closest('.card');
    if (!card || !card.dataset.p || card.classList.contains('folder')) return;
    if (NAME_EDIT.timer) { clearTimeout(NAME_EDIT.timer); NAME_EDIT.timer = 0; }
    openNameEditor(card.dataset.p, meta);
  };
}

/* ---------------- 双击名称区：自己输入中文名 / 拉丁名 ---------------- */

function closeNameEditor() {
  if (NAME_EDIT.onDoc && typeof document !== 'undefined') {
    document.removeEventListener('click', NAME_EDIT.onDoc);
  }
  NAME_EDIT.onDoc = null;
  if (NAME_EDIT.box) NAME_EDIT.box.remove();
  NAME_EDIT.box = null;
}

function neField(labelText, cls, value, placeholder) {
  const wrap = document.createElement('label');
  wrap.className = 'ne-field';
  const span = document.createElement('span');
  span.textContent = labelText;
  const input = document.createElement('input');
  input.className = cls;
  input.type = 'text';
  input.value = value;
  input.placeholder = placeholder;
  input.spellcheck = false;
  wrap.appendChild(span);
  wrap.appendChild(input);
  return { wrap, input };
}

/**
 * 自动补名字：用户只填中文名或只填学名时，从内置《中国生物物种名录》/ 自然在线分类库
 * 补另一侧。只补空着的一侧，不覆盖用户已经写的；两侧都填就不动。
 */
async function autoFillNames(cnInput, laInput, btn, msgEl) {
  const cn = String((cnInput && cnInput.value) || '').trim();
  const latin = String((laInput && laInput.value) || '').trim();
  const say = (text, cls) => {
    if (!msgEl) return;
    msgEl.textContent = text || '';
    msgEl.className = `ne-auto-msg${cls ? ' ' + cls : ''}`;
  };
  if (!cn && !latin) {
    say('先填中文名或拉丁名，再点自动识别', 'bad');
    return;
  }
  if (cn && latin) {
    say('两侧都已填写；如需核对请直接保存', '');
    return;
  }
  if (!btn) return;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '识别中…';
  say('正在查物种名录…', '');
  try {
    const out = await post('/api/species/complete', {
      items: [{ key: 'name-edit', cn, latin }],
      online: true,
    });
    const it = (out.items || [])[0] || {};
    let filled = false;
    if (!cn && it.fillCn) { cnInput.value = it.fillCn; filled = true; }
    if (!latin && it.fillLatin) { laInput.value = it.fillLatin; filled = true; }
    if (filled) {
      const from = it.source || '物种名录';
      say(`已从${from}补齐，可直接保存`, 'ok');
      if (!cn && laInput.focus) laInput.focus();
      else if (!latin && cnInput.focus) cnInput.focus();
    } else if (it.state === 'ambiguous') {
      const n = (it.candidates || []).length;
      say(n ? `名录里有 ${n} 个同名候选，请手动选择` : (it.note || '名录里有多个同名，请手动填写'), 'bad');
    } else {
      say(it.note || '名录里没找到，请检查名字或手动填写', 'bad');
    }
  } catch (err) {
    say('自动识别失败：' + err.message, 'bad');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

function openNameEditor(p, anchor) {
  closeNameEditor();
  const files = Array.isArray(S.files) ? S.files : [];
  let f = S.byPath.get(p) || files.find((x) => x.path === p);
  // 自然在线页的站点照片不在 S.files 里，按 photoId 从 NAT.photos 找
  if (!f && isNatKey(p)) {
    const id = p.slice(NAT_KEY.length);
    const np = (NAT.photos || []).find((x) => String(x.photoId) === id);
    if (np) f = natPhotoAsFile(np);
  }
  if (!f) return;
  const album = isNatKey(p);
  const pair = speciesPairOf(f);
  const box = document.createElement('div');
  box.className = 'name-edit';
  const head = document.createElement('div');
  head.className = 'ne-head';
  const strong = document.createElement('b');
  strong.textContent = album ? '填写鉴定名（待上传）' : '填写物种名';
  const sub = document.createElement('span');
  sub.textContent = f.name;
  sub.title = f.name;
  head.appendChild(strong);
  head.appendChild(sub);
  box.appendChild(head);
  const cn = neField('中文名', 'ne-cn', pair.cn, '如：碧翠凤蝶');
  const la = neField('拉丁名', 'ne-la', pair.latin, '如：Papilio bianor');
  box.appendChild(cn.wrap);
  box.appendChild(la.wrap);
  const autoRow = document.createElement('div');
  autoRow.className = 'ne-auto-row';
  const autoBtn = document.createElement('button');
  autoBtn.type = 'button';
  autoBtn.className = 'ghost mini ne-auto';
  autoBtn.textContent = '自动识别';
  autoBtn.title = '只填一侧时，从物种名录补齐另一侧';
  const autoMsg = document.createElement('span');
  autoMsg.className = 'ne-auto-msg';
  autoRow.appendChild(autoBtn);
  autoRow.appendChild(autoMsg);
  box.appendChild(autoRow);
  autoBtn.onclick = () => autoFillNames(cn.input, la.input, autoBtn, autoMsg);
  const tip = document.createElement('div');
  tip.className = 'ne-tip';
  tip.textContent = album
    ? '保存后先存到本机「待上传鉴定」，再点「重新鉴定上传」同步到自然在线；不上传图片。'
    : '保存会写进图片标签，不改文件名、不移动照片。';
  box.appendChild(tip);
  const acts = document.createElement('div');
  acts.className = 'ne-acts';
  const cancel = document.createElement('button');
  cancel.className = 'ghost mini ne-cancel';
  cancel.textContent = '取消';
  const save = document.createElement('button');
  save.className = 'primary mini ne-save';
  save.textContent = '保存';
  acts.appendChild(cancel);
  acts.appendChild(save);
  box.appendChild(acts);
  document.body.appendChild(box);
  NAME_EDIT.box = box;

  const r = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: 24, bottom: 24 };
  const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280;
  const vh = (typeof window !== 'undefined' && window.innerHeight) || 800;
  box.style.left = `${Math.max(12, Math.min(vw - 322, Number(r.left) || 12))}px`;
  box.style.top = `${Math.max(12, Math.min(vh - 232, (Number(r.bottom) || 60) + 6))}px`;

  cancel.onclick = closeNameEditor;
  save.onclick = () => saveNameEdit(p, f, cn.input, la.input, save);
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeNameEditor();
    else if (e.key === 'Enter') saveNameEdit(p, f, cn.input, la.input, save);
  });
  NAME_EDIT.onDoc = (e) => {
    if (NAME_EDIT.box && !NAME_EDIT.box.contains(e.target)) closeNameEditor();
  };
  setTimeout(() => {
    if (NAME_EDIT.box === box && typeof document !== 'undefined') {
      document.addEventListener('click', NAME_EDIT.onDoc);
    }
  }, 0);
  if (cn.input.focus) cn.input.focus();
}

async function saveNameEdit(p, f, cnInput, laInput, saveBtn) {
  const cn = String((cnInput && cnInput.value) || '').trim();
  const latin = String((laInput && laInput.value) || '').trim();
  if (!cn && !latin) { toast('中文名和拉丁名至少填一个', 2600); return; }
  if (saveBtn) saveBtn.disabled = true;
  try {
    if (isNatKey(p)) {
      const photoId = String(p).slice(NAT_KEY.length);
      const ph = (NAT.photos || []).find((x) => String(x.photoId) === photoId) || f.nat || {};
      const rec = {
        photoId,
        albumId: String((NAT.album && NAT.album.id) || ph.albumId || ''),
        fileName: ph.fileName || ph.name || f.name || '',
        chinese: cn, latin, nameId: '',
        original: { cname: String(ph.cname || ''), lname: String(ph.lname || '') },
        status: 'pending', message: '', savedAt: Date.now(),
      };
      const out = await post('/api/nat/renames', { records: [rec] });
      NAT.renames = new Map((out.records || []).filter((x) => x && x.photoId).map((x) => [String(x.photoId), x]));
      refreshPendingBadge();
      patchAlbumCard(p);
      // 自然在线页的卡片不在 S.els 里，写完直接重铺当前这一页，让「待上传」立刻出现
      if (S.tab === 'nature') {
        if (NAT.side === 'album') renderNatPhotos();
        else renderNatLocal();
      }
      toast('已写入待上传鉴定，点「重新鉴定上传」同步站点', 3600);
    } else {
      await post('/api/write', { path: p, cn, latin, note: '', source: '手工填写', rename: false, archive: false });
      S.labels.set(p, { title: cn || latin, kw: [cn, latin].filter(Boolean) });
      S.written.add(p);
      patchCard(p);
      updateFilterCounts();
      if (S.active === p) openPanel(p);
      toast('物种名已写进图片标签', 2400);
    }
    closeNameEditor();
  } catch (err) {
    if (saveBtn) saveBtn.disabled = false;
    toast('保存失败：' + err.message, 4000);
  }
}

/* ---------------- 物种名核对：批量补齐只有一侧的名字 ---------------- */

/** 勾了就只核对勾选的；没勾核对当前这一屏（相册端是当前这一页） */
function nameCheckTargets() {
  const album = S.mode === 'album';
  const all = () => {
    if (album) return S.files || [];
    try { return pageView().all; } catch { return S.files || []; }
  };
  if (S.sel.size) return all().filter((f) => S.sel.has(f.path)).slice(0, 400);
  const onePage = () => {
    if (album) return S.files || [];
    try { return pageView().items; } catch { return S.files || []; }
  };
  return onePage().slice(0, 400);
}

function ncItemsFrom(targets) {
  return targets.map((f) => {
    const pair = speciesPairOf(f);
    const lab = S.labels.get(f.path);
    return {
      key: f.path, fileName: f.name,
      cn: pair.cn, latin: pair.latin,
      labelTitle: lab ? String(lab.title || '') : '',
      labelKeywords: lab ? (lab.kw || []).map(String) : [],
    };
  });
}

function ncRowHtml(r, i) {
  const dim = r.state === 'complete' || r.state === 'empty' ? ' dim' : '';
  const note = r.state === 'filled'
    ? `✓ ${r.source || '名录'}补上了${r.cn ? '' : '中文名'}${r.latin ? '' : '学名'}，可再改`
    : r.state === 'ambiguous' ? '⚠ 多个学名共用这个中文名，请从候选里挑一个'
      : r.state === 'unresolved' ? `× ${r.note || '查不到'}，可自己填；或勾「联网补查」`
        : r.state === 'complete' ? (r.note ? `已完整 · ${r.note}` : '中文名与学名都齐了')
          : '没有物种名，先识别或双击卡片名称手填';
  const cls = r.state === 'filled' ? 'ok' : (r.state === 'ambiguous' || r.state === 'unresolved') ? 'warn' : '';
  const cand = (r.candidates || []).length
    ? `<select class="nc-pick" data-i="${i}"><option value="">从候选里挑一个学名…</option>${r.candidates
        .map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}</select>`
    : '';
  return `<div class="nc-row${dim}" data-i="${i}" data-key="${esc(r.key)}">
    <div class="nc-row-file" title="${esc(r.fileName)}">${esc(r.fileName)}</div>
    <div class="nc-row-cur">现有：中文 ${esc(r.cn || '—')} ｜ 学名 ${esc(r.latin || '—')}</div>
    <div class="nc-row-fields">
      <label><span>中文名</span><input class="nc-cn" value="${esc(r.fillCn || r.cn)}" placeholder="中文名"></label>
      <label><span>学名</span><input class="nc-la" value="${esc(r.fillLatin || r.latin)}" placeholder="学名"></label>
    </div>
    ${cand}
    <div class="nc-row-note ${cls}">${esc(note)}</div>
  </div>`;
}

function ncRender() {
  const rows = NC.rows;
  const s = { filled: 0, ambiguous: 0, unresolved: 0, complete: 0, empty: 0 };
  for (const r of rows) if (s[r.state] !== undefined) s[r.state] += 1;
  $('ncSummary').textContent =
    `扫描 ${rows.length} 张 · 可补齐 ${s.filled} · 重名待选 ${s.ambiguous} · 查不到 ${s.unresolved} · 已完整 ${s.complete} · 无名字 ${s.empty}`;
  $('ncList').innerHTML = rows.length
    ? rows.slice(0, 300).map(ncRowHtml).join('') + (rows.length > 300 ? '<div class="nc-row nc-row-note">只显示前 300 张，其余请翻页或勾选后再核对</div>' : '')
    : '<div class="empty" style="padding:16px">这一屏没有照片</div>';
  $('ncApply').disabled = !rows.length || NC.applying;
  $('ncTip').textContent = NC.mode === 'album'
    ? '用内置《中国生物物种名录》离线查表：只有学名补中文、只有中文补学名；重名的列候选让你挑，查不到的可勾「联网补查」。默认核对相册当前这一页，勾了照片就只核对勾选的。确认后名字先存本机「待上传鉴定」，在自然在线页点「重新鉴定上传」才同步站点；全程不上传图片。'
    : '用内置《中国生物物种名录》离线查表：只有学名补中文、只有中文补学名；重名的列候选让你挑，查不到的可勾「联网补查」。默认核对当前这一页，勾了照片就只核对勾选的。确认后写进图片标签，不改文件名、不移动照片；建议值可以直接改。';
}

async function nameCheckRun() {
  if (!NC.targets.length) { $('ncErr').textContent = '这一屏没有可核对的照片'; return; }
  const online = Boolean($('ncOnline') && $('ncOnline').checked);
  $('ncSummary').textContent = `正在核对 ${NC.targets.length} 张…`;
  $('ncApply').disabled = true;
  $('ncErr').textContent = '';
  try {
    const out = await post('/api/species/complete', { items: ncItemsFrom(NC.targets), online });
    NC.rows = out.items || [];
    ncRender();
  } catch (err) {
    $('ncErr').textContent = '核对失败：' + err.message;
    $('ncSummary').textContent = '核对没跑起来';
  }
}

function openNameCheck() {
  closeNameEditor();
  NC.targets = nameCheckTargets();
  NC.mode = S.mode === 'album' ? 'album' : 'local';
  NC.rows = [];
  NC.applying = false;
  $('nameCheckMask').classList.add('show');
  $('ncErr').textContent = '';
  $('ncList').innerHTML = '';
  $('ncApply').disabled = true;
  if (!NC.targets.length) {
    $('ncSummary').textContent = '这一屏没有照片，先在左边选个文件夹或相册';
    return;
  }
  nameCheckRun();
}

function closeNameCheck() {
  const m = $('nameCheckMask');
  if (m) m.classList.remove('show');
}

/** 把弹窗里改动过的名字写回：本机端写图片标签，相册端存本机待上传鉴定 */
async function ncApply() {
  if (NC.applying) return;
  const els = [...$('ncList').querySelectorAll('.nc-row')];
  const changes = [];
  for (const el of els) {
    const r = NC.rows[Number(el.dataset.i)];
    if (!r) continue;
    const ci = el.querySelector('.nc-cn');
    const li = el.querySelector('.nc-la');
    const cn = String((ci && ci.value) || '').trim();
    const latin = String((li && li.value) || '').trim();
    if ((cn || latin) && (cn !== r.cn || latin !== r.latin)) {
      changes.push({ key: r.key, fileName: r.fileName, cn, latin });
    }
  }
  if (!changes.length) { toast('没有要写入的改动', 2200); return; }
  const tip = NC.mode === 'album'
    ? `确认把 ${changes.length} 张补齐的鉴定名存到本机「待上传鉴定」？\n之后在自然在线页点「重新鉴定上传」才同步到站点，不上传图片。`
    : `确认把 ${changes.length} 张补齐的物种名写进图片标签？\n不改文件名、不移动照片。`;
  if (!window.confirm(tip)) return;
  NC.applying = true;
  $('ncApply').disabled = true;
  let ok = 0;
  let fail = 0;
  try {
    if (NC.mode === 'album') {
      const records = changes.map((c) => {
        const photoId = String(c.key).slice(NAT_KEY.length);
        const ph = (NAT.photos || []).find((x) => String(x.photoId) === photoId) || {};
        return {
          photoId,
          albumId: String((NAT.album && NAT.album.id) || ph.albumId || ''),
          fileName: ph.fileName || ph.name || c.fileName,
          chinese: c.cn, latin: c.latin, nameId: '',
          original: { cname: String(ph.cname || ''), lname: String(ph.lname || '') },
          status: 'pending', message: '', savedAt: Date.now(),
        };
      });
      const out = await post('/api/nat/renames', { records });
      NAT.renames = new Map((out.records || []).filter((x) => x && x.photoId).map((x) => [String(x.photoId), x]));
      refreshPendingBadge();
      for (const c of changes) patchAlbumCard(c.key);
      ok = changes.length;
    } else {
      for (const c of changes) {
        try {
          await post('/api/write', {
            path: c.key, cn: c.cn, latin: c.latin, note: '', source: '物种名核对', rename: false, archive: false,
          });
          S.labels.set(c.key, { title: c.cn || c.latin, kw: [c.cn, c.latin].filter(Boolean) });
          S.written.add(c.key);
          patchCard(c.key);
          ok += 1;
        } catch { fail += 1; }
      }
      updateFilterCounts();
      if (S.active) openPanel(S.active);
      render();
    }
    toast(fail ? `已补齐 ${ok} 张，失败 ${fail} 张` : `已补齐 ${ok} 张照片的名字`, 3200);
    closeNameCheck();
  } catch (err) {
    $('ncErr').textContent = '写入失败：' + err.message;
  } finally {
    NC.applying = false;
    $('ncApply').disabled = false;
  }
}

function bindNameCheck() {
  if ($('nameCheckBtn')) $('nameCheckBtn').onclick = openNameCheck;
  if ($('ncCancel')) $('ncCancel').onclick = closeNameCheck;
  if ($('ncRedo')) $('ncRedo').onclick = nameCheckRun;
  if ($('ncOnline')) $('ncOnline').onchange = nameCheckRun;
  if ($('ncApply')) $('ncApply').onclick = ncApply;
  if ($('ncList')) {
    $('ncList').onchange = (e) => {
      const sel = e.target.closest && e.target.closest('.nc-pick');
      if (!sel || !sel.value) return;
      const row = sel.closest('.nc-row');
      const la = row && row.querySelector ? row.querySelector('.nc-la') : null;
      if (la) la.value = sel.value;
    };
  }
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
    S.page = 1; // 换筛选等于换了一批图，页码从头开始才不会莫名其妙停在第 9 页
    [...$('filterSeg').children].forEach((x) => x.classList.toggle('on', x === b));
    $('selAll').textContent = S.filter === 'nolatin' ? '全选没有学名' : '全选未标注';
    render();
  };
  bindPager();
  $('selAll').onclick = () => {
    // 相册端：把这一页的相册照片全勾上（没有「未标注」这个概念，统统可选）
    if (S.mode === 'album') {
      for (const f of S.files) S.sel.add(f.path);
      for (const f of S.files) patchAlbumCard(f.path);
      updateCount();
      return;
    }
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
  $('exportBtn').onclick = doExport;
  $('runBtn').onclick = runIdentify;
  $('writeBtn').onclick = doWrite;
  $('nextPhotoBtn').onclick = nextPhotoClick;
}

/**
 * 翻页条。
 *
 * 键盘左右键也能翻，但只在「焦点不在输入框/下拉框」时才接管 ——
 * 否则在路径框、手动填名框里按左右键会被抢去翻页，很难用。
 */
function bindPager() {
  const curPage = () => (S.mode === 'album' ? NAT.page : S.page);
  $('pgPrev').onclick = () => gotoPage(curPage() - 1);
  $('pgNext').onclick = () => gotoPage(curPage() + 1);
  $('pgSize').onchange = (e) => {
    const v = Number(e.target.value);
    S.pageSize = PAGE_SIZES.includes(v) ? v : 120;
    try {
      localStorage.setItem(PAGE_KEY, String(S.pageSize));
    } catch {}
    S.page = 1;
    $('grid').scrollTop = 0;
    if (S.mode === 'album') {
      NAT.size = S.pageSize || 120;
      NAT.page = 1;
      loadAlbumPhotos();
      return;
    }
    render();
  };
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target;
    if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;
    if (t && t.isContentEditable) return;
    if (document.querySelector('.mask.show')) return;
    if ($('pager').hidden) return;
    e.preventDefault();
    gotoPage(S.page + (e.key === 'ArrowRight' ? 1 : -1));
  });
}

/* ---------------- 识别 ---------------- */

async function runIdentify() {
  // 相册端：走 /api/nat/identify，图和名字都在站点上
  if (S.mode === 'album') return runIdentifyAlbum();
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

async function identifyOne(p, opts = {}) {
  S.busy.add(p);
  patchCard(p);
  try {
    const variants = await makeVariants(p);
    const body = { path: p, sources: S.state.current.sources, force: opts.force === true, ...variants };
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

/** 相册端批量识别：同一套两并发队列，识别结果按 nat:<photoId> 存进 S.results */
async function runIdentifyAlbum() {
  const keys = [...S.sel];
  if (!keys.length) return toast('先勾选要识别的照片');
  S.queue = keys.length;
  updateCount();
  let done = 0;
  const queue = keys.slice();
  const worker = async () => {
    while (queue.length) {
      const k = queue.shift();
      await identifyAlbumOne(k);
      done += 1;
      S.queue = queue.length;
      updateCount();
    }
  };
  await Promise.all([worker(), worker()]);
  S.queue = 0;
  updateCount();
  toast(`识别完成 ${done} 张`);
}

async function identifyAlbumOne(key, opts = {}) {
  const id = key.slice(NAT_KEY.length);
  const ph = NAT.photos.find((x) => x.photoId === id);
  if (!ph) return;
  S.busy.add(key);
  patchAlbumCard(key);
  try {
    const variants = await natVariants(ph);
    const r = await post('/api/nat/identify', {
      url: ph.full || ph.thumb,
      name: ph.fileName || '',
      sources: S.state.current.sources,
      force: opts.force === true,
      ...variants,
    });
    S.results.set(key, r);
    if (S.active === key) openPanel(key);
  } catch (err) {
    S.results.set(key, { rows: [], sites: {}, error: err.message });
    if (S.active === key) openPanel(key);
  } finally {
    S.busy.delete(key);
    patchAlbumCard(key);
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

/* ---------------- 大图查看：点右栏预览图打开 ----------------
 * 变换写成 translate(tx,ty) scale(s)，transform-origin 默认居中。
 * 屏幕坐标 m 与图上一点 p 的关系是 m = t + s*p；换到新倍率 s' 时，
 * 要让鼠标底下那一点不跑，就得 t' = m - (s'/s)*(m - t)。
 * 图不落磁盘、也不另开接口：/img?path=... 不带 thumb 就是原图。
 */
const ZOOM = { path: '', s: 1, tx: 0, ty: 0, fit: 1, drag: null, moved: false };

function zoomShown() {
  const m = $('zoomMask');
  return Boolean(m && m.classList.contains('show'));
}

/** 1 倍 = 适应窗口，图被 CSS 缩到窗口里的比例就是 fit */
function zoomFit() {
  const img = $('zoomImg');
  if (!img || !img.naturalWidth || !img.offsetWidth) return 1;
  return img.offsetWidth / img.naturalWidth || 1;
}

function zoomPaint() {
  const img = $('zoomImg');
  if (img) img.style.transform = `translate(${ZOOM.tx}px, ${ZOOM.ty}px) scale(${ZOOM.s})`;
  const pct = $('zoomPct');
  if (pct) pct.textContent = `${Math.round(ZOOM.s * ZOOM.fit * 100)}%`;
  const st = $('zoomStage');
  if (st) st.classList.toggle('grabbable', ZOOM.s > 1.001);
}

/** 别把图拖得连边都找不着；jsdom 里没有布局，一律跳过 */
function zoomClamp() {
  const st = $('zoomStage');
  const img = $('zoomImg');
  if (!st || !img) return;
  const sw = st.clientWidth;
  const sh = st.clientHeight;
  const hw = (img.offsetWidth * ZOOM.s) / 2;
  const hh = (img.offsetHeight * ZOOM.s) / 2;
  if (!sw || !sh || !hw || !hh) return;
  const mx = Math.max(0, hw + sw / 2 - 48);
  const my = Math.max(0, hh + sh / 2 - 48);
  ZOOM.tx = Math.min(mx, Math.max(-mx, ZOOM.tx));
  ZOOM.ty = Math.min(my, Math.max(-my, ZOOM.ty));
}

function zoomSet(next, anchor) {
  const s2 = Math.min(16, Math.max(0.2, next));
  const k = s2 / ZOOM.s;
  const a = anchor || { x: 0, y: 0 };
  ZOOM.tx = a.x - k * (a.x - ZOOM.tx);
  ZOOM.ty = a.y - k * (a.y - ZOOM.ty);
  ZOOM.s = s2;
  zoomClamp();
  zoomPaint();
}

function zoomReset() {
  ZOOM.s = 1;
  ZOOM.tx = 0;
  ZOOM.ty = 0;
  zoomPaint();
}

/** 原始大小：一个原图像素对一个屏幕像素，也就是 s = 1/fit */
function zoomActual() {
  const img = $('zoomImg');
  if (!img || !img.naturalWidth) return;
  ZOOM.fit = zoomFit();
  zoomReset();
  zoomSet(1 / (ZOOM.fit || 1), { x: 0, y: 0 });
}

function zoomAnchor(e, st) {
  const r = st.getBoundingClientRect();
  return {
    x: (Number(e.clientX) || 0) - r.left - r.width / 2,
    y: (Number(e.clientY) || 0) - r.top - r.height / 2,
  };
}

function zoomList() {
  try {
    // 自然在线页看的是站点相册：没有 S.files 的本地路径，用 NAT.photos 拼同样的伪文件
    if (S.tab === 'nature' && NAT.side === 'album') return (NAT.photos || []).map(natPhotoAsFile);
    return pageView().all || [];
  } catch { return []; }
}

function zoomIndexText(p) {
  const all = zoomList();
  const i = all.findIndex((x) => x.path === p);
  return i < 0 ? '' : `${i + 1} / ${all.length}`;
}

function zoomLoad(p) {
  const files = Array.isArray(S.files) ? S.files : [];
  let f = S.byPath.get(p) || files.find((x) => x.path === p);
  // 自然在线页的站点照片不在 S.files 里，按 photoId 从 NAT.photos 找
  if (!f && isNatKey(p)) {
    const id = p.slice(NAT_KEY.length);
    const np = (NAT.photos || []).find((x) => String(x.photoId) === id);
    if (np) f = natPhotoAsFile(np);
  }
  const img = $('zoomImg');
  if (img) {
    // 相册照片没有本地路径，原图要从站点的图片接口拿
    img.src =
      isNatKey(p) && f && f.nat
        ? `/api/nat/img?u=${enc(f.nat.full || f.nat.thumb || '')}`
        : `/img?path=${enc(p)}`;
    img.alt = f ? f.name : '';
  }
  if ($('zoomName')) $('zoomName').textContent = f ? f.name : p;
  if ($('zoomIdx')) $('zoomIdx').textContent = S.mode === 'album' ? '' : zoomIndexText(p);
  ZOOM.path = p;
}

function openZoom() {
  const p = S.active;
  if (!p || !$('zoomMask')) return;
  ZOOM.s = 1;
  ZOOM.tx = 0;
  ZOOM.ty = 0;
  ZOOM.moved = false;
  ZOOM.drag = null;
  zoomLoad(p);
  $('zoomMask').classList.add('show');
  ZOOM.fit = zoomFit();
  zoomPaint();
}

function closeZoom() {
  const m = $('zoomMask');
  if (m) m.classList.remove('show');
  ZOOM.drag = null;
  const st = $('zoomStage');
  if (st) st.classList.remove('dragging');
}

/** 翻到本层筛选结果里的上一张/下一张；右侧详情和网格高亮一起跟着走 */
function zoomStep(d) {
  // 自然在线页的站点相册：在本页 NAT.photos 里翻
  if (S.tab === 'nature' && NAT.side === 'album') {
    const list = NAT.photos || [];
    if (!list.length) return;
    let i = list.findIndex((x) => NAT_KEY + String(x.photoId) === ZOOM.path);
    if (i < 0) i = 0;
    const j = Math.min(list.length - 1, Math.max(0, i + d));
    if (j === i) return;
    const p = NAT_KEY + String(list[j].photoId);
    ZOOM.s = 1;
    ZOOM.tx = 0;
    ZOOM.ty = 0;
    S.active = p;
    zoomLoad(p);
    zoomPaint();
    return;
  }
  // 标注页的相册端：在「相册这一页」里翻，不掺本机那套分页换算
  if (S.mode === 'album') {
    const list = S.files || [];
    if (!list.length) return;
    let i = list.findIndex((x) => x.path === ZOOM.path);
    if (i < 0) i = 0;
    const j = Math.min(list.length - 1, Math.max(0, i + d));
    if (j === i) return;
    const p = list[j].path;
    ZOOM.s = 1;
    ZOOM.tx = 0;
    ZOOM.ty = 0;
    S.active = p;
    patchAlbumCard(p);
    openPanel(p);
    zoomLoad(p);
    zoomPaint();
    return;
  }
  const all = zoomList();
  if (!all.length) return;
  let i = all.findIndex((x) => x.path === ZOOM.path);
  if (i < 0) i = 0;
  const j = Math.min(all.length - 1, Math.max(0, i + d));
  if (j === i) return;
  const p = all[j].path;
  ZOOM.s = 1;
  ZOOM.tx = 0;
  ZOOM.ty = 0;
  zoomLoad(p);
  S.active = p;
  let size = S.pageSize || 0;
  try { size = pageView().size || size; } catch { /* 还没载入文件夹 */ }
  S.page = Math.floor(j / (size || Math.max(all.length, 1))) + 1;
  render();
  openPanel(p);
  zoomPaint();
}

function bindZoom() {
  const m = $('zoomMask');
  const st = $('zoomStage');
  if (!m || !st) return;

  if ($('pvPreview')) $('pvPreview').onclick = openZoom;
  $('zoomClose').onclick = closeZoom;
  $('zoomPrev').onclick = () => zoomStep(-1);
  $('zoomNext').onclick = () => zoomStep(1);
  $('zoomIn').onclick = () => zoomSet(ZOOM.s * 1.25, { x: 0, y: 0 });
  $('zoomOut').onclick = () => zoomSet(ZOOM.s / 1.25, { x: 0, y: 0 });
  $('zoomFitBtn').onclick = zoomReset;
  $('zoomOne').onclick = zoomActual;
  m.addEventListener('click', (e) => { if (e.target === m) closeZoom(); });

  $('zoomImg').addEventListener('load', () => {
    ZOOM.fit = zoomFit();
    zoomPaint();
  });
  window.addEventListener('resize', () => {
    if (!zoomShown()) return;
    ZOOM.fit = zoomFit();
    zoomPaint();
  });

  // passive:false 才能 preventDefault，否则滚轮会带着背后的页面一起滚
  st.addEventListener('wheel', (e) => {
    if (!zoomShown()) return;
    e.preventDefault();
    const k = Math.exp(-(Number(e.deltaY) || 0) * (e.deltaMode === 1 ? 0.03 : 0.0015));
    zoomSet(ZOOM.s * k, zoomAnchor(e, st));
  }, { passive: false });

  // 拖拽不用 setPointerCapture（这里实测会丢事件），move/up 挂 document，松手摘掉
  const onMove = (e) => {
    const d = ZOOM.drag;
    if (!d) return;
    const dx = (Number(e.clientX) || 0) - d.x;
    const dy = (Number(e.clientY) || 0) - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) ZOOM.moved = true;
    ZOOM.tx = d.tx + dx;
    ZOOM.ty = d.ty + dy;
    zoomClamp();
    zoomPaint();
  };
  const onUp = () => {
    ZOOM.drag = null;
    st.classList.remove('dragging');
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onUp);
  };
  st.addEventListener('pointerdown', (e) => {
    if (!zoomShown() || e.button !== 0) return;
    e.preventDefault();
    ZOOM.moved = false;
    ZOOM.drag = { x: Number(e.clientX) || 0, y: Number(e.clientY) || 0, tx: ZOOM.tx, ty: ZOOM.ty };
    st.classList.add('dragging');
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  });

  // 点图片外的暗区也能关；延后一点，免得双击被当成两次单击提前关掉
  let clickTimer = 0;
  st.addEventListener('click', (e) => {
    if (!zoomShown() || e.target !== st || ZOOM.moved) return;
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => { if (zoomShown()) closeZoom(); }, 220);
  });
  st.addEventListener('dblclick', (e) => {
    clearTimeout(clickTimer);
    e.preventDefault();
    if (ZOOM.s > 1.01) zoomReset();
    else zoomSet(2, zoomAnchor(e, st));
  });

  // capture 阶段先吃掉按键，别让标注页翻页、评分详情抽屉等监听跟着响应
  document.addEventListener('keydown', (e) => {
    if (!zoomShown()) return;
    const k = e.key;
    if (k === 'Escape') closeZoom();
    else if (k === '+' || k === '=') zoomSet(ZOOM.s * 1.25, { x: 0, y: 0 });
    else if (k === '-' || k === '_') zoomSet(ZOOM.s / 1.25, { x: 0, y: 0 });
    else if (k === '0') zoomReset();
    else if (k === 'ArrowLeft') zoomStep(-1);
    else if (k === 'ArrowRight') zoomStep(1);
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);
}

/* ---------------- 右侧详情 ---------------- */

const SITE_NAME = () => Object.fromEntries((S.state?.siteMeta || []).map((m) => [m.key, m.name]));

/* ---------------- 候选物种的科属悬停 ---------------- */
/** 和服务端 /api/taxonomy 的 key 口径一致：优先学名，没学名才用中文名 */
function taxoKeyOf(latin, cn) {
  const l = String(latin || '').trim();
  if (l) return l.toLowerCase();
  const c = String(cn || '').trim();
  return c ? `cn:${c.toLowerCase()}` : '';
}

/** 识别结果出来后顺手把前几个候选的科属查回来（服务端有缓存，断网也不影响识别） */
async function prefetchTaxo(rows) {
  const want = (rows || []).slice(0, 8)
    .map((r) => ({ latin: String(r.latin || '').trim(), cn: String(r.cn || '').trim() }))
    .filter((x) => x.latin || x.cn)
    .filter((x, i, arr) => arr.findIndex((y) => taxoKeyOf(y.latin, y.cn) === taxoKeyOf(x.latin, x.cn)) === i)
    .filter((x) => !S.taxo.has(taxoKeyOf(x.latin, x.cn)));
  if (!want.length) return;
  for (const x of want) S.taxo.set(taxoKeyOf(x.latin, x.cn), { pending: true });
  try {
    const out = await post('/api/taxonomy', { items: want });
    for (const [k, v] of Object.entries(out.items || {})) S.taxo.set(k, v || null);
    for (const x of want) {
      const k = taxoKeyOf(x.latin, x.cn);
      if (S.taxo.get(k) && S.taxo.get(k).pending) S.taxo.set(k, null);
    }
  } catch {
    for (const x of want) S.taxo.set(taxoKeyOf(x.latin, x.cn), null);
  }
  // 查询回来时鼠标可能还停在这个候选上：直接把浮层内容刷新，别让人移开再移回
  taxoTipRefresh();
}

function taxoLine(label, v, fallback) {
  const cn = v && v.cn ? esc(v.cn) : '';
  const la = v && v.latin ? v.latin : '';
  const body = cn && la ? `${cn} <span class="tl">${esc(la)}</span>`
    : cn || (la ? `<span class="tl">${esc(la)}</span>` : '')
      || (fallback ? `<span class="tl">${esc(fallback)}</span><span class="tw">（按学名推断）</span>` : '<span class="tw">—</span>');
  return `<div><b>${label}</b> ${body}</div>`;
}

function taxoTipHtml(b) {
  const rec = S.taxo.get(taxoKeyOf(b.dataset.latin, b.dataset.cn));
  return taxoLine('科', rec && rec.family, '')
    + taxoLine('属', rec && rec.genus, b.dataset.genus || '')
    + (rec && rec.pending ? '<div class="tw">科属查询中…</div>' : '');
}

/** 科属是异步查的：查完时鼠标可能还没移走，把浮层就地刷新一下 */
function taxoTipRefresh() {
  const tip = $('taxoTip');
  if (!tip || tip.hidden || tip.dataset.i === undefined) return;
  const list = $('candList');
  const b = list && list.querySelector(`.cand[data-i="${tip.dataset.i}"]`);
  if (b) tip.innerHTML = taxoTipHtml(b);
}

/** 事件委托挂在 #candList 上：候选列表每次 openPanel 都会重绘，不能逐个绑 */
function bindTaxoTip() {
  const list = $('candList');
  const tip = $('taxoTip');
  if (!list || !tip) return;
  const place = (e) => {
    const w = tip.offsetWidth || 200;
    const h = tip.offsetHeight || 60;
    const x = e.clientX + 14 + w > window.innerWidth ? e.clientX - w - 12 : e.clientX + 14;
    const y = e.clientY + 16 + h > window.innerHeight ? e.clientY - h - 12 : e.clientY + 16;
    tip.style.left = `${Math.max(4, x)}px`;
    tip.style.top = `${Math.max(4, y)}px`;
  };
  list.addEventListener('mouseover', (e) => {
    const b = e.target.closest && e.target.closest('.cand');
    if (!b) return;
    tip.dataset.i = b.dataset.i;
    tip.innerHTML = taxoTipHtml(b);
    tip.hidden = false;
    place(e);
  });
  list.addEventListener('mousemove', (e) => {
    if (!tip.hidden) place(e);
  });
  list.addEventListener('mouseout', (e) => {
    if (!e.relatedTarget || !list.contains(e.relatedTarget)) tip.hidden = true;
  });
}

/* ---------------- 右侧面板：每张照片各存各的手填草稿 ----------------
 * 以前切换照片时三个输入框完全不清，下一张会「继承」上一张手填的物种名和备注，
 * 自动跳下一张时尤其容易误写。这里改成按路径存草稿：换片不继承、切回还在。 */
const PANEL = { last: '', drafts: new Map() };

function panelSwapDraft(p) {
  const cn = $('inCn'); const la = $('inLatin'); const note = $('inNote');
  if (!cn || !la || !note) return;
  if (PANEL.last && PANEL.last !== p) {
    PANEL.drafts.set(PANEL.last, { cn: cn.value, latin: la.value, note: note.value });
    const d = PANEL.drafts.get(p);
    cn.value = d ? d.cn : '';
    la.value = d ? d.latin : '';
    note.value = d ? d.note : '';
  }
  PANEL.last = p;
}

function openPanel(p) {
  // 相册照片（nat:<photoId>）走相册端的面板：图片、各站、候选、写回
  if (isNatKey(p)) return openAlbumPanel(p);
  const f = S.files.find((x) => x.path === p);
  if (!f) return;
  panelSwapDraft(p);
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
  // 各站明细跟着候选一起画：这里不分支，没结果时它自己会列出每个站的失败原因
  pvSitesPaint(r);
  const list = $('candList');
  if (!r) {
    list.innerHTML = `<div class="dim" style="padding:6px 2px">还没识别。勾上这张图，点右上「识别选中」。</div>`;
    $('pvVerdict').textContent = '';
  } else if (r.error) {
    list.innerHTML = `<div class="msg err">${esc(r.error)}</div>`;
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
    // 命中本机缓存时给一条提示和「重新识别」入口，避免一次旧结果被锁 30 天
    const cacheNote = r.cached
      ? '<div class="dim" style="padding:2px 2px 6px;font-size:11.5px">本机缓存 · <a href="#" data-reid="1" style="color:inherit;text-decoration:underline">重新识别</a></div>'
      : '';
    // 服务端现在回 15 行（完整结果表要用），窄面板里只列前 8，剩下的去「完整结果」看
    list.innerHTML = cacheNote + r.rows
      .slice(0, 8)
      .map((row, i) => {
        const srcs = Object.keys(row.bySite || {}).map((k) => names[k] || k).join('、');
        return `<button class="cand" data-i="${i}" data-latin="${esc(row.latin || '')}" data-cn="${esc(row.cn || '')}" data-genus="${esc(row.genus || '')}" title="鼠标停一下看科、属">
          <span class="pct">${row.pct}%</span>
          <span class="nm"><div class="cn">${row.cn || '（无中文名）'}</div><div class="la">${row.latin || ''}</div></span>
          <span class="src" title="${srcs}">${row.support} 票</span>
        </button>`;
      })
      .join('');
    list.onclick = (e) => {
      const reid = e.target.closest('[data-reid]');
      if (reid) {
        e.preventDefault();
        identifyOne(p, { force: true });
        return;
      }
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
    // 候选的科属异步查一次（结果存 S.taxo，悬停时直接读），断网也不挡着写入
    prefetchTaxo(r.rows);
    // 默认把第一候选填进手动框，用户直接点写入也能成
    const top = r.rows[0];
    $('inCn').value = top.cn || '';
    $('inLatin').value = top.latin || '';
    list.querySelector('.cand')?.classList.add('on');
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

/* ---------------- 归档 ---------------- */

/**
 * 归档只剩「预览 + 确认」这一步：范围在「按分类归档」页面上勾选，
 * 这里只负责把将要发生的事说清楚，用户点头才真的动文件。
 */
const ARCH = { payload: null };
/** 预览文案：分类文件夹太长会挤爆弹层，中间省略成 界/…/科/属 */
function archShort(p) {
  const seg = String(p).split('/');
  return seg.length > 4 ? `${seg[0]}/…/${seg.slice(-2).join('/')}` : p;
}

function archPreviewHtml(pre) {
  const rows = pre.groups
    .slice(0, 10)
    .map((g) => `<li>${esc(archShort(g.name))} <b>${g.count}</b> 张</li>`)
    .join('');
  const more = pre.groups.length > 10 ? `<li>… 还有 ${pre.groups.length - 10} 个分类文件夹</li>` : '';
  const bits = [];
  if (pre.exists) bits.push(`目标里已经有 <b>${pre.exists}</b> 张（跳过，不重复放一份）`);
  if (pre.already) bits.push(`已经在分类文件夹里的 <b>${pre.already}</b> 张（跳过）`);
  if (pre.skipped) bits.push(`没有物种名的 <b>${pre.skipped}</b> 张（跳过）`);
  if (pre.unknown) bits.push(`查不到分类的 <b>${pre.unknown}</b> 张（放进「未分类」）`);
  if (pre.truncated) bits.push(`一次最多处理 ${pre.scanned} 张，这次到上限了，剩下的可以再点一次`);
  const verb = pre.copy ? '复制' : '移动';
  const place = pre.copy ? '复制到' : '移动到';
  const depth = pre.bySpecies ? '（到「种」级，每个物种一个文件夹）' : '（到「属」级，同属物种共用一个属文件夹）';
  return (
    `<div>会${verb} <b>${pre.willMove}</b> 张图片（${pre.species} 个物种）${place} ` +
    `<span class="arch-destpath">${esc(pre.dest || '')}</span> 下的 ${pre.groups.length} 个分类文件夹${depth}：</div>` +
    (rows ? `<ul class="arch-groups">${rows}${more}</ul>` : '') +
    (bits.length ? `<div class="arch-sub">${bits.join('<br>')}</div>` : '') +
    `<div class="arch-sub">${pre.copy ? '原图不会被删除。' : '移动后不能撤销。'}继续吗？</div>`
  );
}

/**
 * 预览 + 确认入口：范围在「按分类归档」页面勾好，这里只负责把结果说清楚。
 */
async function archPreviewFlow(body) {
  ARCH.payload = { ...body, apply: true };
  $('archPreviewStep').hidden = false;
  $('archPreviewText').innerHTML = '<span class="spin"></span> 正在查分类…（第一次要联网，可能几十秒）';
  $('archGo').textContent = '开始归档';
  $('archGo').disabled = true;
  $('archMask').classList.add('show');

  try {
    const pre = await post('/api/archive', { ...body, apply: false });
    if (!pre.willMove) {
      const why = pre.exists
        ? `目标文件夹里已经有这 ${pre.exists} 张了，不用再归并一次`
        : pre.already
          ? `这些图片都已经在分类文件夹里了（${pre.already} 张），不用再重排`
          : pre.skipped
            ? '这些图片没有物种名（标签和文件名里都没有学名），没法分类'
            : '这个范围里没有可归档的图片';
      toast(why, 4400);
      archClose();
      return;
    }
    $('archPreviewText').innerHTML = archPreviewHtml(pre);
    $('archGo').disabled = false;
  } catch (err) {
    toast(err.message, 4200);
    archClose();
  }
}

async function archGo() {
  return archApply();
}

async function archApply() {
  const btn = $('archGo');
  btn.disabled = true;
  btn.textContent = '归并中…';
  $('archPreviewStep').hidden = true;
  $('archProgress').hidden = false;
  setArchProgress(null, '准备中…', '');
  try {
    const start = await post('/api/archive', ARCH.payload); // payload.apply===true → 后台任务
    if (!start.ok) throw new Error(start.error || '无法启动归并');
    const id = start.jobId;
    let last = null;
    while (true) {
      const j = await api(`/api/archive/job/${encodeURIComponent(id)}`);
      if (!j.ok) throw new Error(j.error || '任务查询失败');
      last = j;
      if (j.finished) break;
      const pct = j.total ? Math.min(100, Math.round((j.done / j.total) * 100)) : null;
      setArchProgress(pct, j.phase || '处理中…', j.total ? `${j.done}/${j.total}` : '');
      await sleepMs(280);
    }
    const r = last.result;
    setArchProgress(100, '完成', '');
    archClose();
    await loadDir(S.dir);
    if (S.tab === 'archive') renderArchiveTab();
    const n = r.copy ? r.copied : r.moved;
    const bits = [`已${r.copy ? '复制' : '移动'} ${n} 张到 ${r.groups.length} 个分类文件夹`];
    if (r.exists) bits.push(`跳过目标已有的 ${r.exists} 张`);
    if (r.already) bits.push(`跳过已归档 ${r.already} 张`);
    if (r.pruned) bits.push(`清掉 ${r.pruned} 个空文件夹`);
    if (r.failed?.length) bits.push(`${r.failed.length} 张失败`);
    toast(bits.join('，'), 4800);
  } catch (err) {
    $('archProgress').hidden = true;
    $('archPreviewStep').hidden = false;
    toast(err.message, 4200);
  } finally {
    btn.disabled = false;
    btn.textContent = '开始归档';
  }
}

function setArchProgress(pct, phase, count) {
  const bar = $('archBar');
  const ph = $('archPhase');
  const ct = $('archCount');
  if (pct == null) {
    bar.style.width = '100%';
    bar.classList.add('indet');
  } else {
    bar.style.width = pct + '%';
    bar.classList.remove('indet');
  }
  ph.textContent = phase || '';
  ct.textContent = count || '';
}

function archClose() {
  $('archMask').classList.remove('show');
}

function bindArchiveSheet() {
  const mask = $('archMask');
  $('archGo').onclick = archGo;
  $('archCancel').onclick = archClose;
  mask.addEventListener('click', (e) => {
    if (e.target === mask) archClose();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && mask.classList.contains('show')) archClose();
  });
}

/* ---------------- 「按分类归档」标签页 ---------------- */

/**
 * 独立模块：把散落在各个文件夹里的照片统一归并到同一棵分类树。
 * 页面主体是一格格文件夹卡片，勾谁就把谁（连同它下面的所有子文件夹）算进来；
 * 目标文件夹可以指到别处（归并），方式可选复制（默认）或移动。
 */
const ATAB = { dir: '', key: '', subdirs: [], sel: new Set(), own: false, useSel: false, mode: 'picked' };

/** 范围三选一：只处理当前文件夹 / 连子文件夹 / 勾选文件夹 */
const ARCH_HINT = {
  own: '只处理当前这一层，子文件夹里的图不动。（点下面任意卡片可切回「勾选文件夹」）',
  deep: '当前文件夹和它下面所有子文件夹一起重排，已经归档过的会跳过。（点卡片可切回「勾选文件夹」）',
  picked: '已经归档过的图会自动跳过，没有物种名的也会跳过。',
};

function setArchMode(m) {
  ATAB.mode = m === 'own' || m === 'deep' ? m : 'picked';
  [...$('archScope').children].forEach((b) => b.classList.toggle('on', b.dataset.m === ATAB.mode));
  const grid = $('archGrid');
  if (grid) grid.classList.toggle('dim', ATAB.mode !== 'picked');
  const hint = $('archHint');
  if (hint) hint.textContent = ARCH_HINT[ATAB.mode];
  updateArchSelInfo();
}

/**
 * 归档页的「勾选」有三类卡片：
 *   本层图片      → includeOwn
 *   标注页选中的   → files（只在标注页确实勾了图时出现）
 *   子文件夹       → folders（每个都递归处理它下面的所有层级）
 */
async function runArchiveTab() {
  const dir = S.dir;
  if (!dir) return;
  ATAB.dir = dir;
  $('archCurPath').textContent = dir;
  $('archCurPath').title = dir;
  $('archEmpty').hidden = true;
  $('archGrid').innerHTML = '<div class="arch-loading"><span class="spin"></span> 正在读子文件夹…</div>';
  try {
    const r = await api(`/api/subdirs?path=${enc(dir)}&depth=1`);
    ATAB.subdirs = r.dirs || [];
    // 目录或「标注页选了几张」变了就重置勾选；只是刷新则保留原来的选择
    const key = `${dir}|${S.sel.size}`;
    if (ATAB.key !== key) {
      ATAB.key = key;
      if (S.sel.size) {
        // 在标注页勾了图再切过来，本意显然只处理这几张
        ATAB.useSel = true;
        ATAB.own = false;
        ATAB.sel = new Set();
      } else {
        ATAB.useSel = false;
        ATAB.own = S.files.length > 0;
        ATAB.sel = new Set(ATAB.subdirs.map((d) => d.path));
      }
    } else {
      const alive = new Set(ATAB.subdirs.map((d) => d.path));
      ATAB.sel = new Set([...ATAB.sel].filter((p) => alive.has(p)));
    }
    renderArchiveTab();
  } catch (err) {
    $('archGrid').innerHTML = '';
    $('archEmpty').hidden = false;
    $('archEmpty').innerHTML = `<b>读不了这个文件夹</b>${esc(err.message)}`;
  }
}

/** 一张可勾选的卡片。kind: own | sel | dir */
function archTile(kind, opt) {
  const on = kind === 'own' ? ATAB.own : kind === 'sel' ? ATAB.useSel : ATAB.sel.has(opt.path);
  const title = kind === 'dir' ? opt.path : '';
  const sub = kind === 'own' ? `本层 ${opt.count} 张` : kind === 'sel' ? `已勾选 ${opt.count} 张` : '文件夹';
  const name = kind === 'dir' ? opt.name : kind === 'own' ? '本层的图片' : '标注页选中的图片';
  const glyph =
    kind === 'dir'
      ? '<path d="M6 14a3 3 0 0 1 3-3h9l4 4.5h17a3 3 0 0 1 3 3v3H6z" fill="#dcae5d"/><path d="M6 19h36l-4 16.5a3 3 0 0 1-3 2.5H12a3 3 0 0 1-3-2.6z" fill="#f0c877"/>'
      : '<rect x="9" y="11" width="30" height="24" rx="3" fill="#e9c98c"/><circle cx="18" cy="20" r="3" fill="#fff"/><path d="M11 32l8-9 6 6 5-5 7 8z" fill="#fff"/>';
  return `<div class="card folder pick${on ? ' sel' : ''}" data-k="${kind}"${opt.path ? ` data-d="${esc(opt.path)}"` : ''}${title ? ` title="${esc(title)}"` : ''}>
        <div class="thumb fold">
          <span class="tick">${on ? '✓' : ''}</span>
          <svg viewBox="0 0 48 48" width="46" height="46" aria-hidden="true">${glyph}</svg>
        </div>
        <div class="meta"><div class="nm">${esc(name)}</div><div class="sz">${esc(sub)}</div></div>
      </div>`;
}

function renderArchiveTab() {
  const grid = $('archGrid');
  const tiles = [];
  if (S.files.length) tiles.push(archTile('own', { count: S.files.length }));
  if (S.sel.size) tiles.push(archTile('sel', { count: S.sel.size }));
  for (const d of ATAB.subdirs) tiles.push(archTile('dir', d));

  if (!tiles.length) {
    grid.innerHTML = '';
    $('archEmpty').hidden = false;
    $('archEmpty').innerHTML = '<b>这个文件夹是空的</b>没有子文件夹，也没有图片';
  } else {
    $('archEmpty').hidden = true;
    grid.innerHTML = tiles.join('');
  }
  grid.onclick = (e) => {
    const card = e.target.closest('.card.pick');
    if (!card) return;
    // 在另外两种范围下点卡片，等于表态「我要按勾选来」，顺手切到勾选模式再勾
    if (ATAB.mode !== 'picked') {
      ATAB.mode = 'picked';
      [...$('archScope').children].forEach((b) => b.classList.toggle('on', b.dataset.m === 'picked'));
      grid.classList.remove('dim');
    }
    const kind = card.dataset.k;
    if (kind === 'own') ATAB.own = !ATAB.own;
    else if (kind === 'sel') ATAB.useSel = !ATAB.useSel;
    else {
      const p = card.dataset.d;
      if (ATAB.sel.has(p)) ATAB.sel.delete(p);
      else ATAB.sel.add(p);
    }
    const on =
      kind === 'own' ? ATAB.own : kind === 'sel' ? ATAB.useSel : ATAB.sel.has(card.dataset.d);
    card.classList.toggle('sel', on);
    const tick = card.querySelector('.tick');
    if (tick) tick.textContent = on ? '✓' : '';
    updateArchSelInfo();
  };
  grid.ondblclick = (e) => {
    // 双击文件夹 = 进这一层（和浏览页一致），方便先看看里面有什么
    const card = e.target.closest('.card.pick[data-k="dir"]');
    if (card) loadDir(card.dataset.d);
  };
  updateArchSelInfo();
}

function updateArchSelInfo() {
  if (ATAB.mode === 'own') {
    $('archSelInfo').textContent = `将处理：当前文件夹这一层（${S.files.length} 张）`;
    return;
  }
  if (ATAB.mode === 'deep') {
    $('archSelInfo').textContent = '将处理：当前文件夹及其所有子文件夹';
    return;
  }
  const bits = [];
  if (ATAB.own) bits.push(`本层 ${S.files.length} 张`);
  if (ATAB.useSel) bits.push(`选中 ${S.sel.size} 张`);
  if (ATAB.sel.size) bits.push(`${ATAB.sel.size} 个文件夹`);
  $('archSelInfo').textContent = bits.length ? `将处理：${bits.join(' + ')}` : '还没勾选任何东西';
}

async function archRunClick() {
  if (!ATAB.dir) return;
  const dest = $('archDest').value.trim();
  const body = {
    path: ATAB.dir,
    copy: $('archCopy').checked,
    bySpecies: $('archBySpecies').checked,
  };
  if (ATAB.mode === 'own') {
    body.deep = false;
  } else if (ATAB.mode === 'deep') {
    body.deep = true;
  } else {
    const sel = ATAB.subdirs.filter((d) => ATAB.sel.has(d.path)).map((d) => d.path);
    if (!sel.length && !ATAB.own && !ATAB.useSel) {
      toast('先勾选要参与归档的卡片');
      return;
    }
    body.deep = false;
    if (ATAB.own) body.includeOwn = true;
    if (ATAB.useSel && S.sel.size) body.files = [...S.sel];
    if (sel.length) body.folders = sel;
  }
  if (dest) body.dest = dest;
  await archPreviewFlow(body);
}

/* ---------------- 目标文件夹选择器 ---------------- */

const DP = { path: '', onPick: null };

async function dirPickerOpen(start, onPick) {
  DP.onPick = onPick || null;
  $('dirMask').classList.add('show');
  // 没有当前目录时从树根起步：mac 上没有 C:\，写死会导致选择器一打开就报错
  const fallback = T.drives.length ? normPath(T.drives[0].path) : isWinPath(S.dir) ? 'C:\\' : '/';
  await dirPickerGo(start || S.dir || fallback);
}

function dirPickerClose() {
  $('dirMask').classList.remove('show');
}

async function dirPickerGo(p) {
  $('dirList').innerHTML = '<div class="empty-line">读取中…</div>';
  try {
    const r = await api(`/api/dirs?path=${enc(p)}`);
    DP.path = r.path;
    $('dirPath').textContent = r.path;
    $('dirPath').title = r.path;
    $('dirUp').dataset.p = r.parent || '';
    $('dirUp').disabled = !r.parent;
    $('dirList').innerHTML = r.dirs.length
      ? r.dirs.map((d) => `<label data-p="${esc(d.path)}">📁 ${esc(d.name)}</label>`).join('')
      : '<div class="empty-line">（这个文件夹下面没有子文件夹）</div>';
  } catch (err) {
    $('dirList').innerHTML = `<div class="empty-line">${esc(err.message)}</div>`;
  }
}

function bindArchiveTab() {
  $('archRun').onclick = archRunClick;

  // 范围三选一
  [...$('archScope').children].forEach((b) => {
    b.onclick = () => setArchMode(b.dataset.m);
  });

  // 全选：本层 + 标注页选中的 + 全部子文件夹，一个不落
  $('archAllBtn').onclick = () => {
    setArchMode('picked');
    ATAB.own = S.files.length > 0;
    ATAB.useSel = S.sel.size > 0;
    ATAB.sel = new Set(ATAB.subdirs.map((d) => d.path));
    renderArchiveTab();
  };

  // 清空：什么都不处理
  $('archNoneBtn').onclick = () => {
    setArchMode('picked');
    ATAB.own = false;
    ATAB.useSel = false;
    ATAB.sel = new Set();
    renderArchiveTab();
  };

  $('archDestPick').onclick = () => {
    const start = $('archDest').value.trim() || ATAB.dir || S.dir;
    dirPickerOpen(start, (p) => {
      $('archDest').value = p;
      toast('归档结果会放进这个文件夹下的分类树', 3000);
    });
  };
  $('archDestClear').onclick = () => {
    $('archDest').value = '';
    toast('目标已清空：分类树建在当前文件夹下（这时一定是移动）', 3400);
  };
  $('archCopy').onchange = () => {
    if (!$('archDest').value.trim() && $('archCopy').checked) {
      toast('没有指定目标文件夹时只能就地归档，也就是移动', 3400);
    }
  };

  $('dirUse').onclick = () => {
    if (DP.onPick) DP.onPick(DP.path);
    dirPickerClose();
  };
  $('dirCancel').onclick = dirPickerClose;
  $('dirUp').onclick = () => {
    const p = $('dirUp').dataset.p;
    if (p) dirPickerGo(p);
  };
  $('dirList').onclick = (e) => {
    const lb = e.target.closest('[data-p]');
    if (lb) dirPickerGo(lb.dataset.p);
  };
  $('dirMask').addEventListener('click', (e) => {
    if (e.target.id === 'dirMask') dirPickerClose();
  });
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

/* ---------------- 批量鉴定后挨个确认：下一张 / 写入后自动跳 ---------------- */
/** 找下一张「有识别结果、本次会话还没写过」的照片；走到末尾会绕回开头 */
function nextPendingPath(from) {
  const list = (S.files || []).filter((f) => f && f.path);
  if (!list.length) return '';
  const i = list.findIndex((f) => f.path === from);
  const ordered = i >= 0 ? list.slice(i + 1).concat(list.slice(0, i + 1)) : list.slice();
  for (const f of ordered) {
    if (f.path === from) continue;
    if (S.results.has(f.path) && !S.written.has(f.path)) return f.path;
  }
  return '';
}

/** 切到指定照片：分页时连页码一起跳，不然卡片不在这一页的 DOM 上 */
function jumpToPhoto(p) {
  if (!p) return false;
  const list = (S.files || []).filter((f) => f && f.path);
  const idx = list.findIndex((f) => f.path === p);
  const size = S.pageSize || 0;
  if (size && idx >= 0) S.page = Math.floor(idx / size) + 1;
  S.active = p;
  render();
  openPanel(p);
  return true;
}

function nextPhotoClick() {
  const nxt = nextPendingPath(S.active);
  if (!nxt) return toast('没有下一张待确认的照片了', 2400);
  jumpToPhoto(nxt);
}

/** 写入成功后接着干的事：自动模式就跳下一张，否则留在原地把结果说清楚 */
function afterWriteAdvance(from, msg, html) {
  const auto = !!($('autoNextChk') && $('autoNextChk').checked);
  const nxt = auto ? nextPendingPath(from) : '';
  if (nxt) {
    jumpToPhoto(nxt);
    toast(`${msg} · 已跳到下一张待确认`, 2800);
    return;
  }
  render();
  if (S.active) openPanel(S.active);
  if (msg) {
    $('writeMsg').className = 'msg ok';
    $('writeMsg').innerHTML = (html || esc(msg)) + (auto ? ' · 这一批都确认完了' : '');
  }
}

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
      renameSuffix: S.opt.suffix,
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
      $('panelBody').hidden = true;
      $('panelEmpty').hidden = false;
      // 归档后这张已经不在本层了，自动模式直接从剩下的照片里接着确认
      if ($('autoNextChk') && $('autoNextChk').checked) {
        const nxt = nextPendingPath(p);
        if (nxt) {
          jumpToPhoto(nxt);
          toast(`已写入并归档到「${out.folder}」· 已跳到下一张`, 3200);
          return;
        }
      }
      render();
      toast(`已写入并归档到「${out.folder}」`, 3600);
      return;
    }

    // 重命名成功后文件路径变了：卡片、选中集合、识别结果都要跟着搬家，
    // 否则旧路径还会留在列表里，点它只会「图片不存在」。
    const next = out.path || p;
    S.labels.delete(p);
    // kw 一定要带上：写进图片的关键词就是 [中文名, 学名]，
    // 少了学名，「没有学名」筛选会把刚标好的图又算回未鉴定。
    S.labels.set(next, { title: cn || latin, kw: [cn, latin].filter(Boolean) });
    S.written.add(next);
    PANEL.drafts.delete(p);
    PANEL.drafts.delete(next);
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

    const okMsg = `已写入 ${out.kind.toUpperCase()}（+${out.delta} 字节）· 标题：${out.title}`
      + (out.renamed ? ` · 文件已改名为 ${out.name}` : '');
    const okHtml = `已写入 ${out.kind.toUpperCase()}（+${out.delta} 字节）· 标题：${esc(out.title)}`
      + (out.renamed ? `<br>文件已改名为 ${esc(out.name)}` : '');
    // openPanel 会清掉写入提示，所以提示统一在 afterWriteAdvance 里最后写
    afterWriteAdvance(S.active, okMsg, okHtml);
  } catch (err) {
    $('writeMsg').className = 'msg err';
    $('writeMsg').textContent = err.message;
  } finally {
    $('writeBtn').textContent = '确认并写入图片';
    $('writeBtn').disabled = false;
  }
}

/* ---------------- 各站结果 / 完整结果（原本在聚合台，现并进工坊） ---------------- */

/**
 * 这一段以前是把图甩给另一个软件（物种鉴定聚合台）去看多站明细：
 * 没装要引导下载、装旧了要提示升级、还得分标签页递消息。
 * 现在整段并进来 —— 右侧面板直接列「每个站回了什么」，「完整结果」再摊平成合并表：
 * 结论、每站 Top5、各站对每个候选的打分、学名旁的 iNat / PPBC / 自然在线 / GBIF。
 * 数据全来自 /api/identify 的返回，不用再装第二个程序。
 */

/** 分数写法：百度这类尾巴是 0.0004 的别显示成 0.0 */
function fmtScore(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n > 0 && n < 0.1 ? '<0.1' : n.toFixed(1);
}

const siteMetaMap = () => Object.fromEntries((S.state?.siteMeta || []).map((m) => [m.key, m]));

function siteNameOf(k) {
  return siteMetaMap()[k]?.name || k;
}

/** 拉丁学名里的属名（第一个词）。带 × 的杂交名、只有中文名的候选都返回空 */
function genusOfLatin(latin) {
  const first = String(latin || '')
    .trim()
    .split(/\s+/)[0]
    .replace(/[×✕]/g, '');
  return /^[A-Z][a-z]{2,}$/.test(first) ? first : '';
}

/**
 * 「这张图不归它管」不算故障：懂鸟只认鸟、快瞳只认鸟、晓虫各分区只认对应类群。
 * 这类跳过用灰色，真失败才用红 —— 跟聚合台同一套说法，别两边不一致。
 */
function siteSkipped(err) {
  return /没识别出动物|没识别出植物|没检测到目标框|不在指定地区的分布范围|没认出来|没认出鸟|未解析到物种|没有任何结果/.test(
    String(err || ''),
  );
}

/* ---- 右侧面板：一站点一行 ---- */

function pvSitesPaint(r) {
  const box = $('pvSites');
  if (!box) return;
  const head = $('pvSitesHead');
  const meta = $('pvSitesMeta');
  const btn = $('aggBtn');
  if (!r || r.error || !r.sites) {
    box.innerHTML = '';
    if (meta) meta.textContent = '';
    if (btn) btn.hidden = true;
    if (head) head.hidden = true;
    return;
  }
  if (head) head.hidden = false;
  const keys = Object.keys(r.sites);
  const okCount = keys.filter((k) => r.sites[k].ok && (r.sites[k].items || []).length).length;
  if (meta) meta.textContent = keys.length ? `${okCount}/${keys.length} 站有结果` : '';
  if (btn) btn.hidden = !(r.rows || []).length;

  box.innerHTML = keys
    .map((k) => {
      const s = r.sites[k] || {};
      const top = (s.items || [])[0];
      const cls = top ? '' : s.ok ? ' empty' : siteSkipped(s.error) ? ' skipped' : ' failed';
      const secs = s.mirrorOf ? '同源' : s.ms ? `${(s.ms / 1000).toFixed(1)}s` : '—';
      const mid = s.mirrorOf
        ? `<span class="pvs-tag">与「${esc(siteNameOf(s.mirrorOf))}」同源，不重复计票</span>`
        : top
          ? `<span class="pvs-top"><i>${esc(top.latin || '')}</i>${top.cn ? `<span>${esc(top.cn)}</span>` : ''}</span>`
          : `<span class="pvs-err">${esc(s.error || '没有结果')}</span>`;
      return `<div class="pvs-row${cls}">
        <span class="pvs-name">${esc(siteNameOf(k))}</span>
        <span class="pvs-mid">${mid}</span>
        <span class="pvs-sc">${top ? fmtScore(top.score) : ''}</span>
        <span class="pvs-ms">${secs}</span>
      </div>`;
    })
    .join('');
}

/* ---- 检索地区：只决定学名旁那几个小标跳到什么范围，不参与识别 ---- */

const AGG_PLACES = [
  { code: '', label: '全世界（不限定）' },
  { code: 'CN-35', label: '中国 · 福建' },
  { code: 'CN-44', label: '中国 · 广东' },
  { code: 'CN-33', label: '中国 · 浙江' },
  { code: 'CN-36', label: '中国 · 江西' },
  { code: 'CN-43', label: '中国 · 湖南' },
  { code: 'CN-45', label: '中国 · 广西' },
  { code: 'CN-52', label: '中国 · 贵州' },
  { code: 'CN-53', label: '中国 · 云南' },
  { code: 'CN-51', label: '中国 · 四川' },
  { code: 'CN-50', label: '中国 · 重庆' },
  { code: 'CN-42', label: '中国 · 湖北' },
  { code: 'CN-41', label: '中国 · 河南' },
  { code: 'CN-34', label: '中国 · 安徽' },
  { code: 'CN-32', label: '中国 · 江苏' },
  { code: 'CN-37', label: '中国 · 山东' },
  { code: 'CN-13', label: '中国 · 河北' },
  { code: 'CN-14', label: '中国 · 山西' },
  { code: 'CN-61', label: '中国 · 陕西' },
  { code: 'CN-62', label: '中国 · 甘肃' },
  { code: 'CN-63', label: '中国 · 青海' },
  { code: 'CN-64', label: '中国 · 宁夏' },
  { code: 'CN-65', label: '中国 · 新疆' },
  { code: 'CN-54', label: '中国 · 西藏' },
  { code: 'CN-15', label: '中国 · 内蒙古' },
  { code: 'CN-21', label: '中国 · 辽宁' },
  { code: 'CN-22', label: '中国 · 吉林' },
  { code: 'CN-23', label: '中国 · 黑龙江' },
  { code: 'CN-46', label: '中国 · 海南' },
  { code: 'CN-11', label: '中国 · 北京' },
  { code: 'CN-12', label: '中国 · 天津' },
  { code: 'CN-31', label: '中国 · 上海' },
  { code: 'TW', label: '中国台湾' },
  { code: 'HK', label: '中国香港' },
  { code: 'MO', label: '中国澳门' },
  { code: 'JP', label: '日本' },
  { code: 'KR', label: '韩国' },
  { code: 'TH', label: '泰国' },
  { code: 'VN', label: '越南' },
  { code: 'US', label: '美国' },
  { code: 'GB', label: '英国' },
  { code: 'AU', label: '澳大利亚' },
];

function aggPlace() {
  const p = S.state?.linkPlace || {};
  return { code: String(p.code || ''), placeId: Number(p.placeId) || 0, placeName: String(p.placeName || '') };
}

/** 拼给接口的地区参数：自定义地名优先，其次省代码 */
function aggPlaceQS() {
  const p = aggPlace();
  const qs = new URLSearchParams();
  if (p.placeId) {
    qs.set('placeId', String(p.placeId));
    if (p.placeName) qs.set('placeName', p.placeName);
  } else if (p.code) {
    qs.set('place', p.code);
  }
  return qs;
}

function paintAggPlace() {
  const sel = $('aggPlace');
  if (!sel) return;
  const p = aggPlace();
  const known = AGG_PLACES.some((x) => x.code === p.code);
  sel.innerHTML =
    AGG_PLACES.map((x) => `<option value="${x.code}">${esc(x.label)}</option>`).join('') +
    (p.code && !known ? `<option value="${esc(p.code)}">${esc(p.code)}</option>` : '');
  sel.value = p.code;
  const hint = $('aggPlaceHint');
  if (hint) {
    const custom = p.placeId ? p.placeName || String(p.placeId) : '';
    hint.textContent = custom ? `自定义：${custom}` : '只影响学名旁那几个小标';
  }
}

async function aggPlaceSave(next) {
  S.state.linkPlace = { code: '', placeId: 0, placeName: '', ...next };
  paintAggPlace();
  try {
    await post('/api/config', { linkPlace: S.state.linkPlace });
  } catch {
    /* 存不下去也不影响这次查看 */
  }
  // 地区换了，表里的字号小标和已经开着的那份查询都得按新范围重来
  if (aggShown()) renderAgg(true);
  if (gxShown()) runGenus();
}

/* ---- 「完整结果」弹窗 ---- */

let AGG_CUR = null; // { path, r }
let AGG_SEQ = 0;

function aggShown() {
  const m = $('aggMask');
  return Boolean(m && m.classList.contains('show'));
}

function openAgg() {
  const p = S.active;
  const r = S.results.get(p);
  if (!p || !r || !(r.rows || []).length) {
    toast('这张还没有可看的结果，先识别一下');
    return;
  }
  AGG_CUR = { path: p, r };
  $('aggMask').classList.add('show');
  paintAggPlace();
  renderAgg(true);
}

function closeAgg() {
  const m = $('aggMask');
  if (m) m.classList.remove('show');
}

/** 合并表 + 各站原始结果。withEbird=true 时顺带查一次 eBird（只作旁证，不参与打分） */
function renderAgg(withEbird) {
  const cur = AGG_CUR;
  if (!cur) return;
  const r = cur.r;
  const sites = r.aggSites && r.aggSites.length ? r.aggSites : Object.keys(r.sites || {});
  const rows = r.rows || [];
  const f = S.files.find((x) => x.path === cur.path);

  $('aggFile').textContent = cur.name || (f ? f.name : '');
  $('aggVerdict').textContent = r.verdict || '—';

  const ebOn = Boolean(S.state?.ebird?.ready);
  const th = $('aggEbirdTh');
  if (th) {
    th.hidden = !ebOn;
    th.textContent = 'eBird 近14天';
  }

  $('aggBody').innerHTML = rows
    .map((row, i) => {
      const support = Object.keys(row.bySite || {});
      const pills = support
        .map((s) => `<span class="agg-pill">${esc(siteNameOf(s))} ${fmtScore(row.bySite[s].score)}</span>`)
        .join('');
      const missing = sites
        .filter((s) => !(row.bySite || {})[s])
        .map((s) => `<span class="agg-pill off">${esc(siteNameOf(s))} —</span>`)
        .join('');
      const badge = row.unanimous
        ? '<span class="agg-badge">全站提到</span>'
        : row.support >= 2
          ? `<span class="agg-badge gray">${row.support} 站提到</span>`
          : '';
      return `<tr>
        <td class="agg-idx">${i + 1}</td>
        <td>
          <div class="agg-name">${row.cn ? esc(row.cn) : '—'} ${badge}</div>
          <div class="agg-lat"><i>${esc(row.latin || '')}</i>${gxChips(row.latin)}</div>
        </td>
        <td class="agg-vote">${row.support}/${r.siteCount || sites.length}</td>
        <td>
          <span class="agg-meter"><i style="width:${Math.min(100, row.pct || 0)}%"></i></span>
          <span class="agg-pct">${row.pct}</span>
        </td>
        <td class="agg-pills">${pills}${missing}</td>
        ${ebOn ? `<td class="agg-eb" data-latin="${esc(row.latin || '')}">…</td>` : ''}
      </tr>`;
    })
    .join('');

  $('aggSites').innerHTML = Object.keys(r.sites || {})
    .map((k) => aggSiteCard(k, r.sites[k]))
    .join('');

  if (withEbird && ebOn) aggEbirdFill(rows);
}

/** 各站原始结果卡片：Top5 + 每条的小横条，跟聚合台那张站卡一个意思 */
function aggSiteCard(k, s) {
  const name = esc(siteNameOf(k));
  if (!s) {
    return `<div class="agg-site"><div class="agg-site-h"><span>${name}</span><span>未查询</span></div>
      <div class="agg-site-b dim">这张没包含该站点</div></div>`;
  }
  if (!s.ok || !(s.items || []).length) {
    const skipped = siteSkipped(s.error);
    return `<div class="agg-site ${skipped ? 'skipped' : 'failed'}">
      <div class="agg-site-h"><span>${name}</span><span>${s.ms ? `${(s.ms / 1000).toFixed(1)}s` : ''}</span></div>
      <div class="agg-site-b">${esc(s.error || '没有结果')}</div></div>`;
  }
  const top = s.items.slice(0, 5);
  const max = Math.max(...top.map((t) => Number(t.score) || 0), 1);
  return `<div class="agg-site${s.mirrorOf ? ' mirrored' : ''}">
    <div class="agg-site-h"><span>${name}</span><span>${s.mirrorOf ? '同引擎' : `${(s.ms / 1000).toFixed(1)}s`}</span></div>
    ${
      s.mirrorOf
        ? `<div class="agg-site-note">与「${esc(siteNameOf(s.mirrorOf))}」共用接口，结果相同，不重复计票</div>`
        : ''
    }
    <div class="agg-site-b">
      ${top
        .map(
          (t) =>
            `<div class="agg-cand">
              <span class="agg-rk">${t.rank || ''}</span>
              <span class="agg-cn">${esc(t.cn || '')}</span>
              <span class="agg-la"><i>${esc(t.latin || '')}</i></span>
              <span class="agg-cs">${fmtScore(t.score)}</span>
            </div>
            <div class="agg-cbar"><i style="width:${Math.max(3, ((Number(t.score) || 0) / max) * 100)}%"></i></div>`,
        )
        .join('')}
    </div></div>`;
}

/** eBird 那列：只给旁证。没配 key / 非鸟类 / 查不到都只是空着，不影响别的 */
async function aggEbirdFill(rows) {
  const seq = ++AGG_SEQ;
  const names = rows.map((r) => r.latin).filter(Boolean);
  if (!names.length) return;
  let j;
  try {
    const res = await fetch('/api/ebird/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // 地区跟着「检索地区」走，别再固定用设置里那个（默认上海）。
      // 自定义地名只有 placeId、没有省代码，eBird 认代码不认 placeId，那种情况回退到配置值。
      body: JSON.stringify({
        sciNames: names,
        region: aggPlace().code || S.state?.ebird?.region || '',
      }),
    });
    j = await res.json();
  } catch {
    return;
  }
  if (seq !== AGG_SEQ || !aggShown()) return;
  const th = $('aggEbirdTh');
  if (th && j.ok) {
    th.textContent = j.regionLabel ? `eBird·${j.regionLabel} 近${j.back}天` : 'eBird 近14天';
  }
  if (!j.ok) {
    document.querySelectorAll('#aggBody .agg-eb').forEach((td) => {
      td.textContent = '—';
    });
    if (j.error) toast(j.error, 3400);
    return;
  }
  const map = new Map((j.items || []).map((x) => [String(x.latin || '').toLowerCase(), x]));
  document.querySelectorAll('#aggBody .agg-eb').forEach((td) => {
    const it = map.get(String(td.dataset.latin || '').toLowerCase());
    if (!it) {
      td.textContent = '—';
    } else if (!it.isBird) {
      td.innerHTML = '<span class="dim">非鸟类</span>';
    } else if (it.error) {
      td.innerHTML = `<span class="dim">${esc(it.error)}</span>`;
    } else {
      td.innerHTML = it.count ? `<b>${it.count}</b> 条` : '<span class="dim">0 条</span>';
      td.title = it.last ? `最近 ${it.last}${it.lastLoc ? ` · ${it.lastLoc}` : ''}` : '';
    }
  });
}

/** 导出一张的合并结果（Excel 直接能开，带 BOM 免得中文乱码） */
function aggCsv() {
  const cur = AGG_CUR;
  if (!cur) return;
  const r = cur.r;
  const sites = r.aggSites && r.aggSites.length ? r.aggSites : Object.keys(r.sites || {});
  const q = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ['排名', '中文名', '学名', '综合得分', '得票', ...sites.map(siteNameOf)];
  const body = (r.rows || []).map((row, i) => [
    i + 1,
    row.cn || '',
    row.latin || '',
    row.pct,
    // Excel 双击打开 CSV 会把裸的 3/5 当成「3 月 5 日」。
    // 带上单位写成纯文本，任何表格软件都不会再自作主张转日期（比 ="3/5" 那种公式更稳）。
    `${row.support}/${r.siteCount || sites.length} 站`,
    ...sites.map((s) => {
      const b = (row.bySite || {})[s];
      return b ? fmtScore(b.score) : '';
    }),
  ]);
  const text = '\ufeff' + [head, ...body].map((row) => row.map(q).join(',')).join('\r\n');
  const f = S.files.find((x) => x.path === cur.path);
  const base = (cur.name || f?.name || '结果').replace(/\.[^.]+$/, '');
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `识别结果_${base}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('已导出这张的合并结果');
}

/* ---- 学名旁的查询小标 ---- */

function gxChips(latin) {
  const g = genusOfLatin(latin);
  if (!g) return '';
  const L = esc(latin || '');
  // 四个标包在 .gx-set 里：父级 .agg-lat 是 wrap 的 flex，
  // 不包的话学名一长就把 GBIF 挤到下一行，只剩它自己孤零零一行
  return (
    '<span class="gx-set">' +
    `<button class="gx-chip" data-gx="inat" data-latin="${L}" title="在 iNaturalist 看这个属在检索地区有哪些种">iNat</button>` +
    `<button class="gx-chip" data-gx="ppbc" data-latin="${L}" title="在植物智看这个属的图库（按检索地区）">PPBC</button>` +
    `<button class="gx-chip" data-gx="nature" data-genus="${esc(g)}" title="在自然在线的保护地名录里查这个属">自然在线</button>` +
    `<button class="gx-chip" data-gx="gbif" data-genus="${esc(g)}" title="查 GBIF：这个属在检索地区有哪些种">GBIF</button>` +
    '</span>'
  );
}

async function gxChipGo(el) {
  const kind = el.dataset.gx;
  if (kind === 'nature') {
    // 自然在线站内确实有「照片高级搜索」：目标类群（属/科名）+ 省市/地名筛照片。
    // 但站方那个高级搜索是弹窗表单、不吃 URL 参数，所以先在服务端问一次数量，
    // 再把人送到 /msearch?kw=属名（站内这个页会自动执行搜索）。
    const g = el.dataset.genus || '';
    const qs = aggPlaceQS();
    qs.set('genus', g);
    let info = null;
    try { info = await api('/api/nature/photo-adv?' + qs.toString()); } catch { /* 站内照样要跳 */ }
    const url = (info && info.url) || ('https://ecp.ibiodiversity.cn/msearch?kw=' + enc(g));
    window.open(url, '_blank', 'noopener');
    if (info && !info.error) {
      const where = info.place || '当前检索地区';
      toast(
        info.total
          ? `自然在线「${where}」有 ${info.total} 张 ${g} 属照片，已打开站内搜索`
          : `自然在线在「${where}」没查到 ${g} 属照片，已打开站内全站搜索`,
        4200,
      );
    }
    return;
  }
  if (kind === 'gbif') {
    openGenusPanel('gbif', el.dataset.genus || '');
    return;
  }
  const qs = aggPlaceQS();
  qs.set('latin', el.dataset.latin || '');
  const url = kind === 'inat' ? '/api/inat/link?' : '/api/ppbc/link?';
  el.disabled = true;
  try {
    const j = await api(url + qs.toString());
    if (!j.ok || !j.url) {
      toast(j.error || '拼不出链接，换个检索地区再试', 3600);
      return;
    }
    window.open(j.url, '_blank', 'noopener');
  } catch (err) {
    toast(err.message || '打开失败', 3600);
  } finally {
    el.disabled = false;
  }
}

/* ---- 单图识别：不打开文件夹，Ctrl+V / 拖入 / 选一张就识别 ----
 * 图不落磁盘、也不进 S.files：服务端 /api/identify/paste 直接吃前端压好的两份 JPEG，
 * 走的是和本地图片完全一样的 identifyImage（站点开关、去重、聚合全复用）。
 * 识别完开「完整结果」弹窗，所以粘贴图没有「写入图片」这一步，也不会碰文件夹里的照片。 */
let PASTE_SEQ = 0;

function pasteShown() {
  const m = $('pasteMask');
  return Boolean(m && m.classList.contains('show'));
}

function pasteReset() {
  const img = $('pasteImg');
  if (img) { img.hidden = true; img.removeAttribute('src'); }
  if ($('pasteHint')) $('pasteHint').hidden = false;
  if ($('pasteAgain')) $('pasteAgain').hidden = true;
  const st = $('pasteState');
  if (st) {
    st.className = 'paste-state';
    st.textContent = '正在用顶上开着的那几个站点识别，识别完自动打开「完整结果」。';
  }
  if ($('pasteFile')) $('pasteFile').value = '';
}

function openPaste() {
  const m = $('pasteMask');
  if (!m) return;
  pasteReset();
  m.classList.add('show');
  if ($('pasteZone')) $('pasteZone').focus();
}

function closePaste() {
  PASTE_SEQ += 1; // 让还在路上的识别作废
  const m = $('pasteMask');
  if (m) m.classList.remove('show');
}

function pasteAccept(files) {
  const list = Array.from(files || []).filter(
    (f) => (f.type || '').startsWith('image/') || /\.(jpe?g|png|webp|bmp|gif|tiff?)$/i.test(f.name || ''),
  );
  if (!list.length) return false;
  pasteRun(list[0]);
  return true;
}

/** 把粘贴/拖进来的 Blob 压成 1600 / 640 两份 JPEG（和 makeVariants 同一套口径） */
function pasteVariants(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try { resolve({ dataJpeg: draw(img, 1600, 0.9), dataSmall: draw(img, 640, 0.85) }); }
      catch { resolve({}); }
    };
    img.onerror = () => resolve({});
    img.src = url;
  });
}

async function pasteRun(file) {
  const seq = ++PASTE_SEQ;
  if (!pasteShown()) openPaste();
  const st = $('pasteState');
  const url = URL.createObjectURL(file);
  const img = $('pasteImg');
  if (img) { img.src = url; img.hidden = false; }
  if ($('pasteHint')) $('pasteHint').hidden = true;
  if ($('pasteAgain')) $('pasteAgain').hidden = false;
  if (st) { st.className = 'paste-state'; st.textContent = '正在读出图片…'; }
  try {
    let variants = await pasteVariants(url);
    // 浏览器解不开的图（HEIC / 损坏）：退而把原始字节送上去，让服务端和站点自己判
    if (!variants.dataJpeg) {
      const raw = await new Promise((resolve) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result || ''));
        fr.onerror = () => resolve('');
        fr.readAsDataURL(file);
      });
      variants = { dataJpeg: raw.split(',').pop() || '', dataSmall: '' };
    }
    if (seq !== PASTE_SEQ) return;
    if (!variants.dataJpeg) throw new Error('这张图读不出来，先另存成 JPG 再试');
    if (st) st.textContent = '正在向多个站点识别，稍等十几秒…';
    const name = file.name || '粘贴图片.jpg';
    const r = await post('/api/identify/paste', {
      name,
      sources: S.state?.current?.sources,
      ...variants,
    });
    if (seq !== PASTE_SEQ) return;
    if (!r || !(r.rows || []).length) throw new Error((r && r.error) || '没有拿到识别结果');
    closePaste();
    AGG_CUR = { path: 'paste://' + Date.now(), name: r.name || name, r };
    $('aggMask').classList.add('show');
    paintAggPlace();
    renderAgg(true);
    toast('单图识别完成，已打开完整结果');
  } catch (err) {
    if (seq !== PASTE_SEQ) return;
    if (st) { st.className = 'paste-state bad'; st.textContent = err.message || '识别失败'; }
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

function bindPaste() {
  if (!$('pasteMask')) return;
  if ($('pasteBtn')) $('pasteBtn').onclick = openPaste;
  if ($('pasteClose')) $('pasteClose').onclick = closePaste;
  $('pasteMask').addEventListener('click', (e) => { if (e.target === $('pasteMask')) closePaste(); });
  if ($('pasteAgain')) {
    $('pasteAgain').onclick = () => { PASTE_SEQ += 1; pasteReset(); $('pasteFile').click(); };
  }
  if ($('pasteZone')) $('pasteZone').onclick = () => $('pasteFile').click();
  if ($('pasteFile')) {
    $('pasteFile').onchange = (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (f) pasteAccept([f]);
    };
  }
  const zone = $('pasteZone');
  if (zone) {
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('on'); });
    zone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      if (!e.relatedTarget || !zone.contains(e.relatedTarget)) zone.classList.remove('on');
    });
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('on');
      pasteAccept(e.dataTransfer?.files);
    });
  }
  // 全局 Ctrl+V：只在标注页、且没有别的弹窗开着时接管；输入框里照常粘文字。
  // 自然在线 / 评分页有自己的粘贴用途，别抢。
  window.addEventListener('paste', (e) => {
    if (S.tab !== 'annotate') return;
    const t = e.target;
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
    if (!pasteShown() && document.querySelector('.mask.show')) return;
    const items = Array.from(e.clipboardData?.items || []);
    const files = items.filter((i) => (i.type || '').startsWith('image/')).map((i) => i.getAsFile()).filter(Boolean);
    if (!files.length) return;
    e.preventDefault();
    pasteAccept(files);
  });
}

/* ---- 属查询面板：自然在线名录 / GBIF 分布 ---- */

let GX = { kind: '', genus: '', seq: 0 };

function gxShown() {
  const m = $('gxMask');
  return Boolean(m && m.classList.contains('show'));
}

function openGenusPanel(kind, genus) {
  if (!genus) return;
  GX = { kind, genus, seq: GX.seq + 1 };
  const nature = kind === 'nature';
  $('gxTitle').innerHTML = nature ? `自然在线 · <i>${esc(genus)}</i> 属` : `GBIF · <i>${esc(genus)}</i> 属`;
  $('gxSub').textContent = '';
  $('gxBar').hidden = !nature;
  if (nature) {
    const p = aggPlace();
    const area = p.placeId ? p.placeName : AGG_PLACES.find((x) => x.code === p.code)?.label || '';
    $('gxQ').value = '';
    $('gxQ').placeholder = area
      ? `${area.replace(/^中国\s*·\s*/, '')} 一带的地名，比如 武夷山`
      : '武夷山 / 闽江源 / 车八岭';
  }
  $('gxBody').innerHTML = '<div class="gx-load">正在查…</div>';
  $('gxMask').classList.add('show');
  runGenus();
}

async function runGenus() {
  const seq = ++GX.seq;
  const body = $('gxBody');
  const qs = aggPlaceQS();
  qs.set('genus', GX.genus);
  if (GX.kind === 'gbif') {
    qs.set('group', S.state?.current?.preset || '');
  } else {
    const q = ($('gxQ')?.value || '').trim();
    if (q) qs.set('q', q);
  }
  const btn = $('gxGo');
  if (btn) btn.disabled = true;
  try {
    const j = await api((GX.kind === 'gbif' ? '/api/gbifds/query?' : '/api/nature/sites?') + qs.toString());
    if (seq !== GX.seq || !gxShown()) return;
    body.innerHTML = GX.kind === 'gbif' ? gbifHtml(j) : natureHtml(j);
  } catch (err) {
    if (seq !== GX.seq) return;
    const msg = err.message || '查询失败';
    body.innerHTML =
      `<div class="gx-empty bad">${esc(msg)}</div>` +
      (/登录|令牌|过期/.test(msg)
        ? '<div class="gx-hint">名录和看图识别共用一张令牌：先到「自然在线」那页给账号取一次验证码登录，之后这里才查得动。</div>'
        : '');
  } finally {
    if (seq === GX.seq && btn) btn.disabled = false;
  }
}

function gbifHtml(j) {
  const rows = j.species || [];
  const head = `<div class="gx-head">
    <div class="gx-nums"><b>${rows.length}</b> 种有记录${j.family ? ` · ${esc(j.family)}` : ''}</div>
    <div class="gx-meta">GBIF 全球 <b>${j.globalTotal ?? '—'}</b> 个接受名 · 范围内 <b>${j.records ?? '—'}</b> 条记录${
      j.regionName ? ` · 范围：<b>${esc(j.regionName)}</b>` : ''
    }</div>
    ${j.question ? `<div class="gx-q">${esc(j.question)}</div>` : ''}
    ${j.warning ? `<div class="gx-warn">${esc(j.warning)}</div>` : ''}
    ${j.isSynonym && j.acceptedGenus
      ? `<div class="gx-warn">GBIF 把「${esc(j.genus || '')}」当作 <i>${esc(j.acceptedGenus)}</i> 的异名，下面按接受名统计（否则会一直显示 0 条）。</div>`
      : ''}
    ${j.answer && j.answer.summary ? `<div class="gx-sum">${esc(j.answer.summary)}</div>` : ''}
    <button class="ghost mini gx-alt" data-gx-nature="1" title="不按照片查，改看各保护区自己编的物种名录里收了这个属的哪些种">按保护区名录查这个属</button>
  </div>`;
  // 模型补充单独一块，明确标「GBIF 无记录 · 未经核实」，不许混进上面那张可核查的表
  const extras = (j.answer && Array.isArray(j.answer.extra) ? j.answer.extra : [])
    .filter((x) => x && (x.latin || x.cn))
    .map((x) => `<span>${esc(x.cn || '—')} <i>${esc(x.latin || '')}</i></span>`)
    .join('');
  const extraBlock = extras
    ? `<div class="gx-sub">模型补充 <span class="gx-tag">GBIF 无记录 · 未经核实</span></div><div class="gx-extra">${extras}</div>`
    : '';
  if (!rows.length) {
    return (
      head +
      `<div class="gx-empty">GBIF 在<b>${esc(j.regionName || '这个范围')}</b>没有「${esc(
        j.genus || '',
      )}」属的记录。<br>常见原因：这一带本来就没有分布；或者当地的数据只来自少数几个数据集，覆盖面有限。</div>` +
      extraBlock
    );
  }
  const tr = rows
    .map(
      (s, i) => `<tr>
      <td class="gx-idx">${i + 1}</td>
      <td>${s.cn ? esc(s.cn) : '<span class="dim">—</span>'}</td>
      <td><i>${esc(s.latin || '')}</i></td>
      <td class="gx-n">${s.count}</td>
    </tr>`,
    )
    .join('');
  return (
    head +
    `<table class="gx-table"><thead><tr><th>#</th><th>中文名</th><th>学名</th><th>记录数</th></tr></thead><tbody>${tr}</tbody></table>` +
    extraBlock
  );
}

function natureHtml(j) {
  const all = j.sites || [];
  const hit = all.filter((s) => s.n > 0);
  const zero = all.filter((s) => !s.n);
  const head = `<div class="gx-head">
    <div class="gx-meta">关键词「<b>${esc(j.keyword || '')}</b>」命中 <b>${j.matched}</b> 个站点，已查 <b>${j.scanned}</b> 个${
      j.skipped ? `（还有 ${j.skipped} 个没查）` : ''
    }${j.scope ? ` · 范围：<b>${esc(j.scope)}</b>` : ''}</div>
    <div class="gx-warn">站点按中文标题模糊匹配：搜「南平」可能混进「湖南平江芦头林场」这类同名站，点开前看一眼站名。</div>
  </div>`;
  if (!all.length) {
    return (
      head +
      `<div class="gx-empty">关键词「<b>${esc(j.keyword || '')}</b>」没搜到任何站点。<br>换个地名试试：自然在线的站名一般是「某某保护区 / 某某国家公园」，用地名本身最灵（「武夷山」而不是「南平市武夷山市」）。</div>`
    );
  }
  const rows = hit
    .map(
      (s) => `<div class="gx-nat">
      <div class="gx-nat-h"><b>${esc(s.title)}</b><span>${s.n} 种 · 名录 ${s.total} 条</span>
        ${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noreferrer">进站看</a>` : ''}</div>
      <div class="gx-sps">${(s.species || [])
        .map((sp) => `<span class="gx-sp">${sp.cn ? esc(sp.cn) : ''}${sp.latin ? `<i>${esc(sp.latin)}</i>` : ''}</span>`)
        .join('')}</div>
    </div>`,
    )
    .join('');
  const zeroLine = zero.length
    ? `<div class="gx-zero">另有 ${zero.length} 个站点的名录里没有这个属（${zero
        .map((s) => esc(s.title))
        .join('、')}）</div>`
    : '';
  return head + rows + zeroLine;
}

/* ---- 绑定 ---- */

/* ---- 检索地区：手填地名的联想建议（照聚合台那套，防抖 + 请求序号防串） ---- */
let aggSugTimer = 0;
let aggSugSeq = 0;

function aggSugHide() {
  const box = $('aggPlaceSug');
  if (!box) return;
  box.hidden = true;
  box.innerHTML = '';
  aggSugSeq += 1; // 让还在路上的那次搜索作废
}

function aggSugShown() {
  const box = $('aggPlaceSug');
  return Boolean(box && !box.hidden);
}

function aggSugShow(rows, note) {
  const box = $('aggPlaceSug');
  const inp = $('aggPlaceQ');
  if (!box || !inp) return;
  // 挂在输入框正下方（工具条可能换行，按输入框实际位置算）
  box.style.left = `${Math.max(0, inp.offsetLeft)}px`;
  if (note) {
    box.innerHTML = `<div class="agg-sug-note${/失败|出错/.test(note) ? ' bad' : ''}">${esc(note)}</div>`;
    box.hidden = false;
    return;
  }
  box.innerHTML = rows
    .map(
      (r) => `<button class="agg-sug" data-place-id="${Number(r.id) || 0}" data-place-name="${esc(r.name)}">
        <b>${esc(r.name)}</b><small>${esc(r.display || '')}</small>
      </button>`,
    )
    .join('');
  box.hidden = false;
}

async function aggSugSearch(q) {
  const seq = ++aggSugSeq;
  aggSugShow([], '正在搜索…');
  try {
    const j = await api(`/api/inat/places?q=${enc(q)}`);
    if (seq !== aggSugSeq) return;
    if (!j.ok) return aggSugShow([], j.error || '搜索失败，稍后再试');
    if (!(j.results || []).length) return aggSugShow([], `没找到「${q}」，换个说法试试（英文名也行）`);
    aggSugShow(j.results);
  } catch (err) {
    if (seq === aggSugSeq) aggSugShow([], err.message || '连不上本地服务');
  }
}

function aggSugPick(el) {
  const id = Number(el.dataset.placeId) || 0;
  const name = el.dataset.placeName || '';
  if (!id) return;
  aggSugHide();
  $('aggPlaceQ').value = '';
  aggPlaceSave({ code: '', placeId: id, placeName: name });
  toast(`检索地区改成「${name}」`);
}

function bindAggSheet() {
  const mask = $('aggMask');
  if (!mask) return;
  $('aggClose').onclick = closeAgg;
  mask.addEventListener('click', (e) => {
    if (e.target === mask) closeAgg();
  });
  $('aggBtn').onclick = openAgg;
  $('aggCsv').onclick = aggCsv;
  // 小标是按钮：iNat / PPBC 拼深链直接开，自然在线跳站内照片搜索，GBIF 开工坊面板
  $('aggBody').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-gx]');
    if (chip) gxChipGo(chip);
  });
  // GBIF 面板里留一个次级入口：改看各保护区自己编的物种名录（原来那个面板不删，只是不再抢小标）
  $('gxBody').addEventListener('click', (e) => {
    if (e.target.closest('[data-gx-nature]')) openGenusPanel('nature', GX.genus);
  });
  $('aggPlace').onchange = (e) => aggPlaceSave({ code: e.target.value, placeId: 0, placeName: '' });
  // 手填地名交给 iNat 的空间搜索换成 place_id，比让人记 CN-35 靠谱；
  // 边打边给一串候选，回车选第一条（和聚合台那一行一样）
  const sug = $('aggPlaceSug');
  $('aggPlaceQ').addEventListener('input', (e) => {
    clearTimeout(aggSugTimer);
    const v = e.target.value.trim();
    if (v.length < 2) return aggSugHide();
    aggSugTimer = setTimeout(() => aggSugSearch(v), 420);
  });
  $('aggPlaceQ').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { aggSugHide(); return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const first = sug && sug.querySelector('.agg-sug');
    if (first) return aggSugPick(first);
    const v = e.target.value.trim();
    if (v.length >= 2) aggSugSearch(v);
  });
  if (sug) {
    sug.addEventListener('click', (e) => {
      const b = e.target.closest('.agg-sug');
      if (b) aggSugPick(b);
    });
  }
  document.addEventListener('pointerdown', (e) => {
    if (!aggSugShown()) return;
    if (e.target.closest('#aggPlaceSug') || e.target.closest('#aggPlaceQ')) return;
    aggSugHide();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // 分级关：地名候选 → 单图识别 → 属查询 → 完整结果，一层一层退。
    // 大图查看器比这些都高一层，它自己在 capture 阶段先吃掉 Esc，这里轮不到。
    if (aggSugShown()) { aggSugHide(); e.stopImmediatePropagation(); return; }
    if (pasteShown()) { closePaste(); e.stopImmediatePropagation(); return; }
    if (gxShown()) {
      $('gxMask').classList.remove('show');
      e.stopImmediatePropagation();
      return;
    }
    if (aggShown()) {
      closeAgg();
      e.stopImmediatePropagation();
    }
  });
}

function bindGenusSheet() {
  const mask = $('gxMask');
  if (!mask) return;
  const close = () => mask.classList.remove('show');
  $('gxClose').onclick = close;
  mask.addEventListener('click', (e) => {
    if (e.target === mask) close();
  });
  $('gxGo').onclick = () => runGenus();
  $('gxQ').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    runGenus();
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
  const size = r.size ? ` · ${r.delta ? '增量包 ' : ''}${mbText(r.size)} MB` : '';
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
      const what = p.delta ? '增量补丁' : '新版';
      const text = p.total
        ? `正在下载${what} ${mbText(p.received)} / ${mbText(p.total)} MB`
        : `正在下载${what} ${mbText(p.received)} MB`;
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

/* ---------------- 统计分析标签页（bio-file 统计模块整合进标注工坊） ----------------
 * 点「统计分析」才出统计页；统计的是当前文件夹及其所有子文件夹下的已鉴定物种图，
 * 未鉴定的只给数字 + 按文件夹分组。底层喂给 lib/stats.js —— 和 bio-file 同一套统计逻辑。
 */

/**
 * 有些页面没有「相册端」这回事，进页面时把左栏的相册端锁上，并自动回到本机端；离开时解锁。
 *   · 统计分析 / 按分类归档 —— 只处理本机文件夹
 *   · 自然在线 —— 右边本来就有相册列表，左栏要留给本机文件夹树（拖文件夹上传要用）
 */
function syncSrcAvailability(tab) {
  const statsLock = tab === 'stats' || tab === 'archive';
  const natLock = tab === 'nature';
  const locked = statsLock || natLock;
  const seg = $('srcSeg');
  if (seg) {
    for (const b of seg.querySelectorAll('button[data-src]')) {
      const off = locked && b.dataset.src === 'album';
      b.disabled = off;
      b.classList.toggle('src-locked', off);
      b.title = off
        ? natLock
          ? '自然在线页右边已有相册列表，左栏相册端在这里不用切；左栏用来选本机文件夹'
          : '统计分析 / 按分类归档只处理本机文件夹，相册端在这里不可用'
        : b.dataset.src === 'album' ? '照片来自自然在线账号里的相册' : '照片来自本机文件夹';
    }
  }
  return locked;
}

function showTab(name) {
  S.tab = name;
  // 归档 / 统计 / 自然在线页：进页面就回到本机端（切走后不会自动跳回相册端）
  if (syncSrcAvailability(name) && S.mode === 'album') setSource('local', { quiet: true });
  const lay = document.querySelector('.layout');
  const views = {
    annotate: $('browseView'),
    stats: $('statsView'),
    archive: $('archiveView'),
    nature: $('natView'),
    score: $('scoreView'),
  };
  // 统计、归档、自然在线、照片评分都是「整块占用」的视图，右边那块标注面板收起来
  lay.classList.toggle('stats-mode', name === 'stats' || name === 'archive' || name === 'nature' || name === 'score');
  for (const [k, el] of Object.entries(views)) if (el) el.classList.toggle('on', k === name);
  [...$('tabs').children].forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  if (name === 'stats') statsOpen();
  if (name === 'archive') runArchiveTab();
  if (name === 'nature') natOpen();
  if (name === 'score') scoreOpen();
}

function bindTabs() {
  $('tabs').onclick = (e) => {
    const b = e.target.closest('button.tab');
    if (!b) return;
    showTab(b.dataset.tab);
  };
  $('reStatsBtn').onclick = () => runStats(STAB.dir || S.dir);
  $('stBackBtn').onclick = () => statsLanding();
}

/* ---------------- 「统计分析」标签页 ----------------
 * 两步走：打开标签页只列文件夹（不自动开跑），选一个才开始扫；
 * 结果页不分标签、所有板块一次铺开。
 */

const STAB = { dir: '', subdirs: [], done: false, running: false };

/** 进标签页用：同一个文件夹已经算过就保留结果，否则回到文件夹列表 */
function statsOpen() {
  if (!S.dir) {
    toast('请先在左侧选择文件夹');
    return;
  }
  if (STAB.done && STAB.dir === S.dir) return;
  statsLanding();
}

/** 落地页：当前文件夹 + 它下面一层的子文件夹，点谁就统计谁（都含子文件夹） */
async function statsLanding() {
  if (!S.dir) return;
  STAB.dir = S.dir;
  STAB.done = false;
  const grid = $('statsGrid');
  $('stLand').hidden = false;
  $('statsBody').hidden = true;
  $('stBackBtn').hidden = true;
  $('reStatsBtn').hidden = true;
  $('statsBusy').hidden = true;
  $('statsPath').textContent = '当前文件夹：' + S.dir;
  $('statsPath').title = S.dir;
  $('statsEmpty').hidden = true;
  grid.innerHTML = '<div class="arch-loading"><span class="spin"></span> 正在读子文件夹…</div>';
  try {
    const r = await api(`/api/subdirs?path=${enc(S.dir)}&depth=1`);
    STAB.subdirs = r.dirs || [];
  } catch (err) {
    grid.innerHTML = '';
    $('statsEmpty').hidden = false;
    $('statsEmpty').innerHTML = `<b>读不了这个文件夹</b>${esc(err.message)}`;
    return;
  }
  const tiles = [statsTile(S.dir, '这个文件夹', '含所有子文件夹')];
  for (const d of STAB.subdirs) tiles.push(statsTile(d.path, d.name, '含它下面的所有层级'));
  grid.innerHTML = tiles.join('');
  grid.onclick = (e) => {
    const card = e.target.closest('.card.pick');
    if (card) runStats(card.dataset.p);
  };
  if (!STAB.subdirs.length) {
    $('statsEmpty').hidden = false;
    $('statsEmpty').innerHTML = '<b>这里没有子文件夹</b>点「这个文件夹」直接统计就行';
  }
}

/** 落地页上一格文件夹 */
function statsTile(dirPath, name, sub) {
  return `<div class="card folder pick" data-p="${esc(dirPath)}" title="${esc(dirPath)}">
      <div class="thumb fold">
        <svg viewBox="0 0 48 48" width="46" height="46" aria-hidden="true"><path d="M6 14a3 3 0 0 1 3-3h9l4 4.5h17a3 3 0 0 1 3 3v3H6z" fill="#dcae5d"/><path d="M6 19h36l-4 16.5a3 3 0 0 1-3 2.5H12a3 3 0 0 1-3-2.6z" fill="#f0c877"/></svg>
      </div>
      <div class="meta"><div class="nm">${esc(name)}</div><div class="sz">${esc(sub)}</div></div>
    </div>`;
}

async function runStats(target) {
  const dir = target || STAB.dir || S.dir;
  if (!dir) {
    toast('请先在左侧选择文件夹');
    return;
  }
  if (STAB.running) return;
  STAB.running = true;
  STAB.dir = dir;
  const body = $('statsBody');
  $('stLand').hidden = true;
  body.hidden = false;
  $('stBackBtn').hidden = false;
  $('reStatsBtn').hidden = true;
  $('statsPath').textContent = '统计范围：' + dir + '（含所有子文件夹）';
  $('statsPath').title = dir;
  $('statsBusy').hidden = false;
  body.innerHTML = '<div class="st-loading">正在扫描并解析分类，请稍候…（首次遇到未缓存的物种会联网查 iNaturalist / GBIF）</div>';
  try {
    const d = await api('/api/stats?path=' + enc(dir));
    if (!d.ok) throw new Error(d.error || '分析失败');
    STAB.done = true;
    $('reStatsBtn').hidden = false;
    renderStats(d);
  } catch (e) {
    STAB.done = false;
    body.innerHTML = '<div class="st-err">' + esc(e.message || e) + '</div>';
  } finally {
    STAB.running = false;
    $('statsBusy').hidden = true;
  }
}

/* ---------------- 结果页 ---------------- */

const ST_COLORS = ['#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#b07aa1', '#76b7b2', '#edc948', '#ff9da7', '#9c755f', '#86bcb6'];

/** 一排横条（复用浏览页 .bar-row 的样式） */
function stBars(data, limit, colorful) {
  const rows = (data || []).slice(0, limit || 10);
  if (!rows.length) return '<div class="muted">这里没有数据</div>';
  const max = rows[0].count || 1;
  return rows
    .map((it, i) => {
      const w = Math.max(3, Math.round((it.count / max) * 100));
      const bg = colorful ? `;background:${ST_COLORS[i % ST_COLORS.length]}` : '';
      return `<div class="bar-row"><div class="name" title="${esc(it.name)}">${esc(it.name)}</div><div class="track"><div class="fill" style="width:${w}%${bg}"></div></div><div class="cnt">${it.count}</div></div>`;
    })
    .join('');
}

/**
 * 分类层级分布（层层包含版）
 * 旧版是个把「界/门/纲/目/科/属/种」当 7 个并列扇区的圆环，
 * 但分类阶元是嵌套关系（界 ⊃ 门 ⊃ 纲 ⊃ 目 ⊃ 科 ⊃ 属 ⊃ 种），并列会误导。
 * 这里改成缩进的「包含」条：越往里层级越深、条越长，并标出「之下细分出多少个下一级」。
 */
function stHierarchy(L) {
  const order = [
    ['界', L['界'] || 0, '#e15759'],
    ['门', L['门'] || 0, '#b07aa1'],
    ['纲', L['纲'] || 0, '#4e79a7'],
    ['目', L['目'] || 0, '#f28e2b'],
    ['科', L['科'] || 0, '#59a14f'],
    ['属', L['属'] || 0, '#ff9da7'],
    ['种', L['种'] || 0, '#76b7b2'],
  ].filter((p) => p[1] > 0);
  if (!order.length) return '<div class="muted">没有已鉴定的图片</div>';
  const leaf = order[order.length - 1][1] || 1; // 最细层级（种）作满格，体现「逐级细分、层层包含」
  let rows = '';
  order.forEach((p, i) => {
    const [name, n, c] = p;
    const w = Math.max(8, Math.round((n / leaf) * 100));
    const indent = i * 16; // 每深一层右缩，呈现嵌套
    const next = order[i + 1];
    const sub = next
      ? `${n} 个${name} 之下，共细分出 <b>${next[1]}</b> 个${next[0]}`
      : '最细层级 · 已到物种';
    rows += `<div class="hier-row" style="margin-left:${indent}px">
      <div class="hier-head"><span class="hier-dot" style="background:${c}"></span>
        <span class="hier-name">${name}</span>
        <span class="hier-n">${n}</span></div>
      <div class="track"><div class="fill" style="width:${w}%;background:${c}"></div></div>
      <div class="hier-sub">${sub}</div>
    </div>`;
  });
  return `<div class="st-hier"><div class="st-hier-cap">界 ⊃ 门 ⊃ 纲 ⊃ 目 ⊃ 科 ⊃ 属 ⊃ 种（逐级细分、层层包含）</div>${rows}</div>`;
}

function stCard(title, hint, inner, cls) {
  return `<section class="st-card${cls ? ' ' + cls : ''}"><header><h4>${title}</h4>${hint ? `<span class="hint">${hint}</span>` : ''}</header><div class="st-card-body">${inner}</div></section>`;
}

function renderStats(d) {
  const L = d.level;
  const dim = (n) => (d.dimensions.find((x) => x.dim === n) || { data: [] }).data;
  const un = d.unidentified || { count: 0, byFolder: [], list: [] };

  // ① 顶部一排数字（顺序对着 bio-file：总图片 → 已识别 → 未识别 → 种属科目纲门界）
  const kpis = [
    ['总图片', d.total, ''],
    ['已识别', L['已鉴定'], 'ok'],
    ['未识别', L['未鉴定'], 'warn'],
    ['物种', L['种'], ''],
    ['属', L['属'], ''],
    ['科', L['科'], ''],
    ['目', L['目'], ''],
    ['纲', L['纲'], ''],
    ['门', L['门'], ''],
    ['界', L['界'], ''],
  ];
  let html = '<div class="st-kpis">';
  for (const [label, n, cls] of kpis) html += `<div class="kpi ${cls}"><b>${n || 0}</b><span>${label}</span></div>`;
  html += '</div>';

  // ② 所有板块一次铺开
  html += '<div class="st-grid">';
  html += stCard('分类树', '点节点展开 / 收起', '<div class="stree-box" id="stree"></div>', 'span2');
  html += stCard('行政区域', '离线索引；没有坐标或离城市太远按文件夹归', stBars(dim('region'), 10));

  html += stCard('分类层级分布', '层层包含 · 逐级细分', stHierarchy(L));
  html += stCard('按物种', '仅统计已鉴定 · Top 12', stBars(dim('species'), 12, true));
  html += stCard('按项目', '顶层子文件夹', stBars(dim('project'), 8, true));

  html += stCard('按文件夹', 'Top 10', stBars(dim('folder'), 10));
  html += stCard('按时间（季节）', 'EXIF 拍摄时间，缺失用文件时间', stBars(dim('time_season'), 8, true));
  html += stCard('按年份', 'Top 8', stBars(dim('time_year'), 8));

  // ③ 未鉴定：数字 + 按文件夹 + 缩略图
  let unInner;
  if (!un.count) {
    unInner = '<div class="muted">没有未鉴定的图片，全部都已标注 ✓</div>';
  } else {
    unInner = `<table class="un-table"><thead><tr><th>所在文件夹</th><th style="text-align:right">张数</th></tr></thead><tbody>`;
    for (const row of un.byFolder || []) unInner += `<tr><td>${esc(row.folder)}</td><td class="cnt">${row.count}</td></tr>`;
    unInner += '</tbody></table>';
    const list = (un.list || []).slice(0, 24);
    if (list.length) {
      unInner += '<div class="st-thumbs">';
      for (const it of list) {
        unInner += `<figure class="st-thumb" title="${esc(it.folder + ' / ' + it.stem)}"><img loading="lazy" decoding="async" src="/img?path=${enc(it.path)}&amp;thumb=1" alt=""><figcaption>${esc(it.stem)}</figcaption></figure>`;
      }
      unInner += '</div>';
      if (un.count > list.length) unInner += `<div class="un-note">上面只铺了前 ${list.length} 张，未鉴定共 ${un.count} 张。</div>`;
    }
  }
  html += stCard('未鉴定', `${un.count} 张 · 数字 + 按文件夹分组`, unInner, 'span3');

  html += '</div>';
  html += `<div class="un-note">共 ${d.total} 张图，其中已鉴定 ${L['已鉴定'] || 0} 张、未鉴定 ${L['未鉴定'] || 0} 张${d.truncated ? '（已达单次上限，结果不完整）' : ''}。</div>`;
  html += '<div class="un-note" style="margin-top:2px">行政区划索引：<a href="https://www.geonames.org/" target="_blank" rel="noreferrer">GeoNames</a>（CC BY 4.0），离线内置，不联网。</div>';

  $('statsBody').innerHTML = html;
  renderStatsTree(d.tree);
}

/* 注意：函数名不能叫 renderTree —— 左侧文件夹树已经有一个 renderTree()，
   同名函数声明会互相覆盖（后声明的赢），把左边的磁盘树搞坏。 */
function renderStatsTree(node) {
  const el = $('stree');
  if (!el) return;
  el.innerHTML = statsTreeHtml(node);
  el.querySelectorAll('.snode').forEach((n) => {
    n.addEventListener('click', (e) => {
      e.stopPropagation();
      const ul = n.parentElement.querySelector(':scope > ul.stree');
      if (ul) ul.style.display = ul.style.display === 'none' ? '' : 'none';
      const tw = n.querySelector('.tw');
      if (tw) tw.textContent = ul && ul.style.display === 'none' ? '▸' : '▾';
    });
  });
}

function statsTreeHtml(node, depth) {
  const d = depth || 0;
  const has = node.children && node.children.length;
  // 根和第一层直接展开，再往下先收起来，免得一屏全是树
  const open = d < 1;
  const tw = has ? `<span class="tw">${open ? '▾' : '▸'}</span>` : '<span class="tw"></span>';
  let s = '<li><span class="snode' + (node.leaf ? ' leaf' : '') + '">' + tw + '<span class="nm">' + esc(node.name) + '</span><span class="c">' + node.count + '</span></span>';
  if (has) {
    s += '<ul class="stree' + (d === 0 ? ' root' : '') + '"' + (open ? '' : ' style="display:none"') + '>';
    for (const c of node.children) s += statsTreeHtml(c, d + 1);
    s += '</ul>';
  }
  return s + '</li>';
}

/* ---------------- 「自然在线」标签页 ----------------
 * 原本独立成软件的「自然在线客户端」被做成了这里的一个模块：
 *   后端 lib/nature-client.js 是站点接口，lib/nature-store.js 管账号与令牌，
 *   这一层只管点。所有请求都走本机服务转发 —— 令牌不进浏览器，图片也走本机代理
 *   （直连站点会同时撞上 CORS、防盗链和令牌泄露三件事）。
 *
 * 和「标注」页的分工：识别还是 lib/adapters.js 里的 xingse 适配器管的，
 * 这里管的是账号里的**相册**：新建、上传、浏览、批量下载、删除。
 */

const NAT = {
  loaded: false,
  loggedIn: false,
  side: 'local', // local = 看本机文件夹的照片；album = 看站点相册里的照片
  localSel: new Set(), // 勾选的本地照片（绝对路径），用来上传
  albums: [],
  album: null, // 当前打开的相册 { id, title }
  photos: [],
  page: 1,
  size: 60,
  total: 0,
  sel: new Set(), // 勾选的照片 id
  res: new Map(), // photoId → 识别结果（和「标注」页那张图共用一个识别内核）
  busy: new Set(), // 正在识别的 photoId
  idRunning: false, // 这一轮识别还没跑完（自然在线页已不做识别）
  renames: new Map(), // photoId → 本机待上传的鉴定记录（只存名字，不存图片）
  timer: null, // 上传进度轮询
  upl: null, // 当前上传任务
  marqMoved: false, // 刚框选完，紧接着那次 click 要吞掉
  visibleTotal: 0, // 当前网格里显示着的可勾选照片数（render 时更新，全选按钮态用）
};
// jsdom 验收要拿得到相册状态（和 SCR / S 一个理由）
if (typeof window !== 'undefined') window.NAT = NAT;

/* ---------- 本机待上传鉴定记录 ----------
 * 相册端选好候选点「写入鉴定」先落到这里；「重新鉴定上传」再把纯名字提交给站点。
 * 图片自始至终不参与：站点收到的只有 photoId + NameID + 中文名/学名。
 * 和 nature-client 的 renames.json 是同一套思路，只是挪进了标注工坊的 data/。 */
function natPendingList() {
  return [...NAT.renames.values()].filter((r) => r && r.status !== 'done');
}

async function natRenamesLoad() {
  try {
    const r = await api('/api/nat/renames');
    NAT.renames = new Map(
      (r.records || []).filter((x) => x && x.photoId).map((x) => [String(x.photoId), x]),
    );
  } catch {
    NAT.renames = new Map();
  }
  refreshPendingBadge();
  return NAT.renames;
}

function refreshPendingBadge() {
  const n = natPendingList().length;
  for (const id of ['natPendingTag', 'natPendingCount']) {
    const el = $(id);
    if (el) el.textContent = String(n);
  }
  const btn = $('natReIdBtn');
  if (btn) {
    btn.title = n
      ? `有 ${n} 条写好的鉴定待同步：只传鉴定结果，不传图片`
      : '把本机写好的鉴定结果同步到自然在线（只传鉴定结果，不传图片）';
  }
}

/** 自然在线页卡片：本机已写好、还没上传的鉴定（识别结果统一去标注页看） */
function natPendingLine(p) {
  const rec = NAT.renames.get(String(p.photoId));
  if (!rec || rec.status === 'done') return '';
  const nm = [rec.chinese, rec.latin].filter(Boolean).join(' ') || '（未命名）';
  const bad = rec.status === 'failed' ? '上传失败 · ' : '';
  return `<div class="idr pending" title="已写入本机，等「重新鉴定上传」同步到自然在线">${bad}待上传 ${esc(nm)}</div>`;
}

function natOpen() {
  // 从评分页的相册端切过来时，接着看同一个相册（分数就印在卡片上）；
  // 其余情况停在本机文件夹：本页要靠左栏文件树选文件夹、拖子文件夹上传。
  const keepAlbum = Boolean(NAT.album) && SCR.mode === 'album'
    && String(SCR.albumId) === String(NAT.album.id);
  NAT.side = keepAlbum ? 'album' : 'local';
  syncNatSideUI(true);
  refreshNatScores();
  if (!NAT.loaded) natStatus();
  else natSyncUpBtn();
}

/** 评分页刚写进 /api/score/remote 的结果，自然在线这边重新读一次再刷卡片 */
async function refreshNatScores() {
  try {
    const r = await api('/api/score/remote');
    SCR.remote = r.items || {};
    if (S.tab === 'nature' && NAT.side === 'album' && (NAT.photos || []).length) renderNatPhotos();
  } catch {
    /* 读不到就沿用内存里已有的 */
  }
}

function natEmpty(title, sub) {
  const el = $('natEmpty');
  el.hidden = false;
  el.innerHTML = `<b>${esc(title)}</b>${esc(sub || '')}`;
}

/** 状态 = 登录情况 + 顺带验一下令牌还有没有效 */
async function natStatus() {
  const who = $('natWho');
  who.textContent = '正在检查登录状态…';
  $('natDot').className = 'nat-dot';
  try {
    const r = await api('/api/nat/status');
    NAT.loaded = true;
    NAT.loggedIn = !!r.loggedIn;
    const host = String(r.host || 'https://ecp.ibiodiversity.cn');
    const hostEl = $('natHost');
    hostEl.href = /^https?:\/\//i.test(host) ? host : 'https://' + host;
    hostEl.textContent = host + (r.central ? '' : '（联调假站点）');
    hostEl.title = '单击在浏览器打开 ' + host;
    hostEl.className = 'nat-host' + (r.central ? '' : ' local');
    if (NAT.loggedIn) {
      $('natDot').className = 'nat-dot on';
      who.innerHTML = `已登录 <b>${esc(r.username || '')}</b>${r.nickName ? ' · ' + esc(r.nickName) : ''}`;
      $('natLoginBox').hidden = true;
      $('natLogoutBtn').hidden = false;
      $('natEmpty').hidden = true;
      await natLoadAlbums();
      if (!NAT.album && NAT.side === 'album') {
        natEmpty(
          '选一个相册',
          '右边是账号里的相册。点开就能看照片，勾上几张可以下载原图或导出 KML 轨迹；在「标注」页勾好的图，点右上角那个按钮就能传上来。'
        );
      }
    } else {
      $('natDot').className = 'nat-dot warn';
      // 识别用的是包里内置的账号，未登录只影响相册/写回，文案上要说清楚，别让人以为识别坏了
      who.textContent =
        '相册未登录' +
        (r.reason && r.reason !== '未登录' && r.reason !== '相册未登录' ? '：' + r.reason : '') +
        (r.share && r.share.hasToken ? '（识别不受影响）' : '');
      $('natLoginBox').hidden = false;
      // 配置里存过用户自己登录过的账号名，就先预填上，少打一截
      if ($('natUserInput') && r.username && !$('natUserInput').value) $('natUserInput').value = r.username;
      $('natLogoutBtn').hidden = true;
      $('natAlbumList').innerHTML = '';
      $('natAlbumCount').textContent = '0';
      natEmpty(
        '先登录（只影响相册）',
        '自然在线的识别用的是程序内置的账号，不登录也能认植物；相册和写回鉴定动的是「你自己的照片」，所以要用你自己的账号。验证码只能人眼看，每次换令牌手动输一次；登录后令牌加密存在本机，重启不用再输。',
      );
      await natCaptcha();
    }
  } catch (err) {
    $('natDot').className = 'nat-dot warn';
    who.textContent = '连不上本机服务：' + err.message;
  }
  natSyncUpBtn();
}

async function natCaptcha() {
  const img = $('natCapImg');
  img.removeAttribute('src');
  try {
    const r = await api('/api/nat/captcha');
    img.dataset.key = r.key;
    img.src = r.image;
  } catch (err) {
    toast('验证码取不到：' + err.message);
  }
}

async function natLogin() {
  const u = (($('natUserInput') && $('natUserInput').value) || '').trim();
  const p = ($('natPassInput') && $('natPassInput').value) || '';
  if (!u) return toast('请填写自然在线的账号');
  if (!p) return toast('请填写密码');
  const v = $('natCapInput').value.trim();
  const key = $('natCapImg').dataset.key || '';
  if (!key) return toast('验证码还没出来');
  if (!v) return toast('请照图填写验证码');
  $('natLoginBtn').disabled = true;
  try {
    await post('/api/nat/login', { username: u, password: p, captcha: v, key });
    $('natCapInput').value = '';
    toast('登录成功');
    await natStatus();
  } catch (err) {
    toast('登录失败：' + err.message);
    await natCaptcha(); // 验证码一次性的，错了必须换一张
  } finally {
    $('natLoginBtn').disabled = false;
  }
}

async function natLoadAlbums() {
  const list = $('natAlbumList');
  list.innerHTML = '<div class="arch-loading"><span class="spin"></span> 读取相册…</div>';
  try {
    const r = await api('/api/nat/albums');
    NAT.albums = r.albums || [];
  } catch (err) {
    list.innerHTML = `<div class="empty" style="padding:22px 8px"><b>相册读不出来</b>${esc(err.message)}</div>`;
    return;
  }
  renderNatAlbums();
  natRefreshSelects();
}

function natRefreshSelects() {
  natSyncSel();
}

/** 上传进行中同步各按钮状态（这几个调用点原本是「移动到相册」按钮留下的） */
function natSyncTagBtn() {
  if ($('tagBatchBtn')) $('tagBatchBtn').disabled = Boolean(NAT.upl) || !S.sel.size || S.mode !== 'album';
  natSyncSel();
}

/** 标注页启动后静默拉一次相册：不阻塞界面，拉不到就等用户点开时再试 */
let natAlbumsLoading = false;
async function natEnsureAlbums() {
  if (NAT.albums.length || natAlbumsLoading) return;
  natAlbumsLoading = true;
  try {
    const r = await api('/api/nat/albums');
    NAT.albums = r.albums || [];
    natRefreshSelects();
  } catch {
    /* 站点没连上就先空着，别打扰标注页 */
  } finally {
    natAlbumsLoading = false;
  }
}

function renderNatAlbums() {
  $('natAlbumCount').textContent = NAT.albums.length;
  const list = $('natAlbumList');
  if (!NAT.albums.length) {
    list.innerHTML = '<div class="empty" style="padding:24px 8px"><b>还没有相册</b>点上面「＋ 新建」建一个</div>';
    return;
  }
  list.innerHTML = NAT.albums
    .map(
      (a) => `<div class="nat-album${NAT.album && NAT.album.id === a.id ? ' on' : ''}" data-id="${esc(a.id)}" data-title="${esc(a.title)}" title="点击查看；把勾选的照片拖到这里移动">
        <span class="ttl" title="${esc(a.title)}">${esc(a.title)}</span>
        <span class="cnt">${a.count || 0}</span>
        <button class="del" data-del="${esc(a.id)}" title="删除这个相册">×</button>
      </div>`
    )
    .join('');
}

/* ---------------- 标注页的「相册端」 ----------------
 * 为什么接进标注页而不是另开一页：要的是「像标注本地照片一样」处理相册照片 ——
 * 同一套网格、同一套勾选、同一套右侧面板（各站明细 + 候选表），只是照片在自然在线
 * 账号里，写回走站点接口而不是图片标签。
 *
 * 实现上不复制状态：相册照片当成「伪文件」塞进 S.files，path 用 nat:<photoId>，
 * 这样 render()/updateCount()/openPanel() 这些已有逻辑不用大改，只在几个入口认出
 * nat: 前缀换实现（卡片图、识别、面板脚注）。切回本机端时把快照还回去。
 */

const NAT_KEY = 'nat:';
const isNatKey = (p) => typeof p === 'string' && p.startsWith(NAT_KEY);

/** 相册照片 → 伪文件：字段和本机文件对齐，缺的留空，省得别处判空炸 */
function natPhotoAsFile(p) {
  return {
    path: NAT_KEY + p.photoId,
    name: p.fileName || p.name || p.photoId,
    size: Number(p.size) || 0,
    nat: p,
  };
}

/** 相册端左栏：相册列表 */
function renderAlbumRail() {
  const box = $('albumRail');
  if (!box) return;
  if (!NAT.loggedIn) {
    box.innerHTML =
      '<div class="ar-empty"><b>相册没登录</b><br>相册要用你自己的自然在线账号。到「自然在线」页登录一次（验证码只能人眼看），回来这里就有相册了。<br>识别本身用的是程序内置账号，不登录也能认。</div>';
    return;
  }
  if (!NAT.albums.length) {
    box.innerHTML = '<div class="ar-empty"><b>还没有相册</b>到「自然在线」页新建一个，再把照片传上去。</div>';
    return;
  }
  box.innerHTML = NAT.albums
    .map(
      (a) => `<div class="ar-item${NAT.album && NAT.album.id === a.id ? ' on' : ''}" data-id="${esc(a.id)}" data-title="${esc(a.title)}">
        <span class="ttl" title="${esc(a.title)}">${esc(a.title)}</span>
        <span class="cnt">${a.count || 0}</span>
      </div>`,
    )
    .join('');
}

/** 进相册端：先拉相册清单；已经选过相册就把照片铺出来 */
async function enterAlbumMode() {
  if (!NAT.loggedIn) await natStatus();
  await natEnsureAlbums();
  renderAlbumRail();
  if (NAT.album) await loadAlbumPhotos();
  else {
    S.files = [];
    NAT.photos = [];
    NAT.total = 0;
    S.sel.clear();
    S.active = null;
    renderAlbum();
  }
}

/** 打开某个相册：页码归 1、勾选清空 */
async function openAlbumHere(id, title) {
  NAT.album = { id, title };
  NAT.page = 1;
  S.page = 1;
  S.sel.clear();
  S.active = null;
  renderAlbumRail();
  await loadAlbumPhotos();
}

/** 拉当前相册的一页照片，转成伪文件铺到网格里 */
async function loadAlbumPhotos() {
  if (!NAT.album) return;
  const size = NAT.size || 120;
  const grid = $('grid');
  grid.innerHTML = '<div class="arch-loading"><span class="spin"></span> 读取照片…</div>';
  try {
    const r = await api(`/api/nat/photos?album=${enc(NAT.album.id)}&page=${NAT.page}&size=${size}`);
    NAT.photos = r.records || [];
    NAT.total = r.total || NAT.photos.length;
    if (r.album && r.album.title) NAT.album.title = r.album.title;
  } catch (err) {
    NAT.photos = [];
    NAT.total = 0;
    S.files = [];
    renderAlbum();
    $('empty').hidden = false;
    $('empty').innerHTML = `<b>照片读不出来</b>${esc(err.message)}`;
    return;
  }
  S.files = NAT.photos.map(natPhotoAsFile);
  renderAlbum();
  scAlbumSync();
}

/** 站点照片列表变了（换相册 / 翻页 / 同步完鉴定）时，评分页相册端跟着重铺 */
function scAlbumSync() {
  if (S.tab === 'score' && SCR.mode === 'album') scLoadAlbum();
}

/** 相册端的网格：和本机那套长得一样，图片走 /api/nat/img，卡片多一行识别结果 */
function renderAlbum() {
  const grid = $('grid');
  S.els.clear();
  grid.innerHTML = S.files.map(albumCardHtml).join('');
  for (const el of grid.children) {
    const p = el.dataset.p;
    if (p) S.els.set(p, el);
  }
  bindGridEvents(grid, false);
  renderAlbumPager();
  $('empty').hidden = S.files.length > 0;
  if (!S.files.length) {
    $('empty').innerHTML = NAT.album
      ? '<b>这个相册还是空的</b>到「自然在线」页把照片传上来，再回这里识别'
      : '<b>先在左边选一个相册</b>照片都在自然在线账号里，选一个相册就会铺在这里';
  }
  updateCount();
}

function albumCardHtml(f) {
  const on = S.sel.has(f.path);
  const act = S.active === f.path;
  const p = f.nat || {};
  const orig = [p.cname, p.lname].filter(Boolean).join(' ');
  const sub = orig || [p.date, p.place].filter(Boolean).join(' · ') || (f.size ? kb(f.size) : '站点未命名');
  return `<div class="card${on ? ' sel' : ''}${act ? ' active' : ''}" data-p="${esc(f.path)}">
        <div class="thumb" title="单击选中；点右下角放大镜看大图；点左上角圆圈勾选">
          <img loading="lazy" decoding="async" src="/api/nat/img?u=${enc(p.thumb || p.full || '')}" alt="">
          <span class="tick" title="单击勾选">${on ? '✓' : ''}</span>
          ${zoomBtnHtml(f.path)}
        </div>
        <div class="meta" title="单击勾选；双击手写中文名 / 拉丁名"><div class="nm" title="${esc(f.name)}">${esc(f.name)}</div><div class="sz">${esc(sub)}</div>${albumCardLine(f.path)}</div>
      </div>`;
}

/** 卡片上的识别结果行（相册端） */
function albumCardLine(key) {
  if (S.busy.has(key)) return '<div class="idr run"><span class="spin"></span>识别中…</div>';
  const rec = NAT.renames.get(String(key).slice(NAT_KEY.length));
  if (rec && rec.status !== 'done') {
    const nm = [rec.chinese, rec.latin].filter(Boolean).join(' ') || '（未命名）';
    return `<div class="idr pending" title="已写入本机，等「重新鉴定上传」同步到自然在线">待上传 ${esc(nm)}</div>`;
  }
  const r = S.results.get(key);
  if (!r) return '';
  if (r.error) return `<div class="idr bad" title="${esc(r.error)}">识别失败</div>`;
  const rows = r.rows || [];
  if (!rows.length) return '<div class="idr bad">没认出来</div>';
  const top = rows[0];
  const sup = Number(top.support) || 1;
  const tail = sup > 1 ? ` · ${sup} 站` : top.pct != null ? ` ${Math.round(top.pct)}%` : '';
  return `<div class="idr new">识别 ${esc(top.cn || top.latin || '')}${tail}</div>`;
}

function renderAlbumPager() {
  const bar = $('pager');
  if (!bar) return;
  const size = NAT.size || 120;
  const pages = Math.max(1, Math.ceil(NAT.total / size));
  bar.hidden = NAT.total <= size;
  if (bar.hidden) return;
  $('pgNow').textContent = String(NAT.page);
  $('pgTotal').textContent = String(pages);
  $('pgPrev').disabled = NAT.page <= 1;
  $('pgNext').disabled = NAT.page >= pages;
  const from = (NAT.page - 1) * size + 1;
  const to = Math.min(NAT.total, NAT.page * size);
  $('pgStat').textContent = `${from}–${to} 张 / 共 ${NAT.total} 张` + (S.sel.size ? ` · 已选 ${S.sel.size}` : '');
}

function toggleAlbum(p, jump = true) {
  if (S.sel.has(p)) S.sel.delete(p);
  else S.sel.add(p);
  S.active = p;
  patchAlbumCard(p);
  updateCount();
  if (jump) openPanel(p);
}

/** 只改一张卡片：勾选态、识别结果行 */
function patchAlbumCard(p) {
  const el = S.els.get(p);
  if (!el) return;
  const on = S.sel.has(p);
  el.classList.toggle('sel', on);
  el.classList.toggle('active', S.active === p);
  const tick = el.querySelector('.tick');
  if (tick) tick.textContent = on ? '✓' : '';
  const meta = el.querySelector('.meta');
  if (!meta) return;
  const old = meta.querySelector('.idr');
  const html = albumCardLine(p);
  if (!html) {
    if (old) old.remove();
    return;
  }
  if (old) old.outerHTML = html;
  else meta.insertAdjacentHTML('beforeend', html);
}

/** 相册端的右侧面板：图片、各站明细、候选表、写回按钮 */
function openAlbumPanel(p) {
  const f = S.files.find((x) => x.path === p) || { path: p, name: p.slice(NAT_KEY.length), nat: {} };
  const ph = f.nat || {};
  S.albumPick = null;
  $('panel').classList.add('nat-mode');
  $('panelEmpty').hidden = true;
  $('panelBody').hidden = false;
  $('pvImg').src = `/api/nat/img?u=${enc(ph.thumb || ph.full || '')}`;
  $('pvName').textContent = f.name;
  $('pvLabel').textContent = '来自自然在线相册 · 写回只改鉴定结果';
  $('pvExif').textContent = [[ph.cname, ph.lname].filter(Boolean).join(' '), ph.date, ph.place]
    .filter(Boolean)
    .join(' · ');
  $('writeMsg').textContent = '';
  $('natWriteMsg').textContent = '';
  const r = S.results.get(p);
  // 各站明细和标注页那张图是同一份数据、同一套画法，直接复用
  pvSitesPaint(r);
  renderAlbumCands(r);
  syncAlbumWrite();
}

/** 候选表（相册端）：点一条就是选中它，作为「写入鉴定」的内容 */
function renderAlbumCands(r) {
  const list = $('candList');
  if (!list) return;
  if (!r) {
    list.innerHTML = '<div class="dim" style="padding:6px 2px">还没识别。勾上这张，点右上「识别选中」。</div>';
    $('pvVerdict').textContent = '';
    return;
  }
  if (r.error) {
    list.innerHTML = `<div class="msg err">${esc(r.error)}</div>`;
    $('pvVerdict').textContent = '';
    return;
  }
  const rows = r.rows || [];
  if (!rows.length) {
    const failed = Object.entries(r.sites || {})
      .filter(([, v]) => !v.ok)
      .map(([k, v]) => `${SITE_NAME()[k] || k}：${v.error}`);
    list.innerHTML = `<div class="dim" style="padding:6px 2px">没有站点给出结果</div>${
      failed.length
        ? `<ul class="dim" style="padding-left:16px;font-size:11.5px">${failed.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`
        : ''
    }`;
    $('pvVerdict').textContent = '';
    return;
  }
  const names = SITE_NAME();
  const cacheNote = r.cached
    ? '<div class="dim" style="padding:2px 2px 6px;font-size:11.5px">本机缓存 · <a href="#" data-reid="1" style="color:inherit;text-decoration:underline">重新识别</a></div>'
    : '';
  list.innerHTML = cacheNote + rows
    .slice(0, 10)
    .map((row, i) => {
      const srcs = Object.keys(row.bySite || {}).map((k) => names[k] || k).join('、');
      return `<button class="cand${i === 0 ? ' on' : ''}" data-i="${i}" title="认出它的站：${esc(srcs)}">
        <span class="pct">${row.pct}%</span>
        <span class="nm"><div class="cn">${esc(row.cn || '（无中文名）')}</div><div class="la">${esc(row.latin || '')}</div></span>
        <span class="src">${row.support} 票</span>
      </button>`;
    })
    .join('');
  list.onclick = (e) => {
    const reid = e.target.closest('[data-reid]');
    if (reid) {
      e.preventDefault();
      identifyAlbumOne(S.active, { force: true });
      return;
    }
    const b = e.target.closest('.cand');
    if (!b) return;
    [...list.children].forEach((x) => x.classList.toggle('on', x === b));
    S.albumPick = rows[Number(b.dataset.i)] || null;
    syncAlbumWrite();
  };
  S.albumPick = rows[0];
  $('pvVerdict').textContent = r.verdict || '';
  prefetchTaxo(rows);
  syncAlbumWrite();
}

/** 候选选中状态同步到「写入鉴定」按钮 */
function syncAlbumWrite() {
  const btn = $('natWriteOne');
  if (!btn) return;
  const row = S.albumPick;
  btn.disabled = !row || !isNatKey(S.active);
  btn.textContent = row ? `写入「${row.cn || row.latin || '这个候选'}」` : '写入鉴定';
}

/** 相册端的「写入鉴定」：把选中的候选先存到本机待上传记录，不立即联网提交。
 *  之后由「重新鉴定上传」把纯名字同步到平台（图片不上传），再回读站点的新鉴定结果。 */
async function natWriteOne() {
  if (!isNatKey(S.active) || !S.albumPick) return toast('先在上面选一个候选');
  const row = S.albumPick;
  const photoId = S.active.slice(NAT_KEY.length);
  const ph = (S.files.find((x) => x.path === S.active) || {}).nat || {};
  const rec = {
    photoId,
    albumId: NAT.album ? String(NAT.album.id) : String(ph.albumId || ''),
    fileName: ph.fileName || ph.name || '',
    chinese: String(row.cn || '').trim(),
    latin: String(row.latin || '').trim(),
    nameId: '',
    original: { cname: ph.cname || '', lname: ph.lname || '' },
    status: 'pending',
    message: '',
    savedAt: Date.now(),
  };
  if (!rec.chinese && !rec.latin) return toast('这个候选没有名字，换一个候选');
  const btn = $('natWriteOne');
  if (btn) btn.disabled = true;
  $('natWriteMsg').textContent = '';
  try {
    const out = await post('/api/nat/renames', { records: [rec] });
    NAT.renames = new Map(
      (out.records || []).filter((x) => x && x.photoId).map((x) => [String(x.photoId), x]),
    );
    refreshPendingBadge();
    patchAlbumCard(S.active);
    const name = [rec.chinese, rec.latin].filter(Boolean).join(' ');
    $('natWriteMsg').innerHTML =
      `已写入「${esc(name)}」，<b>还没上传</b>。点旁边「重新鉴定上传」把鉴定结果同步到自然在线（图片不上传）。`;
  } catch (err) {
    $('natWriteMsg').textContent = '写入失败：' + err.message;
  } finally {
    if (btn) btn.disabled = false;
    syncAlbumWrite();
  }
}

/** 本机端 ⇄ 相册端：只换「照片从哪来」，网格和右侧面板是同一套 */
async function setSource(mode, opts = {}) {
  const m = mode === 'album' ? 'album' : 'local';
  if (m === 'album' && (S.tab === 'stats' || S.tab === 'archive' || S.tab === 'nature')) {
    toast(
      S.tab === 'nature'
        ? '自然在线页右边就是相册列表，直接点右边的相册看照片；左栏留给本机文件夹'
        : '统计分析 / 按分类归档只处理本机文件夹，相册端在这里不可用',
      3200,
    );
    return;
  }
  if (S.mode === m) return;
  // 进相册端前把本机这份收好（S.files 要被相册占用），切回来原样还回去
  if (m === 'album') S.localSnap = { files: S.files, dir: S.dir, dirs: S.dirs, page: S.page };
  S.mode = m;
  S.sel.clear();
  S.active = null;
  S.queue = 0;
  S.albumPick = null;
  const alb = m === 'album';
  if ($('srcSeg')) [...$('srcSeg').children].forEach((b) => b.classList.toggle('on', b.dataset.src === m));
  $('panel').classList.toggle('nat-mode', alb);
  $('panelEmpty').hidden = false;
  $('panelBody').hidden = true;
  $('railHeadFiles').hidden = alb;
  $('railHeadAlbums').hidden = !alb;
  $('albumRail').hidden = !alb;
  const pathbox = $('pathInput') && $('pathInput').closest('.pathbox');
  if (pathbox) pathbox.hidden = alb;
  if ($('places')) $('places').hidden = alb;
  if ($('tree')) $('tree').hidden = alb;
  // 相册端没有「筛选未标注」「导出清单」；「照片评分」两个来源都能用，保留
  if ($('filterSeg')) $('filterSeg').hidden = alb;
  if ($('exportBtn')) $('exportBtn').hidden = alb;
  if ($('toScoreBtn')) $('toScoreBtn').hidden = false;
  if ($('selAll')) $('selAll').textContent = alb ? '全选本页' : S.filter === 'nolatin' ? '全选没有学名' : '全选未标注';
  // 批量鉴定只在相册端出现（本机端没有「写回站点鉴定」这回事）
  if ($('tagBatchBtn')) $('tagBatchBtn').hidden = !alb;
  if (alb) {
    await enterAlbumMode();
  } else {
    const snap = S.localSnap || {};
    S.files = snap.files || [];
    S.dir = snap.dir || S.dir;
    S.dirs = snap.dirs || [];
    S.page = snap.page || 1;
    if ($('pager')) $('pager').hidden = true;
    // 目录树还没读出来（刚启动、磁盘慢）时不挡着切回来，下一次读盘会自己补上
    try {
      renderTree();
    } catch {
      /* 树没准备好就先空着 */
    }
    render();
  }
  // 自然在线页、评分页都没有自己的来源开关，一律跟随这里
  NAT.side = alb ? 'album' : 'local';
  syncNatSideUI(S.tab === 'nature');
  if (S.tab === 'score') scoreOpen();
  updateCount();
  if (!opts.quiet) toast(alb ? '已切到相册端：照片来自自然在线账号' : '已切回本机端', 2000);
}

/* ---------------- 自然在线：中间这块看什么，由左栏的「本机端 / 相册端」决定 ---------------- */

/** 当前本地文件夹里能看的图片（和标注页同一份 S.files，不额外读盘） */
function natLocalList() {
  return (S.files || []).filter((f) => /\.(jpe?g|png|webp|bmp|tiff?)$/i.test(String(f.name || '')));
}

/**
 * 同步自然在线页中间那块的按钮 + 网格。
 * 来源不再由页面内的开关决定，而是读左栏的 S.mode（setSource 会同步 NAT.side）。
 * reload=false 只刷按钮，用在「人不在自然在线页」的时候，避免白白联网拉照片。
 */
function syncNatSideUI(reload) {
  const albumMode = NAT.side === 'album';
  if ($('natLocalActs')) $('natLocalActs').hidden = albumMode;
  if ($('natAlbumActs')) $('natAlbumActs').hidden = !albumMode;
  // 本机端：提示可以直接拖；相册端：提示怎么回文件夹（左栏锁的是本机端）
  if ($('natDragHint')) {
    $('natDragHint').hidden = false;
    $('natDragHint').textContent = albumMode
      ? '勾选照片后，拖到右边相册即可移动；点左栏「本机端」回文件夹'
      : '拖照片 / 子文件夹到右边相册即可上传';
  }
  if (!reload) { natSyncSel(); return; }
  if (albumMode) {
    if (NAT.album) natLoadPhotos();
    else {
      $('natGrid').innerHTML = '';
      $('natPager').hidden = true;
      NAT.visibleTotal = 0;
      NAT.photos = [];
      $('natAlbumName').textContent = '选右边的相册看照片';
      natEmpty('选一个相册', '右边是账号里的相册，点开就能看照片；勾上几张可以下载原图或导出 KML 轨迹。');
    }
  } else {
    renderNatLocal();
  }
  natSyncSel();
}

/**
 * 本机端的子文件夹卡片：单击进去，拖到右边某个相册 = 把整个文件夹传上去。
 * 样式沿用标注页的 .card.folder，只多一个可拖标记。
 */
function natFolderCardHtml(d) {
  return `<div class="card folder nat-folder" draggable="true" data-d="${esc(d.path)}" title="单击进入「${esc(d.name)}」；拖到右边相册即可上传这个文件夹">
    <div class="thumb fold">
      <svg viewBox="0 0 48 48" width="46" height="46" aria-hidden="true">
        <path d="M6 14a3 3 0 0 1 3-3h9l4 4.5h17a3 3 0 0 1 3 3v3H6z" fill="#dcae5d"/>
        <path d="M6 19h36l-4 16.5a3 3 0 0 1-3 2.5H12a3 3 0 0 1-3-2.6z" fill="#f0c877"/>
      </svg>
      <span class="nat-drag-mark" title="拖到右边相册上传">⇢</span>
    </div>
    <div class="meta"><div class="nm" title="${esc(d.path)}">${esc(d.name)}</div><div class="sz">文件夹 · 可拖到右边相册</div></div>
  </div>`;
}

/** 本地模式：子文件夹 + 图片一起铺成卡片；照片可勾选，也可拖到右边相册上传 */
function renderNatLocal() {
  const grid = $('natGrid');
  if (!grid) return;
  $('natPager').hidden = true;
  const files = natLocalList();
  const dirs = S.dirs || [];
  NAT.visibleTotal = files.length;
  // 换了文件夹后，勾选里那些已经不在本目录的路径要清掉，免得「上传这些 N 张」数字虚高
  const valid = new Set(files.map((f) => f.path));
  for (const p of [...NAT.localSel]) if (!valid.has(p)) NAT.localSel.delete(p);
  $('natAlbumName').textContent = S.dir ? shortenPath(S.dir) : '先在左边选一个文件夹';
  $('natAlbumName').title = S.dir || '';
  grid.innerHTML = '';
  if (!files.length && !dirs.length) {
    natEmpty(
      '这个文件夹没有图片',
      S.dir ? '换一个文件夹；右边是账号里的相册，点开就能看站点照片。' : '在左边的文件树里点一个装有照片的文件夹。',
    );
    natSyncSel();
    return;
  }
  $('natEmpty').hidden = true;
  const frag = document.createDocumentFragment();
  // 子文件夹排在照片前面：和标注页一致，也方便一眼把整个文件夹拖到右边相册
  for (const d of dirs) {
    const wrap = document.createElement('div');
    wrap.innerHTML = natFolderCardHtml(d);
    frag.appendChild(wrap.firstElementChild);
  }
  for (const f of files) {
    const on = NAT.localSel.has(f.path);
    const card = document.createElement('div');
    card.className = `card${on ? ' sel' : ''}`;
    card.dataset.p = f.path;
    card.draggable = true;
    card.title = `${f.name}｜单击勾选；拖到右边相册上传；点右下角放大镜看大图`;
    card.innerHTML = `
      <div class="thumb">
        <img loading="lazy" decoding="async" draggable="false" src="/img?path=${enc(f.path)}&amp;thumb=1" alt="">
        <span class="tick">${on ? '✓' : ''}</span>
        ${zoomBtnHtml(f.path)}
      </div>
      <div class="meta">
        <div class="nm" title="${esc(f.name)}">${esc(f.name)}</div>
        <div class="sz">${esc(f.labelTitle || (f.labeled ? '已标注' : '未标注'))}</div>
      </div>`;
    frag.appendChild(card);
  }
  grid.appendChild(frag);
  natSyncSel();
}

async function natUploadLocal() {
  const files = [...NAT.localSel];
  if (!files.length) return toast('先勾选要上传的本地照片');
  const mode = $('natUpMode').value;
  if (mode === 'album' && !NAT.album) return toast('先在右边选一个目标相册');
  await natRunUpload(files, mode, NAT.album ? NAT.album.id : '');
}

async function natOpenAlbum(id, title) {
  NAT.album = { id, title };
  NAT.page = 1;
  NAT.sel.clear();
  renderNatAlbums();
  $('natAlbumName').textContent = title;
  // 相册列就在右边，左栏保持本机端不动；中间这块单独切到站点照片
  NAT.side = 'album';
  syncNatSideUI(false);
  await natLoadPhotos();
  natSyncUpBtn();
  natSyncSel();
}

async function natLoadPhotos() {
  if (!NAT.album) return;
  const grid = $('natGrid');
  $('natEmpty').hidden = true;
  grid.innerHTML = '<div class="arch-loading"><span class="spin"></span> 读取照片…</div>';
  try {
    const r = await api(`/api/nat/photos?album=${enc(NAT.album.id)}&page=${NAT.page}&size=${NAT.size}`);
    NAT.photos = r.records || [];
    NAT.total = r.total || NAT.photos.length;
    if (r.album && r.album.title) {
      NAT.album.title = r.album.title;
      $('natAlbumName').textContent = r.album.title;
    }
  } catch (err) {
    grid.innerHTML = '';
    natEmpty('照片读不出来', err.message);
    return;
  }
  renderNatPhotos();
}

function renderNatPhotos() {
  const grid = $('natGrid');
  grid.innerHTML = '';
  NAT.visibleTotal = NAT.photos.length;
  if (!NAT.photos.length) {
    natEmpty('这个相册还是空的', '在「标注」页勾好图，再点上面那个「上传选中的」');
    renderNatPager();
    natSyncSel();
    return;
  }
  $('natEmpty').hidden = true;
  const frag = document.createDocumentFragment();
  for (const p of NAT.photos) {
    const on = NAT.sel.has(p.photoId);
    const card = document.createElement('div');
    card.className = 'card' + (on ? ' sel' : '');
    card.dataset.id = p.photoId;
    card.draggable = on;
    card.setAttribute('draggable', on ? 'true' : 'false');
    const label = [p.cname, p.lname].filter(Boolean).join(' ') || p.fileName || p.photoId;
    // 第二行只放日期/地点：标题已经是文件名时再重复一遍没意义
    const sub = [p.date, p.place].filter(Boolean).join(' · ');
    const src = p.thumb || p.full;
    card.title = `${label}｜单击勾选；勾选后可拖到右边相册；点右下角放大镜看大图`;
    card.innerHTML = `
      <div class="thumb">
        <img loading="lazy" decoding="async" draggable="false" src="/api/nat/img?u=${enc(src)}" alt="">
        <span class="tick">${on ? '✓' : ''}</span>
        ${natScoreBadge(p)}
        ${zoomBtnHtml(NAT_KEY + p.photoId)}
      </div>
      <div class="meta">
        <div class="nm" title="${esc(label)}">${esc(label)}</div>
        <div class="sz">${esc(sub || (p.size > 0 ? kb(p.size) : ''))}</div>
        ${natPendingLine(p)}
        ${natScoreLine(p)}
      </div>`;
    frag.appendChild(card);
  }
  grid.appendChild(frag);
  renderNatPager();
  natSyncSel();
  scAlbumSync();
}

function renderNatPager() {
  const pages = Math.max(1, Math.ceil(NAT.total / NAT.size));
  $('natPager').hidden = NAT.total <= NAT.size;
  $('natPgNow').textContent = NAT.page;
  $('natPgTotal').textContent = pages;
  $('natPgStat').textContent = `共 ${NAT.total} 张`;
  $('natPgPrev').disabled = NAT.page <= 1;
  $('natPgNext').disabled = NAT.page >= pages;
}

function natSyncSel() {
  const localMode = NAT.side === 'local';
  const n = localMode ? NAT.localSel.size : NAT.sel.size;
  const localUp = $('natLocalUp');
  if (localUp) {
    localUp.textContent = `↑ 上传这些 ${n} 张`;
    localUp.disabled = !n || !NAT.loggedIn || Boolean(NAT.upl)
      || ($('natUpMode').value === 'album' && !NAT.album);
    localUp.title = NAT.album
      ? `把这里勾选的 ${n} 张本地照片传到相册「${NAT.album.title}」`
      : '先在右边选一个目标相册（或把「上传到」改成「按物种名分相册」）';
  }
  $('natSelInfo').textContent = n ? `已选 ${n} 张` : '';
  const reid = $('natReIdBtn');
  if (reid) reid.disabled = false; // 读本机待上传记录，不依赖当前勾选
  const busy = Boolean(NAT.upl) || NAT.idRunning;
  if ($('natBatchBtn')) $('natBatchBtn').disabled = localMode || !n || busy;
  if ($('natDelBtn')) $('natDelBtn').disabled = localMode || !n || busy;
  // 下载类只在相册端可用；没勾选就按本页全部处理，所以只要本页有照片就能点
  const hasPhotos = !localMode && (NAT.photos || []).length > 0;
  if ($('natOrigBtn')) $('natOrigBtn').disabled = !hasPhotos;
  if ($('natKmlBtn')) $('natKmlBtn').disabled = !hasPhotos;
  // 全选 / 清空：没有可选的就灰掉；全选只作用于当前显示的这一屏
  if ($('natSelAll')) $('natSelAll').disabled = !NAT.visibleTotal || n >= NAT.visibleTotal;
  if ($('natSelNone')) $('natSelNone').disabled = n === 0;
}

/* ---------------- 自然在线：框选 + 全选（本机文件夹 / 相册照片两个模式共用） ---------------- */

/** 当前模式生效的勾选集合：本地按绝对路径、相册按 photoId */
function natSelSet() {
  return NAT.side === 'local' ? NAT.localSel : NAT.sel;
}

/** 当前网格里显示着的照片 key（本地是路径，相册是 photoId），全选只勾这些 */
function natVisibleKeys() {
  const grid = $('natGrid');
  if (!grid) return [];
  const localMode = NAT.side === 'local';
  const out = [];
  for (const card of grid.querySelectorAll('.card')) {
    const key = localMode ? card.dataset.p : card.dataset.id;
    if (key) out.push(key);
  }
  return out;
}

/** 把勾选集合刷到卡片上：框选 / 全选 / 清空 / 单击切换都走这里，和评分页 scSelApply 一个套路 */
function natSelApply() {
  const grid = $('natGrid');
  if (!grid) return;
  const localMode = NAT.side === 'local';
  const set = natSelSet();
  for (const card of grid.querySelectorAll('.card')) {
    const key = localMode ? card.dataset.p : card.dataset.id;
    if (!key) continue;
    const on = set.has(key);
    if (card.classList.contains('sel') !== on) card.classList.toggle('sel', on);
    const tk = card.querySelector('.tick');
    if (tk) {
      const want = on ? '✓' : '';
      if (tk.textContent !== want) tk.textContent = want; // 大文件夹框选拖动时别做无谓 DOM 写
    }
    // 相册照片只有勾选后才可拖：未勾选时按下仍能拉框选，不会一碰就变拖拽
    if (!localMode) {
      card.draggable = on;
      card.setAttribute('draggable', on ? 'true' : 'false');
    }
  }
  natSyncSel();
}

/** 全选：只勾当前这一屏（本机＝当前文件夹、相册＝当前这一页） */
function natSelectAll() {
  const keys = natVisibleKeys();
  if (!keys.length) return toast('这里没有可勾选的照片');
  const set = natSelSet();
  for (const k of keys) set.add(k);
  natSelApply();
}

/** 清空：取消当前模式下的全部勾选 */
function natSelectNone() {
  natSelSet().clear();
  natSelApply();
}

/** 框选：在照片区按住拖出橡皮筋，框住的即勾上；Shift/Ctrl 按住拖是在已有勾选上追加。
 *  和评分页 bindScMarquee 一个套路（document 级 move/up，别用 setPointerCapture），
 *  差别是这里**未勾选的卡片上也可以起笔**：移动不足 4px 视为单击（仍走 onclick 勾选），
 *  超过就进框选，并用 NAT.marqMoved 吞掉松手后紧跟的那次 click，防止刚框到的又被取消。
 *  勾选后的相册卡片才变成 draggable，这样「框选」和「拖到另一个相册」不抢手势。
 */
function bindNatMarquee() {
  const grid = $('natGrid');
  if (!grid) return;
  grid.addEventListener('pointerdown', (e) => {
    NAT.marqMoved = false; // 上一轮没消费掉的吞 click 标记在这里复位（click 和 pointerup 是否同一任务各浏览器不一，别用定时器猜）
    if (e.button !== 0 || e.pointerType === 'touch') return;
    if (NAT.idRunning || NAT.upl) return; // 识别/上传进行中别画框
    const startCard = e.target.closest ? e.target.closest('.card') : null;
    // 卡片本身可拖到右边相册：别让框选抢走这个手势；框选仍可在空白处起笔
    if (startCard && startCard.getAttribute('draggable') === 'true') return;
    scClearTextSelection();
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const localMode = NAT.side === 'local';
    const base = additive ? new Set(natSelSet()) : new Set();
    const box = document.createElement('div');
    box.className = 'sc-marquee';
    document.body.appendChild(box);
    grid.classList.add('dragging');
    const x0 = e.clientX; const y0 = e.clientY;
    let moved = false;
    const onMove = (ev) => {
      const dx = ev.clientX - x0; const dy = ev.clientY - y0;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      moved = true;
      const l = Math.min(x0, ev.clientX); const t = Math.min(y0, ev.clientY);
      const w = Math.abs(dx); const h = Math.abs(dy);
      box.style.left = `${l}px`; box.style.top = `${t}px`;
      box.style.width = `${w}px`; box.style.height = `${h}px`;
      const hits = new Set(base);
      for (const card of grid.querySelectorAll('.card')) {
        const key = localMode ? card.dataset.p : card.dataset.id;
        if (!key) continue;
        const r = card.getBoundingClientRect();
        if (!r.width && !r.height) continue; // 没排版的节点当作不在框里
        if (r.right < l || r.left > l + w || r.bottom < t || r.top > t + h) continue;
        hits.add(key);
      }
      if (localMode) NAT.localSel = hits; else NAT.sel = hits;
      natSelApply();
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      box.remove();
      grid.classList.remove('dragging');
      if (moved) {
        // 松手后紧跟的那次 click 要吞掉，否则会把刚框到的又取消；
        // 标记会在下一次 pointerdown 一进来就复位（见上），漏吞/误吞都不会跨手势
        NAT.marqMoved = true;
      } else if (!startCard && !additive) {
        // 在空白处单击：清空勾选（和评分页一致）
        natSelSet().clear();
        natSelApply();
      }
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  });
}

/** 站点上的图做识别用：只压多识要的那份 ≤640 小图 */
function natVariants(p) {
  // 原图本身就是 JPEG 时不要再压一份 1600 的覆盖它 —— 站点拿原图打分更准
  // （实测重压版会把 98% 压到 28%），只有 png/webp 才补一份 JPEG 副本。
  const needJpeg = !/\.jpe?g$/i.test(p.fileName || p.full || '');
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const out = { dataSmall: draw(img, 640, 0.85) };
        if (needJpeg) out.dataJpeg = draw(img, 1600, 0.9);
        resolve(out);
      } catch {
        resolve({});
      }
    };
    img.onerror = () => resolve({});
    img.src = `/api/nat/img?u=${enc(p.full || p.thumb)}`;
  });
}

/* ---------------- 自然在线：写回鉴定（只改鉴定结果，不动原图） ----------------
 * 和原独立版 nature-client 的「重新鉴定上传 / 批量鉴定」是同一条链路：
 *   GET  /api/nat/taxa        把名字解析成站点分类库的 NameID
 *   POST /api/nat/reidentify  提交纯 JSON（photoId + NameID + 中文名/学名）
 * 站点收到后覆盖这几张照片的鉴定结果；图片文件完全不参与，也不会新增照片。
 * 千万别和「上传」混了：上传走 /api/nat/upload，会往相册里多出一张图。
 */
const NW = { rows: [], taxa: [], nameId: '', submitting: false, mode: 'write' };

/** 在分类库候选里挑最贴近的：学名精确 > 中文精确 > 学名前缀 > 首个（照原版口径） */
function nwPickTaxon(taxa, chinese, latin) {
  const list = Array.isArray(taxa) ? taxa : [];
  if (!list.length) return null;
  const zh = String(chinese || '').trim();
  const la = String(latin || '').trim().toLowerCase();
  return (
    (zh && list.find((t) => String(t.nameZh || '').trim() === zh)) ||
    (la && list.find((t) => String(t.spName || '').trim().toLowerCase() === la)) ||
    (la && list.find((t) => String(t.spName || '').trim().toLowerCase().startsWith(la))) ||
    list[0]
  );
}

function nwCollect() {
  for (const el of $('nwList').querySelectorAll('.nw-cn')) {
    const r = NW.rows.find((x) => x.photoId === el.dataset.id);
    if (r) r.chinese = el.value.trim();
  }
  for (const el of $('nwList').querySelectorAll('.nw-la')) {
    const r = NW.rows.find((x) => x.photoId === el.dataset.id);
    if (r) r.latin = el.value.trim();
  }
}

/**
 * 打开鉴定提交面板。三个入口共用这一套，最后都走 /api/nat/reidentify（纯 JSON，不传图片）：
 *   nwOpenReId()  → mode='reid'  「重新鉴定上传」：本机待上传记录，逐张各自名字
 *   nwOpenBatch() → mode='batch' 「批量鉴定」：勾选的多张照片统一赋一个名字
 *   nwOpen()      → mode='write' 兼容旧的直接写回入口
 */
function nwOpen(opts) {
  const o = opts || {};
  NW.mode = o.mode || 'write';
  let ids = Array.isArray(o.ids) ? o.ids.slice() : [];
  const hasRecords = Array.isArray(o.records);
  if (!ids.length && !hasRecords) ids = nwPickedIds();
  if (!ids.length && !hasRecords) {
    return toast(NW.mode === 'batch' ? '先勾选要批量鉴定的照片' : '先勾选要写回的照片');
  }
  if (hasRecords) {
    NW.rows = o.records.map((rec) => ({
      photoId: String(rec.photoId),
      fileName: String(rec.fileName || ''),
      original: [rec.original && rec.original.cname, rec.original && rec.original.lname]
        .filter(Boolean)
        .join(' ') || '（站点未命名）',
      chinese: String(rec.chinese || ''),
      latin: String(rec.latin || ''),
      checked: true,
      status: '',
      message: rec.status === 'failed' ? `上次失败：${rec.message || ''}` : '',
      removable: NW.mode === 'reid',
      nameId: String(rec.nameId || ''),
    }));
  } else {
    const single = ids.length === 1 && (o.zh || o.la) ? o : null;
    NW.rows = ids.map((id) => {
      const p = NAT.photos.find((x) => x.photoId === id) || { photoId: id };
      const r = NAT.res.get(id) || S.results.get(NAT_KEY + id);
      const top = (r && (r.rows || [])[0]) || null;
      return {
        photoId: id,
        fileName: p.fileName || p.name || '',
        original: [p.cname, p.lname].filter(Boolean).join(' ') || '（站点未命名）',
        chinese: single ? String(single.zh || '') : top ? String(top.cn || '') : String(p.cname || ''),
        latin: single ? String(single.la || '') : top ? String(top.latin || '') : String(p.lname || ''),
        checked: true,
        status: '',
        message: '',
        removable: false,
        nameId: '',
      };
    });
  }
  NW.taxa = [];
  NW.nameId = '';
  NW.submitting = false;
  $('nwBatch').checked = !!o.batch;
  $('nwChinese').value = '';
  $('nwLatin').value = '';
  $('nwKw').value = '';
  $('nwErr').textContent = '';
  if ($('nwAutoMsg')) $('nwAutoMsg').textContent = '';
  $('nwClearLock').hidden = true;
  $('nwLocked').hidden = true;
  $('nwTaxaList').innerHTML = '<div class="empty">输入中文名或学名后点「检索」；留空则提交时按每张的名字自动匹配。</div>';
  const title = { reid: '重新鉴定上传', batch: '批量鉴定', write: '写回鉴定到自然在线' }[NW.mode]
    || '写回鉴定到自然在线';
  $('nwTitle').textContent = title;
  $('nwTip').innerHTML = NW.mode === 'reid'
    ? '下面是<b>本机已经写好、还没上传</b>的鉴定结果。提交时只发照片 id 与名字（纯 JSON），<b>图片不上传、不新增照片</b>；成功后重新读取自然在线，把站点返回的新鉴定结果显示回来。'
    : NW.mode === 'batch'
      ? '对勾选的多张照片<b>统一赋同一个名字</b>，一次提交鉴定。只发照片 id 与名字，<b>图片不上传</b>；成功后重新读取站点返回的新鉴定结果。'
      : '把下面的名字作为「重新鉴定」提交到网页端，站点会覆盖这些照片的鉴定结果。<b>不上传图片、不新增照片、不删除原图</b>。';
  $('nwSubmit').textContent = NW.mode === 'reid'
    ? '上传鉴定结果'
    : NW.mode === 'batch' ? '提交批量鉴定' : '提交写回';
  $('natWriteMask').classList.add('show');
  nwSyncBatch();
  nwRender();
}

/** 自然在线页「重新鉴定上传」：把本机待上传的记录列出来，默认全部勾选 */
async function nwOpenReId() {
  await natRenamesLoad();
  const pending = natPendingList();
  if (!pending.length) {
    return toast('没有待上传的鉴定。先在「标注」页相册端选候选点「写入鉴定」，或用「批量鉴定」统一赋名。', 3800);
  }
  nwOpen({ mode: 'reid', records: pending });
}

/** 当前勾选的站点照片 id：标注页相册端优先，其次自然在线页里勾的照片 */
function nwPickedIds() {
  // 自然在线页的勾选在 NAT.sel；别拿标注页隐藏的 S.sel 去串台
  if (S.tab === 'nature') return NAT.side === 'album' ? [...NAT.sel] : [];
  const tagPicked = [...S.sel].filter(isNatKey).map((k) => k.slice(NAT_KEY.length));
  return tagPicked.length ? tagPicked : [...NAT.sel];
}

/** 「标注」页相册端的「批量鉴定」：对勾选的照片统一赋一个名字，一次提交（只传名字） */
function nwOpenBatch() {
  const ids = nwPickedIds();
  if (!ids.length) return toast('先在相册里勾选要批量鉴定的照片', 3000);
  nwOpen({ mode: 'batch', ids, batch: true });
}

/** 从本机待上传记录里移除一条（写错了、或不想传了） */
async function nwRemoveRecord(photoId) {
  try {
    const out = await post('/api/nat/renames/delete', { ids: [photoId] });
    NAT.renames = new Map(
      (out.records || []).filter((x) => x && x.photoId).map((x) => [String(x.photoId), x]),
    );
    refreshPendingBadge();
    NW.rows = NW.rows.filter((r) => r.photoId !== photoId);
    nwRender();
    if (S.mode === 'album') renderAlbum();
    toast('已从待上传记录里移除');
  } catch (err) {
    toast('移除失败：' + err.message, 3000);
  }
}

function nwClose() {
  $('natWriteMask').classList.remove('show');
}

function nwSyncBatch() {
  const on = $('nwBatch').checked;
  $('nwBatchBox').hidden = !on;
  if ($('nwAutoMsg')) $('nwAutoMsg').hidden = !on;
  document.querySelector('.sheet.nw').classList.toggle('batch', on);
  if (on && !$('nwChinese').value && !$('nwLatin').value) {
    const first = NW.rows.find((r) => r.checked) || NW.rows[0];
    if (first) {
      $('nwChinese').value = first.chinese;
      $('nwLatin').value = first.latin;
    }
  }
}

function nwRender() {
  const box = $('nwList');
  box.innerHTML = NW.rows
    .map(
      (r) => `<div class="nw-row${r.checked ? ' sel' : ''}" data-id="${esc(r.photoId)}">
      <input type="checkbox" class="nw-chk-row" data-id="${esc(r.photoId)}" ${r.checked ? 'checked' : ''}>
      ${r.removable ? `<button class="nw-row-del" data-del="${esc(r.photoId)}" title="从本机待上传记录里移除">×</button>` : ''}
      <div class="nw-row-main">
        <div class="nw-row-name" title="${esc(r.fileName || r.photoId)}">${esc(r.fileName || r.photoId)}</div>
        <div class="nw-row-orig">站点原名：${esc(r.original)}</div>
        <div class="nw-row-inputs">
          <input type="text" class="nw-cn" data-id="${esc(r.photoId)}" placeholder="中文名" value="${esc(r.chinese)}">
          <input type="text" class="nw-la" data-id="${esc(r.photoId)}" placeholder="学名" value="${esc(r.latin)}">
        </div>
        <div class="nw-row-stat ${r.status === 'ok' ? 'ok' : r.status === 'bad' ? 'bad' : ''}">${esc(r.message || '')}</div>
      </div>
    </div>`,
    )
    .join('');
  const n = NW.rows.filter((r) => r.checked).length;
  $('nwCount').textContent = `已选 ${NW.rows.length} 张，勾选 ${n} 张`;
  $('nwSubmit').disabled = !n || NW.submitting;
}

async function nwSearch() {
  const kw = $('nwKw').value.trim();
  if (!kw) return toast('填个中文名或学名再检索');
  try {
    const r = await api(`/api/nat/taxa?keyword=${enc(kw)}&limit=12`);
    NW.taxa = r.taxa || [];
    if (!NW.taxa.length) {
      $('nwTaxaList').innerHTML = '<div class="empty">分类库里没找到，换个关键词试试</div>';
      return;
    }
    $('nwTaxaList').innerHTML = NW.taxa
      .map((t) => {
        const id = String(t.nameId);
        const on = NW.nameId === id ? ' on' : '';
        return `<button class="nw-chip${on}" data-id="${esc(id)}" data-zh="${esc(t.nameZh || '')}" data-sp="${esc(t.spName || '')}">${esc(
          t.nameZh || t.spName || id,
        )}${t.spName ? `<i>${esc(t.spName)}</i>` : ''}${t.levelName ? ` · ${esc(t.levelName)}` : ''}</button>`;
      })
      .join('');
  } catch (err) {
    $('nwErr').textContent = '分类库检索失败：' + err.message;
  }
}

function nwLock(id, zh, sp) {
  NW.nameId = String(id);
  $('nwClearLock').hidden = false;
  $('nwLocked').hidden = false;
  $('nwLocked').textContent = `已锁定分类：${[zh, sp].filter(Boolean).join('  ')}（NameID ${NW.nameId}）`;
  // 一个 NameID 对应一个名字：锁定后自动切到「统一名字」，免得把不同名字挂到同一条分类上
  $('nwBatch').checked = true;
  $('nwChinese').value = zh || '';
  $('nwLatin').value = sp || '';
  nwSyncBatch();
  nwRender();
  for (const c of $('nwTaxaList').querySelectorAll('.nw-chip')) {
    c.classList.toggle('on', c.dataset.id === NW.nameId);
  }
}

function nwClearLock() {
  NW.nameId = '';
  $('nwClearLock').hidden = true;
  $('nwLocked').hidden = true;
  for (const c of $('nwTaxaList').querySelectorAll('.nw-chip')) c.classList.remove('on');
}

async function nwAutoNameId(chinese, latin) {
  const kw = String(latin || chinese || '').trim();
  if (!kw) throw new Error('中文名与学名至少填一项');
  const r = await api(`/api/nat/taxa?keyword=${enc(kw)}&limit=10`);
  const pick = nwPickTaxon(r.taxa || [], chinese, latin);
  if (!pick) throw new Error(`分类库里没找到「${kw}」，请在上面检索并点一条锁定 NameID`);
  return String(pick.nameId);
}

async function nwSubmit() {
  if (NW.submitting) return;
  nwCollect();
  const batch = $('nwBatch').checked;
  const bzh = $('nwChinese').value.trim();
  const bla = $('nwLatin').value.trim();
  // 直接改 NW.rows 里的对象，别用副本：提交结果（已写回 / 失败）要回写到面板上
  const rows = NW.rows.filter((r) => r.checked);
  if (batch) {
    for (const r of rows) {
      r.chinese = bzh;
      r.latin = bla;
    }
  }
  if (!rows.length) return toast('先勾选要写回的照片');
  const empty = rows.find((r) => !r.chinese && !r.latin);
  if (empty) {
    $('nwErr').textContent = `「${empty.fileName || empty.photoId}」还没填名字`;
    return;
  }
  const act = NW.mode === 'reid'
    ? '上传本机写好的鉴定结果'
    : NW.mode === 'batch' ? '提交批量鉴定' : '写回鉴定结果';
  if (!window.confirm(`确认${act}（${rows.length} 张照片）？\n只发鉴定结果（照片 id + 名字），不上传图片、不新增照片。`)) return;

  NW.submitting = true;
  $('nwSubmit').disabled = true;
  $('nwErr').textContent = '';
  // 锁定了 NameID（或批量同名）时只解析一次；逐张模式按各自名字解析并复用同名结果
  let sharedId = NW.nameId;
  if (!sharedId && batch) {
    try {
      sharedId = await nwAutoNameId(bzh, bla);
    } catch (err) {
      $('nwErr').textContent = err.message;
      NW.submitting = false;
      $('nwSubmit').disabled = false;
      return;
    }
  }
  const cache = new Map();
  const records = [];
  for (const r of rows) {
    let nameId = sharedId;
    if (!nameId) {
      const key = r.latin || r.chinese;
      if (!cache.has(key)) {
        try {
          cache.set(key, await nwAutoNameId(r.chinese, r.latin));
        } catch (err) {
          cache.set(key, { error: err.message });
        }
      }
      const got = cache.get(key);
      if (got && typeof got === 'object') {
        r.status = 'bad';
        r.message = got.error;
        continue;
      }
      nameId = got;
    }
    r.nameId = String(nameId || '');
    records.push({ photoId: r.photoId, chinese: r.chinese, latin: r.latin, nameId });
  }
  if (records.length) {
    try {
      const out = await post('/api/nat/reidentify', { records });
      const byId = new Map((out.results || []).map((x) => [x.photoId, x]));
      for (const r of rows) {
        const res = byId.get(r.photoId);
        if (!res) continue;
        r.status = res.ok ? 'ok' : 'bad';
        r.message = res.ok ? '已写回' : res.error || '写回失败';
        if (res.ok) {
          const p = NAT.photos.find((x) => x.photoId === r.photoId);
          if (p) {
            if (r.chinese) p.cname = r.chinese;
            if (r.latin) p.lname = r.latin;
          }
          NAT.res.delete(r.photoId);
        }
      }
    } catch (err) {
      $('nwErr').textContent = '提交失败：' + err.message;
    }
  }
  NW.submitting = false;
  nwRender();
  renderNatPhotos();
  const okN = rows.filter((r) => r.status === 'ok').length;
  const failN = rows.length - okN;
  // 把提交结果回写本机待上传记录：成功标记 done，失败留 failed 下次可重试
  if (records.length) {
    const recs = NW.rows.map((r) => ({
      photoId: r.photoId,
      fileName: r.fileName,
      chinese: r.chinese,
      latin: r.latin,
      nameId: r.nameId || NW.nameId || '',
      status: r.status === 'ok' ? 'done' : r.status === 'bad' ? 'failed' : 'pending',
      message: r.message || '',
      savedAt: Date.now(),
    }));
    try {
      const out = await post('/api/nat/renames', { records: recs });
      NAT.renames = new Map(
        (out.records || []).filter((x) => x && x.photoId).map((x) => [String(x.photoId), x]),
      );
      refreshPendingBadge();
    } catch {
      /* 本机落盘失败不影响已经提交成功的结果 */
    }
  }
  toast(
    failN ? `已上传 ${okN} 张鉴定，失败 ${failN} 张` : `已上传 ${okN} 张鉴定结果到自然在线`,
    3000,
  );
  if (okN) {
    // 站点那边名字已经变了：两个视图都重新拉一遍，卡片显示网页端返回的新鉴定结果。
    // /api/nat/photos 每次直连站点、不走缓存，所以这里拿到的就是同步后的新值。
    try {
      await natLoadPhotos();
    } catch {
      /* 刷新失败不影响已提交的结果 */
    }
    if (S.mode === 'album' && NAT.album) {
      try {
        await loadAlbumPhotos();
      } catch {
        /* 同上 */
      }
      renderAlbum();
    }
  }
}

function nwBind() {
  if ($('natReIdBtn')) $('natReIdBtn').onclick = nwOpenReId;
  if ($('tagBatchBtn')) $('tagBatchBtn').onclick = nwOpenBatch;
  if ($('natBatchBtn')) $('natBatchBtn').onclick = nwOpenBatch;
  if ($('natDelBtn')) $('natDelBtn').onclick = natDeleteSelected;
  if ($('nwAutoBtn')) $('nwAutoBtn').onclick = () => autoFillNames($('nwChinese'), $('nwLatin'), $('nwAutoBtn'), $('nwAutoMsg'));
  if ($('natReIdShortcut')) $('natReIdShortcut').onclick = nwOpenReId;
  $('nwCancel').onclick = nwClose;
  $('nwBatch').onchange = nwSyncBatch;
  $('nwSelAll').onclick = () => {
    nwCollect();
    const all = NW.rows.every((r) => r.checked);
    NW.rows.forEach((r) => {
      r.checked = !all;
    });
    nwRender();
  };
  $('nwSearch').onclick = nwSearch;
  $('nwKw').onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      nwSearch();
    }
  };
  $('nwClearLock').onclick = nwClearLock;
  $('nwSubmit').onclick = nwSubmit;
  $('nwTaxaList').onclick = (e) => {
    const c = e.target.closest('.nw-chip');
    if (c) nwLock(c.dataset.id, c.dataset.zh, c.dataset.sp);
  };
  $('nwList').onclick = (e) => {
    const del = e.target.closest('.nw-row-del');
    if (del) {
      nwRemoveRecord(del.dataset.del);
      return;
    }
    const c = e.target.closest('.nw-chk-row');
    if (!c) return;
    const r = NW.rows.find((x) => x.photoId === c.dataset.id);
    if (!r) return;
    nwCollect();
    r.checked = c.checked;
    nwRender();
  };
  $('natWriteMask').onclick = (e) => {
    if (e.target === $('natWriteMask')) nwClose();
  };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('natWriteMask').classList.contains('show')) nwClose();
  });
}

/* ---------------- 拖拽本机文件夹（自然在线页的上传入口） ----------------
 * 照片移动、标注页直传相册等入口已下线：本页只保留上传与下载。 */

/* 浏览器拖进来的是 DataTransfer，拿不到本机路径；用 webkitGetAsEntry 递归读目录 */
function natReadEntries(reader) {
  return new Promise((resolve) => reader.readEntries(resolve, () => resolve([])));
}
async function natWalkEntry(entry, out, root, depth) {
  if (depth > 8) return;
  if (entry.isFile) {
    const f = await new Promise((resolve) => entry.file(resolve, () => resolve(null)));
    if (f && /\.(jpe?g|png|webp|bmp|gif|tiff?|heic)$/i.test(f.name)) {
      out.push({ file: f, name: f.name, root });
    }
    return;
  }
  if (!entry.isDirectory) return;
  const reader = entry.createReader();
  let batch;
  do {
    batch = await natReadEntries(reader);
    for (const c of batch) await natWalkEntry(c, out, root, depth + 1);
  } while (batch.length);
}
async function natCollectDrop(dt) {
  const entries = [...(dt.items || [])]
    .filter((i) => i.kind === 'file')
    .map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null))
    .filter(Boolean);
  const out = [];
  for (const e of entries) {
    await natWalkEntry(e, out, e.isDirectory ? e.name : '', 0);
  }
  if (!out.length) {
    for (const f of [...(dt.files || [])]) {
      if (/\.(jpe?g|png|webp|bmp|gif|tiff?|heic)$/i.test(f.name)) out.push({ file: f, name: f.name, root: '' });
    }
  }
  return out;
}

function natBatchId() {
  return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
async function natDropOne(it, batch) {
  const r = await fetch(
    `/api/nat/drop-file?batch=${encodeURIComponent(batch)}&name=${encodeURIComponent(it.name)}`,
    { method: 'POST', body: it.file },
  );
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.error || '文件落盘失败');
  return j.path;
}

/** target：{kind:'album', id} 或 {kind:'new'}（按顶层文件夹名建相册） */
async function natHandleDrop(dt, target) {
  if (!NAT.loggedIn) return toast('先在「自然在线」页登录');
  const items = await natCollectDrop(dt);
  if (!items.length) return toast('拖进来的东西里没有找到图片');
  const groups = new Map();
  for (const it of items) {
    const k = target.kind === 'new' ? it.root : '';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  let gi = 0;
  try {
    for (const [root, list] of groups) {
      gi += 1;
      let albumId = target.id;
      if (target.kind === 'new') {
        const title = root || `拖入的照片 ${new Date().toISOString().slice(0, 10)}`;
        const r = await post('/api/nat/albums', { title });
        albumId = r.id;
        toast(`新建相册「${title}」(${gi}/${groups.size})`, 2000);
      }
      const batch = natBatchId();
      const paths = [];
      for (const it of list) paths.push(await natDropOne(it, batch));
      await natRunUpload(paths, 'album', albumId);
    }
    await natLoadAlbums();
    if (NAT.album) await natLoadPhotos();
  } catch (err) {
    toast('拖入上传失败：' + err.message, 4500);
  }
}

const DIR_MIME = 'application/x-tagden-dir';
/** 本页卡片拖出来的照片路径（JSON 数组）；和 DIR_MIME 分开，drop 时好区分 */
const PATH_MIME = 'application/x-tagden-paths';
/** 自然在线相册里勾选的照片 id（JSON 数组）：拖到另一个相册是「移动」，不是重传 */
const ALBUM_MIME = 'application/x-tagden-photos';

/** 这次拖的是「本程序文件夹节点」/「本页照片路径」/「站点相册照片 id」/「系统文件」 */
function dropKinds(dt) {
  const types = dt ? [...(dt.types || [])] : [];
  return {
    dir: types.includes(DIR_MIME),
    paths: types.includes(PATH_MIME),
    album: types.includes(ALBUM_MIME),
    files: types.includes('Files'),
  };
}

/** 自然在线·本机端卡片起拖：文件夹给目录，照片给路径列表（勾了多张就整批拖） */
function natDragStart(e) {
  if (e.target.closest && e.target.closest('.zoom-btn')) return;

  // 相册端：勾选的照片拖到另一个相册 = 站点原生 move，photoId 和鉴定都不变
  if (NAT.side === 'album') {
    const card = e.target.closest && e.target.closest('.card[data-id]');
    if (!card || !card.dataset.id || !NAT.sel.has(card.dataset.id)) return;
    const ids = NAT.sel.size > 1 ? [...NAT.sel] : [card.dataset.id];
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(ALBUM_MIME, JSON.stringify(ids));
    e.dataTransfer.setData('text/plain', ids.join('\n'));
    NAT.dragging = true;
    return;
  }

  if (NAT.side !== 'local') return;
  const folder = e.target.closest && e.target.closest('.card.folder');
  if (folder && folder.dataset.d) {
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData(DIR_MIME, folder.dataset.d);
    e.dataTransfer.setData('text/plain', folder.dataset.d);
    NAT.dragging = true;
    return;
  }
  const card = e.target.closest && e.target.closest('.card[data-p]');
  if (!card || !card.dataset.p) return;
  const p = card.dataset.p;
  const paths = NAT.localSel.has(p) && NAT.localSel.size > 1 ? [...NAT.localSel] : [p];
  e.dataTransfer.effectAllowed = 'copy';
  e.dataTransfer.setData(PATH_MIME, JSON.stringify(paths));
  e.dataTransfer.setData('text/plain', paths.join('\n'));
  NAT.dragging = true;
}

/**
 * 把左侧文件夹拖到相册：拿绝对路径直接上传，不复制、不中转二进制。
 * 拖到「＋ 新建相册」时按文件夹名建一个；拖到某个相册行就进那个相册。
 */
async function natHandleDirDrop(dirPath, target) {
  if (!NAT.loggedIn) return toast('先在「自然在线」页登录');
  const name = String(dirPath).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '拖入的文件夹';
  let r;
  try {
    r = await api(`/api/images?path=${enc(dirPath)}&deep=1`);
  } catch (err) {
    return toast('读文件夹失败：' + err.message, 4200);
  }
  if (!r.count) return toast(`「${name}」里没有图片`, 3200);
  if (r.count > 1500) return toast(`「${name}」有 ${r.count} 张图，一次传太多容易失败，请拖它的子文件夹`, 5200);
  let albumId = target.id;
  if (target.kind === 'new') {
    const rr = await post('/api/nat/albums', { title: name });
    albumId = rr.id;
    toast(`新建相册「${name}」，开始上传 ${r.count} 张`, 2600);
  }
  const ok = await natRunUpload(r.files, 'album', albumId);
  if (ok && ok.ok !== false) {
    await natLoadAlbums();
    if (NAT.album) await natLoadPhotos();
  }
}

/**
 * 把本页拖出的照片传到某个相册：只发路径，服务端从本机读图上传，不经浏览器中转。
 * 拖到「＋ 新建相册」时，用照片所在文件夹的名字建一个。
 */
async function natHandlePathsDrop(paths, target) {
  if (!NAT.loggedIn) return toast('先在「自然在线」页登录');
  const list = (paths || []).filter(Boolean);
  if (!list.length) return;
  let albumId = target.id;
  if (target.kind === 'new') {
    const dir = String(list[0]).replace(/[\\/][^\\/]*$/, '');
    const name = dir.split(/[\\/]/).filter(Boolean).pop()
      || `拖入的照片 ${new Date().toISOString().slice(0, 10)}`;
    const r = await post('/api/nat/albums', { title: name });
    albumId = r.id;
    toast(`新建相册「${name}」，开始上传 ${list.length} 张`, 2600);
  }
  const ok = await natRunUpload(list, 'album', albumId);
  if (ok && ok.ok !== false) {
    await natLoadAlbums();
    if (NAT.album && String(NAT.album.id) === String(albumId)) await natLoadPhotos();
  }
}

/**
 * 删除自然在线相册里勾选的照片：站点原生删除，原图一起消失，确认后才发。
 * 删当前页最后几张时把页码收回来，避免停在空页。
 */
async function natDeleteSelected() {
  if (!NAT.loggedIn) return toast('先在「自然在线」页登录');
  const ids = [...NAT.sel];
  if (!ids.length) return toast('先勾选要删除的照片');
  if (!window.confirm(`删除勾选的 ${ids.length} 张照片？\n会同步删除自然在线上的原图，删后不能恢复。`)) return;
  try {
    const r = await post('/api/nat/photos/delete', { ids });
    NAT.sel.clear();
    await natLoadAlbums();
    if (NAT.album) {
      await natLoadPhotos();
      const pages = Math.max(1, Math.ceil(NAT.total / NAT.size));
      if (NAT.page > pages) {
        NAT.page = pages;
        await natLoadPhotos();
      }
    }
    natSyncSel();
    toast(`已删除 ${r.deleted != null ? r.deleted : ids.length} 张，并同步到自然在线`, 3200);
  } catch (err) {
    toast('删除失败：' + err.message, 4200);
  }
}

/**
 * 相册照片拖到另一个相册：走 /api/nat/photos/move（站点原生移动，不重传、不换 photoId）。
 * 拖到「＋ 新建相册」时先建相册，再把照片移进去。
 */
async function natHandleAlbumMove(ids, target) {
  if (!NAT.loggedIn) return toast('先在「自然在线」页登录');
  const list = [...new Set((ids || []).map(String).filter(Boolean))];
  if (!list.length) return;
  if (target.kind === 'album' && NAT.album && String(target.id) === String(NAT.album.id)) {
    return toast('这些照片已经在当前相册');
  }
  let albumId = target.id;
  let title = (NAT.albums.find((a) => String(a.id) === String(albumId)) || {}).title || '目标相册';
  try {
    if (target.kind === 'new') {
      title = `移动的照片 ${new Date().toISOString().slice(0, 10)}`;
      const r = await post('/api/nat/albums', { title });
      albumId = r.id;
    }
    await post('/api/nat/photos/move', { albumId, ids: list });
    NAT.sel.clear();
    await natLoadAlbums();
    if (NAT.album) {
      await natLoadPhotos();
      const pages = Math.max(1, Math.ceil(NAT.total / NAT.size));
      if (NAT.page > pages) {
        NAT.page = pages;
        await natLoadPhotos();
      }
    }
    natSyncSel();
    toast(`已移动 ${list.length} 张到「${title}」`, 2600);
  } catch (err) {
    toast('移动失败：' + err.message, 4200);
  }
}

function natBindDrop(el, getTarget, highlight, allow) {
  if (!el) return;
  const ok = allow || {};
  const takes = (k) =>
    (k.dir && ok.dir !== false)
    || (k.paths && ok.paths !== false)
    || (k.album && ok.album !== false)
    || (k.files && ok.files !== false);
  el.addEventListener('dragover', (e) => {
    const k = dropKinds(e.dataTransfer);
    if (!takes(k)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = k.album ? 'move' : 'copy';
    if (highlight) highlight(e, true);
    else el.classList.add('drop-on');
  });
  el.addEventListener('dragleave', (e) => {
    if (el.contains(e.relatedTarget)) return;
    if (highlight) highlight(e, false);
    else el.classList.remove('drop-on');
  });
  el.addEventListener('drop', async (e) => {
    const k = dropKinds(e.dataTransfer);
    if (!takes(k)) return;
    e.preventDefault();
    if (highlight) highlight(e, false);
    else el.classList.remove('drop-on');
    const dirPath = k.dir ? e.dataTransfer.getData(DIR_MIME) : '';
    let paths = [];
    if (k.paths) {
      try { paths = JSON.parse(e.dataTransfer.getData(PATH_MIME) || '[]'); } catch { paths = []; }
    }
    let albumIds = [];
    if (k.album) {
      try { albumIds = JSON.parse(e.dataTransfer.getData(ALBUM_MIME) || '[]'); } catch { albumIds = []; }
    }
    const t = getTarget(e);
    if (!t) return toast('先在右边选一个目标相册');
    if (albumIds.length) return natHandleAlbumMove(albumIds, t);
    if (dirPath) return natHandleDirDrop(dirPath, t);
    if (paths.length) return natHandlePathsDrop(paths, t);
    await natHandleDrop(e.dataTransfer, t);
  });
}

function bindNatDrops() {
  const list = $('natAlbumList');
  natBindDrop(
    list,
    (e) => {
      const row = e.target.closest('.nat-album');
      return row ? { kind: 'album', id: row.dataset.id } : null;
    },
    (e, on) => {
      for (const r of list.querySelectorAll('.nat-album.drop-on')) r.classList.remove('drop-on');
      const row = on && e.target.closest('.nat-album');
      if (row) row.classList.add('drop-on');
    },
  );
  natBindDrop($('natDropZone'), () => ({ kind: 'new' }));
  for (const el of [$('natGrid'), $('natEmpty')]) {
    // 照片区只接「系统里拖进来的文件 / 左栏的文件夹」；本页卡片拖到这儿不算上传，
    // 免得手一抖在网格里松手就传了一遍
    natBindDrop(el, () => (NAT.album ? { kind: 'album', id: NAT.album.id } : null), null, { paths: false, album: false });
  }
  // 本机端卡片起拖（照片按路径、子文件夹按目录）——监听挂在网格上，重铺卡片不用重绑
  const grid = $('natGrid');
  if (grid) {
    grid.addEventListener('dragstart', natDragStart);
    grid.addEventListener('dragend', () => {
      // dragend 后面偶尔还会补一个 click，稍等一下再放开，免得顺手进了文件夹
      setTimeout(() => { NAT.dragging = false; }, 150);
    });
  }
}

/** 起一次上传任务并返回 Promise（拖多个文件夹时要用它串行） */
function natRunUpload(files, mode, albumId) {
  return new Promise((resolve) => {
    (async () => {
      NAT.upl = { id: '' };
      natSyncUpBtn();
      natSyncTagBtn();
      let r;
      try {
        r = await post('/api/nat/upload', { files, mode, albumId: albumId || '' });
      } catch (err) {
        NAT.upl = null;
        natSyncUpBtn();
        natSyncTagBtn();
        toast('上传失败：' + err.message, 4000);
        return resolve({ ok: false, error: err.message });
      }
      NAT.upl = { id: r.jobId };
      setNatProgress(0, r.total, `准备上传 ${r.total} 张…`);
      const tick = async () => {
        let j;
        try {
          j = await api('/api/nat/upload/' + enc(r.jobId));
        } catch (err) {
          natFinishUpload(null, err.message);
          return resolve({ ok: false, error: err.message });
        }
        if (!j.ok) {
          natFinishUpload(null, j.error);
          return resolve({ ok: false, error: j.error });
        }
        setNatProgress(j.done, j.total, j.current ? `正在传 ${j.current}（${j.done}/${j.total}）` : `收尾…（${j.done}/${j.total}）`);
        if (!j.finished) {
          NAT.timer = setTimeout(tick, 500);
          return;
        }
        natFinishUpload(j);
        resolve({ ok: true, job: j });
      };
      clearTimeout(NAT.timer);
      tick();
    })();
  });
}

/** 上传按钮跟着「标注」页的勾选数走 —— 上传的正是那边选中的那些图 */
function natSyncUpBtn() {
  const n = S.sel.size;
  const mode = $('natUpMode').value;
  const btn = $('natUpBtn');
  btn.textContent = `↑ 上传选中的 ${n} 张`;
  btn.disabled = !n || !NAT.loggedIn || (mode === 'album' && !NAT.album) || Boolean(NAT.upl);
  btn.title =
    mode === 'album'
      ? NAT.album
        ? `把「标注」页勾选的 ${n} 张图传到相册「${NAT.album.title}」`
        : '先在右边选一个目标相册'
      : '按图片标签里的物种名各自建相册上传（没有物种名的会跳过）';
}

function setNatProgress(done, total, text) {
  $('natProgress').hidden = false;
  $('natBar').style.width = total ? `${Math.round((done / total) * 100)}%` : '0%';
  $('natPText').textContent = text;
}

async function natUpload() {
  const files = [...S.sel];
  if (!files.length) return toast('先在「标注」页勾选要上传的图');
  const mode = $('natUpMode').value;
  if (mode === 'album' && !NAT.album) return toast('先在右边选一个目标相册');
  await natRunUpload(files, mode, NAT.album ? NAT.album.id : '');
}

async function natFinishUpload(job, error) {
  NAT.upl = null;
  natSyncUpBtn();
  natSyncTagBtn();
  if (error) {
    $('natPText').textContent = '上传中断：' + error;
    $('natBar').style.width = '0%';
    toast('上传中断：' + error, 4000);
    return;
  }
  setNatProgress(job.total, job.total, `完成：成功 ${job.okCount} 张`);
  const bits = [`成功 ${job.okCount} 张`];
  if (job.failed.length) bits.push(`失败 ${job.failed.length} 张`);
  if (job.skipped.length) bits.push(`跳过 ${job.skipped.length} 张（没有物种名）`);
  if (job.albums.length) bits.push(`新建相册 ${job.albums.length} 个`);
  toast(bits.join('，'), 4200);
  if (job.failed.length) console.warn('[自然在线] 上传失败清单', job.failed);
  setTimeout(() => { $('natProgress').hidden = true; }, 2600);
  await natLoadAlbums();
  // 传到当前相册的，回来后直接刷新那一个相册
  if (job.mode === 'album' && NAT.album && NAT.album.id) await natLoadPhotos();
  // 本地模式传完把勾选清掉（照片已经进相册了），网格保持在本机这一侧
  if (NAT.side === 'local') { NAT.localSel.clear(); renderNatLocal(); }
}

/* ---------------- 自然在线页：下载原图 / 下载 KML 轨迹 / 清除缓存 ----------------
 * 和 nature-client 同一套做法：原图由本机服务逐张取回、打成 zip（站点不用再打包一次）；
 * KML 用照片里的 GPS 在浏览器里就地生成；清除缓存只清本机图片字节，
 * 不动账号令牌、待上传鉴定记录和评分结果。
 */

function natTriggerDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function natXesc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[c]));
}

/** 下载 / 导出都以勾选优先；没勾就按本页全部处理 */
function natPickedPhotos() {
  if (NAT.side !== 'album') return [];
  const list = NAT.photos || [];
  const picked = list.filter((p) => NAT.sel.has(String(p.photoId)));
  return picked.length ? picked : list.slice();
}

async function natDownloadOriginal() {
  const items = natPickedPhotos();
  if (!items.length) return toast('先在左栏切到「相册端」并选一个相册', 3200);
  const payload = items
    .map((p) => {
      const url = p.original || p.full || '';
      if (!url) return null;
      const ext = (String(p.fileName || '').split('.').pop() || 'jpg').replace(/[^\w]/g, '') || 'jpg';
      const base = safeName([p.cname || '', p.lname || '', p.photoId].filter(Boolean).join('_')) || String(p.photoId);
      return { url, name: `${base}.${ext}` };
    })
    .filter(Boolean);
  if (!payload.length) return toast('这些照片没有可用的原图地址（站点未返回图片路径）', 3600);
  const btn = $('natOrigBtn');
  if (btn) btn.disabled = true;
  toast(`正在打包 ${payload.length} 张原图…`, 3000);
  try {
    const res = await fetch('/api/nat/original-zip', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: payload }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${res.status}`);
    }
    natTriggerDownload(await res.blob(), `nature-originals-${new Date().toISOString().slice(0, 10)}.zip`);
    toast(`已下载 ${payload.length} 张原图（zip）`);
  } catch (err) {
    toast('下载原图失败：' + err.message, 4000);
  } finally {
    if (btn) btn.disabled = false;
    natSyncSel();
  }
}

/** 由照片 GPS 生成 KML：一条 gx:Track 轨迹连线 + 每张照片一个点 */
function natBuildKml(items) {
  const pts = items
    .filter((it) => it.gps && it.gps.lat != null && it.gps.lng != null)
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  const trackCoords = pts
    .map((it) => `          <gx:coord>${Number(it.gps.lng)} ${Number(it.gps.lat)} 0</gx:coord>`)
    .join('\n');
  const placemarks = pts
    .map((it) => {
      const nm = natXesc([it.cname, it.lname].filter(Boolean).join(' ') || it.fileName || it.photoId);
      const desc = natXesc([it.date, it.place].filter(Boolean).join(' · '));
      return `        <Placemark>
          <name>${nm}</name>
          <description>${desc}</description>
          <Point><coordinates>${Number(it.gps.lng)},${Number(it.gps.lat)},0</coordinates></Point>
        </Placemark>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
  <Document>
    <name>自然在线调查轨迹</name>
    <Snippet>由物种标注工坊生成（${pts.length} 个带 GPS 的点）</Snippet>
    <Folder>
      <name>调查轨迹</name>
      <Placemark>
        <name>轨迹连线</name>
        <gx:Track>
          <altitudeMode>clampToGround</altitudeMode>
${trackCoords}
        </gx:Track>
      </Placemark>
${placemarks}
    </Folder>
  </Document>
</kml>`;
}

function natDownloadKml() {
  const items = natPickedPhotos();
  if (!items.length) return toast('先在左栏切到「相册端」并选一个相册', 3200);
  const withGps = items.filter((p) => p.gps && p.gps.lat != null && p.gps.lng != null).length;
  if (!withGps) return toast('当前照片没有 GPS 信息，无法生成轨迹（站点未返回经纬度）', 3600);
  const blob = new Blob([natBuildKml(items)], { type: 'application/vnd.google-earth.kml+xml' });
  natTriggerDownload(blob, `nature-track-${new Date().toISOString().slice(0, 10)}.kml`);
  toast(`已生成 KML 轨迹（${withGps} 个带 GPS 的点）`);
}

async function natClearCache() {
  if (!window.confirm(
    '清除本机缓存的自然在线图片？\n清除后下次打开会重新从站点读取；账号登录、待上传的鉴定记录和评分结果都不受影响。',
  )) return;
  try {
    const r = await post('/api/nat/cache/clear', {});
    toast(`已清除 ${r.files || 0} 个缓存图片${r.bytes ? `（${kb(r.bytes)}）` : ''}`);
    if (NAT.loggedIn) await natLoadAlbums();
    if (NAT.side === 'album' && NAT.album) await natLoadPhotos();
  } catch (err) {
    toast('清除缓存失败：' + err.message, 4000);
  }
}

/* ---------------- 可拖拽的分隔条 ----------------
 * 文件夹栏、相册栏都能拉宽拉窄，宽度记在 localStorage，双击分隔条复位。
 * 两边用同一套逻辑，只差「往哪个方向算宽度」（dir）。
 */
function bindGutters() {
  // 文件夹栏在最左，往右拖变宽 → dir 1
  bindGutter('gutRail', {
    cssVar: '--rail-w',
    storeKey: 'tagdenRailW',
    dir: 1,
    min: 180,
    max: 620,
    def: 288,
    measure: () => (document.querySelector('.rail') || {}).getBoundingClientRect?.().width || 288,
  });
  // 相册栏在最右，往左拖变宽 → dir -1
  bindGutter('gutAlb', {
    cssVar: '--alb-w',
    storeKey: 'tagdenAlbW',
    dir: -1,
    min: 180,
    max: 520,
    def: 268,
    measure: () => (document.querySelector('.nat-albums') || {}).getBoundingClientRect?.().width || 268,
  });
}

function bindGutter(id, opt) {
  const el = $(id);
  if (!el) return;
  const root = document.documentElement;

  // 先把上次拖的宽度恢复回来
  try {
    const saved = Number(localStorage.getItem(opt.storeKey));
    if (saved >= opt.min && saved <= opt.max) root.style.setProperty(opt.cssVar, saved + 'px');
  } catch {}

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = opt.measure();
    el.classList.add('dragging');
    document.body.classList.add('resizing');

    // 不靠 setPointerCapture：鼠标一离开这条 8px 的细线，元素就收不到 move 了
    // （自然在线视图里实测过），所以拖拽期间直接挂到 document 上。
    const onMove = (ev) => {
      const want = startW + (ev.clientX - startX) * opt.dir;
      const w = Math.max(opt.min, Math.min(opt.max, want));
      document.documentElement.style.setProperty(opt.cssVar, w + 'px');
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      el.classList.remove('dragging');
      document.body.classList.remove('resizing');
      try {
        localStorage.setItem(opt.storeKey, String(Math.round(opt.measure())));
      } catch {}
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  });

  // 双击回到默认宽度，省得拖歪了没法救
  el.addEventListener('dblclick', () => {
    document.documentElement.style.setProperty(opt.cssVar, opt.def + 'px');
    try {
      localStorage.removeItem(opt.storeKey);
    } catch {}
  });
}

function bindNature() {
  // 标注页的本机端 / 相册端
  if ($('srcSeg')) {
    $('srcSeg').onclick = (e) => {
      const b = e.target.closest('button[data-src]');
      if (!b || b.disabled) return;
      // 自然在线页点过右边相册后，左栏仍停在本机端；再点一次「本机端」= 中间回到本机文件夹
      if (b.dataset.src === 'local' && S.mode === 'local' && S.tab === 'nature' && NAT.side === 'album') {
        NAT.side = 'local';
        syncNatSideUI(true);
        return;
      }
      setSource(b.dataset.src);
    };
  }
  if ($('albumRail')) {
    $('albumRail').onclick = (e) => {
      const it = e.target.closest('.ar-item');
      if (it) openAlbumHere(it.dataset.id, it.dataset.title);
    };
  }
  if ($('albumRailRefresh')) {
    $('albumRailRefresh').onclick = async () => {
      NAT.albums = [];
      await natEnsureAlbums();
      renderAlbumRail();
      if (NAT.album) await loadAlbumPhotos();
    };
  }
  if ($('natWriteOne')) $('natWriteOne').onclick = () => natWriteOne();
  bindNatDrops();

  // 本页只管上传 / 下载；看本机文件夹还是相册照片，跟着左栏的「本机端 / 相册端」
  if ($('natLocalUp')) $('natLocalUp').onclick = natUploadLocal;
  if ($('natOrigBtn')) $('natOrigBtn').onclick = natDownloadOriginal;
  if ($('natKmlBtn')) $('natKmlBtn').onclick = natDownloadKml;
  if ($('natClearCacheBtn')) $('natClearCacheBtn').onclick = natClearCache;
  if ($('natLocalOpen')) $('natLocalOpen').onclick = () => showTab('annotate');

  $('natCapImg').onclick = () => natCaptcha();
  $('natLoginBtn').onclick = () => natLogin();
  $('natCapInput').onkeydown = (e) => {
    if (e.key === 'Enter') natLogin();
  };
  $('natPassInput').onkeydown = (e) => {
    if (e.key === 'Enter') natLogin();
  };
  $('natLogoutBtn').onclick = async () => {
    try {
      await post('/api/nat/logout', {});
      NAT.album = null;
      NAT.photos = [];
      NAT.sel.clear();
      $('natGrid').innerHTML = '';
      $('natAlbumName').textContent = '选右边的相册看照片';
      toast('已退出登录');
      await natStatus();
    } catch (err) {
      toast('退出失败：' + err.message);
    }
  };
  $('natRefreshBtn').onclick = async () => {
    if (NAT.loggedIn) await natLoadAlbums();
    else await natStatus();
  };
  $('natNewAlbumBtn').onclick = () => {
    $('natNewAlbumBox').hidden = !$('natNewAlbumBox').hidden;
    if (!$('natNewAlbumBox').hidden) $('natAlbumTitle').focus();
  };
  $('natAlbumCancel').onclick = () => {
    $('natNewAlbumBox').hidden = true;
    $('natAlbumTitle').value = '';
  };
  $('natAlbumCreate').onclick = async () => {
    const title = $('natAlbumTitle').value.trim();
    if (!title) return toast('相册名不能空着');
    $('natAlbumCreate').disabled = true;
    try {
      const r = await post('/api/nat/albums', { title });
      $('natAlbumTitle').value = '';
      $('natNewAlbumBox').hidden = true;
      await natLoadAlbums();
      await natOpenAlbum(r.id, title);
      toast(`相册「${title}」建好了`);
    } catch (err) {
      toast('新建失败：' + err.message, 4000);
    } finally {
      $('natAlbumCreate').disabled = false;
    }
  };
  $('natUpMode').onchange = () => natSyncUpBtn();
  $('natUpBtn').onclick = () => natUpload();
  nwBind();
  $('natPgPrev').onclick = () => {
    if (NAT.page > 1) {
      NAT.page -= 1;
      NAT.sel.clear();
      natLoadPhotos();
    }
  };
  $('natPgNext').onclick = () => {
    NAT.page += 1;
    NAT.sel.clear();
    natLoadPhotos();
  };

  // 相册列表：点行打开、点 × 删除，都走事件委托（列表是整块重渲染的）
  $('natAlbumList').onclick = async (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      e.stopPropagation();
      const id = del.dataset.del;
      const hit = NAT.albums.find((a) => a.id === id);
      if (!window.confirm(`删掉相册「${hit ? hit.title : id}」？相册里的照片会一起没。`)) return;
      try {
        await post('/api/nat/albums/delete', { id });
        if (NAT.album && NAT.album.id === id) {
          NAT.album = null;
          NAT.photos = [];
          NAT.sel.clear();
          NAT.visibleTotal = 0;
          $('natGrid').innerHTML = '';
          $('natAlbumName').textContent = '选右边的相册看照片';
          $('natPager').hidden = true;
        }
        toast('相册已删除');
        await natLoadAlbums();
        natSyncUpBtn();
      } catch (err) {
        toast('删除失败：' + err.message, 4000);
      }
      return;
    }
    const row = e.target.closest('.nat-album');
    if (row) await natOpenAlbum(row.dataset.id, row.dataset.title);
  };

  // 照片卡片：点一下切换勾选（本地模式按路径勾，相册模式按 photoId 勾）
  $('natGrid').onclick = (e) => {
    // 刚框选完：吞掉这次 click，别把框到的又取消掉
    if (NAT.marqMoved) { NAT.marqMoved = false; return; }
    // 双击名称区是重命名；第二下 click 不再切换勾选
    if (e.detail > 1) return;
    // 刚把卡片拖到相册：拖拽收尾偶尔会补一个 click，别顺手进了文件夹
    if (NAT.dragging) { NAT.dragging = false; return; }
    // 右下角放大镜：不切换勾选，只打开大图
    const zoomBtn = e.target.closest('.zoom-btn');
    if (zoomBtn) {
      e.preventDefault();
      const zc = zoomBtn.closest('.card');
      if (!zc) return;
      if (NAT.side === 'album') {
        if (!zc.dataset.id) return;
        S.active = NAT_KEY + zc.dataset.id;
      } else {
        S.active = zc.dataset.p || null;
      }
      openZoom();
      return;
    }
    if (NAT.side === 'local') {
      const folder = e.target.closest('.card.folder');
      if (folder && folder.dataset.d) { loadDir(folder.dataset.d); return; }
    }
    const card = e.target.closest('.card');
    if (!card) return;
    if (NAT.side === 'local') {
      const p = card.dataset.p;
      if (!p) return;
      if (NAT.localSel.has(p)) NAT.localSel.delete(p);
      else NAT.localSel.add(p);
      card.classList.toggle('sel', NAT.localSel.has(p));
      const tk = card.querySelector('.tick');
      if (tk) tk.textContent = NAT.localSel.has(p) ? '✓' : '';
      natSyncSel();
      return;
    }
    const id = card.dataset.id;
    if (NAT.sel.has(id)) NAT.sel.delete(id);
    else NAT.sel.add(id);
    card.classList.toggle('sel', NAT.sel.has(id));
    card.draggable = NAT.sel.has(id);
    card.setAttribute('draggable', NAT.sel.has(id) ? 'true' : 'false');
    const tick = card.querySelector('.tick');
    if (tick) tick.textContent = NAT.sel.has(id) ? '✓' : '';
    natSyncSel();
  };
  // 双击底部名字：本机端写图片标签，相册端先存「待上传鉴定」
  $('natGrid').ondblclick = (e) => {
    const meta = e.target.closest('.meta');
    if (!meta) return;
    const card = meta.closest('.card');
    if (!card) return;
    if (NAT.side === 'album') {
      const id = card.dataset.id;
      if (id) openNameEditor(NAT_KEY + id, meta);
    } else {
      const p = card.dataset.p;
      if (p) openNameEditor(p, meta);
    }
  };

  // 框选 + 全选 / 清空（本机文件夹与相册照片两个模式都适用）
  bindNatMarquee();
  if ($('natSelAll')) $('natSelAll').onclick = () => natSelectAll();
  if ($('natSelNone')) $('natSelNone').onclick = () => natSelectNone();
}

/* ---------------- 「照片评分」标签页（算法整体内置，无外挂进程） ----------------
 * 分工：
 *   public/score-engine.js  —— v2 评分内核（SV=2，与 bio-image 的 OpenCV 版逐图校准过）
 *   public/score-worker.js  —— 浏览器解码 + 后台算分 + 给 AI 压图
 *   /api/score/*            —— 缓存、批内星级、连拍分组、AI 设置与转发
 * 和三处联动：
 *   标注页      —— 卡片右上角显示星级；工具栏「照片评分」直接切过来开跑
 *   自然在线页  —— 勾选的站点照片可取回原图评分，结果显示在卡片第三行
 *   本页底部    —— 选中照片可「送去标注」或「传到自然在线相册」
 */
const SCR = {
  dir: '', scores: {}, counts: [0, 0, 0, 0], invalid: 0,
  sel: new Set(), running: false, worker: null, taskId: 0,
  cfg: null, aiMeta: null, bursts: null, groupMode: false,
  star: '', sort: 'final', remote: {},
  // 评分页自己的目录（可以点进子文件夹）；follow 记住「上次跟着左边树同步到哪」
  files: null, dirMeta: null, follow: '', llama: null,
  detail: '', marqMoved: false,
  // 页面 AI 行用：上次选的是哪个引擎（关掉 AI 时也能记住）、本地扫到的 gguf 缓存
  aiLastEngine: 'cloud', llamaModels: null,
  // 来源跟随左栏：album 时评分对象是自然在线相册里的照片（原图取回本机算，不上传）
  mode: 'local', albumId: '', albumFiles: null,
};
// jsdom 验收要拿得到状态；浏览器里 window 一直存在
if (typeof window !== 'undefined') window.SCR = SCR;

const scIsImage = (n) => /\.(jpe?g|png|webp|bmp|tiff?)$/i.test(String(n || ''));
/** 评分对象：本机端是本页目录（退回标注页目录），相册端是站点相册的伪文件 */
const scFiles = () => SCR.mode === 'album'
  ? (SCR.albumFiles || [])
  : (SCR.files || S.files || []).filter((f) => scIsImage(f.name));

function scWorker() {
  if (!SCR.worker) SCR.worker = new Worker('/score-worker.js');
  return SCR.worker;
}

/** 丢一个任务给 Worker，收 progress / done，返回 { entries, images, error, cancelled } */
function scTask(type, items, extra, onProgress) {
  return new Promise((resolve) => {
    const w = scWorker();
    const id = ++SCR.taskId;
    const out = { entries: {}, images: [], error: '', cancelled: false };
    const onMsg = (ev) => {
      const m = ev.data || {};
      if (m.id !== id) return;
      if (m.type === 'progress') {
        if (m.rec && m.key) out.entries[m.key] = m.rec;
        if (onProgress) onProgress(m);
      } else if (m.type === 'done') {
        w.removeEventListener('message', onMsg);
        if (m.entries) out.entries = { ...out.entries, ...m.entries };
        out.images = m.images || [];
        out.error = m.error || '';
        out.cancelled = !!m.cancelled;
        resolve(out);
      }
    };
    w.addEventListener('message', onMsg);
    w.postMessage({ id, type, items, ...(extra || {}) });
  });
}

function scProgress(on, done, total, text) {
  const box = $('scProgress');
  if (!box) return;
  box.hidden = !on;
  if (!on) return;
  $('scProgText').textContent = text || '处理中…';
  $('scProgBar').style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
}

/**
 * 从卡片上按下拖鼠标会被浏览器当成「选中文字」，整块变蓝且点空白也清不掉。
 * 靠 CSS user-select:none 已经挡掉绝大部分，这里再兜一次底（残留选区）。
 */
function scClearTextSelection() {
  try {
    const s = window.getSelection && window.getSelection();
    if (s && s.rangeCount) s.removeAllRanges();
  } catch { /* 某些环境下没有 getSelection */ }
}

/**
 * 全站禁止「在卡片上按住拖鼠标 → 文字被选中 → 整块蓝」。
 * 三层：CSS user-select:none（首选）→ 这里在捕获阶段拦 selectstart / dragstart →
 * pointerdown 时清掉真实残留的选区（有些浏览器对 user-select 不买账）。
 * 只拦 .card 里的，右侧面板等处的文字仍然可以正常选中复制物种名。
 */
function bindNoTextSelect() {
  const inCard = (t) => !!(t && t.closest && t.closest('.card, .grid'));
  document.addEventListener('selectstart', (e) => { if (inCard(e.target)) e.preventDefault(); }, true);
  document.addEventListener('dragstart', (e) => {
    const t = e.target;
    if (t && t.tagName === 'IMG' && inCard(t)) e.preventDefault();
  }, true);
  document.addEventListener('pointerdown', (e) => {
    if (inCard(e.target)) scClearTextSelection();
  }, true);
}

/**
 * 工具条上的「启动本地服务 / 专用昆虫检测」：不打开 AI 设置也能直接用。
 * 状态跟 scLlamaStatus / scCfgPaint 同步过去。
 */
function scQuickPaint() {
  const r = SCR.llama || {};
  const btn = $('scQuickLlama');
  if (btn) {
    btn.textContent = r.running ? '停止本地服务' : (r.starting ? '启动中…' : '启动本地服务');
    btn.disabled = !!r.starting;
  }
  const box = $('scQuickStrict');
  const c = SCR.cfg;
  if (box && c) {
    const eng = c.engine === 'local' ? 'local' : 'cloud';
    const set = c[eng] || {};
    box.checked = !!set.strict;
    const insect = /昆虫/.test(set.taxon || '');
    box.disabled = !insect;
    const wrap = $('scQuickStrictWrap');
    if (wrap) {
      wrap.classList.toggle('off', !insect);
      wrap.title = insect
        ? '进阶：按昆虫鉴定标准严格评审（检查触角/复眼/足/翅/鞘翅等关键部位，并识别蜘蛛等非昆虫节肢动物）'
        : '只有类群选「昆虫」时可用（在 AI 设置里把类群改成昆虫，或换一个默认就是昆虫的引擎）';
    }
  }
}

/** 工具条上一键启动/停止本地服务；没配模型就先引导去设置里选 */
async function scQuickToggleLlama() {
  const r = SCR.llama || {};
  if (r.running) { await scLlamaStop(); return; }
  if (r.starting) return;
  if (!SCR.cfg) await scCfgLoad();
  const cfg = SCR.cfg || {};
  const local = cfg.local || {};
  // 配置里的 modelPath 可能是空的（旧版本存盘时被写掉过），先扫一遍本机再决定要不要拦
  const lm = await scLlamaModels();
  if (!local.modelPath && !lm.mains.length) {
    scOpenLocalMgr();
    toast('还没选本地模型：在「本地模型管理」里选一个 .gguf（没下过的话点「打开」把文件复制进模型目录）', 4800);
    return;
  }
  await scLlamaStart();
}

/** 工具条上的专用昆虫检测：写进当前生效的那个引擎（本地优先） */
async function scQuickStrict(on) {
  if (!SCR.cfg) await scCfgLoad();
  const c = SCR.cfg || {};
  const eng = c.engine === 'local' ? 'local' : 'cloud';
  const body = { [eng]: { strict: !!on } };
  try {
    const r = await post('/api/score/ai', body);
    if (r && r.cfg) SCR.cfg = r.cfg;
  } catch (err) {
    toast('保存专用昆虫检测设置失败：' + err.message, 3200);
  }
  // 设置面板里的同名勾选框跟着走，两处不能各说各话
  if (eng === 'cloud' && $('scStrict')) $('scStrict').checked = !!on;
  if (eng === 'local' && $('scStrictLocal')) $('scStrictLocal').checked = !!on;
  scQuickPaint();
}

/* ---------------- 页面上的 AI 行（照旧版评分器的排法） ----------------
 * 一行看全：AI 语义评分开不开、评什么类群、用哪个引擎和模型、现在是什么状态。
 * 数据只有一个来源：SCR.cfg。这里所有控件都是「读 cfg → 显示」「改 → 存 cfg → 重画」，
 * 不自己另存一份状态，免得和 AI 设置抽屉对不上。
 */

/** 本地扫到的 gguf，懒加载一次；点「↻」或换目录时才重扫 */
async function scLlamaModels(force) {
  if (SCR.llamaModels && !force) return SCR.llamaModels;
  let r = null;
  try { r = await api('/api/score/llama/models'); } catch { /* 离线也照常显示 */ }
  const files = (r && r.files) || [];
  SCR.llamaModels = {
    mains: files.filter((f) => !f.mmproj),
    projs: files.filter((f) => f.mmproj),
    dirs: (r && r.dirs) || [],
  };
  return SCR.llamaModels;
}

/** 当前生效的引擎（off 时按上次记住的算，别让下拉框空着） */
function scAiEngine() {
  const c = SCR.cfg || {};
  if (c.engine === 'local') return 'local';
  if (c.engine === 'cloud') return 'cloud';
  return SCR.aiLastEngine === 'local' ? 'local' : 'cloud';
}

/** 模型下拉：云端列模型 id，本地列扫到的 .gguf 主模型 */
async function scAiModelFill(eng, set) {
  const sel = $('scAiModel');
  if (!sel) return;
  if (eng === 'local') {
    const lm = await scLlamaModels();
    const cur = String((set && set.modelPath) || '');
    sel.innerHTML = lm.mains.length
      ? lm.mains.map((f) => `<option value="${esc(f.path)}">${esc(f.name)}</option>`).join('')
      : '<option value="">（没扫到 .gguf，点「本地模型管理」看该放哪）</option>';
    if (cur && lm.mains.some((f) => f.path === cur)) sel.value = cur;
    sel.title = lm.mains.length ? '本机扫到的 .gguf 主模型' : '把 .gguf 放进模型目录，再点「本地模型管理」里的 ↻';
  } else {
    const list = (SCR.aiMeta && SCR.aiMeta.cloudModels) || [];
    sel.innerHTML = list.length
      ? list.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')
      : '<option value="">（没有可选模型）</option>';
    if (set && set.model) sel.value = set.model;
    sel.title = '云端百炼的视觉模型';
  }
}

/** 状态一句话：说清「能不能用、为什么不能用」 */
function scAiStatusText() {
  const c = SCR.cfg;
  if (!c) return { txt: '读设置中…', cls: '' };
  if (c.engine === 'off') return { txt: '已关闭（只跑本机技术评分）', cls: '' };
  if (c.engine === 'local') {
    const r = SCR.llama || {};
    if (r.running) return { txt: `本地 · 运行中 :${r.port}`, cls: 'ok' };
    if (!(c.local && c.local.modelPath)) return { txt: '本地 · 还没选主模型', cls: 'bad' };
    const rt = r.runtime || {};
    return rt.bundled
      ? { txt: '本地 · 已就绪 · 运行库 OK', cls: 'ok' }
      : { txt: '本地 · 运行库未就绪', cls: 'bad' };
  }
  return c.hasCloudKey
    ? { txt: '云端 · 已配置 Key', cls: 'ok' }
    : { txt: '云端 · 未配置 Key', cls: 'bad' };
}

function scAiPaint() {
  const on = $('scAiOn');
  if (!on) return;
  const c = SCR.cfg;
  const eng = scAiEngine();
  on.checked = !!c && c.engine !== 'off';
  if ($('scAiEngine')) $('scAiEngine').value = eng;
  const set = (c && c[eng]) || {};
  // 类群：清单来自服务端的 TAXA，选中值来自 cfg
  const taxa = (SCR.aiMeta && SCR.aiMeta.taxa) || [];
  const tSel = $('scAiTaxon');
  if (tSel && taxa.length) {
    if (tSel.options.length !== taxa.length) {
      tSel.innerHTML = taxa.map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join('');
    }
    if (taxa.includes(set.taxon)) tSel.value = set.taxon;
    else if (!tSel.value) tSel.value = taxa[0];
  }
  scAiModelFill(eng, set);
  const st = scAiStatusText();
  if ($('scAiStatus')) {
    $('scAiStatus').textContent = st.txt;
    $('scAiStatus').className = `sc-aist${st.cls ? ' ' + st.cls : ''}`;
    $('scAiStatus').title = on.checked ? '当前 AI 判别状态' : '勾上左边的「AI 语义评分」才会调用大模型';
  }
  // AI 剩余：这一层还有几张没跑过 AI（跑完 AI 判别就能归零）
  const files = scFiles();
  const left = files.filter((f) => !(SCR.scores[f.name] && SCR.scores[f.name].ai)).length;
  if ($('scAiLeft')) {
    $('scAiLeft').textContent = files.length ? (left ? `AI 剩余 ${left} 张` : 'AI 已全部判别') : '';
    $('scAiLeft').title = '当前文件夹里还没做过 AI 判别的张数';
  }
  scQuickPaint();
}

/** 改 AI 设置：存盘 → 拿回新 cfg → 两个面板一起重画 */
async function scAiSave(patch) {
  try {
    const r = await post('/api/score/ai', patch);
    if (r && r.cfg) SCR.cfg = r.cfg;
  } catch (err) {
    toast('保存 AI 设置失败：' + err.message, 3200);
  }
  if (SCR.cfg && SCR.cfg.engine !== 'off') SCR.aiLastEngine = SCR.cfg.engine;
  // 哪个弹窗开着就重画哪个，两处不能各说各话
  if (scAnyDlgShown()) scCfgPaint();
  if (scDlgShown('scLocalMask')) scLocalListRender();
  scAiPaint();
}

/** 换了模型：本地要同时把主模型路径写进去，只有一个 mmproj 时顺手带上 */
async function scAiModelSet(v) {
  const eng = scAiEngine();
  if (eng === 'local') {
    const lm = await scLlamaModels();
    const patch = { local: { modelPath: v } };
    const cur = (SCR.cfg && SCR.cfg.local) || {};
    // 扫描时给 mmproj 下拉自动落的那份只改了客户端 cfg、没存过盘，这里顺手一起持久化，
    // 否则服务端一直空着，重启后配置里就没有 mmproj（v06e「顺手带上了唯一的 mmproj」抓的就是这个）
    if (cur.mmprojPath) patch.local.mmprojPath = cur.mmprojPath;
    else if (lm.projs.length) patch.local.mmprojPath = lm.projs[0].path;
    await scAiSave(patch);
    if ($('scModelPath')) $('scModelPath').value = v;
  } else {
    await scAiSave({ cloud: { model: v } });
  }
}

async function scAiToggleOn(want) {
  if (!SCR.cfg) { await scCfgLoad(); if (!SCR.cfg) return; }
  if (!want) { await scAiSave({ engine: 'off' }); return; }
  // 勾上时挑引擎：本地服务在跑就优先本地（哪怕填了云端 Key 也先用本地）；
  // 否则有 Key 用云端、配过本地模型就用本地、都没配按上次记住的（默认云端）。
  const c0 = SCR.cfg || {};
  const local = c0.local || {};
  const llamaRunning = !!(SCR.llama && SCR.llama.running);
  const pick = llamaRunning ? 'local'
    : (c0.hasCloudKey ? 'cloud'
      : (local.modelPath ? 'local' : (SCR.aiLastEngine === 'local' ? 'local' : 'cloud')));
  await scAiSave({ engine: pick });
  // 勾了却明显用不了：别让它假装在跑，直接把设置打开说清楚
  const c = SCR.cfg || {};
  const bad = c.engine === 'cloud' && !c.hasCloudKey;
  const noModel = c.engine === 'local' && !((c.local || {}).modelPath);
  if (bad || noModel) {
    if (bad) scOpenKeyDlg(); else scOpenLocalMgr();
    toast(bad ? '还没填云端 API Key：在「AI 设置」里贴上自己的 sk- 密钥' : '还没选本地模型：在「本地模型管理」里选一个 .gguf', 4800);
  }
}

/* ---------------- 两个弹窗：AI 设置（云端） / 本地模型管理 ---------------- */

const scDlgShown = (id) => !!($(id) && $(id).classList.contains('show'));
function scOpenDlg(id) { if ($(id)) $(id).classList.add('show'); }
function scCloseDlg(id) { if ($(id)) $(id).classList.remove('show'); }
const scAnyDlgShown = () => scDlgShown('scKeyMask') || scDlgShown('scLocalMask');

/** 提示写到「现在开着的那个」弹窗里；两个都关着就写云端那个 */
function scErrEl() {
  if (scDlgShown('scLocalMask') && $('scCfgErrL')) return $('scCfgErrL');
  return $('scCfgErr');
}

/** AI 设置（云端）：Key / 模型 / 类群 / 图片边长 */
function scOpenKeyDlg() {
  const open = () => { scCfgPaint(); scOpenDlg('scKeyMask'); };
  if (!SCR.cfg) scCfgLoad().then(open);
  else open();
}

/** 本地模型管理：运行库状态、模型列表、启停（照旧版评分器的那个弹窗） */
function scOpenLocalMgr() {
  const open = () => {
    scOpenDlg('scLocalMask');
    scCfgPaint();
    scLlamaScan();
    scLlamaStatus();
  };
  if (!SCR.cfg) scCfgLoad().then(open);
  else open();
}

/** 本地模型列表：一行一个 .gguf，右边「用这个」切换（当前在用的打勾并高亮） */
async function scLocalListRender() {
  const box = $('scModelList');
  if (!box) return;
  const lm = await scLlamaModels();
  if ($('scModelCount')) $('scModelCount').textContent = String(lm.mains.length);
  const cur = String(((SCR.cfg && SCR.cfg.local && SCR.cfg.local.modelPath) || ''));
  const gb = (n) => (n ? `${(n / 1073741824).toFixed(2)} GB` : '大小未知');
  if (!lm.mains.length) {
    box.innerHTML = '<div class="sc-loc-empty">没扫到 .gguf。点上面的「打开」进模型目录，把下载好的主模型（多模态还要一份 mmproj）复制进去，回来点「↻ 重新扫描」。</div>';
    return;
  }
  box.innerHTML = lm.mains.map((f) => {
    const on = f.path === cur;
    return `<div class="sc-loc-item${on ? ' on' : ''}" data-p="${esc(f.path)}">
        <div class="nm"><b>${esc(f.name)}</b><span class="sub">${gb(f.size)}${on ? ' · 当前使用' : ''}</span></div>
        <label class="check"><input type="radio" name="scLocModel" value="${esc(f.path)}"${on ? ' checked' : ''}> ${on ? '在用' : '用这个'}</label>
      </div>`;
  }).join('');
  box.onchange = (e) => {
    const r = e.target.closest('input[type="radio"]');
    if (r && r.value) scAiModelSet(r.value).then(scLocalListRender);
  };
}

function scSyncSel() {
  const n = SCR.sel.size;
  const alb = SCR.mode === 'album';
  // AI 判别目前只压本机 /img 图，相册端先锁上；连拍分组、评分分组、搬文件夹同理
  if ($('scAiRunBtn')) {
    $('scAiRunBtn').disabled = !n || SCR.running || alb;
    $('scAiRunBtn').textContent = SCR.cfg && SCR.cfg.engine !== 'off' ? `AI 判别 ${n} 张` : 'AI 判别选中';
  }
  for (const id of ['scBurstBtn', 'scGroupBtn', 'scBelowGo', 'scBelowPick']) {
    const b = $(id);
    if (b) b.disabled = alb;
  }
  if ($('scSource')) $('scSource').textContent = alb ? '相册端' : '本机端';
  // 全选 / 清空：没有可选的照片就灰掉；顺便把「已选 N 张」写出来
  const onPage = scPagePaths().length;
  if ($('scSelAll')) $('scSelAll').disabled = SCR.running || onPage === 0 || n >= onPage;
  if ($('scSelNone')) $('scSelNone').disabled = SCR.running || n === 0;
  if ($('scSelInfo')) $('scSelInfo').textContent = n ? `已选 ${n} 张` : '';
  // 按钮上直接写清楚这次会动几张：勾了就是勾的数量，没勾就是整层
  if ($('scRunBtn')) $('scRunBtn').textContent = n ? `开始评分 ${n} 张` : '开始评分';
  if ($('scClearBtn')) $('scClearBtn').textContent = n ? `清除 ${n} 张` : '清除评分';
}

/** 当前网格里真正显示着的照片（受星级筛选、连拍折叠影响），全选只选这些 */
function scPagePaths() {
  const grid = $('scGrid');
  if (!grid) return [];
  return [...grid.querySelectorAll('.card.sc-card')].map((c) => c.dataset.p).filter(Boolean);
}

/** 只改 class/勾号，不重建 DOM —— 缩略图不用重新加载 */
function scSelApply() {
  const grid = $('scGrid');
  if (!grid) return;
  for (const card of grid.querySelectorAll('.card.sc-card')) {
    const on = SCR.sel.has(card.dataset.p);
    card.classList.toggle('sel', on);
    const tick = card.querySelector('.tick');
    if (tick) tick.textContent = on ? '✓' : '';
  }
  scSyncSel();
}

/** 标注页卡片右上角的星级角标。评分页算完就能在标注页直接看到哪些值得挑 */
function scoreBadge(f) {
  const rec = SCR.scores[f.name];
  if (!rec || rec.star === undefined) return '';
  const s = Math.max(0, Math.min(3, rec.star || 0));
  return `<span class="score-badge" title="技术分 ${rec.total}，批内第 ${rec.rank_in || '-'} 名">${'★'.repeat(s) || '☆'}${s < 3 ? '☆'.repeat(3 - s) : ''}</span>`;
}

async function scLoad(dir) {
  if (SCR.mode === 'album') return scLoadAlbum();
  const target = dir || SCR.dir || S.dir;
  if (!target) return;
  const prev = SCR.dir;
  SCR.dir = target;
  // 换目录了：连拍分组是按目录算的，别把上一层的组套过来
  if (prev && prev !== target) {
    SCR.bursts = null;
    SCR.groupMode = false;
    scDetailClose(); // 详情里那张已经不在这个目录了
    if ($('scBurstBtn')) $('scBurstBtn').textContent = '连拍分组';
  }
  if ($('scDir')) {
    $('scDir').textContent = `当前文件夹：${shortenPath(target)}`;
    $('scDir').title = target;
  }
  try {
    const [v, d] = await Promise.all([
      api(`/api/score/view?dir=${enc(target)}`),
      api(`/api/score/dirs?dir=${enc(target)}`).catch(() => null),
    ]);
    SCR.dirMeta = d && d.ok ? d : null;
    SCR.scores = v.scores || {};
    SCR.counts = v.counts || [0, 0, 0, 0];
    SCR.invalid = v.invalid || 0;
    // 文件列表：如果就是左边树点开的那个目录，直接复用 S.files（已经带标签，省一次读盘）
    if (target === S.dir && S.files && S.files.length) {
      SCR.files = S.files;
    } else {
      try {
        const l = await api(`/api/list?path=${enc(target)}`);
        SCR.files = l.files || [];
      } catch {
        SCR.files = [];
      }
    }
    SCR.sel.clear();
    scDirsRender();
    scRender();
    scSyncSel();
    // 分组视图开着时，换目录 / 搬完照片都要按新的评分重新分一次组
    if (SG.view) scGroupsRender();
    scAiPaint();
    // 详情抽屉开着的话跟着刷新（刚跑完 AI 就能立刻看到语义说明）
    if (SCR.detail) scDetailOpen(SCR.detail);
    // 标注页的星级角标也跟着更新：评分后即便此刻在评分页，
    // 切回标注页也能立刻看到角标（showTab('annotate') 不会重画网格）
    if (target === S.dir) render();
  } catch (err) {
    toast('读评分失败：' + err.message, 3000);
  }
}

/**
 * 相册端评分：把当前自然在线相册的照片铺成同样的评分卡片。
 * 原图经本机代理 /api/nat/img 取回，在浏览器 Worker 里算技术分，照片不上传；
 * 分数按 photoId 存在 /api/score/remote，和本机目录的「批内星级」互不影响。
 */
async function scLoadAlbum() {
  const album = NAT.album;
  SCR.dir = album ? `nat://album/${album.id}` : '';
  SCR.dirMeta = null;
  SCR.bursts = null;
  SCR.groupMode = false;
  scDetailClose();
  // 照片由「切到相册端 / 打开相册」时已经拉好，这里只复用 NAT.photos。
  // 不在这里再发一次列表请求：那会和 renderNatPhotos 的自动刷新互相触发。
  SCR.albumId = album ? String(album.id) : '';
  SCR.albumFiles = (NAT.photos || []).map((p) => ({
    path: NAT_KEY + p.photoId,
    name: String(p.photoId),
    display: [p.cname, p.lname].filter(Boolean).join(' ') || p.fileName || String(p.photoId),
    url: `/api/nat/img?u=${enc(p.full || p.thumb || '')}`,
    thumbUrl: `/api/nat/img?u=${enc(p.thumb || p.full || '')}`,
    nat: p,
  }));
  try {
    const r = await api('/api/score/remote');
    SCR.remote = r.items || {};
    SCR.scores = {};
    for (const [k, v] of Object.entries(SCR.remote)) if (v && v.rec) SCR.scores[k] = v.rec;
  } catch {
    SCR.remote = {};
    SCR.scores = {};
  }
  SCR.counts = [0, 0, 0, 0];
  SCR.invalid = 0;
  SCR.sel.clear();
  if ($('scDir')) {
    $('scDir').textContent = album ? `当前相册：${album.title || album.id}` : '当前相册：—';
    $('scDir').title = album ? String(album.title || album.id) : '先在左栏选一个自然在线相册';
  }
  if ($('scDirs')) $('scDirs').hidden = true;
  scRender();
  scSyncSel();
  scAiPaint();
  if (SCR.detail) scDetailOpen(SCR.detail);
}

/**
 * 评分页的子文件夹：和「标注」页一样铺成文件夹卡片网格（不是药丸标签）。
 * 这里只负责那条细栏 —— 「↑ 上一层」+ 本层张数；卡片交给 scDirCardsHtml() 混进网格。
 */
function scDirsRender() {
  const box = $('scDirs');
  if (!box) return;
  if (SCR.mode === 'album') { box.hidden = true; return; }
  const m = SCR.dirMeta;
  const subs = (m && m.dirs) || [];
  const hasUp = !!(m && m.parent);
  if (!m || (!subs.length && !hasUp)) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<button class="sc-dir-up" data-up="1" ${hasUp ? '' : 'disabled'} title="返回上一层">↑ 上一层</button>
    <span class="sc-dir-now">本层 <b>${m.files}</b> 张${subs.length ? ` · ${subs.length} 个文件夹` : ''}</span>`;
}

/**
 * 子文件夹卡片：外观照抄标注页的 folderCardHtml（同一套 .card.folder / .thumb.fold），
 * 只把副标题从「文件夹」换成「文件夹 · N 张」，让人一眼知道哪层是空的。
 */
function scDirCardsHtml() {
  if (SCR.mode === 'album') return ''; // 相册端没有「子文件夹」
  const subs = (SCR.dirMeta && SCR.dirMeta.dirs) || [];
  if (!subs.length) return '';
  return subs.map((d) => {
    const n = Number(d.count) || 0;
    return `<div class="card folder sc-dir-card" data-d="${esc(d.path)}" title="${esc(d.path)}">
        <div class="thumb fold">
          <svg viewBox="0 0 48 48" width="46" height="46" aria-hidden="true">
            <path d="M6 14a3 3 0 0 1 3-3h9l4 4.5h17a3 3 0 0 1 3 3v3H6z" fill="#dcae5d"/>
            <path d="M6 19h36l-4 16.5a3 3 0 0 1-3 2.5H12a3 3 0 0 1-3-2.6z" fill="#f0c877"/>
          </svg>
        </div>
        <div class="meta">
          <div class="nm" title="${esc(d.path)}">${esc(d.name)}</div>
          <div class="sz${n ? '' : ' zero'}">文件夹 · ${n} 张</div>
        </div>
      </div>`;
  }).join('');
}

function scRender() {
  const grid = $('scGrid');
  if (!grid) return;
  let files = scFiles();
  const star = $('scStarSel') ? $('scStarSel').value : '';
  if (star !== '') {
    files = files.filter((f) => {
      const r = SCR.scores[f.name];
      if (!r || (r.star === undefined && r.total == null)) return false;
      // 相册端没有「批内星级」，按技术分折算成显示用的 0–3 星
      const st = r.star !== undefined
        ? Number(r.star)
        : Math.max(0, Math.min(3, Math.round((Number(r.total) - 25) / 25)));
      return star === '0' ? st === 0 || !!r.invalid : String(st) === star;
    });
  }
  // 连拍分组：一组只留封面，标题上写清组内还有几张
  let covers = null;
  if (SCR.groupMode && SCR.bursts && SCR.bursts.clusters) {
    covers = new Map();
    for (const c of SCR.bursts.clusters) covers.set(c.cover, c.files.length);
    const hidden = new Set();
    for (const c of SCR.bursts.clusters) for (const n of c.files) if (n !== c.cover) hidden.add(n);
    files = files.filter((f) => !hidden.has(f.name));
  }
  const sort = SCR.sort;
  // 综合分的排序键：有 AI 用综合分，没 AI 退回技术分（和老评分器 sortValue 一个口径）
  const keyOf = (r) => {
    if (!r) return -1;
    if (r.final !== undefined && r.final !== null) return Number(r.final);
    return r.total !== undefined && r.total !== null ? Number(r.total) : -1;
  };
  files.sort((a, b) => {
    if (sort === 'name') return a.name.localeCompare(b.name, 'zh-CN');
    const ra = SCR.scores[a.name] || {}; const rb = SCR.scores[b.name] || {};
    if (sort === 'ai') return (rb.ai?.score ?? -1) - (ra.ai?.score ?? -1) || a.name.localeCompare(b.name, 'zh-CN');
    if (sort === 'final') return keyOf(rb) - keyOf(ra) || a.name.localeCompare(b.name, 'zh-CN');
    return (rb.total ?? -1) - (ra.total ?? -1) || a.name.localeCompare(b.name, 'zh-CN');
  });
  // 子文件夹排在图片前面（和标注页的排法一致），点卡片就进下一层
  grid.innerHTML = scDirCardsHtml() + files.map((f) => scCardHtml(f, SCR.scores[f.name], covers)).join('');
  const empty = $('scEmpty');
  if (empty) {
    empty.hidden = files.length > 0;
    if (!files.length) {
      empty.innerHTML = star !== ''
        ? '这个星级下没有照片。<br>换一个筛选，或点右上角「开始评分」。'
        : SCR.mode === 'album'
          ? '这个相册这一页没有照片。<br>先在左栏「相册端」选一个相册，再点「开始评分」（原图取回本机算，不上传）。'
          : (SCR.dirMeta && SCR.dirMeta.dirs && SCR.dirMeta.dirs.length)
            ? '这一层没有直接放图片，点上面的文件夹卡片继续评。'
            : '这个文件夹没有可评分的图片。<br>在左边选一个装有照片的文件夹，再点「开始评分」。';
    }
  }
  const scored = Object.keys(SCR.scores).length;
  $('scSummary').textContent = SCR.mode === 'album'
    ? (scored
      ? `已评 ${scored} 张 · 相册照片按技术分排序（原图取回本机算，不参与本机批内星级）`
      : '还没评分 · 点右上角「开始评分」，相册原图取回本机算，不上传任何照片')
    : scored
      ? `已评 ${scored} 张 · ★★★ ${SCR.counts[3]} / ★★ ${SCR.counts[2]} / ★ ${SCR.counts[1]} / 0★ ${SCR.counts[0]}${SCR.invalid ? ` · 废片 ${SCR.invalid}` : ''}${SCR.groupMode ? ' · 连拍已折叠' : ''}`
      : '还没评分 · 点右上角「开始评分」，本机算法离线运行，不上传任何照片';
  // 筛选/排序会改变「本层可见张数」，全选按钮的可用状态要跟着走
  scSyncSel();
}

function scCardHtml(f, rec, covers) {
  const star = rec && rec.star !== undefined
    ? Math.max(0, Math.min(3, rec.star))
    : rec && rec.total != null
      ? Math.max(0, Math.min(3, Math.round((Number(rec.total) - 25) / 25)))
      : null;
  const starTxt = star === null ? '' : '★'.repeat(star) + '☆'.repeat(3 - star);
  const tags = rec && rec.tags ? String(rec.tags).split(';').filter(Boolean) : [];
  const extra = covers && covers.get(f.name) ? ` <span class="sc-ai">＋${covers.get(f.name) - 1} 张同组</span>` : '';
  // 大数字给综合分；没跑 AI 就只有技术分，不能拿技术分冒充综合分
  const hasFinal = rec && rec.final !== undefined && rec.final !== null;
  const big = hasFinal ? rec.final : (rec && rec.total !== undefined && rec.total !== null ? rec.total : null);
  const nums = big === null
    ? '<span>未评分</span>'
    : `<b>${big}</b><span class="lb">${hasFinal ? '综合分' : '技术分'}</span>`
      + (rec.ai ? `<span class="sub">技术 ${rec.total} · AI ${rec.ai.score}</span>` : '');
  const nm = f.display || f.name;
  // 相册端的图走本机代理；本机端还是 /img?path=
  const src = f.thumbUrl || `/img?path=${enc(f.path)}&thumb=1`;
  return `<div class="card sc-card${SCR.sel.has(f.path) ? ' sel' : ''}${star === 0 ? ' s0' : ''}" data-p="${esc(f.path)}" data-n="${esc(nm)}" title="${esc(nm)}｜单击勾选，照片旁边看评分详情">
    <div class="thumb">
      <img loading="lazy" decoding="async" draggable="false" src="${esc(src)}" alt="">
      <span class="tick">${SCR.sel.has(f.path) ? '✓' : ''}</span>
      ${starTxt ? `<span class="sc-star" title="批内百分位 ${rec.pct != null ? Math.round(rec.pct * 100) + '%' : '—'}">${starTxt}</span>` : ''}
    </div>
    <div class="sc-meta">
      <div class="nm" title="${esc(nm)}">${esc(nm)}</div>
      <div class="sc-nums">${nums}${extra}</div>
      ${tags.length ? `<div class="sc-tags" title="${esc(tags.join(' · '))}">${esc(tags.join(' · '))}</div>` : ''}
      ${rec && rec.ai ? `<div class="sc-ai" title="${esc(rec.ai.comment || '')}">${esc([rec.ai.kind, rec.ai.comment].filter(Boolean).join(' · ') || 'AI 已判别')}</div>` : ''}
    </div>
  </div>`;
}

/* ---------------- 评分详情（技术分各评分点 + AI 语义说明） ---------------- */

const SD_METRICS = [
  ['清晰', 'sharpness'], ['焦点', 'focus'], ['曝光', 'exposure'],
  ['对比', 'contrast'], ['色彩', 'saturation'], ['噪点', 'noise'], ['主体', 'subject'],
];

function scDetailHtml(f, rec) {
  if (!rec || rec.total === undefined || rec.total === null) {
    return '<div class="sd-none">这张还没评分。<br>点右上角「开始评分」跑本机算法（离线、不上传照片）。'
      + (SCR.aiErr ? `<div class="err">上次 AI 判别失败：${esc(SCR.aiErr)}</div>` : '')
      + '</div>';
  }
  const star = Math.max(0, Math.min(3, rec.star || 0));
  const hasFinal = rec.final !== undefined && rec.final !== null;
  const big = hasFinal ? rec.final : rec.total;
  const cls = big >= 70 ? '' : (big >= 45 ? ' mid' : ' low');
  const ai = rec.ai || null;
  const metrics = SD_METRICS.map(([label, key]) => {
    const v = rec[key];
    if (v === undefined || v === null) return '';
    const warn = Number(v) < 40 ? ' class="warn"' : '';
    return `<div${warn}>${label} <b>${v}</b></div>`;
  }).join('');
  const aiLine = ai ? [
    `对象:${ai.has_insect || '—'}`,
    ai.kind ? `实际:${ai.kind}` : '',
    ai.clarity ? `主体:${ai.clarity}` : '',
    ai.composition ? `构图:${ai.composition}` : '',
    ai.key_parts ? `鉴定部位:${ai.key_parts}` : '',
  ].filter(Boolean).join(' · ') : '';
  const tags = rec.tags ? String(rec.tags).split(';').filter(Boolean) : [];
  const meta = [
    rec.width && rec.height ? `${rec.width}×${rec.height}` : '',
    rec.filesize_kb ? `${rec.filesize_kb} KB` : '',
    rec.iso ? `ISO ${rec.iso}` : '',
    rec.rank_in ? `批内第 ${rec.rank_in} 名` : '',
  ].filter(Boolean).join(' · ');
  return `<div class="sd-score">
      <span class="sd-star">${'★'.repeat(star) || '☆'}${star < 3 ? '☆'.repeat(3 - star) : ''}</span>
      <b class="sd-final${cls}">${big}</b>
      <span class="sd-lab">${hasFinal ? '综合分' : '技术分'}</span>
      <span class="sd-sub">技术 ${rec.total}${ai ? ` · AI ${ai.score}` : ''}</span>
    </div>
    ${rec.insect_strict ? '<span class="sd-strict" title="这次 AI 评审用的是昆虫鉴定标准（专用昆虫检测）">专用昆虫检测</span>' : ''}
    ${metrics ? `<div class="sd-metrics">${metrics}</div>` : ''}
    <div class="sd-ai">${ai
    ? `<div class="q">${esc(aiLine)}</div>${ai.comment ? `<div class="cmt">${esc(ai.comment)}</div>` : ''}`
    : `<div class="q">还没做 AI 语义分析。</div>${SCR.aiErr
      ? `<div class="err">上次 AI 判别失败：${esc(SCR.aiErr)}</div>`
      : '<div class="cmt">勾上「AI 语义评分」、选好引擎，勾选这张照片后点上面的「AI 判别」按钮，这里会给出对象/实际/主体/构图/鉴定部位和一句点评。</div>'}`}
    </div>
    ${tags.length ? `<div class="sd-tags">${tags.map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
    ${meta ? `<div class="sd-meta">${esc(meta)}</div>` : ''}`;
}

function scDetailOpen(path) {
  const f = scFiles().find((x) => x.path === path);
  const box = $('scDetail');
  if (!f || !box) { scDetailClose(); return; }
  SCR.detail = path;
  if ($('scDetailFile')) {
    const nm = f.display || f.name;
    $('scDetailFile').textContent = nm;
    $('scDetailFile').title = nm;
  }
  const body = $('scDetailBody');
  if (body) body.innerHTML = scDetailHtml(f, SCR.scores[f.name] || null);
  box.hidden = false;
  scDetailPlace();
}

/** 找到当前详情对应的那张卡片（网格重画后元素会换，所以每次现找） */
function scDetailCard() {
  if (!SCR.detail) return null;
  const cards = document.querySelectorAll('#scGrid .card.sc-card');
  for (const c of cards) if (c.dataset.p === SCR.detail) return c;
  return null;
}

/**
 * 把详情浮层贴到照片旁边：优先放右侧，右边放不下改左侧，
 * 两侧都挤不开就压在卡片正下方；垂直方向跟着卡片走并夹在视口里。
 * 用 position:fixed + 视口坐标，滚动/改窗口大小时重算一次就行。
 */
function scDetailPlace() {
  const box = $('scDetail');
  if (!box || box.hidden) return;
  const card = scDetailCard();
  if (!card) return;
  const r = card.getBoundingClientRect();
  const bw = box.offsetWidth || 332;
  const bh = box.offsetHeight || 240;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const gap = 12;
  const pad = 10;
  let side = 'right';
  let left = r.right + gap;
  if (left + bw > vw - pad) { left = r.left - gap - bw; side = 'left'; }
  if (left < pad) {
    // 两边都没地方：退化成贴在卡片下方（窄屏走 CSS 的贴底方案，这里只兜中间宽度）
    side = 'none';
    left = Math.max(pad, Math.min(r.left, vw - bw - pad));
  }
  let top = r.top + r.height / 2 - bh / 2;
  if (top + bh > vh - pad) top = vh - bh - pad;
  if (top < pad) top = pad;
  box.style.left = `${Math.round(left)}px`;
  box.style.top = `${Math.round(top)}px`;
  box.dataset.side = side;
  // 箭头对着卡片中线（夹住，别跑出浮层两端）
  const mid = r.top + r.height / 2 - top;
  const arrow = Math.round(Math.max(14, Math.min(bh - 24, mid - 4)));
  box.style.setProperty('--sd-arrow', `${arrow}px`);
}

function scDetailClose() {
  SCR.detail = '';
  const box = $('scDetail');
  if (box) box.hidden = true;
}

/* ---------------- 框选：在网格空白处按下拖出一个矩形 ---------------- */

function bindScMarquee() {
  const grid = $('scGrid');
  if (!grid) return;
  grid.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.pointerType === 'touch' || SCR.running) return;
    if (e.target.closest('.card')) return; // 卡片上按下是点选 / 进子文件夹，不画框
    scClearTextSelection();
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const base = additive ? new Set(SCR.sel) : new Set();
    const box = document.createElement('div');
    box.className = 'sc-marquee';
    document.body.appendChild(box);
    grid.classList.add('dragging');
    const x0 = e.clientX; const y0 = e.clientY;
    let moved = false;
    const onMove = (ev) => {
      const dx = ev.clientX - x0; const dy = ev.clientY - y0;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      moved = true;
      const l = Math.min(x0, ev.clientX); const t = Math.min(y0, ev.clientY);
      const w = Math.abs(dx); const h = Math.abs(dy);
      box.style.left = `${l}px`; box.style.top = `${t}px`;
      box.style.width = `${w}px`; box.style.height = `${h}px`;
      const hits = new Set(base);
      for (const card of grid.querySelectorAll('.card.sc-card')) {
        const r = card.getBoundingClientRect();
        if (!r.width && !r.height) continue; // 没排版的节点当作不在框里
        if (r.right < l || r.left > l + w || r.bottom < t || r.top > t + h) continue;
        hits.add(card.dataset.p);
      }
      SCR.sel = hits;
      scSelApply();
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      box.remove();
      grid.classList.remove('dragging');
      if (moved) {
        SCR.marqMoved = true; // 紧接着那次 click 要吞掉，否则会把刚框到的又取消
      } else if (!additive) {
        SCR.sel = new Set();
        scSelApply();
      }
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    e.preventDefault();
  });
}


/** 本机技术评分：只评没评过的，每 20 张落一次盘，中途停掉也不丢 */
/**
 * 勾选的照片（按当前文件列表换成 file 对象）。
 * 没勾就返回空数组 —— 调用方据此决定「全层」还是「只处理勾选的」。
 */
function scPickedFiles() {
  const picked = [...SCR.sel];
  if (!picked.length) return [];
  return scFiles().filter((f) => picked.includes(f.path));
}

async function scRun() {
  if (SCR.mode === 'album') return scRunAlbum();
  if (SCR.running || !SCR.dir) return;
  // 勾了几张就只评这几张（用户预期的「我选中的那几张」）；没勾才整层评
  const picked = scPickedFiles();
  const files = picked.length ? picked : scFiles();
  if (!files.length) {
    toast(picked.length ? '选中的照片不在当前文件夹' : '这个文件夹没有可评分的图片');
    return;
  }
  const todo = files.filter((f) => !SCR.scores[f.name] || SCR.scores[f.name].stale);
  if (!todo.length) {
    toast(picked.length
      ? `选中的 ${files.length} 张都评过了。想重评就先勾上它们点「清除评分」。`
      : '这个文件夹已经评过了。想重评就先点右上角「清除评分」。', 4000);
    return;
  }
  SCR.running = true;
  scProgress(true, 0, todo.length, `准备评分 ${todo.length} 张${picked.length ? '（只评勾选的）' : ''}…`);
  scSyncSel();
  let pending = {};
  let failed = 0;
  const flush = async (force) => {
    if (!Object.keys(pending).length) return;
    if (!force && Object.keys(pending).length < 20) return;
    const batch = pending; pending = {};
    try { await post('/api/score/put', { dir: SCR.dir, entries: batch }); } catch { /* 下一批再补 */ }
  };
  try {
    const meta = await post('/api/score/meta', { dir: SCR.dir, names: todo.map((f) => f.name) });
    const items = todo.map((f) => ({ name: f.name, path: f.path, meta: (meta.meta || {})[f.name] || {} }));
    const r = await scTask('score', items, {}, (m) => {
      if (m.rec && m.key) {
        pending[m.key] = m.rec;
        SCR.scores[m.name] = m.rec;
        flush(false);
      }
      if (m.error) failed += 1;
      scProgress(true, m.done, m.total, `${m.done}/${m.total}  ${m.error ? '跳过 ' + m.name : esc(m.name || '')}`);
    });
    await flush(true);
    if (r.error) toast('评分出错：' + r.error, 3600);
    await scLoad(SCR.dir);
    toast(`评分完成 ${Object.keys(r.entries).length} 张${failed ? `，跳过 ${failed} 张` : ''}${r.cancelled ? '（已停止）' : ''}`, 3000);
  } catch (err) {
    toast('评分失败：' + err.message, 4000);
  } finally {
    SCR.running = false;
    scProgress(false);
    scSyncSel();
  }
}

/** 相册端评分：原图经本机代理取回，Worker 用 remote 模式算，分数按 photoId 落盘 */
async function scRunAlbum() {
  if (SCR.running) return;
  const picked = scPickedFiles();
  const files = picked.length ? picked : scFiles();
  if (!files.length) return toast('这个相册没有可评分的照片；先在左栏选一个相册', 3200);
  const todo = files.filter((f) => !SCR.scores[f.name] || SCR.scores[f.name].stale);
  if (!todo.length) {
    toast(picked.length
      ? `选中的 ${files.length} 张都评过了。想重评就先勾上它们点「清除评分」。`
      : '这一页都评过了。想重评就先点「清除评分」。', 4000);
    return;
  }
  const items = todo.map((f) => ({ key: f.name, name: f.display || f.name, url: f.url, meta: {} }));
  SCR.running = true;
  scProgress(true, 0, todo.length, `准备评分 ${todo.length} 张${picked.length ? '（只评勾选的）' : ''}…`);
  scSyncSel();
  let failed = 0;
  try {
    const r = await scTask('remote', items, {}, (m) => {
      if (m.rec && m.key) {
        SCR.scores[m.key] = m.rec;
        SCR.remote[m.key] = { rec: m.rec, name: m.name, source: 'nature' };
        post('/api/score/remote', { key: m.key, name: m.name, rec: m.rec, source: 'nature' })
          .catch(() => { /* 缓存写失败不挡显示 */ });
      }
      if (m.error) failed += 1;
      scProgress(true, m.done, m.total, `${m.done}/${m.total}  ${m.error ? '跳过 ' + m.name : esc(m.name || '')}`);
    });
    for (const it of items) if (!r.entries[it.key]) failed += 1;
    scRender();
    toast(`评分完成 ${Object.keys(r.entries).length} 张${failed ? `，跳过 ${failed} 张` : ''}${r.cancelled ? '（已停止）' : ''}`, 3000);
  } catch (err) {
    toast('评分失败：' + err.message, 4000);
  } finally {
    SCR.running = false;
    scProgress(false);
    scSyncSel();
  }
}

/** AI 判别：Worker 压图 → 服务端转发到云端 / 本地 llama-server → 结果写回评分缓存 */
async function scAiRun() {
  if (SCR.mode === 'album') { toast('AI 语义评分目前只支持本机端照片', 3000); return; }
  if (SCR.running) { toast('上一个任务还在跑，等它结束再点', 2800); return; }
  if (!SCR.cfg || SCR.cfg.engine === 'off') {
    toast('先在页面上勾选「AI 语义评分」并选一个引擎', 3600);
    if ($('scAiOn')) $('scAiOn').focus();
    return;
  }
  const picked = [...SCR.sel];
  const files = scFiles().filter((f) => (picked.length ? picked.includes(f.path) : SCR.scores[f.name]));
  if (!files.length) { toast(picked.length ? '选中的照片不在当前文件夹' : '先给这个文件夹评分，或勾选几张照片'); return; }
  const engine = SCR.cfg.engine;
  const set = engine === 'local' ? SCR.cfg.local : SCR.cfg.cloud;

  // 本地引擎：先确认服务真的在听。界面上那句「运行中」是上一次查询的快照，
  // 程序重启 / 手动关掉端口 / 上次退出把 llama-server 收走了，都可能已经过期，
  // 不查就白等一轮再把请求打到空气里。
  if (engine === 'local') {
    let live = null;
    try { live = await api('/api/score/llama/status'); } catch { /* 查不到就让后面的请求自己报错 */ }
    if (live) { SCR.llama = live; scAiPaint(); }
    // 没在跑但模型是配好的：直接替用户把本地服务拉起来，别让人先去点一遍「启动本地服务」。
    // 程序重启会把 llama-server 一起收掉，这是最常见的一次「明明选了本地却不生效」。
    if (live && !live.running && !live.starting) {
      const LO = SCR.cfg.local || {};
      const canStart = !!(LO.modelPath || (SCR.llamaModels && SCR.llamaModels.mains && SCR.llamaModels.mains.length));
      if (canStart) {
        toast('本地服务没在运行，正在自动启动本地模型…', 3200);
        SCR.running = true;
        scProgress(true, 0, 1, '正在启动本地模型…');
        scSyncSel();
        try { await scLlamaStart(); } catch { /* 起不来的原因下面统一报 */ }
        finally { SCR.running = false; scProgress(false); scSyncSel(); }
        try { live = await api('/api/score/llama/status'); } catch { /* 保持原样 */ }
        if (live) { SCR.llama = live; scAiPaint(); }
      }
    }
    if (live && !live.running) {
      const logTail = String(live.log || '').trim().split('\n').pop() || '';
      const msg = `本地服务没在运行（${(SCR.cfg.local && SCR.cfg.local.baseUrl) || '未填地址'}）。`
        + '点工具条上的「启动本地服务」等它显示运行中，再点 AI 判别。'
        + (live.error ? ` ${live.error}` : '') + (logTail && !live.error ? ` ${logTail}` : '');
      SCR.aiErr = msg;
      scAiPaint();
      if (SCR.detail) scDetailOpen(SCR.detail);
      toast(msg, 7000);
      return;
    }
    // 端口可能漂了（18080 被占就会往后顺延），跟实际地址对齐，别拿着旧地址请求
    if (live && live.running && live.baseUrl && SCR.cfg.local && SCR.cfg.local.baseUrl !== live.baseUrl) {
      SCR.cfg.local.baseUrl = live.baseUrl;
      try { await scAiSave({ local: { baseUrl: live.baseUrl } }); } catch { /* 存不上也照跑 */ }
    }
  }

  const side = Number(set.imgSide) || 768;
  SCR.aiErr = '';
  SCR.running = true;
  scProgress(true, 0, files.length, `准备压图 ${files.length} 张…`);
  scSyncSel();
  try {
    const encOut = await scTask('encode', files.map((f) => ({ name: f.name, path: f.path })), { side }, (m) => {
      scProgress(true, m.done, m.total, `压图 ${m.done}/${m.total}`);
    });
    if (!encOut.images.length) { toast('没有能压成 JPEG 的图片', 3200); return; }
    scProgress(true, 0, encOut.images.length, `正在请求 ${engine === 'local' ? '本地模型' : '云端模型'}…`);
    const r = await post('/api/score/ai/run', {
      dir: SCR.dir,
      engine,
      images: encOut.images,
      taxon: set.taxon,
      strict: !!set.strict,
    });
    if (r.ok) toast(`AI 判别完成 ${encOut.images.length} 张`, 2600);
    else {
      const msg = (r.errors && r.errors[0]) || r.error || 'AI 判别没成功';
      SCR.aiErr = msg;
      toast(msg, 5200);
    }
  } catch (err) {
    // api() 在 ok:false 时会抛错：服务端带出来的真实错误在 errors[0]/error 里（也可能只在 err.payload）
    const p = err.payload || {};
    const msg = (p.errors && p.errors[0]) || p.error || err.message || '未知错误';
    SCR.aiErr = msg;
    toast('AI 判别失败：' + msg, 5200);
  } finally {
    // 无论成功 / 失败 / 部分成功，都刷新一遍，让「AI 剩余」计数和详情跟服务端对齐
    try { await scLoad(SCR.dir); } catch { /* 刷新失败不挡提示 */ }
    SCR.running = false;
    scProgress(false);
    scSyncSel();
    scAiPaint();
    if (SCR.detail) scDetailOpen(SCR.detail);
  }
}

/* ---------------- AI 设置 ---------------- */

async function scCfgLoad() {
  try {
    const r = await api('/api/score/ai');
    SCR.cfg = r.cfg;
    SCR.aiMeta = { cloudModels: r.cloudModels, localGuide: r.localGuide, taxa: r.taxa };
    if (SCR.cfg && SCR.cfg.engine !== 'off') SCR.aiLastEngine = SCR.cfg.engine;
    scCfgPaint();
    scAiPaint();
  } catch (err) {
    toast('读 AI 设置失败：' + err.message, 3000);
  }
}

function scFill(sel, list, cur, label, value) {
  if (!sel) return;
  sel.innerHTML = list.map((x) => `<option value="${esc(value(x))}">${esc(label(x))}</option>`).join('');
  sel.value = cur;
  if (sel.value !== String(cur)) sel.selectedIndex = 0;
}

/** GBIF 面板那份 DeepSeek 配置：只回「有没有」，明文 Key 永远不进浏览器 */
function gxCfgPaint() {
  const d = (S.state && S.state.deepseek) || {};
  if ($('gxKey')) $('gxKey').value = '';
  if ($('gxKeyHint')) {
    $('gxKeyHint').textContent = d.hasApiKey ? '已配置（留空即不改动）' : '未配置';
    $('gxKeyHint').style.color = d.hasApiKey ? 'var(--green-d)' : 'var(--ink-3)';
  }
  if ($('gxModel')) $('gxModel').value = d.model || 'deepseek-chat';
}

async function gxKeySave() {
  const key = ($('gxKey') && $('gxKey').value || '').trim();
  const model = ($('gxModel') && $('gxModel').value || '').trim();
  if (!key && !model) return;
  const st = await post('/api/config', { deepseek: { apiKey: key, model } });
  if (st && st.deepseek) S.state.deepseek = st.deepseek;
  gxCfgPaint();
  toast('GBIF 的 DeepSeek Key 已加密保存');
}

/**
 * 内置大陆中文名录（《中国生物物种名录》）状态。只读 —— 名录随程序分发，
 * 不需要 API Key、不需要联网，所以这里只展示版本/条数，不做任何配置。
 */
function colcnPaint() {
  const el = $('colcnInfo');
  if (!el) return;
  const c = (S.state && S.state.colcn) || {};
  if (c.ready) {
    el.textContent = `${c.version} 年度版 · ${Number(c.count || 0).toLocaleString('zh-CN')} 条 · 已内置`;
    el.style.color = 'var(--green-d)';
  } else {
    el.textContent = c.error ? `未启用：${c.error}` : '未启用';
    el.style.color = 'var(--ink-3)';
  }
}

/** 查名自检：用内置名录查一个学名，纯本地、不联网。 */
async function colcnProbe() {
  const q = (($('colcnProbe') && $('colcnProbe').value) || '').trim();
  const out = $('colcnProbeOut');
  if (!q) {
    if (out) out.textContent = '填一个学名再查';
    return;
  }
  if (out) out.textContent = '查询中…';
  try {
    const r = await post('/api/colcn/test', { scientificName: q });
    if (out) {
      out.textContent = r.ok ? `${q} → ${r.cn}` : (r.error || '未收录');
      out.style.color = r.ok ? 'var(--green-d)' : 'var(--ink-3)';
    }
  } catch (e) {
    if (out) out.textContent = e.message || '查询失败';
  }
}

function scCfgPaint() {
  gxCfgPaint();
  colcnPaint();
  const c = SCR.cfg; const m = SCR.aiMeta;
  if (!c || !m) return;
  scFill($('scCloudModel'), m.cloudModels, c.cloud.model, (x) => x.name, (x) => x.id);
  scFill($('scTaxon'), m.taxa, c.cloud.taxon, (x) => x, (x) => x);
  scFill($('scLocalTaxon'), m.taxa, c.local.taxon, (x) => x, (x) => x);
  $('scSide').value = String(c.cloud.imgSide || 768);
  $('scBatch').value = String(c.cloud.batch || 4);
  $('scLocalSide').value = String(c.local.imgSide || 512);
  $('scBaseUrl').value = c.local.baseUrl || '';
  $('scLocalModel').value = c.local.model || '';
  $('scModelPath').value = c.local.modelPath || '';
  $('scKey').value = '';
  $('scKeyHint').textContent = c.hasCloudKey ? '已配置（留空即不改动）' : '未配置';
  $('scKeyHint').style.color = c.hasCloudKey ? 'var(--green-d)' : 'var(--ink-3)';
  // 专用昆虫检测：云端/本地各存一份，跟着各自的类群走
  if ($('scStrict')) $('scStrict').checked = !!(c.cloud && c.cloud.strict);
  if ($('scStrictLocal')) $('scStrictLocal').checked = !!(c.local && c.local.strict);
  scStrictSync();
  const g = m.localGuide || {};
  $('scLocalTip').textContent = g.howto || '';
  $('scLocalLinks').innerHTML = (g.models || [])
    .map((x) => `<li><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.name)}</a> · ${esc(x.size)}</li>`)
    .join('');
  $('scLocalCmd').textContent = g.example || '';
  if ($('scCfgErr')) $('scCfgErr').textContent = '';
  if ($('scCfgErrL')) $('scCfgErrL').textContent = '';
  // 运行库与模型清单都是服务端现查的，异步补，不挡弹窗打开
  scLlamaScan();
  scLlamaStatus();
  scLocalListRender();
  scQuickPaint();
  scSyncSel();
}

/**
 * 『（进阶）专用昆虫检测』只有昆虫类群有意义：非昆虫时置灰但仍然显示。
 * 之前这版把它弄丢了，用户以为功能没了 —— 所以宁可灰着也不隐藏。
 */
function scStrictSync() {
  for (const [chk, taxonSel, wrap] of [
    ['scStrict', 'scTaxon', 'scStrictWrap'],
    ['scStrictLocal', 'scLocalTaxon', 'scStrictLocalWrap'],
  ]) {
    const c = $(chk); const t = $(taxonSel); const w = $(wrap);
    if (!c || !t) continue;
    const insect = /昆虫/.test(t.value || '');
    c.disabled = !insect;
    if (w) {
      w.classList.toggle('off', !insect);
      w.title = insect
        ? '进阶：按昆虫鉴定标准严格评审（检查触角/复眼/足/翅/鞘翅等关键部位，并识别蜘蛛等非昆虫节肢动物）'
        : '只有「类群」选昆虫时才能用（当前类群用的是通用判据）';
    }
    // 抽屉里改了类群/勾选，页面上的快捷控件要立刻跟着变（两处不能各说各话）。
    // t.value 为空说明抽屉还没填好（初次绑定），这时别拿空值去改 cfg。
    if (SCR.cfg && t.value) {
      const eng = taxonSel === 'scTaxon' ? 'cloud' : 'local';
      const set = SCR.cfg[eng] || (SCR.cfg[eng] = {});
      set.taxon = t.value;
      set.strict = !!c.checked;
    }
  }
  scQuickPaint();
}

function scCfgBody(withKey) {
  const c = SCR.cfg || {};
  const CL = c.cloud || {};
  const LO = c.local || {};
  /**
   * 从弹窗控件取值，取不到（控件不存在 / 是空串）就退回已存的配置。
   * 这一步很关键：工具条上的「启动本地服务」也会调 scCfgSave，
   * 那时弹窗根本没打开、输入框全是空的，直接读 DOM 会把已有配置整份写空
   * （local.modelPath 被清成 ""，下次就报「还没选主模型」）。
   */
  const pick = (id, fallback) => {
    const el = $(id);
    const v = el && typeof el.value === 'string' ? el.value.trim() : '';
    return v || String(fallback == null ? '' : fallback);
  };
  const num = (id, fallback) => {
    const el = $(id);
    const n = el ? Number(el.value) : NaN;
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const on = (id, fallback) => {
    const el = $(id);
    return el ? !!el.checked : !!fallback;
  };
  return {
    ...(withKey ? { key: pick('scKey', '') || '__KEEP__' } : {}),
    cloud: {
      model: pick('scCloudModel', CL.model),
      imgSide: num('scSide', Number(CL.imgSide) || 768),
      batch: num('scBatch', Number(CL.batch) || 4),
      taxon: pick('scTaxon', CL.taxon),
      strict: on('scStrict', CL.strict),
    },
    local: {
      baseUrl: pick('scBaseUrl', LO.baseUrl),
      model: pick('scLocalModel', LO.model || 'tagden-ai'),
      modelPath: pick('scModelPath', LO.modelPath),
      // 下拉没选中时保留原来存的那份，别因为「这次没扫到」把路径清掉
      mmprojPath: pick('scMmprojSel', LO.mmprojPath),
      ctx: LO.ctx || 8192,
      ngl: Number.isFinite(Number(LO.ngl)) ? Number(LO.ngl) : 99,
      imgSide: num('scLocalSide', Number(LO.imgSide) || 512),
      batch: 1,
      taxon: pick('scLocalTaxon', LO.taxon),
      strict: on('scStrictLocal', LO.strict),
    },
  };
}

async function scCfgSave(withKey = true) {
  const err = scErrEl();
  try {
    await post('/api/score/ai', scCfgBody(withKey));
    // 重新拉一次：保证 aiMeta（云端模型/类群清单）已就绪再 paint，
    // 否则弹窗刚打开、scCfgLoad 还没回包时 paint 会提前 return，界面不刷新。
    await scCfgLoad();
    if (err) {
      err.textContent = '已保存';
      err.style.color = '';
      setTimeout(() => { if (err.textContent === '已保存') err.textContent = ''; }, 1800);
    }
    return true;
  } catch (e) {
    if (err) { err.textContent = e.message; err.style.color = ''; }
    return false;
  }
}

async function scCfgTest() {
  await scCfgSave(true);
  const err = scErrEl();
  const engine = (SCR.cfg && SCR.cfg.engine) || 'off';
  if (engine === 'off') { if (err) err.textContent = '先在页面上勾选「AI 语义评分」并选一个引擎'; return; }
  if (err) { err.textContent = '正在测试…'; err.style.color = ''; }
  try {
    const r = await post('/api/score/ai/test', { engine });
    if (err) {
      err.textContent = r.ok ? `连接正常 · ${r.model}` : (r.error || '连不上');
      err.style.color = r.ok ? 'var(--green-d)' : 'var(--red)';
    }
  } catch (e) {
    if (err) err.textContent = e.message;
  }
}

/* ---------------- 本地大模型：内置运行库 + 一键拉起 ---------------- */

/** 扫程序目录 / data 目录 models 里的 .gguf，填进两个下拉 */
async function scLlamaScan() {
  const selM = $('scModelSel');
  const selP = $('scMmprojSel');
  if (!selM || !selP) return;
  let r;
  try { r = await api('/api/score/llama/models'); } catch { return; }
  // 刚扫过就作废页面 AI 行那份缓存，否则新丢进去的 .gguf 不会出现在上面的下拉里
  SCR.llamaModels = null;
  // 顺便把「模型目录」那行的路径显示出来，用户才知道该往哪儿放文件
  if ($('scModelDirPath') && r.dirs && r.dirs[0]) $('scModelDirPath').value = r.dirs[0];
  const files = r.files || [];
  const mains = files.filter((f) => !f.mmproj);
  const projs = files.filter((f) => f.mmproj);
  const gb = (n) => (n ? `${(n / 1073741824).toFixed(1)} GB` : '');
  const opt = (f) => `<option value="${esc(f.path)}">${esc(f.name)}${f.size ? ' · ' + gb(f.size) : ''}</option>`;
  selM.innerHTML = mains.length ? mains.map(opt).join('') : '<option value="">（没扫到模型）</option>';
  selP.innerHTML = projs.length ? projs.map(opt).join('') : '<option value="">（没扫到 mmproj）</option>';
  const curM = ($('scModelPath').value || '').trim();
  if (curM && mains.some((f) => f.path === curM)) selM.value = curM;
  const curP = (SCR.cfg && SCR.cfg.local && SCR.cfg.local.mmprojPath) || '';
  if (curP && projs.some((f) => f.path === curP)) selP.value = curP;
  // 下拉会自动落到第一项，但那样不会触发 change，hidden 的 scModelPath 就一直空着，
  // 存盘时 modelPath 被写成 ""，下次启动就报「还没选主模型」。这里主动对齐一次。
  if (!curM && selM.value && $('scModelPath')) $('scModelPath').value = selM.value;
  if (!curP && selP.value && SCR.cfg && SCR.cfg.local && !SCR.cfg.local.mmprojPath) {
    SCR.cfg.local.mmprojPath = selP.value;
  }
  if (!mains.length && $('scLlamaMsg') && !$('scLlamaMsg').textContent) {
    $('scLlamaMsg').textContent = '把 .gguf 放进程序目录的 models 文件夹，或直接填完整路径';
  }
  // 这次扫描的结果直接喂给缓存和列表，别再打一次接口
  SCR.llamaModels = { mains, projs, dirs: r.dirs || [] };
  scLocalListRender();
}

async function scLlamaStatus() {
  const el = $('scRunState');
  if (!el) return;
  let r;
  try { r = await api('/api/score/llama/status'); } catch { return; }
  SCR.llama = r;
  const rt = r.runtime || {};
  const kind = r.running ? ' ok' : (rt.bundled ? '' : ' bad');
  const txt = r.running
    ? `运行中 · 端口 ${r.port}`
    : rt.kind === 'custom'
      ? '用户自带运行库（程序目录 llama/）'
      : rt.kind === 'builtin'
        ? '已内置 llama.cpp（Windows CPU 版）'
        : rt.bundled
          ? '已内置（首次启动时自动解压）'
          : '未内置（Mac 请自行启动 llama-server 后填地址）';
  el.className = `sc-runstate${kind}`;
  el.innerHTML = `<i class="dot"></i>${esc(txt)}`;
  if ($('scRunHint')) $('scRunHint').textContent = r.starting ? '正在加载模型…' : '';
  if ($('scLlamaStop')) $('scLlamaStop').disabled = !r.running;
  if ($('scLlamaStart')) $('scLlamaStart').disabled = !!r.running || !!r.starting;
  if (r.running && r.baseUrl) {
    if ($('scBaseUrl')) $('scBaseUrl').value = r.baseUrl;
    if ($('scLocalModel')) $('scLocalModel').value = 'tagden-ai';
  }
  if (r.running && $('scLlamaMsg') && !$('scLlamaMsg').textContent) {
    $('scLlamaMsg').textContent = `已就绪：${r.baseUrl}`;
  }
  // 页面 AI 行上的状态文字（运行中 / 运行库 OK）跟着这个走
  if ($('scAiStatus')) scAiPaint();
  else scQuickPaint();
}

async function scLlamaStart() {
  // 取模型的顺序：弹窗里选的 → 已存的配置 → 扫到的第一个 .gguf。
  // 工具条上的「启动本地服务」不会开弹窗，DOM 里啥都没有，只能靠后两级兜住。
  let model = ($('scModelPath').value || '').trim()
    || ($('scModelSel') && $('scModelSel').value)
    || ((SCR.cfg && SCR.cfg.local && SCR.cfg.local.modelPath) || '').trim();
  let mmproj = (($('scMmprojSel') && $('scMmprojSel').value) || '').trim()
    || ((SCR.cfg && SCR.cfg.local && SCR.cfg.local.mmprojPath) || '').trim();
  if (!model || !mmproj) {
    const lm = await scLlamaModels();
    if (!model && lm.mains.length) model = lm.mains[0].path;
    if (!mmproj && lm.projs.length) mmproj = lm.projs[0].path;
  }
  if (!model) {
    return toast('还没选本地模型：点「本地模型管理」，把 .gguf 放进模型目录后在 ⤢ 里选一个', 4800);
  }
  if (!mmproj) {
    return toast('还没配 mmproj：视觉模型必须有配套的 mmproj 文件才能看图（在「本地模型管理」里选）', 5200);
  }
  if ($('scLlamaMsg')) $('scLlamaMsg').textContent = '正在启动（首次要解压运行库 + 加载模型，可能要一两分钟）…';
  if ($('scLlamaStart')) $('scLlamaStart').disabled = true;
  try {
    const r = await post('/api/score/llama/start', {
      model,
      mmproj,
      ctx: (SCR.cfg && SCR.cfg.local && SCR.cfg.local.ctx) || 8192,
      ngl: (SCR.cfg && SCR.cfg.local && Number.isFinite(Number(SCR.cfg.local.ngl))) ? Number(SCR.cfg.local.ngl) : 99,
    });
    if (!r.ok) {
      if ($('scLlamaMsg')) $('scLlamaMsg').textContent = (r.error || '启动失败').split('\n')[0];
      toast('启动失败：' + (r.error || '').split('\n')[0], 5200);
      return;
    }
    // 实际用上的路径写回配置：下次不用再选，工具条也能一键起
    if ($('scModelPath')) $('scModelPath').value = model;
    if ($('scMmprojSel') && mmproj) $('scMmprojSel').value = mmproj;
    if ($('scBaseUrl')) $('scBaseUrl').value = r.baseUrl;
    if ($('scLocalModel')) $('scLocalModel').value = r.model || 'tagden-ai';
    if ($('scLlamaMsg')) $('scLlamaMsg').textContent = `已就绪：${r.baseUrl}`;
    await scCfgSave(true); // 地址、别名、模型路径一起存下来
    toast('本地服务已就绪，点「测试连接」确认一下就能用了', 3600);
  } catch (err) {
    if ($('scLlamaMsg')) $('scLlamaMsg').textContent = err.message;
  } finally {
    scLlamaStatus();
  }
}

async function scLlamaStop() {
  try {
    await post('/api/score/llama/stop', {});
    if ($('scLlamaMsg')) $('scLlamaMsg').textContent = '已停止';
  } catch (err) {
    if ($('scLlamaMsg')) $('scLlamaMsg').textContent = err.message;
  }
  scLlamaStatus();
}

/** 在文件管理器里打开 models 文件夹：下好的 gguf 直接复制进去，再点 ↻ 就扫到了 */
async function scOpenModels() {
  const el = $('scModelDirPath');
  const dir = ((el && el.value) || '').trim();
  try {
    const r = await post('/api/score/llama/open-models', { dir });
    if (!r.ok) return toast(r.error || '打不开模型文件夹', 4200);
    if (el && r.dir) el.value = r.dir;
    toast(`已打开模型文件夹，把 .gguf 复制进去后点 ↻ 重新扫描`, 4200);
  } catch (err) {
    toast('打不开模型文件夹：' + err.message, 4200);
  }
}

/* ---------------- 本页操作与联动 ---------------- */

async function scClear() {
  if (!SCR.dir) return;
  // 和「开始评分」同一套口径：勾了就只清勾选的那几张
  const picked = scPickedFiles();
  const names = picked.length ? picked.map((f) => f.name) : null;
  if (SCR.mode === 'album') {
    const keys = names || scFiles().map((f) => f.name);
    if (!keys.length) return;
    if (!confirm(keys.length && names
      ? `清掉勾选的 ${keys.length} 张评分记录？站点照片本身不会动。`
      : `清掉这个相册已评的 ${keys.length} 张评分记录？站点照片本身不会动。`)) return;
    try {
      await post('/api/score/remote/clear', { keys });
      for (const k of keys) { delete SCR.scores[k]; delete SCR.remote[k]; }
      scRender();
      toast(`已清除 ${keys.length} 张的评分`, 2400);
    } catch (err) { toast('清除失败：' + err.message, 3000); }
    return;
  }
  const ask = names
    ? `清掉勾选的 ${names.length} 张评分记录？照片本身不会动。`
    : '还没有勾选照片，会清掉整个文件夹的评分记录。照片本身不会动。<br><br>只想清几张的话，先把它们勾上再点这里。';
  if (!confirm(ask.replace(/<br>/g, '\n'))) return;
  try {
    await post('/api/score/clear', names ? { dir: SCR.dir, names } : { dir: SCR.dir });
    if (names) {
      for (const n of names) delete SCR.scores[n];
    } else {
      SCR.scores = {}; SCR.bursts = null; SCR.groupMode = false;
    }
    await scLoad(SCR.dir);
    toast(names ? `已清除 ${names.length} 张的评分` : '评分已清除', 2400);
  } catch (err) { toast('清除失败：' + err.message, 3000); }
}

async function scBursts() {
  if (SCR.mode === 'album') { toast('连拍分组只支持本机端照片', 2600); return; }
  if (!SCR.dir) return;
  SCR.groupMode = !SCR.groupMode;
  if (SCR.groupMode && !SCR.bursts) {
    try { SCR.bursts = await api(`/api/score/bursts?dir=${enc(SCR.dir)}&gap=3`); }
    catch (err) { toast('连拍分组失败：' + err.message, 3000); SCR.groupMode = false; }
  }
  $('scBurstBtn').textContent = SCR.groupMode ? '展开连拍' : '连拍分组';
  scRender();
  if (SCR.groupMode) toast(`折叠了 ${(SCR.bursts?.clusters || []).length} 组连拍，每组只留封面`, 2600);
}

/**
 * 切到评分页：评分对象跟随左栏的「本机端 / 相册端」。
 * 本机端：左边树换了目录才跟着跳；在页内点进子文件夹后，来回切标签不会被打回上一层。
 * 相册端：换了相册就重新把这一页照片铺出来。
 */
function scoreOpen() {
  const mode = S.mode === 'album' ? 'album' : 'local';
  if (SCR.mode !== mode) {
    SCR.mode = mode;
    SCR.dir = '';
    SCR.sel.clear();
    SCR.detail = '';
    scDetailClose();
  }
  if (SCR.mode === 'album') {
    const aid = NAT.album ? String(NAT.album.id) : '';
    if (SCR.albumId !== aid || !SCR.albumFiles) scLoadAlbum();
    else { scDirsRender(); scRender(); }
  } else if (!SCR.dir || SCR.follow !== S.dir) {
    SCR.follow = S.dir;
    scLoad(S.dir);
  } else {
    scDirsRender();
    scRender();
  }
  if (!SCR.cfg) scCfgLoad(); else scAiPaint();
  scSyncSel();
}

/* ---------------- 评分分组（照原版评分器的分档页） ----------------
 * 原版 insect-photo-scorer 有个「评分分组」页：按 3/5/10 级把已评分照片摊成一组一组，
 * 每组能全选、能整体处理。这里搬进工坊，再加「低于 N 分搬到某个文件夹」。 */
const SG = { view: false, dest: '', buckets: [], defs: [] };

/** 显示的分数口径和排序、服务端筛选保持一致：有 AI 用综合分，没 AI 用技术分 */
function scScoreOf(rec) {
  if (!rec) return null;
  const v = rec.final !== undefined && rec.final !== null ? Number(rec.final) : Number(rec.total);
  return Number.isFinite(v) ? v : null;
}

function scGroupDefs() {
  const lv = Number(($('scGroupLevels') && $('scGroupLevels').value) || 5);
  if (lv === 10) {
    const out = [];
    for (let i = 9; i >= 0; i--) out.push({ label: `${i * 10}~${i * 10 + 10} 分`, min: i * 10, max: i * 10 + 10, mode: 'score' });
    return out;
  }
  if (lv === 3) return [
    { label: '优 ★★★', stars: [3], mode: 'star' },
    { label: '中 ★★', stars: [2], mode: 'star' },
    { label: '差 ☆ 及以下', stars: [0, 1], mode: 'star', bad: true },
  ];
  return [
    { label: '★★★ 优选', stars: [3], mode: 'star' },
    { label: '★★ 良好', stars: [2], mode: 'star' },
    { label: '★ 可留', stars: [1], mode: 'star' },
    { label: '0★ 建议删', stars: [0], mode: 'star' },
    { label: '废片', mode: 'bad' },
  ];
}

function scGroupIndex(rec, defs) {
  if (!rec) return -1;
  if (rec.invalid) {
    const bad = defs.findIndex((d) => d.mode === 'bad');
    if (bad >= 0) return bad;
    const poor = defs.findIndex((d) => d.bad);
    if (poor >= 0) return poor;
  }
  for (let i = 0; i < defs.length; i++) {
    const d = defs[i];
    if (d.mode === 'bad') continue;
    if (d.mode === 'score') {
      const v = scScoreOf(rec);
      if (v === null) continue;
      if (v >= d.min && (v < d.max || (d.max === 100 && v <= 100))) return i;
    } else if (!rec.invalid && d.stars && d.stars.indexOf(Number(rec.star)) >= 0) return i;
  }
  return -1;
}

function scBelowValue() {
  const v = Number($('scBelow') && $('scBelow').value);
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null;
}

function scBelowNames() {
  const below = scBelowValue();
  if (below === null) return [];
  return scFiles().filter((f) => {
    const rec = SCR.scores[f.name];
    if (!rec) return false;
    const v = scScoreOf(rec);
    return v !== null && v < below;
  }).map((f) => f.name);
}

function scBelowStat() {
  const btn = $('scBelowGo');
  if (!btn) return;
  const n = scBelowNames().length;
  btn.textContent = `移到文件夹${n ? `（${n} 张）` : ''}`;
  btn.disabled = false;
}

function scGroupToggle() {
  if (SCR.mode === 'album') { toast('评分分组只支持本机端照片', 2600); return; }
  SG.view = !SG.view;
  const box = $('scGroups');
  const body = $('scBody');
  if (box) box.hidden = !SG.view;
  if (body) body.hidden = SG.view;
  $('scGroupBtn').textContent = SG.view ? '回到照片网格' : '评分分组';
  if (SG.view) scGroupsRender();
}

function scGroupsRender() {
  const box = $('scGroupList');
  if (!box) return;
  const defs = scGroupDefs();
  const buckets = defs.map(() => []);
  const unscored = [];
  const other = [];
  for (const f of scFiles()) {
    const rec = SCR.scores[f.name];
    if (!rec) { unscored.push({ f, rec: null }); continue; }
    const i = scGroupIndex(rec, defs);
    if (i < 0) other.push({ f, rec });
    else buckets[i].push({ f, rec });
  }
  if (unscored.length) { defs.push({ label: '未评分', mode: 'none' }); buckets.push(unscored); }
  if (other.length) { defs.push({ label: '其它', mode: 'none' }); buckets.push(other); }
  SG.defs = defs;
  SG.buckets = buckets.map((b) => b.map((x) => x.f.name));

  const scored = Object.keys(SCR.scores).length;
  if ($('scGroupStat')) $('scGroupStat').textContent = `已评 ${scored} 张 · ${defs.length} 组 · 未评分 ${unscored.length} 张`;
  const firstFull = buckets.findIndex((b) => b.length > 0);
  box.innerHTML = defs.map((d, i) => {
    const items = buckets[i];
    const canMove = d.mode !== 'none';
    const thumbs = items.length
      ? `<div class="sc-gthumbs">${items.map(({ f, rec }) => {
          const v = scScoreOf(rec);
          const st = rec && rec.star !== undefined ? '★'.repeat(Math.max(0, Math.min(3, rec.star || 0))) : '';
          return `<div class="sc-gmini" title="${esc(f.name)}">
            <img loading="lazy" src="/img?path=${enc(f.path)}&amp;thumb=1" alt="">
            <div class="gnum"><b>${v === null ? '未评分' : v}</b><span>${st || (rec && rec.invalid ? '废片' : '')}</span></div>
            <div class="gname">${esc(f.name)}</div>
          </div>`;
        }).join('')}</div>`
      : '<div class="sc-gempty">本组暂无照片</div>';
    return `<details class="sc-grp" ${i === firstFull ? 'open' : ''}>
      <summary><span>${esc(d.label)}</span><span class="gcount">${items.length} 张</span>
        <span class="gacts">
          <button class="ghost mini" data-act="sel" data-g="${i}" title="回照片网格并勾选这一组">全选本组</button>
          ${canMove ? `<button class="ghost mini" data-act="move" data-g="${i}" title="把这一组平铺移到目标文件夹">本组移到…</button>` : ''}
        </span>
      </summary>
      <div class="sc-gbody">${thumbs}</div>
    </details>`;
  }).join('');
  scBelowStat();
}

function scGroupListClick(e) {
  const b = e.target.closest && e.target.closest('button[data-act]');
  if (!b) return;
  const i = Number(b.dataset.g);
  const names = SG.buckets[i] || [];
  if (!names.length) return toast('这一组没有照片');
  if (b.dataset.act === 'sel') {
    SCR.sel.clear();
    for (const f of scFiles()) if (names.indexOf(f.name) >= 0) SCR.sel.add(f.path);
    scGroupToggle();
    scRender();
    scSyncSel();
    return toast(`已选中这一组的 ${names.length} 张`, 2400);
  }
  const label = `「${(SG.defs[i] && SG.defs[i].label) || '这一组'}」`;
  return scMoveFiles(names, label);
}

function scPickDest() {
  dirPickerOpen(SG.dest || SCR.dir || S.dir, (p) => {
    SG.dest = p;
    const el = $('scBelowDest');
    if (el) { el.textContent = shortenPath(p); el.title = p; }
  });
}

/** 移动是不可撤销的，统一在这里二次确认；评分记录由服务端跟着照片一起搬 */
async function scDoMove(body, label) {
  const btn = $('scBelowGo');
  if (btn) btn.disabled = true;
  try {
    const out = await post('/api/score/move', body);
    if (!out.ok) throw new Error(out.error || '移动失败');
    toast(`${label}：已移动 ${out.moved} 张到 ${shortenPath(SG.dest)}${out.failed && out.failed.length ? `，失败 ${out.failed.length} 张` : ''}`, 3600);
    SCR.sel.clear();
    await scLoad(SCR.dir);
    if (SG.view) scGroupsRender();
  } catch (err) {
    toast('移动失败：' + err.message, 4000);
  } finally {
    scBelowStat();
  }
}

function scMoveFiles(names, label) {
  if (!names || !names.length) return toast('没有可移动的照片');
  if (!SG.dest) return toast('先点「目标文件夹…」挑一个地方', 3000);
  if (!confirm(`把${label || '选中的照片'}共 ${names.length} 张移到：\n${SG.dest}\n\n照片会从现在的文件夹里搬走（评分记录跟着走），继续吗？`)) return;
  return scDoMove({ dir: SCR.dir, dest: SG.dest, files: names }, label || '选中的照片');
}

function scBelowGo() {
  if (SCR.mode === 'album') { toast('按分数搬照片只支持本机端', 2600); return; }
  const below = scBelowValue();
  if (below === null) return toast('请填一个 0–100 的分数');
  const names = scBelowNames();
  if (!names.length) return toast(`低于 ${below} 分没有已评分的照片`, 2600);
  if (!SG.dest) return toast('先点「目标文件夹…」挑一个地方', 3000);
  if (!confirm(`把低于 ${below} 分的 ${names.length} 张照片移到：\n${SG.dest}\n\n照片会从现在的文件夹里搬走（评分记录跟着走），继续吗？`)) return;
  return scDoMove({ dir: SCR.dir, dest: SG.dest, below }, `低于 ${below} 分`);
}

function bindScore() {
  // 标注页工具条：一键切过来
  if ($('toScoreBtn')) {
    $('toScoreBtn').onclick = () => {
      showTab('score');
      // 已经评过就不重复跑，只是过来看结果
      if (!Object.keys(SCR.scores).length) setTimeout(() => scRun(), 160);
    };
  }
  $('scRunBtn').onclick = scRun;
  $('scCancelBtn').onclick = () => { if (SCR.worker) SCR.worker.postMessage({ type: 'cancel' }); };
  $('scStarSel').onchange = () => { SCR.star = $('scStarSel').value; scRender(); };
  $('scSortSel').onchange = () => { SCR.sort = $('scSortSel').value; scRender(); };
  $('scBurstBtn').onclick = scBursts;
  $('scGroupBtn').onclick = scGroupToggle;
  $('scGroupLevels').onchange = scGroupsRender;
  $('scGroupReload').onclick = scGroupsRender;
  $('scGroupList').onclick = scGroupListClick;
  $('scBelow').oninput = scBelowStat;
  $('scBelowPick').onclick = scPickDest;
  $('scBelowGo').onclick = scBelowGo;
  $('scClearBtn').onclick = scClear;
  $('scAiRunBtn').onclick = scAiRun;
  // 评分页的「↑ 上一层」：只换评分目录，不动左边树
  if ($('scDirs')) {
    $('scDirs').onclick = (e) => {
      const up = e.target.closest('[data-up]');
      if (!up) return;
      const parent = SCR.dirMeta && SCR.dirMeta.parent;
      if (parent) { SCR.sel.clear(); scLoad(parent); }
    };
  }
  $('scGrid').onclick = (e) => {
    // 刚框选完：吞掉这次 click，别把框到的又取消掉
    if (SCR.marqMoved) { SCR.marqMoved = false; return; }
    // 文件夹卡片：进下一层（不参与勾选）
    const dirCard = e.target.closest('.card.folder[data-d]');
    if (dirCard && dirCard.dataset.d) { SCR.sel.clear(); scLoad(dirCard.dataset.d); return; }
    const card = e.target.closest('.card.sc-card');
    if (!card) return;
    const p = card.dataset.p;
    if (SCR.sel.has(p)) SCR.sel.delete(p); else SCR.sel.add(p);
    card.classList.toggle('sel', SCR.sel.has(p));
    const tick = card.querySelector('.tick');
    if (tick) tick.textContent = SCR.sel.has(p) ? '✓' : '';
    scSyncSel();
    // 点一下同时把详情摊开：技术分各评分点 + AI 语义说明都在右边
    scDetailOpen(p);
  };
  // 全选 / 清空：只作用于当前网格里显示着的照片
  if ($('scSelAll')) {
    $('scSelAll').onclick = () => {
      SCR.sel = new Set(scPagePaths());
      scSelApply();
    };
  }
  if ($('scSelNone')) {
    $('scSelNone').onclick = () => { SCR.sel = new Set(); scSelApply(); };
  }
  if ($('scDetailX')) $('scDetailX').onclick = scDetailClose;
  // 工具条上的快捷入口：启动本地服务 / 专用昆虫检测（不用先开 AI 设置）
  if ($('scQuickLlama')) $('scQuickLlama').onclick = scQuickToggleLlama;
  if ($('scQuickStrict')) $('scQuickStrict').onchange = (e) => scQuickStrict(e.target.checked);
  // 详情抽屉：Esc 关；点空白处（既不在抽屉里，也不是照片卡片）也关
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (scDlgShown('scLocalMask')) { scCloseDlg('scLocalMask'); return; }
    if (scDlgShown('scKeyMask')) { scCloseDlg('scKeyMask'); return; }
    if (SCR.detail) scDetailClose();
  });
  document.addEventListener('pointerdown', (e) => {
    if (!SCR.detail) return;
    const t = e.target;
    if (!t || !t.closest) return;
    // 点浮层自己、点任何照片卡片（会换成那张的详情）、点「AI 设置」这类按钮都不关
    if (t.closest('#scDetail') || t.closest('.card.sc-card')) return;
    scDetailClose();
  });
  // 浮层是 fixed 定位的，网格一滚就和照片脱开了：滚哪儿跟哪儿
  const followDetail = () => { if (SCR.detail) scDetailPlace(); };
  if ($('scGrid')) $('scGrid').addEventListener('scroll', followDetail, { passive: true });
  if ($('scBody')) $('scBody').addEventListener('scroll', followDetail, { passive: true });
  window.addEventListener('resize', followDetail);
  // 从卡片上按下拖鼠标会留下原生文字选区（整块变蓝），这里兜底清一下。
  // 标注页/相册/统计/归档都有卡片，所以是**文档级**而不是只在评分页
  bindNoTextSelect();
  bindScMarquee();
  if ($('scTaxon')) $('scTaxon').onchange = scStrictSync;
  if ($('scLocalTaxon')) $('scLocalTaxon').onchange = scStrictSync;
  scStrictSync();
  // AI 设置抽屉
  // AI 行：开不开 / 类群 / 引擎 / 模型，改完立刻落盘并重画（跟设置抽屉一个来源）
  if ($('scAiOn')) $('scAiOn').onchange = (e) => scAiToggleOn(e.target.checked);
  if ($('scAiEngine')) {
    $('scAiEngine').onchange = (e) => {
      SCR.aiLastEngine = e.target.value === 'local' ? 'local' : 'cloud';
      // 换引擎就是要用它：顺手把「AI 语义评分」勾上，少点一次
      if ($('scAiOn')) $('scAiOn').checked = true;
      scAiSave({ engine: SCR.aiLastEngine });
    };
  }
  if ($('scAiTaxon')) {
    $('scAiTaxon').onchange = (e) => {
      const eng = scAiEngine();
      scAiSave({ [eng]: { taxon: e.target.value } });
    };
  }
  if ($('scAiModel')) $('scAiModel').onchange = (e) => scAiModelSet(e.target.value);
  if ($('scLocalMgrBtn')) $('scLocalMgrBtn').onclick = scOpenLocalMgr;
  // 两个弹窗：AI 设置（云端） / 本地模型管理，各管各的，不再是一个抽屉里切来切去
  $('scCfgBtn').onclick = scOpenKeyDlg;
  $('scKeyClose').onclick = () => scCloseDlg('scKeyMask');
  $('scKeySave').onclick = async () => {
    await scCfgSave(true);
    try { await gxKeySave(); } catch (e) { toast(e.message || 'GBIF 的 Key 没存上', 3200); }
  };
  if ($('gxKeyClear')) {
    $('gxKeyClear').onclick = async () => {
      try {
        const st = await post('/api/config', { deepseek: { clear: true } });
        if (st && st.deepseek) S.state.deepseek = st.deepseek;
        gxCfgPaint();
        toast('已清除 GBIF 的 DeepSeek Key');
      } catch (e) { toast(e.message || '清除失败'); }
    };
  }
  // 内置大陆中文名录：只读状态 + 查名自检（不需要配置）
  if ($('colcnProbeBtn')) $('colcnProbeBtn').onclick = colcnProbe;
  if ($('colcnProbe')) {
    $('colcnProbe').onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); colcnProbe(); }
    };
  }
  $('scLocalClose').onclick = () => scCloseDlg('scLocalMask');
  $('scLocalSave').onclick = () => scCfgSave(true);
  // 点遮罩空白处 / 按 Esc 都能关
  for (const id of ['scKeyMask', 'scLocalMask']) {
    const m = $(id);
    if (m) m.addEventListener('mousedown', (e) => { if (e.target === m) scCloseDlg(id); });
  }
  $('scDelKeyBtn').onclick = async () => {
    if (!confirm('删除已保存的云端 API Key？')) return;
    const body = scCfgBody(false); body.key = '';
    const r = await post('/api/score/ai', body);
    SCR.cfg = r.cfg; scCfgPaint();
    toast('云端 Key 已删除', 2200);
  };
  $('scTestBtn').onclick = scCfgTest;
  $('scTestBtn2').onclick = scCfgTest;
  // 本地大模型：选模型 → 启动 → 自动填地址
  if ($('scModelSel')) $('scModelSel').onchange = () => { const v = $('scModelSel').value; if (v) $('scModelPath').value = v; };
  if ($('scModelScan')) $('scModelScan').onclick = () => scLlamaScan();
  if ($('scLlamaStart')) $('scLlamaStart').onclick = scLlamaStart;
  if ($('scLlamaStop')) $('scLlamaStop').onclick = scLlamaStop;
  if ($('scOpenModels')) $('scOpenModels').onclick = scOpenModels;
  scSyncSel();
}

/* ---------------- 自然在线相册照片的评分（取回原图在本机算） ---------------- */

/** 缩略图右上角的星级角标：评分页相册端的 key 就是 photoId，算完这里能直接看见 */
function natScoreBadge(p) {
  const r = SCR.remote[String(p.photoId)];
  if (!r) return '';
  if (r.busy) return '<span class="score-badge" title="正在取回原图评分"><span class="spin"></span></span>';
  if (r.error) return `<span class="score-badge" title="${esc(r.error)}">!</span>`;
  const rec = r.rec || {};
  if (rec.total == null) return '';
  const base = rec.final != null ? rec.final : rec.total;
  const s = Math.min(3, Math.max(0, Math.round((base - 25) / 25)));
  const ai = rec.ai && rec.ai.score != null ? `，AI ${rec.ai.score}` : '';
  const tip = `${rec.final != null ? '综合' : '技术'}分 ${base}${ai}`;
  return `<span class="score-badge" title="${esc(tip)}">${'★'.repeat(s) || '☆'}${s < 3 ? '☆'.repeat(3 - s) : ''}</span>`;
}

function natScoreLine(p) {
  const r = SCR.remote[String(p.photoId)];
  if (!r) return '';
  if (r.busy) return '<div class="idr run"><span class="spin"></span>评分中…</div>';
  if (r.error) return `<div class="idr bad" title="${esc(r.error)}">评分失败</div>`;
  const rec = r.rec || {};
  if (rec.total == null) return '';
  const base = rec.final != null ? rec.final : rec.total;
  const s = Math.min(3, Math.max(0, Math.round((base - 25) / 25)));
  const ai = rec.ai && rec.ai.score != null ? ` · AI ${rec.ai.score}` : '';
  const tags = String(rec.tags || '').replace(/;/g, ' · ');
  return `<div class="idr ${base >= 70 ? 'ok' : 'new'}" title="${esc(tags || '本机技术评分')}">${rec.final != null ? '综合' : '技术'} ${base}${ai} ${'★'.repeat(s)}${'☆'.repeat(3 - s)}</div>`;
}

async function natScoreSelected() {
  if (SCR.running) return;
  const ids = [...NAT.sel];
  const list = (NAT.photos || []).filter((p) => ids.includes(p.photoId));
  if (!list.length) { toast('先在相册里勾选几张照片'); return; }
  SCR.running = true;
  const items = list.map((p) => ({
    key: p.photoId,
    name: [p.cname, p.lname].filter(Boolean).join(' ') || p.fileName || p.photoId,
    url: `/api/nat/img?u=${enc(p.full || p.thumb || '')}`,
    meta: {},
  }));
  for (const it of items) SCR.remote[it.key] = { busy: true };
  renderNatPhotos();
  try {
    const r = await scTask('remote', items, {});
    for (const [k, rec] of Object.entries(r.entries)) {
      SCR.remote[k] = { rec };
      try { await post('/api/score/remote', { key: k, name: items.find((x) => x.key === k)?.name || '', rec, source: 'nature' }); } catch { /* 缓存失败不挡显示 */ }
    }
    for (const it of items) if (!r.entries[it.key]) SCR.remote[it.key] = { error: '没能解码这张图' };
    renderNatPhotos();
    toast(`评分完成 ${Object.keys(r.entries).length} 张`, 2400);
  } catch (err) {
    toast('评分失败：' + err.message, 3600);
  } finally {
    SCR.running = false;
  }
}


boot();
