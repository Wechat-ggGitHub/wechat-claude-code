import type { CommandContext, CommandResult } from './router.js';
import { scanAllSkills, formatSkillList, findSkill, type SkillInfo } from '../claude/skill-scanner.js';

const HELP_TEXT = `可用命令：

  /help             显示帮助
  /clear            清除当前会话
  /cwd <路径>       切换工作目录
  /model <名称>     切换 Claude 模型
  /permission <模式> 切换权限模式
  /status           查看当前会话状态
  /skills           列出已安装的 skill
  /history [数量]   查看对话记录（默认显示最近20条）
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

export function handleSkills(): CommandResult {
  invalidateSkillCache();
  const skills = getSkills();
  if (skills.length === 0) {
    return { reply: '未找到已安装的 skill。', handled: true };
  }
  const lines = skills.map(s => `/${s.name} — ${s.description}`);
  return { reply: `📋 已安装的 Skill (${skills.length}):\n\n${lines.join('\n')}`, handled: true };
}

export function handleHistory(ctx: CommandContext, args: string): CommandResult {
  const limit = args ? parseInt(args, 10) : 20;
  if (isNaN(limit) || limit <= 0) {
    return { reply: '用法: /history [数量]\n例: /history 50（显示最近50条对话）', handled: true };
  }

  const historyText = ctx.getChatHistoryText?.(limit) || '暂无对话记录';

  return { reply: `📝 对话记录（最近${limit}条）:\n\n${historyText}`, handled: true };
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
