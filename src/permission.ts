import { logger } from './logger.js';
import type { PendingPermission } from './session.js';

const PERMISSION_TIMEOUT = 60_000;

export type OnPermissionTimeout = () => void;

export function createPermissionBroker(onTimeout?: OnPermissionTimeout) {
  const pending = new Map<string, PendingPermission>();

  function createPending(accountId: string, toolName: string, toolInput: string): Promise<boolean> {
    // Clear any existing pending permission for this account to prevent timer leak
    const existing = pending.get(accountId);
    if (existing) {
      clearTimeout(existing.timer);
      pending.delete(accountId);
      existing.resolve(false);
      logger.warn('Replaced existing pending permission', { accountId, toolName: existing.toolName });
    }

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        logger.warn('Permission timeout, auto-denied', { accountId, toolName });
        pending.delete(accountId);
        resolve(false);
        onTimeout?.();
      }, PERMISSION_TIMEOUT);

      pending.set(accountId, { toolName, toolInput, resolve, timer });
    });
  }

  function resolvePermission(accountId: string, allowed: boolean): boolean {
    const perm = pending.get(accountId);
    if (!perm) return false;
    clearTimeout(perm.timer);
    pending.delete(accountId);
    perm.resolve(allowed);
    logger.info('Permission resolved', { accountId, toolName: perm.toolName, allowed });
    return true;
  }

  function getPending(accountId: string): PendingPermission | undefined {
    return pending.get(accountId);
  }

  function formatPendingMessage(perm: PendingPermission): string {
    return [
      '\u{1F527} \u6743\u9650\u8BF7\u6C42',
      '',
      `\u5DE5\u5177: ${perm.toolName}`,
      `\u8F93\u5165: ${perm.toolInput.slice(0, 500)}`,
      '',
      '\u56DE\u590D y \u5141\u8BB8\uFF0Cn \u62D2\u7EDD',
      '(60\u79D2\u672A\u56DE\u590D\u81EA\u52A8\u62D2\u7EDD)',
    ].join('\n');
  }

  function rejectPending(accountId: string): boolean {
    const perm = pending.get(accountId);
    if (!perm) return false;
    clearTimeout(perm.timer);
    pending.delete(accountId);
    perm.resolve(false);
    logger.info('Permission auto-rejected (session cleared)', { accountId, toolName: perm.toolName });
    return true;
  }

  return { createPending, resolvePermission, rejectPending, getPending, formatPendingMessage };
}
