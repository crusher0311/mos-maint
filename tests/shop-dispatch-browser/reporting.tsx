import React from "react";
import { createRoot } from "react-dom/client";
import { CustomReportBuilder } from "../../app/dashboard/reporting/custom-report-builder";
import { safeReportFailure } from "../../lib/report-run-failure";
import "../../artifacts/detect-dog-workflow/src/index.css";

const definition = {
  version: 1, id: "fixture", name: "Hours Presented",
  dateRange: { start: "2026-09-15", end: "2026-10-14" },
  metrics: ["billedRevenue", "opportunityConversionRate", "declinedDeferredDollars", "soldLaborHours", "presentedLaborHours", "laborPartsMix"],
  dimensions: ["none"], comparison: { mode: "previousPeriod" }, presentation: { kind: "scorecard" },
};
const saved = ["first", "second"].map(id => ({ id, name: id === "first" ? "Hours Presented" : "Another report", currentVersion: 2, definition, sharing: { visibility: "private" } }));
let active = false;
// All data is fictional and all API calls stay in this in-browser fixture.
window.fetch = async (input, init) => {
  const url = String(input);
  let body: any = {};
  if (url.startsWith("/api/reports/custom/first")) body = { report: { versions: [{ version: 1, definition: { ...definition, name: "Pinned Hours Presented" } }] } };
  else if (url.startsWith("/api/reports/custom?")) body = { reports: saved };
  else if (url === "/api/reports/runs") {
    const request = JSON.parse(String(init?.body));
    if (request.lookupOnly && request.reportId === "second") body = { status: "idle" };
    else {
      active = !request.lookupOnly;
      body = { runId: "fixture-run", status: active ? "queued" : "failed", stage: active ? "queued" : "failed",
        ...(!active ? { error: safeReportFailure({ kind: "query", stage: "business" }, "fixture-run-1") } : {}) };
    }
  } else if (url === "/api/reports/runs/fixture-run") {
    body = { runId: "fixture-run", status: "failed", stage: "business", error: safeReportFailure({ kind: "schema", stage: "business" }, "fixture-run-2") };
  } else throw new Error(`Unexpected fixture request: ${url}`);
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
};
createRoot(document.getElementById("root")!).render(<main style={{ padding: 24, fontFamily: "sans-serif" }}>
  <h1>Performance reporting — isolated verification</h1>
  <CustomReportBuilder scope={{ kind: "enterprise", enterpriseId: "fixture" }} initialReportId="first" initialReportVersion={1} />
</main>);
