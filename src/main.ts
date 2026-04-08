import { createInterface } from 'node:readline';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { unlinkSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';

import { existsSync } from 'node:fs';
import { WeChatApi } from './wechat/api.js';
import { saveAccount, loadLatestAccount, type AccountData } from './wechat/accounts.js';
import { startQrLogin, waitForQrScan } from './wechat/login.js';
import { createMonitor, type MonitorCallbacks } from './wechat/monitor.js';
import { createSender } from './wechat/send.js';
import { downloadImage, extractText, extractAllImageUrls, extractFileItem, extractVideoItem, extractVoiceItem, downloadFileToLocal, downloadVideoToLocal, downloadVoiceToLocal, type DownloadedMedia } from './wechat/media.js';

import { createSessionStore, type Session } from './session.js';
import { createPermissionBroker } from './permission.js';
import { routeCommand, type CommandContext, type CommandResult } from './commands/router.js';
import { claudeQuery, type QueryOptions } from './claude/provider.js';
import { loadConfig, saveConfig } from './config.js';
import { logger } from './logger.js';
import { processVoiceMessage } from './media/voice.js';
import { DATA_DIR } from './constants.js';
import { MessageType, type WeixinMessage } from './wechat/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_MESSAGE_LENGTH = 800; // WeChat reads best under 800 chars per message
const FINAL_REPLY_TARGET_LENGTH = 280;
const STREAMING_MODE_ERROR_PATTERNS = [
  /only prompt commands are supported in streaming mode/i,
];
const ABORT_ERROR_PATTERNS = [
  /Claude Code process aborted by user/i,
  /operation aborted/i,
  /\babort(ed)?\b/i,
  /\binterrupted\b/i,
];
const EARLY_RESPONSE_MIN_CHARS = 8;
const EARLY_RESPONSE_MAX_CHARS = 140;
const EARLY_RESPONSE_WAIT_MS = 2800;
const RESUME_RECOVERY_ERROR_PATTERNS = [
  ...STREAMING_MODE_ERROR_PATTERNS,
  /cannot resume/i,
  /\bresume\b.*(failed|invalid|unsupported|not supported|not found|expired|missing)/i,
  /\bsession\b.*(invalid|not found|expired|missing|unknown|closed|ended)/i,
  /(invalid|not found|expired|missing|unknown).*(resume|session)/i,
];
const HISTORY_FALLBACK_MESSAGE_LIMIT = 12;
const HISTORY_FALLBACK_CHAR_LIMIT = 6000;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function shouldRetryWithoutResume(error?: string, text?: string): boolean {
  if (!error || text?.trim()) {
    return false;
  }
  return RESUME_RECOVERY_ERROR_PATTERNS.some((pattern) => pattern.test(error));
}

function hasStreamingModeCompatibilityError(error?: string): boolean {
  if (!error) {
    return false;
  }
  return STREAMING_MODE_ERROR_PATTERNS.some((pattern) => pattern.test(error));
}

function isAbortLikeError(error?: string): boolean {
  if (!error) {
    return false;
  }
  return ABORT_ERROR_PATTERNS.some((pattern) => pattern.test(error));
}

function buildPromptWithHistory(basePrompt: string, session: Session): string {
  const history = session.chatHistory || [];
  const previousMessages = history.slice(0, -1);
  if (previousMessages.length === 0) {
    return basePrompt;
  }

  const recentMessages = previousMessages.slice(-HISTORY_FALLBACK_MESSAGE_LIMIT);
  const contextLines: string[] = [];
  let usedChars = 0;

  for (let i = recentMessages.length - 1; i >= 0; i--) {
    const msg = recentMessages[i];
    const content = msg.content.replace(/\n{3,}/g, '\n\n').trim();
    if (!content) {
      continue;
    }

    const role = msg.role === 'user' ? '用户' : 'Claude';
    const line = `${role}: ${content}`;
    if (usedChars + line.length > HISTORY_FALLBACK_CHAR_LIMIT && contextLines.length > 0) {
      break;
    }

    contextLines.unshift(line);
    usedChars += line.length;
  }

  if (contextLines.length === 0) {
    return basePrompt;
  }

  return [
    ...contextLines,
    '',
    `用户: ${basePrompt}`,
  ].join('\n');
}

// ── File sending via [SEND_FILE: path] markers ──────────────────────────────
// When Claude outputs [SEND_FILE: /path/to/file], we detect it, upload the
// file to WeChat CDN, and send it as a media message. The marker is stripped
// from the text before forwarding to the user.

const SEND_FILE_RE = /\[SEND_FILE:\s*([^\]]+)\]/g;
const SEND_FILE_MARKER_PREFIX = '[SEND_FILE:';

