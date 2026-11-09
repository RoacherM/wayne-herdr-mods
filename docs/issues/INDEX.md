---
title: wayne-herdr-mods Issue 与待定事项队列
description: 面向 Agent 自动开发、测试与修复的 6 态原子任务看板。
---

# Issue 队列

Agent 自动处理规则：只认领 `Ready` 栏的条目；修完用 `git commit --only -- <paths>` 提交，同步更新 [DESIGN.md](../../DESIGN.md)，将条目移入 `Done` 并删除对应的单张 `I-*.md` 卡片文件。

## 1. Ready（Agent 可直接认领）

| ID | 优先级 | 领域 | 标题 |
|---|---|---|---|
| [I-004](I-004-pairing-rehello-sas-bypass.md) | P0 | 安全 / 配对 | 配对确认中途重发 hello，宿主把新密钥加进信任表（SAS 被绕过） |
| [I-005](I-005-core-release-unregistered-channel.md) | P1 | 宿主流 | `Core.release()` 对没注册的通道不发 CLOSE，viewer 留在 herdr-core 里 |
| [I-006](I-006-ios-voice-release-before-start.md) | P1 | 语音 | 原生 App：`voice.start` 回来前松手，会录满 60 秒再输入 |

来源：2026-11-09 隐式状态机盘点（DESIGN.md「终端会话状态机」→「其它隐式状态机」）。

## 2. Needs Decision（等用户拍板）

| ID | 领域 | 需拍板问题 | 选项与推荐 |
|---|---|---|---|
| [I-002](I-002-phone-herdr-actions.md) | 手机与 Herdr 对齐 | 手机端写操作白名单范围（新建带任务的 Agent、关标签/结束终端、改 Mac 提示音） | 见卡片内 3 项拍板清单 |
| [I-003](I-003-mac-to-mac-via-tunnel.md) | 多设备同步 | 是否启动 `wayne-herdr-mods via` 让另一台 Mac 的 Herdr.app 经加密中继挂载本机工作区 | 需要跨 Mac 协同操作同一套终端时再启动 |

## 2.5 In Progress

| ID | 领域 | 标题 | 现状 |
|---|---|---|---|

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
| I-004 | `ios` | nsh 原生 Herdr iOS App（免费账号，不上架） | `82a83dd` | `nsh test App.test.tsx` + 真机 iPhone | 2026-11-07 |
| I-000 | `herdr-app` | `my-files` 文件树/预览复制与 Markdown 半透明选区修复 | `50bfd18` | `herdr-app check` | 2026-11-05 |
