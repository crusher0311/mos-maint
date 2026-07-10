// lib/enrollment.ts
//
// Shop enrollment code (QR self-signup) helpers. The enrollment config
// lives on the shop doc under `enrollment`:
//   { enabled, code, mode: "instant" | "approval", defaultRole, rotatedAt }
//
// Codes are 16-char base64url (96 bits of entropy) and are only ever
// compared exactly. Enrollment can NEVER grant elevated roles — the
// default role is limited to the allowlist below.
import crypto from "node:crypto";
import { getAppBaseUrl } from "@/lib/app-host";

export const ENROLLMENT_ALLOWED_ROLES = ["user", "viewer"] as const;
export type EnrollmentRole = (typeof ENROLLMENT_ALLOWED_ROLES)[number];

export type EnrollmentMode = "instant" | "approval";

export interface EnrollmentConfig {
  enabled: boolean;
  code: string | null;
  mode: EnrollmentMode;
  defaultRole: EnrollmentRole;
  rotatedAt: Date | null;
  // In "approval" mode, signups whose email domain matches one of these
  // are auto-approved (skip the pending queue). Empty = every signup in
  // approval mode waits for an admin. Ignored in "instant" mode (everyone
  // is instant there anyway).
  autoApproveDomains: string[];
}

const MAX_AUTO_APPROVE_DOMAINS = 25;

export function generateEnrollmentCode(): string {
  return crypto.randomBytes(12).toString("base64url");
}

export function isValidEnrollmentRole(role: unknown): role is EnrollmentRole {
  return ENROLLMENT_ALLOWED_ROLES.includes(role as EnrollmentRole);
}

export function isValidEnrollmentMode(mode: unknown): mode is EnrollmentMode {
  return mode === "instant" || mode === "approval";
}

/**
 * Clean up an admin-supplied list of domains: lowercase, strip a leading
 * "@" or "*." wildcard, drop anything that isn't a plausible domain, then
 * de-dupe and cap the length. Returns [] for anything unusable.
 */
export function normalizeAutoApproveDomains(input: unknown): string[] {
  const raw: string[] = Array.isArray(input)
    ? input.map((d) => String(d))
    : typeof input === "string"
      ? input.split(/[\s,;]+/)
      : [];

  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const domain = item
      .trim()
      .toLowerCase()
      .replace(/^@/, "")
      .replace(/^\*\./, "");
    if (!domain) continue;
    // Must look like example.com: labels separated by dots, valid TLD.
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
      continue;
    }
    if (seen.has(domain)) continue;
    seen.add(domain);
    out.push(domain);
    if (out.length >= MAX_AUTO_APPROVE_DOMAINS) break;
  }
  return out;
}

/** True if the email's domain is covered by the allowlist (exact match). */
export function emailDomainAutoApproved(email: string, domains: string[]): boolean {
  if (!domains.length) return false;
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return domain.length > 0 && domains.includes(domain);
}

/** Normalize whatever is stored on the shop doc into a full config. */
export function readEnrollmentConfig(shop: any): EnrollmentConfig {
  const e = shop?.enrollment || {};
  return {
    enabled: e.enabled === true,
    code: typeof e.code === "string" && e.code.length >= 12 ? e.code : null,
    mode: isValidEnrollmentMode(e.mode) ? e.mode : "instant",
    defaultRole: isValidEnrollmentRole(e.defaultRole) ? e.defaultRole : "user",
    rotatedAt: e.rotatedAt ? new Date(e.rotatedAt) : null,
    autoApproveDomains: normalizeAutoApproveDomains(e.autoApproveDomains),
  };
}

export function buildJoinUrl(code: string): string {
  return `${getAppBaseUrl()}/join/${encodeURIComponent(code)}`;
}
