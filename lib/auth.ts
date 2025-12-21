// lib/auth.ts
import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/mongo";
import { ENV } from "@/lib/env";

export const SESSION_COOKIE = "session_token";

export type SessionInfo = {
  token: string;
  shopId: number;
  email: string;
  role: string;
};

export async function getSession(): Promise<SessionInfo | null> {
  // ✅ Next.js 15: await cookies()
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  
  // Dev auto-login: skip auth in development mode
  if (!token && process.env.NODE_ENV === "development" && process.env.DEV_AUTO_LOGIN === "true") {
    const devShopId = Number(process.env.DEV_SHOP_ID || "1");
    const devEmail = process.env.DEV_USER_EMAIL || "dev@example.com";
    return {
      token: "dev-auto-login",
      shopId: devShopId,
      email: devEmail,
      role: "owner",
    };
  }
  
  if (!token) return null;

  const db = await getDb();
  const sess = await db.collection("sessions").findOne({
    token,
    expiresAt: { $gt: new Date() },
  });
  if (!sess) return null;

  const user = await db.collection("users").findOne(
    { _id: sess.userId },
    { projection: { email: 1, role: 1 } }
  );
  if (!user) return null;

  return {
    token,
    shopId: Number(sess.shopId),
    email: String(user.email),
    role: String(user.role ?? "owner"),
  };
}

export async function requireSession(): Promise<SessionInfo> {
  const s = await getSession();
  if (!s) redirect("/login");
  return s!; // Non-null assertion since redirect throws
}

export function sessionCookieOptions(maxAgeSeconds = 60 * 60 * 24 * 30) {
  return {
    httpOnly: true as const,
    secure: true as const,
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}
