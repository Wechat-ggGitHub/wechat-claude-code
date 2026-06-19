import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { DEFAULT_WORKING_DIR } from "./constants.js";

export interface Config {
  workingDirectory: string;
  model?: string;
  systemPrompt?: string;
  /** 是否已向用户推送过首次欢迎/引导消息（全局只发一次） */
  welcomed?: boolean;
}

const CONFIG_DIR = join(homedir(), ".wechat-claude-code");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

const DEFAULT_CONFIG: Config = {
  workingDirectory: DEFAULT_WORKING_DIR,
};

export function loadConfig(): Config {
  try {
    const content = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(content);
    const config: Config = {
      workingDirectory: parsed.workingDirectory || DEFAULT_CONFIG.workingDirectory,
      model: parsed.model,
      systemPrompt: parsed.systemPrompt,
      welcomed: parsed.welcomed,
    };
    mkdirSync(config.workingDirectory, { recursive: true });
    return config;
  } catch {
    const config = { ...DEFAULT_CONFIG };
    mkdirSync(config.workingDirectory, { recursive: true });
    return config;
  }
}

export function saveConfig(config: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const data: Record<string, string | boolean> = {
    workingDirectory: config.workingDirectory,
  };
  if (config.model) data.model = config.model;
  if (config.systemPrompt) data.systemPrompt = config.systemPrompt;
  if (config.welcomed) data.welcomed = true;
  writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2) + "\n", "utf-8");
  if (process.platform !== "win32") {
    chmodSync(CONFIG_PATH, 0o600);
  }
}
