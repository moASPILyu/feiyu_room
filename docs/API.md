# 接口说明

所有 `/api/` 接口都要带口令，二选一：

```
x-room-key: <口令>
Authorization: Bearer <口令>
```

口令在 `config.json` 的 `token` 里；没写的话，第一次启动时会随机生成并保存到 `data/token.txt`。

请求和返回都是 JSON（上传图片的接口除外）。失败时返回 `{"ok": false, "reason": "原因"}`，状态码是 400、401 或 404。

## 状态

### `GET /api/state`

页面用的完整状态：

```jsonc
{
  "now": "2026-11-09T12:00:00.000Z",
  "utcOffset": 8,
  "character": { "name": "鲸鱼娘", "pose": "think", "text": "在琢磨事情", "say": "" },
  "themes": [ { "id": "warm", "name": "暖阳原木", "tint": "room" }, { "id": "nordic", "name": "北欧清晨", "tint": "room" }, { "id": "cyber", "name": "赛博夜", "tint": "none" } ],
  "theme": "warm",
  "layout": {
    "spots": { "sill": { "label": "窗台", "x0": 36, "x1": 64, "b": 42, "h": 10, "cap": 3, "fill": 2 } },
    "character": { "default": { "x": 50, "b": 83, "h": 29 } },
    "box": { "x": 67, "b": 87, "w": 10 },
    "schedule": [ { "hours": [12, 14], "poses": ["play"] } ]
  },
  "items": [ { "id": "g1", "name": "小鱼缸", "spot": "cabinet", "feel": "…", "icon": 1762689600000, "uses": [] } ],
  "wants": [ { "id": "w1", "title": "桌面迷你小鱼缸", "why": "…", "by": "ai", "given": true } ],
  "iconProvider": "openai"
}
```

整间屋子只有一套布局（`layout`），三种风格（`themes`）只是换背景图。`theme` 是 `config.json` 里设的默认风格，看的人可以在页面上自己换，换了只存在自己的浏览器里。

`items[].icon`：是数字表示图标已经画好（数字是版本号），否则是 `pending`（正在画）、`fail`（画失败了）、`none`（没有配置生图）。

## 愿望单

| 方法 | 路径 | 请求体 | 说明 |
|---|---|---|---|
| GET | `/api/wants` | | 愿望单，新记的在前 |
| POST | `/api/wants` | `{title, why?, link?, price?, by?}` | 加一件。你的 AI 自己想要什么时，`by` 填 `"ai"`，页面上会显示成它自己记的 |
| DELETE | `/api/wants/<id>` | | 从愿望单删掉一件 |

## 送礼

| 方法 | 路径 | 请求体 | 说明 |
|---|---|---|---|
| POST | `/api/photos` | 图片二进制（jpg/png/webp，≤12MB） | 先传实物照片，返回 `{ok, photo}`，再把 `photo` 填进下面的请求 |
| POST | `/api/gifts` | `{want?, name?, desc?, note?, kind?, photo?}` | 送一件。`want` 填愿望单的 id，或者用 `name` 自己写一件。`kind` 可选 `virtual`（只送进小屋，默认）、`shipping`（真买了，还在路上）、`arrived`（真买了，已经到了） |
| POST | `/api/items/<id>/arrived` | `{photo?}` | 快递到了。带照片的话，图标会照着实物重画 |

送出后服务端会排队画图标，画好（或者画失败）后发出 `gift` 事件，见下文。

## 东西

