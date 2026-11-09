import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from './util.mjs';

/**
 * 一间屋子，多种风格。
 *
 * public/room.json：屋子的布局，所有风格共用。坐标都是背景图宽高的百分比。
 *   spots.<位置>: { label, x0, x1, b, b1?, h, cap, fill?, hang? }
 *     x0/x1 = 左右边界，b = 东西底边贴着的高度（从上往下量），h = 能放的最大高度，cap = 最多放几件，
 *     b1 = 透视里斜着的搁板右端的底边高度（不写就和 b 一样），
 *     fill = 少于这个数时从左往右按格摆（不挤到正中），hang = 挂在墙上的位置。
 *   character.<姿势>: { x, b, h }  角色站的位置（b 是脚底的高度，从上往下量）；没写的姿势用 character.default。
 *   box: { x, b, w }  还没摆的礼物盒放哪。
 *   schedule: [{ hours: [起, 止], poses: [...] }, …]  各时段轮流用的姿势（本地小时，可跨午夜）。
 *
 * public/themes/<风格>/：每种风格一张正方形 bg.jpg 和一个 theme.json { name, order, tint }。
 *   tint = "room"（按时间调日夜光线，默认）或 "none"（背景本身就是固定光线，比如夜景）。
 *   换风格时布局不变，所以每张背景的家具位置要和 room.json 对得上。
 */
export function loadRoom(publicDir) {
  const layout = readJson(join(publicDir, 'room.json'), null);
  if (!layout?.spots) throw new Error(`没有读到 ${join(publicDir, 'room.json')}`);
  const dir = join(publicDir, 'themes');
  const themes = [];
  if (existsSync(dir)) {
    for (const id of readdirSync(dir)) {
      if (!/^[\w-]+$/.test(id) || !existsSync(join(dir, id, 'bg.jpg'))) continue;
      const t = readJson(join(dir, id, 'theme.json'), {});
      themes.push({ id, name: t.name || id, order: t.order ?? 99, tint: t.tint === 'none' ? 'none' : 'room' });
    }
  }
  themes.sort((a, b) => a.order - b.order);
  return {
    themes,
    layout: {
      spots: layout.spots,
      character: layout.character ?? { default: { x: 50, b: 90, h: 30 } },
      box: layout.box ?? { x: 82, b: 95, w: 11 },
      schedule: Array.isArray(layout.schedule) ? layout.schedule : [],
    },
  };
}
