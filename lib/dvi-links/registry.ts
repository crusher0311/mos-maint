// Task #860: DVI provider registry.
//
// Adding a new DVI provider is: add an entry here (domain matcher + parser)
// — the extraction, fetch, storage, and health pipeline pick it up
// automatically. Keep this module free of server-only imports.
import type { DviLinkProvider, DviParseResult } from "./types";
import { parseAutoVitalsReport } from "./parsers/autovitals";
import { parseAutoServe1Report } from "./parsers/autoserve1";
import { parseAutoFlowMicrosite } from "./parsers/autoflow";
import { parseMasterTechReport } from "./parsers/mastertech";

export interface DviProviderDef {
  provider: DviLinkProvider;
  label: string;
  /** Hostnames (suffix match) whose share links belong to this provider. */
  hosts: string[];
  /**
   * Optional path prefix filter — when set, only URLs whose pathname starts
   * with one of these prefixes are treated as share links.
   */
  pathPrefixes?: string[];
  /**
   * Parses a fetched report body into the common record. `null` parser means
   * detection + health tracking only (parseStatus "na"), e.g. media links.
   */
  parse: ((body: string, sourceUrl: string) => DviParseResult) | null;
  /** True when link bodies are media (images/video), not HTML reports. */
  mediaOnly?: boolean;
}

export const DVI_PROVIDERS: DviProviderDef[] = [
  {
    provider: "autoserve1",
    label: "AutoServe1",
    hosts: ["app.autoserve1.com"],
    pathPrefixes: ["/report/"],
    parse: parseAutoServe1Report,
  },
  {
    provider: "autovitals",
    label: "AutoVitals",
    // avlink.io short links 302 → tvpx.autovitals.com/InspectionResults.aspx
    hosts: ["avlink.io", "tvpx.autovitals.com"],
    parse: parseAutoVitalsReport,
  },
  {
    provider: "mastertech",
    label: "MasterTech.ai",
    hosts: ["app.mastertech.ai", "mastertech.ai"],
    parse: parseMasterTechReport,
  },
  {
    provider: "autoops",
    label: "AutoOps",
    hosts: ["aops.cc", "dashboard.autoops.com"],
    // Share links redirect to hosted media (JPEG/video) — no HTML report.
    parse: null,
    mediaOnly: true,
  },
  {
    provider: "autoflow",
    label: "AutoFlow microsite",
    hosts: ["autotext.me"],
    pathPrefixes: ["/admin/microsite", "/microsite"],
    parse: parseAutoFlowMicrosite,
  },
];

export function providerForUrl(rawUrl: string): DviProviderDef | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const path = u.pathname.toLowerCase();
  for (const def of DVI_PROVIDERS) {
    const hostMatch = def.hosts.some(
      (h) => host === h || host.endsWith(`.${h}`),
    );
    if (!hostMatch) continue;
    if (def.pathPrefixes && !def.pathPrefixes.some((p) => path.startsWith(p))) {
      continue;
    }
    return def;
  }
  return null;
}

export function providerDef(provider: DviLinkProvider): DviProviderDef {
  const def = DVI_PROVIDERS.find((d) => d.provider === provider);
  if (!def) throw new Error(`Unknown DVI provider: ${provider}`);
  return def;
}
