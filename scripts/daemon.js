#!/usr/bin/env node
/**
 * wechat-claude-code cross-platform daemon manager
 * Supports: Windows / macOS (launchd) / Linux (systemd + nohup fallback)
 */

import { spawn, execSync } from 'node:child_process';
import { homedir, platform, userInfo } from 'node:os';
import { join, dirname } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, createWriteStream } from 'node:fs';
import { argv, cwd, env, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROJECT_DIR = join(__dirname, '..');
const DATA_DIR = env.WCC_DATA_DIR || join(homedir(), '.wechat-claude-code');
const SERVICE_NAME = 'wechat-claude-code';
const PLATFORM = platform();

// =============================================================================
// Utility functions
// =============================================================================

function getNodeBin() {
  return process.execPath;
}

function getPidFilePath() {
  return join(DATA_DIR, `${SERVICE_NAME}.pid`);
}

function getLogDir() {
  return join(DATA_DIR, 'logs');
}

function ensureLogDir() {
  const logDir = getLogDir();
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }
}

function readPidFile() {
  const pidFile = getPidFilePath();
  if (!existsSync(pidFile)) return null;
  try {
    return parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
  } catch {
    return null;
  }
}

function writePidFile(pid) {
  writeFileSync(getPidFilePath(), String(pid));
}

function removePidFile() {
  const pidFile = getPidFilePath();
  if (existsSync(pidFile)) {
    unlinkSync(pidFile);
  }
}

