import { randomUUID } from "node:crypto";
import {
  canonical, digest, DurableError, pending, stages,
  type Operation, type Reply, type Scope, type Stage, type Classification,
} from "./model";

/** Transaction callbacks MUST contain local storage only, never provider calls.
 * Implementations guarantee serializable write conflicts and durable commits. */
export interface Transaction {
  get<T>(key: string): Promise<T | null>;
  put<T>(key: string, value: T): Promise<void>;
}
export interface Store {
  read<T>(key: string): Promise<T | null>;
  transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
}
const requestKey = (scope: Scope, key: string) => `request:${digest([scope.shopId, "protractor", key])}`;
export const operationKey = (id: string) => `operation:${id}`;
export const targetKey = (op: Operation) => `target:${digest([op.scope.shopId, "protractor", op.plan.target.connection, op.plan.target.guid])}`;
export interface Receipt { reply: Reply; eventId: string; operationId: string }
export interface Gate { owner: string | null; last: string; revision: number }
export class Repository {
  constructor(public store: Store) {}
  async operation(id: string) { return this.store.read<Operation>(operationKey(id)); }
  authorize(op: Operation, scope: Scope, staff = false) {
    if (!scope.actor || scope.shopId !== op.scope.shopId || (!staff && scope.actor !== op.scope.actor)) throw new DurableError("OPERATION_FORBIDDEN", 403);
  }
  async lookup(scope: Scope, key: string, requestDigest: string) {
    const id = await this.store.read<string>(requestKey(scope, key));
    if (!id) return null;
    const op = await this.operation(id);
    if (!op) throw new DurableError("STORE_UNAVAILABLE", 503);
    this.authorize(op, scope);
    if (op.requestDigest !== requestDigest) throw new DurableError("REQUEST_CONFLICT");
    return op;
  }
  async reserve(candidate: Operation): Promise<{op: Operation; created: boolean}> {
    return this.store.transaction(async tx => {
      const key = requestKey(candidate.scope, candidate.key);
      const existing = await tx.get<string>(key);
      if (existing) {
        const op = (await tx.get<Operation>(operationKey(existing)))!;
        this.authorize(op, candidate.scope);
        if (op.requestDigest !== candidate.requestDigest) throw new DurableError("REQUEST_CONFLICT");
        return {op, created: false};
      }
      const gate = await tx.get<Gate>(targetKey(candidate));
      if (gate?.owner) throw new DurableError("TARGET_UNRESOLVED");
      if (gate?.last) {
        const previous = (await tx.get<Operation>(operationKey(gate.last)))!;
        // New keys cannot duplicate the last completed selection. Do not expose
        // another actor's saved payload or allocate a second set of IDs.
        if (previous.requestDigest === candidate.requestDigest && previous.state === "complete") {
          this.authorize(previous, candidate.scope);
          await tx.put(key, previous.id);
          return {op: previous, created: false};
        }
        throw new DurableError("OWNERSHIP_REVISION_REQUIRED");
      }
      await tx.put(key, candidate.id);
      await tx.put(operationKey(candidate.id), candidate);
      await tx.put(targetKey(candidate), {owner: candidate.id, last: candidate.id, revision: 1});
      await tx.put(`audit:${candidate.id}:0`, {event: "prepared", at: candidate.createdAt, actor: candidate.scope.actor});
      return {op: candidate, created: true};
    });
  }
  /** Fast target check before composition. The reservation transaction repeats it. */
  async target(scope: Scope, connection: string, guid: string) {
    const key = `target:${digest([scope.shopId, "protractor", connection, guid])}`;
    const gate = await this.store.read<Gate>(key);
    return gate ? this.operation(gate.owner || gate.last) : null;
  }
  async claim(id: string, scope: Scope, now = Date.now(), staff = false): Promise<string | null> {
    const token = randomUUID();
    return this.store.transaction(async tx => {
      const op = await tx.get<Operation>(operationKey(id));
      if (!op) throw new DurableError("NOT_FOUND", 404);
      this.authorize(op, scope, staff);
      if (op.state === "complete" || (op.claim && op.claim.until > now)) return null;
      op.claim = {token, until: now + 30_000}; op.revision++;
      await tx.put(operationKey(id), op);
      return token;
    });
  }
  private async fenced<T>(id: string, token: string, fn: (op: Operation, tx: Transaction) => Promise<T>) {
    return this.store.transaction(async tx => {
      const op = await tx.get<Operation>(operationKey(id));
      if (!op || op.claim?.token !== token || op.claim.until <= Date.now()) throw new DurableError("STALE_WORKER");
      const gate = await tx.get<Gate>(targetKey(op));
      if (gate?.owner !== id) throw new DurableError("STALE_OWNER");
      const result = await fn(op, tx);
      op.revision++;
      await tx.put(operationKey(id), op);
      await tx.put(`audit:${id}:${op.revision}`, {event: op.state, revision: op.revision, at: new Date().toISOString()});
      return result;
    });
  }
  async admit(id: string, token: string, stage: Stage, attempt: string) {
    await this.fenced(id, token, async op => {
      const s = op.stages[stage];
      if (s.state !== "prepared") throw new DurableError("STAGE_ALREADY_ADMITTED");
      if (stage === "findings" && op.stages.packages.state !== "verified") throw new DurableError("PACKAGES_UNVERIFIED");
      if (canonical(op.plan) !== op.planBytes || digest(op.plan) !== op.planDigest) throw new DurableError("PLAN_CORRUPT", 503);
      s.state = "admitted"; s.token = attempt; s.admittedAt = new Date().toISOString(); s.revision++;
      op.state = "in_progress";
    });
  }
  async outcome(id: string, token: string, stage: Stage, attempt: string, acknowledged: boolean) {
    return this.fenced(id, token, async op => {
      const s = op.stages[stage];
      if (s.token !== attempt || s.state !== "admitted") throw new DurableError("STALE_ATTEMPT");
      s.state = acknowledged ? "acknowledged" : "uncertain"; s.revision++;
      s.transportSettled = acknowledged;
      s.error = acknowledged ? null : "TRANSPORT_UNCONFIRMED"; op.state = "verification_required";
    });
  }
  async observe(id: string, token: string, stage: Stage, classification: Classification, hash: string | null, revision: string | null) {
    return this.fenced(id, token, async op => {
      const s = op.stages[stage];
      s.classification = classification; s.observedHash = hash; s.observedRevision = revision; s.revision++;
      // Conflict is sticky: operator resolution must create an audited revision.
      if (s.state !== "conflict") {
        if (classification === "desired") {
          s.state = "verified";
          if (revision && !s.verifiedRevision) s.verifiedRevision = revision;
        }
        else if (classification === "partial_or_edited") s.state = "conflict";
        else if (s.state !== "prepared" && s.state !== "not_requested") s.state = "uncertain";
      }
      op.state = stages.some(n => op.stages[n].state === "conflict") ? "conflict" :
        stages.every(n => ["verified", "not_requested"].includes(op.stages[n].state)) ? "provider_verified" : "verification_required";
    });
  }
  async releaseClaim(id: string, token: string) {
    await this.fenced(id, token, async op => { op.claim = null; });
  }
  async finalize(id: string, token: string): Promise<Receipt> {
    return this.fenced(id, token, async (op, tx) => {
      if (op.state !== "provider_verified") throw new DurableError("NOT_VERIFIED");
      const receipt: Receipt = {
        operationId: id, eventId: `auto-dvi:${id}`,
        reply: {status: 200, body: {
          ok: true, mode: "server_write", operationId: id, operationState: "complete",
          workOrderId: op.plan.target.guid, lineCount: op.plan.lineCount, recommendedCount: op.plan.recommendedCount,
          inspectionResultsWritten: op.stages.findings.state === "verified",
          packageStatus: "acknowledged", resultsStatus: op.stages.findings.state === "not_requested" ? "not_requested" : "acknowledged",
          readBackStatus: "verified", outcome: "complete", recoveryAllowed: false,
          localReceiptStatus: "recorded", nextAction: "none",
        }},
      };
      await tx.put(`receipt:${id}`, receipt);
      await tx.put(`outbox:${id}`, {operationId: id, eventId: receipt.eventId, delivered: false});
      op.state = "complete"; op.claim = null;
      const gate = (await tx.get<Gate>(targetKey(op)))!;
      await tx.put(targetKey(op), {...gate, owner: null, revision: gate.revision + 1});
      return receipt;
    });
  }
  async response(op: Operation) {
    const receipt = await this.store.read<Receipt>(`receipt:${op.id}`);
    return receipt?.reply || pending(op);
  }
  /** Same transaction and deterministic event identity: no external callback in
   * this commit. Analytics delivery can use eventId separately, best effort. */
  async deliver(id: string) {
    await this.store.transaction(async tx => {
      const event = await tx.get<{delivered: boolean; eventId: string}>(`outbox:${id}`);
      if (!event || event.delivered) return;
      const op = (await tx.get<Operation>(operationKey(id)))!;
      if (op.state !== "complete" || !await tx.get(`receipt:${id}`)) throw new DurableError("NOT_VERIFIED");
      await tx.put(`activity:${id}`, {operationId: id, eventId: event.eventId, shopId: op.scope.shopId,
        vin: op.plan.target.vin, provider: "protractor", repairOrderId: op.plan.target.guid,
        itemCount: op.plan.lineCount, appliedBy: op.scope.actor, mode: "server_write", appliedAt: new Date(op.createdAt)});
      await tx.put(`outbox:${id}`, {...event, delivered: true});
    });
  }
}
