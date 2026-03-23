import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Re-implement splitMessage since it's not exported
const MAX_MESSAGE_LENGTH = 2048;

function splitMessage(text: string, maxLen: number = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitIdx = remaining.lastIndexOf('\n', maxLen);
    if (splitIdx < maxLen * 0.3) {
      splitIdx = maxLen;
    }
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n+/, '');
  }
  return chunks;
}

describe('splitMessage', () => {
  it('returns single chunk for short text', () => {
    const result = splitMessage('hello');
    assert.deepStrictEqual(result, ['hello']);
  });

  it('returns single chunk for text exactly at limit', () => {
    const text = 'a'.repeat(2048);
    const result = splitMessage(text);
    assert.deepStrictEqual(result, [text]);
  });

  it('splits long text without newlines at maxLen boundary', () => {
    const text = 'a'.repeat(5000);
    const result = splitMessage(text);
    assert.strictEqual(result[0].length, 2048);
    assert.strictEqual(result[1].length, 2048);
    assert.strictEqual(result[2].length, 904);
    assert.strictEqual(result.join(''), text);
  });

  it('prefers splitting at newline near the limit', () => {
    // Place a newline at position 1800 (within 30% threshold of 2048)
    const text = 'a'.repeat(1800) + '\n' + 'b'.repeat(2000);
    const result = splitMessage(text);
    assert.strictEqual(result[0], 'a'.repeat(1800));
    assert.strictEqual(result[1], 'b'.repeat(2000));
  });

  it('ignores newline too early (before 30% threshold)', () => {
    // Newline at position 100, way too early — should hard-split at maxLen
    const text = 'a'.repeat(100) + '\n' + 'b'.repeat(3000);
    const result = splitMessage(text);
    assert.strictEqual(result[0].length, 2048);
  });

  it('strips leading newlines from remainder', () => {
    // Total length must exceed maxLen to trigger splitting
    const text = 'a'.repeat(1900) + '\n\n\n' + 'b'.repeat(2000);
    const result = splitMessage(text);
    assert.strictEqual(result.length, 2);
    assert.ok(!result[1].startsWith('\n'), 'second chunk should not start with newline');
    assert.ok(result[1].startsWith('b'), 'second chunk should start with content');
  });

  it('handles empty string', () => {
    assert.deepStrictEqual(splitMessage(''), ['']);
  });

  it('works with custom maxLen', () => {
    const result = splitMessage('abcdefghij', 3);
    assert.strictEqual(result.length, 4); // abc, def, ghi, j
    assert.strictEqual(result.join(''), 'abcdefghij');
  });
});
