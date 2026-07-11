/**
 * Route-level smoke tests for the Estimate Assist API surface:
 *
 *   - POST /api/estimate-assist/audit          (dual auth, validation, AI merge, history save)
 *   - POST /api/estimate-assist/job-builder    (dual auth, validation, KB vs AI fallback)
 *   - POST /api/estimate-assist/language       (session auth, validation, 504 on AI timeout)
 *   - GET  /api/estimate-assist/audit/history  (session auth, shop scoping, pagination)
 *
 * Run:
 *   NODE_OPTIONS='--require ./scripts/_stubs/server-only-stub.cjs' npx tsx tests/estimate-assist-routes.smoke.ts
 *
 * The `server-only` stub is required because the routes import `lib/auth`.
 * All external dependencies — session store, extension-token validation,
 * AI budget, OpenAI, Mongo, Postgres VIN lookup — are swapped via each
 * route's `__deps` test seam, so nothing here touches a real database or
 * makes a live OpenAI call (the fake OpenAI throws if used unexpectedly).
 */

import { NextRequest, NextResponse } from "next/server";
import { makeFakeDb } from "./utils/fake-mongo";
import { ESTIMATE_COLLECTIONS } from "../lib/estimate-assist/job-knowledge-base";
import { NORMALIZED_COLLECTIONS } from "../lib/normalized-schema";
import { POST as auditPOST, __deps as auditDeps } from "../app/api/estimate-assist/audit/route";
import { POST as builderPOST, __deps as builderDeps } from "../app/api/estimate-assist/job-builder/route";
import { POST as languagePOST, __deps as languageDeps } from "../app/api/estimate-assist/language/route";
import { GET as historyGET, __deps as historyDeps } from "../app/api/estimate-assist/audit/history/route";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ------------------------------------------------------------------
// Shared fakes
// ------------------------------------------------------------------

const SESSION = { email: "advisor@shop.test", shopId: 42, role: "admin" };

