import type { Validator } from './types';
export class PaymentError extends Error {
 constructor(readonly code:string,readonly status=0,readonly unknown=false){super(code)}
}
export type Pending={key:string;path:string;body:unknown;recoveryPath:string;queried:boolean;createdAt:string;replayable:boolean;attempts:number;proofs?:Record<string,string|number>};
type Identity=Record<string,string|number>;
type Reference={key:string;path:string;recoveryPath:string;createdAt:string;identity:Identity};
const identityKeys=new Set(['client_request_id','evidence_version','proposal_id','version','evidence_sha256','mapping_sha256','execution_sha256','candidate_id','expected_generation','check_version','maker_id','checker_id']);
function normalizeOrigin(origin:string):string {
 const url=new URL(origin);
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new PaymentError('INVALID_API_ORIGIN');
 return url.origin;
}
export function paymentRecoveryStorageKey(origin:string,owner:string):string {
 return `q-payment-recovery-v2:${encodeURIComponent(normalizeOrigin(origin))}:${encodeURIComponent(owner)}`;
}
function identityOf(p:Pending):Identity {
 const result:Identity={};
 for(const source of [p.body,p.proofs])if(source&&typeof source==='object'&&!Array.isArray(source))
  for(const [key,value]of Object.entries(source))if(identityKeys.has(key)&&(typeof value==='string'||typeof value==='number'))result[key]=value;
 return result;
}
function referenceOf(p:Pending):Reference{return {key:p.key,path:p.path,recoveryPath:p.recoveryPath,createdAt:p.createdAt,identity:identityOf(p)}}
function scrub(p:Pending):void {
 const identity=identityOf(p);
 // Mutate the owned clone too: a previously captured body reference cannot retain a file.
 if(p.body&&typeof p.body==='object')for(const key of Object.keys(p.body))Reflect.deleteProperty(p.body,key);
 p.body=identity;p.proofs=undefined;p.replayable=false;p.queried=false;
}
function sameReference(a:Reference,b:Reference):boolean {
 const canonical=(value:Reference)=>JSON.stringify({...value,identity:Object.fromEntries(Object.entries(value.identity).sort(([a],[b])=>a.localeCompare(b)))});
 return canonical(a)===canonical(b);
}
function validReference(p:Record<string,unknown>):boolean{
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;const hash=/^[0-9a-f]{64}$/;
 if(typeof p.key!=='string'||!p.key.trim()||p.key.length>200||typeof p.path!=='string'||typeof p.recoveryPath!=='string'||typeof p.createdAt!=='string'||!Number.isFinite(Date.parse(p.createdAt))||!p.identity||typeof p.identity!=='object'||Array.isArray(p.identity))return false;
 const body=p.identity as Record<string,unknown>;
 const id=(k:string)=>typeof body[k]==='string'&&uuid.test(body[k]);
 const sha=(k:string)=>typeof body[k]==='string'&&hash.test(body[k]);
 const version=(k:string)=>typeof body[k]==='number'&&Number.isSafeInteger(body[k])&&body[k]>=1;
 if((body.maker_id!==undefined&&!id('maker_id'))||(body.checker_id!==undefined&&!id('checker_id')))return false;
 if(p.path==='/v1/payments/fx/activations')return p.key==='fx-activation'&&p.recoveryPath==='/v1/payments/fx/status'&&id('candidate_id')&&sha('evidence_sha256')&&version('expected_generation');
 if(p.path==='/v1/payments/operator/settlements')return p.key==='settlement-import'&&id('client_request_id')&&sha('evidence_sha256')&&sha('mapping_sha256')&&p.recoveryPath===`/v1/payments/operator/settlements/by-client-key/${String(body.client_request_id)}`;
 const match=p.path.match(/^\/v1\/payments\/(operator\/)?(orders|refunds|settlements)\/([^/]+)\/(proposals|approvals|refunds|approve|evidence|verify|unknown|evidence-rejections|rechecks)$/);
 if(!match||!uuid.test(match[3]))return false;
 const [,operator,kind,target,action]=match;const actionKey=action==='evidence-rejections'?'reject':action;
 if(!operator&&kind==='orders')return p.key===`order:${target}`&&p.recoveryPath===`/v1/payments/operator/orders/${target}`&&version('evidence_version')&&(action==='proposals'||(action==='approvals'&&id('proposal_id')));
 if(operator&&kind==='orders'&&action==='refunds')return p.key===`refund-create:${target}`&&p.recoveryPath===`/v1/payments/operator/orders/${target}`&&id('client_request_id');
 if(operator&&kind==='settlements'&&action==='rechecks')return p.key===`settlement-recheck:${target}`&&p.recoveryPath===`/v1/payments/operator/settlements/${target}`&&sha('mapping_sha256')&&sha('evidence_sha256')&&version('check_version');
 if(operator&&kind==='settlements'&&action==='verify')return p.key===`settlement-verify:${target}`&&p.recoveryPath===`/v1/payments/operator/settlements/${target}`&&sha('mapping_sha256')&&sha('evidence_sha256');
 if(operator&&kind==='refunds'&&['approve','evidence','verify','unknown','evidence-rejections'].includes(action))return p.key.startsWith(`refund-${actionKey}:`)&&uuid.test(p.key.slice(`refund-${actionKey}:`.length))&&p.recoveryPath===`/v1/payments/operator/refunds/${target}`&&version('version')&&(!['verify','evidence-rejections'].includes(action)||sha('evidence_sha256'))&&(action!=='evidence'||(sha('evidence_sha256')&&sha('execution_sha256')));
 return false;
}

