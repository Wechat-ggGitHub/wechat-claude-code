import { createInterface } from 'node:readline';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { unlinkSync, writeFileSync, mkdirSync } from 'node:fs';

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
import { DATA_DIR } from './constants.js';
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

/** Open a file using the platform's default application (secure: uses spawnSync) */
function openFile(filePath: string): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];

  if (platform === 'darwin') {
    cmd = 'open';
    args = [filePath];
  } else if (platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '', filePath];
  } else {
    // Linux: try xdg-open
    cmd = 'xdg-open';
    args = [filePath];
  }

  const result = spawnSync(cmd, args, { stdio: 'ignore' });
  if (result.error) {
    logger.warn('Failed to open file', { cmd, filePath, error: result.error.message });
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

async function runSetup(): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });
  const QR_PATH = join(DATA_DIR, 'qrcode.png');

  console.log('正在设置...\n');

  // Loop: generate QR → display → poll for scan → handle expiry → repeat
  while (true) {
    const { qrcodeUrl, qrcodeId } = await startQrLogin();

    const isHeadlessLinux = process.platform === 'linux' &&
      !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;

    if (isHeadlessLinux) {
      // Headless Linux: display QR in terminal using qrcode-terminal
      try {
        const qrcodeTerminal = await import('qrcode-terminal');
        console.log('请用微信扫描下方二维码：\n');
        qrcodeTerminal.default.generate(qrcodeUrl, { small: true });
        console.log();
        console.log('二维码链接：', qrcodeUrl);
        console.log();
      } catch {
        logger.warn('qrcode-terminal not available, falling back to URL');
        console.log('无法在终端显示二维码，请访问链接：');
        console.log(qrcodeUrl);
        console.log();
      }
    } else {
      // macOS / Windows / GUI Linux: generate QR PNG and open with system viewer
      const QRCode = await import('qrcode');
      const pngData = await QRCode.toBuffer(qrcodeUrl, { type: 'png', width: 400, margin: 2 });
      writeFileSync(QR_PATH, pngData);

      openFile(QR_PATH);
      console.log('已打开二维码图片，请用微信扫描：');
      console.log(`图片路径: ${QR_PATH}\n`);
    }

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
  try { unlinkSync(QR_PATH); } catch {
    logger.warn('Failed to clean up QR image', { path: QR_PATH });
  }

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

  // Fix: backfill session workingDirectory from config if it's still the default process.cwd()
  if (config.workingDirectory && session.workingDirectory === process.cwd()) {
    session.workingDirectory = config.workingDirectory;
    sessionStore.save(account.accountId, session);
  }

  const sender = createSender(api, account.accountId);
  const sharedCtx = { lastContextToken: '' };
  const permissionBroker = createPermissionBroker(async () => {
    try {
      await sender.sendText(account.userId ?? '', sharedCtx.lastContextToken, '⏰ 权限请求超时，已自动拒绝。');
    } catch {
      logger.warn('Failed to send permission timeout message');
    }
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

  // -- Grace period: catch late y/n after timeout --

  if (session.state === 'idle' && permissionBroker.isTimedOut(account.accountId)) {
    const lower = userText.toLowerCase();
    if (lower === 'y' || lower === 'yes' || lower === 'n' || lower === 'no') {
      permissionBroker.clearTimedOut(account.accountId);
      await sender.sendText(fromUserId, contextToken, '⏰ 权限请求已超时，请重新发送你的请求。');
      return;
    }
  }

  // -- Permission state handling --

  if (session.state === 'waiting_permission') {
    const lower = userText.toLowerCase();

    // Check if there's actually a pending permission (may be lost after restart)
    const pendingPerm = permissionBroker.getPending(account.accountId);
    if (!pendingPerm) {
      // No pending permission in memory but state is waiting_permission
      // This can happen after service restart - fix the inconsistent state
      session.state = 'idle';
      sessionStore.save(account.accountId, session);
      await sender.sendText(fromUserId, contextToken, '⚠️ 权限请求已失效（可能因服务重启），请重新发送你的请求。');
      return;
    }

    if (lower === 'y' || lower === 'yes') {
      const resolved = permissionBroker.resolvePermission(account.accountId, true);
      await sender.sendText(fromUserId, contextToken, resolved ? '✅ 已允许' : '⚠️ 权限请求处理失败，可能已超时');
    } else if (lower === 'n' || lower === 'no') {
      const resolved = permissionBroker.resolvePermission(account.accountId, false);
      await sender.sendText(fromUserId, contextToken, resolved ? '❌ 已拒绝' : '⚠️ 权限请求处理失败，可能已超时');
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
      getChatHistoryText: (limit?: number) => sessionStore.getChatHistoryText(session, limit),
      rejectPendingPermission: () => permissionBroker.rejectPending(account.accountId),
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

  // Record user message in chat history
  sessionStore.addChatMessage(session, 'user', userText || '(图片)');

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

    const effectivePermissionMode = session.permissionMode ?? config.permissionMode;
    const isAutoPermission = effectivePermissionMode === 'auto';

    // Map 'auto' to the SDK's underlying mode (use acceptEdits as base, but we override canUseTool)
    const sdkPermissionMode = isAutoPermission ? 'acceptEdits' : effectivePermissionMode;

    const queryOptions: QueryOptions = {
      prompt: userText || '请分析这张图片',
      cwd: session.workingDirectory || config.workingDirectory,
      resume: session.sdkSessionId,
      model: session.model,
      permissionMode: sdkPermissionMode,
      images,
      onPermissionRequest: isAutoPermission
        ? async () => true  // auto-approve all tools, skip broker
        : async (toolName: string, toolInput: string) => {
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

    let result = await claudeQuery(queryOptions);

    // If resume failed (e.g. corrupted session), retry without resume
    if (result.error && queryOptions.resume) {
      logger.warn('Resume failed, retrying without resume', { error: result.error, sessionId: queryOptions.resume });
      queryOptions.resume = undefined;
      session.sdkSessionId = undefined;
      sessionStore.save(account.accountId, session);
      const retryResult = await claudeQuery(queryOptions);
      Object.assign(result, retryResult);
    }

    // Send result back to WeChat (show generic error to user, log details internally)
    if (result.error) {
      logger.error('Claude query error', { error: result.error });
      await sender.sendText(fromUserId, contextToken, '⚠️ Claude 处理请求时出错，请稍后重试。');
    } else if (result.text) {
      // Record assistant response in chat history
      sessionStore.addChatMessage(session, 'assistant', result.text);

      const chunks = splitMessage(result.text);
      for (const chunk of chunks) {
        await sender.sendText(fromUserId, contextToken, chunk);
      }
    } else {
      await sender.sendText(fromUserId, contextToken, 'ℹ️ Claude 无返回内容（可能因权限被拒而终止）');
    }

    // Update session with new SDK session ID
    session.sdkSessionId = result.sessionId || undefined;
    session.state = 'idle';
    sessionStore.save(account.accountId, session);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('Error in sendToClaude', { error: errorMsg });
    await sender.sendText(fromUserId, contextToken, '⚠️ 处理消息时出错，请稍后重试。');

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
    logger.error('Setup failed', { error: err instanceof Error ? err.message : String(err) });
    console.error('设置失败:', err);
    process.exit(1);
  });
} else {
  // 'start' or no argument
  runDaemon().catch((err) => {
    logger.error('Daemon start failed', { error: err instanceof Error ? err.message : String(err) });
    console.error('启动失败:', err);
    process.exit(1);
  });
}