function jsonReq(url: string, body: any, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** Fake OpenAI client. `content` is what choices[0].message.content returns.
 *  Pass `null` as content to simulate a timeout (withUpstreamTimeout fallback
 *  shape: the awaited value itself is null). Pass `"THROW"` to simulate a
 *  hard client failure. */
function fakeOpenAI(content: string | null, calls: { n: number }) {
  return {
    chat: {
      completions: {
        create: async (_args: any) => {
          calls.n += 1;
          if (content === "THROW") throw new Error("fake OpenAI down");
          if (content === null) return null;
          return {
            choices: [{ message: { content } }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
            model: "gpt-4o-mini",
          };
        },
      },
    },
  } as any;
}

/** OpenAI stub that must never be reached. */
function bannedOpenAI(calls: { n: number }) {
  return {
    chat: {
      completions: {
        create: async () => {
          calls.n += 1;
          throw new Error("OpenAI must not be called in this scenario");
        },
      },
    },
  } as any;
}

const ORIGINAL = {
  audit: { ...auditDeps },
  builder: { ...builderDeps },
  language: { ...languageDeps },
  history: { ...historyDeps },
};

function restoreAll() {
  Object.assign(auditDeps, ORIGINAL.audit);
  Object.assign(builderDeps, ORIGINAL.builder);
  Object.assign(languageDeps, ORIGINAL.language);
  Object.assign(historyDeps, ORIGINAL.history);
}

/** Common happy-path plumbing: session present, not admin, budget OK. */
function stubCommon(deps: any) {
  deps.getSession = async () => ({ ...SESSION });
  if ("isPlatformAdmin" in deps) deps.isPlatformAdmin = async () => false;
  if ("enforceAiBudget" in deps) deps.enforceAiBudget = async () => null;
  if ("trackOpenAiCall" in deps) deps.trackOpenAiCall = () => {};
}

async function run() {
  console.log("estimate-assist route smoke tests");

  // ================================================================
  // Audit route
  // ================================================================
  console.log("\nPOST /api/estimate-assist/audit — auth:");
  {
    restoreAll();
    auditDeps.getSession = async () => null;
    const res = await auditPOST(jsonReq("/api/estimate-assist/audit", { lineItems: [] }));
    ok("no session → 401", res.status === 401);
    const body = await res.json();
    ok("  → ok:false body", body.ok === false);
  }
  {
    restoreAll();
    auditDeps.validateExtensionToken = async () => ({
      authorized: false,
      code: "token_invalid",
      error: "Invalid extension token",
    }) as any;
    auditDeps.getSession = async () => {
      throw new Error("session path must not run for ext_ bearer tokens");
    };
    const res = await auditPOST(
      jsonReq("/api/estimate-assist/audit", { lineItems: [] }, { authorization: "Bearer ext_bad" }),
    );
    ok("invalid ext_ token → 401", res.status === 401, String(res.status));
    const body = await res.json();
    ok("  → stable code field for extension retry classification", typeof body.code === "string" && body.code.length > 0, JSON.stringify(body));
  }

  console.log("\nPOST /api/estimate-assist/audit — validation:");
  {
    restoreAll();
    stubCommon(auditDeps);
    const res = await auditPOST(jsonReq("/api/estimate-assist/audit", {}));
    ok("no lineItems and no workOrderId → 400", res.status === 400);
    const body = await res.json();
    ok("  → explains what's missing", /lineItems|workOrderId/.test(body.error || ""), body.error);
  }
  {
    restoreAll();
    stubCommon(auditDeps);
    const fake = makeFakeDb({});
    auditDeps.getDb = (async () => fake.db) as any;
    const res = await auditPOST(jsonReq("/api/estimate-assist/audit", { workOrderId: "99999" }));
    ok("unknown workOrderId → 404 RO_NOT_SYNCED", res.status === 404);
    const body = await res.json();
    ok("  → code RO_NOT_SYNCED", body.code === "RO_NOT_SYNCED");
    ok(
      "  → tried normalized id, RO number, and provenance lookups",
      fake.ops.filter(o => o.op === "findOne" && o.collection === NORMALIZED_COLLECTIONS.workOrders).length === 3,
    );
  }
  {
    restoreAll();
    stubCommon(auditDeps);
    const blocked = NextResponse.json({ ok: false, error: "AI budget exceeded" }, { status: 429 });
    auditDeps.enforceAiBudget = (async () => blocked) as any;
    const res = await auditPOST(
      jsonReq("/api/estimate-assist/audit", { lineItems: [{ title: "Oil Change" }] }),
    );
    ok("budget-blocked → blocker response passed through (429)", res.status === 429);
  }

  console.log("\nPOST /api/estimate-assist/audit — lineItems + workOrderId together:");
  {
    // Extension now sends live on-screen lineItems alongside the Tekmetric
    // internal RO id. A missing/empty DB copy must NEVER fail the request.
    restoreAll();
    stubCommon(auditDeps);
    const fake = makeFakeDb({});
    auditDeps.getDb = (async () => fake.db) as any;
    const aiCalls = { n: 0 };
    auditDeps.getOpenAI = () => fakeOpenAI(null, aiCalls); // AI timeout → static findings only
    const res = await auditPOST(
      jsonReq("/api/estimate-assist/audit", {
        workOrderId: "555001",
        lineItems: [{ title: "Front Brake Pad Replacement", description: "long enough description here", partsTotal: 89 }],
        vehicleInfo: { year: 2020, make: "Honda", model: "Civic" },
      }),
    );
    ok("unsynced RO + provided lineItems → 200 (DB miss never fails)", res.status === 200, String(res.status));
    const body = await res.json();
    ok("  → report built from provided lineItems", body.ok === true && body.report.findings.length >= 1);
  }
  {
    // When both are sent and the webhook cache knows the RO, the report is
    // enriched with the display RO number (internal id ≠ display number).
    restoreAll();
    stubCommon(auditDeps);
    const fake = makeFakeDb({
      tekmetric_work_orders: [
        {
          _id: "twoc-1",
          shopId: "42", // string in this cache
          workOrderId: "555001", // Tekmetric internal id
          workOrderNumber: 26352, // display RO number
          vehicleYear: 2019,
          vehicleMake: "Toyota",
          vehicleModel: "Camry",
          odometer: 88000,
        },
      ],
    });
    auditDeps.getDb = (async () => fake.db) as any;
    const aiCalls = { n: 0 };
    auditDeps.getOpenAI = () => fakeOpenAI(null, aiCalls);
    const res = await auditPOST(
      jsonReq("/api/estimate-assist/audit", {
        workOrderId: "555001",
        lineItems: [{ title: "Front Brake Pad Replacement", description: "long enough description here", partsTotal: 89 }],
      }),
    );
    ok("both sent + cache hit → 200", res.status === 200);
    const body = await res.json();
    ok("  → display RO number enriched from webhook cache", body.report.workOrderNumber === "26352", body.report.workOrderNumber);
    ok("  → vehicle enriched from webhook cache", body.report.vehicleDisplay === "2019 Toyota Camry", body.report.vehicleDisplay);
  }

  console.log("\nPOST /api/estimate-assist/audit — webhook-cache fallback (workOrderId only):");
  {
    // RO not normalized yet, but the Tekmetric webhook cache has data.jobs
    // (cents). The DB path must use them instead of returning RO_NOT_SYNCED.
    restoreAll();
    stubCommon(auditDeps);
    const fake = makeFakeDb({
      tekmetric_work_orders: [
        {
          _id: "twoc-2",
          shopId: "42",
          workOrderId: "555002",
          workOrderNumber: 26353,
          vehicleYear: 2021,
          vehicleMake: "Ford",
          vehicleModel: "F-150",
          odometer: 42000,
          data: {
            jobs: [
              {
                name: "Front Brake Pad Replacement",
                note: "long enough description here",
                laborTotal: 15000, // cents
                partsTotal: 8900, // cents
                subtotal: 23900, // cents
                labor: [{ name: "R&R pads", hours: 1.5, rate: 10000 }],
              },
              { name: null }, // nameless job must be skipped, not crash
            ],
          },
        },
      ],
    });
    auditDeps.getDb = (async () => fake.db) as any;
    const aiCalls = { n: 0 };
    auditDeps.getOpenAI = () => fakeOpenAI(null, aiCalls);
    const res = await auditPOST(jsonReq("/api/estimate-assist/audit", { workOrderId: "555002" }));
    ok("normalized miss + webhook cache jobs → 200", res.status === 200, String(res.status));
    const body = await res.json();
    ok("  → report produced from cached jobs", body.ok === true && !!body.report);
    ok("  → display RO number from cache", body.report.workOrderNumber === "26353", body.report.workOrderNumber);
    ok("  → vehicle from cache", body.report.vehicleDisplay === "2021 Ford F-150", body.report.vehicleDisplay);
    // Cents→dollars conversion: a $150-labor/$89-parts line should NOT
    // trip absurd-value rules; check via the saved history row's line count.
    const saved = fake.collections[ESTIMATE_COLLECTIONS.estimateAudits] || [];
    ok("  → nameless cached job skipped (1 line item audited)", saved[0]?.lineItemCount === 1, String(saved[0]?.lineItemCount));
  }
  {
    // Display-RO-number lookup: dashboard users type the RO number, which
    // matches the cache's workOrderNumber (stored as a number), not workOrderId.
    restoreAll();
    stubCommon(auditDeps);
    const fake = makeFakeDb({
      tekmetric_work_orders: [
        {
          _id: "twoc-3",
          shopId: "42",
          workOrderId: "555003",
          workOrderNumber: 26354,
          data: { jobs: [{ name: "Oil Change", note: "long enough description here", laborTotal: 3000, partsTotal: 4500, subtotal: 7500 }] },
        },
      ],
    });
    auditDeps.getDb = (async () => fake.db) as any;
    const aiCalls = { n: 0 };
    auditDeps.getOpenAI = () => fakeOpenAI(null, aiCalls);
    const res = await auditPOST(jsonReq("/api/estimate-assist/audit", { workOrderId: "26354" }));
    ok("lookup by display RO number hits webhook cache → 200", res.status === 200, String(res.status));
  }
  {
    // Normalized WO matches (via provenance, by Tekmetric internal id) but
    // has ZERO jobs; the webhook cache row is keyed by the DISPLAY RO
    // number. The fallback must query the cache with the caller's original
    // id / the WO's display number — NOT the rewritten normalized _id.
    restoreAll();
    stubCommon(auditDeps);
    const fake = makeFakeDb({
      [NORMALIZED_COLLECTIONS.workOrders]: [
        {
          _id: "nwo-2", // normalized _id — NOT a cache key
          shopId: 42,
          workOrderNumber: "26356",
          serviceJobs: [],
          provenance: { sourceSystem: "tekmetric", sourceIds: [{ idValue: "555004" }] },
        },
      ],
      tekmetric_work_orders: [
        {
          _id: "twoc-4",
          shopId: "42",
          workOrderId: "999999", // different internal id on the cache row
          workOrderNumber: 26356, // matches via the WO's display number
          data: { jobs: [{ name: "Coolant Flush", note: "long enough description here", laborTotal: 9000, partsTotal: 3500, subtotal: 12500 }] },
        },
      ],
    });
    auditDeps.getDb = (async () => fake.db) as any;
    const aiCalls = { n: 0 };
    auditDeps.getOpenAI = () => fakeOpenAI(null, aiCalls);
    const res = await auditPOST(jsonReq("/api/estimate-assist/audit", { workOrderId: "555004" }));
    ok("normalized WO w/ no jobs + cache keyed by RO number → 200", res.status === 200, String(res.status));
    const body = await res.json();
    ok("  → report built from cached jobs (not RO_NO_LINE_ITEMS)", body.ok === true && !!body.report, JSON.stringify(body.code || body.error || ""));
    ok(
      "  → cache never queried with the normalized _id",
      !fake.ops.some(
        (o) =>
          o.op === "findOne" &&
          o.collection === "tekmetric_work_orders" &&
          JSON.stringify(o.filter).includes("nwo-2"),
      ),
    );
  }
  {
    // Normalized WO exists but has no jobs, webhook cache empty too →
    // RO_NO_LINE_ITEMS (not RO_NOT_SYNCED, and not the generic message).
    restoreAll();
    stubCommon(auditDeps);
    const fake = makeFakeDb({
      [NORMALIZED_COLLECTIONS.workOrders]: [
        { _id: "nwo-1", shopId: 42, workOrderNumber: "26355", serviceJobs: [] },
      ],
    });
    auditDeps.getDb = (async () => fake.db) as any;
    const res = await auditPOST(jsonReq("/api/estimate-assist/audit", { workOrderId: "26355" }));
    ok("synced WO with no jobs anywhere → 400", res.status === 400, String(res.status));
    const body = await res.json();
    ok("  → code RO_NO_LINE_ITEMS", body.code === "RO_NO_LINE_ITEMS", body.code);
  }

  console.log("\nPOST /api/estimate-assist/audit — report generation (AI stubbed):");
  {
    restoreAll();
    stubCommon(auditDeps);
    const fake = makeFakeDb({});
    auditDeps.getDb = (async () => fake.db) as any;
    const aiCalls = { n: 0 };
    auditDeps.getOpenAI = () =>
      fakeOpenAI(
        JSON.stringify({
          findings: [
            {
              severity: "info",
              category: "AI Analysis",
              title: "Pricing looks below market",
              description: "Total appears low for this repair.",
              confidence: 0.6,
            },
          ],
        }),
        aiCalls,
      );
    const tracked: any[] = [];
    auditDeps.trackOpenAiCall = ((...args: any[]) => tracked.push(args)) as any;

    const res = await auditPOST(
      jsonReq("/api/estimate-assist/audit", {
        lineItems: [
          // parts-only line → static Missing Labor warning
          { title: "Front Brake Pad Replacement", description: "long enough description here", partsTotal: 89 },
        ],
        vehicleInfo: { year: 2020, make: "Honda", model: "Civic", mileage: 45000 },
      }),
    );
    ok("valid audit → 200", res.status === 200);
    const body = await res.json();
    ok("  → ok:true with report", body.ok === true && !!body.report);
    const categories = (body.report.findings as any[]).map(f => f.category);
    ok("  → static Missing Labor finding present", categories.includes("Missing Labor"), categories.join(","));
    ok("  → AI finding merged in", categories.includes("AI Analysis"), categories.join(","));
    ok("  → score reflects summary math (≤100, ≥0)", body.report.summary.score >= 0 && body.report.summary.score <= 100);
    ok(
      "  → score = 100 − 5·warnings − 1·info",
      body.report.summary.score ===
        100 - 15 * body.report.summary.critical - 5 * body.report.summary.warnings - 1 * body.report.summary.info,
      String(body.report.summary.score),
    );
    ok("  → vehicleDisplay built from vehicleInfo", body.report.vehicleDisplay === "2020 Honda Civic");
    ok("  → OpenAI called exactly once", aiCalls.n === 1);
    ok("  → usage tracked", tracked.length === 1 && tracked[0][0] === 42);
    const saved = fake.collections[ESTIMATE_COLLECTIONS.estimateAudits] || [];
    ok("  → audit history row saved with shop scoping", saved.length === 1 && saved[0].shopId === 42);
    ok("  → saved row carries score + finding count", saved[0]?.score === body.report.summary.score && saved[0]?.findingCount === body.report.findings.length);
  }
  {
    restoreAll();
    stubCommon(auditDeps);
    const fake = makeFakeDb({});
    auditDeps.getDb = (async () => fake.db) as any;
    const aiCalls = { n: 0 };
    auditDeps.getOpenAI = () => fakeOpenAI("THROW", aiCalls);
    const res = await auditPOST(
      jsonReq("/api/estimate-assist/audit", {
        lineItems: [{ title: "Front Brake Pad Replacement", description: "long enough description here", partsTotal: 89 }],
      }),
    );
    ok("AI failure → still 200 with static findings", res.status === 200);
    const body = await res.json();
    ok(
      "  → static findings survive, no AI findings",
      body.report.findings.length >= 1 && !body.report.findings.some((f: any) => f.category === "AI Analysis"),
    );
  }

  // ================================================================
  // Job-builder route
  // ================================================================
  console.log("\nPOST /api/estimate-assist/job-builder — auth + validation:");
  {
    restoreAll();
    builderDeps.getSession = async () => null;
    const res = await builderPOST(jsonReq("/api/estimate-assist/job-builder", { jobNameOrId: "x" }));
    ok("no session → 401", res.status === 401);
  }
  {
    restoreAll();
    builderDeps.validateExtensionToken = async () => ({
      authorized: false,
      code: "token_expired",
      error: "expired",
    }) as any;
    const res = await builderPOST(
      jsonReq("/api/estimate-assist/job-builder", { jobNameOrId: "x" }, { authorization: "Bearer ext_expired" }),
    );
    ok("invalid ext_ token → 401", res.status === 401, String(res.status));
  }
  {
    restoreAll();
    stubCommon(builderDeps);
    const res = await builderPOST(jsonReq("/api/estimate-assist/job-builder", {}));
    ok("missing jobNameOrId → 400", res.status === 400);
    const body = await res.json();
    ok("  → names the required field", (body.error || "").includes("jobNameOrId"), body.error);
  }

  console.log("\nPOST /api/estimate-assist/job-builder — KB hit (no AI call):");
  {
    restoreAll();
    stubCommon(builderDeps);
    const aiCalls = { n: 0 };
    builderDeps.getOpenAI = () => bannedOpenAI(aiCalls);
    builderDeps.getShopHistoricalAverage = (async () => ({
      avgHours: 1.1,
      avgTotal: 350,
      avgLaborTotal: 180,
      avgPartsTotal: 170,
      count: 12,
    })) as any;
    // AWD vehicle so the differential-fluid VIN adjustment (+0.3h) applies
    builderDeps.lookupVehicleByVin = (async (vin: string, shopId: number) => {
      ok("  (vin lookup receives uppercased-later vin + shop)", vin === "1hgcm82633a004352" && shopId === 42);
      return { year: 2021, make: "Subaru", model: "Outback", drivetrain: "AWD", engineCylinders: 4 };
    }) as any;

    const res = await builderPOST(
      jsonReq("/api/estimate-assist/job-builder", {
        jobNameOrId: "differential-fluid",
        vin: "1hgcm82633a004352",
      }),
    );
    ok("KB job → 200", res.status === 200);
    const body = await res.json();
    ok("  → estimate from knowledge base", body.ok === true && body.estimate.jobId === "differential-fluid");
    ok("  → NOT AI-enhanced", body.estimate.aiEnhanced === false);
    ok("  → OpenAI never called for a rich KB job", aiCalls.n === 0);
    ok(
      "  → AWD VIN adjustment applied to labor hours",
      body.estimate.vehicleContext.vinAdjustments?.laborHoursAdded === 0.3,
      JSON.stringify(body.estimate.vehicleContext),
    );
    ok(
      "  → AWD additional part included",
      body.estimate.requiredParts.includes("Front Differential Fluid"),
      JSON.stringify(body.estimate.requiredParts),
    );
    ok("  → shop history surfaced", body.estimate.shopHistory?.occurrences === 12);
    ok("  → shop average on laborHours", body.estimate.laborHours.shopAverage === 1.1);
  }

  console.log("\nPOST /api/estimate-assist/job-builder — AI fallback:");
  {
    restoreAll();
    stubCommon(builderDeps);
    builderDeps.getShopHistoricalAverage = (async () => null) as any;
    builderDeps.lookupVehicleByVin = (async () => null) as any;
    const aiCalls = { n: 0 };
    builderDeps.getOpenAI = () =>
      fakeOpenAI(
        JSON.stringify({
          technicalDescription: "Remove and replace the flux capacitor assembly per OEM procedure.",
          customerDescription: "Replace a worn part that keeps your vehicle running smoothly.",
          estimatedLaborHours: 2.5,
          requiredParts: ["Flux Capacitor"],
          companionJobs: ["Brake Fluid Flush", "Totally Made Up Nonexistent Service zzqq"],
        }),
        aiCalls,
      );
    const res = await builderPOST(
      jsonReq("/api/estimate-assist/job-builder", { jobNameOrId: "zzzz unmatchable widget qqqq" }),
    );
    ok("unknown job + AI success → 200", res.status === 200);
    const body = await res.json();
    ok("  → aiEnhanced:true, Custom category", body.estimate.aiEnhanced === true && body.estimate.category === "Custom");
    ok("  → AI called exactly once", aiCalls.n === 1);
    ok("  → AI labor hours used", body.estimate.laborHours.typical === 2.5, JSON.stringify(body.estimate.laborHours));
    ok("  → AI parts used", body.estimate.requiredParts.includes("Flux Capacitor"));
    // AI-suggested companion titles must map to real KB entries (and only
    // real ones) so off-KB jobs still show Related Jobs — previously these
    // were parsed and silently dropped.
    ok(
      "  → AI companion titles mapped to KB entries",
      body.estimate.companionJobs.length === 1 &&
        body.estimate.companionJobs[0].jobId === "brake-fluid-flush",
      JSON.stringify(body.estimate.companionJobs),
    );
  }
  {
    restoreAll();
    stubCommon(builderDeps);
    builderDeps.getShopHistoricalAverage = (async () => null) as any;
    builderDeps.lookupVehicleByVin = (async () => null) as any;
    const aiCalls = { n: 0 };
    builderDeps.getOpenAI = () => fakeOpenAI(null, aiCalls); // simulates upstream timeout
    const res = await builderPOST(
      jsonReq("/api/estimate-assist/job-builder", { jobNameOrId: "zzzz unmatchable widget qqqq" }),
    );
    ok("unknown job + AI timeout → 504 (no silent empty estimate)", res.status === 504, String(res.status));
    const body = await res.json();
    ok("  → loud error message", body.ok === false && /took too long/i.test(body.error || ""), body.error);
  }

  // ================================================================
  // Language route
  // ================================================================
  console.log("\nPOST /api/estimate-assist/language:");
  {
    restoreAll();
    languageDeps.getSession = async () => null;
    const res = await languagePOST(jsonReq("/api/estimate-assist/language", { text: "hi" }));
    ok("no session → 401", res.status === 401);
  }
  {
    restoreAll();
    stubCommon(languageDeps);
    const res = await languagePOST(jsonReq("/api/estimate-assist/language", {}));
    ok("no text and no lineItems → 400", res.status === 400);
  }
  {
    restoreAll();
    stubCommon(languageDeps);
    const blocked = NextResponse.json({ ok: false, error: "AI budget exceeded" }, { status: 429 });
    languageDeps.enforceAiBudget = (async () => blocked) as any;
    const res = await languagePOST(jsonReq("/api/estimate-assist/language", { text: "replace brakes" }));
    ok("budget-blocked → 429 passthrough", res.status === 429);
  }
  {
    restoreAll();
    stubCommon(languageDeps);
    const aiCalls = { n: 0 };
    languageDeps.getOpenAI = () =>
      fakeOpenAI(
        JSON.stringify({
          technical: "R&R front brake pads; torque caliper bolts to spec.",
          customer: "We'll replace your front brake pads so you stop safely.",
          lineItems: [],
        }),
        aiCalls,
      );
    const res = await languagePOST(
      jsonReq("/api/estimate-assist/language", {
        lineItems: [
          // labor without parts → completionIssues warning computed pre-AI
          { description: "front pads", hasLabor: true, hasParts: false, laborHours: 1 },
        ],
      }),
    );
    ok("valid request → 200", res.status === 200);
    const body = await res.json();
    ok("  → technical + customer versions returned", body.technical.startsWith("R&R") && body.customer.includes("brake pads"));
    ok(
      "  → completionIssues flag missing parts",
      body.completionIssues.some((i: any) => i.type === "missing_parts"),
      JSON.stringify(body.completionIssues),
    );
    ok("  → AI called exactly once", aiCalls.n === 1);
  }
  {
    restoreAll();
    stubCommon(languageDeps);
    const aiCalls = { n: 0 };
    languageDeps.getOpenAI = () => fakeOpenAI(null, aiCalls); // upstream timeout
    const res = await languagePOST(jsonReq("/api/estimate-assist/language", { text: "replace brakes" }));
    ok("AI timeout → 504 (fails loudly)", res.status === 504, String(res.status));
  }

  // ================================================================
  // Audit history route
  // ================================================================
  console.log("\nGET /api/estimate-assist/audit/history:");
  {
    restoreAll();
    historyDeps.getSession = async () => null;
    const res = await historyGET(new NextRequest("http://localhost/api/estimate-assist/audit/history"));
    ok("no session → 401", res.status === 401);
  }
  {
    restoreAll();
    historyDeps.getSession = async () => ({ ...SESSION });
    const mkAudit = (i: number, shopId: number, severity: string) => ({
      _id: `a-${shopId}-${i}`,
      shopId,
      workOrderId: `wo-${i}`,
      workOrderNumber: `${1000 + i}`,
      lineItemCount: 2,
      findingCount: 1,
      score: 90 - i,
      createdAt: new Date(Date.UTC(2026, 5, i + 1)),
      report: { findings: [{ severity }] },
    });
    const fake = makeFakeDb({
      [ESTIMATE_COLLECTIONS.estimateAudits]: [
        mkAudit(1, 42, "warning"),
        mkAudit(2, 42, "critical"),
        mkAudit(3, 42, "info"),
        mkAudit(4, 777, "critical"), // other shop — must never leak
      ],
    });
    historyDeps.getDb = (async () => fake.db) as any;

    const res = await historyGET(new NextRequest("http://localhost/api/estimate-assist/audit/history"));
    ok("history → 200", res.status === 200);
    const body = await res.json();
    ok("  → only this shop's audits returned", body.audits.length === 3 && body.totalCount === 3);
    ok(
      "  → other shop's audit never leaks",
      !body.audits.some((a: any) => a._id === "a-777-4"),
    );
    ok(
      "  → newest first",
      body.audits[0]._id === "a-42-3" && body.audits[2]._id === "a-42-1",
      body.audits.map((a: any) => a._id).join(","),
    );

    const paged = await historyGET(
      new NextRequest("http://localhost/api/estimate-assist/audit/history?limit=1&offset=1"),
    );
    const pagedBody = await paged.json();
    ok(
      "  → limit/offset respected (page 2 of 1-per-page)",
      pagedBody.audits.length === 1 && pagedBody.audits[0]._id === "a-42-2" && pagedBody.totalCount === 3,
      JSON.stringify(pagedBody.audits.map((a: any) => a._id)),
    );

    const filtered = await historyGET(
      new NextRequest("http://localhost/api/estimate-assist/audit/history?severity=critical"),
    );
    const filteredBody = await filtered.json();
    ok(
      "  → severity filter matches inside report.findings",
      filteredBody.audits.length === 1 && filteredBody.audits[0]._id === "a-42-2",
      JSON.stringify(filteredBody.audits.map((a: any) => a._id)),
    );

    const capped = await historyGET(
      new NextRequest("http://localhost/api/estimate-assist/audit/history?limit=5000"),
    );
    const cappedBody = await capped.json();
    ok("  → limit capped at 100", cappedBody.limit === 100);
  }

  restoreAll();
  if (failed > 0) {
    console.error(`\n${failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nAll assertions passed");
}

run().catch((err) => {
  console.error("Test run crashed:", err);
  process.exit(1);
});
