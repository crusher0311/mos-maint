import { randomUUID } from "node:crypto";
import { canonical, comparisonBytes, classify, digest, DurableError, type Operation, type Scope, type Snapshot, type Stage } from "./model";
import { Repository, operationKey, targetKey, type Gate } from "./repository";
import { DurablePushService, type Provider } from "./service";

export interface RecoveryGrant {
  id: string; operationId: string; shopId: number; actor: string; stage: Stage;
  planDigest: string; operationRevision: number; stageRevision: number;
  observedRevision: string; observedHash: string; expiresAt: number;
  action: "saved_stage_once"; consumed: boolean;
  /** Evidence is produced by a verified server capability, never browser text. */
  quiescence: Partial<Record<Stage, {attempt: string; evidence: string}>>;
}
export interface RecoveryDependencies {
  repository: Repository; provider: Provider; service: DurablePushService;
  authorize(scope: Scope): Promise<void>;
  enabled: boolean;
  proveQuiescence?(op: Operation, stage: Stage, attempt: string): Promise<string | null>;
}
const grantKey = (id: string) => `recovery-grant:${id}`;

/** The caller supplies identity only. All authority, payloads and termination
 * evidence originate on the server. No generic retry/force API exists. */
export class RecoveryService {
  constructor(private deps: RecoveryDependencies) {}
  private async check(scope: Scope, id: string) {
    await this.deps.authorize(scope);
    if (!this.deps.enabled) throw new DurableError("RECOVERY_DISABLED", 403);
    if (!this.deps.provider.concurrencyVerified) throw new DurableError("PROVIDER_CAPABILITY_UNVERIFIED", 503);
    const op = await this.deps.repository.operation(id);
    if (!op) throw new DurableError("NOT_FOUND", 404);
    await this.deps.service.validateExisting(scope, op, true);
    return op;
  }
  private eligible(op: Operation, stage: Stage, read: Snapshot) {
    if (op.state === "complete" || op.state === "conflict" ||
        Object.values(op.stages).some(s => s.state === "conflict"))
      throw new DurableError("MANUAL_RESOLUTION_REQUIRED");
    const s = op.stages[stage];
    if (!op.plan.payloads[stage] || ["verified", "not_requested"].includes(s.state))
      throw new DurableError("STAGE_NOT_RECOVERABLE");
    if (classify(op.plan, stage, read) !== "baseline")
      throw new DurableError("RECONCILE_REQUIRED");
    // Findings baseline must include *all* desired packages. The generic
    // classifier also recognizes the original baseline, which is insufficient.
    const expected = stage === "packages" ? op.plan.baseline.body : op.plan.desired.packages;
    if (comparisonBytes(op.plan, read.body) !== comparisonBytes(op.plan, expected)) throw new DurableError("PROVIDER_EDIT");
    if (stage === "packages" && read.revision !== op.plan.baseline.revision)
      throw new DurableError("PROVIDER_EDIT");
    if (stage === "findings" && (op.stages.packages.state !== "verified" ||
        op.stages.packages.verifiedRevision !== read.revision))
      throw new DurableError("PACKAGES_UNVERIFIED");
  }
  private async quiescence(op: Operation, stage: Stage) {
    const proofs: RecoveryGrant["quiescence"] = {};
    for (const name of stage === "findings" ? ["packages", "findings"] as const : ["packages"] as const) {
      const s = op.stages[name];
      if (!s.token || s.transportSettled) continue;
      const evidence = await this.deps.proveQuiescence?.(op, name, s.token);
      if (!evidence) throw new DurableError("EARLIER_REQUEST_UNRESOLVED");
      proofs[name] = {attempt: s.token, evidence};
    }
    return proofs;
  }
  async issue(scope: Scope, id: string, stage: Stage) {
    await this.check(scope, id);
    // Reads and local receipt repair only. Already-desired work needs no grant.
    const result = await this.deps.service.reconcile(scope, id);
    if (result.body.operationState === "complete") return result;
    const op = await this.check(scope, id);
    const read = await this.deps.provider.read(op.plan.target);
    this.eligible(op, stage, read);
    const quiescence = await this.quiescence(op, stage);
    await this.deps.authorize(scope);
    const grant: RecoveryGrant = {
      id: randomUUID(), operationId: id, shopId: scope.shopId, actor: scope.actor, stage,
      planDigest: op.planDigest, operationRevision: op.revision + 1, stageRevision: op.stages[stage].revision,
      observedRevision: read.revision, observedHash: digest(read.body), expiresAt: Date.now() + 120_000,
      action: "saved_stage_once", consumed: false, quiescence,
    };
    await this.deps.repository.store.transaction(async tx => {
      const current = await tx.get<Operation>(operationKey(id));
      const gate = current && await tx.get<Gate>(targetKey(current));
      if (!current || current.revision !== op.revision || current.claim || gate?.owner !== id)
        throw new DurableError("OPERATION_CHANGED");
      current.revision++;
      await tx.put(operationKey(id), current);
      await tx.put(grantKey(grant.id), grant);
      await tx.put(`audit:${id}:${current.revision}`, {event: "recovery_authorized", actor: scope.actor,
        stage, grantId: grant.id, planDigest: grant.planDigest, at: new Date().toISOString(), quiescence});
    });
    return {status: 200, body: {operationId: id, stage, grantId: grant.id, expiresAt: grant.expiresAt,
      recoveryAllowed: false, nextAction: "confirm_saved_stage",
      review: {packages: stage === "findings" ? "verified_unchanged" : "baseline_unchanged",
        selectedStage: "baseline_unchanged", action: "Send only this saved stage with its original IDs."}}};
  }
  async consume(scope: Scope, id: string, stage: Stage, grantId: string) {
    const op = await this.check(scope, id);
    const grant = await this.deps.repository.store.read<RecoveryGrant>(grantKey(grantId));
    this.validateGrant(grant, scope, op, stage);
    const read = await this.deps.provider.read(op.plan.target);
    this.eligible(op, stage, read);
    if (read.revision !== grant!.observedRevision || digest(read.body) !== grant!.observedHash)
      throw new DurableError("PROVIDER_EDIT");
    // Revalidate termination evidence and live permissions after the network read.
    await this.quiescence(op, stage);
    await this.check(scope, id);
    const token = randomUUID(), attempt = randomUUID();
    await this.deps.repository.store.transaction(async tx => {
      const current = await tx.get<Operation>(operationKey(id));
      if (!current) throw new DurableError("NOT_FOUND", 404);
      const saved = await tx.get<RecoveryGrant>(grantKey(grantId));
      this.validateGrant(saved, scope, current, stage);
      const gate = await tx.get<Gate>(targetKey(current));
      if (current.claim || gate?.owner !== id) throw new DurableError("OPERATION_BUSY");
      saved!.consumed = true;
      current.claim = {token, until: Date.now() + 30_000};
      const s = current.stages[stage];
      s.state = "admitted"; s.token = attempt; s.admittedAt = new Date().toISOString();
      s.transportSettled = false; s.revision++;
      current.state = "in_progress"; current.revision++;
      await tx.put(grantKey(grantId), saved);
      await tx.put(operationKey(id), current);
      await tx.put(`audit:${id}:${current.revision}`, {event: "recovery_admitted", actor: scope.actor,
        stage, grantId, attempt, at: new Date().toISOString()});
    });
    // A lost transaction response exits above: it must never authorize a send.
    const repo = this.deps.repository;
    try {
      const saved = await repo.operation(id);
      if (!saved || saved.claim?.token !== token || saved.claim.until <= Date.now() ||
          saved.stages[stage].token !== attempt || saved.planDigest !== digest(saved.plan))
        throw new DurableError("ADMISSION_UNCONFIRMED", 503);
      await this.check(scope, id);
      let ack = false;
      try { ack = await this.deps.provider.write(saved.plan.target, stage, saved.plan.payloads[stage]!, read.revision); }
      catch { /* No retries or SOAP fallback, including conditional rejection. */ }
      await repo.outcome(id, token, stage, attempt, ack);
    } finally { await repo.releaseClaim(id, token).catch(() => {}); }
    await this.deps.authorize(scope);
    return this.deps.service.reconcile(scope, id);
  }
  private validateGrant(grant: RecoveryGrant | null, scope: Scope, op: Operation, stage: Stage) {
    if (!grant || grant.consumed || grant.expiresAt <= Date.now() || grant.actor !== scope.actor ||
        grant.shopId !== scope.shopId || grant.operationId !== op.id || grant.stage !== stage ||
        grant.planDigest !== op.planDigest || grant.operationRevision !== op.revision ||
        grant.stageRevision !== op.stages[stage].revision || grant.action !== "saved_stage_once")
      throw new DurableError("GRANT_INVALID", 403);
  }
}
