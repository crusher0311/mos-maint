export type ShopWareRepairOrderQuery = {
  associations?: string;
  updated_after?: string;
  closed_after?: string;
  shop_id?: number;
  customer_id?: number;
  vehicle_id?: number;
};

/**
 * Builds the query accepted by Shop-Ware repair-order endpoints.
 *
 * Shop-Ware expects associations as repeated `associations[]` keys rather
 * than one comma-delimited value. Callers may keep passing the existing
 * comma-delimited selection.
 */
export function buildRepairOrderQuery(
  params: ShopWareRepairOrderQuery = {}
): URLSearchParams {
  const query = new URLSearchParams();

  for (const association of params.associations?.split(',') ?? []) {
    const trimmed = association.trim();
    if (trimmed) query.append('associations[]', trimmed);
  }

  if (params.updated_after) query.set('updated_after', params.updated_after);
  if (params.closed_after) query.set('closed_after', params.closed_after);
  if (params.shop_id) query.set('shop_id', String(params.shop_id));
  if (params.customer_id) query.set('customer_id', String(params.customer_id));
  if (params.vehicle_id) query.set('vehicle_id', String(params.vehicle_id));

  return query;
}