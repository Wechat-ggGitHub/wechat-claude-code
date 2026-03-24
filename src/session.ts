import { loadJson, saveJson } from './store.js';
import { mkdirSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { DATA_DIR } from './constants.js';
import { logger } from './logger.js';

const SESSIONS_DIR = join(DATA_DIR, 'sessions');

// Claude Code 会话索引相关
const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

/** Claude Code 会话索引条目 */
export interface ClaudeSessionEntry {
  sessionId: string;
  firstPrompt: string;
  messageCount: number;
  modified: string;
}

/** Claude Code 会话索引 */
interface ClaudeSessionIndex {
  version: number;
  entries: Array<{
    sessionId: string;
    fullPath: string;
    fileMtime: number;
    firstPrompt: string;
    messageCount: number;
    created: string;
    modified: string;
    gitBranch: string;
    projectPath: string;
    isSidechain: boolean;
  }>;
}

/**
 * 将工作目录转换为 Claude Code 的项目目录名格式
 */
function workingDirToProjectName(workingDirectory: string): string {
  // 标准化路径，统一使用正斜杠
  const normalized = workingDirectory.replace(/\\/g, '/');
  // 移除末尾斜杠
  const trimmed = normalized.replace(/\/+$/, '');
  // 转换格式: D:/code2/wechat-claude-code -> D--code2-wechat-claude-code
  return trimmed
    .replace(/^\w+:/, (match) => match.replace(':', '-').toUpperCase())
    .replace(/\//g, '-');
}

/**
 * 从 .jsonl 文件中提取会话信息
 */
function extractSessionInfoFromJsonl(filePath: string): { firstPrompt: string; messageCount: number } | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    let firstPrompt = '';
    let messageCount = 0;

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);

        // 只计算 user 消息
        if (entry.type === 'user' && entry.message?.content) {
          messageCount++;
          const msgContent = entry.message.content;
          // 查找第一条非命令的用户消息作为标题
          if (!firstPrompt && typeof msgContent === 'string') {
            // 跳过命令和元数据消息
            if (!msgContent.startsWith('<local-command-caveat>') &&
                !msgContent.startsWith('<command-name>') &&
                !msgContent.includes('Caveat:')) {
              firstPrompt = msgContent;
            }
          }
        }
      } catch {
        // 忽略解析错误的行
      }
    }

    return { firstPrompt: firstPrompt.slice(0, 100) || '(无标题)', messageCount };
  } catch (err) {
    logger.debug('Failed to extract session info', { filePath, error: err });
    return null;
  }
}

/**
 * 获取指定工作目录的最近 Claude Code 会话列表
 * @param workingDirectory 工作目录
 * @param limit 返回的最大会话数量
 */
