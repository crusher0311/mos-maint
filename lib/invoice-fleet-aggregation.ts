import { INVOICE_HOURS_SQL, INVOICE_HOURS_MAX_ORDERS, INVOICE_VERIFIED_PREDICATE } from "./invoice-hours-query";
import { combineInvoiceLocationDiagnostics } from "./invoice-hours-contract";
import type { ReportingMetricValues } from "./reporting-kpi-contract";
import { COMMON_UNINVOICED_STATUSES, PROTRACTOR_UNINVOICED_STATUSES } from "./invoice-status-policy";

const statuses=(values:string[])=>values.map(value=>`'${value}'`).join(",");
const sentinel=`LIMIT ${INVOICE_HOURS_MAX_ORDERS+1}`;
if(INVOICE_HOURS_SQL.split(sentinel).length!==3)throw Error("Invoice closure changed; review fleet aggregation");
const closure=INVOICE_HOURS_SQL.replaceAll(sentinel,"");
const valid=INVOICE_VERIFIED_PREDICATE
  .replaceAll("wo.custom_fields->'invoiceHours'","f.invoice_evidence")
  .replaceAll("wo.provenance->'sourceIds'","f.source_ids")
  .replaceAll("wo.provenance->>'sourceSystem'","f.provider");

/** Only execute inside the resource-limited, globally admitted transaction. */
export const INVOICE_FLEET_SQL=`
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
  SELECT coalesce(bool_or(invoice_evidence IS NOT NULL AND invoice_evidence<>'null'::jsonb
    AND (NOT verified OR
      coalesce(jsonb_typeof(invoice_evidence->'sold'),'missing') NOT IN ('number','null') OR
      coalesce(jsonb_typeof(invoice_evidence->'presented'),'missing') NOT IN ('number','null'))),false) unsupported
  FROM facts
),
invoices AS MATERIALIZED (
  SELECT shop_id,provider||':'||lower(invoice_evidence->>'id') identity,
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
  SELECT shop_id,identity,count(DISTINCT ids)>1 ambiguous,min(ids::text)::text[] ids
  FROM unknown_rows GROUP BY shop_id,identity
),
unknown_aliases AS MATERIALIZED (
  -- Expand before joining: otherwise PostgreSQL can join every invoice in a
  -- shop to every unknown group, then apply the alias filter (quadratic work).
  SELECT u.shop_id,u.identity,unnest(u.ids) alias FROM unknown_groups u
),
resolved_unknowns AS (
  SELECT DISTINCT u.shop_id,u.identity
  FROM unknown_aliases u
  JOIN invoices i ON i.shop_id=u.shop_id AND i.identity=u.alias
),
unknown_totals AS (
  SELECT u.shop_id,count(*) FILTER (WHERE r.identity IS NULL) unknown
  FROM unknown_groups u LEFT JOIN resolved_unknowns r USING(shop_id,identity)
  GROUP BY u.shop_id
),
totals AS (
  SELECT shop_id,count(*) FILTER (WHERE conflict) conflicts,
    count(*) FILTER (WHERE NOT conflict AND date >= $2 AND date <= $3) eligible,
    coalesce(sum(sold) FILTER (WHERE NOT conflict AND date >= $2 AND date <= $3 AND sold>=0),0) sold,
    coalesce(sum(presented) FILTER (WHERE NOT conflict AND date >= $2 AND date <= $3 AND presented>=0),0) presented,
    count(*) FILTER (WHERE NOT conflict AND date >= $2 AND date <= $3 AND sold>=0) sold_covered,
    count(*) FILTER (WHERE NOT conflict AND date >= $2 AND date <= $3 AND presented>=0) presented_covered
  FROM invoices GROUP BY shop_id
)
SELECT s.shop_id,(g.unsupported OR EXISTS(SELECT 1 FROM unknown_groups WHERE ambiguous)) unsupported,
  coalesce(t.eligible,0) eligible,coalesce(u.unknown,0)+coalesce(t.conflicts,0) unknown,
  coalesce(t.sold,0) sold,coalesce(t.presented,0) presented,
  coalesce(t.sold_covered,0) sold_covered,coalesce(t.presented_covered,0) presented_covered
FROM unnest($1::int[]) s(shop_id)
CROSS JOIN guards g LEFT JOIN totals t USING(shop_id) LEFT JOIN unknown_totals u USING(shop_id)
`;

export function invoiceFleetParams(authorized:number[],requested:number[],start:Date,end:Date){
  if(!requested.length||requested.length>200||new Set(requested).size!==requested.length||
    requested.some(id=>!Number.isSafeInteger(id)||id<=0||!authorized.includes(id))||
    !Number.isFinite(+start)||!Number.isFinite(+end)||start>end)
    throw Error("Select between 1 and 200 authorized locations for invoice reporting.");
  return [`{${requested.join(",")}}`,start.toISOString(),end.toISOString()];
}

export function invoiceFleetResult(ids:number[],rows:Record<string,any>[]){
  if(rows.length!==ids.length||new Set(rows.map(r=>Number(r.shop_id))).size!==ids.length||
    rows.some(r=>!ids.includes(Number(r.shop_id))))throw Error("Incomplete invoice aggregation result.");
  const locations=new Map<number,Partial<ReportingMetricValues>>();
  for(const r of rows){
    if(r.unsupported!==false)throw Error("Stored invoice evidence is ambiguous or unsupported. No invoice totals were published; source evidence needs review.");
    const n=(key:string,integer=false)=>{
      const v=Number(r[key]);
      if(r[key]==null||!Number.isFinite(v)||v<0||(integer&&!Number.isSafeInteger(v)))
        throw Error("Invalid invoice aggregation total.");
      return v;
    };
    const count=n("eligible",true),unknown=n("unknown",true),sold=n("sold"),presented=n("presented"),
      soldCovered=n("sold_covered",true),presentedCovered=n("presented_covered",true);
    if(soldCovered>count||presentedCovered>count)throw Error("Invalid invoice aggregation coverage.");
    locations.set(Number(r.shop_id),{
      invoiceEvidenceCapped:0,invoiceCount:count,invoicePopulationUnknown:unknown,
      invoiceSoldHours:sold,invoicePresentedHours:presented,invoiceSoldCovered:soldCovered,
      invoicePresentedCovered:presentedCovered,
      averageSoldHoursPerInvoice:!unknown&&count>0&&soldCovered===count?sold/count:null,
      averagePresentedHoursPerInvoice:!unknown&&count>0&&presentedCovered===count?presented/count:null,
    });
  }
  return {summary:combineInvoiceLocationDiagnostics(ids,locations),locations};
}
