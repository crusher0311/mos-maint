/**
 * Extension Route Capability Matrix
 *
 * Single source of truth for every HTTP method exported from every
 * app/api/extension/** /route.ts file.
 *
 * Classification tiers:
 *  - "public"           No auth required. Auth POST, version GET, download GET,
 *                       and OPTIONS on every route.
 *  - "read"             Requires validateExtensionToken (or guard) but only
 *                       reads data. GET routes for plan, features, specs,
 *                       canned-jobs, search, etc.
 *  - "write"            Mutations that don't cross into a provider's live system.
 *                       e.g. storing a preference, printing a label, posting a
 *                       support ticket, pushing telemetry.
 *  - "provider_action"  Mutations that write into a provider (SMS) system
 *                       (add/apply/remove jobs, create contact/vehicle/WO,
 *                       inject concern, push add-declined-work, etc.).
 *                       Routes may carry both "write" and "provider_action".
 *  - "admin"            Requires super-admin / platform-admin elevation.
 *                       Migration CRUD and sniffer upload.
 *
 * OPTIONS on every route is always "preflight" (handled separately; it
 * implies no authentication).
 *
 * Usage:
 *   import { lookupPolicy } from "@/lib/extension-route-policy";
 *   const tiers = lookupPolicy("/api/extension/jobs/add-to-ro", "POST");
 *   // → ["write", "provider_action"]
 *
 * Pathname matching: dynamic segments like [id] are normalised to :id
 * before lookup so callers can pass the literal URL pathname.
 */

export type PolicyTier =
  | "public"
  | "read"
  | "write"
  | "provider_action"
  | "admin"
  | "preflight";

