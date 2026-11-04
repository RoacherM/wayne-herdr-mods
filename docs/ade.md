# 多设备 ADE 方案（草案）

日期：2026-11-04。状态：第 0 步已完成（浏览器里修好了闪烁，见下文「第 0 步结果」）；第 1 步以后是方案，没写代码。下文的「已查」指读过源码或 schema；「猜测」指没验证。

## 结论

1. **Mac 不重写。** 直接用 Herdr.app。它本来就支持「别的机器」：每台机器的 space / tab / 分屏存在那台机器的 herdr-core 里，所有连上的窗口共享结构和终端，各自保留焦点和缩放（herdr-app README，已查）。我们只做一个 `via` 命令，让一台 Mac 通过 Cloudflare 中继连上另一台 Mac 的 herdr-core。Mac 之间的同步不用写界面。
2. **手机 / iPad 新做一个原生 App。** 这是 Herdr 唯一没有客户端的地方。界面用 nsh，终端用 libghostty-vt（和 Mac 上同一个终端内核），协议直接说 herdr-core 自己的分帧协议。
3. **中继改成「加密字节隧道」。** 中继和加密不动。Mac 宿主不再把 herdr-core 翻译成我们自己的 `term.*` 接口，而是把 herdr-core 的分帧协议原样转过去，只按设备角色过滤方法。手机和远端 Mac 都变成普通的 herdr-core 客户端。
4. **先修现在的闪烁（第 0 步）。** 原因大部分已经找到，和是否重写无关，改动小。新 App 从第一天起就带着这些修正。

## 第 0 步结果（2026-11-04）：浏览器里能解决

用户的规则：浏览器里能解决就优化现有实现，不能再走原生方案。表格里的 #1–#5 都在 PWA 里修好了，逐帧测试（`dev/flicker-smoke.mjs`）坏帧从 12/23 降到 0，重开 0 坏帧，19 种字符宽度和 Ghostty 一致。细节在 DESIGN.md「画面不闪」。

所以现在**不需要**为了闪烁做原生 App。下面的原生方案留作以后：真 iPhone 上手感仍不够（例如 xterm.js 在 200 列以上掉帧），或者需要 PWA 做不到的东西（APNs 推送更可靠、后台录音、Mac 之间同步）时再启动。Mac 之间同步（第 1 步）和闪烁无关，可以单独做。

## 术语

- **herdr-core**：终端运行时（`hc`），开源，Apache-2.0，`github.com/herdrdev/herdr-core`。服务端自己也用 libghostty-vt 维护每个终端的屏幕。
- **Herdr.app**：桌面客户端，Rust + GPUI（Zed 的界面库）+ libghostty-vt，开源，`github.com/herdrdev/herdr-app`。
- **libghostty-vt**：从 Ghostty 拆出来的终端内核（解析字节、维护屏幕、编码按键）。不含渲染。C API，官方说明仍不稳定。
- **nsh**：Native Shell，Longbridge 的跨平台原生界面框架，TSX 在 QuickJS 里跑，iOS 上画 UIKit。没有终端组件。
- **分帧协议**：`hello {framed: true}` 之后的 herdr-core 连接格式。帧类型 DATA / CREDIT / CLOSE / RESIZE / FOCUS / FACTS。
- **`via` 命令**：`hc machine add --name X --via '<命令>'`。herdr-core 用这个命令代替 ssh 连另一台机器，命令只要双向原样传字节。
- **首屏（first paint）**：attach 时 herdr-core 发的整屏重画，开头是 CAN（0x18），会覆盖掉旧画面。
- **尺寸主导者**：最近打字、改尺寸或获得焦点的非 observe viewer，终端尺寸由它决定。

## 结构

```
 Mac A（终端在这里跑）                         Cloudflare                     其他设备
 ┌──────────────────────────┐                ┌───────────────┐
 │ herdr-core ◀── Herdr.app │                │ Worker + DO   │      Mac B: Herdr.app
 │     ▲                    │   wss，E2E     │ 只转发密文    │        └ herdr-core B
 │     │ 分帧协议（原样）   │◀──────────────▶│               │◀──────── hc machine add --via
 │ 宿主：隧道 + 角色过滤    │                │               │          'herdr-relay via macA'
 │      + 手机扩展          │                │               │
 └──────────────────────────┘                │               │◀──────── iPhone / iPad App
                                             └───────────────┘          nsh 界面
                       （同一局域网时走 WebRTC 直连，跳过中继）           + libghostty-vt 终端
```

