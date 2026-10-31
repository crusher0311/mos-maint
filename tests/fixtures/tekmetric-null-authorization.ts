/**
 * Source-shape regression: one approved diagnostic list request on 2026-10-31
 * returned 50 invoices / 253 jobs, including 6 authorized:null jobs. All dates,
 * job arrays and parts arrays were present. Identifiers and content below are
 * fictional; no customer data or source invoice identifiers are retained.
 */
export const nullableAuthorizationInvoice = () => ({
  id: 9001, shopId: 10, repairOrderNumber: 9001,
  postedDate: "2026-10-15T12:00:00Z",
  repairOrderStatus: { code: "POSTED", name: "Posted" },
  milesIn: 1000,
  jobs: [
    { id: 1, authorized: true, parts: [
      { id: 11, name: "Example tire 225/45R18", quantity: 2, dotNumbers: ["001", "001"] },
    ] },
    { id: 2, authorized: null, parts: [] },
    { id: 3, authorized: null, parts: [
      { id: 12, name: "Example tire 225/45R18", quantity: 1, dotNumbers: ["002"] },
    ] },
    { id: 4, authorized: false, parts: [
      { id: 13, name: "Example tire 225/45R18", quantity: 1, dotNumbers: ["003"] },
    ] },
  ],
});
