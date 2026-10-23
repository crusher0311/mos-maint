const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs/promises'), os=require('node:os'), path=require('node:path');
const net=require('node:net'), {spawn}=require('node:child_process');
const {once}=require('node:events'), {randomUUID}=require('node:crypto');

test('uploaded Cosmos receiver adapter acknowledges only persisted empty synthetic deliveries',
  {timeout:20000}, async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mos-receiver-'));
  await fs.copyFile(path.resolve('scripts/protractor-export-synthetic/cosmos-test-receiver.cjs'),path.join(dir,'server.cjs'));
  const reserve=net.createServer();
  await new Promise(r=>reserve.listen(0,'127.0.0.1',r));
  const port=reserve.address().port;
  await new Promise(r=>reserve.close(r));
  let child;
  async function start(){
    child=spawn(process.execPath,[path.join(dir,'server.cjs')],{
      env:{PATH:process.env.PATH,PORT:String(port),STRICT:'1',
        NODE_OPTIONS:process.env.NODE_OPTIONS||'',PROTRACTOR_OFFLINE_ALLOW_LOOPBACK:'true'},
      stdio:['ignore','pipe','pipe'],
    });
    child.stderr.resume();
    await new Promise((resolve,reject)=>{
      child.once('error',reject);child.once('exit',code=>reject(Error('early exit '+code)));
      child.stdout.on('data',b=>{if(String(b).includes('Webhook receiver on'))resolve();});
    });
  }
  async function stop(){
    if(child?.exitCode===null){const done=once(child,'exit');child.kill();await done;}
  }
  async function post(value,id){
    const res=await fetch(`http://127.0.0.1:${port}/webhook`,{
      method:'POST',headers:{'content-type':'application/json',...(id?{'x-mos-delivery-id':id}:{})},
      body:JSON.stringify(value),
    });
    return {status:res.status,ack:res.headers.get('x-mos-acknowledgment'),body:await res.json()};
  }
  try {
    await start();
    const id=randomUUID(),body={schemaVersion:'mos.protractor.snapshots.v1',deliveryId:id,synthetic:true,records:[]};
    let r=await post(body,id);
    assert.equal(r.status,200);assert.equal(r.ack,id);
    assert.equal(r.body.signatureVerificationProven,false);
    assert.equal(await fs.readFile(path.join(dir,'received',`mos-synthetic-${id}.json`),'utf8'),JSON.stringify(body));
    await stop();await start();
    assert.equal((await post(body,id)).ack,id);
    r=await post({...body,changed:true},id);assert.equal(r.status,409);assert.equal(r.ack,null);
    r=await post({...body,records:[{id:'fake'}]},id);assert.equal(r.status,422);assert.equal(r.ack,null);
    r=await post({...body,synthetic:false},id);assert.equal(r.status,422);assert.equal(r.ack,null);
    r=await post(body,randomUUID());assert.equal(r.status,400);assert.equal(r.ack,null);
    r=await post({id:'generic-fixture'});assert.equal(r.status,200);assert.equal(r.ack,null);
    const blocked=randomUUID();
    await fs.mkdir(path.join(dir,'received',`mos-synthetic-${blocked}.json`));
    r=await post({...body,deliveryId:blocked},blocked);assert.equal(r.status,500);assert.equal(r.ack,null);
  } finally {await stop();await fs.rm(dir,{recursive:true,force:true});}
});
