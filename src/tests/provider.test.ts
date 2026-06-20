import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleStreamLine, type StreamParserState } from '../claude/provider.js';

function freshState(): StreamParserState {
  return { sessionId: '', textParts: [], trackingSkill: false, skillInputAccum: '' };
}

test('handleStreamLine: system init 设置 sessionId', () => {
  const state = freshState();
  handleStreamLine(
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-123' }),
    state,
    {},
  );
  assert.equal(state.sessionId, 'sess-123');
});

test('handleStreamLine: text_delta 触发 onText', () => {
  const calls: string[] = [];
  handleStreamLine(
    JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } },
    }),
    freshState(),
    { onText: (t) => calls.push(t) },
  );
  assert.deepEqual(calls, ['hello']);
});

test('handleStreamLine: content_block_stop 重置 trackingSkill，无回调', () => {
  const state = freshState();
  state.trackingSkill = true;
  let textCalls = 0;
  handleStreamLine(
    JSON.stringify({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }),
    state,
    { onText: () => textCalls++ },
  );
  assert.equal(state.trackingSkill, false);
  assert.equal(textCalls, 0);
});

test('handleStreamLine: assistant 消息文本累积到 textParts', () => {
  const state = freshState();
  handleStreamLine(
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '回复内容' }] },
    }),
    state,
    {},
  );
  assert.deepEqual(state.textParts, ['回复内容']);
});

test('handleStreamLine: 空行和非法 JSON 静默跳过', () => {
  const state = freshState();
  handleStreamLine('', state, {});
  handleStreamLine('not json', state, {});
  handleStreamLine('   ', state, {});
  assert.deepEqual(state.textParts, []);
});

test('handleStreamLine: message_delta 带 stop_reason 触发 onTurnEnd', () => {
  const calls: string[] = [];
  handleStreamLine(
    JSON.stringify({
      type: 'stream_event',
      event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    }),
    freshState(),
    { onTurnEnd: (r) => calls.push(r) },
  );
  assert.deepEqual(calls, ['end_turn']);
});

test('handleStreamLine: message_delta 无 stop_reason 不触发 onTurnEnd', () => {
  const calls: string[] = [];
  handleStreamLine(
    JSON.stringify({
      type: 'stream_event',
      event: { type: 'message_delta', delta: {} },
    }),
    freshState(),
    { onTurnEnd: (r) => calls.push(r) },
  );
  assert.deepEqual(calls, []);
});

test('handleStreamLine: tool_use stop_reason 也正常透传', () => {
  const calls: string[] = [];
  handleStreamLine(
    JSON.stringify({
      type: 'stream_event',
      event: { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    }),
    freshState(),
    { onTurnEnd: (r) => calls.push(r) },
  );
  assert.deepEqual(calls, ['tool_use']);
});