function readReferences(origin:string,owner:string):Map<string,Reference>{
 try {
  // The old owner-only format has no trustworthy origin. Never guess or migrate it.
  const legacy=localStorage.getItem(`q-payment-recovery-v1:${owner}`);
  if(legacy&&legacy!=='[]')throw new PaymentError('LEGACY_RECOVERY_ORIGIN_REQUIRED');
  const raw=localStorage.getItem(paymentRecoveryStorageKey(origin,owner));
  if(!raw)return new Map();
  if(raw.length>65536)throw Error('INVALID_RECOVERY');
  const envelope:unknown=JSON.parse(raw);
  if(!envelope||typeof envelope!=='object'||Array.isArray(envelope))throw Error('INVALID_RECOVERY');
  const e=envelope as Record<string,unknown>;
  if(e.version!==2||e.origin!==origin||e.owner!==owner||!Array.isArray(e.items)||e.items.length>40)throw Error('INVALID_RECOVERY');
  const records=new Map<string,Reference>();
  for(const item of e.items){
   if(!item||typeof item!=='object'||Array.isArray(item))throw Error('INVALID_RECOVERY');
   const value=item as Record<string,unknown>;
   if(!validReference(value)||typeof value.key!=='string'||records.has(value.key))throw Error('INVALID_RECOVERY');
   const identity=value.identity as Record<string,unknown>;
   if(Object.entries(identity).some(([k,v])=>!identityKeys.has(k)||(typeof v!=='string'&&typeof v!=='number')))throw Error('INVALID_RECOVERY');
   records.set(value.key,value as unknown as Reference);
  }
  return records;
 }catch(error){if(error instanceof PaymentError)throw error;throw new PaymentError('RECOVERY_DATA_INVALID')}
}
function writeReferences(origin:string,owner:string,records:Map<string,Reference>){
 try{localStorage.setItem(paymentRecoveryStorageKey(origin,owner),JSON.stringify({version:2,origin,owner,items:[...records.values()]}))}
 catch{throw new PaymentError('RECOVERY_STORAGE_UNAVAILABLE')}
}
const nodeQueues=new Map<string,Promise<unknown>>();
async function storageLock<T>(scope:string,run:()=>Promise<T>):Promise<T>{
 if(typeof navigator!=='undefined'&&navigator.locks)return navigator.locks.request(scope,run);
 // Tests execute outside a browser; an unsupported browser must fail closed on writes.
 if(typeof window!=='undefined')throw new PaymentError('RECOVERY_LOCK_UNAVAILABLE');
 const previous=nodeQueues.get(scope)??Promise.resolve();
 const task=previous.catch(()=>{}).then(run);nodeQueues.set(scope,task);
 try{return await task}finally{if(nodeQueues.get(scope)===task)nodeQueues.delete(scope)}
}
function fromReference(p:Reference):Pending{return {...p,body:structuredClone(p.identity),queried:false,replayable:false,attempts:1}}

