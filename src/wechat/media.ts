import type { MessageItem, ImageItem } from './types.js';
import { MessageItemType } from './types.js';
import { downloadAndDecrypt } from './cdn.js';
import { logger } from '../logger.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const DOWNLOADS_DIR = join(homedir(), '.wechat-claude-code', 'downloads');

export interface DownloadedMedia {
  fileName: string;
  localPath: string;
  size: number;
}

function getCdnData(item: MessageItem): { aesKey: string; encryptQueryParam: string; fullUrl?: string } | null {
  const fileItem = item.file_item ?? item.video_item ?? item.voice_item;
  if (!fileItem) return null;

  // media format
  if (fileItem.media?.encrypt_query_param && (fileItem.media.aes_key)) {
    return {
      aesKey: fileItem.media.aes_key,
      encryptQueryParam: fileItem.media.encrypt_query_param,
      fullUrl: fileItem.media.full_url,
    };
  }

  // cdn_media format
  if (fileItem.cdn_media?.encrypt_query_param && fileItem.cdn_media?.aes_key) {
    return {
      aesKey: fileItem.cdn_media.aes_key,
      encryptQueryParam: fileItem.cdn_media.encrypt_query_param,
      fullUrl: fileItem.cdn_media.full_url,
    };
  }

  return null;
}

function detectMimeType(data: Buffer): string {
  if (data[0] === 0x89 && data[1] === 0x50) return 'image/png';
  if (data[0] === 0xFF && data[1] === 0xD8) return 'image/jpeg';
  if (data[0] === 0x47 && data[1] === 0x49) return 'image/gif';
  if (data[0] === 0x52 && data[1] === 0x49) return 'image/webp';
  if (data[0] === 0x42 && data[1] === 0x4D) return 'image/bmp';
  return 'image/jpeg'; // fallback
}

/**
 * Extract AES key and encrypt_query_param from an ImageItem,
 * prioritizing the original/full-resolution image (media) over cdn_media.
 */
function getImageCdnData(imageItem: ImageItem): { aesKey: string; encryptQueryParam: string; fullUrl?: string } | null {
  // Prefer media (original/full image) — this is the HD version
  if (imageItem.media?.encrypt_query_param && (imageItem.media.aes_key || imageItem.aeskey)) {
    return {
      aesKey: imageItem.media.aes_key ?? imageItem.aeskey!,
      encryptQueryParam: imageItem.media.encrypt_query_param,
      fullUrl: imageItem.media.full_url,
    };
  }

  // Fallback: old cdn_media format
  if (imageItem.cdn_media?.aes_key && imageItem.cdn_media?.encrypt_query_param) {
    return {
      aesKey: imageItem.cdn_media.aes_key,
      encryptQueryParam: imageItem.cdn_media.encrypt_query_param,
      fullUrl: imageItem.cdn_media.full_url,
    };
  }

  logger.warn('Image item has no usable CDN data', {
    hasCdnMedia: !!imageItem.cdn_media,
    hasAeskey: !!imageItem.aeskey,
    hasMedia: !!imageItem.media,
  });
  return null;
}

/**
 * Download a CDN image, decrypt it, save to disk, and return a base64 data URI + local path.
 * Returns null on failure.
 */
export async function downloadImage(item: MessageItem): Promise<{ dataUri: string; localPath: string; size: number } | null> {
  const imageItem = item.image_item;
  if (!imageItem) {
    return null;
  }

  const cdnData = getImageCdnData(imageItem);
  if (!cdnData) {
    return null;
  }

  // Log image size info for debugging
  logger.info('Image item size info', {
    midSize: imageItem.mid_size,
    hdSize: imageItem.hd_size,
    thumbSize: imageItem.thumb_size,
    thumbWidth: imageItem.thumb_width,
    thumbHeight: imageItem.thumb_height,
  });

  try {
    const decrypted = await downloadAndDecrypt(cdnData.encryptQueryParam, cdnData.aesKey, cdnData.fullUrl);
    const mimeType = detectMimeType(decrypted);
    const ext = mimeType.split('/')[1] || 'jpg';
    const fileName = `image_${Date.now()}.${ext}`;
    await mkdir(DOWNLOADS_DIR, { recursive: true });
    const localPath = join(DOWNLOADS_DIR, fileName);
    await writeFile(localPath, decrypted);

    const base64 = decrypted.toString('base64');
    const dataUri = `data:${mimeType};base64,${base64}`;
    logger.info('Image downloaded, decrypted and saved', { localPath, size: decrypted.length });
    return { dataUri, localPath, size: decrypted.length };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('Failed to download image', { error: msg });
    return null;
  }
}

