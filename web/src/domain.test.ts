import assert from 'node:assert/strict'
import test from 'node:test'
import { groups, initialEntities, pages } from './catalog'
import { applyAction, createInitialState, getActions, statusLabel, type Command, type DemoState } from './domain'

const entity = (state: DemoState, id: string) => {
  const result = state.entities.find((item) => item.id === id)
  assert.ok(result, `Missing fixture ${id}`)
  return result
}
const act = (state: DemoState, entityId: string, actionId: string, overrides: Partial<Command> = {}) => applyAction(state, { entityId, actionId, reason: '演示核对 / Demo verification', operator: 'Mandow', outcome: 'success', ...overrides })

test('the complete bilingual catalog has two fictional records per page and valid references', () => {
  assert.equal(groups.length, 8)
  assert.equal(pages.length, 39)
  assert.equal(initialEntities.length, 81)
  assert.equal(new Set(initialEntities.map((item) => item.id)).size, initialEntities.length)
  for (const page of pages) {
    assert.ok(groups.some((group) => group.id === page.groupId))
    assert.ok(page.title.zh && page.title.en && page.description.zh && page.description.en)
    assert.ok(initialEntities.filter((item) => item.pageId === page.id).length >= 2, page.id)
  }
  for (const item of initialEntities) {
    assert.ok(item.name.zh && item.name.en && item.summary.zh && item.summary.en)
    assert.equal(item.fields[0]?.value.en, 'Fictional demo data')
    for (const related of item.related ?? []) assert.ok(initialEntities.some((candidate) => candidate.id === related.id && candidate.pageId === related.pageId))
    assert.notEqual(statusLabel(item.status).zh, item.status)
  }
})

test('session revocation affects only the selected session and is audited', () => {
  const initial = createInitialState()
  const result = act(initial, 'session-101', 'session.revoke')
  assert.ok(result.ok)
  assert.equal(entity(result.state, 'session-101').status, 'revoked')
  assert.deepEqual(entity(result.state, 'session-102'), entity(initial, 'session-102'))
  assert.deepEqual(entity(result.state, 'user-101'), entity(initial, 'user-101'))
  assert.equal(entity(initial, 'session-101').status, 'active')
  assert.equal(result.state.logs[0]?.operator, 'Mandow')
  assert.equal(result.state.logs[0]?.outcome, 'success')
  assert.ok(result.state.logs[0]?.time)
  assert.equal(act(result.state, 'session-101', 'session.revoke').ok, false)
})

test('resolving an AI issue preserves the original failed response', () => {
  const result = act(createInitialState(), 'call-301', 'ai.resolve')
  assert.ok(result.ok)
  assert.equal(entity(result.state, 'call-301').status, 'resolved')
  assert.equal(entity(result.state, 'call-301').workflow?.response, 'failed')
  assert.equal(entity(result.state, 'call-301').fields.find((field) => field.label.en === 'Original response')?.value.en, 'Failed: stream interrupted')
  assert.equal(getActions(entity(result.state, 'call-301')).length, 0)
})

test('video queries preserve the original task through failure, unknown, and success', () => {
  const initial = createInitialState()
  const before = structuredClone(entity(initial, 'video-401'))
  const failed = act(initial, 'video-401', 'video.query', { outcome: 'failure' })
  assert.equal(failed.ok, false)
  assert.deepEqual(entity(failed.state, 'video-401'), before)
  const unknown = act(failed.state, 'video-401', 'video.query', { outcome: 'unknown' })
  assert.equal(entity(unknown.state, 'video-401').status, 'unknown')
  const completed = act(unknown.state, 'video-401', 'video.query')
  assert.equal(entity(completed.state, 'video-401').status, 'completed')
  assert.equal(entity(completed.state, 'video-401').workflow?.providerTaskId, before.workflow?.providerTaskId)
  assert.equal(entity(completed.state, 'video-401').workflow?.requestId, before.workflow?.requestId)
  assert.equal(completed.state.entities.length, initial.entities.length)
  assert.deepEqual(completed.state.logs.map((log) => log.outcome), ['success', 'unknown', 'failure'])
  assert.equal(getActions(entity(completed.state, 'video-401')).length, 0)
})

test('a confirmed failed video task differs from a failed lookup and cannot resubmit', () => {
  const result = act(createInitialState(), 'video-401', 'video.query-failed')
  assert.ok(result.ok)
  assert.equal(entity(result.state, 'video-401').status, 'failed')
  assert.equal(entity(result.state, 'video-401').workflow?.lookup, 'confirmed')
  assert.equal(entity(result.state, 'video-401').workflow?.providerResult, 'failed')
  assert.equal(result.state.logs[0]?.outcome, 'success')
  assert.equal(getActions(entity(result.state, 'video-401')).some((action) => action.id.startsWith('video.')), false)
})

