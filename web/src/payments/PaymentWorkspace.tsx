import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ArrowUpRight, CircleAlert, LockKeyhole } from 'lucide-react';
import { useAdmin } from '../state';
import { adminPages, adminPageForPath } from '../routes';
import { PaymentSession } from './session';
import { OrdersPanel } from './OrdersPanel';
import { SettlementPanel } from './SettlementPanel';
import { FxPanel } from './FxPanel';
import { AuditPanel } from './AuditPanel';
import { paymentLoginAllowed } from './api';
import './payments.css';

export function PaymentWorkspace() {
  const { t, locale, setLocale } = useAdmin();
  const location = useLocation();
  const current = adminPageForPath(location.pathname);
  const allowed = paymentLoginAllowed(window.location.origin, import.meta.env.VITE_Q_LOCAL_API_TEST, import.meta.env.VITE_Q_API_URL);
  useEffect(() => {
    document.title = t('小Q · 管理工作台', 'Q · Operations');
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
  }, [locale, t]);
  return <div className="payment-workspace">
    <a className="skip-link" href="#main-content">{t('跳至主要内容', 'Skip to main content')}</a>
    <header className="pay-header">
      <Link className="ops-brand" to="/"><span className="ops-wordmark" aria-hidden="true">Q</span><span>{t('小Q管理工作台', 'Q operations')}</span></Link>
      <div className="ops-header-actions"><button className="button secondary" aria-label={t('切换语言', 'Switch language')} onClick={() => setLocale(locale === 'zh' ? 'en' : 'zh')}>{locale === 'zh' ? 'English' : '中文'}</button></div>
    </header>
    <main className="ops-main" id="main-content" tabIndex={-1}>
      <div className="ops-heading"><h1>{t('管理工作台', 'Operations')}</h1><p>{t('核对付款，处理待办，保留每一步依据。', 'Review payments, resolve pending work, and preserve the evidence.')}</p></div>
      {!allowed ? <section className="panel pay-login" aria-labelledby="official-entry">
        <LockKeyhole aria-hidden="true" size={28}/><h2 id="official-entry">{t('请使用小Q官方后台', 'Use the official Q workspace')}</h2>
        <p>{t('当前地址不接收账号或密码。请前往官方地址登录。', 'This address does not accept credentials. Sign in at the official address.')}</p>
        <a className="button" href="https://q.kaicloudpay.com/q-admin/">{t('打开官方后台', 'Open official workspace')}<ArrowUpRight size={16} aria-hidden="true"/></a>
      </section> : !current ? <section className="panel ops-empty" aria-labelledby="unavailable-title">
        <CircleAlert aria-hidden="true" size={28}/><h2 id="unavailable-title">{t('此模块尚未接入正式后台', 'This module is not connected')}</h2>
        <p>{t('当前没有可用的管理接口，因此不显示业务记录或统计。', 'No management API is available for this module. Business records and metrics are unavailable.')}</p>
        <Link className="button secondary" to="/">{t('返回管理工作台', 'Return to operations')}</Link>
      </section> : <PaymentSession>
        <nav className="pay-tabs" aria-label={t('管理导航', 'Operations navigation')}>
          {adminPages.map(page => <Link key={page.id} to={page.path} aria-current={current === page.id ? 'page' : undefined}>{t(page.zh, page.en)}</Link>)}
        </nav>
        {current === 'orders' ? <OrdersPanel/> : current === 'settlements' ? <SettlementPanel/> : current === 'fx' ? <FxPanel/> : <AuditPanel/>}
      </PaymentSession>}
      <footer className="ops-footer"><span>{t('小Q · 操作员工作区', 'Q · Operator workspace')}</span><span>{t('版本', 'Build')} {__BUILD_SHA__}</span></footer>
    </main>
  </div>;
}
