#!/bin/bash
set -euo pipefail

# =============================================================================
# wechat-claude-code cross-platform daemon manager
# Supports: macOS (launchd) / Linux (systemd + nohup fallback)
# =============================================================================

DATA_DIR="${HOME}/.wechat-claude-code"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_NAME="wechat-claude-code"

# Platform detection
OS_TYPE="$(uname -s)"

# =============================================================================
# macOS (launchd) functions
# =============================================================================

macos_plist_label() {
  echo "com.wechat-claude-code.bridge"
}

macos_plist_path() {
  echo "${HOME}/Library/LaunchAgents/$(macos_plist_label).plist"
}

macos_is_loaded() {
  launchctl print "gui/$(id -u)/$(macos_plist_label)" &>/dev/null
}

macos_start() {
  local plist_label="$(macos_plist_label)"
  local plist_path="$(macos_plist_path)"
  local node_bin="$(command -v node || echo '/usr/local/bin/node')"

  if macos_is_loaded; then
    echo "Already running (or plist loaded)"
    exit 0
  fi

  mkdir -p "$DATA_DIR/logs"

  # Collect Anthropic/Claude env vars for plist
  local plist_extra_env=""
  for var in ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY ANTHROPIC_BASE_URL CLAUDE_API_KEY; do
    if [ -n "${!var:-}" ]; then
      plist_extra_env="${plist_extra_env}    <key>${var}</key>
    <string>${!var}</string>
"
    fi
  done

  cat > "$plist_path" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${plist_label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node_bin}</string>
    <string>${PROJECT_DIR}/dist/main.js</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${PROJECT_DIR}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${DATA_DIR}/logs/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${DATA_DIR}/logs/stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${HOME}/.local/bin:${node_bin%/*}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
${plist_extra_env}  </dict>
</dict>
</plist>
PLIST

  launchctl load "$plist_path"
  echo "Started wechat-claude-code daemon (macOS launchd)"
}

macos_stop() {
  local plist_label="$(macos_plist_label)"
  local plist_path="$(macos_plist_path)"

  launchctl bootout "gui/$(id -u)/${plist_label}" 2>/dev/null || true
  rm -f "$plist_path"
  echo "Stopped wechat-claude-code daemon (macOS launchd)"
}

macos_status() {
  if macos_is_loaded; then
    local pid=$(pgrep -f "dist/main.js start" 2>/dev/null | head -1)
    if [ -n "$pid" ]; then
      echo "Running (PID: $pid)"
    else
      echo "Loaded but not running"
    fi
  else
    echo "Not running"
  fi
}

macos_logs() {
  local log_dir="${DATA_DIR}/logs"
  if [ -d "$log_dir" ]; then
    local latest=$(ls -t "${log_dir}"/bridge-*.log 2>/dev/null | head -1)
    if [ -n "$latest" ]; then
      tail -100 "$latest"
    else
      echo "No bridge logs found. Checking stdout/stderr:"
      for f in "${log_dir}"/stdout.log "${log_dir}"/stderr.log; do
        if [ -f "$f" ]; then
          echo "=== $(basename "$f") ==="
          tail -30 "$f"
        fi
      done
    fi
  else
    echo "No logs found"
  fi
}

# =============================================================================
# Linux (systemd) functions
# =============================================================================

linux_ensure_user_session() {
  if [ -z "${XDG_RUNTIME_DIR:-}" ]; then
    export XDG_RUNTIME_DIR="/run/user/$(id -u)"
    mkdir -p "$XDG_RUNTIME_DIR" 2>/dev/null || true
  fi
  if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
    export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"
  fi
}

linux_service_file() {
  echo "${HOME}/.config/systemd/user/${SERVICE_NAME}.service"
}

linux_pid_file() {
  echo "${DATA_DIR}/${SERVICE_NAME}.pid"
}

linux_node_bin() {
  local node_bin="$(command -v node 2>/dev/null || echo '')"
  if [ -z "$node_bin" ]; then
    local nvm_default="${NVM_DIR:-${HOME}/.nvm}/versions/node"
    if [ -d "$nvm_default" ]; then
      node_bin="$(find "$nvm_default" -name "node" -type f 2>/dev/null | head -1)"
    fi
  fi
  echo "${node_bin:-/usr/bin/node}"
}

linux_systemd_available() {
  linux_ensure_user_session
  systemctl --user list-units &>/dev/null
}

linux_create_service_file() {
  local service_file="$(linux_service_file)"
  local node_bin="$(linux_node_bin)"

  mkdir -p "$(dirname "$service_file")"

  # Collect Anthropic/Claude env vars to pass through to the service
  local extra_env=""
  for var in ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY ANTHROPIC_BASE_URL CLAUDE_API_KEY; do
    if [ -n "${!var:-}" ]; then
      extra_env="${extra_env}Environment=${var}=${!var}
"
    fi
  done

  cat > "$service_file" <<SERVICE
[Unit]
Description=WeChat Claude Code Bridge
Documentation=https://github.com/Wechat-ggGitHub/wechat-claude-code
After=network.target

[Service]
Type=simple
ExecStart=${node_bin} ${PROJECT_DIR}/dist/main.js start
WorkingDirectory=${PROJECT_DIR}
Restart=always
RestartSec=10
Environment=PATH=${HOME}/.local/bin:${node_bin%/*}:/usr/local/bin:/usr/bin:/bin
${extra_env}StandardOutput=append:${DATA_DIR}/logs/stdout.log
StandardError=append:${DATA_DIR}/logs/stderr.log
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
SERVICE

  chmod 644 "$service_file"
}

linux_reload_daemon() {
  linux_ensure_user_session
  systemctl --user daemon-reload 2>/dev/null || true
}

linux_direct_start() {
  local pid_file="$(linux_pid_file)"
  local node_bin="$(linux_node_bin)"

  if [ -f "$pid_file" ]; then
    local old_pid=$(cat "$pid_file" 2>/dev/null)
    if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
      echo "Already running (PID: $old_pid)"
      exit 0
    fi
    rm -f "$pid_file"
  fi

  mkdir -p "$DATA_DIR/logs"

  echo "Starting wechat-claude-code daemon (direct mode)..."
  nohup "$node_bin" "${PROJECT_DIR}/dist/main.js" start \
    >> "$DATA_DIR/logs/stdout.log" \
    2>> "$DATA_DIR/logs/stderr.log" &
  local pid=$!
  echo "$pid" > "$pid_file"
  echo "Started (PID: $pid)"
  echo "Logs: $DATA_DIR/logs/stdout.log"
}

linux_direct_stop() {
  local pid_file="$(linux_pid_file)"

  if [ ! -f "$pid_file" ]; then
    echo "Not running (no PID file)"
    exit 0
  fi

  local pid=$(cat "$pid_file" 2>/dev/null)
  if [ -z "$pid" ]; then
    rm -f "$pid_file"
    echo "Stopped"
    exit 0
  fi

  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    local count=0
    while kill -0 "$pid" 2>/dev/null && [ $count -lt 10 ]; do
      sleep 1
      count=$((count + 1))
    done
    kill -9 "$pid" 2>/dev/null || true
    echo "Stopped (PID: $pid)"
  else
    echo "Process not running (cleaning up PID file)"
  fi

  rm -f "$pid_file"
}

linux_direct_status() {
  local pid_file="$(linux_pid_file)"

  if [ ! -f "$pid_file" ]; then
    echo "Not running"
    exit 0
  fi

  local pid=$(cat "$pid_file" 2>/dev/null)
  if [ -z "$pid" ]; then
    echo "Not running (invalid PID file)"
    exit 0
  fi

  if kill -0 "$pid" 2>/dev/null; then
    echo "Running (PID: $pid)"
  else
    echo "Not running (stale PID file)"
  fi
}

linux_start() {
  if linux_systemd_available; then
    local service_file="$(linux_service_file)"

    if systemctl --user is-active --quiet "${SERVICE_NAME}" 2>/dev/null; then
      echo "Already running"
      exit 0
    fi

    mkdir -p "$DATA_DIR/logs"
    linux_create_service_file
    linux_reload_daemon

    systemctl --user start "${SERVICE_NAME}"
    systemctl --user enable "${SERVICE_NAME}" 2>/dev/null || true
    echo "Started wechat-claude-code daemon (Linux systemd)"
  else
    echo "Note: systemd user session not available, using direct mode"
    echo "To enable systemd mode, run: 'loginctl enable-linger $(whoami)'"
    echo ""
    linux_direct_start
  fi
}

linux_stop() {
  if linux_systemd_available && systemctl --user cat "${SERVICE_NAME}" &>/dev/null; then
    systemctl --user stop "${SERVICE_NAME}" 2>/dev/null || true
    systemctl --user disable "${SERVICE_NAME}" 2>/dev/null || true
    echo "Stopped wechat-claude-code daemon (Linux systemd)"
  else
    linux_direct_stop
  fi
}

linux_restart() {
  linux_stop
  sleep 1
  linux_start
}

linux_status() {
  if linux_systemd_available && systemctl --user cat "${SERVICE_NAME}" &>/dev/null; then
    if systemctl --user is-active --quiet "${SERVICE_NAME}" 2>/dev/null; then
      local pid=$(systemctl --user show-property --value=MainPID "${SERVICE_NAME}" 2>/dev/null)
      if [ -n "$pid" ] && [ "$pid" != "0" ]; then
        echo "Running (PID: $pid)"
      else
        echo "Active"
      fi
    else
      echo "Not running"
    fi

    if systemctl --user cat "${SERVICE_NAME}" &>/dev/null; then
      echo ""
      systemctl --user status "${SERVICE_NAME}" --no-pager 2>/dev/null || true
    fi
  else
    linux_direct_status
  fi
}

linux_logs() {
  if command -v journalctl >/dev/null 2>&1; then
    if journalctl --user --unit="${SERVICE_NAME}" --quiet &>/dev/null; then
      echo "=== systemd journal logs (last 100 lines) ==="
      journalctl --user --unit="${SERVICE_NAME}" --no-pager -n 100 2>/dev/null || true
      echo ""
      echo "=== File logs ==="
    fi
  fi

  local log_dir="${DATA_DIR}/logs"
  if [ -d "$log_dir" ]; then
    for f in "${log_dir}"/stdout.log "${log_dir}"/stderr.log; do
      if [ -f "$f" ]; then
        echo "=== $(basename "$f") ==="
        tail -50 "$f"
        echo ""
      fi
    done
  else
    echo "No logs found"
  fi
}

# =============================================================================
# Windows (Git Bash / MINGW / MSYS) functions
# =============================================================================

win32_pid_file() {
  echo "${DATA_DIR}/${SERVICE_NAME}.pid"
}

win32_is_process_running() {
  local pid="$1"
  # Git Bash on Windows supports /proc/$PID
  [ -d "/proc/$pid" ] 2>/dev/null
}

win32_find_daemon_pids() {
  # Find all node processes running our daemon entry point
  ps -W 2>/dev/null | grep -i "node" | grep "dist/main.js" | awk '{print $1}' | head -20
  # Also try pgrep-style via /proc
  for p in /proc/[0-9]*/cmdline; do
    if [ -f "$p" ] && grep -ql "dist/main.js" "$p" 2>/dev/null; then
      basename "$(dirname "$p")"
    fi
  done 2>/dev/null
}

win32_start() {
  local pid_file="$(win32_pid_file)"
  local node_bin="$(command -v node 2>/dev/null || echo 'node')"

  # Check if already running via PID file
  if [ -f "$pid_file" ]; then
    local old_pid=$(cat "$pid_file" 2>/dev/null)
    if [ -n "$old_pid" ] && win32_is_process_running "$old_pid"; then
      echo "Already running (PID: $old_pid)"
      exit 0
    fi
    rm -f "$pid_file"
  fi

  mkdir -p "$DATA_DIR/logs"

  echo "Starting wechat-claude-code daemon (Windows)..."

  # Start daemon in background
  "$node_bin" "${PROJECT_DIR}/dist/main.js" start \
    >> "$DATA_DIR/logs/stdout.log" \
    2>> "$DATA_DIR/logs/stderr.log" &
  local pid=$!
  echo "$pid" > "$pid_file"

  # Give it a moment to start (or fail immediately)
  sleep 2

  if win32_is_process_running "$pid"; then
    echo "Started (PID: $pid)"
    echo "Logs: $DATA_DIR/logs/stdout.log"
  else
    echo "ERROR: Process exited immediately. Check logs:"
    tail -20 "$DATA_DIR/logs/stderr.log" 2>/dev/null
    rm -f "$pid_file"
    exit 1
  fi
}

win32_stop() {
  local pid_file="$(win32_pid_file)"

  if [ ! -f "$pid_file" ]; then
    echo "Not running (no PID file)"
    exit 0
  fi

  local pid=$(cat "$pid_file" 2>/dev/null)
  if [ -z "$pid" ]; then
    rm -f "$pid_file"
    echo "Stopped"
    exit 0
  fi

  if win32_is_process_running "$pid"; then
    kill "$pid" 2>/dev/null || taskkill //PID "$pid" //F 2>/dev/null || true
    local count=0
    while win32_is_process_running "$pid" && [ $count -lt 10 ]; do
      sleep 1
      count=$((count + 1))
    done
    # Force kill if still running
    if win32_is_process_running "$pid"; then
      taskkill //PID "$pid" //F 2>/dev/null || true
    fi
    echo "Stopped (PID: $pid)"
  else
    echo "Process not running (cleaning up PID file)"
  fi

  rm -f "$pid_file"
}

win32_status() {
  local pid_file="$(win32_pid_file)"

  if [ ! -f "$pid_file" ]; then
    echo "Not running"
    exit 0
  fi

  local pid=$(cat "$pid_file" 2>/dev/null)
  if [ -z "$pid" ]; then
    echo "Not running (invalid PID file)"
    exit 0
  fi

  if win32_is_process_running "$pid"; then
    echo "Running (PID: $pid)"
  else
    echo "Not running (stale PID file)"
  fi
}

win32_logs() {
  local log_dir="${DATA_DIR}/logs"
  if [ -d "$log_dir" ]; then
    local latest=$(ls -t "${log_dir}"/bridge-*.log 2>/dev/null | head -1)
    if [ -n "$latest" ]; then
      echo "=== Bridge log: $(basename "$latest") (last 100 lines) ==="
      tail -100 "$latest"
    fi
    for f in "${log_dir}"/stdout.log "${log_dir}"/stderr.log; do
      if [ -f "$f" ]; then
        echo ""
        echo "=== $(basename "$f") (last 30 lines) ==="
        tail -30 "$f"
      fi
    done
  else
    echo "No logs found"
  fi
}

# =============================================================================
# Main dispatcher
# =============================================================================

# Detect Windows: MINGW, MSYS, or CYGWIN
is_windows() {
  case "$OS_TYPE" in
    MINGW*|MSYS*|CYGWIN*) return 0 ;;
    *) return 1 ;;
  esac
}

