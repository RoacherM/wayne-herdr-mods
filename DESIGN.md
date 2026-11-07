---
title: wayne-herdr-mods 设计与协议
description: 手机浏览器通过端到端加密中继或 WebRTC 直连操作本机 Herdr.app 终端，以及 Herdr.app 自定义界面（main-preview、my-tabs、my-files、wayne-phones）的完整架构与协议契约。
---

# wayne-herdr-mods 设计

> 2026-11-04 起项目叫 wayne-herdr-mods（旧名 herdr-relay）：手机网页和 Herdr.app 里的界面是一套东西，agent 照 `SKILL.md` 用它。命令、后台服务（`com.roacherm.wayne-herdr-mods`）、`~/.config/wayne-herdr-mods`、`~/.local/share/wayne-herdr-mods`、日志、钥匙串（`wayne-herdr-mods.voice`）、mod（`wayne-phones`）都改了新名字；`install` 把旧的配置搬过来一次（`host/main.js` 的 `migrateOld`）。故意不改的：中继地址 `herdr-relay.sir-housir.workers.dev` 和 Worker 名、加密协议里的 `herdr-relay/v1` 等标签（已配对的手机靠它们）、手机网页的 localStorage 键 `herdr-relay`（手机上的配对存在这里）、`ios/` 和 `shell/` 里的原型。

在手机浏览器里看和操作这台 Mac 上 Herdr.app 的终端和 agent。不用 Tailscale，不用 SSH，不开端口。做法照 `dsh-pair`（`~/Projects/sides/dsh-plugins/dsh-pair`）：Cloudflare 上放一个中继，电脑只往外连；同一网络下自动升级为 WebRTC 直连。

## 术语

- **herdr-core**：Herdr.app 底下的终端运行时，命令行叫 `hc`（本机 0.1.16）。所有终端（`t1`…`t9`）都活在它里面，Herdr.app 的窗口只是它的客户端。socket 在 `~/.local/state/herdr-core/default/default.sock`。
- **旧 herdr**：`~/.local/bin/herdr` 0.9.5 和它的 `herdr.sock`。Herdr.app 不用它（`herdr status` 显示 server not running）。herdrup、hackerchai/herdr-relay 都对接的是这一套，所以对我们没用。
- **viewer（观看者）**：一条 `terminal.attach` 流。Herdr.app 每个显示终端的地方是一个 viewer，手机也是一个 viewer。
- **observe viewer**：`observe: true` 的 viewer，只看，不能打字，也不影响终端尺寸。
- **尺寸主导者**：最近一次打字、改尺寸或获得焦点的非 observe viewer。终端的列数和行数由它决定，其余 viewer 看到的都是这个尺寸。
- **中继（relay）**：Cloudflare Worker + Durable Object，只转发密文，同一个 Worker 也托管手机网页。
- **宿主进程（host）**：Mac 上的 `wayne-herdr-mods` 后台进程，一头连中继，一头连 herdr-core。

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
| agent 卡住、结束、退出时推送 | 宿主订阅 `status` / `turn` / `finished` 事件 → Web Push / iOS 原生本地通知 | ✓ |
| 浏览工作区文件与低带宽预览（代码、文档、图片、视频） | 宿主受限文件沙箱 `files.roots` / `files.list` / `files.open` / `files.slice`（不暴露 `herdr-core` 任意 `file.*`） | ✓ |

手机不新建、不关闭终端，也不写 `herdr-app` 布局文档。第一版只看、只打字。

## 多个窗口怎么同步

这一节回答「我有多个窗口」的问题。下面的规则都是 probe 在独立的 scratch core 上实测出来的（`node probe/sync.mjs`）。

**1. 输出天然同步。** herdr-core 里一个终端只有一份屏幕。每个 viewer 拿到的都是同一份输出。Mac 两个窗口加一个手机，任何一方打的字，三方都同时看到。不需要我们做任何同步。

**2. 尺寸只有一个，谁最后动谁说了算。** 这是唯一的冲突点。手机如果用自己的尺寸（比如 44 列）去打字，它就成了尺寸主导者，Mac 上所有显示这个终端的窗口都会变成 44 列。Mac 窗口重新获得焦点或被拖动，尺寸就回来。手机断开时，尺寸自动交还给最近活动的 Mac 窗口。

### 手机布局（2026-11-04 改）

用的是第 2 条规则本身，不加开关：

| 谁在用 | 终端的尺寸 | 怎么发生 |
|---|---|---|
| 手机打开终端页 | 手机的格子（430pt 宽的 iPhone、12px 字约 57x55） | 宿主先用手机的格子 attach 一个打字 viewer（不是 resumed，所以它马上主导），再 attach 显示流。首屏就是手机尺寸，程序（Claude Code 等）按手机宽度重排 |
| Mac 上打字、拖窗口、点进这个窗格 | Mac 窗口的尺寸 | Herdr.app 的 viewer 成为最近活动者（`viewers.rs` `touch`）。手机收到 `size`，变回 Mac 的格子，左右平移看 |
| 手机再打字（或滑动全屏程序） | 手机的格子 | 每次输入前宿主重报手机的格子，手机又成为最近活动者 |
| 手机锁屏、切到后台、离开终端页 | 马上回到 Mac 窗口的尺寸，Mac 上不用动 | 手机发 `term.fit` 不带尺寸，宿主 detach 打字 viewer；回到页面再发尺寸 |
| 手机转屏 | 新的手机格子 | 页面尺寸变了就发 `term.fit` |

手机的每个终端在宿主里是两个 viewer（`host/phones.js` `openStream`）：

- **显示**：`observe: true` + `resize_notifications: true`。只看，从不改尺寸。herdr-core 改尺寸时，在这条流里先发 RESIZE 帧，再发新尺寸的整屏重画（`viewers.rs` `apply_size`；这个选项只对 observe 生效）。宿主把 RESIZE 原样转成 `size` 事件，和输出同一个顺序，手机先改格子再画后面的字节。
- **打字**：普通 viewer，尺寸是手机的格子（`fit`）。它自己收到的输出直接丢掉，信用立刻回给 core。
- 手机的格子按键盘收起时的高度算。键盘弹出不改尺寸（程序不用重画），页面跟着光标滚。

不闪的细节：

- **重连不抢、不让。** 中继 / 直连切换或重连时，旧流的打字 viewer 在宿主里保留 4 秒（`PARK_MS`），新流接手它。否则中间有一刻 Mac 主导，程序会重画两次。同一连接上重开同一个终端，新流也接手旧流的打字 viewer。
- **重连时 Mac 正在主导，就不抢。** 手机记得自己是否在主导（最后一次 `size` 是不是自己的格子）。不是的话，重开时带 `lead: false`，等手机下次打字再抢。
- 旧手机页（不带 `fit`）照旧：打字 viewer 第一次输入时才 attach，`resumed: true`，每次输入前重报 Mac 的尺寸，从不改尺寸。旧 herdr-core（没有 `resize_notifications`）也走这条，因为手机没法和字节同步地知道新尺寸。

以前有过「适配手机」开关（2026-11-03 删掉了：要手动切换）。现在不用开关：谁最后用，就按谁的尺寸。测法：`dev/layout-smoke.mjs`（Mac 窗口 160x50 在场；手机打开、Mac 打字、手机打字、重连 3 次（尺寸一直不变）、锁屏、回来、离开，每一步核对 herdr-core 里的尺寸）；`test/host.live.test.mjs` 在协议层测同一套。

**4. 打字的三条路，按用途选。**

- 原始按键：走 attach 流的 DATA，和本地键盘一样，大小写、粘贴都对。打字用这条。
- `terminal.send`：整句话，自动回车。它会等电脑上没人在打字再输入，Mac 和手机同时打字时不会把字搅在一起。「发给 agent」按钮用这条。
- `terminal.keys`：只给按钮用（Esc、Ctrl-C、↑↓、Tab、1/2/3）。probe 发现单个大写字母会被当成小写（`A` 变成 `a`，要写 `shift+a`），所以普通文字绝不走这条。

**5. 布局只读。** `herdr-app` 文档里是 space → tab → 分屏树，没有按窗口区分的字段，所有 Mac 窗口共用这一份（当前 v9：5 个 space，7 个 tab）。手机只读它来分组，并订阅 `doc` 事件刷新。手机不写它。即使将来要写，`doc.set` 带版本号，过期的写入会被拒（probe 验证：`conflict`），不会覆盖 Mac 的改动。

**6. 多台手机、多个标签页。** 每个手机连接在宿主里对应一条自己的 `hc connect`，各自订阅、各自 attach。一个手机断开只关它自己的流，不影响其他手机和 Mac。中继最多 8 个手机连接。

## 电脑上的确认

配对统一在 Herdr.app 里做：发二维码、显示核对码、允许或拒绝、移除设备。

| 入口 | 怎么打开 | 说明 |
|---|---|---|
| Herdr.app 的「手机」窗口（2026-11-04） | 标签栏右上角的手机图标；agent 用 `wayne-herdr-mods pair` 替人打开并显示二维码 | 列出配对的手机（在线、上次连接、推送），「配对新手机」显示二维码，手机来了显示核对码和「允许 / 拒绝」，「移除」点两次才删。关掉窗口时，还没人扫的二维码作废。下面「语音输入」一节：粘贴火山引擎 API Key 保存（输入框打码）、「试一次」（Mac 朗读一句再识别）、「换 Key」、「关闭」（2026-11-06）。 |
| 命令行 | `wayne-herdr-mods devices`（`devices rm <id>`） | 只列出、移除。配对只在 Herdr.app 里做（2026-11-04 起，终端里打二维码的方式删了）。 |

「手机」窗口是一个 Herdr.app mod（插件），叫 `wayne-phones`，在 `herdr-app/mods/wayne-phones/`。它是下面「Herdr.app 里的界面」的一部分。

- 它不直接连后台服务，只运行 `wayne-herdr-mods ctl <方法> <json>`。`ctl` 走后台服务的控制 socket：`status`、`pair.start`、`pair.cancel`、`pair.decide`、`devices.remove`、`watch`。`watch` 在有变化时返回，最多等 20 秒，所以窗口跟着手机上线、下线、来配对。有二维码时 `ctl` 顺带给出 `qrSvg`。
- 二维码写成 `~/.config/herdr-app/data/wayne-phones/qr-<到期时间>.svg` 再显示（`image()` 只读文件）。不写进 mod 目录：那里的文件一变 mod 就重新加载。
- 为什么不放进「设置」：Herdr.app 的设置页只有固定的几节，每次启动重写，mod 加不进去；要加只能改 Herdr.app 本身。所以入口是标签栏上的图标。

## Herdr.app 里的界面（2026-11-04）

手机网页和 Mac 上的 Herdr.app 是同一套东西。我们在 Herdr.app 里改的界面也放在这个仓库，`herdr-app/` 的目录结构和 `~/.config/herdr-app/` 一样：

