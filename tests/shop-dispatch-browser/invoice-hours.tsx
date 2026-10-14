import React from "react";
import { createRoot } from "react-dom/client";
import ReportingPage from "../../app/dashboard/reporting/page";
import { REPORTING_KPI_CATALOG } from "../../lib/reporting-kpi-contract";
import "../../generated-artifacts/invoice-hours-fixture.css";

const state = { requests: [] as any[], pending: false, fail: false, polls: 0 };
const populationFixtures = fetch(new URL("../../generated-artifacts/invoice-population.json", import.meta.url)).then(response => response.json());
(window as any).invoiceFixture = state;
const makeRow = (key: string, label: string, count: number, presented: number, sold: number) => ({
  key, shopId: Number(key), label, comparison: null, delta: null, deltaPercent: null,
  current: { invoiceCount: count, invoicePopulationUnknown: 0, invoicePresentedHours: presented,
    invoiceSoldHours: sold, invoicePresentedCovered: count, invoiceSoldCovered: count,
    averagePresentedHoursPerInvoice: count ? presented / count : null, averageSoldHoursPerInvoice: count ? sold / count : null },
});
async function result(request: any) {
  let rows = [makeRow("1", "Fictional Central", 90, 180, 90), makeRow("2", "Fictional North", 10, 120, 110)];
  if (request.definition.dateRange.start === "2026-08-01") {
    rows[0].current.averagePresentedHoursPerInvoice = null as any;
    rows[0].current.invoicePresentedCovered = 80;
  }
  if (request.definition.dateRange.start === "2026-07-01") {
    rows[0].current.invoicePopulationUnknown = 3;
    rows[0].current.averagePresentedHoursPerInvoice = null as any;
    rows[0].current.averageSoldHoursPerInvoice = null as any;
  }
  if (request.definition.dateRange.start === "2026-06-01") rows = [makeRow("1", "Fictional Central", 0, 0, 0)];
  const population = new URLSearchParams(window.location.search).get("population");
  if (population) {
    const values = (await populationFixtures)[population];
    rows = [{ ...makeRow("1", "Fictional Central", 0, 0, 0), current: values as any }];
  }
  const filter = request.definition.filters?.[0];
  if (filter) rows = rows.filter(row => row.key === filter.value);
  return { ok: true, version: 1, definitionId: request.definition.id, generatedAt: "2026-10-14T12:00:00Z", rows,
    metadata: { executedRange: request.definition.dateRange, executedScope: { kind: request.scope.kind, shopIds: [1,2] },
      definitionName: request.definition.name, selectedFilters: request.definition.filters, dimension: "location",
      metrics: REPORTING_KPI_CATALOG.filter(m => request.definition.metrics.includes(m.key)),
      comparison: { mode: "none" }, presentation: request.definition.presentation, bounds: { shops: 2 },
      coverage: {}, dataQuality: { notes: [] }, truncated: false, source: "reporting-kpi-service" } };
}
window.fetch = async (input, init) => {
  const url = String(input);
  let body: any = {};
  if (url === "/api/auth/me") body = { role: "owner", shopId: 1, enterpriseId: "fictional" };
  else if (url.startsWith("/api/reports/locations?")) body = { locations: [
    { key: "1", label: "Fictional Central" }, { key: "2", label: "Fictional North" },
  ] };
  else if (url.startsWith("/api/reports/custom?")) body = { reports: [] };
  else if (url.startsWith("/api/reports/subscriptions")) body = { subscriptions: [] };
  else if (url === "/api/reports/runs") {
    const request = JSON.parse(String(init?.body));
    state.requests.push(request);
    body = { runId: `run-${state.requests.length}`, status: state.pending ? "queued" : "succeeded", result: state.pending ? undefined : await result(request) };
  } else if (url.startsWith("/api/reports/runs/")) {
    state.polls++;
    const request = state.requests[Number(url.split("-").pop()) - 1];
    // Simulate a slow response to exercise unmount/scope isolation.
    await new Promise(resolve => setTimeout(resolve, 250));
    body = { runId: url.split("/").pop(), status: state.fail ? "failed" : "succeeded",
      result: state.fail ? undefined : await result(request) };
  } else throw new Error(`Unexpected fixture request ${url}`);
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
};
createRoot(document.getElementById("root")!).render(<ReportingPage />);
