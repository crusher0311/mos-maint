// lib/test-auth.ts
// E2E Testing Auth Bypass - Only works when E2E_TEST_SECRET is set

import { createHmac } from "crypto";

export const TEST_AUTH_HEADER = "x-test-auth";

export type TestAuthPayload = {
  shopId: number;
  email: string;
  role: string;
  isPlatformAdmin?: boolean;
  exp: number; // Expiration timestamp
};

const getTestSecret = () => process.env.E2E_TEST_SECRET;

export function isTestAuthEnabled(): boolean {
  const secret = getTestSecret();
  return !!secret && secret.length >= 16;
}

export function createTestToken(payload: Omit<TestAuthPayload, "exp">, expiresInMs = 300000): string {
  const secret = getTestSecret();
  if (!secret) throw new Error("E2E_TEST_SECRET not configured");

  const fullPayload: TestAuthPayload = {
    ...payload,
    exp: Date.now() + expiresInMs,
  };

  const data = Buffer.from(JSON.stringify(fullPayload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(data).digest("base64url");

  return `${data}.${signature}`;
}

export function verifyTestToken(token: string): TestAuthPayload | null {
  const secret = getTestSecret();
  if (!secret) return null;

  try {
    const [data, signature] = token.split(".");
    if (!data || !signature) return null;

    const expectedSig = createHmac("sha256", secret).update(data).digest("base64url");
    if (signature !== expectedSig) return null;

    const payload: TestAuthPayload = JSON.parse(Buffer.from(data, "base64url").toString());

    if (payload.exp < Date.now()) return null;

    return payload;
  } catch {
    return null;
  }
}

export function getTestAuthFromHeaders(headers: Headers): TestAuthPayload | null {
  if (!isTestAuthEnabled()) return null;

  const token = headers.get(TEST_AUTH_HEADER);
  if (!token) return null;

  return verifyTestToken(token);
}
