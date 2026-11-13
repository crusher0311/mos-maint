import { getDb } from "@/lib/data/db";
import { GridFSBucket, ObjectId, type Db } from "mongodb";
import { createHash } from "node:crypto";

export const printSetupStore = { getDb: getDb as () => Promise<Db> };
export async function pairingCollection() {
  return (await printSetupStore.getDb()).collection<any>("print_setup_pairings");
}
export const INSTALLER_RELEASE = "windows-x64-pairing-diagnostic-v1";
export async function installerRelease() {
  return (await printSetupStore.getDb()).collection("print_installer_releases").findOne({ _id: INSTALLER_RELEASE as any });
}
export async function installerBytes() {
  const release = await installerRelease();
  if (!release || !/^[a-f0-9]{64}$/.test(String(release.sha256)) ||
      !ObjectId.isValid(String(release.fileId))) throw new Error("Installer unavailable");
  const stream = new GridFSBucket(await printSetupStore.getDb(), { bucketName: "print_installers" })
    .openDownloadStream(new ObjectId(String(release.fileId)));
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of stream) {
    const chunk = Buffer.from(raw); size += chunk.length;
    if (size > 32 * 1024 * 1024) { stream.destroy(); throw new Error("Installer too large"); }
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (createHash("sha256").update(bytes).digest("hex") !== release.sha256)
    throw new Error("Installer integrity check failed");
  return bytes;
}
