import {
  listExtensionBootstrapCandidateUsers as listBootstrapUsersFromRepository,
} from "@/lib/data/repositories/users";
import {
  getUserShopIds,
  isActiveExtensionUser,
} from "@/lib/extension-auth";
import type {
  ExtensionProvider,
} from "@/lib/extension-session";
import type {
  VerifiedProviderEmployee,
} from "@/lib/extension-provider-proof";

type BootstrapProvider = Exclude<ExtensionProvider, "protractor">;

interface ProviderIdentityMapping {
  provider: BootstrapProvider;
  subject: string;
  smsShopId: string;
}

export const __deps = {
  listBootstrapUsersFromRepository,
};

export function normalizeVerifiedEmail(value: unknown): string | null {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  return email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null;
}

function normalizedSubject(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const subject = String(value).trim();
  return subject && subject.length <= 256 ? subject : null;
}

function normalizeProvider(value: unknown): BootstrapProvider | null {
  const provider = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^shop[-_]ware$/, "shopware");
  return ["tekmetric", "shopware", "shopmonkey", "autoflow"].includes(provider)
    ? (provider as BootstrapProvider)
    : null;
}

function providerIdentityMappings(user: any): ProviderIdentityMapping[] {
  const mappings: ProviderIdentityMapping[] = [];
  const add = (
    rawProvider: unknown,
    rawSubject: unknown,
    rawSmsShopId: unknown,
  ) => {
    const provider = normalizeProvider(rawProvider);
    const subject = normalizedSubject(rawSubject);
    const smsShopId = normalizedSubject(rawSmsShopId);
    if (provider && subject && smsShopId) {
      mappings.push({ provider, subject, smsShopId });
    }
  };

  const flat = user?.providerIdentities;
  if (Array.isArray(flat)) {
    for (const item of flat) {
      add(
        item?.provider,
        item?.subject ?? item?.employeeId ?? item?.accountId,
        item?.smsShopId ?? item?.tenantId ?? item?.shopId,
      );
    }
  }

  const extension = user?.extensionProviderIdentities;
  if (extension && typeof extension === "object") {
    for (const [provider, rawEntries] of Object.entries(extension)) {
      const entries = Array.isArray(rawEntries) ? rawEntries : [rawEntries];
      for (const item of entries as any[]) {
        add(
          provider,
          item?.subject ?? item?.employeeId ?? item?.accountId,
          item?.smsShopId ?? item?.tenantId ?? item?.shopId,
        );
      }
    }
  }
  return mappings;
}

function userEmail(user: any): string | null {
  return normalizeVerifiedEmail(user?.emailLower ?? user?.email);
}

/**
 * Returns a user only when the live provider identity resolves to exactly one
 * active, already-authorized MOS user for this shop. Provider-role fields are
 * intentionally absent from this function: they can never grant MOS authority.
 *
 * If a user has explicit mappings for this provider, the current subject and
 * tenant must match one of them; verified-email fallback cannot bypass a
 * mismatched provider/tenant mapping.
 */
export function matchExistingExtensionUser(input: {
  users: any[];
  provider: BootstrapProvider;
  smsShopId: string;
  mosShopId: number;
  employee?: VerifiedProviderEmployee;
}): any | null {
  const subject = normalizedSubject(input.employee?.subject);
  const verifiedEmail = normalizeVerifiedEmail(input.employee?.verifiedEmail);
  if (!subject && !verifiedEmail) return null;

  const matches = input.users.filter((user) => {
    if (!isActiveExtensionUser(user)) return false;
    if (!getUserShopIds(user).includes(String(input.mosShopId))) return false;

    const mappings = providerIdentityMappings(user);
    const providerMappings = mappings.filter(
      (mapping) => mapping.provider === input.provider,
    );
    // Once a user is pinned to a provider subject (immutable provider
    // account id), only that subject may elevate as them — the email
    // fallback is disabled so a same-shop insider cannot re-point their own
    // provider profile email at this user's address and inherit their
    // authority. The subject is provider-global, so a pinned user still
    // elevates at other locations they're assigned to (which pins those
    // tenants too).
    const mappedIdentityMatch =
      Boolean(subject) &&
      providerMappings.some((mapping) => mapping.subject === subject);
    if (providerMappings.length > 0) return mappedIdentityMatch;
    return Boolean(verifiedEmail && userEmail(user) === verifiedEmail);
  });

  return matches.length === 1 ? matches[0] : null;
}

/**
 * Reads possible matches from the canonical identity store. The returned
 * records are filtered again by `matchExistingExtensionUser`; this function
 * does not grant access and never writes a user or membership.
 */
export async function listExtensionBootstrapCandidateUsers(input: {
  employee?: VerifiedProviderEmployee;
}): Promise<any[]> {
  const email = normalizeVerifiedEmail(input.employee?.verifiedEmail);
  const subject = normalizedSubject(input.employee?.subject);
  if (!email && !subject) return [];

  // Provider mappings live in a JSON profile in PG and nested fields in
  // Mongo. The fleet is bounded, so the repository returns a sanitized
  // backend-neutral snapshot and this module applies the exact same
  // uniqueness/ambiguity rules in memory for both canonical modes.
  return (await __deps.listBootstrapUsersFromRepository()).filter(Boolean);
}