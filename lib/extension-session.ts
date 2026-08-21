import crypto from "node:crypto";
import {
  findExtensionSessionByTokenHash,
  insertExtensionSession,
  revokeExtensionSessionById,
  touchExtensionSession,
  type ExtensionSessionRow,
} from "@/lib/data/repositories/pg/identity";

export type ExtensionAssurance = "basic" | "verified";
export type ExtensionCapability = "read" | "write" | "admin" | "provider_action";
export type ExtensionProvider =
  | "tekmetric"
  | "protractor"
  | "shopware"
  | "shopmonkey"
  | "autoflow";

export interface ExtensionSessionPrincipal {
  sessionId: string;
  userId?: string;
  shopId?: number;
  provider?: ExtensionProvider;
  assurance: ExtensionAssurance;
  capabilities: ExtensionCapability[];
  expiresAt: Date;
  isLegacy?: boolean;
}

export type ExtensionSessionLookup =
  | { status: "active"; principal: ExtensionSessionPrincipal }
  | { status: "expired" | "revoked" | "invalid" };

const TOKEN_PREFIX = "exts_";
const VERIFIED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const BASIC_TTL_MS = 8 * 60 * 60 * 1000;

/** Test seam: security tests replace storage without touching Postgres. */
export const __deps = {
  findExtensionSessionByTokenHash,
  insertExtensionSession,
  revokeExtensionSessionById,
  touchExtensionSession,
};

export function hashExtensionSessionToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function newToken(): string {
  return `${TOKEN_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
}

function capabilitiesFor(
  assurance: ExtensionAssurance,
  isAdmin = false,
  canWrite = true,
): ExtensionCapability[] {
  return assurance === "basic"
    ? ["read"]
    : [
        "read",
        ...(canWrite ? (["write", "provider_action"] as const) : []),
        ...(isAdmin ? ["admin" as const] : []),
      ];
}

export async function issueExtensionSession(input: {
  shopId: number;
  provider: ExtensionProvider;
  assurance: ExtensionAssurance;
  userId?: string;
  isAdmin?: boolean;
  canWrite?: boolean;
  expiresAt?: Date;
}): Promise<{ token: string; principal: ExtensionSessionPrincipal }> {
  if (input.assurance === "verified" && !input.userId) {
    throw new Error("Verified extension sessions require a user identity");
  }
  if (input.assurance === "basic" && input.userId) {
    throw new Error("Basic extension sessions cannot be linked to a user");
  }
  if (
    input.assurance === "basic" &&
    process.env.EXTENSION_BASIC_SESSIONS_DISABLED === "true"
  ) {
    throw new Error("Basic extension sessions are disabled");
  }
  const token = newToken();
  const now = new Date();
  const expiresAt =
    input.expiresAt ??
    new Date(now.getTime() + (input.assurance === "basic" ? BASIC_TTL_MS : VERIFIED_TTL_MS));
  const capabilities = capabilitiesFor(
    input.assurance,
    input.isAdmin,
    input.canWrite !== false,
  );
  const tokenHash = hashExtensionSessionToken(token);
  const row = await __deps.insertExtensionSession({
    id: crypto.randomUUID(),
    tokenHash,
    userId: input.userId ?? null,
    shopId: input.shopId,
    provider: input.provider,
    assurance: input.assurance,
    capabilities,
    expiresAt,
    createdAt: now,
    lastUsedAt: now,
  });
  console.info(
    `[Extension Session] issued assurance=${input.assurance} shop=${input.shopId} provider=${input.provider}`,
  );
  return {
    token,
    principal: {
      sessionId: row.id,
      userId: row.userId ?? undefined,
      shopId: row.shopId,
      provider: row.provider as ExtensionProvider,
      assurance: row.assurance as ExtensionAssurance,
      capabilities: row.capabilities as ExtensionCapability[],
      expiresAt: row.expiresAt,
    },
  };
}

/**
 * Server-side-only issuer used by passwordless shop-resolution flows. It does
 * not create or modify a MOS.Tools user. Callers must establish the shop proof
 * before invoking this helper.
 */
export async function issueBasicExtensionSession(input: {
  shopId: number;
  provider: ExtensionProvider;
  expiresAt?: Date;
}): Promise<{ token: string; principal: ExtensionSessionPrincipal }> {
  return issueExtensionSession({
    ...input,
    assurance: "basic",
  });
}

function rowToPrincipal(row: ExtensionSessionRow): ExtensionSessionPrincipal {
  return {
    sessionId: row.id,
    userId: row.userId ?? undefined,
    shopId: row.shopId,
    provider: row.provider as ExtensionProvider,
    assurance: row.assurance as ExtensionAssurance,
    capabilities: row.capabilities as ExtensionCapability[],
    expiresAt: row.expiresAt,
  };
}

export async function lookupExtensionSession(token: string): Promise<ExtensionSessionLookup> {
  if (!token.startsWith(TOKEN_PREFIX)) return { status: "invalid" };
  const row = await __deps.findExtensionSessionByTokenHash(hashExtensionSessionToken(token));
  if (!row) return { status: "invalid" };
  if (row.revokedAt) return { status: "revoked" };
  if (row.expiresAt.getTime() <= Date.now()) return { status: "expired" };
  void __deps.touchExtensionSession(row.id)
    .catch((error) => console.warn("[Extension Session] unable to update use timestamp", error));
  return { status: "active", principal: rowToPrincipal(row) };
}

export async function revokeExtensionSession(sessionId: string): Promise<void> {
  await __deps.revokeExtensionSessionById(sessionId);
}

export function hasExtensionCapability(
  principal: Pick<ExtensionSessionPrincipal, "capabilities"> | undefined,
  capability: ExtensionCapability,
): boolean {
  return Boolean(principal?.capabilities.includes(capability));
}