// tests/e2e/test-utils.ts
// E2E Test Utilities

import { createHmac } from "crypto";

const TEST_AUTH_HEADER = "x-test-auth";

type TestAuthPayload = {
  shopId: number;
  email: string;
  role: string;
  isPlatformAdmin?: boolean;
};

export function createTestToken(
  payload: TestAuthPayload,
  secret: string,
  expiresInMs = 300000
): string {
  const fullPayload = {
    ...payload,
    exp: Date.now() + expiresInMs,
  };

  const data = Buffer.from(JSON.stringify(fullPayload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(data).digest("base64url");

  return `${data}.${signature}`;
}

export function testFetch(
  baseUrl: string,
  secret: string,
  defaultAuth: TestAuthPayload = { shopId: 25, email: "test@example.com", role: "owner" }
) {
  return async function (
    path: string,
    options: RequestInit & { auth?: TestAuthPayload | false } = {}
  ): Promise<Response> {
    const { auth, ...fetchOptions } = options;
    const headers = new Headers(fetchOptions.headers);

    if (auth !== false) {
      const token = createTestToken(auth || defaultAuth, secret);
      headers.set(TEST_AUTH_HEADER, token);
    }

    return fetch(`${baseUrl}${path}`, {
      ...fetchOptions,
      headers,
    });
  };
}

export type TestResult = {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
};

export async function runTest(
  name: string,
  testFn: () => Promise<void>
): Promise<TestResult> {
  const start = Date.now();
  try {
    await testFn();
    return { name, passed: true, duration: Date.now() - start };
  } catch (error: any) {
    return {
      name,
      passed: false,
      error: error.message || String(error),
      duration: Date.now() - start,
    };
  }
}

export function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

export function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(
      `${message || "Assertion failed"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

export function assertOk(response: Response, message?: string): void {
  if (!response.ok) {
    throw new Error(
      `${message || "Request failed"}: ${response.status} ${response.statusText}`
    );
  }
}
