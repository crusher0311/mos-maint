import { pilotHash } from "./tire-dot-pilot";

// Only fixed schema names appear in diagnostics. Never include source values,
// dynamic property names, customer text, VINs, DOTs, or part descriptions.
const fields = new Set(("id shopId repairOrderNumber repairOrderStatus code name postedDate updatedDate " +
  "deletedDate deleted isDeleted archived isArchived archivedDate milesIn milesOut mileageIn mileageOut " +
  "vehicleId vin year make model laborSales partsSales subletSales feeTotal discountTotal taxes totalSales " +
  "jobs authorized status declined deferred parts description brand partNumber partType type category " +
  "quantity width ratio diameter dotNumbers vehicle").split(" "));

export function describePilotMismatch(
  prior: { page: number; hash: string; inMonth: boolean; data: any } | null,
  incoming: { data: any; hash: string },
  page: number,
) {
  const changedPaths: string[] = [];
  let visited = 0, truncated = false;
  const add = (path: string) => {
    if (changedPaths.length >= 24) { truncated = true; return; }
    if (!changedPaths.includes(path)) changedPaths.push(path);
  };
  const walk = (a: any, b: any, path: string, depth: number) => {
    if (++visited > 2000 || changedPaths.length >= 24 || depth > 8) { truncated = true; return; }
    if (a === b) return;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) add(`${path}.length`);
      for (let i = 0; i < Math.min(a.length, b.length); i++) {
        if (visited >= 2000 || changedPaths.length >= 24) { truncated = true; break; }
        walk(a[i], b[i], `${path}[${i}]`, depth + 1);
      }
    } else if (a && b && typeof a === "object" && typeof b === "object" &&
        !Array.isArray(a) && !Array.isArray(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (visited >= 2000 || changedPaths.length >= 24) { truncated = true; break; }
        if (!fields.has(key)) {
          if (pilotHash(a[key] ?? null) !== pilotHash(b[key] ?? null)) add(`${path}.otherFields`);
          continue;
        }
        if (Object.hasOwn(a, key) !== Object.hasOwn(b, key)) add(`${path}.${key}`);
        else walk(a[key], b[key], `${path}.${key}`, depth + 1);
      }
    } else add(path);
  };
  // Outside-month baseline payloads are deliberately reduced: don't fabricate
  // field differences against them. Hash/page evidence still remains useful.
  if (prior?.inMonth && prior.hash !== incoming.hash) walk(prior.data, incoming.data, "invoice", 0);
  return {
    version: 1,
    baselineFound: !!prior,
    expectedPage: prior?.page ?? null,
    observedPage: page,
    pageChanged: !!prior && prior.page !== page,
    contentChanged: !!prior && prior.hash !== incoming.hash,
    baselineHash: prior?.hash ?? null,
    observedHash: incoming.hash,
    fieldComparison: !prior ? "baseline_missing" : !prior.inMonth ? "baseline_reduced" : "available",
    changedPaths, truncated,
  };
}
