import { build } from "esbuild";
import { readFileSync } from "node:fs";

export function fleet(size = 1000) {
  return Array.from({ length: size }, (_, i) => ({
    _id: `fixture-${i + 1}`, shopId: i % 2 ? String(i + 1) : i + 1,
    name: `Fixture Shop ${i + 1}`, createdAt: new Date("2026-01-01"),
    billing: { plan: i % 2 ? "trial" : "detect_dog_founder", status: i % 2 ? "trial" : "active" },
    enterpriseId: i < 10 ? "enterprise-fixture" : null,
    reviewStatus: i % 3 ? "approved" : "pending",
    tekmetric: { shopId: i + 100 },
    trial: { endsAt: new Date("2030-01-01"), reminderSent: { 7: new Date("2026-01-01") } },
  }));
}

export async function apiFixture(options: { baseline?: boolean; size?: number } = {}) {
  const f = {
    shops: fleet(options.size), admin: true, signedIn: true, pg: false,
    delay: 0, fail: "", calls: [] as { name: string; pipeline: any[]; options: any }[],
    auditSize: 100_000, maxAccumulated: 0, counter: 0,
    async rows(name: string, pipeline: any[] = [], opts: any = {}) {
      this.calls.push({ name, pipeline, options: opts });
      if (name === "enterprise_accounts") return [{ _id: "enterprise-fixture", name: "Fixture Enterprise" }];
      if (this.delay) await new Promise(r => setTimeout(r, this.delay));
      if (this.fail === name) throw new Error("synthetic read failure");
      if (name === "tekmetric_backfill_progress") return [{ shopId: 1, completed: true, totalJobsIndexed: this.counter }];
      if (name === "backfill_progress") return [];
      if (name === "audit_logs") {
        const bounded = pipeline.some(p => p.$group?.entries?.$firstN);
        const audit = Array.from({ length: this.auditSize }, (_, i) => ({
          type: "shop_trial_reminder_sent", createdAt: new Date(Date.UTC(2026, 0, 1) - i * 86400000),
          daysLeft: i === 0 ? 7 : i, ownerEmail: "owner@example.test",
        }));
        audit.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        const entries = [];
        for (const row of audit) if (!bounded || entries.length < 10) entries.push(row);
        this.maxAccumulated = entries.length;
        return [{ _id: 1, entries: entries.slice(0, 10) }];
      }
      if (name === "users" && pipeline[0]?.$match?.role) return [{ _id: 1, email: "owner@example.test" }];
      if (name === "job_index") return [{ _id: 1, count: 42 }, { _id: "1", count: 8 }];
      return [{ _id: 1, count: 2 }, { _id: "1", count: 3 }];
    },
  };
  if (options.baseline) {
    // Frozen model of the former dependency graph, not git HEAD (which changes
    // after merge). The original route was also measured during implementation.
    return { f, get: async () => {
      await f.rows("enterprise_accounts");
      await Promise.all([
        f.rows("users"), f.rows("vehicles"), f.rows("vins"),
        f.rows("backfill_progress"), f.rows("tekmetric_backfill_progress"),
        f.rows("sticker_generations"), f.rows("sticker_generations"),
        f.rows("audit_logs", [{ $group: { entries: { $push: "$$ROOT" } } }]),
        f.rows("users"),
      ]);
      await f.rows("job_index");
      return new Response(JSON.stringify({ ok: true, shops: f.shops }));
    } };
  }
  const stubs: Record<string, string> = {
    "next/server": `export const NextResponse = {json: (data, init) => new Response(JSON.stringify(data), init)};`,
    "@/lib/auth": `export const getSession = async () => fixture.signedIn ? {isPlatformAdmin: fixture.admin} : null;`,
    "@/lib/mongo": `export const getDb = async () => ({collection: name => ({
      aggregate: (pipeline, options) => ({toArray: () => fixture.rows(name, pipeline, options)}),
      find: (query, options) => ({toArray: () => fixture.rows(name, [{$match:query}], options)})
    })});`,
    "@/lib/data/repositories/shops": `export const listAllShops = async () => fixture.shops;`,
    "@/lib/db/wave4-write-mode": `export const dualWritePgIdentity = async () => {}; export const isIdentityPgCanonical = () => fixture.pg;`,
    "@/lib/data/repositories/pg/identity": `export const insertShop=()=>{}; export const insertUser=()=>{};
      export const platformShopUserSummary=async()=>[{_id:1,count:9}];
      export const platformShopEnterprises=async()=>[{_id:"enterprise-fixture",name:"PG Enterprise"}];`,
    "@/lib/stripe": `export const getBillingSettings=async()=>({trialDays:14}); export const getStripe=()=>{};`,
    "@/lib/db/repositories/wave1": `export const pgViewedVinsAggregateByShop=async(ids)=>fixture.rows("vins", [{$match:{shopId:{$in:ids}}}]);`,
    "@/lib/user-write-guard": `export const assertNoLegacyPasswordField=()=>{};`,
    "@/lib/seed-default-admins": `export const seedDefaultAdmins=()=>{};`,
    "@/lib/email": `export const sendEmail=()=>{}; export const makeCredentialsWelcomeEmail=()=>{};`,
    "bcryptjs": `export default {};`,
  };
  const path = "app/api/platform-admin/shops/route.ts";
  const source = readFileSync(path, "utf8");
  const bundle = await build({
    stdin: { contents: source, resolveDir: process.cwd(), loader: "ts" },
    bundle: true, write: false, platform: "node", format: "cjs", treeShaking: true,
    plugins: [{ name: "isolated-stores", setup(b) {
      b.onResolve({ filter: /.*/ }, args => args.path in stubs ? { path: args.path, namespace: "fixture" } : undefined);
      b.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: stubs[args.path], loader: "ts" }));
    } }],
  });
  const module = { exports: {} as any };
  new Function("fixture", "module", "exports", bundle.outputFiles[0].text)(f, module, module.exports);
  return {
    f,
    get: (view = "legacy", shopId?: string) => module.exports.GET({
      nextUrl: new URL(`https://offline.invalid/api/platform-admin/shops?view=${view}${shopId ? `&shopId=${shopId}` : ""}`),
    }) as Promise<Response>,
  };
}
