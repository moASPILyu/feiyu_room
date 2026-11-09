import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';
import { Room } from '../server/room.mjs';
import { createApp } from '../server/http.mjs';
import { generateIcon, iconPrompt } from '../server/images.mjs';
import { characterState, POSES } from '../server/pose.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const PNG = readFileSync(join(PUBLIC, 'character', 'box.png'));
const tmp = () => mkdtempSync(join(tmpdir(), 'gift-room-test-'));

function makeRoom(over = {}, opts = {}) {
  const dir = tmp();
  let t = Date.parse('2026-11-09T04:00:00Z'); // 本地 12 点
  const cfg = { dataDir: dir, utcOffset: 8, autoPlaceMinutes: -1, character: { name: '测试鱼', sleep: [23, 7] }, image: { provider: 'none' }, webhook: {}, ...over };
  const room = new Room(cfg, { publicDir: PUBLIC, now: () => t, iconMaker: async () => PNG, ...opts });
  return { room, dir, tick: (ms) => { t += ms; }, at: (iso) => { t = Date.parse(iso); } };
}
const idle = (room) => new Promise((r) => { const i = setInterval(() => { if (!room.busy && !room.queue.length) { clearInterval(i); r(); } }, 5); });

test('一间屋子三种风格，位置坐标合法，姿势都有图', () => {
  const { room } = makeRoom();
  assert.deepEqual(room.themes.map((t) => t.id), ['warm', 'nordic', 'cyber']);
  assert.equal(room.themes.find((t) => t.id === 'cyber').tint, 'none', '夜景风格不再调光线');
  for (const t of room.themes) assert.ok(existsSync(join(PUBLIC, 'themes', t.id, 'bg.jpg')), t.id);
  for (const [k, v] of Object.entries(room.layout.spots)) {
    assert.ok(v.label && v.x0 < v.x1 && v.b > 0 && v.b <= 100 && v.h > 0 && v.cap >= 1, k);
  }
  assert.ok(room.layout.character.default);
  for (const p of POSES) assert.ok(existsSync(join(PUBLIC, 'character', p + '.png')), p);
  assert.equal(room.defaultTheme(), 'warm');
  assert.equal(makeRoom({ theme: 'cyber' }).room.defaultTheme(), 'cyber');
  assert.equal(makeRoom({ theme: 'moon' }).room.defaultTheme(), 'warm', '配错了用第一个');
});

test('愿望单：加、去重、链接校验、删', () => {
  const { room } = makeRoom();
  assert.equal(room.store.addWant({ title: '小鱼缸', why: '想养两条小鱼' }).ok, true);
  assert.equal(room.store.addWant({ title: '小 鱼缸' }).ok, false);
  assert.equal(room.store.addWant({ title: '灯', link: 'javascript:alert(1)' }).ok, false);
  const w = room.store.addWant({ title: '台灯', link: 'https://example.com/x', by: 'ai' }).want;
  assert.equal(w.by, 'ai');
  assert.equal(room.store.wants()[0].title, '台灯', '新的在前');
  assert.equal(room.store.removeWant(w.id).ok, true);
  assert.equal(room.store.removeWant(w.id).ok, false);
});

test('送礼 → 画图标 → 发 gift 事件（带签名）', async () => {
  const calls = [];
  const fetchImpl = async (url, o) => { calls.push({ url, o }); return new Response('ok'); };
  const { room } = makeRoom({ webhook: { url: 'http://ai.local/hook', secret: 's3' } }, { fetchImpl });
  const w = room.store.addWant({ title: '【包邮】可爱小鱼缸 桌面迷你', why: '想养鱼' }).want;
  const r = room.gift({ want: w.id, note: '给你', kind: 'shipping' });
  assert.equal(r.ok, true); assert.equal(r.item.name, '可爱小鱼缸'); assert.equal(r.item.size, 'm', '带“小”降一档');
  assert.equal(room.gift({ want: w.id }).ok, false, '同一件不能送两次');
  assert.equal(room.gift({ name: '可爱小鱼缸' }).ok, false, '一分钟内同名');
  assert.equal(room.gift({ name: '🐟' }).ok, true);
  assert.equal(room.gift({ name: '🌟' }).ok, true, '全是表情的两个名字不算同名');
  assert.equal(room.gift({ name: '🌟' }).ok, false);
  await idle(room); await new Promise((r) => setTimeout(r, 20));
  assert.equal(room.store.get(r.item.id).icon.status, 'ok');
  const hook = calls.find((c) => c.o.headers['x-gift-room-event'] === 'gift');
  assert.ok(hook, '发了 gift 事件');
  const sig = 'sha256=' + createHmac('sha256', 's3').update(hook.o.body).digest('hex');
  assert.equal(hook.o.headers['x-gift-room-signature'], sig);
  const body = JSON.parse(hook.o.body);
  assert.equal(body.item.id, r.item.id); assert.ok(body.room.free.length > 0); assert.equal(body.room.character.name, '测试鱼');
});

