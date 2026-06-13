import type { CommandContext, CommandResult } from './router.js';
import { scanAllSkills, formatSkillList, findSkill, type SkillInfo } from '../claude/skill-scanner.js';
import { loadConfig, saveConfig } from '../config.js';
import { DEFAULT_WORKING_DIR } from '../constants.js';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, basename, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HELP_TEXT = `可用命令：

会话管理：
  /help             显示帮助
  /stop             停止当前对话并清空排队消息
  /clear            清除当前会话
  /reset            完全重置（包括工作目录等设置）
  /status           查看当前会话状态
  /compact          压缩上下文（保持当前对话，大幅减少 token 占用）
  /history [数量]   查看对话记录（默认最近20条）
  /undo [数量]      撤销最近对话（默认1条）
  /resume           列出当前目录的历史对话
  /resume <编号>    恢复指定编号的历史对话

文件：
  /send <路径>      发送本地文件（图片直接显示，其他文件作为附件）

配置：
  /cwd [路径]       查看或切换工作目录
  /model [名称]     查看或切换 Claude 模型
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

export function handleStatus(ctx: CommandContext): CommandResult {
  const s = ctx.session;
  const lines = [
    '📊 会话状态',
    '',
    `工作目录: ${s.workingDirectory}`,
    `模型: ${s.model ?? '默认'}`,
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
  const newSession = ctx.clearSession();
  newSession.workingDirectory = DEFAULT_WORKING_DIR;
  Object.assign(ctx.session, newSession);
  return { reply: '✅ 会话已完全重置，所有设置恢复默认。', handled: true };
}

/** 压缩上下文 — 通过原生 /compact 命令压缩当前 session，保持 session ID 不变 */
export function handleCompact(ctx: CommandContext): CommandResult {
  if (!ctx.session.sdkSessionId) {
    return { reply: 'ℹ️ 当前没有活动的对话，无需压缩。', handled: true };
  }
  return { handled: true, compactSession: true };
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

export function handleSend(ctx: CommandContext, args: string): CommandResult {
  if (!args) {
    return { reply: '用法: /send <文件路径>\n例: /send ~/Documents/report.pdf\n     /send ./chart.png', handled: true };
  }

  const resolved = args.startsWith('/')
    ? args
    : resolve(ctx.session.workingDirectory, args.replace(/^~/, homedir()));
  if (!existsSync(resolved)) {
    return { reply: `文件不存在: ${resolved}`, handled: true };
  }

  const stat = statSync(resolved);
  if (stat.isDirectory()) {
    return { reply: `这是一个目录，请指定文件: ${resolved}`, handled: true };
  }

  if (stat.size > 25 * 1024 * 1024) {
    return { reply: `文件过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)，最大支持 25MB`, handled: true };
  }

  return { handled: true, sendFile: resolved };
}

interface SessionIndexEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
  created: string;
  modified: string;
  messageCount: number;
  gitBranch: string;
}

interface SessionIndex {
  version: number;
  entries: SessionIndexEntry[];
  originalPath: string;
}

function cwdToProjectSlug(cwd: string): string {
  // Claude Code converts the full path to a slug by replacing every non-alphanumeric
  // character (slashes, underscores, dots, etc.) with a hyphen.
  // e.g. /Users/unknown_liang/Desktop/Code/atlas_v01
  //   → -Users-unknown-liang-Desktop-Code-atlas-v01
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function extractSessionInfo(jsonlPath: string): { customTitle?: string; firstUserMessage?: string } {
  if (!existsSync(jsonlPath)) return {};
  try {
    const lines = readFileSync(jsonlPath, 'utf-8').split('\n');
    let customTitle: string | undefined;
    let firstUserMessage: string | undefined;
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj: any;
      try { obj = JSON.parse(line); } catch { continue; }
      // custom title set by /rename — keep updating to get the latest
      if (obj.type === 'custom-title' && typeof obj.customTitle === 'string' && obj.customTitle.trim()) {
        customTitle = obj.customTitle.trim();
      }
      // first real user message
      if (!firstUserMessage && obj.type === 'user') {
        const content = obj.message?.content;
        if (typeof content === 'string' && content.trim().length > 5) {
          firstUserMessage = content.trim();
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 5) {
              firstUserMessage = block.text.trim();
              break;
            }
          }
        }
      }
      // once we have firstUserMessage, we still need to scan for the latest customTitle
      // so never break early here
    }
    return { customTitle, firstUserMessage };
  } catch { /* ignore */ }
  return {};
}

function loadSessionIndex(cwd: string): SessionIndexEntry[] {
  const slug = cwdToProjectSlug(cwd.replace(/^~/, homedir()));
  const indexPath = join(homedir(), '.claude', 'projects', slug, 'sessions-index.json');
  if (!existsSync(indexPath)) return [];
  try {
    const data: SessionIndex = JSON.parse(readFileSync(indexPath, 'utf-8'));
    return (data.entries || []).sort(
      (a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime()
    );
  } catch {
    return [];
  }
}

function formatSessionLabel(entry: SessionIndexEntry, index: number): string {
  const { customTitle, firstUserMessage } = extractSessionInfo(entry.fullPath);
  // customTitle (from /rename) takes priority, then first user message, then summary
  const raw = customTitle || firstUserMessage || entry.summary || '（无内容）';
  const label = raw
    .replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '')
    .replace(/<[^>]+>/g, '')
    .trim()
    .slice(0, 50);
  const titleMark = customTitle ? `[${customTitle}] ` : '';
  const displayLabel = customTitle
    ? `[${customTitle}]`
    : (firstUserMessage || entry.summary || '（无内容）')
        .replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '')
        .replace(/<[^>]+>/g, '')
        .trim()
        .slice(0, 50);
  const modified = new Date(entry.modified).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const msgs = entry.messageCount;
  return `${index + 1}. [${modified}] ${displayLabel} (${msgs}条)`;
}

export function handleResume(ctx: CommandContext, args: string): CommandResult {
  const cwd = ctx.session.workingDirectory || DEFAULT_WORKING_DIR;

  const entries = loadSessionIndex(cwd);
  if (entries.length === 0) {
    return { reply: `当前目录 ${cwd} 没有历史对话记录。`, handled: true };
  }

  // /resume 不带参数 — 列出会话列表
  if (!args) {
    const MAX_LIST = 15;
    const shown = entries.slice(0, MAX_LIST);
    const lines = shown.map((e, i) => formatSessionLabel(e, i));
    const footer = entries.length > MAX_LIST ? `\n…共 ${entries.length} 条，仅显示最近 ${MAX_LIST} 条` : '';
    return {
      reply: `📋 历史对话（目录: ${cwd}）\n\n${lines.join('\n')}${footer}\n\n用 /resume <编号> 恢复，例: /resume 1`,
      handled: true,
    };
  }

  // /resume <编号> — 按编号恢复
  const num = parseInt(args.trim(), 10);
  if (!isNaN(num) && num >= 1 && num <= entries.length) {
    const target = entries[num - 1];
    const label = (target.summary || target.firstPrompt || target.sessionId).slice(0, 60);
    ctx.updateSession({ sdkSessionId: target.sessionId });
    return {
      reply: `✅ 已切换到历史对话 #${num}\n摘要: ${label}\n时间: ${new Date(target.modified).toLocaleString('zh-CN')}\n\n发送下一条消息即可继续该对话。`,
      handled: true,
    };
  }

  // /resume <sessionId> — 按完整 UUID 恢复
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRe.test(args.trim())) {
    const target = entries.find(e => e.sessionId === args.trim());
    if (!target) {
      return { reply: `未找到 sessionId: ${args.trim()}`, handled: true };
    }
    ctx.updateSession({ sdkSessionId: target.sessionId });
    const label = (target.summary || target.firstPrompt || target.sessionId).slice(0, 60);
    return {
      reply: `✅ 已切换到历史对话\n摘要: ${label}\n时间: ${new Date(target.modified).toLocaleString('zh-CN')}\n\n发送下一条消息即可继续该对话。`,
      handled: true,
    };
  }

  return {
    reply: `用法:\n  /resume          列出历史对话\n  /resume <编号>   恢复指定对话（编号来自列表）`,
    handled: true,
  };
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
