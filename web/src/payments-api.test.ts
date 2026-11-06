import test from 'node:test';
import assert from 'node:assert/strict';
import { PaymentApi, PaymentError, resolveApiOrigin, paymentRecoveryStorageKey, paymentLoginAllowed } from './payments/api';
import { parseOperator, object, amount, parseSettlement } from './payments/types';
const store=new Map<string,string>();
Object.defineProperty(globalThis,'localStorage',{value:{getItem:(k:string)=>store.get(k)??null,setItem:(k:string,v:string)=>{store.set(k,v)},removeItem:(k:string)=>store.delete(k)},configurable:true});
const response=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json'}});

test('uncertain mutations retain original identity, require a read, and cannot cross accounts',async()=>{
 const original=globalThis.fetch;const requests:{method:string;body:string}[]=[];let fail=true;
 globalThis.fetch=async(_url,init)=>{requests.push({method:init?.method??'GET',body:String(init?.body??'')});if(fail)throw Error('network');return response({status:'ok'})};
 try{const api=new PaymentApi('secret-token','owner-api-test',()=>{},'https://q.kaicloudpay.com');
 const body={client_request_id:'44444444-4444-4444-8444-444444444444',reason:'private reason',evidence_base64:btoa('private mapping'),source_document_base64:btoa('private file')};
 await assert.rejects(api.mutate('settlement-import','/v1/payments/operator/settlements',body,object,'/v1/payments/operator/settlements/by-client-key/44444444-4444-4444-8444-444444444444'),(e:unknown)=>e instanceof PaymentError&&e.unknown);
 assert.deepEqual(api.pending('settlement-import')?.body,body);
 assert.equal(new PaymentApi('another','different-owner',()=>{},'https://q.kaicloudpay.com').pending('settlement-import'),undefined);
 await assert.rejects(api.mutate('settlement-import','/v1/payments/operator/settlements',{client_request_id:'new-key'},object,'/v1/payments/operator/settlements'),/PENDING_REQUIRES_QUERY/);
 await assert.rejects(api.retry('settlement-import',object),/QUERY_REQUIRED/);
 const persisted=JSON.stringify([...store.values()]);assert(!persisted.includes('secret-token'));assert(!persisted.includes('private reason'));assert(!persisted.includes('private file'));assert(persisted.includes('44444444-4444-4444-8444-444444444444'));
 fail=false;await api.recover('settlement-import',object);assert(api.pending('settlement-import'));
 await api.retry('settlement-import',object);assert.equal(api.pending('settlement-import'),undefined);
 assert.equal(requests[0].body,requests[2].body);
 }finally{globalThis.fetch=original}
});

test('401 preserves pending requests and invalidates only its own session callback',async()=>{
 const original=globalThis.fetch;let expired=0;globalThis.fetch=async()=>response({},401);
 try{const api=new PaymentApi('token','owner-expire',()=>{expired++;api.invalidate()},'https://q.kaicloudpay.com');await assert.rejects(api.mutate('order:44444444-4444-4444-8444-444444444444','/v1/payments/orders/44444444-4444-4444-8444-444444444444/approvals',{proposal_id:'55555555-5555-4555-8555-555555555555',evidence_version:1},object,'/v1/payments/operator/orders/44444444-4444-4444-8444-444444444444'),(e:unknown)=>e instanceof PaymentError&&e.unknown);assert.equal(expired,1);assert(api.pending('order:44444444-4444-4444-8444-444444444444'));await assert.rejects(api.get('/v1/payments/operator/me',object),/SESSION_CHANGED/)}finally{globalThis.fetch=original}
});

test('late responses after invalidation cannot update a new account',async()=>{
 const original=globalThis.fetch;let resolve!:(value:Response)=>void;globalThis.fetch=()=>new Promise<Response>(r=>{resolve=r});
 try{const api=new PaymentApi('token','owner-stale',()=>assert.fail('stale unauthorized callback'),'https://q.kaicloudpay.com');const request=api.get('/v1/payments/operator/me',parseOperator);api.invalidate();resolve(response({},401));await assert.rejects(request,/SESSION_CHANGED/)}finally{globalThis.fetch=original}
});

test('malformed or oversized successful write responses are unknown, never safe new writes',async()=>{
 const original=globalThis.fetch;globalThis.fetch=async()=>response({roles:['administrator']});
 try{const api=new PaymentApi('token','owner-malformed',()=>{},'https://q.kaicloudpay.com');await assert.rejects(api.mutate('fx-activation','/v1/payments/fx/activations',{candidate_id:'55555555-5555-4555-8555-555555555555',evidence_sha256:'a'.repeat(64),expected_generation:1},parseOperator,'/v1/payments/fx/status'),(e:unknown)=>e instanceof PaymentError&&e.unknown);assert(api.pending('fx-activation'));assert.throws(()=>parseOperator({user_id:'a',server_time:'now',roles:['admin']}));}finally{globalThis.fetch=original}
});

