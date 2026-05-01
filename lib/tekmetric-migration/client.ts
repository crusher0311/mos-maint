/**
 * Shared Tekmetric internal-API client used by every migration phase.
 *
 * Mirrors the `jsonFetch` helper in the proven snippets
 * (scripts/one-off/tekmetric-open-jobs-migration-2026-04-30/*) so the
 * server-side orchestrator emits identical wire calls.  The only changes
 * vs. the snippets:
 *   - `base` is parameterised (snippets default to `location.origin`),
 *     defaulting here to https://shop.tekmetric.com.
 *   - We do NOT send `credentials: 'include'`; the server has no cookies
 *     to forward.  `x-auth-token` alone is accepted by Tekmetric's
 *     internal API.
 */

export const TEKMETRIC_DEFAULT_BASE = "https://shop.tekmetric.com";

export interface TekFetchOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  headers?: Record<string, string>;
  base?: string;
}

export class TekFetchError extends Error {
  status: number;
  body: string;
  path: string;

  constructor(status: number, statusText: string, path: string, body: string) {
    super(
      `${status} ${statusText} on ${path} :: ${body.slice(0, 300)}`,
    );
    this.name = "TekFetchError";
    this.status = status;
    this.body = body;
    this.path = path;
  }
}

export async function tekFetch<T = any>(
  token: string,
  path: string,
  opts: TekFetchOptions = {},
): Promise<T | null> {
  const base = opts.base || TEKMETRIC_DEFAULT_BASE;
  const url = path.startsWith("http") ? path : `${base}${path}`;
  const init: RequestInit = {
    method: opts.method || "GET",
    headers: {
      "x-auth-token": token,
      "content-type": "application/json",
      accept: "application/json",
      ...(opts.headers || {}),
    },
  };
  if (opts.body !== undefined) {
    init.body =
      typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  }
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new TekFetchError(res.status, res.statusText, path, body);
  }
  if (res.status === 204) return null;
  return res.json();
}

/**
 * appointmentOption GET returns string enum, POST expects numeric Long.
 * Confirmed in HAR: "DROP" -> 2.
 */
export const APPT_OPTION_MAP: Record<string, number> = {
  DROP: 2,
  WAIT: 1,
  PICKUP: 3,
};

export function normalizeApptOption(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return APPT_OPTION_MAP[v] ?? 2;
  return 2;
}

/** Migration marker — same string format as snippet 02. */
export function migrationMarker(sourceRoNumber: string | number): string {
  return `[migrated from RO#${sourceRoNumber}]`;
}

export const MIGRATION_MARKER_RE = /\[migrated from RO#(\d+)\]/;

export function inspectionTitleMarker(srcInspectionId: string | number): string {
  return `[migrated ins#${srcInspectionId}]`;
}

export const INSPECTION_TITLE_MARKER_RE = /\[migrated ins#(\S+?)\]/;

export const PHOTO_NOTE_MARKER = "[migrated]";