| 文件 | 是什么 | 从哪来 |
|---|---|---|
| `layouts/main-preview.json`、`.svg` | 窗口布局：在 Herdr 自带的 `main` 上换了标签栏、文件面板和窗格框的顶栏（`my-pane`） | 复制自 `main` |
| `mods/my-pane/` | 窗格框的顶栏：标签里只有一个窗格（且没放大）时不显示放大按钮（放大没东西可盖）；文件标签显示文件名和所在文件夹，不显示「my-files」 | 复制自 `pane` 0.1.13 |
| `mods/my-tabs/` | 标签栏：右上角只留「+」、手机图标、一个面板按钮。标签的图标是你在这个标签里最后点进的 agent（2026-11-05 改：原来是标签里第一个 agent，一个标签里有 Claude Code 和 agy 时会显示错）。只有窗口当前的窗格有 `focused`，所以每个标签自己记住。agent 退出后前台回到 shell，图标就是终端（2026-11-05 改，见「agent 退出后的图标」） | 复制自 `tabs` 0.1.12 |
| `mods/my-files/` | 文件面板：只放文件树，每个窗格（window）各记一份展开的文件夹；点文件就把它开成一个 Herdr 标签（见下面「文件面板：每个窗格一份，文件开成 Herdr 标签」）。「复制路径」在树的每一行（悬停、右键）；「复制全文」2026-11-06 去掉（用户：没用）。`TextView.markdown` 的选区色绘制在文字上层，必须用带透明度的 `#rrggbb59`（约 35% alpha），否则实色选区会盖死选中的文字。纯逻辑在 `state.js`（`test/my-files-state.test.mjs`） | 复制自 `files` 0.1.12 |
| `mods/wayne-phones/` | 「手机」窗口和它的图标 `phone.svg` | 新写 |

### agent 退出后的图标（2026-11-05）

- 现象：epi 退出后，标签栏和手机列表仍显示 epi 的图标。
- 原因（`herdr-core` / Herdr.app，2026-11-05 实测）：agent 用 OSC 7501 报的状态在它退出后还留着。t25 前台是 `zsh`，状态仍是 `app=epi state=done`；Herdr.app 的 `panes()` 也仍给 `program.key=epi, agent=true`。
- 规则：前台进程是 shell（`zsh`、`bash`、`fish`、`sh` 等）时，agent 已经退出，忽略它留下的 `app`。
  - 标签栏 `my-tabs`：用 `terminals()` 的 `foreground.name` 判断；这样的窗格显示 `icons/shell.svg` 和 shell 的名字。
  - 手机列表 `host/terminals.js` 的 `project()`：`app` 为 `null`，图标是 `shell`。状态点不变。
- 活着的 agent 前台都是自己（`claude`、`agy`、`node …/epi`），不受影响。`dev/fake-desktop.mjs` 的假 agy 因此改用编译出的 `agy` 程序跑，不再用 `/bin/sh`。

- 改界面就改仓库里的文件，再运行 `node dist/wayne-herdr-mods.mjs install`。install 把 `herdr-app/` 打进 `wayne-herdr-mods.mjs`，写进 `~/.config/herdr-app/`，内容没变的文件不写（写了 Herdr 会重新加载那个 mod）。在 Herdr.app 里直接改的文件，下次 install 会被覆盖，要先复制回仓库。
- install 不切换布局。换一台 Mac，要在 Herdr 里选一次 `main-preview`（`herdr-app do layout.switch --name main-preview`）。
- 不放进来的：Herdr 自带的布局和 mod（每次启动重写），Herdr 自己写的 `gpui-kit.d.ts`、`jsconfig.json`，个人设置 `settings.json`、`keys.json`。
- 不加快捷键；2026-11-04 一次安装加在 `keys.json` 的 ⌘⇧M，搬配置时删掉。
- `wayne-herdr-mods uninstall` 只删「手机」窗口，布局和标签栏留着（那时标签栏的手机图标点了没反应）。
- 复制来的 mod 不跟着 Herdr 更新。Herdr 改了 `tabs` 或 `files`，要自己对比 `cloned_from` 的版本再合进来。

### 文件面板：每个窗格一份，文件开成 Herdr 标签（2026-11-06）

- 现象：在一个 tab 里打开 `build.mjs` 预览，换到别的 tab 或同一 tab 的另一个窗格，看到的还是它。
- 原因：`files` 0.1.12 记状态（展开的文件夹、预览的文件）用的键是文件夹路径。同一文件夹下的所有窗格共用一份。
- 规则：键里加上窗格（`state.js` 的 `locate`、`windowOf`）。窗格就是 tab 里的一个 window；布局里的终端块没有窗格，用 `terminal:<地址>` 代替。焦点在文件标签上时，面板是打开它的那个窗口的（`from`）。
- 点击规则（2026-11-06 第三版，用户选的）：面板只放文件树。点树里的文件，就把它开成一个 **Herdr 标签**，和终端标签排在同一条标签栏里。
  - 用 Herdr 自己的概念：`tab.new {name, mod: "my-files", props: {file, on?}}` 是「只有一个 mod 窗格的标签（a file, a board）」（herdr-app 0.1.13 AGENTS.md）。只有一个窗格的标签不画窗格框（`lone` 默认 false），所以没有分屏 / 放大 / 关闭这排按钮。
  - 同一个文件再点：切到已有的那个标签（`tab.select`），只找当前 space 的标签。文件标签记在 `shared("my-files/tabs")`（`{ [tab]: {file, root, on, from} }`）；`tab.new` 不返回 id，用前后标签列表的差找新标签（`newTabId`，没出现就每 50 ms 再看，最多 20 次）。关掉的标签下次写入时删掉（`withFileTab`）。
  - 回终端：点终端的标签。关文件：标签上的 ×。都是 Herdr 自己的，my-files 不再画 ⤢ / ⤡。
  - 文件标签里的 markdown 链接指向别的文件：也开成标签。树里高亮当前标签的文件。
  - 别的机器上的文件：`props.on` 带上机器名，预览在那台机器上读。
- 试过不做：
  - 第一版：面板里也能预览，开着全窗口视图时点文件才进全窗口。同一次点击有两种结果，用户觉得怪。
  - 第二版：在当前 tab 拆出一个 `my-files` 窗格并 `pane.zoom` 盖住终端，里面再画一排自己的文件标签和 ⤢ / ⤡。结果是标签套标签：Herdr 的窗格框（分屏、放大、关闭）在上面，自己的标签和 ⤡ 在下面，面板里还有一个 ⤡（2026-11-06 用户截图）。根因是没用 Herdr 的「标签」概念。
  - 把文件「拖」进终端对话框（2026-11-06）。herdr-app 0.1.13 的 mod 没有拖拽源（`gpui-kit.d.ts` 只有接 Finder 文件的 `on_drop` 和挪停靠面板的 `drag_tab`），也没有「打字但不回车」的命令（`hc send` / `terminal.send` 必定回车，hc 0.1.18）。退而做的「插入到终端」（文件放剪贴板 + `run("terminal.paste")`）用户试了有问题，已去掉。要做真拖拽得等 Herdr.app 给 mod 加拖拽源。
- 文件标签只有一层顶栏（2026-11-06，用户截图：文件标签里还有窗格框的放大按钮，且新标签插在当前标签后面）：
  - 布局框住每个窗格，只有一个窗格也框（`lone: true`，Herdr 自带的 `main` 也这样），框的顶栏原来是 Herdr 的 `pane` mod。换成我们的 `my-pane`：文件名、文件夹，悬停时分屏和关闭；标签里有别的窗格时才有放大。
  - my-files 在文件标签里不再画自己的标题行和边框，只留一行靠右的「预览 / 源码」和「用默认 App 打开」。面板顶栏没有按钮。
  - `tab.new` 把新标签放在当前标签后面；记下新标签后 `tab.move {id, index: 最后}` 挪到最右。
- 已验证（herdr-app 0.1.13，2026-11-06）：`herdr-app check` 通过；`test/my-files-state.test.mjs` 测找标签、忘掉关掉的标签、新标签 id、文件标签有焦点时面板不跳。**没验证**：真窗口里点文件开出标签、再点切回去（规则：不替用户点 live 窗口）。测试时不要往用户正在用的窗口发 `tab.new` / `pane.split`：两次调用之间焦点可能换到别的 tab（2026-11-06 一次分屏落进了用户的 tab 4，当场撤掉）。

### 图标跟着 Herdr.app（2026-11-06）

手机上的程序图标和 Herdr.app 侧栏、标签栏一样，新的 agent 不用在这里一个个加。

- Herdr.app 每个终端是什么程序、用哪个图标、要不要着色，只有它自己知道（内置程序表 + 用户的 `programs.json`）。常驻的标签栏 `my-tabs` 每 2 秒把 `terminals()` 里本机终端的 `program`（`key`、`icon`、`tint`）写进 `shared("wayne-herdr-mods.programs")`，内容没变不写。Herdr 把 `shared` 存在 `~/.config/herdr-app/shared.json`。
- 宿主（`host/terminals.js`）读这个文件（按修改时间缓存，`watchFile` 2 秒一查，变了就推给手机）：终端的图标 key 用 Herdr 的答案，图标文件和着色也用 Herdr 的；手机已经会用宿主发来的 `icons`。
- Herdr 没开、或者答案还没写到时退回旧做法：agent 报告的 `app` 或前台程序名，经 `ALIASES` 和 Herdr 自带 `new-menu` 缓存的 agent 表（`shared("new-menu.agents")` 的 `run` → `key`，`tint`）换成 key，再找 `icons/<key>.svg`。
- 前台是 shell 时一律是 shell 图标，不管 Herdr 上次怎么说（见上面「agent 退出后的图标」）。
- Herdr 不认识的 agent（例如 droid，2026-11-06）Herdr 自己也只显示通用的 agent 图标，手机一样。要专门的图标，在 `~/.config/herdr-app/programs.json` 里加一项（Herdr 自己的扩展点），手机自动跟上。试过不做：从 LobeHub 图标库自动下载——droid、factory 都没有（2026-11-06 unpkg `@lobehub/icons-static-svg` 404），还要联网、要改用户的 Herdr 配置。
- 终端页顶栏中间显示这个图标，不再显示 agent 的名字（名字只给读屏，`aria-label`）。图标 key 变了才换（列表刷新很频繁）。测法：`dev/fake-desktop.mjs` + 无头 iPhone 打开 claude 和 zsh 终端，顶栏分别是 Claude 图标和终端图标（2026-11-06）。

## 地址和域名

用免费的 `https://herdr-relay.sir-housir.workers.dev`。Worker 名 `herdr-relay`，部署后这个地址自动就有，`wrangler.jsonc` 里不写 `routes`。`dsh-pair` 已经在同一个账号下用 `dsh-pair-relay.sir-housir.workers.dev`。

`workers.dev` 在大陆不开代理时经常打不开。手机打不开时，再给账号加一个自己的域名，在 `wrangler.jsonc` 里加一行：

```jsonc
"routes": [{ "pattern": "herdr.<域名>", "custom_domain": true }]
```

换地址的代价：手机网页、配对链接、Web Push 订阅和手机密钥都绑在地址上，所以每台手机要重新扫码配对一次，并重新添加到主屏幕。

## 直连（WebRTC，已实现）

中继在 Cloudflare，手机到 Mac 一次往返约 230 ms（本机实测：经中继 p50 229 ms）。直连时数据点对点走，本机实测 p50 0.4 ms。

```
1. 手机 ──中继（已加密、已认证）──▶ Mac   rtc.offer {sdp}  →  {sdp}（answer）
2. 手机 ◀──────── WebRTC 数据通道 ────────▶ Mac
3. 在数据通道上重新做一次握手和设备认证（跟中继连接完全一样），Mac 把它当作连接 rtc:<n>
```

- **谁能发 offer**：只有已经认证的手机（`rtc.offer` 在白名单里，只在 ready 之后能调）。数据通道上不认证就什么都做不了。
- **两层加密**：WebRTC 自己的 DTLS，加上我们自己的端到端加密。
- **地址**：不逐个交换地址（不 trickle），offer 和 answer 里一次带全。手机的局域网地址被浏览器藏成 `xxx.local`（mDNS），Mac 端的 werift 会去解析；解析不了，也能从手机发来的连通检查里学到地址。STUN 用 `stun.cloudflare.com:3478`。
- **分片**：数据通道上一条消息最多 16 KB（`shared/pieces.js`），长消息分片发。
- **切换**（`app/src/direct.js` 的 `Duo`）：
  - 中继连上后 0.5 秒试直连。成功后所有调用都走直连，正在看的终端在直连上重新打开；中继那条连接收到 `link.idle`，关掉它的流，留着备用。
  - 直连每 5 秒 ping 一次，15 秒没回音就算断。断了马上回到中继，终端在中继上重新打开；之后 3 秒、15 秒、1 分钟、5 分钟再试。
  - 打不通（比如手机在蜂窝网络、Mac 在 NAT 后面）就一直用中继，跟以前一样。
