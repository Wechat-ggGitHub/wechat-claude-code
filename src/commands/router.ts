import type { Session } from '../session.js';
import { findSkill } from '../claude/skill-scanner.js';
import { logger } from '../logger.js';
import { handleHelp, handleClear, handleCwd, handleModel, handlePermission, handleStatus, handleSkills, handleHistory, handleReset, handleVersion, handleExport, handleUndo, handleGit, handleUnknown, handleCompact, handleResume, handleMcp } from './handlers.js';

export interface CommandContext {
  accountId: string;
  session: Session;
  updateSession: (partial: Partial<Session>) => void;
  clearSession: () => Session;
  getChatHistoryText?: (limit?: number) => string;
  rejectPendingPermission?: () => boolean;
  text: string;
}

export interface CommandResult {
  reply?: string;
  handled: boolean;
  claudePrompt?: string; // If set, this text should be sent to Claude
  mcpStatusRequest?: boolean; // If true, caller should fetch MCP status asynchronously
  /** List recent sessions for user to select */
  listSessions?: boolean;
  /** Resume a specific session by ID */
  resumeSession?: string;
}

/**
 * Parse and dispatch a slash command.
 *
 * Supported commands:
 *   /help             - Show help text with all available commands
 *   /clear            - Clear the current session
 *   /reset            - Full reset including all settings
 *   /cwd [path]       - View or change working directory
 *   /model [name]     - View or change Claude model
 *   /permission [mode] - View or change permission mode
 *   /status           - Show current session info
 *   /skills           - List all installed skills
 *   /history [n]      - Show chat history (default 20)
 *   /export           - Export current chat to file
 *   /undo [n]         - Undo recent messages (default 1)
 *   /git              - Show git status of working directory
 *   /version          - Show version info
 *   /compact          - Compact context (start new SDK session, keep history)
 *   /resume           - Resume previous SDK session
 *   /mcp              - Show MCP server status
 *   /<skill>          - Invoke a skill by name (args are forwarded to Claude)
 */
export function routeCommand(ctx: CommandContext): CommandResult {
  const text = ctx.text.trim();

  if (!text.startsWith('/')) {
    return { handled: false };
  }

  const spaceIdx = text.indexOf(' ');
  const cmd = (spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim();

  logger.info(`Slash command: /${cmd} ${args}`.trimEnd());

  switch (cmd) {
    case 'help':
      return handleHelp(args);
    case 'clear':
      return handleClear(ctx);
    case 'reset':
      return handleReset(ctx);
    case 'cwd':
      return handleCwd(ctx, args);
    case 'model':
      return handleModel(ctx, args);
    case 'permission':
      return handlePermission(ctx, args);
    case 'status':
      return handleStatus(ctx);
    case 'skills':
      return handleSkills(args);
    case 'history':
      return handleHistory(ctx, args);
    case 'export':
      return handleExport(ctx);
    case 'undo':
      return handleUndo(ctx, args);
    case 'git':
      return handleGit(ctx);
    case 'version':
    case 'v':
      return handleVersion();
    case 'compact':
      return handleCompact(ctx);
    case 'resume':
      return handleResume(ctx, args);
    case 'mcp':
      return handleMcp(ctx);
    default:
      return handleUnknown(cmd, args);
  }
}
