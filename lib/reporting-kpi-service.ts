import { getClient } from "@/lib/db/drizzle";
import {
  REPORTING_DIMENSION_LIMIT,
  REPORTING_KPI_CATALOG,
  REPORTING_KPI_VERSION,
  REPORTING_MAX_RANGE_DAYS,
  UNKNOWN_DIMENSION_KEY,
  finalizeMetrics,
  type ReportingAvailability,
  type ReportingGroup,
  type ReportingKpiResponse,
  type ReportingMetricValues,
} from "@/lib/reporting-kpi-contract";
import type { ResolvedReportingScope } from "@/lib/reporting-scope";

type Row = Record<string, any>;

export function normalizeReportingRange(startRaw?: string | null, endRaw?: string | null) {
  const end = endRaw ? new Date(endRaw) : new Date();
  const start = startRaw ? new Date(startRaw) : new Date(end.getTime() - 29 * 86400000);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) throw new Error("Invalid date range");
  end.setUTCHours(23, 59, 59, 999);
  start.setUTCHours(0, 0, 0, 0);
  const days = Math.floor((end.getTime() - start.getTime()) / 86400000) + 1;
  if (days < 1 || days > REPORTING_MAX_RANGE_DAYS) {
    throw new Error(`Date range must be between 1 and ${REPORTING_MAX_RANGE_DAYS} days`);
  }
  return { start, end, days };
}

const availability = (row?: Row): ReportingAvailability => ({
  business: Boolean(row?.business_available),
  payments: Boolean(row?.payments_available),
  staff: Boolean(row?.staff_available),
  laborParts: Boolean(row?.mix_available),
  planViews: Boolean(row?.plan_views_available),
  recommendationEvents: Boolean(row?.rec_events_available),
});

function metrics(row: Row = {}): ReportingMetricValues {
  const hasPlanViews = Boolean(row.plan_views_available);
  const hasRecommendationEvents = Boolean(row.rec_events_available);
  return finalizeMetrics({
    repairOrderCount: Number(row.ro_count || 0),
    billedRevenue: row.billed_revenue == null ? null : Number(row.billed_revenue),
    declinedDeferredDollars: row.declined_dollars == null ? null : Number(row.declined_dollars),
    soldOpportunityCount: row.sold_opps == null ? null : Number(row.sold_opps),
    missedOpportunityCount: row.missed_opps == null ? null : Number(row.missed_opps),
    laborRevenue: row.labor_revenue == null ? null : Number(row.labor_revenue),
    partsRevenue: row.parts_revenue == null ? null : Number(row.parts_revenue),
    plansViewed: !hasPlanViews || row.plans_viewed == null ? null : Number(row.plans_viewed),
    recommendationsAdded: !hasRecommendationEvents || row.rec_added == null ? null : Number(row.rec_added),
    recommendationsSold: !hasRecommendationEvents || row.rec_sold == null ? null : Number(row.rec_sold),
    attributedRevenue: !hasRecommendationEvents || row.attributed_revenue == null ? null : Number(row.attributed_revenue),
  });
}

function group(row: Row, label?: string): ReportingGroup {
  return {
    key: String(row.dimension_key ?? UNKNOWN_DIMENSION_KEY),
    label: label || String(row.dimension_label || "Unknown / unmapped"),
    ...(row.shop_id != null ? { shopId: Number(row.shop_id) } : {}),
    metrics: metrics(row),
    availability: availability(row),
  };
}

const money = (alias: string, column: string) =>
  `CASE WHEN lower(coalesce(${alias}.provenance->>'sourceSystem','')) = 'tekmetric' THEN ${alias}.${column}::numeric / 100 ELSE ${alias}.${column}::numeric END`;

