---
id: I-001
title: 清理 ~/.claude.json 测试遗留条目与旧目录 whisper 模型文件
status: ops-approval
priority: P2
subsystem: DESIGN.md
repo: self
---

## 背景與來源
1. 2026-11-03 测试 Claude Code 普通屏幕模式（`dev/classic-smoke.mjs`）时，在 `/tmp/cc-classic` 点了信任目录，`~/.claude.json` 中留下了一条 `/private/tmp/cc-classic` 记录（当时有其它 Claude Code 正在运行，未直接修改该文件）。
2. 早期评估本地语音识别时下载的 `whisper.cpp` 模型仍留在旧目录 `~/.local/share/herdr-relay/models/`（约 574 MB），现已采用火山引擎云端识别。

## 执行条件（需用户确认）
- 确认当前没有正在写入 `~/.claude.json` 的 Claude Code 进程后，从 `~/.claude.json` 的 `projects` 字段移除 `/private/tmp/cc-classic`。
- 确认不再需要本地 `whisper.cpp` 备选后，执行 `rm -rf ~/.local/share/herdr-relay`。
