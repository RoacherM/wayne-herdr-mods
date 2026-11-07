# wayne-herdr-mods contributor entrypoint

`wayne-herdr-mods`（旧名 `herdr-relay`）在手机浏览器里通过端到端加密中继或 WebRTC 直连操作本机 `Herdr.app` 的终端，并维护 `Herdr.app` 里我们的自定义界面（`herdr-app/`）。

## 1. 目录与边界测试（The Boundary Test）

| 目录 | 职责 | 放进这里的判断标准 |
|---|---|---|
| `app/` | 手机端 PWA（终端列表、xterm.js 终端页、语音、直连） | 代码跑在手机浏览器里吗？构建产物进 `relay/public/` |
| `host/` | Mac 常驻服务与 `wayne-herdr-mods` CLI | 代码跑在 Mac Node.js 进程里，负责连接 `herdr-core` / 中继 / 钥匙串吗？ |
| `relay/` | Cloudflare Worker + Durable Object | 代码跑在 Cloudflare 边缘、且只转发密文或托管静态页吗？ |
| `shared/` | 手机与 Mac 共用的纯逻辑（`e2e.js`、`coast.js`、`wheel.js`、`pieces.js`） | 双端都要用且不依赖 Node/DOM 专有 API 吗？ |
| `herdr-app/` | `Herdr.app` 自定义布局与 mod（`main-preview`、`my-tabs`、`my-files`、`wayne-phones`） | 是装进 `~/.config/herdr-app/` 的界面配置或 mod 吗？ |
| `test/` | 单测与全链路协议测试 | 不预先起任何服务就能跑通吗？需要中继时用 `test/local-relay.mjs` 起临时实例 |
| `dev/` | 无头 Chrome 冒烟（`*-smoke.mjs`）、`fake-desktop.mjs`、`bench.mjs`、`asks.mjs` | 需要起无头浏览器、假桌面或跑分吗？文件第 1 行写明前置条件 |
| `probe/` | `herdr-core` 行为探针（`sync.mjs` 等） | 是在验证外部二进制/协议的未知行为吗？ |
| `bench/` | 跑分数据（`results.jsonl`） | 只放跑分结果数据，不放脚本 |
| `ios/` | nsh 原生 Herdr iOS App：`App.tsx` 界面 + `host/` Swift 宿主（已实现） | 代码跑在原生 App 里吗？网页版功能仍做进 `app/` |
| `shell/ios/` | WKWebView 薄壳（已停） | 只留作参考 |
| `.scratch/` | 排查数据、临时截图、一次性审计输出（已 gitignore） | 是一次性产物吗？严禁放进 `docs/` |

## 2. 按任务读取文档

- 唯一架构与协议事实：[DESIGN.md](DESIGN.md)（代码注释通过 `DESIGN.md「章节名」` 反指）
- 外部 Agent 使用本工具的说明：[SKILL.md](SKILL.md)（随 `install` 装入 `~/.agents/skills/wayne-herdr-mods`）
- 待办与待拍板队列：[docs/issues/INDEX.md](docs/issues/INDEX.md)

改哪里 → 先读 `DESIGN.md` 哪一节：

| 改动位置 | 先读 |
|---|---|
| `shared/e2e.js`、`relay/`、配对、`host/phones.js` 白名单 | 「安全」「手机能做什么，对应哪个接口」「地址和域名」 |
| `host/rtc-link.js`、`app/src/direct.js`、`shared/pieces.js` | 「直连（WebRTC，已实现）」 |
| 终端尺寸、多个查看者 | 「多个窗口怎么同步」「手机布局」 |
| `app/` 终端页（画面、滚动、键盘、输入） | 「终端页怎么显示」「终端页布局」「画面不闪」「滑动延迟」「重印整段对话」 |
| `host/voice.js`、`app/src/voice.js` | 「语音输入（已实现）」 |
| `herdr-app/` | 「Herdr.app 里的界面」 |
| `ios/`、`shell/ios/` | 「原生 App（nsh）」+ [docs/native-app.html](docs/native-app.html) |
| `probe/` | 「probe 怎么跑」及对应章节的版本号与日期 |

## 3. 常用命令

```sh
npm test                                           # 全量测试，约 7 秒；host.live 自起临时中继 + 独立 HC_SESSION=relay-live
npm run relay:dev                                  # 起本地中继（127.0.0.1:8799），dev/ 冒烟与跑分要用
node dev/bench.mjs                                 # 模拟跑分（需先 build + relay:dev），慢 20% 以上退出码为 1
node dev/asks.mjs --show                           # 查看本机捕获的 blocked 提问屏幕样本
npm run build && node dist/wayne-herdr-mods.mjs install  # 构建并同步命令、LaunchAgent、Herdr.app 界面与 skill
```

## 4. 必须遵守的 6 条规则

1. **绝不干扰用户的实时环境**：严禁停止、重启或发信号给用户的 `Herdr.app` 和默认 `herdr-core`；测试一律用独立 `HC_SESSION` 和临时目录。严禁只改 `~/.config/herdr-app/` 安装副本而不改仓库 `herdr-app/` 源码。
2. **协议与持久化标识兼容**：中继地址、`herdr-relay/v1` 协议标签、手机 `localStorage['herdr-relay']` 不可改名。改协议前先改 [DESIGN.md](DESIGN.md)，写清「旧手机页 + 新宿主 / 新手机页 + 旧宿主」的行为并配测试。
3. **修 Bug 先红后绿**：修任何 bug 必须带一个在旧代码上失败、新代码上通过的测试，并跑 `ub-mode` 汇报数字。
4. **完成定义（DoD）**：测试通过 + 若改了 `app/`、`host/`、`herdr-app/`、`SKILL.md` 则执行 `npm run build && node dist/wayne-herdr-mods.mjs install`（改了 `app/` 或 `relay/` 需说明是否部署中继）+ 同步更新 [DESIGN.md](DESIGN.md)。工作区有其它未完成改动时，用 `git commit --only -- <paths>` 提交。
5. **实测带版本号**：已验证事实与推测分开写；外部依赖（`herdr-core`、`Herdr.app`、`nsh`、`Claude Code`）的结论标明版本号与日期。
6. **按需独立审查**：改动触及加密握手、宿主 RPC 白名单（`host/phones.js`）、凭证或持久化时，交由不同于作者的模型独立审查 `git diff`。

## 5. Issue 自动处理闭环

处理 [docs/issues/INDEX.md](docs/issues/INDEX.md) 时：只自动认领 `status: ready` 的条目；按卡内 `verify` 先跑出 Red → 改代码跑出 Green → 提交并更新 [DESIGN.md](DESIGN.md) → 将状态改为 `done` 并删除已 `done` 的单张 `docs/issues/I-*.md`。
