import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, createInitialState } from './domain';
import { selectIssues } from './selectors';

test('the queue contains canonical issues including AI investigation and no snapshot duplicates', () => {
  const state = createInitialState();
  const issues = selectIssues(state);
  assert(issues.some((item) => item.id === 'call-301'));
  assert(issues.some((item) => item.id === 'video-401'));
  assert(issues.every((item) => !['dashboard', 'incidents', 'audit', 'activity'].includes(item.pageId)));
  const result = applyAction(state, { entityId: 'video-401', actionId: 'video.query', operator: 'Mandow', reason: 'Original task confirmed', outcome: 'success' });
  assert(result.ok);
  assert(!selectIssues(result.state).some((item) => item.id === 'video-401'));
});

test('resolving an operational issue removes it from the queue but preserves the business outcome', () => {
  const state = createInitialState();
  const issue = selectIssues(state).find((item) => item.pageId === 'reconciliation');
  assert(issue);
  const result = applyAction(state, { entityId: issue.id, actionId: 'issue.resolve', operator: 'hera', reason: 'Recorded a follow-up decision', outcome: 'success' });
  assert(result.ok);
  assert.equal(result.state.entities.find((item) => item.id === issue.id)?.status, issue.status);
  assert(!selectIssues(result.state).some((item) => item.id === issue.id));
});

test('account restriction revokes linked sessions, and restoration cannot revive tokens', () => {
  const initial = createInitialState();
  const restrict = applyAction(initial, { entityId: 'user-101', actionId: 'account.restrict', operator: 'Mandow', reason: 'Account access review', outcome: 'success' });
  assert(restrict.ok);
  assert.equal(restrict.state.entities.find((item) => item.id === 'user-101')?.status, 'access_restricted');
  assert.equal(restrict.state.entities.find((item) => item.id === 'session-101')?.status, 'revoked');
  const restore = applyAction(restrict.state, { entityId: 'user-101', actionId: 'account.restore', operator: 'Mandow', reason: 'Review completed', outcome: 'success' });
  assert(restore.ok);
  assert.equal(restore.state.entities.find((item) => item.id === 'user-101')?.status, 'active');
  assert.equal(restore.state.entities.find((item) => item.id === 'session-101')?.status, 'revoked');
  assert.deepEqual(restore.state.entities.filter((item) => item.pageId === 'demo-ledger'), initial.entities.filter((item) => item.pageId === 'demo-ledger'));
});

test('provider confirmation keeps refunds in the queue until entitlement reconciliation finishes', () => {
  let state = createInitialState();
  const command = { entityId: 'refund-701', operator: 'hera' as const, reason: 'Refund stage verification', outcome: 'success' as const };
  state = applyAction(state, { ...command, actionId: 'refund.request' }).state;
  state = applyAction(state, { ...command, actionId: 'refund.query' }).state;
  assert(selectIssues(state).some((item) => item.id === 'refund-701'));
  assert.equal(state.entities.find((item) => item.id === 'refund-701')?.workflow?.entitlement, 'active');
  state = applyAction(state, { ...command, actionId: 'refund.reconcile' }).state;
  assert(!selectIssues(state).some((item) => item.id === 'refund-701'));
});
