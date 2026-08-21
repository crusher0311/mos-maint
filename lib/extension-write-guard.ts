/**
 * Lightweight write-permission check for extension routes that mutate
 * shop data (create RO, create contact, create vehicle, etc.).
 *
 * The platform doesn't yet have a fine-grained per-shop role model, so we
 * check the user's top-level role plus a couple of common opt-out flags:
 *
 *   - `role` of "viewer" / "read_only" → denied
 *   - `readOnly === true` → denied
 *
 * Platform admins always pass. Returns null when allowed, or a string error
 * message when denied (caller should respond with 403).
 *
 * This is intentionally permissive by default — owners, advisors, and
 * legacy users (no role set) all pass. The goal is to make the gate
 * explicit at the route level so we can tighten it later without touching
 * every endpoint.
 */
const READ_ONLY_ROLES = new Set(["viewer", "read_only", "readonly"]);

export function checkExtensionWritePermission(user: any): string | null {
  if (!user) return "Not authenticated";
  const principal = user.extensionPrincipal;
  if (
    principal &&
    (principal.assurance !== "verified" ||
      !Array.isArray(principal.capabilities) ||
      !principal.capabilities.includes("write"))
  ) {
    return "Verify your MOS.Tools account to make changes";
  }
  if (user.role === "platform_admin" || user.isPlatformAdmin === true) return null;
  if (user.readOnly === true) return "Your account is read-only";
  const role = (user.role || "").toString().toLowerCase();
  if (role && READ_ONLY_ROLES.has(role)) {
    return "Your role does not have permission to create repair orders";
  }
  return null;
}
