import { execFile } from 'node:child_process';
import { promisify } from 'util';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { logger } from '../logger.js';
import { getFfmpegPath } from './ffmpeg.js';

const execFileAsync = promisify(execFile);

/**
 * Convert AMR audio file to WAV using ffmpeg
 */
export async function convertAmrToWav(amrPath: string): Promise<string | null> {
  const ffmpegPath = getFfmpegPath();
  if (!ffmpegPath) {
    logger.warn('ffmpeg not available for voice conversion');
    return null;
  }

  const wavPath = join(tmpdir(), `voice_${Date.now()}.wav`);

  try {
    await execFileAsync(ffmpegPath, [
      '-i', amrPath,
      '-ar', '16000',     // 16kHz sample rate (good for speech recognition)
      '-ac', '1',          // Mono
      '-sample_fmt', 's16', // 16-bit
      '-y',
      wavPath
    ], { timeout: 15000 });

    if (existsSync(wavPath)) {
      return wavPath;
    }
    return null;
  } catch (error) {
    logger.error('AMR to WAV conversion failed:', error);
    return null;
  }
}

/**
 * Transcribe audio file to text using Windows Speech Recognition (PowerShell)
 * Falls back to a simple description if recognition fails
 */
export async function transcribeAudio(audioPath: string): Promise<string | null> {
  if (!existsSync(audioPath)) {
    return null;
  }

  // Try Windows Speech Recognition via PowerShell
  try {
    const escapedPath = audioPath.replace(/\\/g, '\\\\');
    const psScript = `
Add-Type -AssemblyName System.Speech
$recog = New-Object System.Speech.Recognition.SpeechRecognitionEngine
$recog.SetInputToWaveFile("${escapedPath}")
$result = $recog.Recognize()
if ($result) { $result.Text } else { "" }
`;
    const { stdout } = await execFileAsync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command', psScript
    ], { timeout: 15000 });

    const text = stdout.trim();
    if (text && text.length > 0) {
      return text;
    }
  } catch (error) {
    logger.warn('Windows Speech Recognition failed:', error);
  }

  return null;
}

/**
 * Process voice message: convert + transcribe
 * Returns transcription text or null
 */
export async function processVoiceMessage(amrPath: string): Promise<string | null> {
  // Step 1: Convert AMR to WAV
  const wavPath = await convertAmrToWav(amrPath);
  if (!wavPath) {
    logger.warn('Could not convert voice message');
    return null;
  }

  // Step 2: Transcribe
  const text = await transcribeAudio(wavPath);

  // Cleanup WAV file
  try { unlinkSync(wavPath); } catch {}

  return text;
}
