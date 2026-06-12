#!/usr/bin/env node
/**
 * Log Visualizer for wechat-claude-code
 *
 * Generates a self-contained HTML page that compares Claude CLI's original
 * output with what the user actually saw in WeChat.
 *
 * Usage:
 *   npx tsx src/tools/visualize-logs.ts [--date YYYY-MM-DD] [--output path] [--open]
 */

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

const DATA_DIR = process.env.WCC_DATA_DIR || join(homedir(), '.wechat-claude-code');

// ─── Keepalive messages (must match main.ts SILENCE_MESSAGES) ───
const SILENCE_MESSAGES = new Set([
  '我还在处理中，这个问题有点复杂，请再稍等一下',
  '正在努力干活中，马上就有结果了，请稍等片刻',
  '有点复杂正在处理，再给我一点时间，很快就好',
  '快好了别着急，正在收尾阶段，马上给你回复',
  '还在跑呢，任务量比较大，不过马上就能出结果了',
  '任务比想象的复杂一些，再等等我，正在全力处理',
  '正在处理中，进展顺利，再等一会儿就好',
  '还没完不过已经快了，再给我一分钟就能搞定',
  '我在认真思考这个问题，请再稍等一会儿',
  '稍微有点棘手，不过已经快解决了，再等我一下',
  '我还在处理，请稍等一下',
  '请稍等一下',
]);

// ─── Types ───

interface ParsedLine {
  timestamp: string;
  level: string;
  message: string;
  raw?: string;
}

interface SentMessage {
  text: string;
  timestamp: string;
  clientId: string;
  isKeepalive: boolean;
}

interface Session {
  index: number;
  startTime: string;
  endTime: string | null;
  durationSec: number | null;
  sessionId: string;
  resume: boolean;
  cwd: string;
  hasError: boolean;
  textLength: number | null;

  userMessages: Array<{ text: string; timestamp: string }>;
  sentMessages: SentMessage[];
  slashCommands: string[];

  // Enriched from chatHistory
  claudeFullOutput: string | null;
}

// ─── CLI Args ───

function parseArgs(): { date: string; output?: string; open: boolean } {
  const args = process.argv.slice(2);
  let date = '';
  let output: string | undefined;
  let open = false;

  // Default date: today in UTC+8
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
  date = now.toISOString().slice(0, 10);

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--date' && args[i + 1]) {
      date = args[++i];
    } else if (args[i] === '--output' && args[i + 1]) {
      output = args[++i];
    } else if (args[i] === '--open') {
      open = true;
    }
  }
  return { date, output, open };
}

// ─── Log Parsing ───

function tryParseJson(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    // Try to fix corrupted JSON from redact() — context_token gets mangled
    let fixed = raw;
    // Pattern: "context_token": "***"***".replace(/"[^"]*"$/, "")
    fixed = fixed.replace(/"(?:context_token)"\s*:\s*"\*\*\*"\*\*\*"[^}]*?\.replace\([^)]+\)/g, '"context_token":"***"');
    try {
      return JSON.parse(fixed);
    } catch {
      return null;
    }
  }
}

function parseLogFile(logPath: string): ParsedLine[] {
  if (!existsSync(logPath)) {
    console.error(`Log file not found: ${logPath}`);
    process.exit(1);
  }
  const raw = readFileSync(logPath, 'utf-8');
  const lines: ParsedLine[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    // Format: <timestamp> <LEVEL> <message> [JSON]
    const match = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))\s+(INFO|WARN|ERROR|DEBUG)\s+(\S+)(?:\s+(.*))?$/);
    if (!match) continue;
    lines.push({
      timestamp: match[1],
      level: match[2],
      message: match[3],
      raw: match[4],
    });
  }
  return lines;
}

// ─── Data Extraction ───

function extractSentMessage(line: ParsedLine): { text: string; clientId: string } | null {
  if (line.message !== 'API' || !line.raw) return null;
  // "API request {"url":"...sendmessage..."
  const idx = line.raw.indexOf('sendmessage');
  if (idx === -1) return null;
  // Find the JSON object start
  const jsonStart = line.raw.indexOf('{');
  if (jsonStart === -1) return null;
  const data = tryParseJson(line.raw.slice(jsonStart));
  if (!data?.body?.msg?.item_list) return null;
  for (const item of data.body.msg.item_list) {
    if (item.text_item?.text) {
      return { text: item.text_item.text, clientId: data.body.msg.client_id || '' };
    }
  }
  return null;
}