test('local API override requires both explicit test build and a loopback page; production stays official',()=>{
 assert.equal(resolveApiOrigin('http://localhost:4173','1','http://127.0.0.1:8787'),'http://127.0.0.1:8787');
 assert.equal(resolveApiOrigin('http://localhost:4173',undefined,'http://127.0.0.1:8787'),'https://q.kaicloudpay.com');
 assert.equal(resolveApiOrigin('https://8.163.108.216','1','http://127.0.0.1:8787'),'https://q.kaicloudpay.com');
 assert.throws(()=>resolveApiOrigin('http://localhost:4173','1','https://attacker.example'));
 assert.throws(()=>resolveApiOrigin('http://localhost:4173','1','http://user:secret@127.0.0.1:8787'));
});

test('monetary displays preserve every minor unit and settlement differences include a batch-level mismatch',()=>{
 assert.equal(amount(9007199254740991,'HKD'),'HK$90,071,992,547,409.91');
 const s={settlement_id:'id',client_request_id:'key',kind:'bank_settlement',source:'fixture',currency:'CNY',status:'differences',mapping_sha256:'a'.repeat(64),evidence_sha256:'b'.repeat(64),source_document_media_type:'text/csv',source_validation:'operator_supplied',bank_reference:'ref',bank_amount_minor:1,record_count:200,matched_count:0,check_version:1,differences:[...Array.from({length:200},(_,i)=>({row:i+1,code:'Q_ORDER_MISSING'})),{row:0,code:'BANK_NET_AMOUNT_MISMATCH'}],maker_id:'maker',checker_id:null,created_at:'date',verified_at:null};
 assert.equal(parseSettlement(s).differences.length,201);
 assert.throws(()=>parseSettlement({...s,differences:[{row:201,code:'OUT_OF_RANGE'}]}));
});

test('corrupted recovery references fail closed before any new write',async()=>{
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return response({})};
 try{store.set(paymentRecoveryStorageKey('https://q.kaicloudpay.com','broken-owner'),'{broken');const api=new PaymentApi('token','broken-owner',()=>{},'https://q.kaicloudpay.com');await assert.rejects(api.mutate('new','/v1/payments/fx/activations',{},object,'/v1/payments/fx/status'),/RECOVERY_DATA_INVALID/);assert.equal(calls,0)}finally{globalThis.fetch=original}
});

test('syntactically valid but semantically corrupt recovery metadata also blocks new writes',async()=>{
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return response({})};
 try{store.set(paymentRecoveryStorageKey('https://q.kaicloudpay.com','bad-fields'),JSON.stringify({version:2,origin:'https://q.kaicloudpay.com',owner:'bad-fields',items:[{key:'',path:'',recoveryPath:'/v1/payments/',createdAt:'',identity:null}]}));const api=new PaymentApi('token','bad-fields',()=>{},'https://q.kaicloudpay.com');await assert.rejects(api.mutate('new','/v1/payments/fx/activations',{},object,'/v1/payments/fx/status'),/RECOVERY_DATA_INVALID/);assert.equal(calls,0)}finally{globalThis.fetch=original}
});

const originalId='44444444-4444-4444-8444-444444444444';
const otherId='66666666-6666-4666-8666-666666666666';
const settlementBody=(id=originalId)=>({client_request_id:id,reason:'bank-private-note',evidence_base64:btoa('mapping-private'),source_document_base64:btoa('bank-original-private')});
const recovery=(id=originalId)=>`/v1/payments/operator/settlements/by-client-key/${id}`;
const importPath='/v1/payments/operator/settlements';

test('same account on different API origins cannot read or replay another service request; disk envelopes bind origin',async()=>{
 const original=globalThis.fetch;const urls:string[]=[];globalThis.fetch=async input=>{urls.push(String(input));throw Error('offline')};
 const a='http://127.0.0.1:18787',b='http://127.0.0.1:18788',owner='origin-owner';
 try{
  const left=new PaymentApi('left-token',owner,()=>{},a);const right=new PaymentApi('right-token',owner,()=>{},b);
  await assert.rejects(left.mutate('settlement-import',importPath,settlementBody(),object,recovery()));
  assert.equal(right.pending('settlement-import'),undefined);await assert.rejects(right.retry('settlement-import',object),/QUERY_REQUIRED/);assert.equal(urls.length,1);
  await assert.rejects(right.mutate('settlement-import',importPath,settlementBody(otherId),object,recovery(otherId)));
  assert.equal(urls[1],b+importPath);assert.notDeepEqual(left.pending('settlement-import')?.body,right.pending('settlement-import')?.body);
  const record=JSON.parse(store.get(paymentRecoveryStorageKey(a,owner))!);assert.equal(record.origin,a);assert.equal(record.owner,owner);assert(!JSON.stringify(record).includes('left-token'));
  store.set(paymentRecoveryStorageKey(b,owner),JSON.stringify(record));
  const tampered=new PaymentApi('b',owner,()=>{},b);assert.equal(tampered.pending('settlement-import'),undefined);
  await assert.rejects(tampered.mutate('settlement-import',importPath,settlementBody(),object,recovery()),/RECOVERY_DATA_INVALID/);assert.equal(urls.length,2);
  left.invalidate();assert.equal(JSON.parse(store.get(paymentRecoveryStorageKey(a,owner))!).origin,a);
 }finally{globalThis.fetch=original}
});

