# herdr-relay 设计（草案）

在手机浏览器里看和操作这台 Mac 上 Herdr.app 的终端和 agent。不用 Tailscale，不用 SSH，不开端口。做法照 `dsh-pair`（`~/Projects/sides/dsh-plugins/dsh-pair`）：Cloudflare 上放一个中继，电脑只往外连。

日期：2026-11-02。状态：方案 + probe，还没写实现。

## 术语

- **herdr-core**：Herdr.app 底下的终端运行时，命令行叫 `hc`（本机 0.1.16）。所有终端（`t1`…`t9`）都活在它里面，Herdr.app 的窗口只是它的客户端。socket 在 `~/.local/state/herdr-core/default/default.sock`。
- **旧 herdr**：`~/.local/bin/herdr` 0.9.5 和它的 `herdr.sock`。Herdr.app 不用它（`herdr status` 显示 server not running）。herdrup、hackerchai/herdr-relay 都对接的是这一套，所以对我们没用。
- **viewer（观看者）**：一条 `terminal.attach` 流。Herdr.app 每个显示终端的地方是一个 viewer，手机也是一个 viewer。
- **observe viewer**：`observe: true` 的 viewer，只看，不能打字，也不影响终端尺寸。
- **尺寸主导者**：最近一次打字、改尺寸或获得焦点的非 observe viewer。终端的列数和行数由它决定，其余 viewer 看到的都是这个尺寸。
- **中继（relay）**：Cloudflare Worker + Durable Object，只转发密文，同一个 Worker 也托管手机网页。
- **宿主进程（host）**：Mac 上的 `herdr-relay` 后台进程，一头连中继，一头连 herdr-core。

## 结构

```
iPhone 浏览器 / PWA ──wss /v1/client/<id>──▶ Cloudflare Worker + DO（只见密文）
                                                   ▲
                                        wss /v1/desktop/<id>（只出站，Ed25519 签名占座）
                                                   │
                        Mac: herdr-relay 宿主进程 ──hc connect（分帧模式）──▶ herdr-core
                                                                                ▲
                                                         Herdr.app 的每个窗口 ───┘（都是 viewer）
```

端到端加密、配对、断线重连全部照搬 `dsh-pair`：

- `shared/e2e.js`：X25519 三次 DH + XSalsa20-Poly1305，计数器 nonce 防重放。改协议标签为 `herdr-relay/v1`，其余不动。
- `relay/src/index.js`：Room DO，一个桌面座位、最多 8 个手机连接，ping/pong 不唤醒 DO。原样复制，改名。
- 配对：二维码里有桌面公钥和一次性令牌（10 分钟），两边显示 6 位核对码，电脑上确认。确认在哪里做见下文「电脑上的确认」。
- 手机端 `link.js`（每步都有超时、回到前台就重连）原样复制。

新写的只有两块：宿主进程里对接 herdr-core 的部分，和手机上的终端页面。

## 手机能做什么，对应哪个接口

| 手机上的操作 | herdr-core 接口 | probe 验证 |
|---|---|---|
| 看所有终端：在哪个 space/tab、跑什么、agent 状态 | `terminal.list` + `events.subscribe`（快照 + 每次变化一条事件） | ✓ |
| 按 Herdr.app 的布局分组显示 | `doc.get herdr-app`（只读） | ✓ |
| 打开一个终端看实时画面 | `terminal.attach`，首屏是当前画面，之后是原始输出 | ✓ |
| 直接打字（含方向键、Esc、Ctrl-C） | attach 流上发 DATA | ✓ |
| 发一句话给 agent | `terminal.send`：等电脑上 ~3 秒没人打字，粘贴并回车 | ✓ |
| 快捷键按钮 | `terminal.keys`，约 33 ms 一次 | ✓ |
| 停止 | `terminal.interrupt` | 未测 |
| agent 卡住、结束、退出时推送 | 宿主订阅 `status` / `turn` / `finished` 事件 → Web Push | 未测 |

手机不新建、不关闭终端，也不写 `herdr-app` 布局文档。第一版只看、只打字。

