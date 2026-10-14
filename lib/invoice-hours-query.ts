// Scan bounded stored headers, not only close-dated rows: otherwise invoices
// dated differently or missing dates would disappear into false 100% coverage.
// No child joins, provider calls, repairs or writes.
export const INVOICE_HOURS_MAX_ORDERS = 100_000;
export const INVOICE_HOURS_SQL = `
SELECT wo.id, wo.shop_id, wo.status,
  wo.provenance->>'sourceSystem' provider,
  wo.provenance->'sourceIds' source_ids,
  wo.custom_fields->'invoiceHours' invoice_evidence
FROM normalized_work_orders wo
WHERE wo.shop_id=ANY($1::int[])
  AND NOT coalesce((wo.soft_delete->>'isDeleted')::boolean,false)
  AND wo.status NOT IN ('voided','cancelled')
ORDER BY wo.shop_id, wo.id
LIMIT ${INVOICE_HOURS_MAX_ORDERS + 1}
`;
