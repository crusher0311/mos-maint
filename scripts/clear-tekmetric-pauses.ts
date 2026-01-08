import { getDb } from "../lib/mongo";

async function clearPauses() {
  const db = await getDb();
  const result = await db.collection('shops').updateMany(
    { 'tekmetric.pausedUntil': { $exists: true } },
    { $unset: { 'tekmetric.pausedUntil': '', 'tekmetric.authFailures': '' } }
  );
  console.log('Cleared pauses:', result.modifiedCount, 'shops');
  process.exit(0);
}

clearPauses();
