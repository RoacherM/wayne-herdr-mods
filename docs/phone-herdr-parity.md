# 方案：让手机网页和 Mac 上的 Herdr 对齐

状态：方案，未实现。日期：2026-11-02。基于 v0.1.0（提交 76dd775）。

## 1. 目标

手机打开网页后，能看到、能做 Mac 上 Herdr 里**远程时真正需要**的东西：

- 看到和 Mac 一样的结构：工作区、标签、子 agent、置顶、完成提醒。
- 做常用操作：开新 agent 并给它第一句任务、改名、关闭、置顶、结束。
- 看到 Mac 的状态和设置：Herdr 版本、有没有更新、其他机器、已配对设备。
- 调手机自己的设置：字号、按键条、主题。

不做的事：

- 不在手机上复刻 Mac 的窗口布局（分屏、侧栏、mod 面板的位置）。手机屏太小，这些对手机没有意义。
- 不让手机发任意命令给 Mac。每个操作都单独放行（白名单）。

## 2. 术语

| 术语 | 意思 |
|---|---|
| Herdr.app | Mac 上的窗口程序（`herdr-app`）。它管工作区、标签、布局、设置。 |
| herdr-core（`hc`） | 真正运行所有终端的后台程序。窗口关了它也在跑。 |
| 宿主（host） | Mac 上的 `herdr-relay` 进程。它是手机和 Herdr 之间唯一的门。 |
| 工作区（space） | 一个干活的地方，通常对应一个仓库。 |
| 标签（tab） | 工作区里的一件事，包含一个或几个终端。 |
| 子 agent | agent 用 `hc run` 开的终端。core 记下了它的 `parent`。 |
| 结构文档 | herdr-core 里名为 `herdr-app` 的 JSON 文档。工作区、标签、分屏都存在这里。 |
| 白名单 | 宿主只放行列出的方法和参数，其他的一律拒绝。 |

## 3. 现状（已核实）

我在这台 Mac 上只读地查了以下事实：

1. **结构有唯一来源。** Herdr 把工作区、标签、分屏存在 core 的 `herdr-app` 文档里（`doc.get`）。Herdr.app 自带的说明 `~/.config/herdr-app/AGENTS.md` 写明：「Connected screens share that layout and live terminals, not their focus, zoom or attention」。也就是说，结构是共享的；焦点、缩放、「看过没有」是每块屏幕自己的。手机就是一块屏幕。
2. **改东西只有一个入口。** 所有修改都走命令：`herdr-app do <命令> --参数 值`。`herdr-app commands` 用机器可读的格式列出每个命令和参数，现在有 `space.*`、`tab.*`、`terminal.*`、`app.*` 等。
3. **设置是文件。** 对人的设置在 `~/.config/herdr-app/settings.json`（zoom、sounds、font、theme 等），外观在 `layouts/<名字>.json`。Mac 上的设置窗口分 6 组：Look、Alerts、Keyboard、Machines、Updates、Privacy。
4. **core 已经给了更多信息。** `terminal.list` 的每个终端都带 `parent`（子 agent）和 `labels`（包括 `herdr.pinned` 置顶）。`server.status` 给 core 版本。`machine.list` 给其他机器。
5. **手机现在只有：**
   - 首页：按工作区和标签分组的终端列表，加一个「需要你」分组。
   - 新建 shell 标签。
   - 终端页（v0.1.0 的新界面）。
   - 设置页只有三项：Mac 名字和中继地址、通知开关、取消配对。
   - 宿主白名单：`terminals.list`、`term.*`、`upload.*`、`voice.done`、`image.put`、`push.*`、`device.forget`。

## 4. 差距

