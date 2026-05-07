const { MongoClient } = require('mongodb');
const uri = `mongodb+srv://${process.env.MONGODB_USERNAME}:${encodeURIComponent(process.env.MONGODB_PASSWORD)}@mos-maintenance-mvp.tiixipi.mongodb.net/?retryWrites=true&w=majority`;
(async () => {
  const c = new MongoClient(uri); await c.connect();
  const dbs = await c.db().admin().listDatabases();
  for (const d of dbs.databases) console.log(d.name, d.sizeOnDisk);
  // find which db has shops with the heart certified id range
  for (const d of dbs.databases) {
    if (['admin','local','config'].includes(d.name)) continue;
    try {
      const cnt = await c.db(d.name).collection('shops').countDocuments({});
      const heart = await c.db(d.name).collection('shops').findOne({ _id: 82 }, { projection:{ name:1 } });
      console.log(d.name, 'shops:', cnt, 'shop82:', heart?.name);
    } catch(e) {}
  }
  await c.close();
})().catch(e=>{console.error(e);process.exit(1);});
