import assert from "node:assert/strict";
import { generateKeyPairSync, privateDecrypt, constants, createHash } from "node:crypto";
import type { Db } from "mongodb";
import { pairingDeps, beginPairing, approvePairing, pairingStatus } from "../../lib/print-queue/setup-pairing";

export async function checkPrintSetup(db: Db) {
  const original = { ...pairingDeps };
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  let minted = 0, revoked = 0;
  const raw = "mos_" + "b".repeat(64);
  pairingDeps.pairingCollection = async () => db.collection<any>("setup_test");
  pairingDeps.generateApiKey = async (shopId, _name, permissions) => {
    assert.equal(shopId, 63); assert.deepEqual(permissions, ["print:agent"]);
    minted++; return { key: raw, keyPrefix: raw.slice(0, 12), keyId: String(minted) };
  };
  pairingDeps.revokeApiKey = async () => { revoked++; return true; };
  try {
    await assert.rejects(() => beginPairing("bad key"));
    const begun = await beginPairing(keys.publicKey);
    assert.deepEqual(await pairingStatus(begun.pairingToken), { state: "pending" });
    const approvals = await Promise.allSettled(Array.from({ length: 5 }, () =>
      approvePairing(begun.pairingToken, { shopId: 63, name: "Pilot fixture" }, "fixture")));
    assert(approvals.some(r => r.status === "fulfilled")); assert.equal(minted, 1);
    await approvePairing(begun.pairingToken, { shopId: 63, name: "Pilot fixture" }, "fixture");
    assert.equal(minted, 1);
    await assert.rejects(() => approvePairing(begun.pairingToken, { shopId: 64, name: "Other" }, "fixture"));
    const status = await pairingStatus(begun.pairingToken);
    assert.equal(status.state, "approved");
    assert.equal(privateDecrypt({ key: keys.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256" }, Buffer.from(status.encryptedKey, "base64")).toString(), raw);
    const doc = await db.collection("setup_test").findOne({});
    assert(!JSON.stringify(doc).includes(raw)); assert(!JSON.stringify(doc).includes(begun.pairingToken));
    assert.equal(doc?.publicKey, undefined);
    const hash = createHash("sha256").update(begun.pairingToken).digest("hex");
    await db.collection<any>("setup_test").updateOne({ _id: hash }, { $set: { expiresAt: new Date(0) } });
    await assert.rejects(() => pairingStatus(begun.pairingToken));
    await assert.rejects(() => approvePairing(begun.pairingToken, { shopId: 63, name: "Pilot" }, "fixture"));
    const failed = await beginPairing(keys.publicKey);
    pairingDeps.generateApiKey = async () => { throw new Error("offline failure"); };
    await assert.rejects(() => approvePairing(failed.pairingToken, { shopId: 63, name: "Pilot" }, "fixture"));
    assert.equal((await pairingStatus(failed.pairingToken)).state, "failed");
    assert.equal(revoked, 0);
    console.log("PASS real Mongo setup approval races, encryption, expiry and shop isolation");
  } finally { Object.assign(pairingDeps, original); }
}
