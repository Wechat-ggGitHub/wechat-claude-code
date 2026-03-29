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

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface QueryOptions {
  prompt: string;
  cwd: string;
  resume?: string;
  model?: string;
  permissionMode?: "default" | "acceptEdits" | "plan" | "bypassPermissions";
  images?: Array<{
    type: "image";
    source: { type: "base64"; media_type: string; data: string };
  }>;
  onPermissionRequest?: (toolName: string, toolInput: string) => Promise<boolean>;
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
// Core function
// ---------------------------------------------------------------------------

export async function claudeQuery(options: QueryOptions): Promise<QueryResult> {
  const {
    prompt,
    cwd,
    resume,
    model,
    permissionMode,
    images,
    onPermissionRequest,
  } = options;

  logger.info("Starting Claude query", {
    cwd,
    model,
    permissionMode,
    resume: !!resume,
    hasImages: !!images?.length,
  });

  // When images are present we use the multi-content AsyncIterable path;
  // otherwise a plain string is simpler and sufficient.
  const hasImages = images && images.length > 0;
  const promptParam: string | AsyncIterable<SDKUserMessage> = hasImages
    ? singleUserMessage(prompt, images)
    : prompt;

  // --- Build SDK options ---
  const sdkOptions: Options = {
    cwd,
    permissionMode,
    allowDangerouslySkipPermissions: permissionMode === 'bypassPermissions',
    settingSources: ["user", "project"],
  };

  if (model) sdkOptions.model = model;
  if (resume) sdkOptions.resume = resume;

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

  const QUERY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  try {
    const result = query({ prompt: promptParam, options: sdkOptions });

    let timeoutId: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('Claude query timed out after 5 minutes')), QUERY_TIMEOUT_MS);
    });

    const iterateResult = async () => {
      for await (const message of result) {
      const sid = getSessionId(message);
      if (sid) sessionId = sid;

      switch (message.type) {
        case "assistant": {
          const text = extractText(message as SDKAssistantMessage);
          if (text) textParts.push(text);
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
          // tool_progress, auth_status, stream_event, etc. — ignore
          break;
      }
    }
    };

    try {
      await Promise.race([iterateResult(), timeoutPromise]);
    } finally {
      clearTimeout(timeoutId!);
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
