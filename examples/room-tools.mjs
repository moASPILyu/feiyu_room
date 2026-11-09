#!/usr/bin/env node
/**
 * 把小屋的接口包装成聊天模型能调用的工具（OpenAI 兼容的 function calling 格式）。
 *
 * 在你自己的代码里：
 *   import { TOOLS, runTool } from './room-tools.mjs';
 *   // 1. 调聊天接口时带上 tools: TOOLS
 *   // 2. 模型返回 tool_calls 时，对每一个调用：
 *   const result = await runTool(call.function.name, JSON.parse(call.function.arguments || '{}'));
 *   // 3. 把 result 用 JSON.stringify 后作为 role: "tool" 的消息发回去
 * 完整的来回见 examples/chat-with-tools.mjs。
 *
 * 也可以在命令行里直接试（参数写成 键=值，免得在 PowerShell 里折腾引号）：
 *   node examples/room-tools.mjs room_look
 *   node examples/room-tools.mjs room_character say=你好呀 pose=wave
 *   node examples/room-tools.mjs room_place item=g1 spot=sill feel=好看
 *
 * 小屋地址和口令从环境变量 ROOM_URL、ROOM_TOKEN 读，也可以在 runTool 的第三个参数里传。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const TOOLS = JSON.parse(readFileSync(new URL('./tools.json', import.meta.url), 'utf8'));

function client({ url = process.env.ROOM_URL || 'http://127.0.0.1:17800', token = process.env.ROOM_TOKEN || '' } = {}) {
  const base = url.replace(/\/+$/, '');
  return async (path, body, method = body ? 'POST' : 'GET') => {
    const r = await fetch(base + path, {
      method, headers: { 'x-room-key': token, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000),
    });
    if (r.status === 401) throw new Error('小屋口令不对（检查 ROOM_TOKEN）');
    return r.json();
  };
}

/** 礼物可以用 id（g3）也可以用名字，统一换成 id。 */
function findItem(state, ref) {
  const r = String(ref ?? '').trim();
  return state.items.find((x) => x.id === r) ?? state.items.find((x) => x.name === r) ?? state.items.find((x) => r && x.name.includes(r)) ?? null;
}

/** 执行一个工具调用，返回一个可以直接 JSON.stringify 发回给模型的对象。出错不抛异常，返回 {ok:false, reason}。 */
export async function runTool(name, args = {}, opts = {}) {
  const room = client(opts);
  try {
    if (name === 'room_look') {
      const s = await room('/api/state');
      const spots = s.layout.spots;
      const label = (it) => (!it.spot ? '还在礼物盒里没拆' : it.spot === 'stored' ? '收在箱子里' : spots[it.spot]?.label ?? it.spot);
      const used = (k) => s.items.filter((x) => x.spot === k).length;
      return {
        ok: true,
        me: { name: s.character.name, doing: s.character.text, pose: s.character.pose, saying: s.character.say || '' },
        items: s.items.map((it) => ({ id: it.id, name: it.name, where: label(it), feel: it.feel || '', note: it.note || '', used: it.useCount, real: it.kind !== 'virtual' })),
        unplaced: s.items.filter((x) => !x.spot).map((x) => ({ id: x.id, name: x.name })),
        freeSpots: Object.entries(spots).filter(([k, v]) => used(k) < v.cap).map(([k, v]) => ({ spot: k, label: v.label })),
        wishlist: s.wants.filter((w) => !w.given).map((w) => ({ title: w.title, why: w.why })),
      };
    }
    if (name === 'room_add_want') return await room('/api/wants', { title: args.title, why: args.why, link: args.link, price: args.price, by: 'ai' });
    if (name === 'room_place' || name === 'room_use') {
      const it = findItem(await room('/api/state'), args.item);
      if (!it) return { ok: false, reason: `屋里没有「${args.item}」，先用 room_look 看看有哪些。` };
      if (name === 'room_use') { const r = await room(`/api/items/${it.id}/use`, { what: args.what }); return r.ok ? { ok: true, item: { id: it.id, name: it.name, used: r.item.uses.length } } : r; }
      const r = await room(`/api/items/${it.id}/place`, { spot: args.spot, name: args.name, feel: args.feel });
      return r.ok ? { ok: true, item: { id: r.item.id, name: r.item.name, spot: r.item.spot } } : r;
    }
    if (name === 'room_character') {
      const body = {};
      for (const k of ['say', 'pose', 'text', 'minutes']) if (args[k] !== undefined && args[k] !== '') body[k] = args[k];
      if (body.minutes !== undefined) body.minutes = Number(body.minutes);
      return await room('/api/character', body);
    }
    return { ok: false, reason: `没有这个工具：${name}` };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) };
  }
}

// 命令行：node examples/room-tools.mjs <工具名> [键=值 ...]
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [name, ...kv] = process.argv.slice(2);
  if (!name) {
    console.log('用法：node examples/room-tools.mjs <工具名> [键=值 ...]\n可用的工具：' + TOOLS.map((t) => t.function.name).join('、'));
    process.exit(0);
  }
  const args = Object.fromEntries(kv.map((s) => { const i = s.indexOf('='); return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)]; }));
  console.log(JSON.stringify(await runTool(name, args), null, 2));
}
