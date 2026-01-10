import { MongoClient } from "mongodb";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

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
  
  if (process.env.MONGODB_URI) {
    return process.env.MONGODB_URI;
  }
  
  throw new Error("Missing MongoDB credentials");
}

async function ensureIndexes() {
  const uri = getMongoUri();
  console.log("Connecting to MongoDB Atlas...");

  const client = new MongoClient(uri);
  
  try {
    await client.connect();
    const db = client.db();
    console.log("Connected to MongoDB");

    const indexes: Array<{
      collection: string;
      index: Record<string, 1 | -1>;
      options?: { unique?: boolean; background?: boolean; name?: string };
    }> = [
      // job_index - Tekmetric job search (MongoDB Performance Advisor recommendations)
      { collection: "job_index", index: { shopId: 1 } },
      { collection: "job_index", index: { shopId: 1, vin: 1 } },
      { collection: "job_index", index: { shopId: 1, jobLabel: 1 } },
      { collection: "job_index", index: { shopId: 1, closedAt: -1 } },
      { collection: "job_index", index: { shopId: 1, workOrderId: 1 } },
      { collection: "job_index", index: { jobTitle: -1, performedAC: -1, shopId: 1 } },

      // job_history - Protractor job search
      { collection: "job_history", index: { shopId: 1 } },
      { collection: "job_history", index: { shopId: 1, vin: 1 } },
      { collection: "job_history", index: { shopId: 1, closedAt: -1 } },

      // vehicles - dashboard queries
      { collection: "vehicles", index: { shopId: 1, vin: 1 }, options: { unique: true } },
      { collection: "vehicles", index: { shopId: 1, updatedAt: -1 } },
      { collection: "vehicles", index: { vin: 1 } },

      // viewed_vins - trial tracking
      { collection: "viewed_vins", index: { shopId: 1 } },
      { collection: "viewed_vins", index: { shopId: 1, vin: 1, roNumber: 1 }, options: { unique: true } },

      // events - AutoFlow webhook events (MongoDB Performance Advisor recommendations)
      { collection: "events", index: { shopId: 1 } },
      { collection: "events", index: { shopId: 1, receivedAt: -1 } },
      { collection: "events", index: { vin: 1 } },
      { collection: "events", index: { "payload.vehicle.vin": 1, "payload.shop.id": 1, serviceWorkId: 1, shopId: 1 } },
      { collection: "events", index: { "payload.customer.number": 1 } },

      // part_xross_xref - Part cross reference
      { collection: "part_xross_xref", index: { normalizedPartNumber: 1, shopId: 1 } },

      // customers - customer lookup
      { collection: "customers", index: { shopId: 1 } },
      { collection: "customers", index: { shopId: 1, emailLower: 1 } },

      // users - auth
      { collection: "users", index: { shopId: 1 } },
      { collection: "users", index: { emailLower: 1 } },

      // sessions - auth
      { collection: "sessions", index: { token: 1 }, options: { unique: true } },
      { collection: "sessions", index: { expiresAt: 1 } },

      // shops - lookup
      { collection: "shops", index: { shopId: 1 }, options: { unique: true } },

      // backfill progress tracking
      { collection: "backfill_progress", index: { shopId: 1 }, options: { unique: true } },
      { collection: "tekmetric_backfill_progress", index: { shopId: 1 }, options: { unique: true } },

      // usage_logs - OpenAI usage tracking
      { collection: "usage_logs", index: { shopId: 1 } },
      { collection: "usage_logs", index: { timestamp: -1 } },
      { collection: "usage_logs", index: { shopId: 1, timestamp: -1 } },

      // setup_tokens - invite links
      { collection: "setup_tokens", index: { token: 1 } },
      { collection: "setup_tokens", index: { expiresAt: 1 } },

      // reset_tokens - password reset
      { collection: "reset_tokens", index: { token: 1 } },
      { collection: "reset_tokens", index: { expiresAt: 1 } },

      // sticker_generations - billing tracking
      { collection: "sticker_generations", index: { shopId: 1 } },
      { collection: "sticker_generations", index: { shopId: 1, generatedAt: -1 } },

      // api_usage - API traffic monitoring
      { collection: "api_usage", index: { provider: 1, timestamp: -1 } },
      { collection: "api_usage", index: { shopId: 1, timestamp: -1 } },
      { collection: "api_usage", index: { timestamp: -1 } },

      // recommendation_events - shop analytics
      { collection: "recommendation_events", index: { shopId: 1, createdAt: -1 } },

      // protractor_work_orders - dashboard
      { collection: "protractor_work_orders", index: { shopId: 1 } },
      { collection: "protractor_work_orders", index: { shopId: 1, status: 1 } },

      // tekmetric_work_orders - dashboard
      { collection: "tekmetric_work_orders", index: { shopId: 1 } },
      { collection: "tekmetric_work_orders", index: { shopId: 1, status: 1 } },

      // normalized collections
      { collection: "normalized_work_orders", index: { shopId: 1 } },
      { collection: "normalized_work_orders", index: { shopId: 1, status: 1 } },
      { collection: "normalized_work_orders", index: { vin: 1 } },
      { collection: "normalized_vehicles", index: { shopId: 1 } },
      { collection: "normalized_vehicles", index: { vin: 1 } },
      { collection: "normalized_customers", index: { shopId: 1 } },
    ];

    for (const { collection, index, options } of indexes) {
      try {
        const col = db.collection(collection);
        const indexName = options?.name || Object.keys(index).join("_");
        
        await col.createIndex(index, {
          background: true,
          ...options,
          name: indexName,
        });
        console.log(`Created index on ${collection}: ${indexName}`);
      } catch (err: any) {
        if (err.code === 85 || err.code === 86) {
          console.log(`Index already exists on ${collection}: ${Object.keys(index).join("_")}`);
        } else {
          console.error(`Failed to create index on ${collection}:`, err.message);
        }
      }
    }

    console.log("\nIndex setup complete!");
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  } finally {
    await client.close();
  }
}

ensureIndexes();