## 多个窗口怎么同步

这一节回答「我有多个窗口」的问题。下面的规则都是 probe 在独立的 scratch core 上实测出来的（`node probe/sync.mjs`）。

**1. 输出天然同步。** herdr-core 里一个终端只有一份屏幕。每个 viewer 拿到的都是同一份输出。Mac 两个窗口加一个手机，任何一方打的字，三方都同时看到。不需要我们做任何同步。

**2. 尺寸只有一个，谁最后动谁说了算。** 这是唯一的冲突点。手机如果用自己的尺寸（比如 44 列）去打字，它就成了尺寸主导者，Mac 上所有显示这个终端的窗口都会变成 44 列。Mac 窗口重新获得焦点或被拖动，尺寸就回来。手机断开时，尺寸自动交还给最近活动的 Mac 窗口。

**3. 我们的做法：手机跟随，不抢尺寸。**

- 手机打开终端时，先用 observe 模式，只看不打字。
- 手机要打字时，用终端**当前的**列数和行数重新 attach 成普通 viewer。probe 验证：这样打字不改尺寸。
- 宿主订阅 `size` 事件。Mac 窗口被拖动时，手机立刻用新尺寸回一个 RESIZE，跟上去。probe 验证：Mac 改成 130x42，手机跟随后继续打字，尺寸保持 130x42。
- 手机屏幕放不下 267 列，就用 xterm.js 按真实列数渲染，再缩放或横向滚动。画面和 Mac 一模一样，只是小。
- 提供一个「适配手机」开关，打开后才用手机自己的尺寸。开关旁边写明：Mac 上这个窗格会一起变窄。

剩下一个小窗口期：Mac 刚改尺寸、手机还没收到 `size` 事件时手机正好打字，终端会被拉回旧尺寸一下，随后手机跟上，又变回来。这是两次重画，不丢字。

**4. 打字的三条路，按用途选。**

- 原始按键：走 attach 流的 DATA，和本地键盘一样，大小写、粘贴都对。打字用这条。
- `terminal.send`：整句话，自动回车。它会等电脑上没人在打字再输入，Mac 和手机同时打字时不会把字搅在一起。「发给 agent」按钮用这条。
- `terminal.keys`：只给按钮用（Esc、Ctrl-C、↑↓、Tab、1/2/3）。probe 发现单个大写字母会被当成小写（`A` 变成 `a`，要写 `shift+a`），所以普通文字绝不走这条。

**5. 布局只读。** `herdr-app` 文档里是 space → tab → 分屏树，没有按窗口区分的字段，所有 Mac 窗口共用这一份（当前 v9：5 个 space，7 个 tab）。手机只读它来分组，并订阅 `doc` 事件刷新。手机不写它。即使将来要写，`doc.set` 带版本号，过期的写入会被拒（probe 验证：`conflict`），不会覆盖 Mac 的改动。

**6. 多台手机、多个标签页。** 每个手机连接在宿主里对应一条自己的 `hc connect`，各自订阅、各自 attach。一个手机断开只关它自己的流，不影响其他手机和 Mac。中继最多 8 个手机连接。

## 电脑上的确认

`dsh-pair` 在 DSH 侧栏里确认配对。这里没有插件界面可用，第一版用命令行：

```
herdr-relay pair     # 打印二维码和链接，显示核对码，等你按 y
herdr-relay devices  # 列出、移除设备
```

以后可以做成 Herdr 的插件面板（herdr-core 有 `plugin.pane.open`），第一版不做。

## 地址和域名

用免费的 `https://herdr-relay.sir-housir.workers.dev`。Worker 名 `herdr-relay`，部署后这个地址自动就有，`wrangler.jsonc` 里不写 `routes`。`dsh-pair` 已经在同一个账号下用 `dsh-pair-relay.sir-housir.workers.dev`。

`workers.dev` 在大陆不开代理时经常打不开。手机打不开时，再给账号加一个自己的域名，在 `wrangler.jsonc` 里加一行：

```jsonc
"routes": [{ "pattern": "herdr.<域名>", "custom_domain": true }]
```

