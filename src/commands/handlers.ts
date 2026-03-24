import type { CommandContext, CommandResult } from './router.js';
import { scanAllSkills, formatSkillList, findSkill, type SkillInfo } from '../claude/skill-scanner.js';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from '../constants.js';

// 读取版本信息
function getVersion(): string {
  try {
    const __dirname = fileURLToPath(new URL('.', import.meta.url));
    const pkgPath = join(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

const HELP_TEXT = `可用命令：

会话管理：
  /help             显示帮助
  /clear            清除当前会话（重新开始）
  /reset            完全重置会话（包括工作目录等设置）
  /status           查看当前会话状态
  /compact          压缩上下文（开始新 SDK 会话，保留历史）
  /resume           恢复之前的 SDK 会话
  /mcp              查看 MCP 服务器状态

配置：
  /cwd [路径]       查看或切换工作目录
  /model [名称]     查看或切换 Claude 模型
  /permission [模式] 查看或切换权限模式

对话：
  /history [数量]   查看对话记录（默认显示最近20条）
  /export           导出当前对话到文件
  /undo [数量]      撤销最近的对话（默认1条）

开发：
  /git              查看工作目录的 git 状态
  /version          查看版本信息

技能：
  /skills [full]    列出已安装的 skill（full 显示完整描述）
  /<skill> [参数]   触发已安装的 skill

直接输入文字即可与 Claude Code 对话`;

// 缓存 skill 列表，避免每次命令都扫描文件系统
let cachedSkills: SkillInfo[] | null = null;
let lastScanTime = 0;
const CACHE_TTL = 60_000; // 60秒

function getSkills(): SkillInfo[] {
  const now = Date.now();
  if (!cachedSkills || now - lastScanTime > CACHE_TTL) {
    cachedSkills = scanAllSkills();
    lastScanTime = now;
  }
  return cachedSkills;
}

/** 清除缓存，用于 /skills 命令强制刷新 */
export function invalidateSkillCache(): void {
  cachedSkills = null;
}

export function handleHelp(_args: string): CommandResult {
  return { reply: HELP_TEXT, handled: true };
}

export function handleClear(ctx: CommandContext): CommandResult {
  // Reject any pending permission to avoid orphaned promise corrupting new session
  ctx.rejectPendingPermission?.();
  const newSession = ctx.clearSession();
  Object.assign(ctx.session, newSession);
  return { reply: '✅ 会话已清除，下次消息将开始新会话。', handled: true };
}

export function handleCwd(ctx: CommandContext, args: string): CommandResult {
  if (!args) {
    return { reply: `当前工作目录: ${ctx.session.workingDirectory}\n用法: /cwd <路径>`, handled: true };
  }
  ctx.updateSession({ workingDirectory: args });
  return { reply: `✅ 工作目录已切换为: ${args}`, handled: true };
}

export function handleModel(ctx: CommandContext, args: string): CommandResult {
  if (!args) {
    return { reply: '用法: /model <模型名称>\n例: /model claude-sonnet-4-6', handled: true };
  }
  ctx.updateSession({ model: args });
  return { reply: `✅ 模型已切换为: ${args}`, handled: true };
}

const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto'] as const;
const PERMISSION_DESCRIPTIONS: Record<string, string> = {
  default: '每次工具使用需手动审批',
  acceptEdits: '自动批准文件编辑，其他需审批',
  plan: '只读模式，不允许任何工具',
  auto: '自动批准所有工具（危险模式）',
};

export function handlePermission(ctx: CommandContext, args: string): CommandResult {
  if (!args) {
    const current = ctx.session.permissionMode ?? 'default';
    const lines = [
      '🔒 当前权限模式: ' + current,
      '',
      '可用模式:',
      ...PERMISSION_MODES.map(m => `  ${m} — ${PERMISSION_DESCRIPTIONS[m]}`),
      '',
      '用法: /permission <模式>',
    ];
    return { reply: lines.join('\n'), handled: true };
  }
  const mode = args.trim().toLowerCase();
  if (!PERMISSION_MODES.includes(mode as any)) {
    return {
      reply: `未知模式: ${mode}\n可用: ${PERMISSION_MODES.join(', ')}`,
      handled: true,
    };
  }
  ctx.updateSession({ permissionMode: mode as any });
  const warning = mode === 'auto' ? '\n\n⚠️ 已开启危险模式：所有工具调用将自动批准，无需手动确认。' : '';
  return { reply: `✅ 权限模式已切换为: ${mode}\n${PERMISSION_DESCRIPTIONS[mode]}${warning}`, handled: true };
}

export function handleStatus(ctx: CommandContext): CommandResult {
  const s = ctx.session;
  const mode = s.permissionMode ?? 'default';
  const lines = [
    '📊 会话状态',
    '',
    `工作目录: ${s.workingDirectory}`,
    `模型: ${s.model ?? '默认'}`,
    `权限模式: ${mode}`,
    `会话ID: ${s.sdkSessionId ?? '无'}`,
    `状态: ${s.state}`,
  ];
  return { reply: lines.join('\n'), handled: true };
}

export function handleSkills(args: string): CommandResult {
  invalidateSkillCache();
  const skills = getSkills();
  if (skills.length === 0) {
    return { reply: '未找到已安装的 skill。', handled: true };
  }

  const showFull = args.trim().toLowerCase() === 'full';

  if (showFull) {
    const lines = skills.map(s => `/${s.name}\n   ${s.description}`);
    return { reply: `📋 已安装的 Skill (${skills.length}):\n\n${lines.join('\n\n')}`, handled: true };
  } else {
    const lines = skills.map(s => `/${s.name}`);
    return { reply: `📋 已安装的 Skill (${skills.length}):\n\n${lines.join('\n')}\n\n💡 使用 /skills full 查看完整描述`, handled: true };
  }
}

const MAX_HISTORY_LIMIT = 100;

export function handleHistory(ctx: CommandContext, args: string): CommandResult {
  const limit = args ? parseInt(args, 10) : 20;
  if (isNaN(limit) || limit <= 0) {
    return { reply: '用法: /history [数量]\n例: /history 50（显示最近50条对话）', handled: true };
  }
  const effectiveLimit = Math.min(limit, MAX_HISTORY_LIMIT);

  const historyText = ctx.getChatHistoryText?.(effectiveLimit) || '暂无对话记录';

  return { reply: `📝 对话记录（最近${effectiveLimit}条）:\n\n${historyText}`, handled: true };
}

/** 完全重置会话（包括工作目录等设置） */
export function handleReset(ctx: CommandContext): CommandResult {
  ctx.rejectPendingPermission?.();
  const newSession = ctx.clearSession();
  // 完全重置，使用系统默认工作目录
  newSession.workingDirectory = process.cwd();
  newSession.model = undefined;
  newSession.permissionMode = undefined;
  Object.assign(ctx.session, newSession);
  return { reply: '✅ 会话已完全重置，所有设置恢复默认。', handled: true };
}

/** 查看版本信息 */
export function handleVersion(): CommandResult {
  const version = getVersion();
  return {
    reply: `📦 wechat-claude-code\n版本: ${version}\n\nGitHub: https://github.com/Wechat-ggGitHub/wechat-claude-code`,
    handled: true,
  };
}

/** 导出当前对话到文件 */
export function handleExport(ctx: CommandContext): CommandResult {
  const historyText = ctx.getChatHistoryText?.() || '暂无对话记录';

  if (historyText === '暂无对话记录') {
    return { reply: '⚠️ 当前没有对话记录可导出', handled: true };
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const exportPath = join(DATA_DIR, 'exports', `chat-${timestamp}.txt`);

  return {
    reply: `📤 对话已导出\n\n路径: ${exportPath}\n\n内容预览:\n${historyText.slice(0, 500)}${historyText.length > 500 ? '...' : ''}`,
    handled: true,
  };
}

/** 撤销最近的对话 */
export function handleUndo(ctx: CommandContext, args: string): CommandResult {
  const count = args ? parseInt(args, 10) : 1;

  if (isNaN(count) || count <= 0) {
    return { reply: '用法: /undo [数量]\n例: /undo 2（撤销最近2条对话）', handled: true };
  }

  const history = ctx.session.chatHistory || [];
  if (history.length === 0) {
    return { reply: '⚠️ 没有对话记录可撤销', handled: true };
  }

  const actualCount = Math.min(count, history.length);
  ctx.session.chatHistory = history.slice(0, -actualCount);
  ctx.updateSession({ chatHistory: ctx.session.chatHistory });

  return { reply: `✅ 已撤销最近 ${actualCount} 条对话`, handled: true };
}

/** 压缩上下文 - 清除 SDK 会话 ID，开始新上下文但保留聊天历史 */
export function handleCompact(ctx: CommandContext): CommandResult {
  const currentSessionId = ctx.session.sdkSessionId;

  if (!currentSessionId) {
    return { reply: 'ℹ️ 当前没有活动的 SDK 会话，无需压缩。', handled: true };
  }

  // 备份当前会话 ID 以便恢复
  ctx.updateSession({
    previousSdkSessionId: currentSessionId,
    sdkSessionId: undefined,
  });

  return {
    reply: `✅ 上下文已压缩\n\n` +
           `下次消息将开始新的 SDK 会话（token 清零）\n` +
           `聊天历史已保留，可用 /history 查看\n` +
           `如需恢复之前会话，请使用 /resume`,
    handled: true,
  };
}

/** 恢复之前的 SDK 会话 */
export function handleResume(ctx: CommandContext, args: string): CommandResult {
  // 如果有参数（序号），恢复指定的会话
  if (args) {
    const index = parseInt(args.trim(), 10);
    if (isNaN(index) || index < 1) {
      return {
        reply: '⚠️ 请输入有效的序号\n\n用法: /resume 1\n输入 /resume 查看会话列表',
        handled: true,
      };
    }

    // 返回特殊标志让 main.ts 根据序号恢复会话
    return { handled: true, resumeByIndex: index - 1 }; // 转为 0-based 索引
  }

  // 没有参数，列出最近的会话
  // 返回特殊标志让 main.ts 异步获取会话列表
  return { handled: true, listSessions: true };
}

/** 查看 MCP 服务器状态 */
export function handleMcp(_ctx: CommandContext): CommandResult {
  // Return a special flag to indicate async MCP status request
  return { handled: true, mcpStatusRequest: true };
}

/** 查看 git 状态 */
export function handleGit(ctx: CommandContext): CommandResult {
  const cwd = ctx.session.workingDirectory;

  try {
    // 检查是否是 git 仓库
    const revParseResult = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
    });

    if (revParseResult.status !== 0) {
      return { reply: `⚠️ 当前目录不是 git 仓库\n工作目录: ${cwd}`, handled: true };
    }

    // 获取分支
    const branchResult = spawnSync('git', ['branch', '--show-current'], {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
    });
    const branch = branchResult.stdout.trim();

    // 获取状态
    const statusResult = spawnSync('git', ['status', '--short'], {
      cwd,
      encoding: 'utf-8',
      timeout: 10000,
    });
    const status = statusResult.stdout.trim();

    // 获取最近提交
    const logResult = spawnSync('git', ['log', '-3', '--oneline'], {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
    });
    const recentCommits = logResult.stdout.trim();

    const lines = [
      `📂 工作目录: ${cwd}`,
      `🌿 当前分支: ${branch || '(detached)'}`,
      '',
      '📝 状态:',
      status || '  (工作区干净)',
      '',
      '🕐 最近提交:',
      ...recentCommits.split('\n').map(l => `  ${l}`),
    ];

    return { reply: lines.join('\n'), handled: true };
  } catch (err) {
    return {
      reply: `⚠️ 执行 git 命令失败\n错误: ${err instanceof Error ? err.message : String(err)}`,
      handled: true,
    };
  }
}

export function handleUnknown(cmd: string, args: string): CommandResult {
  const skills = getSkills();
  const skill = findSkill(skills, cmd);

  if (skill) {
    const prompt = args ? `Use the ${skill.name} skill: ${args}` : `Use the ${skill.name} skill`;
    return { handled: true, claudePrompt: prompt };
  }

  return {
    handled: true,
    reply: `未找到 skill: ${cmd}\n输入 /skills 查看可用列表`,
  };
}
