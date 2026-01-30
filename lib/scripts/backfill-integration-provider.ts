import { getDb } from '@/lib/mongo';

type IntegrationProvider = 'tekmetric' | 'protractor' | 'autoflow' | null;

function detectProvider(shop: any): IntegrationProvider {
  if (shop.tekmetric?.shopId || shop.tekmetricShopId) {
    return 'tekmetric';
  }
  if (shop.protractor?.connectionId || shop.protractorConnectionId) {
    return 'protractor';
  }
  if (shop.autoflow?.domain || shop.autoflowDomain) {
    return 'autoflow';
  }
  return null;
}

export async function backfillIntegrationProvider(): Promise<{
  total: number;
  updated: number;
  skipped: number;
  byProvider: Record<string, number>;
}> {
  const db = await getDb();
  const shops = await db.collection('shops').find({}).toArray();
  
  let updated = 0;
  let skipped = 0;
  const byProvider: Record<string, number> = {
    tekmetric: 0,
    protractor: 0,
    autoflow: 0,
    none: 0
  };

  for (const shop of shops) {
    const provider = detectProvider(shop);
    
    if (provider) {
      byProvider[provider]++;
    } else {
      byProvider.none++;
    }

    if (shop.integrationProvider === provider) {
      skipped++;
      continue;
    }

    await db.collection('shops').updateOne(
      { _id: shop._id },
      { $set: { integrationProvider: provider } }
    );
    updated++;
    console.log(`[Backfill] Shop ${shop.shopId} (${shop.name}): set integrationProvider = ${provider}`);
  }

  console.log(`[Backfill] Complete: ${updated} updated, ${skipped} skipped, by provider:`, byProvider);
  
  return {
    total: shops.length,
    updated,
    skipped,
    byProvider
  };
}

if (require.main === module) {
  backfillIntegrationProvider()
    .then(result => {
      console.log('Backfill complete:', result);
      process.exit(0);
    })
    .catch(err => {
      console.error('Backfill failed:', err);
      process.exit(1);
    });
}
