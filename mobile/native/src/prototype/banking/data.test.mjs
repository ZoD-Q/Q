import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const resolver=registerHooks({resolve(specifier,context,next){if(context.parentURL?.includes('/prototype/')&&specifier.startsWith('.')&&!/\.[a-z]+$/i.test(specifier))return next(specifier+'.ts',context);return next(specifier,context);}});
const {decodeBankWallet,decodeBankReceipt,decodeBankEntry,decodeBankPage}=await import('./data.ts');
const {decodePluginConnection,decodeInvocation,bankIdForPlugin,bankTransferArguments}=await import('../plugin-host/core.ts');
const {parseAmount,formatHKD}=await import('./core.ts');
const {bankReceiptForInvocation,bankFailureForInvocation}=await import('./result.ts');
test.after(()=>resolver.deregister());
const id='11111111-1111-4111-8111-111111111111';
const second='22222222-2222-4222-8222-222222222222';
const wallet={mode:'demo',currency:'HKD',accounts:[{id,bank_id:'hsbc',bank_name:'汇丰银行',bank_name_en:'HSBC',balance_minor:10000000,masked_number:'DEMO 1111',connection_id:second}],total_balance_minor:10000000,recipients:[{id:'demo_chen',display_name:'陈小明',demo:true}]};
const receipt={id,source_bank_id:'hsbc',destination_bank_id:'bochk',recipient:'self',amount_minor:50000,currency:'HKD',mode:'demo',source_balance_minor:9950000,destination_balance_minor:10050000,memo:'lunch',created_at:'2026-10-21T10:00:00Z'};
const connection={id,card_url:'urn:q:bank-demo:hsbc',endpoint_url:'urn:q:bank-demo:hsbc',name:'q.bank-demo.hsbc',title:'汇丰模拟',description:'Q simulation',version:'1.0.0',revision:1,status:'ready',auth_status:'anonymous',last_error_code:null,created_at:receipt.created_at,updated_at:receipt.created_at,pending_update:false,connection_kind:'bank_demo',builtin_service_id:'q.bank-demo.hsbc'};
const invocation={id,connection_id:second,connection_revision:1,connection_title:'汇丰模拟',card_url:connection.card_url,endpoint_url:connection.endpoint_url,connection_kind:'bank_demo',builtin_service_id:'q.bank-demo.hsbc',tool_name:'bank_transfer',arguments:{to_bank_id:'bochk',recipient:'self',amount_minor:50000},status:'awaiting_confirmation',result:null,error_code:null,created_at:receipt.created_at,updated_at:receipt.created_at,expires_at:receipt.created_at};
test('wallet boundary rejects real currencies, duplicated cards, unsafe cents and mismatched totals',()=>{
 assert.deepEqual(decodeBankWallet(wallet),wallet);
 for(const value of [{...wallet,mode:'live'},{...wallet,currency:'QDC'},{...wallet,total_balance_minor:1},{...wallet,accounts:[wallet.accounts[0],wallet.accounts[0]],total_balance_minor:20000000},{...wallet,accounts:[{...wallet.accounts[0],balance_minor:0.01}]},{...wallet,accounts:[{...wallet.accounts[0],masked_number:'4111111111111111'}]}])assert.throws(()=>decodeBankWallet(value),{code:'INVALID_RESPONSE'});
});
test('bank receipt exposes only appropriate balances and validates the entire typed result',()=>{
 assert.deepEqual(decodeBankReceipt(receipt),receipt);
 const fictional={...receipt,recipient:'demo_chen',destination_balance_minor:null};assert.deepEqual(decodeBankReceipt(fictional),fictional);
 for(const value of [{...receipt,amount_minor:-1},{...receipt,amount_minor:0.5},{...receipt,recipient:'demo_chen'},{...receipt,destination_balance_minor:null},{...receipt,source_bank_id:'fake'},{...receipt,id:'wrong'},{...receipt,currency:'USD'}])assert.throws(()=>decodeBankReceipt(value),{code:'INVALID_RESPONSE'});
});
test('entry and pagination preserve distinct debit and credit identities',()=>{
 const entry={id,transaction_id:second,bank_id:'hsbc',kind:'transfer',direction:'out',amount_minor:50000,balance_after_minor:9950000,currency:'HKD',mode:'demo',memo:'',created_at:receipt.created_at,source_bank_id:'hsbc',destination_bank_id:'bochk',recipient:'self'};
 assert.deepEqual(decodeBankPage(decodeBankEntry)({items:[entry],next_cursor:'cursor'}),{items:[entry],next_cursor:'cursor'});
 for(const value of [{...entry,direction:'paid'},{...entry,amount_minor:-50000},{...entry,balance_after_minor:NaN},{...entry,kind:'real_funding'}])assert.throws(()=>decodeBankEntry(value),{code:'INVALID_RESPONSE'});
});
test('only explicit trusted bank type and exact matching service identity select the bank UI',()=>{
 assert.equal(bankIdForPlugin(decodePluginConnection(connection)),'hsbc');
 assert.equal(bankIdForPlugin({...connection,connection_kind:'remote_mcp'}),null);
 for(const value of [{...connection,connection_kind:'remote_mcp'},{...connection,builtin_service_id:'q.bank-demo.bochk'},{...connection,endpoint_url:'https://bank.invalid/mcp'},{...connection,auth_status:'authorized'},{...connection,connection_kind:'bank_demo',builtin_service_id:'q.bank-demo.fake'}])assert.throws(()=>decodePluginConnection(value),{code:'INVALID_RESPONSE'});
 const remote={...connection,connection_kind:'remote_mcp',builtin_service_id:null,card_url:'https://example.test/card',endpoint_url:'https://example.test/mcp',auth_status:'none'};assert.equal(bankIdForPlugin(decodePluginConnection(remote)),null);
});
test('bank confirmation arguments reject altered owner, unknown fields and fractional amounts',()=>{
 assert.equal(bankTransferArguments(decodeInvocation(invocation)).amountMinor,50000);
 for(const argumentsValue of [{...invocation.arguments,user_id:id},{...invocation.arguments,amount_minor:1.2},{...invocation.arguments,recipient:'other_user'},{...invocation.arguments,memo:'x'.repeat(121)}])assert.equal(bankTransferArguments({...invocation,arguments:argumentsValue}),null);
});
test('amount formatting never rounds or silently accepts an invalid transfer',()=>{
 assert.equal(parseAmount('1,000.25'),100025);assert.equal(formatHKD(100025),'HK$1,000.25');assert.equal(parseAmount('0.01'),1);
 for(const amount of ['0','-1','1.001','1e3','2,01','Infinity',''])assert.throws(()=>parseAmount(amount));
});