| Mac 上的 Herdr | 手机现在 | 远程需要吗 | 计划 |
|---|---|---|---|
| 工作区 / 标签 / 终端 | 有 | 需要 | 已有 |
| 子 agent 挂在父 agent 下 | 没有，混在列表里 | 需要 | 第 1 步 |
| 置顶 agent | 没有 | 需要 | 第 1 步（看）、第 2 步（改） |
| done：做完了但你还没看 | 没有 | 很需要 | 第 1 步 |
| 其他机器的工作区 | 没有 | 需要 | 第 1 步 |
| Herdr 的主题颜色 | 固定深色 | 有用 | 第 3 步 |
| 新标签里直接开 agent，并给第一句任务 | 只能开 shell | **很需要** | 第 2 步 |
| 改名、关闭、置顶、结束 | 没有 | 需要 | 第 2 步 |
| 分屏、移动、布局切换 | 没有 | 不需要 | 不做 |
| 设置：Look / Keyboard | 没有 | 只要手机自己的 | 第 3 步 |
| 设置：Alerts | 手机推送 | Mac 的提示音可开关 | 第 3 步 |
| 设置：Updates | 没有 | 看状态；更新要确认 | 第 1 步（看）、第 3 步（做） |
| 设置：Machines | 没有 | 只看 | 第 1 步 |
| 设置：Privacy | 没有 | 不需要 | 不做 |
| mod 面板（changes、files） | 没有 | 以后有用 | 第 4 步 |
| 已配对设备的管理 | 只能取消自己 | 需要 | 第 1 步 |

## 5. 设计

### 5.1 原则

1. **不复制 Herdr，只读它的来源。** 结构读 core 的结构文档，状态读 `terminal.list`，设置读 `settings.json`。宿主不保存自己的一份副本，所以 Herdr 升级后手机不会和它对不上。
2. **只用 Herdr 的命令改东西。** 宿主执行 `herdr-app do`，不自己改结构文档。这样 Herdr 自己的规则（关闭最后一个标签会关掉工作区、命名规则等）照样生效。
3. **手机就是一块屏幕。** 焦点、看过没有、收起的标签、字号，都存在手机上，不写回 Mac。手机操作不能改变 Mac 屏幕上的焦点（v0.1.0 不改 Mac 终端尺寸，也是同一个原则）。
4. **每个操作单独放行。** 宿主按命令列出允许的参数和取值。手机不能选择要运行的程序，只能从 Mac 给的列表里挑。
5. **按能力显示。** 宿主启动时读 `herdr-app commands`，把这台 Mac 支持的操作告诉手机。手机只显示支持的按钮。Herdr 改版后不会出现按了没反应的按钮。

### 5.2 数据流

```
手机网页 ──E2E 加密──▶ 中继 ──▶ 宿主（白名单）
                                  ├─ 读：hc terminal.list / doc.get herdr-app / server.status / machine.list
                                  ├─ 读：~/.config/herdr-app/settings.json、当前 layout 的主题
                                  └─ 改：herdr-app do <放行的命令>   ← 只有这一条写路径
```

### 5.3 宿主新增的方法（全部进白名单）

| 方法 | 做什么 | 说明 |
|---|---|---|
| `herdr.caps` | 这台 Mac 支持哪些操作、有哪些 agent 可开 | 来自 `herdr-app commands`，以及 PATH 上的 `claude` / `codex` |
| 扩展 `terminals.list` | 多给 `parent`、`pinned`、`machine` 字段 | 只是多给字段，旧客户端不受影响 |
| `mac.info` | Herdr 和 core 的版本、有没有等待中的更新、其他机器、已配对设备 | 只读 |
| `herdr.do` | 执行一个放行的命令 | 见下表 |
| `mac.settings.set` | 只改放行的设置项 | 第一版只放行 `sounds.enabled` |

`herdr.do` 放行的命令（第 2 步）：

| 命令 | 允许的参数 | 手机上要确认吗 |
|---|---|---|
| `tab.new` | `space`；`agent`（只能是 caps 里的名字，宿主换成 argv）；`task`（文字，有长度上限）；`name` | 不用 |
| `space.rename` / `tab.rename` | `id`、`name`（有长度上限） | 不用 |
| `terminal.pin` | `terminal`、`pinned` | 不用 |
| `tab.close` | `id`；宿主补上 `confirmed: true` | **要**，并写明会结束里面的程序 |
| `terminal.kill` | `terminal` | **要** |

