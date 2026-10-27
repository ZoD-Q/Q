import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { buildContext, finishStatus, prepareRetry, toolResultIsAnswered } from './state-model.ts';
import { WorkbenchError } from '../api-workbench/core.ts';
const resolver = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.includes('/prototype/') && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(specifier + '.ts', context);
  return next(specifier, context);
} });
test.after(() => resolver.deregister());
const message = (id,role,content,status='complete') => ({id,role,content,status});
test('saved tool data stays visible until its own result has a complete natural answer', () => {
  const id='11111111-1111-4111-8111-111111111111';
  const tool={...message('tool','assistant','','tool'),toolProposalId:id};
  const answer={...message('answer','assistant','Balance is HK$100,000 (demo).'),toolInvocationIds:[id]};
  const c={id:'c',title:'Balance',messages:[message('u','user','balance'),tool,answer]};
  assert.equal(toolResultIsAnswered(c,'tool'),true);
  for(const status of ['pending','streaming','error','incomplete','cancelled','tool']) assert.equal(toolResultIsAnswered({...c,messages:[tool,{...answer,status}]},'tool'),false,status);
  assert.equal(toolResultIsAnswered({...c,messages:[tool,{...answer,content:' '}]},'tool'),false);
  assert.equal(toolResultIsAnswered({...c,messages:[tool,{...answer,toolInvocationIds:[]}]},'tool'),false);
});
test('failed tool continuation retains its saved invocation IDs and preceding tool card', () => {
  const ids=['11111111-1111-4111-8111-111111111111'];
  const proposal={...message('tool','assistant','','tool'),toolProposalId:ids[0]};
  const failed={...message('retry','assistant','half','error'),toolInvocationIds:ids};
  const conversation={id:'c',title:'gallery',messages:[message('u','user','browse'),proposal,failed]};
  assert.deepEqual(prepareRetry(conversation),conversation.messages.slice(0,-1));
  assert.deepEqual(conversation.messages.at(-1).toolInvocationIds,ids);
  const complete={...failed,status:'complete',content:'Shown in viewer'};
  const context=buildContext([conversation.messages[0],proposal,complete,message('next','user','continue')]);
  assert.deepEqual(context.messages,[{role:'user',content:'browse'},{role:'assistant',content:'Shown in viewer'},{role:'user',content:'continue'}]);
});
test('multi-turn context keeps full answers and the latest user request', () => {
  const result=buildContext([message('1','user','记住松树'),message('2','assistant','记住了'),message('3','user','是什么？')]);
  assert.deepEqual(result,{messages:[{role:'user',content:'记住松树'},{role:'assistant',content:'记住了'},{role:'user',content:'是什么？'}],limited:false});
});
test('failed, cancelled and truncated turns never enter subsequent model context', () => {
  for(const status of ['pending','streaming','error','cancelled','incomplete']) {
    assert.deepEqual(buildContext([message('1','user','old'),message('2','assistant','half',status),message('3','user','new')]).messages,[{role:'user',content:'new'}]);
  }
});
test('long history is bounded by whole turns without clipping Unicode', () => {
  const history=[];
  for(let i=0;i<30;i++)history.push(message(`u${i}`,'user',`问${i}`),message(`a${i}`,'assistant',`答${i}`));
  const before=structuredClone(history);
  const result=buildContext([...history,message('last','user','最后🙂')]);
  assert.equal(result.messages.length,39);assert.equal(result.messages.at(-1).content,'最后🙂');assert.equal(result.limited,true);assert.deepEqual(history,before);
  const large=buildContext([message('u','user','🙂'.repeat(12000)),message('a','assistant','好'),message('last','user','🙂'.repeat(12000))]);
  assert.equal(large.messages.length,1);assert.equal(large.limited,true);assert.equal(Array.from(large.messages[0].content).length,12000);
});
test('new prompt is never silently truncated and empty prompts fail', () => {
  assert.throws(()=>buildContext([message('1','user','🙂'.repeat(12001))]),/MESSAGE_TOO_LONG/);
  assert.throws(()=>buildContext([message('1','user','   ')]),/EMPTY_MESSAGE/);
});
test('explicit retry removes only the last failed answer and never duplicates its user message', () => {
  const conversation={id:'c',title:'one',messages:[message('1','user','one'),message('2','assistant','half','error')]};
  const retried=prepareRetry(conversation);assert.equal(retried.length,1);assert.equal(retried[0].id,'1');assert.equal(conversation.messages.length,2);
  assert.equal(prepareRetry({...conversation,messages:[message('1','user','one'),message('2','assistant','done')]}),null);
});
test('only stop with a real answer is a complete turn',()=>{
  assert.equal(finishStatus('stop','answer'),'complete');
  assert.equal(finishStatus('stop',''),'incomplete');
  for(const reason of ['length','content_filter','aborted','insufficient_system_resource','tool_calls'])assert.equal(finishStatus(reason,'partial'),'incomplete');
});

