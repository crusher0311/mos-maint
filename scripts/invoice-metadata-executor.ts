/**
 * Offline repair executor. Deliberately has NO live connection factory.
 * The disposable adapter models canonical/shadow commit in one transaction.
 * It is not a distributed Mongo/Postgres transaction implementation.
 */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import { evidenceDigest as digest, prepareInvoiceMetadataProposal, type SnapshotTarget } from "./invoice-metadata-repair-plan";
import type { StoredEvidenceCase } from "./invoice-evidence-local-preview";

export type Proposal = ReturnType<typeof prepareInvoiceMetadataProposal>;
export interface OriginalProposal {
  proposals: Proposal[];
  held: unknown[];
  repairAuthorized: false;
  livePreflightRequired: true;
  [key: string]: unknown;
}
export interface Owner {
  key: string;
  revision: number;
  snapshot: SnapshotTarget;
  /** Full retained row, including financial fields, used only for equality checks. */
  row: Record<string, any>;
}
export interface CurrentCase {
  canonical: Owner[];
  shadow: Owner[];
  source: StoredEvidenceCase;
  /** Includes archive inventory and hold-registry evidence, not just latest raw. */
  evidenceInventory: unknown;
  holds: string[];
}
export interface WriterVerification {
  id: string;
  deployedRevision: string;
  runtimeRevision: string;
  preservationVerified: boolean;
  rawRetentionVerified: boolean;
  invoiceEvidenceVersion: number;
  verificationDigest: string;
}
export interface Readiness {
  requiredWriterIds: string[];
  writers: WriterVerification[];
  verifiedAt: number;
  writersQuiesced: boolean;
  quiescenceEvidenceDigest: string;
  topology: "disposable-atomic-canonical-shadow";
}
export interface FinalPlan {
  version: 1;
  proposalDigest: string;
  originalProposal: OriginalProposal;
  proposals: Proposal[];
  cases: CurrentCase[];
  readiness: Readiness;
  preflightAt: number;
  expiresAt: number;
}
export interface Approval {
  action: "apply" | "rollback";
  planDigest: string;
  preflightDigest: string;
  approvedBy: string;
  approvalReference: string;
  approvedAt: number;
  expiresAt: number;
}
export interface Receipt {
  planDigest: string;
  index: number;
  state: "applied" | "rolled_back";
  before: CurrentCase;
  after: CurrentCase;
}
export interface RepairTransaction {
  read(proposal: Proposal): Promise<CurrentCase>;
  receipt(key: string): Promise<Receipt | null>;
  /** Must compare the FULL case (owners, aliases, sources, holds and both rows). */
  compareAndSet(proposal: Proposal, before: CurrentCase, after: CurrentCase): Promise<boolean>;
  saveReceipt(key: string, receipt: Receipt): Promise<void>;
  audit(event: AuditEvent): Promise<void>;
}
export interface AuditEvent {
  planDigest: string;
  index: number;
  action: Approval["action"];
  outcome: "applied" | "already_applied" | "rolled_back" | "already_rolled_back" | "rejected_or_unknown";
  approvalReference: string;
}
export interface OfflineRepairStore {
  readonly mode: "disposable-only";
  /** Read-only, repeatable snapshot; no lock/lease is implied by preflight. */
  preflight<T>(fn: (tx: RepairTransaction) => Promise<T>): Promise<T>;
  /** Serialize ownership/source edits too; bounded transaction, never whole-plan. */
  transaction<T>(fn: (tx: RepairTransaction) => Promise<T>): Promise<T>;
  auditFailure(event: AuditEvent): Promise<void>;
}
const MAX_AGE = 5 * 60_000;
const hashPattern = /^[a-f0-9]{64}$/;
function equal(a: unknown, b: unknown, message: string) {
  assert.equal(digest(a), digest(b), message);
}
function verifyReadiness(r: Readiness, now: number) {
  assert.equal(r.topology, "disposable-atomic-canonical-shadow", "Unsupported store topology");
  assert.ok(r.writersQuiesced && hashPattern.test(r.quiescenceEvidenceDigest), "Writer quiescence required");
  assert.ok(r.verifiedAt <= now && now - r.verifiedAt <= MAX_AGE, "Writer verification expired");
  assert.ok(r.requiredWriterIds.length > 0);
  equal([...new Set(r.requiredWriterIds)].sort(), r.writers.map(w => w.id).sort(), "Incomplete/duplicate writer inventory");
  assert.equal(new Set(r.writers.map(w => w.id)).size, r.writers.length);
  for (const w of r.writers) {
    assert.ok(w.id && w.deployedRevision && w.runtimeRevision === w.deployedRevision);
    assert.ok(w.preservationVerified && w.rawRetentionVerified, "Unverified writer preservation");
    assert.equal(w.invoiceEvidenceVersion, 1, "Incompatible invoice-evidence generator");
    assert.match(w.verificationDigest, hashPattern);
  }
}
function verifyCase(p: Proposal, c: CurrentCase) {
  assert.deepEqual(c.holds, [], "Financial/ownership hold");
  assert.ok(c.evidenceInventory != null, "Missing complete retained evidence inventory");
  assert.equal(c.canonical.length, 1, "Unique current owner required in each store");
  assert.equal(createHash("sha256").update(`${p.shopId}:${c.canonical[0].key}`).digest("hex"),
    p.snapshotTargetHash, "Resolved primary key does not match original target hash");
  for (const owners of [c.canonical, c.shadow]) {
    assert.equal(owners.length, 1, "Unique current owner required in each store");
    const owner = owners[0];
    assert.ok(owner.key && Number.isSafeInteger(owner.revision) && owner.revision >= 0);
    for (const field of ["shop_id", "status", "soft_delete", "provenance", "custom_fields"] as const) {
      equal(owner.row[field], owner.snapshot[field], "Projection does not match row");
    }
    // Snapshot hash IDs in the proposal must be independently resolved by the adapter.
    equal(prepareInvoiceMetadataProposal(c.source, [owner.snapshot]), p, "Proposal/source/aliases/target changed");
  }
}
export async function finalizeOfflinePlan(
  store: OfflineRepairStore, originalProposal: OriginalProposal, expectedProposalDigest: string,
  readiness: Readiness, now = Date.now(),
): Promise<FinalPlan> {
  assert.equal(store.mode, "disposable-only", "Live execution is not implemented or authorized");
  originalProposal = structuredClone(originalProposal);
  readiness = structuredClone(readiness);
  const {proposals} = originalProposal;
  assert.ok(proposals.length > 0 && proposals.length <= 100, "Pilot limit exceeded");
  assert.equal(digest(originalProposal), expectedProposalDigest, "Original proposal digest mismatch");
  assert.deepEqual(originalProposal.held, [], "Original proposal contains held cases");
  assert.equal(originalProposal.repairAuthorized, false);
  assert.equal(originalProposal.livePreflightRequired, true);
  verifyReadiness(readiness, now);
  const keys = proposals.map(p => `${p.shopId}:${p.provider}:${p.sourceId.toLowerCase()}`);
  assert.equal(new Set(keys).size, keys.length, "Repeated identity");
  return store.preflight(async tx => {
    const cases: CurrentCase[] = [];
    for (const p of proposals) {
      const c = await tx.read(p);
      verifyCase(p, c);
      cases.push(c);
    }
    for (const side of ["canonical", "shadow"] as const) {
      assert.equal(new Set(cases.map(c => c[side][0].key)).size, cases.length, "Repeated target");
    }
    return structuredClone({version: 1, proposalDigest: expectedProposalDigest, originalProposal, proposals,
      cases, readiness, preflightAt: now, expiresAt: now + MAX_AGE});
  });
}
function patched(c: CurrentCase, p: Proposal): CurrentCase {
  const next = structuredClone(c);
  for (const side of ["canonical", "shadow"] as const) {
    const owner = next[side][0];
    owner.row.custom_fields.invoiceHours = structuredClone(p.patch.value);
    owner.snapshot.custom_fields.invoiceHours = structuredClone(p.patch.value);
    owner.revision++;
  }
  return next;
}
function validateAuthorization(plan: FinalPlan, approval: Approval, now: number) {
  assert.equal(plan.version, 1);
  assert.ok(plan.proposals.length > 0 && plan.proposals.length <= 100);
  assert.equal(plan.proposals.length, plan.cases.length);
  assert.equal(plan.proposalDigest, digest(plan.originalProposal));
  equal(plan.originalProposal.proposals, plan.proposals, "Proposal list changed");
  assert.equal(approval.planDigest, digest(plan), "Approval is for another finalized plan");
  assert.equal(approval.preflightDigest, digest({cases: plan.cases, readiness: plan.readiness, at: plan.preflightAt}));
  assert.ok(approval.action === "apply" || approval.action === "rollback");
  assert.ok(approval.approvedBy.trim() && approval.approvalReference.trim(), "Separate approval required");
  assert.ok(plan.preflightAt <= approval.approvedAt && approval.approvedAt <= now);
  assert.ok(now < approval.expiresAt && now < plan.expiresAt && plan.expiresAt <= plan.preflightAt + MAX_AGE,
    "Approval or preflight expired; never silently refresh");
  verifyReadiness(plan.readiness, now);
}
/** One owner pair per transaction. Stop at the first rejected/ambiguous outcome. */
export async function executeOfflinePlan(
  store: OfflineRepairStore, plan: FinalPlan, approval: Approval, clock = Date.now,
): Promise<AuditEvent[]> {
  assert.equal(store.mode, "disposable-only", "Live execution is disabled");
  // Detach caller-owned objects before any await.
  plan = structuredClone(plan); approval = structuredClone(approval);
  validateAuthorization(plan, approval, clock());
  const results: AuditEvent[] = [];
  for (let index = 0; index < plan.proposals.length; index++) {
    const p = plan.proposals[index], before = plan.cases[index];
    const planDigest = digest(plan), key = `${planDigest}:${index}`;
    const base = {planDigest, index, action: approval.action, approvalReference: approval.approvalReference};
    try {
      const result = await store.transaction(async tx => {
        validateAuthorization(plan, approval, clock());
        const receipt = await tx.receipt(key);
        const current = await tx.read(p);
        verifyCase(p, before);
        const expectedAfter = patched(before, p);
        if (receipt) {
          equal({planDigest: receipt.planDigest, index: receipt.index, before: receipt.before, after: receipt.after},
            {planDigest, index, before, after: expectedAfter}, "Receipt binding changed");
        }
        let outcome: AuditEvent["outcome"];
        if (approval.action === "apply") {
          assert.notEqual(receipt?.state, "rolled_back", "Rolled-back plan cannot be reapplied");
          if (receipt) {
            equal(current, receipt.after, "Committed repair has since changed");
            outcome = "already_applied";
          } else {
            equal(current, before, "Stale state/owners/source/holds; new review required");
            assert.ok(await tx.compareAndSet(p, before, expectedAfter), "Compare-and-set lost");
            equal(await tx.read(p), expectedAfter, "Canonical/shadow verification failed");
            await tx.saveReceipt(key, {planDigest, index, state: "applied", before, after: expectedAfter});
            outcome = "applied";
          }
        } else {
          assert.ok(receipt, "No committed repair to roll back");
          const restored = structuredClone(before);
          // Do not rewind revision tokens; prevents ABA acceptance.
          for (const side of ["canonical", "shadow"] as const) restored[side][0].revision = expectedAfter[side][0].revision + 1;
          if (receipt.state === "rolled_back") {
            equal(current, restored, "Rolled-back target has since changed");
            outcome = "already_rolled_back";
          } else {
            equal(current, expectedAfter, "Conditional rollback refused changed state");
            assert.ok(await tx.compareAndSet(p, current, restored), "Rollback compare-and-set lost");
            equal(await tx.read(p), restored, "Rollback verification failed");
            await tx.saveReceipt(key, {...receipt, state: "rolled_back"});
            outcome = "rolled_back";
          }
        }
        const event = {...base, outcome};
        await tx.audit(event);
        return event;
      });
      results.push(result);
    } catch (error) {
      // Never infer rollback from a rejected COMMIT response. The atomic receipt
      // is authoritative on retry. No raw rows or exception text in audit output.
      await store.auditFailure({...base, outcome: "rejected_or_unknown"});
      throw error;
    }
  }
  return results;
}

/** Safe after approval expiry: inspect durable results, never retry a write. */
export async function inspectOfflineOutcomes(store: OfflineRepairStore, plan: FinalPlan) {
  assert.equal(store.mode, "disposable-only");
  plan = structuredClone(plan);
  const planDigest = digest(plan);
  return store.preflight(async tx => {
    const results = [];
    for (let index = 0; index < plan.proposals.length; index++) {
      const receipt = await tx.receipt(`${planDigest}:${index}`);
      if (!receipt) {
        results.push({index, state: "not_committed" as const});
        continue;
      }
      const before = plan.cases[index], after = patched(before, plan.proposals[index]);
      equal({planDigest: receipt.planDigest, index: receipt.index, before: receipt.before, after: receipt.after},
        {planDigest, index, before, after}, "Receipt binding changed");
      const expected = receipt.state === "applied" ? after : structuredClone(before);
      if (receipt.state === "rolled_back") {
        for (const side of ["canonical", "shadow"] as const) expected[side][0].revision = after[side][0].revision + 1;
      }
      results.push({index, state: receipt.state,
        currentStateMatches: digest(await tx.read(plan.proposals[index])) === digest(expected)});
    }
    return results;
  });
}
