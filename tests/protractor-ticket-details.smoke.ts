/**
 * Regression coverage for Protractor ticket details consumed by Missed
 * Opportunities. The fixture mirrors the affected invoice shape: wrapped
 * package arrays, an overlapping deferred package, deferred-only packages,
 * package-level totals, and flat/nested line pricing.
 *
 * Run: `npx tsx tests/protractor-ticket-details.smoke.ts`
 */
import { ProtractorAdapter } from "../lib/integrations/core/normalized-adapter";
import {
  extractProtractorServicePackages,
  normalizeProtractorServiceJobStatus,
} from "../lib/integrations/protractor/package-normalization";
import { extractJobIndexFromWorkOrder } from "../lib/job-index";
import {
  evaluateRoLines,
  summarizeMissedOpportunities,
  type MissedOpportunityRo,
  type VhiComparisonItem,
} from "../lib/missed-opportunities";
import {
  classifyTicketJobStatus,
  normalizeTicketJobAmount,
} from "../lib/missed-opportunity-ticket-details";
import {
  buildRepairFilter,
  getRepairCheckpointKey,
  parseRepairArgs,
  replayCachedWorkOrder,
} from "../scripts/repair-protractor-ticket-details";

let failed = 0;
function ok(name: string, condition: boolean, detail?: string) {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const approx = (actual: number | undefined, expected: number) =>
  typeof actual === "number" && Math.abs(actual - expected) < 0.005;

const oilLines = [
  { ID: "oil-1", Type: "Material", Description: "Citgo Full Synthetic", Quantity: 5, Price: 11.89 },
  { ID: "oil-2", Type: "Part", Description: "Engine Oil Filter", Quantity: 1, Total: 5.8 },
  { ID: "oil-3", Type: "Labor", Description: "Labor", Hours: 1, Rate: 34.7 },
];

const invoice = {
  ID: "invoice-guid-709006573",
  InvoiceNumber: 709006573,
  WorkOrderNumber: 709007288,
  InvoiceTime: "2026-08-25T09:17:00.000Z",
  Header: { LastModifiedTime: "2026-08-25T09:17:00.000Z" },
  ServiceItem: { VIN: "3GNAL3EK5DS560271" },
  ServicePackages: {
    ItemCollection: [
      {
        ID: "diagnostic",
        Status: "Com-pleted",
        Total: 62.5,
        ServicePackageHeader: { Title: "Cooling System Evaluation" },
        ServicePackageLines: {
          ItemCollection: [{ ID: "diag-1", Type: "Labor", Hours: 0.5, Rate: 125 }],
        },
      },
      {
        ID: "oil-change",
        Status: "Completed",
        ServicePackageHeader: { Title: "•Oil Change - Full Synthetic" },
        ServicePackageLines: { ItemCollection: oilLines },
      },
      {
        ID: "regular-declined",
        Status: " declined ",
        ServicePackageHeader: { Title: "Declined Alignment" },
        ServicePackageLines: {
          ItemCollection: [{ ID: "align-1", Type: "Labor", Hours: 1, Rate: 125 }],
        },
      },
      {
        ID: "duplicate-lines",
        Status: "Completed",
        ServicePackageHeader: { Title: "Duplicate-description labor" },
        ServicePackageLines: {
          ItemCollection: [
            { Type: "Labor", Description: "Technician labor", Hours: 1, Rate: 10 },
            { Type: "Labor", Description: "Technician labor", Hours: 2, Rate: 20 },
          ],
        },
      },
      {
        ID: "zero-dollar",
        Status: "APPROVED",
        Total: 0,
        ServicePackageHeader: { Title: "Customer Requests / Comments / Notes" },
        ServicePackageLines: {
          ItemCollection: [{ ID: "note-1", Type: "Labor", Description: "Notes", Hours: 1 }],
        },
      },
    ],
  },
  DeferredServicePackages: {
    ItemCollection: [
      {
        ID: "oil-change",
        Status: "Completed",
        ServicePackageHeader: { Description: "Deferred by customer" },
        ServicePackageLines: { ItemCollection: [] },
      },
      {
        ID: "duplicate-lines",
        Status: "Deferred",
        ServicePackageHeader: { Title: "Duplicate-description labor" },
        ServicePackageLines: {
          ItemCollection: [
            { Type: "Labor", Description: "Technician labor", Hours: 1, Rate: 10 },
            { Type: "Labor", Description: "Technician labor", Hours: 2, Rate: 20 },
          ],
        },
      },
      {
        ID: "bg-engine",
        Status: "performed",
        ServicePackageHeader: { Title: "BG Engine Performance Restoration" },
        ServicePackageLines: {
          ItemCollection: [
            {
              ID: "bg-1",
              Type: "Part",
              Quantity: 1,
              PriceSummary: { SellPrice: 41.25, SellTotal: 41.25 },
            },
            { ID: "bg-2", Type: "Labor", Quantity: 1, Total: 28.7 },
          ],
        },
      },
      {
        ID: "bg-cooling",
        Status: "IN PROGRESS",
        PriceSummary: { SellTotal: 229.99 },
        ServicePackageHeader: { Title: "BG Cooling System Fluid Exchange Service" },
        ServicePackageLines: [
          { ID: "cool-1", Type: "Part", Quantity: 1, Price: 65.01 },
          { ID: "cool-2", Type: "Material", Quantity: 2, Price: 19.99 },
          { ID: "cool-3", Type: "Labor", Hours: 1, Rate: 120 },
        ],
      },
    ],
  },
};

const adapter = new ProtractorAdapter();
const rawPackages = adapter.extractRawServiceJobsFromWorkOrder(invoice);
const rawById = new Map(rawPackages.map((servicePackage) => [servicePackage.ID, servicePackage]));

console.log("Package extraction:");
ok("regular + deferred containers are both retained", rawPackages.length === 7, `got ${rawPackages.length}`);
ok(
  "overlapping package is represented once",
  rawPackages.filter((servicePackage) => servicePackage.ID === "oil-change").length === 1,
);
ok("deferred-only package is retained", rawById.has("bg-engine") && rawById.has("bg-cooling"));
ok("deferred provenance wins over misleading package status", rawById.get("oil-change")?._isDeferred === true);
ok(
  "thin deferred duplicate does not erase regular pricing lines",
  adapter.extractLineItemsFromServiceJob(rawById.get("oil-change")).length === oilLines.length,
);
ok(
  "partial deferred header does not erase regular title",
  rawById.get("oil-change")?.ServicePackageHeader?.Title === "•Oil Change - Full Synthetic",
);
ok(
  "duplicate ID-less lines survive overlapping package merge",
  adapter.extractLineItemsFromServiceJob(rawById.get("duplicate-lines")).length === 2,
);
ok(
  "parent invoice date is preserved",
  rawPackages.every((servicePackage) => servicePackage._parentClosedAt === invoice.InvoiceTime),
);

const directShape = extractProtractorServicePackages({
  ServicePackages: [{ ID: "direct-1" }],
  DeferredServicePackages: [{ ID: "direct-2" }],
});
ok("direct-array containers are supported", directShape.length === 2);

console.log("Disposition and pricing:");
const mapped = rawPackages.map((servicePackage) =>
  adapter.mapServiceJob(235, "wo-normalized", servicePackage),
);
const mappedById = new Map(mapped.map((job) => [job.jobNumber, job]));
ok("status spelling normalizes safely", mappedById.get("diagnostic")?.status === "completed");
ok("approved variant normalizes to authorized", mappedById.get("zero-dollar")?.status === "authorized");
ok("deferred overlap maps to deferred", mappedById.get("oil-change")?.status === "deferred");
ok("deferred-only misleading performed maps to deferred", mappedById.get("bg-engine")?.status === "deferred");
ok("flat line pricing produces oil subtotal", approx(mappedById.get("oil-change")?.total, 99.95));
ok("mixed nested/flat line pricing produces BG subtotal", approx(mappedById.get("bg-engine")?.total, 69.95));
ok("package-level total wins when present", approx(mappedById.get("bg-cooling")?.total, 229.99));
ok("legitimate package-level zero stays zero", mappedById.get("zero-dollar")?.total === 0);
ok("duplicate ID-less line charges are both retained", approx(mappedById.get("duplicate-lines")?.total, 50));
ok("space/hyphen status variant is recognized", normalizeProtractorServiceJobStatus("IN-PROGRESS") === "in_progress");

console.log("Normalized surfaces:");
const embedded = adapter.extractServiceJobsFromWorkOrder(invoice);
const embeddedById = new Map(embedded.map((job) => [job.jobNumber, job]));
ok("embedded snapshots retain the same unique package set", embedded.length === rawPackages.length);
ok(
  "embedded and standalone totals agree",
  approx(embeddedById.get("oil-change")?.total, mappedById.get("oil-change")?.total || -1),
);
const oilEmbedded = embeddedById.get("oil-change");
const embeddedLineTotal = (oilEmbedded?.lineItems || []).reduce(
  (sum, line) => sum + Number(line.extendedPrice || 0),
  0,
);
ok("normalized line-item prices sum to the package total", approx(embeddedLineTotal, 99.95));

const jobIndex = extractJobIndexFromWorkOrder(235, invoice, "protractor");
ok("job_index also deduplicates the overlapping package", jobIndex.filter((job) => job.servicePackageId === "oil-change").length === 1);
ok("job_index sees deferred-only packages", jobIndex.some((job) => job.servicePackageId === "bg-engine" && job.isDeferred));
ok(
  "regular-container explicit declined package cannot become a performed anchor",
  jobIndex.some((job) => job.servicePackageId === "regular-declined" && job.isDeferred),
);
ok("job_index shares package total pricing", approx(jobIndex.find((job) => job.servicePackageId === "bg-cooling")?.totals.totalAmount, 229.99));
const lowercaseLinesIndex = extractJobIndexFromWorkOrder(
  235,
  {
    ID: "lower-lines-invoice",
    WorkOrderNumber: 709007289,
    ServiceItem: { VIN: invoice.ServiceItem.VIN },
    ServicePackages: [
      {
        ID: "lower-lines-package",
        ServicePackageHeader: { Title: "Lowercase lines shape" },
        lines: [{ Type: "Labor", Description: "Labor", Quantity: 1, Price: 10 }],
      },
    ],
  },
  "protractor",
);
ok(
  "job_index retains established lowercase lines container",
  lowercaseLinesIndex.length === 1 &&
    approx(lowercaseLinesIndex[0]?.totals.totalAmount, 10),
);

console.log("Missed Opportunities contract:");
const planItems: VhiComparisonItem[] = [
  { title: "Engine Oil & Filter Replace", serviceKey: "engine_oil", status: "overdue" },
  { title: "Brake Fluid Exchange", serviceKey: "brake_fluid", status: "overdue" },
];
const ticketTitles = mapped.map((job) => job.title || "");
const beforeStatusAndPriceRepair = evaluateRoLines(ticketTitles, planItems);
const afterStatusAndPriceRepair = evaluateRoLines(
  mapped.map((job) => job.title || ""),
  planItems,
);
ok(
  "status and pricing changes do not alter missed-item matching",
  JSON.stringify(beforeStatusAndPriceRepair) === JSON.stringify(afterStatusAndPriceRepair),
);
const reportRow = (ticketJobs: MissedOpportunityRo["ticketJobs"]): MissedOpportunityRo => ({
  workOrderId: "wo-normalized",
  workOrderNumber: "709007288",
  closedDate: invoice.InvoiceTime,
  vin: invoice.ServiceItem.VIN,
  vehicle: "2013 Chevrolet Captiva Sport",
  advisorName: null,
  lineTitleCount: ticketTitles.length,
  ticketJobs,
  evaluated: true,
  skipReason: null,
  missedItems: afterStatusAndPriceRepair,
});
const beforeSummary = summarizeMissedOpportunities([
  reportRow(
    mapped.map((job) => ({
      title: job.title || "",
      recordedStatus: "completed",
      displayGroup: "approved_performed",
      totalPrice: "0.00",
    })),
  ),
]);
const afterSummary = summarizeMissedOpportunities([
  reportRow(
    mapped.map((job) => ({
      title: job.title || "",
      recordedStatus: job.status || null,
      displayGroup:
        job.status === "deferred" || job.status === "declined"
          ? "deferred_declined"
          : "approved_performed",
      totalPrice: Number(job.total || 0).toFixed(2),
    })),
  ),
]);
ok(
  "ticket status/price repair leaves report summary counts unchanged",
  JSON.stringify(beforeSummary) === JSON.stringify(afterSummary),
);
ok(
  "report classifier consumes corrected deferred status",
  classifyTicketJobStatus(mappedById.get("oil-change")?.status) === "deferred_declined",
);
ok(
  "report amount normalizer consumes corrected package total",
  normalizeTicketJobAmount(mappedById.get("oil-change")?.total) === "99.95",
);

async function runRepairSafetyChecks() {
  console.log("Repair safety contract:");
  const dryArgs = parseRepairArgs(["--shop=235", "--ro=709007288", "--limit=10"]);
  const liveArgs = parseRepairArgs(["--shop=235", "--ro=709007288", "--limit=10", "--confirm"]);
  ok("repair requires explicit confirmation for live mode", !dryArgs.confirm && liveArgs.confirm);
  ok(
    "dry and live checkpoints are separate",
    getRepairCheckpointKey(dryArgs) !== getRepairCheckpointKey(liveArgs),
  );
  const repairFilter = JSON.stringify(buildRepairFilter(dryArgs, "cached-id-1"));
  ok(
    "repair filter is bounded to provider, shop, RO, and resume cursor",
    repairFilter.includes("protractor") &&
      repairFilter.includes("235") &&
      repairFilter.includes("709007288") &&
      repairFilter.includes("cached-id-1"),
  );
  let replayParentId = "";
  const fakeService = {
    async ingestWorkOrder() {
      return {
        success: true,
        action: "updated" as const,
        entityId: "canonical-parent-id",
        entityType: "work_order",
      };
    },
    async replayServiceJobsAndLineItemsFromRawPayload(parentId: string) {
      replayParentId = parentId;
      return { serviceJobs: [], lineItems: [] };
    },
  };
  await replayCachedWorkOrder(fakeService, invoice);
  ok("repair replays children under canonical parent ID", replayParentId === "canonical-parent-id");
  let replayFailureStopped = false;
  try {
    await replayCachedWorkOrder(
      {
        async ingestWorkOrder() {
          return {
            success: true,
            action: "updated" as const,
            entityId: "canonical-parent-id",
            entityType: "work_order",
          };
        },
        async replayServiceJobsAndLineItemsFromRawPayload() {
          return {
            serviceJobs: [
              {
                success: false,
                action: "error" as const,
                entityType: "service_job",
                message: "injected",
              },
            ],
            lineItems: [],
          };
        },
      },
      invoice,
    );
  } catch {
    replayFailureStopped = true;
  }
  ok("repair stops when an injected child replay fails", replayFailureStopped);
}

runRepairSafetyChecks()
  .then(() => {
    if (failed > 0) {
      console.error(`\n${failed} check(s) failed`);
      process.exit(1);
    }
    console.log("\nProtractor ticket-details regression passed.");
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });