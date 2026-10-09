import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import type { ExternalApiContext } from "./middleware";
import type { Db } from "mongodb";

const MAX_BYTES = 8192;
export interface PartnerVhiLink {
  _id: string;
  partnerId: "appfueled";
  shopId: number;
  vin: string;
  deliveryId: string;
  vhiUrl: string;
  receivedAt: Date;
}

export function parseVhiLink(body: any): Omit<PartnerVhiLink, "_id" | "partnerId" | "receivedAt"> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const shopId = Number(body.shopId);
  if (!/^[1-9]\d*$/.test(String(body.shopId)) || !Number.isSafeInteger(shopId)) return null;
  const vin = typeof body.vin === "string" ? body.vin.trim().toUpperCase() : "";
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return null;
  if (typeof body.deliveryId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(body.deliveryId)) return null;
  if (typeof body.vhiUrl !== "string" || body.vhiUrl.length > 4096) return null;
  try {
    const url = new URL(body.vhiUrl);
    if (url.protocol !== "https:" || url.username || url.password || !url.hostname.includes(".") ||
        /^[\d.]+$/.test(url.hostname) || url.hostname.startsWith("[") ||
        /(?:^|\.)(?:localhost|local|internal)$/.test(url.hostname)) return null;
    return { shopId, vin, deliveryId: body.deliveryId, vhiUrl: url.href };
  } catch { return null; }
}

export async function receiveVhiLink(req: NextRequest, context: ExternalApiContext, deps: {
  getDb: () => Promise<Db>;
  shopExists: (id: number) => Promise<boolean>;
  canUseVhi: (id: number) => Promise<boolean>;
}) {
  const { requestId } = context;
  const error = (message: string, status: number) => NextResponse.json({ error: message, requestId }, { status });
  if (!context.isPartner || context.partnerId?.toLowerCase() !== "appfueled") return error("AppFueled partner API key required", 403);
  if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return error("Content-Type must be application/json", 415);
  if (Number(req.headers.get("content-length")) > MAX_BYTES) return error("Body exceeds 8192 bytes", 413);
  const reader = req.body?.getReader();
  if (!reader) return error("JSON body required", 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) { await reader.cancel(); return error("Body exceeds 8192 bytes", 413); }
    chunks.push(value);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { return error("Malformed JSON", 400); }
  const link = parseVhiLink(parsed);
  if (!link) return error("Provide a positive MOS shopId, valid VIN, deliveryId (1–128 safe characters), and public HTTPS vhiUrl", 400);
  if (!await deps.shopExists(link.shopId)) return error("Shop not found", 404);
  if (!await deps.canUseVhi(link.shopId)) return error("Maintenance feature not enabled", 403);
  // Durable inbox, one immutable delivery per partner/shop/VIN/id. No external
  // URL is fetched, logged, or returned. Never allow a retry to overwrite a link.
  const _id = createHash("sha256").update(JSON.stringify(["appfueled", link.shopId, link.vin, link.deliveryId])).digest("hex");
  const collection = (await deps.getDb()).collection<PartnerVhiLink>("partner_vhi_links");
  let duplicate = false;
  try {
    await collection.insertOne({ _id, partnerId: "appfueled", ...link, receivedAt: new Date() });
  } catch (err: any) {
    if (err?.code !== 11000) throw err;
    const existing = await collection.findOne({ _id });
    if (!existing || existing.vhiUrl !== link.vhiUrl) return error("deliveryId already used with different content", 409);
    duplicate = true;
  }
  return NextResponse.json({ success: true, requestId, shopId: link.shopId, vin: link.vin, deliveryId: link.deliveryId, duplicate }, { headers: { "Cache-Control": "no-store" } });
}
