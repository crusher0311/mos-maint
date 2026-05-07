const { MongoClient } = require('mongodb');
const uri = `mongodb+srv://${process.env.MONGODB_USERNAME}:${encodeURIComponent(process.env.MONGODB_PASSWORD)}@mos-maintenance-mvp.tiixipi.mongodb.net/?retryWrites=true&w=majority`;
(async () => {
  const c = new MongoClient(uri); await c.connect();
  const db = c.db('mos-maintenance-mvp');
  // Look at backfill state for the flagged shops
  const ids = [122,123,112,82];
  for (const sid of ids) {
    const s = await db.collection('shops').findOne({ _id: sid }, { projection: { name:1, tekmetricFullPageBackfill:1, tekmetricBackfillStatus:1, tekmetricBackfillState:1 } });
    if (!s) { console.log(sid,'not found'); continue; }
    console.log('---', sid, s.name, '---');
    console.log('fullPage:', JSON.stringify(s.tekmetricFullPageBackfill||null));
    console.log('status:', JSON.stringify(s.tekmetricBackfillStatus||null));
    const c2 = await db.collection('normalized_work_orders').countDocuments({ shopId: sid });
    console.log('normalized_work_orders count:', c2);
  }
  // recent locks
  const locks = await db.collection('cron_locks').find({}).toArray();
  console.log('--- cron_locks ---');
  for (const l of locks) console.log(l.name, 'expiresAt:', l.expiresAt, 'holder:', l.holder);
  await c.close();
})().catch(e=>{console.error(e);process.exit(1);});
