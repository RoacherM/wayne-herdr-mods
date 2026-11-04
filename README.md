# herdr-relay

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
- 多个 Mac 窗口同时看：手机跟随 Mac 的尺寸，不抢；手机上和 Mac 一样的排版，左右滑动看全

## 安装

```sh
npm install
npm run relay:deploy                 # 部署中继到你的 Cloudflare 账号（改 relay/wrangler.jsonc 和 host/service.js 里的地址）
npm run build
node dist/herdr-relay.mjs install    # 复制到 ~/.local/share/herdr-relay，装 LaunchAgent
herdr-relay pair                     # 手机扫码，核对 6 位数字（Herdr.app 里也可以在「手机」窗口里配对和管理）
herdr-relay voice key                # 可选：火山「录音文件识别 2.0 标准版」的 API Key，存进钥匙串
```

## 测试

```sh
npm run relay:dev                                  # 本地中继
RELAY=http://127.0.0.1:8799 npm test               # 加密 + 全链路（在独立的 scratch herdr-core 上）
node probe/sync.mjs                                # herdr-core 多窗口规则
```

设计、协议、验证结果和没验证的部分：见 [DESIGN.md](DESIGN.md)。
