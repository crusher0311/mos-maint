// lib/mongo.ts
import { MongoClient, Db } from "mongodb";
import {
  attachMongoSlowQueryMonitor,
  mongoMonitorEnabled,
} from "@/lib/slow-query/tracker";

let clientPromise: Promise<MongoClient> | undefined;

function getMongoUri(): string {
  // First check for a complete MONGODB_URI
  if (process.env.MONGODB_URI && !process.env.MONGODB_URI.includes('localhost')) {
    return process.env.MONGODB_URI;
  }
  
  // Build URI from individual credentials for MongoDB Atlas
  const username = process.env.MONGODB_USERNAME;
  const password = process.env.MONGODB_PASSWORD;
  
  if (username && password) {
    const encodedPassword = encodeURIComponent(password);
    return `mongodb+srv://${username}:${encodedPassword}@mos-maintenance-mvp.tiixipi.mongodb.net/mos-maintenance-mvp?retryWrites=true&w=majority`;
  }
  
  // Fallback to MONGODB_URI or throw error
  if (process.env.MONGODB_URI) {
    return process.env.MONGODB_URI;
  }
  
  throw new Error("Missing MongoDB credentials. Set MONGODB_USERNAME and MONGODB_PASSWORD, or provide MONGODB_URI");
}

declare global {
  // eslint-disable-next-line no-var
  var _mongoClientPromise: Promise<MongoClient> | undefined;
}

// Connection pool options for scaling
const MONGO_OPTIONS = {
  maxPoolSize: 50,
  minPoolSize: 5,
  maxIdleTimeMS: 30000,
  connectTimeoutMS: 10000,
  // Default 45s keeps live-app reads failing fast. Batch/backfill scripts that
  // run long per-shop aggregations (ACES repair + job-index reindex) override
  // this via MONGODB_SOCKET_TIMEOUT_MS so a single slow op doesn't kill the run.
  socketTimeoutMS: Number(process.env.MONGODB_SOCKET_TIMEOUT_MS) || 45000,
  serverSelectionTimeoutMS: 10000,
  retryWrites: true,
  retryReads: true,
};

// Lazily create the client when first needed (avoids throwing during import)
export async function getMongoClient(): Promise<MongoClient> {
  if (clientPromise) return clientPromise;

  const uri = getMongoUri();

  // Task #1161 — slow-query analyzer. Command monitoring is only turned on
  // when tracking is enabled (SLOW_QUERY_TRACKING_DISABLED unset), so the
  // kill-switched hot path pays zero event-emission overhead.
  const monitor = mongoMonitorEnabled();
  const options = monitor
    ? { ...MONGO_OPTIONS, monitorCommands: true }
    : MONGO_OPTIONS;
  const makeClient = () => {
    const client = new MongoClient(uri, options);
    if (monitor) attachMongoSlowQueryMonitor(client);
    return client.connect();
  };

  if (process.env.NODE_ENV === "development") {
    if (!global._mongoClientPromise) {
      global._mongoClientPromise = makeClient();
    }
    clientPromise = global._mongoClientPromise;
  } else {
    clientPromise = makeClient();
  }
  return clientPromise!;
}

export async function getDb(name: string = process.env.MONGODB_DB || "mos-maintenance-mvp"): Promise<Db> {
  const client = await getMongoClient();
  return client.db(name);
}

