// Co-fire stress trigger: kick Tekmetric + Protractor + Shop-Ware backfill
// chunks within the same ~5s window so we can measure peak combined load
// without waiting for the natural cadence stagger to align (rare). Guarded
// by `BACKFILL_COFIRE_STRESS=true` so it never fires from a regular admin
// session — the admin POST endpoint also requires platform-admin auth.

export const COFIRE_PROVIDERS = [
  { name: "tekmetric", path: "/api/cron/tekmetric-backfill" },
  { name: "protractor", path: "/api/cron/protractor-backfill" },
  { name: "shopware", path: "/api/cron/shopware-backfill" },
] as const;

export interface CofireResult {
  provider: string;
  path: string;
  ok: boolean;
  status: number;
  durationMs: number;
  error?: string;
  responseSnippet?: string;
}

export interface RunCofireOptions {
  baseUrl: string;
  cronSecret: string;
  timeoutMs?: number;
}

export async function runCofireStress(opts: RunCofireOptions): Promise<{
  startedAt: Date;
  results: CofireResult[];
}> {
  const startedAt = new Date();
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;

  const results = await Promise.all(
    COFIRE_PROVIDERS.map(async (p) => {
      const startedAtMs = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(`${opts.baseUrl}${p.path}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${opts.cronSecret}` },
          signal: controller.signal,
        });
        const text = await res.text().catch(() => "");
        return {
          provider: p.name,
          path: p.path,
          ok: res.ok,
          status: res.status,
          durationMs: Date.now() - startedAtMs,
          responseSnippet: text.slice(0, 400),
        } satisfies CofireResult;
      } catch (err: any) {
        return {
          provider: p.name,
          path: p.path,
          ok: false,
          status: 0,
          durationMs: Date.now() - startedAtMs,
          error: err?.name === "AbortError" ? "timeout" : err?.message || String(err),
        } satisfies CofireResult;
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  return { startedAt, results };
}

export function isCofireEnabled(): boolean {
  return process.env.BACKFILL_COFIRE_STRESS === "true";
}
