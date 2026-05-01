/**
 * Auth helper shared by every Detect-Dog migration API route.
 *
 * The wizard lives inside the MOS extension sidepanel, so requests come
 * in over CORS with a Bearer extension token (NOT a session cookie).
 * Each route still requires platform-admin role.
 */
import { NextRequest, NextResponse } from "next/server";
import { validateExtensionToken } from "@/lib/extension-auth";

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
  const auth = await validateExtensionToken(request);
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
  const isAdmin = user.role === "platform_admin" || user.isPlatformAdmin === true;
  if (!isAdmin) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Platform admin access required" },
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
