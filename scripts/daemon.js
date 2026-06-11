#!/usr/bin/env node

// =============================================================================
// wechat-claude-code cross-platform daemon manager
// Supports: macOS (launchd) / Linux (systemd + nohup fallback) / Windows
// =============================================================================

import { execSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, readdirSync, statSync, openSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(homedir(), '.wechat-claude-code');
const PROJECT_DIR = join(__dirname, '..');
const SERVICE_NAME = 'wechat-claude-code';
const PID_FILE = join(DATA_DIR, `${SERVICE_NAME}.pid`);
const LOG_DIR = join(DATA_DIR, 'logs');

const platform = process.platform;

// =============================================================================
// Helpers
// =============================================================================

function ensureLogDir() {
  mkdirSync(LOG_DIR, { recursive: true });
}

function getNodeBin() {
  return process.execPath; // current node binary
}

function getEnvVars() {
  const vars = {};
  for (const key of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_API_KEY']) {
    if (process.env[key]) vars[key] = process.env[key];
  }
  return vars;
}

function readPid() {
  try {
    return parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
  } catch {
    return null;
  }
}

function isProcessRunning(pid) {
  try {
    if (platform === 'win32') {
      const out = execSync(`tasklist /fi "PID eq ${pid}" /fo csv /nh`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      return out.includes(`"node.exe"`);
    } else {
      process.kill(pid, 0);
      return true;
    }
  } catch {
    return false;
  }
}

function savePid(pid) {
  writeFileSync(PID_FILE, String(pid), 'utf-8');
}

function removePid() {
  try { unlinkSync(PID_FILE); } catch {}
}

// =============================================================================
// macOS (launchd)
// =============================================================================

function macosPlistLabel() {
  return 'com.wechat-claude-code.bridge';
}

function macosPlistPath() {
  return join(homedir(), 'Library', 'LaunchAgents', `${macosPlistLabel()}.plist`);
}

function macosIsLoaded() {
  try {
    execSync(`launchctl print "gui/${process.getuid()}/${macosPlistLabel()}"`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function macosStart() {
  if (macosIsLoaded()) {
    console.log('Already running (or plist loaded)');
    return;
  }

  ensureLogDir();
  const nodeBin = getNodeBin();
  const envVars = getEnvVars();

  let plistExtraEnv = '';
  for (const [key, val] of Object.entries(envVars)) {
    plistExtraEnv += `    <key>${key}</key>\n    <string>${val}</string>\n`;
  }

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${macosPlistLabel()}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${join(PROJECT_DIR, 'dist', 'main.js')}</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${PROJECT_DIR}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${join(LOG_DIR, 'stdout.log')}</string>
  <key>StandardErrorPath</key>
  <string>${join(LOG_DIR, 'stderr.log')}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${join(homedir(), '.local/bin')}:${dirname(nodeBin)}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
${plistExtraEnv}  </dict>
</dict>
</plist>`;

  writeFileSync(macosPlistPath(), plist);
  execSync(`launchctl load "${macosPlistPath()}"`);
  console.log('Started wechat-claude-code daemon (macOS launchd)');
}

function macosStop() {
  try {
    execSync(`launchctl bootout "gui/${process.getuid()}/${macosPlistLabel()}"`, { stdio: 'pipe' });
  } catch {}
  try { unlinkSync(macosPlistPath()); } catch {}
  console.log('Stopped wechat-claude-code daemon (macOS launchd)');
}

function macosStatus() {
  if (macosIsLoaded()) {
    try {
      const out = execSync('pgrep -f "dist/main.js start"', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      const pid = out.trim().split('\n')[0];
      console.log(pid ? `Running (PID: ${pid})` : 'Loaded but not running');
    } catch {
      console.log('Loaded but not running');
    }
  } else {
    console.log('Not running');
  }
}

function macosLogs() {
  const logDir = LOG_DIR;
  if (!existsSync(logDir)) { console.log('No logs found'); return; }

  try {
    const files = readdirSync(logDir)
      .filter(f => f.startsWith('bridge-') && f.endsWith('.log'))
      .sort()
      .reverse();
    if (files.length > 0) {
      const content = readFileSync(join(logDir, files[0]), 'utf-8');
      const lines = content.split('\n');
      console.log(lines.slice(-100).join('\n'));
      return;
    }
  } catch {}

  for (const name of ['stdout.log', 'stderr.log']) {
    const p = join(logDir, name);
    if (existsSync(p)) {
      console.log(`=== ${name} ===`);
      const content = readFileSync(p, 'utf-8');
      const lines = content.split('\n');
      console.log(lines.slice(-30).join('\n'));
    }
  }
}

// =============================================================================
// Linux (systemd + nohup fallback)
// =============================================================================

function linuxServiceFile() {
  return join(homedir(), '.config', 'systemd', 'user', `${SERVICE_NAME}.service`);
}

function linuxSystemdAvailable() {
  try {
    execSync('systemctl --user list-units', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function linuxCreateServiceFile() {
  const nodeBin = getNodeBin();
  const envVars = getEnvVars();

  let extraEnv = '';
  for (const [key, val] of Object.entries(envVars)) {
    extraEnv += `Environment=${key}=${val}\n`;
  }

  const service = `[Unit]
Description=WeChat Claude Code Bridge
Documentation=https://github.com/Wechat-ggGitHub/wechat-claude-code
After=network.target

[Service]
Type=simple
ExecStart=${nodeBin} ${join(PROJECT_DIR, 'dist', 'main.js')} start
WorkingDirectory=${PROJECT_DIR}
Restart=always
RestartSec=10
Environment=PATH=${join(homedir(), '.local/bin')}:${dirname(nodeBin)}:/usr/local/bin:/usr/bin:/bin
${extraEnv}StandardOutput=append:${join(LOG_DIR, 'stdout.log')}
StandardError=append:${join(LOG_DIR, 'stderr.log')}
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target`;

  const servicePath = linuxServiceFile();
  mkdirSync(dirname(servicePath), { recursive: true });
  writeFileSync(servicePath, service);
}

function linuxStart() {
  if (linuxSystemdAvailable()) {
    try {
      if (execSync('systemctl --user is-active wechat-claude-code', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim() === 'active') {
        console.log('Already running');
        return;
      }
    } catch {}

    ensureLogDir();
    linuxCreateServiceFile();
    try { execSync('systemctl --user daemon-reload', { stdio: 'pipe' }); } catch {}
    execSync('systemctl --user start wechat-claude-code');
    try { execSync('systemctl --user enable wechat-claude-code', { stdio: 'pipe' }); } catch {}
    console.log('Started wechat-claude-code daemon (Linux systemd)');
  } else {
    console.log('Note: systemd user session not available, using direct mode');
    directStart();
  }
}

function linuxStop() {
  if (linuxSystemdAvailable()) {
    try {
      execSync('systemctl --user cat wechat-claude-code', { stdio: 'pipe' });
      execSync('systemctl --user stop wechat-claude-code', { stdio: 'pipe' });
      execSync('systemctl --user disable wechat-claude-code', { stdio: 'pipe' });
      console.log('Stopped wechat-claude-code daemon (Linux systemd)');
      return;
    } catch {}
  }
  directStop();
}

function linuxStatus() {
  if (linuxSystemdAvailable()) {
    try {
      execSync('systemctl --user cat wechat-claude-code', { stdio: 'pipe' });
      const active = execSync('systemctl --user is-active wechat-claude-code', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      if (active === 'active') {
        try {
          const pid = execSync('systemctl --user show-property --value=MainPID wechat-claude-code', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
          console.log(pid && pid !== '0' ? `Running (PID: ${pid})` : 'Active');
        } catch {
          console.log('Active');
        }
      } else {
        console.log('Not running');
      }
      return;
    } catch {}
  }
  directStatus();
}

function linuxLogs() {
  if (linuxSystemdAvailable()) {
    try {
      execSync('systemctl --user cat wechat-claude-code', { stdio: 'pipe' });
      console.log('=== systemd journal logs (last 100 lines) ===');
      execSync('journalctl --user --unit=wechat-claude-code --no-pager -n 100', { stdio: 'inherit' });
      console.log('');
    } catch {}
  }

  console.log('=== File logs ===');
  for (const name of ['stdout.log', 'stderr.log']) {
    const p = join(LOG_DIR, name);
    if (existsSync(p)) {
      console.log(`=== ${name} ===`);
      const content = readFileSync(p, 'utf-8');
      const lines = content.split('\n');
      console.log(lines.slice(-50).join('\n'));
    }
  }
}

// =============================================================================
// Direct mode (nohup / Windows) — used as fallback on Linux and primary on Windows
// =============================================================================

function directStart() {
  const oldPid = readPid();
  if (oldPid && isProcessRunning(oldPid)) {
    console.log(`Already running (PID: ${oldPid})`);
    return;
  }
  removePid();

  ensureLogDir();

  const nodeBin = getNodeBin();
  const mainJs = join(PROJECT_DIR, 'dist', 'main.js');

  console.log(`Starting ${SERVICE_NAME} daemon (direct mode)...`);

  const out = openSync(join(LOG_DIR, 'stdout.log'), 'a');
  const err = openSync(join(LOG_DIR, 'stderr.log'), 'a');

  const child = spawn(nodeBin, [mainJs, 'start'], {
    cwd: PROJECT_DIR,
    stdio: ['ignore', out, err],
    detached: true,
    env: { ...process.env, ...getEnvVars() },
  });

  child.unref();
  savePid(child.pid);
  console.log(`Started (PID: ${child.pid})`);
  console.log(`Logs: ${join(LOG_DIR, 'stdout.log')}`);
}

function directStop() {
  const pid = readPid();
  if (!pid) {
    console.log('Not running (no PID file)');
    return;
  }

  if (!isProcessRunning(pid)) {
    removePid();
    console.log('Process not running (cleaned up PID file)');
    return;
  }

  console.log(`Stopping PID ${pid}...`);
  try {
    if (platform === 'win32') {
      execSync(`taskkill /PID ${pid} /F`, { stdio: 'pipe' });
    } else {
      process.kill(pid, 'SIGTERM');
      // Wait up to 10s for graceful shutdown
      for (let i = 0; i < 10; i++) {
        if (!isProcessRunning(pid)) break;
        execSync('sleep 1');
      }
      if (isProcessRunning(pid)) {
        process.kill(pid, 'SIGKILL');
      }
    }
  } catch {}
  removePid();
  console.log(`Stopped (PID: ${pid})`);
}

function directStatus() {
  const pid = readPid();
  if (!pid) {
    console.log('Not running');
    return;
  }
  if (isProcessRunning(pid)) {
    console.log(`Running (PID: ${pid})`);
  } else {
    console.log('Not running (stale PID file)');
    removePid();
  }
}

function directLogs() {
  for (const name of ['stdout.log', 'stderr.log']) {
    const p = join(LOG_DIR, name);
    if (existsSync(p)) {
      console.log(`=== ${name} ===`);
      const content = readFileSync(p, 'utf-8');
      const lines = content.split('\n');
      console.log(lines.slice(-100).join('\n'));
    }
  }
  if (!existsSync(join(LOG_DIR, 'stdout.log')) && !existsSync(join(LOG_DIR, 'stderr.log'))) {
    console.log('No logs found');
  }
}

// =============================================================================
// Windows
// =============================================================================

function windowsStart() { directStart(); }
function windowsStop() { directStop(); }
function windowsStatus() { directStatus(); }
function windowsLogs() { directLogs(); }

// =============================================================================
// Main dispatcher
// =============================================================================

function main() {
  const command = process.argv[2];

  if (!command) {
    console.log('Usage: daemon.js {start|stop|restart|status|logs|setup}');
    console.log(`Platform: ${platform}`);
    process.exit(1);
  }

  if (command === 'setup') {
    // Delegate to main.js setup
    const result = spawnSync(getNodeBin(), [join(PROJECT_DIR, 'dist', 'main.js'), 'setup'], {
      cwd: PROJECT_DIR,
      stdio: 'inherit',
    });
    process.exit(result.status ?? 1);
  }

  switch (platform) {
    case 'darwin':
      switch (command) {
        case 'start': macosStart(); break;
        case 'stop': macosStop(); break;
        case 'restart': macosStop(); setTimeout(() => macosStart(), 1000); break;
        case 'status': macosStatus(); break;
        case 'logs': macosLogs(); break;
        default: console.log('Usage: daemon.js {start|stop|restart|status|logs}'); process.exit(1);
      }
      break;
    case 'linux':
      switch (command) {
        case 'start': linuxStart(); break;
        case 'stop': linuxStop(); break;
        case 'restart': linuxStop(); setTimeout(() => linuxStart(), 1000); break;
        case 'status': linuxStatus(); break;
        case 'logs': linuxLogs(); break;
        default: console.log('Usage: daemon.js {start|stop|restart|status|logs}'); process.exit(1);
      }
      break;
    case 'win32':
      switch (command) {
        case 'start': windowsStart(); break;
        case 'stop': windowsStop(); break;
        case 'restart': windowsStop(); setTimeout(() => windowsStart(), 1000); break;
        case 'status': windowsStatus(); break;
        case 'logs': windowsLogs(); break;
        default: console.log('Usage: daemon.js {start|stop|restart|status|logs}'); process.exit(1);
      }
      break;
    default:
      console.log(`Error: Unsupported platform '${platform}'`);
      console.log('Supported platforms: macOS (darwin), Linux, Windows (win32)');
      process.exit(1);
  }
}

main();