function splitMessage(text: string, maxLen: number = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Try to split at double newline (paragraph break) first
    let splitIdx = -1;
    const searchStart = Math.max(maxLen * 0.3, maxLen - 200);
    for (let i = maxLen; i >= searchStart; i--) {
      if (remaining[i] === '\n' && remaining[i - 1] === '\n') {
        splitIdx = i;
        break;
      }
    }
    // Fallback: single newline
    if (splitIdx < 0) {
      splitIdx = remaining.lastIndexOf('\n', maxLen);
    }
    // Last resort: hard cut
    if (splitIdx < searchStart) {
      splitIdx = maxLen;
    }
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n+/, '');
  }
  return chunks;
}

function isContextLeakLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }

  return [
    /会话恢复了一下/i,
    /会话被中断了/i,
    /依据上面的历史继续/i,
    /依据上面.*历史继续/i,
    /依据上面的会话历史继续/i,
    /依据上面.*会话历史继续/i,
    /我是依据.*历史继续/i,
    /我是依据.*会话历史继续/i,
    /我依据.*历史继续/i,
    /我依据.*会话历史继续/i,
    /根据上面的历史继续/i,
    /根据上面的会话历史继续/i,
    /根据历史继续/i,
    /根据会话历史继续/i,
    /沿着上面的历史继续/i,
    /沿着上面的会话历史继续/i,
  ].some((pattern) => pattern.test(trimmed));
}

function isProcessChatterLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }

  return [
    /^这是之前扫描的残留输出/i,
    /^我现在派\d+个Agent/i,
    /^我现在派Agent/i,
    /^我继续(看看|看下|看一下|查|查下|查一下|确认|确认下|检查|检查下|处理)/i,
    /^让我(先)?(看看|看下|看一下|查|查下|查一下|确认|确认下|检查|检查下|过一遍|翻一下|拉取)/i,
    /^我(先|来|去)(看看|看下|看一下|查|查下|查一下|确认|确认下|检查|检查下|过一遍|翻一下|拉取)/i,
  ].some((pattern) => pattern.test(trimmed));
}

function cleanupFinalWechatText(text: string, sentEarlyResponse: boolean): string {
  const lines = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd());

  const cleaned: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      if (cleaned.length > 0 && cleaned[cleaned.length - 1] !== '') {
        cleaned.push('');
      }
      continue;
    }

    if (isContextLeakLine(trimmed)) {
      continue;
    }

    if (isProcessChatterLine(trimmed)) {
      continue;
    }

    cleaned.push(trimmed);
  }

  while (cleaned.length > 0 && cleaned[0] === '') {
    cleaned.shift();
  }

  while (cleaned.length > 0 && cleaned[cleaned.length - 1] === '') {
    cleaned.pop();
  }

  if (sentEarlyResponse) {
    while (cleaned.length > 0) {
      const firstLine = cleaned[0]?.trim();
      if (!firstLine) {
        cleaned.shift();
        continue;
      }
      if (isGoodEarlyResponse(firstLine) || isProcessChatterLine(firstLine)) {
        cleaned.shift();
        while (cleaned.length > 0 && cleaned[0] === '') {
          cleaned.shift();
        }
        continue;
      }
      break;
    }
  }

  return cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function splitWechatReply(text: string, targetLen: number = FINAL_REPLY_TARGET_LENGTH): string[] {
  const normalized = text.trim();
  if (!normalized) {
    return [];
  }

  if (normalized.length <= targetLen) {
    return [normalized];
  }

  const chunks: string[] = [];
  const paragraphs = normalized.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  let current = '';

  const flush = (): void => {
    const trimmed = current.trim();
    if (trimmed) {
      chunks.push(trimmed);
    }
    current = '';
  };

  const appendParagraph = (paragraph: string): void => {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= targetLen) {
      current = candidate;
      return;
    }

    if (current) {
      flush();
    }

    if (paragraph.length <= targetLen) {
      current = paragraph;
      return;
    }

    const lines = paragraph.split('\n').map((line) => line.trim()).filter(Boolean);
    let local = '';

    for (const line of lines) {
      const localCandidate = local ? `${local}\n${line}` : line;
      if (localCandidate.length <= targetLen) {
        local = localCandidate;
        continue;
      }

      if (local) {
        chunks.push(local);
        local = '';
      }

      if (line.length <= targetLen) {
        local = line;
      } else {
        chunks.push(...splitMessage(line, targetLen));
      }
    }

    if (local) {
      current = local;
    }
  };

  for (const paragraph of paragraphs) {
    appendParagraph(paragraph);
  }

  flush();
  return chunks;
}

