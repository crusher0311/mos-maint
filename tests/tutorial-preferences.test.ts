import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { parseTutorialAction, tutorialState } from "../lib/tutorial-preferences";
import { tutorialStoreDeps, personalTutorialPreferences } from "../lib/tutorial-preference-store";
import { tutorialRouteDeps, handleTutorialRequest } from "../lib/tutorial-route-handler";
import { lookupPolicy } from "../lib/extension-route-policy";

test("personal tutorial contract and authenticated routes stay isolated", async () => {
  for (const bad of [null, [], {}, { action: "reset" }, { action: "notice", userId: "other" },
    { action: "complete", guide: "__proto__" }, { action: "complete", guide: "vhi", shopId: 1 }]) {
    assert.equal(parseTutorialAction(bad), null);
  }
  assert.deepEqual(tutorialState({ complete_vhi: true, complete_jobs: "true", unknown: true }),
    { noticeSeen: false, dismissed: [], completed: ["vhi"] });
  const docs = new Map<string, any>([
    ["alice", { _id: "alice", untouched: { theme: "dark" }, tutorialPreferences: {} }],
    ["bob", { _id: "bob", tutorialPreferences: {} }],
  ]);
  let writes = 0;
  tutorialStoreDeps.isIdentityPgCanonical = () => false;
  tutorialStoreDeps.getDb = async () => ({
    collection(name: string) {
      assert.equal(name, "users");
      return {
        async findOne(filter: any) { return docs.get(String(filter._id.$in[0])) || null; },
        async updateOne(filter: any, update: any) {
          const doc = docs.get(String(filter._id.$in[0]));
          if (!doc || (filter["tutorialPreferences.noticeSeen"] && doc.tutorialPreferences.noticeSeen)) return { modifiedCount: 0 };
          writes++;
          for (const [key, value] of Object.entries(update.$set)) doc.tutorialPreferences[key.split(".")[1]] = value;
          return { modifiedCount: 1 };
        },
      };
    },
  }) as any;
  const claims = await Promise.all([personalTutorialPreferences("alice", { action: "notice" }),
    personalTutorialPreferences("alice", { action: "notice" })]);
  assert.equal(claims.filter(c => c.showNotice).length, 1);
  await personalTutorialPreferences("alice", { action: "dismiss", guide: "vhi" });
  await personalTutorialPreferences("alice", { action: "complete", guide: "vhi" });
  assert.deepEqual((await personalTutorialPreferences("alice")).state,
    { noticeSeen: true, dismissed: ["vhi"], completed: ["vhi"] });
  assert.deepEqual((await personalTutorialPreferences("bob")).state, tutorialState(null));
  assert.deepEqual(docs.get("alice").untouched, { theme: "dark" });
  tutorialRouteDeps.personalTutorialPreferences = personalTutorialPreferences;
  let userId = "alice";
  let authenticated = true;
  let assurance = "verified";
  let writable = true;
  tutorialRouteDeps.getSession = async () => authenticated ? { userId, shopId: 1, email: "same@example.test", token: "test", role: "owner" } : null;
  tutorialRouteDeps.validateExtensionToken = async () => ({
    authorized: authenticated, user: authenticated ? { _id: userId } : null, error: null,
    principal: { assurance, userId: assurance === "verified" ? userId : undefined,
      capabilities: writable ? ["read", "write"] : ["read"] },
  }) as any;
  const req = (ext = false, body?: unknown, origin = "https://example.test") => new NextRequest(
    `https://example.test/api/${ext ? "extension/" : ""}tutorials`, {
      method: body === undefined ? "GET" : "PUT",
      headers: { origin, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify({ expectedPersonId: userId, ...(body as object) }) }),
    });
  assert.deepEqual(lookupPolicy("/api/extension/tutorials", "PUT"), ["write"]);
  let response = await handleTutorialRequest(req(true), true);
  assert.equal((await response.json()).state.completed[0], "vhi");
  userId = "bob";
  response = await handleTutorialRequest(req(), false);
  assert.equal((await response.json()).state.noticeSeen, false);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const before = writes;
  for (const ext of [false, true]) {
    authenticated = false;
    assert.equal((await handleTutorialRequest(req(ext, { action: "notice" }), ext)).status, 401);
    authenticated = true;
    assert.equal((await handleTutorialRequest(req(ext, { action: "notice", personId: "alice" }), ext)).status, 400);
  }
  assert.equal((await handleTutorialRequest(req(false, { action: "notice" }, "https://attacker.test"), false)).status, 403);
  for (const ext of [false, true]) {
    assert.equal((await handleTutorialRequest(req(ext, { action: "complete", guide: "vhi", expectedPersonId: "alice" }), ext)).status, 409);
  }
  assurance = "basic";
  response = await handleTutorialRequest(req(true), true);
  assert.deepEqual(await response.json(), { personId: null, persistent: false, canSave: false, state: tutorialState(null) });
  assert.equal((await handleTutorialRequest(req(true, { action: "notice" }), true)).status, 403);
  assurance = "verified"; writable = false;
  assert.equal((await handleTutorialRequest(req(true, { action: "notice" }), true)).status, 403);
  assert.equal(writes, before);
  // Canonical PG mode never falls through to Mongo.
  tutorialStoreDeps.isIdentityPgCanonical = () => true;
  tutorialStoreDeps.getDb = async () => { throw new Error("Mongo must not be used"); };
  tutorialStoreDeps.readTutorialPreferences = async id => { assert.equal(id, "bob"); return { complete_jobs: true }; };
  tutorialStoreDeps.writeTutorialPreference = async (id, key) => { assert.equal(id, "bob"); assert.equal(key, "noticeSeen"); return true; };
  assert.equal((await personalTutorialPreferences("bob", { action: "notice" })).showNotice, true);
  assert.deepEqual((await personalTutorialPreferences("bob")).state.completed, ["jobs"]);
});