- **看得到**：首页状态写「已直连」或「已连接」（中继）。`localStorage['herdr-relay.direct'] = 'off'` 只用中继，用来对比。
- **主机端**：`host/rtc-link.js`，用纯 JS 的 werift（不用原生模块），打包进 `dist/wayne-herdr-mods.mjs`（打包后 1.5 MB）。最多 6 条直连，多了关最旧的。

测试：`test/rtc-link.test.mjs`（主机端，werift 扮手机），`dev/rtc-smoke.mjs`（无头 Chrome，10 项：自动直连、终端、83 KB 回复分片、断开退回、再直连、关掉直连）。

真机：2026-11-03 在 iPhone 上的 **Chrome** 里打通，首页显示「已直连」。iPhone 上的 Chrome 也用 WebKit 引擎（苹果要求，欧盟以外），WebRTC 和 Safari 是同一套，所以 Safari 很可能也行，但没直接试过。蜂窝网络下能不能打通也没试过。

## 安全

- 配对过的手机能往终端打字，权限等于这台 Mac 的 shell。所以必须配对确认，设备可以单独移除，状态文件权限 0600（`~/.config/wayne-herdr-mods/state.json`）。
- 中继只见密文和连接时间、大小这类元数据。
- 推送只发概要（「t6 claude-code 等你确认」），不发终端内容。
- herdr-core 的 socket 没有密码（官方文档说不要转发给不信任的人），所以宿主进程只把上面表格里的接口转给手机，不转发任意 RPC。`machine.exec`、`file.*`、`terminal.run`、`server.*` 一律不开放。
- 文件浏览与预览接口（`files.*`）是纵深防御边界：只允许读取当前 `herdr-core` 工作区与终端所在目录（若某个终端的 `cwd` 在 `~`，则该终端对应的根目录即包含 `~`），每次访问均通过 `realpath` 校验不越出该根目录并屏蔽 `.git` 内部文件。

## 目录

目录边界和「放进这里的判断标准」见 `AGENTS.md` 第 1 节；这里只记每个目录的来历。

```
shared/      e2e.js 从 dsh-pair 复制；pieces.js（直连分片）、coast.js、wheel.js 新写
relay/       从 dsh-pair 复制：Worker + DO + 静态网页（relay/public 是 app/ 的构建产物）
host/        新写：中继连接、配对、hc 适配、推送、语音、命令行；打包成 dist/wayne-herdr-mods.mjs
app/         新写：手机网页（终端列表 + xterm.js 终端页），build 到 relay/public
herdr-app/   Herdr.app 里我们的界面；build 时打进 dist/，install 写到 ~/.config/herdr-app/
SKILL.md     给 agent 的用法；`--skill` 打印它，install 装进 ~/.agents/skills/wayne-herdr-mods
test/        npm test：单测 + host.live.test.mjs（全链路，自己起临时中继 test/local-relay.mjs）
dev/         需先起东西的冒烟与跑分：fake-desktop.mjs（假 Mac）、*-smoke.mjs（无头 iPhone）、bench.mjs
probe/       herdr-core 行为探针：hc.mjs（分帧客户端）、sync.mjs、create.mjs、credit-window.mjs、wheel-batch.mjs
bench/       results.jsonl：每次跑分每条路径一行，带 commit（report.html 不提交）
ios/         nsh 原生 Herdr iOS App（App.tsx + host/ Swift 宿主，见「原生 App（nsh）」）
shell/ios/   原型：WKWebView 薄壳 + install.sh（已停）
docs/        issues/（待办队列）、native-app.html（I-004 的设计原型）
.scratch/    排查数据、临时截图（不提交）
```

后台常驻：`~/Library/LaunchAgents/` 下放一个 LaunchAgent，复制安装，不用软链接。它不启动、不重启 Herdr.app 和 herdr-core；herdr-core 不在时只报离线，等它回来再连。

## 验证

| 步骤 | 内容 | 结果 |
|---|---|---|
| 1 | `probe/sync.mjs`：herdr-core 多 viewer 规则 | 21/21 过 |
| 2 | `test/host.live.test.mjs`：真宿主 + 本地中继 + 模拟手机 + scratch core。配对、列表、首屏、Mac 打字手机看到、手机打字 Mac 看到且尺寸不变（不带 `fit`）、5 MB 输出（credit 不卡）、发送框、快捷键、白名单外方法被拒、手机布局（`fit` / `term.fit`：手机、Mac、离开、转屏、乱填的尺寸）、断开后用同一设备 resume | 过 |
| 3 | `dev/ui-smoke.mjs`：无头 Chrome 模拟 iPhone，连 `dev/fake-desktop.mjs`。欢迎页、首页分组、「需要你」、终端页、按 1 回答菜单、shell 打字、设置、深色 | 过，截图在 dev/shots，无页面错误 |
| 4 | 部署后在真 iPhone 上扫码，在 Herdr.app 的真实 agent 终端上操作一次 | 2026-11-02 过：iPhone 配对成功，从手机给 Herdr.app 里正在运行的 Claude Code 发了一条消息，agent 收到了 |

本地跑法：`npm test`（`host.live.test.mjs` 自己起一个临时中继；要用自己的中继就设 `RELAY=http://127.0.0.1:8799`）；看界面：`node dev/fake-desktop.mjs` 打印配对链接，`node dev/ui-smoke.mjs "<链接>"`。

## 画面不闪（2026-11-04）

用 `dev/flicker-smoke.mjs` 逐帧数（xterm 每画一帧就检查一次画出来的缓冲区）。程序把自己的尺寸和一条同宽的标尺画在屏幕上；测试自己扮成一个 Mac 窗口，把终端尺寸改 12 次；然后同一页面重开终端（和中继 / 直连切换、重连走同一条路）。

| 问题 | 原因 | 改法 | 改前 | 改后 |
|---|---|---|---|---|
| Mac 拖窗口时手机花屏 | 尺寸从事件通道来，字节从流里来，两边不同步 | 显示流用 `resize_notifications`，`size` 和输出同序；手机收到 `size` 先开同步输出（DEC 2026，xterm 暂停绘制），改格子，等整屏重画画完再画 | 23 帧里 12 帧坏 | 0 |
| 重开时闪白、闪半屏 | 先 `xterm.reset()` 清空，再等首屏过网络 | 不 reset。herdr-core 的每次整屏重画都以 `CAN ESC[!p ESC[?2026l` 开头：手机把这个「同步关」换成「同步开」，结尾再关（`app/src/paint.js`），一帧换完。重开时历史在重画切回主屏幕之后清掉，由重画补回，不丢不重 | 1 帧坏 | 0 |
| emoji 后面的字错位 | xterm 默认按 Unicode 6 算宽度，Ghostty 按新标准、VS16 变宽 | `@xterm/addon-unicode-graphemes`。测法：程序问 herdr-core 里的 Ghostty 光标在哪（`ESC[6n`，core 自己回答），手机必须把 `|` 画在同一列 | 👍 🤖 ⚠️ ✍️ 差 1 格 | 19 种字符全对 |
| 大的重画拆成几条消息，可能画半帧 | herdr-core 每帧最多 16 KB | 宿主把输出攒 4 ms 合成一条再发 | 没单独测 | 重画整条到达（上面两项依赖它） |

尺寸变大时，程序重画之前会有一两帧「旧画面在大格子上」。这是 herdr-core 自己屏幕的真实样子，Mac 上也一样，测试单独计数，不算坏帧。

## 重印整段对话（2026-11-05）

**现象。** 手机打开一个长对话，先看到对话从头往下滚，过好几秒才看到输入框。

**原因。** 不是首屏慢。首屏是 herdr-core 给的「当前屏幕 + 400 行历史」，几十 KB，马上到。慢的是之后：手机按自己的格子主导尺寸（57 列），用主屏幕的 agent（Antigravity 的 `agy` 等，不用备用屏幕）收到尺寸变化后，先清掉回滚历史（`ESC[2J ESC[3J`），再从第一句开始把整段对话重印一遍。长对话有几 MB。

- herdr-core 每个流只有 256 KB 信用（credit），落后超过 4 MB 才改发新的一屏。所以几 MB 的重印会整段走中继，每一轮都等手机确认。
- `agy` 把重印包在同步输出里（`ESC[?2026h … l`）。但 xterm 最多等 1 秒，到时间就把已经到的部分画出来。所以你看到的是从顶上开始滚。
- Mac 窗口改尺寸时也一样：程序按 Mac 的宽度重印，整段发到手机。

**改法（`host/phones.js` `reprint()`）。** herdr-core 自己的重画从不清回滚历史。所以程序输出里出现 `ESC[3J`，就说明后面是重印。

1. 从这里起（连同前面紧挨着的 `ESC[2J` / `ESC[H`），宿主先扣住输出。手机上的旧画面不动。
2. 程序安静 100 ms（最多等 1 s）后：扣住的不超过 64 KB（比如 shell 的 `clear`），原样发出。超过 64 KB，就丢掉，再 attach 一次显示流。herdr-core 新给的首屏就是重印的结尾：当前屏幕 + 400 行历史。
3. 这一条 `out` 带 `fresh: true`。手机先清掉旧历史，再在一帧里画完（`paint.js` `clearHistory`）。

记录：每次超过 16 KB 的重印，Mac 写一条 `reprint`（`kb` 大小、`fresh` 是否换成新首屏、`ms` 从开始重印到新画面），进体验记录，报告页的「全部数字」里有 `reprint.kb` 和 `reprint.ms`。

代价：手机上能往回翻的历史，从「整段对话」变成最近 400 行。整段历史还在 Mac 上，程序里也能翻。

**测法。**

| 场景 | 改前 | 改后 |
|---|---|---|
| `agy` 1500 行对话，手机按 57x55 打开（真宿主 + 本地中继） | 645 KB，从头重印 | 61 KB，1 次 fresh，311 ms 收完 |
| `test/host.live.test.mjs`：`clear` 后打印 2 万行 | 超时（没有 fresh） | 只收到结尾，不到 120 KB |

单元测试：`test/paint.test.mjs`（无界面 xterm 实际执行字节：同步开关的位置；主屏、备用屏、程序在断线期间进出全屏，历史都不丢不重）。兼容：新手机页 + 旧宿主（没有 `sized`）回到旧做法；旧手机页 + 新宿主照常工作（忽略 `size`）。`ios/` 的 nsh 原型还是旧做法。

没验证：真 iPhone + Cloudflare 中继（约 230 ms）上的手感；Safari 的 WebKit 里的同步输出（xterm 自己实现，不依赖浏览器，预计一样）。

## 体验记录（2026-11-04）

目的：手机上的体验要能量出来，每次改动后知道是变快还是变慢。三部分：

| 部分 | 在哪 | 做什么 |
|---|---|---|
| 手机自动记录 | `app/src/metrics.js` | 手机网页一直记下面的事件，每 15 秒、页面隐藏时，用 `metrics.put` 发给 Mac |
| Mac 存储 | `host/metrics.js` | 每条一行 JSON，写进 `~/.config/wayne-herdr-mods/metrics/YYYY-MM-DD.jsonl`，保留 30 天 |
| 报告页 | `host/metrics-report.js` | `wayne-herdr-mods metrics` 生成一个 HTML（不联网），按路径分开看中位数和慢的尾巴 |
| 模拟跑分 | `dev/bench.mjs` | 无头 Chrome 模拟 iPhone，连 `dev/fake-desktop.mjs`，按固定脚本操作，结果写进 `bench/results.jsonl` |

