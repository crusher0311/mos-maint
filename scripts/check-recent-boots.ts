const { MongoClient } = require('mongodb');
async function main() {
  const user = encodeURIComponent(process.env.MONGODB_USERNAME || '');
  const pass = encodeURIComponent(process.env.MONGODB_PASSWORD || '');
  const uri = `mongodb+srv://${user}:${pass}@mos-maintenance-mvp.tiixipi.mongodb.net/?retryWrites=true&w=majority`;
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db('mos');
  const status = await db.collection('cron_status').findOne({ _id: 'global' });
  const hist = status?.bootHistory || [];
  console.log(`Total boots in history: ${hist.length}`);
  for (let i = 0; i < Math.min(hist.length, 10); i++) {
    const b = hist[i];
    const jobNames = (b.jobs || []).map((j: any) => j.name);
    const tekJobs = jobNames.filter((n: string) => n.startsWith('tekmetric-'));
    const otherJobs = jobNames.filter((n: string) => !n.startsWith('tekmetric-'));
    console.log(`[${i}] ${b.bootedAt}  status=${b.status}  inst=${(b.instanceId || '').slice(0, 40)}  total=${jobNames.length}  tekmetric=${tekJobs.length}  other=${otherJobs.length}`);
    if (tekJobs.length > 0) console.log(`      tek: ${tekJobs.join(', ')}`);
  }
  console.log('');
  console.log('=== Recent lastRuns sorted by dt ===');
  const lr = status?.lastRuns || {};
  const entries = Object.entries(lr).map(([n, v]: [string, any]) => ({ name: n, ...v }));
  entries.sort((a: any, b: any) => new Date(b.dt || 0).getTime() - new Date(a.dt || 0).getTime());
  for (const e of entries.slice(0, 20)) {
    console.log(`  ${e.name.padEnd(35)} dt=${e.dt}  ms=${e.ms}  ok=${e.ok}  status=${e.status}  err=${e.error ?? '—'}`);
  }
  await client.close();
}
main().catch(e => { console.error(e); process.exit(1); });