test('没配生图：图标标成 none，也照样发事件', async () => {
  const { room } = makeRoom({}, { iconMaker: (item) => generateIcon(item, { image: { provider: 'none' } }) });
  const r = room.gift({ name: '贝壳' });
  await idle(room);
  assert.equal(room.store.get(r.item.id).icon.status, 'none');
});

test('摆放：容量、无效位置、收进箱子、心里话只记第一次、自动摆', () => {
  const { room } = makeRoom();
  const a = room.gift({ name: '贝壳' }).item;
  assert.equal(room.store.place(a.id, 'floorBack', { feel: '好看', size: 's' }).ok, true);
  assert.equal(room.store.place(a.id, 'floorBack', { feel: '第二次' }).ok, true);
  assert.equal(room.store.get(a.id).feel, '好看');
  const b = room.gift({ name: '海螺' }).item;
  assert.equal(room.store.place(b.id, 'floorBack').ok, false, 'floorBack 只能放一件');
  assert.equal(room.store.place(b.id, 'nope').ok, false);
  assert.equal(room.store.place(b.id, 'stored').ok, true);
  const c = room.gift({ name: '大抱枕玩偶' }).item;
  const ap = room.store.autoPlace(c.id);
  assert.equal(ap.ok, true);
  assert.ok(ap.item.spot.startsWith('floor'), '大件自动摆到地上：' + ap.item.spot);
  const d = room.gift({ name: '徽章' }).item;
  assert.ok(!room.store.autoPlace(d.id).item.spot.startsWith('floor'), '小件不摆地上');
  // 地上全占满以后，大件收进箱子之外的地方也能放，满了就收起来
  for (let i = 0; i < 40; i++) { const x = room.gift({ name: '大树' + i }).item; room.store.autoPlace(x.id); }
  assert.equal(room.store.get('大树39').spot, 'stored');
});

test('使用记录和每日上限', () => {
  const { room } = makeRoom();
  const a = room.gift({ name: '画笔' }).item;
  assert.equal(room.store.use(a.id, 'x').ok, false);
  let n = 0; while (room.store.use(a.id, '画了一张画' + n).ok) n++;
  assert.equal(n, 30);
});

test('快递到了：有照片就照实物重画，不再重复发 gift 事件', async () => {
  const events = [];
  const { room } = makeRoom({ webhook: { url: 'http://ai.local/hook' } }, { fetchImpl: async (u, o) => { events.push(o.headers['x-gift-room-event']); return new Response('ok'); } });
  const it = room.gift({ name: '保温杯', kind: 'shipping' }).item;
  await idle(room);
  const ph = room.store.savePhoto(PNG); assert.equal(ph.ok, true);
  assert.equal(room.store.savePhoto(Buffer.from('not an image at all')).ok, false);
  const r = room.arrived(it.id, ph.photo);
  assert.equal(r.ok, true); assert.equal(r.redraw, true); assert.equal(room.store.get(it.id).kind, 'arrived');
  await idle(room); await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(events.filter((e) => e === 'gift').length, 1);
  assert.ok(events.includes('arrived'));
});

test('角色：白天按时段、深夜去睡、收礼拆礼物、外部设置优先', () => {
  const { room, at } = makeRoom();
  at('2026-11-09T04:30:00Z'); // 12:30 午饭
  assert.equal(room.character().pose, 'play');
  at('2026-11-09T01:00:00Z'); // 9 点
  assert.ok(['idle', 'think'].includes(room.character().pose));
  at('2026-11-09T18:00:00Z'); // 2 点
  const c = room.character(); assert.equal(c.pose, 'sleep');
  room.gift({ name: '星星灯' });
  assert.equal(room.character().pose, 'gift');
  room.store.setCharacter({ pose: 'play', text: '在吃饭', until: new Date(Date.parse('2026-11-09T19:00:00Z')).toISOString(), say: '嘿嘿', sayAt: new Date(Date.parse('2026-11-09T18:00:00Z')).toISOString() });
  const d = characterState(room.store, room.cfg, room.layout.schedule);
  assert.equal(d.pose, 'play'); assert.equal(d.text, '在吃饭'); assert.equal(d.say, '嘿嘿');
});

test('生图提示词带名字、描述，有照片时让它照着画', () => {
  assert.match(iconPrompt({ name: '杯子', desc: '蓝色马克杯' }), /杯子（蓝色马克杯）/);
  assert.match(iconPrompt({ name: '杯子', photo: 'p.jpg' }), /参考图/);
});

