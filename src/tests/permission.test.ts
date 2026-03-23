import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPermissionBroker } from '../permission.js';

describe('createPermissionBroker', () => {
  it('resolves true when allowed', async () => {
    const broker = createPermissionBroker();
    const promise = broker.createPending('acc1', 'shell', 'ls');
    broker.resolvePermission('acc1', true);
    assert.strictEqual(await promise, true);
  });

  it('resolves false when denied', async () => {
    const broker = createPermissionBroker();
    const promise = broker.createPending('acc1', 'shell', 'rm -rf');
    broker.resolvePermission('acc1', false);
    assert.strictEqual(await promise, false);
  });

  it('returns false when resolving non-existent pending', () => {
    const broker = createPermissionBroker();
    assert.strictEqual(broker.resolvePermission('no-such', true), false);
  });

  it('getPending returns the pending permission', () => {
    const broker = createPermissionBroker();
    broker.createPending('acc1', 'write_file', '/tmp/x');
    const perm = broker.getPending('acc1');
    assert.ok(perm);
    assert.strictEqual(perm.toolName, 'write_file');
    assert.strictEqual(perm.toolInput, '/tmp/x');
    // Clean up
    broker.resolvePermission('acc1', false);
  });

  it('clears old pending when creating new one (timer leak fix)', async () => {
    const broker = createPermissionBroker();
    const oldPromise = broker.createPending('acc1', 'tool_a', 'input_a');
    // Creating a second pending for the same account should resolve the old one as false
    const newPromise = broker.createPending('acc1', 'tool_b', 'input_b');

    // Old promise should have been auto-rejected
    assert.strictEqual(await oldPromise, false);

    // New pending should be for tool_b
    const perm = broker.getPending('acc1');
    assert.ok(perm);
    assert.strictEqual(perm.toolName, 'tool_b');

    // Clean up
    broker.resolvePermission('acc1', true);
    assert.strictEqual(await newPromise, true);
  });

  it('rejectPending rejects and cleans up', async () => {
    const broker = createPermissionBroker();
    const promise = broker.createPending('acc1', 'shell', 'ls');
    assert.strictEqual(broker.rejectPending('acc1'), true);
    assert.strictEqual(await promise, false);
    assert.strictEqual(broker.getPending('acc1'), undefined);
  });

  it('formatPendingMessage includes tool info', () => {
    const broker = createPermissionBroker();
    broker.createPending('acc1', 'execute_shell', 'cat /etc/hosts');
    const perm = broker.getPending('acc1')!;
    const msg = broker.formatPendingMessage(perm);
    assert.ok(msg.includes('execute_shell'));
    assert.ok(msg.includes('cat /etc/hosts'));
    assert.ok(msg.includes('y'));
    assert.ok(msg.includes('n'));
    // Clean up
    broker.resolvePermission('acc1', false);
  });
});
