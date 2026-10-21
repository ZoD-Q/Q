import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { AppState, View } from 'react-native';
import { Trash2 } from 'lucide-react-native';
import { Action, Input, Row, Sheet, Type, useDesign } from '../design';
import { useQAccount } from './account-state';
import { deletionController as controller } from './deletion-runtime';

type Translate = (zh: string, en: string) => string;
function deletionMessage(error: string, text: Translate): string {
  switch (error) {
    case 'INVALID_CREDENTIALS': return text('密码不正确。原删除请求已保留，请重新输入密码后手动重试。', 'The password is incorrect. The original request is saved; enter your password to retry manually.');
    case 'ACCOUNT_BUSY': return text('账号仍有进行中的操作，本次删除已全部撤回。请稍后检查原请求，再手动重试。', 'The account has work in progress. This deletion was rolled back. Check the original request and retry manually later.');
    case 'ACCOUNT_DELETION_NOT_FOUND': return text('未查到这笔删除的完成记录，不代表账号已经删除。', 'No completed record was found for this request. This does not mean the account was deleted.');
    case 'DELETION_ACCOUNT_CHANGED': return text('账号已变化。这里只能重试原账号的删除，不会删除当前其他账号。', 'The account changed. Only the original account can retry this request; another signed-in account will not be deleted.');
    case 'DELETION_CONFIRMATION_REQUIRED': return text('请输入当前账号密码，并完整输入 DELETE。', 'Enter the current account password and type DELETE exactly.');
    case 'DELETION_PENDING': return text('请先确认原删除请求的结果，恢复信息已保留。', 'Check the original deletion request first. Its recovery information is saved.');
    case 'DELETION_PENDING_LIMIT': return text('本机已保留 32 个账号的待确认请求。请先核查已有记录；不会覆盖任何恢复凭据。', 'This device has 32 pending account requests. Check existing records first; no recovery credentials will be overwritten.');
    case 'DELETION_CLEANUP_PENDING': return text('账号已删除，但本机凭据或恢复信息尚未清理完成，请继续完成本机清理。', 'The account was deleted, but local credentials or recovery data still need cleanup.');
    case 'STORAGE_ERROR': return text('无法安全读取或保存恢复信息。新删除请求不会发送；请先恢复本机存储后重试。', 'Recovery information could not be securely read or saved. No new deletion will be sent until local storage works.');
    case 'RECOVERY_UNAVAILABLE': return text('无法生成安全的恢复凭据，未发送删除请求。请稍后重试。', 'Secure recovery credentials could not be generated. No deletion was sent.');
    case 'UNAUTHORIZED': return text('原登录已失效，删除结果仍需单独确认。请查询原请求；只有确认未完成后才能登录原账号手动重试。', 'The original session expired. Check the deletion request separately; sign into the original account to retry only after checking.');
    case 'RATE_LIMITED': return text('尝试较多，请稍后查询原请求。不要创建新的删除请求。', 'Too many attempts. Check the original request later instead of creating a new one.');
    case 'INVALID_RESPONSE': return text('未收到匹配的删除回执。恢复信息已保留，请查询原请求。', 'A matching deletion receipt was not received. Recovery information is saved; check the original request.');
    default: return text('删除结果暂未确认。恢复信息已保留，请查询原请求，不要重复创建请求。', 'Deletion is unconfirmed. Recovery information is saved; check the original request instead of creating another.');
  }
}