一条隧道里跑两种东西：

| 通道 | 内容 | 谁用 |
|---|---|---|
| `hc` | herdr-core 分帧协议，原样 | 手机、Mac B |
| `ext` | 语音识别、推送订阅、图片分块上传、对话记录（transcripts） | 只有手机 |

### 设备角色

| 角色 | 能调的方法 | 配对时 |
|---|---|---|
| `phone` | 现在 DESIGN.md「安全」一节的白名单：list、attach、send、keys、interrupt、put、doc.get、events、run（只能开 shell） | 和现在一样：扫码 + 6 位数字 |
| `machine` | 全部（远端 core 需要 `machine.exec`、`file.*` 等） | 额外在 Mac A 上确认「允许这台电脑完全控制」。权限等于 ssh 登录。 |

宿主解析每个 JSON-RPC 帧的 `method`，不在白名单就直接回错误，不转给 herdr-core。DATA 帧（按键、输出）不解析，原样转。

`via` 的远端：herdr-core 会把一行 shell（`exec herdr-core connect …`，见 `machines.rs:242`）作为最后一个参数交给 via 命令。Mac A 的宿主**不执行这行字**，直接连本机 herdr-core 的 socket。这样中继上永远不会出现任意命令执行。

## 现在为什么闪（代码证据）

| # | 现象 | 原因 | 证据 | 修法 |
|---|---|---|---|---|
| 1 | Mac 拖窗口时手机花屏一下 | 手机从**事件通道**（`size` 事件 → `onList` → `resizeTo`）得知新尺寸，程序按新尺寸重画的字节从**流**过来。两条通道不同步，字节常常先到，旧尺寸的 xterm 画乱，尺寸到了再画对 | `app/src/main.js` `onList` 里 `resizeTo(t.cols, t.rows)`；`host/phones.js:151` attach 没带 `resize_notifications` | attach 带 `resize_notifications: true`。core 会在同一条流里先发 RESIZE 帧，再发新尺寸的整屏重画（`viewers.rs` `apply_size`）。宿主把 RESIZE 转给手机，手机先 `resize` 再写后面的字节 |
| 2 | 手机打字时 Mac 和手机一起跳一下 | 每次输入前宿主发 RESIZE，尺寸取自事件通道的缓存。Mac 刚改尺寸、缓存还旧时，手机会把终端拉回旧尺寸，再被拉回来：两次整屏重画，Mac 也看得到 | `host/phones.js` `input()` | 尺寸改用这条流上最后一次收到的 RESIZE。根治：给 herdr-core 提一个 `follow` 模式（能打字、永远不当尺寸主导者），见第 3 步 |
| 3 | 切换中继 / 直连、回到前台时闪白 | 重新打开终端时先 `xterm.reset()`，整屏变空，再等首屏过网络（中继约 230 ms） | `app/src/main.js` `open()`；`direct.js` 切换后在新连接上重开所有流 | 不 reset：首屏开头是 CAN + 整屏重画，本来就会覆盖。更好：宿主把 hc 通道挂在**设备**上而不是连接上，换连接只换出口，不重新 attach（带序号，断线补发） |
| 4 | Claude Code 里 ⏺、✳、emoji 那行错位 | xterm.js 默认按 Unicode 6 算宽度；Ghostty 按新标准并且打开 VS16（变宽） | `main.js` 没加 unicode 插件；`herdr-app/src/vt.rs:635` | PWA：加 `@xterm/addon-unicode-graphemes`。新 App：两边都用 libghostty-vt，宽度天然一致 |
| 5 | 快速输出时偶尔半帧 | 中继把一次输出拆成多条消息，渲染器在中间画了一帧 | 推断，没测 | 宿主按 16 ms 合并成一条消息再加密发送。xterm 6 支持同步输出（DEC 2026，已查 `xterm.mjs`），程序用了 2026 的部分本来就不会撕裂 |

herdr-core 本身已经有「落后就只发最新一屏」的机制：viewer 的信用（credit）用完后，积压的输出被一次整屏重画替换（`wire.rs` 「Supersede pending output with a new grid」）。这和 mosh 的思路一样：慢链路上跳过中间帧，不卡也不乱。只要我们的通道不在中间重新拼字节，就能直接用上。

## 手机 App 怎么做

