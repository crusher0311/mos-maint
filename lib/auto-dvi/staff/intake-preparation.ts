import {createHash, randomUUID} from "node:crypto";
import type {Db} from "mongodb";
import {getDb} from "../../data/db";
import {intakeContextSchema, projectIntakeContext, type IntakeContext, type IntakeContextRequest} from "./intake-context";
import type {CachedPlan} from "../../plan-cache";

const collection = "workflow_intake_vhi_preparation";
const missing: IntakeContext = {status: "unavailable", coverage: "unknown", checks: []};
/** Small optional queue; automatic preparation never writes the shared plan
 * cache, so changed VIN/mileage cannot replace another request's context. */
export class IntakePreparation {
  constructor(private database: () => Promise<Db> = getDb, private now = Date.now) {}
  async request(shopId: number, actor: string, email: string, raw: IntakeContextRequest): Promise<IntakeContext> {
    const input = intakeContextSchema.parse(raw), db = await this.database();
    const id = createHash("sha256").update(JSON.stringify([shopId, actor, input, Math.floor(this.now() / 600_000)])).digest("hex");
    const current = await db.collection(collection).findOne({_id: id} as any, {maxTimeMS: 2000});
    if (current) return current.result ?? (["queued", "processing"].includes(current.state) ?
      {status: "preparing", coverage: "unknown", checks: []} : missing);
    const count = await db.collection(collection).countDocuments({shopId, createdAt: {$gte: this.now() - 600_000}},
      {limit: 17, maxTimeMS: 2000});
    if (count >= 16) return missing;
    try {
      await db.collection(collection).insertOne({_id: id, shopId, actor, email, input, state: "queued",
        createdAt: this.now(), attempts: 0, lease: null} as any, {writeConcern: {w: "majority", wtimeoutMS: 2000}});
    } catch (error) {if ((error as {code?: number}).code !== 11000) throw error;}
    return {status: "preparing", coverage: "unknown", checks: []};
  }
  async processOne(shopId: number, build: (input: IntakeContextRequest, actor: string, email: string) => Promise<CachedPlan | null>) {
    const db = await this.database(), token = randomUUID(), at = this.now();
    const job = await db.collection(collection).findOneAndUpdate({shopId, createdAt: {$gte: at - 300_000}, attempts: {$lt: 2},
      $or: [{state: "queued"}, {state: "processing", "lease.until": {$lte: at}}]},
    {$set: {state: "processing", lease: {token, until: at + 60_000}}, $inc: {attempts: 1}},
    {returnDocument: "after", sort: {createdAt: 1}, maxTimeMS: 2000});
    if (!job) return false;
    let result = missing;
    try {result = projectIntakeContext(await build(intakeContextSchema.parse(job.input), job.actor, job.email));}
    catch {/* Only content-free missing coverage reaches the browser. */}
    await db.collection(collection).updateOne({_id: job._id, "lease.token": token, "lease.until": {$gt: this.now()}},
      {$set: {state: "finished", lease: null, result}}, {writeConcern: {w: "majority", wtimeoutMS: 2000}});
    return true;
  }
}