export async function getReportingKpis(
  scope: ResolvedReportingScope,
  range: ReturnType<typeof normalizeReportingRange>,
  options?: { query?: (text: string, params: unknown[]) => Promise<Row[]> },
): Promise<ReportingKpiResponse> {
  const query =
    options?.query ||
    ((text: string, params: unknown[]) =>
      getClient().unsafe(text, params as any[]) as Promise<Row[]>);
  const ids = `{${scope.shopIds.join(",")}}`;
  const woMoney = money("wo", "grand_total");
  const woLabor = money("wo", "labor_total");
  const woParts = money("wo", "parts_total");
  // Service-job and payment values are normalized dollars for every provider.
  // Only Tekmetric work-order rollups retain their source cents representation.
  const jobMoney = "sj.total::numeric";
  const base = `
    WITH refunds AS MATERIALIZED (
      SELECT work_order_id, count(*) payment_rows,
        sum(CASE WHEN status IN ('refunded','partially_refunded','chargeback') THEN coalesce(refunded_amount, amount, 0) ELSE coalesce(refunded_amount,0) END)::numeric refunded
      FROM normalized_payments
      WHERE shop_id = ANY($1::int[]) AND coalesce((soft_delete->>'isDeleted')::boolean,false)=false
      GROUP BY work_order_id
    ), jobs AS MATERIALIZED (
      SELECT work_order_id, count(*) staff_rows,
        sum(CASE WHEN status IN ('declined','deferred') THEN ${jobMoney} ELSE 0 END)::numeric declined_dollars,
        count(*) FILTER (WHERE recommendation_id IS NOT NULL AND status IN ('authorized','completed')) sold_opps,
        count(*) FILTER (WHERE recommendation_id IS NOT NULL AND status IN ('declined','deferred')) missed_opps
      FROM normalized_service_jobs sj WHERE shop_id = ANY($1::int[]) AND coalesce((soft_delete->>'isDeleted')::boolean,false)=false GROUP BY work_order_id
    ), facts AS MATERIALIZED (
      SELECT wo.*, coalesce(r.refunded,0) refunded, coalesce(r.payment_rows,0) payment_rows,
        j.declined_dollars, j.sold_opps, j.missed_opps, j.staff_rows,
        ${woMoney} - coalesce(r.refunded,0) billed, ${woLabor} labor, ${woParts} parts,
        coalesce(wo.closed_date,wo.completed_date) basis_date
      FROM normalized_work_orders wo LEFT JOIN refunds r ON r.work_order_id=wo.id LEFT JOIN jobs j ON j.work_order_id=wo.id
      WHERE wo.shop_id=ANY($1::int[]) AND coalesce((wo.soft_delete->>'isDeleted')::boolean,false)=false
        AND wo.status <> 'voided' AND coalesce(wo.closed_date,wo.completed_date) BETWEEN $2 AND $3
    ), coverage_by_shop AS (
      SELECT scope.shop_id,
        EXISTS(SELECT 1 FROM normalized_work_orders x WHERE x.shop_id=scope.shop_id) business_available,
        EXISTS(SELECT 1 FROM normalized_payments x WHERE x.shop_id=scope.shop_id AND coalesce((x.soft_delete->>'isDeleted')::boolean,false)=false) payments_available,
        EXISTS(SELECT 1 FROM normalized_service_jobs x WHERE x.shop_id=scope.shop_id AND coalesce((x.soft_delete->>'isDeleted')::boolean,false)=false) staff_available,
        EXISTS(SELECT 1 FROM normalized_work_orders x WHERE x.shop_id=scope.shop_id AND (x.labor_total<>0 OR x.parts_total<>0)) mix_available
      FROM unnest($1::int[]) scope(shop_id)
    ), coverage AS (
      SELECT
        bool_or(business_available) business_available,
        bool_or(payments_available) payments_available,
        bool_or(staff_available) staff_available,
        bool_or(mix_available) mix_available
      FROM coverage_by_shop
    )`;
  const aggregate = `count(*)::int ro_count, sum(billed)::float8 billed_revenue,
    sum(declined_dollars)::float8 declined_dollars, sum(sold_opps)::int sold_opps, sum(missed_opps)::int missed_opps,
    sum(labor)::float8 labor_revenue, sum(parts)::float8 parts_revenue,
    sum(payment_rows)::int payment_rows, sum(staff_rows)::int staff_rows,
    count(*) FILTER (WHERE labor<>0 OR parts<>0)::int mix_rows`;

  const [businessRows, technicianRows, usageRows] = await Promise.all([
    query(`${base}, dimension_facts AS (
      SELECT facts.*,
        coalesce(
          nullif(service_advisor_id,''),
          CASE WHEN nullif(service_advisor_name,'') IS NOT NULL THEN 'name:' || lower(service_advisor_name) END,
          '${UNKNOWN_DIMENSION_KEY}'
        ) advisor_key
      FROM facts
    ), grouped AS (
      SELECT CASE
          WHEN grouping(advisor_key)=0 THEN 'advisor'
          WHEN grouping(shop_id)=0 THEN 'location'
          WHEN grouping(basis_date)=0 THEN 'date'
          ELSE 'summary' END dimension_type,
        shop_id,
        CASE
          WHEN grouping(advisor_key)=0 THEN shop_id::text || ':' || advisor_key
          WHEN grouping(shop_id)=0 THEN shop_id::text
          WHEN grouping(basis_date)=0 THEN to_char(basis_date,'YYYY-MM-DD')
          ELSE 'summary' END dimension_key,
        CASE
          WHEN grouping(advisor_key)=0 THEN coalesce(
            (array_agg(nullif(service_advisor_name,'') ORDER BY basis_date DESC)
              FILTER (WHERE nullif(service_advisor_name,'') IS NOT NULL))[1],
            'Unknown / unmapped')
          WHEN grouping(basis_date)=0 THEN to_char(basis_date,'YYYY-MM-DD')
          ELSE NULL END dimension_label,
        ${aggregate}
      FROM dimension_facts
      GROUP BY GROUPING SETS ((), (shop_id), (shop_id,advisor_key), (basis_date))
    ), ranked AS (
      SELECT grouped.*,
        CASE WHEN dimension_type IN ('location','advisor') THEN location_coverage.business_available ELSE coverage.business_available END business_available,
        CASE WHEN dimension_type IN ('location','advisor') THEN location_coverage.payments_available ELSE coverage.payments_available END payments_available,
        CASE WHEN dimension_type IN ('location','advisor') THEN location_coverage.staff_available ELSE coverage.staff_available END staff_available,
        CASE WHEN dimension_type IN ('location','advisor') THEN location_coverage.mix_available ELSE coverage.mix_available END mix_available,
        row_number() OVER (PARTITION BY dimension_type ORDER BY billed_revenue DESC NULLS LAST) dimension_rank
      FROM grouped CROSS JOIN coverage
      LEFT JOIN coverage_by_shop location_coverage ON location_coverage.shop_id=grouped.shop_id
    )
    SELECT * FROM ranked
    WHERE dimension_type <> 'advisor' OR dimension_rank <= ${REPORTING_DIMENSION_LIMIT + 1}
    UNION ALL
    SELECT 'coverage' dimension_type, coverage_by_shop.shop_id,
      coverage_by_shop.shop_id::text dimension_key, NULL::text dimension_label,
      0::int ro_count, NULL::float8 billed_revenue, NULL::float8 declined_dollars,
      NULL::int sold_opps, NULL::int missed_opps, NULL::float8 labor_revenue,
      NULL::float8 parts_revenue, 0::int payment_rows, 0::int staff_rows, 0::int mix_rows,
      coverage_by_shop.business_available, coverage_by_shop.payments_available,
      coverage_by_shop.staff_available, coverage_by_shop.mix_available, 0::bigint dimension_rank
    FROM coverage_by_shop
    ORDER BY dimension_type, dimension_key`, [ids, range.start, range.end]),
    query(`${base}, tech AS (
      SELECT f.shop_id,
        coalesce(
          nullif(sj.technician_id,''),
          CASE WHEN nullif(sj.technician_name,'') IS NOT NULL THEN 'name:' || lower(sj.technician_name) END,
          '${UNKNOWN_DIMENSION_KEY}'
        ) technician_key,
        sj.technician_name, f.id, f.basis_date,
        CASE
          WHEN sj.id IS NULL THEN f.billed
          WHEN sum(abs(sj.total::numeric)) OVER (PARTITION BY f.id) > 0
            THEN f.billed * abs(sj.total::numeric) / sum(abs(sj.total::numeric)) OVER (PARTITION BY f.id)
          ELSE f.billed / count(*) OVER (PARTITION BY f.id)
        END billed,
        coalesce(sj.labor_total::numeric,0) labor, coalesce(sj.parts_total::numeric,0) parts,
        CASE WHEN sj.status IN ('declined','deferred') THEN sj.total::numeric ELSE 0 END declined_dollars,
        CASE WHEN sj.recommendation_id IS NOT NULL AND sj.status IN ('authorized','completed') THEN 1 ELSE 0 END sold_opps,
        CASE WHEN sj.recommendation_id IS NOT NULL AND sj.status IN ('declined','deferred') THEN 1 ELSE 0 END missed_opps,
        CASE WHEN sj.id IS NULL THEN 0 ELSE 1 END staff_rows,
        CASE WHEN f.payment_rows > 0 THEN 1 ELSE 0 END payment_rows
      FROM facts f LEFT JOIN normalized_service_jobs sj ON sj.work_order_id=f.id
        AND coalesce((sj.soft_delete->>'isDeleted')::boolean,false)=false
    ), grouped AS (
      SELECT shop_id, shop_id::text || ':' || technician_key dimension_key,
      coalesce(
        (array_agg(nullif(technician_name,'') ORDER BY basis_date DESC)
          FILTER (WHERE nullif(technician_name,'') IS NOT NULL))[1],
        'Unknown / unmapped') dimension_label,
      count(DISTINCT id)::int ro_count, sum(billed)::float8 billed_revenue,
      sum(declined_dollars)::float8 declined_dollars, sum(sold_opps)::int sold_opps, sum(missed_opps)::int missed_opps,
      sum(labor)::float8 labor_revenue, sum(parts)::float8 parts_revenue,
      count(DISTINCT id) FILTER (WHERE payment_rows > 0)::int payment_rows, sum(staff_rows)::int staff_rows,
      count(*) FILTER (WHERE labor<>0 OR parts<>0)::int mix_rows
      FROM tech GROUP BY shop_id, technician_key
      ORDER BY billed_revenue DESC LIMIT ${REPORTING_DIMENSION_LIMIT + 1}
    )
    SELECT grouped.*, location_coverage.business_available, location_coverage.payments_available,
      location_coverage.staff_available, location_coverage.mix_available
    FROM grouped JOIN coverage_by_shop location_coverage USING (shop_id)`, [ids, range.start, range.end]),
    query(`WITH filtered_events AS MATERIALIZED (
      SELECT * FROM recommendation_events
      WHERE shop_id=ANY($1::int[]) AND received_at BETWEEN $2 AND $3
    ), coverage_by_shop AS (
      SELECT scope.shop_id,
        EXISTS(SELECT 1 FROM viewed_vins WHERE shop_id=scope.shop_id) plan_views_available,
        EXISTS(SELECT 1 FROM recommendation_events WHERE shop_id=scope.shop_id) rec_events_available
      FROM unnest($1::int[]) scope(shop_id)
    ), coverage AS (
      SELECT bool_or(plan_views_available) plan_views_available,
        bool_or(rec_events_available) rec_events_available FROM coverage_by_shop
    ), summary AS (
      SELECT 'summary'::text dimension_type, NULL::integer shop_id, 'summary'::text dimension_key,
        NULL::text dimension_label, count(*)::int rec_events,
        count(*) FILTER (WHERE event_type='recommendation_added')::int rec_added,
        count(*) FILTER (WHERE event_type='recommendation_sold')::int rec_sold,
        coalesce(sum(CASE WHEN event_type='recommendation_sold'
        AND coalesce(payload->>'totalPrice','') ~ '^-?[0-9]+([.][0-9]+)?$'
        THEN (payload->>'totalPrice')::numeric ELSE 0 END),0)::float8 attributed_revenue
      FROM filtered_events
    ), sources AS (
      SELECT 'source'::text dimension_type, NULL::integer shop_id,
        coalesce(nullif(payload->>'recommendationType',''),'unknown') dimension_key,
        coalesce(nullif(payload->>'recommendationType',''),'Unknown / unmapped') dimension_label,
        count(*)::int rec_events,
        count(*) FILTER (WHERE event_type='recommendation_added')::int rec_added,
        count(*) FILTER (WHERE event_type='recommendation_sold')::int rec_sold,
        coalesce(sum(CASE WHEN event_type='recommendation_sold'
          AND coalesce(payload->>'totalPrice','') ~ '^-?[0-9]+([.][0-9]+)?$'
          THEN (payload->>'totalPrice')::numeric ELSE 0 END),0)::float8 attributed_revenue
      FROM filtered_events GROUP BY 3,4
    ), locations AS (
      SELECT 'location'::text dimension_type, scope.shop_id, scope.shop_id::text dimension_key,
        NULL::text dimension_label, count(e.id)::int rec_events,
        count(e.id) FILTER (WHERE e.event_type='recommendation_added')::int rec_added,
        count(e.id) FILTER (WHERE e.event_type='recommendation_sold')::int rec_sold,
        coalesce(sum(CASE WHEN e.event_type='recommendation_sold'
          AND coalesce(e.payload->>'totalPrice','') ~ '^-?[0-9]+([.][0-9]+)?$'
          THEN (e.payload->>'totalPrice')::numeric ELSE 0 END),0)::float8 attributed_revenue
      FROM unnest($1::int[]) scope(shop_id)
      LEFT JOIN filtered_events e ON e.shop_id=scope.shop_id GROUP BY scope.shop_id
    ), grouped_unranked AS (
      SELECT * FROM summary UNION ALL SELECT * FROM sources UNION ALL SELECT * FROM locations
    ), grouped AS (
      SELECT *, row_number() OVER (
        PARTITION BY dimension_type ORDER BY attributed_revenue DESC NULLS LAST
      ) dimension_rank FROM grouped_unranked
    ), views_by_shop AS (
      SELECT shop_id, sum(view_count)::int plans_viewed FROM viewed_vins
      WHERE shop_id=ANY($1::int[]) AND last_viewed_at BETWEEN $2 AND $3
      GROUP BY shop_id
    ), views AS (
      SELECT 'summary' dimension_type, NULL::integer shop_id, coalesce(sum(plans_viewed),0)::int plans_viewed
      FROM views_by_shop
      UNION ALL
      SELECT 'location', shop_id, plans_viewed FROM views_by_shop
    )
    SELECT grouped.*,
      CASE
        WHEN grouped.dimension_type='location' AND location_coverage.plan_views_available THEN coalesce(views.plans_viewed,0)
        WHEN grouped.dimension_type<>'location' AND coverage.plan_views_available THEN coalesce(views.plans_viewed,0)
        ELSE NULL END plans_viewed,
      CASE WHEN grouped.dimension_type='location' THEN location_coverage.plan_views_available ELSE coverage.plan_views_available END plan_views_available,
      CASE WHEN grouped.dimension_type='location' THEN location_coverage.rec_events_available ELSE coverage.rec_events_available END rec_events_available
    FROM grouped LEFT JOIN views
      ON views.dimension_type=grouped.dimension_type AND views.shop_id IS NOT DISTINCT FROM grouped.shop_id
    CROSS JOIN coverage
    LEFT JOIN coverage_by_shop location_coverage ON location_coverage.shop_id=grouped.shop_id
    WHERE grouped.dimension_type<>'source' OR grouped.dimension_rank<=${REPORTING_DIMENSION_LIMIT + 1}
    ORDER BY grouped.dimension_type, attributed_revenue DESC`, [ids, range.start, range.end]),
  ]);
  const summaryBusiness = businessRows.find((r) => r.dimension_type === "summary") || {};
  const usage = usageRows.find((r) => r.dimension_type === "summary") || {};
  const summaryRow = { ...summaryBusiness, ...usage };
  const locationRows = businessRows.filter((r) => r.dimension_type === "location");
  const locationBusiness = new Map(locationRows.map((r) => [Number(r.shop_id), r]));
  const locationCoverage = new Map(
    businessRows
      .filter((r) => r.dimension_type === "coverage")
      .map((r) => [Number(r.shop_id), r]),
  );
  const advisorRows = businessRows.filter((r) => r.dimension_type === "advisor");
  const dailyRows = businessRows
    .filter((r) => r.dimension_type === "date")
    .sort((a, b) => String(a.dimension_key).localeCompare(String(b.dimension_key)));
  const sourceRows = usageRows.filter((r) => r.dimension_type === "source");
  const locationUsage = new Map(
    usageRows
      .filter((r) => r.dimension_type === "location")
      .map((r) => [Number(r.shop_id), r]),
  );
  const names = new Map(scope.shops.map((s) => [s.shopId, s.locationIdentifier ? `${s.name} (${s.locationIdentifier})` : s.name]));
  const advisorTruncated = advisorRows.length > REPORTING_DIMENSION_LIMIT;
  const techTruncated = technicianRows.length > REPORTING_DIMENSION_LIMIT;
  const sourceTruncated = sourceRows.length > REPORTING_DIMENSION_LIMIT;
  return {
    ok: true, version: REPORTING_KPI_VERSION, generatedAt: new Date().toISOString(),
    scope: { kind: scope.kind, shopIds: scope.shopIds, ...(scope.enterpriseId ? { enterpriseId: scope.enterpriseId } : {}) },
    range: { start: range.start.toISOString(), end: range.end.toISOString(), days: range.days, timestampBasis: "closed_date, with completed_date fallback" },
    catalog: REPORTING_KPI_CATALOG,
    summary: metrics(summaryRow), availability: availability(summaryRow),
    timeSeries: dailyRows.map((r) => group(r)),
    byLocation: scope.shops.map((shop) => group(
      {
        shop_id: shop.shopId,
        dimension_key: String(shop.shopId),
        ...(locationCoverage.get(shop.shopId) || {}),
        ...(locationBusiness.get(shop.shopId) || {}),
        ...(locationUsage.get(shop.shopId) || {}),
      },
      names.get(shop.shopId) || `Shop ${shop.shopId}`,
    )),
    byAdvisor: advisorRows.slice(0, REPORTING_DIMENSION_LIMIT).map((r) => group(r)),
    byTechnician: technicianRows.slice(0, REPORTING_DIMENSION_LIMIT).map((r) => group(r)),
    byRecommendationSource: sourceRows
      .slice(0, REPORTING_DIMENSION_LIMIT)
      .map((r) => group(r)),
    dataQuality: {
      unknownAdvisorRepairOrders: advisorRows
        .filter((r) => String(r.dimension_key).endsWith(`:${UNKNOWN_DIMENSION_KEY}`))
        .reduce((sum, r) => sum + Number(r.ro_count || 0), 0),
      unknownTechnicianJobs: technicianRows
        .filter((r) => String(r.dimension_key).endsWith(`:${UNKNOWN_DIMENSION_KEY}`))
        .reduce((sum, r) => sum + Number(r.staff_rows || 0), 0),
      dimensionsTruncated: advisorTruncated || techTruncated || sourceTruncated,
      notes: [
        "Unknown / unmapped staff are retained as explicit groups.",
        "Provider-reported staff identities are not merged across locations.",
        "Attributed revenue is recommendation telemetry and is never added to billed revenue.",
      ],
    },
  };
}