export function DeletionSettings() {
  const { colors, text, notify } = useDesign();
  const account = useQAccount();
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const actor = account.session ? { ownerId: account.session.user.id, token: account.session.token } : null;
  const ownsPending = !!actor && snapshot.selectedOwnerId === actor.ownerId;
  const deleted = snapshot.phase === 'deleted';
  const disabled = snapshot.loading || snapshot.busy || account.loading || account.authBusy || account.logoutBusy;
  const close = useCallback(() => {
    setOpen(false); setPassword(''); setConfirmation(''); controller.cancel();
  }, []);
  useEffect(() => {
    void controller.load();
    const subscription = AppState.addEventListener('change', state => { if (state !== 'active') close(); });
    return () => { subscription.remove(); controller.cancel(); };
  }, [close]);
  const show = () => {
    setPassword(''); setConfirmation('');
    if (!actor && !snapshot.pendingItems.length && !deleted) { account.requestAuth(); return; }
    if (actor) {
      if (!controller.select(actor.ownerId)) return;
      controller.resetCompleted();
    } else if (snapshot.pendingItems.length && !controller.select(snapshot.pendingItems[0].ownerId)) return;
    setOpen(true);
  };
  const check = async (ownerId = snapshot.selectedOwnerId) => {
    if (!ownerId) return;
    setPassword(''); setConfirmation('');
    if (await controller.check(actor, ownerId)) notify(text('原账号删除已确认', 'The original account deletion is confirmed'));
  };
  const submit = async () => {
    if (!actor || !ownsPending || disabled) return;
    const enteredPassword = password, enteredConfirmation = confirmation;
    setPassword(''); setConfirmation('');
    const complete = snapshot.pending
      ? await controller.retry(actor, enteredPassword, enteredConfirmation)
      : await controller.begin(actor, enteredPassword, enteredConfirmation);
    if (complete) notify(text('账号已删除', 'Account deleted'));
  };
  return <>
    <Row title={text('删除账号', 'Delete account')} subtitle={text('永久删除需验证当前密码', 'Permanent deletion requires your current password')}
      icon={Trash2} onPress={show} last />
    {snapshot.pendingItems.length || deleted || snapshot.error === 'STORAGE_ERROR' ? <View accessibilityLiveRegion="polite" style={{ gap: 10, paddingVertical: 12 }}>
      <Type color={snapshot.error ? colors.danger : colors.muted}>
        {snapshot.pendingItems.length
          ? text(`有 ${snapshot.pendingItems.length} 笔账号删除仍待确认或清理，各自的恢复信息会保留。`, `${snapshot.pendingItems.length} account deletion request(s) still need confirmation or cleanup. Each keeps its own recovery information.`)
          : text('原账号已确认删除。', 'The original account deletion is confirmed.')}
      </Type>
      {snapshot.error ? <Type size={13} color={colors.danger}>{deletionMessage(snapshot.error, text)}</Type> : null}
      {snapshot.pendingItems.map((pending, index) => <Action key={pending.ownerId} kind="ghost"
        label={pending.ownerId === actor?.ownerId ? text('查询当前账号的删除结果', 'Check this account’s deletion')
          : text(`查询其他账号的删除结果 ${index + 1}`, `Check another account’s deletion ${index + 1}`)}
        disabled={snapshot.busy} onPress={() => void check(pending.ownerId)} />)}
      {!snapshot.pendingItems.length && snapshot.error === 'STORAGE_ERROR' ? <Action kind="ghost" label={text('重试读取恢复信息', 'Retry reading recovery information')}
        disabled={snapshot.busy} onPress={() => { void controller.load(); }} /> : null}
    </View> : null}
    <Sheet visible={open} title={text('删除账号', 'Delete account')} onClose={close}>
      {deleted ? <>
        <Type>{text('服务器已确认原账号删除。', 'The server confirmed deletion of the original account.')}</Type>
        <Type size={13} muted>{text('本机清理只针对这个账号。旧版本留下且无法定位的缓存碎片可能保留；未确认的模拟转账恢复记录会保留。', 'Local cleanup is limited to this account. Unlocatable cache fragments from older versions may remain; unresolved simulated-transfer recovery records are retained.')}</Type>
        {snapshot.error ? <Type color={colors.danger}>{deletionMessage(snapshot.error, text)}</Type> : null}
        {snapshot.pending ? <Action label={text('完成本机清理', 'Finish local cleanup')} disabled={snapshot.busy} onPress={() => void check()} /> : null}
        <Action kind="ghost" label={text('关闭', 'Close')} onPress={close} />
      </> : <>
        <Type weight="500" color={colors.danger}>
          {ownsPending && account.session
            ? text(`将永久删除 @${account.session.user.handle}，此操作不能撤销。`, `Permanently delete @${account.session.user.handle}. This cannot be undone.`)
            : text('这是原账号的删除请求，当前其他账号不会被删除。', 'This request belongs to the original account. Another signed-in account will not be deleted.')}
        </Type>
        <View style={{ gap: 10 }}>
          <Type size={14}>{text('删除资料、你自己发送的聊天正文、个人服务连接和保存在 Q 的服务凭据。', 'Delete your profile, chat text you sent, private service connections, and service credentials stored by Q.')}</Type>
          <Type size={14}>{text('保留去标识化账号记录、不可变模拟账本和最小防重复收据。QDC 原交易备注保留；银行模拟转账备注会清除。他人的举报及证据按原期限保留。', 'Retain pseudonymous account records, immutable simulated-ledger amounts and minimal recovery receipts. QDC memos remain; bank simulation memos are cleared. Others’ reports and evidence keep their original expiry.')}</Type>
          <Type size={14}>{text('已被他人复制或分享的内容不会随之消失；自动同机备份保留 14 天；手动或异地副本需另行处理，不会全部即时擦除。外部服务已开始的任务不会自动取消。', 'Copies or content shared by others remain outside this deletion. Automatic on-server backups are retained for 14 days; manual or off-server copies require separate handling and are not all erased immediately. Work already started by external services is not automatically cancelled.')}</Type>
          <Type size={13} muted>{text('确认删除后会清理本机可定位的社交待发消息和举报恢复记录。旧版本无法定位的缓存碎片可能保留；未确认的模拟转账恢复记录不会删除。', 'After confirmed deletion, local social outbox and report recovery records that can be located are removed. Unlocatable fragments from older versions may remain. Unresolved simulated-transfer recovery records are not deleted.')}</Type>
          <Type size={13} muted>{text('提交后关闭弹窗不会撤销服务端已执行的删除。请求中断时会保留原请求以确认结果。', 'Closing this sheet cannot undo a deletion already performed by the server. An interrupted request is kept so its result can be checked.')}</Type>
          {process.env.EXPO_OS === 'web' ? <Type size={13} muted>{text('网页预览只在本页内存保存恢复凭据。结果确认前请勿刷新或关闭页面。', 'The web preview keeps recovery credentials only in page memory. Do not reload or close it before confirmation.')}</Type> : null}
        </View>
        {snapshot.pending ? <View style={{ gap: 10 }}>
          <Type size={14}>{text('先查询原请求。未查到完成记录并不等于删除成功；手动重试始终使用原请求编号。', 'Check the original request first. A missing completion record is not success; a manual retry always keeps the original request ID.')}</Type>
          <Action kind="secondary" label={snapshot.busy ? text('正在确认…', 'Checking…') : text('查询原删除结果', 'Check original deletion')}
            disabled={snapshot.busy} onPress={() => void check()} />
        </View> : null}
        {snapshot.error ? <View accessibilityLiveRegion="polite"><Type color={colors.danger}>{deletionMessage(snapshot.error, text)}</Type></View> : null}
        {ownsPending ? <>
          <Input label={text('当前账号密码', 'Current account password')} value={password} onChangeText={setPassword}
            secureTextEntry autoCapitalize="none" autoCorrect={false} textContentType="password" maxLength={128} editable={!disabled} />
          <Input label={text('输入 DELETE 确认', 'Type DELETE to confirm')} value={confirmation} onChangeText={setConfirmation}
            autoCapitalize="characters" autoCorrect={false} maxLength={6} editable={!disabled} />
          <Action kind="ghost" icon={Trash2}
            label={snapshot.busy ? text('正在处理…', 'Working…') : snapshot.pending ? text('确认并重试原删除', 'Confirm and retry original deletion') : text('永久删除账号', 'Permanently delete account')}
            style={{ borderWidth: 1, borderColor: colors.danger, borderRadius: 13 }}
            disabled={disabled || !password || confirmation !== 'DELETE'} onPress={() => void submit()} />
        </> : <Type muted>{text('如需手动重试，请先登录原账号。查询结果不需要重新登录。', 'Sign into the original account to retry manually. Checking the result does not require signing in.')}</Type>}
        <Action kind="ghost" label={text('暂不操作', 'Close for now')} onPress={close} />
      </>}
    </Sheet>
  </>;
}