术语：

- **p50**（中位数）：一半的次数比它快。
- **p95**：最慢的 5% 从这里开始。体验差通常在 p95，不在 p50。
- **路径**：手机到 Mac 的通道，「直连」（WebRTC）或「中继」（Cloudflare Worker）。

事件（手机只记时间和种类，不记屏幕内容，不记打了什么字）：

| 事件 | 字段 | 从哪到哪 |
|---|---|---|
| `echo` | `net`、`paint` | 在安静的终端里按一个键（之前 300 ms 没有输出）→ 第一段输出到达 / 画到屏幕上（xterm 画完后的下一帧） |
| `open` | `ms`、`again` | 点开终端（`again`：重连后重新打开）→ 第一屏画出来；15 秒没画就不算 |
| `resume` | `away`、`ready`、`paint` | 切回页面 → 连接可用 → 终端画出来；5 秒内没有新画面（屏幕本来就对），`paint` 是 null |
| `rtt` | `ms`、`n`、`ice`、`pair` | 一批记录发到 Mac 再收到回复：顺便量一次往返（含连接里的排队）。直连时再加 WebRTC 自己量的网络往返 `ice`（不含排队）和路径种类 `pair`（`host` 同一个网络、`srflx` 穿过 NAT、`relay` 走 TURN；不记地址）。`ms` 远大于 `ice`：慢在我们的排队；两个都大：慢在网络 |
| `link` | `status` | 连接状态变化：数断线 |
| `scroll` | `mode`、`ms`、`n`、`p95`、`long`、`steps`、`coast`、`lag`、`lagMax`、`answered`、`kb` | 一次滑动（加惯性）：帧间隔的 p95 和超过 50 ms 的帧数；全屏程序里每个滚轮步到「程序回应它的画面」画出来的延迟（见「滑动延迟」）。旧记录叫 `frames`，只有帧间隔 |
| `macscroll` | `steps`、`coast`、`prog`、`progMax`、`kb`、`behind`、`ms` | Mac 自己记（`src: mac`）：一次滑动里写给程序的滚轮步、程序回应用时、程序输出多少、最多有多少字节在路上 |
| `op` | `op`、`key` | 用了什么：按键栏的键（记键名）、粘贴、语音、图片、打开、返回 |

规则：

- Mac 按白名单检查每个字段（事件名、类型、字符串最长 40）。不在名单上的字段丢掉，类型不对的整条丢掉。一批最多 500 条。设备 id 只存前 8 位。
- 手机连不上 Mac 时最多攒 400 条，旧的先丢。Mac 不认识 `metrics.put`（旧版本）时也只是攒着，不报错。
- 页面版本：build 时写进 `__APP_V__`（`<commit>[+]·<build>`，`+` 表示有没提交的改动），每条记录带着，方便按版本对比。
- 报告用 dataviz 的配色：直连蓝、中继橙，浅色和深色都过了校验；每条线有文字标签，不只靠颜色；每个数字都在表格里有。

模拟跑分的脚本（每条路径一样）：反复打开终端；一次按一个键（间隔 450 ms + 2×延迟，保证终端是安静的）；按键栏 ↑ ↓；上下拖动终端；切到别的标签页再回来，长的那次让连接以为睡了很久（和 iOS 后台回来走同一条路：`link.js wake()`）。路径：直连、中继、中继 + 150 ms 往返（WebSocket 的每条消息各方向延迟 75 ms，模拟离中继远的手机网络）。中位数比上次同一路径慢 20% 以上且多于 10 ms，退出码是 1。

不用 Chrome 的页面冻结（`Page.setWebLifecycleState frozen`）模拟后台：解冻后页面一直是隐藏状态，不再出帧，量出来的不是真的。

第一次跑分（2026-11-04，本机，每格 p50 / p95，毫秒）：

| 路径 | 打字到看见 | 打开终端 | 长时间离开后回来：重连 / 画出来 | 往返 | 滑动慢帧 |
|---|---|---|---|---|---|
| 直连 | 12 / 31 | 17 / 29 | 25 / 49（走中继，见下） | 3 / 9 | 17 / 18 |
| 中继 | 12 / 31 | 23 / 34 | 24 / 56 | 4 / 6 | 18 / 18 |
| 中继 + 150 ms | 161 / 167 | 176 / 185 | 410 / 758 | 156 / 157 | 17 / 17 |

读法：

- 本机上，打字到看见约 12 ms，其中数据到达约 8 ms，画只多约 4 ms。网页本身不是瓶颈。
- 延迟 150 ms 时，打字和打开都约等于一个往返，没有多余的来回。
- 长时间离开后回来要约 5 个往返。离中继远时这是最慢的一步。拆开看：

  | 步骤 | 往返 |
  |---|---|
  | 中继说「电脑在线」 | 0.5 |
  | 握手 hello → welcome | 1 |
  | 手机发 auth → Mac 回 ready | 1 |
  | 刷新终端列表 | 1 |
  | 重新打开终端 → 画出来 | 1 |
- 直连的手机睡醒后先用中继，直连过一会儿才回来。
- 短暂离开（0.8 秒）后屏幕本来就是对的，什么都不用重画，`paint` 是 null；所以「回到页面」的数字只来自要重画的那几次。

优化一（2026-11-04）：省掉两个往返。

1. **Mac 提前回 ready**（`host/phones.js`）：握手时 Mac 已从 hello 认出手机的公钥。认识的手机，`ready` 紧跟 welcome 一起发，不等 auth。安全上不变：`ready` 用会话密钥加密，密钥里有手机私钥参与的 DH（`dhPEd`），只有持有手机私钥的一方能读。手机接着发的 auth 是证明：收到之前，这台手机不算在线，发来的任何东西也不处理（重放一个旧 hello，只能拿到一条读不了的 `ready`）。旧版手机网页照常工作：它收到 `ready` 只是早了一个往返。已配对的手机又扫了一次码，也按「已配对」直接放行（手机端 `pairing` 标记照样保存这台电脑）。
2. **重连后先打开终端**（`app/src/main.js`）：重新打开终端和刷新列表同时发，不再一个等一个。

结果（中继 + 150 ms）：长时间离开后回来，重连 410 → 260 ms，画出来 738 → 430 ms。其他测量没有变慢。`test/host.live.test.mjs` 检查：`ready` 在 auth 之前到达；auth 之前不在线；auth 之后请求有回应。

剩下的 0.5 个往返（等中继说「电脑在线」）要改中继协议，没做。真实网络上还要加 TCP 和 TLS 握手（模拟里没有），所以真机上的数会更大，要看手机的真实记录。

## 滑动延迟（2026-11-04）

用户反馈：在全屏程序（Claude Code）里滑动「不跟手」，不卡，但有延迟。

真机记录：滑动时帧间隔 p95 = 18 ms，手机画得不慢。但直连往返 p50 = 433 ms，滑动中有一次 2493 ms。

原因：手指每移一行发一个滚轮步，程序回应一段画面。每步重画一整屏（几 KB）的程序最糟。重画的数据比网络带得快，就在路上排队。herdr-core 给每个查看者 256 KB 的窗口（`probe/credit-window.mjs` 测的），落后时它按顺序补发旧数据，不跳到最新画面。所以屏幕显示的是几百毫秒到两秒前的画面。

怎么量（都写进体验记录）：

- 手机的「滑动到画面跟上」（`scroll.lag`）：两边用同一个办法数滚轮步（`shared/wheel.js`）。Mac 在每段输出上标 `w`：这段输出开始时，程序已经收到了手机的第几个滚轮步。手机记下每一步的发送时间，画出 `w` ≥ 这一步的第一屏时算一个延迟。只看「下一段输出什么时候到」不行：排队的旧画面也会到，延迟会显得很小。
- Mac 的 `macscroll`（`host/scroll-watch.js`）：程序回应滚轮要多久（`prog`，不含网络），最多有多少字节发出去了但手机还没画完（`behind`）。两个合起来，能分清慢在程序还是在网络。

怎么改（`host/phones.js`）：Mac 控制滚轮步的节奏。

- 在路上的数据超过 12 KB，或者上一步程序还没回应（最多等 100 ms），新的滚轮步先攒着；条件满足时一次交给程序。程序读到一批，只重画一次。
- 步子不丢、顺序不变；打字等其他输入来了，先把攒的步交出去，再交这次的输入。松手后的惯性（Mac 跑的）也走同一条路；手指再按下时，攒着的惯性步作废。
- 手机画完 8 KB（或 30 ms 内）就确认一次（原来要 32 KB），Mac 才知道手机画到哪了。旧版手机网页照常工作，只是确认得粗一些。

结果（`node dev/bench.mjs --scroll`，`dev/scroll-app.py` 模拟每步重画整屏的全屏程序；每格 p50 / p95，毫秒）：

| 路径 | 改之前：跟上 | 改之后：跟上 | 改之前：最大落后 | 改之后：最大落后 | 在路上最多 |
|---|---|---|---|---|---|
| 中继（本机） | 18 / 52 | 18 / 34 | 68 | 68 | 51 → 10 KB |
| 中继 + 150 ms + 1 Mbit/s | 318 / 1835 | 285 / 318 | 2636 | 469 | 231 → 21 KB |

慢网下 p50 接近下限：一个往返（150 ms）加一屏的传输时间。再往下要么网络更快，要么在手机上先挪画面（以前试过，「先挪、等重画到了再弹回」不好，没再做）。

Claude Code 自己怎么回应（`probe/wheel-batch.mjs`：复制一个旧会话，在临时的 core 里打开，60×40）：

| 发法 | 程序写回 | 分几段 |
|---|---|---|
| 1 步 | 约 240 字节 | 1 |
| 20 步，一步一写，间隔 8 ms | 8–10 KB | 19 |
| 20 步，一次写 | 6–9 KB | 4–8 |

- Claude Code 每步只写约 450 字节（只更新变了的部分），不是整屏。合起来写不省字节（它自己做平滑滚动），只少了分段。合并写它照常接受。
- 所以在 Claude Code 里，只有网络慢到每秒带不了几十 KB 时才会排队。网络正常时，滑动的延迟主要就是一次往返：滚轮步到 Mac，画面回手机。
- 真机（2026-11-04 下午，旧版网页）直连的往返是 433–609 ms，滑动中有一次 2493 ms。这比同一个 Wi‑Fi 下应有的几十毫秒大得多。`rtt` 里含我们的排队，分不清是网络慢还是排队，所以 `rtt` 加了 `ice` 和 `pair`（见上表）。下一批真机记录会说明慢在哪。

## 终端页怎么显示

字号固定 12px（看得清）。平时终端就是手机的格子（见「多个窗口怎么同步」第 3 条），不用平移。Mac 在主导时，终端是 Mac 的列数和行数：110 列在 430pt 宽的 iPhone 上约 807px 宽，手机先显示左边约一半，左右滑动看其余部分（浏览器原生横向滚动，`touch-action: pan-x`）。不用 CSS 缩放：xterm 从 DOM 量字格，缩放会量错。

**跟随最新，和终端一样（2026-11-04 改）。** Mac 窗口常比手机高（例如 Claude Code 在 267x58 的窗口里，输入框和状态栏在第 55–57 行，手机一屏只有约 39 行）。规则：

- 画面停在最新处（最后一行有字的行和光标都在屏幕里）时，有新输出就一直跟着。
- 手指往上翻，就停下，右下角出现 ↓。翻回最新处，或点 ↓，就恢复跟随。打字、点快捷键也恢复。
- 左右平移只影响左右，不停止上下跟随。平移后左右不再跟光标，下次打字再跟。

