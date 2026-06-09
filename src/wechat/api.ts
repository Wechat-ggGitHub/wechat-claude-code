import type {
  GetUpdatesResp,
  SendMessageReq,
  GetUploadUrlResp,
  SendTypingReq,
  GetConfigResp,
} from './types.js';
import { logger } from '../logger.js';

/** Generate a random base64 identifier. */
function generateUin(): string {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  return Buffer.from(buf).toString('base64');
}

export class WeChatApi {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly uin: string;
  private readonly nextSendTime = new Map<string, number>();
  private static readonly MIN_SEND_INTERVAL = 2500;

  constructor(token: string, baseUrl: string = 'https://ilinkai.weixin.qq.com') {
    if (baseUrl) {
      try {
        const url = new URL(baseUrl);
        const allowedHosts = ['weixin.qq.com', 'wechat.com'];
        const isAllowed = allowedHosts.some(h => url.hostname === h || url.hostname.endsWith('.' + h));
        if (url.protocol !== 'https:' || !isAllowed) {
          logger.warn('Untrusted baseUrl, using default', { baseUrl });
          baseUrl = 'https://ilinkai.weixin.qq.com';
        }
      } catch {
        logger.warn('Invalid baseUrl, using default', { baseUrl });
        baseUrl = 'https://ilinkai.weixin.qq.com';
      }
    }
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.uin = generateUin();
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.token}`,
      'AuthorizationType': 'ilink_bot_token',
      'X-WECHAT-UIN': this.uin,
    };
  }

  private async request<T = Record<string, unknown>>(
    path: string,
    body: unknown,
    timeoutMs: number = 15_000,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const url = `${this.baseUrl}/${path}`;

    logger.debug('API request', { url, body });

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }

      const json = (await res.json()) as T;
      logger.debug('API response', json);
      return json;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error(`Request to ${url} timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Long-poll for new messages. Timeout 35s for long-polling. */
  async getUpdates(buf?: string): Promise<GetUpdatesResp> {
    return this.request<GetUpdatesResp>(
      'ilink/bot/getupdates',
      buf ? { get_updates_buf: buf } : {},
      35_000,
    );
  }

  /** Send a message to a user. Per-user rate limited, retries on rate-limit (ret: -2). */
  async sendMessage(req: SendMessageReq): Promise<void> {
    const userId = req.msg?.to_user_id;
    if (userId) {
      const now = Date.now();
      const nextAvailable = (this.nextSendTime.get(userId) ?? 0) + WeChatApi.MIN_SEND_INTERVAL;
      const sendAt = Math.max(now, nextAvailable);
      this.nextSendTime.set(userId, sendAt);
      const waitMs = sendAt - now;
      if (waitMs > 0) {
        logger.debug('Rate limiter waiting', { userId, waitMs });
        await new Promise(r => setTimeout(r, waitMs));
      }
    }

    const MAX_RETRIES = 2;
    let delay = 3_000;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const res = await this.request<{ ret?: number }>('ilink/bot/sendmessage', req);
      if (res.ret === -2) {
        if (attempt === MAX_RETRIES) {
          logger.warn('sendMessage rate-limited after max retries', { attempts: MAX_RETRIES });
          return;
        }
        logger.warn('sendMessage rate-limited (ret:-2), retrying', { attempt, delayMs: delay });
        await new Promise(r => setTimeout(r, delay));
        delay = Math.min(delay * 2, 15_000);
        continue;
      }
      return;
    }
  }

  /** Fetch bot config (includes typing_ticket). */
  async getConfig(ilinkUserId: string, contextToken?: string): Promise<GetConfigResp> {
    return this.request<GetConfigResp>(
      'ilink/bot/getconfig',
      { ilink_user_id: ilinkUserId, context_token: contextToken },
      10_000,
    );
  }

  /** Send a typing indicator to a user. */
  async sendTyping(req: SendTypingReq): Promise<void> {
    await this.request('ilink/bot/sendtyping', req, 10_000);
  }

  /** Get a presigned upload URL for media files. */
  async getUploadUrl(req: import('./types.js').GetUploadUrlReq): Promise<GetUploadUrlResp> {
    return this.request<GetUploadUrlResp>('ilink/bot/getuploadurl', req);
  }
}
