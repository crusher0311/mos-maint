import assert from "node:assert/strict";
import { createHash } from "node:crypto";

/**
 * Read-only verifier. It checks actual deployment records, including suspended
 * services, rather than trusting branch names or an operator readiness flag.
 * No POST, resume, deploy, environment update or provider request exists here.
 */
export async function verifyInvoiceRepairWriters(sql: any) {
  const expected = await sql.unsafe(`SELECT service_id,repository,expected_revision,
    compatibility_evidence_digest FROM invoice_repair_writer_inventory
    WHERE reviewed_at<=clock_timestamp() AND expires_at>clock_timestamp()
    ORDER BY service_id`);
  assert.ok(expected.length > 0 && expected.length <= 100, "Missing current reviewed writer inventory");
  const repositories = [...new Set(expected.map((r: any) => r.repository))];
  assert.equal(repositories.length, 1, "Writer repository scope must be explicit");
  for (const row of expected) {
    assert.match(row.service_id, /^srv-[a-z0-9]+$/);
    assert.match(row.expected_revision, /^[a-f0-9]{40}$/);
    assert.match(row.compatibility_evidence_digest, /^[a-f0-9]{64}$/);
  }
  const apiKey = process.env.RENDER_API_KEY_PROD;
  assert.ok(apiKey, "Read-only deployment verification is not configured");
  async function get(path: string) {
    const response = await fetch(`https://api.render.com/v1${path}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(5000), redirect: "error", cache: "no-store",
    });
    assert.ok(response.ok, "Deployment verification failed");
    const text = await response.text();
    assert.ok(Buffer.byteLength(text) <= 2_000_000, "Deployment inventory byte cap");
    return JSON.parse(text);
  }
  const services: any[] = [];
  let cursor = "", complete = false;
  for (let page = 0; page < 10; page++) {
    const rows = await get(`/services?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    assert.ok(Array.isArray(rows) && rows.length <= 100, "Malformed deployment inventory");
    services.push(...rows.map(r => r.service));
    if (rows.length < 100) { complete = true; break; }
    const next = rows.at(-1)?.cursor;
    assert.ok(typeof next === "string" && next && next !== cursor, "Incomplete service pagination");
    cursor = next;
  }
  assert.ok(complete, "Complete service inventory cap");
  const relevant = services.filter(s => s?.repo === repositories[0] &&
    ["web_service", "background_worker", "cron_job"].includes(s.type));
  assert.deepEqual(relevant.map(s => s.id).sort(), expected.map((r: any) => r.service_id).sort(),
    "Unknown or missing deployed writer; environment-group membership is insufficient");
  const evidence = [];
  for (const writer of expected) {
    const service = relevant.find(s => s.id === writer.service_id);
    assert.ok(["suspended", "not_suspended"].includes(service.suspended), "Unknown suspension state");
    const deployments = await get(`/services/${writer.service_id}/deploys?limit=100`);
    assert.ok(Array.isArray(deployments), "Malformed deployment records");
    const live = deployments.map(r => r.deploy).find(d => d?.status === "live");
    assert.equal(live?.commit?.id, writer.expected_revision, "Deployed writer is incompatible");
    const runtime = await sql.unsafe(`SELECT instance_id,revision,protocol FROM invoice_repair_writer_runtime
      WHERE service_id=$1 AND observed_at>clock_timestamp()-interval '30 seconds'
      ORDER BY instance_id`, [writer.service_id]);
    if (service.suspended === "not_suspended") {
      assert.ok(runtime.length > 0, "Missing fresh runtime writer evidence");
      for (const instance of runtime) {
        assert.equal(instance.revision, live.commit.id, "Runtime/deployed writer disagreement");
        assert.equal(instance.protocol, 1);
      }
    } else assert.equal(runtime.length, 0, "Suspended writer still appears active");
    evidence.push({ writer, deploymentId: live.id, suspended: service.suspended, runtime });
  }
  return createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
}
