import {
  query,
  type SDKMessage,
  type SDKAssistantMessage,
  type SDKResultMessage,
  type SDKUserMessage,
  type Options,
  type CanUseTool,
  type PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import { logger } from "../logger.js";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface QueryOptions {
  prompt: string;
  cwd: string;
  resume?: string;
  model?: string;
  systemPrompt?: string;
  permissionMode?: "default" | "acceptEdits" | "plan" | "bypassPermissions";
  images?: Array<{
    type: "image";
    source: { type: "base64"; media_type: string; data: string };
  }>;
  onPermissionRequest?: (toolName: string, toolInput: string) => Promise<boolean>;
  /** Called each time an assistant text chunk is produced (e.g. before/after tool calls). */
  onText?: (text: string) => Promise<void> | void;
  /** Called when Claude invokes a tool, with a human-readable summary. */
  onThinking?: (summary: string) => Promise<void> | void;
  /** Optional abort controller to cancel the query (e.g. when user sends a new message). */
  abortController?: AbortController;
}

export interface QueryResult {
  text: string;
  sessionId: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a tool_use block into a concise human-readable summary.
 */
function formatToolUse(toolName: string, input: Record<string, unknown>): string {
  const icons: Record<string, string> = {
    Bash: "🔧", Read: "📖", Write: "✏️", Edit: "✏️", MultiEdit: "✏️",
    Grep: "🔍", Glob: "🔍", WebFetch: "🌐", WebSearch: "🌐",
    TodoWrite: "📝", TodoRead: "📝", Task: "🤖",
  };
  const icon = icons[toolName] ?? "⚙️";
  let detail = "";
  if (input.command) detail = String(input.command).slice(0, 80);
  else if (input.file_path) detail = String(input.file_path);
  else if (input.pattern) detail = String(input.pattern).slice(0, 60);
  else if (input.query) detail = String(input.query).slice(0, 60);
  else if (input.url) detail = String(input.url).slice(0, 60);
  return detail ? `${icon} ${toolName}: ${detail}` : `${icon} ${toolName}`;
}

/**
 * Extract accumulated text from an SDK assistant message's content blocks.
 */
function extractText(msg: SDKAssistantMessage): string {
  const content = msg.message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block: any) => block.type === "text")
    .map((block: any) => (block.text as string) ?? "")
    .join("");
}

/**
 * Extract session_id from any SDKMessage that carries one.
 */
function getSessionId(msg: SDKMessage): string | undefined {
  if ("session_id" in msg) {
    return (msg as { session_id: string }).session_id;
  }
  return undefined;
}

/**
 * Build an async iterable yielding a single SDKUserMessage with optional
 * image content blocks.  The session_id is set to "" — the SDK assigns the
 * real session id once the process starts.
 */
async function* singleUserMessage(
  text: string,
  images?: QueryOptions["images"],
): AsyncGenerator<SDKUserMessage, void, unknown> {
  const contentBlocks: Array<{
    type: string;
    text?: string;
    source?: { type: "base64"; media_type: string; data: string };
  }> = [{ type: "text", text }];

  if (images?.length) {
    for (const img of images) {
      contentBlocks.push({ type: "image", source: img.source });
    }
  }

  const msg: SDKUserMessage = {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: contentBlocks,
    },
  };

  yield msg;
}

// ---------------------------------------------------------------------------
// Resolve global claude cli.js path (avoids bundled old version in SDK)
// ---------------------------------------------------------------------------

