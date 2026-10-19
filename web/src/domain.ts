import { initialEntities } from './catalog'

export type Locale = 'zh' | 'en'
export type Text = { zh: string; en: string }
export type PageDefinition = { id: string; groupId: string; title: Text; description: Text; basis: 'existing' | 'branch' | 'planned' }
export type GroupDefinition = { id: string; title: Text; icon: string }
export type Entity = {
  id: string; pageId: string; name: Text; summary: Text; status: string; owner: string; updatedAt: string
  fields: { label: Text; value: Text }[]
  timeline: { label: Text; detail: Text; time: string }[]
  related?: { label: Text; pageId: string; id: string }[]
  workflow?: Record<string, string>
}
export type AuditEntry = {
  id: string; entityId: string; entityName: Text; action: Text; reason: string
  operator: 'Mandow' | 'hera'; outcome: 'success' | 'failure' | 'unknown'; time: string
}
export type DemoState = { entities: Entity[]; logs: AuditEntry[] }
export type ActionDefinition = { id: string; label: Text; description: Text; impact: Text; allowOutcome?: boolean; needsValue?: boolean; danger?: boolean }
export type Command = {
  entityId: string; actionId: string; reason: string; operator: 'Mandow' | 'hera'
  outcome: 'success' | 'failure' | 'unknown'; value?: string
}
export type ActionResult = { state: DemoState; ok: boolean; message: Text }

const t = (zh: string, en: string): Text => ({ zh, en })

const labels: Record<string, Text> = {
  access_restricted: t('访问受限', 'Access restricted'),
  active: t('正常', 'Active'), pending: t('待处理', 'Pending'), investigating: t('排查中', 'Investigating'),
  resolved: t('已处理', 'Resolved'), failed: t('失败', 'Failed'), unknown: t('结果待确认', 'Result unknown'),
  processing: t('处理中', 'Processing'), completed: t('已完成', 'Completed'), revoked: t('已撤销', 'Revoked'),
  expired: t('已过期', 'Expired'), listed: t('公开展示中', 'Listed'), unlisted: t('已撤下公开展示', 'Unlisted'),
  connected: t('已连接', 'Connected'), authorization_required: t('待用户授权', 'Authorization required'),
  review: t('待审核', 'Under review'), restricted: t('已限制展示', 'Visibility restricted'),
  appealed: t('申诉待复核', 'Appeal awaiting review'), restored: t('已恢复展示', 'Visibility restored'),
  published: t('已发布', 'Published'), draft: t('草稿', 'Draft'), rolled_back: t('配置已回滚', 'Configuration rolled back'),
  requested: t('退款请求已登记', 'Refund requested'), channel_pending: t('渠道处理中', 'Channel pending'),
  channel_confirmed: t('渠道已确认', 'Channel confirmed'), reconciled: t('已对账', 'Reconciled'),
  discrepancy: t('有差异', 'Discrepancy'), paused: t('已暂停', 'Paused'), degraded: t('服务降级', 'Degraded'),
  planned: t('规划', 'Planned'), delivered: t('已送达', 'Delivered'), blocked: t('被规则拦截', 'Blocked'),
  attention: t('需要关注', 'Needs attention'), awaiting_evidence: t('等待补充材料', 'Awaiting evidence'),
}

export function statusLabel(status: string): Text {
  return labels[status] ?? t(status, status)
}

