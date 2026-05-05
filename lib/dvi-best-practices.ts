// Per-shop DVI best-practice blurbs. Mongo `shop_dvi_best_practices`,
// keyed by {shopId, serviceKey}, hard-capped at 140 chars. Shops start
// empty; DEFAULT_DVI_BEST_PRACTICES is exposed as opt-in templates only.

import { Db } from "mongodb";
import { getDb } from "@/lib/mongo";
import { toKeyFromName } from "@/lib/service-keys";

export const SHOP_DVI_BEST_PRACTICES_COLLECTION = "shop_dvi_best_practices";
export const DVI_BEST_PRACTICE_MAX_CHARS = 140;

export interface ShopDviBestPractice {
  shopId: number;
  serviceKey: string;
  serviceName: string;
  blurb: string;
  updatedAt: Date;
  updatedBy?: string | null;
  createdAt?: Date;
}

/**
 * Suggested starter library shown in the admin UI as one-click "Add"
 * templates. Nothing here is written to the DB until an admin saves it.
 */
export const DEFAULT_DVI_BEST_PRACTICES: Array<{
  serviceKey: string;
  serviceName: string;
  blurb: string;
}> = [
  {
    serviceKey: "front_brake_pads",
    serviceName: "Front Brake Pads",
    blurb: "Most vehicles need new front pads every 30k–50k miles. Replacing late can score the rotors and double the repair cost.",
  },
  {
    serviceKey: "rear_brake_pads",
    serviceName: "Rear Brake Pads",
    blurb: "Rear pads usually last longer than fronts but wear unevenly on parking-brake-equipped vehicles. Replace before the wear indicator squeals.",
  },
  {
    serviceKey: "front_brake_rotors",
    serviceName: "Front Brake Rotors",
    blurb: "Resurface or replace rotors when grooved or below minimum thickness — worn rotors cause pulsing and shorten new pad life.",
  },
  {
    serviceKey: "rear_brake_rotors",
    serviceName: "Rear Brake Rotors",
    blurb: "Rear rotors often rust before they wear out. Replace pairs together so braking stays balanced side-to-side.",
  },
  {
    serviceKey: "front_shocks",
    serviceName: "Front Shocks / Struts",
    blurb: "Worn front struts increase stopping distance and chew up tires. Most need replacement around 60k–80k miles.",
  },
  {
    serviceKey: "rear_shocks",
    serviceName: "Rear Shocks / Struts",
    blurb: "Leaking or bouncing rear shocks reduce control on rough roads. Always replace in pairs to keep ride height even.",
  },
  {
    serviceKey: "wheel_alignment",
    serviceName: "Wheel Alignment",
    blurb: "Recommended after suspension work or every 12 months. Skipping alignment can ruin a new set of tires in under 10k miles.",
  },
  {
    serviceKey: "tire_rotation",
    serviceName: "Tire Rotation",
    blurb: "Rotate every 5k–7k miles to even out tread wear. Most tire warranties require documented rotations to stay valid.",
  },
  {
    serviceKey: "battery",
    serviceName: "Battery",
    blurb: "Most car batteries last 3–5 years. Once load-test capacity drops below 70%, replace before the next cold snap leaves you stranded.",
  },
  {
    serviceKey: "wiper_blades",
    serviceName: "Wiper Blades",
    blurb: "Replace every 6–12 months. Streaking or chattering blades reduce visibility in rain and freezing weather.",
  },
  {
    serviceKey: "cabin_air",
    serviceName: "Cabin Air Filter",
    blurb: "Replace every 15k–30k miles. A clogged cabin filter restricts A/C airflow and traps allergens inside the vehicle.",
  },
  {
    serviceKey: "engine_air",
    serviceName: "Engine Air Filter",
    blurb: "Replace every 15k–30k miles or sooner in dusty conditions. A dirty filter lowers MPG and can damage mass-airflow sensors.",
  },
  {
    serviceKey: "brake_fluid",
    serviceName: "Brake Fluid",
    blurb: "Brake fluid absorbs water over time, which lowers its boiling point. Most manufacturers recommend a flush every 2–3 years.",
  },
  {
    serviceKey: "coolant",
    serviceName: "Coolant",
    blurb: "Old coolant turns acidic and corrodes the radiator and water pump. Flush per the manufacturer interval — typically 3–5 years.",
  },
];

