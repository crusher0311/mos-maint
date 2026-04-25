import { getDb } from '../lib/mongo';
async function main() {
  const db = await getDb();
  const locks = await db.collection('cron_locks').find({}).sort({ acquiredAt: -1 }).limit(50).toArray();
  console.log('=== cron_locks (most recent 50) ===');
  for (const l of locks) {
    const acq = l.acquiredAt instanceof Date ? l.acquiredAt.toISOString() : l.acquiredAt;
    const exp = l.expiresAt instanceof Date ? l.expiresAt.toISOString() : l.expiresAt;
    const rel = l.releasedAt instanceof Date ? l.releasedAt.toISOString() : (l.releasedAt ?? '—');
    console.log(`  ${l._id}  acq=${acq}  exp=${exp}  rel=${rel}`);
  }
  console.log('');
  const boost = await db.collection('cron_locks').findOne({ _id: 'tekmetric-backfill-weekend-boost' as any });
  console.log('=== boost cron lookup ===');
  console.log(boost ? JSON.stringify(boost, null, 2) : 'NOT FOUND - boost cron has never fired on prod');
  console.log('');
  const reg = await db.collection('cron_locks').findOne({ _id: 'tekmetric-backfill' as any });
  console.log('=== regular tekmetric-backfill lookup ===');
  console.log(reg ? JSON.stringify(reg, null, 2) : 'NOT FOUND');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
