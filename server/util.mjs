import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

/** 去掉控制字符和零宽字符，压空白，截长度。 */
export const clean = (s, n = 200) => String(s ?? '')
  .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁠-⁯﻿]/g, ' ')
  .replace(/\s+/g, ' ').trim().slice(0, n);

/** 名字比对用：全角转半角、小写、去空白和标点。 */
export const norm = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');

export function readJson(file, dflt) {
  try { return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return dflt; }
}

/** 先写临时文件再改名，进程中途被杀也不会留下半截 JSON。 */
export function writeJsonAtomic(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
  renameSync(tmp, file);
}

/** 按配置的时区（相对 UTC 的小时数）取本地时间的各个字段。 */
export function localParts(ms, utcOffset = 8) {
  const d = new Date(ms + utcOffset * 3600_000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), day: d.toISOString().slice(0, 10) };
}

/** 小时 h 是否落在 [from, to) 里，支持跨午夜（比如 [23, 7]）。 */
export function inHours(h, [from, to]) {
  return from <= to ? h >= from && h < to : h >= from || h < to;
}

/** 看文件头判断图片类型，只认 png、jpg、webp。 */
export function imageType(buf) {
  if (!buf || buf.length < 12) return null;
  const head = buf.subarray(0, 4).toString('hex');
  if (head === '89504e47') return 'png';
  if (head.startsWith('ffd8')) return 'jpg';
  if (head === '52494646' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}
export const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
