import { createContext, useContext, useCallback, useEffect, useRef, useState, type ReactNode, type FormEvent } from 'react';
import { flushSync } from 'react-dom';
import { PaymentApi, PaymentError, apiOrigin } from './api';
import { object, string, parseOperator, type Operator } from './types';
import { useAdmin } from '../state';

type Session={api:PaymentApi;operator:Operator;epoch:number};
const Context=createContext<Session|null>(null);
export function usePayments(){const value=useContext(Context);if(!value)throw Error('PAYMENT_SESSION_REQUIRED');return value}
export function PaymentSession({children}:{children:ReactNode}){
 const {t}=useAdmin();const [session,setSession]=useState<Session|null>(null);const [handle,setHandle]=useState('');const [password,setPassword]=useState('');const [error,setError]=useState('');const [busy,setBusy]=useState(false);
 const passwordInput=useRef<HTMLInputElement>(null);const generation=useRef(0);const client=useRef<PaymentApi|null>(null);const mounted=useRef(true);
 const stopSession=useCallback(()=>{mounted.current=false;generation.current++;client.current?.invalidate()},[]);
 useEffect(()=>{mounted.current=true;return stopSession},[stopSession]);
 const pageBoundary=useCallback(()=>{generation.current++;client.current?.invalidate();client.current=null;flushSync(()=>{setSession(null);setPassword('');setHandle('');setBusy(false);setError('')});if(passwordInput.current)passwordInput.current.value=''},[]);
 useEffect(()=>{const show=(event:PageTransitionEvent)=>{if(event.persisted)pageBoundary()};window.addEventListener('pagehide',pageBoundary);window.addEventListener('pageshow',show);return()=>{window.removeEventListener('pagehide',pageBoundary);window.removeEventListener('pageshow',show)}},[pageBoundary]);
 function expire(epoch:number){if(epoch!==generation.current||!mounted.current)return;generation.current++;client.current?.invalidate();client.current=null;setSession(null);setPassword('');setBusy(false);setError(t('会话已失效，请重新登录。同一服务与账号仅保留待确认请求的恢复引用；原文件和备注已清除。','Session expired. Sign in again; only recovery references for this service and account remain; original documents and notes have been cleared.'))}
 async function login(event:FormEvent){event.preventDefault();const epoch=++generation.current;client.current?.invalidate();setSession(null);setError('');setBusy(true);const secret=password;setPassword('');
  const publicClient=new PaymentApi('', '',()=>{},apiOrigin());client.current=publicClient;
  try{const auth=await publicClient.post('/v1/auth/login',{handle:handle.trim(),password:secret},v=>{const o=object(v);return {token:string(o.token),id:string(object(o.user).id)}});if(epoch!==generation.current||!mounted.current)return;
   publicClient.invalidate();const api=new PaymentApi(auth.token,auth.id,()=>expire(epoch),apiOrigin());client.current=api;
   const operator=await api.get('/v1/payments/operator/me',parseOperator);if(operator.user_id!==auth.id)throw new PaymentError('IDENTITY_MISMATCH');if(epoch!==generation.current||!mounted.current)return;
   setSession({api,operator,epoch});setHandle('');
  }catch(e){if(epoch===generation.current&&mounted.current){client.current?.logout();client.current=null;setError(e instanceof PaymentError&&e.status===403?t('该 Q 账号没有钱包支付操作权限。','This Q account has no payment operator permission.'):t('登录或角色验证失败，请检查账号及服务状态后重试。','Login or role verification failed. Check your account and service status.'))}}finally{if(epoch===generation.current&&mounted.current)setBusy(false)}
 }
 function logout(){const old=client.current;generation.current++;setSession(null);setPassword('');setError('');setBusy(false);client.current=null;old?.logout()}
 if(!session)return <section className="panel pay-login"><h2>{t('使用 Q 账号登录','Sign in with your Q account')}</h2><p>{t('登录后仍需服务端验证操作角色。演示页面的署名不会授予真实权限。','The server must verify your operator role after login. Demo attribution grants no real permissions.')}</p><small>{apiOrigin()}</small><form onSubmit={login}><label className="field">{t('账号','Handle')}<input autoComplete="username" value={handle} required maxLength={24} onChange={e=>setHandle(e.target.value)} disabled={busy}/></label><label className="field">{t('密码','Password')}<input ref={passwordInput} type="password" autoComplete="current-password" value={password} required maxLength={128} onChange={e=>setPassword(e.target.value)} disabled={busy}/></label>{error&&<p role="alert" className="pay-error">{error}</p>}<button className="button" disabled={busy}>{busy?t('正在验证…','Verifying…'):t('登录并验证角色','Sign in and verify role')}</button></form></section>;
 return <Context.Provider value={session}><div className="pay-session"><span>{t('当前账号','Account')}: <code>{session.operator.user_id}</code></span><span>{t('权限','Roles')}: {session.operator.roles.map(r=>r==='maker'?t('初审','Maker'):t('复审','Checker')).join(' / ')}</span><button className="button secondary" onClick={logout}>{t('退出 / 切换账号','Sign out / switch account')}</button></div><div key={session.epoch}>{children}</div></Context.Provider>;
}
