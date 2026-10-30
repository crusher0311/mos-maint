import { getDb } from "@/lib/data/db";
import { findEnterpriseById } from "./enterprise";
import { listShopsByShopIds } from "./shops";
import { PILOT_CONTROL, assertPilotRange, type TirePilotSelection } from "@/lib/tire-dot-pilot";
import type { TireDotDefinition } from "@/lib/tire-dot-report-contract";

export async function findTirePilot(definition: TireDotDefinition): Promise<TirePilotSelection | null> {
  const db = await getDb();
  const control: any = await db.collection("tire_dot_pilot_control").findOne(
    { _id: PILOT_CONTROL as any, enabled: true }, { maxTimeMS: 2000 });
  if (!control) return null;
  const enterprise = await findEnterpriseById(control.enterpriseId);
  const members = (enterprise?.shopIds || []).map(Number);
  if (!definition.locationIds.some(id => members.includes(id))) return null;
  if (!definition.locationIds.every(id => members.includes(id)))
    throw new Error("Pilot scope cannot mix HEART and other locations");
  const selection: any = control.published && await db.collection("tire_dot_pilot_generations").findOne(
    { _id: control.published as any, state: "published" }, { maxTimeMS: 2000 });
  if (!selection) throw new Error(`October HEART refresh is ${control.status || "scheduled"}; no verified generation is available yet.`);
  assertPilotRange(definition, selection);
  return { generation: selection._id, enterpriseId: selection.enterpriseId,
    start: selection.start, end: selection.end, startedAt: selection.startedAt,
    finishedAt: selection.finishedAt, finalMonth: selection.finalMonth,
    locations: selection.locations, warnings: selection.warnings };
}
export async function validateTirePilot(selection: TirePilotSelection, selected: number[]) {
  const enterprise = await findEnterpriseById(selection.enterpriseId);
  const members = (enterprise?.shopIds || []).map(Number);
  const shops = await listShopsByShopIds(selected);
  if (selected.some(id => !members.includes(id) || !shops.some((s: any) => {
    const provider = s.integrationProvider || s.smsProvider || s.smsType;
    return Number(s.shopId) === id && (!provider || String(provider).toLowerCase() === "tekmetric") &&
      Number(s.tekmetric?.shopId || s.tekmetricShopId) === selection.locations.find(l => l.shopId === id)?.providerShopId;
  }))) throw new Error("HEART membership or provider binding changed; refresh the pilot evidence.");
}
export async function readTirePilotPage(selection: TirePilotSelection, shopId: number, after: string | null) {
  return (await getDb()).collection("tire_dot_pilot_evidence").find({
    generation: selection.generation, shopId, inMonth: true, verified: true, ...(after ? { key: { $gt: after } } : {}),
  }, { projection: { key: 1, data: 1, header: 1 }, maxTimeMS: 2000 })
    .hint("pilot_generation_shop_key").sort({ key: 1 }).limit(25).map((r: any) => ({
      key: r.key, doc: { ...r.header, shopId, workOrderId: r.key, data: r.data },
    })).toArray();
}
