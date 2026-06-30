// lib/integrations/autoflow/webhook.ts
//
// Shared AutoFlow inbound-webhook logic used by BOTH:
//   - app/api/webhooks/autoflow/[token]/route.ts (legacy per-shop token URL)
//   - app/api/webhooks/autoflow/route.ts         (single-source URL; shop
//     resolved from the payload, the way Tekmetric resolves by repairOrder.shopId)
//
// AutoFlow event payloads always carry a `shop` object, e.g.:
//   "shop": { "id": 49, "remote_id": "75", "location_id": "TX046",
//             "text_number": "8063566795", "domain": "harrells-raefordrd.autotext.me" }
// so a single endpoint can serve every location by matching `shop.domain`
// against the stored `autoflowDomain`.

import type { Db } from "mongodb";
import crypto from "node:crypto";
import { fetchDviByInvoice, upsertDviSnapshot } from "@/lib/integrations/autoflow/client";
import { upsertCustomerFromEvent } from "@/lib/upsert-customer";
import { insertEvent } from "@/lib/data/repositories/events";

// ---- HMAC helpers --------------------------------------------------------

export function timingSafeEqual(a: Buffer, b: Buffer) {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function verifyHmacSHA256(secret: string, rawBody: string, signatureHex: string) {
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(signatureHex, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

// ---- Payload field extraction -------------------------------------------

export function getEventName(payload: any): string {
  return (
    payload?.event?.type ||
    payload?.event ||
    payload?.type ||
    payload?.name ||
    ""
  );
}

export function resolveVin(payload: any): string | null {
  return (
    payload?.vin ??
    payload?.vehicle?.vin ??
    payload?.data?.vehicle?.vin ??
    payload?.ticket?.vehicle?.vin ??
    null
  )
    ? String(
        payload?.vin ??
          payload?.vehicle?.vin ??
          payload?.data?.vehicle?.vin ??
          payload?.ticket?.vehicle?.vin
      )
        .trim()
        .toUpperCase()
    : null;
}

/**
 * Normalize an AutoFlow domain/subdomain into the canonical
 * `<subdomain>.autotext.me` form we store in `autoflowDomain`.
 */
export function extractAutoflowDomain(payload: any): string | null {
  const raw =
    payload?.shop?.domain ??
    payload?.shop?.subdomain ??
    payload?.domain ??
    null;
  if (!raw) return null;
  let d = String(raw).trim().toLowerCase();
  d = d.replace(/^https?:\/\//i, ""); // strip protocol
  d = d.replace(/\/.*$/, ""); // drop path/query
  d = d.replace(/[./]+$/, ""); // trailing dots/slashes
  if (d && !d.includes(".")) d = `${d}.autotext.me`; // subdomain-only case
  return d || null;
}

export type ResolvedAutoflowShop = { shopId: number; name?: string };

function dedupeShopsByShopId(docs: any[]): any[] {
  const seen = new Set<string>();
  const out: any[] = [];
  for (const d of docs) {
    if (d?.shopId == null) continue;
    const key = String(d.shopId);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

/**
 * Single-source resolution: figure out which MOS shop an AutoFlow event
 * belongs to from the payload alone (no per-shop URL token).
 *
 * SAFETY: this customer runs ~10 near-identically-named Harrell's locations, so
 * a wrong-shop match would silently attribute a DVI to the wrong store. To
 * avoid that we resolve in tiers and REFUSE to guess on ambiguity:
 *
 *   Tier 1 (authoritative): `shop.domain` -> stored `autoflowDomain`. An
 *     AutoFlow subdomain is unique per location, so this deterministically
 *     identifies one shop. Both the full host and the bare subdomain forms are
 *     accepted because either may be stored.
 *   Tier 2 (fallback): only when no domain is present (or it matched nothing),
 *     try text_number / remote_id / shop.id. These can collide across sibling
 *     locations, so we accept them ONLY when they resolve to exactly one shop.
 *
 * In any tier, more than one distinct shop -> return null (caller stores the
 * event as unresolved instead of misattributing it).
 *
 * Read-only: never writes or auto-learns (high-volume receiver path).
 */
export async function resolveShopFromAutoflowPayload(
  db: Db,
  payload: any
): Promise<ResolvedAutoflowShop | null> {
  const shops = db.collection("shops");
  const projection = { shopId: 1, name: 1 } as const;

  // ---- Tier 1: domain (unique per location, authoritative) ----
  const domain = extractAutoflowDomain(payload);
  if (domain) {
    const sub = domain.split(".")[0];
    const domainMatches = dedupeShopsByShopId(
      await shops
        .find(
          {
            $or: [
              { autoflowDomain: domain },
              { autoflowDomain: sub },
              { "autoflow.domain": domain },
              { "autoflow.domain": sub },
              { "autoflow.subdomain": sub },
            ],
          },
          { projection, limit: 5 }
        )
        .toArray()
    );

    if (domainMatches.length === 1) {
      return { shopId: Number(domainMatches[0].shopId), name: domainMatches[0].name };
    }
    if (domainMatches.length > 1) {
      console.warn(
        `[autoflow-webhook] ambiguous domain "${domain}" matched ${domainMatches.length} shops (${domainMatches
          .map((d) => d.shopId)
          .join(", ")}) — refusing to guess`
      );
      return null;
    }
    // domain present but unknown -> fall through to fallback identifiers
  }

  // ---- Tier 2: non-domain identifiers (accept only an unambiguous match) ----
  const or: any[] = [];

  const textNumber =
    payload?.shop?.text_number != null ? String(payload.shop.text_number).trim() : "";
  if (textNumber) {
    or.push({ "autoflow.textNumber": textNumber }, { autoflowTextNumber: textNumber });
  }

  const remoteId =
    payload?.shop?.remote_id != null ? String(payload.shop.remote_id).trim() : "";
  if (remoteId) or.push({ "autoflow.remoteId": remoteId });

  const afId = payload?.shop?.id != null ? String(payload.shop.id).trim() : "";
  if (afId) or.push({ "autoflow.shopId": afId }, { "autoflow.shopNumbers": afId });

  if (or.length === 0) return null;

  const fallbackMatches = dedupeShopsByShopId(
    await shops.find({ $or: or }, { projection, limit: 5 }).toArray()
  );

  if (fallbackMatches.length === 1) {
    return { shopId: Number(fallbackMatches[0].shopId), name: fallbackMatches[0].name };
  }
  if (fallbackMatches.length > 1) {
    console.warn(
      `[autoflow-webhook] ambiguous fallback identifiers (text_number=${textNumber || "-"}, remote_id=${remoteId || "-"}, shop.id=${afId || "-"}) matched ${fallbackMatches.length} shops — refusing to guess`
    );
  }
  return null;
}

// ---- Shared event processing --------------------------------------------

/**
 * Persist + normalize a single AutoFlow webhook event. Identical behavior for
 * both the token route and the single-source route once the shop is known.
 */
export async function processAutoflowWebhookEvent(args: {
  db: Db;
  shop: { shopId: number | string; name?: string };
  token?: string | null;
  raw: string;
  payload: any;
}): Promise<void> {
  const { db, shop, token, raw, payload } = args;

  // Persist raw event for audit / console.
  // events ingress is PG-canonical via the repository; Mongo `events` is
  // shadow-mirrored during soak so legacy aggregate readers still see the row.
  await insertEvent({
    provider: "autoflow",
    shopId: shop.shopId,
    token: token ?? undefined,
    payload,
    raw,
    receivedAt: new Date(),
  });

  // ---- Normalize into first-class docs so dashboards light up ---------
  try {
    const eventName = String(getEventName(payload)).toLowerCase();

    // AutoFlow is a DVI-only provider: it has no work-order snapshot
    // collection, no NormalizedIngestionService adapter, and never bumps
    // `dashboard_updates`. Its DVI snapshots are cross-referenced onto the
    // primary SMS work order (Tekmetric/Protractor/Shop-Ware) which already
    // drives dashboard visibility. The marker just lets a DVI event be traced.
    console.log(`[autoflow-webhook] received event=${eventName || "(none)"} shop=${shop.shopId}`);

    // 1) Ensure/refresh a customer row for dashboard lists
    await upsertCustomerFromEvent(db, Number(shop.shopId), payload);

    // 2) Optionally mark a customer closed on terminal events
    const closeTypes = new Set<string>([
      "dvi_signoff",
      "dvi.signoff",
      "dvi_completed",
      "dvi.completed",
      "work_completed",
      "ticket_closed",
      "ticket.closed",
      "close",
      "closed",
    ]);

    if (closeTypes.has(eventName)) {
      const now = new Date();
      const vin = resolveVin(payload);
      const shopOr = [{ shopId: shop.shopId }, { shopId: Number(shop.shopId) }];

      await db.collection("customers").updateOne(
        {
          $and: [
            { $or: shopOr as any },
            vin ? { "vehicle.vin": vin } : {},
          ],
        },
        { $set: { status: "closed", closedAt: now, updatedAt: now } }
      );
    }

    // 3) Auto-fetch DVI snapshot on signoff/completion-ish events
    const isDviEvent = /dvi/i.test(eventName) && /(signoff|complete|completed|update)/i.test(eventName);

    const roNumber =
      payload?.ticket?.invoice ??
      payload?.ticket?.id ??
      payload?.event?.invoice ??
      null;

    if (isDviEvent && roNumber != null) {
      const dvi = await fetchDviByInvoice(Number(shop.shopId), String(roNumber));
      await upsertDviSnapshot(Number(shop.shopId), String(roNumber), dvi);

      // Cross-reference this DVI back to the matching primary-SMS work order
      // so downstream joins are cheap and we can flag mismatches (a DVI for
      // an RO we have no record of) for diagnostics. Reconciliation key is
      // shopId + RO number, with VIN fallback when RO numbers don't line up
      // (AutoFlow sometimes carries the invoice number while the primary
      // system carries a different work-order number).
      try {
        const sId = Number(shop.shopId);
        const sIds: any[] = [sId, String(sId)];
        const roStr = String(roNumber);
        const vinForXref =
          (dvi as any)?.vin?.toUpperCase() || resolveVin(payload) || null;
        const vinOr = vinForXref ? [{ vin: vinForXref }] : [];

        const [tekWo, protWo, swRo] = await Promise.all([
          db.collection("tekmetric_work_orders").findOne(
            {
              shopId: { $in: sIds },
              $or: [
                { workOrderNumber: roStr },
                { repairOrderNumber: roStr },
                ...vinOr,
              ],
            },
            { projection: { workOrderId: 1, workOrderNumber: 1, repairOrderNumber: 1, vin: 1 } }
          ),
          db.collection("protractor_work_orders").findOne(
            {
              shopId: { $in: sIds },
              $or: [
                { workOrderNumber: roStr },
                { "data.WorkOrderNumber": roStr },
                ...vinOr,
              ],
            },
            { projection: { workOrderGuid: 1, workOrderNumber: 1, vin: 1 } }
          ),
          db.collection("shopware_repair_orders").findOne(
            {
              mosShopId: { $in: sIds },
              $or: [
                { number: roStr },
                { number: Number(roStr) },
                ...vinOr,
              ],
            },
            { projection: { roId: 1, number: 1, vin: 1 } }
          ),
        ]);

        const xref: Record<string, any> = {};
        if (tekWo) {
          xref.tekmetric = {
            workOrderId: tekWo.workOrderId ?? null,
            workOrderNumber: tekWo.workOrderNumber ?? tekWo.repairOrderNumber ?? null,
            matchedBy: String(tekWo.workOrderNumber ?? tekWo.repairOrderNumber ?? "") === roStr ? "ro" : "vin",
          };
        }
        if (protWo) {
          xref.protractor = {
            workOrderGuid: protWo.workOrderGuid ?? null,
            workOrderNumber: protWo.workOrderNumber ?? null,
            matchedBy: String(protWo.workOrderNumber ?? "") === roStr ? "ro" : "vin",
          };
        }
        if (swRo) {
          xref.shopware = {
            roId: swRo.roId ?? null,
            number: swRo.number ?? null,
            matchedBy: String(swRo.number ?? "") === roStr ? "ro" : "vin",
          };
        }

        const matched = Object.keys(xref).length > 0;
        // Normalize shopId/roNumber forms so the cross-reference always lands
        // on the snapshot we just upserted, even if a future caller stores
        // `shopId` as a string or `roNumber` as a number.
        const updateRes = await db.collection("dvi_results").updateOne(
          {
            shopId: { $in: sIds },
            $or: [
              { roNumber: roStr },
              { roNumber: Number(roStr) },
            ],
          },
          {
            $set: {
              primaryRefs: xref,
              primaryMatched: matched,
              primaryMatchedAt: new Date(),
            },
          }
        );
        if (updateRes.matchedCount === 0) {
          console.warn(
            `[autoflow-webhook] DVI cross-reference write missed dvi_results for shop ${sId} RO ${roStr} (snapshot may not have been written yet)`
          );
        }

        if (!matched) {
          console.log(
            `[autoflow-webhook] DVI for shop ${sId} RO ${roStr} (VIN ${vinForXref || "?"}) has no matching Tekmetric/Protractor/Shop-Ware work order`
          );
        }
      } catch (xerr: any) {
        console.warn(
          `[autoflow-webhook] DVI cross-reference failed for shop ${shop.shopId} RO ${roNumber}: ${xerr.message}`
        );
      }
    }
  } catch (e) {
    // Swallow normalization errors; raw event is still stored for replay
    console.error("Webhook normalization error:", e);
  }
}