test('public unlisting and relisting never change personal connections or service identity', () => {
  const initial = createInitialState()
  const unlisted = act(initial, 'directory-501', 'directory.unlist')
  assert.equal(entity(unlisted.state, 'directory-501').status, 'unlisted')
  for (const id of ['service-501', 'connection-501', 'connection-502']) assert.deepEqual(entity(unlisted.state, id), entity(initial, id))
  const relisted = act(unlisted.state, 'directory-501', 'directory.relist')
  assert.equal(entity(relisted.state, 'directory-501').status, 'listed')
  assert.equal(act(initial, 'directory-502', 'directory.relist').ok, false, 'noindex blocks public relisting')
})

test('moderation requires restrict, appeal, then review and restoration', () => {
  const initial = createInitialState()
  assert.equal(act(initial, 'report-601', 'moderation.restore').ok, false)
  const restricted = act(initial, 'report-601', 'moderation.restrict')
  assert.equal(entity(restricted.state, 'post-601').status, 'restricted')
  assert.equal(act(restricted.state, 'report-601', 'moderation.restore').ok, false)
  const appealed = act(restricted.state, 'report-601', 'moderation.appeal')
  assert.equal(entity(appealed.state, 'post-601').status, 'restricted')
  assert.equal(entity(appealed.state, 'report-601').status, 'appealed')
  const restored = act(appealed.state, 'report-601', 'moderation.restore', { operator: 'hera' })
  assert.equal(entity(restored.state, 'post-601').status, 'published')
  assert.equal(entity(restored.state, 'report-601').status, 'restored')
  assert.equal(restored.state.logs.length, 3)
  assert.equal(restored.state.logs[0]?.operator, 'hera')
  assert.deepEqual(entity(restored.state, 'post-602'), entity(initial, 'post-602'))
})

test('refund request, channel confirmation, entitlement, and reconciliation are separate', () => {
  const initial = createInitialState()
  assert.equal(act(initial, 'refund-701', 'refund.query').ok, false)
  assert.equal(act(initial, 'refund-701', 'refund.reconcile').ok, false)
  const requested = act(initial, 'refund-701', 'refund.request', { outcome: 'unknown' })
  let workflow = entity(requested.state, 'refund-701').workflow
  assert.equal(workflow?.request, 'registered')
  assert.equal(workflow?.channel, 'unknown')
  assert.equal(workflow?.entitlement, 'active')
  assert.equal(workflow?.reconciliation, 'pending')
  assert.equal(entity(requested.state, 'refund-701').fields.find((field) => field.label.en === 'Channel state')?.value.en, 'Result unknown')
  assert.equal(act(requested.state, 'refund-701', 'refund.request').ok, false)
  assert.equal(act(requested.state, 'refund-701', 'refund.reconcile').ok, false)
  const failedQuery = act(requested.state, 'refund-701', 'refund.query', { outcome: 'failure' })
  assert.deepEqual(entity(failedQuery.state, 'refund-701'), entity(requested.state, 'refund-701'))
  const confirmed = act(failedQuery.state, 'refund-701', 'refund.query')
  workflow = entity(confirmed.state, 'refund-701').workflow
  assert.equal(workflow?.channel, 'confirmed')
  assert.equal(workflow?.entitlement, 'active')
  assert.equal(workflow?.reconciliation, 'pending')
  const reconciled = act(confirmed.state, 'refund-701', 'refund.reconcile')
  workflow = entity(reconciled.state, 'refund-701').workflow
  assert.equal(workflow?.entitlement, 'revoked')
  assert.equal(workflow?.reconciliation, 'matched')
  assert.equal(workflow?.refundReference, 'demo-refund-701')
  assert.equal(entity(reconciled.state, 'refund-701').status, 'reconciled')
  assert.equal(entity(reconciled.state, 'order-701').workflow?.entitlement, 'revoked')
  assert.equal(entity(reconciled.state, 'order-701').status, 'completed', 'order history is not rewritten')
  for (const id of ['ledger-701', 'ledger-702']) assert.deepEqual(entity(reconciled.state, id), entity(initial, id))
  assert.equal(getActions(entity(reconciled.state, 'refund-701')).length, 0)
})

test('successful refund registration does not confirm the channel', () => {
  const result = act(createInitialState(), 'refund-701', 'refund.request')
  assert.equal(entity(result.state, 'refund-701').status, 'channel_pending')
  assert.equal(entity(result.state, 'refund-701').workflow?.channel, 'pending')
  const unknown = act(result.state, 'refund-701', 'refund.query', { outcome: 'unknown' })
  assert.equal(entity(unknown.state, 'refund-701').workflow?.channel, 'unknown')
  assert.equal(entity(unknown.state, 'refund-701').workflow?.refundReference, 'demo-refund-701')
})

