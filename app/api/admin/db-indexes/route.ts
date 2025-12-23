// app/api/admin/db-indexes/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/db-indexes
 * Header: X-Admin-Token
 * Query: ?force=1 to drop/recreate incompatible indexes.
 */
export async function POST(req: NextRequest) {
  const admin = req.headers.get("x-admin-token");
  if (!admin) return NextResponse.json({ error: "Missing X-Admin-Token" }, { status: 401 });

  const force = req.nextUrl.searchParams.has("force");

  try {
    const db = await getDb();
    const shops = db.collection("shops");
    const counters = db.collection("counters");
    const setupTokens = db.collection("setup_tokens");
    const users = db.collection("users");
    const sessions = db.collection("sessions");
    const pwResets = db.collection("password_resets");
    const customers = db.collection("customers");

    const ensure = async (col: any, spec: any, opts: any) => {
      try {
        await col.createIndex(spec, opts);
      } catch (e: any) {
        // If an index exists with a different name, allow force rebuild
        if (force && /already exists with a different name/i.test(e?.message || "")) {
          // Find existing indexes that match spec keys and drop them
          const idxs = await col.indexes();
          for (const idx of idxs) {
            const keys = JSON.stringify(idx.key);
            if (keys === JSON.stringify(spec)) {
              await col.dropIndex(idx.name);
            }
          }
          await col.createIndex(spec, opts);
        } else {
          throw e;
        }
      }
    };

    // shops
    await ensure(shops, { shopId: 1 }, { unique: true, name: "shopId_unique" });
    await ensure(shops, { "credentials.autoflow.apiKey": 1 }, { name: "autoflow_apiKey_idx", sparse: true });

    // counters -> align to max shopId
    const maxDoc = await shops
      .find({ shopId: { $type: "number" } }, { projection: { shopId: 1 } })
      .sort({ shopId: -1 })
      .limit(1)
      .next();
    const maxExisting = Number.isFinite(maxDoc?.shopId) ? (maxDoc!.shopId as number) : 0;
    await counters.updateOne(
      { _id: "shopId" },
      { $set: { seq: maxExisting }, $setOnInsert: { _id: "shopId" } },
      { upsert: true }
    );

    // setup_tokens
    await ensure(setupTokens, { token: 1 }, { unique: true, name: "setup_token_unique" });
    await ensure(setupTokens, { expiresAt: 1 }, { expireAfterSeconds: 0, name: "setup_token_ttl" });

    // users (unique per shop)
    await ensure(users, { shopId: 1, emailLower: 1 }, { unique: true, name: "users_shop_email_unique" });

    // sessions
    await ensure(sessions, { token: 1 }, { unique: true, name: "session_token_unique" });
    await ensure(sessions, { expiresAt: 1 }, { expireAfterSeconds: 0, name: "session_ttl" });

    // password_resets
    await ensure(pwResets, { token: 1 }, { unique: true, name: "pwreset_token_unique" });
    await ensure(pwResets, { expiresAt: 1 }, { expireAfterSeconds: 0, name: "pwreset_ttl" });

    // customers
    await ensure(customers, { shopId: 1, externalId: 1 }, { unique: false, name: "customers_shop_extid" });
    await ensure(customers, { shopId: 1, emailLower: 1 }, { unique: false, name: "customers_shop_email" });

    // events (critical for dashboard performance)
    const events = db.collection("events");
    await ensure(events, { shopId: 1, provider: 1, createdAt: -1 }, { name: "events_shop_provider_recent" });
    await ensure(events, { shopId: 1, vehicleVin: 1, createdAt: -1 }, { name: "events_shop_vin_recent" });
    await ensure(events, { provider: 1, createdAt: -1 }, { name: "events_provider_recent" });

    // vehicles
    const vehicles = db.collection("vehicles");
    await ensure(vehicles, { vin: 1 }, { unique: true, sparse: true, name: "vehicles_vin_unique" });
    await ensure(vehicles, { shopId: 1 }, { name: "vehicles_shop" });
    await ensure(vehicles, { "tekmetric.shopId": 1 }, { sparse: true, name: "vehicles_tekmetric_shop" });

    // protractor collections
    const protractorWO = db.collection("protractor_work_orders");
    await ensure(protractorWO, { shopId: 1, vin: 1, fetchedAt: -1 }, { name: "protractor_wo_shop_vin_recent" });
    
    const protractorVehicles = db.collection("protractor_vehicles");
    await ensure(protractorVehicles, { shopId: 1, vin: 1 }, { name: "protractor_vehicles_shop_vin" });

    const counterNow = await counters.findOne({ _id: "shopId" });

    return NextResponse.json({
      ok: true,
      force,
      indexes: [
        "shops.shopId (unique)",
        "shops.credentials.autoflow.apiKey (sparse)",
        "setup_tokens.token (unique)",
        "setup_tokens.expiresAt (TTL)",
        "users {shopId,emailLower} (unique)",
        "sessions.token (unique)",
        "sessions.expiresAt (TTL)",
        "password_resets.token (unique)",
        "password_resets.expiresAt (TTL)",
        "customers {shopId,externalId}",
        "customers {shopId,emailLower}",
        "events {shopId,provider,createdAt}",
        "events {shopId,vehicleVin,createdAt}",
        "events {provider,createdAt}",
        "vehicles.vin (unique, sparse)",
        "vehicles.shopId",
        "vehicles.tekmetric.shopId (sparse)",
        "protractor_work_orders {shopId,vin,fetchedAt}",
        "protractor_vehicles {shopId,vin}",
      ],
      counter: counterNow,
      maxExisting,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}

