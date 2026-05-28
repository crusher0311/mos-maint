/**
 * Smoke test for src/middleware.ts static-asset matcher bypass (task #507).
 *
 * Run: `npx tsx tests/middleware-static-asset-bypass.smoke.ts`
 *
 * Locks in the Task #506 fix that widened the Next.js middleware `matcher`
 * regex so requests for files under `public/` (logos, icons, fonts, etc.)
 * bypass the auth gate instead of being 307'd to `/login`. The
 * Vehicle Health Report at `/report/[vin]` (including AppFueled white-label
 * viewers) renders these as `<img src="/...">` tags — if a future auth
 * change narrows this matcher again, those images silently 404 / show
 * broken-image icons in production.
 *
 * Asserts:
 *  1. Static asset paths (PNG/SVG/ICO/...) under `public/` do NOT match
 *     the middleware matcher — the middleware never runs on them.
 *  2. Real app paths (`/dashboard/...`, `/api/...`) DO still match the
 *     matcher, and the middleware redirects/401s them when unauthenticated.
 */
import { NextRequest } from "next/server";
import { middleware, config } from "../src/middleware";

let failed = 0;

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function matcherMatches(pathname: string): boolean {
  const patterns = Array.isArray(config.matcher) ? config.matcher : [config.matcher];
  for (const raw of patterns) {
    // Next.js anchors matcher patterns. Use ^...$ so a partial match doesn't
    // pass when the negative lookahead should have excluded the path.
    const re = new RegExp(`^${raw}$`);
    if (re.test(pathname)) return true;
  }
  return false;
}

async function run() {
  console.log("middleware static-asset bypass smoke (task #507)");

  // Don't let DEV_AUTO_LOGIN mask the auth-redirect branch.
  process.env.NODE_ENV = "production";
  delete process.env.DEV_AUTO_LOGIN;

  // (1) Static assets from public/ must NOT match the matcher — Next.js
  // skips middleware entirely for paths that don't match, which is exactly
  // the behavior we want for these requests.
  const bypassedPaths = [
    "/logos/makes/chevrolet.png",
    "/icons/service/brake_fluid.svg",
    "/icons/vehicle-health-intelligence.png",
    "/mos-logo.png",
    "/fonts/Inter.woff2",
    "/og-image.jpg",
    "/manifest.json",
  ];
  for (const p of bypassedPaths) {
    ok(
      `matcher excludes ${p}`,
      !matcherMatches(p),
      `matcher unexpectedly matched ${p}`,
    );
  }

  // (2) Protected app paths must still match the matcher AND get
  // redirected/401'd by the middleware when unauthenticated.
  const protectedPagePaths = ["/dashboard/vehicles/abc", "/dashboard/settings"];
  for (const p of protectedPagePaths) {
    ok(`matcher includes ${p}`, matcherMatches(p));
    const res = await middleware(new NextRequest(`http://localhost${p}`));
    ok(`${p} redirects to /login`, res!.status === 307);
    const loc = res!.headers.get("location") || "";
    ok(
      `${p} preserves next= param`,
      loc.includes("/login") && loc.includes(`next=${encodeURIComponent(p)}`),
      `location=${loc}`,
    );
  }

  const protectedApiPaths = ["/api/shops", "/api/vehicles/abc"];
  for (const p of protectedApiPaths) {
    ok(`matcher includes ${p}`, matcherMatches(p));
    const res = await middleware(new NextRequest(`http://localhost${p}`));
    ok(`${p} returns 401 JSON`, res!.status === 401);
  }

  if (failed > 0) {
    console.error(`\n${failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nAll assertions passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
