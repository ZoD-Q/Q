import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useAdmin } from '../state';
import { PaymentError } from './api';
import { PaymentConfirm, errorMessage } from './controls';
import { usePayments } from './session';
import { parseFxStatus, type FxStatus } from './types';

const statusPath = '/v1/payments/fx/status';
const activationPath = '/v1/payments/fx/activations';
const pendingKey = 'fx-activation';
type ActivationReference = { candidate_id: string; evidence_sha256: string; expected_generation: number };
type Prepared = ActivationReference & { reason: string; rate: string; sourceDate: string };
type Receipt = { activation_id: string; snapshot_id: string; generation: number; activated_at: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = /^[0-9a-f]{64}$/;

function activationReference(value: unknown): ActivationReference | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.candidate_id !== 'string' || !uuid.test(v.candidate_id)
    || typeof v.evidence_sha256 !== 'string' || !hash.test(v.evidence_sha256)
    || typeof v.expected_generation !== 'number' || !Number.isSafeInteger(v.expected_generation)
    || v.expected_generation < 1 || v.expected_generation >= Number.MAX_SAFE_INTEGER) return null;
  return { candidate_id: v.candidate_id, evidence_sha256: v.evidence_sha256, expected_generation: v.expected_generation };
}

function parseReceipt(value: unknown, expected: ActivationReference): Receipt {
  if (!value || typeof value !== 'object') throw Error('INVALID_RESPONSE');
  const v = value as Record<string, unknown>;
  if (typeof v.activation_id !== 'string' || !uuid.test(v.activation_id)
    || v.snapshot_id !== expected.candidate_id || v.generation !== expected.expected_generation + 1
    || typeof v.activated_at !== 'string' || !Number.isFinite(Date.parse(v.activated_at))) throw Error('INVALID_RESPONSE');
  return { activation_id: v.activation_id, snapshot_id: expected.candidate_id, generation: expected.expected_generation + 1, activated_at: v.activated_at };
}

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return <dl className="facts">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

export function FxPanel() {
  const { epoch, operator } = usePayments();
  return <FxPanelSession key={`${epoch}:${operator.user_id}`} />;
}