test('configuration drafts show a diff; publishing and rollback change configuration only', () => {
  const initial = createInitialState()
  assert.equal(act(initial, 'config-801', 'config.publish').ok, false)
  assert.equal(act(initial, 'config-801', 'config.rollback').ok, false)
  const drafted = act(initial, 'config-801', 'config.draft', { value: '30 seconds' })
  assert.equal(entity(drafted.state, 'config-801').workflow?.current, '15 seconds')
  assert.equal(entity(drafted.state, 'config-801').workflow?.draft, '30 seconds')
  const published = act(drafted.state, 'config-801', 'config.publish')
  assert.equal(entity(published.state, 'config-801').workflow?.current, '30 seconds')
  assert.equal(entity(published.state, 'config-801').workflow?.previous, '15 seconds')
  assert.equal(entity(published.state, 'config-801').workflow?.draft, undefined)
  const rolledBack = act(published.state, 'config-801', 'config.rollback')
  assert.equal(entity(rolledBack.state, 'config-801').workflow?.current, '15 seconds')
  assert.equal(entity(rolledBack.state, 'config-801').status, 'rolled_back')
  assert.deepEqual(rolledBack.state.entities.filter((item) => item.id !== 'config-801'), initial.entities.filter((item) => item.id !== 'config-801'))
  assert.equal(rolledBack.state.logs.length, 3)
  assert.equal(act(rolledBack.state, 'config-801', 'config.rollback').ok, false)
})

test('failed mutations audit the attempt without changing business data', () => {
  const initial = createInitialState()
  for (const [id, actionId] of [['session-101', 'session.revoke'], ['call-301', 'ai.resolve'], ['directory-501', 'directory.unlist'], ['report-601', 'moderation.restrict'], ['refund-701', 'refund.request'], ['config-801', 'config.draft']]) {
    assert.ok(id && actionId)
    const result = act(initial, id, actionId, { outcome: 'failure', value: '30 seconds' })
    assert.equal(result.ok, false)
    assert.deepEqual(result.state.entities, initial.entities)
    assert.equal(result.state.logs[0]?.outcome, 'failure')
    assert.equal(result.state.logs[0]?.reason, '演示核对 / Demo verification')
  }
})

test('invalid transitions, missing reason, absent target, and invalid draft are rejected', () => {
  const initial = createInitialState()
  const invalid = [
    act(initial, 'session-101', 'session.revoke', { reason: '  ' }),
    act(initial, 'session-102', 'session.revoke'),
    act(initial, 'missing', 'session.revoke'),
    act(initial, 'session-101', 'unrecognized-action'),
    act(initial, 'config-801', 'config.draft', { value: ' ' }),
    act(initial, 'config-801', 'config.draft', { value: '15 seconds' }),
    act(initial, 'config-801', 'config.draft', { value: 'x'.repeat(121) }),
    act(initial, 'session-101', 'session.revoke', { reason: 'x'.repeat(501) }),
    act(initial, 'config-801', 'config.draft', { value: '30 seconds', outcome: 'unknown' }),
  ]
  for (const result of invalid) { assert.equal(result.ok, false); assert.strictEqual(result.state, initial) }
  const missingContent = createInitialState()
  missingContent.entities = missingContent.entities.filter((item) => item.id !== 'post-601')
  assert.equal(act(missingContent, 'report-601', 'moderation.restrict').ok, false)
  const missingOrder = act(createInitialState(), 'refund-702', 'refund.query').state
  missingOrder.entities = missingOrder.entities.filter((item) => item.id !== 'order-702')
  assert.equal(act(missingOrder, 'refund-702', 'refund.reconcile').ok, false)
})

test('state, action definitions, nested records, and reset have no shared mutable references', () => {
  const initial = createInitialState()
  const independent = createInitialState()
  const target = entity(initial, 'session-101')
  target.name.zh = 'changed'
  target.fields[0]!.value.zh = 'changed'
  assert.notEqual(entity(independent, 'session-101').name.zh, 'changed')
  assert.notEqual(entity(independent, 'session-101').fields[0]?.value.zh, 'changed')
  const available = getActions(target)
  available[0]!.label.zh = 'changed'
  assert.notEqual(getActions(target)[0]?.label.zh, 'changed')
  const changed = act(independent, 'session-101', 'session.revoke').state
  entity(changed, 'session-102').name.en = 'mutated result'
  assert.notEqual(entity(independent, 'session-102').name.en, 'mutated result')
  assert.deepEqual(createInitialState(), { entities: initialEntities, logs: [] })
  assert.equal(createInitialState().logs.length, 0)
})
