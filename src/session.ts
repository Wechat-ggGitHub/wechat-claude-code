import { loadJson, saveJson } from './store.js';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { homedir } from 'node:os';

const DATA_DIR = process.env.WCC_DATA_DIR || join(homedir(), '.wechat-claude-code');
const SESSIONS_DIR = join(DATA_DIR, 'sessions');

export type SessionState = 'idle' | 'processing' | 'waiting_permission';

export interface Session {
  sdkSessionId?: string;
  workingDirectory: string;
  model?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'plan';
  state: SessionState;
}

export interface PendingPermission {
  toolName: string;
  toolInput: string;
  resolve: (allowed: boolean) => void;
  timer: NodeJS.Timeout;
}

export function createSessionStore() {
  function getSessionPath(accountId: string): string {
    return join(SESSIONS_DIR, `${accountId}.json`);
  }

  function load(accountId: string): Session {
    return loadJson<Session>(getSessionPath(accountId), {
      workingDirectory: process.cwd(),
      state: 'idle',
    });
  }

  function save(accountId: string, session: Session): void {
    mkdirSync(SESSIONS_DIR, { recursive: true });
    saveJson(getSessionPath(accountId), session);
  }

  function clear(accountId: string, currentSession?: Session): Session {
    const session: Session = {
      workingDirectory: currentSession?.workingDirectory ?? process.cwd(),
      model: currentSession?.model,
      permissionMode: currentSession?.permissionMode,
      state: 'idle',
    };
    save(accountId, session);
    return session;
  }

  return { load, save, clear };
}