// Full matrix. Key format: "<PATHNAME>|<METHOD>" where PATHNAME uses Next.js
// dynamic-segment syntax (e.g. [id]).
//
// Dynamic tekmetric-migration run IDs ([id]) are listed explicitly so the
// lint script can match any numeric segment in their place.
const POLICY_MAP: Record<string, PolicyTier[]> = {
  // ── action-grant ─────────────────────────────────────────────────────────
  // POST: write + provider_action — issues a short-lived signed grant token
  // authorising a specific provider action for an authenticated shop session.
  "/api/extension/action-grant|POST": ["write", "provider_action"],
  "/api/extension/action-grant|OPTIONS": ["preflight"],
  // Signed grant is the credential; provider-page MAIN worlds never receive
  // the long-lived extension bearer token.
  "/api/extension/action-grant/consume|POST": ["public"],
  "/api/extension/action-grant/consume|OPTIONS": ["preflight"],

  // ── auth ─────────────────────────────────────────────────────────────────
  // POST: public — issues extension tokens (no prior auth required)
  "/api/extension/auth|POST": ["public"],
  "/api/extension/auth|OPTIONS": ["preflight"],

  // ── auth-token ───────────────────────────────────────────────────────────
  // POST: write + provider_action — stores a provider x-auth-token for a shop
  "/api/extension/auth-token|POST": ["write", "provider_action"],
  "/api/extension/auth-token|OPTIONS": ["preflight"],

  // ── version ──────────────────────────────────────────────────────────────
  "/api/extension/version|GET": ["public"],

  // ── download ─────────────────────────────────────────────────────────────
  "/api/extension/download|GET": ["public"],

  // ── analytics/push-to-ro ─────────────────────────────────────────────────
  // POST: read — records analytics metadata, no provider mutation
  "/api/extension/analytics/push-to-ro|POST": ["read"],

  // ── build-ro-from-vhi ────────────────────────────────────────────────────
  "/api/extension/build-ro-from-vhi|POST": ["write", "provider_action"],
  "/api/extension/build-ro-from-vhi|OPTIONS": ["preflight"],

  // ── build-ro-from-vhi/log ────────────────────────────────────────────────
  "/api/extension/build-ro-from-vhi/log|POST": ["write"],
  "/api/extension/build-ro-from-vhi/log|OPTIONS": ["preflight"],

  // ── canned-jobs ──────────────────────────────────────────────────────────
  "/api/extension/canned-jobs|GET": ["read"],
  "/api/extension/canned-jobs|OPTIONS": ["preflight"],

  // ── concern-assistant ────────────────────────────────────────────────────
  "/api/extension/concern-assistant|GET": ["read"],
  "/api/extension/concern-assistant|POST": ["read"],
  "/api/extension/concern-assistant|OPTIONS": ["preflight"],

  // ── concern-assistant/inject-protractor ──────────────────────────────────
  "/api/extension/concern-assistant/inject-protractor|POST": [
    "write",
    "provider_action",
  ],
  "/api/extension/concern-assistant/inject-protractor|OPTIONS": ["preflight"],

  // ── enhance-corrections ──────────────────────────────────────────────────
  "/api/extension/enhance-corrections|GET": ["read"],
  "/api/extension/enhance-corrections|POST": ["write"],
  "/api/extension/enhance-corrections|OPTIONS": ["preflight"],

  // ── enhance-findings ─────────────────────────────────────────────────────
  "/api/extension/enhance-findings|POST": ["read"],
  "/api/extension/enhance-findings|OPTIONS": ["preflight"],

  // ── features ─────────────────────────────────────────────────────────────
  "/api/extension/features|GET": ["read"],
  "/api/extension/features|OPTIONS": ["preflight"],

  // ── inspections ──────────────────────────────────────────────────────────
  "/api/extension/inspections|POST": ["write", "provider_action"],
  "/api/extension/inspections|OPTIONS": ["preflight"],

  // ── jobs/add-to-ro ───────────────────────────────────────────────────────
  "/api/extension/jobs/add-to-ro|POST": ["write", "provider_action"],
  "/api/extension/jobs/add-to-ro|OPTIONS": ["preflight"],

  // ── jobs/apply-canned ────────────────────────────────────────────────────
  "/api/extension/jobs/apply-canned|POST": ["write", "provider_action"],
  "/api/extension/jobs/apply-canned|OPTIONS": ["preflight"],

  // ── jobs/last-performed ──────────────────────────────────────────────────
  "/api/extension/jobs/last-performed|GET": ["read"],
  "/api/extension/jobs/last-performed|OPTIONS": ["preflight"],

  // ── jobs/remove-from-ro ──────────────────────────────────────────────────
  "/api/extension/jobs/remove-from-ro|POST": ["write", "provider_action"],
  "/api/extension/jobs/remove-from-ro|OPTIONS": ["preflight"],

  // ── jobs/search ──────────────────────────────────────────────────────────
  "/api/extension/jobs/search|GET": ["read"],
  "/api/extension/jobs/search|OPTIONS": ["preflight"],

  // ── keytag ───────────────────────────────────────────────────────────────
  "/api/extension/keytag|GET": ["read"],
  "/api/extension/keytag|POST": ["write"],
  "/api/extension/keytag|OPTIONS": ["preflight"],

  // ── labor-rates ──────────────────────────────────────────────────────────
  "/api/extension/labor-rates|GET": ["read"],
  "/api/extension/labor-rates|PUT": ["write"],
  "/api/extension/labor-rates|OPTIONS": ["preflight"],

  // ── plan ─────────────────────────────────────────────────────────────────
  "/api/extension/plan|GET": ["read"],
  "/api/extension/plan|OPTIONS": ["preflight"],

  // ── preferences ──────────────────────────────────────────────────────────
  "/api/extension/preferences|GET": ["read"],
  "/api/extension/preferences|PUT": ["write"],
  "/api/extension/preferences|OPTIONS": ["preflight"],

  // ── prefill-dvi ──────────────────────────────────────────────────────────
  "/api/extension/prefill-dvi|POST": ["write", "provider_action"],
  "/api/extension/prefill-dvi|OPTIONS": ["preflight"],

  // ── print ────────────────────────────────────────────────────────────────
  "/api/extension/print|POST": ["write"],
  "/api/extension/print|OPTIONS": ["preflight"],

  // ── print/config ─────────────────────────────────────────────────────────
  "/api/extension/print/config|GET": ["read"],
  "/api/extension/print/config|PUT": ["write"],
  "/api/extension/print/config|OPTIONS": ["preflight"],

  // ── protractor/contacts ──────────────────────────────────────────────────
  "/api/extension/protractor/contacts|GET": ["read"],
  "/api/extension/protractor/contacts|OPTIONS": ["preflight"],

  // ── protractor/create-contact ────────────────────────────────────────────
  "/api/extension/protractor/create-contact|POST": ["write", "provider_action"],
  "/api/extension/protractor/create-contact|OPTIONS": ["preflight"],

  // ── protractor/create-vehicle ────────────────────────────────────────────
  "/api/extension/protractor/create-vehicle|POST": ["write", "provider_action"],
  "/api/extension/protractor/create-vehicle|OPTIONS": ["preflight"],

  // ── protractor/create-work-order ─────────────────────────────────────────
  "/api/extension/protractor/create-work-order|POST": [
    "write",
    "provider_action",
  ],
  "/api/extension/protractor/create-work-order|OPTIONS": ["preflight"],

  // ── protractor/deferred-work ─────────────────────────────────────────────
  "/api/extension/protractor/deferred-work|GET": ["read"],
  "/api/extension/protractor/deferred-work|OPTIONS": ["preflight"],

  // ── protractor/plate-lookup ──────────────────────────────────────────────
  "/api/extension/protractor/plate-lookup|POST": ["read"],
  "/api/extension/protractor/plate-lookup|OPTIONS": ["preflight"],

  // ── protractor/vehicles ──────────────────────────────────────────────────
  "/api/extension/protractor/vehicles|GET": ["read"],
  "/api/extension/protractor/vehicles|OPTIONS": ["preflight"],

  // ── protractor/vin-decode ────────────────────────────────────────────────
  "/api/extension/protractor/vin-decode|GET": ["read"],
  "/api/extension/protractor/vin-decode|OPTIONS": ["preflight"],

  // ── protractor/vin-plate-ocr ─────────────────────────────────────────────
  "/api/extension/protractor/vin-plate-ocr|POST": ["read"],
  "/api/extension/protractor/vin-plate-ocr|OPTIONS": ["preflight"],

  // ── realtime-token ───────────────────────────────────────────────────────
  "/api/extension/realtime-token|POST": ["write"],
  "/api/extension/realtime-token|OPTIONS": ["preflight"],

  // ── ro-context ───────────────────────────────────────────────────────────
  "/api/extension/ro-context|GET": ["read"],
  "/api/extension/ro-context|OPTIONS": ["preflight"],

  // ── session ───────────────────────────────────────────────────────────────
  // DELETE revokes the caller's own session; Basic must be able to log out.
  "/api/extension/session|DELETE": ["read"],
  "/api/extension/session|OPTIONS": ["preflight"],

  // ── sniffer-upload ───────────────────────────────────────────────────────
  // POST: admin — platform-admin-only debug tool
  "/api/extension/sniffer-upload|POST": ["admin"],
  "/api/extension/sniffer-upload|OPTIONS": ["preflight"],

  // ── specs ────────────────────────────────────────────────────────────────
  "/api/extension/specs|GET": ["read"],
  "/api/extension/specs|OPTIONS": ["preflight"],

  // ── sticker ──────────────────────────────────────────────────────────────
  "/api/extension/sticker|GET": ["read"],
  "/api/extension/sticker|POST": ["write"],
  "/api/extension/sticker|OPTIONS": ["preflight"],

  // ── support ──────────────────────────────────────────────────────────────
  "/api/extension/support|GET": ["read"],
  "/api/extension/support|POST": ["write"],
  "/api/extension/support|OPTIONS": ["preflight"],

  // ── tek-endpoint-report ──────────────────────────────────────────────────
  // POST: read — observability telemetry, fire-and-forget
  "/api/extension/tek-endpoint-report|POST": ["read"],
  "/api/extension/tek-endpoint-report|OPTIONS": ["preflight"],

  // ── tekmetric/add-declined-work ──────────────────────────────────────────
  "/api/extension/tekmetric/add-declined-work|POST": [
    "write",
    "provider_action",
  ],
  "/api/extension/tekmetric/add-declined-work|OPTIONS": ["preflight"],

  // ── tekmetric/deferred-work ──────────────────────────────────────────────
  "/api/extension/tekmetric/deferred-work|GET": ["read"],
  "/api/extension/tekmetric/deferred-work|OPTIONS": ["preflight"],

  // ── tekmetric/resolve-part-costs ─────────────────────────────────────────
  "/api/extension/tekmetric/resolve-part-costs|POST": ["read"],
  "/api/extension/tekmetric/resolve-part-costs|OPTIONS": ["preflight"],

  // ── tekmetric-migration/runs ─────────────────────────────────────────────
  "/api/extension/tekmetric-migration/runs|GET": ["admin"],
  "/api/extension/tekmetric-migration/runs|POST": ["admin"],
  "/api/extension/tekmetric-migration/runs|OPTIONS": ["preflight"],

  // ── tekmetric-migration/runs/[id] ────────────────────────────────────────
  "/api/extension/tekmetric-migration/runs/[id]|GET": ["admin"],
  "/api/extension/tekmetric-migration/runs/[id]|OPTIONS": ["preflight"],

  // ── tekmetric-migration/runs/[id]/dump ───────────────────────────────────
  "/api/extension/tekmetric-migration/runs/[id]/dump|POST": ["admin"],
  "/api/extension/tekmetric-migration/runs/[id]/dump|OPTIONS": ["preflight"],

  // ── tekmetric-migration/runs/[id]/load-core ──────────────────────────────
  "/api/extension/tekmetric-migration/runs/[id]/load-core|POST": ["admin"],
  "/api/extension/tekmetric-migration/runs/[id]/load-core|OPTIONS": [
    "preflight",
  ],

  // ── tekmetric-migration/runs/[id]/load-extras ────────────────────────────
  "/api/extension/tekmetric-migration/runs/[id]/load-extras|POST": ["admin"],
  "/api/extension/tekmetric-migration/runs/[id]/load-extras|OPTIONS": [
    "preflight",
  ],

  // ── tekmetric-migration/runs/[id]/override-clone ─────────────────────────
  "/api/extension/tekmetric-migration/runs/[id]/override-clone|POST": [
    "admin",
  ],
  "/api/extension/tekmetric-migration/runs/[id]/override-clone|OPTIONS": [
    "preflight",
  ],

  // ── tekmetric-migration/token-status ─────────────────────────────────────
  "/api/extension/tekmetric-migration/token-status|GET": ["admin"],
  "/api/extension/tekmetric-migration/token-status|OPTIONS": ["preflight"],

  // ── telemetry ────────────────────────────────────────────────────────────
  "/api/extension/telemetry|POST": ["read"],
  "/api/extension/telemetry|OPTIONS": ["preflight"],

  // ── vhi-coach ────────────────────────────────────────────────────────────
  "/api/extension/vhi-coach|POST": ["read"],
  "/api/extension/vhi-coach|OPTIONS": ["preflight"],

  // ── extension callers outside /api/extension ─────────────────────────────
  "/api/tekmetric/apply-canned-job|POST": ["write"],
  "/api/tekmetric/apply-canned-job|OPTIONS": ["preflight"],
  "/api/protractor/apply-canned-job|POST": ["write"],
  "/api/protractor/apply-canned-job|OPTIONS": ["preflight"],
  "/api/estimate-assist/audit|POST": ["read"],
  "/api/estimate-assist/audit|OPTIONS": ["preflight"],
  "/api/estimate-assist/job-builder|POST": ["read"],
  "/api/estimate-assist/job-builder|OPTIONS": ["preflight"],
  "/api/vehicle/common-failures|GET": ["read"],
  "/api/vehicle/common-failures|OPTIONS": ["preflight"],
};

