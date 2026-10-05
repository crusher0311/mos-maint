/**
 * Shared evaluator tests (task #1279 step 1).
 *
 * Run: npx tsx tests/estimate-audit-evaluator.smoke.ts
 */
import { evaluateAudit } from "../lib/estimate-assist/audit-evaluator";

let failed = 0;
function ok(name: string, condition: boolean, detail?: string) {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function fakeOpenAI(content: string | null, onCreate?: (options: any) => void) {
  return {
    chat: {
      completions: {
        create: async (_request: any, options: any) => {
          onCreate?.(options);
          return content == null ? null : {
            choices: [{ message: { content } }],
            usage: { total_tokens: 10 },
          };
        },
      },
    },
  };
}

async function run() {
  console.log("estimate audit shared evaluator");

  let aiRequestOptions: any;
  const duplicate = await evaluateAudit(
    {
      shopId: 42,
      lineItems: [{
        title: "Front Brake Pad Replacement",
        description: "Replace worn front brake pads and inspect the rotor condition.",
        partsTotal: 89,
      }],
      canUseMaintenance: false,
      workOrderId: "wo-1",
      provider: "tekmetric",
    },
    {
      getOpenAI: () => fakeOpenAI(
        JSON.stringify({
          findings: [{
            severity: "warning",
            category: "Estimate completeness",
            title: "Front brake pad replacement has missing labor",
            description: "Parts are quoted but labor is missing for this line.",
            lineItemIndex: 0,
          }],
        }),
        (options) => { aiRequestOptions = options; },
      ),
      getDb: async () => {
        throw new Error("VHI must not be read without maintenance access");
      },
      trackOpenAiCall: () => {},
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    },
  );
  const missingLabor = duplicate.findings.filter((finding) =>
    finding.evidence?.operation === "missing_labor",
  );
  ok("static and AI equivalent finding is merged before scoring", missingLabor.length === 1);
  ok(
    "merged finding contains both sources",
    missingLabor[0]?.sources?.includes("static") === true && missingLabor[0]?.sources?.includes("ai") === true,
    JSON.stringify(missingLabor[0]),
  );
  ok("AI completion reports complete when VHI is not applicable", duplicate.completeness === "complete");
  ok("AI completion status is explicit", duplicate.aiStatus.status === "completed");
  ok(
    "AI request receives an abort deadline and no SDK retries",
    aiRequestOptions?.signal instanceof AbortSignal && aiRequestOptions?.maxRetries === 0,
    JSON.stringify({ maxRetries: aiRequestOptions?.maxRetries, hasSignal: !!aiRequestOptions?.signal }),
  );

  const vhi = await evaluateAudit(
    {
      shopId: 42,
      lineItems: [{ title: "Oil Change", description: "Perform complete oil and filter service.", laborTotal: 40, partsTotal: 30 }],
      vehicleVin: "1hgcM82633a004352",
      canUseMaintenance: true,
    },
    {
      getDb: async () => ({ fake: true }),
      getCachedPlan: async () => ({
        plan: {
          distanceUnit: "miles",
          buckets: {
            overdue: [{ title: "Coolant Exchange", serviceKey: "coolant", dueAtMiles: 90000 }],
            dueSoon: [],
          },
        },
      }),
      getOpenAI: () => fakeOpenAI(null),
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    },
  );
  ok("VHI lookup uses cached-plan result", vhi.vhiComparison?.status === "compared");
  ok("missing cached VHI item is included", vhi.findings.some((finding) => finding.source === "vhi"));
  ok(
    "AI timeout is honestly marked partial rather than silently complete",
    vhi.completeness === "partial" && vhi.aiStatus.status === "unavailable",
    JSON.stringify(vhi.evaluation),
  );

  if (failed > 0) {
    console.error(`\n${failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nAll shared evaluator assertions passed");
}

run().catch((error) => {
  console.error("Test run crashed:", error);
  process.exit(1);
});