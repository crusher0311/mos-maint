const { MongoClient } = require('mongodb');
async function main() {
  const user = encodeURIComponent(process.env.MONGODB_USERNAME || '');
  const pass = encodeURIComponent(process.env.MONGODB_PASSWORD || '');
  const uri = `mongodb+srv://${user}:${pass}@mos-maintenance-mvp.tiixipi.mongodb.net/?retryWrites=true&w=majority`;
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db('mos');
  const status = await db.collection('cron_status').findOne({ _id: 'global' });
  console.log('=== bootHistory[0..9] full ===');
  for (let i = 0; i < (status?.bootHistory || []).length; i++) {
    const b = status.bootHistory[i];
    console.log(`--- entry ${i} ---`);
    console.log(JSON.stringify(b, null, 2));
  }
  await client.close();
}
main().catch(e => { console.error(e); process.exit(1); });