换地址的代价：手机网页、配对链接、Web Push 订阅和手机密钥都绑在地址上，所以每台手机要重新扫码配对一次，并重新添加到主屏幕。

## 安全

- 配对过的手机能往终端打字，权限等于这台 Mac 的 shell。所以必须配对确认，设备可以单独移除，状态文件权限 0600（`~/.config/herdr-relay/state.json`）。
- 中继只见密文和连接时间、大小这类元数据。
- 推送只发概要（「t6 claude-code 等你确认」），不发终端内容。
- herdr-core 的 socket 没有密码（官方文档说不要转发给不信任的人），所以宿主进程只把上面表格里的接口转给手机，不转发任意 RPC。`machine.exec`、`file.*`、`terminal.run`、`server.*` 一律不开放。

## 目录

```
shared/e2e.js        从 dsh-pair 复制
relay/               从 dsh-pair 复制：Worker + DO + 静态网页
host/                新写：中继连接、配对、hc 适配、推送、命令行
app/                 新写：手机网页（终端列表 + xterm.js 终端页），build 到 relay/public
probe/               hc.mjs（分帧客户端）、sync.mjs（多窗口同步 probe）
test/                e2e.test.mjs（加密）、host.live.test.mjs（全链路）
dev/                 fake-desktop.mjs（假 Mac）、ui-smoke.mjs（无头 iPhone 截图）
```

后台常驻：`~/Library/LaunchAgents/` 下放一个 LaunchAgent，复制安装，不用软链接。它不启动、不重启 Herdr.app 和 herdr-core；herdr-core 不在时只报离线，等它回来再连。

## 验证

| 步骤 | 内容 | 结果 |
|---|---|---|
| 1 | `probe/sync.mjs`：herdr-core 多 viewer 规则 | 21/21 过 |
| 2 | `test/host.live.test.mjs`：真宿主 + 本地中继 + 模拟手机 + scratch core。配对、列表、首屏、Mac 打字手机看到、手机打字 Mac 看到且尺寸不变、5 MB 输出（credit 不卡）、发送框、快捷键、白名单外方法被拒、适配手机再还原、断开后用同一设备 resume | 过 |
| 3 | `dev/ui-smoke.mjs`：无头 Chrome 模拟 iPhone，连 `dev/fake-desktop.mjs`。欢迎页、首页分组、「需要你」、终端页、按 1 回答菜单、适配手机、shell 打字、设置、深色 | 过，截图在 dev/shots，无页面错误 |
| 4 | 部署后在真 iPhone 上扫码，在 Herdr.app 的真实 agent 终端上操作一次 | 2026-11-02 过：iPhone 配对成功，从手机给 Herdr.app 里正在运行的 Claude Code 发了一条消息，agent 收到了 |

本地跑法：`npm run relay:dev`，然后 `RELAY=http://127.0.0.1:8799 npm test`；看界面：`node dev/fake-desktop.mjs` 打印配对链接，`node dev/ui-smoke.mjs "<链接>"`。

## 终端页怎么显示

终端保持 Mac 的列数。手机按宽度挑字号（8–14px，步长 0.5），让一整行放得下；110 列在 390pt 宽的 iPhone 上是 8px。更宽时字号停在 8px，横向滚动。不用 CSS 缩放：xterm 从 DOM 量字格，缩放会量错。

首屏可能比 `term.open` 的回复先到。页面在拿到流编号前先把输出存起来，拿到后再放。

## probe 怎么跑

```
node probe/sync.mjs            # A 部分 + B 部分
node probe/sync.mjs --scratch  # 只跑 A 部分
```

A 部分在 `HC_SESSION=relay-probe` 的独立 core 里自己开一个 `/bin/sh`，用两条连接模拟「Mac 窗口」和「手机」，结束时停掉这个 scratch core。B 部分对你的默认 core 只读：`terminal.list`、`doc.get herdr-app`、`events.subscribe`，不打字、不 attach。

## 还没验证的

