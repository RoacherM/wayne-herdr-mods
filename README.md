# wayne-herdr-mods

（2026-11-04 前叫 herdr-relay。装过旧版的话，`install` 会把配置搬过来，已配对的手机不用重配。）

在手机浏览器里操作 Mac 上 [Herdr](https://herdr.dev) 的终端和 agent。不用 Tailscale：Mac 主动连 Cloudflare 上的中继，手机也连中继，中间全程端到端加密，中继只转发密文。

```
iPhone（PWA） ──wss──▶ Cloudflare Worker + Durable Object ◀──wss── Mac 后台服务 ──▶ herdr-core
```

能做的：
- 看所有终端（按 Herdr 的工作区 / 标签页分组），「需要你」的 agent 排在最前
- 实时看终端画面、直接打字、快捷键（Esc、Tab、^C、方向键、1/2/3…）
- 发消息（`terminal.send`）、发图片（落在终端旁边，消息里带路径）
- 按住说话：手机录音，Mac 调火山语音识别，文字填进输入框
- 在工作区里新建终端标签页
- agent 等你确认、出错、完成长任务时推送（添加到主屏幕后）
- 手机布局：手机打开终端，终端换成手机的大小；回到 Mac 上打字，换回 Mac 的大小，不用按键切换
- Herdr.app 里我们的界面（`herdr-app/`）：布局 main-preview、标签栏、文件面板；标签栏右上角的手机图标打开「手机」窗口，在里面配对和管理手机
- 给 agent 用：`wayne-herdr-mods --skill`（就是 `SKILL.md`），安装时也装进 `~/.agents/skills/`

## 安装

```sh
npm install
npm run relay:deploy                 # 部署中继到你的 Cloudflare 账号（改 relay/wrangler.jsonc 和 host/service.js 里的地址）
npm run build
node dist/wayne-herdr-mods.mjs install  # 装命令、LaunchAgent、Herdr.app 的界面和 agent skill
# 配对：在 Herdr.app 里点标签栏右上角的手机图标 →「配对新手机」，手机扫码，核对 6 位数字
wayne-herdr-mods voice key           # 可选：火山「录音文件识别 2.0 标准版」的 API Key，存进钥匙串
```

## 测试

```sh
npm run relay:dev                                  # 本地中继
RELAY=http://127.0.0.1:8799 npm test               # 加密 + 全链路（在独立的 scratch herdr-core 上）
node probe/sync.mjs                                # herdr-core 多窗口规则
```

设计、协议、验证结果和没验证的部分：见 [DESIGN.md](DESIGN.md)。
