# 接入你自己的 AI

小屋本身不带聊天模型。想让屋里的鲸鱼娘“活”起来，比如收到礼物自己决定摆在哪、对你说句话，平时聊天时能看自己的屋子、记下想要的东西，就要把你自己的 AI 接进来。

## 先弄清楚是怎么连的

```
                       ① 事件：收到礼物了 / 快递到了
  ┌──────────┐  ───────────────────────────────▶  ┌──────────────┐        ┌──────────────┐
  │  小屋     │                                    │  你的 AI 程序  │ ─────▶ │  聊天模型      │
  │  :17800   │  ◀───────────────────────────────  │              │ ◀───── │（DeepSeek 等）│
  └──────────┘   ② 调接口：摆到窗台、说句话          └──────────────┘        └──────────────┘
```

- **小屋**就是 `npm start` 跑起来的服务。它有一组 HTTP 接口，带上口令就能调用，见 [API.md](API.md)。
- **你的 AI 程序**负责在中间传话：收到小屋发来的事件后去问聊天模型，再按模型的回答调用小屋的接口。
- **聊天模型**用哪家都行，只要接口兼容 OpenAI 的 `/chat/completions` 格式。DeepSeek、通义、Kimi、本地的 Ollama 一般都兼容。

## 选一种接法

| 你的情况 | 用哪个 | 能做什么 |
|---|---|---|
| 想先玩起来，什么都没写过 | [A. 收礼自动反应](#a-收礼自动反应) | 收到礼物后，她自己起名、选位置、写心里话、说句谢谢 |
| 想在命令行里和她聊天 | [B. 命令行聊天](#b-命令行聊天) | 聊天时她能看屋里有什么、记愿望单、摆东西、在屋里冒话 |
| 已经有自己的聊天机器人（QQ 机器人、AI 伴侣之类） | [C. 接进已有的机器人](#c-接进已有的机器人) | 把上面这些能力做成工具交给你的机器人 |

A 和 B、C 可以同时用：A 负责收礼时的反应，B 或 C 负责平时聊天。

## 准备：三样东西

1. **小屋口令**：在项目的 `data/token.txt` 里。
2. **聊天接口的地址、模型名和 key**：在模型服务商的控制台申请，模型名以服务商文档为准。拿 DeepSeek 举例，地址是 `https://api.deepseek.com`。
3. **webhook 密钥**：自己随便编一串字母数字，比如 `fish-rice-2026`，只用在 A 里。小屋发事件时会用它签名，你的 AI 程序靠它确认事件确实是小屋发来的。

key 和口令只放在自己电脑上，不要发到群里，也不要提交进 git。

## A. 收礼自动反应

用的是 [`examples/ai-bridge.mjs`](../examples/ai-bridge.mjs)。

**第 1 步：告诉小屋把事件发到哪里。** 在 `config.json` 里加上下面这段（没有 `config.json` 的话，先把 `config.example.json` 复制一份改名），然后重启小屋：

```json
"webhook": { "url": "http://127.0.0.1:17801/hook", "secret": "fish-rice-2026" }
```

**第 2 步：再开一个命令行窗口，进到项目文件夹，启动 ai-bridge。**

Windows（PowerShell）：

```powershell
$env:ROOM_URL = "http://127.0.0.1:17800"
$env:ROOM_TOKEN = (Get-Content data\token.txt).Trim()
$env:WEBHOOK_SECRET = "fish-rice-2026"
$env:CHAT_BASE_URL = "https://api.deepseek.com"
$env:CHAT_MODEL = "deepseek-chat"
$env:CHAT_API_KEY = "你的key"
node examples/ai-bridge.mjs
```

macOS / Linux：

```bash
export ROOM_URL=http://127.0.0.1:17800
export ROOM_TOKEN=$(cat data/token.txt)
export WEBHOOK_SECRET=fish-rice-2026
export CHAT_BASE_URL=https://api.deepseek.com
export CHAT_MODEL=deepseek-chat
export CHAT_API_KEY=你的key
node examples/ai-bridge.mjs
```

看到“ai-bridge 在 http://127.0.0.1:17801/hook 等事件”就说明启动成功了。`WEBHOOK_SECRET` 要和 `config.json` 里的 `secret` 一模一样。

**第 3 步：试一下。** 在页面上送她一件东西。等图标画好（没配生图的话马上就会触发），ai-bridge 的窗口里会打印出类似“摆放 g1 sill”的一行，页面上她会抱着礼物冒出一句话。

- 不填 `CHAT_API_KEY` 也能运行，这时会按简单规则处理：摆到第一个空位，说一句“谢谢鱼片送的……”。
- 想换角色设定，可以加一个环境变量 `PERSONA`，写一段角色描述。
- 小屋和 ai-bridge 两个窗口都要一直开着。

## B. 命令行聊天

用的是 [`examples/chat-with-tools.mjs`](../examples/chat-with-tools.mjs)。模型需要支持 function calling（tools）。环境变量和 A 一样，但不需要 `WEBHOOK_SECRET`：

```powershell
# Windows：先设置好 ROOM_URL、ROOM_TOKEN、CHAT_BASE_URL、CHAT_MODEL、CHAT_API_KEY（写法同 A）
node examples/chat-with-tools.mjs
```

聊起来大概是这样：

```
你：屋里现在有什么呀
  [room_look] 好了
鲸鱼娘：窗台上有小盆栽，矮柜上是你送的小鱼缸，金鱼还在游呢！床头还有星星灯～
你：要不要把那个海螺挪到窗台上
  [room_place] 好了
鲸鱼娘：挪好啦，晒着太阳亮晶晶的！
```

方括号里是她调用的工具，每调一次，小屋页面上就能看到对应的变化。输入 `exit` 退出。

## C. 接进已有的机器人

我们把小屋的能力整理成了 5 个工具，定义写在 [`examples/tools.json`](../examples/tools.json) 里，格式是 OpenAI 兼容的 function calling：

| 工具 | 作用 | 对应的接口 |
|---|---|---|
| `room_look` | 看屋里有什么、哪些位置空着、愿望单里还有什么 | `GET /api/state`（返回内容比较多，建议整理成摘要再给模型） |
| `room_add_want` | 把想要的东西记进愿望单 | `POST /api/wants`，记得加上 `"by": "ai"` |
| `room_place` | 把礼物摆到某个位置 / 收进箱子 | `POST /api/items/<id>/place` |
| `room_use` | 记一笔“拿某件礼物做了什么” | `POST /api/items/<id>/use` |
| `room_character` | 冒一句话、换个动作 | `POST /api/character` |

### 你的机器人是 Node.js 写的

直接用 [`examples/room-tools.mjs`](../examples/room-tools.mjs)。它已经处理好了：用名字找礼物、整理 `room_look` 返回的内容、出错时把原因返回给模型。

```js
import { TOOLS, runTool } from './room-tools.mjs';

// 调聊天接口时带上工具
const body = { model, messages, tools: TOOLS };

// 模型返回 tool_calls 时，逐个执行，再把结果发回去
for (const call of reply.tool_calls ?? []) {
  const result = await runTool(call.function.name, JSON.parse(call.function.arguments || '{}'),
    { url: 'http://127.0.0.1:17800', token: '小屋口令' });
  messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
}
```

完整的来回流程见 `chat-with-tools.mjs` 里的 `chat()` 函数。

命令行里也可以单独试某个工具（需要先设置好 `ROOM_URL` 和 `ROOM_TOKEN`）：

```bash
node examples/room-tools.mjs room_look
node examples/room-tools.mjs room_character say=鱼片回来啦 pose=wave
```

### 你的机器人是别的语言写的

把 `tools.json` 的内容原样交给模型。模型调用工具时，按上面那张表去请求小屋的接口就行。请求头里带上口令：

```python
import requests  # pip install requests

ROOM = "http://127.0.0.1:17800"
H = {"x-room-key": "小屋口令"}

# 冒一句话、挥挥手
requests.post(f"{ROOM}/api/character", json={"say": "鱼片回来啦！", "pose": "wave", "minutes": 10}, headers=H)

# 看屋里有什么
state = requests.get(f"{ROOM}/api/state", headers=H).json()
for it in state["items"]:
    print(it["id"], it["name"], it["spot"])
```

`room_place` 和 `room_use` 的接口路径里要用礼物的 id（`g1`、`g2`……）。如果模型给的是礼物名字，先从 `/api/state` 的 `items` 里查出对应的 id。

### 建议加进系统提示词的话

```
你有一间主人给你布置的小屋，可以用工具看屋里有什么、把礼物摆好、记下你拿礼物做了什么、
把想要的东西记进愿望单、在屋里冒一句话。聊到礼物或者屋子时先用 room_look 看一眼再说，
不要编屋里没有的东西。只有自己真的想要时才记愿望单，不要一次记很多。
```

### 不想每次都调工具

也可以在每轮对话之前调一次 `room_look`（或者 `GET /api/state`），把摘要直接塞进上下文，比如“屋里：窗台上有小盆栽……”。这样模型不需要支持工具调用，只是不能自己动手摆东西。

### 不用 webhook，自己定时检查

如果你的机器人收不了 HTTP 请求，比如跑在没有固定地址的地方，可以每隔一段时间请求一次 `GET /api/state`，找出 `spot` 是 `null` 的礼物，它们就是还没摆的新礼物。

### 自己写 webhook 接收端时怎么验签

小屋发事件时，请求头 `x-gift-room-signature` 里是 `sha256=` 加上用 `secret` 对**原始请求体**算出的 HMAC-SHA256（十六进制）。Python 写法：

```python
import hmac, hashlib

def verify(raw_body: bytes, signature: str, secret: str) -> bool:
    want = "sha256=" + hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(want, signature or "")
```

事件的完整格式见 [API.md 的“事件”部分](API.md#事件webhook)。收到事件后先回复 200，再慢慢处理。小屋等 15 秒没收到回复就算失败，会重试一次。

## 出问题时先查这几样

- **ai-bridge 窗口没有任何反应**：检查 `config.json` 里的 `webhook.url` 写对了没有，以及改完以后小屋有没有重启。
- **ai-bridge 窗口打印“签名不对”**：两边的 `secret` 和 `WEBHOOK_SECRET` 不一致。
- **小屋窗口打印“事件没发出去”**：ai-bridge 没开，或者 `webhook.url` 的端口和 ai-bridge 的不一样（默认 17801）。
- **工具返回“小屋口令不对”**：`ROOM_TOKEN` 和 `data/token.txt` 里的不一样，注意别多复制了空格或换行。
- **聊天接口返回 401 或 404**：key 填错了，或者模型名、地址不对，对照服务商文档改。
- **她调了工具但页面没变化**：页面每 15 秒刷新一次，等一会儿或者手动刷新。