test('command 生图：参数不过 shell，{ref} 没照片时连同选项名一起去掉', async () => {
  const dir = tmp();
  const script = join(dir, 'draw.mjs');
  writeFileSync(script, `import {writeFileSync,readFileSync} from 'node:fs';const a=process.argv.slice(2);writeFileSync(a[a.indexOf('--out')+1],readFileSync(${JSON.stringify(join(PUBLIC, 'character', 'box.png'))}));writeFileSync(${JSON.stringify(join(dir, 'args.json'))},JSON.stringify(a));`);
  const buf = await generateIcon({ name: '杯子"; rm -rf /' }, { image: { provider: 'command', command: { args: [process.execPath, script, '--prompt', '{prompt}', '--out', '{out}', '--ref', '{ref}'] } } });
  assert.ok(buf.length > 100);
  const args = JSON.parse(readFileSync(join(dir, 'args.json'), 'utf8'));
  assert.ok(!args.includes('--ref')); assert.match(args[1], /杯子"; rm -rf \//);
  rmSync(dir, { recursive: true, force: true });
});

test('openai 生图：解析 b64_json 和 url 两种返回', async () => {
  process.env.GR_TEST_KEY = 'k';
  const cfg = { image: { provider: 'openai', openai: { apiKeyEnv: 'GR_TEST_KEY', baseUrl: 'http://img.local/v1' } } };
  const b64 = await generateIcon({ name: '杯子' }, cfg, { fetchImpl: async (u, o) => { assert.equal(o.headers.authorization, 'Bearer k'); return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] })); } });
  assert.equal(b64.length, PNG.length);
  const viaUrl = await generateIcon({ name: '杯子' }, cfg, { fetchImpl: async (u) => (String(u).endsWith('/generations') ? new Response(JSON.stringify({ images: [{ url: 'http://img.local/a.png' }] })) : new Response(PNG)) });
  assert.equal(viaUrl.length, PNG.length);
  await assert.rejects(generateIcon({ name: 'x' }, cfg, { fetchImpl: async () => new Response('{"error":"bad"}', { status: 401 }) }), /401/);
});

test('HTTP：口令、静态文件白名单、各接口', async () => {
  const { room } = makeRoom();
  const server = createApp(room, { publicDir: join(ROOT, 'public'), token: 'tok' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const f = (p, o = {}) => fetch(base + p, { ...o, headers: { 'x-room-key': 'tok', ...(o.headers || {}) } });
  const j = (p, body, method = 'POST') => f(p, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  try {
    const page = await (await fetch(base + '/')).text();
    assert.match(page, /测试鱼的小屋/);
    assert.equal((await fetch(base + '/character/idle.png')).status, 200);
    assert.equal((await fetch(base + '/themes/warm/bg.jpg')).status, 200);
    assert.equal((await fetch(base + '/themes/warm/theme.json')).status, 404, 'json 不直接给');
    assert.equal((await fetch(base + '/room.json')).status, 404);
    assert.equal((await fetch(base + '/../package.json')).status, 404);
    assert.equal((await fetch(base + '/%2e%2e/package.json')).status, 404);
    assert.equal((await fetch(base + '/api/state')).status, 401);
    assert.equal((await fetch(base + '/api/state', { headers: { authorization: 'Bearer tok' } })).status, 200);
    assert.equal((await fetch(base + '/api/state', { headers: { 'x-room-key': 'tox' } })).status, 401);

    const w = await j('/api/wants', { title: '小鱼缸', why: '想养鱼', by: 'ai' });
    assert.equal(w.ok, true);
    const g = await j('/api/gifts', { want: w.want.id, note: '给你' });
    assert.equal(g.ok, true);
    await idle(room);
    assert.equal((await f(`/api/items/${g.id}/icon`)).headers.get('content-type'), 'image/png');
    assert.equal((await j(`/api/items/${g.id}/place`, { spot: 'desk', feel: '好开心' })).ok, true);
    assert.equal((await j(`/api/items/${g.id}`, { name: '鱼缸' }, 'PATCH')).item.name, '鱼缸');
    assert.equal((await j(`/api/items/${g.id}/use`, { what: '往里放了一颗小石子' })).ok, true);
    assert.equal((await j('/api/character', { pose: 'fly' })).ok, false);
    const ch = await j('/api/character', { pose: 'play', say: '谢谢你！', minutes: 5 });
    assert.equal(ch.character.pose, 'play'); assert.equal(ch.character.say, '谢谢你！');
    const up = await (await f(`/api/items/${g.id}/icon`, { method: 'PUT', body: PNG })).json();
    assert.equal(up.ok, true);
    const ph = await (await f('/api/photos', { method: 'POST', body: PNG })).json();
    assert.equal(ph.ok, true);
    const bad = await f('/api/gifts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
    assert.equal(bad.status, 400);
    assert.equal((await f('/api/items/g999/use', { method: 'POST' })).status, 404);
    const st = await (await f('/api/state')).json();
    assert.equal(st.items[0].feel, '好开心'); assert.equal(st.character.name, '测试鱼'); assert.equal(st.wants[0].given, true);
    assert.equal(st.theme, 'warm'); assert.equal(st.themes.length, 3); assert.ok(st.layout.spots.desk);
    assert.equal((await f(`/api/wants/${w.want.id}`, { method: 'DELETE' })).status, 200);
  } finally { await new Promise((r) => server.close(r)); room.close(); }
});
