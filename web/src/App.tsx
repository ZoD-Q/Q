import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Activity, ArrowUpRight, ChevronDown, CircleHelp, FlaskConical, Globe2, LayoutDashboard, Menu, MessageSquare, PlugZap, RotateCcw, Search, Settings2, ShieldCheck, SlidersHorizontal, Users, Wallet, X } from 'lucide-react';
import { groups, pages } from './catalog';
import { AdminProvider, useAdmin } from './state';
import { Basis, Empty, Modal, Status, Time } from './ui';
import { Dashboard, ActivityLog } from './Dashboard';
import { EntityDetail } from './Detail';
import type { Entity } from './domain';
import { selectIssues } from './selectors';

const icons: Record<string, typeof Activity> = { overview: LayoutDashboard, users: Users, ai: Activity, plugins: PlugZap, content: MessageSquare, commerce: Wallet, growth: SlidersHorizontal, system: ShieldCheck };
const route = (id: string) => id === 'dashboard' ? '/' : `/${id}`;

function Navigation({ activeGroup, close }: { activeGroup: string; close?: () => void }) {
  const { text, t } = useAdmin();
  const [expanded, setExpanded] = useState<string | null>(null);
  return <nav aria-label={t('主导航', 'Main navigation')}>
    {groups.map((group) => {
      const Icon = icons[group.id] ?? Settings2;
      const open = (expanded ?? activeGroup) === group.id;
      return <div className="nav-group" key={group.id}>
        <button className={`nav-group-button ${activeGroup === group.id ? 'active' : ''}`} aria-expanded={open} onClick={() => setExpanded(open ? '' : group.id)}><Icon size={18} /><span>{text(group.title)}</span><ChevronDown size={14} className={open ? 'rotated' : ''} /></button>
        {open && <div className="nav-children">{pages.filter((page) => page.groupId === group.id).map((page) => <NavLink key={page.id} to={route(page.id)} end onClick={close}>{text(page.title)}</NavLink>)}</div>}
      </div>;
    })}
  </nav>;
}

function GlobalSearch() {
  const { state, t, text } = useAdmin();
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const location = useLocation();
  useEffect(() => { setQuery(''); }, [location.pathname, location.search]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); input.current?.focus(); }
      if (event.key === 'Escape') setQuery('');
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  const results = query.trim() ? state.entities.filter((item) => `${item.id} ${text(item.name)} ${item.owner}`.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 8) : [];
  return <div className="global-search"><Search size={17} aria-hidden="true" /><input ref={input} aria-label={t('全局搜索', 'Global search')} placeholder={t('搜索用户、任务、插件或订单', 'Search users, tasks, plugins or orders')} value={query} onChange={(event) => setQuery(event.target.value)} /><kbd>⌘ K</kbd>
    {query && <div className="search-results" role="region" aria-label={t('搜索结果', 'Search results')}><div className="search-caption">{t('演示数据中的搜索结果', 'Results in demo data')}<button className="icon-button" onClick={() => setQuery('')} aria-label={t('关闭搜索结果', 'Close search results')}><X size={16}/></button></div>{results.map((item) => <Link key={item.id} to={`/${item.pageId}?item=${encodeURIComponent(item.id)}`}><span>{text(item.name)}<small>{item.id}</small></span><ArrowUpRight size={16}/></Link>)}{!results.length && <p>{t('没有找到匹配的演示记录。', 'No matching demo records.')}</p>}</div>}
  </div>;
}

export function EntityRows({ entities }: { entities: Entity[] }) {
  const { t, text } = useAdmin();
  const [params, setParams] = useSearchParams();
  const open = (entity: Entity) => { const next = new URLSearchParams(params); next.set('item', entity.id); setParams(next); };
  return <div className="table-scroll"><table><thead><tr><th>{t('对象', 'Record')}</th><th>{t('状态', 'Status')}</th><th>{t('关联账号 / 负责人', 'Account / owner')}</th><th>{t('更新时间 · 上海', 'Updated · Shanghai')}</th><th><span className="sr-only">{t('操作', 'Action')}</span></th></tr></thead><tbody>{entities.map((entity) => <tr key={entity.id}>
    <td><button className="record-link" onClick={() => open(entity)}>{text(entity.name)}</button><span className="record-summary">{text(entity.summary)}</span><span className="record-id">{entity.id}</span></td>
    <td><Status value={entity.status}/></td><td>{entity.owner}</td><td className="time-cell"><Time value={entity.updatedAt}/></td><td><button className="icon-button" aria-label={`${t('查看', 'View')} ${text(entity.name)}`} onClick={() => open(entity)}><ArrowUpRight size={17}/></button></td>
  </tr>)}</tbody></table></div>;
}