- `terminal.interrupt` 对 Claude Code / Codex 的实际效果。
- agent 的 `blocked` 状态和审批菜单：probe 里只有 `/bin/sh`，没有 agent 状态上报。本机只有 t6（claude-code）报告了状态，其他 node 进程没报。
- Herdr.app 窗口切换焦点时，是否真的给 herdr-core 发 FOCUS。probe 里用的是模拟 viewer，不是 Herdr.app 本身。
- 手机浏览器里 xterm.js 渲染 267 列时的可读性和性能（会停在 8px 横向滚动，没在真机看过）。
- iOS 软键盘弹出时终端页的高度（用了 `100dvh` 和 `interactive-widget=resizes-content`，只在桌面 Chrome 模拟过）。
- 真实 Web Push 到 iPhone：推送代码从 dsh-pair 复制，那边在真机验证过，这里没验证。

## 语音输入（已实现）

不用手机自带的语音识别。手机只录音，音频经过同一条端到端加密通道传到 Mac。Mac 调用火山引擎「豆包语音 · 录音文件识别极速版」转成文字。中继只看到密文。API Key 只存在 Mac 上，手机和中继都拿不到。

```
手机 MediaRecorder ──分块 voice.put（E2E）──▶ 中继（密文）──▶ Mac 宿主
   ▲                                                           │ ffmpeg → ogg/opus 16 kHz 单声道
   │                                                           │ POST openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash
   └──────── 文字填进发送框，你改完再点发送 ◀──────────────────┘
```

| 部分 | 做法 |
|---|---|
| 手机录音 | 发送框左边加麦克风键：按住说话，松开结束，上滑取消。iOS Safari 录出 `audio/mp4`，Chrome 录出 `audio/webm`。限 120 秒。 |
| 传输 | 分块 `voice.put {id, offset, total, mime, data}`，每块 48 KB，走现有加密通道。 |
| 转码 | Mac 用 ffmpeg 转成 ogg/opus 16 kHz 单声道：极速版文档列的格式里没有 webm，iOS 的 mp4 也不确定是否直收，统一转码最稳。 |
| 识别 | 极速版：一次 POST 直接返回结果，没有提交再轮询。头：`X-Api-Key`（新版控制台的 Key）或 `X-Api-App-Key` + `X-Api-Access-Key`（旧版），`X-Api-Resource-Id: volc.bigasr.auc_turbo`，`X-Api-Request-Id`（UUID），`X-Api-Sequence: -1`。体：`audio.data`（base64）+ `audio.format`，`request.model_name: "bigmodel"`，`enable_itn`、`enable_punc`。结果状态在响应头 `X-Api-Status-Code`：`20000000` 成功，`20000003` 静音。 |
| 热词 | 带上编程词和当前终端的项目名、文件名。具体字段（`request.context` 或 `corpus`）以真实请求为准，未验证。 |
| 密钥 | `herdr-relay voice key` 从标准输入读入，存进 macOS 钥匙串（`security add-generic-password`），不进 state.json、不进日志。没配 key 时 `ready` 里 `voice: false`，手机不显示麦克风键。 |
| 结果 | `voice.done {id}` 返回文字，填进发送框，不自动发。 |
| 限制 | 单条 ≤ 2 MB、≤ 120 秒；每台手机同时只识别一条；识别完立刻删音频。 |

备选（不做，除非云端用不了）：本地 whisper.cpp。本机 M5 Pro 实测 9.7 秒中文，热启动 0.6 秒；中文对，英文词会被拆开（`npm` → `N,T,M`）。模型在 `~/.local/share/herdr-relay/models/`（574 MB），不用就删。

参考：火山引擎接入说明 https://docs.volcengine.com/docs/DoubaoVoice/Accessmust-read?lang=zh ；极速版字段对照了社区实现 https://github.com/lanbinleo/bili2text （src/b2t/transcribers/volcengine.py）。官方极速版页面里只找到旧版 v1 submit/query 接口，v3 flash 的字段是从接入说明和社区实现交叉得到的，第一次真实请求前都算猜测。

## 原生 App（nsh）评估（TODO，未开始）

