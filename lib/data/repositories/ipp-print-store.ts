import { getDb } from "@/lib/data/db";
import { ObjectId, type Db } from "mongodb";

// Shared injection seam for isolated tests; production always uses the data layer.
export const ippStoreDeps: { getDb: () => Promise<Db> } = { getDb };

export async function updateIppInventory(filter: any, update: any) {
  return (await ippStoreDeps.getDb()).collection("print_ipp_inventory").updateOne(filter, update, { upsert: true });
}
export async function listIppInventories(shopId: number, expectedProtocol: string) {
  return (await ippStoreDeps.getDb()).collection("print_ipp_inventory")
    .find({ shopId, protocol: expectedProtocol }).limit(100).toArray();
}
export async function readIppDefaults(filter: { _id: ObjectId; shopId: number; kind: string }) {
  return (await ippStoreDeps.getDb()).collection("print_ipp_defaults").findOne(filter);
}
export async function updateIppDefaults(filter: any, update: any) {
  return (await ippStoreDeps.getDb()).collection("print_ipp_defaults").updateOne(filter, update, { upsert: true });
}
export async function findIppJob(filter: any, options: any = {}) {
  return (await ippStoreDeps.getDb()).collection("print_jobs").findOne(filter, options);
}
export async function updateIppJob(filter: any, update: any, options: any = {}) {
  return (await ippStoreDeps.getDb()).collection("print_jobs").updateOne(filter, update, options);
}
export async function claimIppJob(filter: any, update: any) {
  return (await ippStoreDeps.getDb()).collection("print_jobs").findOneAndUpdate(
    filter, update, { sort: { createdAt: 1 }, returnDocument: "after" });
}
