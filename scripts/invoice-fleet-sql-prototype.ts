/**
 * Offline-only feasibility prototype. Not imported by the live reporting path.
 * Callers must apply the transaction resource settings documented alongside it.
 */
import { INVOICE_HOURS_SQL, INVOICE_HOURS_MAX_ORDERS, INVOICE_VERIFIED_PREDICATE } from "../lib/invoice-hours-query";
import { cappedInvoiceHours, combineInvoiceLocationDiagnostics } from "../lib/invoice-hours-contract";
import type { ReportingMetricValues } from "../lib/reporting-kpi-contract";
import { COMMON_UNINVOICED_STATUSES, PROTRACTOR_UNINVOICED_STATUSES } from "../lib/invoice-status-policy";

const statuses=(values:string[])=>values.map(value=>`'${value}'`).join(",");

const sentinel = `LIMIT ${INVOICE_HOURS_MAX_ORDERS + 1}`;
if (INVOICE_HOURS_SQL.split(sentinel).length !== 3) throw Error("Invoice closure changed; review prototype");
// Reuse exactly the existing candidate/peer selection, without transmitting its
// representations to Node. This does NOT modify the production query or limit.
const closure = INVOICE_HOURS_SQL.replaceAll(sentinel, "");
const valid = INVOICE_VERIFIED_PREDICATE
  .replaceAll("wo.custom_fields->'invoiceHours'", "f.invoice_evidence")
  .replaceAll("wo.provenance->'sourceIds'", "f.source_ids")
  .replaceAll("wo.provenance->>'sourceSystem'", "f.provider");

export const INVOICE_FLEET_PROTOTYPE_SQL = `
WITH closure AS NOT MATERIALIZED (${closure}),
facts AS MATERIALIZED (
  SELECT f.id,f.shop_id,f.status,f.provider,f.invoice_evidence,
    coalesce((${valid}) AND invoice_evidence->'version'='1'::jsonb,false) verified,
    ARRAY(SELECT coalesce(f.provider,'null')||':'||lower(s->>'idValue')
      FROM jsonb_array_elements(coalesce(f.source_ids,'[]'::jsonb)) WITH ORDINALITY a(s,n)
      WHERE s->>'system'=f.provider AND s->>'idType' IN ('invoice_id','work_order_id')
      ORDER BY n) ids
  FROM closure f
),
guards AS (
  -- This prototype only accepts canonical numeric/null hour evidence. Reject
  -- noncanonical evidence rather than pretending it is a known empty invoice.
  SELECT coalesce(bool_or(invoice_evidence IS NOT NULL AND invoice_evidence<>'null'::jsonb
    AND (NOT verified OR
      coalesce(jsonb_typeof(invoice_evidence->'sold'),'missing') NOT IN ('number','null') OR
      coalesce(jsonb_typeof(invoice_evidence->'presented'),'missing') NOT IN ('number','null'))),false) unsupported
  FROM facts
),
invoices AS MATERIALIZED (
  SELECT shop_id, provider||':'||lower(invoice_evidence->>'id') identity,
    min(invoice_evidence->>'date') date,
    count(DISTINCT invoice_evidence->>'date')>1 conflict,
    CASE WHEN count(invoice_evidence->>'sold')=count(*)
      AND count(DISTINCT invoice_evidence->>'sold')=1
      THEN min((invoice_evidence->>'sold')::double precision) END sold,
    CASE WHEN count(invoice_evidence->>'presented')=count(*)
      AND count(DISTINCT invoice_evidence->>'presented')=1
      THEN min((invoice_evidence->>'presented')::double precision) END presented
  FROM facts WHERE verified GROUP BY shop_id,provider,lower(invoice_evidence->>'id')
),
unknown_rows AS (
  SELECT shop_id,coalesce(ids[1],coalesce(provider,'null')||':row:'||id) identity,ids
  FROM facts WHERE NOT verified
    AND status NOT IN (${statuses(COMMON_UNINVOICED_STATUSES)},'voided','cancelled')
    AND NOT (coalesce(provider,'')='protractor' AND status IN (${statuses(PROTRACTOR_UNINVOICED_STATUSES)}))
),
unknown_groups AS (
  SELECT shop_id,identity,count(DISTINCT ids)>1 ambiguous,
    min(ids::text)::text[] ids
  FROM unknown_rows GROUP BY shop_id,identity
),
unknown_totals AS (
  SELECT u.shop_id,count(*) FILTER (WHERE NOT EXISTS (
    SELECT 1 FROM invoices i WHERE i.shop_id=u.shop_id AND i.identity=ANY(u.ids))) unknown
  FROM unknown_groups u GROUP BY u.shop_id
),
totals AS (
  SELECT shop_id,
    count(*) FILTER (WHERE conflict) conflicts,
    count(*) FILTER (WHERE NOT conflict AND date >= $2 AND date <= $3) eligible,
    coalesce(sum(sold) FILTER (WHERE NOT conflict AND date >= $2 AND date <= $3 AND sold>=0),0) sold,
    coalesce(sum(presented) FILTER (WHERE NOT conflict AND date >= $2 AND date <= $3 AND presented>=0),0) presented,
    count(*) FILTER (WHERE NOT conflict AND date >= $2 AND date <= $3 AND sold>=0) sold_covered,
    count(*) FILTER (WHERE NOT conflict AND date >= $2 AND date <= $3 AND presented>=0) presented_covered
  FROM invoices GROUP BY shop_id
)
SELECT s.shop_id,
  (g.unsupported OR EXISTS(SELECT 1 FROM unknown_groups WHERE ambiguous)) unsupported,
  coalesce(t.eligible,0) eligible,
  coalesce(u.unknown,0)+coalesce(t.conflicts,0) unknown,
  coalesce(t.sold,0) sold,coalesce(t.presented,0) presented,
  coalesce(t.sold_covered,0) sold_covered,coalesce(t.presented_covered,0) presented_covered
FROM unnest($1::int[]) s(shop_id)
CROSS JOIN guards g
LEFT JOIN totals t USING(shop_id)
LEFT JOIN unknown_totals u USING(shop_id)
`;

