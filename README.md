# wechat-claude-code

**English** | [中文](README_zh.md)

A [Claude Code](https://claude.ai/claude-code) Skill that bridges personal WeChat to your local Claude Code. Chat with Claude from your phone via WeChat — text, images, permission approvals, slash commands, all supported.

## Features

- Text conversation with Claude Code through WeChat
- Image recognition — send photos for Claude to analyze
- Permission approval — reply `y`/`n` in WeChat to approve Claude's tool use
- Slash commands — `/help`, `/clear`, `/model`, `/status`, `/skills`
- Launch any installed Claude Code skill from WeChat
- Cross-platform — Windows, macOS (launchd), Linux (systemd + nohup fallback)
- Session persistence — resume conversations across messages

## Prerequisites

- Node.js >= 18
- Windows, macOS or Linux
- Personal WeChat account (QR code binding required)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) with `@anthropic-ai/claude-agent-sdk` installed
  > **Note:** The SDK supports third-party API providers (e.g. OpenRouter, AWS Bedrock, custom OpenAI-compatible endpoints) — set `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` accordingly.

## Installation

Clone into your Claude Code skills directory:

```bash
git clone https://github.com/Wechat-ggGitHub/wechat-claude-code.git ~/.claude/skills/wechat-claude-code
cd ~/.claude/skills/wechat-claude-code
npm install
```

`postinstall` automatically compiles TypeScript via `tsc`.

## Quick Start

### 1. Setup (first time only)

Scan QR code to bind your WeChat account:

```bash
cd ~/.claude/skills/wechat-claude-code
npm run setup
```

A QR code image will open — scan it with WeChat. Then configure your working directory.

### 2. Start the daemon

```bash
npm run daemon -- start
```

- **Windows**: runs as background process with PID file
- **macOS**: registers a launchd agent for auto-start and auto-restart
- **Linux**: uses systemd user service (falls back to nohup if systemd unavailable)

### 3. Chat in WeChat

Send any message in WeChat to start chatting with Claude Code.

### 4. Manage the service

```bash
npm run daemon -- status   # Check if running
npm run daemon -- stop     # Stop the daemon
npm run daemon -- restart  # Restart (after code updates)
npm run daemon -- logs     # View recent logs
```

## WeChat Commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/clear` | Clear current session (start fresh) |
| `/model <name>` | Switch Claude model |
| `/permission <mode>` | Switch permission mode |
| `/status` | View current session state |
| `/skills` | List installed Claude Code skills |
| `/<skill> [args]` | Trigger any installed skill |

## Permission Approval

When Claude requests to execute a tool, you'll receive a permission request in WeChat:

- Reply `y` or `yes` to allow
- Reply `n` or `no` to deny
- No response within 120 seconds = auto-deny

You can switch permission mode with `/permission <mode>`:

| Mode | Description |
|------|-------------|
| `default` | Manual approval for each tool use |
| `acceptEdits` | Auto-approve file edits, other tools need approval |
| `plan` | Read-only mode, no tools allowed |
| `auto` | Auto-approve all tools (dangerous mode) |

## How It Works

```
WeChat (phone) ←→ ilink bot API ←→ Node.js daemon ←→ Claude Code SDK (local)
```

- The daemon long-polls WeChat's ilink bot API for new messages
- Messages are forwarded to Claude Code via `@anthropic-ai/claude-agent-sdk`
- Responses are sent back to WeChat
- Platform-native service management keeps the daemon running (background process on Windows, launchd on macOS, systemd/nohup on Linux)

## Data

All data is stored in `~/.wechat-claude-code/`:

```
~/.wechat-claude-code/
├── accounts/       # WeChat account credentials (one JSON per account)
├── config.env      # Global config (working directory, model, permission mode)
├── sessions/       # Session data (one JSON per account)
├── get_updates_buf # Message polling sync buffer
└── logs/           # Rotating logs (daily, 30-day retention)
```

## Development

```bash
npm run dev    # Watch mode — auto-compile on TypeScript changes
npm run build  # Compile TypeScript
```

## License

[MIT](LICENSE)
