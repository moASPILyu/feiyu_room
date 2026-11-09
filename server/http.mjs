import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { POSES } from './pose.mjs';
import { clean, imageType, MIME } from './util.mjs';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
const MAX_JSON = 64 * 1024, MAX_BIN = 12 * 1024 * 1024 + 1;

function readBody(req, max) {
  return new Promise((ok, fail) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > max) { fail(Object.assign(new Error('too_large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', fail);
  });
}
async function readJsonBody(req) {
  const raw = (await readBody(req, MAX_JSON)).toString('utf8');
  try { return raw.trim() ? JSON.parse(raw) : {}; } catch { throw Object.assign(new Error('bad_json'), { status: 400 }); }
}
function sameKey(a, b) {
  const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? ''));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/**
 * 网页和接口。网页和美术素材不用口令；/api/ 下的全部接口都要口令：
 *   请求头 x-room-key: <口令>  或  Authorization: Bearer <口令>
 */
export function createApp(room, { publicDir, token }) {
  const pub = resolve(publicDir);

  function send(res, code, body, type, extra = {}) {
    const isBuf = Buffer.isBuffer(body);
    res.writeHead(code, { 'content-type': type ?? (isBuf ? 'application/octet-stream' : 'application/json; charset=utf-8'), 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', ...extra });
    res.end(isBuf ? body : typeof body === 'string' ? body : JSON.stringify(body));
  }
  const reply = (res, r) => send(res, r.ok ? 200 : 400, r);

  function serveStatic(req, res, path) {
    if (path === '/' || path === '/index.html') path = '/index.html';
    if (!/^\/[\w./-]+$/.test(path) || path.includes('..')) return false;
    const f = resolve(pub, '.' + path);
    if (!f.startsWith(pub + sep) || !existsSync(f)) return false;
    const ext = f.slice(f.lastIndexOf('.'));
    if (!TYPES[ext] || ext === '.json') return false; // 布局和风格信息走 /api/state，json 文件不直接给
    let body = readFileSync(f);
    if (path === '/index.html') body = Buffer.from(body.toString('utf8').replaceAll('{{NAME}}', escHtml(room.cfg.character?.name ?? '鲸鱼娘')));
    send(res, 200, body, TYPES[ext], { 'cache-control': ext === '.png' || ext === '.jpg' ? 'max-age=86400' : 'no-cache' });
    return true;
  }

  async function api(req, res, url) {
    const p = url.pathname.slice(5); // 去掉 /api/
    const m = req.method;
    let mm;
    if (m === 'GET' && p === 'state') return send(res, 200, room.state());

    // 愿望单
    if (m === 'GET' && p === 'wants') return send(res, 200, { wants: room.store.wants() });
    if (m === 'POST' && p === 'wants') { const b = await readJsonBody(req); return reply(res, room.store.addWant({ ...b, by: b.by })); }
    if (m === 'DELETE' && (mm = p.match(/^wants\/(w\d+)$/))) return reply(res, room.store.removeWant(mm[1]));

    // 送礼
    if (m === 'POST' && p === 'gifts') {
      const b = await readJsonBody(req);
      const r = room.gift({ want: b.want ? String(b.want) : undefined, name: b.name, desc: b.desc, note: b.note, kind: String(b.kind ?? 'virtual'), photo: b.photo });
      return send(res, r.ok ? 200 : 400, r.ok ? { ok: true, id: r.item.id } : r);
    }
    if (m === 'POST' && p === 'photos') return reply(res, room.store.savePhoto(await readBody(req, MAX_BIN)));

    // 单件东西
    if ((mm = p.match(/^items\/(g\d+)(?:\/([a-z]+))?$/))) {
      const [, id, act] = mm;
      if (!room.store.get(id)) return send(res, 404, { ok: false, reason: '没有这件东西。' });
      if (m === 'GET' && act === 'icon') {
        const f = room.store.iconPath(id);
        if (!f || !existsSync(f)) return send(res, 404, { ok: false, reason: '还没有图标。' });
        const buf = readFileSync(f); return send(res, 200, buf, MIME[imageType(buf)] ?? 'image/png', { 'cache-control': 'private, max-age=31536000, immutable' });
      }
      if (m === 'GET' && act === 'photo') {
        const it = room.store.get(id); const f = room.store.photoPath(it.realPhoto ?? it.photo);
        if (!f) return send(res, 404, { ok: false, reason: '没有照片。' });
        const buf = readFileSync(f); return send(res, 200, buf, MIME[imageType(buf)] ?? 'image/jpeg');
      }
      if (m === 'PUT' && act === 'icon') return reply(res, room.store.setIcon(id, await readBody(req, MAX_BIN), 'upload'));
      if (m === 'POST' && act === 'redraw') return reply(res, room.redraw(id));
      const b = await readJsonBody(req);
      if (m === 'PATCH' && !act) return reply(res, room.store.edit(id, b));
      if (m === 'POST' && act === 'place') return reply(res, room.store.place(id, b.spot, b));
      if (m === 'POST' && act === 'autoplace') return reply(res, room.store.autoPlace(id));
      if (m === 'POST' && act === 'use') return reply(res, room.store.use(id, b.what));
      if (m === 'POST' && act === 'arrived') return reply(res, room.arrived(id, b.photo));
    }

    // 角色状态：你的 AI 让她说句话、换姿势
    if (m === 'POST' && p === 'character') {
      const b = await readJsonBody(req);
      if (b.pose !== undefined && !POSES.includes(b.pose)) return send(res, 400, { ok: false, reason: `pose 只能是 ${POSES.join('、')}。` });
      const patch = {};
      if (b.say !== undefined) { patch.say = clean(b.say, 80); patch.sayAt = new Date(room.now()).toISOString(); }
      if (b.pose || b.text) {
        const min = Math.min(Math.max(Number(b.minutes) || 30, 1), 24 * 60);
        Object.assign(patch, { pose: b.pose ?? 'idle', text: clean(b.text, 40), until: new Date(room.now() + min * 60_000).toISOString() });
      }
      if (b.clear) Object.assign(patch, { until: null, pose: null, text: '' });
      room.store.setCharacter(patch);
      return send(res, 200, { ok: true, character: room.character() });
    }
    return send(res, 404, { ok: false, reason: 'not_found' });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname.startsWith('/api/')) {
        const auth = req.headers['x-room-key'] ?? String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        if (!sameKey(auth, token)) return send(res, 401, { ok: false, reason: '口令不对' });
        return await api(req, res, url);
      }
      if (req.method === 'GET' && serveStatic(req, res, url.pathname)) return;
      send(res, 404, 'not found', 'text/plain; charset=utf-8');
    } catch (e) {
      if (!res.headersSent) send(res, e.status ?? 500, { ok: false, reason: e.status ? e.message : 'server_error' });
      if (!e.status) console.error('[gift-room]', e);
    }
  }

  return createServer(handle);
}

const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
