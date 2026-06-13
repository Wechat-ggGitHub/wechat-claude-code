import { mkdirSync, appendFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./constants.js";

const LOG_DIR = join(DATA_DIR, "logs");
const MAX_LOG_FILES = 30; // Keep at most 30 days of logs

/** Clean up old log files beyond MAX_LOG_FILES retention. */
function cleanupOldLogs(): void {
  try {
    const files = readdirSync(LOG_DIR)
      .filter((f) => f.startsWith("bridge-") && f.endsWith(".log"))
      .sort();
    while (files.length > MAX_LOG_FILES) {
      unlinkSync(join(LOG_DIR, files.shift()!));
    }
  } catch {
    // Ignore errors during cleanup
  }
}

/**
 * Redact sensitive values from a string:
 * - Bearer tokens (Authorization headers)
 * - aes_key values
 * - generic token/secret values in JSON payloads
 */
export function redact(obj: unknown): string {
  const raw = typeof obj === "string" ? obj : JSON.stringify(obj);
  if (!raw) return raw;

  let safe = raw;
  // Mask Bearer tokens: "Bearer <anything>"
  safe = safe.replace(/Bearer\s+[^\s"\\]+/gi, "Bearer ***");
  // Mask generic token/secret/password/api_key values in JSON
  // Matches both snake_case (bot_token) and camelCase (botToken)
  safe = safe.replace(
    /"(?:(?:[\w]+_)?[Tt]oken|(?:[\w]+_)?[Ss]ecret|(?:[\w]+_)?[Pp]assword|(?:[\w]+_)?api_key|[Aa]es_[Kk]ey)"\s*:\s*"[^"]*"/gi,
    (match) => {
      const key = match.match(/"[^"]*"/)?.[0] ?? '""';
      return `${key}: "***"`;
    },
  );
  return safe;
}

function ensureLogDir(): void {
  mkdirSync(LOG_DIR, { recursive: true });
  cleanupOldLogs();
}

function getLogFilePath(): string {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const date = now.toISOString().slice(0, 10); // YYYY-MM-DD
  return join(LOG_DIR, `bridge-${date}.log`);
}

function writeLogLine(level: string, message: string, data?: unknown): void {
  ensureLogDir();
  const ts = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
  const timestamp = ts.replace('Z', '+08:00');
  const parts = [timestamp, level, message];
  if (data !== undefined) {
    parts.push(redact(data));
  }
  const line = parts.join(" ") + "\n";
  appendFileSync(getLogFilePath(), line, "utf-8");
}

export const logger = {
  info(message: string, data?: unknown): void {
    writeLogLine("INFO", message, data);
  },
  warn(message: string, data?: unknown): void {
    writeLogLine("WARN", message, data);
  },
  error(message: string, data?: unknown): void {
    writeLogLine("ERROR", message, data);
  },
  debug(message: string, data?: unknown): void {
    writeLogLine("DEBUG", message, data);
  },
} as const;
