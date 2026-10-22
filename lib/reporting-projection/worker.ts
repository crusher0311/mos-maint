import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { requireHoldCoverage } from "../invoice-repair/hold-registry";
import {
  classify, EMPTY_DIGEST, builderEnabled as enabled, hash, LIMITS, PARSER_VERSION, UUID,
  type Copy, type Review, type SourceInventory,
} from "./contract";

/** No operational writes: sql must have reporting-table-only write permissions. */
export class InvoiceProjectionWorker {
  constructor(private readonly sql: ReturnType<typeof postgres>, private readonly source: SourceInventory) {}

  async start(shop: number) {
    if (!enabled()) return null;
    assert.ok(Number.isSafeInteger(shop) && shop > 0);
    assert.ok(this.source.channels.length > 0 && this.source.channels.length <= 30);
    assert.equal(new Set(this.source.channels).size, this.source.channels.length);
    return this.sql.begin(async tx => {
      await tx.unsafe("SET LOCAL statement_timeout='2000ms'");
      await tx.unsafe("INSERT INTO reporting_invoice.scopes(shop_id) VALUES($1) ON CONFLICT DO NOTHING", [shop]);
      const [scope] = await tx.unsafe("SELECT * FROM reporting_invoice.scopes WHERE shop_id=$1 FOR UPDATE", [shop]);
      const [existing] = await tx.unsafe(`SELECT id FROM reporting_invoice.builds WHERE shop_id=$1
        AND phase IN ('inventory','verify','project')`, [shop]);
      if (existing) return existing.id as string;
      const id = randomUUID();
      await tx.unsafe(`INSERT INTO reporting_invoice.builds(id,shop_id,revision,parser_version,channels,digest)
        VALUES($1,$2,$3,$4,$5::text::jsonb,$6)`,
      [id, shop, scope.revision, PARSER_VERSION, JSON.stringify(this.source.channels), EMPTY_DIGEST]);
      return id;
    });
  }

  async cancel(id: string) {
    if (!enabled()) return;
    await this.sql.unsafe(`UPDATE reporting_invoice.builds SET phase='cancelled'
      WHERE id=$1 AND phase IN ('inventory','verify','project')`, [id]);
  }

  async tick(id: string, options: { signal?: AbortSignal; steps?: number; budgetMs?: number; inventoryOnly?: boolean } = {}) {
    if (!enabled()) return { status: "disabled", steps: 0 };
    const steps = options.steps ?? LIMITS.tickSteps, budget = options.budgetMs ?? LIMITS.tickMs;
    assert.ok(Number.isSafeInteger(steps) && steps > 0 && steps <= LIMITS.tickSteps);
    assert.ok(Number.isSafeInteger(budget) && budget > 0 && budget <= LIMITS.tickMs);
    const deadline = Date.now() + budget;
    let completed = 0;
    while (completed < steps && Date.now() < deadline && !options.signal?.aborted) {
      // One small transaction per document/identity. Lost responses replay durable state.
      const status = await this.step(id, deadline, options.signal, options.inventoryOnly);
      if (status !== "progress") return { status, steps: completed };
      completed++;
    }
    return { status: options.signal?.aborted ? "cancelled_tick" : "deferred", steps: completed };
  }

