const { MongoClient } = require('mongodb');
async function main() {
  const user = encodeURIComponent(process.env.MONGODB_USERNAME || '');
  const pass = encodeURIComponent(process.env.MONGODB_PASSWORD || '');
  const uri = `mongodb+srv://${user}:${pass}@mos-maintenance-mvp.tiixipi.mongodb.net/?retryWrites=true&w=majority`;
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db('mos');
  const status = await db.collection('cron_status').findOne({ _id: 'global' });
  if (!status) {
    console.log('No cron_status doc');
    process.exit(0);
  }
  console.log('=== Last boot ===');
  console.log(JSON.stringify(status.lastBoot, null, 2));
  console.log('');
  console.log('=== lastRuns ===');
  const lastRuns = status.lastRuns || {};
  const sorted = Object.entries(lastRuns).sort((a, b) => {
    const at = new Date((a[1] as any).startedAt || 0).getTime();
    const bt = new Date((b[1] as any).startedAt || 0).getTime();
    return bt - at;
  });
  for (const [name, run] of sorted) {
    const r = run as any;
    console.log(`  ${name}  startedAt=${r.startedAt}  ms=${r.ms}  ok=${r.ok}  status=${r.status}  error=${r.error ?? '—'}`);
  }
  console.log('');
  console.log('=== Boot history (last 10) ===');
  for (const b of (status.bootHistory || []).slice(0, 10)) {
    console.log(`  bootAt=${b.bootAt}  instance=${b.instanceId}  jobs=${(b.jobs || []).map((j: any) => j.name).join(', ')}`);
  }
  await client.close();
}
main().catch(e => { console.error(e); process.exit(1); });
