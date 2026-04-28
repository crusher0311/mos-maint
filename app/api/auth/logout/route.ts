import { NextResponse } from "next/server";
import { cookies } from "next/headers";

export const runtime = "nodejs";

export async function POST() {
  const store = await cookies(); // ⬅️ await

  // read if you need it for logging
  const token = store.get("session_token")?.value ?? store.get("sid")?.value;

  // clear either cookie name you might be using
  store.set({
    name: "session_token",
    value: "",
    path: "/",
    maxAge: 0,
  });
  store.set({
    name: "sid",
    value: "",
    path: "/",
    maxAge: 0,
  });
  // Also clear the must-change-password gating cookie so a stale value
  // doesn't keep redirecting the next person to log in on this device.
  store.set({
    name: "mcp_flag",
    value: "",
    path: "/",
    maxAge: 0,
  });

  return NextResponse.json({ ok: true });
}
