import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { encryptAesEcb, aesEcbPaddedSize } from './crypto.js';
import { WeChatApi } from './api.js';
import { UploadMediaType } from './types.js';
import { CDN_BASE_URL } from '../constants.js';
import { logger } from '../logger.js';

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico']);

export interface UploadedMedia {
  mediaType: 'image' | 'file';
  encryptQueryParam: string;
  aesKeyHex: string;
  fileName: string;
  fileSize: number;
  rawSize: number;
}

export function isImageFile(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(filePath).toLowerCase());
}

export async function uploadFile(
  api: WeChatApi,
  toUserId: string,
  filePath: string,
): Promise<UploadedMedia> {
  const stat = statSync(filePath);
  if (stat.size > MAX_FILE_SIZE) {
    throw new Error(`文件过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)，最大支持 25MB`);
  }

  const fileName = basename(filePath);
  const isImage = isImageFile(filePath);
  const mediaType = isImage ? UploadMediaType.IMAGE : UploadMediaType.FILE;

  // Prepare file
  const plaintext = readFileSync(filePath);
  const rawSize = plaintext.length;
  const rawFileMd5 = createHash('md5').update(plaintext).digest('hex');
  const fileSize = aesEcbPaddedSize(rawSize);
  const fileKey = randomBytes(16).toString('hex'); // 32-hex-char string
  const aesKey = randomBytes(16); // 16 raw bytes
  const aesKeyHex = aesKey.toString('hex');

  // Get upload URL
  logger.info('Requesting upload URL', { fileName, rawSize, mediaType, toUserId });

  const uploadResp = await api.getUploadUrl({
    filekey: fileKey,
    media_type: mediaType,
    to_user_id: toUserId,
    rawsize: rawSize,
    rawfilemd5: rawFileMd5,
    filesize: fileSize,
    no_need_thumb: true,
    aeskey: aesKeyHex,
    base_info: {
      channel_version: '2.0.0',
      bot_agent: 'wechat-claude-code',
    },
  });

  logger.info('Upload URL response', { uploadResp });

  if (!uploadResp.upload_full_url && !uploadResp.upload_param) {
    throw new Error(`获取上传地址失败: ${JSON.stringify(uploadResp)}`);
  }

  // Encrypt
  const encrypted = encryptAesEcb(aesKey, plaintext);

  // Build CDN upload URL
  let uploadUrl: string;
  if (uploadResp.upload_full_url) {
    uploadUrl = uploadResp.upload_full_url;
  } else {
    uploadUrl = `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadResp.upload_param!)}&filekey=${fileKey}`;
  }

  logger.info('Uploading to CDN', { uploadUrl, encryptedSize: encrypted.length });

  // Upload to CDN (POST, get download param from response header)
  const encryptQueryParam = await uploadToCdn(uploadUrl, encrypted);

  logger.info('CDN upload succeeded', { fileName });

  return {
    mediaType: isImage ? 'image' : 'file',
    encryptQueryParam,
    aesKeyHex,
    fileName,
    fileSize,
    rawSize,
  };
}

async function uploadToCdn(url: string, encrypted: Buffer): Promise<string> {
  const MAX_RETRIES = 3;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);

    try {
      const res = await fetch(url, {
        method: 'POST',
        body: new Uint8Array(encrypted),
        signal: controller.signal,
        headers: { 'Content-Type': 'application/octet-stream' },
      });

      if (res.status >= 400 && res.status < 500) {
        const text = await res.text();
        throw new Error(`CDN 上传失败 (4xx): ${res.status} ${text.slice(0, 200)}`);
      }

      if (res.status >= 500) {
        logger.warn('CDN upload 5xx, retrying', { status: res.status, attempt });
        continue;
      }

      // Get download param from response header
      const param = res.headers.get('x-encrypted-param');
      if (!param) {
        throw new Error('CDN 上传成功但未返回 x-encrypted-param');
      }
      return param;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error('CDN 上传超时');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error('CDN 上传失败: 多次重试后仍失败');
}
