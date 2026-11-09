'use strict';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NAME = document.body.dataset.name || '她';
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* 隐私模式 */ } } };

// 口令：网址里 #key=xxx 读一次就记住并从地址栏抹掉
let key = store.get('giftRoomKey') || '';
{ const hk = new URLSearchParams(location.hash.slice(1)).get('key'); if (hk) { key = hk; store.set('giftRoomKey', hk); history.replaceState(null, '', location.pathname + location.search); } }

let S = null, tapPose = null, tapTimer = 0;
let seen = new Set(); try { seen = new Set(JSON.parse(store.get('giftRoomSeen') || '[]')); } catch { /* 坏数据就当没看过 */ }
const firstVisit = !store.get('giftRoomSeen');

function toast(t, ms = 2400) { const el = $('#toast'); el.textContent = t; el.style.display = 'block'; clearTimeout(toast.t); toast.t = setTimeout(() => (el.style.display = 'none'), ms); }
async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'x-room-key': key, ...(opts.headers || {}) } });
  if (r.status === 401) { $('#keybox').classList.add('on'); throw Error('key'); }
  return r;
}
const postJson = (path, body, method = 'POST') => api(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
$('#keyGo').onclick = async () => {
  key = $('#keyInput').value.trim();
  try { const r = await api('/api/state'); if (r.ok) { store.set('giftRoomKey', key); $('#keybox').classList.remove('on'); render(await r.json()); } } catch { toast('口令不对'); }
};

// ---------------------------------------------------------------- 图标：取回来，白底的抠成透明，裁掉空边
const iconCache = new Map();
const BOX = '/character/box.png';
function iconSrc(it) {
  if (typeof it.icon !== 'number') return Promise.resolve(BOX);
  const k = it.id + ':' + it.icon;
  if (!iconCache.has(k)) {
    iconCache.set(k, api('/api/items/' + encodeURIComponent(it.id) + '/icon?v=' + it.icon)
      .then((r) => (r.ok ? r.blob() : null)).then((b) => (b ? cutWhite(b) : BOX)).catch(() => BOX));
  }
  return iconCache.get(k);
}
async function cutWhite(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, 512 / Math.max(bmp.width, bmp.height));
    const W = Math.round(bmp.width * k), H = Math.round(bmp.height * k);
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(bmp, 0, 0, W, H);
    const img = g.getImageData(0, 0, W, H), d = img.data;
    const whiteAt = (i) => d[i + 3] > 200 && 255 - Math.min(d[i], d[i + 1], d[i + 2]) < 28;
    const corners = [0, (W - 1) * 4, (H - 1) * W * 4, (H * W - 1) * 4];
    if (corners.every(whiteAt)) {
      // 从四条边上连着的白色往里漫，漫到的都变透明；挨着的一圈按离白多远给半透明，边缘不发硬
      const bg = new Uint8Array(W * H), q = [];
      const push = (p) => { if (!bg[p] && whiteAt(p * 4)) { bg[p] = 1; q.push(p); } };
      for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
      for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
      while (q.length) {
        const p = q.pop(), x = p % W, y = (p / W) | 0;
        if (x > 0) push(p - 1); if (x < W - 1) push(p + 1); if (y > 0) push(p - W); if (y < H - 1) push(p + W);
      }
      for (let p = 0; p < W * H; p++) {
        if (bg[p]) { d[p * 4 + 3] = 0; continue; }
        const x = p % W, y = (p / W) | 0;
        if ((x > 0 && bg[p - 1]) || (x < W - 1 && bg[p + 1]) || (y > 0 && bg[p - W]) || (y < H - 1 && bg[p + W])) {
          const dist = 255 - Math.min(d[p * 4], d[p * 4 + 1], d[p * 4 + 2]);
          d[p * 4 + 3] = Math.min(d[p * 4 + 3], Math.max(64, Math.min(255, dist * 4)));
        }
      }
      g.putImageData(img, 0, 0);
    }
    // 裁到内容边界
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (d[(y * W + x) * 4 + 3] > 24) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) return URL.createObjectURL(blob);
    const o = document.createElement('canvas'); o.width = x1 - x0 + 1; o.height = y1 - y0 + 1;
    o.getContext('2d').drawImage(c, x0, y0, o.width, o.height, 0, 0, o.width, o.height);
    return await new Promise((res) => o.toBlob((b) => res(URL.createObjectURL(b || blob)), 'image/png'));
  } catch { return URL.createObjectURL(blob); }
}
const ratio = new Map();
function aspect(src) {
  if (ratio.has(src)) return Promise.resolve(ratio.get(src));
  return new Promise((res) => { const im = new Image(); im.onload = () => { const v = im.naturalWidth / im.naturalHeight || 1; ratio.set(src, v); res(v); }; im.onerror = () => res(1); im.src = src; });
}

