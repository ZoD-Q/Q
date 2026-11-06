import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useAdmin } from './state';

export function Modal({ children, title, close, wide = false }: { children: ReactNode; title: string; close: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const prior = document.activeElement;
    const dialog = ref.current;
    dialog?.showModal();
    return () => { dialog?.close(); if (prior instanceof HTMLElement && prior.isConnected) prior.focus(); };
  }, []);
  const { t } = useAdmin();
  return <dialog ref={ref} className={wide ? 'drawer' : 'modal'} aria-label={title} onKeyDown={event => {
    if (event.key !== 'Tab') return;
    const targets = [...event.currentTarget.querySelectorAll<HTMLElement>('a[href],button,input,select,textarea,[tabindex]')]
      .filter(element => !element.matches(':disabled,[tabindex="-1"]') && element.getClientRects().length > 0);
    const first = targets[0], last = targets.at(-1);
    if (!first || !last) { event.preventDefault(); event.currentTarget.focus(); }
    else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }} onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="dialog-body"><div className="dialog-heading"><span>{title}</span><button className="icon-button" aria-label={t('关闭', 'Close')} onClick={close}><X size={20} aria-hidden="true"/></button></div>{children}</div>
  </dialog>;
}
