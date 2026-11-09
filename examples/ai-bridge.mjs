#!/usr/bin/env node
/**
 * 示例：把礼物小屋接到你自己的 AI 上。
 *
 * 它是一个小的 HTTP 服务，接收小屋发来的事件（webhook），然后：
 *   1. 问你的聊天模型：收到这件礼物，想给它起什么名字、摆在哪、心里怎么想、对你说什么；
 *   2. 调小屋的接口：摆放、写心里话、让角色冒一句话。
 * 没配模型 key 时，用一套简单的规则兜底（摆到第一个空位，说声谢谢）。
 *
 * 用法：
 *   ROOM_URL=http://127.0.0.1:17800 ROOM_TOKEN=<小屋口令> WEBHOOK_SECRET=<和 config.json 里一样> \
 *   CHAT_BASE_URL=https://api.deepseek.com CHAT_MODEL=deepseek-chat CHAT_API_KEY=<你的 key> \
 *   node examples/ai-bridge.mjs
 * 然后在小屋的 config.json 里填 "webhook": { "url": "http://127.0.0.1:17801/hook", "secret": "<同一个>" }。
 *
 * CHAT_BASE_URL 填任何 OpenAI 兼容的地址都行（/chat/completions）。
 */
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

const env = process.env;
const ROOM = (env.ROOM_URL || 'http://127.0.0.1:17800').replace(/\/+$/, '');
const TOKEN = env.ROOM_TOKEN || '';
const SECRET = env.WEBHOOK_SECRET || '';
const PORT = Number(env.BRIDGE_PORT || 17801);
const CHAT = { base: (env.CHAT_BASE_URL || '').replace(/\/+$/, ''), model: env.CHAT_MODEL || '', key: env.CHAT_API_KEY || '' };
const PERSONA = env.PERSONA || '你是鲸鱼娘，一个长着鲸鱼尾巴和鲸鳍耳朵的小女仆，住在主人给你布置的小屋里。你最爱吃白米饭，喜欢叫主人“鱼片”，说话活泼、容易开心，偶尔有点小得意。';

const room = (path, body, method = 'POST') => fetch(ROOM + path, {
  method, headers: { 'x-room-key': TOKEN, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
}).then((r) => r.json());

function verify(raw, sig) {
  if (!SECRET) return true;
  const want = Buffer.from('sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex'));
  const got = Buffer.from(String(sig ?? ''));
  return want.length === got.length && timingSafeEqual(want, got);
}

/** 问聊天模型要一个 JSON 决定。 */
async function decide(ev) {
  const spots = ev.room.free ?? [];
  if (!CHAT.base || !CHAT.key || !spots.length) {
    return { name: ev.item.name, spot: spots[0]?.spot ?? 'stored', feel: '', say: `谢谢鱼片送的${ev.item.name}！` };
  }
  const prompt = [
    `主人送了你一件礼物：「${ev.item.name}」${ev.item.desc ? `（${ev.item.desc}）` : ''}。`,
    ev.item.note ? `主人送的时候说：“${ev.item.note}”。` : '',
    ev.item.why ? `你以前想要它的时候说过：“${ev.item.why}”。` : '',
    ev.item.kind === 'virtual' ? '' : '这是主人真买的实物，实物在主人那儿。',
    '屋里现在空着的位置：', ...spots.map((s) => `- spot=${s.spot}：${s.label}`),
    '用 JSON 回答，不要别的文字：{"name":"你给它起的名字(≤12字)","spot":"…","feel":"收到时心里的一句话(≤40字)","say":"对主人说的一句话(≤40字)"}',
  ].filter(Boolean).join('\n');
  const r = await fetch(CHAT.base + '/chat/completions', {
    method: 'POST', headers: { authorization: `Bearer ${CHAT.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: CHAT.model, messages: [{ role: 'system', content: PERSONA }, { role: 'user', content: prompt }], response_format: { type: 'json_object' }, temperature: 0.9 }),
    signal: AbortSignal.timeout(60_000),
  });
  const j = await r.json();
  const out = JSON.parse(j.choices?.[0]?.message?.content ?? '{}');
  return spots.some((s) => s.spot === out.spot) ? out : { ...out, spot: spots[0].spot };
}

async function onEvent(ev) {
  if (ev.event === 'gift') {
    const d = await decide(ev);
    const placed = await room(`/api/items/${ev.item.id}/place`, { spot: d.spot, name: d.name, feel: d.feel });
    console.log('摆放', ev.item.id, placed.ok ? d.spot : placed.reason);
    if (d.say) await room('/api/character', { say: d.say, pose: 'gift', minutes: 15 });
  } else if (ev.event === 'arrived') {
    await room('/api/character', { say: `${ev.item.name}到啦？好想摸摸它！`, pose: 'wave', minutes: 10 });
  }
}

createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/hook') { res.writeHead(404).end(); return; }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    if (!verify(raw, req.headers['x-gift-room-signature'])) { console.warn('收到的事件签名不对：WEBHOOK_SECRET 要和小屋 config.json 里的 webhook.secret 一样'); res.writeHead(401).end(); return; }
    res.writeHead(200).end('ok'); // 先回 200，再慢慢处理
    let ev; try { ev = JSON.parse(raw.toString('utf8')); } catch { return; }
    onEvent(ev).catch((e) => console.error('处理事件失败', e.message));
  });
}).listen(PORT, '127.0.0.1', () => console.log(`ai-bridge 在 http://127.0.0.1:${PORT}/hook 等事件`));
