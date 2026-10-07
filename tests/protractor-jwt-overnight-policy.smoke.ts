import assert from "node:assert/strict";
import {
  isJwtOvernightEligible as eligible, validateJwtOvernightGrant as validate,
  jwtOvernightAdmissionExpression, jwtOvernightConsumptionFields,
  compileJwtOvernightInvoiceRequest, matchesJwtOvernightDispatch,
  type JwtOvernightGrant, type JwtOvernightRequest,
} from "../lib/protractor-jwt-overnight-policy";

const grant: JwtOvernightGrant = {
  version: 1, runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  canaryGeneration: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  manifestHash: "c".repeat(64), notBefore: new Date("2026-10-06T03:00:00Z"),
  expiresAt: new Date("2026-10-06T10:00:00Z"), windowKeys: ["233:2026-09-01"],
  maxRequests: 3, consumedRequests: 0, stopped: false,
};
const request: JwtOvernightRequest = {
  runId: grant.runId, shopId: 233, day: "2026-09-01", operation: "invoice-day", method: "GET",
};
const early:JwtOvernightGrant={...grant,notBefore:new Date("2026-10-07T23:00:00Z"),
 expiresAt:new Date("2026-10-08T10:00:00Z"),maxRequests:1000,consumedRequests:65};
validate(early);
for(const patch of [
 {notBefore:new Date("2026-10-07T22:00:00Z")},
 {notBefore:new Date("2026-10-08T23:00:00Z"),expiresAt:new Date("2026-10-09T10:00:00Z")},
 {expiresAt:new Date("2026-10-08T11:00:00Z")},
 {maxRequests:1001},{consumedRequests:64}
])assert.throws(()=>validate({...early,...patch}),/Invalid JWT/);
const context = {
  now: new Date("2026-10-06T04:00:00Z"), canaryGeneration: grant.canaryGeneration,
  relay: true, production: true, operatorStopped: false,
  generalWorkersSuspended: true, quietWindow: true,
};
assert.equal(eligible(grant, request, context), true);
assert.equal(eligible(grant, request, {...context, now: grant.notBefore}), true);
assert.equal(eligible(grant, request, {...context, now: grant.expiresAt}), false);
assert.equal(eligible(grant, request, {...context, now: new Date("invalid")}), false);
for (const field of ["relay", "production", "generalWorkersSuspended", "quietWindow"] as const) {
  assert.equal(eligible(grant, request, {...context, [field]: false}), false, field);
}
assert.equal(eligible(grant, request, {...context, operatorStopped: true}), false);
assert.equal(eligible(grant, request, {...context, canaryGeneration: "wrong"}), false);
for (const patch of [
  {shopId: 999}, {shopId: 227}, {day: "2026-07-01"}, {day: "2026-09-31"},
  {day: "2026-09-02"}, {method: "POST"}, {operation: "work-order"}, {runId: "wrong"},
]) assert.equal(eligible(grant, {...request, ...patch} as JwtOvernightRequest, context), false);
for (const patch of [
  {stopped: true}, {consumedRequests: 3}, {maxRequests: 2001}, {consumedRequests: -1},
  {maxRequests: 2.5}, {consumedRequests: .5}, {windowKeys: ["227:2026-09-01"]},
  {windowKeys: []}, {windowKeys: ["233:2026-09-01", "233:2026-09-01"]},
  {expiresAt: new Date("2026-10-07T10:00:00Z")},
  {notBefore: new Date("2026-10-06T02:00:00Z")},
  {manifestHash: "not-a-hash"},
]) assert.equal(eligible({...grant, ...patch}, request, context), false);
assert.doesNotThrow(() => validate({...grant,
  notBefore: new Date("2026-11-01T03:00:00Z"), expiresAt: new Date("2026-11-01T11:00:00Z")}));