改前：手指一碰（`touchmove`）就永久停止跟随，手机只显示终端上半部分，输入框和状态栏看不到，不像终端。测法：`dev/follow-smoke.mjs`（160x100 的 Mac 窗口里画 Claude Code 形状的画面，每 300 ms 一行新输出；检查首屏、平移后、上翻后、点 ↓ 后看到的行）。

**⏺ 画成字，不画成 emoji。** Claude Code 每条回复前的 ⏺（U+23FA）默认是文字样式，Ghostty 画成一格的圆点。iOS 没有带这个字的文字字体，WebKit 退到 Apple Color Emoji，画成蓝色按钮（真 iPhone 和 iOS 模拟器都能看到；Mac 上的 Chrome 有文字字体，看不出来）。手机写入 xterm 前，在 ⌨ ⏏ ⏭ ⏮ ⏯ ⏱ ⏲ ⏸ ⏹ ⏺ 后面补 VS15（U+FE0E，「按文字画」），已经带 VS15 / VS16 的不动（`app/src/text-style.js`，`test/text-style.test.mjs`）。xterm 仍算一格，`dev/flicker-smoke.mjs` 的 19 种宽度仍全对。

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
- 用键盘自己的收起键收起后，页面回到全屏（见「键盘弹出和收起」）：原因在真机上量过，修法只在单测里用真机的数字验证过，真机待验证。
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
| 密钥 | 「手机」窗口的「语音输入」一节，或 `wayne-herdr-mods voice key`（从标准输入读入），都存进 macOS 钥匙串（`security add-generic-password`），不进 state.json、不进日志。窗口经 `ctl voice.set / voice.test / voice.off` 交给后台服务，`status` 只带 Key 末 4 位（`voice: "…32e5"`）。新 Key 下一次识别就生效；手机要重新连接才显示麦克风键。命令行 `voice key / off` 在后台服务运行时也走 `ctl`（Key 走 0600 的控制 socket），没运行时直接写钥匙串。
- Key 出现在哪里（2026-11-06 独立审查后改）：`security` 从标准输入读 Key（`-w` 放最后，它问两遍，macOS 27.0 实测），不在它的参数里。工具失败时的报错只写工具名、退出码和它的 stderr，不写参数（Node 原本的报错带整条命令行，钥匙串锁着时会把 Key 显示在窗口里；`test/voice.test.mjs` 测这一条）。还剩一处：Herdr mod 的 `exec` 没有标准输入，mod 也不能写 `~/.config/wayne-herdr-mods/`（沙箱只给自己的目录，2026-11-06 用探针 mod 实测），所以窗口把 Key 放在 `wayne-herdr-mods ctl voice.set` 的参数里。这个进程活约 1 秒；这期间这台 Mac 上任何本地账户都能用 `ps` 看到（`/bin/ps` 是 setuid root），记录进程命令行的监控软件也会记下。单人用的 Mac 可以接受；介意的话用命令行 `voice key`，它从终端读 Key。
- 状态只显示 Key 末 4 位；8 位以下的 Key 一位也不显示。「试一次」朗读固定的句子，20 秒内结束（mod 的 `exec` 最多等 30 秒）。没配 key 时 `ready` 里 `voice: false`，手机不显示麦克风键。 |
| 结果 | `voice.done {id}` 返回文字，填进发送框，不自动发。 |
| 限制 | 单条 ≤ 2 MB、≤ 120 秒；每台手机同时只识别一条；识别完立刻删音频。 |

**切到后台再回来，录音失败（2026-11-05 修）。** 现象：手机提示「上传已过期，请重试」，要刷新页面才好。

- 原因 1（主要）：手机复用同一个麦克风流（`app/src/voice.js` `acquireStream`），这样 iOS WKWebView 不会每次都问权限。切到后台时 iOS 打断录音，回来后这个流的状态还是 `live`，但被静音（`muted`）。录出来是 0 字节。0 字节不会上传，于是 `upload()` 返回空 id，Mac 找不到这个上传，就说「已过期」。只有刷新页面才会丢掉旧流。证据：2026-11-05 07:26–07:29 手机记录了 6 次按住说话，Mac 日志里一次识别都没有。
- 改法：被静音的流不复用，录到 0 字节的流也不复用，下次按下时向系统要一个新的。0 字节不再上传，提示「没录到声音：麦克风被系统打断了，请再按住说一次」。
- 原因 2：上传的分块存在 Mac 的「这条连接」上。手机在中继和直连之间切换，或者重连，分块就找不到了，也报「已过期」。改法：按手机（设备）存，换连接也能找到。
- 记录：每次录音写一条 `voice`（`kb` 大小、`ms` 时长、`muted` 开始时是否静音、`err`：`null` 成功，`silence` 没听清，`empty` 0 字节，`expired`、`timeout`、`link`、`other`）。
- 测法：`test/voice.test.mjs`（静音的流被换掉、0 字节不上传）；`test/host.live.test.mjs`（分块在一条连接上传，在下一条连接上用）。两个测试在旧代码上都失败。iOS 真机上切后台的行为没有自动测，是从记录推断的。

备选（不做，除非云端用不了）：本地 whisper.cpp。本机 M5 Pro 实测 9.7 秒中文，热启动 0.6 秒；中文对，英文词会被拆开（`npm` → `N,T,M`）。模型在 `~/.local/share/herdr-relay/models/`（574 MB；改名时没搬也没删，留在旧目录），不用就删。

参考：火山引擎接入说明 https://docs.volcengine.com/docs/DoubaoVoice/Accessmust-read?lang=zh ；极速版字段对照了社区实现 https://github.com/lanbinleo/bili2text （src/b2t/transcribers/volcengine.py）。官方极速版页面里只找到旧版 v1 submit/query 接口，v3 flash 的字段是从接入说明和社区实现交叉得到的，第一次真实请求前都算猜测。

## 原生 App（nsh）：评估 + 第 0 步原型（`ios/`）

> **2026-11-07 改：做 nsh 原生 App（用户决定）。** 起因：iOS 网页里键盘的问题只能绕（见「键盘弹出和收起」），薄壳 App 用的也是同一个 WebKit，绕不开。原生 App 里键盘、输入行、键盘栏、语音按钮都是原生控件，网页视图只负责画终端、从不拿焦点。
> - 账号：只用免费 Apple 账号，不上架，不做推送。App 每 7 天要从 Mac 重装（`ios/host/install.sh`）。通知仍走主屏幕 Web App 的 Web Push。
> - 终端画面：先用 WebView 里的 xterm.js（换 WebGL 渲染），接口保持窄（原生 → 页面 `size/out/reset`，页面 → 原生 `ready/ack/input`），以后真不够顺再换原生组件。依据：手机实测画一个字中位数 8 ms、p95 25 ms，滑动帧间隔中位数 18 ms，慢的是网络（打开终端中位数 1.6 秒）。
> - 语音：继续经 Mac 用火山（热词、拼写还原），录音由 Swift 宿主做。
> - 多台 Mac：做进原生 App，网页版不加。
> - 结构：`ios/App.tsx`（nsh 界面）+ `ios/host/`（Swift 宿主：xcodegen 工程，链接 `NativeShell.xcframework`，`NshAppView.loadBundle` 运行 `nsh build` 的产物；`handle(name)` 给 App 调录音、扫码、震动反馈）。
> - 进度（2026-11-07，nsh 0.4.0 `e626a8d`，Xcode 26，iOS 27）：
>   1. **终端画面对齐网页版**（`ios/term/term.js`）：Unicode 15 graphemes 宽度（`@xterm/addon-unicode-graphemes`）、`paint.js` 同步重绘不闪（`sized` + `atomic` + `SYNC_ON` + `fresh` 重印处理）、`text-style.js` 补 VS15（`⏺` 等字符）、手机自适应格子（`fit` / `term.fit`，键盘弹出不重算行数）、全屏程序滑动惯性交给 Mac（`term.coast`）与「回到最新」`↓` 按钮、8 KB / 30 ms credit 确认。
>   2. **键盘栏、输入浮泡、图标与圆润黑白灰设计**（`ios/App.tsx`、`ios/theme.json`、`ios/build-term.mjs`、`ios/term/term.js`）：`build-term.mjs` 同步 `~/.config/herdr-app/icons/` 全量 123 个 Agent/程序 SVG 图标并生成 `ios/src/prog-icons.ts`；全应用采用与网页版（`app/src/app.css`）一致的圆润黑白灰视觉（`rounded-[20px]` 卡片、`rounded-full` 胶囊按钮与标签、底栏圆形 `＋`/`⌨` 与胶囊 `按住 说话`、悬浮 `.term-bubble` 输入泡）；首页提供顶栏原生 `headerRightSymbol: "gearshape"` 与页内圆角状态卡双入口进入设置页；终端页在 `WebView` 测出手机格子（`ready` + `fit`）后再发 `term.open`，保证首屏自适应手机宽度；宿主配备圆润包豪斯几何色块 + 极简线条重绘的 Herdr 小羊与 Relay 信号波主屏幕图标（`ios/host/Sources/Assets.xcassets/AppIcon.appiconset/AppIcon.png`）。
>   3. **Swift 宿主能力与状态通知**（`ios/host/Sources/App.swift`、`ios/src/conn.ts`）：`voice.start / level / stop / cancel`（`AVAudioRecorder` 16 kHz 单声道 AAC `.m4a`，分块 `upload.put` + `voice.done` 调 Mac 火山极速版识别）、`qr.scan`（`AVCaptureSession` 原生扫码弹窗）、`notify.status / request / send / consumeTap`（基于 `UNUserNotificationCenter` 本地通知与 `beginBackgroundTask` 后台保活，无需付费 APNs 证书即可在 App 运行或切后台期间监听所有已配对 Mac 的终端状态变化 `blocked` / `done` / `error` / 退出并弹窗提醒，点通知自动切换到对应 Mac 并打开该终端）、`haptic`（轻触震动）；`nsh.json` 显式声明 `capabilities.host: ["voice.*", "qr.*", "notify.*", "haptic"]`；监听 `lifecycle()` 在回前台时立即 `wake()` 重连并恢复 `term.fit`，切后台时释放终端尺寸主导权。
>   4. **多台 Mac 配对、切换与后台并行监听**（`ios/src/conn.ts` + `ios/App.tsx`）：`Storage["herdr-relay"]` 保存 `desktops: Saved[]`（兼容单台旧格式，跨 Mac 复用同一把设备密钥 `deviceSecret`）；首页顶部常驻圆角胶囊栏显示所有已配对电脑（带实时在线绿点）与「`＋ 配对新电脑`」胶囊入口；后台对非当前 Mac 维持轻量加密连接（`bgLinks`），实时同步各台电脑的在线状态与 agent 状态通知，设置页支持按台切换或单独移除。
>   5. **真机验证（2026-11-07）**：已通过 `ios/host/install.sh` 签名并装入真 iPhone（`com.roacherm.herdr`），真机配对上线（设备 `04ab271d Herdr iPhone`）并成功从原生 App 向本机终端发送消息。
>
> 2026-11-06 的方向（已被上面替代）见 [docs/native-app.html](docs/native-app.html)（I-004）：
> - 推送：设备一直「推送关」，因为手机页只在 Chrome 标签页里用（7 天 1790 条指标全是 `standalone: false`）。iOS 只给主屏幕 Web App 推送。先用主屏幕 Web App + 现有 Web Push（0 元）。
> - App：免费 Apple 账号不能推送、7 天失效，不做。要做就付费，做「薄壳」：WKWebView 跑现在的手机页，Swift 只管 APNs、锁屏按钮、Face ID、钥匙串。不再用 nsh 重写界面。
> - 下面是 2026-11-02 的评估和原型记录，留作参考。

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