test('history writer serializes revisions and retries unknown writes with identical payload', async () => {
  const { createHistoryWriter } = await import('./history.ts');
  const calls=[]; let fail=true; let sequence=0;
  const writer=createHistoryWriter(async(id,body)=>{
    calls.push(structuredClone(body));
    if(fail) { fail=false; throw Error('NETWORK_ERROR'); }
    return {...body,revision:body.expected_revision+1,updated_at:'2026-10-21T00:00:00Z'};
  },()=>`request-${++sequence}`);
  const conversation={id:'c',title:'hello',messages:[message('u','user','hello')]};
  await assert.rejects(writer.save(conversation),/NETWORK_ERROR/);
  await assert.rejects(writer.save({...conversation,title:'changed'}),/HISTORY_SAVE_PENDING/);
  await writer.retry({...conversation,title:'changed'});
  assert.deepEqual(calls[0],calls[1]);
  assert.deepEqual(Object.keys(calls[0]).sort(),['expected_revision','messages','request_id','title']);
  await Promise.all([writer.save(conversation),writer.save({...conversation,title:'next'})]);
  assert.deepEqual(calls.map(x=>x.expected_revision),[0,0,1,2]);
});

test('new history writes keep only plugin display fields and retries preserve the original snapshot', async () => {
  const { chatPluginSnapshot, createHistoryWriter } = await import('./history.ts');
  const display = { id: '11111111-1111-4111-8111-111111111111', title: 'HSBC demo', endpoint_url: 'urn:q:bank-demo:hsbc', connection_kind: 'bank_demo', builtin_service_id: 'q.bank-demo.hsbc' };
  const connection = { ...display, card_url: display.endpoint_url, status: 'ready', auth_status: 'anonymous', revision: 1, owner_name: 'Q', extra: { private: 'connection metadata' } };
  const before = structuredClone(connection);
  assert.deepEqual(chatPluginSnapshot(connection), display);
  assert.deepEqual(connection, before);
  const calls = []; let sequence = 0;
  const writer = createHistoryWriter(async (id, body) => {
    calls.push(structuredClone(body));
    if (calls.length === 1) throw Error('NETWORK_ERROR');
    return { id, ...body, revision: body.expected_revision + 1, updated_at: '2026-10-21T00:00:00Z' };
  }, () => `request-${++sequence}`);
  const conversation = { id: 'c', title: 'bank chat', messages: [message('u', 'user', 'hello')], plugin: connection };
  await assert.rejects(writer.save(conversation), /NETWORK_ERROR/);
  assert.deepEqual(calls[0].plugin, display);
  connection.title = 'Changed after the failed request';
  connection.builtin_service_id = 'q.bank-demo.bochk';
  conversation.messages[0].content = 'new message';
  await assert.rejects(writer.save(conversation), /HISTORY_SAVE_PENDING/);
  await writer.retry(conversation);
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(sequence, 1);
  assert.equal(writer.hasPending('c'), false);

  const remote = { id: display.id, title: 'Remote', endpoint_url: 'https://example.invalid/mcp', card_url: 'https://example.invalid/card', status: 'ready' };
  assert.deepEqual(chatPluginSnapshot(remote), { id: remote.id, title: remote.title, endpoint_url: remote.endpoint_url });
  assert.deepEqual(chatPluginSnapshot({ ...remote, connection_kind: 'remote_mcp', builtin_service_id: null }), { id: remote.id, title: remote.title, endpoint_url: remote.endpoint_url, connection_kind: 'remote_mcp', builtin_service_id: null });
});

