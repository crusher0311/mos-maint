import { getDb } from '../lib/mongo';

async function setupLogStreamIndexes() {
  console.log('Setting up render_log_stream indexes...');
  
  const db = await getDb();
  const collection = db.collection('render_log_stream');
  
  await collection.createIndex({ logId: 1 }, { unique: true, background: true });
  console.log('Created unique index on logId');
  
  await collection.createIndex({ timestamp: -1 }, { background: true });
  console.log('Created index on timestamp (descending)');
  
  await collection.createIndex({ level: 1, timestamp: -1 }, { background: true });
  console.log('Created compound index on level + timestamp');
  
  await collection.createIndex({ serviceId: 1, timestamp: -1 }, { background: true });
  console.log('Created compound index on serviceId + timestamp');
  
  await collection.createIndex({ environment: 1, timestamp: -1 }, { background: true });
  console.log('Created compound index on environment + timestamp');
  
  await collection.createIndex(
    { receivedAt: 1 },
    { expireAfterSeconds: 30 * 24 * 60 * 60, background: true }
  );
  console.log('Created TTL index on receivedAt (30 day retention)');
  
  console.log('All indexes created successfully!');
  process.exit(0);
}

setupLogStreamIndexes().catch(err => {
  console.error('Error setting up indexes:', err);
  process.exit(1);
});