const actions: Record<string, ActionDefinition> = {
  'account.restrict': { id: 'account.restrict', label: t('限制演示账号', 'Restrict demo account'), description: t('模拟限制账号访问并撤销关联的有效演示会话。', 'Simulate an access restriction and revoke linked active demo sessions.'), impact: t('不删除资料、内容、订单或账本；不改变第三方授权或业务结果。', 'Preserves profiles, content, orders, and ledger entries. Third-party authorization and business results do not change.'), danger: true },
  'account.restore': { id: 'account.restore', label: t('恢复演示账号', 'Restore demo account'), description: t('解除演示账号的访问限制。', 'Remove this demo account’s access restriction.'), impact: t('已撤销会话不会恢复；此操作不恢复其他独立受限内容或权益。', 'Revoked sessions stay revoked. Independently restricted content and entitlements are not restored.') },
  'issue.resolve': { id: 'issue.resolve', label: t('记录处理结论', 'Record resolution'), description: t('登记运营处理结论并移出待办。', 'Record the operational resolution and remove this item from the queue.'), impact: t('保留原业务结果、错误和时间线；不重新执行任务或修改账务。', 'Preserves business outcomes, errors, and history. Does not repeat a task or modify accounting.') },
  'session.revoke': { id: 'session.revoke', label: t('撤销会话', 'Revoke session'), description: t('使这个演示会话失效。', 'Invalidate this demo session.'), impact: t('仅影响选中会话，不停用账号，也不改变其他设备。', 'Only this session is affected; the account and other devices remain unchanged.'), danger: true },
  'ai.resolve': { id: 'ai.resolve', label: t('标记问题已处理', 'Resolve issue'), description: t('记录排查结论，关闭运营问题。', 'Record the investigation and close the operational issue.'), impact: t('不重新调用模型，不把失败响应改为成功。', 'Does not call the model again or turn a failed response into a success.') },
  'video.query': { id: 'video.query', label: t('查询原任务', 'Query original task'), description: t('使用原供应商任务编号模拟查询结果。', 'Simulate a lookup using the original provider task ID.'), impact: t('成功返回完成结果；失败保留原任务；未知保持待确认。不会创建新生成请求。', 'Success returns completion; a failed lookup preserves the task; unknown remains unresolved. No new generation request is created.'), allowOutcome: true },
  'video.query-failed': { id: 'video.query-failed', label: t('演示查到任务失败', 'Simulate confirmed task failure'), description: t('模拟原任务查询成功，但供应商明确返回生成失败。', 'Simulate a successful lookup that confirms the provider task failed.'), impact: t('只更新原任务结果，不重新提交，不自动扣费或退款。', 'Updates only the original task result. No resubmission, charge, or automatic refund.') },
  'directory.unlist': { id: 'directory.unlist', label: t('撤下公开展示', 'Unlist from directory'), description: t('将该服务从演示公共目录撤下。', 'Remove this service from the demo public directory.'), impact: t('个人连接及其授权不变；不是停用服务或禁止通过链接添加。', 'Personal connections and authorization stay unchanged. This does not disable the service or direct-link addition.'), danger: true },
  'directory.relist': { id: 'directory.relist', label: t('恢复公开展示', 'Restore directory listing'), description: t('在演示公开条件仍满足时恢复目录展示。', 'Restore the listing while its demo publication conditions remain valid.'), impact: t('只影响公共目录，不新增个人连接，也不替用户授权。', 'Only the public listing changes; no personal connections or authorization are created.') },
  'moderation.restrict': { id: 'moderation.restrict', label: t('限制内容展示', 'Restrict visibility'), description: t('记录举报处理依据并限制关联作品展示。', 'Record the moderation rationale and restrict the linked work.'), impact: t('仅改变关联内容的展示状态；保留申诉与审核记录。', 'Only the linked content visibility changes; appeals and review history are retained.'), danger: true },
  'moderation.appeal': { id: 'moderation.appeal', label: t('登记演示申诉', 'Register demo appeal'), description: t('为当前处置登记一条模拟申诉。', 'Record a simulated appeal against the current decision.'), impact: t('进入复核，不自动恢复作品，也不向作者发送消息。', 'Begins review; does not automatically restore the work or message the creator.') },
  'moderation.restore': { id: 'moderation.restore', label: t('复核并恢复', 'Review and restore'), description: t('记录复核结论并恢复关联作品展示。', 'Record the review conclusion and restore the linked work.'), impact: t('恢复展示并保留原处置记录；不删除举报。', 'Restores visibility while preserving the original decision and report.') },
  'refund.request': { id: 'refund.request', label: t('登记退款请求', 'Register refund request'), description: t('记录请求与原渠道引用，进入待查询状态。', 'Register the request and original channel reference for a later lookup.'), impact: t('演示操作不向渠道发送指令。请求登记不代表资金已退或权益已撤销。', 'No instruction is sent to a provider. Registration does not mean funds are returned or entitlements revoked.'), allowOutcome: true },
  'refund.query': { id: 'refund.query', label: t('查询原退款', 'Query original refund'), description: t('沿用原退款引用查询模拟渠道结果。', 'Look up the simulated channel result with the original refund reference.'), impact: t('不创建第二笔退款。渠道确认后仍须独立核对权益与对账。', 'No second refund is created. Channel confirmation still requires separate entitlement and reconciliation checks.'), allowOutcome: true },
  'refund.reconcile': { id: 'refund.reconcile', label: t('核对权益与对账', 'Verify entitlement and reconcile'), description: t('核对原订单、渠道结果与权益，登记演示对账结论。', 'Check the original order, provider result, and entitlement; record a demo reconciliation.'), impact: t('仅在渠道明确成功后可操作；不修改钱包余额或历史分录。', 'Available only after confirmed channel success. Does not edit balances or historical entries.') },
  'config.draft': { id: 'config.draft', label: t('编辑配置草稿', 'Edit configuration draft'), description: t('填写新的演示值，保留当前生效值。', 'Enter a new demo value while retaining the active value.'), impact: t('此步不生效。发布前可比较当前值与草稿值。', 'This step does not activate the value. Compare the active and draft values before publishing.'), needsValue: true },
  'config.publish': { id: 'config.publish', label: t('发布配置', 'Publish configuration'), description: t('将当前草稿发布为演示配置值。', 'Publish the draft as the active demo configuration.'), impact: t('只更新本地演示配置；不部署、不重试任务、不影响真实服务。', 'Updates only local demo configuration. No deployment, task retry, or real-service change.') },
  'config.rollback': { id: 'config.rollback', label: t('回滚配置', 'Roll back configuration'), description: t('恢复上一次发布前的演示配置值。', 'Restore the demo value from before the last publish.'), impact: t('仅回滚配置；不会撤销已完成业务或改变任务结果。', 'Only configuration is rolled back. Completed business operations and task results are not reversed.') },
}