function resolveGlobalClaudeCliPath(): string | undefined {
  try {
    if (process.platform === 'win32') {
      // Windows: use `where claude` instead of `which`
      try {
        const claudeBin = execSync("where claude", { encoding: "utf8" }).trim().split(/\r?\n/)[0];
        if (claudeBin) {
          // On Windows, no symlinks to resolve — check directly
          if (claudeBin.endsWith(".js") && existsSync(claudeBin)) return claudeBin;
          const cliJs = join(dirname(claudeBin), "cli.js");
          if (existsSync(cliJs)) return cliJs;
        }
      } catch {
        // `where` failed, fall through
      }

      // Check well-known Windows npm global path
      const appData = process.env.APPDATA;
      if (appData) {
        const knownPath = join(appData, "npm", "node_modules", "@anthropic-ai", "claude-code", "cli.js");
        if (existsSync(knownPath)) return knownPath;
      }

      // Try npm global prefix
      try {
        const npmPrefix = execSync("npm config get prefix", { encoding: "utf8" }).trim();
        const npmCli = join(npmPrefix, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
        if (existsSync(npmCli)) return npmCli;
      } catch {
        // ignore
      }
    } else {
      // macOS / Linux: use `which` and resolve symlinks
      const claudeBin = execSync("which claude", { encoding: "utf8" }).trim();
      // Resolve symlinks to get the actual file
      const realBin = execSync(`readlink -f "${claudeBin}" 2>/dev/null || realpath "${claudeBin}" 2>/dev/null || echo "${claudeBin}"`, { encoding: "utf8" }).trim();
      // On npm global installs, the binary itself is cli.js
      if (realBin.endsWith(".js") && existsSync(realBin)) return realBin;
      // Otherwise look for cli.js next to the binary
      const cliJs = join(dirname(realBin), "cli.js");
      if (existsSync(cliJs)) return cliJs;
      // Try npm global prefix
      const npmPrefix = execSync("npm config get prefix", { encoding: "utf8" }).trim();
      const npmCli = join(npmPrefix, "lib", "node_modules", "@anthropic-ai", "claude-code", "cli.js");
      if (existsSync(npmCli)) return npmCli;
    }
  } catch {
    // ignore
  }
  return undefined;
}

const GLOBAL_CLAUDE_CLI_PATH = resolveGlobalClaudeCliPath();

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

export async function claudeQuery(options: QueryOptions): Promise<QueryResult> {
  const {
    prompt,
    cwd,
    resume,
    model,
    systemPrompt,
    permissionMode,
    images,
    onPermissionRequest,
    onText,
    onThinking,
    abortController,
  } = options;

  logger.info("Starting Claude query", {
    cwd,
    model,
    permissionMode,
    resume: !!resume,
    hasImages: !!images?.length,
  });

  // Always use the streaming-input path so text-only turns and image turns
  // reuse the same SDK input mode across a resumed session.
  const promptParam: AsyncIterable<SDKUserMessage> = singleUserMessage(prompt, images);

  // --- Build SDK options ---
  const sdkOptions: Options = {
    cwd,
    permissionMode,
    allowDangerouslySkipPermissions: permissionMode === 'bypassPermissions',
    settingSources: ["user", "project"],
    includePartialMessages: !!onText,
  };

  // Use the globally installed claude cli.js to avoid version mismatch with the bundled one
  if (GLOBAL_CLAUDE_CLI_PATH) {
    (sdkOptions as any).pathToClaudeCodeExecutable = GLOBAL_CLAUDE_CLI_PATH;
    logger.debug("Using global claude cli.js", { path: GLOBAL_CLAUDE_CLI_PATH });
  }

  if (model) sdkOptions.model = model;
  if (resume) sdkOptions.resume = resume;
  if (abortController) sdkOptions.abortController = abortController;
  if (systemPrompt) {
    (sdkOptions as any).systemPrompt = { type: "preset", preset: "claude_code", append: systemPrompt };
  }

  // Permission callback — bridges the SDK's CanUseTool to our simpler handler.
  if (onPermissionRequest) {
    const canUseTool: CanUseTool = async (
      toolName: string,
      input: Record<string, unknown>,
    ): Promise<PermissionResult> => {
      const inputStr = JSON.stringify(input);
      logger.info("Permission request from SDK", { toolName });
      try {
        const allowed = await onPermissionRequest(toolName, inputStr);
        if (allowed) {
          return { behavior: "allow", updatedInput: input };
        }
        return {
          behavior: "deny",
          message: "Permission denied by user.",
          interrupt: true,
        };
      } catch (err) {
        logger.error("Permission handler error", { toolName, err });
        return {
          behavior: "deny",
          message: "Permission check failed.",
          interrupt: true,
        };
      }
    };
    sdkOptions.canUseTool = canUseTool;
  }

  // --- Execute query & accumulate output ---
  let sessionId = "";
  const textParts: string[] = [];
  let errorMessage: string | undefined;

  try {
    const result = query({ prompt: promptParam, options: sdkOptions });

    const iterateResult = async () => {
      for await (const message of result) {
      const sid = getSessionId(message);
      if (sid) sessionId = sid;

      switch (message.type) {
        case "assistant": {
          const aMsg = message as SDKAssistantMessage;
          const content = aMsg.message?.content;
          // Extract tool_use blocks and notify onThinking
          if (onThinking) {
            if (Array.isArray(content)) {
              for (const block of content) {
                if ((block as any).type === "tool_use") {
                  const summary = formatToolUse(
                    (block as any).name ?? "Tool",
                    (block as any).input ?? {},
                  );
                  await onThinking(summary);
                }
              }
            }
          }
          // Accumulate text; only call onText if not already streaming via stream_event
          const text = extractText(aMsg);
          if (text) {
            textParts.push(text);
            if (onText && !sdkOptions.includePartialMessages) await onText(text);
          }
          break;
        }
        case "stream_event": {
          const evt = (message as any).event;
          if (evt?.type === "content_block_delta") {
            const deltaType: string = evt.delta?.type ?? "";
            if (deltaType === "text_delta" && onText) {
              const delta: string = evt.delta.text;
              if (delta) await onText(delta);
            }
          }
          break;
        }
        case "result": {
          const rm = message as SDKResultMessage;
          if (rm.subtype === "success" && "result" in rm) {
            // The SDK result message carries the final result string.
            // Append only when it adds content not yet seen.
            if (rm.result) {
              const combined = textParts.join("");
              if (!combined.includes(rm.result)) {
                textParts.push(rm.result);
              }
            }
          } else if ("errors" in rm && rm.errors.length > 0) {
            errorMessage = rm.errors.join("; ");
            logger.error("SDK returned error result", { errors: rm.errors });
          }
          break;
        }
        case "system": {
          logger.debug("SDK system message", {
            subtype: (message as { subtype?: string }).subtype,
          });
          break;
        }
        default:
          // tool_progress, auth_status, etc. — ignore
          break;
      }
    }
    };

    try {
      await iterateResult();
    } finally {
      // no timeout — wait indefinitely
    }
  } catch (err: unknown) {
    errorMessage = err instanceof Error ? err.message : String(err);
    logger.error("Claude query threw", { error: errorMessage });
  }

  const fullText = textParts.join("\n").trim();

  if (!fullText && !errorMessage) {
    errorMessage = "Claude returned an empty response.";
  }

  logger.info("Claude query completed", {
    sessionId,
    textLength: fullText.length,
    hasError: !!errorMessage,
  });

  return {
    text: fullText,
    sessionId,
    error: errorMessage,
  };
}
