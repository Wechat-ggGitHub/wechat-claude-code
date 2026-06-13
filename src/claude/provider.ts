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
  /** Called when a content block ends — use to flush buffered text. */
  onBlockEnd?: () => Promise<void> | void;
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
    onBlockEnd,
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
  let sessionId = '';
  const textParts: string[] = [];
  let errorMessage: string | undefined;
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
      const partialText = textParts.join('\n').trim();
      finish({
        text: partialText,
        sessionId,
        error: partialText ? undefined : 'Claude query timed out after 60 minutes',
      });
    }, QUERY_TIMEOUT_MS);

    // Abort handling
    const onAbort = () => {
      logger.info('Claude CLI query aborted');
      child!.kill('SIGTERM');
      const partialText = textParts.join('\n').trim();
      finish({ text: partialText, sessionId });
    };
    abortController?.signal.addEventListener('abort', onAbort, { once: true });

    // Collect stderr
    const stderrParts: string[] = [];
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      stderrParts.push(chunk);
    });

    // Parse NDJSON from stdout
    let skillInputAccum = '';
    let trackingSkill = false;

    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line: string) => {
      if (!line.trim()) return;
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        // Skip unparseable lines
        return;
      }

      switch (obj.type) {
        case 'system': {
          if (obj.subtype === 'init' && obj.session_id) {
            sessionId = obj.session_id;
          }
          // compact completed — treat empty result as success
          if (obj.subtype === 'compact_boundary') {
            const pre = obj.compact_metadata?.pre_tokens ?? 0;
            const post = obj.compact_metadata?.post_tokens ?? 0;
            if (pre > 0) {
              textParts.push(`__compact__:${pre}:${post}`);
            }
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
            if (text) textParts.push(text);
          }
          break;
        }
        case 'stream_event': {
          const evt = obj.event;
          if (evt?.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
            if (evt.content_block.name === 'Skill') {
              trackingSkill = true;
              skillInputAccum = '';
            }
          } else if (evt?.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
            const delta: string = evt.delta.text;
            if (delta && onText) {
              Promise.resolve(onText(delta)).catch(() => {});
            }
          } else if (evt?.type === 'content_block_delta' && evt.delta?.type === 'input_json_delta' && trackingSkill) {
            skillInputAccum += evt.delta.partial_json ?? '';
            try {
              const parsed = JSON.parse(skillInputAccum);
              if (parsed.skill) {
                const msg = `\n正在调用 ${parsed.skill} 技能\n\n`;
                if (onText) Promise.resolve(onText(msg)).catch(() => {});
                trackingSkill = false;
              }
            } catch {
              // JSON not complete yet, keep accumulating
            }
          } else if (evt?.type === 'content_block_stop') {
            trackingSkill = false;
            if (onBlockEnd) Promise.resolve(onBlockEnd()).catch(() => {});
          }
          break;
        }
        case 'result': {
          if (obj.result && typeof obj.result === 'string') {
            const combined = textParts.join('');
            if (!combined.includes(obj.result)) {
              textParts.push(obj.result);
            }
          }
          if (obj.subtype === 'error' || (obj.errors && obj.errors.length > 0)) {
            const errors = obj.errors ?? [obj.error_message ?? 'Unknown error'];
            errorMessage = Array.isArray(errors) ? errors.join('; ') : String(errors);
            logger.error('CLI returned error result', { errors });
          }
          break;
        }
        default:
          break;
      }
    });

    // Handle process exit
    child.on('close', (code: number | null) => {
      clearTimeout(timeoutId);
      abortController?.signal.removeEventListener('abort', onAbort);

      if (code !== 0 && code !== null && !textParts.length && !errorMessage) {
        const stderr = stderrParts.join('').trim();
        errorMessage = stderr || `claude exited with code ${code}`;
        logger.error('Claude CLI exited with error', { code, stderr: stderr.slice(0, 500) });
      }

      const fullText = textParts.join('\n').trim();

      if (!fullText && !errorMessage) {
        errorMessage = 'Claude returned an empty response.';
      }

      logger.info("Claude CLI query completed", {
        sessionId,
        textLength: fullText.length,
        hasError: !!errorMessage,
      });

      finish({
        text: fullText,
        sessionId,
        error: errorMessage,
      });
    });

    child.on('error', (err: Error) => {
      clearTimeout(timeoutId);
      abortController?.signal.removeEventListener('abort', onAbort);
      finish({ text: '', sessionId, error: `Failed to spawn claude: ${err.message}` });
    });
  });
}
