const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('mos-tools-extension/lib/sign-in-diagnostics.js', 'utf8');
const sandbox = {};
vm.runInNewContext(source.replace('export function', 'function') + '\nthis.diagnostic=signInDiagnostic;', sandbox);
const diagnostic = (...args) => JSON.parse(JSON.stringify(sandbox.diagnostic(...args)));
assert.deepEqual(diagnostic('response', {provider:'autoflow',shopId:'743'},
  {provider:'protractor',shopId:66}, 200), {
  phase:'response',requestedProvider:'autoflow',requestedSmsShopId:'743',
  returnedProvider:'protractor',returnedMosShopId:'66',returnedSmsShopId:null,httpStatus:200,
});
assert.equal(diagnostic('request', null).requestedProvider, null);
assert.equal(diagnostic('response', {}, {}).returnedProvider, null);
const secrets = {email:'private@example.com',password:'password-secret',token:'exts_secret',loginCode:'private-code'};
const result = diagnostic('response', {...secrets,provider:'autoflow',shopId:'743'},
  {...secrets,provider:'autoflow',shopId:221,smsShopId:'743'},200);
assert.equal(result.returnedProvider,'autoflow');
for (const secret of Object.values(secrets)) assert(!JSON.stringify(result).includes(secret));
for (const bad of ['private@example.com', 'exts_secret', 'https://private', {}, [], -1, Infinity, '0', '123\n']) {
  const row=diagnostic('private-code',{provider:bad,shopId:bad},{provider:bad,shopId:bad,smsShopId:bad},bad);
  assert.equal(row.phase,'unknown');
  for (const field of ['requestedProvider','requestedSmsShopId','returnedProvider','returnedMosShopId','returnedSmsShopId','httpStatus'])
    assert.equal(row[field],null);
}
// Execute the actual login path through receipt of a response. Supersede the
// synthetic login there to prevent storage/session effects in this offline test.
const worker=fs.readFileSync('mos-tools-extension/background.js','utf8');
const login=worker.slice(worker.indexOf('async function handleMosLogin('),worker.indexOf('\nfunction bootstrapContextKey('));
(async()=>{
  for (const ok of [true,false]) {
    const logs=[];
    const context={...sandbox,signInDiagnostic:sandbox.diagnostic,
      console:{log:(...args)=>logs.push(args),error(){}},
      _stateReady:Promise.resolve(),explicitLoginInFlight:false,authEpoch:0,
      mosAuthSource:'explicit',mosApiToken:null,mosApiUrl:'https://fixture.invalid',pendingBootstrapAuth:null,
      chrome:{tabs:{query:async()=>[{id:7}]}},
      smsContextsByTab:new Map([[7,{provider:'autoflow',shopId:'743'}]]),currentSmsContext:null,
      revokeExtensionBearer:async()=>{},
    };
    context.fetch=async()=>{context.authEpoch=99;return {ok,status:ok?200:403,
      json:async()=>ok?{...secrets,session:{provider:'protractor',shopId:66}}:{error:'fixture denial'}};};
    vm.createContext(context);
    vm.runInContext(login,context);
    await assert.rejects(context.handleMosLogin(secrets.email,secrets.password,'https://fixture.invalid'));
    const rows=logs.filter(row=>row[0]==='[MOS Sign-in Context]').map(row=>JSON.parse(row[1]));
    assert.equal(rows.length,2);
    assert.equal(rows[0].requestedSmsShopId,'743');
    assert.equal(rows[1].phase,ok?'response':'rejected');
    if(ok) assert.equal(rows[1].returnedMosShopId,'66');
    for(const secret of Object.values(secrets)) assert(!JSON.stringify(rows).includes(secret));
  }
  console.log('PASS sign-in diagnostic privacy and actual worker request/response paths');
})().catch(error=>{console.error(error);process.exitCode=1;});