不放行：`space.new`（以后再说）、`pane.*`、`layout.*`、`app.reset`、`app.quit`、`window.*`，以及所有带 `argv` 的自由参数。

### 5.4 手机界面

- **首页**
  - 置顶的 agent 排在最上面。
  - 子 agent 缩进，挂在父 agent 下，默认收起。
  - 「做完了」用绿点表示。打开那个终端后，绿点在手机上消失，Mac 上不受影响。
  - 其他机器的工作区放在下面，带机器名。
  - 工作区标题上的 ＋ 改成小菜单：「Claude Code」「Codex」「Shell」，可以顺手写第一句任务。可以用语音输入任务。
- **长按一行**：改名、置顶、结束（要确认）。
- **设置页**分两组：
  - 「这台手机」：字号、按键条要哪些键、主题（跟随 Mac / 深色 / 浅色）、通知、语音。
  - 「这台 Mac」：Herdr 和 core 的版本、更新状态、其他机器（只看）、提示音开关、已配对设备（可以移除别的设备）、中继地址、取消配对。

### 5.5 第 4 步：mod 面板（以后做）

Mac 上的 `changes`（git 改动）和 `files`（文件树）对手机审阅 agent 的工作有用。做法是给宿主加专用的只读方法，例如 `space.changes`：在这个工作区的仓库里跑固定的 `git status` / `git diff`，有大小上限。不开放任意命令（`machine.exec` 不进白名单）。

## 6. 分步计划

| 步 | 内容 | 改动范围 | 验收（外部检查） |
|---|---|---|---|
| 1 | 只读对齐：子 agent、置顶、done、其他机器、`mac.info`、设备列表 | 宿主多给字段，加 `mac.info`；首页和设置页 | 主机联调测试：子 agent 出现在父 agent 下；term-smoke 加首页截图检查 |
| 2 | 常用操作：`herdr.caps`、`herdr.do`（上表 5 个命令）、长按菜单、＋ 菜单 | 宿主白名单和参数校验；首页菜单 | 单元测试：白名单外的命令和参数都被拒绝；在**临时 Herdr 实例**上跑 tab.new 带任务 |
| 3 | 设置：手机字号、按键条、主题跟随 Mac，Mac 提示音，更新（要确认） | 设置页；`mac.settings.set` | 改提示音后 `settings.json` 只变一项；手机字号不影响 Mac |
| 4 | mod 面板：git 改动和文件只读查看 | 宿主专用只读方法 | 大仓库下有上限，不超时 |

iOS 原生 app 以后直接用同一套宿主方法，宿主不用再改。

## 7. 风险和要先验证的事

以下是**猜测**，动手前要先验证：

1. **`herdr-app do tab.new` 会不会把 Mac 屏幕切到新标签。** 如果会，就违反原则 3。办法：先在临时 Herdr 实例（`HERDR_APP_HOME` 指向别处）上试。如果它会抢焦点，就继续用现在的做法：带 `herdr.space` / `herdr.tab` 标签直接让 core 开终端，Herdr 会自动收进去（说明文档里写了这条路）。第一句任务改用 `terminal.send` 送。
2. **Herdr.app 没开时。** `herdr-app do` 要窗口在运行。这时手机只能看，操作按钮置灰，并说明原因。新建标签可以退回上面的 core 标签做法。
3. **更新会重启 Herdr.app。** 终端由 core 保持，不会断，但 Mac 窗口会闪一下。所以要确认，并写明「Mac 上的 Herdr 窗口会重启」。
4. **安全面变大。** 每加一个写操作，被盗手机能做的事就多一点。对策：
   - 白名单加参数校验；
   - 结束和关闭这类操作要确认；
   - 设置页可以移除丢失的设备（已有 `device.forget`）；
   - 宿主日志记下每个写操作，但不记内容。

## 8. 要你拍板的事

1. 手机能不能改 **Mac 的**设置？建议：第一版只放行提示音开关，其他只看。
2. 手机能不能**关闭标签、结束终端**？建议：能，但每次都要确认。
3. 「做完了」的绿点，手机看过以后要不要同步给 Mac？建议：不同步。Herdr 的规则是每块屏幕各管各的。