main() {
  local command="${1:-}"

  if is_windows; then
    case "$command" in
      start)   win32_start ;;
      stop)    win32_stop ;;
      restart) win32_stop; sleep 1; win32_start ;;
      status)  win32_status ;;
      logs)    win32_logs ;;
      *)
        echo "Usage: daemon.sh {start|stop|restart|status|logs}"
        echo "Platform: Windows (Git Bash)"
        exit 1
        ;;
    esac
  else
    case "$OS_TYPE" in
      Darwin)
        case "$command" in
          start)   macos_start ;;
          stop)    macos_stop ;;
          restart) macos_stop; sleep 1; macos_start ;;
          status)  macos_status ;;
          logs)    macos_logs ;;
          *)
            echo "Usage: daemon.sh {start|stop|restart|status|logs}"
            echo "Platform: macOS (launchd)"
            exit 1
            ;;
        esac
        ;;
      Linux)
        case "$command" in
          start)   linux_start ;;
          stop)    linux_stop ;;
          restart) linux_restart ;;
          status)  linux_status ;;
          logs)    linux_logs ;;
          *)
            echo "Usage: daemon.sh {start|stop|restart|status|logs}"
            echo "Platform: Linux (systemd)"
            exit 1
            ;;
        esac
        ;;
      *)
        echo "Error: Unsupported platform '$OS_TYPE'"
        echo "Supported platforms: macOS (Darwin), Linux, Windows (Git Bash)"
        exit 1
        ;;
    esac
  fi
}

main "$@"
