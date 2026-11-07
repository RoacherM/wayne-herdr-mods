---
id: I-004
title: nsh 原生 Herdr iOS App（免费账号，不上架）
status: in-progress
priority: P1
subsystem: DESIGN.md
repo: self
files:
  - docs/native-app.html
  - host/push.js
  - host/phones.js
  - relay/public/sw.js
  - ios/App.tsx
  - ios/host/
---

## 2026-11-07 决定与进度
用户决定做 nsh 原生 App，只用免费账号、不上架、不做推送。终端先用 WebView 里的 xterm.js，语音继续走火山，多台 Mac 做进 App。
- 已完成：`ios/term/term.js`（对齐网页版不闪、Unicode 15、手机自适应格子 `fit`、Mac 惯性滑行 `term.coast`、`↓` 回到最新）、`ios/App.tsx`（最新键盘栏 + agent 快捷键 + 修饰键 `term.press`、光标显隐 `hold`、一键收起键盘、按住说话、扫码配对、多台 Mac 切换）、`ios/host/Sources/App.swift`（`AVAudioRecorder` 录音 + `AVCaptureSession` 扫码 + 触感反馈），并通过 `ios/host/install.sh` 编译签名安装到真机 iPhone。
- 待真机核验：手机「设置 ▸ 通用 ▸ VPN 与设备管理」信任开发者证书后，打开 Herdr App 扫码或从剪贴板粘贴配对。

## 背景
用户 2026-11-06 说交互已经够好，痛点是：1. agent 完成或要授权时收不到推送；2. 依赖浏览器，想要独立 App。没有 Apple 付费账号，必要时可以开。

实测：推送代码完整，但设备「推送关」。最近 7 天 1790 条手机指标全是 `chrome`、`standalone: false`。iOS 只给主屏幕 Web App 推送。

## 设计
完整设计、术语、选项对比、屏幕原型见 [docs/native-app.html](../native-app.html)。要点：
- 第 0 步（0 元）：主屏幕 Web App + 现有 Web Push，量一周到达率。
- 第 1–3 步（$99/年）：薄壳 App（WKWebView 跑现在的手机页）+ APNs（NSE 解密）+ 锁屏按钮直接回答（`term.answer` 核对问题没变）。
- 不用 nsh 重写界面；不做免费账号 App（不能推送、7 天失效）。
- 原「nsh + libghostty-vt 原生终端」只在真机终端掉帧时再考虑，目前没出现。

## 需拍板
1. 现在：用户做第 0 步（添加到主屏幕、重新扫码、开启通知）；Agent 同时做推送到达率统计。
2. 一周后：到达 ≥ 95%、延迟中位数 < 10 秒、「点通知再回答」够用 → 关闭本卡；否则开账号做第 1–3 步。

## verify
- 第 0 步：`wayne-herdr-mods devices` 显示「推送开」；设置页「发一条测试」在锁屏收到；`wayne-herdr-mods metrics` 有「推送：发出 N，收到 M」。
