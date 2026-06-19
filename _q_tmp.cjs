const { MongoClient } = require('mongodb');
function uri(){
  if(process.env.MONGODB_URI && !process.env.MONGODB_URI.includes('localhost')) return process.env.MONGODB_URI;
  const u=process.env.MONGODB_USERNAME,p=process.env.MONGODB_PASSWORD;
  return `mongodb+srv://${u}:${encodeURIComponent(p)}@mos-maintenance-mvp.tiixipi.mongodb.net/mos-maintenance-mvp?retryWrites=true&w=majority`;
}
(async()=>{
  const c=new MongoClient(uri(),{serverSelectionTimeoutMS:10000});
  await c.connect();
  const db=c.db('mos-maintenance-mvp');
  // find job_index rows for RO 223880
  const rows=await db.collection('job_index').find({workOrderNumber:223880}).limit(20).toArray();
  console.log('job_index by workOrderNumber=223880:',rows.length);
  for(const r of rows){
    console.log(JSON.stringify({shopId:r.shopId,won:r.workOrderNumber,woid:r.workOrderId,title:r.job&&r.job.title,authorized:r.authorized,isDeferred:r.isDeferred,vin:r.vehicle&&r.vehicle.vin,mileage:r.mileage,performedAt:r.performedAt,src:r.metadata&&r.metadata.sourceType},null,0));
  }
  await c.close();
})().catch(e=>{console.error('ERR',e.message);process.exit(1)});
