import assert from 'node:assert/strict';
import test from 'node:test';
import { buildContext, finishStatus, prepareRetry } from './state-model.ts';
const message = (id,role,content,status='complete') => ({id,role,content,status});
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