| 部分 | 做法 | 理由 |
|---|---|---|
| 界面框架 | nsh（TSX），已有原型 `ios/` | 你指定；列表、设置、发送框这类页面 nsh 够用；以后 Android 可复用 |
| 终端视图 | Swift 宿主注册一个原生组件 `GhosttyTerminal`：libghostty-vt + Metal（或 CoreText）绘制 | 终端页是 App 价值的大头，必须原生、60 fps；和 Mac 同一个内核，画面、宽度、按键编码完全一致 |
| VT 绑定 | 首选官方 `ghostty-vt.xcframework`（含 iOS 切片，猜测：第三方文档说 nightly 已有）；退路：用 herdr-core 仓库里的 `crates/ghostty-vt`（Rust）编成静态库 | 官方 API 不稳定，锁定一个 Ghostty 提交 |
| 渲染参考 | `herdr-app/src/vt.rs`（把 libghostty-vt 读成帧、编码按键鼠标，2500 行）和 render state API 的脏行标记 | 照着改，不从零写 |
| 协议 | herdr-core 分帧客户端，TS 写，跑在 QuickJS；从 `host/hc.js`（197 行）移植 | 已验证 QuickJS 能跑我们的加密和连接代码 |
| 数据流 | 协议层收到 DATA 帧，直接交给原生组件（不经 JSON 和 base64 往返 WebView） | 现在 WebView 方案每一帧都要 base64 + 字符串过桥 |
| 滚动 | 主屏历史在手机本地的 libghostty-vt 里，原生滚动；全屏程序继续用 Mac 跑惯性（`term.coast` 改成 `ext` 通道的消息） | 本地历史零延迟 |
| 布局 | 读 `doc.get herdr-app`，订阅 `doc` 事件。以后要在手机上改布局，`doc.set` 带版本号，冲突会被拒 | 和 Herdr.app 同一份数据 |
| 原生能力 | Swift 宿主：扫码、录音、APNs、钥匙串 | nsh 文档里都没有 |

对齐 Herdr.app 的功能，手机上按这个顺序做：space / tab 列表和 agent 状态 → 终端页 → 发送和快捷键 → 新建 tab → 语音、图片 → 推送 → 分屏（iPad 才做）。

nsh 的风险：v0.3，`wss://` 在正式版里坏过（用 main 分支绕开），`headerRight` 点不动，逐字输入慢。缓解：终端页和输入都在原生组件里，nsh 只管外围页面。如果 nsh 卡住超过一天，外围页面换 SwiftUI，协议层不受影响。

## 分期

| 步 | 内容 | 产出 | 估计（猜测） |
|---|---|---|---|
| 0 | 修现在 PWA 的闪烁：表格 #1–#5 | **已完成**：`dev/flicker-smoke.mjs`、`test/paint.test.mjs` | 实际约半天 |
| 1 | 隧道 + 角色过滤 + `herdr-relay via` | Mac B 的 Herdr.app 侧栏里出现 Mac A 的 space，能打字 | 2–3 天 |
| 2 | 手机 App：协议层换成分帧客户端；`GhosttyTerminal` 原生组件 | 真机上 Claude Code 终端页 60 fps，Mac 改尺寸手机不花屏 | 5–8 天 |
| 3 | ~~给 herdr-core 提 PR：`attach {follow: true}`~~ 不需要了：2026-11-04 改成手机布局（谁最后用就按谁的尺寸，见 DESIGN.md「多个窗口怎么同步」第 3 条），用的是 herdr-core 现有的规则 | | 0 |
| 4 | 推送（APNs）、iPad 分屏 | | 2–3 天 |

## 怎么判断成功

- 闪烁：第 0 步的录帧测试。指标：Mac 连续拖窗口 10 次、手机切换中继 / 直连 10 次，坏帧数为 0。
- 延迟：沿用 `dev/` 里的往返测量。中继 p50 约 230 ms，直连 p50 约 0.4 ms（局域网，已测）。
- 一致性：同一终端，Mac 和手机各截一屏，按格子比较文字和宽度，完全相同。

## 没验证的

- Herdr.app 通过 `via` 连远端 core 时，230 ms 延迟下的手感。
- 官方 `ghostty-vt.xcframework` 是否真有 iOS 切片、是否能在 App Store 构建里用。
- nsh 的 Swift 宿主里注册原生组件，能否每秒收几百个 DATA 帧而不卡（可能要让协议层也搬到 Swift / Rust）。
- herdr-core 是否接受 `follow` 模式的 PR。
