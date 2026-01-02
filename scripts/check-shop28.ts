import { MongoClient } from 'mongodb';

const uri = `mongodb+srv://${process.env.MONGODB_USERNAME}:${process.env.MONGODB_PASSWORD}@cluster0.yz0v9gv.mongodb.net/?retryWrites=true&w=majority`;

async function check() {
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db('mos_maintenance');
    
    // Count jobs by source for shop 28
    const protractorJobs = await db.collection('job_index').countDocuments({ shopId: 28, source: 'protractor' });
    const tekmetricJobs = await db.collection('job_index').countDocuments({ shopId: 28, source: 'tekmetric' });
    const allJobs = await db.collection('job_index').countDocuments({ shopId: 28 });
    
    console.log('Shop 28 Job Index:');
    console.log('  Protractor jobs:', protractorJobs);
    console.log('  Tekmetric jobs:', tekmetricJobs);
    console.log('  Total jobs:', allJobs);
    
    // Check backfill progress
    const protractorProgress = await db.collection('protractor_backfill_progress').findOne({ shopId: 28 });
    const tekmetricProgress = await db.collection('tekmetric_backfill_progress').findOne({ shopId: 28 });
    
    console.log('\nBackfill Progress:');
    console.log('  Protractor:', protractorProgress ? JSON.stringify(protractorProgress, null, 2) : 'None');
    console.log('  Tekmetric:', tekmetricProgress ? JSON.stringify(tekmetricProgress, null, 2) : 'None');
    
    // Check shop config
    const shop = await db.collection('shops').findOne({ shopId: 28 });
    console.log('\nShop 28 Config:');
    console.log('  Name:', shop?.name);
    console.log('  Protractor:', JSON.stringify(shop?.protractor) || 'Not configured');
    console.log('  Tekmetric shopId:', shop?.tekmetric?.shopId || shop?.tekmetricShopId || 'Not configured');
    
  } finally {
    await client.close();
  }
}

check().catch(console.error);
