import { appendFileSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { clean, norm, readJson, writeJsonAtomic, localParts, imageType } from './util.mjs';

export const KINDS = ['virtual', 'shipping', 'arrived']; // 只送进屋里 / 真买了在路上 / 真买了已经到了
export const SIZES = ['s', 'm', 'l'];
const PHOTO_MAX = 12 * 1024 * 1024;
const USES_PER_DAY = 30;

/** 按名字猜大小：大件放地上，小件放架子格子。猜错了可以改。 */
export function guessSize(text) {
  const t = String(text ?? '');
  const tiny = /迷你|小(?!时)|mini/i.test(t); // 带“小”“迷你”的降一档
  if (/树|盆栽|桌|柜|椅|沙发|屏风|琴|落地|自行车|帐篷|立牌|抱枕|玩偶|公仔|鱼缸|冲浪板|滑板/.test(t)) return tiny ? 'm' : 'l';
  if (/笔|尺|挂件|徽章|吧唧|钥匙|戒指|发夹|贴纸|印章|书签|硬币|U盘|耳机|贝壳|海螺|糖|橡皮/.test(t)) return 's';
  return tiny ? 's' : 'm';
}

/**
 * 小屋的全部数据：礼物、愿望单、角色状态、流水日志、图标和照片。
 * 都是 dataDir 下的普通文件，删掉 dataDir 就是一间空屋子。
 */
export class RoomStore {
  constructor({ dataDir, spots = {}, now = () => Date.now(), utcOffset = 8 }) {
    this.dataDir = dataDir; this.spots = spots; this.now = now; this.utcOffset = utcOffset;
    this.itemsFile = join(dataDir, 'items.json');
    this.wantsFile = join(dataDir, 'wants.json');
    this.charFile = join(dataDir, 'character.json');
    this.logFile = join(dataDir, 'log.jsonl');
    this.iconDir = join(dataDir, 'icons');
    this.photoDir = join(dataDir, 'photos');
    this.lastGiftAt = 0;
  }

  iso() { return new Date(this.now()).toISOString(); }

  // ------------------------------------------------------------ 读写
  load() { const d = readJson(this.itemsFile, null); return d && Array.isArray(d.items) ? d : { version: 1, next: 1, items: [] }; }
  save(d) { writeJsonAtomic(this.itemsFile, d); }
  items() { return this.load().items; }
  get(ref) {
    const r = String(ref ?? '').trim(); const items = this.items();
    return items.find((x) => x.id === r) ?? items.find((x) => norm(x.name) === norm(r) && norm(r)) ?? null;
  }
  update(id, fn) {
    const d = this.load(); const it = d.items.find((x) => x.id === id);
    if (!it) return null; fn(it); this.save(d); return it;
  }
  log(row) {
    try { mkdirSync(this.dataDir, { recursive: true }); appendFileSync(this.logFile, JSON.stringify({ at: this.iso(), ...row }) + '\n', 'utf8'); } catch { /* 日志写不了不影响功能 */ }
  }
  logRows(since = 0) {
    try {
      return readFileSync(this.logFile, 'utf8').split(/\r?\n/).filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((r) => r && Date.parse(r.at) > since);
    } catch { return []; }
  }

  // ------------------------------------------------------------ 愿望单
  wantsData() { const d = readJson(this.wantsFile, null); return d && Array.isArray(d.wants) ? d : { next: 1, wants: [] }; }
  wants() {
    const given = new Set(this.items().map((x) => x.wantId).filter(Boolean));
    return this.wantsData().wants.map((w) => ({ ...w, given: given.has(w.id) })).reverse();
  }
  /** 加一件想要的东西。by：谁记的（"user" 页面上手填，"ai" 你自己的 AI 通过接口加）。 */
  addWant({ title, why, link, price, by = 'user' } = {}) {
    const t = clean(title, 80);
    if (!t) return { ok: false, reason: '要写想要什么。' };
    const lk = clean(link, 500);
    if (lk && !/^https?:\/\//i.test(lk)) return { ok: false, reason: '链接要以 http:// 或 https:// 开头。' };
    const d = this.wantsData();
    if (d.wants.some((w) => (norm(t) ? norm(w.title) === norm(t) : w.title === t))) return { ok: false, reason: '愿望单里已经有这件了。' };
    const w = { id: 'w' + d.next, title: t, why: clean(why, 200), link: lk, price: clean(price, 16), by: by === 'ai' ? 'ai' : 'user', at: this.iso() };
    d.next += 1; d.wants.push(w); writeJsonAtomic(this.wantsFile, d);
    this.log({ kind: 'want', id: w.id, title: t, by: w.by });
    return { ok: true, want: w };
  }
  removeWant(id) {
    const d = this.wantsData(); const n = d.wants.length;
    d.wants = d.wants.filter((w) => w.id !== id);
    if (d.wants.length === n) return { ok: false, reason: '愿望单里没有这件。' };
    writeJsonAtomic(this.wantsFile, d); this.log({ kind: 'want-remove', id });
    return { ok: true };
  }

  // ------------------------------------------------------------ 送礼
  gift({ want, name, desc, note, kind = 'virtual', photo } = {}) {
    if (!KINDS.includes(kind)) return { ok: false, reason: 'kind 只能是 virtual、shipping、arrived。' };
    let w = null;
    if (want) { w = this.wantsData().wants.find((x) => x.id === want) ?? null; if (!w) return { ok: false, reason: '愿望单里没有这件。' }; }
    const nm = clean(name, 20) || (w ? shortName(w.title) : '');
    if (!nm) return { ok: false, reason: '要有个名字。' };
    const d = this.load();
    if (w && d.items.some((x) => x.wantId === w.id)) return { ok: false, reason: '这件已经送过了。' };
    // 名字全是表情或符号时 norm 会变成空串，这时按原文比，免得不同的两件被当成同名
    const same = (a) => (norm(a) && norm(nm) ? norm(a) === norm(nm) : a === nm);
    if (d.items.some((x) => this.now() - Date.parse(x.at) < 60_000 && same(x.name))) return { ok: false, reason: '刚送过同名的一件。' };
    const ph = photo ? this.photoName(photo) : null;
    const id = 'g' + d.next; d.next += 1;
    const item = {
      id, name: nm, desc: clean(desc, 200) || (w ? w.title : ''), note: clean(note, 200), kind, at: this.iso(),
      ...(kind === 'arrived' ? { arrivedAt: this.iso() } : {}),
      ...(w ? { wantId: w.id, wantTitle: w.title, why: w.why, price: w.price } : {}),
      photo: ph, icon: { status: 'pending', tries: 0 }, spot: null, feel: '', uses: [],
      size: guessSize(nm + ' ' + (desc ?? '') + ' ' + (w?.title ?? '')),
    };
    d.items.push(item); this.save(d);
    this.lastGiftAt = this.now();
    this.log({ kind: 'gift', id, name: nm, giftKind: kind, want: w?.id ?? null, photo: !!ph });
    return { ok: true, item };
  }

  arrived(id, photo) {
    const ph = photo ? this.photoName(photo) : null;
    const before = this.get(id);
    if (!before) return { ok: false, reason: '没有这件。' };
    const it = this.update(before.id, (x) => {
      if (x.kind === 'shipping') { x.kind = 'arrived'; x.arrivedAt = this.iso(); }
      if (ph) x.realPhoto = ph;
    });
    this.log({ kind: 'arrived', id: it.id, photo: !!ph });
    // 原来的图标不是照着照片画的，有了实物照片就照实物重画
    const redraw = !!ph && !before.photo;
    if (redraw) this.update(it.id, (x) => { x.photo = ph; x.icon = { status: 'pending', tries: 0, redo: true }; });
    return { ok: true, item: this.get(it.id), redraw };
  }

  savePhoto(buf) {
    if (!buf?.length || buf.length > PHOTO_MAX) return { ok: false, reason: '照片是空的或超过 12MB。' };
    const ext = imageType(buf);
    if (!ext) return { ok: false, reason: '只收 jpg、png、webp。' };
    mkdirSync(this.photoDir, { recursive: true });
    const name = `p${this.now()}-${randomUUID().slice(0, 6)}.${ext}`;
    writeFileSync(join(this.photoDir, name), buf);
    return { ok: true, photo: name };
  }
  photoName(name) { const n = String(name ?? '').replace(/[^\w.-]/g, ''); return n && existsSync(join(this.photoDir, n)) ? n : null; }
  photoPath(name) { const n = this.photoName(name); return n ? join(this.photoDir, n) : null; }

  // ------------------------------------------------------------ 摆放、改名、使用
  spotOf(spotId) { return spotId === 'stored' ? { label: '收进箱子', stored: true, cap: Infinity } : this.spots[spotId] ?? null; }
  countAt(items, spotId, exceptId) { return items.filter((x) => x.spot === spotId && x.id !== exceptId).length; }
  freeSpots(items = this.items()) {
    return Object.entries(this.spots).filter(([k, v]) => this.countAt(items, k) < v.cap).map(([k, v]) => ({ spot: k, label: v.label, h: v.h }));
  }

  /** 摆到屋里某个位置。spot 填 "stored" 是收进箱子（不摆出来）。feel 只记第一次摆的时候说的。 */
  place(ref, spotId, { feel, name, size } = {}) {
    const it = this.get(ref);
    if (!it) return { ok: false, reason: '没有这件东西。' };
    const stored = spotId === 'stored';
    const sp = this.spotOf(spotId);
    if (!sp) return { ok: false, reason: `没有这个位置。能用的：${Object.keys(this.spots).join('、')}、stored。` };
    if (!stored && this.countAt(this.items(), spotId, it.id) >= sp.cap) return { ok: false, reason: `${sp.label}已经放满了。` };
    const first = !it.spot;
    this.update(it.id, (x) => {
      delete x.scene; x.spot = spotId; x.placedAt = this.iso();
      if (feel && (!x.feel || first)) x.feel = clean(feel, 120);
      if (clean(name, 20)) x.name = clean(name, 20);
      if (SIZES.includes(size)) x.size = size;
    });
    this.log({ kind: 'place', id: it.id, spot: spotId, first });
    return { ok: true, item: this.get(it.id) };
  }

  /** 改名字、心里话、大小。 */
  edit(ref, { name, feel, size } = {}) {
    const it = this.get(ref); if (!it) return { ok: false, reason: '没有这件东西。' };
    if (size !== undefined && !SIZES.includes(size)) return { ok: false, reason: 'size 只能是 s、m、l。' };
    this.update(it.id, (x) => {
      if (clean(name, 20)) x.name = clean(name, 20);
      if (feel !== undefined) x.feel = clean(feel, 120);
      if (size) x.size = size;
    });
    this.log({ kind: 'edit', id: it.id });
    return { ok: true, item: this.get(it.id) };
  }

  use(ref, what) {
    const it = this.get(ref); if (!it) return { ok: false, reason: '没有这件东西。' };
    const w = clean(what, 120); if (w.length < 2) return { ok: false, reason: '写一句拿它干了什么。' };
    const today = localParts(this.now(), this.utcOffset).day;
    const n = this.logRows(this.now() - 86_400_000).filter((r) => r.kind === 'use' && localParts(Date.parse(r.at), this.utcOffset).day === today).length;
    if (n >= USES_PER_DAY) return { ok: false, reason: '今天记得够多了，明天再记。' };
    const at = this.iso();
    this.update(it.id, (x) => { x.uses = [...(x.uses ?? []), { at, what: w }].slice(-60); x.lastUsedAt = at; });
    this.log({ kind: 'use', id: it.id, what: w });
    return { ok: true, item: this.get(it.id) };
  }

  /** 自动摆：找一个放得下这件的空位（大件优先地上，小件优先架子），都满了就收进箱子。 */
  autoPlace(ref) {
    const it = this.get(ref); if (!it || it.spot) return { ok: false, reason: '已经摆过了或没有这件。' };
    const need = { s: 4, m: 8, l: 15 }[it.size] ?? 8;
    const free = this.freeSpots().sort((a, b) => Math.abs(a.h - need * 1.3) - Math.abs(b.h - need * 1.3));
    const fit = free.find((f) => f.h >= need * 0.7) ?? free[0];
    return this.place(it.id, fit ? fit.spot : 'stored');
  }

  // ------------------------------------------------------------ 图标
  iconPath(id) { const it = this.get(id); return it?.icon?.status === 'ok' ? join(this.iconDir, it.icon.file) : null; }
  setIcon(id, buf, source = 'gen') {
    const ext = imageType(buf); if (!ext) return { ok: false, reason: '图标只收 png、jpg、webp。' };
    if (buf.length > PHOTO_MAX) return { ok: false, reason: '图标太大。' };
    mkdirSync(this.iconDir, { recursive: true });
    const file = `${id}-${this.now()}.${ext}`;
    writeFileSync(join(this.iconDir, file), buf);
    const it = this.update(id, (x) => { x.icon = { status: 'ok', file, source, v: this.now(), tries: x.icon?.tries ?? 0 }; });
    if (!it) return { ok: false, reason: '没有这件东西。' };
    this.log({ kind: 'icon', id, ok: true, source });
    return { ok: true, item: it };
  }

  // ------------------------------------------------------------ 角色状态（外部 AI 可以写）
  character() { return readJson(this.charFile, {}); }
  setCharacter(patch) { const c = { ...this.character(), ...patch }; writeJsonAtomic(this.charFile, c); return c; }
}

/** 愿望单标题太长时取个短名：去掉括号里的东西，取第一段前 14 个字。 */
export function shortName(title) {
  let t = String(title ?? '').replace(/【[^】]*】|\[[^\]]*\]|（[^）]*）|\([^)]*\)/g, ' ').trim();
  t = t.split(/\s+/)[0] || t;
  return clean(t, 14);
}
