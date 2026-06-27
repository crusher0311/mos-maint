/**
 * Inline SVG icons for VHI item status, exposed to API partners so they can
 * render the same visual language as our UI without shipping our CSS.
 *
 * Each SVG is self-contained, 16x16, currentColor-friendly where possible,
 * but ships explicit fill colors so it works in <img src="data:..."> contexts.
 */

import { readFileSync } from "fs";
import { join } from "path";
import type { ProgressStatus } from "@/lib/vhi-progress";
import {
  ICON_KEY_TO_IMAGE,
  DEFAULT_SERVICE_ICON_KEY,
  DVI_FINDING_ICON_KEY,
} from "@/lib/service-icons";

export type IconStatus = ProgressStatus | "deferred";

const ICON_SVGS: Record<IconStatus, string> = {
  overdue: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" role="img" aria-label="Overdue"><circle cx="8" cy="8" r="7" fill="#dc2626"/><rect x="7" y="3.5" width="2" height="6" rx="1" fill="#fff"/><rect x="7" y="10.5" width="2" height="2" rx="1" fill="#fff"/></svg>`,
  soon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" role="img" aria-label="Due soon"><circle cx="8" cy="8" r="7" fill="#f59e0b"/><path d="M8 4v4l2.5 2.5" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`,
  ok: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" role="img" aria-label="OK"><circle cx="8" cy="8" r="7" fill="#10b981"/><path d="M4.5 8.5l2.2 2.2L11.5 6" stroke="#fff" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`,
  deferred: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" role="img" aria-label="Deferred"><circle cx="8" cy="8" r="7" fill="#3b82f6"/><circle cx="5" cy="8" r="1" fill="#fff"/><circle cx="8" cy="8" r="1" fill="#fff"/><circle cx="11" cy="8" r="1" fill="#fff"/></svg>`,
};

export function getStatusIconSvg(status: IconStatus | null | undefined): string | null {
  if (!status) return null;
  return ICON_SVGS[status] ?? null;
}

/**
 * Top-level icon set partners can fetch once and reuse, instead of getting a
 * duplicate SVG string on every item. Returned as a plain object so it
 * serializes cleanly into JSON responses.
 */
export function getStatusIconSet(): Record<IconStatus, string> {
  return { ...ICON_SVGS };
}

// ---------------------------------------------------------------------------
// Service icons (the per-service pictograms: oil drop, differential, etc.)
//
// IMPORTANT: this is distinct from the status icons above. `getStatusIconSet`
// is the red/amber/green OVERDUE/SOON/OK/DEFERRED indicator. The service-icon
// set below is the per-service PICTOGRAM that matches what our customer-facing
// VHI shows. Partners resolve an item's `serviceIconKey` (emitted on every
// VHI item) and look it up in `getServiceIconSet()` to render the same icon.
//
// The artwork is the same `public/icons/service/*.svg` files our UI renders;
// we inline their markup here because a partner's domain can't load our
// relative `/icons/service/*.svg` paths. Read lazily and cached so we only
// touch the filesystem once per process.
// ---------------------------------------------------------------------------

/**
 * Hand-authored markup for the DVI-finding warning triangle. The component
 * renders this as JSX (it has no artwork file), so we mirror it here as a
 * self-contained SVG string. Uses an amber fill so it reads as a warning
 * regardless of the partner's surrounding text color.
 */
const DVI_FINDING_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32" role="img" aria-label="Inspection finding"><path d="M16 4 L28 26 L4 26 Z" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linejoin="round"/><line x1="16" y1="12" x2="16" y2="19" stroke="#f59e0b" stroke-width="2.5" stroke-linecap="round"/><circle cx="16" cy="23" r="1.5" fill="#f59e0b"/></svg>`;

/** Strip the XML prolog so each entry is self-contained inline markup. */
function normalizeSvg(raw: string): string {
  return raw.replace(/<\?xml[^>]*\?>\s*/i, "").trim();
}

let serviceIconCache: Record<string, string> | null = null;

function loadServiceIcons(): Record<string, string> {
  if (serviceIconCache) return serviceIconCache;
  const out: Record<string, string> = {};
  for (const [key, publicPath] of Object.entries(ICON_KEY_TO_IMAGE)) {
    try {
      const rel = publicPath.replace(/^\//, "");
      const abs = join(process.cwd(), "public", rel);
      out[key] = normalizeSvg(readFileSync(abs, "utf8"));
    } catch (err) {
      console.warn(
        `[vhi-icons] could not read service icon "${key}" (${publicPath}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  out[DVI_FINDING_ICON_KEY] = DVI_FINDING_SVG;
  serviceIconCache = out;
  return out;
}

/**
 * Inline SVG markup for a single service-icon key. Falls back to the general
 * service icon for unknown keys so callers never get a missing icon.
 */
export function getServiceIconSvg(key: string | null | undefined): string | null {
  if (!key) return null;
  const set = loadServiceIcons();
  return set[key] ?? set[DEFAULT_SERVICE_ICON_KEY] ?? null;
}

/**
 * Top-level service-icon set (icon-key -> inline SVG) partners fetch once per
 * response and reuse, instead of duplicating SVG markup on every item. Mirrors
 * the `getStatusIconSet()` pattern. Includes the general/default fallback so a
 * partner can always resolve any item's `serviceIconKey`.
 */
export function getServiceIconSet(): Record<string, string> {
  return { ...loadServiceIcons() };
}