test('an explicitly rejected history snapshot can be corrected without changing its CAS revision or message identities', async () => {
  const { createHistoryWriter } = await import('./history.ts');
  const calls = []; let sequence = 0;
  const writer = createHistoryWriter(async (id, body) => {
    calls.push(structuredClone(body));
    if (!body.title.trim()) throw new WorkbenchError('VALIDATION_ERROR', 400);
    return { id, ...body, revision: body.expected_revision + 1, updated_at: '2026-10-26T00:00:00Z' };
  }, () => `request-${++sequence}`);
  const conversation = { id: 'c', title: ' ', messages: [message('user-1', 'user', '你好')] };
  writer.seed('c', 7);
  await assert.rejects(writer.save(conversation), /VALIDATION_ERROR/);
  assert.equal(writer.hasPending('c'), true);
  await assert.rejects(writer.retry(conversation), /VALIDATION_ERROR/);
  assert.deepEqual(calls[1], calls[0]); // Unchanged input never allocates another key.
  conversation.title = '你好';
  await assert.rejects(writer.save(conversation), /HISTORY_SAVE_PENDING/);
  writer.seed('c', 99, true); // A summary refresh must not bypass the original CAS.
  await writer.retry(conversation);
  assert.equal(calls.length, 3);
  assert.equal(sequence, 2);
  assert.equal(calls[2].expected_revision, 7);
  assert.notEqual(calls[2].request_id, calls[0].request_id);
  assert.deepEqual(calls[2].messages, calls[0].messages);
  assert.equal(calls[2].title, '你好');
  assert.equal(writer.hasPending('c'), false);
});

test('uncertain history attempts stay immutable even if a later attempt receives validation or conflict errors', async () => {
  const { createHistoryWriter } = await import('./history.ts');
  const errors = [
    new WorkbenchError('NETWORK_ERROR'), new WorkbenchError('REQUEST_TIMEOUT'),
    new WorkbenchError('CANCELLED'), new WorkbenchError('UNAUTHORIZED', 401),
    new WorkbenchError('RATE_LIMITED', 429), new WorkbenchError('REQUEST_FAILED', 503),
    new WorkbenchError('AI_HISTORY_CONFLICT', 409), new WorkbenchError('AI_HISTORY_REQUEST_REUSED', 409),
    new WorkbenchError('VALIDATION_ERROR', 0), new Error('VALIDATION_ERROR'),
  ];
  for (const failure of errors) {
    const calls = []; let sequence = 0;
    const writer = createHistoryWriter(async (id, body) => {
      calls.push(structuredClone(body));
      if (calls.length === 1) throw failure;
      if (calls.length === 2) throw new WorkbenchError('VALIDATION_ERROR', 400);
      return { id, ...body, revision: body.expected_revision + 1, updated_at: '2026-10-26T00:00:00Z' };
    }, () => `request-${++sequence}`);
    const original = { id: 'c', title: 'Original', messages: [message('u', 'user', '你好')] };
    await assert.rejects(writer.save(original));
    const corrected = { ...original, title: 'Corrected' };
    await assert.rejects(writer.retry(corrected), /VALIDATION_ERROR/);
    await writer.retry(corrected);
    assert.deepEqual(calls, [calls[0], calls[0], calls[0]], failure.message);
    assert.equal(sequence, 1);
  }
});

test('a corrected validation rejection becomes immutable as soon as its result is unknown', async () => {
  const { createHistoryWriter } = await import('./history.ts');
  const calls = []; let sequence = 0;
  const writer = createHistoryWriter(async (id, body) => {
    calls.push(structuredClone(body));
    if (calls.length === 1 || calls.length === 3) throw new WorkbenchError('VALIDATION_ERROR', 400);
    if (calls.length === 2) throw new WorkbenchError('REQUEST_TIMEOUT');
    return { id, ...body, revision: body.expected_revision + 1, updated_at: '2026-10-26T00:00:00Z' };
  }, () => `request-${++sequence}`);
  const conversation = { id: 'c', title: 'Original', messages: [message('u', 'user', '你好'), { ...message('a', 'assistant', '', 'error'), toolInvocationIds: ['11111111-1111-4111-8111-111111111111'] }] };
  writer.seed('c', 4);
  await assert.rejects(writer.save(conversation), /VALIDATION_ERROR/);
  conversation.title = 'Corrected';
  await assert.rejects(writer.retry(conversation), /REQUEST_TIMEOUT/);
  conversation.title = 'Changed again';
  await assert.rejects(writer.retry(conversation), /VALIDATION_ERROR/);
  await writer.retry(conversation);
  assert.equal(sequence, 2);
  assert.notEqual(calls[0].request_id, calls[1].request_id);
  assert.equal(calls[1].expected_revision, 4);
  assert.deepEqual(calls[1].messages, calls[0].messages);
  assert.deepEqual(calls[2], calls[1]);
  assert.deepEqual(calls[3], calls[1]);
});

