import { invoiceFleetParams, invoiceFleetResult } from "../invoice-fleet-aggregation";
import { hash, PARSER_VERSION, type Query } from "./contract";

/** One snapshot for all requested locations; unresolved/unknown dates count in every range.
 * Registry/review checks are repeated at read time, not trusted from projection time. */
export const PROJECTION_REPORT_SQL = `
WITH builds AS (
 SELECT b.* FROM reporting_invoice.scopes s
 JOIN reporting_invoice.builds b ON b.id=s.published
 WHERE s.shop_id=ANY($1::int[]) AND b.shop_id=s.shop_id AND b.phase='complete'
 AND b.revision=s.revision AND b.parser_version=$4
 AND b.verified_at>clock_timestamp()-interval '5 minutes'
 AND EXISTS(SELECT 1 FROM reporting_invoice.change_cursors
   WHERE name='mongo' AND observed_at>clock_timestamp()-interval '30 seconds')
), checked AS (
 SELECT i.*,
   (i.classification IN ('verified','noninvoice') AND
    EXISTS(SELECT 1 FROM reporting_invoice.reviews r WHERE r.id=i.review_id
     AND r.shop_id=b.shop_id AND r.identity=i.identity AND r.input_digest=i.input_digest
     AND r.inventory_digest=b.inventory_digest AND r.parser_version=b.parser_version
     AND r.revoked_at IS NULL AND r.reviewed_at<=clock_timestamp() AND r.expires_at>clock_timestamp())
    AND EXISTS(SELECT 1 FROM invoice_repair_hold_reviews r
     JOIN invoice_repair_hold_scopes s USING(shop_id,provider)
     WHERE r.id=i.hold_review_id AND r.shop_id=b.shop_id AND r.provider='protractor'
     AND r.scope_revision=s.revision AND r.inventory_digest=b.inventory_digest
     AND r.reviewed_at<=clock_timestamp() AND r.expires_at>clock_timestamp())
    AND NOT EXISTS(SELECT 1 FROM invoice_repair_holds h WHERE h.shop_id=b.shop_id
     AND h.provider='protractor' AND h.resolved_at IS NULL
     AND (h.source_id IS NULL OR lower(h.source_id)=i.identity))) trusted
 FROM builds b JOIN reporting_invoice.items i ON i.build_id=b.id
)
SELECT b.shop_id,false unsupported,
 count(*) FILTER(WHERE c.trusted AND c.classification='verified' AND c.invoice_date BETWEEN $2 AND $3)::int eligible,
 count(*) FILTER(WHERE c.identity IS NOT NULL AND NOT c.trusted)::int unknown,
 coalesce(sum(c.sold) FILTER(WHERE c.trusted AND c.classification='verified' AND c.invoice_date BETWEEN $2 AND $3),0) sold,
 coalesce(sum(c.presented) FILTER(WHERE c.trusted AND c.classification='verified' AND c.invoice_date BETWEEN $2 AND $3),0) presented,
 count(c.sold) FILTER(WHERE c.trusted AND c.classification='verified' AND c.invoice_date BETWEEN $2 AND $3)::int sold_covered,
 count(c.presented) FILTER(WHERE c.trusted AND c.classification='verified' AND c.invoice_date BETWEEN $2 AND $3)::int presented_covered
FROM builds b LEFT JOIN checked c ON c.build_id=b.id GROUP BY b.shop_id
`;

export async function readProjection(query: Query, authorized: number[], requested: number[], start: Date, end: Date) {
  const params = invoiceFleetParams(authorized, requested, start, end);
  const rows = await query(PROJECTION_REPORT_SQL, [...params, PARSER_VERSION]);
  // No fallback scan: a missing/stale location makes fleet coverage unavailable.
  if (rows.length !== requested.length) throw Error("Invoice projection is unavailable or stale. Rebuild the stored-evidence projection.");
  return invoiceFleetResult(requested, rows);
}

export async function projectionCacheToken(query: Query, shops: number[]) {
  invoiceFleetParams(shops, shops, new Date(0), new Date(1));
  const rows = await query(`SELECT s.shop_id,s.revision::text,s.published::text,
    b.verified_at::text,b.phase,
    (b.verified_at>clock_timestamp()-interval '5 minutes') fresh,
    (SELECT observed_at>clock_timestamp()-interval '30 seconds' FROM reporting_invoice.change_cursors WHERE name='mongo') watcher,
    (SELECT min(expires_at)::text FROM reporting_invoice.reviews r
      WHERE r.shop_id=s.shop_id AND revoked_at IS NULL AND expires_at>clock_timestamp()) review_expiry,
    (SELECT min(expires_at)::text FROM invoice_repair_hold_reviews r
      WHERE r.shop_id=s.shop_id AND expires_at>clock_timestamp()) hold_expiry
    FROM reporting_invoice.scopes s LEFT JOIN reporting_invoice.builds b ON b.id=s.published
    WHERE s.shop_id=ANY($1::int[]) ORDER BY s.shop_id`, [`{${shops.join(",")}}`]);
  return hash([PARSER_VERSION, rows]);
}
