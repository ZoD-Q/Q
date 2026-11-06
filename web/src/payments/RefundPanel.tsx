import { useCallback, useEffect, useRef, useState } from 'react';
import { useAdmin } from '../state';
import { PaymentError } from './api';
import { usePayments } from './session';
import { parseRefund } from './types';
import { PaymentConfirm } from './controls';
import { validateRefundWriteResult, matchesRefundUnknown, matchesRefundVerification, type RefundAction } from './refund-response';
import type { components } from '../../../mobile/shared/src/generated';

type Refund = components['schemas']['PaymentRefund'];
type EvidenceVersion = components['schemas']['PaymentRefundEvidenceVersion'];
type EvidencePage = components['schemas']['PaymentRefundEvidencePage'];
type Props = { paymentId: string; payerId: string; onChanged: () => void };
type Kind = RefundAction;
type Body = Record<string, string | number>;
type Audit = { id: string; actor: string; action: string; time: string };
type Context = { refund: Refund | null; payMinor: number; creditMinor: number; createdAt: string; paidAt: string | null; verified: boolean; audit: Audit[] };
type Upload = { name: string; base64: string; hash: string; size: number };
type Prepared = { kind: Kind; key: string; path: string; body: Body; recoveryPath: string; retry?: boolean; evidenceHash?: string; evidenceName?: string; recoveryIdentity?: Body };
const kinds: Kind[] = ['create', 'approve', 'evidence', 'verify', 'unknown', 'reject'];
const prefix = '/v1/payments/operator';
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const validText = (value: string, limit: number) => Boolean(value.trim()) && bytes(value) <= limit && !Array.from(value).some((character) => {
  const code = character.codePointAt(0)!;
  return (code < 32 && code !== 9 && code !== 10) || (code >= 127 && code <= 159);
});

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid refund response');
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid refund response');
  return value;
}
function amount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid refund amount');
  return value;
}
function timestamp(value: unknown): string {
  const result = string(value);
  if (!Number.isFinite(Date.parse(result))) throw new Error('Invalid refund timestamp');
  return result;
}
function scopedRefund(value: unknown, paymentId: string): Refund {
  const data = object(value);
  const result: Refund = { ...parseRefund(value), notes: data.notes === null ? null : string(data.notes), approved_at: data.approved_at === null ? null : timestamp(data.approved_at) };
  if (result.payment_id !== paymentId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result.refund_id)
      || !['requested', 'approved_external', 'unknown', 'evidence_pending', 'refunded', 'evidence_rejected'].includes(result.status) || result.version < 1) throw new Error('Refund scope mismatch');
  if (amount(result.pay_amount_minor_cny) < 1 || amount(result.credit_amount_minor_hkd) < 1 || amount(result.frozen_minor_hkd) > result.credit_amount_minor_hkd) throw new Error('Invalid refund amounts');
  if (result.evidence_sha256 !== null && !/^[0-9a-f]{64}$/.test(result.evidence_sha256)) throw new Error('Invalid refund evidence hash');
  timestamp(result.created_at); timestamp(result.updated_at);
  if (result.executed_at !== null) timestamp(result.executed_at);
  if (result.evidence_version !== null && amount(result.evidence_version) < 1) throw new Error('Invalid refund evidence version');
  if (result.rejection_reason !== null) string(result.rejection_reason);
  if (['evidence_pending', 'evidence_rejected', 'refunded'].includes(result.status) && (result.evidence_version === null || result.evidence_sha256 === null)) throw new Error('Missing refund evidence identity');
  return result;
}
function parseEvidencePage(value: unknown): EvidencePage {
  const data = object(value);
  if (!Array.isArray(data.items) || data.items.length > 100) throw new Error('Invalid evidence page');
  const next = data.next_cursor === null ? null : string(data.next_cursor);
  if (next !== null && !/^[1-9][0-9]{0,18}$/.test(next)) throw new Error('Invalid evidence cursor');
  const items: EvidenceVersion[] = data.items.map((value) => {
    const row = object(value);
    const version = amount(row.evidence_version);
    const hash = string(row.evidence_sha256);
    if (version < 1 || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid evidence identity');
    return { evidence_version: version, evidence_sha256: hash, external_reference: string(row.external_reference), executed_at: timestamp(row.executed_at), actor_id: string(row.actor_id), notes: string(row.notes), created_at: timestamp(row.created_at), rejected_by: row.rejected_by === null ? null : string(row.rejected_by), rejection_reason: row.rejection_reason === null ? null : string(row.rejection_reason), rejected_at: row.rejected_at === null ? null : timestamp(row.rejected_at) };
  });
  if (new Set(items.map((item) => item.evidence_version)).size !== items.length) throw new Error('Duplicate evidence version');
  return { items, next_cursor: next };
}
function parseContext(value: unknown, paymentId: string, payerId: string): Context {
  const data = object(value);
  const order = object(data.order);
  if (order.payment_id !== paymentId || order.account_id !== payerId || order.pay_currency !== 'CNY' || order.credit_currency !== 'HKD') throw new Error('Refund scope mismatch');
  if (!Array.isArray(data.audit) || !Object.hasOwn(data, 'refund')) throw new Error('Invalid refund response');
  const refund = data.refund === null ? null : scopedRefund(data.refund, paymentId);
  const audit = data.audit.map((item): Audit => {
    const entry = object(item);
    return { id: string(entry.audit_id), actor: string(entry.actor_id), action: string(entry.action), time: timestamp(entry.created_at) };
  }).filter((entry) => entry.action.startsWith('refund_'));
  return { refund, payMinor: amount(order.pay_amount_minor_cny), creditMinor: amount(order.credit_amount_minor_hkd), createdAt: timestamp(order.created_at), paidAt: data.provider_paid_at === null ? null : timestamp(data.provider_paid_at), verified: typeof data.verified_at === 'string' && Number.isFinite(Date.parse(data.verified_at)) && typeof data.provider_trade_no === 'string' && Boolean(data.provider_trade_no), audit };
}
async function digest(base64: string): Promise<string> {
  const binary = atob(base64);
  const buffer = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const hash = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
async function matches(kind: Kind, body: Record<string, unknown>, refund: Refund, actor: string): Promise<boolean> {
  if (kind === 'create') return refund.client_request_id === body.client_request_id && refund.maker_id === actor && (body.reason === undefined || refund.reason === body.reason);
  if (kind === 'approve') return refund.checker_id === actor && refund.status !== 'requested';
  if (kind === 'unknown') return matchesRefundUnknown(refund, body, actor);
  if (kind === 'verify') return matchesRefundVerification(refund, body, actor);
  if (kind === 'reject') return refund.status === 'evidence_rejected' && refund.checker_id === actor && refund.evidence_sha256 === body.evidence_sha256 && typeof body.evidence_version === 'number' && refund.evidence_version === body.evidence_version && typeof body.version === 'number' && refund.version > body.version && (body.reason === undefined || refund.rejection_reason === body.reason);
  if (body.evidence_base64 === undefined && typeof body.evidence_sha256 === 'string' && typeof body.execution_sha256 === 'string' && refund.executed_at !== null) {
    const bytes = new TextEncoder().encode(JSON.stringify([refund.external_reference, new Date(refund.executed_at).toISOString()]));
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
    return refund.maker_id === actor && refund.evidence_sha256 === body.evidence_sha256 && hash === body.execution_sha256 && typeof body.version === 'number' && refund.version > body.version;
  }
  return typeof body.evidence_base64 === 'string' && typeof body.executed_at === 'string'
    && typeof body.version === 'number' && refund.version > body.version
    && refund.maker_id === actor && refund.external_reference === body.external_reference
    && refund.executed_at !== null && Date.parse(refund.executed_at) === Date.parse(body.executed_at)
    && refund.evidence_sha256 === await digest(body.evidence_base64);
}

function RefundEvidenceHistory({ refundId, disabled, download }: { refundId: string; disabled: boolean; download: (version: number) => void }) {
  const { api } = usePayments();
  const { t } = useAdmin();
  const [page, setPage] = useState<EvidencePage | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [trail, setTrail] = useState<(string | null)[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const sequence = useRef(0);
  useEffect(() => {
    const current = ++sequence.current;
    setLoading(true); setFailed(false); setPage(null);
    const path = `${prefix}/refunds/${refundId}/evidence?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    void api.get(path, parseEvidencePage).then((result) => { if (sequence.current === current) setPage(result); }).catch(() => { if (sequence.current === current) setFailed(true); }).finally(() => { if (sequence.current === current) setLoading(false); });
    return () => { sequence.current += 1; };
  }, [api, refundId, cursor, refresh]);
  return <section aria-label={t('退款凭证历史', 'Refund evidence history')}>
    <h3>{t('退款凭证历史', 'Refund evidence history')}</h3>
    <p>{t('历史版本只读并保留退回原因。下载仅为附件，不在页面内执行或预览文件；历史哈希不能用于核验当前版本。', 'Historical versions are read-only and retain correction reasons. Files download as attachments, never execute or preview inline. A historical hash cannot verify the current version.')}</p>
    {loading && <p role="status">{t('读取凭证历史…', 'Loading evidence history…')}</p>}
    {failed && <p role="alert">{t('无法读取凭证历史，请手动刷新；未触发任何退款操作。', 'Could not load evidence history. Refresh manually; no refund operation was triggered.')}</p>}
    <button type="button" className="button secondary" disabled={disabled || loading} onClick={() => setRefresh((value) => value + 1)}>{t('刷新凭证历史', 'Refresh evidence history')}</button>
    {page?.items.length === 0 && <p>{t('暂无凭证版本。', 'No evidence versions yet.')}</p>}
    {page?.items.map((entry) => <article key={entry.evidence_version} aria-label={`${t('凭证版本', 'Evidence version')} ${entry.evidence_version}`}>
      <h4>{t('凭证版本', 'Evidence version')} {entry.evidence_version}</h4>
      <dl className="facts">{[['SHA-256', entry.evidence_sha256], [t('外部流水', 'External reference'), entry.external_reference], [t('执行时间', 'Executed at'), entry.executed_at], [t('提交人', 'Submitted by'), entry.actor_id], [t('提交时间', 'Submitted at'), entry.created_at], [t('退款专用说明', 'Refund-specific notes'), entry.notes], [t('退回人', 'Returned by'), entry.rejected_by ?? '—'], [t('补正原因', 'Correction reason'), entry.rejection_reason ?? '—'], [t('退回时间', 'Returned at'), entry.rejected_at ?? '—']].map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>
      <button type="button" className="button secondary" disabled={disabled || loading} onClick={() => download(entry.evidence_version)}>{t(`下载版本 ${entry.evidence_version} 附件`, `Download version ${entry.evidence_version} attachment`)}</button>
    </article>)}
    <div className="form-actions"><button type="button" className="button secondary" disabled={disabled || loading || trail.length === 0} onClick={() => { setCursor(trail.at(-1) ?? null); setTrail((items) => items.slice(0, -1)); }}>{t('上一页凭证', 'Previous evidence page')}</button><button type="button" className="button secondary" disabled={disabled || loading || !page?.next_cursor} onClick={() => { setTrail((items) => [...items, cursor]); setCursor(page?.next_cursor ?? null); }}>{t('下一页凭证', 'Next evidence page')}</button></div>
  </section>;
}

export function RefundPanel(props: Props) {
  const { epoch, operator } = usePayments();
  return <RefundPanelSession key={`${epoch}:${operator.user_id}:${props.paymentId}:${props.payerId}`} {...props} />;
}

function RefundPanelSession({ paymentId, payerId, onChanged }: Props) {
  const { api, operator } = usePayments();
  const { t } = useAdmin();
  const [context, setContext] = useState<Context | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [externalReference, setExternalReference] = useState('');
  const [executedAt, setExecutedAt] = useState('');
  const [verifiedHash, setVerifiedHash] = useState('');
  const [checkedEvidence, setCheckedEvidence] = useState(false);
  const [rejectionReason, setRejectionReason] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [upload, setUpload] = useState<Upload | null>(null);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [, refreshPending] = useState(0);
  const mounted = useRef(true);
  const fileGeneration = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const readSequence = useRef(0);
  const serverClock = useRef({ time: Date.parse(operator.server_time), started: performance.now() });
  const refund = context?.refund ?? null;
  const keyFor = (kind: Kind) => `refund-${kind}:${paymentId}`;
  const pendingKind = kinds.find((kind) => api.pending(keyFor(kind)));
  const pendingKey = pendingKind ? keyFor(pendingKind) : null;
  const isPayer = operator.user_id === payerId;
  const maker = operator.roles.includes('maker');
  const checker = operator.roles.includes('checker');
  const retryRoleAllowed = !isPayer && (pendingKind === 'create' ? maker
    : pendingKind === 'evidence' ? maker && refund?.maker_id === operator.user_id
      : pendingKind === 'approve' ? checker && refund?.maker_id !== operator.user_id
        : pendingKind === 'verify' || pendingKind === 'reject' ? checker && refund?.checker_id === operator.user_id && refund?.maker_id !== operator.user_id
          : Boolean(refund && [refund.maker_id, refund.checker_id].includes(operator.user_id)));

  const safeError = (cause: unknown) => {
    if (cause instanceof PaymentError) {
      if (cause.unknown) return t('操作结果尚未确认。原请求已保留，请先查询原记录，勿重复发起。', 'The outcome is unknown. The original request is retained. Query it before retrying.');
      if (cause.status === 401) return t('会话已过期，请重新登录后查询原记录。', 'Your session expired. Sign in again and query the original record.');
      if (cause.status === 403) return t('当前账号没有此操作权限，或违反付款人与复核人隔离规则。', 'This account lacks permission or violates payer/operator separation.');
      if (cause.status === 409) return t('记录、额度或凭证版本已变化，请刷新核对。未确认的原请求继续保留。', 'The record, funds, or evidence revision changed. Refresh and review; unconfirmed original requests remain retained.');
      if (cause.status === 404) return t('尚未查到对应记录。未找到不等于未执行，原请求仍保留。', 'No matching record was found. This does not prove non-execution; the original request is retained.');
      if (cause.status === 429) return t('请求过于频繁，请稍后手动查询原记录。', 'Too many requests. Query the original record manually later.');
    }
    return t('退款资料暂不可用。请核对连接后手动刷新，原请求不会自动重发。', 'Refund information is unavailable. Check the connection and refresh manually; requests are never resent automatically.');
  };
  const recoveredRefund = useCallback((value: unknown): Refund => {
    const data = object(value);
    return scopedRefund(Object.hasOwn(data, 'refund') ? data.refund : data, paymentId);
  }, [paymentId]);
  const load = useCallback(async () => {
    const sequence = ++readSequence.current;
    const result = await api.get(`${prefix}/orders/${paymentId}`, (value: unknown) => parseContext(value, paymentId, payerId));
    if (mounted.current && sequence === readSequence.current) setContext(result);
  }, [api, paymentId, payerId]);
  useEffect(() => {
    mounted.current = true;
    void load().catch(() => { if (mounted.current) setError(t('无法读取退款资料，请手动刷新。', 'Could not load refund information. Refresh manually.')); });
    return () => { mounted.current = false; fileGeneration.current += 1; readSequence.current += 1; };
  }, [load, t]);

  const label = (kind: Kind) => ({
    create: t('申请全额退款', 'Request full refund'),
    approve: t('批准外部退款', 'Approve external refund'),
    evidence: refund?.status === 'evidence_rejected' ? t('提交补正凭证', 'Submit corrected evidence') : t('上传退款凭证', 'Attach refund evidence'),
    verify: t('复核凭证并完成退款记账', 'Verify evidence and finalize refund accounting'),
    unknown: t('登记外部结果未知', 'Record unknown external outcome'),
    reject: t('退回凭证补正', 'Request evidence correction'),
  })[kind];
  function denied(kind: Kind): string {
    if (busy) return t('正在处理，请等待。', 'An operation is in progress.');
    if (!context) return t('先读取当前订单与退款记录。', 'Load the current order and refund first.');
    if (isPayer) return t('付款人不能发起、批准或核验自己的退款。', 'The payer cannot request, approve, or verify their own refund.');
    if (pendingKey) return t('存在待确认写入，先查询原记录。', 'An unresolved write exists. Query the original record first.');
    if (kind === 'create') return !maker ? t('需要初审（maker）角色。', 'Maker role required.') : refund ? t('该订单已有全额退款记录。', 'A full-refund record already exists.') : !context.verified ? t('原订单须先取得已核实的付款证据与渠道流水。', 'The original payment must have verified evidence and a provider trade reference.') : '';
    if (!refund) return t('尚无退款记录。', 'No refund exists yet.');
    if (kind === 'approve') return !checker ? t('需要复审（checker）角色。', 'Checker role required.') : refund.maker_id === operator.user_id ? t('发起人与复审人必须不同。', 'Maker and checker must be different people.') : refund.status !== 'requested' ? t('仅待批准的退款可执行此操作。', 'Only a requested refund can be approved.') : '';
    if (kind === 'evidence') return !maker || refund.maker_id !== operator.user_id ? t('仅原退款发起人且仍具 maker 角色可上传。', 'Only the original refund maker with an active maker role may attach evidence.') : !['approved_external', 'unknown', 'evidence_rejected'].includes(refund.status) ? t('须先批准外部退款，再提交实际执行凭证。', 'Approve the external refund before attaching execution evidence.') : !refund.approved_at || !context.paidAt ? t('缺少批准或原付款时间，请刷新核对。', 'Approval or original payment time is missing. Refresh and review.') : '';
    if (kind === 'verify') return !checker || refund.checker_id !== operator.user_id || refund.maker_id === operator.user_id ? t('仅原批准此退款的独立 checker 可核验凭证。', 'Only the independent checker who approved this refund may verify it.') : refund.status !== 'evidence_pending' ? t('等待原发起人提交退款凭证。', 'Await refund evidence from the original maker.') : '';
    if (kind === 'reject') return !checker || refund.checker_id !== operator.user_id || refund.maker_id === operator.user_id ? t('仅原批准此退款的独立 checker 可退回凭证。', 'Only the independent checker who approved this refund may request correction.') : refund.status !== 'evidence_pending' || !refund.evidence_sha256 ? t('只有当前待核验凭证可以退回补正。', 'Only current evidence awaiting verification may be returned for correction.') : '';
    return ![refund.maker_id, refund.checker_id].includes(operator.user_id) ? t('仅原发起人或原复审人可登记结果未知。', 'Only the original maker or checker may record an unknown outcome.') : refund.status !== 'approved_external' || !refund.approved_at || !refund.checker_id || refund.maker_id === refund.checker_id ? t('仅已批准的外部退款可登记未知结果。', 'Only an approved external refund can be marked unknown.') : '';
  }
  function clearSensitiveForm() {
    fileGeneration.current += 1;
    setUpload(null); setNotes(''); setReason(''); setExternalReference(''); setExecutedAt(''); setVerifiedHash(''); setCheckedEvidence(false); setRejectionReason('');
    if (fileInput.current) fileInput.current.value = '';
  }
  async function chooseFile(file: File | undefined) {
    const generation = ++fileGeneration.current;
    setUpload(null); setError('');
    if (!file) return;
    if (file.size < 1 || file.size > 131_072) { setError(t('凭证文件须为 1–131,072 字节（128 KiB）。', 'Evidence must contain 1–131,072 bytes (128 KiB).')); if (fileInput.current) fileInput.current.value = ''; return; }
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (const byte of data) binary += String.fromCharCode(byte);
      const base64 = btoa(binary);
      const hash = await digest(base64);
      if (mounted.current && generation === fileGeneration.current) setUpload({ name: file.name, base64, hash, size: data.length });
    } catch { if (mounted.current && generation === fileGeneration.current) setError(t('无法读取凭证文件，请重新选择。', 'Could not read the evidence file. Select it again.')); }
  }
  function prepare(kind: Kind) {
    setError(''); setNotice('');
    const restriction = denied(kind);
    if (restriction) { setError(restriction); return; }
    let body: Body;
    if (kind === 'create') {
      if (!validText(reason, 1000)) { setError(t('请填写退款原因，最多 1,000 UTF-8 字节，不含控制字符。', 'Enter a refund reason within 1,000 UTF-8 bytes, without control characters.')); return; }
      body = { client_request_id: crypto.randomUUID(), reason: reason.trim() };
    } else {
      if (!refund) return;
      body = { version: refund.version };
      if (kind === 'unknown' || kind === 'evidence') {
        if (!validText(notes, 1000)) { setError(t('请填写说明，最多 1,000 UTF-8 字节，不含控制字符。', 'Enter notes within 1,000 UTF-8 bytes, without control characters.')); return; }
        body.notes = notes.trim();
      }
      if (kind === 'evidence') {
        const time = Date.parse(executedAt);
        const serverNow = serverClock.current.time + performance.now() - serverClock.current.started;
        if (!upload || !validText(externalReference, 200) || !Number.isFinite(time) || !Number.isFinite(serverNow) || !context?.paidAt || !refund.approved_at || time < Date.parse(context.paidAt) || time < Date.parse(refund.approved_at) || time > serverNow) {
          setError(t('请提供有效凭证、最多 200 字节的外部流水号，以及原付款与退款批准之后、当前服务端时间之前的执行时间。', 'Provide evidence, an external reference within 200 bytes, and an execution time after both the original payment and refund approval, and before current server time.')); return;
        }
        Object.assign(body, { evidence_base64: upload.base64, external_reference: externalReference.trim(), executed_at: new Date(time).toISOString() });
      }
      if (kind === 'verify') {
        if (!checkedEvidence || !refund.evidence_sha256 || verifiedHash.trim().toLowerCase() !== refund.evidence_sha256.toLowerCase()) { setError(t('请独立核对凭证，并填写与当前凭证一致的 SHA-256。', 'Independently verify the evidence and enter its current matching SHA-256.')); return; }
        body.evidence_sha256 = refund.evidence_sha256;
      }
      if (kind === 'reject') {
        if (!refund.evidence_sha256 || !validText(rejectionReason, 1000)) { setError(t('请填写补正原因，最多 1,000 UTF-8 字节，不含控制字符。', 'Enter a correction reason within 1,000 UTF-8 bytes, without control characters.')); return; }
        Object.assign(body, { evidence_sha256: refund.evidence_sha256, reason: rejectionReason.trim() });
      }
    }
    setPrepared({ kind, key: keyFor(kind), body, path: kind === 'create' ? `${prefix}/orders/${paymentId}/refunds` : `${prefix}/refunds/${refund!.refund_id}/${kind === 'reject' ? 'evidence-rejections' : kind}`, recoveryPath: kind === 'create' ? `${prefix}/orders/${paymentId}` : `${prefix}/refunds/${refund!.refund_id}`, ...(kind === 'evidence' && upload ? { evidenceHash: upload.hash, evidenceName: upload.name } : {}), ...(['reject', 'verify'].includes(kind) && refund?.evidence_version ? { recoveryIdentity: { evidence_version: refund.evidence_version } } : {}), ...(kind === 'unknown' && refund?.checker_id ? { recoveryIdentity: { maker_id: refund.maker_id, checker_id: refund.checker_id } } : {}) });
  }

  async function submit() {
    if (!prepared || busy || !context) return;
    const command = prepared;
    setBusy(true); setError(''); setNotice('');
    try {
      // Evidence hashes are computed while selecting the file (or retained in the original
      // pending request). Keep this parser synchronous so validation precedes recovery cleanup.
      const parseResult = (value: unknown) => validateRefundWriteResult(recoveredRefund(value), {
        kind: command.kind, path: command.path, paymentId, actor: operator.user_id, body: command.body,
        payMinor: context.payMinor, creditMinor: context.creditMinor, evidenceHash: command.evidenceHash,
        evidenceVersion: typeof command.recoveryIdentity?.evidence_version === 'number' ? command.recoveryIdentity.evidence_version : undefined,
        makerId: typeof command.recoveryIdentity?.maker_id === 'string' ? command.recoveryIdentity.maker_id : undefined,
        checkerId: typeof command.recoveryIdentity?.checker_id === 'string' ? command.recoveryIdentity.checker_id : undefined,
      });
      const result = command.retry
        ? await api.retry(command.key, parseResult)
        : await api.mutate(command.key, command.path, command.body, parseResult, command.recoveryPath, command.recoveryIdentity);
      if (!mounted.current) return;
      setContext((current) => current ? { ...current, refund: result } : current);
      setNotice(t('服务端已返回退款记录；外部退款不会由此页面自动执行。', 'The server returned the refund record. This page never automatically executes a provider refund.'));
      onChanged();
    } catch (cause) { if (mounted.current) setError(safeError(cause)); }
    finally {
      if (mounted.current) { setBusy(false); setPrepared(null); clearSensitiveForm(); refreshPending((value) => value + 1); }
    }
  }
  async function refresh() {
    if (busy) return;
    setBusy(true); setError('');
    try { await load(); } catch (cause) { if (mounted.current) setError(safeError(cause)); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function findOriginalRejection(result: Refund, identity: Record<string, unknown>): Promise<{ confirmed: boolean; bounded: boolean }> {
    const expected = identity.evidence_version;
    if (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 1 || typeof identity.evidence_sha256 !== 'string' || result.checker_id !== operator.user_id) return { confirmed: false, bounded: false };
    let cursor: string | null = null;
    let scanned = 0;
    const visited = new Set<string>();
    for (let page = 0; page < 10 && scanned < 200; page++) {
      if (!mounted.current) return { confirmed: false, bounded: false };
      const limit = Math.min(20, 200 - scanned);
      const history: EvidencePage = await api.get(`${prefix}/refunds/${result.refund_id}/evidence?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, parseEvidencePage);
      if (!mounted.current) return { confirmed: false, bounded: false };
      if (history.items.length > limit) throw new Error('Evidence history limit exceeded');
      scanned += history.items.length;
      const original = history.items.find((entry) => entry.evidence_version === expected);
      if (original) return { confirmed: original.rejected_by === operator.user_id && original.evidence_sha256 === identity.evidence_sha256 && original.rejected_at !== null && (identity.reason === undefined || original.rejection_reason === identity.reason), bounded: false };
      if (history.next_cursor === null) return { confirmed: false, bounded: false };
      if (history.items.length === 0 || visited.has(history.next_cursor)) throw new Error('Invalid evidence history cursor');
      visited.add(history.next_cursor); cursor = history.next_cursor;
    }
    return { confirmed: false, bounded: true };
  }
  async function queryOriginal() {
    if (!pendingKey || !pendingKind || busy || !context) return;
    const key = pendingKey;
    const kind = pendingKind;
    const pending = api.pending(key);
    if (!pending) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api.recover(key, (value: unknown): Refund | null => {
        const data = object(value);
        if (Object.hasOwn(data, 'refund') && data.refund === null) {
          if (object(data.order).payment_id !== paymentId) throw new Error('Refund scope mismatch');
          return null;
        }
        const result = recoveredRefund(value);
        if (result.pay_amount_minor_cny !== context.payMinor || result.credit_amount_minor_hkd !== context.creditMinor) throw new Error('Refund amount mismatch');
        if (kind !== 'create' && pending.recoveryPath !== `${prefix}/refunds/${result.refund_id}`) throw new Error('Refund target mismatch');
        return result;
      });
      if (!mounted.current) return;
      if (result) setContext((current) => current ? { ...current, refund: result } : current);
      const identity: Record<string, unknown> = { ...object(pending.body), ...pending.proofs };
      let confirmed = Boolean(result && await matches(kind, identity, result, operator.user_id));
      let bounded = false;
      if (!confirmed && kind === 'reject' && result && typeof identity.version === 'number' && result.version > identity.version) {
        const history = await findOriginalRejection(result, identity);
        confirmed = history.confirmed; bounded = history.bounded;
      }
      if (!mounted.current) return;
      if (confirmed) {
        await api.clearPending(key);
        if (!mounted.current) return;
        setNotice(t('已按原请求确认结果，未重新执行。', 'The original request outcome is confirmed. Nothing was executed again.'));
        onChanged();
      } else setNotice(bounded
        ? t('已达到本次历史查询上限（最多 200 条、10 页），仍未核实原退回。保留待确认引用，请授权运维人工核查，不要重新退回或执行退款。', 'The history lookup reached its limit of 200 records or 10 pages without confirming the original rejection. The pending reference is retained. Ask authorized operations staff to reconcile it; do not repeat the rejection or refund.')
        : t('尚未确认原写入结果。保留原引用；仅原载荷仍在内存时，才可明确重试同一请求。', 'The original write is not yet confirmed. Keep its reference; retry the same request explicitly only while the original payload remains in memory.'));
    } catch (cause) {
      if (mounted.current) setError(safeError(cause));
    } finally { if (mounted.current) { setBusy(false); refreshPending((value) => value + 1); } }
  }
  function prepareRetry() {
    if (!pendingKey || !pendingKind || busy || !retryRoleAllowed) return;
    const pending = api.pending(pendingKey);
    if (!pending || !pending.replayable || !pending.queried) return;
    const raw = object(pending.body);
    const body: Body = {};
    for (const [key, value] of Object.entries(raw)) if (typeof value === 'string' || typeof value === 'number') body[key] = value;
    setPrepared({ kind: pendingKind, key: pendingKey, path: pending.path, body, recoveryPath: pending.recoveryPath, retry: true, evidenceHash: typeof pending.proofs?.evidence_sha256 === 'string' ? pending.proofs.evidence_sha256 : undefined, recoveryIdentity: pending.proofs });
  }
  async function download(version?: number) {
    if (!refund?.evidence_sha256 || busy) return;
    const chosenVersion = version ?? refund.evidence_version;
    if (chosenVersion === null || !Number.isSafeInteger(chosenVersion) || chosenVersion < 1) { setError(t('凭证版本无效，请刷新核对。', 'Invalid evidence version. Refresh and review.')); return; }
    setBusy(true); setError('');
    try { await api.download(`${prefix}/refunds/${refund.refund_id}/document?version=${chosenVersion}`, `refund-evidence-${refund.refund_id}${version === undefined ? '' : `-v${version}`}.bin`); }
    catch (cause) { if (mounted.current) setError(safeError(cause)); }
    finally { if (mounted.current) setBusy(false); }
  }
  const money = (minor: number, currency: 'CNY' | 'HKD') => `${currency} ${BigInt(minor) / 100n}.${String(BigInt(minor) % 100n).padStart(2, '0')}`;
  const pending = pendingKey ? api.pending(pendingKey) : undefined;
  const statusNames: Record<string, string> = { requested: t('等待独立复审批准', 'Awaiting independent approval'), approved_external: t('已批准，等待外部执行凭证', 'Approved; awaiting external execution evidence'), unknown: t('外部结果未知', 'External outcome unknown'), evidence_pending: t('凭证待原复审人核验', 'Evidence awaiting original checker verification'), evidence_rejected: t('凭证已退回，等待原发起人补正', 'Evidence returned; awaiting correction by the original maker'), refunded: t('凭证已核验，退款记账完成', 'Evidence verified; refund accounting completed') };
  const auditNames: Record<string, string> = { refund_requested: t('申请退款', 'Refund requested'), refund_external_approved: t('批准外部退款', 'External refund approved'), refund_result_unknown: t('登记外部结果未知', 'External result marked unknown'), refund_evidence_attached: t('提交退款凭证', 'Refund evidence attached'), refund_evidence_correction_requested: t('退回凭证补正', 'Evidence correction requested'), refund_external_verified: t('核验退款凭证', 'Refund evidence verified') };
  const actionButton = (kind: Kind) => <div key={kind}><button type="button" className="button secondary" disabled={Boolean(denied(kind))} onClick={() => prepare(kind)}>{label(kind)}</button>{denied(kind) && <small>{denied(kind)}</small>}</div>;

  return <section className="panel pay-detail" aria-label={t('外部全额退款', 'External full refund')}>
    <h2>{t('外部全额退款', 'External full refund')}</h2>
    <p>{t('付款人、发起人和复审人须为三名独立人员。该流程只记录外部全额退款与凭证，不调用渠道退款；没有部分退款、强制成功或直接修改余额入口。', 'The payer, maker, and checker must be three independent people. This workflow records externally executed full refunds and evidence; it never calls provider refunds or offers partial refunds, forced success, or balance editing.')}</p>
    <button type="button" className="button secondary" disabled={busy} onClick={() => void refresh()}>{t('刷新退款记录', 'Refresh refund record')}</button>
    {busy && <p role="status">{t('读取或提交中…', 'Loading or submitting…')}</p>}
    {error && <p role="alert" className="pay-error">{error}</p>}
    {notice && <p role="status" className="pay-notice">{notice}</p>}
    {pending && <aside className="pay-notice" aria-label={t('退款待确认请求', 'Pending refund request')}>
      <h3>{t('待确认写入：', 'Unconfirmed write: ')}{label(pendingKind!)}</h3>
      <p>{t('先查询原记录；超时、401 或服务异常均不能作为退款失败或成功的依据。', 'Query the original record first. Timeout, 401, or service errors do not prove refund failure or success.')}</p>
      <p><code>{pendingKey}</code></p>
      <div className="form-actions"><button type="button" className="button secondary" disabled={busy || !context} onClick={() => void queryOriginal()}>{t('查询原退款记录', 'Query original refund record')}</button><button type="button" className="button secondary" disabled={busy || !retryRoleAllowed || !pending.replayable || !pending.queried} onClick={prepareRetry}>{t('按原载荷重试', 'Retry original payload')}</button></div>
      {!retryRoleAllowed && <p>{t('当前角色或人员隔离条件不允许重试；仍可读取原记录。', 'Current role or separation-of-duties rules prevent retrying. You can still read the original record.')}</p>}
      {!pending.replayable && <p>{t('本次内存已没有完整原载荷，仅保留非秘密恢复引用。不能重建新请求；请继续查询或交由授权运维核实。', 'The complete original payload is no longer in memory; only non-secret recovery references remain. Do not create a replacement request. Continue querying or ask authorized operations staff to reconcile it.')}</p>}
    </aside>}
    {context && <>
      <dl className="facts"><div><dt>{t('付款订单', 'Payment')}</dt><dd>{paymentId}</dd></div><div><dt>{t('付款人', 'Payer')}</dt><dd>{payerId}</dd></div><div><dt>{t('原订单全额 CNY', 'Full original CNY amount')}</dt><dd>{money(refund?.pay_amount_minor_cny ?? context.payMinor, 'CNY')}</dd></div><div><dt>{t('对应入账 HKD', 'Corresponding HKD credit')}</dt><dd>{money(refund?.credit_amount_minor_hkd ?? context.creditMinor, 'HKD')}</dd></div><div><dt>{t('冻结 HKD', 'Frozen HKD')}</dt><dd>{refund ? money(refund.frozen_minor_hkd, 'HKD') : t('申请后由服务端计算', 'Calculated by the server on request')}</dd></div></dl>
      {!refund ? <><label className="field">{t('退款原因（最多 1,000 字节）', 'Refund reason (up to 1,000 bytes)')}<textarea value={reason} disabled={busy || Boolean(pendingKey)} onChange={(event) => setReason(event.target.value)} maxLength={1000}/><small>{bytes(reason)}/1000 UTF-8 bytes</small></label>{actionButton('create')}</> : <>
        <p role="status">{statusNames[refund.status] ?? t('未识别状态，请刷新核对', 'Unrecognized state; refresh and review')}</p>
        <dl className="facts">{[[t('退款编号', 'Refund ID'), refund.refund_id], [t('原请求编号', 'Original request ID'), refund.client_request_id], [t('版本', 'Version'), String(refund.version)], [t('退款原因', 'Refund reason'), refund.reason], [t('发起人', 'Maker'), refund.maker_id], [t('原复审人', 'Original checker'), refund.checker_id ?? '—'], [t('批准时间', 'Approved at'), refund.approved_at ?? '—'], [t('原付款时间', 'Original payment time'), context.paidAt ?? '—'], [t('外部流水', 'External reference'), refund.external_reference ?? '—'], [t('执行时间', 'Executed at'), refund.executed_at ?? '—'], [t('退款专用说明', 'Refund-specific notes'), refund.notes ?? '—'], ['SHA-256', refund.evidence_sha256 ?? '—'], [t('核验人', 'Verified by'), refund.verified_by ?? '—'], [t('更新于', 'Updated at'), refund.updated_at]].map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>
        <dl className="facts"><div><dt>{t('当前凭证版本', 'Current evidence version')}</dt><dd>{refund.evidence_version ?? '—'}</dd></div><div><dt>{t('当前补正原因', 'Current correction reason')}</dt><dd>{refund.rejection_reason ?? '—'}</dd></div></dl>
        {refund.status === 'requested' && actionButton('approve')}
        {refund.status === 'evidence_rejected' && <p className="pay-notice">{t('仅补正凭证，不要再次执行外部退款。冻结保持；新凭证版本仍须由原复审人核验，退回不等于退款失败。', 'Correct the evidence only; do not execute the external refund again. Funds remain frozen. The new evidence version still needs the original checker; a correction request does not mean the refund failed.')}</p>}
        {['approved_external', 'unknown', 'evidence_rejected'].includes(refund.status) && <>
          <label className="field">{t('外部执行说明（最多 1,000 字节）', 'External execution notes (up to 1,000 bytes)')}<textarea value={notes} disabled={busy || Boolean(pendingKey) || isPayer} maxLength={1000} onChange={(event) => setNotes(event.target.value)}/><small>{bytes(notes)}/1000 UTF-8 bytes</small></label>
          {refund.status === 'approved_external' && actionButton('unknown')}
          <fieldset disabled={Boolean(denied('evidence'))}><legend>{t('原发起人提交外部退款凭证', 'Original maker submits external refund evidence')}</legend>
            <label className="field">{t('凭证文件（最多 128 KiB）', 'Evidence file (up to 128 KiB)')}<input ref={fileInput} type="file" onChange={(event) => void chooseFile(event.target.files?.[0])}/></label>
            {upload && <p>{upload.name} · {upload.size} bytes<br/><code className="pay-hash">SHA-256 {upload.hash}</code></p>}
            <label className="field">{t('外部退款流水（最多 200 字节）', 'External refund reference (up to 200 bytes)')}<input value={externalReference} maxLength={200} onChange={(event) => setExternalReference(event.target.value)}/></label>
            <label className="field">{t('实际执行时间（本机时区）', 'Actual execution time (device time zone)')}<input type="datetime-local" value={executedAt} onChange={(event) => setExecutedAt(event.target.value)}/></label>
          </fieldset>{actionButton('evidence')}
        </>}
        {refund.evidence_sha256 && <button type="button" className="button secondary" disabled={busy} onClick={() => void download()}>{t('下载原凭证核对', 'Download original evidence')}</button>}
        {refund.status === 'evidence_pending' && <><fieldset disabled={Boolean(denied('verify'))}><legend>{t('原复审人独立核验', 'Independent verification by the original checker')}</legend><p>{t('请在渠道或银行独立核对执行事实。文件哈希只证明文件一致，不能证明退款实际成功。', 'Independently verify execution with the provider or bank. A file hash proves file consistency, not actual refund success.')}</p><label className="field">{t('核对 SHA-256', 'Verified SHA-256')}<input value={verifiedHash} maxLength={64} autoComplete="off" onChange={(event) => setVerifiedHash(event.target.value)}/></label><label><input type="checkbox" checked={checkedEvidence} onChange={(event) => setCheckedEvidence(event.target.checked)}/>{t('已独立核对全额、流水、执行时间与原凭证', 'I independently checked the full amount, reference, execution time, and original evidence')}</label></fieldset>{actionButton('verify')}</>}
        {refund.status === 'evidence_pending' && <><fieldset disabled={Boolean(denied('reject'))}><legend>{t('退回当前凭证补正', 'Return current evidence for correction')}</legend><label className="field">{t('补正原因（最多 1,000 字节）', 'Correction reason (up to 1,000 bytes)')}<textarea value={rejectionReason} maxLength={1000} onChange={(event) => setRejectionReason(event.target.value)}/><small>{bytes(rejectionReason)}/1000 UTF-8 bytes</small></label></fieldset>{actionButton('reject')}</>}
        <button type="button" className="button secondary" disabled={busy} aria-expanded={historyOpen} onClick={() => setHistoryOpen((value) => !value)}>{historyOpen ? t('收起凭证历史', 'Hide evidence history') : t('查看凭证历史', 'View evidence history')}</button>
        {historyOpen && <RefundEvidenceHistory key={`${refund.refund_id}:${refund.evidence_version ?? 0}:${refund.version}`} refundId={refund.refund_id} disabled={busy} download={(version) => void download(version)}/>}
        {refund.status === 'refunded' && <p>{t('此记录只读。凭证核验和相应冲正由服务端完成，不允许再次退款；冻结金额以当前服务端退款记录为准。', 'This record is read-only. Evidence verification and the corresponding reversal were handled by the server; another refund is not allowed. The frozen amount follows the current server refund record.')}</p>}
      </>}
      <h3>{t('退款操作记录', 'Refund audit records')}</h3><p>{t('显示当前订单返回的退款审计元数据，不展示自由文本财务说明或凭证正文。', 'Shows refund audit metadata returned for this order, not free-form financial notes or evidence content.')}</p><ul>{context.audit.map((entry) => <li key={entry.id}>{entry.time} · {auditNames[entry.action] ?? t('退款操作', 'Refund action')} · {entry.actor}</li>)}</ul>
    </>}
    {prepared && <PaymentConfirm title={`${prepared.retry ? t('确认按原载荷重试：', 'Confirm original-payload retry: ') : t('确认：', 'Confirm: ')}${label(prepared.kind)}`} busy={busy} onConfirm={() => void submit()} onCancel={() => { setPrepared(null); }}>
      <p>{t('付款订单', 'Payment')}: {paymentId}</p><p>{t('操作账号', 'Operator')}: {operator.user_id}</p>
      {context && <p>{money(refund?.pay_amount_minor_cny ?? context.payMinor, 'CNY')} / {money(refund?.credit_amount_minor_hkd ?? context.creditMinor, 'HKD')}</p>}
      <p>{t('原请求 / 版本', 'Original request / version')}: {prepared.body.client_request_id ?? prepared.body.version}</p>
      {prepared.kind === 'create' && <p>{t('仅全额退款。原订单若已入账，申请将冻结对应 HKD 可用额度；不会自动向渠道退款。', 'Full refund only. If the order was credited, this request freezes the corresponding available HKD; it does not issue a provider refund.')}</p>}
      {prepared.kind === 'approve' && <p>{t('批准后仍须由原发起人在外部渠道完成退款并提交凭证；批准本身不移动渠道资金。', 'The original maker must execute the refund externally and submit evidence. Approval itself moves no provider funds.')}</p>}
      {prepared.kind === 'evidence' && <><p>{t('外部流水', 'External reference')}: {prepared.body.external_reference}</p><p>{t('执行时间（UTC）', 'Execution time (UTC)')}: {prepared.body.executed_at}</p><p>{t('上传只提交凭证，尚未核验或完成退款记账。', 'Uploading attaches evidence; it does not verify it or finalize refund accounting.')}</p></>}
      {prepared.kind === 'evidence' && prepared.evidenceHash && <><p>{prepared.evidenceName ?? t('原请求凭证', 'Original request evidence')}</p><code className="pay-hash">SHA-256 {prepared.evidenceHash}</code></>}
      {prepared.kind === 'evidence' && refund?.status === 'evidence_rejected' && <p>{t('这次仅追加补正凭证版本，不重新执行外部退款，不释放冻结。', 'This only appends corrected evidence. It does not execute another external refund or release frozen funds.')}</p>}
      {prepared.kind === 'reject' && <><p>{t('当前凭证版本', 'Current evidence version')}: {prepared.recoveryIdentity?.evidence_version ?? prepared.body.evidence_version}</p><code className="pay-hash">{prepared.body.evidence_sha256}</code><p>{t('补正原因', 'Correction reason')}: {prepared.body.reason}</p><p>{t('只退回凭证，保留冻结与历史版本。原发起人须补正证据，不能再次执行外部退款。', 'Return evidence only. Frozen funds and historical versions are retained. The original maker must correct evidence, never repeat the external refund.')}</p></>}
      {prepared.kind === 'verify' && <><p>{t('当前凭证版本', 'Current evidence version')}: {prepared.recoveryIdentity?.evidence_version ?? t('未保留，不能确认', 'Not retained; cannot confirm')}</p><code className="pay-hash">{prepared.body.evidence_sha256}</code><p>{t('确认将完成退款记录；原订单已入账时，服务端将执行对应 HKD 冲正。请确认这是已独立核实的外部退款。', 'Confirmation finalizes the refund record and reverses the corresponding HKD credit when applicable. Confirm that the external refund was independently verified.')}</p></>}
      {prepared.kind === 'unknown' && <p>{t('仅登记外部结果未知，不释放冻结、不重试渠道退款。', 'Records an unknown external result only; does not release frozen funds or retry the provider refund.')}</p>}
    </PaymentConfirm>}
  </section>;
}