function PageContent({ pageId }: { pageId: string }) {
  const { state, t, text } = useAdmin();
  const [params, setParams] = useSearchParams();
  const query = params.get('q') ?? '';
  const status = params.get('status') ?? 'all';
  const scenario = params.get('scenario') ?? 'normal';
  const all = pageId === 'incidents' ? selectIssues(state) : state.entities.filter((item) => item.pageId === pageId);
  const statuses = [...new Set(all.map((item) => item.status))];
  const filtered = all.filter((item) => (status === 'all' || item.status === status) && `${item.id} ${text(item.name)} ${text(item.summary)} ${item.owner}`.toLowerCase().includes(query.toLowerCase()));
  const set = (key: string, value: string) => { const next = new URLSearchParams(params); if (value && value !== 'all' && value !== 'normal') next.set(key, value); else next.delete(key); next.delete('item'); setParams(next, { replace: true }); };
  if (pageId === 'dashboard') return <Dashboard/>;
  if (pageId === 'audit' || pageId === 'activity') return <ActivityLog/>;
  return <section className="panel page-panel">
    <div className="filter-bar"><label className="filter-search"><Search size={17}/><input aria-label={t('搜索当前列表', 'Search this list')} value={query} onChange={(event) => set('q', event.target.value)} placeholder={t('搜索名称、编号或账号', 'Search name, ID or account')}/></label>
      <label className="select-label"><span>{t('状态', 'Status')}</span><select value={status} onChange={(event) => set('status', event.target.value)}><option value="all">{t('全部状态', 'All statuses')}</option>{statuses.map((value) => <option key={value} value={value}>{text(statusText(value))}</option>)}</select></label>
      <label className="select-label"><span>{t('预览场景', 'Preview state')}</span><select value={scenario} onChange={(event) => set('scenario', event.target.value)}><option value="normal">{t('正常', 'Normal')}</option><option value="empty">{t('空列表', 'Empty')}</option><option value="error">{t('加载失败', 'Load failed')}</option><option value="loading">{t('加载中', 'Loading')}</option></select></label>
    </div>
    {scenario === 'loading' ? <div className="empty" role="status"><span className="spinner"/><h3>{t('正在演示加载状态', 'Previewing loading state')}</h3><p>{t('切回“正常”查看记录。', 'Switch to Normal to view records.')}</p></div> : scenario === 'error' ? <div className="empty" role="alert"><CircleHelp size={36}/><h3>{t('演示加载失败', 'Demo loading failed')}</h3><p>{t('数据没有改变，可恢复正常预览。', 'Data is unchanged. Restore the normal preview.')}</p><button className="button" onClick={() => set('scenario', 'normal')}>{t('恢复预览', 'Restore preview')}</button></div> : scenario === 'empty' || !filtered.length ? <Empty title={t('这里暂时没有记录', 'No records here')} description={t('尝试调整筛选，或切换预览场景。', 'Adjust the filters or switch the preview state.')}/> : <EntityRows entities={filtered}/>}
    <div className="table-footer"><span>{t('共', 'Total')} {scenario === 'empty' ? 0 : filtered.length} {t('条演示记录', 'demo records')}</span><span>{t('所有改动仅在本次页面会话保留', 'Changes last for this page session only')}</span></div>
  </section>;
}

import { statusLabel as statusText } from './domain';

