import assert from 'node:assert/strict';
import test from 'node:test';
import { chatErrorMessage, historyErrorMessage } from './messages.ts';

const zh = value => value;
const en = (_, value) => value;
test('history save rejection describes cloud storage rather than connectivity or user prompt syntax', () => {
  for (const text of [zh, en]) {
    const answer = chatErrorMessage('HISTORY_SAVE_FAILED', text);
    assert.notEqual(answer, chatErrorMessage('NETWORK_ERROR', text));
    assert.match(answer, /聊天记录同步失败|history sync failed/);
    assert.match(answer, /同步|sync/);
    const validation = historyErrorMessage('VALIDATION_ERROR', text);
    assert.match(validation, /聊天记录未通过云端校验|Chat history failed server validation/);
    assert.match(validation, /先复制未同步内容|Copy unsynced content before/);
    assert.doesNotMatch(validation, /重新登录|sign in/i);
  }
});
test('history conflict, capacity, pending and unknown errors have distinct bilingual recovery guidance', () => {
  for (const text of [zh, en]) {
    for (const code of ['AI_HISTORY_CONFLICT', 'AI_HISTORY_REQUEST_REUSED']) {
      const message = historyErrorMessage(code, text);
      assert.match(message, /冲突|conflicts/);
      assert.match(message, /重载云端|Reload cloud/);
      assert.doesNotMatch(message, /重新登录|sign in/i);
    }
    assert.match(historyErrorMessage('AI_HISTORY_LIMIT', text), /数量已达上限|conversation limit/);
    assert.match(historyErrorMessage('AI_HISTORY_TOO_LARGE', text), /大小限制|size limit/);
    assert.match(historyErrorMessage('HISTORY_SAVE_PENDING', text), /原请求|original request/);
    assert.match(historyErrorMessage('REQUEST_FAILED', text), /尚未确认|not confirmed/);
    assert.match(historyErrorMessage('UNRECOGNIZED', text), /当前内容|current content/);
  }
});
