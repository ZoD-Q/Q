import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const resolver=registerHooks({resolve(specifier,context,next){if(context.parentURL?.includes('/prototype/')&&specifier.startsWith('.')&&!/\.[a-z]+$/i.test(specifier))return next(specifier+'.ts',context);return next(specifier,context);}});
const core=await import('./fred-core.ts');
test.after(()=>resolver.deregister());
const tool={name:'fred-search-series',description:'Search data',inputSchema:{type:'object',properties:{search_text:{type:'string',minLength:2},limit:{type:'integer',minimum:1,maximum:20},frequency:{type:'string',enum:['m','q']}},required:['search_text']}};
test('runtime schema fields bind exact arguments and reject missing, range and enum errors',()=>{
 const fields=core.fredFields(tool);assert.deepEqual(core.fredArguments(fields,{search_text:'inflation',limit:'10'}),{search_text:'inflation',limit:10});
 for(const args of [{},{search_text:'i'},{search_text:'inflation',limit:'21'},{search_text:'inflation',limit:'2.2'},{search_text:'inflation',frequency:'yearly'}])assert.throws(()=>core.fredArguments(fields,args));
 assert.throws(()=>core.fredFields({...tool,inputSchema:{type:'object',properties:{nested:{type:'object'}},required:['nested']}}));
 assert.throws(()=>core.decodeFredCatalog({connection_revision:1,retention:'persisted',items:[tool]}));
 assert.throws(()=>core.decodeFredCatalog({connection_revision:1,retention:'ephemeral',items:[tool,tool]}));
});
test('date inputs reject impossible dates without creating a query',()=>{
 const fields=[{name:'date',type:'string',format:'date',required:true}];for(const date of ['2026-99-01','2026-02-30','2026-1-01'])assert.throws(()=>core.fredArguments(fields,{date}),error=>error.code==='FRED_INPUT_INVALID');
});
const expected={id:'connection',revision:2,tool:tool.name};
const reply={connection_id:'connection',connection_revision:2,tool_name:tool.name,retention:'ephemeral',retrieved_at:'2026-11-08T00:00:00Z',result:{content:[{type:'text',text:JSON.stringify({observations:[{date:'2026-01-01',value:'.'},{date:'2026-02-01',value:'4.2'}]})}]}};
test('display formats records without raw JSON, preserves missing values and rejects stale result bindings',()=>{
 const result=core.decodeFredReading(reply,expected,'en');assert.ok(result.rows.some(row=>row.value==='Missing'));assert.ok(result.rows.some(row=>row.value==='4.2'));assert.ok(result.rows.every(row=>!row.value.startsWith('{')));
 for(const patch of [{connection_id:'other'},{connection_revision:3},{tool_name:'fred-graph-series'},{retention:'persistent'},{result:{isError:true,content:[]}}])assert.throws(()=>core.decodeFredReading({...reply,...patch},expected,'en'));
 const bounded=core.decodeFredReading({...reply,result:{structuredContent:{observations:Array.from({length:300},(_,i)=>({date:'2026-01-01',value:i}))}}},expected,'en');assert.equal(bounded.limited,true);assert.equal(bounded.rows.length,160);
});