function Shell() {
  const { state, t, text, locale, setLocale, theme, setTheme, operator, setOperator, reset } = useAdmin();
  const location = useLocation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const parts = location.pathname.split('/').filter(Boolean);
  const pageId = parts[0] ?? 'dashboard';
  const page = pages.find((item) => item.id === pageId);
  const group = groups.find((item) => item.id === page?.groupId);
  const fullId = parts[1];
  const selectedId = fullId ?? params.get('item');
  const entity = state.entities.find((item) => item.id === selectedId && (item.pageId === pageId || pageId === 'incidents'));
  const [mobileNav, setMobileNav] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const closeEntity = () => { if (fullId) navigate(route(pageId)); else { const next = new URLSearchParams(params); next.delete('item'); setParams(next); } };
  useEffect(() => { document.title = `${page ? text(page.title) : t('页面不存在', 'Page not found')} · ${t('小Q演示后台', 'Q Admin Demo')}`; document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'; }, [page, locale, text, t]);
  return <div className="shell"><aside className="sidebar"><Link className="brand" to="/"><span className="brand-q">Q</span><span>{t('小Q', 'Q')}<small>{t('管理工作台', 'Admin workspace')}</small></span></Link><Navigation key={page?.groupId} activeGroup={page?.groupId ?? 'overview'}/><div className="sidebar-bottom"><div className="demo-dot"/>{t('演示环境', 'Demo environment')}<small>{__BUILD_SHA__}</small></div></aside>
    <div className="workspace"><header className="topbar"><button className="icon-button mobile-only" aria-label={t('打开导航', 'Open navigation')} onClick={() => setMobileNav(true)}><Menu size={20}/></button><GlobalSearch/><div className="topbar-tools"><button className="icon-button" aria-label={t('切换语言', 'Switch language')} onClick={() => setLocale(locale === 'zh' ? 'en' : 'zh')}><Globe2 size={18}/><span>{locale === 'zh' ? 'EN' : '中'}</span></button><label><span className="sr-only">{t('外观主题', 'Theme')}</span><select aria-label={t('外观主题', 'Theme')} value={theme} onChange={(event) => setTheme(event.target.value as typeof theme)}><option value="light">{t('浅色', 'Light')}</option><option value="dark">{t('深色', 'Dark')}</option><option value="warm">{t('暖色', 'Warm')}</option></select></label><label className="operator"><span className="avatar">{operator[0]}</span><select aria-label={t('演示操作者', 'Demo operator')} value={operator} onChange={(event) => setOperator(event.target.value as typeof operator)}><option>Mandow</option><option>hera</option></select></label></div></header>
    <div className="demo-banner"><FlaskConical size={15}/><strong>{t('演示原型', 'Interactive demo')}</strong><span>{t('虚构数据 · 操作仅影响当前页面 · 刷新后重置', 'Fictional data · Changes affect this page only · Refresh to reset')}</span><button onClick={() => setResetOpen(true)}><RotateCcw size={14}/>{t('重置演示', 'Reset demo')}</button></div>
    <main id="main-content"><div className="breadcrumb">{text(group?.title ?? {zh:'工作台',en:'Workspace'})}<span>/</span>{page ? text(page.title) : t('未找到页面', 'Page not found')}</div>
    {page ? <><div className="page-heading"><div><div className="title-row"><h1>{text(page.title)}</h1><Basis value={page.basis}/></div><p>{text(page.description)}</p></div><button className="icon-button" aria-label={t('查看演示说明', 'About this demo')} onClick={() => setHelpOpen(true)}><CircleHelp size={20}/></button></div>
    {fullId ? entity ? <div className="panel full-detail"><button className="text-button" onClick={() => navigate(route(pageId))}>{t('返回列表', 'Back to list')}</button><EntityDetail key={entity.id} entity={entity}/></div> : <Empty title={t('记录不存在', 'Record not found')} description={t('该演示记录可能已重置，请返回列表。', 'The demo may have reset. Return to the list.')}/> : <PageContent pageId={pageId}/>}</> : <div className="panel"><Empty title={t('没有这个页面', 'Page not found')} description={t('从左侧菜单选择一个页面继续。', 'Choose a page from the navigation.')}/><Link className="button" to="/">{t('返回工作台', 'Back to workspace')}</Link></div>}
    <footer className="page-footer"><span>{t('小Q管理工作台 · 仅供产品体验', 'Q Admin · Product demonstration only')}</span><span>{t('版本', 'Version')} {__BUILD_SHA__}</span></footer></main></div>
    {mobileNav && <Modal title={t('导航', 'Navigation')} close={() => setMobileNav(false)} wide><Navigation key={page?.groupId} activeGroup={page?.groupId ?? 'overview'} close={() => setMobileNav(false)}/></Modal>}
    {entity && !fullId && <Modal title={t('记录详情', 'Record details')} close={closeEntity} wide><Link className="detail-expand" to={`/${entity.pageId}/${entity.id}`}>{t('打开完整详情', 'Open full details')}<ArrowUpRight size={15}/></Link><EntityDetail key={entity.id} entity={entity}/></Modal>}
    {resetOpen && <Modal title={t('重置演示', 'Reset demo')} close={() => setResetOpen(false)}><p>{t('将清除本次演示操作和记录，恢复所有初始场景。主题和语言不变。', 'Clear this session’s actions and records, then restore initial scenarios. Theme and language stay unchanged.')}</p><div className="form-actions"><button className="button secondary" onClick={() => setResetOpen(false)}>{t('取消', 'Cancel')}</button><button className="button" onClick={() => { reset(); setResetOpen(false); navigate('/'); }}>{t('确认重置', 'Confirm reset')}</button></div></Modal>}
    {helpOpen && <Modal title={t('关于这个演示', 'About this demo')} close={() => setHelpOpen(false)}><p>{t('你和 hera 使用相同的演示视图。这里没有真实登录、管理员授权或业务请求。所有账号、任务、金额和统计都是虚构示例。', 'Mandow and hera share the same demo view. There is no real login, administrator authorization, or business request. Accounts, tasks, amounts, and metrics are fictional examples.')}</p><p>{t('能力标签说明产品代码的基础，不代表管理接口已经接通。真实管理权限将在后端接入阶段实现。', 'Capability labels describe the code foundation, not a connected management API. Real administrator authorization belongs to a later backend integration.')}</p><button className="button" onClick={() => setHelpOpen(false)}>{t('知道了', 'Got it')}</button></Modal>}
  </div>;
}

export default function App() { return <AdminProvider><Shell/></AdminProvider>; }
