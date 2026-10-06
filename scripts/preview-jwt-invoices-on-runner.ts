/**
 * Run only inside the existing, approved deployment with its own configuration.
 * One GET, no retries, no ingestion/cache writes, no environment overrides.
 * Normal admission/audit accounting remains owned by the shared client.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

async function main() {
  const root = process.cwd();
  if (!existsSync(resolve(root, "lib/integrations/protractor/relay-transport.ts"))) {
    throw new Error("Current relay adapter is not present");
  }
  const load = (path: string) => import(pathToFileURL(resolve(root, path)).href);
  const { readProtractorRelayConfig } = await load("lib/integrations/protractor/relay-config.ts");
  if (readProtractorRelayConfig().mode !== "relay") {
    throw new Error("Approved relay-only configuration is not active");
  }
  const client = await load("lib/integrations/protractor/client.ts");
  const policy = client.getProtractorOutboundPolicy();
  if (!policy.allowed || policy.callbackOnly || policy.requireTimedTrial) {
    console.log(JSON.stringify({ event: "jwt_invoice_preview", outcome: "blocked",
      reason: !policy.allowed ? (policy.reason || "outbound_denied") :
        policy.callbackOnly ? "callback_only_policy" : "timed_trial_policy",
      callbackOnly: Boolean(policy.callbackOnly), requireTimedTrial: Boolean(policy.requireTimedTrial) }));
    return;
  }
  const config = await client.resolveProtractorConfig(227);
  if (!config.configured || config.shopId !== 227) {
    throw new Error("Exact shop configuration unavailable");
  }
  // Initial representative day only. Do not broaden or paginate automatically.
  const result = await client.protractorFetch(
    "/Invoice/?startDate=2026-09-01&endDate=2026-09-02&take=25&skip=0",
    config, { method: "GET" }, 0, 227, { priority: false, maxRetries: 0 },
  );
  if (!result.ok) {
    // Provider error strings can contain response bodies; never print them.
    console.log(JSON.stringify({ event: "jwt_invoice_preview", outcome: "not_read",
      reason: "Shared adapter rejected or failed the bounded GET; inspect sanitized admission logs" }));
    return;
  }
  const invoices = result.data?.ItemCollection;
  if (!Array.isArray(invoices) || invoices.length > 25) {
    throw new Error("Unexpected or oversized invoice-list result");
  }
  console.log(JSON.stringify({
    event: "jwt_invoice_preview", outcome: "read", shopId: 227,
    pageRows: invoices.length, possiblyTruncated: invoices.length === 25,
    invoices: invoices.map((invoice: any) => ({
      workOrderNumber: /^\d+$/.test(String(invoice.WorkOrderNumber)) ? String(invoice.WorkOrderNumber) : null,
      invoiceNumber: /^\d+$/.test(String(invoice.InvoiceNumber)) ? String(invoice.InvoiceNumber) : null,
      invoiceDate: /^\d{4}-\d{2}-\d{2}/.test(String(invoice.InvoiceTime)) ? String(invoice.InvoiceTime).slice(0,10) : null,
      type: ["Invoice","CreditInvoice","WorkOrder","Appointment"].includes(invoice.Type) ? invoice.Type : "other",
    })),
  }));
}

const timer = setTimeout(() => process.exit(2), 90000);
main().then(() => { clearTimeout(timer); process.exit(0); }).catch(() => {
  clearTimeout(timer);
  console.error(JSON.stringify({ event: "jwt_invoice_preview", outcome: "blocked",
    reason: "Runner preflight or execution failed; no repair attempted" }));
  process.exit(1);
});
