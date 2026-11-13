import type { NextRequest } from "next/server";

/** Browser authority is the public origin, not Render's internal bind address.
 * Never trust arbitrary Host or forwarded headers to extend this allowlist. */
export function isPrintBrowserOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  return origin === "https://mos.tools" ||
    (process.env.NODE_ENV !== "production" && origin === req.nextUrl.origin &&
      ["localhost", "127.0.0.1", "[::1]"].includes(req.nextUrl.hostname));
}
