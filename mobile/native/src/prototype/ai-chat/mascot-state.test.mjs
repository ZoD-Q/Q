import assert from 'node:assert/strict';
import test from 'node:test';
import { getMascotPresentation } from './mascot-state.ts';

const answer = (status, extra = {}) => ({ id: 'answer', role: 'assistant', content: 'Received text', status, ...extra });
const present = (message, extra = {}) => getMascotPresentation({ phase: 'idle', message, ...extra });

test('one answer moves from waiting through thought and delivery to actual completion', () => {
  const pending = answer('pending', { content: '' });
  for (const [phase, state, title] of [
    ['waiting', 'thinking', '正在准备回答'],
    ['thinking', 'thinking', '思考中'],
    ['responding', 'streaming', '正在回答'],
  ]) {
    const result = present(pending, { phase });
    assert.equal(result.state, state);
    assert.equal(result.title.zh, title);
    assert.equal(result.busy, true);
  }
  const complete = present(answer('complete', { finishReason: 'stop' }));
  assert.equal(complete.state, 'complete');
  assert.equal(complete.title.zh, '回答完成');
  assert.equal(complete.busy, false);
});

test('an independent configuration check cannot replace an actively arriving answer', () => {
  for (const statusPhase of ['checking', 'unconfigured', 'error']) {
    const result = present(answer('streaming'), { phase: 'responding', statusPhase, statusError: 'NETWORK_ERROR', messageError: 'AI_BUSY' });
    assert.equal(result.state, 'streaming');
    assert.equal(result.busy, true);
  }
});

test('idle configuration is not presented as provider uptime or successful generation', () => {
  const result = getMascotPresentation({ phase: 'idle', statusPhase: 'ready', hasSession: true });
  assert.equal(result.state, 'ready');
  assert.equal(result.title.zh, '小Q在这里');
  assert.equal(result.busy, false);
  assert.doesNotMatch(JSON.stringify(result), /系统正常|运行正常|健康|healthy|operational|online/i);
});

test('explicit stop does not promise resuming the cancelled stream', () => {
  const result = present(answer('cancelled'));
  assert.equal(result.state, 'paused');
  assert.equal(result.title.zh, '已停止');
  assert.match(result.detail.zh, /重新生成/);
  assert.doesNotMatch(result.detail.en, /resume/i);
  assert.equal(result.busy, false);
});

test('recovered unfinished history is an interruption, not an intentional pause', () => {
  const restored = present(answer('cancelled', { errorCode: 'INTERRUPTED' }));
  assert.equal(restored.state, 'interrupted');
  assert.equal(restored.title.zh, '回答已中断');
  assert.equal(restored.busy, false);
  for (const status of ['pending', 'streaming']) {
    assert.equal(present(answer(status)).state, 'interrupted');
  }
});

test('transport, incomplete EOF, timeout and provider failures remain distinguishable', () => {
  const network = present(answer('error', { errorCode: 'NETWORK_ERROR' }));
  assert.equal(network.state, 'offline');
  assert.equal(network.title.zh, '连接异常');
  assert.doesNotMatch(JSON.stringify(network), /设备已离线|网络已断开|device is offline/i);
  assert.equal(present(answer('error', { errorCode: 'INCOMPLETE_RESPONSE' })).state, 'interrupted');
  for (const errorCode of ['AI_TIMEOUT', 'REQUEST_TIMEOUT']) {
    const timeout = present(answer('error', { errorCode }));
    assert.equal(timeout.state, 'interrupted');
    assert.equal(timeout.title.zh, '等待超时');
    assert.equal(timeout.busy, false);
  }
  assert.equal(present(answer('error', { errorCode: 'AI_UPSTREAM_ERROR' })).state, 'error');
});

test('tool message defers to the live card rather than asserting confirmation or business success', () => {
  const result = present(answer('tool', { content: '', finishReason: 'tool_calls', toolProposalId: 'proposal' }));
  assert.equal(result.state, 'paused');
  assert.equal(result.title.zh, '查看插件状态');
  assert.equal(result.busy, false);
  assert.match(result.detail.en, /plugin card/);
  assert.doesNotMatch(JSON.stringify(result), /awaiting confirmation|任务完成|succeeded/i);
});

