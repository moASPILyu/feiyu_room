#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Room } from './room.mjs';
import { createApp } from './http.mjs';
import { readJson } from './util.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 配置：config.json（没有就用 config.example.json），环境变量可以覆盖常用的几项。 */
export function loadConfig(file = process.env.GIFT_ROOM_CONFIG || join(ROOT, 'config.json')) {
  const base = readJson(join(ROOT, 'config.example.json'), {});
  const own = existsSync(file) ? readJson(file, null) : {};
  if (own === null) throw new Error(`配置文件不是合法 JSON：${file}`);
  const cfg = { ...base, ...own, character: { ...base.character, ...own.character }, image: { ...base.image, ...own.image }, webhook: { ...base.webhook, ...own.webhook } };
  const env = process.env;
  if (env.GIFT_ROOM_HOST) cfg.host = env.GIFT_ROOM_HOST;
  if (env.GIFT_ROOM_PORT) cfg.port = Number(env.GIFT_ROOM_PORT);
  if (env.GIFT_ROOM_TOKEN) cfg.token = env.GIFT_ROOM_TOKEN;
  if (env.GIFT_ROOM_DATA) cfg.dataDir = env.GIFT_ROOM_DATA;
  if (env.GIFT_ROOM_WEBHOOK) cfg.webhook.url = env.GIFT_ROOM_WEBHOOK;
  cfg.dataDir = resolve(ROOT, cfg.dataDir || 'data');
  return cfg;
}

/** 口令：配置里没写就随机生成一个，存在 data/token.txt。 */
export function ensureToken(cfg) {
  if (cfg.token) return { token: cfg.token, fresh: false };
  const f = join(cfg.dataDir, 'token.txt');
  if (existsSync(f)) return { token: readFileSync(f, 'utf8').trim(), fresh: false };
  mkdirSync(cfg.dataDir, { recursive: true });
  const token = randomBytes(12).toString('base64url');
  writeFileSync(f, token + '\n', { encoding: 'utf8', mode: 0o600 });
  return { token, fresh: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cfg = loadConfig();
  const { token, fresh } = ensureToken(cfg);
  const room = new Room(cfg, { publicDir: join(ROOT, 'public') });
  room.catchUp();
  const server = createApp(room, { publicDir: join(ROOT, 'public'), token });
  server.listen(cfg.port, cfg.host, () => {
    const url = `http://${cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host}:${cfg.port}/`;
    console.log(`礼物小屋已启动：${url}`);
    console.log(`房间风格 ${room.themes.map((t) => t.name).join('、')}，生图：${cfg.image.provider}，事件通知：${cfg.webhook.url || '没配'}`);
    console.log(fresh ? `第一次启动，口令已生成在 ${join(cfg.dataDir, 'token.txt')}。` : '口令在 config.json 的 token 或 data/token.txt 里。');
    console.log(`浏览器打开 ${url}#key=<口令> 会自动记住口令。`);
  });
  const stop = () => { room.close(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
