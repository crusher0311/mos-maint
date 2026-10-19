import { MongoClient } from "mongodb";
import { MongoDviStore } from "../../lib/data/repositories/auto-dvi-durable";
import { fixtureService, body, scope } from "./dvi-durable-fixture";

async function main() {
  const [port, dbName, mode] = process.argv.slice(2);
  if (!/^\d+$/.test(port) || !/^dvi_test_[a-z0-9_]+$/.test(dbName)) throw Error("Unsafe fixture scope");
  const client = new MongoClient(`mongodb://127.0.0.1:${port}/?replicaSet=dvi_test&directConnection=true`);
  await client.connect();
  try {
    const db = client.db(dbName);
    const service = fixtureService(new MongoDviStore(client, db), db, mode === "race" ? undefined : mode);
    const result = await service.push(scope, body);
    console.log(JSON.stringify({status: result.status, operationId: result.body.operationId}));
  } finally { await client.close(); }
}
main().catch(() => { process.exitCode = 1; });
