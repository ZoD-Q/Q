import type { DemoState } from './domain';

const priority = ['video-tasks', 'ai-calls', 'moderation', 'refunds', 'plugin-services', 'reconciliation'];
const needsAttention = new Set(['unknown', 'failed', 'investigating', 'review', 'appealed', 'discrepancy', 'degraded', 'attention', 'channel_pending', 'channel_confirmed']);

/** Use canonical business records; overview fixtures and audit history are not open incidents. */
export function selectIssues(state: DemoState) {
  return state.entities.filter((entity) => priority.includes(entity.pageId) && needsAttention.has(entity.status) && entity.workflow?.issue !== 'resolved')
    .sort((a, b) => priority.indexOf(a.pageId) - priority.indexOf(b.pageId));
}
