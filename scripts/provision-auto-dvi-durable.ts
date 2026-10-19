/**
 * Operator-only storage provisioning. Never imported by application startup.
 * Requires separate approval for the database this process is configured to use.
 */
import { getDb, getMongoClient } from "../lib/mongo";
import { DURABLE_COLLECTION, MongoDviStore } from "../lib/data/repositories/auto-dvi-durable";

async function main() {
  if (process.argv.slice(2).join(" ") !== "--operator-approved") {
    throw new Error("Separate operator approval required; pass --operator-approved");
  }
  const db = await getDb();
  const client = await getMongoClient();
  const hello = await db.admin().command({ hello: 1 });
  if (!hello.setName && hello.msg !== "isdbgrid") throw new Error("Transactions required");
  const names = [DURABLE_COLLECTION, "auto_dvi_applications"];
  // Inspect both before making any change. Never alter existing storage options.
  for (const name of names) {
    const info = await db.listCollections({ name }).next();
    if (!info) continue;
    if (info.type !== "collection" || !("options" in info) ||
        info.options?.capped || info.options?.timeseries)
      throw new Error(`Incompatible existing collection: ${name}`);
    const indexes = await db.collection(name).listIndexes().toArray();
    if (!indexes.some(i => i.name === "_id_" && i.key?._id === 1) ||
        indexes.some(i => i.expireAfterSeconds !== undefined))
      throw new Error(`Unsafe indexes: ${name}`);
  }
  for (const name of names) {
    if (await db.listCollections({ name }, { nameOnly: true }).hasNext()) {
      console.log(JSON.stringify({ collection: name, outcome: "already_exists" }));
      continue;
    }
    await db.createCollection(name, { writeConcern: { w: "majority", j: true } });
    console.log(JSON.stringify({ collection: name, outcome: "created" }));
  }
  await new MongoDviStore(client, db).ready();
  console.log(JSON.stringify({ storageReady: true, enrollmentChanged: false }));
}

main().catch(error => {
  // Do not print connection strings, driver payloads or credentials.
  console.error(JSON.stringify({ failed: true, type: error?.name, code: error?.code }));
  process.exitCode = 1;
}).finally(async () => {
  if (process.argv.includes("--operator-approved")) await (await getMongoClient()).close();
});
