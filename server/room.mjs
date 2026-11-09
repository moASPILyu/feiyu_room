import { createHmac } from 'node:crypto';
import { RoomStore } from './store.mjs';
import { characterState } from './pose.mjs';
import { generateIcon } from './images.mjs';
import { loadRoom } from './scenes.mjs';

/**
 * 把数据、生图、角色状态、事件通知串起来。
 * 送礼 → 排队画图标 → 画好（或画不出）后发 gift 事件给你的 AI（webhook）→
 * 你的 AI 调接口摆放、写心里话、说一句话；autoPlaceMinutes 分钟内没人摆，就自动找个空位摆上。
 */
export class Room {
  constructor(cfg, { publicDir, now = () => Date.now(), iconMaker, fetchImpl = fetch } = {}) {
    this.cfg = cfg; this.now = now; this.fetchImpl = fetchImpl;
    const { themes, layout } = loadRoom(publicDir);
    this.themes = themes; this.layout = layout;
    this.store = new RoomStore({ dataDir: cfg.dataDir, spots: layout.spots, now, utcOffset: cfg.utcOffset ?? 8 });
    this.iconMaker = iconMaker ?? ((item, photoPath) => generateIcon(item, cfg, { photoPath, fetchImpl }));
    this.queue = []; this.busy = false; this.timers = new Set();
    this.webhookLog = [];
  }

  character() { return characterState(this.store, this.cfg, this.layout.schedule, this.now()); }

  state() {
    const items = this.store.items().map((x) => ({
      id: x.id, name: x.name, desc: x.desc, note: x.note, kind: x.kind, at: x.at, arrivedAt: x.arrivedAt ?? null,
      why: x.why ?? '', price: x.price ?? '', wantTitle: x.wantTitle ?? '', spot: x.spot, feel: x.feel,
      uses: (x.uses ?? []).slice(-8).reverse(), useCount: x.uses?.length ?? 0, size: x.size ?? 'm',
      icon: x.icon?.status === 'ok' ? x.icon.v : x.icon?.status ?? 'pending', hasRealPhoto: !!(x.realPhoto || x.photo),
    }));
    return {
      now: new Date(this.now()).toISOString(), utcOffset: this.cfg.utcOffset ?? 8,
      character: { name: this.cfg.character?.name ?? '鲸鱼娘', ...this.character() },
      themes: this.themes, theme: this.defaultTheme(), layout: this.layout, items, wants: this.store.wants().slice(0, 100),
      iconProvider: this.cfg.image?.provider ?? 'none',
    };
  }

  /** 默认风格：config 里的 theme，没有或不存在就用排第一的。看的人可以在页面上自己换。 */
  defaultTheme() { const t = this.cfg.theme; return this.themes.some((x) => x.id === t) ? t : this.themes[0]?.id ?? null; }

  // ------------------------------------------------------------ 送礼流程
  gift(input) {
    const r = this.store.gift(input);
    if (r.ok) this.queueIcon(r.item.id);
    return r;
  }
  arrived(id, photo) {
    const r = this.store.arrived(id, photo);
    if (r.ok) {
      if (r.redraw) this.queueIcon(r.item.id);
      void this.emit('arrived', { item: r.item });
    }
    return r;
  }
  redraw(id) {
    const it = this.store.get(id); if (!it) return { ok: false, reason: '没有这件东西。' };
    this.store.update(it.id, (x) => { x.icon = { status: 'pending', tries: 0, redo: true }; });
    this.queueIcon(it.id);
    return { ok: true };
  }

  queueIcon(id) { if (!this.queue.includes(id)) this.queue.push(id); void this.runIcons(); }
  async runIcons() {
    if (this.busy) return; this.busy = true;
    try {
      while (this.queue.length) {
        const id = this.queue.shift(); const it = this.store.get(id);
        if (!it || it.icon?.status === 'ok') continue;
        const redo = !!it.icon?.redo;
        let buf = null, error = '', none = false;
        for (let k = 0; k < 2 && !buf && !none; k++) {
          this.store.update(id, (x) => { x.icon.tries = (x.icon.tries ?? 0) + 1; });
          try { buf = await this.iconMaker(this.store.get(id), it.photo ? this.store.photoPath(it.photo) : null); }
          catch (e) { error = String(e?.message ?? e).slice(0, 160); none = e?.code === 'NO_PROVIDER'; }
        }
        let ok = false;
        if (buf) ok = this.store.setIcon(id, buf, 'gen').ok;
        if (!ok) { this.store.update(id, (x) => { x.icon = { status: none ? 'none' : 'fail', tries: x.icon.tries, error }; }); this.store.log({ kind: 'icon', id, ok: false, error });
          if (!none) console.warn(`[gift-room] ${id} 的图标没画出来：${error || '生图返回的不是图片'}`);
        }
        if (!redo) this.afterIcon(id);
      }
    } finally { this.busy = false; }
  }

  /** 图标好了（或画不出来）：通知你的 AI，并定时自动摆放兜底。 */
  afterIcon(id) {
    void this.emit('gift', { item: this.store.get(id) });
    const min = this.cfg.autoPlaceMinutes ?? 10;
    if (min < 0) return;
    const t = setTimeout(() => {
      this.timers.delete(t);
      const it = this.store.get(id);
      if (it && !it.spot) { const r = this.store.autoPlace(id); if (r.ok) void this.emit('placed', { item: r.item, auto: true }); }
    }, min * 60_000);
    t.unref?.(); this.timers.add(t);
  }

  /** 启动时把上次没摆、超时的东西补摆上（进程重启过，定时器丢了）。 */
  catchUp() {
    const min = this.cfg.autoPlaceMinutes ?? 10; if (min < 0) return;
    for (const it of this.store.items()) {
      if (it.icon?.status === 'pending') this.queueIcon(it.id);
      else if (!it.spot && this.now() - Date.parse(it.at) > min * 60_000) this.store.autoPlace(it.id);
    }
  }

  close() { for (const t of this.timers) clearTimeout(t); this.timers.clear(); }

  // ------------------------------------------------------------ 事件通知（给你自己的 AI）
  /** POST 到 webhook.url，body 是 {event, at, item, room}；配了 secret 就在 x-gift-room-signature 里带 sha256 HMAC。 */
  async emit(event, payload) {
    const url = this.cfg.webhook?.url; if (!url) return;
    const st = this.state();
    const body = JSON.stringify({
      event, at: new Date(this.now()).toISOString(), ...payload,
      room: { character: st.character, free: this.store.freeSpots().map((f) => ({ spot: f.spot, label: f.label })) },
    });
    const headers = { 'content-type': 'application/json', 'x-gift-room-event': event };
    if (this.cfg.webhook.secret) headers['x-gift-room-signature'] = 'sha256=' + createHmac('sha256', this.cfg.webhook.secret).update(body).digest('hex');
    for (let k = 0; k < 2; k++) {
      try {
        const r = await this.fetchImpl(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(15_000) });
        this.webhookLog.push({ event, status: r.status });
        if (r.ok) return;
      } catch (e) { this.webhookLog.push({ event, error: String(e?.message ?? e).slice(0, 80) }); }
    }
    const last = this.webhookLog.at(-1);
    console.warn(`[gift-room] ${event} 事件没发出去（${last?.status ? '对方返回 ' + last.status : last?.error ?? '未知原因'}），检查 webhook.url 和接收端`);
  }
}