test('a corrupted or blocked origin does not poison the same account on another origin',async()=>{
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('offline')};
 const owner='blocked-origin-owner',a='http://localhost:18787',b='https://q.kaicloudpay.com';
 try{store.set(paymentRecoveryStorageKey(a,owner),'{broken');const left=new PaymentApi('a',owner,()=>{},a),right=new PaymentApi('b',owner,()=>{},b);
 await assert.rejects(left.mutate('settlement-import',importPath,settlementBody(),object,recovery()),/RECOVERY_DATA_INVALID/);
 await assert.rejects(right.mutate('settlement-import',importPath,settlementBody(),object,recovery()),(e:unknown)=>e instanceof PaymentError&&e.unknown);assert.equal(calls,1);assert(right.pending('settlement-import'));
 }finally{globalThis.fetch=original}
});

test('invalidate scrubs captured payloads and a new session only gets recovery identities, never a replayable file',async()=>{
 const original=globalThis.fetch;globalThis.fetch=async()=>{throw Error('offline')};
 const origin='https://q.kaicloudpay.com',owner='scrub-owner';
 try{const api=new PaymentApi('old-token',owner,()=>{},origin);await assert.rejects(api.mutate('settlement-import',importPath,settlementBody(),object,recovery()));
 const captured=api.pending('settlement-import')!;const heldBody=captured.body;assert(JSON.stringify(heldBody).includes('bank-private-note'));
 api.invalidate();assert.equal(captured.replayable,false);assert.equal(captured.queried,false);assert(!JSON.stringify(heldBody).includes('bank-private-note'));assert(!JSON.stringify(captured).includes('source_document_base64'));assert(!JSON.stringify(api).includes('old-token'));
 const next=new PaymentApi('new-token',owner,()=>{},origin);assert.equal(next.pending('settlement-import')?.replayable,false);assert.equal(object(next.pending('settlement-import')?.body).client_request_id,originalId);
 globalThis.fetch=async()=>response({found:true});await next.recover('settlement-import',object);await assert.rejects(next.retry('settlement-import',object),/ORIGINAL_PAYLOAD_UNAVAILABLE/);
 assert(!JSON.stringify([...store.values()]).includes('bank-original-private'));await next.clearPending('settlement-import');assert.equal(next.pending('settlement-import'),undefined);
 }finally{globalThis.fetch=original}
});

test('a late logout or 401 from an old client cannot scrub the new session or its pending request',async()=>{
 const original=globalThis.fetch;let logoutReply!:(r:Response)=>void;let staleReply!:(r:Response)=>void;
 globalThis.fetch=async(input)=>{if(String(input).endsWith('/auth/logout'))return new Promise<Response>(r=>{logoutReply=r});if(String(input).endsWith('/operator/me'))return new Promise<Response>(r=>{staleReply=r});throw Error('offline')};
 try{const owner='late-owner',origin='https://q.kaicloudpay.com';let expired=0;const old=new PaymentApi('old-token',owner,()=>{expired++},origin);const stale=old.get('/v1/payments/operator/me',object);old.logout();
 const next=new PaymentApi('new-token',owner,()=>{expired++},origin);await assert.rejects(next.mutate('settlement-import',importPath,settlementBody(),object,recovery()));const held=next.pending('settlement-import')!;
 staleReply(response({},401));await assert.rejects(stale,/SESSION_CHANGED/);logoutReply(new Response(null,{status:204}));await new Promise(r=>setTimeout(r,0));
 assert.equal(expired,0);assert.equal(held.replayable,true);assert(JSON.stringify(held.body).includes('bank-private-note'));next.invalidate();
 }finally{globalThis.fetch=original}
});

