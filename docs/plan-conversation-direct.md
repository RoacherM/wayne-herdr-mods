# 计划：对话视图、手机直连、Claude Code 普通模式

写于 2026-11-03。用户在 2026-11-04 早上验收。

## 为什么做

在手机上往回翻 agent 的历史不顺。原因是：

- Claude Code 和 epi 跑在**全屏模式**（alternate screen，备用屏幕）。程序在原地重画，旧的行不进终端历史。herdr-core 里只存了一屏（t6：57 行，t8：56 行）。
- 所以要看旧内容，只能给程序发滚轮，等它重画。手机到 Mac 绕新加坡，一次往返约 250 ms。
- Mac 上的 Herdr App 也是这样把滚轮交给程序，但本机往返只要几毫秒，所以顺。

参考：Herdr 的手机中继插件 [herdr-mobile-relay](https://github.com/0cv/herdr-mobile-relay) 也分两种视图。一种是读 agent 会话记录的**对话视图**，滚动用浏览器原生滚动。另一种是**终端视图**，用来处理菜单和审批。它还支持 WebRTC 直连。

## 顺序和分工

全部由我（Claude）做，按下面的顺序。每做完一个大功能就测试、部署、提交一次。

| 阶段 | 功能 | 提交 |
|---|---|---|
| A | 对话视图：Mac 读会话记录，手机原生滚动 | A1 主机读取器，A2 手机视图，A3 删掉 History |
| B | WebRTC 直连：中继只牵线，数据点对点 | B1 |
| C | Claude Code 普通模式：验证，写出做法 | C1（文档和测试） |

## A. 对话视图

### 术语

- **会话记录**（transcript）：agent 自己写在 Mac 上的 JSONL 文件，每行一条记录。
- **条目**（item）：手机显示的一条消息。种类有用户消息、回复、工具调用。
- **seq**：条目在会话记录里的序号，用来按页拿更早的条目。

### 怎么找到会话记录（只在 Mac 上做，手机只给终端地址）

| agent | 怎么认出来 | 文件 |
|---|---|---|
| Claude Code | 前台进程名是 `claude` | `~/.claude/sessions/<pid>.json` 给出 `sessionId`，再找 `~/.claude/projects/*/<sessionId>.jsonl` |
| epi | 前台命令里有 `epi` | `~/.epi/pi/sessions/--<cwd 把 / 换成 ->--/` 里最新修改的 `.jsonl` |
| pi | 前台命令里有 `pi` | `~/.pi/agent/sessions/` 下的同样规则 |
| Codex | 前台进程名是 `codex` | `~/.codex/sessions/年/月/日/rollout-*.jsonl`（最近 14 天）。第一行 `session_meta` 写着文件夹：取同一个文件夹里、这个进程启动后建的文件 |

每次检查更新时都重新定位，因为 `/clear`、`/resume` 会换文件。

Codex 的文件里大部分是给模型看的内容（`response_item`，含注入的 AGENTS.md 和环境说明）。只读 `event_msg` 里的 `item_completed`：用户消息、回复、命令和输出、改文件、MCP 工具、网页搜索、看图。思考和子 agent 不显示。文件夹比较时先解析符号链接（`/tmp` 和 `/private/tmp` 是同一个）。

### 协议（加进白名单，只有这三个方法和一个事件）

- `conv.open {address}` → `{c, kind, items, hasMore}`。拿最近一页（60 条），之后开始推送新条目。
- `conv.older {c, before}` → `{items, hasMore}`。拿 seq 小于 `before` 的一页。
- `conv.close {c}`。
- 事件 `conv {c, items, reset?}`：新条目；文件换了就带 `reset`。

限制：工具输出最多 2,000 字，一条消息最多 20,000 字。不发思考内容、系统注入、子 agent（sidechain）的记录。每 300 ms 检查一次文件大小，只读新增的部分。

### 手机

- 终端页标题栏加一个切换："终端 / 对话"。只对 agent 显示。
- 打开 agent 时默认进对话视图，切换的选择记在手机上。
- 对话视图是一个原生滚动的列表：
  - 打开时停在最新处；新内容来了，在底部就跟着走。
  - 往上看时位置不动。
  - 接近顶部时自动拿更早的一页，插在前面，位置不跳。
- 下面是输入框：打字、语音、图片，发送走 `term.send`（粘贴并回车）。
- agent 在等你确认时显示一条提示，点一下就切到终端视图回答。
- **实时部分**：会话记录只有写完的条目。agent 在工作或提问时，列表下面显示它屏幕上输入框以上的几行（每 700 ms 读一次屏幕）。屏幕上有选项菜单时，选项可以点：点别的选项发 ↑/↓ 移过去，点已选中的发 ⏎。

### TODO

- [x] A1 `host/transcripts.js`：定位，解析 Claude Code 和 pi/epi 的格式，按页读取，增量读取
- [x] A1 `host/phones.js`：`conv.open / conv.older / conv.close`，推送 `conv` 事件，断开时清理
- [x] A1 单元测试：两种格式的样本（自己造的，不用真实对话）
- [x] A1 `dev/fake-desktop.mjs`：一个假的 Claude Code 会话记录，带进程信息
- [x] A2 `app/src/conversation.js`：列表、Markdown 子集、工具卡片、跟随底部、加载更早
- [x] A2 `app/src/main.js`：切换按钮、输入框、等待确认的提示
- [x] A2 `dev/conv-smoke.mjs`：打开、滚动、加载更早、新条目、发送
- [x] A2 部署中继，重装主机，提交
- [x] A3 删掉 `app/src/history.js` 和 touch-scroll 里的 History 接线；终端视图里的滚动保留"先移动文字、再等重画"
- [x] A3 跑全部测试，部署，提交

## B. WebRTC 直连

### 做法

- 手机和 Mac 先照旧经中继连上，然后通过这条已经加密、已经认证的连接交换 WebRTC 的 offer、answer 和网络地址（ICE candidate）。
- 打通后，数据通道（DataChannel）当成第二条连接：在上面重新做一次握手和认证，跟中继连接一样。主机把它当作另一个连接号（cid）。
- 手机优先用直连，正在看的终端会在直连上重新打开。直连断了就退回中继，中继连接一直保持。
- 主机端用纯 JS 的 WebRTC 库（werift），不用原生模块，方便打包。
- STUN 用 Cloudflare 的 `stun.cloudflare.com:3478`。同一个 Wi-Fi 下不需要 STUN。

### TODO

- [x] B1 调研并验证：werift 能打包进主机（打包后 1.5 MB，打包版也跑过单元测试）。Chrome 也把地址藏成 mDNS 名字，能连上；Safari 没在真机验证
- [x] B1 `host/rtc-link.js`：answer、ICE、数据通道接到 phones（新 cid）；`shared/pieces.js` 分片
- [x] B1 `app/src/direct.js`（`Duo`）+ `app/src/link.js`：在就绪后尝试直连，切换，退回
- [x] B1 无头 Chrome 测试 `dev/rtc-smoke.mjs` 10/10：本机直连 p50 0.4 ms，经 Cloudflare 中继 p50 229 ms
- [x] B1 部署，重装主机，提交

做法细节见 DESIGN.md「直连（WebRTC，已实现）」。

## C. Claude Code 普通模式

- [x] C1 在临时 core（HC_SESSION=relay-ui）里启动两个 Claude Code 2.1.316：一个带 `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`，一个不带。验证它的输出进了终端历史，手机能本地滚动（`dev/classic-smoke.mjs` 5/5）
- [x] C1 写出做法和代价（见下面）。**没改用户的 `~/.claude/settings.json`**，由用户决定
- [x] C1 提交

### 结果

| | 普通模式（带变量） | 全屏模式（现在的设置 `"tui": "fullscreen"`） |
|---|---|---|
| 屏幕 | 普通屏幕（没有 `ESC[?1049h`） | 备用屏幕（有 `ESC[?1049h`） |
| 手机拿到的历史 | 屏幕上面 301 行 | 0 行 |
| 手机怎么滚 | 原生滚动的页面，往上拖 2000 px，没给 Mac 发任何东西 | 只能发滚轮，等程序重画 |
| Herdr.app 里怎么滚 | 终端自己的滚动条 | 程序自己的滚动 |

- 环境变量比设置文件里的 `"tui": "fullscreen"` 优先（Claude Code 的代码里：`CLAUDE_CODE_NO_FLICKER === false || CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN` 时不用全屏）。
- 真实终端 t6、t8 现在的历史只有 59 和 58 行（只读计数），跟全屏模式一致。

### 怎么打开（由你决定，我没改）

任选一种：

1. `~/.claude/settings.json` 的 `env` 里加 `"CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN": "1"`。只对新启动的 Claude Code 生效。
2. 或者把 `"tui": "fullscreen"` 改掉（之前调研到的 `/tui default` 命令也是改这个；没验证）。
3. 或者只在某个终端里：`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 claude`。注意别用 `env …` 包一层：herdr-core 会把程序名记成 `env`。

### 代价（没在真机上长时间用过，是推测）

- 普通模式下 Claude Code 在屏幕底部原地重画输入框和进度。窗口改尺寸时（比如手机"适配手机尺寸"），已经打出来的行可能重复或错位。这是终端 UI 库（Ink）的老问题。
- 有一点闪烁；全屏模式就是为了去掉闪烁才加的（变量名叫 `NO_FLICKER`）。
- 对话视图（A）不受影响：它读会话记录，不看屏幕。有了 A，普通模式只是让"终端视图"也能顺滑地翻历史。

### 测试时的副作用

- 在 `/tmp/cc-classic` 里点了"信任这个文件夹"，`~/.claude.json` 里多了一条 `/private/tmp/cc-classic`。文件夹已删。这条记录没删：别的 Claude Code 正在运行时改这个文件有风险。
- 为了产生输出，我在两个测试终端里各跑了一次 `! seq 1 400`。这次 Claude Code 把结果交给了模型，模型各回了一句话：一共 2 次很小的 API 调用。原计划是不发提示词，这里没做到。

## 约束

- 不重启用户的 Herdr.app 和默认 herdr-core；测试只用临时 core。
- 不给用户真实终端发输入。
- 手机不能指定文件路径，也拿不到命令行参数（argv）。
- 真实对话内容不进仓库，不打印。
- 只提交，不推送。

## 进度

| 时间 | 完成 | 提交 | 部署 |
|---|---|---|---|
| 11-03 | A1 + A2 对话视图（单元测试 42/42，conv-smoke 17/17，term-smoke 28/28，voice-smoke 6/6） | daf5d9f | 页面 dd6aa37f，主机已重装 |
| 11-03 | A3 删掉 History（scroll-smoke 19/19） | 364ff35 | 页面 6e1f7705 |
| 11-03 | B1 WebRTC 直连（单元测试 44/44，rtc-smoke 10/10；直连 p50 0.4 ms，经中继 229 ms） | 848e195 | 页面 56dd3c2e，主机已重装 |
| 11-03 | C1 Claude Code 普通模式：验证和写法（classic-smoke 5/5），没改设置 | 本条之后的提交 | 页面 55052064（只多了本机测试钩子） |
| 11-03 | 实时部分：对话视图里显示正在输出的内容 | 056f1a4 | 已部署，主机已重装 |
| 11-03 | 实时部分的选项菜单可以点 | 800aa97 | 页面 417ebe2d，主机已重装 |
| 11-03 | Codex 的对话视图（单元测试 49/49，conv-smoke 22/22；本机 69 个真实 Codex 文件全部能解析，只数了条数） | 本条之后的提交 | 页面 b0e5e373，主机已重装 |
