import { useEffect, useRef, useState } from 'react';
import { useAdmin } from '../state';
import { usePayments } from './session';
import { errorMessage } from './controls';
import { isPaymentId, paymentAuditPath, parsePaymentAuditPage, paymentAuditReferences, type PaymentAuditPage } from './audit-data';

type Result = PaymentAuditPage & { scope: string; receivedAt: string };
export function AuditPanel() {
  const { api } = usePayments();
  const { t } = useAdmin();
  const [draft, setDraft] = useState('');
  const [paymentId, setPaymentId] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [trail, setTrail] = useState<(string | null)[]>([]);
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const path = paymentAuditPath(paymentId, cursor);
  const scope = `${path}:${refresh}`;
  const visible = result?.scope === scope ? result : null;
  const loading = status === 'loading' || (status === 'ready' && visible === null);

  useEffect(() => {
    const id = ++sequence.current;
    setStatus('loading'); setError(''); setResult(null);
    void api.get(path, (value) => parsePaymentAuditPage(value, paymentId)).then((page) => {
      if (sequence.current !== id) return;
      setResult({ ...page, scope, receivedAt: new Date().toISOString() }); setStatus('ready');
    }).catch((cause: unknown) => {
      if (sequence.current === id) { setError(errorMessage(cause, t)); setStatus('error'); }
    });
    return () => { sequence.current += 1; };
  }, [api, path, paymentId, scope, t]);

  function applyScope(next: string) { setPaymentId(next); setCursor(null); setTrail([]); setRefresh((value) => value + 1); }
  const actionNames: Record<string, [string, string]> = {
    credit_proposed: ['提交入账初审', 'Credit proposed'], credit_approved: ['复审入账', 'Credit approved'],
    refund_requested: ['申请退款', 'Refund requested'], refund_external_approved: ['批准外部退款', 'External refund approved'],
    refund_result_unknown: ['登记退款结果未知', 'Refund outcome marked unknown'], refund_evidence_attached: ['提交退款凭证', 'Refund evidence attached'],
    refund_evidence_correction_requested: ['退回退款凭证', 'Refund evidence returned'], refund_external_verified: ['核验退款并记账', 'Refund verified and recorded'],
    settlement_evidence_imported: ['导入结算材料', 'Settlement evidence imported'], settlement_rechecked: ['按原材料重核', 'Original evidence rechecked'],
    settlement_evidence_verified: ['独立核对结算材料', 'Settlement evidence attested'], fx_candidate_activated: ['激活参考汇率候选', 'Reference-rate candidate activated'],
  };
  return <section className="panel pay-panel" aria-label={t('支付审计', 'Payment audit')} aria-busy={loading}>
    <h2>{t('支付域操作审计', 'Payment operation audit')}</h2>
    <p>{t('读取服务端保存的支付、退款、结算与汇率操作记录。仅覆盖支付域，不能据此推断全平台活动或业务总量。', 'Server-recorded payment, refund, settlement and reference-rate actions. This covers the payment domain only and does not establish platform activity or business totals.')}</p>
    <form className="pay-lookup" noValidate onSubmit={(event) => { event.preventDefault(); const value = draft.trim(); if (!value || isPaymentId(value)) applyScope(value.toLowerCase()); else { setError(t('请输入完整有效的订单编号，或留空查询。', 'Enter a complete valid payment ID, or leave it empty.')); setStatus('error'); } }}>
      <label>{t('按付款订单筛选（可留空）', 'Filter by payment ID (optional)')}<input value={draft} onChange={(event) => setDraft(event.target.value)} pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}" maxLength={36}/></label>
      <button className="button secondary" type="submit" disabled={loading}>{t('应用筛选', 'Apply filter')}</button>
      <button className="button secondary" type="button" disabled={loading} onClick={() => { setDraft(''); applyScope(''); }}>{t('全部支付域记录', 'All payment-domain events')}</button>
      <button className="button secondary" type="button" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>{t('刷新当前页', 'Refresh current page')}</button>
    </form>
    <p className="muted">{paymentId ? t(`范围：订单 ${paymentId}`, `Scope: payment ${paymentId}`) : t('范围：当前角色可读取的支付域记录', 'Scope: payment-domain records available to this role')} · {t(`第 ${trail.length + 1} 页，每页最多 20 条`, `Page ${trail.length + 1}, up to 20 records per page`)}</p>
    {loading && <p role="status">{t('正在读取审计记录…', 'Reading audit records…')}</p>}
    {status === 'error' && <><p className="pay-error" role="alert">{error}</p><p role="status">{t('未能读取此页，不能判断是否存在记录。请手动刷新。', 'This page could not be read; record availability is unknown. Refresh manually.')}</p></>}
    {visible && status === 'ready' && <>
      <p className="muted">{t('浏览器接收时间', 'Received by this browser')}: <time dateTime={visible.receivedAt}>{visible.receivedAt}</time> · {t('下列发生时间均由服务端记录返回。', 'Event times below are returned by the server.')}</p>
      {visible.items.length === 0 ? <p role="status">{t('本次范围与页码没有返回审计记录。', 'No audit records were returned for this scope and page.')}</p> : <div className="table-scroll"><table><thead><tr><th>{t('发生时间', 'Event time')}</th><th>{t('操作', 'Action')}</th><th>{t('操作者', 'Actor')}</th><th>{t('付款订单', 'Payment')}</th><th>{t('审计引用', 'Audit references')}</th></tr></thead><tbody>{visible.items.map((item) => {
        const name = Object.hasOwn(actionNames, item.action) ? actionNames[item.action] : undefined;
        const references = paymentAuditReferences(item);
        return <tr key={item.audit_id}><td><time dateTime={item.created_at}>{item.created_at}</time></td><td>{name ? t(...name) : item.action}{name&&<small><code>{item.action}</code></small>}</td><td><code>{item.actor_id}</code></td><td>{item.payment_id ? <code>{item.payment_id}</code> : t('未关联付款订单', 'No associated payment')}</td><td><code>{item.audit_id}</code>{references.length > 0 && <details><summary>{t('查看引用与证据摘要', 'View references and evidence hashes')}</summary><dl className="facts">{references.map(([key, value]) => <div key={key}><dt>{key}</dt><dd><code>{value}</code></dd></div>)}</dl></details>}</td></tr>;
      })}</tbody></table></div>}
    </>}
    <div className="form-actions"><button className="button secondary" disabled={loading || trail.length === 0} onClick={() => { setCursor(trail.at(-1) ?? null); setTrail((items) => items.slice(0, -1)); }}>{t('上一页审计', 'Previous audit page')}</button><button className="button secondary" disabled={loading || status !== 'ready' || !visible?.next_cursor} onClick={() => { setTrail((items) => [...items, cursor]); setCursor(visible?.next_cursor ?? null); }}>{t('下一页审计', 'Next audit page')}</button></div>
  </section>;
}
