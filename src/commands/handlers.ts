import type { CommandContext, CommandResult } from './router.js';
import { scanAllSkills, formatSkillList, findSkill, type SkillInfo } from '../claude/skill-scanner.js';
import { loadConfig, saveConfig } from '../config.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HELP_TEXT = `可用命令：

会话管理：
  /help             显示帮助
  /clear            清除当前会话
  /reset            完全重置（包括工作目录等设置）
  /status           查看当前会话状态
  /compact          压缩上下文（开始新 SDK 会话，保留历史）
  /history [数量]   查看对话记录（默认最近20条）
  /undo [数量]      撤销最近对话（默认1条）

配置：
  /cwd [路径]       查看或切换工作目录
  /model [名称]     查看或切换 Claude 模型
  /permission [模式] 查看或切换权限模式
  /prompt [内容]    查看或设置系统提示词（全局生效）

其他：
  /skills [full]    列出已安装的 skill（full 显示描述）
  /version          查看版本信息
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
  const mode = args.trim();
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
  }
  const lines = skills.map(s => `/${s.name}`);
  return { reply: `📋 已安装的 Skill (${skills.length}):\n\n${lines.join('\n')}\n\n使用 /skills full 查看完整描述`, handled: true };
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
  newSession.workingDirectory = process.cwd();
  newSession.model = undefined;
  newSession.permissionMode = undefined;
  Object.assign(ctx.session, newSession);
  return { reply: '✅ 会话已完全重置，所有设置恢复默认。', handled: true };
}

/** 压缩上下文 — 清除 SDK 会话 ID，开始新上下文但保留聊天历史 */
export function handleCompact(ctx: CommandContext): CommandResult {
  const currentSessionId = ctx.session.sdkSessionId;
  if (!currentSessionId) {
    return { reply: 'ℹ️ 当前没有活动的 SDK 会话，无需压缩。', handled: true };
  }
  ctx.updateSession({
    previousSdkSessionId: currentSessionId,
    sdkSessionId: undefined,
  });
  return {
    reply: '✅ 上下文已压缩\n\n下次消息将开始新的 SDK 会话（token 清零）\n聊天历史已保留，可用 /history 查看',
    handled: true,
  };
}

/** 撤销最近 N 条对话 */
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

/** 查看版本信息 */
export function handleVersion(): CommandResult {
  try {
    const __dirname = fileURLToPath(new URL('.', import.meta.url));
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'));
    const version = pkg.version || 'unknown';
    return { reply: `wechat-claude-code v${version}`, handled: true };
  } catch {
    return { reply: 'wechat-claude-code (version unknown)', handled: true };
  }
}

export function handlePrompt(_ctx: CommandContext, args: string): CommandResult {
  const config = loadConfig();
  if (!args) {
    const current = config.systemPrompt;
    if (current) {
      return { reply: `📝 当前系统提示词:\n${current}\n\n用法:\n/prompt <提示词>  — 设置\n/prompt clear   — 清除`, handled: true };
    }
    return { reply: '📝 暂无系统提示词\n\n用法: /prompt <提示词>\n例: /prompt 用中文回答我', handled: true };
  }
  if (args.trim().toLowerCase() === 'clear') {
    config.systemPrompt = undefined;
    saveConfig(config);
    return { reply: '✅ 系统提示词已清除', handled: true };
  }
  config.systemPrompt = args.trim();
  saveConfig(config);
  return { reply: `✅ 系统提示词已设置:\n${config.systemPrompt}`, handled: true };
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