function FxPanelSession() {
  const { api, operator } = usePayments();
  const { t } = useAdmin();
  const [status, setStatus] = useState<FxStatus | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(true);
  const [currentVerified, setCurrentVerified] = useState(false);
  const [receivedAt, setReceivedAt] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [recovery, setRecovery] = useState<'matched' | 'unconfirmed' | null>(null);
  const mounted = useRef(false);
  const operation = useRef(0);
  const inFlight = useRef(true);
  const pending = api.pending(pendingKey);
  const candidate = status?.candidate;
  const canActivate = currentVerified && !pending && !busy
    && operator.roles.some((role) => role === 'maker' || role === 'checker')
    && candidate?.manual_activation_allowed === true && status?.generation !== null
    && status?.generation !== undefined;
  const reasonValid = Array.from(reason.trim()).length >= 10 && Array.from(reason).length <= 500
    && Array.from(reason).every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 31 && (code < 127 || code > 159);
    });
  const missing = t('未提供', 'Not provided');
  const yesNo = (value: boolean) => value ? t('是', 'Yes') : t('否', 'No');

  useEffect(() => {
    mounted.current = true;
    const id = ++operation.current;
    inFlight.current = true;
    void api.get(statusPath, parseFxStatus).then((next) => {
      if (!mounted.current || id !== operation.current) return;
      setStatus(next); setCurrentVerified(true); setReceivedAt(new Date().toISOString()); setError(null);
    }).catch((cause: unknown) => {
      if (mounted.current && id === operation.current) { setError(cause); setCurrentVerified(false); }
    }).finally(() => {
      if (mounted.current && id === operation.current) { setBusy(false); inFlight.current = false; }
    });
    return () => { mounted.current = false; operation.current += 1; };
  }, [api]);

  async function refresh(reconcile: boolean) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null); setPrepared(null); setCurrentVerified(false);
    const id = ++operation.current;
    const original = activationReference(api.pending(pendingKey)?.body);
    try {
      const next = reconcile ? await api.recover(pendingKey, parseFxStatus) : await api.get(statusPath, parseFxStatus);
      if (!mounted.current || id !== operation.current) return;
      setStatus(next); setCurrentVerified(true); setReceivedAt(new Date().toISOString());
      if (reconcile) {
        // A matching live snapshot resolves the desired state, not who activated it.
        // Rust increments the reviewed generation once on activation. Later generations
        // or a missing candidate never prove this activation's outcome.
        const matches = original !== null && next.generation === original.expected_generation + 1
          && next.current?.snapshot_id === original.candidate_id
          && next.current.evidence_sha256 === original.evidence_sha256;
        if (matches) await api.clearPending(pendingKey);
        setRecovery(matches ? 'matched' : 'unconfirmed');
      }
    } catch (cause) {
      if (mounted.current && id === operation.current) setError(cause);
    } finally {
      if (mounted.current && id === operation.current) { setBusy(false); inFlight.current = false; }
    }
  }

  function prepare() {
    if (!canActivate || !candidate || !status || status.generation === null || !reasonValid) return;
    const reference = activationReference({ candidate_id: candidate.id, evidence_sha256: candidate.evidence_sha256, expected_generation: status.generation });
    if (!reference) { setError(new PaymentError('INVALID_RESPONSE')); return; }
    setPrepared({ ...reference, reason: reason.trim(), rate: candidate.rate_cny_per_100_hkd, sourceDate: candidate.source_date });
  }

  async function activate() {
    if (inFlight.current || !prepared || !canActivate || !candidate || !status) return;
    if (candidate.id !== prepared.candidate_id || candidate.evidence_sha256 !== prepared.evidence_sha256
      || status.generation !== prepared.expected_generation) {
      setPrepared(null); setCurrentVerified(false); setError(new PaymentError('VERSION_OR_STATE_CHANGED', 409)); return;
    }
    const request = { candidate_id: prepared.candidate_id, evidence_sha256: prepared.evidence_sha256, expected_generation: prepared.expected_generation, reason: prepared.reason };
    inFlight.current = true; setBusy(true); setError(null); setReceipt(null); setRecovery(null); setCurrentVerified(false);
    const id = ++operation.current;
    try {
      const result = await api.mutate(pendingKey, activationPath, request, (value) => parseReceipt(value, request), statusPath);
      if (!mounted.current || id !== operation.current) return;
      setReceipt(result); setReason(''); setPrepared(null);
      // Read the new state after a definitive receipt; never refresh the provider.
      const next = await api.get(statusPath, parseFxStatus);
      if (mounted.current && id === operation.current) { setStatus(next); setCurrentVerified(true); setReceivedAt(new Date().toISOString()); }
    } catch (cause) {
      if (mounted.current && id === operation.current) { setPrepared(null); setError(cause); }
    } finally {
      if (mounted.current && id === operation.current) { setBusy(false); inFlight.current = false; }
    }
  }

  const stateLabels: Record<string, string> = { ready: t('可用于新报价', 'Available for new quotes'), held: t('已暂停使用', 'On hold'), stale: t('已过期', 'Stale'), unconfigured: t('未配置或策略不匹配', 'Unconfigured or policy mismatch') };
  return <section className="panel full-detail" aria-label={t('汇率状态', 'FX status')} aria-busy={busy}>
    <div className="panel-heading"><div><h2>{t('参考汇率与证据', 'Reference rate and evidence')}</h2><p>{t('所显示参考价仅用于报价计算，来源核验状态见下方证据；不是可成交汇率，也不表示兑换或清算已发生。', 'Displayed reference rates support quoting; source verification is shown with the evidence below. They are not executable prices or proof of currency conversion or settlement.')}</p></div><button className="button secondary" disabled={busy} onClick={() => void refresh(Boolean(pending))}>{busy ? t('查询中…', 'Reading…') : pending ? t('查询待确认激活', 'Reconcile pending activation') : t('查询当前状态', 'Read current status')}</button></div>
    <p className="muted">{t('本页只读取服务端已保存状态，不触发供应商刷新。所有时间按服务端返回展示；剩余时间不会伪装为实时倒计时。', 'This page reads saved server state and does not refresh the provider. Times come from the server; remaining time is a snapshot, not a live countdown.')}</p>
    <p className="muted">{t('范围：当前服务保存的参考汇率、候选与诊断。','Scope: reference rates, candidates and diagnostics saved by this service.')}{receivedAt&&<> · {t('浏览器最近接收时间','Last received by this browser')}: <time dateTime={receivedAt}>{receivedAt}</time></>}</p>
    {error !== null && <p role="alert" className="pay-error">{errorMessage(error, t)}</p>}
    {pending && <div role="status" className="impact"><div><strong>{t('激活结果待确认', 'Activation outcome unknown')}</strong><p>{t('原候选编号、证据摘要和策略版本已保留。先查询当前状态；不重新提交激活，也不因候选消失就推断失败。', 'The original candidate, evidence hash, and generation are retained. Query the state first; do not resubmit or infer failure from a missing candidate.')}</p><code>{activationReference(pending.body)?.candidate_id ?? missing}</code></div></div>}
    {recovery && <p role="status">{recovery === 'matched' ? t('当前生效快照、证据摘要与策略版本匹配原候选。已核实目标状态；这不替代具体操作者的激活回执。', 'The active snapshot, evidence hash, and generation match the original candidate. The desired state is verified; this does not replace an actor-specific activation receipt.') : t('当前状态仍不能确认原激活结果。原引用继续保留，请由运维核对审计记录，勿重复激活。', 'The original outcome is still unconfirmed. Its references remain retained; have operations review the audit record without repeating activation.')}</p>}
    {receipt && <section className="detail-section" role="status"><h3>{t('服务端已返回激活回执', 'Server activation receipt received')}</h3><Facts rows={[[t('激活编号', 'Activation ID'), <code>{receipt.activation_id}</code>], [t('快照编号', 'Snapshot ID'), <code>{receipt.snapshot_id}</code>], [t('策略版本', 'Generation'), receipt.generation], [t('激活时间', 'Activated at'), receipt.activated_at]]}/></section>}
    {!status && <p role="status">{busy ? t('正在读取真实汇率状态…', 'Reading server FX state…') : t('未读取到汇率状态，不展示示例报价。', 'FX state is unavailable. No sample rate is substituted.')}</p>}
    {status && <>
      {!currentVerified && <p role="status">{t('以下为上次成功读取的状态，尚未重新核实；激活入口已停用。', 'The information below is the last successful read and has not been reverified. Activation is disabled.')}</p>}
      <Facts rows={[[t('状态', 'State'), stateLabels[status.state] ?? status.state], [t('更新模式', 'Mode'), status.mode === 'automatic' ? t('服务端自动更新', 'Server automatic refresh') : status.mode === 'manual' ? t('配置参考价', 'Configured reference rate') : status.mode], [t('服务端时间', 'Server time'), status.server_time], [t('策略版本', 'Generation'), status.generation ?? missing], [t('策略摘要', 'Policy fingerprint'), <code>{status.policy_fingerprint}</code>]]}/>
      <section className="detail-section"><h3>{t('有效期与暂停提醒', 'Expiry and hold alerts')}</h3><Facts rows={[[t('24 小时内到期', 'Expires within 24 hours'), yesNo(status.alerts.within_24h)], [t('6 小时内到期', 'Expires within 6 hours'), yesNo(status.alerts.within_6h)], [t('已过期 / 无有效报价', 'Stale / no valid rate'), yesNo(status.alerts.stale)], [t('已暂停', 'Held'), yesNo(status.alerts.held)], [t('暂停原因', 'Hold reason'), status.hold_reason ?? missing]]}/><p className="muted">{t('过期、暂停或策略不匹配时不能据此创建新报价。已接受订单保留自己的冻结报价，本操作不会改写原订单。', 'Stale, held, or mismatched policy cannot support new quotes. Accepted orders retain their frozen quote; this action does not rewrite them.')}</p></section>
      <section className="detail-section"><h3>{t('当前参考快照', 'Current reference snapshot')}</h3>{status.current ? <Facts rows={[[t('快照编号', 'Snapshot ID'), status.current.snapshot_id ?? t('配置快照，无持久编号', 'Configured snapshot, no stored ID')], [t('来源日期', 'Source date'), status.current.source_date], [t('参考价时点', 'Rate time'), status.current.rate_at], [t('获取时间', 'Fetched at'), status.current.fetched_at], [t('到期时间', 'Expires at'), status.current.expires_at], [t('剩余秒数（读取时）', 'Remaining seconds at read'), status.current.remaining_seconds], [t('每 HK$100 对应人民币', 'CNY per HK$100'), status.current.rate_cny_per_100_hkd], [t('原始证据 SHA-256', 'Evidence SHA-256'), <code>{status.current.evidence_sha256}</code>], [t('服务端已核验 ECB 证据', 'Server-verified ECB evidence'), yesNo(status.current.evidence_verified)]]}/> : <p>{t('服务端未提供当前快照。', 'The server did not provide a current snapshot.')}</p>}</section>
      <section className="detail-section"><h3>{t('刷新诊断', 'Refresh diagnostics')}</h3><Facts rows={[[t('最近检查', 'Last checked'), status.last_checked_at ?? missing], [t('最近成功获取', 'Last successful fetch'), status.last_success_at ?? missing], [t('最近错误码', 'Last error code'), status.last_error_code ?? missing], [t('最近 HTTP 状态', 'Last HTTP status'), status.last_http_status ?? missing], [t('下次服务端尝试', 'Next server attempt'), status.next_attempt_at ?? missing], [t('服务端正在刷新', 'Server refresh in progress'), yesNo(status.refresh_in_progress)]]}/></section>
      <section className="detail-section"><h3>{t('待人工核对候选', 'Candidate for manual review')}</h3>{candidate ? <><Facts rows={[[t('候选编号', 'Candidate ID'), <code>{candidate.id}</code>], [t('来源日期', 'Source date'), candidate.source_date], [t('每 HK$100 对应人民币', 'CNY per HK$100'), candidate.rate_cny_per_100_hkd], [t('候选证据 SHA-256', 'Candidate evidence SHA-256'), <code>{candidate.evidence_sha256}</code>], [t('核对原因', 'Review reason'), candidate.reason], [t('服务端允许人工激活', 'Manual activation allowed by server'), yesNo(candidate.manual_activation_allowed)]]}/>{canActivate && <><label className="field">{t('人工核对理由（10–500 字）', 'Review reason (10–500 characters)')}<input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} aria-describedby="fx-reason-help"/></label><p id="fx-reason-help" className="muted">{t('核对原始证据后填写理由；不要输入密钥、密码或个人金融明细。', 'Review the original evidence and provide a reason. Do not include secrets, passwords, or personal financial details.')}</p><button className="button" disabled={!reasonValid} onClick={prepare}>{t('核对并激活此候选', 'Review and activate this candidate')}</button></>}{!candidate.manual_activation_allowed && <p>{t('该候选当前不可人工激活。页面不能修改参考价、证据、过期时间或绕过暂停。', 'This candidate cannot currently be activated manually. This page cannot edit rates, evidence, expiry, or bypass a hold.')}</p>}</> : <p>{t('没有待人工激活的候选。', 'No candidate awaits manual activation.')}</p>}</section>
    </>}
    {prepared && <PaymentConfirm title={t('确认激活参考汇率候选', 'Confirm reference-rate activation')} busy={busy} onCancel={() => setPrepared(null)} onConfirm={() => void activate()}><p>{t('只激活下列精确证据快照，不执行兑换、支付或清算。服务端会再次核对权限、候选和策略版本。', 'Activate only the exact evidence snapshot below. No conversion, payment, or settlement is performed. The server rechecks role, candidate, and generation.')}</p><Facts rows={[[t('候选编号', 'Candidate ID'), <code>{prepared.candidate_id}</code>], [t('证据 SHA-256', 'Evidence SHA-256'), <code>{prepared.evidence_sha256}</code>], [t('策略版本', 'Generation'), prepared.expected_generation], [t('来源日期', 'Source date'), prepared.sourceDate], [t('每 HK$100 对应人民币', 'CNY per HK$100'), prepared.rate], [t('核对理由', 'Review reason'), prepared.reason]]}/></PaymentConfirm>}
  </section>;
}
