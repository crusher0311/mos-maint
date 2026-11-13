import { NextRequest, NextResponse } from "next/server";
import { requireSession, verifiedGhostAdminEmail } from "@/lib/auth";
import { checkShopFeatureGate } from "@/lib/extension-route-guard";
import { findShopByShopId } from "@/lib/data/repositories/shops";
import { installerRelease, installerBytes } from "@/lib/data/repositories/print-setup";
import { beginPairing, pairingStatus, approvePairing } from "./setup-pairing";
import { readPrintJsonBody } from "./request-body";
import { clientIp, rateLimit } from "@/lib/rate";
const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
const json = (value: unknown, status = 200) => NextResponse.json(value, { status, headers });
async function manager(req: NextRequest, write = false) {
  const user = await requireSession();
  const ghostAdmin = user.isImpersonation ? await verifiedGhostAdminEmail(user) : null;
  if (!Number.isSafeInteger(user.shopId) || user.shopId <= 0 ||
      (user.isImpersonation ? !ghostAdmin : !(user.isPlatformAdmin || ["owner", "admin", "manager"].includes(user.role))))
    throw new Error("Manager access required");
  if (write && req.headers.get("origin") !== req.nextUrl.origin) throw new Error("Same-origin approval required");
  // Only the explicitly approved pilot location may install/connect this build.
  if (user.shopId !== 63) throw new Error("Computer setup is not enabled for this pilot location");
  const gate = await checkShopFeatureGate(user.shopId, ["oil_sticker"]);
  if (gate) throw new Error("Sticker printing is not available for this shop");
  return { ...user, setupActorEmail: ghostAdmin || user.email };
}
export async function setupInfo(req: NextRequest) {
  try {
    const user = await manager(req);
    const shop = await findShopByShopId(user.shopId);
    if (!shop || typeof shop.name !== "string" || !shop.name.trim()) return json({ error: "Shop identity unavailable" }, 404);
    const release = await installerRelease();
    return json({ shopId: user.shopId, shopName: shop.name, canManage: true, installer: {
      available: !!release, downloadUrl: release ? "/api/print/setup/installer" : null,
      version: "pairing-v1", sha256: release?.sha256 ?? null,
    } });
  } catch { return json({ error: "Setup unavailable. Sign in as a shop manager with sticker printing access." }, 403); }
}
export async function downloadInstaller(req: NextRequest) {
  try {
    await manager(req);
    return new NextResponse(new Uint8Array(await installerBytes()), { headers: { ...headers,
      "Content-Type": "application/octet-stream",
      "Content-Disposition": 'attachment; filename="MOS-Print-Setup-pilot.exe"',
      "X-Content-Type-Options": "nosniff",
    } });
  } catch { return json({ error: "Installer unavailable. Check your access or contact support." }, 503); }
}
export async function approveSetup(req: NextRequest) {
  try {
    const user = await manager(req, true);
    const body = await readPrintJsonBody(req, 4096);
    if (body.shopId !== user.shopId) return json({ error: "Your selected shop changed. Reload setup before approving." }, 409);
    const shop = await findShopByShopId(user.shopId);
    if (!shop || typeof shop.name !== "string" || !shop.name.trim()) return json({ error: "Shop identity unavailable" }, 404);
    const rl = await rateLimit({ id: `print-setup-approve:${user.shopId}:${user.userId}`, limit: 10, windowSeconds: 600 });
    if (!rl.allowed) return json({ error: "Too many setup attempts. Wait before retrying." }, 429);
    return json(await approvePairing(body.pairingToken, { shopId: user.shopId, name: shop.name }, user.setupActorEmail));
  } catch { return json({ error: "Connection not approved. Check manager access, shop, and setup expiration before trying again." }, 403); }
}
// Intentionally unauthenticated device bootstrap. A random device capability,
// RSA private-key possession, and an explicit manager approval are all required.
export async function deviceSetup(req: NextRequest) {
  try {
    const rl = await rateLimit({ id: `print-device:${clientIp(req)}`, limit: 60, windowSeconds: 600 });
    if (!rl.allowed) return json({ error: "Wait before retrying setup." }, 429);
    const body = await readPrintJsonBody(req, 4096);
    if (body.action === "begin") {
      const starts = await rateLimit({ id: `print-device-start:${clientIp(req)}`, limit: 5, windowSeconds: 600 });
      if (!starts.allowed) return json({ error: "Wait before starting another setup." }, 429);
      return json(await beginPairing(body.publicKey));
    }
    if (body.action === "status") return json(await pairingStatus(body.pairingToken));
    return json({ error: "Invalid setup action" }, 400);
  } catch { return json({ error: "Setup unavailable or expired. Restart from the wizard." }, 400); }
}
