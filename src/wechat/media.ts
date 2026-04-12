import type { MessageItem, ImageItem } from './types.js';
import { MessageItemType } from './types.js';
import { downloadAndDecrypt } from './cdn.js';
import { logger } from '../logger.js';

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
 * supporting both the old cdn_media format and the newer flat format.
 */
function getImageCdnData(imageItem: ImageItem): { aesKey: string; encryptQueryParam: string } | null {
  // Old format: cdn_media.aes_key + cdn_media.encrypt_query_param
  if (imageItem.cdn_media?.aes_key && imageItem.cdn_media?.encrypt_query_param) {
    return {
      aesKey: imageItem.cdn_media.aes_key,
      encryptQueryParam: imageItem.cdn_media.encrypt_query_param,
    };
  }

  // New format: aeskey + media.encrypt_query_param
  // Use media.aes_key (base64-of-hex) over aeskey (raw hex) since downloadAndDecrypt expects base64
  if (imageItem.media?.encrypt_query_param && (imageItem.media.aes_key || imageItem.aeskey)) {
    return {
      aesKey: imageItem.media.aes_key ?? imageItem.aeskey!,
      encryptQueryParam: imageItem.media.encrypt_query_param,
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
 * Download a CDN image, decrypt it, and return a base64 data URI.
 * Returns null on failure.
 */
export async function downloadImage(item: MessageItem): Promise<string | null> {
  const imageItem = item.image_item;
  if (!imageItem) {
    return null;
  }

  const cdnData = getImageCdnData(imageItem);
  if (!cdnData) {
    return null;
  }

  try {
    const decrypted = await downloadAndDecrypt(cdnData.encryptQueryParam, cdnData.aesKey);
    const mimeType = detectMimeType(decrypted);
    const base64 = decrypted.toString('base64');
    const dataUri = `data:${mimeType};base64,${base64}`;
    logger.info('Image downloaded and decrypted', { size: decrypted.length });
    return dataUri;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('Failed to download image', { error: msg });
    return null;
  }
}

/**
 * Extract text content from a message item.
 * Handles text items and voice items (using ASR transcription).
 */
export function extractText(item: MessageItem): string {
  if (item.type === MessageItemType.VOICE) {
    const voiceText = item.voice_item?.voice_text || item.voice_item?.text;
    if (voiceText) {
      return `[语音] ${voiceText}`;
    }
  }
  return item.text_item?.text ?? '';
}

/**
 * Find the first IMAGE type item in a list.
 */
export function extractFirstImageUrl(items?: MessageItem[]): MessageItem | undefined {
  return items?.find((item) => item.type === MessageItemType.IMAGE);
}
