import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiConsentGate, createAiPermission } from './consent.ts';

test('an unapproved send is held and cancelling never authorizes it', () => {
  const permission = createAiPermission();
  const gate = createAiConsentGate(permission);
  const sent = [];
  if (gate.request('session-a', 1, 'private draft')) sent.push('private draft');
  assert.deepEqual(sent, []);
  gate.cancel();
  assert.equal(gate.approve('session-a', 1), null);
  assert.equal(permission.allows('session-a'), false);
});

test('approval resumes only the held request for that session and generation', () => {
  const permission = createAiPermission();
  const gate = createAiConsentGate(permission);
  assert.equal(gate.request('session-a', 2, { text: 'hello' }), false);
  assert.deepEqual(gate.approve('session-a', 2), { text: 'hello' });
  assert.equal(gate.approve('session-a', 2), null);
  assert.equal(gate.request('session-a', 2, { text: 'follow-up' }), true);
  assert.equal(permission.allows('session-b'), false);
});

test('account changes and delayed confirmations cannot authorize an old request', () => {
  for (const [identity, generation] of [['session-b', 3], ['session-a', 4]]) {
    const permission = createAiPermission();
    const gate = createAiConsentGate(permission);
    gate.request('session-a', 3, 'old private text');
    assert.equal(gate.approve(identity, generation), null);
    assert.equal(permission.allows(identity), false);
    assert.equal(permission.allows('session-a'), false);
  }
});

test('revocation reaches subscribers even when another view throws', () => {
  const permission = createAiPermission();
  const gate = createAiConsentGate(permission);
  let stopped = 0;
  permission.subscribe(() => { throw new Error('view failed'); });
  const unsubscribe = permission.subscribe(() => {
    if (!permission.allows('session-a')) { stopped++; gate.cancel(); }
  });
  gate.request('session-a', 1, 'request');
  gate.approve('session-a', 1);
  permission.revoke();
  assert.equal(stopped, 1);
  assert.equal(gate.request('session-a', 1, 'new request'), false);
  permission.revoke();
  assert.equal(gate.approve('session-a', 1), null);
  unsubscribe();
});
