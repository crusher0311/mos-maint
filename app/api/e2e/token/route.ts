// app/api/e2e/token/route.ts
// Generate test tokens for E2E testing (only when E2E_TEST_SECRET is set)

import { NextRequest, NextResponse } from "next/server";
import { createTestToken, isTestAuthEnabled } from "@/lib/test-auth";

export async function POST(req: NextRequest) {
  if (!isTestAuthEnabled()) {
    return NextResponse.json(
      { error: "E2E testing not enabled" },
      { status: 403 }
    );
  }

  try {
    const body = await req.json();
    const { shopId, email, role, isPlatformAdmin, expiresInMs } = body;

    if (!shopId || !email || !role) {
      return NextResponse.json(
        { error: "Missing required fields: shopId, email, role" },
        { status: 400 }
      );
    }

    const token = createTestToken(
      {
        shopId: Number(shopId),
        email: String(email),
        role: String(role),
        isPlatformAdmin: Boolean(isPlatformAdmin),
      },
      expiresInMs
    );

    return NextResponse.json({ token });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || "Failed to create token" },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    enabled: isTestAuthEnabled(),
    message: isTestAuthEnabled()
      ? "E2E testing enabled. POST with { shopId, email, role } to get a token."
      : "E2E testing not enabled. Set E2E_TEST_SECRET environment variable.",
  });
}
