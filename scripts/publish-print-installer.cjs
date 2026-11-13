// Operator-only distribution. Does not deploy web code, enroll a printer,
// generate credentials, or start an agent. Never run without explicit approval.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { MongoClient, GridFSBucket } = require("mongodb");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
async function main() {
  if (process.argv.slice(2).some(a => a !== "--execute")) throw Error("Only --execute is supported");
  const dir = path.resolve(__dirname, "../generated-artifacts/mos-print-installer");
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "pairing-release.json")));
  const bytes = fs.readFileSync(path.join(dir, "MOS-Print-Setup-pilot.exe"));
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  if (manifest.release !== "windows-x64-pairing-v1" || digest !== manifest.sha256 ||
      bytes.length > 32 * 1024 * 1024 || bytes.toString("ascii", 0, 2) !== "MZ")
    throw Error("Installer artifact verification failed");
  console.log(JSON.stringify({ event: "installer_verified", sha256: digest, bytes: bytes.length, execute: process.argv.includes("--execute") }));
  if (!process.argv.includes("--execute")) return;
  const uri = process.env.MONGODB_URI || `mongodb+srv://${encodeURIComponent(process.env.MONGODB_USERNAME)}:${encodeURIComponent(process.env.MONGODB_PASSWORD)}@mos-maintenance-mvp.tiixipi.mongodb.net/mos-maintenance-mvp?retryWrites=true&w=majority`;
  const client = new MongoClient(uri, { maxPoolSize: 1, serverSelectionTimeoutMS: 10000 });
  try {
    await client.connect();
    const db = client.db("mos-maintenance-mvp");
    const releases = db.collection("print_installer_releases");
    const prior = await releases.findOne({ _id: manifest.release });
    if (prior) {
      if (prior.sha256 !== digest) throw Error("Release already exists with different content; do not replace silently");
      console.log(JSON.stringify({ event: "installer_already_distributed", sha256: digest })); return;
    }
    const bucket = new GridFSBucket(db, { bucketName: "print_installers" });
    const upload = bucket.openUploadStream("MOS-Print-Setup-pilot.exe", { metadata: { sha256: digest } });
    await pipeline(Readable.from([bytes]), upload);
    // TTL is storage hygiene only. Application expiry checks remain mandatory.
    await db.collection("print_setup_pairings").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await releases.insertOne({ _id: manifest.release, fileId: upload.id, sha256: digest, bytes: bytes.length, createdAt: new Date() });
    console.log(JSON.stringify({ event: "installer_distributed", sha256: digest }));
  } finally { await client.close(); }
}
main().catch(() => { console.error("Installer distribution stopped. Check artifact, permissions, and existing release; no automatic retry."); process.exitCode = 1; });
