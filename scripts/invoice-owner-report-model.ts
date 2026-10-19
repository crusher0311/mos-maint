/** Shared offline computation. No credentials, source-store access, or repair writes. */
import assert from "node:assert/strict";
import type {Sql} from "postgres";
import {reconcileStored} from "./invoice-stored-evidence";
import {INVOICE_HOURS_SQL} from "../lib/invoice-hours-query";
import {aggregateInvoiceHours,type InvoiceHoursFact} from "../lib/invoice-hours-contract";
import type {ReportingMetricValues} from "../lib/reporting-kpi-contract";

export function reconcileOwnerCopies(ownerId:string, payloads:any[]) {
  const bound=payloads.filter(r=>String(r.ID??"").toLowerCase()===ownerId);
  assert.ok(bound.length>0,"Missing owner payload");
  return reconcileStored([ownerId],bound,[]);
}

export async function queryOwnerReport(local:Sql, table:"normalized_work_orders"|"proposed_work_orders",
  shops:number[], start:string, end:string) {
  assert.ok(["normalized_work_orders","proposed_work_orders"].includes(table));
  const rows=await local.unsafe<InvoiceHoursFact[]>(INVOICE_HOURS_SQL.replaceAll("normalized_work_orders",table),
    [`{${shops.join(",")}}`,start,end]);
  return {rows,...aggregateInvoiceHours(rows,new Date(start),new Date(end))};
}

export function assertOwnerFinancialControl(summary:Partial<ReportingMetricValues>, expected:{invoices:number;sold:number;presented:number}) {
  assert.equal(summary.invoiceCount,expected.invoices);
  assert.equal(summary.invoiceSoldCovered,expected.invoices);
  assert.equal(summary.invoicePresentedCovered,expected.invoices);
  assert.ok(summary.invoiceSoldHours!=null&&summary.invoicePresentedHours!=null);
  assert.ok(Math.abs(summary.invoiceSoldHours-expected.sold)<0.000001);
  assert.ok(Math.abs(summary.invoicePresentedHours-expected.presented)<0.000001);
}
