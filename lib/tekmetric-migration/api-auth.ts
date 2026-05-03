/**
 * Auth helper shared by every Detect-Dog migration API route.
 *
 * The wizard lives inside the MOS extension sidepanel, so requests come
 * in over CORS with a Bearer extension token (NOT a session cookie).
 * Each route requires super-admin (owner) access — i.e. an email in the
 * SUPER_ADMIN_EMAILS allowlist (lib/super-admins.ts). This is narrower
 * than platform_admin: regular platform admins are denied with 403.
 */
import { NextRequest, NextResponse } from "next/server";
import { validateExtensionToken } from "@/lib/extension-auth";
import { isSuperAdmin } from "@/lib/super-admins";

// Test seam: smoke tests swap these out so we can exercise the gate
// (super-admin email → ok, platform-admin-but-not-allowlisted → 403,
// regular user → 403, missing/invalid token → 401) without standing up
// a real Mongo + token row. See tests/tekmetric-migration-api-auth.smoke.ts.
export const __deps = {
  validateExtensionToken,
  isSuperAdmin,
};

export const tekMigCorsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export interface MigAuthOk {
  ok: true;
  user: {
    id: string;
    email: string | null;
    username: string | null;
    role: string;
  };
}

export interface MigAuthFail {
  ok: false;
  response: NextResponse;
}

// Shape of the raw user document attached to ExtensionAuthResult. Mongo
// gives us _id; some code paths add an `id` mirror. Both can be string or
// ObjectId. Typed locally to avoid `as any` at every read site.
interface RawExtensionUser {
  _id?: string | { toString(): string };
  id?: string | { toString(): string };
  email?: string | null;
  username?: string | null;
  role?: string | null;
  isPlatformAdmin?: boolean;
}

export async function requireMigAdmin(
  request: NextRequest,
): Promise<MigAuthOk | MigAuthFail> {
  const auth = await __deps.validateExtensionToken(request);
  if (!auth.authorized || !auth.user) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: auth.error || "Unauthorized" },
        { status: 401, headers: tekMigCorsHeaders },
      ),
    };
  }
  const user = auth.user as RawExtensionUser;
  // Migration is a super-admin-only tool (owner allowlist), not just any
  // platform admin. The extension UI also gates the tab on isSuperAdmin,
  // but this is the real security boundary — never trust the client gate.
  if (!__deps.isSuperAdmin(user.email)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Super admin access required" },
        { status: 403, headers: tekMigCorsHeaders },
      ),
    };
  }
  return {
    ok: true,
    user: {
      id: String(user._id || user.id || ""),
      email: user.email || null,
      username: user.username || null,
      role: user.role || "platform_admin",
    },
  };
}

export function migOptions() {
  return new NextResponse(null, { status: 204, headers: tekMigCorsHeaders });
}

export function migJson(body: any, init?: { status?: number }) {
  return NextResponse.json(body, {
    status: init?.status ?? 200,
    headers: tekMigCorsHeaders,
  });
}

export function migError(message: string, status = 500) {
  return migJson({ error: message }, { status });
}

export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const expiresIn30d = () => new Date(Date.now() + RETENTION_MS);
