import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveStickerScan, STICKER_REPORT_TTL_MS } from "../lib/sticker-redirect";
import { createStickerQrTarget } from "../lib/sticker-qr-target";
import { getStickerRedirectUrl } from "../lib/sticker-utils";
import { verifyShareToken } from "../lib/report-share";

// Synthetic fixtures only. No live database, HoverCode calls, or signing key.
process.env.REPORT_SHARE_SECRET = "offline-sticker-test-only";
process.env.NEXT_PUBLIC_BASE_URL = "https://stickers.example.test";
const vin = "1HGCM82633A004352";
const ref = "a".repeat(24);
const shop = { stickerConfig: { scanDestination: "vhi" as const, appointmentUrl: "https://booking.example.test/" }, websiteUrl: "https://shop.example.test/" };
const deps = { resolveVehicle: async (r: string, shopId: number) => r === ref && shopId === 42 ? vin : null, canViewVhi: async () => true };

test("VHI scans mint fresh scoped, one-hour tokens without changing the token model", async () => {
  const now = Date.now();
  const first = await resolveStickerScan(shop, 42, ref, { ...deps, now: () => now });
  const second = await resolveStickerScan(shop, 42, ref, { ...deps, now: () => now + 1000 });
  assert.equal(first.kind, "vhi");
  const url = new URL(first.url!, "https://stickers.example.test");
  assert.equal(url.pathname, `/report/${vin}`);
  const token = url.searchParams.get("token")!;
  assert.deepEqual(verifyShareToken(token), { vin, shopId: "42" });
  assert.equal(Number(Buffer.from(token, "base64url").toString().split(":")[2]), now + STICKER_REPORT_TTL_MS);
  assert.notEqual(first.url, second.url);
});

test("missing, malformed, unknown, and cross-shop references fall back; denied entitlement does too", async () => {
  for (const reference of [null, "", "bad", "b".repeat(24)]) {
    assert.deepEqual(await resolveStickerScan(shop, 42, reference, deps), { kind: "appointment", url: shop.stickerConfig.appointmentUrl });
  }
  assert.equal((await resolveStickerScan(shop, 43, ref, deps)).kind, "appointment");
  assert.equal((await resolveStickerScan(shop, 42, ref, { ...deps, canViewVhi: async () => false })).kind, "appointment");
  assert.equal((await resolveStickerScan(shop, 42, ref, { ...deps, resolveVehicle: async () => "BADVIN" })).kind, "appointment");
});

test("destination preferences and safe fallback chain are honored", async () => {
  const never = { resolveVehicle: async () => { throw new Error("must not resolve VIN"); }, canViewVhi: async () => false };
  assert.equal((await resolveStickerScan({ ...shop, stickerConfig: { ...shop.stickerConfig, scanDestination: "website" } }, 42, ref, never)).kind, "website");
  assert.equal((await resolveStickerScan({ ...shop, stickerConfig: { appointmentUrl: shop.stickerConfig.appointmentUrl } }, 42, ref, never)).kind, "appointment");
  assert.equal((await resolveStickerScan({ stickerConfig: { scanDestination: "website", appointmentUrl: "https://booking.example.test/" } }, 42, ref, never)).kind, "appointment");
  assert.equal((await resolveStickerScan({ ...shop, stickerConfig: { scanDestination: "vhi" } }, 42, null, deps)).kind, "website");
  assert.deepEqual(await resolveStickerScan({ stickerConfig: { appointmentUrl: "javascript:alert(1)" } }, 42, null, deps), { kind: "none", url: null });
});

test("generation persists unguessable shop-scoped references, never tokens or raw destinations", async () => {
  const rows: any[] = [];
  const db: any = { collection: (name: string) => {
    assert.equal(name, "sticker_vehicle_references");
    return { insertOne: async (row: any) => rows.push(row) };
  } };
  assert.equal(await createStickerQrTarget(db, 42), getStickerRedirectUrl(42));
  assert.equal(rows.length, 0);
  const target = new URL(await createStickerQrTarget(db, 42, vin.toLowerCase()));
  assert.equal(target.pathname, "/api/sticker/redirect/42");
  assert.match(target.searchParams.get("v")!, /^[A-Za-z0-9_-]{24}$/);
  assert.equal(rows[0].shopId, 42);
  assert.equal(rows[0].vin, vin);
  assert.equal(rows[0]._id, target.searchParams.get("v"));
  assert.equal(target.searchParams.has("token"), false);
  const next = await createStickerQrTarget(db, 43, vin);
  assert.notEqual(next, target.href);
  assert.equal(await createStickerQrTarget(db, 42, "bad vin"), getStickerRedirectUrl(42));
  await assert.rejects(createStickerQrTarget({ collection: () => ({ insertOne: async () => { throw new Error("DB unavailable"); } }) } as any, 42, vin), /DB unavailable/);
});

test("all QR generation paths use first-party targets and isolate vehicle caches", () => {
  for (const path of [
    "app/api/sticker/generate/route.ts", "app/api/sticker/qr/route.ts",
    "app/api/sticker/regenerate-qr/route.ts", "app/api/extension/sticker/route-handler.ts",
  ]) {
    const src = readFileSync(path, "utf8");
    assert.match(src, /await createStickerQrTarget\(/, path);
    assert.doesNotMatch(src, /(?:appointmentUrl|customUrl)\s*\|\|\s*getStickerRedirectUrl/, path);
  }
  const generate = readFileSync("app/api/sticker/generate/route.ts", "utf8");
  assert.match(generate, /if \(genericQr\)/);
  assert.match(generate, /config\.qrTargetUrl === redirectUrl/);
  const cache = readFileSync("app/api/sticker/qr-cache/route.ts", "utf8");
  assert.match(cache, /targetUrl === appointmentUrl/);
  assert.match(cache, /const appointmentUrl = getStickerRedirectUrl\(shopId\)/);
  assert.match(cache, /data\.qr_data !== target/);
  const hovercode = readFileSync("lib/hovercode.ts", "utf8");
  assert.match(hovercode, /const destinationUrl = getStickerRedirectUrl/);
  const redirect = readFileSync("app/api/sticker/redirect/[shopId]/route.ts", "utf8");
  assert.match(redirect, /destinationKind: resolved.kind/);
  assert.match(redirect, /private, no-store/);
  assert.match(redirect, /shopId: id/);
});
