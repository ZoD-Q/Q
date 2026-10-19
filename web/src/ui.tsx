import { useEffect, useRef, type ReactNode } from 'react';
import { Check, CircleAlert, Clock3, X } from 'lucide-react';
import { statusLabel } from './domain';
import { useAdmin } from './state';

export function Status({ value }: { value: string }) {
  const { text } = useAdmin();
  const bad = ['failed', 'restricted', 'access_restricted', 'blocked', 'discrepancy', 'degraded'].includes(value);
  const pending = ['pending', 'unknown', 'review', 'appealed', 'processing', 'attention', 'channel_pending', 'requested', 'investigating', 'authorization_required'].includes(value);
  const neutral = ['draft', 'planned', 'revoked', 'expired', 'unlisted', 'paused'].includes(value);
  const Icon = bad ? CircleAlert : pending ? Clock3 : Check;
  return <span className={`status ${bad ? 'bad' : pending ? 'pending' : neutral ? 'neutral' : 'good'}`}><Icon size={13} aria-hidden="true" />{text(statusLabel(value))}</span>;
}
export function Basis({ value }: { value: 'existing' | 'branch' | 'planned' }) {
  const { t } = useAdmin();
  return <span className="basis">{value === 'existing' ? t('已有底层', 'Existing foundation') : value === 'branch' ? t('开发分支', 'Development branch') : t('规划能力', 'Planned capability')}</span>;
}
export function Modal({ children, title, close, wide = false }: { children: ReactNode; title: string; close: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  const { t } = useAdmin();
  return <dialog ref={ref} className={wide ? 'drawer' : 'modal'} aria-label={title} onCancel={(event) => { event.preventDefault(); close(); }} onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
    <div className="dialog-body"><div className="dialog-heading"><span>{title}</span><button className="icon-button" aria-label={t('关闭', 'Close')} onClick={close}><X size={20} /></button></div>{children}</div>
  </dialog>;
}
export function Empty({ title, description }: { title: string; description: string }) {
  return <div className="empty"><img src={`${import.meta.env.BASE_URL}mascot/06-paused.png`} alt="" /><h3>{title}</h3><p>{description}</p></div>;
}
export function Time({ value }: { value: string }) {
  const { locale } = useAdmin();
  const date = new Date(value);
  return <time dateTime={value}>{Number.isNaN(date.getTime()) ? value : date.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-GB', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</time>;
}
