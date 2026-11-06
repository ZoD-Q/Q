import assert from 'node:assert/strict';
import test from 'node:test';
import { parseNewsCache, buildResearchDraft } from './core.ts';

const query={kind:'news',topic:'central_banks'};
const fixture=()=>({version:1,topic:'central_banks',server_time:'2026-11-05T02:00:00Z',status:'partial',
  records:[{title:'Policy release',url:'https://www.federalreserve.gov/newsevents/pressreleases/policy.htm',source_id:'fed',publisher:'Federal Reserve',published_at:'2026-10-28T18:00:00Z',indexed_at:null}],
  sources:[
    {id:'fed',name:'Federal Reserve',url:'https://www.federalreserve.gov/feeds/press_monetary.xml',status:'ready',last_checked_at:'2026-11-05T01:59:00Z',last_success_at:'2026-11-05T01:59:00Z',retry_at:'2026-11-05T02:14:00Z',error_code:null},
    {id:'ecb',name:'European Central Bank',url:'https://www.ecb.europa.eu/rss/press.html',status:'unavailable',last_checked_at:'2026-11-05T01:59:00Z',last_success_at:null,retry_at:'2026-11-05T02:04:00Z',error_code:'timeout'},
  ]});
const invalid=value=>assert.throws(()=>parseNewsCache(value,query),error=>error.code==='invalid_data');

test('partial official cache preserves publication, collection and cache-read times separately',()=>{
  const report=parseNewsCache(fixture(),query);
  assert.equal(report.newsCache.status,'partial');assert.equal(report.records[0].timeKind,'published');
  assert.equal(report.records[0].observedAt,'2026-10-28T18:00:00.000Z');
  assert.equal(report.newsCache.sources[0].lastSuccessAt,'2026-11-05T01:59:00.000Z');
  assert.equal(report.fetchedAt,'2026-11-05T02:00:00.000Z');
  assert.ok(!report.limitations.includes('index_time_not_publication'));
  const draft=buildResearchDraft(report,'zh');assert.match(draft,/央行动态/);assert.match(draft,/不代表全网/);assert.match(draft,/Policy release/);
});
test('wrong topic, forged aggregate status, source URL/name/id and duplicate source are rejected',()=>{
  for(const change of [value=>value.topic='markets',value=>value.version=2,value=>value.status='ready',value=>value.sources[0].url='https://evil.example/feed',value=>value.sources[0].name='Wrong publisher',value=>value.sources[1]=value.sources[0],value=>value.records[0].source_id='gdelt_markets']) {const value=fixture();change(value);invalid(value);}
});
test('cache age and source/time identities prevent displaying unavailable or forged records',()=>{
  for(const change of [value=>value.sources[0].last_success_at='2026-11-03T00:00:00Z',value=>value.sources[0].last_success_at='2026-11-06T00:00:00Z',value=>value.records[0].indexed_at='2026-11-05T01:00:00Z',value=>value.records[0].published_at='2026-11-06T00:00:00Z',value=>value.records[0].url='https://evil.example/a',value=>value.sources[0].retry_at='bad date',value=>value.records=Array(21).fill(value.records[0])]) {const value=fixture();change(value);invalid(value);}
});
test('unavailable state is distinct from a validated empty source feed',()=>{
  const unavailable=fixture();unavailable.records=[];unavailable.sources[0].status='unavailable';unavailable.sources[0].last_success_at=null;unavailable.status='unavailable';
  const failed=parseNewsCache(unavailable,query);assert.equal(failed.newsCache.status,'unavailable');assert.equal(failed.records.length,0);
  const empty=fixture();empty.records=[];empty.sources[1]={...empty.sources[1],status:'ready',last_success_at:empty.sources[0].last_success_at,error_code:null};empty.status='ready';
  assert.equal(parseNewsCache(empty,query).newsCache.status,'ready');
});
