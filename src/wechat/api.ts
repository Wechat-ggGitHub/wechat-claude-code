import type {
  GetUpdatesResp,
  SendMessageReq,
} from './types.js';
import { logger } from '../logger.js';

/** Generate a random uint32 decimal string, then base64 encode it. */
function generateUin(): string {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  const uint32 = new DataView(buf.buffer).getUint32(0, false);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

export class WeChatApi {
  private readonly token: string;
  private readonly baseUrl: string;

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
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'AuthorizationType': 'ilink_bot_token',
      'Authorization': `Bearer ${this.token}`,
      'X-WECHAT-UIN': generateUin(), // regenerate per request
    };
  }

  private assertRetSuccess(action: string, response: { ret?: number; retmsg?: string }): void {
    if (response.ret === undefined || response.ret === 0) {
      return;
    }
    const suffix = response.retmsg ? ` (${response.retmsg})` : '';
    throw new Error(`${action} failed with ret=${response.ret}${suffix}`);
  }

  private async request<T = Record<string, unknown>>(
    path: string,
    body: unknown,
    timeoutMs: number = 15_000,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const url = `${this.baseUrl}/${path}`;

    // All requests must include base_info
    const fullBody = { ...(body as Record<string, unknown>), base_info: { channel_version: '1.0.0' } };

    logger.debug('API request', { url, body: fullBody });

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(fullBody),
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

  /** Send a message to a user. Retries up to 3 times on rate-limit (ret: -2). */
  async sendMessage(req: SendMessageReq): Promise<void> {
    const MAX_RETRIES = 3;
    let delay = 10_000;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const res = await this.request<{ ret?: number; retmsg?: string }>('ilink/bot/sendmessage', req);
      if ((res as any)?.ret === -2) {
        if (attempt === MAX_RETRIES) {
          logger.warn('sendMessage rate-limited after max retries', { attempts: MAX_RETRIES });
          return;
        }
        logger.warn('sendMessage rate-limited (ret:-2), retrying', { attempt, delayMs: delay });
        await new Promise(r => setTimeout(r, delay));
        delay = Math.min(delay * 2, 60_000);
        continue;
      }
      this.assertRetSuccess('sendMessage', res);
      return;
    }
  }

  /**
   * Get CDN upload parameters for a media file.
   * Returns upload_param to use as CDN upload query parameter.
   */
  async getUploadUrl(params: {
    filekey: string;
    media_type: number;
    to_user_id: string;
    rawsize: number;
    rawfilemd5: string;
    filesize: number;
    aeskey: string;
    no_need_thumb?: boolean;
  }): Promise<{ upload_param: string; thumb_upload_param?: string }> {
    const res = await this.request<{ ret?: number; upload_param?: string; thumb_upload_param?: string }>(
      'ilink/bot/getuploadurl',
      {
        filekey: params.filekey,
        media_type: params.media_type,
        to_user_id: params.to_user_id,
        rawsize: params.rawsize,
        rawfilemd5: params.rawfilemd5,
        filesize: params.filesize,
        aeskey: params.aeskey,
        no_need_thumb: params.no_need_thumb ?? true,
      },
    );

    if (res.ret !== undefined && res.ret !== 0) {
      throw new Error(`getUploadUrl failed with ret=${res.ret}`);
    }
    if (!res.upload_param) {
      throw new Error(`getUploadUrl returned no upload_param: ${JSON.stringify(res)}`);
    }
    return res as { upload_param: string; thumb_upload_param?: string };
  }

  /** Get typing_ticket for sendtyping. Cached per userId for ~24h. */
  async getConfig(ilinkUserId: string, contextToken?: string): Promise<string> {
    const body: Record<string, unknown> = { ilink_user_id: ilinkUserId };
    if (contextToken) body.context_token = contextToken;
    const res = await this.request<{ ret?: number; retmsg?: string; typing_ticket?: string }>('ilink/bot/getconfig', body);
    this.assertRetSuccess('getconfig', res);
    if (!res.typing_ticket) {
      throw new Error(`getconfig returned no typing_ticket: ${JSON.stringify(res)}`);
    }
    logger.info('Got typing_ticket', { ilinkUserId });
    return res.typing_ticket;
  }

  /** Send or cancel typing indicator. status: 1=typing, 2=cancel. */
  async sendTyping(ilinkUserId: string, typingTicket: string, status: 1 | 2): Promise<void> {
    const res = await this.request<{ ret?: number; retmsg?: string }>('ilink/bot/sendtyping', {
      ilink_user_id: ilinkUserId,
      typing_ticket: typingTicket,
      status,
    });
    this.assertRetSuccess('sendtyping', res);
  }

}
