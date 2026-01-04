#!/usr/bin/env npx tsx
import { MongoClient } from 'mongodb';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

function getMongoUri(): string {
  if (process.env.MONGODB_URI && !process.env.MONGODB_URI.includes('localhost')) {
    return process.env.MONGODB_URI;
  }
  
  const username = process.env.MONGODB_USERNAME;
  const password = process.env.MONGODB_PASSWORD;
  
  if (username && password) {
    const encodedPassword = encodeURIComponent(password);
    return `mongodb+srv://${username}:${encodedPassword}@mos-maintenance-mvp.tiixipi.mongodb.net/mos-maintenance-mvp?retryWrites=true&w=majority`;
  }
  
  throw new Error("Missing MongoDB credentials");
}

const MONGODB_URI = getMongoUri();

async function createIndexes() {
  console.log('Setting up normalized collection indexes...\n');
  
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db();

  const indexes: Array<{ collection: string; indexes: Array<{ spec: any; options?: any }> }> = [
    {
      collection: 'normalized_vehicles',
      indexes: [
        { spec: { shopId: 1, vin: 1 }, options: { name: 'shopId_vin' } },
        { spec: { 'provenance.sourceSystem': 1, 'provenance.sourceIds.id': 1 }, options: { name: 'source_lookup' } },
        { spec: { shopId: 1, 'softDelete.isDeleted': 1 }, options: { name: 'shop_active' } },
        { spec: { year: 1, make: 1, model: 1 }, options: { name: 'ymm_lookup' } },
      ],
    },
    {
      collection: 'normalized_customers',
      indexes: [
        { spec: { shopId: 1, email: 1 }, options: { name: 'shopId_email' } },
        { spec: { 'provenance.sourceSystem': 1, 'provenance.sourceIds.id': 1 }, options: { name: 'source_lookup' } },
        { spec: { shopId: 1, 'softDelete.isDeleted': 1 }, options: { name: 'shop_active' } },
      ],
    },
    {
      collection: 'normalized_work_orders',
      indexes: [
        { spec: { shopId: 1, vehicleId: 1 }, options: { name: 'shopId_vehicleId' } },
        { spec: { shopId: 1, customerId: 1 }, options: { name: 'shopId_customerId' } },
        { spec: { shopId: 1, closedDate: -1 }, options: { name: 'shop_closedDate' } },
        { spec: { 'provenance.sourceSystem': 1, 'provenance.sourceIds.id': 1 }, options: { name: 'source_lookup' } },
        { spec: { shopId: 1, 'softDelete.isDeleted': 1, closedDate: -1 }, options: { name: 'shop_active_closed' } },
        { spec: { contentHash: 1 }, options: { name: 'content_hash' } },
      ],
    },
    {
      collection: 'normalized_service_jobs',
      indexes: [
        { spec: { workOrderId: 1 }, options: { name: 'workOrderId' } },
        { spec: { shopId: 1, title: 'text', description: 'text' }, options: { name: 'shop_text_search' } },
        { spec: { 'provenance.sourceSystem': 1, 'provenance.sourceIds.id': 1 }, options: { name: 'source_lookup' } },
        { spec: { shopId: 1, 'softDelete.isDeleted': 1 }, options: { name: 'shop_active' } },
        { spec: { contentHash: 1 }, options: { name: 'content_hash' } },
      ],
    },
    {
      collection: 'normalized_payments',
      indexes: [
        { spec: { workOrderId: 1 }, options: { name: 'workOrderId' } },
        { spec: { shopId: 1, paymentDate: -1 }, options: { name: 'shop_paymentDate' } },
        { spec: { 'provenance.sourceSystem': 1, 'provenance.sourceIds.id': 1 }, options: { name: 'source_lookup' } },
        { spec: { contentHash: 1 }, options: { name: 'content_hash' } },
      ],
    },
    {
      collection: 'normalized_inspections',
      indexes: [
        { spec: { workOrderId: 1 }, options: { name: 'workOrderId' } },
        { spec: { vehicleId: 1 }, options: { name: 'vehicleId' } },
        { spec: { shopId: 1, inspectionDate: -1 }, options: { name: 'shop_inspectionDate' } },
        { spec: { 'provenance.sourceSystem': 1, 'provenance.sourceIds.id': 1 }, options: { name: 'source_lookup' } },
        { spec: { contentHash: 1 }, options: { name: 'content_hash' } },
      ],
    },
    {
      collection: 'normalized_recommendations',
      indexes: [
        { spec: { workOrderId: 1 }, options: { name: 'workOrderId' } },
        { spec: { vehicleId: 1 }, options: { name: 'vehicleId' } },
        { spec: { shopId: 1, status: 1 }, options: { name: 'shop_status' } },
        { spec: { 'provenance.sourceSystem': 1, 'provenance.sourceIds.id': 1 }, options: { name: 'source_lookup' } },
        { spec: { contentHash: 1 }, options: { name: 'content_hash' } },
      ],
    },
  ];

  for (const { collection: collName, indexes: collIndexes } of indexes) {
    console.log(`\n${collName}:`);
    const collection = db.collection(collName);
    
    for (const { spec, options } of collIndexes) {
      try {
        await collection.createIndex(spec, options);
        console.log(`  Created index: ${options?.name || JSON.stringify(spec)}`);
      } catch (err: any) {
        if (err.code === 85) {
          console.log(`  Index exists (different options): ${options?.name}`);
        } else if (err.code === 86) {
          console.log(`  Index exists (same name): ${options?.name}`);
        } else {
          console.error(`  Error creating index ${options?.name}: ${err.message}`);
        }
      }
    }
  }

  console.log('\n\nIndex setup complete!');
  await client.close();
  process.exit(0);
}

createIndexes().catch(err => {
  console.error('Index setup failed:', err);
  process.exit(1);
});
