import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readdirSync, unlinkSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { logger } from '../logger.js';
import { getFfmpegPath } from './ffmpeg.js';

const execFileAsync = promisify(execFile);

/**
 * Check if ffmpeg is available (bundled or system)
 */
export function isFfmpegAvailable(): boolean {
  return getFfmpegPath() !== null;
}

/**
 * Extract key frames from a video file using ffmpeg
 * Returns an array of image file paths (JPEG frames)
 *
 * @param videoPath - Path to the video file
 * @param maxFrames - Maximum number of frames to extract (default: 4)
 * @returns Array of extracted frame image paths
 */
export async function extractVideoFrames(
  videoPath: string,
  maxFrames: number = 4
): Promise<string[]> {
  // Verify ffmpeg exists
  const ffmpegPath = getFfmpegPath();
  if (!ffmpegPath) {
    logger.warn('ffmpeg not available, cannot extract video frames');
    return [];
  }

  // Verify video file exists
  if (!existsSync(videoPath)) {
    logger.error(`Video file not found: ${videoPath}`);
    return [];
  }

  // Create temp directory for frames
  const frameDir = join(tmpdir(), `wechat-frames-${Date.now()}`);
  mkdirSync(frameDir, { recursive: true });

  const framePattern = join(frameDir, 'frame_%03d.jpg');

  try {
    // Extract frames evenly distributed across the video duration
    await execFileAsync(ffmpegPath, [
      '-i', videoPath,
      '-vf', `fps=1/${maxFrames},select='not(mod(n\\,1))'`,
      '-frames:v', String(maxFrames),
      '-q:v', '2',  // Good quality JPEG
      '-y',         // Overwrite output
      framePattern
    ], { timeout: 30000 });

    // Collect extracted frame files
    const frames = readdirSync(frameDir)
      .filter(f => f.endsWith('.jpg'))
      .sort()
      .map(f => join(frameDir, f));

    if (frames.length === 0) {
      // Fallback: try simpler extraction (first few seconds)
      await execFileAsync(ffmpegPath, [
        '-i', videoPath,
        '-vf', `select='gte(n\\,0)'`,
        '-frames:v', String(maxFrames),
        '-q:v', '2',
        '-y',
        framePattern
      ], { timeout: 30000 });

      const fallbackFrames = readdirSync(frameDir)
        .filter(f => f.endsWith('.jpg'))
        .sort()
        .map(f => join(frameDir, f));

      return fallbackFrames;
    }

    return frames;
  } catch (error) {
    logger.error('Failed to extract video frames:', error);
    // Cleanup on error
    try {
      rmSync(frameDir, { recursive: true, force: true });
    } catch {}
    return [];
  }
}

/**
 * Clean up extracted frame files and their temp directory
 */
export function cleanupFrames(framePaths: string[]): void {
  if (framePaths.length === 0) return;

  // Collect unique directories
  const dirs = new Set<string>();
  for (const path of framePaths) {
    try {
      if (existsSync(path)) {
        dirs.add(join(path, '..'));
        unlinkSync(path);
      }
    } catch {}
  }
  // Try to remove the temp directories
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}
