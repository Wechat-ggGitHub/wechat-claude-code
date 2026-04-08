---
name: wechat-claude-code
description: 微信消息桥接 - 在微信中与 Claude Code 聊天。支持文字对话、图片识别、权限审批、斜杠命令。
---

# WeChat Claude Code Bridge

通过个人微信与本地 Claude Code 进行对话。

## 前置条件

- Node.js >= 18
- macOS / Linux / Windows（Git Bash）
- 个人微信账号（需扫码绑定）
- 已安装 Claude Code（`@anthropic-ai/claude-agent-sdk`）

## 安装

```bash
cd ~/.claude/skills/wechat-claude-code
npm install
```

`postinstall` 脚本会自动执行 `npm run build` 编译 TypeScript。

## 触发场景

用户提到"微信桥接"、"微信聊天"、"wechat bridge"、"连接微信"、"微信状态"、"停止微信"等与微信桥接相关的话题时触发。

## 触发后的执行流程

**被触发时，不要直接执行任何操作，先探查当前状态再给出可用操作。**

按顺序检查以下状态：

### 第 1 步：检查是否已安装

```bash
cd ~/.claude/skills/wechat-claude-code && test -d node_modules && echo "installed" || echo "not_installed"
```

- 如果 `not_installed`：提示用户运行 `cd ~/.claude/skills/wechat-claude-code && npm install` 安装依赖，然后停止。

### 第 2 步：检查是否已绑定微信账号

```bash
ls ~/.wechat-claude-code/accounts/*.json 2>/dev/null | head -1
```

- 如果没有账号文件：提示用户需要先执行 setup 扫码绑定，询问是否现在执行。
- 如果有账号文件：继续下一步。

### 第 3 步：检查 daemon 运行状态

```bash
cd ~/.claude/skills/wechat-claude-code && npm run daemon -- status
```

### 第 4 步：根据状态展示信息

**如果 daemon 未运行：**

```
微信桥接已绑定但未运行。

可用操作：
  setup    重新扫码绑定（换号或过期时使用）
  start    启动服务
  logs     查看上次运行的日志
```

**如果 daemon 正在运行：**

```
微信桥接正在运行（PID: xxx）。

可用操作：
  stop     停止服务
  restart  重启服务（代码更新后使用）
  logs     查看运行日志

微信端命令（直接在微信中发送）：
  /help    显示帮助
  /clear   清除当前会话，开始新对话
  /status  查看当前会话状态
  /model   切换 Claude 模型
  /skills  查看已安装的 skill
```

如果用户明确指定了操作（如"启动微信"、"停止微信服务"、"看看日志"等），跳过状态展示直接执行对应命令。

## 子命令参考

所有命令的工作目录为 `~/.claude/skills/wechat-claude-code`。

| 命令 | 执行 | 说明 |
|------|------|------|
| setup | `npm run setup` | 首次安装向导：生成 QR 码 → 微信扫码 → 配置工作目录 |
| start | `npm run daemon -- start` | 启动 launchd 守护进程（开机自启、自动重启） |
| stop | `npm run daemon -- stop` | 停止守护进程 |
| restart | `npm run daemon -- restart` | 重启守护进程 |
| status | `npm run daemon -- status` | 查看运行状态 |
| logs | `npm run daemon -- logs` | 查看最近日志（tail -100） |

## 权限审批

当 Claude 请求执行工具时，微信会收到权限请求消息：
- 回复 `y` 或 `yes` 允许
- 回复 `n` 或 `no` 拒绝
- 60 秒未回复自动拒绝并通知

## 数据目录

所有数据存储在 `~/.wechat-claude-code/`：

```
~/.wechat-claude-code/
├── accounts/       # 绑定的微信账号数据（每个账号一个 JSON）
├── config.env      # 全局配置（工作目录、模型、权限模式）
├── sessions/       # 会话数据（每个账号一个 JSON）
├── get_updates_buf # 消息轮询同步缓冲
└── logs/           # 运行日志（每日轮转，保留 30 天）
```
