#!/usr/bin/env node
/**
 * 示例：在命令行里和鲸鱼娘聊天，她能看自己的小屋、记愿望单、摆礼物、记用过什么、在屋里冒话。
 * 用来试 room-tools.mjs 怎么接进聊天模型；你自己的机器人照着 chat() 这一段改就行。
 *
 * 需要的环境变量：
 *   ROOM_URL       小屋地址，默认 http://127.0.0.1:17800
 *   ROOM_TOKEN     小屋口令（data/token.txt 里那串）
 *   CHAT_BASE_URL  OpenAI 兼容的聊天接口地址，比如 https://api.deepseek.com
 *   CHAT_MODEL     模型名，以服务商文档为准
 *   CHAT_API_KEY   你的 key
 *   PERSONA        可不填，角色设定
 * 模型要支持 function calling（tools）。输入 exit 退出。
 */
import { createInterface } from 'node:readline/promises';
import { TOOLS, runTool } from './room-tools.mjs';

const env = process.env;
const CHAT = { base: (env.CHAT_BASE_URL || '').replace(/\/+$/, ''), model: env.CHAT_MODEL || '', key: env.CHAT_API_KEY || '' };
if (!CHAT.base || !CHAT.model || !CHAT.key) {
  console.error('先设置 CHAT_BASE_URL、CHAT_MODEL、CHAT_API_KEY 三个环境变量，见 docs/connect-ai.md。');
  process.exit(1);
}
const PERSONA = env.PERSONA || '你是鲸鱼娘，一个长着鲸鱼尾巴和鲸鳍耳朵的小女仆，最爱吃白米饭，喜欢叫主人“鱼片”，说话活泼、容易开心，偶尔有点小得意。';
const SYSTEM = PERSONA + '\n\n你有一间主人给你布置的小屋，可以用工具看屋里有什么、把礼物摆好、记下你拿礼物做了什么、把想要的东西记进愿望单、在屋里冒一句话。'
  + '聊到礼物或者屋子时先用 room_look 看一眼再说，不要编屋里没有的东西。回复像聊天一样简短。';

async function complete(messages) {
  const r = await fetch(CHAT.base + '/chat/completions', {
    method: 'POST', headers: { authorization: `Bearer ${CHAT.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: CHAT.model, messages, tools: TOOLS, temperature: 0.8 }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!r.ok) throw new Error(`聊天接口返回 ${r.status}：${(await r.text()).slice(0, 200)}`);
  return (await r.json()).choices[0].message;
}

/** 一轮对话：模型想调工具就替它调，结果发回去，直到它给出文字回复（最多 5 轮工具调用）。 */
async function chat(messages) {
  for (let round = 0; round < 6; round++) {
    const msg = await complete(messages);
    messages.push(msg);
    if (!msg.tool_calls?.length) return msg.content ?? '';
    for (const call of msg.tool_calls) {
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* 参数坏了就按空参数 */ }
      const result = await runTool(call.function.name, args);
      console.log(`  [${call.function.name}] ${result.ok === false ? '失败：' + result.reason : '好了'}`);
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  return '（工具调用太多次，先停一下）';
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const messages = [{ role: 'system', content: SYSTEM }];
console.log('和鲸鱼娘聊天，输入 exit 退出。');
process.stdout.write('你：');
for await (const line of rl) { // 输入结束（Ctrl+D、管道读完）时循环自己停
  const text = line.trim();
  if (text === 'exit') break;
  if (text) {
    const before = messages.length;
    messages.push({ role: 'user', content: text });
    try { console.log('鲸鱼娘：' + await chat(messages)); }
    catch (e) { console.log('出错了：' + e.message); messages.length = before; } // 出错的这一轮整轮丢掉，免得留下没配对的工具调用
  }
  process.stdout.write('你：');
}
rl.close();