/**
 * Extract text content from a message item.
 * Returns text_item.text or empty string.
 */
export function extractText(item: MessageItem): string {
  return item.text_item?.text ?? '';
}

/**
 * Find all IMAGE type items in a list.
 */
export function extractAllImageUrls(items?: MessageItem[]): MessageItem[] {
  if (!items) return [];
  return items.filter((item) => item.type === MessageItemType.IMAGE);
}

/**
 * Find the first FILE type item in a list.
 */
export function extractFileItem(items?: MessageItem[]): MessageItem | undefined {
  return items?.find((item) => item.type === MessageItemType.FILE);
}

/**
 * Find the first VIDEO type item in a list.
 */
export function extractVideoItem(items?: MessageItem[]): MessageItem | undefined {
  return items?.find((item) => item.type === MessageItemType.VIDEO);
}

/**
 * Find the first VOICE type item in a list.
 */
export function extractVoiceItem(items?: MessageItem[]): MessageItem | undefined {
  return items?.find((item) => item.type === MessageItemType.VOICE);
}

/**
 * Sanitize a file name: strip path components, replace special chars, fallback to timestamp.
 */
export function sanitizeFileName(name: string): string {
  // Take only the last segment (strip any path separators)
  let base = name.split(/[/\\]/).pop() || '';
  // Replace special characters with underscore
  base = base.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  // Collapse multiple underscores
  base = base.replace(/_+/g, '_').replace(/^_|_$/g, '');
  // Fallback to timestamp if empty
  if (!base) {
    base = `file_${Date.now()}`;
  }
  return base;
}

/**
 * Download a file from CDN and save to local disk.
 */
export async function downloadFileToLocal(item: MessageItem): Promise<DownloadedMedia | null> {
  const fileItem = item.file_item;
  if (!fileItem) return null;

  const cdnData = getCdnData(item);
  if (!cdnData) {
    logger.warn('File item has no usable CDN data');
    return null;
  }

  const rawFileName = fileItem.file_name || '';
  const fileName = sanitizeFileName(rawFileName) || `file_${Date.now()}`;

  try {
    const decrypted = await downloadAndDecrypt(cdnData.encryptQueryParam, cdnData.aesKey, cdnData.fullUrl);
    await mkdir(DOWNLOADS_DIR, { recursive: true });
    const localPath = join(DOWNLOADS_DIR, fileName);
    await writeFile(localPath, decrypted);
    logger.info('File downloaded and saved', { localPath, size: decrypted.length });
    return { fileName, localPath, size: decrypted.length };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('Failed to download file', { error: msg });
    return null;
  }
}

/**
 * Download a video from CDN and save to local disk.
 */
export async function downloadVideoToLocal(item: MessageItem): Promise<DownloadedMedia | null> {
  const videoItem = item.video_item;
  if (!videoItem) return null;

  const cdnData = getCdnData(item);
  if (!cdnData) {
    logger.warn('Video item has no usable CDN data');
    return null;
  }

  const fileName = `video_${Date.now()}.mp4`;

  try {
    const decrypted = await downloadAndDecrypt(cdnData.encryptQueryParam, cdnData.aesKey, cdnData.fullUrl);
    await mkdir(DOWNLOADS_DIR, { recursive: true });
    const localPath = join(DOWNLOADS_DIR, fileName);
    await writeFile(localPath, decrypted);
    logger.info('Video downloaded and saved', { localPath, size: decrypted.length });
    return { fileName, localPath, size: decrypted.length };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('Failed to download video', { error: msg });
    return null;
  }
}

/**
 * Download a voice message from CDN and save to local disk.
 */
export async function downloadVoiceToLocal(item: MessageItem): Promise<DownloadedMedia & { voiceText?: string } | null> {
  const voiceItem = item.voice_item;
  if (!voiceItem) return null;

  const cdnData = getCdnData(item);
  if (!cdnData) {
    logger.warn('Voice item has no usable CDN data');
    return null;
  }

  const fileName = `voice_${Date.now()}.amr`;

  try {
    const decrypted = await downloadAndDecrypt(cdnData.encryptQueryParam, cdnData.aesKey, cdnData.fullUrl);
    await mkdir(DOWNLOADS_DIR, { recursive: true });
    const localPath = join(DOWNLOADS_DIR, fileName);
    await writeFile(localPath, decrypted);
    logger.info('Voice downloaded and saved', { localPath, size: decrypted.length });
    const result: DownloadedMedia & { voiceText?: string } = { fileName, localPath, size: decrypted.length };
    if (voiceItem.text) {
      result.voiceText = voiceItem.text;
    }
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('Failed to download voice', { error: msg });
    return null;
  }
}
