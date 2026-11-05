---
name: wayne-herdr-mods
description: "Wayne 的 Herdr 套件：用手机浏览器操作这台 Mac 上 Herdr 的终端（配对手机、看谁在线、移除手机），以及 Herdr.app 里我们自己的界面（布局 main-preview、标签栏、文件面板、「手机」窗口）。用户提到手机连 Mac、配对手机、herdr-relay、wayne-herdr-mods，或要改 Herdr.app 的这套界面时使用。"
---

# wayne-herdr-mods

两部分：

- **手机**：后台服务（launchd 常驻）把 Herdr 的终端通过中继端到端加密地给手机网页。手机打开终端时，终端换成手机的大小；回到 Mac 上打字，就换回 Mac 的大小。
- **Herdr.app 里的界面**：仓库 `herdr-app/` 和 `~/.config/herdr-app/` 一一对应。标签栏右上角的手机图标打开「手机」窗口。

命令是 `wayne-herdr-mods`。不存在就是没装，见「安装」。（旧名 herdr-relay，2026-11-04 改名，旧命令已删。）

## 先看状态

```sh
wayne-herdr-mods status       # 中继、herdr-core、几台手机在线
wayne-herdr-mods devices      # 已配对的手机：id 前 8 位、名字、在线、推送、上次连接
wayne-herdr-mods ctl status   # 同样的信息，JSON（脚本用这个）
```

`relay` 或 `core` 不是 `online` 时，先看日志 `~/Library/Logs/wayne-herdr-mods.log`。不要重启 Herdr.app 或 herdr-core；后台服务会自己等它们回来。

## 配对一台手机

配对只在 Herdr.app 里做：标签栏右上角的手机图标打开「手机」窗口，点「配对新手机」。要人做的：用手机相机扫码，核对手机和 Mac 上的 6 位数字，一样就点「允许」。

你可以替人把二维码摆出来：

```sh
wayne-herdr-mods pair    # 打开「手机」窗口并显示二维码，马上返回
```

然后告诉人去扫码、核对数字。二维码 10 分钟后失效，只能配一台。关掉窗口，没扫的二维码就作废。

不要替人点「允许」（`ctl pair.decide`）：核对数字就是为了确认扫码的是这个人自己的手机。

## 移除一台手机

先问人。移除后那台手机要重新扫码。

```sh
wayne-herdr-mods devices rm <id>     # id 用 devices 列出的前 8 位
```

## 等变化（脚本、等手机上线）

```sh
wayne-herdr-mods ctl watch '{"ms":20000}'   # 有变化就返回新状态，最多等 20 秒
```

`ctl` 的方法：`status`、`watch {ms}`、`pair.start`、`pair.cancel`、`pair.decide {allow}`、`devices.remove {id}`。输出一行 JSON；有二维码时带 `pairing.offer.qrSvg`。

## 手机体验好不好（延迟、卡顿）

```sh
wayne-herdr-mods metrics --json --days 7   # 真实手机的数字：每个测量按直连、中继分开，p50 和 p95（毫秒）
wayne-herdr-mods metrics                   # 同样的内容，打开一个报告页给人看
```

测量：`echo.paint` 打字到看见、`scroll.lag` 全屏程序里滑动到画面跟上、`open.ms` 打开终端、`resume.paint` 切回页面到画出来、`resume.ready` 切回到连接恢复、`rtt.ms` 往返（含排队）、`rtt.ice` 直连时的网络往返（不含排队）、`macscroll.prog` 程序回应滚轮（Mac 上，不含网络）、`macscroll.behind` 滑动时在路上的数据（KB）、`reprint.kb` / `reprint.ms` 程序清掉历史整段重印的大小、到手机拿到新画面的时间（Mac 上；超过 64 KB 换成新首屏，`fresh: true`）、`scroll.p95` 滑动时慢的帧。原始记录每天一个文件：`~/.config/wayne-herdr-mods/metrics/YYYY-MM-DD.jsonl`。改了手机网页或连接的代码后，在仓库里跑 `node dev/bench.mjs`（只看滑动：`--scroll`）（要先 `npm run build` 和 `npm run relay:dev`）：它和上次比，慢了 20% 以上会指出来，退出码 1。

## 改 Herdr.app 的界面

源文件在仓库的 `herdr-app/`（`layouts/main-preview.json`、`mods/my-tabs/`、`mods/my-files/`、`mods/wayne-phones/`）。改仓库里的，不要只改 `~/.config/herdr-app/` 里的：下次安装会覆盖。

```sh
npm run build && node dist/wayne-herdr-mods.mjs install   # 只写改了的文件，Herdr 自动重新加载
herdr-app check ~/.config/herdr-app/mods/my-tabs           # 检查一个 mod
herdr-app status                                           # errors 里有加载失败的 mod
herdr-app do mod.open --name wayne-phones                  # 打开或关上「手机」窗口
```

mod 怎么写：`~/.config/herdr-app/AGENTS.md`。`my-tabs`、`my-files` 复制自 Herdr 0.1.12 的 `tabs`、`files`，不会跟着 Herdr 更新。

## 安装

在仓库里：

```sh
npm install && npm run build && node dist/wayne-herdr-mods.mjs install
```

这会装好命令、后台服务、Herdr.app 的界面和这个 skill。装过旧的 herdr-relay 的话，它的密钥、已配对的手机、语音 Key 和日志会一起搬过来。设计和每条规则的原因在仓库的 `DESIGN.md`。
