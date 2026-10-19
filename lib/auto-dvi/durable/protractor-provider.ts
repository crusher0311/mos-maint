import { resolveProtractorConfig, fetchWorkOrderById, protractorFetch } from "@/lib/integrations/protractor";
import { DurableError, type Scope, type Request, type Snapshot, type Target, type Stage } from "./model";
import type { Provider } from "./service";

/** Installed only after a separately authorized provider pilot. Normalization
 * must verify nested completeness, VIN, openness, labels and revision semantics.
 * An exclusive window must remain valid until the transport actually settles,
 * not merely until an HTTP route timeout or a local worker lease expires. */
export interface VerifiedProtractorCapabilities {
  connectionVersion: string;
  read(raw: unknown, target: Target): Snapshot;
  /** Independent setup enumeration/evidence, not labels echoed by an upsert. */
  resultLabels(target: Target): Promise<NonNullable<Snapshot["resultLabels"]>>;
  exclusiveWrite<T>(target: Target, revision: string, sendOnce: () => Promise<T>): Promise<T>;
}
export class ProtractorDurableProvider implements Provider {
  readonly concurrencyVerified: boolean;
  constructor(private capabilities?: VerifiedProtractorCapabilities) {
    this.concurrencyVerified = !!capabilities;
  }
  async target(scope: Scope, request: Request): Promise<Target> {
    const config = await resolveProtractorConfig(scope.shopId);
    if (!config.configured || config.shopId !== scope.shopId) throw new DurableError("PROVIDER_NOT_CONFIGURED", 403);
    return {shopId: scope.shopId, connection: config.connectionId,
      connectionVersion: this.capabilities?.connectionVersion || "unverified",
      guid: request.workOrderGuid, vin: request.vin};
  }
  async read(target: Target): Promise<Snapshot> {
    const config = await resolveProtractorConfig(target.shopId);
    if (!config.configured || config.connectionId !== target.connection) throw new DurableError("CONNECTION_CHANGED");
    if (!this.capabilities || this.capabilities.connectionVersion !== target.connectionVersion)
      throw new DurableError("PROVIDER_CAPABILITY_UNVERIFIED", 503);
    const response = await fetchWorkOrderById(target.shopId, target.guid, {priority: true, maxRetries: 0, timeoutMs: 15_000});
    if (!response.ok) throw new DurableError("READ_UNAVAILABLE", 503);
    const snapshot = this.capabilities.read(response.workOrder, target);
    return {...snapshot, resultLabels: await this.capabilities.resultLabels(target)};
  }
  async write(target: Target, stage: Stage, payload: Record<string, any>, expectedRevision: string): Promise<boolean> {
    if (!this.capabilities || this.capabilities.connectionVersion !== target.connectionVersion)
      throw new DurableError("PROVIDER_CAPABILITY_UNVERIFIED", 503);
    const config = await resolveProtractorConfig(target.shopId);
    if (!config.configured || config.connectionId !== target.connection || config.shopId !== target.shopId)
      throw new DurableError("CONNECTION_CHANGED");
    let sent = false;
    return this.capabilities.exclusiveWrite(target, expectedRevision, async () => {
      if (sent) throw new DurableError("SECOND_TRANSPORT_FORBIDDEN");
      sent = true;
      const result = await protractorFetch(`/WorkOrder/${target.guid}${stage === "findings" ? "/Inspection" : ""}`,
        config, {method: "POST", body: JSON.stringify(payload)}, 0, target.shopId,
        {priority: true, maxRetries: 0, timeoutMs: 15_000});
      return result.ok;
    });
  }
}
