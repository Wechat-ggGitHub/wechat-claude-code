import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export interface Config {
  workingDirectory: string;
  model?: string;
  permissionMode?: "default" | "acceptEdits" | "plan" | "auto";
  systemPrompt?: string;
}

const CONFIG_DIR = join(homedir(), ".wechat-claude-code");
const CONFIG_PATH = join(CONFIG_DIR, "config.env");

const DEFAULT_CONFIG: Config = {
  workingDirectory: process.cwd(),
};

function ensureConfigDir(): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
}

function parseConfigFile(content: string): Config {
  const config: Config = { ...DEFAULT_CONFIG };
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    switch (key) {
      case "workingDirectory":
        config.workingDirectory = value;
        break;
      case "model":
        config.model = value;
        break;
      case "permissionMode":
        if (
          value === "default" ||
          value === "acceptEdits" ||
          value === "plan" ||
          value === "auto"
        ) {
          config.permissionMode = value;
        }
        break;
      case "systemPrompt":
        config.systemPrompt = value;
        break;
    }
  }
  return config;
}

export function loadConfig(): Config {
  try {
    const content = readFileSync(CONFIG_PATH, "utf-8");
    return parseConfigFile(content);
  } catch {
    // File does not exist yet — return defaults
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: Config): void {
  ensureConfigDir();
  const lines: string[] = [];
  lines.push(`workingDirectory=${config.workingDirectory}`);
  if (config.model) {
    lines.push(`model=${config.model}`);
  }
  if (config.permissionMode) {
    lines.push(`permissionMode=${config.permissionMode}`);
  }
  if (config.systemPrompt) {
    lines.push(`systemPrompt=${config.systemPrompt}`);
  }
  writeFileSync(CONFIG_PATH, lines.join("\n") + "\n", "utf-8");
  if (process.platform !== 'win32') {
    chmodSync(CONFIG_PATH, 0o600);
  }
}