nsh（Native Shell，https://nsh.dev ，Longbridge 开源，Apache-2.0）：用 Rust 或 TSX 写界面，iOS 上画的是 UIKit 原生控件，不是 WebView。TSX 在 QuickJS（一个小型 JS 引擎）里运行。

2026-11-02 查到的事实：
- 很新：仓库 2026-10-14 建立，最新版 v0.3.0（10-26），68 个未关的 issue。
- 有：`fetch`、全局 `WebSocket`、`crypto.getRandomValues`、`Storage`（键值存储）、`WebView`（和页面互发字符串）、`InputAccessoryView`（键盘上方的工具条）、`nsh package --target ios` 出签名 `.ipa`。
- 文档里没有：录音、扫码（相机）、APNs 推送、钥匙串。要用就得写一个 Swift 宿主 App（嵌入 `NshAppView`），在宿主里注册原生组件或桥接函数。`nsh package` 打出的独立 App 不注册任何原生组件。
- 没有终端组件：要么在 `WebView` 里继续跑 xterm.js，要么在 Swift 宿主里用 SwiftTerm（成熟的 Swift 终端库）做原生组件。

不用改的：中继、Mac 宿主、加密协议。`shared/e2e.js`（tweetnacl 是纯 JS）和 `app/src/link.js` 预计能在 QuickJS 里直接跑，未验证。
要改的：推送。PWA 用 Web Push；原生 App 用 APNs，Mac 宿主要加 APNs 发送（.p8 密钥 + HTTP/2），还要付费的 Apple 开发者账号。

| 工作 | 估计（我的工作日） |
|---|---|
| 0. 探路：装 nsh，在你的 iPhone 上跑 hello world；验证 QuickJS 里握手、WebSocket 连中继、WebView 里的 xterm.js | 1 |
| 1. 移植连接和协议 | 0.5 |
| 2. 原生页面：配对、终端列表、设置 | 1–1.5 |
| 3. 终端页：WebView + xterm.js（方案 A） / SwiftTerm 原生组件（方案 B） | 1 / 2–3 |
| 4. 发送框 + 键盘工具条 | 0.5–1 |
| 5. Swift 宿主：录音、扫码 | 1.5–2 |
| 6. 推送：App 端 APNs + Mac 端发送 | 1.5 |
| 7. 打包、签名、装到手机 | 0.5 |
| 合计 | 不带推送约 6–8，带推送约 8–11 |

估计是猜测，第 0 步做完再修正。

实测（2026-11-02，真 Key，2.0 标准版）：Mac 朗读一句 9.7 秒中文，1.4–1.9 秒返回。中文全对；火山原样输出「phones js」「NPM Test」，经过拼写还原后是「phones.js」「npm test」。

拼写还原：识别后，把结果里和热词只差大小写、或者只差空格/点/横线的地方，改回热词原样（只改整词，`testing` 不会被改）。只对 `SPELL` 表和你自己的词生效；`Node`、`push` 这类普通词只当提示、不强改。你的词写在 `~/.config/herdr-relay/voice-words.txt`，一行一个，`#` 开头是注释；终端所在文件夹名自动加入。

## 发图片（已实现）

手机点「+」选图（最多 6 张）。大图先在手机上缩到长边 2048px、JPEG 0.85。发送时每张图分块 `upload.put` 传到 Mac，再 `image.put` 调用 herdr-core 的 `terminal.put`：文件落在这个终端自己的文件夹里（终端删掉时一起删），返回路径。消息变成「路径1 路径2 你的文字」，用 `terminal.send` 发出去。Claude Code 和 Codex 会把消息里的图片路径当附件读。单张上限 8 MB（`terminal.put` 的上限）。

## 终端页布局

顶栏压缩（返回、标题、适配手机）。底部：一排快捷键（第一个是「直接打字」），下面是 iMessage 式输入行：左边「+」加图，中间圆角输入框，右边空着时是麦克风（按住说话），有内容时变成发送键。

### 手指滑动看历史（`app/src/touch-scroll.js`）

