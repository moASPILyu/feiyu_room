import { spawn } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { imageType, MIME } from './util.mjs';

export const DEFAULT_STYLE = '画风：可爱的 Q 版手游道具图标，干净的深色描边，柔和平涂加一点高光。只画这一件东西，完整、居中，正面略带俯视；挂在墙上的东西画正面。纯白背景，不要文字、不要边框、不要人物、不要其他东西。';

/** 给生图模型的提示词。有实物照片时让它照着照片画。 */
export function iconPrompt(item, style = DEFAULT_STYLE) {
  const what = item.desc && item.desc !== item.name ? `${item.name}（${item.desc}）` : item.name;
  return `一件游戏道具图标：${what}。`
    + (item.photo ? '颜色、形状、花纹照参考图里这件实物画，只画这件东西本身，不画包装、价签、手和桌面。' : '画出这件东西最典型、最好认的样子。')
    + style;
}

/**
 * 按配置生成一张图标，返回图片 Buffer（png/jpg/webp）。
 * provider:
 *   none     不生成，页面上显示礼物盒和名字；可以在页面上手动传图标。
 *   openai   OpenAI 兼容的图片接口（/images/generations，有参考照片且 useEdits=true 时用 /images/edits）。
 *   command  跑你自己的命令（ComfyUI 脚本、本地模型、别的命令行工具都行），命令把图写到 {out}。
 */
export async function generateIcon(item, { image = {} } = {}, { photoPath = null, fetchImpl = fetch } = {}) {
  const provider = image.provider ?? 'none';
  const prompt = iconPrompt(item, image.style || DEFAULT_STYLE);
  if (provider === 'none') throw Object.assign(new Error('没有配置生图'), { code: 'NO_PROVIDER' });
  if (provider === 'openai') return openaiImage(prompt, image.openai ?? {}, photoPath, fetchImpl);
  if (provider === 'command') return commandImage(prompt, image.command ?? {}, photoPath);
  throw new Error(`不认识的 image.provider：${provider}`);
}

function apiKey(o) {
  const k = (o.apiKeyEnv && process.env[o.apiKeyEnv]) || o.apiKey || '';
  if (!k) throw new Error(`没有生图 API key：设置环境变量 ${o.apiKeyEnv || 'GIFT_ROOM_IMAGE_KEY'}`);
  return k;
}

async function openaiImage(prompt, o, photoPath, fetchImpl) {
  const base = String(o.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const headers = { authorization: `Bearer ${apiKey(o)}` };
  const params = { model: o.model || 'gpt-image-1', prompt, n: 1, ...(o.size ? { size: o.size } : {}), ...(o.extra ?? {}) };
  let res;
  const ctl = AbortSignal.timeout((o.timeoutSec ?? 240) * 1000);
  if (photoPath && o.useEdits) {
    const buf = readFileSync(photoPath); const t = imageType(buf) ?? 'png';
    const form = new FormData();
    for (const [k, v] of Object.entries(params)) form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
    form.append('image', new Blob([buf], { type: MIME[t] }), basename(photoPath));
    res = await fetchImpl(`${base}/images/edits`, { method: 'POST', headers, body: form, signal: ctl });
  } else {
    res = await fetchImpl(`${base}/images/generations`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(params), signal: ctl });
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`生图接口 ${res.status}：${text.slice(0, 200)}`);
  let j; try { j = JSON.parse(text); } catch { throw new Error('生图接口返回的不是 JSON'); }
  // OpenAI：data[0].b64_json 或 data[0].url；有些兼容接口：images[0].url
  const first = j.data?.[0] ?? j.images?.[0] ?? {};
  if (first.b64_json) return checkImage(Buffer.from(first.b64_json, 'base64'));
  if (first.url) {
    const r = await fetchImpl(first.url, { signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`下载生成的图失败：${r.status}`);
    return checkImage(Buffer.from(await r.arrayBuffer()));
  }
  throw new Error('生图接口没返回图片');
}

/** args 是参数数组（不经过 shell），里面的 {prompt} {out} {ref} 会被替换；没有参考照片时，值是 {ref} 的那一项和它前面的选项名都会去掉。 */
async function commandImage(prompt, o, photoPath) {
  const args = Array.isArray(o.args) ? o.args.map(String) : [];
  if (!args.length) throw new Error('image.command.args 没填');
  const dir = join(tmpdir(), 'gift-room-' + randomUUID().slice(0, 8)); mkdirSync(dir, { recursive: true });
  const out = join(dir, 'icon.png');
  const filled = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.includes('{ref}') && !photoPath) { if (filled.length && /^-/.test(filled.at(-1))) filled.pop(); continue; }
    filled.push(a.replaceAll('{prompt}', prompt).replaceAll('{out}', out).replaceAll('{ref}', photoPath ?? ''));
  }
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(filled[0], filled.slice(1), { cwd: o.cwd || process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let log = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('生图命令超时')); }, (o.timeoutSec ?? 300) * 1000);
      child.stdout.on('data', (d) => { log = (log + d).slice(-400); });
      child.stderr.on('data', (d) => { log = (log + d).slice(-400); });
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`生图命令退出码 ${code}：${log.slice(-200)}`)); });
    });
    if (!existsSync(out)) throw new Error('生图命令没有写出 {out}');
    return checkImage(readFileSync(out));
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录，删不掉也不影响 */ }
  }
}

function checkImage(buf) {
  if (!imageType(buf)) throw new Error('生成的不是 png/jpg/webp 图片');
  return buf;
}
