import type { Db } from "mongodb";
import { MongoDviStore } from "../../lib/data/repositories/auto-dvi-durable";
import { Repository } from "../../lib/auto-dvi/durable/repository";
import { DurablePushService, type Provider } from "../../lib/auto-dvi/durable/service";
import { DurableError, type Request, type Scope, type Stage, type Target, type Snapshot } from "../../lib/auto-dvi/durable/model";

export const guid = "11111111-1111-4111-8111-111111111111";
export const vin = "1HGCM82633A004352";
export const scope = {shopId: 1, actor: "fixture@example.invalid"};
export const body = {clientRequestId: "request-0001", workOrderGuid: guid, vin,
  items: [{name: "Battery", rating: "red", notes: "Test"}],
  recommendedItems: [{name: "Service"}, {name: "Service"}]};
export const target: Target = {shopId: 1, connection: "fixture", connectionVersion: "1", guid, vin};
export async function resetProvider(db: Db) {
  await db.collection("fixture_provider").deleteMany({});
  await db.collection("fixture_provider").insertOne({_id: "wo", target, revision: 0, open: true, complete: true,
    body: {ID: guid, ServicePackages: {ItemCollection: []}}, writes: [], mode: "ok"} as any);
}
export class FixtureProvider implements Provider {
  concurrencyVerified = true;
  constructor(public db: Db, private crashStage?: string) {}
  async target(_scope: Scope, request: Request) {
    const row = (await this.db.collection("fixture_provider").findOne({_id: "wo"} as any))!;
    return {...row.target, guid: request.workOrderGuid, vin: request.vin};
  }
  async read(t: Target): Promise<Snapshot> {
    const row = (await this.db.collection("fixture_provider").findOne({_id: "wo"} as any))!;
    if (row.mode === "read-fails") throw Error("fixture read failed");
    if (row.mode === "numeric-readback") {
      // Independent provider simulation, not the application's comparator.
      for (const pkg of row.body.ServicePackages.ItemCollection) {
        for (const line of pkg.ServicePackageLines?.ItemCollection || []) {
          if (line.Type !== "Labor") continue;
          for (const field of ["Quantity", "Price", "Total"]) {
            if (typeof line[field] === "string") line[field] = Number(line[field]);
          }
        }
      }
    }
    return {target: row.target, open: row.open, complete: row.complete, fresh: true,
      resultLabels: {target: row.target, source: "shop_configuration", evidence: "isolated fixture setup",
        green: "OK", yellow: "Requires Future Attention", red: "Required"},
      revision: String(row.revision), body: row.body};
  }
  async write(t: Target, stage: Stage, payload: Record<string, any>, revision: string) {
    const coll = this.db.collection("fixture_provider");
    const row = (await coll.findOne({_id: "wo"} as any))!;
    if (row.mode === `absent-${stage}`) return false;
    if (row.mode === `edited-before-${stage}`) {
      await coll.updateOne({_id: "wo"} as any, {$inc: {revision: 1}});
    }
    const next = structuredClone(row.body);
    if (stage === "packages") next.ServicePackages.ItemCollection.push(...payload.ServicePackages.ItemCollection);
    else next.ServicePackages.ItemCollection.push(...payload.ItemCollection);
    const result = await coll.updateOne({_id: "wo", revision: Number(revision)} as any,
      {$set: {body: next}, $inc: {revision: 1}, $push: {writes: stage}} as any);
    if (!result.matchedCount) throw new DurableError("CONDITIONAL_REJECTED");
    if (this.crashStage === stage) process.exit(73); // process dies after provider commit
    if (row.mode === `lost-${stage}`) throw Error("fixture response lost");
    return true;
  }
}
export function fixtureService(store: MongoDviStore, db: Db, crashStage?: string) {
  return new DurablePushService({repository: new Repository(store), provider: new FixtureProvider(db, crashStage),
    admissions: true, price: async () => [{title: "Service", hours: 1, rate: 100}, {title: "Service", hours: 2, rate: 150}]});
}
