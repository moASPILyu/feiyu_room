import { clean, localParts, inHours } from './util.mjs';

/** 角色的姿势。每个姿势对应 public/character/<姿势>.png，站在哪由 room.json 的 character 决定。 */
export const POSES = ['idle', 'think', 'play', 'wave', 'gift', 'sleep'];
const TEXT = { idle: '在发呆', think: '在琢磨事情', play: '在吃白米饭', wave: '在跟你打招呼', gift: '在拆你送的东西', sleep: '睡着了' };
const DEFAULT_SCHEDULE = [
  { hours: [7, 12], poses: ['idle', 'think'] },
  { hours: [12, 14], poses: ['play'] },
  { hours: [14, 18], poses: ['think', 'idle'] },
  { hours: [18, 23], poses: ['play', 'idle', 'think'] },
];

/**
 * 角色现在在干嘛。优先级：
 *   1. 外部 AI 通过 POST /api/character 设的状态（没过期就用）
 *   2. 刚收到礼物（10 分钟内）→ 拆礼物
 *   3. 睡觉时段，且最近没说话 → 睡觉
 *   4. 最近用过哪件东西（30 分钟内）→ 琢磨它
 *   5. 最近说过话 → 挥手
 *   6. 平时：按 room.json 的 schedule，每 20 分钟换一个姿势
 */
export function characterState(store, cfg, schedule = [], now = store.now()) {
  const { h } = localParts(now, cfg.utcOffset ?? 8);
  const c = store.character();
  const sayFresh = c.say && now - Date.parse(c.sayAt ?? 0) < 20 * 60_000;
  const say = sayFresh ? clean(c.say, 80) : '';
  const pick = (pose, text, extra = {}) => {
    const p = POSES.includes(pose) ? pose : 'idle';
    return { pose: p, text: clean(text, 40) || TEXT[p] || '', say, ...extra };
  };

  if (c.until && Date.parse(c.until) > now) return pick(c.pose ?? 'idle', c.text, { by: 'api' });

  const items = store.items();
  const lastGift = Math.max(store.lastGiftAt, ...items.map((x) => Date.parse(x.at) || 0));
  if (now - lastGift < 10 * 60_000) return pick('gift', TEXT.gift);

  const sleepHours = cfg.character?.sleep ?? [23, 7];
  if (inHours(h, sleepHours) && !sayFresh) return pick('sleep', TEXT.sleep);

  const used = items.map((x) => ({ x, t: Date.parse(x.lastUsedAt ?? '') || 0 })).filter((u) => now - u.t < 30 * 60_000).sort((a, b) => b.t - a.t)[0];
  if (used) return pick('think', `在用${used.x.name}`, { using: used.x.id });

  if (sayFresh) return pick('wave', TEXT.wave);

  const sched = schedule.length ? schedule : DEFAULT_SCHEDULE;
  const slot = sched.find((s) => inHours(h, s.hours ?? [])) ?? { poses: ['idle'] };
  const poses = (slot.poses ?? ['idle']).filter((p) => POSES.includes(p));
  const pose = poses[Math.floor(now / (20 * 60_000)) % Math.max(1, poses.length)] ?? 'idle';
  return pick(pose, TEXT[pose]);
}
