import { loadJson, saveJson } from '../store.js';
import { join } from 'node:path';
import { DATA_DIR } from '../constants.js';
const SYNC_BUF_PATH = join(DATA_DIR, 'get_updates_buf');

export function loadSyncBuf(): string {
  return loadJson<string>(SYNC_BUF_PATH, '');
}

export function saveSyncBuf(buf: string): void {
  saveJson(SYNC_BUF_PATH, buf);
}