export function createInitialState(): DemoState {
  return { entities: structuredClone(initialEntities), logs: [] }
}

export function getActions(entity: Entity): ActionDefinition[] {
  let ids: string[] = []
  switch (entity.pageId) {
    case 'accounts': if (entity.status === 'active') ids = ['account.restrict']; else if (entity.status === 'access_restricted') ids = ['account.restore']; break
    case 'sessions': if (entity.status === 'active') ids = ['session.revoke']; break
    case 'ai-calls': if (['failed', 'investigating', 'unknown'].includes(entity.status)) ids = ['ai.resolve']; break
    case 'video-tasks': if (['processing', 'unknown'].includes(entity.status)) ids = ['video.query', 'video.query-failed']; else if (entity.status === 'failed' && entity.workflow?.issue !== 'resolved') ids = ['issue.resolve']; break
    case 'plugin-services':
    case 'reconciliation': if (['attention', 'discrepancy', 'degraded', 'failed'].includes(entity.status) && entity.workflow?.issue !== 'resolved') ids = ['issue.resolve']; break
    case 'plugin-directory':
      if (entity.status === 'listed') ids = ['directory.unlist']
      if (entity.status === 'unlisted' && entity.workflow?.publicEligible === 'yes') ids = ['directory.relist']
      break
    case 'moderation':
      if (entity.status === 'review') ids = ['moderation.restrict']
      if (entity.status === 'restricted') ids = ['moderation.appeal']
      if (entity.status === 'appealed') ids = ['moderation.restore']
      break
    case 'refunds':
      if (entity.workflow?.request === 'not_requested') ids = ['refund.request']
      else if (['pending', 'unknown'].includes(entity.workflow?.channel ?? '')) ids = ['refund.query']
      else if (entity.workflow?.channel === 'confirmed' && entity.workflow.reconciliation !== 'matched') ids = ['refund.reconcile']
      break
    case 'configuration':
      ids = ['config.draft']
      if (entity.workflow?.draft && entity.workflow.draft !== entity.workflow.current) ids.push('config.publish')
      if (entity.workflow?.previous && !entity.workflow.draft) ids.push('config.rollback')
      break
  }
  return ids.flatMap((id) => actions[id] ? [structuredClone(actions[id])] : [])
}

function updateField(entity: Entity, zh: string, en: string, value: Text): void {
  const current = entity.fields.find((field) => field.label.en === en)
  if (current) current.value = value
  else entity.fields.push({ label: t(zh, en), value })
}

function appendAudit(state: DemoState, entity: Entity, action: ActionDefinition, command: Command, time: string): void {
  state.logs.unshift({ id: `audit-${state.logs.length + 1}`, entityId: entity.id, entityName: { ...entity.name }, action: { ...action.label }, reason: command.reason.trim(), operator: command.operator, outcome: command.outcome, time })
}