/**
 * Normalise a URL pathname so dynamic [id] segments always use the
 * bracket syntax regardless of whether the caller passed a literal
 * run-id or the template form.
 *
 * e.g. "/api/extension/tekmetric-migration/runs/42/dump"
 *   → "/api/extension/tekmetric-migration/runs/[id]/dump"
 */
function normalisePath(pathname: string): string {
  return pathname.replace(
    /^(\/api\/extension\/tekmetric-migration\/runs)\/[^/]+/,
    "$1/[id]",
  );
}

/**
 * Look up the policy tiers for a given route pathname + HTTP method.
 *
 * Returns an array of PolicyTier values (never empty on a known route),
 * or `null` when the route+method combination is not registered in the
 * capability matrix.
 *
 * The returned array is read-only. Any mutation is a no-op on the original.
 *
 * @param pathname  URL pathname, e.g. "/api/extension/jobs/add-to-ro"
 * @param method    HTTP method in any case, e.g. "POST" or "post"
 */
export function lookupPolicy(
  pathname: string,
  method: string,
): Readonly<PolicyTier[]> | null {
  const key = `${normalisePath(pathname)}|${method.toUpperCase()}`;
  const entry = POLICY_MAP[key];
  return entry ?? null;
}

/**
 * Return true when the route+method is classified as public (no auth
 * required, i.e. it contains "public" or "preflight").
 */