// Resolve serviceKey via the same toKeyFromName used by DVI plan matching;
// fall back to a slug for custom services with no canonical mapping.
export function canonicalizeServiceKey(input: {
  serviceName?: string | null;
  serviceKey?: string | null;
}): string | null {
  const name = String(input.serviceName ?? "").trim();
  if (name) {
    const canonical = toKeyFromName(name);
    if (canonical) return canonical;
  }
  const raw = String(input.serviceKey ?? input.serviceName ?? "").toLowerCase().trim();
  if (!raw) return null;
  const slug = raw.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
  return slug || null;
}

async function collection(db?: Db) {
  const _db = db ?? (await getDb());
  return _db.collection<ShopDviBestPractice>(SHOP_DVI_BEST_PRACTICES_COLLECTION);
}

export async function listShopDviBestPractices(
  shopId: number,
  db?: Db,
): Promise<ShopDviBestPractice[]> {
  const col = await collection(db);
  return col
    .find({ shopId: Number(shopId) })
    .sort({ serviceName: 1 })
    .toArray();
}

/**
 * `Map<serviceKey, blurb>` lookup for the plan page. Empty/whitespace
 * blurbs are filtered out so we never render an empty paragraph.
 */
export async function getShopDviBestPracticeMap(
  shopId: number,
  db?: Db,
): Promise<Map<string, string>> {
  const rows = await listShopDviBestPractices(shopId, db);
  const out = new Map<string, string>();
  for (const r of rows) {
    const t = String(r.blurb || "").trim();
    if (r.serviceKey && t) out.set(r.serviceKey, t.slice(0, DVI_BEST_PRACTICE_MAX_CHARS));
  }
  return out;
}

/**
 * Upsert one blurb. Returns the previous blurb (for audit logging) and the
 * new blurb. Empty `blurb` removes the entry so the lookup map stays small.
 */
export async function upsertShopDviBestPractice(args: {
  shopId: number;
  serviceKey: string;
  serviceName: string;
  blurb: string;
  updatedBy?: string | null;
  db?: Db;
}): Promise<{
  before: string | null;
  after: string | null;
  serviceKey: string;
  serviceName: string;
}> {
  const shopId = Number(args.shopId);
  const serviceKey = String(args.serviceKey || "").trim();
  if (!serviceKey) throw new Error("serviceKey is required");
  const serviceName = String(args.serviceName || serviceKey).trim();
  const blurb = String(args.blurb || "").trim().slice(0, DVI_BEST_PRACTICE_MAX_CHARS);

  const col = await collection(args.db);
  const existing = await col.findOne({ shopId, serviceKey });
  const before = existing?.blurb ?? null;

  if (!blurb) {
    if (existing) await col.deleteOne({ shopId, serviceKey });
    return { before, after: null, serviceKey, serviceName };
  }

  const now = new Date();
  await col.updateOne(
    { shopId, serviceKey },
    {
      $set: {
        shopId,
        serviceKey,
        serviceName,
        blurb,
        updatedAt: now,
        updatedBy: args.updatedBy ?? null,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
  return { before, after: blurb, serviceKey, serviceName };
}

/** Explicit delete; returns the prior blurb (or null) for audit logging. */
export async function deleteShopDviBestPractice(args: {
  shopId: number;
  serviceKey: string;
  db?: Db;
}): Promise<{ before: string | null; serviceKey: string; serviceName: string | null }> {
  const shopId = Number(args.shopId);
  const serviceKey = String(args.serviceKey || "").trim();
  if (!serviceKey) throw new Error("serviceKey is required");
  const col = await collection(args.db);
  const existing = await col.findOne({ shopId, serviceKey });
  if (!existing) return { before: null, serviceKey, serviceName: null };
  await col.deleteOne({ shopId, serviceKey });
  return { before: existing.blurb ?? null, serviceKey, serviceName: existing.serviceName ?? null };
}