function syncRefundFields(entity: Entity): void {
  const workflow = entity.workflow ?? {}
  updateField(entity, '请求状态', 'Request state', workflow.request === 'registered' ? t('已登记', 'Registered') : t('未请求', 'Not requested'))
  updateField(entity, '渠道状态', 'Channel state', workflow.channel === 'confirmed' ? t('已确认退款', 'Refund confirmed') : workflow.channel === 'unknown' ? t('结果待确认', 'Result unknown') : t('处理中', 'Pending'))
  updateField(entity, '权益状态', 'Entitlement state', workflow.entitlement === 'revoked' ? t('已核对并撤销', 'Verified and revoked') : t('保留，待核对', 'Retained pending verification'))
  updateField(entity, '对账状态', 'Reconciliation state', workflow.reconciliation === 'matched' ? t('匹配', 'Matched') : t('待核对', 'Not reconciled'))
}

export function applyAction(state: DemoState, command: Command): ActionResult {
  const reject = (message: Text): ActionResult => ({ state, ok: false, message })
  if (!command.reason.trim()) return reject(t('请填写处理原因。', 'Enter a reason for this action.'))
  if (command.reason.trim().length > 500) return reject(t('处理原因最多 500 字。', 'Keep the reason within 500 characters.'))
  if (!['Mandow', 'hera'].includes(command.operator)) return reject(t('请选择演示操作者。', 'Choose a demo operator.'))
  if (!['success', 'failure', 'unknown'].includes(command.outcome)) return reject(t('演示结果无效。', 'Invalid demo outcome.'))
  const source = state.entities.find((entity) => entity.id === command.entityId)
  if (!source) return reject(t('未找到该演示记录。', 'This demo record was not found.'))
  const action = getActions(source).find((item) => item.id === command.actionId)
  if (!action) return reject(t('当前状态不允许此操作，请查看最新记录。', 'This action is unavailable in the current state. Review the latest record.'))
  if (command.outcome === 'unknown' && !action.allowOutcome) return reject(t('此本地操作没有待确认结果，请选择成功或失败。', 'This local action has no pending outcome. Choose success or failure.'))
  const draftValue = command.value?.trim()
  if (action.needsValue && (!draftValue || draftValue.length > 120)) return reject(t('请填写 1–120 字的配置值。', 'Enter a configuration value of 1–120 characters.'))
  if (command.actionId === 'config.draft' && draftValue === source.workflow?.current) return reject(t('草稿值与当前生效值相同。', 'The draft matches the active value.'))
  if (command.actionId.startsWith('moderation.') && !state.entities.some((entity) => entity.id === source.workflow?.contentId)) return reject(t('关联内容不存在，未执行处置。', 'The linked content is missing; no moderation action was applied.'))
  if (command.actionId === 'refund.reconcile' && !state.entities.some((entity) => entity.id === source.workflow?.orderId && entity.pageId === 'orders')) return reject(t('原订单不存在，未执行权益核对。', 'The original order is missing; entitlement verification was not applied.'))

  const next = structuredClone(state)
  const entity = next.entities.find((item) => item.id === source.id)
  if (!entity) return reject(t('未找到该演示记录。', 'This demo record was not found.'))
  const time = new Date().toISOString()
  appendAudit(next, entity, action, command, time)
  if (command.outcome === 'failure') return { state: next, ok: false, message: t('演示操作失败，原业务状态未改变；已记录审计。', 'The demo action failed. Business state is unchanged and the attempt is audited.') }

  entity.workflow ??= {}
  const workflow = entity.workflow
  if (command.outcome === 'unknown') {
    if (command.actionId === 'video.query') { entity.status = 'unknown'; workflow.lookup = 'unknown' }
    if (command.actionId === 'refund.request') { entity.status = 'unknown'; workflow.request = 'registered'; workflow.channel = 'unknown' }
    if (command.actionId === 'refund.query') { entity.status = 'unknown'; workflow.channel = 'unknown' }
    if (command.actionId.startsWith('refund.')) syncRefundFields(entity)
    entity.updatedAt = time
    entity.timeline.unshift({ label: t('结果待确认', 'Outcome unknown'), detail: t(`${action.label.zh}：${command.reason.trim()}`, `${action.label.en}: ${command.reason.trim()}`), time })
    return { state: next, ok: true, message: t('结果尚未确认，不能视为完成；保留原引用继续查询。', 'The outcome is not confirmed. Keep the original reference and query again.') }
  }

  switch (command.actionId) {
    case 'account.restrict': {
      entity.status = 'access_restricted'
      const userId = entity.fields.find((field) => field.label.en === 'User ID')?.value.en
      if (userId) for (const session of next.entities.filter((item) => item.pageId === 'sessions' && item.status === 'active' && item.fields.some((field) => field.label.en === 'User' && field.value.en === userId))) {
        session.status = 'revoked'; session.updatedAt = time
        session.timeline.unshift({ label: t('账号限制，撤销会话', 'Session revoked after account restriction'), detail: t(command.reason.trim(), command.reason.trim()), time })
      }
      break
    }
    case 'account.restore': entity.status = 'active'; break
    case 'issue.resolve': workflow.issue = 'resolved'; updateField(entity, '运营跟进', 'Operational follow-up', t('已记录处理结论', 'Resolution recorded')); break
    case 'session.revoke': entity.status = 'revoked'; break
    case 'ai.resolve': entity.status = 'resolved'; workflow.issue = 'resolved'; break
    case 'video.query': entity.status = 'completed'; workflow.lookup = 'confirmed'; workflow.providerResult = 'succeeded'; break
    case 'video.query-failed': entity.status = 'failed'; workflow.lookup = 'confirmed'; workflow.providerResult = 'failed'; break
    case 'directory.unlist': entity.status = 'unlisted'; break
    case 'directory.relist': entity.status = 'listed'; break
    case 'moderation.restrict': entity.status = 'restricted'; break
    case 'moderation.appeal': entity.status = 'appealed'; break
    case 'moderation.restore': entity.status = 'restored'; break
    case 'refund.request': entity.status = 'channel_pending'; workflow.request = 'registered'; workflow.channel = 'pending'; break
    case 'refund.query': entity.status = 'channel_confirmed'; workflow.channel = 'confirmed'; break
    case 'refund.reconcile': entity.status = 'reconciled'; workflow.entitlement = 'revoked'; workflow.reconciliation = 'matched'; break
    case 'config.draft':
      workflow.draft = draftValue ?? ''; entity.status = 'draft'
      updateField(entity, '草稿值', 'Draft value', t(workflow.draft, workflow.draft))
      break
    case 'config.publish':
      workflow.previous = workflow.current ?? ''; workflow.current = workflow.draft ?? ''; delete workflow.draft; entity.status = 'published'
      updateField(entity, '当前值', 'Active value', t(workflow.current, workflow.current))
      updateField(entity, '上次值', 'Previous value', t(workflow.previous, workflow.previous))
      updateField(entity, '草稿值', 'Draft value', t('无待发布草稿', 'No pending draft'))
      break
    case 'config.rollback':
      workflow.current = workflow.previous ?? ''; delete workflow.previous; entity.status = 'rolled_back'
      updateField(entity, '当前值', 'Active value', t(workflow.current, workflow.current))
      updateField(entity, '上次值', 'Previous value', t('已完成本次回滚', 'Rollback completed'))
      break
  }
  if (command.actionId.startsWith('refund.')) {
    syncRefundFields(entity)
  }
  if (command.actionId === 'refund.reconcile') {
    const order = next.entities.find((item) => item.id === workflow.orderId && item.pageId === 'orders')
    if (order) {
      order.workflow = { ...order.workflow, entitlement: 'revoked' }
      updateField(order, '权益', 'Entitlement', t('已核对并撤销', 'Verified and revoked'))
      order.updatedAt = time
      order.timeline.unshift({ label: { ...action.label }, detail: t(command.reason.trim(), command.reason.trim()), time })
    }
  }
  if (['moderation.restrict', 'moderation.restore'].includes(command.actionId)) {
    const content = next.entities.find((item) => item.id === workflow.contentId)
    if (content) {
      content.status = command.actionId === 'moderation.restore' ? 'published' : 'restricted'
      content.updatedAt = time
      content.timeline.unshift({ label: { ...action.label }, detail: t(command.reason.trim(), command.reason.trim()), time })
    }
  }
  entity.updatedAt = time
  entity.timeline.unshift({ label: { ...action.label }, detail: t(command.reason.trim(), command.reason.trim()), time })
  return { state: next, ok: true, message: t('演示操作已记录，变更仅存在于本次预览。', 'The demo action was recorded. Changes exist only in this preview.') }
}