| 方法 | 路径 | 请求体 | 说明 |
|---|---|---|---|
| POST | `/api/items/<id>/place` | `{spot, feel?, name?, size?}` | 摆到屋里某个位置，位置名见 `layout.spots`。`spot` 填 `"stored"` 表示收进箱子。`feel` 是收到时心里的一句话，只记第一次 |
| POST | `/api/items/<id>/autoplace` | | 自动找空位摆（大件优先地上，小件优先架子），都满了就收进箱子 |
| PATCH | `/api/items/<id>` | `{name?, feel?, size?}` | 改名字、心里话、大小（`s`/`m`/`l`） |
| POST | `/api/items/<id>/use` | `{what}` | 记一次“拿它做了什么”，页面详情里能看到；30 分钟内角色会坐下来琢磨它 |
| GET | `/api/items/<id>/icon` | | 图标图片 |
| PUT | `/api/items/<id>/icon` | 图片二进制 | 手动换图标 |
| POST | `/api/items/<id>/redraw` | | 重画图标 |
| GET | `/api/items/<id>/photo` | | 实物照片 |

## 角色

### `POST /api/character`

```jsonc
{
  "say": "谢谢你！",      // 冒一句话，在头顶气泡里显示，20 分钟内有效
  "pose": "play",         // idle 站着 / think 坐着敲电脑 / play 捧碗吃白米饭 / wave 挥手 / gift 抱着礼物 / sleep 在床上睡觉
  "text": "在吃饭",        // 页面顶部的状态
  "minutes": 30,          // pose/text 保持多久，1~1440，默认 30
  "clear": true           // 清掉之前设的状态，回到自动作息
}
```

只填 `say` 时，角色照常按自动作息活动，只是头顶会冒出这句话。

没有外部设置时，角色按下面的作息自己活动：

1. 刚收到礼物（10 分钟内）：拆礼物。
2. 睡觉时段（`config.json` 的 `character.sleep`，默认 23 点到 7 点）：在床上睡觉。
3. 30 分钟内用过某件东西：坐下来琢磨它。
4. 20 分钟内说过话：挥手。
5. 其余时间：按 `public/room.json` 的 `schedule` 选当前时段的姿势，每 20 分钟换一个。

## 事件（webhook）

在 `config.json` 里填 `webhook.url`，小屋会把事件 POST 过去：

```
POST <webhook.url>
content-type: application/json
x-gift-room-event: gift
x-gift-room-signature: sha256=<用 webhook.secret 对请求体算的 HMAC-SHA256，十六进制>
```

```jsonc
{
  "event": "gift",              // gift：图标画好了（或画失败了），该收礼了
                                // arrived：实物快递到了
                                // placed：超时没人摆，系统自动摆好了
  "at": "2026-11-09T12:00:00.000Z",
  "item": { "id": "g1", "name": "小鱼缸", "desc": "…", "note": "主人说的话", "why": "以前想要它时说的", "kind": "virtual" },
  "room": {
    "character": { "name": "鲸鱼娘", "pose": "gift" },
    "free": [ { "spot": "sill", "label": "窗台" }, { "spot": "floorL", "label": "左边地上" } ]
  }
}
```

验证签名的写法见 `examples/ai-bridge.mjs`。失败时会重试一次。如果 `autoPlaceMinutes` 分钟内没人调用 `place`，系统会自动找空位摆上；设成 `-1` 可以关掉自动摆放。

## 生图

`config.json` 的 `image.provider`：

- `none`：不生成图标，屋里显示礼物盒加名字，可以在页面上手动传图标。
- `openai`：OpenAI 兼容的图片接口。请求 `POST {baseUrl}/images/generations`；有实物照片且 `useEdits: true` 时，改用 `POST {baseUrl}/images/edits` 并把照片作为参考图传过去。返回值里的 `data[0].b64_json`、`data[0].url`、`images[0].url` 三种格式都能识别。key 从 `apiKeyEnv` 指定的环境变量读取。`extra` 里的字段会原样并进请求体。
- `command`：运行你自己的命令。`args` 是参数数组，不经过 shell，里面的 `{prompt}`、`{out}`、`{ref}` 会被替换成提示词、输出路径和参考照片路径。命令需要把图片写到 `{out}`，退出码为 0 表示成功。没有参考照片时，`{ref}` 那一项会被去掉；如果它前面一项是 `--xxx` 这样的选项名，也会一起去掉。

图标最好是白底或透明底。白底的会在浏览器里自动抠掉。