### 第 0 步结果（2026-11-02，nsh 0.3.0，只在本机 Mac 验证，没有打包上手机）

已验证：
- **连接代码原样能用。** PWA 的 `app/src/link.js` 和 `shared/e2e.js`（tweetnacl）在 nsh 的 QuickJS 里直接运行。QuickJS 有 `WebSocket`、`TextEncoder`、`atob/btoa`、`crypto.getRandomValues`、`crypto.subtle.digest`、`EventTarget`、`CustomEvent`；没有 `document`、`window`、`self`。只改了两处：`link.js` 里对 `document`/`window` 加了判空；`ios/src/shim.ts` 设 `globalThis.self = globalThis`，让 tweetnacl 找到随机数来源（不设的话它会去调 `require('crypto')`，打包就失败）。
- **QuickJS 直连中继**（`ios/probe/link.test.ts`）：配对、列终端、开流、打字往返、用同一把设备密钥重连，0.3 秒内完成。
- **整个 App**（`ios/App.test.tsx`）：配对（粘贴链接）→ 原生首页（按 Herdr 工作区分组、状态点、「+」新建）→ 终端页（WebView 里跑 xterm.js，连接留在原生一侧，只有一条连接）→ 发消息 → 返回 → 设置 → 取消配对。无界面运行和 iOS 模拟器（`nsh test --target ios`，真 UIKit 渲染、截图）都通过。

终端页的做法：`ios/build-term.mjs` 把 xterm.js、`term/term.js`、CSS 打成一个 HTML 字符串（约 346 KB），用 `<WebView html>` 显示，不需要网络。原生和页面之间用字符串互发 JSON：原生 → 页面 `size/out/reset`；页面 → 原生 `ready/ack/input`。信用（credit）仍然在 xterm 画完之后才回给 Mac。

遇到的问题：
- **nsh 0.3.0 的 `wss://` 坏了**（真机配对失败的原因）：原生宿主的全局 `WebSocket` 和 `websocket` 模块一连 TLS 就报 rustls 的 `Could not automatically determine the process-level CryptoProvider`。`https` 的 fetch 和不加密的 `ws://` 正常。上游 10-27 修复（`464e7be`），晚于 0.3.0 发布。现在用 `curl -fsSL https://nsh.dev/install.sh | sh -s -- --source` 装 main 分支（实测 `df6aa34`）：真实中继在 macOS、Mac Catalyst 和 iOS 模拟器上都通过。无界面测试用的是测试工具自己的网络实现，测不出这个问题，所以 `ios/probe/NetProbe.tsx` 要在真宿主里跑。
- main 分支和 0.3.0 的 API 有出入：Input 的 `onChange` 收到 `{ value }`；`numberOfLines` 写在 style 里；ref 类型从 `nsh/types` 导入（`WebViewRef`）；`websocket` 模块导出 `connect`。
- 系统导航栏右侧插槽（`headerRight`）里的按钮在模拟器里点不动，处理函数没有被调用。是 nsh 的问题还是测试代理的问题，没有分清。暂时把「设置」放到页面内容里。
- 文档和类型定义有出入：`hidesBottomBarWhenPushed` 文档里有，类型里没有。
- 逐字输入很长的文字在真 UIKit 上很慢（350 个字符超过 30 秒），测试里改用粘贴。

还没做：语音和扫码（需要 Swift 宿主）、APNs 推送、发图片（nsh 有 `Picker.pickImages`，预计不需要宿主）、回到前台时立即重连（nsh 没有找到 App 状态 API，原型目前靠 Link 自己的计时器）、slash 命令模式、真机。

修正后的估计：第 0 步 + 第 1 步 + 大部分第 2、3 步已经完成（原型能用）。剩下的：界面打磨和图片约 1.5 天，Swift 宿主（录音、扫码）1.5–2 天，推送 1.5 天，打包上真机 0.5 天。合计不带推送约 3.5–4 天，带推送约 5–5.5 天。

本地跑法：
```sh
npm run relay:dev                      # 本地中继
node dev/fake-desktop.mjs              # 临时 herdr-core + 假终端，打印配对链接
npm run ios:term                       # 生成 ios/src/term-html.ts
# 把链接写进 ios/probe/link.json（{"link":"…"}），然后：
cd ios && nsh test App.test.tsx                 # 无界面
cd ios && nsh test App.test.tsx --target ios    # iOS 模拟器，截图在 ios/shots/
cd ios && nsh test App.test.tsx --target macos  # macOS 原生宿主
npm run ios:dev                        # Mac 上的 iPhone 尺寸窗口（Catalyst），手动点
```

实测（2026-11-02，真 Key，2.0 标准版）：Mac 朗读一句 9.7 秒中文，1.4–1.9 秒返回。中文全对；火山原样输出「phones js」「NPM Test」，经过拼写还原后是「phones.js」「npm test」。

拼写还原：识别后，把结果里和热词只差大小写、或者只差空格/点/横线的地方，改回热词原样（只改整词，`testing` 不会被改）。只对 `SPELL` 表和你自己的词生效；`Node`、`push` 这类普通词只当提示、不强改。你的词写在 `~/.config/wayne-herdr-mods/voice-words.txt`，一行一个，`#` 开头是注释；终端所在文件夹名自动加入。

## 内置浏览器：nsh 探针（2026-11-06）

问题：能不能像 dsh 的 `browser-use-plugin`（0.1.1）那样，做一个人和 agent 共用的浏览器？dsh 的做法：Electron 界面里放一个 `<webview>`，agent 的 `browser_*` 工具经长轮询交给拥有它的渲染进程执行，人在侧栏看到每一步。

- Herdr.app 里面放不了：它的 mod 文档写明不能用 web view（herdr-app 0.1.13）；`Herdr` 程序不链接 WebKit，也不含 nsh。nsh 的 GPUI 后端能显示 web view，但要 Herdr 自己嵌入 nsh 的 `AppView`。
- 单独的 nsh 窗口可以。探针 `probe/nsh-browser/`（nsh 0.3.0 main `df6aa34`，`nsh test App.test.tsx --target macos`，真 AppKit 窗口 + WKWebView，联网）。做法：`injectedJavaScriptBeforeContentLoaded` 给每个页面装一个小助手，app 发 `{id, script}`，助手执行后用 `window.nsh.postMessage` 回结果。

| 问题 | 实测（开发宿主里，一次运行） |
|---|---|
| 来回一次多快 | `injectJavaScript`：50 次 p50 0.07 ms、p95 0.31 ms；`ref.postMessage`：p50 0.15 ms、p95 12 ms、最大 88 ms。200 KB 的结果 1 ms 回来。 |
| 读页面 | Wikipedia 首页 381 个可点元素，序列化约 5 KB，来回 17 ms；词条页 798 个、约 45 KB，页内 14 ms。 |
| 点击 | `el.click()` 和派发的 `pointerdown/mousedown/mouseup/click` 都是 `isTrusted: false`。普通链接、按钮、表单能用（在 Wikipedia 搜 `WebKit` 并提交，跳到了词条页）；检查 `isTrusted` 的网站不认。 |
| 打字 | 输入框和 `contenteditable` 里 `document.execCommand('insertText')` 产生的 `beforeinput`/`input` 是 `isTrusted: true`；用 value setter 加派发 `input` 是 `false`。 |
| 截图 | TSX 没有截图接口。`nsh test` 的窗口截图包含网页内容（`shots/window.png`），但那是测试工具专用。正式做要二选一：Rust 原生组件调 WKWebView `takeSnapshot`，或者 Mac 宿主对这个窗口 `screencapture -l <窗口号>`（要屏幕录制权限）。都没验证。 |

- 推测（未验证）：真点击要在 Rust 里给 WKWebView 发 `NSEvent`（nsh 测试工具 `nsh-platform-macos/src/synth.rs` 就是这样发系统输入的）。这需要自己写一个嵌入 nsh 的 Mac 宿主；`nsh package` 打出的独立 App 不注册原生组件。
- 注意：每个网站都能调用 `window.nsh.postMessage`，所以 app 收到的页面消息一律当不可信数据，只认带自己发出的 `id` 的回答。
- 探针只回答能不能做；还没决定做不做。对比 ego lite（Chromium，已装，`ego-browser` skill）：它有真点击和截图，但不能按 Herdr 的需要定制。

## 发图片（已实现）

手机点「+」选图（最多 6 张）。大图先在手机上缩到长边 2048px、JPEG 0.85。发送时每张图分块 `upload.put` 传到 Mac，再 `image.put` 调用 herdr-core 的 `terminal.put`：文件落在这个终端自己的文件夹里（终端删掉时一起删），返回路径。消息变成「路径1 路径2 你的文字」，用 `terminal.send` 发出去。Claude Code 和 Codex 会把消息里的图片路径当附件读。单张上限 8 MB（`terminal.put` 的上限）。

## 终端页布局

顶栏压缩（返回、标题）。底部：一排快捷键，下面是输入行：左边「+」加图，中间「按住 说话」，右边键盘。

### 键盘弹出和收起（`app/src/keyboard-fit.js`，2026-11-07 改）

iOS 的键盘盖在页面上，不缩小页面。所以键盘弹出时，终端页的高度跟着「可见区域」（`visualViewport`，浏览器报告的、没被键盘挡住的那部分屏幕）走。键盘收起时，页面交回 CSS（`inset: 0`，铺满屏幕）。

判断「键盘弹出」要同时满足两条：输入框有焦点；可见区域比窗口矮 120 px 以上（矮得更少是浏览器工具栏在伸缩）。

问题（2026-11-07 iPhone 上 Chrome 截图）：用键盘自己的收起键收起后，键盘下去了，页面还停在键盘弹出时的高度，中间空一大块黑。只有点输入行右边的键盘按钮才恢复。第一次修（`3557e3b`）以为只是事件没来：输入框有焦点时每 200 ms（`POLL_MS`）再读一次可见区域。真机上没用。

实测（2026-11-07，iPhone，iOS 27.0，Chrome，页面版本 `mw5rxepi`；手机的 `kbd` 记录，见「体验记录」）：

| 时刻 | 发生了什么 | 焦点 | 可见区域高 / 偏移 | 窗口滚动 | 页面上边 / 下边 |
|---|---|---|---|---|---|
| 10:19:01.7 | 键盘弹出 | 在 | 476 / 0 | 0 | 0 / 476 |
| 10:19:02.6–03.5 | iOS 慢慢滚动窗口，偏移跟着变 | 在 | 476 / 0→72 | 0→72 | 0 / 476 |
| 10:19:05.2 | 按键盘的收起键 | **还在** | **476 / 72（旧值，没有事件）** | **0** | 72 / 548（上下都空） |
| 10:19:10.2 | 点键盘按钮（失去焦点） | 没了 | 476 / 72 | 0 | 0 / 753 |
| 10:19:14.3 | 失去焦点后 75 ms 内 | 没了 | 753 / 0（新值来了） | 0 | 0 / 753 |

结论：收起键之后，iOS 读到的可见区域本身就是旧的，读多少次都一样；只有失去焦点后才更新。会变的是窗口：iOS 把它滚回 0。键盘在的时候，可见区域的偏移和窗口滚动永远相等（101 条记录里只有上面两次不等）。

做法：

- 输入框有焦点、按可见区域看键盘在、但偏移和窗口滚动差 20 px（`STALE_PX`）以上：而且隔一次轮询（200 ms）再读还是这样：说明可见区域的值是旧的，键盘其实已经收起。只差一次不算，可能是回弹或转屏（独立审查提出，真机没见过）。页面让输入框失去焦点，和点键盘按钮一样。失去焦点后 iOS 送来新值，页面回到全屏；再点终端就能弹出键盘（输入框有焦点时点终端不会弹键盘，这也是以前「只能按右边按钮」的原因）。
- 刚获得焦点的 600 ms（`SETTLE_MS`）内不判断：那时可见区域可能还停在上一次的位置（上表 10:19:11.7 那次，90 ms 后就对了）。
- 放大（双指缩放）时偏移也会离开窗口滚动，这时不判断。
- 窗口滚动事件、可见区域事件和每 200 ms 的轮询都会触发检查。
- 失去焦点时立即回到全屏，600 ms 后再查一次。