// ---------------------------------------------------------------- 时间和光线（按服务端配置的时区）
const previewH = Number(new URLSearchParams(location.search).get('t')); // 只用来预览光线：?t=22
function localNow() {
  const d = new Date(Date.now() + (S?.utcOffset ?? 8) * 3600e3);
  if (location.search.includes('t=') && previewH >= 0 && previewH < 24) d.setUTCHours(previewH);
  return { h: d.getUTCHours(), m: d.getUTCMinutes() };
}
const fmt = (iso, withTime = true) => {
  if (!iso) return '';
  const d = new Date(Date.parse(iso) + (S?.utcOffset ?? 8) * 3600e3);
  return (d.getUTCMonth() + 1) + '月' + d.getUTCDate() + '日' + (withTime ? ' ' + String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0') : '');
};
function lighting(theme) {
  const { h, m } = localNow(); const t = h + m / 60;
  let tint = 'rgba(0,0,0,0)', glow = 0;
  if (theme?.tint !== 'none') { // 背景本身就是夜景的风格（tint: "none"）不再调光线
    if (t >= 19 || t < 5.5) { tint = 'rgba(30,40,100,.58)'; glow = 1; }
    else if (t >= 17.3) { tint = 'rgba(235,130,70,.28)'; glow = .5; }
    else if (t < 7) { tint = 'rgba(120,130,200,.32)'; glow = .3; }
  }
  $('#tint').style.background = tint; $('#glow').style.opacity = glow;
  $('#clock').textContent = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

// ---------------------------------------------------------------- 画房间
const SIZE_H = { s: 6, m: 10, l: 20 }, SIZE_W = { s: 10, m: 15, l: 22 };
let lastSay = store.get('giftRoomSay') || '', sayUntil = 0;
let themeId = store.get('giftRoomTheme') || '';

// 风格只影响自己这台设备上看到的样子，存在浏览器里
function renderThemes() {
  const nav = $('#themes');
  nav.innerHTML = S.themes.length < 2 ? '' : S.themes.map((t) => '<button data-t="' + esc(t.id) + '" class="' + (t.id === themeId ? 'on' : '') + '">' + esc(t.name) + '</button>').join('');
  nav.querySelectorAll('button').forEach((b) => (b.onclick = () => { themeId = b.dataset.t; store.set('giftRoomTheme', themeId); render(S); }));
}

async function render(st) {
  S = st;
  if (!S.themes.length) { $('#status').textContent = '没有房间背景'; return; }
  if (!S.themes.some((t) => t.id === themeId)) themeId = S.theme || S.themes[0].id;
  const theme = S.themes.find((t) => t.id === themeId); const L = S.layout;
  renderThemes();
  const bg = $('#bg'); const want = '/themes/' + theme.id + '/bg.jpg'; if (bg.getAttribute('src') !== want) bg.src = want;
  const ch = S.character; const pose = tapPose || ch.pose;
  $('#status').innerHTML = esc(NAME) + '<b>' + esc(ch.text || '在屋里') + '</b>';
  const frag = document.createDocumentFragment();

  // 摆在屋里的东西
  const bySpot = {};
  for (const it of S.items) if (L.spots[it.spot]) (bySpot[it.spot] = bySpot[it.spot] || []).push(it);
  for (const [sp, list] of Object.entries(bySpot)) {
    const s = L.spots[sp];
    list.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    const n = list.length, slot = (s.x1 - s.x0) / Math.max(n, s.fill || 1);
    for (let i = 0; i < n; i++) {
      const it = list[i]; const src = await iconSrc(it); const ar = await aspect(src);
      let hh = Math.min(s.h * 0.92, SIZE_H[it.size] || SIZE_H.m), ww = hh * ar;
      const maxW = Math.min(slot * 0.92, SIZE_W[it.size] || SIZE_W.m);
      if (ww > maxW) { ww = maxW; hh = ww / ar; }
      const el = document.createElement('div');
      el.className = 'thing' + (seen.has(it.id) ? '' : ' new');
      const cx = s.x0 + slot * (i + 0.5);
      const by = s.b1 == null ? s.b : s.b + (s.b1 - s.b) * (cx - s.x0) / (s.x1 - s.x0); // 透视里斜着的搁板：左右两头底边高度不同
      Object.assign(el.style, { left: cx + '%', bottom: (100 - by) + '%', width: ww + '%', height: hh + '%', zIndex: Math.round(by * 10) });
      el.innerHTML = '<img alt="">' + (src === BOX ? '<span class="label"></span>' : '');
      el.firstChild.src = src; if (src === BOX) el.querySelector('.label').textContent = it.name;
      el.onclick = () => openItem(it.id);
      frag.appendChild(el);
    }
  }
  // 还没摆的礼物盒
  const boxed = S.items.filter((x) => !x.spot);
  if (boxed.length) {
    const b = L.box; const el = document.createElement('div');
    el.className = 'thing pulse';
    Object.assign(el.style, { left: b.x + '%', bottom: (100 - b.b) + '%', width: b.w + '%', height: b.w + '%', zIndex: 970 });
    el.innerHTML = '<img src="' + BOX + '" alt="礼物盒">' + (boxed.length > 1 ? '<span class="badge">' + boxed.length + '</span>' : '');
    el.onclick = () => (boxed.length === 1 ? openItem(boxed[0].id) : openBoxes(boxed));
    frag.appendChild(el);
  }
  // 角色
  {
    const p = L.character[pose] || L.character.default || { x: 50, b: 88, h: 28 };
    const el = document.createElement('div');
    el.className = 'her ' + (pose === 'sleep' ? 'sleep' : pose === 'play' ? 'play' : 'bob');
    Object.assign(el.style, { left: p.x + '%', bottom: (100 - p.b) + '%', height: p.h + '%', zIndex: Math.round(p.b * 10) + 1 });
    el.innerHTML = '<img alt="">'; el.firstChild.src = '/character/' + pose + '.png'; el.firstChild.alt = NAME;
    el.onclick = tapHer;
    frag.appendChild(el);
    if (pose === 'sleep') {
      const z = document.createElement('div'); z.className = 'zz'; z.textContent = 'z z';
      Object.assign(z.style, { left: (p.x + 5) + '%', bottom: (100 - p.b + p.h - 2) + '%' }); frag.appendChild(z);
    }
    if (ch.say && ch.say !== lastSay) { lastSay = ch.say; sayUntil = Date.now() + 12000; store.set('giftRoomSay', ch.say); setTimeout(() => S && render(S), 12500); }
    const line = tapPose ? (pose === 'sleep' ? tapLine() : ch.say || tapLine()) : Date.now() < sayUntil && pose !== 'sleep' ? ch.say : '';
    if (line) {
      const b = document.createElement('div'); b.className = 'bubble'; b.textContent = line;
      Object.assign(b.style, { left: Math.min(Math.max(p.x, 22), 78) + '%', bottom: (100 - p.b + p.h + 1.5) + '%' }); frag.appendChild(b);
    }
  }
  $('#layer').replaceChildren(frag);
  lighting(theme);
  renderMine(); renderWants();
  if (firstVisit && !seen.size) markSeen(S.items.map((x) => x.id));
}
function markSeen(ids) { for (const i of ids) seen.add(i); store.set('giftRoomSeen', JSON.stringify([...seen])); }
function tapLine() { return S.character.pose === 'sleep' ? '……唔，睡着呢' : '嗨！'; }
function tapHer() {
  tapPose = S.character.pose === 'sleep' ? 'sleep' : 'wave';
  clearTimeout(tapTimer); tapTimer = setTimeout(() => { tapPose = null; render(S); }, 3500);
  render(S);
}
const placeLabel = (it) => {
  if (!it.spot) return '还在礼物盒里';
  if (it.spot === 'stored') return '收在箱子里';
  return S.layout.spots[it.spot]?.label || '';
};

async function renderMine() {
  const box = $('#mine');
  if (!S.items.length) { box.innerHTML = '<div class="empty" style="grid-column:1/-1">还没送过' + esc(NAME) + '东西。去“愿望单”挑一件，或者在“送点别的”里自己写一件。</div>'; return; }
  const items = [...S.items].reverse();
  const srcs = await Promise.all(items.map(iconSrc));
  box.innerHTML = items.map((it, i) => '<div class="card" data-id="' + esc(it.id) + '"><div class="ic"><img src="' + esc(srcs[i]) + '" alt=""></div><div class="nm">' + esc(it.name) + '</div><div class="sub">' + esc(placeLabel(it)) + '</div></div>').join('');
  box.querySelectorAll('.card').forEach((c) => (c.onclick = () => openItem(c.dataset.id)));
}

function renderWants() {
  const box = $('#wants');
  if (!S.wants.length) { box.innerHTML = '<div class="empty">愿望单是空的。上面可以手动记，也可以让你自己的 AI 通过接口往里加。</div>'; return; }
  box.innerHTML = S.wants.map((w) => '<div class="want"><div class="t"><div>' + esc(w.title) + '</div><span>' + (w.price ? '¥' + esc(w.price) : '') + '</span></div>'
    + (w.why ? '<div class="why">' + esc(w.why) + '</div>' : '')
    + '<div class="meta"><div>' + esc(fmt(w.at, false)) + (w.by === 'ai' ? ' · ' + esc(NAME) + '自己记的' : '') + (w.link ? ' · <a href="' + esc(w.link) + '" target="_blank" rel="noopener noreferrer">看看</a>' : '') + '</div>'
    + '<div class="acts">' + (w.given ? '<span class="tag">已经送了</span>' : '<button class="btn ghost small" data-del="' + esc(w.id) + '">删掉</button><button class="btn small" data-w="' + esc(w.id) + '">送给' + esc(NAME) + '</button>') + '</div></div></div>').join('');
  box.querySelectorAll('button[data-w]').forEach((b) => (b.onclick = () => { const w = S.wants.find((x) => x.id === b.dataset.w); openGift({ want: w.id }, w.title); }));
  box.querySelectorAll('button[data-del]').forEach((b) => (b.onclick = async () => {
    const w = S.wants.find((x) => x.id === b.dataset.del); if (!w || !confirm('从愿望单里删掉「' + w.title + '」？')) return;
    const r = await api('/api/wants/' + encodeURIComponent(w.id), { method: 'DELETE' }); toast(r.ok ? '删掉了' : '没删成'); refresh();
  }));
}
$('#wGo').onclick = async () => {
  const title = $('#wTitle').value.trim(); if (!title) return toast('写一下想要什么');
  try {
    const r = await postJson('/api/wants', { title, why: $('#wWhy').value.trim(), link: $('#wLink').value.trim() }); const j = await r.json();
    if (j.ok) { $('#wTitle').value = $('#wWhy').value = $('#wLink').value = ''; $('#addWant').open = false; toast('记下了'); refresh(); } else toast(j.reason || '没记上');
  } catch { toast('没连上'); }
};

// ---------------------------------------------------------------- 弹层
function openSheet(html) { $('#sheetBody').innerHTML = html; $('#sheet').classList.add('on'); $('#sheetBg').classList.add('on'); }
function closeSheet() { $('#sheet').classList.remove('on'); $('#sheetBg').classList.remove('on'); }
$('#sheetBg').onclick = closeSheet;

async function openItem(id) {
  const it = S.items.find((x) => x.id === id); if (!it) return;
  markSeen([id]);
  const src = await iconSrc(it);
  const real = it.kind === 'shipping' ? '实物在路上' : it.kind === 'arrived' ? '实物在你那儿' : '送进屋里的';
  let h = '<div class="detail-top"><div class="big"><img src="' + esc(src) + '" alt=""></div><div><h2>' + esc(it.name) + '</h2>'
    + '<div class="kv">你 ' + esc(fmt(it.at)) + ' 送的</div><div class="kv">' + esc(real) + ' · ' + esc(placeLabel(it)) + '</div>'
    + (it.useCount ? '<div class="kv">' + esc(NAME) + '用过 ' + it.useCount + ' 次</div>' : '') + '</div></div>';
  if (it.note) h += '<div class="quote his"><small>你送的时候说</small>' + esc(it.note) + '</div>';
  if (it.feel) h += '<div class="quote"><small>' + esc(NAME) + '收到时</small>' + esc(it.feel) + '</div>';
  if (it.why) h += '<div class="quote"><small>' + esc(NAME) + '想要它的时候说</small>' + esc(it.why) + '</div>';
  if (it.uses.length) h += '<div class="kv" style="margin-top:12px">' + esc(NAME) + '拿它做过</div><ul class="uses">' + it.uses.map((u) => '<li><small>' + esc(fmt(u.at)) + '</small>' + esc(u.what) + '</li>').join('') + '</ul>';
  if (typeof it.icon !== 'number') h += '<div class="kv" style="margin-top:10px">' + (it.icon === 'pending' ? '图标正在画，一会儿再看。' : it.icon === 'none' ? '没有配置生图，可以自己传一张图标。' : '图标没画出来，可以重画或者自己传一张。') + '</div>';
  // 摆到哪
  const opts = ['<option value="">摆到……</option>'];
  for (const [k, v] of Object.entries(S.layout.spots)) {
    const n = S.items.filter((x) => x.spot === k && x.id !== it.id).length;
    if (n < v.cap) opts.push('<option value="' + esc(k) + '">' + esc(v.label) + '</option>');
  }
  opts.push('<option value="stored">收进箱子</option>');
  h += '<label class="f">摆放位置</label><select id="placeSel">' + opts.join('') + '</select>';
  h += '<div class="row">';
  if (it.kind === 'shipping') h += '<button class="btn" id="arrBtn">快递到了</button><button class="btn ghost" id="arrPhotoBtn">到了，拍给' + esc(NAME) + '看</button><input type="file" id="arrPhoto" accept="image/*" hidden>';
  if (it.hasRealPhoto) h += '<button class="btn ghost" id="seePhoto">看实物照片</button>';
  h += '<button class="btn ghost" id="upIconBtn">换图标</button><input type="file" id="upIcon" accept="image/png,image/jpeg,image/webp" hidden>';
  if (S.iconProvider !== 'none' && it.icon !== 'pending') h += '<button class="btn ghost" id="redrawBtn">重画</button>';
  h += '<button class="btn ghost" id="closeBtn">好</button></div><div id="realPhotoBox"></div>';
  openSheet(h);
  $('#closeBtn').onclick = closeSheet;
  $('#placeSel').onchange = async (e) => {
    const spot = e.target.value; if (!spot) return;
    const j = await (await postJson('/api/items/' + it.id + '/place', { spot })).json();
    toast(j.ok ? '摆好了' : j.reason || '没摆上'); if (j.ok) { closeSheet(); refresh(); }
  };
  if ($('#arrBtn')) $('#arrBtn').onclick = () => arrived(it.id, null);
  if ($('#arrPhotoBtn')) { $('#arrPhotoBtn').onclick = () => $('#arrPhoto').click(); $('#arrPhoto').onchange = async (e) => { const f = e.target.files[0]; if (!f) return; const ph = await uploadPhoto(f); if (ph) arrived(it.id, ph); }; }
  if ($('#seePhoto')) $('#seePhoto').onclick = async () => { const r = await api('/api/items/' + it.id + '/photo'); if (r.ok) { const im = document.createElement('img'); im.style.cssText = 'width:100%;border-radius:12px;margin-top:12px'; im.src = URL.createObjectURL(await r.blob()); $('#realPhotoBox').replaceChildren(im); } };
  $('#upIconBtn').onclick = () => $('#upIcon').click();
  $('#upIcon').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const r = await api('/api/items/' + it.id + '/icon', { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: await shrink(f, 1024, 'image/png') });
    const j = await r.json(); toast(j.ok ? '图标换好了' : j.reason || '没换成'); if (j.ok) { closeSheet(); refresh(); }
  };
  if ($('#redrawBtn')) $('#redrawBtn').onclick = async () => { const j = await (await postJson('/api/items/' + it.id + '/redraw', {})).json(); toast(j.ok ? '在重画了，一会儿再看' : j.reason || '没成功'); closeSheet(); refresh(); };
  render(S);
}
function openBoxes(list) {
  openSheet('<h2 style="margin:4px 0 10px;font-size:18px">礼物盒</h2><div class="kv" style="margin-bottom:10px">' + esc(NAME) + '还没摆好的</div><div class="grid">'
    + list.map((it) => '<div class="card" data-id="' + esc(it.id) + '"><div class="ic"><img src="' + BOX + '" alt=""></div><div class="nm">' + esc(it.name) + '</div></div>').join('') + '</div>');
  document.querySelectorAll('#sheetBody .card').forEach((c) => (c.onclick = () => openItem(c.dataset.id)));
}
async function arrived(id, photo) {
  try {
    const r = await postJson('/api/items/' + id + '/arrived', { photo }); const j = await r.json();
    if (j.ok) { toast(photo ? '告诉' + NAME + '了，照片也给她看了' : '告诉' + NAME + '快递到了'); closeSheet(); refresh(); } else toast(j.reason || '没成功');
  } catch { toast('没连上'); }
}
async function shrink(file, max = 1600, type = 'image/jpeg') {
  const bmp = await createImageBitmap(file).catch(() => null); if (!bmp) return file;
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return await new Promise((res) => c.toBlob((b) => res(b || file), type, 0.86));
}
async function uploadPhoto(file) {
  toast('照片上传中…', 6000);
  try {
    const r = await api('/api/photos', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: await shrink(file) });
    const j = await r.json(); if (!j.ok) { toast(j.reason || '照片没传上'); return null; }
    return j.photo;
  } catch { toast('照片没传上'); return null; }
}

