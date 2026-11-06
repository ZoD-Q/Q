import { useEffect, useRef, useState } from 'react';
import { useAdmin } from '../state';
import { PaymentError, type Pending } from './api';
import { PaymentConfirm, errorMessage } from './controls';
import { usePayments } from './session';
import { parseSettlement, parseSettlementPage, type Settlement } from './types';
import { prepareSettlement, parseMinorAmount, parseSettlementChecks, hasRecheckEvidence, SettlementFileError, type SettlementCheck, type PreparedSettlement, type SettlementKind, type SourceMedia } from './settlement-files';

const base = '/v1/payments/operator/settlements';
const importKey = 'settlement-import';
type VersionedSettlement = Settlement & { check_version: number };
type Confirmation = { kind: 'import'; value: PreparedSettlement } | { kind: 'verify'; value: VersionedSettlement } | { kind: 'recheck'; value: VersionedSettlement } | { kind: 'retry'; key: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validate(value: unknown): VersionedSettlement {
  const result = parseSettlement(value);
  if (!('check_version' in result) || typeof result.check_version !== 'number' || !Number.isSafeInteger(result.check_version) || result.check_version < 1) throw Error('INVALID_RESPONSE');
  if (!uuid.test(result.settlement_id) || !uuid.test(result.client_request_id) || !uuid.test(result.maker_id)
    || !/^[0-9a-f]{64}$/.test(result.mapping_sha256) || !/^[0-9a-f]{64}$/.test(result.evidence_sha256)
    || !['order_reconciliation', 'bank_settlement', 'hkd_reserve'].includes(result.kind)
    || !['CNY', 'HKD'].includes(result.currency) || !['awaiting_verification', 'discrepancy', 'operator_verified'].includes(result.status)
    || result.source_validation !== 'operator_supplied' || result.record_count < 0 || result.record_count > 200
    || result.matched_count < 0 || result.matched_count > result.record_count) throw Error('INVALID_RESPONSE');
  for (const item of result.differences) difference(item);
  return result as VersionedSettlement;
}
function difference(value: unknown): { row: number; code: string } {
  if (!value || typeof value !== 'object' || !('row' in value) || !('code' in value)
    || typeof value.row !== 'number' || !Number.isSafeInteger(value.row) || value.row < 0 || value.row > 200
    || typeof value.code !== 'string' || !/^[A-Z0-9_]{1,80}$/.test(value.code)) throw Error('INVALID_RESPONSE');
  return { row: value.row, code: value.code };
}
function bodyOf(pending: Pending): Record<string, unknown> {
  const payload = pending.body && typeof pending.body === 'object' && !Array.isArray(pending.body) ? pending.body as Record<string, unknown> : {};
  return { ...pending.proofs, ...payload };
}
export function SettlementPanel() {
  const { epoch, operator } = usePayments();
  return <SettlementSession key={`${epoch}:${operator.user_id}`}/>;
}
function SettlementSession() {
  const { api, operator } = usePayments(); const { t } = useAdmin();
  const text = useRef(t); text.current = t;
  const mounted = useRef(true); const locked = useRef(false); const listGeneration = useRef(0);
  const [items, setItems] = useState<VersionedSettlement[]>([]); const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<VersionedSettlement | null>(null);
  const detailsId = useRef(''); const [checks, setChecks] = useState<SettlementCheck[]>([]);
  const [checkCursor, setCheckCursor] = useState<string | null>(null); const [detailFresh, setDetailFresh] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [kind, setKind] = useState<SettlementKind>('order_reconciliation'); const [source, setSource] = useState('');
  const [media, setMedia] = useState<SourceMedia>('application/pdf'); const [bankReference, setBankReference] = useState(''); const [bankAmount, setBankAmount] = useState('');
  const [mappingFile, setMappingFile] = useState<File | null>(null); const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [checked, setChecked] = useState(false); const [fileVersion, setFileVersion] = useState(0);
  const maker = operator.roles.includes('maker'); const checker = operator.roles.includes('checker');
  const pending = api.pendingList().filter((item) => item.key === importKey || item.key.startsWith('settlement-verify:') || item.key.startsWith('settlement-recheck:'));
  function safeError(cause: unknown) {
    if (cause instanceof SettlementFileError) return t('文件未通过校验：请检查大小、严格 JSON、唯一引用、整数分金额与原 PDF/UTF-8 CSV。', 'Files failed validation. Check size, strict JSON, unique references, integer minor amounts and original PDF/UTF-8 CSV.');
    if (cause instanceof PaymentError && cause.status === 404) return t('尚未查到原记录。404 不证明未执行；原请求继续保留，请核对恢复接口是否已部署。', 'Original record not found. A 404 does not prove non-execution. The request stays retained; check recovery endpoint availability.');
    return errorMessage(cause, t);
  }
  async function run(work: () => Promise<void>) {
    if (locked.current) return; locked.current = true; setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (cause) { if (mounted.current) setError(safeError(cause)); }
    finally { locked.current = false; if (mounted.current) setBusy(false); }
  }
  async function list(next: string | null) {
    const generation = ++listGeneration.current;
    const page = await api.get(`${base}?limit=20${next ? `&cursor=${encodeURIComponent(next)}` : ''}`, (value) => {
      const parsed = parseSettlementPage(value); return { ...parsed, items: parsed.items.map(validate) };
    });
    if (mounted.current && generation === listGeneration.current) { setItems((old) => next ? [...old, ...page.items.filter((item) => !old.some((entry) => entry.settlement_id === item.settlement_id))] : page.items); setCursor(page.next_cursor); }
  }
  function update(result: VersionedSettlement, fresh = true) { if (mounted.current) { listGeneration.current++; if (detailsId.current !== result.settlement_id) { setChecks([]); setCheckCursor(null); } detailsId.current = result.settlement_id; setSelected(result); setDetailFresh(fresh); setChecked(false); setItems((old) => [result, ...old.filter((item) => item.settlement_id !== result.settlement_id)]); } }
  async function loadChecks(id: string, next: string | null = null) {
    const page = await api.get(`${base}/${id}/checks?limit=20${next ? `&cursor=${encodeURIComponent(next)}` : ''}`, parseSettlementChecks);
    if (mounted.current && detailsId.current === id) { setChecks((old) => next ? [...old, ...page.items.filter((item) => !old.some((entry) => entry.check_version === item.check_version))] : page.items); setCheckCursor(page.next_cursor); }
    return page;
  }
  async function openDetail(id: string) {
    const result = await api.get(`${base}/${id}`, (value) => { const item = validate(value); if (item.settlement_id !== id) throw Error('SCOPE_MISMATCH'); return item; });
    update(result); await loadChecks(id);
  }
  useEffect(() => {
    mounted.current = true; let cancelled = false; const generation = ++listGeneration.current;
    void api.get(`${base}?limit=20`, (value) => { const page = parseSettlementPage(value); return { ...page, items: page.items.map(validate) }; }).then((page) => {
      if (!cancelled && mounted.current && generation === listGeneration.current) { setItems(page.items); setCursor(page.next_cursor); }
    }).catch(() => { if (!cancelled && mounted.current && generation === listGeneration.current) setError(text.current('无法读取结算列表，请手动刷新。', 'Could not load settlements. Refresh manually.')); });
    return () => { cancelled = true; mounted.current = false; };
  }, [api]);
  function clearFiles() { setMappingFile(null); setSourceFile(null); setFileVersion((value) => value + 1); }
  async function prepareImport() {
    if (!mappingFile || !sourceFile || !maker || api.pending(importKey)) throw new SettlementFileError('document');
    const value = await prepareSettlement({ mappingFile, sourceFile, kind, source, media,
      bankReference: kind === 'order_reconciliation' ? null : bankReference,
      bankAmount: kind === 'order_reconciliation' ? null : parseMinorAmount(bankAmount, kind === 'bank_settlement' ? 'signed' : 'positive'), requestId: crypto.randomUUID() });
    if (mounted.current) setConfirmation({ kind: 'import', value });
  }
  async function recover(record: Pending) {
    const result = await api.recover(record.key, validate); const original = bodyOf(record);
    if (record.key.startsWith('settlement-recheck:')) {
      const id = record.key.slice('settlement-recheck:'.length);
      if (typeof original.check_version !== 'number' || !Number.isSafeInteger(original.check_version) || original.check_version < 1
        || typeof original.evidence_sha256 !== 'string' || typeof original.mapping_sha256 !== 'string'
        || result.settlement_id !== id || result.evidence_sha256 !== original.evidence_sha256 || result.mapping_sha256 !== original.mapping_sha256) throw Error('RECOVERY_MISMATCH');
      const known = detailsId.current === id ? checks : [];
      update(result, false); const page = await loadChecks(id);
      if (!hasRecheckEvidence({ settlement_id: id, check_version: original.check_version, evidence_sha256: original.evidence_sha256, mapping_sha256: original.mapping_sha256 }, result, [...known, ...page.items], operator.user_id)) {
        if (mounted.current) setNotice(t('尚未定位原材料上由本账号新增的核对版本；原请求保留。可继续读取历史并查询，不能重发重核请求。', 'No later check by this account was located for the original evidence. The request stays retained. Read more history and query again; do not repeat the recheck POST.')); return;
      }
      await api.clearPending(record.key);
      if (mounted.current) setNotice(t('已找到原材料上的后续核对记录，没有重复重核。请刷新后再开始独立核材。', 'A later check of the original evidence was found without another recheck. Refresh before independent attestation.'));
      return;
    } else if (record.key === importKey) {
      if (result.client_request_id !== original.client_request_id || result.maker_id !== operator.user_id) throw Error('RECOVERY_MISMATCH');
      if ((typeof original.evidence_sha256 === 'string' && result.evidence_sha256 !== original.evidence_sha256) || (typeof original.mapping_sha256 === 'string' && result.mapping_sha256 !== original.mapping_sha256)) throw Error('RECOVERY_MISMATCH');
      if (typeof original.evidence_base64 === 'string' && typeof original.source_document_base64 === 'string') {
        const digest = async (encoded: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)))), (byte) => byte.toString(16).padStart(2, '0')).join('');
        if (result.mapping_sha256 !== await digest(original.evidence_base64) || result.evidence_sha256 !== await digest(original.source_document_base64)
          || result.kind !== original.kind || result.source !== original.source || result.bank_reference !== original.bank_reference || result.bank_amount_minor !== original.bank_amount_minor) throw Error('RECOVERY_MISMATCH');
      }
    } else if (result.settlement_id !== record.key.slice('settlement-verify:'.length)
      || result.mapping_sha256 !== original.mapping_sha256 || result.evidence_sha256 !== original.evidence_sha256) throw Error('RECOVERY_MISMATCH');
    else if (result.status !== 'operator_verified' || result.checker_id !== operator.user_id) {
      update(result); if (mounted.current) setNotice(t('原批次可读取，但尚不能确认本次核材已完成；原请求保留。', 'The original batch is readable, but this attestation is not confirmed. Its request remains retained.')); return;
    }
    await api.clearPending(record.key); update(result);
    if (mounted.current) { clearFiles(); setNotice(t('已查询到匹配的原记录，没有重复提交。', 'The matching original record was recovered without resubmission.')); }
  }
  async function submit() {
    const target = confirmation; if (!target) return;
    try {
      let result: VersionedSettlement;
      if (target.kind === 'import') {
        const prepared = target.value;
        result = await api.mutate(importKey, base, prepared.body, (value) => {
          const item = validate(value);
          if (item.client_request_id !== prepared.body.client_request_id || item.maker_id !== operator.user_id
            || item.mapping_sha256 !== prepared.mappingHash || item.evidence_sha256 !== prepared.evidenceHash) throw Error('IMPORT_MISMATCH');
          return item;
        }, `${base}/by-client-key/${prepared.body.client_request_id}`);
      } else if (target.kind === 'recheck') {
        const item = target.value;
        result = await api.mutate(`settlement-recheck:${item.settlement_id}`, `${base}/${item.settlement_id}/rechecks`, {}, (value) => {
          const current = validate(value);
          if (current.settlement_id !== item.settlement_id || current.check_version <= item.check_version
            || current.mapping_sha256 !== item.mapping_sha256 || current.evidence_sha256 !== item.evidence_sha256) throw Error('RECHECK_MISMATCH');
          return current;
        }, `${base}/${item.settlement_id}`, { check_version: item.check_version, mapping_sha256: item.mapping_sha256, evidence_sha256: item.evidence_sha256 });
        update(result, false); await loadChecks(result.settlement_id);
        if (mounted.current) setNotice(t('原材料重核已记录，文件未改变。请刷新当前批次后，再由独立复审人员核材。', 'The original material was rechecked without changing its files. Refresh the batch before independent checker attestation.'));
        return;
      } else if (target.kind === 'verify') {
        const item = target.value;
        result = await api.mutate(`settlement-verify:${item.settlement_id}`, `${base}/${item.settlement_id}/verify`,
          { mapping_sha256: item.mapping_sha256, evidence_sha256: item.evidence_sha256 }, (value) => {
            const current = validate(value);
            if (current.settlement_id !== item.settlement_id || current.status !== 'operator_verified' || current.checker_id !== operator.user_id
              || current.mapping_sha256 !== item.mapping_sha256 || current.evidence_sha256 !== item.evidence_sha256) throw Error('VERIFICATION_MISMATCH');
            return current;
          }, `${base}/${item.settlement_id}`);
      } else {
        if (target.key.startsWith('settlement-recheck:')) throw Error('RECHECK_QUERY_ONLY');
        const original = api.pending(target.key); if (!original) throw Error('NO_PENDING');
        const identity = bodyOf(original);
        result = await api.retry(target.key, (value) => {
          const item = validate(value);
          if (target.key === importKey ? item.client_request_id !== identity.client_request_id || item.maker_id !== operator.user_id
            : item.settlement_id !== target.key.slice('settlement-verify:'.length) || item.status !== 'operator_verified' || item.checker_id !== operator.user_id
              || item.mapping_sha256 !== identity.mapping_sha256 || item.evidence_sha256 !== identity.evidence_sha256) throw Error('RETRY_MISMATCH');
          return item;
        });
      }
      update(result); if (mounted.current) { clearFiles(); setNotice(t('服务端已返回保存结果。人工核材不代表银行认证或换汇完成。', 'The server returned a saved result. Manual attestation does not establish bank verification or completed FX.')); }
    } finally { if (mounted.current) setConfirmation(null); }
  }
  return <section className="panel pay-panel"><h2>{t('结算与原始凭证', 'Settlements and source evidence')}</h2><p>{t('以下读取真实操作记录。人工核材不等于银行 API 核实，也不表示已经完成换汇。', 'These are live operational records. Manual evidence attestation is not bank API verification or completed foreign exchange.')}</p>{error && <p role="alert" className="pay-error">{error}</p>}{notice && <p role="status">{notice}</p>}<button className="button secondary" disabled={busy} onClick={() => void run(() => list(null))}>{t('刷新列表', 'Refresh list')}</button><div className="table-scroll"><table><thead><tr><th>{t('批次来源', 'Batch source')}</th><th>{t('类别 / 币种', 'Kind / currency')}</th><th>{t('状态', 'Status')}</th><th>{t('匹配行', 'Matched rows')}</th></tr></thead><tbody>{items.map((item) => <tr key={item.settlement_id}><td><button className="record-link" disabled={busy} onClick={() => void run(() => openDetail(item.settlement_id))}>{item.source}</button><small>{item.settlement_id}</small></td><td>{item.kind} / {item.currency}</td><td>{item.status}</td><td>{item.matched_count}/{item.record_count}</td></tr>)}</tbody></table></div>{cursor && <button className="button secondary" disabled={busy} onClick={() => void run(() => list(cursor))}>{t('下一页', 'Next page')}</button>}
    {pending.map((record) => <div className="scope-note" key={record.key}><strong>{t('原请求结果待确认', 'Original request outcome unknown')}</strong><p>{t('先查询原记录。未找到也不创建新请求；刷新后仅保留恢复引用，文件载荷不会保存在浏览器。', 'Query the original record first. A missing record does not create a new request. After reload only recovery references remain; document payloads are not stored in the browser.')}</p><code>{record.key === importKey ? String(bodyOf(record).client_request_id ?? '') : record.key.slice(record.key.indexOf(':') + 1)}</code><div className="form-actions"><button className="button secondary" disabled={busy} onClick={() => void run(() => recover(record))}>{t('查询原记录', 'Query original record')}</button>{!record.key.startsWith('settlement-recheck:') && <button className="button secondary" disabled={busy || !record.queried || !record.replayable} onClick={() => setConfirmation({ kind: 'retry', key: record.key })}>{t('手动重试原请求', 'Manually retry original request')}</button>}</div></div>)}
    <form onSubmit={(event) => { event.preventDefault(); void run(prepareImport); }}>
      <h3>{t('导入对账资料', 'Import reconciliation evidence')}</h3><p>{t('仅上传必要的规范化 JSON 和原始 PDF/CSV；不解析或预览原文。规范化文件 ≤128 KiB / 200 行，原文件 ≤256 KiB。金额均为整数分。', 'Upload only the necessary normalized JSON and original PDF/CSV. Originals are not parsed or previewed. Mapping ≤128 KiB / 200 rows; original ≤256 KiB. All amounts use integer minor units.')}</p>
      {!maker && <p>{t('当前账号不是初审人员，不能导入。', 'This account is not a maker and cannot import evidence.')}</p>}
      <fieldset disabled={busy || !maker || Boolean(api.pending(importKey))}>
        <label className="field">{t('批次类型', 'Batch kind')}<select value={kind} onChange={(event) => setKind(event.target.value as SettlementKind)}><option value="order_reconciliation">{t('CNY 订单对账', 'CNY order reconciliation')}</option><option value="bank_settlement">{t('CNY 银行结算材料', 'CNY bank settlement evidence')}</option><option value="hkd_reserve">{t('HKD 储备材料', 'HKD reserve evidence')}</option></select></label>
        <label className="field">{t('资料来源名称', 'Evidence source name')}<input required maxLength={200} value={source} onChange={(event) => setSource(event.target.value)}/></label>
        {kind !== 'order_reconciliation' && <><label className="field">{t('银行参考编号', 'Bank reference')}<input required maxLength={200} value={bankReference} onChange={(event) => setBankReference(event.target.value)}/></label><label className="field">{t('银行金额（整数最小单位）', 'Bank amount (integer minor units)')}<input required inputMode={kind === 'bank_settlement' ? 'text' : 'numeric'} pattern={kind === 'bank_settlement' ? '(0|-?[1-9][0-9]*)' : '[1-9][0-9]*'} value={bankAmount} onChange={(event) => setBankAmount(event.target.value)}/></label></>}
        <label className="field">{t('规范化 JSON 文件', 'Normalized JSON file')}<input key={`mapping-${fileVersion}`} type="file" accept=".json,application/json" required onChange={(event) => setMappingFile(event.target.files?.[0] ?? null)}/></label>
        <p>{kind === 'hkd_reserve' ? t('JSON 必须为 currency=HKD 且 rows=[]，银行金额须为正数。材料不代表储备已经由银行 API 核实。', 'JSON requires currency=HKD, rows=[] and a positive bank amount. Evidence does not establish bank API verification of reserves.') : t('JSON 包含 currency=CNY 与 rows。每行保留原 merchant_order_no、provider_trade_no、gross_minor、channel_fee_minor、net_minor。entry_kind 缺省为 payment：总额正、手续费及净额非负。refund 行必须有 refund_external_reference，总额为原 CNY 应付的负数，手续费和净额允许有符号；净额始终等于总额减手续费。同一订单可同时有支付行及退款行。银行金额允许为正、零、负，须与行净额精确一致。', 'JSON contains currency=CNY and rows with original merchant_order_no, provider_trade_no, gross_minor, channel_fee_minor and net_minor. entry_kind defaults to payment: positive gross, nonnegative fee/net. A refund requires refund_external_reference and negative original CNY payable as gross; fee/net may be signed. Net always equals gross minus fee. One order may have payment and refund rows. Bank amounts may be positive, zero or negative and must match the exact net total.')}</p>
        <details><summary>{t('查看 JSON 格式示例', 'View JSON format example')}</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(kind === 'hkd_reserve' ? { currency: 'HKD', rows: [] } : { currency: 'CNY', rows: [
          { entry_kind: 'payment', merchant_order_no: 'EXAMPLE-ORDER', provider_trade_no: 'EXAMPLE-TRADE', gross_minor: 10000, channel_fee_minor: 100, net_minor: 9900 },
          { entry_kind: 'refund', refund_external_reference: 'EXAMPLE-REFUND', merchant_order_no: 'EXAMPLE-ORDER', provider_trade_no: 'EXAMPLE-TRADE', gross_minor: -10000, channel_fee_minor: -100, net_minor: -9900 },
        ] }, null, 2)}</pre><p>{t('这是格式示例，不能作为原始凭证。退款行必须对应服务端已完成并核实的原退款及外部引用；上传材料不会执行退款、银行核实或换汇。', 'This is a format example, not source evidence. Refund rows must match the original completed and verified server refund and external reference. Uploading evidence does not execute a refund, bank verification, or FX.')}</p></details>
        <label className="field">{t('原文件类型', 'Original document type')}<select value={media} onChange={(event) => setMedia(event.target.value as SourceMedia)}><option value="application/pdf">PDF</option><option value="text/csv">UTF-8 CSV</option></select></label>
        <label className="field">{t('原始凭证文件', 'Original evidence file')}<input key={`source-${fileVersion}`} type="file" accept=".pdf,.csv,application/pdf,text/csv" required onChange={(event) => setSourceFile(event.target.files?.[0] ?? null)}/></label>
        <button className="button" type="submit">{t('校验文件并核对导入', 'Validate files and review import')}</button>
      </fieldset>
    </form>
    {selected && <article className="pay-detail"><h3>{t('结算详情', 'Settlement details')}</h3><p>{selected.source} · <code>{selected.settlement_id}</code></p><dl className="facts">
      <div><dt>{t('状态', 'Status')}</dt><dd>{selected.status === 'operator_verified' ? t('人工核材完成', 'Operator attested') : selected.status === 'discrepancy' ? t('存在对账差异', 'Reconciliation discrepancy') : t('等待独立复核', 'Awaiting independent verification')}</dd></div>
      <div><dt>{t('资料性质', 'Source validation')}</dt><dd>{t('操作人员提供；未经银行 API 验证', 'Operator supplied; not verified by a bank API')}</dd></div>
      <div><dt>{t('类别 / 币种', 'Kind / currency')}</dt><dd>{selected.kind} / {selected.currency}</dd></div>
      <div><dt>{t('银行参考编号', 'Bank reference')}</dt><dd>{selected.bank_reference ?? '—'}</dd></div>
      <div><dt>{t('银行金额（分）', 'Bank amount (minor units)')}</dt><dd>{selected.bank_amount_minor?.toString() ?? '—'}</dd></div>
      <div><dt>{t('匹配 / 总行数', 'Matched / total rows')}</dt><dd>{selected.matched_count} / {selected.record_count}</dd></div>
      <div><dt>{t('初审人员', 'Maker')}</dt><dd>{selected.maker_id}</dd></div><div><dt>{t('复审人员', 'Checker')}</dt><dd>{selected.checker_id ?? '—'}</dd></div>
      <div><dt>{t('当前核对版本', 'Current check version')}</dt><dd>{selected.check_version}</dd></div><div><dt>{t('创建时间', 'Created at')}</dt><dd>{selected.created_at}</dd></div><div><dt>{t('核材时间', 'Attested at')}</dt><dd>{selected.verified_at ?? '—'}</dd></div>
      <div><dt>Mapping SHA-256</dt><dd><code>{selected.mapping_sha256}</code></dd></div><div><dt>Source SHA-256</dt><dd><code>{selected.evidence_sha256}</code></dd></div>
    </dl><div className="form-actions"><button className="button secondary" disabled={busy} onClick={() => void run(() => api.download(`${base}/${selected.settlement_id}/document?part=mapping`, `mapping-${selected.settlement_id}.json`))}>{t('下载规范化资料', 'Download normalized mapping')}</button><button className="button secondary" disabled={busy} onClick={() => void run(() => api.download(`${base}/${selected.settlement_id}/document?part=source`, `source-${selected.settlement_id}.${selected.source_document_media_type === 'application/pdf' ? 'pdf' : 'csv'}`))}>{t('下载原始凭证', 'Download original evidence')}</button></div>
    <p>{t('文件仅作为附件下载，不在本页预览。核对文件完整性及来源后再提交人工核材。', 'Files download as attachments and are never previewed here. Verify integrity and provenance before attesting.')}</p>
    {selected.differences.length > 0 && <div role="status"><h4>{t('差异明细', 'Differences')}</h4><ul>{selected.differences.map((entry, index) => { const item = difference(entry); return <li key={`${item.row}-${index}`}>{item.row === 0 ? t('批次合计', 'Batch total') : `${t('行', 'Row')} ${item.row}`}: <code>{item.code}</code></li>; })}</ul><p>{t('差异不能强行覆盖。若原材料正确而 Q 订单状态刚更新，可按原材料重新核对；只有原材料本身需要更正时，才导入新的有效原始凭证，保留旧记录。', 'Differences cannot be overridden. If the original evidence is correct and Q order state has changed, recheck the same material. Import new evidence only to correct the source itself, retaining the old record.')}</p></div>}
    {selected.status === 'awaiting_verification' && <><p>{!checker ? t('只有复审人员可核材。', 'Only a checker may attest.') : selected.maker_id === operator.user_id ? t('不能复核自己导入的材料；需另一名有权限的复审人员。', 'You cannot attest your own import. Another authorized checker must review it.') : t('付款人不得复核本人款项。角色、材料版本与付款人隔离必须由服务端判定，页面按钮不代替授权。', 'Payers must not review their own payments. Roles, evidence versions and payer separation require server enforcement; a visible button is not authorization.')}</p>
      <label className="field"><span><input type="checkbox" checked={checked} disabled={busy || !detailFresh || !checker || selected.maker_id === operator.user_id || Boolean(api.pending(`settlement-recheck:${selected.settlement_id}`))} onChange={(event) => setChecked(event.target.checked)}/>{t('我已人工核对原文件、规范化映射及两项 SHA-256，理解这不是银行 API 认证或换汇完成。', 'I checked the original, mapping and both SHA-256 hashes, and understand this is not bank API certification or completed FX.')}</span></label>
      <button className="button" disabled={busy || !detailFresh || !checked || !checker || selected.maker_id === operator.user_id || Boolean(api.pending(`settlement-verify:${selected.settlement_id}`)) || Boolean(api.pending(`settlement-recheck:${selected.settlement_id}`))} onClick={() => setConfirmation({ kind: 'verify', value: selected })}>{t('核对后提交人工核材', 'Review and submit attestation')}</button></>}
    <section><h4>{t('按原材料重新核对', 'Recheck original material')}</h4><p>{t('重核会追加新的核对版本，不改动已保存的原文件或映射。零差异也只进入等待复核；刷新后仍需独立复审人员核材。', 'Rechecking appends a check version without changing either saved document. Zero differences only moves the batch to awaiting verification; refresh before independent checker attestation.')}</p><div className="form-actions"><button className="button secondary" disabled={busy} onClick={() => void run(() => openDetail(selected.settlement_id))}>{t('刷新批次与核对历史', 'Refresh batch and check history')}</button>{selected.status !== 'operator_verified' && <button className="button secondary" disabled={busy || (!maker && !checker) || Boolean(api.pending(`settlement-recheck:${selected.settlement_id}`)) || Boolean(api.pending(`settlement-verify:${selected.settlement_id}`))} onClick={() => setConfirmation({ kind: 'recheck', value: selected })}>{t('按原材料重新核对', 'Recheck original material')}</button>}</div>{!detailFresh && <p role="status">{t('重核结果已返回，请先刷新当前批次，再开始独立核材。', 'A recheck result was received. Refresh this batch before independent attestation.')}</p>}</section>
    <section><h4>{t('核对历史', 'Check history')}</h4>{checks.length ? <ol>{checks.map((entry) => <li key={entry.check_version}><strong>{t('版本', 'Version')} {entry.check_version}</strong> · {t('匹配行', 'Matched rows')} {entry.matched_count} · {entry.actor_id} · {entry.created_at}<ul>{entry.differences.map((item, index) => <li key={`${item.row}-${index}`}>{item.row === 0 ? t('批次合计', 'Batch total') : `${t('行', 'Row')} ${item.row}`}: <code>{item.code}</code></li>)}</ul></li>)}</ol> : <p>{t('暂无已读取的核对历史。', 'No check history has been loaded.')}</p>}{checkCursor && <button className="button secondary" disabled={busy} onClick={() => void run(async () => { await loadChecks(selected.settlement_id, checkCursor); })}>{t('更多核对历史', 'More check history')}</button>}</section>
    </article>}
    {confirmation && <PaymentConfirm title={confirmation.kind === 'import' ? t('确认导入资料', 'Confirm evidence import') : confirmation.kind === 'verify' ? t('确认人工核材', 'Confirm manual attestation') : confirmation.kind === 'recheck' ? t('确认按原材料重核', 'Confirm original-evidence recheck') : t('重试原请求', 'Retry original request')} busy={busy} onCancel={() => setConfirmation(null)} onConfirm={() => void run(submit)}>
      {confirmation.kind === 'import' ? <><p>{confirmation.value.body.source} · {confirmation.value.body.kind} · {confirmation.value.mapping.currency} · {confirmation.value.mapping.rows.length} {t('行', 'rows')}</p><p>{t('原请求编号', 'Original request ID')}: {confirmation.value.body.client_request_id}</p><p>{t('银行参考 / 银行金额（分）', 'Bank reference / amount (minor units)')}: {confirmation.value.body.bank_reference ?? '—'} / {confirmation.value.body.bank_amount_minor?.toString() ?? '—'}</p><p>{t('映射净额合计（分）', 'Mapping net total (minor units)')}: {confirmation.value.mapping.rows.reduce((sum, row) => sum + BigInt(row.net_minor), 0n).toString()} {confirmation.value.mapping.currency}</p><p>{t('规范化文件 / 原文件字节数', 'Mapping / original bytes')}: {confirmation.value.mappingBytes} / {confirmation.value.sourceBytes}</p><dl className="facts"><div><dt>Mapping SHA-256</dt><dd><code>{confirmation.value.mappingHash}</code></dd></div><div><dt>Source SHA-256</dt><dd><code>{confirmation.value.evidenceHash}</code></dd></div></dl></> : confirmation.kind === 'verify' || confirmation.kind === 'recheck' ? <><p>{confirmation.value.source} · {confirmation.value.settlement_id}</p>{confirmation.kind === 'recheck' && <p>{t('将按原始材料重新计算匹配结果并追加核对历史，不改文件、不自动通过复审；当前版本', 'Recomputes matches from the original material and appends history. Files remain unchanged and approval is not automatic. Current version')}: {confirmation.value.check_version}</p>}<p>{confirmation.kind === 'verify' ? t('仅证明另一名操作人员已人工核对这两份材料。不自动调用银行、不执行换汇、不直接修改余额。', 'Records independent manual review of these two documents only. No bank request, FX execution, or direct balance change occurs.') : t('重核只更新计算结果，不执行付款、退款、银行认证或换汇。', 'Rechecking updates calculated matches only. It performs no payment, refund, bank certification, or FX.')}</p><code>{confirmation.value.mapping_sha256}</code><br/><code>{confirmation.value.evidence_sha256}</code></> : <p>{t('仅重发查询过的同一请求与原文件载荷，不生成新编号。请先确认原查询结果。', 'Resends only the queried original request and document payload, without generating a new ID. Review its lookup result first.')}</p>}
    </PaymentConfirm>}
  </section>;
}