function extractUserMessage(line: ParsedLine): { text: string; timestamp: string } | null {
  if (line.message !== 'API' || !line.raw) return null;
  const jsonStart = line.raw.indexOf('{');
  if (jsonStart === -1) return null;
  const data = tryParseJson(line.raw.slice(jsonStart));
  if (!data?.msgs || !Array.isArray(data.msgs)) return null;
  for (const msg of data.msgs) {
    if (msg.from_user_id?.includes('@im.wechat') && msg.item_list) {
      for (const item of msg.item_list) {
        if (item.text_item?.text) {
          return { text: item.text_item.text, timestamp: line.timestamp };
        }
        if (item.voice_item?.text) {
          return { text: `[语音] ${item.voice_item.text}`, timestamp: line.timestamp };
        }
      }
    }
  }
  return null;
}

// ─── Session Reconstruction ───

function reconstructSessions(lines: ParsedLine[]): Session[] {
  const sessions: Session[] = [];
  let current: Session | null = null;
  let pendingUserMsgs: Array<{ text: string; timestamp: string }> = [];

  for (const line of lines) {
    // Collect user messages that arrive before a query starts
    const userMsg = extractUserMessage(line);
    if (userMsg) {
      pendingUserMsgs.push(userMsg);
    }

    // Slash commands — handled outside sessions
    if (line.message === 'Slash' && line.raw?.startsWith('command:')) {
      if (current) {
        current.slashCommands.push(line.raw.replace('command: ', ''));
      }
      pendingUserMsgs = [];
      continue;
    }

    // Query start
    if (line.message === 'Starting' && line.raw?.includes('Claude CLI query')) {
      const data = tryParseJson(line.raw.replace(/^.*?\{/, '{'));
      current = {
        index: sessions.length + 1,
        startTime: line.timestamp,
        endTime: null,
        durationSec: null,
        sessionId: '',
        resume: data?.resume ?? false,
        cwd: data?.cwd ?? '',
        hasError: false,
        textLength: null,
        userMessages: [...pendingUserMsgs],
        sentMessages: [],
        slashCommands: [],
        claudeFullOutput: null,
      };
      pendingUserMsgs = [];
      sessions.push(current);
      continue;
    }

    // Query completed
    if (line.message === 'Claude' && line.raw?.includes('CLI query completed')) {
      if (current) {
        current.endTime = line.timestamp;
        const start = new Date(current.startTime).getTime();
        const end = new Date(line.timestamp).getTime();
        current.durationSec = Math.round((end - start) / 1000);
        const data = tryParseJson(line.raw.replace(/^.*?\{/, '{'));
        if (data) {
          current.sessionId = data.sessionId || '';
          current.textLength = data.textLength ?? null;
          current.hasError = data.hasError ?? false;
        }
      }
      current = null;
      continue;
    }

    // Query aborted
    if (line.message === 'Claude' && line.raw?.includes('CLI query aborted')) {
      if (current) {
        current.endTime = line.timestamp;
        const start = new Date(current.startTime).getTime();
        const end = new Date(line.timestamp).getTime();
        current.durationSec = Math.round((end - start) / 1000);
        current.hasError = true;
      }
      current = null;
      continue;
    }

    // Query timed out
    if (line.message === 'Claude' && line.raw?.includes('query timed out')) {
      if (current) {
        current.hasError = true;
      }
      continue;
    }

    // Sent messages during a session
    if (current) {
      const sent = extractSentMessage(line);
      if (sent) {
        current.sentMessages.push({
          text: sent.text,
          timestamp: line.timestamp,
          clientId: sent.clientId,
          isKeepalive: SILENCE_MESSAGES.has(sent.text),
        });
      }
    }
  }

  return sessions;
}

// ─── Chat History Enrichment ───

interface ChatEntry {
  role: string;
  content: string;
  timestamp: number;
}

function loadChatHistories(): ChatEntry[] {
  const sessionDir = join(DATA_DIR, 'sessions');
  if (!existsSync(sessionDir)) return [];
  const entries: ChatEntry[] = [];
  for (const f of readdirSync(sessionDir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const data = JSON.parse(readFileSync(join(sessionDir, f), 'utf-8'));
      if (data.chatHistory && Array.isArray(data.chatHistory)) {
        entries.push(...data.chatHistory);
      }
    } catch { /* skip */ }
  }
  return entries;
}

function enrichSessions(sessions: Session[], chatEntries: ChatEntry[]): void {
  // Build lookup of assistant entries by timestamp
  const assistantEntries = chatEntries
    .filter(e => e.role === 'assistant')
    .sort((a, b) => a.timestamp - b.timestamp);

  for (const session of sessions) {
    if (!session.endTime) continue;
    const endMs = new Date(session.endTime).getTime();
    // Find the closest assistant entry within 60s of session end
    let best: ChatEntry | null = null;
    let bestDist = Infinity;
    for (const entry of assistantEntries) {
      const dist = Math.abs(entry.timestamp - endMs);
      if (dist < bestDist && dist < 60_000) {
        bestDist = dist;
        best = entry;
      }
    }
    if (best) {
      session.claudeFullOutput = best.content;
    }
  }
}

// ─── Diff ───

interface DiffSegment {
  type: 'same' | 'lost' | 'extra';
  text: string;
}

function computeDiff(fullOutput: string, sentMessages: SentMessage[]): DiffSegment[] {
  const sent = sentMessages
    .filter(m => !m.isKeepalive)
    .map(m => m.text)
    .join('\n');

  if (!fullOutput && !sent) return [];
  if (!fullOutput) return [{ type: 'extra', text: sent }];
  if (!sent) return [{ type: 'lost', text: fullOutput }];

  // Simple character-level diff: walk both strings
  const segments: DiffSegment[] = [];
  let i = 0, j = 0;

  while (i < fullOutput.length || j < sent.length) {
    // Find common prefix from current positions
    let commonLen = 0;
    while (i + commonLen < fullOutput.length && j + commonLen < sent.length && fullOutput[i + commonLen] === sent[j + commonLen]) {
      commonLen++;
    }

    if (commonLen > 0) {
      // Check if there's lost text before the common section
      if (i > 0 && j > 0) {
        // Already handled
      }
      segments.push({ type: 'same', text: fullOutput.slice(i, i + commonLen) });
      i += commonLen;
      j += commonLen;
    } else {
      // Find where they realign
      let lostEnd = i;
      let extraEnd = j;

      // Look ahead for realignment
      let found = false;
      const lookAhead = Math.min(fullOutput.length - i, sent.length - j, 200);
      for (let k = 1; k <= lookAhead; k++) {
        // Check if skipping k chars from fullOutput matches
        if (i + k < fullOutput.length && fullOutput[i + k] === sent[j]) {
          segments.push({ type: 'lost', text: fullOutput.slice(i, i + k) });
          i += k;
          found = true;
          break;
        }
        // Check if skipping k chars from sent matches
        if (j + k < sent.length && fullOutput[i] === sent[j + k]) {
          segments.push({ type: 'extra', text: sent.slice(j, j + k) });
          j += k;
          found = true;
          break;
        }
      }

      if (!found) {
        // No realignment found nearby, mark rest as different
        if (i < fullOutput.length) {
          segments.push({ type: 'lost', text: fullOutput.slice(i) });
          i = fullOutput.length;
        }
        if (j < sent.length) {
          segments.push({ type: 'extra', text: sent.slice(j) });
          j = sent.length;
        }
      }
    }
  }

  return segments;
}

// ─── HTML Generation ───

function esc(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtTime(ts: string): string {
  const d = new Date(ts);
  // Convert to UTC+8
  const utc8 = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  return utc8.toISOString().slice(11, 19);
}

function fmtDuration(sec: number | null): string {
  if (sec === null) return '?';
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m${s}s`;
}

function renderDiff(segments: DiffSegment[]): string {
  if (segments.length === 0) return '<span class="diff-identical">无法比较</span>';
  const isAllSame = segments.every(s => s.type === 'same');
  if (isAllSame) return '<span class="diff-identical">完全一致，无文本丢失</span>';

  let html = '';
  for (const seg of segments) {
    const text = esc(seg.text);
    if (seg.type === 'same') {
      html += text;
    } else if (seg.type === 'lost') {
      html += `<span class="diff-lost" title="Claude 输出了但未发送到微信">${text}</span>`;
    } else {
      html += `<span class="diff-extra" title="微信收到了但 Claude 未输出">${text}</span>`;
    }
  }
  return html;
}

function generateHtml(sessions: Session[], date: string): string {
  const totalSent = sessions.reduce((sum, s) => sum + s.sentMessages.filter(m => !m.isKeepalive).length, 0);
  const totalKeepalive = sessions.reduce((sum, s) => sum + s.sentMessages.filter(m => m.isKeepalive).length, 0);
  const totalErrors = sessions.filter(s => s.hasError).length;
  const withFullOutput = sessions.filter(s => s.claudeFullOutput !== null).length;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>WeChat-Claude-Code Log Viewer — ${esc(date)}</title>
<style>
  :root {
    --bg: #f0f2f5;
    --card: #fff;
    --border: #e0e0e0;
    --text: #1a1a1a;
    --text2: #666;
    --accent: #4f46e5;
    --green: #16a34a;
    --red: #dc2626;
    --orange: #ea580c;
    --blue-bg: #eff6ff;
    --green-bg: #f0fdf4;
    --red-bg: #fef2f2;
    --orange-bg: #fff7ed;
    --gray-bg: #f9fafb;
    --lost-bg: #fecaca;
    --extra-bg: #bbf7d0;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.6;
    padding: 16px;
    max-width: 900px;
    margin: 0 auto;
  }
  h1 { font-size: 20px; font-weight: 600; margin-bottom: 4px; }
  .subtitle { color: var(--text2); font-size: 14px; margin-bottom: 16px; }
  .stats {
    display: flex; gap: 16px; flex-wrap: wrap;
    margin-bottom: 16px; font-size: 13px;
  }
  .stat { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 8px 14px; }
  .stat b { color: var(--accent); }
  .filters {
    display: flex; gap: 8px; flex-wrap: wrap;
    margin-bottom: 20px;
  }
  .filters button {
    background: var(--card); border: 1px solid var(--border); border-radius: 6px;
    padding: 6px 12px; font-size: 13px; cursor: pointer;
  }
  .filters button.active { background: var(--accent); color: #fff; border-color: var(--accent); }
  .filters button:hover { opacity: 0.8; }
  .session {
    background: var(--card); border: 1px solid var(--border); border-radius: 12px;
    margin-bottom: 16px; overflow: hidden;
  }
  .session.hidden { display: none; }
  .session-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 16px; border-bottom: 1px solid var(--border);
    cursor: pointer; user-select: none;
  }
  .session-header:hover { background: var(--gray-bg); }
  .session-meta { font-size: 13px; color: var(--text2); }
  .session-meta .time { font-weight: 600; color: var(--text); }
  .session-badge {
    display: inline-block; font-size: 11px; font-weight: 600;
    padding: 2px 8px; border-radius: 10px; margin-left: 6px;
  }
  .badge-resume { background: var(--blue-bg); color: var(--accent); }
  .badge-new { background: var(--green-bg); color: var(--green); }
  .badge-error { background: var(--red-bg); color: var(--red); }
  .badge-timeout { background: var(--orange-bg); color: var(--orange); }
  .session-body { padding: 0 16px 16px; }
  .section {
    margin-top: 12px; border-radius: 8px; overflow: hidden;
    border: 1px solid var(--border);
  }
  .section-title {
    font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;
    padding: 6px 12px; color: var(--text2);
  }
  .section-title.user { background: var(--blue-bg); }
  .section-title.claude { background: var(--green-bg); }
  .section-title.sent { background: var(--orange-bg); }
  .section-title.diff { background: var(--gray-bg); }
  .section-content {
    padding: 10px 12px; font-size: 14px; white-space: pre-wrap; word-break: break-word;
    max-height: 400px; overflow-y: auto;
  }
  .sent-item {
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
  }
  .sent-item:last-child { border-bottom: none; }
  .sent-item .timestamp { font-size: 11px; color: var(--text2); margin-bottom: 2px; }
  .sent-item .text { white-space: pre-wrap; word-break: break-word; }
  .sent-item.keepalive { opacity: 0.4; font-style: italic; }
  .diff-lost {
    background: var(--lost-bg); border-radius: 2px; padding: 0 2px;
    text-decoration: line-through; cursor: help;
  }
  .diff-extra {
    background: var(--extra-bg); border-radius: 2px; padding: 0 2px;
    cursor: help;
  }
  .diff-identical { color: var(--green); font-weight: 500; font-style: normal; white-space: normal; }
  .no-data { color: var(--text2); font-style: italic; font-size: 13px; padding: 10px 12px; }
  .char-count { font-size: 11px; color: var(--text2); margin-left: 8px; }
  @media (max-width: 600px) {
    body { padding: 8px; }
    .session-header { flex-direction: column; align-items: flex-start; gap: 4px; }
  }
</style>
</head>
<body>
<h1>WeChat-Claude-Code Log Viewer</h1>
<p class="subtitle">${esc(date)} — ${sessions.length} 个会话</p>

<div class="stats">
  <div class="stat">会话 <b>${sessions.length}</b></div>
  <div class="stat">发送消息 <b>${totalSent}</b></div>
  <div class="stat">心跳 <b>${totalKeepalive}</b></div>
  <div class="stat">错误 <b>${totalErrors}</b></div>
  <div class="stat">有完整输出 <b>${withFullOutput}/${sessions.length}</b></div>
</div>

<div class="filters">
  <button class="active" onclick="toggleFilter(this, 'all')">全部</button>
  <button onclick="toggleFilter(this, 'error')">仅错误</button>
  <button onclick="toggleFilter(this, 'diff')">有差异</button>
  <button onclick="toggleAll(true)">展开全部</button>
  <button onclick="toggleAll(false)">折叠全部</button>
</div>

${sessions.map(s => renderSessionCard(s)).join('\n')}

<script>
function toggleFilter(btn, type) {
  document.querySelectorAll('.filters button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.session').forEach(el => {
    const isErr = el.dataset.error === '1';
    const hasDiff = el.dataset.diff === '1';
    if (type === 'all') el.classList.remove('hidden');
    else if (type === 'error') el.classList.toggle('hidden', !isErr);
    else if (type === 'diff') el.classList.toggle('hidden', !hasDiff);
  });
}
function toggleAll(expand) {
  document.querySelectorAll('.session-body').forEach(el => {
    el.style.display = expand ? '' : 'none';
  });
}
document.querySelectorAll('.session-header').forEach(header => {
  header.addEventListener('click', () => {
    const body = header.nextElementSibling;
    body.style.display = body.style.display === 'none' ? '' : 'none';
  });
});
// Collapse all by default
document.querySelectorAll('.session-body').forEach(el => el.style.display = 'none');
</script>
</body>
</html>`;
}

function renderSessionCard(s: Session): string {
  const startT = fmtTime(s.startTime);
  const endT = s.endTime ? fmtTime(s.endTime) : '?';
  const dur = fmtDuration(s.durationSec);
  const resumeBadge = s.resume
    ? '<span class="session-badge badge-resume">resume</span>'
    : '<span class="session-badge badge-new">new</span>';
  const errorBadge = s.hasError ? '<span class="session-badge badge-error">error</span>' : '';

  // Sent messages HTML
  let sentHtml = '';
  const realMessages = s.sentMessages.filter(m => !m.isKeepalive);
  const keepaliveMessages = s.sentMessages.filter(m => m.isKeepalive);

  if (s.sentMessages.length === 0) {
    sentHtml = '<div class="no-data">无发送记录</div>';
  } else {
    sentHtml = '<div class="section-content">';
    for (const m of realMessages) {
      sentHtml += `<div class="sent-item"><div class="timestamp">${fmtTime(m.timestamp)}</div><div class="text">${esc(m.text)}</div></div>`;
    }
    for (const m of keepaliveMessages) {
      sentHtml += `<div class="sent-item keepalive"><div class="timestamp">${fmtTime(m.timestamp)} [心跳]</div><div class="text">${esc(m.text)}</div></div>`;
    }
    sentHtml += '</div>';
  }

  // Claude full output
  const claudeHtml = s.claudeFullOutput
    ? `<div class="section-content">${esc(s.claudeFullOutput)}</div>`
    : '<div class="no-data">完整输出不可用（会话历史已修剪或未记录）</div>';

  // Diff
  let diffHtml: string;
  let hasDiff = false;
  if (s.claudeFullOutput) {
    const segments = computeDiff(s.claudeFullOutput, s.sentMessages);
    hasDiff = !segments.every(seg => seg.type === 'same');
    diffHtml = `<div class="section-content" style="white-space:pre-wrap;word-break:break-word">${renderDiff(segments)}</div>`;
  } else {
    diffHtml = '<div class="no-data">无可比数据</div>';
    hasDiff = false;
  }

  const totalSentChars = realMessages.reduce((sum, m) => sum + m.text.length, 0);
  const diffIndicator = hasDiff ? ' style="color:var(--red)"' : ' style="color:var(--green)"';

  return `<div class="session" data-error="${s.hasError ? 1 : 0}" data-diff="${hasDiff ? 1 : 0}">
  <div class="session-header">
    <div>
      <span class="time">#${s.index} ${startT} → ${endT}</span> (${dur})
      ${resumeBadge}${errorBadge}
    </div>
    <div class="session-meta">
      <span${diffIndicator}>${s.claudeFullOutput ? `${s.claudeFullOutput.length} → ${totalSentChars} chars` : 'no history'}</span>
      ${s.sessionId ? `<span class="char-count">sid: ${s.sessionId.slice(0, 8)}...</span>` : ''}
    </div>
  </div>
  <div class="session-body">
    <div class="section">
      <div class="section-title user">用户输入</div>
      <div class="section-content">${s.userMessages.map(m => esc(m.text)).join('\n') || '(无)'}</div>
    </div>
    <div class="section">
      <div class="section-title claude">Claude 完整输出${s.claudeFullOutput ? ` <span class="char-count">${s.claudeFullOutput.length} chars</span>` : ''}</div>
      ${claudeHtml}
    </div>
    <div class="section">
      <div class="section-title sent">发送到微信 <span class="char-count">${realMessages.length} 条消息${keepaliveMessages.length > 0 ? ` + ${keepaliveMessages.length} 心跳` : ''}</span></div>
      ${sentHtml}
    </div>
    <div class="section">
      <div class="section-title diff">差异对比</div>
      ${diffHtml}
    </div>
  </div>
</div>`;
}

// ─── Main ───

function main() {
  const { date, output, open } = parseArgs();

  const logPath = join(DATA_DIR, 'logs', `bridge-${date}.log`);
  console.log(`Parsing log: ${logPath}`);

  const lines = parseLogFile(logPath);
  console.log(`Parsed ${lines.length} log lines`);

  const sessions = reconstructSessions(lines);
  console.log(`Reconstructed ${sessions.length} sessions`);

  const chatEntries = loadChatHistories();
  console.log(`Loaded ${chatEntries.length} chat history entries`);
  enrichSessions(sessions, chatEntries);

  const enriched = sessions.filter(s => s.claudeFullOutput !== null).length;
  console.log(`Enriched ${enriched}/${sessions.length} sessions with full output`);

  const html = generateHtml(sessions, date);

  if (output) {
    writeFileSync(output, html, 'utf-8');
    console.log(`Written to: ${output}`);
    if (open) {
      const cmd = process.platform === 'win32'
        ? `cmd /c start "" "${output}"`
        : process.platform === 'darwin'
          ? `open "${output}"`
          : `xdg-open "${output}"`;
      execSync(cmd);
    }
  } else {
    process.stdout.write(html);
  }
}

main();