function openGift(g, title) {
  const h = '<h2 style="margin:4px 0 2px;font-size:18px">送' + esc(NAME) + '「' + esc(title || g.name) + '」</h2>'
    + '<label class="f">想说的话（会写在礼物上，可不填）</label><textarea id="gNote" maxlength="200"></textarea>'
    + '<label class="f">怎么送</label><div class="kinds">'
    + '<label><input type="radio" name="gk" value="virtual" checked><div>送进小屋<small>没有实物，就是送给' + esc(NAME) + '的</small></div></label>'
    + '<label><input type="radio" name="gk" value="shipping"><div>真买了，还在路上<small>到了以后点“快递到了”</small></div></label>'
    + '<label><input type="radio" name="gk" value="arrived"><div>真买了，已经到了<small>实物在你那儿</small></div></label></div>'
    + '<div class="row"><button class="btn" id="gGo">送出去</button><button class="btn ghost" id="gNo">再想想</button></div>';
  openSheet(h);
  $('#gNo').onclick = closeSheet;
  $('#gGo').onclick = async () => {
    $('#gGo').disabled = true;
    try {
      const r = await postJson('/api/gifts', { ...g, note: $('#gNote').value.trim(), kind: document.querySelector('input[name=gk]:checked').value });
      const j = await r.json();
      if (j.ok) { closeSheet(); toast(S.iconProvider === 'none' ? '送出去了' : '送出去了，图标画好就会出现在屋里', 3600); markSeen([j.id]); oReset(); switchTab('mine'); refresh(); }
      else { toast(j.reason || '没送出去'); $('#gGo').disabled = false; }
    } catch { toast('没连上'); $('#gGo').disabled = false; }
  };
}

