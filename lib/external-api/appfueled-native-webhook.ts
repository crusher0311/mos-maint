import { createHash, randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { BodyError, readBoundedJson } from "./bounded-json";
import { parseVhiLink, persistVhiLink, type VhiLinkDependencies } from "./vhi-link-webhook";

type NativeDeps = VhiLinkDependencies & {
  resolveConnection: (id: string) => Promise<{ shopId: number; connectionHash: string } | null>;
  admit: (bucket: string, limit: number) => Promise<boolean>;
};

export function createAppFueledLinkEndpoint(
  legacy: (req: NextRequest) => Promise<NextResponse>,
  deps: NativeDeps,
) {
  return async (req: NextRequest) => {
    const inbound = req.headers.get("x-request-id") || req.headers.get("x-correlation-id");
    const requestId = inbound && /^[A-Za-z0-9._:-]{1,128}$/.test(inbound) ? inbound : randomUUID();
    const reply = (error: string, status: number) => NextResponse.json({ error, requestId }, {
      status, headers: { "X-Request-Id": requestId, "Cache-Control": "no-store", ...(status === 429 ? { "Retry-After": "60" } : {}) },
    });
    try {
      // Public admission before reading/looking up attacker-controlled credentials.
      if (!await deps.admit("global", 3000)) return reply("Rate limit exceeded", 429);
      const body: any = await readBoundedJson(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) return reply("Invalid payload", 400);
      if (!Object.prototype.hasOwnProperty.call(body, "data")) {
        // Native-looking malformed messages never fall through to legacy auth.
        if (["connection_id", "event_name", "mos_shop_id", "vhi_url"].some(k => k in body))
          return reply("Native payload requires data envelope", 400);
        return await legacy(new NextRequest(req.url, {
          method: "POST", headers: req.headers, body: JSON.stringify(body),
        }));
      }
      const data = body.data;
      if (Object.keys(body).length !== 1 || !data || typeof data !== "object" || Array.isArray(data) ||
          Object.keys(data).sort().join(",") !== "connection_id,event_name,mos_shop_id,vhi_url,vin" ||
          data.event_name !== "vhi_url" ||
          typeof data.connection_id !== "string" || !data.connection_id ||
          data.connection_id.length > 2048 || /[\u0000-\u0020\u007f]/.test(data.connection_id) ||
          typeof data.mos_shop_id !== "number" || !Number.isSafeInteger(data.mos_shop_id))
        return reply("Invalid native payload", 400);
      const link = parseVhiLink({ shopId: data.mos_shop_id, vin: data.vin, vhiUrl: data.vhi_url, deliveryId: "native" });
      if (!link) return reply("Invalid shop, VIN, or public HTTPS URL", 400);
      const connection = await deps.resolveConnection(data.connection_id);
      if (!connection) return reply("Invalid connection", 401);
      if (!await deps.admit(`shop:${connection.shopId}`, 300)) return reply("Rate limit exceeded", 429);
      if (connection.shopId !== link.shopId) return reply("Connection does not match MOS shop", 403);
      if (!await deps.shopExists(link.shopId)) return reply("Shop not found", 404);
      if (!await deps.canUseVhi(link.shopId)) return reply("Maintenance feature not enabled", 403);
      link.deliveryId = "native:" + createHash("sha256").update(JSON.stringify([
        "native-v1", connection.connectionHash, link.shopId, link.vin, link.vhiUrl,
      ])).digest("hex");
      const response = await persistVhiLink(link, requestId, deps, {
        source: "appfueled_native", eventName: "vhi_url", deduplicationVersion: 1,
      });
      response.headers.set("X-Request-Id", requestId);
      return response;
    } catch (error) {
      if (error instanceof BodyError) return reply(error.message, error.status);
      // Never log DB exceptions: uniqueness/driver errors can contain credentials or URLs.
      return reply("Webhook temporarily unavailable", 503);
    }
  };
}