xterm 6 自己画滚动条，只认鼠标滚轮，手指拖动不会滚。所以终端区域自己处理竖向拖动：
- 先滚外层（终端比可用高度高时），再按行滚 xterm 的历史（`scrollLines`），手指走多远内容走多远；
- 松手后按速度惯性滑行，逐渐减速；
- 全屏程序（vim、less 等，备用屏幕没有历史）改发滚轮事件，由 xterm 按 Mac 上的方式转给程序；
- 横向拖动交给浏览器（宽终端左右滚）。

验证：`dev/scroll-smoke.mjs`（模拟 iPhone 触摸，7/7）：慢拖看到更早的行、快划会继续滑、上拖回来、横拖不滚行、点按不动、全屏程序收到 `ESC[<64;…M` 滚轮报告。真机手感未验证。

### Slash 命令（`app/src/live-command.js`）

问题：输入框只在发送时才把文字交给终端，所以打 `/` 时 Claude Code、Codex 自己的命令菜单（边打边筛选）不会出现。
实测（2026-11-02，临时 herdr-core）：`terminal.send`（粘贴 + 回车）发完整的 `/help`（Claude Code）和 `/status`（Codex）都能执行，所以发送这一步没问题，缺的是菜单。

做法：输入框内容以 `/` 开头（且只有一行、没有图片）时进入命令模式：每次改动都算出「退格到公共前缀，再补上新字」的按键，从终端流实时打进去。菜单就显示在上方的终端里；↑↓、Tab 用快捷键栏；发送 = 回车。把 `/` 删掉，打进终端的字也会退格删掉。普通消息仍然走 `terminal.send`。

验证：`dev/slash-smoke.mjs`（模拟 iPhone + 真 Claude Code，8/8）：打 `/he` 出现 /help 菜单，发送后打开帮助，删掉 `/` 后 Claude Code 输入框为空，普通消息不受影响。

## 远程新建终端：probe 结果（2026-11-02，`probe/create.mjs`）

在 herdr-relay 工作区里建了两个临时标签页，每个跑一个 30 秒后退出的 shell。

| 做法 | 结果 |
|---|---|
| A `herdr-app do tab.new --space S --name … --argv […]` | 能用，从模拟 LaunchAgent 的环境（`env -i`、最小 PATH）也能连上窗口。名字生效。**会抢焦点**：Mac 窗口直接切到新标签页。程序退出 33 秒后标签页**还在**（原因没查清），probe 用 `tab.close` 关掉。 |
| B herdr-core `terminal.run`，带标签 `herdr.space=S` | 能用：Herdr.app 自动建了新标签页。**不抢焦点**。程序退出后标签页自己关了。缺点：标签页名字是默认的序号（「3」），记录里没有补上 `herdr.tab`。 |

probe 结束时 Mac 焦点停在 herdr-relay 工作区（因为 A 抢过焦点，关掉后落到同一工作区），已用 `pane.focus` 还原到 probe 前的窗格。

结论：用 B。第一条消息用程序自己的参数传（`claude "任务"`、`codex "任务"`，argv 数组，不经过 shell），工作目录用这个工作区第一个终端的当前目录。没验证：B 建好后再 `tab.rename` 会不会抢焦点。

## 远程新建终端（已实现）

首页每个工作区标题右边有「+」。点一下：在这个工作区新建一个标签页，里面是登录 shell（`$SHELL -l`，和 Herdr.app 自己开的一样：`TERM=xterm-256color`、`COLORTERM=truecolor`、`TERM_PROGRAM=ghostty`），目录是这个工作区第一个终端的当前目录。建好后手机直接进入这个终端。想跑什么自己输入。

做法：`term.new {space}` → herdr-core `terminal.run`，带标签 `herdr.space`，`keep: true`。手机不能指定程序和参数。

验证：全链路测试（标签、`-l`、keep、能打开、未知工作区被拒）；无头 iPhone：点「+」→ 新终端 → 输入 `pwd; echo NEW_TAB_$((20+22))` 得到 `/private/tmp`、`NEW_TAB_42`，返回首页多一行；真 Herdr.app：herdr-relay 工作区标签页 1 → 2，Mac 焦点没动，结束后关掉，回到 1。