  private async step(id: string, deadline: number, signal?: AbortSignal, inventoryOnly = false): Promise<string> {
    return this.sql.begin(async tx => {
      await tx.unsafe("SET LOCAL statement_timeout='2000ms'");
      await tx.unsafe("SET LOCAL lock_timeout='250ms'");
      const [metadata] = await tx.unsafe("SELECT shop_id FROM reporting_invoice.builds WHERE id=$1", [id]);
      assert.ok(metadata, "Unknown projection build");
      // Same ordering as invalidation/publication; SKIP LOCKED admits only one worker.
      const [scope] = await tx.unsafe("SELECT * FROM reporting_invoice.scopes WHERE shop_id=$1 FOR UPDATE SKIP LOCKED", [metadata.shop_id]);
      if (!scope) return "busy";
      const [b] = await tx.unsafe("SELECT * FROM reporting_invoice.builds WHERE id=$1 FOR UPDATE", [id]);
      if (["complete", "failed", "cancelled"].includes(b.phase)) return b.phase;
      const fail = async (reason: string) => {
        await tx.unsafe("UPDATE reporting_invoice.builds SET phase='failed',failure=$2 WHERE id=$1", [id, reason]);
        return "failed";
      };
      if (b.parser_version !== PARSER_VERSION ||
        JSON.stringify(b.channels) !== JSON.stringify(this.source.channels)) return fail("source_or_parser_changed");
      if (signal?.aborted || Date.now() >= deadline) return "deferred";
      if (inventoryOnly && b.phase !== "inventory") return "awaiting_feed";
      // A scope revision is a freshness veto, not proof that this inventory's
      // exact source versions changed. Preserve durable inventory across traffic.
      // A new verification pass must compare every source key/digest, including
      // insertions/deletions, and remain in one unchanged revision.
      if (b.phase !== "inventory" && String(b.revision) !== String(scope.revision)) {
        await tx.unsafe(`UPDATE reporting_invoice.builds SET phase='verify',channel=0,cursor=NULL,
          digest=$2,revision=$3,verified_at=clock_timestamp(),checkpoint=NULL WHERE id=$1`,
        [id, EMPTY_DIGEST, scope.revision]);
        // Resetting the checkpoint reprocesses every item before publication.
        // Avoid a single unbounded UPDATE of up to 100,000 fact rows here.
        return "progress";
      }

      if (b.phase === "inventory" || b.phase === "verify") {
        const channel = this.source.channels[b.channel];
        if (!channel) {
          if (b.phase === "inventory") {
            if (inventoryOnly) return "awaiting_feed";
            await tx.unsafe(`UPDATE reporting_invoice.builds SET phase='verify',channel=0,cursor=NULL,
              inventory_digest=digest,digest=$2,revision=$3,verified_at=clock_timestamp() WHERE id=$1`,
            [id, EMPTY_DIGEST, scope.revision]);
          } else {
            if (b.digest !== b.inventory_digest) return fail("inventory_changed");
            await tx.unsafe("UPDATE reporting_invoice.builds SET phase='project' WHERE id=$1", [id]);
          }
          return "progress";
        }
        const doc = await this.source.next(channel, b.shop_id, b.cursor);
        if (signal?.aborted || Date.now() >= deadline) return "deferred";
        if (!doc) {
          await tx.unsafe("UPDATE reporting_invoice.builds SET channel=channel+1,cursor=NULL WHERE id=$1", [id]);
          return "progress";
        }
        assert.ok(doc.key !== b.cursor, "Inventory cursor did not advance");
        assert.ok(doc.identities.length <= 101, "source_identity_limit");
        if (b.phase === "inventory") {
          if (b.document_count >= LIMITS.documents) return fail("document_limit");
          await tx.unsafe(`INSERT INTO reporting_invoice.sources VALUES($1,$2,$3,$4)`,
            [id, channel, doc.key, doc.digest]);
          let added = 0;
          for (const identity of doc.identities) {
            const inserted = await tx.unsafe("INSERT INTO reporting_invoice.items(build_id,identity) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING identity", [id, identity]);
            added += inserted.length;
            await tx.unsafe(`INSERT INTO reporting_invoice.refs VALUES($1,$2,$3,$4,$5,$6,$7)`,
              [id, identity, channel, doc.key, doc.digest, doc.owner, doc.ambiguous]);
          }
          if (b.identity_count + added > LIMITS.identities) return fail("identity_limit");
          await tx.unsafe(`UPDATE reporting_invoice.builds SET document_count=document_count+1,
            identity_count=$2 WHERE id=$1`, [id, b.identity_count + added]);
        } else {
          // Fail on a real changed/new source version even when broad revisions
          // keep arriving. Do not repeatedly reset past a known evidence veto.
          const [original] = await tx.unsafe(`SELECT digest FROM reporting_invoice.sources
            WHERE build_id=$1 AND channel=$2 AND source_key=$3`, [id, channel, doc.key]);
          if (!original || original.digest !== doc.digest) return fail("source_changed");
        }
        await tx.unsafe("UPDATE reporting_invoice.builds SET cursor=$2,digest=$3 WHERE id=$1",
          [id, doc.key, hash([b.digest, channel, doc.key, doc.digest])]);
        return "progress";
      }

      // A completed rescan is deliberately short lived, not a promise of cross-store atomicity.
      if (Date.now() - +new Date(b.verified_at) >= LIMITS.freshnessMs) return fail("verification_expired");
      const [item] = await tx.unsafe(`SELECT identity FROM reporting_invoice.items
        WHERE build_id=$1 AND ($2::text IS NULL OR identity COLLATE "C">$2)
        ORDER BY identity COLLATE "C" LIMIT 1`, [id, b.checkpoint]);
      if (!item) {
        const [remaining] = await tx.unsafe("SELECT count(*)::int n FROM reporting_invoice.items WHERE build_id=$1 AND classification IS NULL", [id]);
        assert.equal(remaining.n, 0);
        await tx.unsafe("UPDATE reporting_invoice.builds SET phase='complete',published_at=clock_timestamp() WHERE id=$1", [id]);
        await tx.unsafe("UPDATE reporting_invoice.scopes SET published=$2 WHERE shop_id=$1", [b.shop_id, id]);
        return "complete";
      }
      const refs = await tx.unsafe(`SELECT channel,source_key AS key,digest,owner,ambiguous FROM reporting_invoice.refs
        WHERE build_id=$1 AND identity=$2 ORDER BY channel COLLATE "C",source_key COLLATE "C" LIMIT $3`,
      [id, item.identity, LIMITS.copies + 1]) as unknown as Copy[];
      const input = hash(refs);
      let reason: string | null = refs.length > LIMITS.copies ? "copy_limit" : null;
      const raws: unknown[] = [];
      let bytes = 0;
      if (!reason) for (const ref of refs) {
        if (signal?.aborted) return "deferred";
        if (Date.now() >= deadline) { reason = "identity_deadline_limit"; break; }
        const doc = await this.source.load(ref.channel, b.shop_id, ref.key);
        if (signal?.aborted) return "deferred";
        if (!doc || doc.digest !== ref.digest) return fail("source_changed");
        bytes += Buffer.byteLength(JSON.stringify(doc.raws));
        if (bytes > LIMITS.identityBytes) { reason = "identity_byte_limit"; break; }
        // Archive pages contain many identities; don't misattribute their other invoices.
        raws.push(...doc.raws.filter((r: any) => String(r?.ID).toLowerCase() === item.identity));
      }
      const reviews = await tx.unsafe(`SELECT * FROM reporting_invoice.reviews WHERE shop_id=$1 AND identity=$2
        AND input_digest=$3 AND inventory_digest=$4 AND parser_version=$5 AND revoked_at IS NULL
        AND reviewed_at<=clock_timestamp() AND expires_at>clock_timestamp() ORDER BY id LIMIT 2`,
      [b.shop_id, item.identity, input, b.inventory_digest, PARSER_VERSION]);
      const review = reviews.length === 1 ? reviews[0] as unknown as Review : null;
      let holdReview: string | null = null;
      if (review && UUID.test(item.identity)) {
        const candidates = await tx.unsafe(`SELECT r.id FROM invoice_repair_hold_reviews r
          JOIN invoice_repair_hold_scopes s USING(shop_id,provider)
          WHERE r.shop_id=$1 AND r.provider='protractor' AND r.scope_revision=s.revision
          AND r.inventory_digest=$2 AND r.reviewed_at<=clock_timestamp() AND r.expires_at>clock_timestamp()
          ORDER BY r.reviewed_at DESC LIMIT 1`, [b.shop_id, b.inventory_digest]);
        if (candidates.length) {
          try {
            await requireHoldCoverage(tx as any, { shopId: b.shop_id, provider: "protractor" },
              [item.identity], b.inventory_digest, candidates[0].id);
            holdReview = candidates[0].id;
          } catch (error) {
            // Only an evidence veto is unresolved. Database errors abort/retry the tick.
            if (!(error instanceof assert.AssertionError)) throw error;
          }
        }
      }
      const fact = reason
        ? { classification: "unresolved", reason, invoiceDate: null, sold: null, presented: null }
        : classify(b.shop_id, item.identity, raws, refs.flatMap(r => r.owner ? [r.owner] : []),
          refs.some(r => r.ambiguous) || refs.filter(r => r.channel === "mongo.normalized_work_orders").length > 1,
          review, !!holdReview);
      await tx.unsafe(`UPDATE reporting_invoice.items SET input_digest=$3,classification=$4,reason=$5,
        invoice_date=$6,sold=$7,presented=$8,review_id=$9,hold_review_id=$10 WHERE build_id=$1 AND identity=$2`,
      [id, item.identity, input, fact.classification, fact.reason, fact.invoiceDate, fact.sold, fact.presented, review?.id ?? null, holdReview]);
      await tx.unsafe("UPDATE reporting_invoice.builds SET checkpoint=$2 WHERE id=$1", [id, item.identity]);
      return "progress";
    }) as Promise<string>;
  }
}