assert.deepEqual(jwtOvernightAdmissionExpression({...request, shopId: 227}), {$literal: false});
assert.ok("$cond" in jwtOvernightAdmissionExpression(request));
// Exercise the emitted Mongo expression, including malformed/missing storage,
// rather than relying only on the preliminary JavaScript eligibility test.
function evaluate(value: any, row: any): any {
  if (value === "$$NOW") return context.now;
  if (typeof value === "string" && value.startsWith("$")) {
    return value.slice(1).split(".").reduce((v: any, k: string) => v?.[k], row);
  }
  if (Array.isArray(value)) return value.map(v => evaluate(v, row));
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  const [[op, arg]] = Object.entries(value) as [string, any][];
  if (op === "$literal") return arg;
  if (op === "$cond") return evaluate(evaluate(arg[0], row) ? arg[1] : arg[2], row);
  if (op === "$type") {
    const v = evaluate(arg, row);
    return v === undefined ? "missing" : v instanceof Date ? "date" : typeof v;
  }
  if (op === "$isArray") return Array.isArray(evaluate(arg, row));
  if (op === "$isNumber") return typeof evaluate(arg, row) === "number";
  if (op === "$trunc") return Math.trunc(evaluate(arg, row));
  const args = evaluate(arg, row);
  switch (op) {
    case "$and": return args.every(Boolean);
    case "$eq": return args[0] === args[1];
    case "$lt": return args[0] < args[1];
    case "$lte": return args[0] <= args[1];
    case "$gt": return args[0] > args[1];
    case "$gte": return args[0] >= args[1];
    case "$in": return args[1].includes(args[0]);
    case "$add": return args[0] + args[1];
    case "$ifNull": return args[0] ?? args[1];
    default: throw new Error(`Unhandled expression ${op}`);
  }
}
const row = {canary: {generation: grant.canaryGeneration}, jwtOvernight: grant};
const expression = jwtOvernightAdmissionExpression(request);
assert.equal(evaluate(expression, row), true);
assert.equal(evaluate(expression, {}), false);
for (const patch of [
  {runId: "wrong"}, {canaryGeneration: "old"}, {stopped: true},
  {version: 2}, {windowKeys: null}, {windowKeys: []},
  {notBefore: context.now.toISOString()}, {expiresAt: context.now},
  {consumedRequests: -1}, {consumedRequests: 3}, {consumedRequests: .5},
  {consumedRequests: "0"}, {maxRequests: "3"}, {maxRequests: 2001},
]) {
  assert.equal(evaluate(expression, {...row, jwtOvernight: {...grant, ...patch}}), false);
}
const fields: any = jwtOvernightConsumptionFields(request);
assert.equal(evaluate(fields["jwtOvernight.consumedRequests"], row), 1);
assert.equal(evaluate(fields["jwtOvernight.consumedRequests"], {
  ...row, jwtOvernight: {...grant, consumedRequests: 3},
}), 3);
// Three serialized successful admissions exhaust the finite budget. A fourth
// request is rejected; real concurrency still requires the atomic DB boundary.
let stored = {...grant};
for (let i = 0; i < 3; i++) {
  const current = {...row, jwtOvernight: stored};
  assert.equal(evaluate(expression, current), true);
  stored = {...stored, consumedRequests: evaluate(fields["jwtOvernight.consumedRequests"], current)};
}
assert.equal(evaluate(expression, {...row, jwtOvernight: stored}), false);
const dispatch = compileJwtOvernightInvoiceRequest(request, 0);
assert.equal(dispatch.endpoint, "/Invoice/?startDate=2026-09-01&endDate=2026-09-02&take=100&skip=0");
assert.equal(matchesJwtOvernightDispatch(request, dispatch), true);
assert.equal(matchesJwtOvernightDispatch(request, compileJwtOvernightInvoiceRequest(request, 4)), true);
assert.throws(() => compileJwtOvernightInvoiceRequest(request, 5));
assert.throws(() => compileJwtOvernightInvoiceRequest(request, -1));
assert.throws(() => compileJwtOvernightInvoiceRequest(request, .5));
for (const patch of [
  {method: "POST"}, {shopId: 227}, {body: {}}, {body: ""},
  {endpoint: dispatch.endpoint + "&startDate=2026-01-01"},
  {endpoint: "https://example.com" + dispatch.endpoint},
  {endpoint: dispatch.endpoint.replace("take=100", "take=1000")},
  {endpoint: dispatch.endpoint.replace("Invoice/", "WorkOrder/")},
  {endpoint: dispatch.endpoint.replace("endDate=2026-09-02", "endDate=2026-10-01")},
]) assert.equal(matchesJwtOvernightDispatch(request, {...dispatch, ...patch}), false);
assert.equal(compileJwtOvernightInvoiceRequest({...request, day: "2026-08-31"}, 0).endpoint,
  "/Invoice/?startDate=2026-08-31&endDate=2026-09-01&take=100&skip=0");
console.log("JWT overnight eligibility: scope, dates, expiry, stops, budget and DST passed.");
