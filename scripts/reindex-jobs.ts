import { reindexFromStoredData } from "../lib/tekmetric-job-index";

async function main() {
  console.log("Starting full reindex from stored data...");
  const result = await reindexFromStoredData();
  console.log("REINDEX COMPLETE:", JSON.stringify(result));
}

main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