没覆盖的情况：键盘刚弹出、iOS 还没开始滚动窗口（偏移和滚动都是 0）时就按收起键，两个值相等，看不出来。实测每次弹出后 1 秒内都滚到 64–72。

诊断：手机每当这些值变化时记一条 `kbd`，每个终端页最多 300 条，免得挤掉别的记录（焦点、可见区域、窗口、滚动、页面上下边，只有数字），`~/.config/wayne-herdr-mods/metrics/` 里能看到。

测法：`test/keyboard-fit.test.mjs`。「the viewport stale (iOS 27)」一项用的是上表的数字，旧代码失败。

### 键盘栏的顺序（2026-11-05 改）

从手机上做 vibe coding 时，要打的字靠语音或键盘输入。键盘栏只做两件事：回答 agent 的问题，和打断 agent。所以顺序是：

```
 ┌ 一屏能看到（393 px 宽的手机上也是前 7 个）────┐  往右滑
 Esc  ←  ↑  ↓  →  ⏎  ⇧Tab  ^C  │  Tab 粘贴 换行 1 2 3 y n ^D ^R ^L
 └─ 打断 ┘└──── 回答菜单 ────┘ └ 模式 ┘
```

依据：手机两天的记录（`op` 里的 `key`，2026-11-04 到 11-05），共 53 次按键。⏎ 31 次，n 7 次（其中 5 次是同一秒里连按，那次键已经发出，只是网慢没看到变化），↓ 4 次，Esc 4 次，↑ 3 次，← → 各 2 次。粘贴、⇧Tab、^C、Tab、换行、1 2 3、y、^D ^R ^L 都是 0 次。旧的顺序把粘贴、⇧Tab、^C 放在最前面，← → 却要滑动才能看到。同期语音输入 76 次。

- **Esc 在最左**：打断正在跑的 agent（Claude Code、Codex、epi 都用 Esc），也用来取消问题。
- **← ↑ ↓ → ⏎ 挨在一起**：回答菜单就是「↓ ↓ ⏎」，手指一路往右按。
- **⇧Tab 留在一屏内**：数据是 0 次，但它是 Claude Code 切换计划模式唯一的入口。
- **^C 在一屏的边上**：在 Claude Code 里按两次会退出，放远一点不容易误按。
- 数据只有两天，以后按 `wayne-herdr-mods metrics` 报告页里的「键」统计再调整。

| 键 | 发什么 | 用途 |
|---|---|---|
| Esc、⇧Tab、^C | `ESC`、`ESC[Z`、`0x03` | 打断、Claude Code 切换模式、中断 |
| ← ↑ ↓ → | 程序开了应用光标模式（vim、less）发 `ESC O A`，否则 `ESC [ A` | 按住不动 0.38 秒后连发，每 70 ms 一次。手指横向滑动快捷键栏是滚动，不发键 |
| ⏎、Tab | `\r`、`\t` | |
| 粘贴 | 手机剪贴板里的文字，作为一次 bracketed paste（`ESC[200~ … ESC[201~`）；剪贴板里是图片（截图）就按「+」的路上传 | 和 Mac 上 ⌘V 一样，Claude Code 把长文字显示成 [Pasted text]。iOS 会先弹一个小的「粘贴」气泡，点一下才读 |
| 换行 | 一个粘贴的换行 | Claude Code / Codex 里换行，不发送 |
| 1 2 3 y n | 字符本身 | 回答菜单 |
| ^D、^R、^L | `0x04`、`0x12`、`0x0c` | 退出、搜历史、清屏 |

测法：`dev/keys-smoke.mjs`（终端里跑一个 raw 模式读取器，原样打印收到的字节）。

### 每个 agent 的快捷键（2026-11-06）

键盘栏在 `^C` 后面多两组键：这个终端里 agent 自己的快捷键，和 `^ ⌥ ⇧` 三个修饰键。

```
 Esc ← ↑ ↓ → ⏎ ⇧Tab ^C │ ^⏎ ^O ^T ^B ⌥P …（跟着 agent 变）│ ^ ⌥ ⇧ │ Tab 粘贴 换行 …
```

- **agent 的快捷键**（`app/src/agent-keys.js`）：按终端的图标（Herdr.app 给的 `icon`），不认识时按程序名。agent 退出变回 shell，这组键就没了。来源都是程序自己（2026-11-06）：
  - Claude Code 2.1.316：程序里的默认键表，例如 `ctrl+enter` 是 `chat:sendNow`（立即发送）。放了 ^⏎ ^O ^T ^B ⌥P ⌥T ^G ^S。
  - agy（Antigravity CLI）：程序里的更新说明和提示。⌥M（和「排队」设置相反地发送）、^O、^G、^R、⌥S、⇧⏎。
  - droid 1.5.0：程序里的提示。^N ^L ^O ^T ^R ^X ⇧⏎。
  - Codex 0.163.0 没放：它的提示是运行时拼的，从程序里读不准；用修饰键自己组合。
  - 读用户的配置：Claude Code 有 `~/.claude/keybindings.json`、agy 也有 `keybindings.json`，这台 Mac 上都没有，所以先不读。以后有人改了键再加。
- **修饰键**：点 `^`、`⌥`、`⇧`（可以多个），再点一个键栏的键（Esc、箭头、⏎、Tab、1 2 3 y n），或者在键盘上打一个英文字符，就发出组合键，例如 `^` 再 `⏎` 是 `ctrl+enter`，`⌥` 再打 `m` 是 `alt+m`。发一次就松开。中文输入法在拼字时不算。外接键盘的 Ctrl/Alt + ⏎ 也走这条路。
- **怎么发**：按名字发（`term.press {s, keys: ['ctrl+enter']}`），Mac 调 herdr-core 的 `terminal.keys`。herdr-core 按程序要的格式编码（`probe/keys.mjs`，hc 0.1.18，2026-11-06 实测）：

| 键 | 程序没要求（legacy） | modifyOtherKeys | kitty 键盘协议 |
|---|---|---|---|
| `ctrl+enter` | `ESC[27;5;13~` | `ESC[27;5;13~` | `ESC[13;5u` |
| `shift+enter` | `ESC[27;2;13~` | `ESC[27;2;13~` | `ESC[13;2u` |
| `alt+m` | `ESC m` | `ESC m` | `ESC[109;3u` |
| `ctrl+shift+p` | 报错（legacy 没有这个键） | 报错 | `ESC[112;6u` |

  手机自己发字节做不到这一点：程序在手机连上之前就切了键盘模式，手机看不到。
- 顺序：`term.press` 和打字走同一条队列（`host/phones.js` 的 `stream.inputs`），先发出去的字先到。名字不在白名单（`KEY_RE`）里的整条丢掉；herdr-core 报错（比如 legacy 下的 `ctrl+shift+p`）只记日志。
- 新旧混用：`ready` 里有 `keys: true` 的 Mac 才收 `term.press`。旧 Mac + 新手机：没有这个字段，手机不显示 agent 快捷键和修饰键，其它键照旧。新 Mac + 旧手机：旧手机不发 `term.press`，没有变化。
- 测法：`test/agent-keys.test.mjs`（每个 agent 的键都在白名单里、组合的名字）；`test/host.live.test.mjs`（`term.press` 排在前面打的字后面，坏名字丢掉）。

### 程序在问时，打的字先等着（2026-11-05 改）

程序报告 `blocked`（等你确认）时，手机打的字先不进终端。原因：菜单里一个字母就可能选中一项（Claude Code 的 1 / 2 / 3，y / n）。字等在发送框里，气泡说「等你回答后输入：…」，回答完再进去。

问题：Antigravity 的「Approve plan」也报告 `blocked`，但它不是菜单。它的回答方式是在自己的输入行里打字（或打 `/artifact`）。手机一直等，就卡死了：只能回 Mac 上处理。

现在的规则（`app/src/main.js` `hold()`）：

| 程序报告 | 光标 | 打的字 |
|---|---|---|
| 不是 `blocked` | — | 马上进去 |
| `blocked` | 显示（程序在自己的输入行等字） | 马上进去 |
| `blocked` | 隐藏（菜单；Claude Code 一直隐藏） | 等着。点气泡「点这里照样打字」就进去，直到这次提问结束 |

依据：2026-11-05 本机 19 个终端里，菜单和 Claude Code、epi 的界面都隐藏光标；Antigravity 的输入行、shell 都显示光标。这是观察，不是程序的约定，所以留了点气泡这条退路，什么情况都不会卡死。

测法：`dev/term-smoke.mjs` 里 `plan · agy`（`blocked`，光标显示，打字直接到）和 `plan · stuck`（`blocked`，光标隐藏，点气泡后到）。旧代码这 4 项失败。

### 在手机上回答程序的问题（2026-11-05）

程序问你时，在手机上用底部的键回答：↑↓ 换选项，←→ 换题（Claude Code 一次问好几题时），⏎ 选中，Esc 取消。

**试过又去掉的：程序在问时把这些键变蓝（0.1.7 加，2026-11-06 去掉）。** 蓝色跟着程序报告的 `blocked` 走，但 `blocked` 不一定是菜单：Antigravity 每写好一份计划（artifact）就报 `blocked kind=permission msg="Approve plan"`（2026-11-06 本机 t2w 实测，`asks/` 里 23:53、00:07、00:30 三份样本），屏幕上只是它的输入行和 agent 用文字列的 1. 2. 3.。用户以为手机「认出了一个提问」，其实手机只是在照搬报告。现在键盘栏永远一个样子，屏幕原样同步，怎么答由你看屏幕决定。按下的键仍亮一圈黄框，直到程序画出东西（网络慢时知道键发出去了）。测法：`dev/term-smoke.mjs` 的「no key turns blue」两项，旧代码失败。

**试过又去掉的：选项按钮面板。** 手机读屏幕上的菜单（标记 `❯ › →`、同列的选项、下面的按键提示），在终端下半部画成一排按钮，点一个按钮，手机替你按方向键和 ⏎。真机上它回答了 6 次，都成功了。但用户不要它：选项一长，面板就挡住、也滑不动；而且原来的终端样式就够用。2026-11-05 去掉。

**试过又去掉的：独立对话视图（`host/transcripts.js` + `app/src/conversation.js`）。** 2026-11-03 曾实现过读取 `~/.claude`、`~/.epi`、`~/.codex` JSONL 会话文件并在手机上渲染原生滚动列表的「对话视图」。在完成手机布局自动切换、长对话 `reprint()` 截断和 Mac 端惯性滑行后，直接看终端视图已经足够顺滑且信息完整，维护两套视图反而割裂，遂移除。

**Claude Code 普通屏幕模式实测（2026-11-03，Claude Code 2.1.316，`dev/classic-smoke.mjs`）。** 默认 `"tui": "fullscreen"` 使用备用屏幕（`ESC[?1049h`），手机拿不到回滚历史；设置环境变量 `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` 优先于 `"tui": "fullscreen"`，输出进入主屏幕历史（300+ 行），手机可直接原生滚动。注意启动时不要用 `env CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 claude` 包一层，否则 `herdr-core` 会把程序名记成 `env`。代价是窗口改尺寸时 Ink 底部重画偶有重复行，是否开启由用户在 `~/.claude/settings.json` 自行决定。

**「方向键没用」的真正原因：网慢。** 用户说手机上的方向键不起作用。核对的结果：

