import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { publicEncrypt, constants } from "node:crypto";
import { beginDeviceConnection, checkDeviceConnection } from "../src/ipp/pairing";
test("device handoff keeps secrets local, reuses pending setup, and decrypts only its credential", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mos-pairing-"));
  let publicKey = "", begins = 0, approved = false;
  const raw = "mos_" + "c".repeat(64);
  const fake = (async (url: string, init: RequestInit) => {
    assert.equal(url, "https://mos.tools/api/print-agent/pair"); assert.equal(init.redirect, "error");
    const data = JSON.parse(String(init.body));
    if (data.action === "begin") {
      begins++; publicKey = data.publicKey;
      assert(!String(init.body).includes("PRIVATE"));
      return new Response(JSON.stringify({ pairingToken: "a".repeat(64), expiresAt: new Date(Date.now() + 600_000).toISOString() }));
    }
    return new Response(JSON.stringify(approved ? { state: "approved", shopId: 63,
      encryptedKey: publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(raw)).toString("base64") } : { state: "pending" }));
  }) as typeof fetch;
  try {
    const start = await beginDeviceConnection(dir, fake);
    assert(start.approvalUrl.includes("#pair=")); assert(!start.approvalUrl.includes(raw));
    assert.deepEqual(await beginDeviceConnection(dir, fake), start); assert.equal(begins, 1);
    await assert.rejects(() => checkDeviceConnection(dir, fake));
    approved = true;
    assert.deepEqual(await checkDeviceConnection(dir, fake), { key: raw, shopId: 63 });
    assert.deepEqual(await checkDeviceConnection(dir, fake), { key: raw, shopId: 63 });
    assert(!fs.readFileSync(path.join(dir, "setup-pairing.json"), "utf8").includes(raw));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
