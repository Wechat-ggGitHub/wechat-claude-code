import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { logger } from '../logger.js';

let cachedFfmpegPath: string | null | undefined = undefined;
const require = createRequire(import.meta.url);

/**
 * Resolve the ffmpeg binary path.
 * Prefers the bundled npm package (@ffmpeg-installer/ffmpeg),
 * falls back to system PATH lookup.
 * Returns null if neither is available.
 */
export function getFfmpegPath(): string | null {
  if (cachedFfmpegPath !== undefined) {
    return cachedFfmpegPath;
  }

  // Try bundled ffmpeg from npm package
  try {
    const bundled = require('@ffmpeg-installer/ffmpeg').path as string;
    if (bundled && existsSync(bundled)) {
      cachedFfmpegPath = bundled;
      logger.info(`Using bundled ffmpeg: ${bundled}`);
      return bundled;
    }
  } catch (error) {
    logger.warn('Bundled ffmpeg unavailable, falling back to system PATH', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Fall back to system ffmpeg in PATH
  // execFile will search PATH, so just use the binary name
  const sysFfmpeg = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  cachedFfmpegPath = sysFfmpeg;
  logger.info(`Using system ffmpeg: ${sysFfmpeg}`);
  return sysFfmpeg;
}
