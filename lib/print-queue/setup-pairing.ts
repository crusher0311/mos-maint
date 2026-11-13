import { createHash, createPublicKey, publicEncrypt, constants, randomBytes } from "node:crypto";
import { pairingCollection } from "@/lib/data/repositories/print-setup";
import { generateApiKey, revokeApiKey } from "@/lib/external-api/api-keys";

export const pairingDeps = { pairingCollection, generateApiKey, revokeApiKey };
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function validPairingToken(token: unknown): token is string {
  return typeof token === "string" && /^[a-f0-9]{64}$/.test(token);
}
export async function beginPairing(publicKey: unknown) {
  if (typeof publicKey !== "string" || publicKey.length > 1000) throw new Error("Invalid public key");
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== "rsa" || key.asymmetricKeyDetails?.modulusLength !== 2048)
    throw new Error("Invalid public key");
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 10 * 60_000);
  await (await pairingDeps.pairingCollection()).insertOne({
    _id: hash(token), publicKey: key.export({ type: "spki", format: "pem" }).toString(),
    state: "pending", expiresAt, createdAt: new Date(),
  });
  return { pairingToken: token, expiresAt: expiresAt.toISOString() };
}
export async function pairingStatus(token: unknown) {
  if (!validPairingToken(token)) throw new Error("Invalid setup link");
  const doc = await (await pairingDeps.pairingCollection()).findOne({ _id: hash(token), expiresAt: { $gt: new Date() } });
  if (!doc) throw new Error("Setup expired. Start again from the wizard.");
  return doc.state === "approved"
    ? { state: "approved", shopId: doc.shopId, shopName: doc.shopName, encryptedKey: doc.encryptedKey }
    : { state: doc.state };
}
export async function approvePairing(token: unknown, shop: { shopId: number; name: string }, actor: string) {
  if (!validPairingToken(token)) throw new Error("Invalid setup link");
  const col = await pairingDeps.pairingCollection();
  const id = hash(token);
  // First approval wins; never allow a different browser/shop to rebind a device.
  const claimed = await col.findOneAndUpdate(
    { _id: id, state: "pending", expiresAt: { $gt: new Date() } },
    { $set: { state: "approving", shopId: shop.shopId, shopName: shop.name, approvedBy: actor } },
    { returnDocument: "after" },
  );
  if (!claimed) {
    const prior = await col.findOne({ _id: id, state: "approved", shopId: shop.shopId, expiresAt: { $gt: new Date() } });
    if (prior) return { approved: true, shopId: shop.shopId, shopName: shop.name };
    throw new Error("Setup expired or already claimed. Check the wizard before starting again.");
  }
  let keyId: string | undefined;
  try {
    const key = await pairingDeps.generateApiKey(shop.shopId, "MOS Print computer setup", ["print:agent"], actor);
    keyId = key.keyId;
    const encryptedKey = publicEncrypt({
      key: claimed.publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256",
    }, Buffer.from(key.key)).toString("base64");
    const result = await col.updateOne({ _id: id, state: "approving", expiresAt: { $gt: new Date() } },
      { $set: { state: "approved", encryptedKey, keyId }, $unset: { publicKey: "" } });
    if (result.modifiedCount !== 1) throw new Error("Setup expired");
    return { approved: true, shopId: shop.shopId, shopName: shop.name };
  } catch {
    // A lost database acknowledgement must not cause another credential mint.
    // Fail closed; revoke the known key even if encrypted persistence succeeded.
    if (keyId) await pairingDeps.revokeApiKey(keyId);
    await col.updateOne({ _id: id }, { $set: { state: "failed" }, $unset: { encryptedKey: "", publicKey: "" } });
    throw new Error("Connection was not completed. Start a new setup from the wizard.");
  }
}