test('length, filtering, missing content and user-message completion do not celebrate success', () => {
  for (const finishReason of ['length', 'content_filter', 'aborted', 'insufficient_system_resource']) {
    const result = present(answer('incomplete', { finishReason }));
    assert.equal(result.state, 'interrupted');
    assert.equal(result.busy, false);
  }
  assert.notEqual(present(answer('complete', { content: '  ' })).state, 'complete');
  assert.notEqual(present(answer('complete', { finishReason: 'length' })).state, 'complete');
  assert.equal(present({ id: 'user', role: 'user', status: 'complete', content: 'Question' }).state, 'ready');
});

test('new auth or sync work is not hidden behind a previous successful answer', () => {
  const previous = answer('complete');
  for (const busy of ['authBusy', 'historyBusy']) {
    const result = present(previous, { [busy]: true });
    assert.equal(result.state, 'thinking');
    assert.equal(result.busy, true);
  }
  assert.equal(present(previous, { authError: 'UNAUTHORIZED' }).title.zh, '请重新登录');
  assert.equal(present(previous, { messageError: 'HISTORY_SAVE_PENDING' }).title.zh, '历史尚未同步');
});

test('unsynced history blocks a prior outcome from saying it is ready for more messages', () => {
  for (const message of [answer('complete'), answer('error', { errorCode: 'AI_UPSTREAM_ERROR' }), undefined]) {
    const result = present(message, { historyError: 'private sync diagnostic' });
    assert.equal(result.state, 'error');
    assert.equal(result.title.zh, '历史尚未同步');
    assert.equal(result.detail.zh, '请先重试同步，再继续发送。');
    assert.equal(result.busy, false);
    assert.doesNotMatch(JSON.stringify(result), /private sync diagnostic/);
  }
  assert.equal(present(undefined, { historyError: '' }).state, 'ready');
  assert.equal(present(answer('complete'), { historyError: '' }).state, 'complete');
});

test('history errors do not replace current request progress or active recovery', () => {
  for (const [phase, state] of [['waiting', 'thinking'], ['thinking', 'thinking'], ['responding', 'streaming']]) {
    const result = present(answer('streaming'), { phase, historyError: 'HISTORY_SAVE_PENDING' });
    assert.equal(result.state, state);
    assert.equal(result.busy, true);
  }
  const recovering = present(answer('complete'), { historyError: 'HISTORY_SAVE_PENDING', historyBusy: true });
  assert.equal(recovering.title.zh, '正在同步对话');
  assert.equal(recovering.busy, true);
  assert.equal(present(answer('complete'), { historyError: 'HISTORY_SAVE_PENDING', authError: 'UNAUTHORIZED' }).title.zh, '请重新登录');
});

test('account clearing or switching conversations never inherits a previous outcome', () => {
  assert.equal(present(answer('error', { errorCode: 'AI_UPSTREAM_ERROR' })).state, 'error');
  const fresh = getMascotPresentation({ phase: 'idle', hasSession: false, statusPhase: 'ready' });
  assert.equal(fresh.state, 'ready');
  assert.match(fresh.detail.zh, /登录/);
  assert.equal(present(answer('complete')).state, 'complete');
  assert.equal(getMascotPresentation({ phase: 'idle', hasSession: true }).state, 'ready');
});

test('stale checking-send errors do not keep a ready session indefinitely busy', () => {
  const result = getMascotPresentation({ phase: 'idle', statusPhase: 'ready', messageError: 'AI_STATUS_CHECKING' });
  assert.equal(result.state, 'ready');
  assert.equal(result.busy, false);
});

test('checking, unconfigured and failed configuration are different observable states', () => {
  assert.equal(getMascotPresentation({ phase: 'idle', statusPhase: 'checking' }).busy, true);
  const unconfigured = getMascotPresentation({ phase: 'idle', statusPhase: 'unconfigured' });
  assert.equal(unconfigured.title.zh, '对话暂不可用');
  assert.equal(unconfigured.busy, false);
  const failed = getMascotPresentation({ phase: 'idle', statusPhase: 'error', statusError: 'UNAUTHORIZED' });
  assert.equal(failed.title.zh, '连接检查未完成');
  assert.doesNotMatch(failed.title.en, /sign in/i);
});

test('all output copy is localized and unrecognized error details are never exposed', () => {
  const secret = 'private upstream diagnostic';
  const message = Object.freeze(answer('error', { errorCode: secret }));
  const input = Object.freeze({ phase: 'idle', message });
  const result = getMascotPresentation(input);
  for (const field of ['title', 'detail']) for (const language of ['zh', 'en']) {
    assert.ok(result[field][language].trim());
  }
  assert.equal(result.state, 'error');
  assert.doesNotMatch(JSON.stringify(result), /private upstream/);
  assert.equal(message.errorCode, secret);
});
