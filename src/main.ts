import { createInterface } from 'node:readline';
import process from 'node:process';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

import { WeChatApi } from './wechat/api.js';
import { saveAccount, loadLatestAccount, type AccountData } from './wechat/accounts.js';
import { startQrLogin, waitForQrScan } from './wechat/login.js';
import { createMonitor, type MonitorCallbacks } from './wechat/monitor.js';
import { createSender } from './wechat/send.js';
import { downloadImage, extractText, extractFirstImageUrl } from './wechat/media.js';
import { createSessionStore, type Session } from './session.js';
import { createPermissionBroker } from './permission.js';
import { routeCommand, type CommandContext, type CommandResult } from './commands/router.js';
import { claudeQuery, type QueryOptions } from './claude/provider.js';
import { loadConfig, saveConfig } from './config.js';
import { logger } from './logger.js';
import { MessageType, type WeixinMessage } from './wechat/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_MESSAGE_LENGTH = 2048;

function splitMessage(text: string, maxLen: number = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline near the limit
    let splitIdx = remaining.lastIndexOf('\n', maxLen);
    if (splitIdx < maxLen * 0.3) {
      splitIdx = maxLen;
    }
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n+/, '');
  }
  return chunks;
}

function promptUser(question: string, defaultValue?: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const display = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
    rl.question(display, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

async function runSetup(): Promise<void> {
  const DATA_DIR = join(homedir(), '.wechat-claude-code');
  mkdirSync(DATA_DIR, { recursive: true });
  const QR_PATH = join(DATA_DIR, 'qrcode.png');

  console.log('正在设置...\n');

  // Loop: generate QR → open image → poll for scan → handle expiry → repeat
  while (true) {
    const { qrcodeUrl, qrcodeId } = await startQrLogin();

    // Generate QR code as PNG image
    const QRCode = await import('qrcode');
    const pngData = await QRCode.toBuffer(qrcodeUrl, { type: 'png', width: 400, margin: 2 });
    writeFileSync(QR_PATH, pngData);

    // Open with system default viewer (cross-platform)
    const openCmd = process.platform === 'win32'
      ? `cmd /c start "" "${QR_PATH}"`
      : process.platform === 'darwin'
        ? `open "${QR_PATH}"`
        : `xdg-open "${QR_PATH}"`;
    execSync(openCmd);
    console.log('已打开二维码图片，请用微信扫描：');
    console.log(`图片路径: ${QR_PATH}\n`);
    console.log('等待扫码绑定...');

    try {
      await waitForQrScan(qrcodeId);
      console.log('✅ 绑定成功!');
      break;
    } catch (err: any) {
      if (err.message?.includes('expired')) {
        console.log('⚠️ 二维码已过期，正在刷新...\n');
        continue;
      }
      throw err;
    }
  }

  // Clean up QR image
  try { unlinkSync(QR_PATH); } catch {}

  const workingDir = await promptUser('请输入工作目录', process.cwd());
  const config = loadConfig();
  config.workingDirectory = workingDir;
  saveConfig(config);

  console.log('运行 npm run daemon -- start 启动服务');
}

// ---------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------

async function runDaemon(): Promise<void> {
  const config = loadConfig();
  const account = loadLatestAccount();

  if (!account) {
    console.error('未找到账号，请先运行 node dist/main.js setup');
    process.exit(1);
  }

  const api = new WeChatApi(account.botToken, account.baseUrl);
  const sessionStore = createSessionStore();
  const session: Session = sessionStore.load(account.accountId);
  const sender = createSender(api, account.accountId);
  const sharedCtx = { lastContextToken: '' };
  const permissionBroker = createPermissionBroker(async () => {
    try {
      await sender.sendText(account.userId ?? '', sharedCtx.lastContextToken, '⏰ 权限请求超时，已自动拒绝。');
    } catch {}
  });

  // -- Wire the monitor callbacks --

  const callbacks: MonitorCallbacks = {
    onMessage: async (msg: WeixinMessage) => {
      await handleMessage(msg, account, session, sessionStore, permissionBroker, sender, config, sharedCtx);
    },
    onSessionExpired: () => {
      logger.warn('Session expired, will keep retrying...');
      console.error('⚠️ 微信会话已过期，请重新运行 setup 扫码绑定');
    },
  };

  const monitor = createMonitor(api, callbacks);

  // -- Graceful shutdown --

  function shutdown(): void {
    logger.info('Shutting down...');
    monitor.stop();
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  logger.info('Daemon started', { accountId: account.accountId });
  console.log(`已启动 (账号: ${account.accountId})`);

  await monitor.run();
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

async function handleMessage(
  msg: WeixinMessage,
  account: AccountData,
  session: Session,
  sessionStore: ReturnType<typeof createSessionStore>,
  permissionBroker: ReturnType<typeof createPermissionBroker>,
  sender: ReturnType<typeof createSender>,
  config: ReturnType<typeof loadConfig>,
  sharedCtx: { lastContextToken: string },
): Promise<void> {
  // Filter: only user messages with required fields
  if (msg.message_type !== MessageType.USER) return;
  if (!msg.from_user_id || !msg.item_list) return;

  const contextToken = msg.context_token ?? '';
  const fromUserId = msg.from_user_id;
  sharedCtx.lastContextToken = contextToken;

  // Extract text from items
  const userText = extractTextFromItems(msg.item_list);
  const imageItem = extractFirstImageUrl(msg.item_list);

  // Concurrency guard: reject normal messages and /clear while processing
  if (session.state === 'processing') {
    if (userText.startsWith('/clear')) {
      await sender.sendText(fromUserId, contextToken, '⏳ 正在处理上一条消息，请稍后再清除会话');
    } else if (!userText.startsWith('/')) {
      await sender.sendText(fromUserId, contextToken, '⏳ 正在处理上一条消息，请稍后...');
    }
    // Allow /status and /help during processing (read-only)
    if (!userText.startsWith('/status') && !userText.startsWith('/help')) return;
  }

  // -- Permission state handling --

  if (session.state === 'waiting_permission') {
    const lower = userText.toLowerCase();
    if (lower === 'y' || lower === 'yes') {
      permissionBroker.resolvePermission(account.accountId, true);
      await sender.sendText(fromUserId, contextToken, '✅ 已允许');
    } else if (lower === 'n' || lower === 'no') {
      permissionBroker.resolvePermission(account.accountId, false);
      await sender.sendText(fromUserId, contextToken, '❌ 已拒绝');
    } else {
      await sender.sendText(fromUserId, contextToken, '正在等待权限审批，请回复 y 或 n。');
    }
    return;
  }

  // -- Command routing --

  if (userText.startsWith('/')) {
    const updateSession = (partial: Partial<Session>) => {
      Object.assign(session, partial);
      sessionStore.save(account.accountId, session);
    };

    const ctx: CommandContext = {
      accountId: account.accountId,
      session,
      updateSession,
      clearSession: () => sessionStore.clear(account.accountId),
      text: userText,
    };

    const result: CommandResult = routeCommand(ctx);

    if (result.handled && result.reply) {
      await sender.sendText(fromUserId, contextToken, result.reply);
      return;
    }

    if (result.handled && result.claudePrompt) {
      // Fall through to send the claudePrompt to Claude
      await sendToClaude(
        result.claudePrompt,
        imageItem,
        fromUserId,
        contextToken,
        account,
        session,
        sessionStore,
        permissionBroker,
        sender,
        config,
      );
      return;
    }

    if (result.handled) {
      // Handled but no reply and no claudePrompt (shouldn't normally happen)
      return;
    }

    // Not handled, treat as normal message (fall through)
  }

  // -- Normal message -> Claude --

  if (!userText && !imageItem) {
    await sender.sendText(fromUserId, contextToken, '暂不支持此类型消息，请发送文字或图片');
    return;
  }

  await sendToClaude(
    userText,
    imageItem,
    fromUserId,
    contextToken,
    account,
    session,
    sessionStore,
    permissionBroker,
    sender,
    config,
  );
}

function extractTextFromItems(items: NonNullable<WeixinMessage['item_list']>): string {
  return items.map((item) => extractText(item)).filter(Boolean).join('\n');
}

async function sendToClaude(
  userText: string,
  imageItem: ReturnType<typeof extractFirstImageUrl>,
  fromUserId: string,
  contextToken: string,
  account: AccountData,
  session: Session,
  sessionStore: ReturnType<typeof createSessionStore>,
  permissionBroker: ReturnType<typeof createPermissionBroker>,
  sender: ReturnType<typeof createSender>,
  config: ReturnType<typeof loadConfig>,
): Promise<void> {
  // Set state to processing
  session.state = 'processing';
  sessionStore.save(account.accountId, session);

  try {
    // Download image if present
    let images: QueryOptions['images'];
    if (imageItem) {
      const base64DataUri = await downloadImage(imageItem);
      if (base64DataUri) {
        // Convert data URI to the format Claude expects
        const matches = base64DataUri.match(/^data:([^;]+);base64,(.+)$/);
        if (matches) {
          images = [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: matches[1],
                data: matches[2],
              },
            },
          ];
        }
      }
    }

    const queryOptions: QueryOptions = {
      prompt: userText || '请分析这张图片',
      cwd: session.workingDirectory || config.workingDirectory,
      resume: session.sdkSessionId,
      model: session.model,
      permissionMode: session.permissionMode ?? config.permissionMode,
      images,
      onPermissionRequest: async (toolName: string, toolInput: string) => {
        // Set state to waiting_permission
        session.state = 'waiting_permission';
        sessionStore.save(account.accountId, session);

        // Create pending permission
        const permissionPromise = permissionBroker.createPending(
          account.accountId,
          toolName,
          toolInput,
        );

        // Send permission message to WeChat
        const perm = permissionBroker.getPending(account.accountId);
        if (perm) {
          const permMsg = permissionBroker.formatPendingMessage(perm);
          await sender.sendText(fromUserId, contextToken, permMsg);
        }

        const allowed = await permissionPromise;

        // Reset state after permission resolved
        session.state = 'processing';
        sessionStore.save(account.accountId, session);

        return allowed;
      },
    };

    const result = await claudeQuery(queryOptions);

    // Send result back to WeChat
    if (result.error) {
      await sender.sendText(fromUserId, contextToken, `⚠️ 错误: ${result.error}`);
    } else if (result.text) {
      const chunks = splitMessage(result.text);
      for (const chunk of chunks) {
        await sender.sendText(fromUserId, contextToken, chunk);
      }
    } else {
      await sender.sendText(fromUserId, contextToken, '(Claude 返回了空响应)');
    }

    // Update session with new SDK session ID
    session.sdkSessionId = result.sessionId || undefined;
    session.state = 'idle';
    sessionStore.save(account.accountId, session);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('Error in sendToClaude', { error: errorMsg });
    await sender.sendText(fromUserId, contextToken, `⚠️ 处理消息时出错: ${errorMsg}`);

    // Reset state
    session.state = 'idle';
    sessionStore.save(account.accountId, session);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const command = process.argv[2];

if (command === 'setup') {
  runSetup().catch((err) => {
    console.error('设置失败:', err);
    process.exit(1);
  });
} else {
  // 'start' or no argument
  runDaemon().catch((err) => {
    console.error('启动失败:', err);
    process.exit(1);
  });
}