test('concurrent clients merge pending references and a stale clear cannot delete a replacement request',async()=>{
 const original=globalThis.fetch;globalThis.fetch=async()=>{throw Error('offline')};const origin='https://q.kaicloudpay.com',owner='concurrent-owner';
 try{const a=new PaymentApi('a',owner,()=>{},origin),b=new PaymentApi('b',owner,()=>{},origin);
 const fx={candidate_id:otherId,evidence_sha256:'a'.repeat(64),expected_generation:1};
 await Promise.all([assert.rejects(a.mutate('settlement-import',importPath,settlementBody(),object,recovery())),assert.rejects(b.mutate('fx-activation','/v1/payments/fx/activations',fx,object,'/v1/payments/fx/status'))]);
 assert.equal(a.pendingList().length,2);assert.equal(b.pendingList().length,2);
 globalThis.fetch=async()=>response({found:true});await a.recover('settlement-import',object);await b.recover('settlement-import',object);await b.clearPending('settlement-import');
 globalThis.fetch=async()=>{throw Error('offline')};await assert.rejects(b.mutate('settlement-import',importPath,settlementBody(otherId),object,recovery(otherId)));
 await assert.rejects(a.clearPending('settlement-import'),/RECOVERY_REFERENCE_CHANGED/);assert.equal(object(b.pending('settlement-import')!.body).client_request_id,otherId);
 }finally{globalThis.fetch=original}
});

test('owner-only legacy references are never guessed into an API origin',async()=>{
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return response({})};
 try{store.set('q-payment-recovery-v1:legacy-owner',JSON.stringify([{client_request_id:originalId}]));const api=new PaymentApi('x','legacy-owner',()=>{},'https://q.kaicloudpay.com');await assert.rejects(api.mutate('settlement-import',importPath,settlementBody(),object,recovery()),/LEGACY_RECOVERY_ORIGIN_REQUIRED/);assert.equal(calls,0);assert(store.has('q-payment-recovery-v1:legacy-owner'))}finally{globalThis.fetch=original}
});

test('recheck recovery metadata stays outside the POST body and cannot be replayed',async()=>{
 const original=globalThis.fetch;let posted='';globalThis.fetch=async(_url,init)=>{if(init?.method==='POST'){posted=String(init.body);throw Error('offline')}return response({check_version:2})};
 try{const api=new PaymentApi('token','recheck-owner',()=>{},'https://q.kaicloudpay.com');const key=`settlement-recheck:${originalId}`;
 await assert.rejects(api.mutate(key,`${importPath}/${originalId}/rechecks`,{},object,`${importPath}/${originalId}`,{check_version:1,evidence_sha256:'a'.repeat(64),mapping_sha256:'b'.repeat(64)}));
 assert.equal(posted,'{}');await api.recover(key,object);await assert.rejects(api.retry(key,object),/QUERY_ONLY_RECOVERY/);
 api.invalidate();const next=new PaymentApi('new','recheck-owner',()=>{},'https://q.kaicloudpay.com');assert.equal(object(next.pending(key)?.body).check_version,1);assert.equal(next.pending(key)?.replayable,false);
 }finally{globalThis.fetch=original}
});

test('credential entry is limited to official origin or explicit loopback QA',()=>{
 assert(paymentLoginAllowed('https://q.kaicloudpay.com',undefined,undefined));
 assert(!paymentLoginAllowed('https://8.163.108.216',undefined,undefined));
 assert(!paymentLoginAllowed('http://127.0.0.1:18082',undefined,undefined));
 assert(paymentLoginAllowed('http://127.0.0.1:18082','1','http://127.0.0.1:18788'));
 assert(!paymentLoginAllowed('https://q.kaicloudpay.com.attacker.test','1','http://127.0.0.1:18788'));
 assert(!paymentLoginAllowed('http://q.kaicloudpay.com','1','http://127.0.0.1:18788'));
});

test('early response rejection aborts the transport even while the body never finishes',async()=>{
 const original=globalThis.fetch;let aborted=0;
 globalThis.fetch=async(_url,init)=>{init?.signal?.addEventListener('abort',()=>{aborted++});return new Response(new ReadableStream({pull(){return new Promise(()=>{})}}),{headers:{'content-length':'1048577'}})};
 try{const api=new PaymentApi('token','abort-body-owner',()=>{},'https://q.kaicloudpay.com');await assert.rejects(api.get('/v1/payments/operator/me',object),/RESPONSE_TOO_LARGE/);assert.equal(aborted,1)}finally{globalThis.fetch=original}
});

test('an untrusted cancel promise cannot block an oversized body rejection',async()=>{
 const original=globalThis.fetch;let cancelled=0,aborted=0;
 globalThis.fetch=async(_url,init)=>{init?.signal?.addEventListener('abort',()=>{aborted++});return new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(1048577))},cancel(){cancelled++;return new Promise(()=>{})}}))};
 try{const api=new PaymentApi('token','cancel-body-owner',()=>{},'https://q.kaicloudpay.com');await assert.rejects(api.get('/v1/payments/operator/me',object),/RESPONSE_TOO_LARGE/);assert.equal(cancelled,1);assert.equal(aborted,1)}finally{globalThis.fetch=original}
});