export class PaymentApi {
 private controllers=new Set<AbortController>();
 private active=true;
 private recordsMap=new Map<string,Pending>();
 private recovered=new Map<string,Reference>();
 readonly origin:string;
 private token:string;
 constructor(token:string,readonly owner:string,private readonly unauthorized:()=>void,origin:string){this.token=token;this.origin=normalizeOrigin(origin)}
 private assertActive(unknown=false){if(!this.active)throw new PaymentError('SESSION_CHANGED',0,unknown)}
 private scope(){return paymentRecoveryStorageKey(this.origin,this.owner)}
 invalidate(){
  if(!this.active)return;
  this.active=false;this.token='';this.recovered.clear();
  for(const p of this.recordsMap.values())scrub(p);
  for(const c of this.controllers)c.abort();this.controllers.clear();
 }
 private syncRecords(){
  this.assertActive();
  const refs=readReferences(this.origin,this.owner);
  for(const [key,p]of this.recordsMap){const ref=refs.get(key);if(p.attempts===0)continue;if(!ref||!sameReference(referenceOf(p),ref)){scrub(p);this.recordsMap.delete(key)}}
  for(const [key,ref]of refs)if(!this.recordsMap.has(key))this.recordsMap.set(key,fromReference(ref));
 }
 pending(key:string){if(this.active)try{this.syncRecords()}catch{/* Writes still fail closed; do not expose corrupt data. */}return this.recordsMap.get(key)}
 pendingList(){if(this.active)try{this.syncRecords()}catch{/* See pending(). */}return [...this.recordsMap.values()]}
 async clearPending(key:string){
  this.assertActive();const expected=this.recovered.get(key);if(!expected)throw new PaymentError('QUERY_REQUIRED');
  await this.forget(key,expected);this.recovered.delete(key);
 }
 private async forget(key:string,expected:Reference){
  await storageLock(this.scope(),async()=>{
   this.assertActive();const refs=readReferences(this.origin,this.owner);const actual=refs.get(key);
   if(actual&&!sameReference(actual,expected))throw new PaymentError('RECOVERY_REFERENCE_CHANGED',0,true);
   refs.delete(key);writeReferences(this.origin,this.owner,refs);
   const local=this.recordsMap.get(key);if(local&&sameReference(referenceOf(local),expected)){scrub(local);this.recordsMap.delete(key)}
  });
 }
 logout(){const token=this.token;this.invalidate();if(!token)return;const revoker=new PaymentApi(token,'',()=>{},this.origin);void revoker.post('/v1/auth/logout',undefined,()=>null).catch(()=>{}).finally(()=>revoker.invalidate())}
 async request<T>(path:string,method:string,body:unknown,parse:Validator<T>,binary=false):Promise<T>{
  this.assertActive();
  if(!path.startsWith('/v1/')||path.includes('://')||path.includes('..'))throw new PaymentError('INVALID_PATH');
  const controller=new AbortController();this.controllers.add(controller);const timer=setTimeout(()=>controller.abort(),15000);const write=method!=='GET';
  try{
   const response=await fetch(this.origin+path,{method,headers:{...(this.token?{Authorization:`Bearer ${this.token}`} : {}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal,credentials:'omit',redirect:'error',cache:'no-store'});
   this.assertActive(write);
   if(response.status===401){this.invalidate();this.unauthorized();throw new PaymentError('SESSION_EXPIRED',401,write)}
   if(!response.ok)throw new PaymentError(response.status===403?'PERMISSION_DENIED':response.status===409?'VERSION_OR_STATE_CHANGED':response.status===429?'RATE_LIMITED':`HTTP_${response.status}`,response.status,write&&(response.status>=500||response.status===408));
   if(response.status===204)return parse(null);
   const limit=binary?262144:1048576;
   if(Number(response.headers.get('content-length'))>limit)throw new PaymentError('RESPONSE_TOO_LARGE',0,write);
   if(!response.body)throw new PaymentError('INVALID_RESPONSE',0,write);
   const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
   while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit){void reader.cancel().catch(()=>{});throw new PaymentError('RESPONSE_TOO_LARGE',0,write)}chunks.push(value)}
   const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length}
   this.assertActive(write);
   try{return parse(binary?bytes:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)))}catch{throw new PaymentError('INVALID_RESPONSE',0,write)}
  }catch(error){if(error instanceof PaymentError)throw error;throw new PaymentError(controller.signal.aborted?'REQUEST_ABORTED':'NETWORK_ERROR',0,write)}finally{controller.abort();clearTimeout(timer);this.controllers.delete(controller)}
 }
 get<T>(path:string,parse:Validator<T>){return this.request(path,'GET',undefined,parse)}
 post<T>(path:string,body:unknown,parse:Validator<T>){return this.request(path,'POST',body,parse)}
 async mutate<T>(key:string,path:string,body:unknown,parse:Validator<T>,recoveryPath:string,recoveryIdentity?:Identity){
  this.assertActive();if(this.pending(key))throw new PaymentError('PENDING_REQUIRES_QUERY',0,true);
  const p:Pending={key,path,body:structuredClone(body),recoveryPath,queried:false,createdAt:new Date().toISOString(),replayable:true,attempts:0,proofs:recoveryIdentity?structuredClone(recoveryIdentity):undefined};this.recordsMap.set(key,p);
  let reserved=false;
  try{
   if(p.body&&typeof p.body==='object'&&!Array.isArray(p.body)){
    const b=p.body as Record<string,unknown>;
    const digest=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes)))).map(v=>v.toString(16).padStart(2,'0')).join('');
    const decoded=(value:string)=>{if(value.length>524288)throw Error('EVIDENCE_TOO_LARGE');return Uint8Array.from(atob(value),c=>c.charCodeAt(0))};
    if(typeof b.source_document_base64==='string'&&typeof b.evidence_base64==='string'){
     const source=await digest(decoded(b.source_document_base64));this.assertActive();
     const mapping=await digest(decoded(String(b.evidence_base64)));this.assertActive();p.proofs={evidence_sha256:source,mapping_sha256:mapping};
    }else if(typeof b.evidence_base64==='string'){
     const evidence=await digest(decoded(b.evidence_base64));this.assertActive();
     const execution=await digest(new TextEncoder().encode(JSON.stringify([b.external_reference,typeof b.executed_at==='string'?new Date(b.executed_at).toISOString():null])));this.assertActive();p.proofs={evidence_sha256:evidence,execution_sha256:execution};
    }
   }
   await storageLock(this.scope(),async()=>{
    this.assertActive();const refs=readReferences(this.origin,this.owner);
    if(refs.has(key))throw new PaymentError('PENDING_REQUIRES_QUERY',0,true);
    if(refs.size>=40)throw new PaymentError('RECOVERY_LIMIT');
    const ref=referenceOf(p);if(!validReference(ref))throw new PaymentError('INVALID_RECOVERY_REFERENCE');
    refs.set(key,ref);writeReferences(this.origin,this.owner,refs);reserved=true;
   });
  }catch(error){scrub(p);if(this.recordsMap.get(key)===p)this.recordsMap.delete(key);throw error}
  this.assertActive(reserved);
  return this.sendPending(p,parse);
 }
 private async sendPending<T>(p:Pending,parse:Validator<T>){
  this.assertActive();p.attempts++;const reference=referenceOf(p);
  try{const result=await this.post(p.path,p.body,parse);this.assertActive(true);try{await this.forget(p.key,reference)}catch{throw new PaymentError('RECOVERY_FINALIZATION_FAILED',0,true)}return result}
  catch(error){
   if(!this.active)throw new PaymentError('SESSION_CHANGED',0,true);
   if(error instanceof PaymentError&&!error.unknown&&p.attempts===1)await this.forget(p.key,reference);
   if(p.attempts>1)throw new PaymentError('ORIGINAL_OUTCOME_UNCONFIRMED',0,true);throw error;
  }
 }
 async recover<T>(key:string,parse:Validator<T>){
  this.assertActive();const p=this.pending(key);if(!p)throw new PaymentError('NO_PENDING_REQUEST');
  try{const result=await this.get(p.recoveryPath,parse);this.assertActive();if(this.pending(key)!==p)throw new PaymentError('RECOVERY_REFERENCE_CHANGED',0,true);p.queried=true;this.recovered.set(key,referenceOf(p));return result}
  catch(e){if(this.active&&e instanceof PaymentError&&e.status===404&&this.pending(key)===p)p.queried=true;throw e}
 }
 async retry<T>(key:string,parse:Validator<T>){
  this.assertActive();const p=this.pending(key);if(!p||!p.queried)throw new PaymentError('QUERY_REQUIRED');
  if(!p.replayable||p.body===undefined||!p.path)throw new PaymentError('ORIGINAL_PAYLOAD_UNAVAILABLE');
  if(p.path.endsWith('/rechecks'))throw new PaymentError('QUERY_ONLY_RECOVERY',0,true);p.queried=false;this.recovered.delete(key);return this.sendPending(p,parse);
 }
 async download(path:string,filename:string){const bytes=await this.request(path,'GET',undefined,v=>{if(!(v instanceof Uint8Array))throw Error();return v},true);this.assertActive();const url=URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:'application/octet-stream'}));const a=document.createElement('a');a.href=url;a.download=filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000)}
}
export function resolveApiOrigin(pageOrigin:string,localTest:string|undefined,configured:string|undefined):string{
 const page=new URL(pageOrigin);const localPage=['localhost','127.0.0.1','[::1]'].includes(page.hostname);
 if(localTest==='1'&&localPage&&configured){const u=new URL(configured);if(!['localhost','127.0.0.1','[::1]'].includes(u.hostname)||!['http:','https:'].includes(u.protocol)||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('INVALID_TEST_API');return u.origin}
 return page.origin==='https://q.kaicloudpay.com'?page.origin:'https://q.kaicloudpay.com';
}
export function apiOrigin():string{return resolveApiOrigin(location.origin,import.meta.env.VITE_Q_LOCAL_API_TEST,import.meta.env.VITE_Q_API_URL)}

export function paymentLoginAllowed(pageOrigin:string,localTest:string|undefined,configured:string|undefined):boolean {
 if(pageOrigin==='https://q.kaicloudpay.com')return true;
 if(localTest!=='1'||!configured)return false;
 try{const resolved=resolveApiOrigin(pageOrigin,localTest,configured);return resolved!=='https://q.kaicloudpay.com'}catch{return false}
}
