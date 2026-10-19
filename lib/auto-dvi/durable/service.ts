import { randomUUID } from "node:crypto";
import { composePlan } from "./compose";
import { Repository } from "./repository";
import {
  canonical, classify, digest, DurableError, newOperation, parseRequest, validSnapshot,
  type Operation, type Reply, type Request, type Scope, type Snapshot, type Stage, type Target,
} from "./model";

export interface Provider {
  /** Resolve using the authenticated shop connection, never a VIN fallback. */
  target(scope: Scope, request: Request): Promise<Target>;
  read(target: Target): Promise<Snapshot>;
  /** Must enforce conditional write or a verified exclusive editing window.
   * A read followed by an unconditional POST does NOT implement this contract.
   * Exactly one REST attempt; no retry, SOAP fallback, or replacement IDs. */
  write(target: Target, stage: Stage, payload: Record<string, any>, expectedRevision: string): Promise<boolean>;
  concurrencyVerified: boolean;
}
export interface Dependencies {
  repository: Repository; provider: Provider;
  price(shopId: number, request: Request): Promise<Array<{title: string; hours: number; rate: number}>>;
  admissions: boolean;
}
export class DurablePushService {
  constructor(private deps: Dependencies) {}
  private async checkedTarget(scope: Scope, request: Request) {
    if (!scope.actor || !Number.isSafeInteger(scope.shopId) || scope.shopId <= 0) throw new DurableError("UNAUTHORIZED", 403);
    const target = await this.deps.provider.target(scope, request);
    if (target.shopId !== scope.shopId || target.guid !== request.workOrderGuid || target.vin !== request.vin ||
        !target.connection || !target.connectionVersion) throw new DurableError("TARGET_CHANGED");
    return target;
  }
  private async validateExisting(scope: Scope, op: Operation) {
    this.deps.repository.authorize(op, scope);
    if (op.schemaVersion !== 1 || op.composerVersion !== 1 || op.comparatorVersion !== 1 ||
        op.planDigest !== digest(op.plan) || op.planBytes !== canonical(op.plan) ||
        op.requestDigest !== digest(op.request) || op.requestBytes !== canonical(op.request))
      throw new DurableError("PLAN_VERSION_OR_INTEGRITY", 503);
    const target = await this.checkedTarget(scope, op.request);
    if (canonical(target) !== canonical(op.plan.target)) throw new DurableError("CONNECTION_CHANGED");
  }
  async push(scope: Scope, body: unknown): Promise<Reply> {
    const {clientRequestId, request} = parseRequest(body);
    const repo = this.deps.repository;
    // Deliberately before pricing, composition, target resolution or provider reads.
    const found = await repo.lookup(scope, clientRequestId, digest(request));
    if (found) {
      await this.validateExisting(scope, found);
      return repo.response(found); // Push is NEVER a recovery command.
    }
    const target = await this.checkedTarget(scope, request);
    const previous = await repo.target(scope, target.connection, target.guid);
    if (previous) {
      if (previous.state !== "complete") throw new DurableError("TARGET_UNRESOLVED");
      repo.authorize(previous, scope);
      if (previous.requestDigest === digest(request)) {
        // Reserve an alias so editing this new key later also conflicts.
        const alias = {...previous, key: clientRequestId};
        const result = await repo.reserve(alias);
        return repo.response(result.op);
      }
      throw new DurableError("OWNERSHIP_REVISION_REQUIRED");
    }
    if (!this.deps.admissions) throw new DurableError("ADMISSIONS_DISABLED", 503);
    if (!this.deps.provider.concurrencyVerified) throw new DurableError("PROVIDER_CAPABILITY_UNVERIFIED", 503);
    const snapshot = await this.deps.provider.read(target);
    if (!validSnapshot(snapshot, target)) throw new DurableError("UNVERIFIED_TARGET", 409);
    const extras = await this.deps.price(scope.shopId, request);
    const plan = composePlan(request, snapshot, extras);
    const candidate = newOperation(scope, clientRequestId, request, plan);
    let result;
    try { result = await repo.reserve(candidate); }
    catch (error) {
      if (error instanceof DurableError) throw error;
      // A lost commit response cannot justify using the in-memory candidate.
      const saved = await repo.lookup(scope, clientRequestId, digest(request));
      if (!saved) {
        const owner = await repo.target(scope, target.connection, target.guid);
        if (owner && owner.id !== candidate.id) throw new DurableError("TARGET_UNRESOLVED");
        throw new DurableError("STORE_UNAVAILABLE", 503);
      }
      return repo.response(saved);
    }
    if (!result.created) return repo.response(result.op);
    // Exact authoritative read-back of the winning immutable plan before admission.
    const saved = await repo.lookup(scope, clientRequestId, digest(request));
    if (!saved || saved.id !== candidate.id || saved.planDigest !== digest(plan)) throw new DurableError("STORE_UNAVAILABLE", 503);
    return this.initial(scope, saved);
  }
  private async initial(scope: Scope, op: Operation): Promise<Reply> {
    const repo = this.deps.repository;
    const token = await repo.claim(op.id, scope);
    if (!token) return repo.response((await repo.operation(op.id))!);
    try {
      for (const stage of ["packages", "findings"] as const) {
        await this.validateExisting(scope, op);
        const observed = await this.deps.provider.read(op.plan.target);
        const expected = stage === "packages" ? op.plan.baseline.body : op.plan.desired.packages;
        if (!validSnapshot(observed, op.plan.target) || canonical(observed.body) !== canonical(expected) ||
            (stage === "packages" && observed.revision !== op.plan.baseline.revision)) {
          await repo.observe(op.id, token, stage, validSnapshot(observed, op.plan.target) ? "partial_or_edited" : "unknown",
            null, null);
          break;
        }
        const attempt = randomUUID();
        // If this commit response is lost, DO NOT send, even if admission is
        // subsequently readable. A new worker only gets read-only reconciliation.
        await repo.admit(op.id, token, stage, attempt);
        const admitted = await repo.operation(op.id);
        if (!admitted || admitted.claim?.token !== token || admitted.claim.until <= Date.now() ||
            admitted.stages[stage].token !== attempt || admitted.stages[stage].state !== "admitted" ||
            admitted.planDigest !== digest(admitted.plan)) throw new DurableError("STORE_UNAVAILABLE", 503);
        let ack = false;
        try {
          ack = await this.deps.provider.write(op.plan.target, stage, admitted.plan.payloads[stage]!, observed.revision);
        } catch { /* Even a rejected response is ambiguous; never switch transport. */ }
        await repo.outcome(op.id, token, stage, attempt, ack);
        let read: Snapshot | null = null;
        try { read = await this.deps.provider.read(op.plan.target); } catch { /* unknown */ }
        const classification = read ? classify(op.plan, stage, read) : "unknown";
        await repo.observe(op.id, token, stage, classification, read ? digest(read.body) : null, read?.revision ?? null);
        if (classification !== "desired") break;
      }
      const latest = (await repo.operation(op.id))!;
      if (latest.state === "provider_verified") {
        const receipt = await repo.finalize(op.id, token);
        await repo.deliver(op.id).catch(() => {}); // receipt, not analytics, is authoritative
        return receipt.reply;
      }
      return repo.response(latest);
    } finally {
      await repo.releaseClaim(op.id, token).catch(() => {});
    }
  }
  /** Staff callers must authenticate and check current entitlement before entry.
   * No write capability is invoked here, including lost receipt repair. */
  async status(scope: Scope, id: string): Promise<Reply> {
    const op = await this.deps.repository.operation(id);
    if (!op) throw new DurableError("NOT_FOUND", 404);
    await this.validateExisting(scope, op);
    return this.deps.repository.response(op);
  }
  async reconcile(scope: Scope, id: string): Promise<Reply> {
    const repo = this.deps.repository;
    const op = await repo.operation(id);
    if (!op) throw new DurableError("NOT_FOUND", 404);
    await this.validateExisting(scope, op);
    if (op.state === "complete") {
      await repo.deliver(id).catch(() => {});
      return repo.response(op);
    }
    const token = await repo.claim(id, scope);
    if (!token) return repo.response(op);
    try {
      let read: Snapshot | null = null;
      try { read = await this.deps.provider.read(op.plan.target); } catch { /* unknown */ }
      const finalMatch = read && classify(op.plan, "findings", read) === "desired";
      for (const stage of ["packages", "findings"] as const) {
        const classification = finalMatch ? "desired" : read ? classify(op.plan, stage, read) : "unknown";
        await repo.observe(id, token, stage, classification, read ? digest(read.body) : null, read?.revision ?? null);
      }
      const latest = (await repo.operation(id))!;
      if (latest.state === "provider_verified") {
        const receipt = await repo.finalize(id, token);
        await repo.deliver(id).catch(() => {});
        return receipt.reply;
      }
      return repo.response(latest);
    } finally { await repo.releaseClaim(id, token).catch(() => {}); }
  }
}
