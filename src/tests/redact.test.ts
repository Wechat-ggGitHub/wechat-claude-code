import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../logger.js';

describe('redact — log sanitization', () => {
  it('masks Bearer tokens', () => {
    const input = 'Authorization: Bearer sk-abc123-secret-token';
    const result = redact(input);
    assert.ok(!result.includes('sk-abc123'), 'token should be masked');
    assert.ok(result.includes('Bearer ***'));
  });

  it('masks token fields in JSON', () => {
    const obj = { bot_token: 'secret-value-123', name: 'bot' };
    const result = redact(obj);
    assert.ok(!result.includes('secret-value-123'), 'token value should be masked');
    assert.ok(result.includes('"bot"'), 'non-sensitive values should remain');
  });

  it('masks password fields', () => {
    const obj = { password: 'hunter2' };
    const result = redact(obj);
    assert.ok(!result.includes('hunter2'));
  });

  it('masks api_key fields', () => {
    const obj = { api_key: 'key-12345' };
    const result = redact(obj);
    assert.ok(!result.includes('key-12345'));
  });

  it('masks secret fields', () => {
    const obj = { secret: 'very-secret' };
    const result = redact(obj);
    assert.ok(!result.includes('very-secret'));
  });

  it('preserves non-sensitive data', () => {
    const obj = { status: 'ok', count: 42 };
    const result = redact(obj);
    assert.ok(result.includes('"ok"'));
    assert.ok(result.includes('42'));
  });

  it('handles string input', () => {
    const result = redact('Bearer my-token-here in header');
    assert.ok(!result.includes('my-token-here'));
    assert.ok(result.includes('Bearer ***'));
  });

  it('handles null/undefined gracefully', () => {
    assert.strictEqual(redact(null), 'null');
    assert.strictEqual(redact(undefined), undefined);
  });
});