function isProcessRunning(pid) {
  if (!pid || isNaN(pid)) return false;

  if (PLATFORM === 'win32') {
    try {
      // Windows: use tasklist to check if process exists
      const result = execSync(`tasklist /FI "PID eq ${pid}" /NH`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe']
      });
      return result.includes(String(pid));
    } catch {
      return false;
    }
  } else {
    // Unix: use kill -0
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

function killProcess(pid) {
  if (PLATFORM === 'win32') {
    try {
      execSync(`taskkill /PID ${pid} /F`, { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  } else {
    try {
      process.kill(pid, 'SIGTERM');
      return true;
    } catch {
      return false;
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// =============================================================================
// Windows functions
// =============================================================================

function windowsStart() {
  const pid = readPidFile();
  if (pid && isProcessRunning(pid)) {
    console.log(`Already running (PID: ${pid})`);
    exit(0);
  }

  ensureLogDir();

  const nodeBin = getNodeBin();
  const mainJs = join(PROJECT_DIR, 'dist', 'main.js');
  const stdoutLog = join(getLogDir(), 'stdout.log');
  const stderrLog = join(getLogDir(), 'stderr.log');

  console.log('Starting wechat-claude-code daemon...');

  // Use detatched spawn on Windows
  const child = spawn(nodeBin, [mainJs, 'start'], {
    cwd: PROJECT_DIR,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  // Write PID file
  writePidFile(child.pid);

  // Pipe stdout/stderr to log files
  const stdout = createWriteStream(stdoutLog, { flags: 'a' });
  const stderr = createWriteStream(stderrLog, { flags: 'a' });
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);

  // Unref to allow parent to exit
  child.unref();

  console.log(`Started (PID: ${child.pid})`);
  console.log(`Logs: ${stdoutLog}`);
}

function windowsStop() {
  const pid = readPidFile();

  if (!pid) {
    console.log('Not running (no PID file)');
    exit(0);
  }

  if (!isProcessRunning(pid)) {
    removePidFile();
    console.log('Not running (stale PID file)');
    exit(0);
  }

  console.log(`Stopping process (PID: ${pid})...`);

  // Try graceful shutdown first
  killProcess(pid);

  // Wait for process to exit (sync version)
  let attempts = 0;
  while (isProcessRunning(pid) && attempts < 10) {
    // Synchronous sleep using busy wait
    const start = Date.now();
    while (Date.now() - start < 1000) {
      // busy wait
    }
    attempts++;
  }

  // Force kill if still running
  if (isProcessRunning(pid)) {
    console.log('Force killing...');
    killProcess(pid);
  }

  removePidFile();
  console.log('Stopped');
}

function windowsStatus() {
  const pid = readPidFile();

  if (!pid) {
    console.log('Not running');
    exit(0);
  }

  if (isProcessRunning(pid)) {
    console.log(`Running (PID: ${pid})`);
  } else {
    console.log('Not running (stale PID file)');
  }
}

function windowsLogs() {
  const logDir = getLogDir();

  if (!existsSync(logDir)) {
    console.log('No logs found');
    exit(0);
  }

  const files = ['stdout.log', 'stderr.log'];

  for (const file of files) {
    const filePath = join(logDir, file);
    if (existsSync(filePath)) {
      console.log(`=== ${file} (last 50 lines) ===`);
      try {
        const content = readFileSync(filePath, 'utf-8');
        const lines = content.split('\n').slice(-50).join('\n');
        console.log(lines);
      } catch (err) {
        console.log(`Error reading ${file}: ${err.message}`);
      }
      console.log('');
    }
  }
}

// =============================================================================
// macOS (launchd) functions
// =============================================================================

function macosPlistLabel() {
  return 'com.wechat-claude-code.bridge';
}

function macosPlistPath() {
  return join(homedir(), 'Library', 'LaunchAgents', `${macosPlistLabel()}.plist`);
}

function macosIsLoaded() {
  try {
    execSync(`launchctl print gui/${userInfo().uid}/${macosPlistLabel()}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function macosStart() {
  if (macosIsLoaded()) {
    console.log('Already running (or plist loaded)');
    exit(0);
  }

  ensureLogDir();

  const plistLabel = macosPlistLabel();
  const plistPath = macosPlistPath();
  const nodeBin = getNodeBin();
  const mainJs = join(PROJECT_DIR, 'dist', 'main.js');

  // Collect Anthropic/Claude env vars
  let plistExtraEnv = '';
  for (const varName of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_API_KEY']) {
    if (env[varName]) {
      plistExtraEnv += `    <key>${varName}</key>
    <string>${env[varName]}</string>
`;
    }
  }

  const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${plistLabel}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${mainJs}</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${PROJECT_DIR}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${join(DATA_DIR, 'logs', 'stdout.log')}</string>
  <key>StandardErrorPath</key>
  <string>${join(DATA_DIR, 'logs', 'stderr.log')}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${join(homedir(), '.local', 'bin')}:${dirname(nodeBin)}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
${plistExtraEnv}  </dict>
</dict>
</plist>
`;

  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, plistContent);

  execSync(`launchctl load "${plistPath}"`);
  console.log('Started wechat-claude-code daemon (macOS launchd)');
}

function macosStop() {
  const plistLabel = macosPlistLabel();
  const plistPath = macosPlistPath();

  try {
    execSync(`launchctl bootout gui/${userInfo().uid}/${plistLabel}`, { stdio: 'pipe' });
  } catch {
    // Ignore errors
  }

  if (existsSync(plistPath)) {
    unlinkSync(plistPath);
  }

  console.log('Stopped wechat-claude-code daemon (macOS launchd)');
}

function macosStatus() {
  if (macosIsLoaded()) {
    try {
      const result = execSync('pgrep -f "dist/main.js start"', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      const pid = result.trim().split('\n')[0];
      if (pid) {
        console.log(`Running (PID: ${pid})`);
      } else {
        console.log('Loaded but not running');
      }
    } catch {
      console.log('Loaded but not running');
    }
  } else {
    console.log('Not running');
  }
}

function macosLogs() {
  const logDir = getLogDir();

  if (!existsSync(logDir)) {
    console.log('No logs found');
    exit(0);
  }

  const files = ['stdout.log', 'stderr.log'];

  for (const file of files) {
    const filePath = join(logDir, file);
    if (existsSync(filePath)) {
      console.log(`=== ${file} ===`);
      try {
        execSync(`tail -30 "${filePath}"`, { stdio: 'inherit' });
      } catch (err) {
        // Fallback if tail not available
        const content = readFileSync(filePath, 'utf-8');
        console.log(content.split('\n').slice(-30).join('\n'));
      }
      console.log('');
    }
  }
}

// =============================================================================
// Linux (systemd + nohup fallback) functions
// =============================================================================

function linuxEnsureUserSession() {
  if (!env.XDG_RUNTIME_DIR) {
    env.XDG_RUNTIME_DIR = `/run/user/${userInfo().uid}`;
    try {
      mkdirSync(env.XDG_RUNTIME_DIR, { recursive: true });
    } catch {
      // Ignore
    }
  }
  if (!env.DBUS_SESSION_BUS_ADDRESS) {
    env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${env.XDG_RUNTIME_DIR}/bus`;
  }
}

function linuxServiceFile() {
  return join(homedir(), '.config', 'systemd', 'user', `${SERVICE_NAME}.service`);
}

function linuxSystemdAvailable() {
  linuxEnsureUserSession();
  try {
    execSync('systemctl --user list-units', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function linuxCreateServiceFile() {
  const serviceFile = linuxServiceFile();
  const nodeBin = getNodeBin();
  const mainJs = join(PROJECT_DIR, 'dist', 'main.js');

  mkdirSync(dirname(serviceFile), { recursive: true });

  // Collect env vars
  let extraEnv = '';
  for (const varName of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_API_KEY']) {
    if (env[varName]) {
      extraEnv += `Environment=${varName}=${env[varName]}\n`;
    }
  }

  const serviceContent = `[Unit]
Description=WeChat Claude Code Bridge
Documentation=https://github.com/Wechat-ggGitHub/wechat-claude-code
After=network.target

[Service]
Type=simple
ExecStart=${nodeBin} ${mainJs} start
WorkingDirectory=${PROJECT_DIR}
Restart=always
RestartSec=10
Environment=PATH=${join(homedir(), '.local', 'bin')}:${dirname(nodeBin)}:/usr/local/bin:/usr/bin:/bin
${extraEnv}StandardOutput=append:${join(DATA_DIR, 'logs', 'stdout.log')}
StandardError=append:${join(DATA_DIR, 'logs', 'stderr.log')}
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
`;

  writeFileSync(serviceFile, serviceContent);
}

function linuxDirectStart() {
  const pid = readPidFile();
  if (pid && isProcessRunning(pid)) {
    console.log(`Already running (PID: ${pid})`);
    exit(0);
  }

  ensureLogDir();

  const nodeBin = getNodeBin();
  const mainJs = join(PROJECT_DIR, 'dist', 'main.js');
  const stdoutLog = join(getLogDir(), 'stdout.log');
  const stderrLog = join(getLogDir(), 'stderr.log');

  console.log('Starting wechat-claude-code daemon (direct mode)...');

  const child = spawn(nodeBin, [mainJs, 'start'], {
    cwd: PROJECT_DIR,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  writePidFile(child.pid);

  const stdout = createWriteStream(stdoutLog, { flags: 'a' });
  const stderr = createWriteStream(stderrLog, { flags: 'a' });
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);

  child.unref();

  console.log(`Started (PID: ${child.pid})`);
  console.log(`Logs: ${stdoutLog}`);
}

function linuxDirectStop() {
  const pid = readPidFile();

  if (!pid) {
    console.log('Not running (no PID file)');
    exit(0);
  }

  if (!isProcessRunning(pid)) {
    removePidFile();
    console.log('Not running (stale PID file)');
    exit(0);
  }

  console.log(`Stopping process (PID: ${pid})...`);

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Ignore
  }

  // Wait for process to exit (sync version)
  let attempts = 0;
  while (isProcessRunning(pid) && attempts < 10) {
    const start = Date.now();
    while (Date.now() - start < 1000) {
      // busy wait
    }
    attempts++;
  }

  // Force kill if still running
  if (isProcessRunning(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Ignore
    }
  }

  removePidFile();
  console.log('Stopped');
}

function linuxDirectStatus() {
  const pid = readPidFile();

  if (!pid) {
    console.log('Not running');
    exit(0);
  }

  if (isProcessRunning(pid)) {
    console.log(`Running (PID: ${pid})`);
  } else {
    console.log('Not running (stale PID file)');
  }
}

function linuxStart() {
  if (linuxSystemdAvailable()) {
    try {
      // Check if already running
      execSync(`systemctl --user is-active --quiet ${SERVICE_NAME}`, { stdio: 'pipe' });
      console.log('Already running');
      exit(0);
    } catch {
      // Not running, continue
    }

    ensureLogDir();
    linuxCreateServiceFile();

    linuxEnsureUserSession();
    execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
    execSync(`systemctl --user start ${SERVICE_NAME}`);
    try {
      execSync(`systemctl --user enable ${SERVICE_NAME}`, { stdio: 'pipe' });
    } catch {
      // Ignore
    }

    console.log('Started wechat-claude-code daemon (Linux systemd)');
  } else {
    console.log('Note: systemd user session not available, using direct mode');
    console.log(`To enable systemd mode, run: 'loginctl enable-linger ${userInfo().username}'`);
    console.log('');
    linuxDirectStart();
  }
}

function linuxStop() {
  if (linuxSystemdAvailable()) {
    try {
      execSync(`systemctl --user cat ${SERVICE_NAME}`, { stdio: 'pipe' });
      execSync(`systemctl --user stop ${SERVICE_NAME}`, { stdio: 'pipe' });
      try {
        execSync(`systemctl --user disable ${SERVICE_NAME}`, { stdio: 'pipe' });
      } catch {
        // Ignore
      }
      console.log('Stopped wechat-claude-code daemon (Linux systemd)');
      return;
    } catch {
      // Service doesn't exist, try direct mode
    }
  }

  linuxDirectStop();
}

function linuxStatus() {
  if (linuxSystemdAvailable()) {
    try {
      execSync(`systemctl --user cat ${SERVICE_NAME}`, { stdio: 'pipe' });

      try {
        execSync(`systemctl --user is-active --quiet ${SERVICE_NAME}`);
        const pidResult = execSync(`systemctl --user show-property --value=MainPID ${SERVICE_NAME}`, { encoding: 'utf-8' }).trim();
        if (pidResult && pidResult !== '0') {
          console.log(`Running (PID: ${pidResult})`);
        } else {
          console.log('Active');
        }
      } catch {
        console.log('Not running');
      }

      console.log('');
      try {
        execSync(`systemctl --user status ${SERVICE_NAME} --no-pager`, { stdio: 'inherit' });
      } catch {
        // Ignore
      }
      return;
    } catch {
      // Service doesn't exist
    }
  }

  linuxDirectStatus();
}

function linuxLogs() {
  // Try journalctl first
  try {
    execSync(`journalctl --user --unit=${SERVICE_NAME} --quiet`, { stdio: 'pipe' });
    console.log('=== systemd journal logs (last 100 lines) ===');
    try {
      execSync(`journalctl --user --unit=${SERVICE_NAME} --no-pager -n 100`, { stdio: 'inherit' });
    } catch {
      // Ignore
    }
    console.log('');
    console.log('=== File logs ===');
  } catch {
    // journalctl not available or no logs
  }

  const logDir = getLogDir();

  if (!existsSync(logDir)) {
    console.log('No logs found');
    exit(0);
  }

  const files = ['stdout.log', 'stderr.log'];

  for (const file of files) {
    const filePath = join(logDir, file);
    if (existsSync(filePath)) {
      console.log(`=== ${file} ===`);
      try {
        execSync(`tail -50 "${filePath}"`, { stdio: 'inherit' });
      } catch {
        const content = readFileSync(filePath, 'utf-8');
        console.log(content.split('\n').slice(-50).join('\n'));
      }
      console.log('');
    }
  }
}

// =============================================================================
// Main dispatcher
// =============================================================================

function main() {
  const command = argv[2];

  const usage = `Usage: daemon.js {start|stop|restart|status|logs}`;

  if (PLATFORM === 'win32') {
    switch (command) {
      case 'start':
        windowsStart();
        break;
      case 'stop':
        windowsStop();
        break;
      case 'restart':
        windowsStop();
        setTimeout(() => windowsStart(), 1000);
        break;
      case 'status':
        windowsStatus();
        break;
      case 'logs':
        windowsLogs();
        break;
      default:
        console.log(usage);
        console.log('Platform: Windows (direct mode)');
        exit(1);
    }
  } else if (PLATFORM === 'darwin') {
    switch (command) {
      case 'start':
        macosStart();
        break;
      case 'stop':
        macosStop();
        break;
      case 'restart':
        macosStop();
        setTimeout(() => macosStart(), 1000);
        break;
      case 'status':
        macosStatus();
        break;
      case 'logs':
        macosLogs();
        break;
      default:
        console.log(usage);
        console.log('Platform: macOS (launchd)');
        exit(1);
    }
  } else if (PLATFORM === 'linux') {
    switch (command) {
      case 'start':
        linuxStart();
        break;
      case 'stop':
        linuxStop();
        break;
      case 'restart':
        linuxStop();
        setTimeout(() => linuxStart(), 1000);
        break;
      case 'status':
        linuxStatus();
        break;
      case 'logs':
        linuxLogs();
        break;
      default:
        console.log(usage);
        console.log('Platform: Linux (systemd)');
        exit(1);
    }
  } else {
    console.log(`Error: Unsupported platform '${PLATFORM}'`);
    console.log('Supported platforms: Windows, macOS (Darwin), Linux');
    exit(1);
  }
}

main();
