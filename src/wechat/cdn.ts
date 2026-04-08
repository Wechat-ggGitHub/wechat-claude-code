import { decryptAesEcb, encryptAesEcb } from "./crypto.js";
import { logger } from "../logger.js";
import { CDN_BASE_URL } from "./accounts.js";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { randomBytes, createHash } from "node:crypto";

export function buildCdnDownloadUrl(encryptQueryParam: string, fullUrl?: string): string {
  // Prefer full_url (contains taskid) when available — required for re-sent files
  if (fullUrl && fullUrl.startsWith('https://')) {
    return fullUrl;
  }
  if (!/^[A-Za-z0-9%=&+._~\-/]+$/.test(encryptQueryParam)) {
    throw new Error('Invalid CDN query parameter');
  }
  return `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;
}

export async function downloadAndDecrypt(
  encryptQueryParam: string,
  aesKeyBase64: string,
  fullUrl?: string,
): Promise<Buffer> {
  const url = buildCdnDownloadUrl(encryptQueryParam, fullUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`CDN download failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  clearTimeout(timer);

  if (!response.ok) {
    throw new Error(`CDN download failed: ${response.status} ${response.statusText}`);
  }

  const encrypted = Buffer.from(await response.arrayBuffer());

  // Handle both formats:
  // 1. base64-of-raw-16-bytes (16 raw bytes encoded as base64)
  // 2. base64-of-hex-string (32 hex chars encoded as base64)
  let aesKey: Buffer;
  const raw = Buffer.from(aesKeyBase64, "base64");

  if (raw.length === 16) {
    aesKey = raw;
  } else {
    const hexStr = raw.toString("utf-8");
    aesKey = Buffer.from(hexStr, "hex");
  }

  const decrypted = decryptAesEcb(aesKey, encrypted);
  logger.info("CDN download and decrypt succeeded", { size: decrypted.length });

  return decrypted;
}

// ── Upload helpers ──────────────────────────────────────────────────────────

/** Map file extension to WeChat media_type parameter */
function mediaTypeFromExt(ext: string): number {
  const lower = ext.toLowerCase();
  const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
  const videoExts = ['.mp4', '.mov', '.avi', '.mkv', '.m4v', '.3gp'];

  if (imageExts.includes(lower)) return 1; // IMAGE
  if (videoExts.includes(lower)) return 2; // VIDEO
  return 3; // FILE
}

export interface UploadResult {
  mediaType: number;
  aesKeyHex: string;
  aesKeyBase64: string;
  encryptQueryParam: string;
  fileName: string;
  fileSize: number;
  encryptedSize: number;
  md5: string;
}

/** Upload encrypted data to WeChat CDN. Returns x-encrypted-param from response header. */
async function uploadToCdn(uploadParam: string, filekey: string, encryptedData: Buffer): Promise<string> {
  const url = `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;

  logger.info('Uploading to CDN', { filekey, encryptedSize: encryptedData.length });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
      },
      body: new Uint8Array(encryptedData),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`CDN upload failed: ${res.status} ${text}`);
    }

    const eqp = res.headers.get('x-encrypted-param');
    if (!eqp) {
      throw new Error('CDN upload succeeded but no x-encrypted-param in response headers');
    }

    logger.info('CDN upload succeeded', { encryptedQueryParamLength: eqp.length });
    return eqp;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('CDN upload timed out after 120s');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read a local file, encrypt it with AES-128-ECB, and upload to WeChat CDN.
 *
 * Upload flow per the iLink protocol:
 * 1. Generate random AES-128 key and filekey
 * 2. Compute raw file MD5 and encrypted size
 * 3. Call getUploadUrl to get upload_param
 * 4. POST encrypted data to CDN
 * 5. Get x-encrypted-param from CDN response header
 */
export async function uploadFile(
  filePath: string,
  toUserId: string,
  getUploadUrl: (params: {
    filekey: string;
    media_type: number;
    to_user_id: string;
    rawsize: number;
    rawfilemd5: string;
    filesize: number;
    aeskey: string;
    no_need_thumb: boolean;
  }) => Promise<{ upload_param: string }>,
): Promise<UploadResult> {
  const ext = extname(filePath);
  const fileName = basename(filePath);
  const mediaType = mediaTypeFromExt(ext);

  const fileData = await readFile(filePath);
  const fileSize = fileData.length;

  // Generate AES-128 key (16 random bytes)
  const aesKeyRaw = randomBytes(16);
  const aesKeyHex = aesKeyRaw.toString('hex');

  // Compute raw file MD5
  const md5 = createHash('md5').update(fileData).digest('hex');

  // Encrypt file with AES-128-ECB
  const encrypted = encryptAesEcb(aesKeyRaw, fileData);
  const encryptedSize = encrypted.length;

  // Generate filekey (random 16 bytes hex)
  const filekey = randomBytes(16).toString('hex');

  logger.info('Uploading file', { filePath, fileName, mediaType, fileSize, encryptedSize, md5 });

  // Step 1: Get upload parameters from API
  const uploadInfo = await getUploadUrl({
    filekey,
    media_type: mediaType,
    to_user_id: toUserId,
    rawsize: fileSize,
    rawfilemd5: md5,
    filesize: encryptedSize,
    aeskey: aesKeyHex,
    no_need_thumb: true,
  });

  logger.info('Got upload_param from API');

  // Step 2: Upload encrypted data to CDN
  const encryptQueryParam = await uploadToCdn(uploadInfo.upload_param, filekey, encrypted);

  // Prepare aes_key for sendmessage: base64(hex string)
  const aesKeyBase64 = Buffer.from(aesKeyHex, 'utf-8').toString('base64');

  logger.info('File upload complete', { fileName, fileSize, encryptedSize });

  return {
    mediaType,
    aesKeyHex,
    aesKeyBase64,
    encryptQueryParam,
    fileName,
    fileSize,
    encryptedSize,
    md5,
  };
}
