import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, CheckCircle2, CircleAlert, Clock3, ShieldCheck } from 'lucide-react';
import { getActions, type ActionDefinition, type Entity } from './domain';
import { useAdmin } from './state';
import { Status, Time } from './ui';

function ActionForm({ entity, action, cancel }: { entity: Entity; action: ActionDefinition; cancel: () => void }) {
  const { t, text, execute, operator } = useAdmin();
  const [reason, setReason] = useState('');
  const [value, setValue] = useState(entity.workflow?.draft ?? '');
  const [outcome, setOutcome] = useState<'success' | 'failure' | 'unknown'>('success');
  const [message, setMessage] = useState('');
  const [finished, setFinished] = useState(false);
  const [resultOk, setResultOk] = useState(false);
  function submit(event: FormEvent) {
    event.preventDefault();
    const result = execute({ entityId: entity.id, actionId: action.id, reason, value, outcome });
    setMessage(result.message);
    setResultOk(result.ok);
    if (result.recorded) setFinished(true);
  }
  return <form className="action-form" onSubmit={submit}>
    <h3>{text(action.label)}</h3><p>{text(action.description)}</p><div className="impact"><ShieldCheck size={18}/><span><strong>{t('影响范围', 'Impact')}</strong>{text(action.impact)}</span></div>
    <div className="action-target"><span>{t('操作对象', 'Target')}</span><strong>{text(entity.name)}</strong><span>{t('操作者', 'Operator')}</span><strong>{operator} · {t('演示', 'Demo')}</strong></div>
    {!finished && <>{action.needsValue && <label className="field">{t('新配置值', 'New configuration value')}<input value={value} onChange={(event) => setValue(event.target.value)} required maxLength={120}/></label>}
    {action.allowOutcome && <label className="field">{t('模拟返回结果', 'Simulated result')}<select value={outcome} onChange={(event) => setOutcome(event.target.value as typeof outcome)}><option value="success">{t('成功返回', 'Successful response')}</option><option value="failure">{t('请求失败，保留原状态', 'Request failed; keep original state')}</option><option value="unknown">{t('结果仍待确认', 'Outcome remains unknown')}</option></select></label>}
    <label className="field">{t('处理原因', 'Reason')}<textarea autoFocus rows={3} value={reason} required maxLength={500} onChange={(event) => setReason(event.target.value)} placeholder={t('说明本次处理的依据，不填写真实个人信息', 'Describe the reason. Do not enter real personal information.')}/><small>{reason.length}/500</small></label></>}
    {message && <div role={resultOk ? 'status' : 'alert'} className={`action-result ${!resultOk ? 'error' : outcome === 'unknown' ? 'uncertain' : ''}`}>{!resultOk ? <CircleAlert size={18}/> : outcome === 'unknown' ? <Clock3 size={18}/> : <CheckCircle2 size={18}/>}<span>{message}</span></div>}
    <div className="form-actions"><button type="button" className="button secondary" onClick={cancel}>{finished ? t('返回详情', 'Back to details') : t('取消', 'Cancel')}</button>{!finished && <button className={`button ${action.danger ? 'danger' : ''}`} type="submit">{t('确认演示操作', 'Confirm demo action')}</button>}</div>
  </form>;
}

const refundStepLabels = [ ['request', '退款申请', 'Request'], ['channel', '渠道处理', 'Provider'], ['entitlement', '业务权益', 'Entitlement'], ['reconciliation', '对账', 'Reconciliation'] ] as const;
const workflowValues: Record<string, [string, string]> = { not_requested: ['未申请', 'Not requested'], registered: ['已登记', 'Registered'], pending: ['处理中', 'Pending'], unknown: ['待确认', 'Unknown'], confirmed: ['已确认', 'Confirmed'], unchanged: ['未变更', 'Unchanged'], not_checked: ['未核对', 'Not checked'], checked: ['已核对', 'Checked'], revoked: ['已撤销', 'Revoked'], matched: ['已匹配', 'Matched'], active: ['有效', 'Active'], verified: ['已核验', 'Verified'], not_started: ['未开始', 'Not started'], preserved: ['保持原状', 'Preserved'], reviewed: ['已核对', 'Reviewed'] };

export function EntityDetail({ entity }: { entity: Entity }) {
  const { text, t } = useAdmin();
  const [action, setAction] = useState<ActionDefinition | null>(null);
  const available = getActions(entity);
  return <article className="entity-detail"><div className="detail-title"><div className="detail-record-id">{entity.id}</div><h2>{text(entity.name)}</h2><p>{text(entity.summary)}</p><Status value={entity.status}/></div>
    {entity.pageId === 'refunds' && <div className="workflow-steps" aria-label={t('退款流程阶段', 'Refund stages')}>{refundStepLabels.map(([key, zh, en], index) => { const raw = entity.workflow?.[key] ?? 'not_started'; const label = workflowValues[raw]; return <div key={key}><span className="step-number">{index + 1}</span><strong>{t(zh, en)}</strong><small>{label ? t(...label) : raw}</small></div>; })}</div>}
    {entity.pageId === 'configuration' && <div className="config-diff"><div><small>{t('当前生效值', 'Active value')}</small><strong>{entity.workflow?.current ?? '—'}</strong></div><ArrowRight size={18}/><div><small>{t('草稿值', 'Draft value')}</small><strong>{entity.workflow?.draft || t('尚无草稿', 'No draft')}</strong></div>{entity.workflow?.previous && <p>{t('上一版本', 'Previous version')}：{entity.workflow.previous}</p>}</div>}
    {action ? <ActionForm key={action.id} entity={entity} action={action} cancel={() => setAction(null)}/> : <>
      <section className="detail-section"><h3>{t('记录信息', 'Record information')}</h3><dl className="facts">{entity.fields.map((field) => <div key={field.label.en}><dt>{text(field.label)}</dt><dd>{text(field.value)}</dd></div>)}<div><dt>{t('关联账号 / 负责人', 'Account / owner')}</dt><dd>{entity.owner}</dd></div><div><dt>{t('更新时间', 'Updated')}</dt><dd><Time value={entity.updatedAt}/></dd></div></dl></section>
      {entity.related?.length ? <section className="detail-section"><h3>{t('关联记录', 'Related records')}</h3><div className="related-links">{entity.related.map((related) => <Link key={related.id} to={`/${related.pageId}/${related.id}`}>{text(related.label)}<ArrowRight size={15}/></Link>)}</div></section> : null}
      <section className="detail-section"><h3>{t('时间线', 'Timeline')}</h3><ol className="timeline">{entity.timeline.map((event, index) => <li key={`${event.time}-${index}`}><span className="timeline-dot"/><div><strong>{text(event.label)}</strong><p>{text(event.detail)}</p><Time value={event.time}/></div></li>)}</ol></section>
      <section className="detail-actions"><h3>{t('可执行的演示操作', 'Available demo actions')}</h3>{available.length ? <div className="action-buttons">{available.map((item) => <button className={`button ${item.danger ? 'secondary danger-outline' : 'secondary'}`} key={item.id} onClick={() => setAction(item)}>{text(item.label)}</button>)}</div> : <p className="muted">{t('当前记录为只读展示，无可执行的管理操作。', 'This record is read-only. No management action is available.')}</p>}<small>{t('所有操作只影响本次演示，不会发送业务请求。', 'Actions affect this demo only. No business request is sent.')}</small></section>
    </>}
  </article>;
}