export function listRecentSessions(workingDirectory: string, limit: number = 5): ClaudeSessionEntry[] {
  try {
    const projectName = workingDirToProjectName(workingDirectory);
    const projectDir = join(CLAUDE_PROJECTS_DIR, projectName);

    if (!existsSync(projectDir)) {
      logger.debug('Project directory not found', { projectDir });
      return [];
    }

    // 首先尝试从 sessions-index.json 读取
    const indexPath = join(projectDir, 'sessions-index.json');
    if (existsSync(indexPath)) {
      try {
        const content = readFileSync(indexPath, 'utf-8');
        const index: ClaudeSessionIndex = JSON.parse(content);

        if (index.entries && index.entries.length > 0) {
          const sorted = [...index.entries]
            .sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime())
            .slice(0, limit);

          return sorted.map(e => ({
            sessionId: e.sessionId,
            firstPrompt: e.firstPrompt,
            messageCount: e.messageCount,
            modified: e.modified,
          }));
        }
      } catch (err) {
        logger.debug('Failed to read sessions index', { indexPath, error: err });
      }
    }

    // 回退：直接扫描 .jsonl 文件
    const files = readdirSync(projectDir);
    const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));

    if (jsonlFiles.length === 0) {
      return [];
    }

    const sessions: ClaudeSessionEntry[] = [];
    for (const file of jsonlFiles) {
      const filePath = join(projectDir, file);
      const sessionId = file.replace('.jsonl', '');
      const info = extractSessionInfoFromJsonl(filePath);
      const fileStat = statSync(filePath);

      if (info) {
        sessions.push({
          sessionId,
          firstPrompt: info.firstPrompt,
          messageCount: info.messageCount,
          modified: new Date(fileStat.mtime).toISOString(),
        });
      }
    }

    // 按修改时间排序
    sessions.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());

    return sessions.slice(0, limit);
  } catch (err) {
    logger.error('Failed to list recent sessions', { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

/**
 * 从指定会话的 .jsonl 文件中获取最近的对话记录
 * @param workingDirectory 工作目录
 * @param sessionId 会话 ID
 * @param limit 返回的最大消息数量
 */
export function getRecentMessagesFromSession(
  workingDirectory: string,
  sessionId: string,
  limit: number = 5,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  try {
    const projectName = workingDirToProjectName(workingDirectory);
    const jsonlPath = join(CLAUDE_PROJECTS_DIR, projectName, `${sessionId}.jsonl`);

    if (!existsSync(jsonlPath)) {
      logger.debug('Session file not found', { jsonlPath });
      return [];
    }

    const content = readFileSync(jsonlPath, 'utf-8');
    const lines = content.trim().split('\n');
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);

        // 提取用户消息
        if (entry.type === 'user' && entry.message?.content) {
          const msgContent = entry.message.content;
          if (typeof msgContent === 'string' &&
              !msgContent.startsWith('<local-command-caveat>') &&
              !msgContent.startsWith('<command-name>')) {
            messages.push({ role: 'user', content: msgContent });
          }
        }

        // 提取助手消息
        if (entry.type === 'assistant' && entry.message?.content) {
          const contentBlocks = entry.message.content;
          if (Array.isArray(contentBlocks)) {
            const textBlocks = contentBlocks.filter((b: { type: string }) => b.type === 'text');
            if (textBlocks.length > 0) {
              const text = textBlocks.map((b: { text: string }) => b.text).join('\n');
              messages.push({ role: 'assistant', content: text });
            }
          }
        }
      } catch {
        // 忽略解析错误的行
      }
    }

    // 返回最近的消息
    return messages.slice(-limit);
  } catch (err) {
    logger.error('Failed to get recent messages from session', { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

function validateAccountId(accountId: string): void {
  if (!/^[a-zA-Z0-9_.@=-]+$/.test(accountId)) {
    throw new Error(`Invalid accountId: "${accountId}"`);
  }
}

export type SessionState = 'idle' | 'processing' | 'waiting_permission';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface McpServerInfo {
  name: string;
  status: string;
}

export interface Session {
  sdkSessionId?: string;
  /** 备份的 SDK 会话 ID，用于 /resume 恢复 */
  previousSdkSessionId?: string;
  /** 下次消息是否使用 continue: true 恢复最近的会话 */
  continueRecent?: boolean;
  /** 保存的会话列表，用于序号查找 */
  cachedSessionList?: ClaudeSessionEntry[];
  workingDirectory: string;
  model?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'auto';
  state: SessionState;
  chatHistory: ChatMessage[];
  maxHistoryLength?: number;
  /** MCP 服务器状态信息 */
  mcpServers?: McpServerInfo[];
}

export interface PendingPermission {
  toolName: string;
  toolInput: string;
  resolve: (allowed: boolean) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_MAX_HISTORY = 100;

export function createSessionStore() {
  function getSessionPath(accountId: string): string {
    validateAccountId(accountId);
    return join(SESSIONS_DIR, `${accountId}.json`);
  }

  function load(accountId: string): Session {
    validateAccountId(accountId);
    const session = loadJson<Session>(getSessionPath(accountId), {
      workingDirectory: process.cwd(),
      state: 'idle',
      chatHistory: [],
      maxHistoryLength: DEFAULT_MAX_HISTORY,
    });

    // Backward compatibility: ensure chatHistory exists
    if (!session.chatHistory) {
      session.chatHistory = [];
    }
    if (!session.maxHistoryLength) {
      session.maxHistoryLength = DEFAULT_MAX_HISTORY;
    }

    return session;
  }

  function save(accountId: string, session: Session): void {
    mkdirSync(SESSIONS_DIR, { recursive: true });

    // Trim chat history if it exceeds max length before saving
    const maxLen = session.maxHistoryLength || DEFAULT_MAX_HISTORY;
    if (session.chatHistory.length > maxLen) {
      session.chatHistory = session.chatHistory.slice(-maxLen);
    }

    saveJson(getSessionPath(accountId), session);
  }

  function clear(accountId: string, currentSession?: Session): Session {
    const session: Session = {
      workingDirectory: currentSession?.workingDirectory ?? process.cwd(),
      model: currentSession?.model,
      permissionMode: currentSession?.permissionMode,
      state: 'idle',
      chatHistory: [],
      maxHistoryLength: currentSession?.maxHistoryLength || DEFAULT_MAX_HISTORY,
    };
    save(accountId, session);
    return session;
  }

  function addChatMessage(session: Session, role: 'user' | 'assistant', content: string): void {
    if (!session.chatHistory) {
      session.chatHistory = [];
    }
    session.chatHistory.push({
      role,
      content,
      timestamp: Date.now(),
    });

    // Trim if exceeds max length
    const maxLen = session.maxHistoryLength || DEFAULT_MAX_HISTORY;
    if (session.chatHistory.length > maxLen) {
      session.chatHistory = session.chatHistory.slice(-maxLen);
    }
  }

  function getChatHistoryText(session: Session, limit?: number): string {
    const history = session.chatHistory || [];
    const messages = limit ? history.slice(-limit) : history;

    if (messages.length === 0) {
      return '暂无对话记录';
    }

    const lines: string[] = [];
    for (const msg of messages) {
      const time = new Date(msg.timestamp).toLocaleString('zh-CN');
      const role = msg.role === 'user' ? '用户' : 'Claude';
      lines.push(`[${time}] ${role}:`);
      lines.push(msg.content);
      lines.push('');
    }

    return lines.join('\n');
  }

  return { load, save, clear, addChatMessage, getChatHistoryText };
}
