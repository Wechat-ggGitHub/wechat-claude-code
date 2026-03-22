# wechat-claude-code

[English](README.md) | **中文**

一个 [Claude Code](https://claude.ai/claude-code) Skill，将个人微信桥接到本地 Claude Code。通过手机微信与 Claude 对话——文字、图片、权限审批、斜杠命令，全部支持。

## 功能特性

- 通过微信与 Claude Code 进行文字对话
- 图片识别——发送照片让 Claude 分析
- 权限审批——在微信中回复 `y`/`n` 控制工具执行
- 斜杠命令——`/help`、`/clear`、`/model`、`/status`、`/skills`
- 在微信中触发任意已安装的 Claude Code Skill
- 跨平台守护进程——macOS (launchd) / Linux (systemd)
- 开机自启、崩溃自动重启
- 会话持久化——跨消息恢复上下文

## 前置条件

- Node.js >= 18
- macOS 或 Linux（需 systemd 支持）
- 个人微信账号（需扫码绑定）
- 已安装 [Claude Code](https://docs.anthropic.com/en/docs/claude-code)（含 `@anthropic-ai/claude-agent-sdk`）

## 安装

克隆到 Claude Code skills 目录：

```bash
git clone https://github.com/Wechat-ggGitHub/wechat-claude-code.git ~/.claude/skills/wechat-claude-code
cd ~/.claude/skills/wechat-claude-code
npm install
```

`postinstall` 脚本会自动编译 TypeScript。

## 快速开始

### 1. 首次设置

扫码绑定微信账号：

```bash
cd ~/.claude/skills/wechat-claude-code
npm run setup
```

会自动弹出二维码图片，用微信扫码后配置工作目录。

### 2. 启动服务

```bash
npm run daemon -- start
```

**macOS**: 注册 launchd 代理，实现开机自启和自动重启。
**Linux**: 创建 systemd 用户服务，实现开机自启和自动重启。

### 3. 在微信中聊天

直接在微信中发消息即可与 Claude Code 对话。

### 4. 管理服务

```bash
npm run daemon -- status   # 查看运行状态
npm run daemon -- stop     # 停止服务
npm run daemon -- restart  # 重启服务（代码更新后使用）
npm run daemon -- logs     # 查看最近日志
```

## 微信端命令

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助 |
| `/clear` | 清除当前会话（重新开始） |
| `/model <名称>` | 切换 Claude 模型 |
| `/status` | 查看当前会话状态 |
| `/skills` | 列出已安装的 Claude Code Skill |
| `/<skill> [参数]` | 触发任意已安装的 Skill |

## 权限审批

当 Claude 请求执行工具时，微信会收到权限请求：

- 回复 `y` 或 `yes` 允许
- 回复 `n` 或 `no` 拒绝
- 60 秒未回复自动拒绝

## 工作原理

```
微信（手机） ←→ ilink bot API ←→ Node.js 守护进程 ←→ Claude Code SDK（本地）
```

- 守护进程通过长轮询监听微信 ilink bot API 的新消息
- 消息通过 `@anthropic-ai/claude-agent-sdk` 转发给 Claude Code
- 回复发送回微信
- **macOS**: launchd 代理保持守护进程运行
- **Linux**: systemd 用户服务保持守护进程运行

## 数据目录

所有数据存储在 `~/.wechat-claude-code/`：

```
~/.wechat-claude-code/
├── accounts/       # 微信账号凭证（每个账号一个 JSON）
├── config.env      # 全局配置（工作目录、模型、权限模式）
├── sessions/       # 会话数据（每个账号一个 JSON）
├── get_updates_buf # 消息轮询同步缓冲
└── logs/           # 运行日志（每日轮转，保留 30 天）
```

## 开发

```bash
npm run dev    # 监听模式——TypeScript 文件变更时自动编译
npm run build  # 编译 TypeScript
```

## License

[MIT](LICENSE)