export function isPublicRoute(pathname: string, method: string): boolean {
  const tiers = lookupPolicy(pathname, method);
  if (!tiers) return false;
  return tiers.includes("public") || tiers.includes("preflight");
}

/**
 * Return true when the route+method requires admin elevation (super-admin
 * or platform-admin) regardless of any other tiers it also holds.
 */
export function isAdminRoute(pathname: string, method: string): boolean {
  const tiers = lookupPolicy(pathname, method);
  if (!tiers) return false;
  return tiers.includes("admin");
}

/**
 * Return all registered pathnames (without method suffix) — useful for
 * lint scripts that need to iterate the full set.
 */
export function allRegisteredRoutes(): string[] {
  const seen = new Set<string>();
  for (const key of Object.keys(POLICY_MAP)) {
    seen.add(key.split("|")[0]);
  }
  return [...seen].sort();
}

/**
 * Return all registered method entries as `{ pathname, method, tiers }` tuples.
 * Useful for generating documentation or running completeness checks.
 */
export function allPolicyEntries(): Array<{
  pathname: string;
  method: string;
  tiers: Readonly<PolicyTier[]>;
}> {
  return Object.entries(POLICY_MAP).map(([key, tiers]) => {
    const [pathname, method] = key.split("|");
    return { pathname, method, tiers };
  });
}