let oPhoto = null;
$('#oPhotoBtn').onclick = () => $('#oPhoto').click();
$('#oPhoto').onchange = async (e) => { const f = e.target.files[0]; if (!f) return; const ph = await uploadPhoto(f); if (ph) { oPhoto = ph; const p = $('#oPhotoPrev'); p.src = URL.createObjectURL(f); p.hidden = false; toast('照片好了'); } };
$('#oNext').onclick = () => { const name = $('#oName').value.trim(); if (!name) return toast('写一下送什么'); openGift({ name, desc: $('#oDesc').value.trim(), photo: oPhoto || undefined }); };
function oReset() { $('#oName').value = ''; $('#oDesc').value = ''; oPhoto = null; $('#oPhotoPrev').hidden = true; }

function switchTab(p) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.p === p));
  document.querySelectorAll('.panel').forEach((x) => x.classList.toggle('on', x.id === 'p-' + p));
  store.set('giftRoomTab', p);
}
document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => switchTab(b.dataset.p)));
{ const t = store.get('giftRoomTab'); if (t) switchTab(t); }

let busy = false;
async function refresh() {
  if (busy) return; busy = true;
  try { const r = await api('/api/state'); if (r.ok) await render(await r.json()); }
  catch (e) { if (String(e.message) !== 'key') $('#status').textContent = '连不上服务'; }
  finally { busy = false; }
}
if (!key) $('#keybox').classList.add('on'); else refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 15000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