function isGoodEarlyResponse(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }

  if (isContextLeakLine(trimmed)) {
    return false;
  }

  if (/[`#]/.test(trimmed) || /^\s*[-*0-9]+\./m.test(trimmed) || trimmed.includes('\n- ')) {
    return false;
  }

  const compact = trimmed.replace(/\s+/g, '');

  if (/^(好的?|行|可以|收到|明白|嗯|好嘞|没问题|稍等|稍等下|马上)[，。！？!?~… ]*$/i.test(compact)) {
    return false;
  }

  if (/^(找到了|结果是|看完了|查完了|已经(处理|完成|删完|清空)|搞定了|删除成功|清理完了)/.test(compact)) {
    return false;
  }

  const actionLeadPatterns = [
    /我先/i,
    /我这就/i,
    /我先去/i,
    /我先看/i,
    /我先查/i,
    /我先核对/i,
    /我先确认/i,
    /我先检查/i,
    /我先拉/i,
    /我先搜/i,
    /我拉出来看看/i,
    /我来先/i,
    /我来看看/i,
    /我来看下/i,
    /我来查/i,
    /我来查下/i,
    /我来确认/i,
    /我来确认下/i,
    /我来检查/i,
    /我来处理/i,
    /我来清/i,
    /我帮你/i,
    /我去看/i,
    /我去查/i,
    /我看一下/i,
    /我看下/i,
    /我查一下/i,
    /我查下/i,
    /我确认一下/i,
    /我确认下/i,
    /我检查一下/i,
    /我检查下/i,
    /我过一遍/i,
    /我翻一下/i,
    /我先过一遍/i,
    /我先翻一下/i,
    /让我先/i,
    /先把/i,
    /先看下/i,
    /先查下/i,
    /继续处理/i,
    /好[的呀啊吧]*[,， ]*我/i,
    /行[,， ]*我/i,
    /收到[,， ]*我/i,
  ];

  if (actionLeadPatterns.some((pattern) => pattern.test(trimmed))) {
    return true;
  }

  return /(看|查|核对|确认|检查|处理|清理|清空|删除|扫描|拉取|翻|整理|筛|对比|排查|验证|汇总|过一遍|搜|分析)/.test(trimmed)
    && /(我|先|这就|马上|继续)/.test(trimmed)
    && !/(总结|如下|共计|一共|清单|名单|累计)/.test(trimmed);
}

function findEarlyFlushIndex(text: string): number {
  if (!text) {
    return 0;
  }

  const strongBoundary = /\n{2,}|[。！？!?；;](?:\s|$)?/g;
  let match: RegExpExecArray | null;
  while ((match = strongBoundary.exec(text)) !== null) {
    const boundary = match.index + match[0].length;
    if (boundary > EARLY_RESPONSE_MAX_CHARS) {
      break;
    }
    if (boundary >= EARLY_RESPONSE_MIN_CHARS) {
      const candidate = text.slice(0, boundary).trim();
      if (isGoodEarlyResponse(candidate)) {
        return boundary;
      }
    }
  }

  return 0;
}

function findSoftEarlyFlushIndex(text: string): number {
  if (!text) {
    return 0;
  }

  const trimmed = text.trim();
  if (!trimmed || trimmed.length < EARLY_RESPONSE_MIN_CHARS || trimmed.length > EARLY_RESPONSE_MAX_CHARS) {
    return 0;
  }

  if (trimmed.includes('\n') || trimmed.includes(SEND_FILE_MARKER_PREFIX)) {
    return 0;
  }

  return isGoodEarlyResponse(trimmed) ? text.length : 0;
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
// Singleton lock (prevents multiple daemon instances)
// ---------------------------------------------------------------------------

const LOCK_FILE = join(DATA_DIR, 'daemon.lock');

function isPM2(): boolean {
  return !!process.env.pm_id || !!process.env.pm2_exec_path;
}

function acquireLock(): void {
  mkdirSync(DATA_DIR, { recursive: true });

  // PM2 manages process lifecycle itself - skip lock to avoid restart loops
  if (isPM2()) {
    logger.info('Running under PM2, skipping singleton lock');
    return;
  }

  if (existsSync(LOCK_FILE)) {
    try {
      const lockData = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
      try {
        process.kill(lockData.pid, 0);
        console.error(`❌ 已有 daemon 进程运行中 (PID: ${lockData.pid}, started: ${lockData.started})`);
        console.error('   如需重启，请先运行: npm run daemon -- stop');
        process.exit(1);
      } catch {
        // Process is dead, steal the lock
        logger.warn('Stale lock found, stealing', { oldPid: lockData.pid });
      }
    } catch {
      // Corrupted lock file, remove it
      logger.warn('Corrupted lock file, removing');
    }
  }

  // Write our lock
  writeFileSync(LOCK_FILE, JSON.stringify({
    pid: process.pid,
    started: new Date().toISOString(),
  }));
  logger.info('Acquired daemon lock', { pid: process.pid });
}

function releaseLock(): void {
  try { unlinkSync(LOCK_FILE); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------

async function runDaemon(): Promise<void> {
  acquireLock();

  const config = loadConfig();
  const account = loadLatestAccount();

  if (!account) {
    console.error('未找到账号，请先运行 node dist/main.js setup');
    releaseLock();
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

  // Fix: reset stale non-idle state on startup (e.g. after crash)
  if (session.state !== 'idle') {
    logger.warn('Resetting stale session state on startup', { state: session.state });
    session.state = 'idle';
    sessionStore.save(account.accountId, session);
  }

  const sender = createSender(api, account.accountId);
  const sharedCtx = { lastContextToken: '' };
  const activeControllers = new Map<string, AbortController>();

  // Pending media: stores downloaded image local paths from aborted queries
  // so that the next message can reference them
  const pendingMediaPaths: string[] = [];
  const permissionBroker = createPermissionBroker(async () => {
    try {
      await sender.sendText(account.userId ?? '', sharedCtx.lastContextToken, '⏰ 权限请求超时，已自动拒绝。');
    } catch {
      logger.warn('Failed to send permission timeout message');
    }
  });

  // -- Wire the monitor callbacks --

  // Typing indicator: cache typing_ticket per userId
  const typingTicketCache = new Map<string, { ticket: string; expires: number }>();

  const callbacks: MonitorCallbacks = {
    onMessage: async (msg: WeixinMessage) => {
      await handleMessage(msg, account, session, sessionStore, permissionBroker, sender, config, sharedCtx, activeControllers, pendingMediaPaths, api, typingTicketCache);
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
    releaseLock();
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
  activeControllers: Map<string, AbortController>,
  pendingMediaPaths: string[],
  api: WeChatApi,
  typingTicketCache: Map<string, { ticket: string; expires: number }>,
): Promise<void> {
  // Filter: only user messages with required fields
  if (msg.message_type !== MessageType.USER) return;
  if (!msg.from_user_id || !msg.item_list) return;

  const contextToken = msg.context_token ?? '';
  const fromUserId = msg.from_user_id;
  sharedCtx.lastContextToken = contextToken;

  // Extract text from items
  const userText = extractTextFromItems(msg.item_list);
  const imageItems = extractAllImageUrls(msg.item_list);
  const fileItem = extractFileItem(msg.item_list);
  const videoItem = extractVideoItem(msg.item_list);
  const voiceItem = extractVoiceItem(msg.item_list);

  // Concurrency guard: abort current query when new message arrives
  if (session.state === 'processing') {
    if (userText.startsWith('/clear')) {
      // Force reset stuck session state
      const ctrl = activeControllers.get(account.accountId);
      if (ctrl) { ctrl.abort(); activeControllers.delete(account.accountId); }
      session.state = 'idle';
      pendingMediaPaths.length = 0;
      sessionStore.save(account.accountId, session);
      // Fall through to command routing so /clear executes normally
    } else if (!userText.startsWith('/')) {
      // Abort the current query and process the new message instead
      const ctrl = activeControllers.get(account.accountId);
      if (ctrl) { ctrl.abort(); activeControllers.delete(account.accountId); }
      session.state = 'idle';
      sessionStore.save(account.accountId, session);
      // pendingMediaPaths retains any downloaded image paths from aborted query
      // Fall through to send new message to Claude
    } else if (!userText.startsWith('/status') && !userText.startsWith('/help')) {
      return;
    }
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
    // Check if there's actually a pending permission (may be lost after restart)
    const pendingPerm = permissionBroker.getPending(account.accountId);
    if (!pendingPerm) {
      session.state = 'idle';
      sessionStore.save(account.accountId, session);
      await sender.sendText(fromUserId, contextToken, '⚠️ 权限请求已失效（可能因服务重启），请重新发送你的请求。');
      return;
    }

    const lower = userText.toLowerCase();
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
        imageItems,
        fromUserId,
        contextToken,
        account,
        session,
        sessionStore,
        permissionBroker,
        sender,
        config,
        activeControllers,
        pendingMediaPaths,
        api,
        typingTicketCache,
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

  if (!userText && imageItems.length === 0 && !fileItem && !videoItem && !voiceItem) {
    await sender.sendText(fromUserId, contextToken, '暂不支持此类型消息，请发送文字、图片、文件、视频或语音');
    return;
  }

  // Build context description for non-text media
  let mediaContext = '';

  // If there are pending media paths from a previously aborted query, attach them
  if (pendingMediaPaths.length > 0) {
    mediaContext += `\n[用户之前发送了以下图片，已保存到本地，请一并处理: ${pendingMediaPaths.join(', ')}]`;
    pendingMediaPaths.length = 0;
  }

  // Handle file: download to local and describe to Claude
  if (fileItem) {
    const downloaded = await downloadFileToLocal(fileItem);
    if (downloaded) {
      mediaContext += `\n[用户发送了一个文件: ${downloaded.fileName} (${formatSize(downloaded.size)})，已保存到 ${downloaded.localPath}]`;
    } else {
      mediaContext += '\n[用户发送了一个文件，但下载失败]';
    }
  }

  // Handle video: download and pass path to Claude
  if (videoItem) {
    const downloaded = await downloadVideoToLocal(videoItem);
    if (downloaded) {
      mediaContext += `\n[用户发送了一个视频: ${downloaded.fileName} (${formatSize(downloaded.size)})，已保存到 ${downloaded.localPath}。你可以使用工具读取和分析这个视频文件。]`;
    } else {
      mediaContext += '\n[用户发送了一个视频，但下载失败]';
    }
  }

  // Handle voice: download, transcribe, and include text if available
  if (voiceItem) {
    const downloaded = await downloadVoiceToLocal(voiceItem);
    if (downloaded) {
      const serverVoiceText = downloaded.voiceText?.trim();
      if (serverVoiceText) {
        mediaContext += `\n用户发送了一条语音，语音识别文本: ${serverVoiceText}`;
      } else {
        // Fall back to local transcription only when WeChat did not already provide text
        const transcription = await processVoiceMessage(downloaded.localPath);
        if (transcription) {
          mediaContext += `\n用户发送了一条语音，语音识别文本: ${transcription}`;
        } else {
          mediaContext += `\n用户发送了一条语音，已保存到 ${downloaded.localPath}（语音识别暂不可用）`;
        }
      }
    } else {
      mediaContext += '\n[用户发送了一条语音，但下载失败]';
    }
  }

  const effectivePrompt = (userText || '请处理用户发送的文件') + mediaContext;

  await sendToClaude(
    effectivePrompt,
    imageItems,
    fromUserId,
    contextToken,
    account,
    session,
    sessionStore,
    permissionBroker,
    sender,
    config,
    activeControllers,
    pendingMediaPaths,
    api,
    typingTicketCache,
  );
}

function extractTextFromItems(items: NonNullable<WeixinMessage['item_list']>): string {
  return items.map((item) => extractText(item)).filter(Boolean).join('\n');
}

async function sendToClaude(
  userText: string,
  imageItems: ReturnType<typeof extractAllImageUrls>,
  fromUserId: string,
  contextToken: string,
  account: AccountData,
  session: Session,
  sessionStore: ReturnType<typeof createSessionStore>,
  permissionBroker: ReturnType<typeof createPermissionBroker>,
  sender: ReturnType<typeof createSender>,
  config: ReturnType<typeof loadConfig>,
  activeControllers: Map<string, AbortController>,
  pendingMediaPaths: string[],
  api: WeChatApi,
  typingTicketCache: Map<string, { ticket: string; expires: number }>,
): Promise<void> {
  // Set state to processing
  session.state = 'processing';
  sessionStore.save(account.accountId, session);

  // Create abort controller for this query so it can be cancelled by new messages
  const abortController = new AbortController();
  activeControllers.set(account.accountId, abortController);

  // Record user message in chat history
  sessionStore.addChatMessage(session, 'user', userText || '(图片)');

  // -- Typing indicator --
  const TYPING_TICKET_TTL = 20 * 60 * 1000; // cache ticket for 20 minutes
  const TYPING_REFRESH_INTERVAL = 5 * 1000; // refresh every 5s
  let typingTimer: ReturnType<typeof setInterval> | null = null;

  async function getTypingTicket(): Promise<string> {
    const cached = typingTicketCache.get(fromUserId);
    if (cached && cached.expires > Date.now()) return cached.ticket;
    const ticket = await api.getConfig(fromUserId, contextToken);
    typingTicketCache.set(fromUserId, { ticket, expires: Date.now() + TYPING_TICKET_TTL });
    return ticket;
  }

  async function startTyping(): Promise<void> {
    try {
      const ticket = await getTypingTicket();
      await api.sendTyping(fromUserId, ticket, 1);
      typingTimer = setInterval(async () => {
        try {
          const t = await getTypingTicket();
          await api.sendTyping(fromUserId, t, 1);
        } catch { /* ignore typing refresh errors */ }
      }, TYPING_REFRESH_INTERVAL);
    } catch (err) {
      logger.warn('Failed to start typing indicator', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  async function stopTyping(): Promise<void> {
    if (typingTimer) { clearInterval(typingTimer); typingTimer = null; }
    try {
      const cached = typingTicketCache.get(fromUserId);
      if (cached) await api.sendTyping(fromUserId, cached.ticket, 2);
    } catch { /* ignore */ }
  }

  let partialTextBuffer = '';
  let sentAssistantPrefix = '';
  let sentEarlyResponse = false;
  let partialFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let partialFlushChain = Promise.resolve();

  const isCurrentRun = (): boolean => activeControllers.get(account.accountId) === abortController;

  function clearPartialFlushTimer(): void {
    if (partialFlushTimer) {
      clearTimeout(partialFlushTimer);
      partialFlushTimer = null;
    }
  }

  function queueEarlyResponse(allowSoftFlush = false): Promise<void> {
    partialFlushChain = partialFlushChain
      .then(async () => {
        clearPartialFlushTimer();

        if (sentEarlyResponse || !isCurrentRun()) {
          return;
        }

        let flushIndex = findEarlyFlushIndex(partialTextBuffer);
        if (flushIndex <= 0 && allowSoftFlush) {
          flushIndex = findSoftEarlyFlushIndex(partialTextBuffer);
        }
        if (flushIndex <= 0) {
          if (partialTextBuffer.trim()) {
            scheduleEarlyResponse();
          }
          return;
        }

        const markerIndex = partialTextBuffer.indexOf(SEND_FILE_MARKER_PREFIX);
        if (markerIndex >= 0 && markerIndex < flushIndex) {
          flushIndex = markerIndex;
        }

        if (flushIndex <= 0) {
          return;
        }

        const rawChunk = partialTextBuffer.slice(0, flushIndex);
        const displayChunk = rawChunk.trim();
        partialTextBuffer = partialTextBuffer.slice(flushIndex).replace(/^\n+/, '');

        if (!displayChunk) {
          if (partialTextBuffer.trim()) {
            scheduleEarlyResponse();
          }
          return;
        }

        if (!isCurrentRun()) {
          return;
        }

        for (const chunk of splitMessage(displayChunk)) {
          await sender.sendText(fromUserId, contextToken, chunk);
        }

        sentAssistantPrefix += rawChunk;
        sentEarlyResponse = true;
      })
      .catch((err) => {
        logger.warn('Failed to flush partial assistant text', {
          error: err instanceof Error ? err.message : String(err),
        });
      });

    return partialFlushChain;
  }

  function scheduleEarlyResponse(): void {
    if (sentEarlyResponse || !isCurrentRun()) {
      return;
    }
    clearPartialFlushTimer();
    if (!partialTextBuffer.trim()) {
      return;
    }

    partialFlushTimer = setTimeout(() => {
      void queueEarlyResponse(true);
    }, EARLY_RESPONSE_WAIT_MS);
  }

  // Start typing indicator (fire and forget, don't block query)
  startTyping();

  try {
    // Download images if present
    let images: QueryOptions['images'];
    if (imageItems.length > 0) {
      const imageEntries: NonNullable<QueryOptions['images']> = [];
      for (const imgItem of imageItems) {
        const imgResult = await downloadImage(imgItem);
        if (imgResult) {
          // Notify user that image was received and saved
          try {
            await sender.sendText(fromUserId, contextToken, `📷 收到图片 (${formatSize(imgResult.size)})，正在处理...`);
          } catch { /* ignore send errors */ }

          // Convert data URI to the format Claude expects
          const matches = imgResult.dataUri.match(/^data:([^;]+);base64,(.+)$/);
          if (matches) {
            imageEntries.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: matches[1],
                data: matches[2],
              },
            });
          }

          // Save path to pendingMediaPaths so it survives abort
          pendingMediaPaths.push(imgResult.localPath);
        }
      }
      if (imageEntries.length > 0) {
        images = imageEntries;
      }
    }

    const effectivePermissionMode = session.permissionMode ?? config.permissionMode;
    const isAutoPermission = effectivePermissionMode === 'auto';

    // Map 'auto' to bypassPermissions — skips all permission checks in the SDK
    const sdkPermissionMode = isAutoPermission ? 'bypassPermissions' : effectivePermissionMode;

    // Extract [SEND_FILE: path] markers from text.
    // Returns { filePaths, cleanedText } — does NOT send files.
    function extractSendFileMarkers(text: string): { filePaths: string[]; cleanedText: string } {
      const filePaths: string[] = [];
      let match: RegExpExecArray | null;
      const re = new RegExp(SEND_FILE_RE.source, 'g');
      while ((match = re.exec(text)) !== null) {
        filePaths.push(match[1].trim());
      }
      const cleaned = text.replace(new RegExp(SEND_FILE_RE.source, 'g'), '').trim();
      return { filePaths, cleanedText: cleaned };
    }

    const SEND_FILE_SYSTEM_HINT = `

[WeChat Bridge - Communication Protocol]
You are communicating with the user through WeChat. Follow these rules strictly:

## Message Format
- Keep responses SHORT - WeChat messages work best under 500 characters
- Break long responses into short paragraphs separated by newlines
- Use bullet points or numbered lists for multiple items
- Do NOT use markdown headers (##, ###) or code blocks with triple backticks - they render poorly in WeChat
- Use plain text formatting only
- Be direct - lead with the answer, not the reasoning

## File & Media Support
You can send files (Excel, Word, PDF, images, videos, etc.) to the user via WeChat.
When you need to send a file, output a marker in your response: [SEND_FILE: /absolute/path/to/file]
The system will automatically upload and send the file to the user's WeChat, and strip the marker from the text.
You can include multiple markers to send multiple files. Examples:
- [SEND_FILE: C:\\Users\\user\\Desktop\\report.xlsx]
- [SEND_FILE: /home/user/photo.jpg]
Always verify the file exists before including the marker. You can use Bash (ls) to check.

## Media from User
The user can send you files, images, videos, and voice messages. When they do:
- Files are downloaded to ~/.wechat-claude-code/downloads/ and the path is included in the prompt
- Videos are downloaded to ~/.wechat-claude-code/downloads/ and the path is included in the prompt. Use tools to analyze video files.
- Voice messages are downloaded to ~/.wechat-claude-code/downloads/ (speech-to-text transcription included when available)
- Images are sent as base64 data for direct analysis
You can read and process these files from their local paths.

## File Management
You can manage files on this computer. The user may ask you to:
- Search for files by name, type, or content
- Read, create, edit, or delete files
- Organize files (move, rename, copy)
- Convert file formats (e.g., CSV to Excel, JSON to CSV)
- Compress or extract archives
Always confirm before deleting files. Show file paths so the user can verify.

## Behavior Guidelines
- When the user sends a file/image, always acknowledge it first, then process
- Before using tools for a multi-step, destructive, or time-consuming task, first send one short sentence telling the user what you are about to do
- That first sentence should feel like a natural chat reply, not a robotic status label
- A brief acknowledgment is fine, but it must quickly transition into the immediate next action
- Prefer one complete natural sentence of about 10-30 Chinese characters before you start working
- Avoid repetitive honorifics or exaggerated phrases like "老板说得对" unless the user is clearly using that tone on purpose
- Do not mention hidden context management or say things like "我是依据上面的会话历史继续的" unless the user explicitly asks how context or memory works
- Do not narrate every internal step or stream token-by-token
- Do not expose tool failures, retries, debugging chatter, or implementation steps unless the user explicitly asks for them
- After the initial short sentence, keep silent until you have a real result to report
- When done, summarize the result concisely
- If something fails, explain what happened and suggest next steps
- Use Chinese (中文) by default unless the user writes in English`;

    const effectiveSystemPrompt = (config.systemPrompt ?? '') + SEND_FILE_SYSTEM_HINT;

    const basePrompt = userText || '请分析这张图片';
    const buildClaudePrompt = (useHistoryFallback: boolean): string =>
      useHistoryFallback ? buildPromptWithHistory(basePrompt, session) : basePrompt;

    const queryOptions: QueryOptions = {
      prompt: buildClaudePrompt(!session.sdkSessionId),
      cwd: (session.workingDirectory || config.workingDirectory).replace(/^~/, process.env.HOME || ''),
      resume: session.sdkSessionId,
      model: session.model,
      systemPrompt: effectiveSystemPrompt,
      permissionMode: sdkPermissionMode,
      abortController,
      images,
      onText: async (text: string) => {
        if (!text || !isCurrentRun()) {
          return;
        }

        partialTextBuffer += text;

        if (!sentEarlyResponse) {
          if (findEarlyFlushIndex(partialTextBuffer) > 0) {
            await queueEarlyResponse();
          } else {
            scheduleEarlyResponse();
          }
        }
      },
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

    // Retry without resume only for errors that clearly indicate resume/session reuse is unavailable.
    if (queryOptions.resume && shouldRetryWithoutResume(result.error, result.text)) {
      logger.warn('Resume unavailable, retrying with local history fallback', {
        error: result.error,
        sessionId: queryOptions.resume,
      });
      // Save the previous session ID for debugging before clearing
      session.previousSdkSessionId = queryOptions.resume;
      queryOptions.resume = undefined;
      session.sdkSessionId = undefined;
      queryOptions.prompt = buildClaudePrompt(true);
      sessionStore.save(account.accountId, session);
      const retryResult = await claudeQuery(queryOptions);
      Object.assign(result, retryResult);
    }

    if (hasStreamingModeCompatibilityError(result.error)) {
      const incompatibleSessionId = result.sessionId || queryOptions.resume || session.sdkSessionId;
      logger.warn('Streaming mode compatibility issue detected, rotating Claude session for next turn', {
        sessionId: incompatibleSessionId,
        error: result.error,
      });
      if (incompatibleSessionId) {
        session.previousSdkSessionId = incompatibleSessionId;
      }
      result.sessionId = '';
    }

    clearPartialFlushTimer();

    if (!isCurrentRun()) {
      logger.info('Skipping stale Claude result because a newer query is active', {
        sessionId: result.sessionId,
        hasText: !!result.text,
        hasError: !!result.error,
      });
      return;
    }

    if (isAbortLikeError(result.error)) {
      logger.info('Skipping aborted Claude output', {
        sessionId: result.sessionId,
        hasText: !!result.text,
        error: result.error,
      });
      session.state = 'idle';
      sessionStore.save(account.accountId, session);
      return;
    }

    // Send result back to WeChat — use the streamed prefix when available,
    // then fall back to the final result for anything not yet delivered.
    if (result.text) {
      if (result.error) {
        logger.warn('Claude query had error but returned text, using text', { error: result.error });
      }
      sessionStore.addChatMessage(session, 'assistant', result.text);
      const { filePaths } = extractSendFileMarkers(result.text);
      let remainingText = result.text;

      if (sentAssistantPrefix) {
        if (result.text.startsWith(sentAssistantPrefix)) {
          remainingText = result.text.slice(sentAssistantPrefix.length);
        } else {
          logger.warn('Streamed assistant prefix did not match final result, falling back to full response', {
            streamedLength: sentAssistantPrefix.length,
            finalLength: result.text.length,
          });
        }
      }

      const { cleanedText } = extractSendFileMarkers(remainingText);
      const textNotes: string[] = [];

      // Send files first
      for (const fp of filePaths) {
        try {
          if (!existsSync(fp)) {
            logger.warn('SEND_FILE: file not found', { path: fp });
            textNotes.push(`⚠️ 文件发送失败: ${fp}（文件不存在）`);
            continue;
          }
          logger.info('SEND_FILE: uploading', { path: fp });
          await sender.sendMedia(fromUserId, contextToken, fp);
          logger.info('SEND_FILE: sent successfully', { path: fp });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error('SEND_FILE: failed', { path: fp, error: msg });
          textNotes.push(`⚠️ 文件发送失败: ${fp}`);
        }
      }

      // Then send the final text that has not already been streamed.
      const finalText = cleanupFinalWechatText(
        [cleanedText.trim(), ...textNotes].filter(Boolean).join('\n'),
        sentEarlyResponse,
      );
      if (finalText) {
        const chunks = splitWechatReply(finalText);
        for (const chunk of chunks) {
          await sender.sendText(fromUserId, contextToken, chunk);
        }
      }
    } else if (result.error) {
      logger.error('Claude query error', { error: result.error });
      try {
        await sender.sendText(fromUserId, contextToken, '❌ 处理出错，请重试');
      } catch { /* ignore send errors */ }
    } else {
      await sender.sendText(fromUserId, contextToken, 'ℹ️ Claude 无返回内容（可能因权限被拒而终止）');
    }

    // Update session with new SDK session ID
    session.sdkSessionId = result.sessionId || undefined;
    session.state = 'idle';
    // Clear pending media paths on successful completion (they've been processed)
    pendingMediaPaths.length = 0;
    sessionStore.save(account.accountId, session);
  } catch (err) {
    clearPartialFlushTimer();
    const isAbort = err instanceof Error && (err.name === 'AbortError' || err.message.includes('abort'));
    if (isAbort) {
      // Query was cancelled by a new incoming message — keep pendingMediaPaths intact
      // so the next message can reference the downloaded images
      logger.info('Claude query aborted by new message, pending media preserved', { pendingMediaPaths });
    } else {
      if (!isCurrentRun()) {
        logger.info('Suppressing error from stale Claude query', {
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('Error in sendToClaude (silenced)', { error: errorMsg });
      try {
        await sender.sendText(fromUserId, contextToken, '❌ 处理出错，请重试');
      } catch { /* ignore send errors */ }
    }
    // Note: do NOT clear sdkSessionId on abort — the aborted query may have
    // returned a valid sessionId in provider.ts which was already captured.
    // Only clear it if we know the session is genuinely lost.
    if (isCurrentRun()) {
      session.state = 'idle';
      sessionStore.save(account.accountId, session);
    }
  } finally {
    clearPartialFlushTimer();
    // Stop typing indicator
    if (isCurrentRun()) {
      await stopTyping();
      activeControllers.delete(account.accountId);
    }
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