export function invoiceFleetPrototypeParams(authorized: number[], requested: number[], start: Date, end: Date) {
  if (!requested.length || requested.length>200 || new Set(requested).size!==requested.length ||
      requested.some(id=>!Number.isSafeInteger(id)||id<=0||!authorized.includes(id)) ||
      !Number.isFinite(+start)||!Number.isFinite(+end)||start>end)
    throw Error("Invalid or unauthorized invoice prototype scope");
  return [`{${requested.join(",")}}`,start.toISOString(),end.toISOString()];
}

export function invoiceFleetPrototypeResult(ids: number[], rows: Record<string, any>[]) {
  if(rows.length!==ids.length || new Set(rows.map(r=>Number(r.shop_id))).size!==ids.length ||
    rows.some(r=>!ids.includes(Number(r.shop_id)))) throw Error("Incomplete invoice prototype result");
  const locations=new Map<number,Partial<ReportingMetricValues>>();
  for(const r of rows){
    if(r.unsupported){locations.set(Number(r.shop_id),cappedInvoiceHours());continue;}
    const n=(key:string)=>{
      const v=Number(r[key]);if(r[key]==null||!Number.isFinite(v)||v<0)throw Error("Invalid invoice total");return v;
    };
    const count=n("eligible"),unknown=n("unknown"),sold=n("sold"),presented=n("presented"),
      soldCovered=n("sold_covered"),presentedCovered=n("presented_covered");
    locations.set(Number(r.shop_id),{
      invoiceEvidenceCapped:0,invoiceCount:count,invoicePopulationUnknown:unknown,
      invoiceSoldHours:sold,invoicePresentedHours:presented,
      invoiceSoldCovered:soldCovered,invoicePresentedCovered:presentedCovered,
      averageSoldHoursPerInvoice:!unknown&&count>0&&soldCovered===count?sold/count:null,
      averagePresentedHoursPerInvoice:!unknown&&count>0&&presentedCovered===count?presented/count:null,
    });
  }
  return {summary:combineInvoiceLocationDiagnostics(ids,locations),locations};
}
