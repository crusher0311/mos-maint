import crypto from "node:crypto";
import { consumeExtensionActionGrantUse } from "@/lib/data/repositories/pg/identity";

const GRANT_PREFIX = "extg_";
const DEFAULT_TTL_SECONDS = 90;

export interface ExtensionActionGrantClaims {
  version: 1;
  sessionId: string;
  shopId: number;
  provider: string;
  action: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

function encode(value: string | Buffer): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function decode(value: string): Buffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, "base64");
}

function signingSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET is required to issue extension action grants");
  }
  return secret;
}

export const __deps = {
  consumeExtensionActionGrantUse,
};

export function issueExtensionActionGrant(input: {
  sessionId: string;
  shopId: number;
  provider: string;
  action: string;
  ttlSeconds?: number;
  now?: Date;
}): { grant: string; claims: ExtensionActionGrantClaims } {
  if (!/^[a-z0-9._:-]{1,80}$/i.test(input.action)) {
    throw new Error("Invalid provider action");
  }
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const ttl = Math.max(15, Math.min(input.ttlSeconds ?? DEFAULT_TTL_SECONDS, 120));
  const claims: ExtensionActionGrantClaims = {
    version: 1,
    sessionId: input.sessionId,
    shopId: input.shopId,
    provider: input.provider,
    action: input.action,
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + ttl,
    nonce: crypto.randomBytes(12).toString("hex"),
  };
  const payload = encode(JSON.stringify(claims));
  const signature = encode(
    crypto.createHmac("sha256", signingSecret()).update(payload).digest(),
  );
  return { grant: `${GRANT_PREFIX}${payload}.${signature}`, claims };
}

export function verifyExtensionActionGrant(
  grant: string,
  expected: {
    sessionId: string;
    shopId: number;
    provider: string;
    action: string;
    now?: Date;
  },
): ExtensionActionGrantClaims | null {
  const claims = verifyExtensionActionGrantSignature(grant, expected.now);
  if (!claims) return null;
  if (
    claims.sessionId !== expected.sessionId ||
    claims.shopId !== expected.shopId ||
    claims.provider !== expected.provider ||
    claims.action !== expected.action
  ) {
    return null;
  }
  return claims;
}

export function verifyExtensionActionGrantSignature(
  grant: string,
  nowDate = new Date(),
): ExtensionActionGrantClaims | null {
  if (!grant.startsWith(GRANT_PREFIX)) return null;
  const [payload, signature] = grant.slice(GRANT_PREFIX.length).split(".");
  if (!payload || !signature) return null;
  // Compare the *encoded* signature strings, not decoded bytes. Base64url has
  // discarded trailing bits, so many strings decode to the same bytes; a
  // byte-level compare accepts those non-canonical spellings. That both made
  // the forged-signature smoke test flaky (a last-char flip can be a decode
  // no-op ~25% of the time) and — worse — let one logical grant exist under
  // multiple spellings with distinct grantHash values, side-stepping the
  // one-time replay guard.
  const expectedSignature = Buffer.from(
    encode(crypto.createHmac("sha256", signingSecret()).update(payload).digest()),
  );
  const actualSignature = Buffer.from(signature);
  if (
    expectedSignature.length !== actualSignature.length ||
    !crypto.timingSafeEqual(expectedSignature, actualSignature)
  ) {
    return null;
  }
  // Reject non-canonical payload spellings for the same reason: the replay
  // ledger hashes the full grant string.
  if (encode(decode(payload)) !== payload) return null;
  let claims: ExtensionActionGrantClaims;
  try {
    claims = JSON.parse(decode(payload).toString("utf8"));
  } catch {
    return null;
  }
  const now = Math.floor(nowDate.getTime() / 1000);
  if (
    claims.version !== 1 ||
    claims.expiresAt <= now ||
    claims.issuedAt > now + 30 ||
    claims.expiresAt > now + 120
  ) {
    return null;
  }
  return claims;
}

export async function consumeExtensionActionGrant(
  grant: string,
  expected: { provider: string; action: string; now?: Date },
): Promise<{
  status: "consumed" | "replayed" | "inactive_session" | "invalid";
  claims?: ExtensionActionGrantClaims;
}> {
  const now = expected.now ?? new Date();
  const claims = verifyExtensionActionGrantSignature(grant, now);
  if (
    !claims ||
    claims.provider !== expected.provider ||
    claims.action !== expected.action
  ) {
    return { status: "invalid" };
  }
  const status = await __deps.consumeExtensionActionGrantUse({
    grantHash: crypto.createHash("sha256").update(grant).digest("hex"),
    sessionId: claims.sessionId,
    expiresAt: new Date(claims.expiresAt * 1000),
    now,
  });
  return { status, claims };
}