test('restored history interrupts unfinished streams and preserves tool metadata without running tools', async () => {
  const { decodeHistory,restoreHistory,decodeHistoryPage }=await import('./history.ts');
  const id='11111111-1111-4111-8111-111111111111';
  const detail={id,title:'hello',revision:1,updated_at:'2026-10-21T00:00:00Z',messages:[{...message(id,'assistant','half','streaming'),toolProposalId:id,toolInvocationIds:[id]}]};
  const restored=restoreHistory(decodeHistory(detail));
  assert.equal(restored.messages[0].status,'cancelled');
  assert.equal(restored.messages[0].toolProposalId,id);
  assert.deepEqual(restored.messages[0].toolInvocationIds,[id]);
  assert.equal(detail.messages[0].status,'streaming');
  assert.throws(()=>decodeHistory({...detail,messages:[{...detail.messages[0],toolInvocationIds:['invalid']}]}),/INVALID_RESPONSE/);
  assert.throws(()=>decodeHistoryPage({items:[],next_cursor:'invalid'}),/INVALID_RESPONSE/);
});

test('summary refresh never advances revision of a local hydrated snapshot', async () => {
  const { createHistoryWriter } = await import('./history.ts');
  const revisions=[];
  const writer=createHistoryWriter(async(id,body)=>{ revisions.push(body.expected_revision); return {...body,id,revision:body.expected_revision+1,updated_at:'2026-10-21T00:00:00Z'}; },()=> 'request');
  writer.seed('c',1,true);
  writer.seed('c',2);
  await writer.save({id:'c',title:'local revision one',messages:[]});
  assert.deepEqual(revisions,[1]);
  writer.seed('c',7,true);
  await writer.save({id:'c',title:'loaded remote seven',messages:[]});
  assert.deepEqual(revisions,[1,7]);
});

test('cloud replacement waits for an uncertain retry before fetching and replacing the snapshot', async () => {
  const { createHistoryWriter }=await import('./history.ts');
  let resolveSave; let attempts=0; let cloudRevision=1;
  const writer=createHistoryWriter(async(id,body)=>{
    if(attempts++===0) throw Error('NETWORK_ERROR');
    await new Promise(resolve=> {resolveSave=resolve;});
    cloudRevision=body.expected_revision+1;
    return {...body,id,revision:cloudRevision,updated_at:'2026-10-21T00:00:00Z'};
  },()=> 'request');
  const c={id:'c',title:'local',messages:[]};
  writer.seed(c.id,1,true);
  await assert.rejects(writer.save(c));
  const retry=writer.retry(c);
  let fetched=false;
  const reload=(async()=> {await writer.drain(); fetched=true; writer.discard(c.id,cloudRevision);})();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(fetched,false);
  resolveSave(); await Promise.all([retry,reload]);
  assert.equal(fetched,true); assert.equal(cloudRevision,2);
});

test('financial result markers cannot enter cloud history or model context even when the local flag is lost', async () => {
  const { createHistoryWriter } = await import('./history.ts');
  let writes = 0;
  const writer = createHistoryWriter(async () => { writes++; throw new Error('must not write'); }, () => 'request');
  for (const local of [
    { id: 'private', title: 'private', localOnly: true, messages: [message('u', 'user', 'private')] },
    { id: 'private', title: 'private', messages: [{ ...message('u', 'user', 'private'), localFinance: true }] },
    { id: 'private', title: 'private', messages: [{ ...message('a', 'assistant', 'private'), financeResult: { kind: 'bills' } }] },
  ]) {
    await assert.rejects(writer.save(local), /LOCAL_FINANCE_PRIVATE/);
    await assert.rejects(writer.retry(local), /LOCAL_FINANCE_PRIVATE/);
  }
  assert.equal(writes, 0);
  assert.throws(() => buildContext([{ ...message('u', 'user', 'private'), localFinance: true }]), /LOCAL_FINANCE_PRIVATE/);
  assert.throws(() => buildContext([{ ...message('u', 'user', 'private'), financeResult: { kind: 'bills' } }]), /LOCAL_FINANCE_PRIVATE/);
});

test('financial AI guidance is included in the bounded context without modifying the original conversation', () => {
  const messages = [message('u', 'user', 'Explain a concept')];
  const before = structuredClone(messages);
  assert.equal(buildContext(messages, 'Public financial guidance').messages[0].content, 'Public financial guidance\n\nExplain a concept');
  assert.deepEqual(messages, before);
  assert.throws(() => buildContext([message('u', 'user', 'x'.repeat(12000))], 'Guidance'), /FINANCE_MESSAGE_TOO_LONG/);
});
