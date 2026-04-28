import { createHmac } from "crypto";

export const MUST_CHANGE_PASSWORD_COOKIE = "mcp_flag";

function getSecret(): string {
  return (
    process.env.SESSION_SECRET ||
    "development-secret-that-is-at-least-32-characters-long"
  );
}

export function signMustChangePasswordToken(sessionToken: string): string {
  return createHmac("sha256", getSecret())
    .update(`mcp:${sessionToken}`)
    .digest("base64url");
}

export function mustChangePasswordCookieOptions(maxAgeSeconds = 60 * 60 * 24 * 30) {
  return {
    httpOnly: true as const,
    secure: true as const,
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}
