---
title: wayne-herdr-mods Issue 与待定事项队列
description: 面向 Agent 自动开发、测试与修复的 6 态原子任务看板。
---

# Issue 队列

Agent 自动处理规则：只认领 `Ready` 栏的条目；修完用 `git commit --only -- <paths>` 提交，同步更新 [DESIGN.md](../../DESIGN.md)，将条目移入 `Done` 并删除对应的单张 `I-*.md` 卡片文件。

## 1. Ready（Agent 可直接认领）

（当前无待修代码缺陷）

## 2. Needs Decision（等用户拍板）

| ID | 领域 | 需拍板问题 | 选项与推荐 |
|---|---|---|---|
| [I-002](I-002-phone-herdr-actions.md) | 手机与 Herdr 对齐 | 手机端写操作白名单范围（新建带任务的 Agent、关标签/结束终端、改 Mac 提示音） | 见卡片内 3 项拍板清单 |
| [I-003](I-003-mac-to-mac-via-tunnel.md) | 多设备同步 | 是否启动 `wayne-herdr-mods via` 让另一台 Mac 的 Herdr.app 经加密中继挂载本机工作区 | 需要跨 Mac 协同操作同一套终端时再启动 |
| [I-004](I-004-ios-native-app.md) | 手机推送与独立 App | 先做第 0 步（主屏幕 Web App 推送，0 元），一周后是否开 $99 账号做薄壳 App + APNs + 锁屏回答 | 推荐先第 0 步；设计见 [docs/native-app.html](../native-app.html) |

## 3. External Blocked / Ops Approval（跨仓阻塞或需本机配置授权）

| ID | 类型 | 需授权操作 | 说明 |
|---|---|---|---|
| [I-001](I-001-clean-claude-tmp-residue.md) | `ops-approval` | 清理本机 `~/.claude.json` 与旧目录模型文件 | 删除测试遗留的 `/private/tmp/cc-classic` 记录及未使用的 `~/.local/share/herdr-relay/models/`（574 MB） |

## 4. Verifying（已提交，待真机核验）

| ID | 领域 | 标题 | Commit | 测试 |
|---|---|---|---|---|

## 5. Done（最近已闭环，单卡已删）

| ID | 领域 | 标题 | Commit | 测试 | 日期 |
|---|---|---|---|---|---|
| I-000 | `herdr-app` | `my-files` 文件树/预览复制与 Markdown 半透明选区修复 | `50bfd18` | `herdr-app check` | 2026-11-05 |
