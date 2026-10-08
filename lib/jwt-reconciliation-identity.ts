/** Invoice numbers can collide with unrelated, later work-order numbers.
 * Exact provider provenance disambiguates those, but retains real duplicates. */
export function reconciliationMatches(rows:any[],native:any,source:any):any[] {
  return rows.filter(row=>[native.wo,native.invoice,source.ID].includes(row.work_order_number) &&
    row.provenance?.sourceSystem==="protractor" &&
    row.provenance.sourceIds?.some((id:any)=>id.system==="protractor" &&
      String(id.idValue).toLowerCase()===String(source.ID).toLowerCase()));
}
