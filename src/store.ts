import { readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "./logger.js";

/**
 * Load a JSON file, returning a typed object or the fallback if the file
 * does not exist or cannot be parsed.
 */
export function loadJson<T>(filePath: string, fallback: T): T {
  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.warn('loadJson failed, using fallback', { filePath, error: err instanceof Error ? err.message : String(err) });
    }
    return fallback;
  }
}

/**
 * Persist an object as pretty-printed JSON.
 * File is written with mode 0o600 (owner read/write only).
 */
export function saveJson(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const raw = JSON.stringify(data, null, 2) + "\n";
  writeFileSync(filePath, raw, "utf-8");
  chmodSync(filePath, 0o600);
}
