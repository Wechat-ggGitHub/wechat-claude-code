import { loadJson, saveJson } from './store.js';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DATA_DIR } from './constants.js';
import { logger } from './logger.js';

const SESSIONS_DIR = join(DATA_DIR, 'sessions');

// Claude Code 会话索引相关
const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

/** Claude Code 会话索引条目 */
export interface ClaudeSessionEntry {
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
}

/** Claude Code 会话索引 */
interface ClaudeSessionIndex {
  version: number;
  entries: ClaudeSessionEntry[];
}

/**
 * 获取指定工作目录的最近 Claude Code 会话列表
 * @param workingDirectory 工作目录
 * @param limit 返回的最大会话数量
 */
export function listRecentSessions(workingDirectory: string, limit: number = 5): ClaudeSessionEntry[] {
  try {
    // 将工作目录转换为 Claude Code 的项目目录名格式
    // 例如: D:\code2\wechat-claude-code -> D--code2-wechat-claude-code
    const projectName = workingDirectory
      .replace(/^[A-Za-z]:/, (match) => match.replace(':', '-').toUpperCase())
      .replace(/[/\\]/g, '-');

    const indexPath = join(CLAUDE_PROJECTS_DIR, projectName, 'sessions-index.json');

    if (!existsSync(indexPath)) {
      logger.debug('No sessions index found', { indexPath });
      return [];
    }

    const content = readFileSync(indexPath, 'utf-8');
    const index: ClaudeSessionIndex = JSON.parse(content);

    if (!index.entries || index.entries.length === 0) {
      return [];
    }

    // 按 modified 时间降序排序，取最近的 limit 个
    const sorted = [...index.entries]
      .sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime())
      .slice(0, limit);

    return sorted;
  } catch (err) {
    logger.error('Failed to list recent sessions', { error: err instanceof Error ? err.message : String(err) });
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
