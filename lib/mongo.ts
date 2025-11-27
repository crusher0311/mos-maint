// lib/mongo.ts
import { MongoClient, Db } from "mongodb";

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

// Lazily create the client when first needed (avoids throwing during import)
export async function getMongoClient(): Promise<MongoClient> {
  if (clientPromise) return clientPromise;

  const uri = getMongoUri();

  if (process.env.NODE_ENV === "development") {
    if (!global._mongoClientPromise) {
      global._mongoClientPromise = new MongoClient(uri).connect();
    }
    clientPromise = global._mongoClientPromise;
  } else {
    clientPromise = new MongoClient(uri).connect();
  }
  return clientPromise!;
}

export async function getDb(name: string = process.env.MONGODB_DB || "mos-maintenance-mvp"): Promise<Db> {
  const client = await getMongoClient();
  return client.db(name);
}

