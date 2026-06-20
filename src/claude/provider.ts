import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface QueryOptions {
  prompt: string;
  cwd: string;
  resume?: string;
  model?: string;
  systemPrompt?: string;
  images?: Array<{
    type: "image";
    source: { type: "base64"; media_type: string; data: string };
  }>;
  /** Called each time an assistant text chunk is produced (e.g. before/after tool calls). */
  onText?: (text: string) => Promise<void> | void;
  /** Called when an assistant turn ends, with its stop_reason
   *  ('tool_use' | 'end_turn' | 'max_tokens' | 'stop_sequence' | 'pause_turn' | ...).
   *  Use to decide whether the turn's text is interstitial or final answer. */
  onTurnEnd?: (stopReason: string) => Promise<void> | void;
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

const TEMP_DIR = join(tmpdir(), 'wechat-claude-code');

function saveImageTemp(images: NonNullable<QueryOptions['images']>): string[] {
  mkdirSync(TEMP_DIR, { recursive: true });
  const paths: string[] = [];
  for (const img of images) {
    const ext = img.source.media_type.split('/')[1] || 'png';
    const fileName = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const filePath = join(TEMP_DIR, fileName);
    writeFileSync(filePath, Buffer.from(img.source.data, 'base64'));
    paths.push(filePath);
  }
  return paths;
}

function cleanupTempFiles(paths: string[]): void {
  for (const p of paths) {
    try { unlinkSync(p); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Stream parser (extracted for testability)
// ---------------------------------------------------------------------------

export interface StreamParserState {
  sessionId: string;
  textParts: string[];
  errorMessage?: string;
  trackingSkill: boolean;
  skillInputAccum: string;
}

export interface StreamParserCallbacks {
  onText?: (text: string) => void;
  onTurnEnd?: (stopReason: string) => void;
}

export function handleStreamLine(
  line: string,
  state: StreamParserState,
  callbacks: StreamParserCallbacks,
): void {
  if (!line.trim()) return;
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return;
  }

  switch (obj.type) {
    case 'system': {
      if (obj.subtype === 'init' && obj.session_id) {
        state.sessionId = obj.session_id;
      }
      break;
    }
    case 'assistant': {
      const content = obj.message?.content;
      if (Array.isArray(content)) {
        const text = content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text ?? '')
          .join('');
        if (text) state.textParts.push(text);
      }
      break;
    }
    case 'stream_event': {
      const evt = obj.event;
      if (evt?.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
        if (evt.content_block.name === 'Skill') {
          state.trackingSkill = true;
          state.skillInputAccum = '';
        }
      } else if (evt?.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
        const delta: string = evt.delta.text;
        if (delta && callbacks.onText) {
          Promise.resolve(callbacks.onText(delta)).catch(() => {});
        }
      } else if (evt?.type === 'content_block_delta' && evt.delta?.type === 'input_json_delta' && state.trackingSkill) {
        state.skillInputAccum += evt.delta.partial_json ?? '';
        try {
          const parsed = JSON.parse(state.skillInputAccum);
          if (parsed.skill) {
            const msg = `\n正在调用 ${parsed.skill} 技能\n\n`;
            if (callbacks.onText) Promise.resolve(callbacks.onText(msg)).catch(() => {});
            state.trackingSkill = false;
          }
        } catch {
          // JSON not complete yet
        }
      } else if (evt?.type === 'content_block_stop') {
        state.trackingSkill = false;
      } else if (evt?.type === 'message_delta' && evt.delta?.stop_reason) {
        if (callbacks.onTurnEnd) Promise.resolve(callbacks.onTurnEnd(evt.delta.stop_reason)).catch(() => {});
      }
      break;
    }
    case 'result': {
      if (obj.result && typeof obj.result === 'string') {
        const combined = state.textParts.join('');
        if (!combined.includes(obj.result)) {
          state.textParts.push(obj.result);
        }
      }
      if (obj.subtype === 'error' || (obj.errors && obj.errors.length > 0)) {
        const errors = obj.errors ?? [obj.error_message ?? 'Unknown error'];
        state.errorMessage = Array.isArray(errors) ? errors.join('; ') : String(errors);
        logger.error('CLI returned error result', { errors });
      }
      break;
    }
    default:
      break;
  }
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
    systemPrompt,
    images,
    onText,
    onTurnEnd,
    abortController,
  } = options;

  logger.info("Starting Claude CLI query", {
    cwd,
    model,
    resume: !!resume,
    hasImages: !!images?.length,
  });

  // Build CLI arguments
  const args: string[] = [
    '-p', '-',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--dangerously-skip-permissions',
  ];

  if (resume) args.push('--resume', resume);
  if (model) args.push('--model', model);
  if (systemPrompt) args.push('--append-system-prompt', systemPrompt);

  // Handle images: save to temp files and append paths to prompt
  const tempImagePaths = images?.length ? saveImageTemp(images) : [];
  let fullPrompt = prompt;
  if (tempImagePaths.length > 0) {
    const imageLines = tempImagePaths.map(p => `\n![image](file://${p})`).join('');
    fullPrompt += imageLines;
  }

  // Accumulators
  let child: ChildProcess | undefined;
  let settled = false;

  const QUERY_TIMEOUT_MS = 60 * 60 * 1000;

  return new Promise<QueryResult>((resolve) => {
    const finish = (result: QueryResult) => {
      if (settled) return;
      settled = true;
      cleanupTempFiles(tempImagePaths);
      resolve(result);
    };

    try {
      child = spawn('claude', args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      finish({ text: '', sessionId: '', error: `Failed to spawn claude: ${msg}` });
      return;
    }

    // Write prompt to stdin and close
    child.stdin!.write(fullPrompt);
    child.stdin!.end();

    // Timeout
    const timeoutId = setTimeout(() => {
      logger.warn('Claude CLI query timed out, killing process');
      child!.kill('SIGTERM');
      const partialText = parserState.textParts.join('\n').trim();
      finish({
        text: partialText,
        sessionId: parserState.sessionId,
        error: partialText ? undefined : 'Claude query timed out after 60 minutes',
      });
    }, QUERY_TIMEOUT_MS);

    // Abort handling
    const onAbort = () => {
      logger.info('Claude CLI query aborted');
      child!.kill('SIGTERM');
      const partialText = parserState.textParts.join('\n').trim();
      finish({ text: partialText, sessionId: parserState.sessionId });
    };
    abortController?.signal.addEventListener('abort', onAbort, { once: true });

    // Collect stderr
    const stderrParts: string[] = [];
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      stderrParts.push(chunk);
    });

    // Parse NDJSON from stdout (logic in handleStreamLine for testability)
    const parserState: StreamParserState = {
      sessionId: '',
      textParts: [],
      trackingSkill: false,
      skillInputAccum: '',
    };
    const parserCallbacks: StreamParserCallbacks = { onText, onTurnEnd };

    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line: string) => {
      handleStreamLine(line, parserState, parserCallbacks);
    });

    // Handle process exit
    child.on('close', (code: number | null) => {
      clearTimeout(timeoutId);
      abortController?.signal.removeEventListener('abort', onAbort);

      if (code !== 0 && code !== null && !parserState.textParts.length && !parserState.errorMessage) {
        const stderr = stderrParts.join('').trim();
        parserState.errorMessage = stderr || `claude exited with code ${code}`;
        logger.error('Claude CLI exited with error', { code, stderr: stderr.slice(0, 500) });
      }

      const fullText = parserState.textParts.join('\n').trim();

      if (!fullText && !parserState.errorMessage) {
        parserState.errorMessage = 'Claude returned an empty response.';
      }

      logger.info("Claude CLI query completed", {
        sessionId: parserState.sessionId,
        textLength: fullText.length,
        hasError: !!parserState.errorMessage,
      });

      finish({
        text: fullText,
        sessionId: parserState.sessionId,
        error: parserState.errorMessage,
      });
    });

    child.on('error', (err: Error) => {
      clearTimeout(timeoutId);
      abortController?.signal.removeEventListener('abort', onAbort);
      finish({ text: '', sessionId: parserState.sessionId, error: `Failed to spawn claude: ${err.message}` });
    });
  });
}