- 真机记录（17:31）：按 ↓ 后 0.97 秒、按 → 后 0.96 秒，屏幕才变（`echo.net`）。键是到了的。
- 那天手机用 5G 时，直连的网络往返一直在 510–560 ms（`rtt.ice`），忙时整体往返到 1 秒；在 Wi-Fi 下是 7 ms。
- 在真的 Claude Code AskUserQuestion 上，用手机页面点底部的键（`puppeteer`，本机中继）：新版和 0.1.6 都是 ↑↓ 换选项、←→ 换题，全部有效。
- Claude Code 的菜单认 `ESC [ A`、`ESC O A` 和 j/k。只有菜单刚画出来的一瞬间，第一个键会被吞掉。

所以改的是反馈，不是按键：按下的键会一直亮着（黄框），直到程序画出新东西（最多 3 秒），见 `main.js` `pressed()`。网慢时，这样能看出键已经发出去了，不会以为没按上。

**提问样本**（`host/ask-samples.js`）：终端每次开始问（或换了一个问题），Mac 等 0.3 秒，把屏幕存一份到 `~/.config/wayne-herdr-mods/asks/`：`.bin` 是 herdr-core 画的原始字节，`.json` 是状态（app、kind、msg）和尺寸。最多 200 份，只在本机。`node dev/asks.mjs --show` 打出每份样本的屏幕。这次排查时，那个问题出现在 Mac 服务启动之前，所以没有样本，只能靠记录推断。以后再遇到答不了的问题，就有屏幕可查。

测法：`dev/term-smoke.mjs` 的 `ask · claude`（`dev/fake-menu.mjs`，一个会响应方向键、样子照 Claude Code 的假程序）。它用底部的键答两道题、Submit 和授权，并检查键按下后亮着、程序回话后熄灭。`test/host.live.test.mjs` 测存样本；关掉存样本时，这个测试失败。

### 手指滑动看历史（`app/src/touch-scroll.js`）

xterm 6 自己画滚动条，只认鼠标滚轮，手指拖动不会滚。所以终端区域自己处理竖向拖动：
- 先滚外层（终端比可用高度高时），再按行滚 xterm 的历史（`scrollLines`），手指走多远内容走多远；
- 全屏程序（vim、less、Claude Code 等，备用屏幕没有历史）：手指每走一行，马上发一个滚轮事件，由 xterm 按 Mac 上的方式转给程序。手机上不提前挪文字，只显示程序真实的重画；
- 松手后按速度惯性滑行，减速率和 iOS 原生滚动一样（每毫秒 0.998），全屏程序的滑行衰减得更快：每毫秒 0.998³ ≈ 0.994（时间常数 τ ≈ 166 ms，iOS 是 500 ms）。原因：滑行距离 = 初速 × τ，而程序一步滚约 3 行，内容走的距离是手指的 3 倍；τ 除以 3，内容滑行距离就和 iOS 列表一样。2.5 px/ms 的甩动：改前 85 步 = 255 行（约 5 屏）、1.4 秒，用户反馈「衰减太慢」；改后 29 步 = 87 行、0.45 秒。往返延迟约 250 ms，滑行第一帧重画到手机时已过半，用户很少需要去按停。另外下一步要隔 100 ms 以上时就停（`MAX_GAP_MS`）：末尾稀疏的步子是一下一下的跳。曲线只有一份：`shared/coast.js` 的 `coastSteps(v, cell)`，给出每一步在松手后第几毫秒发；
- 全屏程序的滑行由 Mac 来跑：手机松手时只发一条 `term.coast {s, d, v, cell}`（d = 一个滚轮报告，v = 速度 px/ms，cell = 行高 px），Mac（`host/phones.js`）按曲线用本地定时器一帧一步发给程序。Mac 收到这个终端的任何 `term.input`、`{stop: true}` 或流关闭，都会马上停。手指再按下时，手机发 stop。Mac 布局比手机高时，外层先在手机上滑到边，剩下的速度再交给 Mac（真机第一次测试就是这样漏掉的：探针 121 行，外层还能滚，滑行全留在手机上）。普通历史（`scrollLines`）的滑行还是在手机上跑；
- 打字或点 ↓ 回到最新时，先停掉滑行；
- 横向拖动交给浏览器（Mac 的列数比手机宽，左右滚）。

为什么这样做（2026-11-03 实测 Rex 手机 App，同一个探针程序记录收到的每个滚轮事件）：

| | Rex | 改之前的我们 |
|---|---|---|
| 每走多远发一步 | 约每行一步，不管程序一步滚几行 | 先单独发一步、等重画学出「一步滚几行」，再按这个比例发（探针一步滚 3 行 → 每 3 行一步） |
| 节奏 | 很均匀，约每帧（16 ms）一步 | 成团：两步一起到，再空 100–280 ms |
| 惯性 | 手机上算，甩一下继续发约 2 秒，间隔从 16 ms 平滑拉长到 250 ms | 约 1.2 秒，不均匀 |
| 文字提前移动 | 没有 | 先挪、等重画到了再弹回 |
| 同样的手势共发几步 | 204 | 46 |

两边的延迟差不多（Rex 走 Tailscale DERP 约 170–230 ms，我们走中继约 250 ms），所以顺不顺主要看发送方式：均匀、马上、不作假。

为什么滑行要让 Mac 跑：改成每行一步后，用户反馈「慢慢滑没问题，快速甩不丝滑」。探针记录显示手机每帧发的步子到 Mac 时成团（每 100 ms：19 2 2 2 4 26 6 3 …，一次最多 11 步，再空 200 ms）。当时手机走中继，中间经过手机上的 Clash 代理，代理把小包攒在一起发。网络抖动无法从手机这头消除，所以只发一条速度，步子在 Mac 本地按时间发，网络怎么抖都不影响节奏。

验证：`test/coast.test.mjs`（曲线：约 2 秒、先快后慢、有上限）；`dev/scroll-smoke.mjs`（模拟 iPhone 触摸，19/19，含比手机高的布局：外层先滑到边，再交给 Mac）：竖拖看到更早的行且不发任何东西给 Mac、横拖左右滚且不动历史、点按弹出键盘、全屏程序收到 `ESC[<64;…M` 滚轮报告、慢拖约每行一步且手指没松开时程序已经在动、手机上没有提前挪的文字、甩一下松手后还在滚且只发了一条 `term.coast`、打字和 ↓ 先回到最新。真机手感待验证。

### Slash 命令（`app/src/live-line.js`）

问题：输入框只在发送时才把文字交给终端，所以打 `/` 时 Claude Code、Codex 自己的命令菜单（边打边筛选）不会出现。
实测（2026-11-02，临时 herdr-core）：`terminal.send`（粘贴 + 回车）发完整的 `/help`（Claude Code）和 `/status`（Codex）都能执行，所以发送这一步没问题，缺的是菜单。

做法（v0.1.0 起）：不再单设「命令模式」。手机输入框只当键盘：每次改动都算出「退格到公共前缀，再补上新字」的按键，从终端流实时打进程序自己的输入行（`keystrokes()`）。所以 `/` 开头时菜单自然出现在上方的终端里；↑↓、Tab 用快捷键栏；发送 = 回车。把 `/` 删掉，打进终端的字也会退格删掉。2026-11-02 最早的实现 `app/src/live-command.js` 只对 `/` 开头的一行这样做，普通消息走 `terminal.send`；v0.1.0 合并进 `live-line.js` 后删除。

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

## 手机端文件与低带宽视频预览（已实现）

手机在查看终端之余，常需要直接查看当前工作区里的代码、Markdown、截图、PDF/Office 文档以及录屏视频。由于连接可能走 Cloudflare 加密中继或蜂窝弱网，直接在链路上传输数十 MB 的原图或原始视频会阻塞终端打字回显（`term.input` / `term.out`）。

### 1. 路径沙箱（`host/files.js`）

- 手机**不能**传入任意绝对路径。`files.roots` 只从当前 `herdr-core` 的工作区（`space.folder`）和终端工作目录（`t.foreground?.cwd ?? t.cwd`）收集根目录并分配 `rootId`。
- `files.list {rootId, path}` 与 `files.open {rootId, path}` 先对根目录和目标路径分别做 `fs.realpath`，校验目标 `realpath` 严格位于根目录 `realpath` 内部（阻断 `../` 越界与指向工作区外部的符号链接），并拒绝列出或打开 `.git` 与 `.DS_Store`。

### 2. 按文件类型硬件预处理（Mac 端缓存于 `<dataDir>/cache/previews/`）

本机实测（macOS，`sips-316`、`/usr/bin/qlmanage`、`ffmpeg 9.0.2` Apple Silicon `h264_videotoolbox`，2026-11-07）：

| 类型 | 宿主预处理方式 | 实测耗时与体积变化 |
|---|---|---|
| 代码 / Markdown / 文本 | 直接读取前 `128 KB` UTF-8 文本（前 4 KB 含 `\0` 判为二进制） | `< 2 ms` |
| 大图片（PNG / HEIC / TIFF 等） | `/usr/bin/sips -Z 1440 -s format jpeg -s formatOptions 78` 缩至手机视网膜屏足够清晰的 1440px JPEG | 2880×1800 PNG `3.6 MB` → `145 KB`（省 96%，耗时 `51 ms`） |
| 文档（PDF / Office / iWork / HTML） | `/usr/bin/qlmanage -t -s 1600` 生成首屏缩略图 + 注册原文件 `rawPreviewId`（`<= 15 MB`）供手机系统 `QLPreviewController` 打开完整多页文档 | `67 KB` 缩略图（耗时 `178 ms`） |
| 视频（MP4 / MOV / WebM / MKV） | ① `ffmpeg` 抽 6 帧横向拼接成 `Filmstrip` 故事板长图（`~45 KB` JPEG，随 `files.open` 立即返回）；② `ffmpeg` `h264_videotoolbox` 硬件转码为 `480p@15fps` H.264 + 24kbps 单声道 AAC + `-movflags +faststart` MP4（若硬件编码不可用则自动回退 `libx264`） | 30 秒 1080p@30fps 原片 `29.16 MB` → 故事板 `45 KB`（`112 ms`）+ 480p 全片 `768 KB`（`25.6 KB/s`，省 97.4%，耗时 `779 ms`） |

### 3. 63 KB 对齐分片拉取与 iOS 原生预览（`files.slice` + `preview.*`）

- 为什么不用 WebRTC `MediaStreamTrack` 推视频流：我们的 WebRTC 仅配 STUN、无 TURN 中继，跨网段 UDP 不通时媒体轨直接不可用；而走 `files.slice` RPC 分片在局域网下自动跑在 WebRTC DataChannel（0.4 ms RTT）上，跨网段无缝回退 Cloudflare E2E 中继，且享受完整的端到端加密与本地缓存。
- 手机通过 `files.slice {previewId, offset, length: 64512}` 按需拉取（`64512 = 63 × 1024`，是 3 的倍数，base64 分片无 `=` 填充，可直接拼接或流式追加写入原生临时文件），不在同一时刻往 socket 塞入大包，保证终端按键永不排队。
- iOS 原生宿主（`ios/host/Sources/App.swift`）提供 `preview.reset`、`preview.append`、`preview.open`：视频/音频调用系统 `AVPlayerViewController`（支持拖动进度条、倍速、画中画），图片/PDF/Office 文档调用系统 `QLPreviewController`（支持双指缩放、多页翻阅与系统分享）。

验证：`test/files.test.mjs`（根目录收集、目录排序、`.git` 隐藏、`../` 与越界软链拦截、128 KB 文本截断、`sips` 图片压缩 + 分片重组、`ffmpeg` 6 帧故事板 + 480p MP4 转码与 `ftyp` 校验）。