test('server flat structured receipts render as success only when bound to the complete original proposal',()=>{
 const complete={...invocation,status:'succeeded',arguments:{...invocation.arguments,memo:'lunch'},result:{resultType:'complete',content:[{type:'text',text:'Simulated transfer complete'}],structuredContent:{...receipt,kind:'bank_transfer'},isError:false}};
 assert.deepEqual(bankReceiptForInvocation(complete),{...receipt,kind:'bank_transfer'});
 for(const structuredContent of [{kind:'bank_transfer',receipt},{...receipt,kind:'bank_transfer',amount_minor:1},{...receipt,kind:'bank_transfer',destination_bank_id:'citi'},{...receipt,kind:'bank_transfer',memo:'changed'}])assert.equal(bankReceiptForInvocation({...complete,result:{...complete.result,structuredContent}}),null);
 assert.equal(bankReceiptForInvocation({...complete,status:'awaiting_confirmation'}),null);
 assert.equal(bankReceiptForInvocation({...complete,result:{...complete.result,isError:true}}),null);
});

test('bank business failures expose only allowlisted reasons and never an untrusted raw message',()=>{
 const failed={...invocation,status:'tool_error',result:{isError:true,content:[{type:'text',text:'untrusted detail'}],structuredContent:{kind:'bank_error',mode:'demo',error_code:'INSUFFICIENT_FUNDS'}}};
 assert.equal(bankFailureForInvocation(failed),'INSUFFICIENT_FUNDS');
 assert.equal(bankFailureForInvocation({...failed,status:'succeeded'}),null);
 assert.equal(bankFailureForInvocation({...failed,result:{...failed.result,structuredContent:{...failed.result.structuredContent,error_code:'<script>secret</script>'}}}),'BANK_TOOL_ERROR');
});
