import assert from "node:assert/strict";
import {
  extractCallbackVehicleVin,
  extractCallbackWorkOrderVin,
} from "../lib/integrations/protractor/callback-vin";
import {
  __terminalCallbackDeps,
  applyProtractorTerminalCallback,
} from "../lib/integrations/protractor/callback-terminal";
import { replayDeferredTerminalPost } from "../lib/integrations/protractor/callback-replay";

async function main() {
  assert.equal(
    extractCallbackWorkOrderVin({
      ID: "wo-1",
      VIN: "1hgcm82633a004352",
      ServiceItem: { ID: "si-1", VIN: "", Lookup: "customer-unit-7" },
    } as any),
    "1HGCM82633A004352",
    "a valid top-level provider VIN is not hidden by an empty ServiceItem VIN",
  );
  assert.equal(
    extractCallbackVehicleVin({
      ID: "si-1",
      VIN: "",
      Lookup: "1m8gdm9axkp042788",
    }),
    "1M8GDM9AXKP042788",
    "Lookup is accepted only when it validates as a VIN",
  );
  assert.equal(
    extractCallbackVehicleVin({ ID: "si-1", Lookup: "customer-unit-7" }),
    null,
  );
  assert.equal(
    extractCallbackVehicleVin({ ID: "si-1", VIN: "1IOGDM9AXKP042788" }),
    null,
    "invalid VIN characters are rejected",
  );

  const replayEvent = {
    key: "post-1",
    shopId: 42,
    objectId: "wo-closed",
    operation: "CLOSED",
  };
  const replayBase = {
    fetchWorkOrderById: async () => ({
      ok: true,
      workOrder: { ID: "wo-closed", ServiceItem: { ID: "si-1", VIN: "1HGCM82633A004352" } },
    }),
    upsertProtractorWorkOrderSnapshot: async () => undefined,
  };
  assert.equal(
    await replayDeferredTerminalPost({} as any, replayEvent, {
      ...replayBase,
      applyProtractorTerminalCallback: async () => "already_absent",
    }),
    false,
    "a non-DELETE terminal replay cannot treat canonical-store absence as success",
  );
  assert.equal(
    await replayDeferredTerminalPost({} as any, replayEvent, {
      ...replayBase,
      applyProtractorTerminalCallback: async () => "applied",
    }),
    true,
  );

  const originals = { ...__terminalCallbackDeps };
  const dashboardWrites: unknown[] = [];
  const db = {
    collection(name: string) {
      assert.equal(name, "dashboard_updates");
      return {
        updateOne: async (...args: unknown[]) => {
          dashboardWrites.push(args);
        },
      };
    },
  } as any;

  try {
    __terminalCallbackDeps.findCachedWorkOrderById = async () => null;
    __terminalCallbackDeps.findNormalizedReference = async () => null;
    __terminalCallbackDeps.findVehicleReference = async () => null;
    __terminalCallbackDeps.markCachedWorkOrderTerminal = async () => {
      throw new Error("must not update an absent work order");
    };
    __terminalCallbackDeps.removeVehicleSource = async () => {
      throw new Error("must not update an absent vehicle");
    };
    assert.equal(
      await applyProtractorTerminalCallback(db, {
        shopId: "42",
        workOrderId: "absent-wo",
        status: "Deleted",
      }),
      "already_absent",
    );
    assert.equal(dashboardWrites.length, 0, "an already-absent no-op performs no writes");

    __terminalCallbackDeps.findCachedWorkOrderById = async () => {
      throw new Error("cache read unavailable");
    };
    await assert.rejects(
      applyProtractorTerminalCallback(db, {
        shopId: 42,
        workOrderId: "unknown",
        status: "Deleted",
      }),
      /cache read unavailable/,
      "read failures are not interpreted as proof of absence",
    );

    __terminalCallbackDeps.findCachedWorkOrderById = async () => null;
    __terminalCallbackDeps.findNormalizedReference = async () => ({ _id: "normalized" } as any);
    await assert.rejects(
      applyProtractorTerminalCallback(db, {
        shopId: 42,
        workOrderId: "normalized-only",
        status: "Deleted",
      }),
      /stores are inconsistent/,
      "a surviving normalized reference remains retryable instead of becoming a no-op",
    );

    const updates: Array<{ kind: string; args: unknown[] }> = [];
    const matchedWorkOrder = {
      _id: "mongo-work-order-id",
      shopId: "42",
      workOrderId: "canonical-cache-id",
    } as any;
    const matchedVehicle = {
      _id: "mongo-vehicle-id",
      shopId: "42",
      vin: "1HGCM82633A004352",
      status: { sources: [{ provider: "protractor", workOrderId: "provider-guid" }] },
    } as any;
    __terminalCallbackDeps.findCachedWorkOrderById = async (shopId, workOrderId) => {
      assert.equal(shopId, 42);
      assert.equal(workOrderId, "provider-guid");
      return matchedWorkOrder;
    };
    __terminalCallbackDeps.findNormalizedReference = async () => ({ _id: "normalized" } as any);
    __terminalCallbackDeps.findVehicleReference = async () => matchedVehicle;
    __terminalCallbackDeps.markCachedWorkOrderTerminal = async (...args) => {
      updates.push({ kind: "work_order", args });
    };
    __terminalCallbackDeps.removeVehicleSource = async (...args) => {
      updates.push({ kind: "vehicle", args });
    };
    assert.equal(
      await applyProtractorTerminalCallback(db, {
        shopId: 42,
        workOrderId: "provider-guid",
        status: "Deleted",
      }),
      "applied",
    );
    assert.equal(updates.length, 2);
    const workOrderUpdate = updates.find((update) => update.kind === "work_order")!;
    assert.equal(workOrderUpdate.args[1], matchedWorkOrder);
    assert.deepEqual(workOrderUpdate.args.slice(0, 3), [42, matchedWorkOrder, "Deleted"]);
    const vehicleUpdate = updates.find((update) => update.kind === "vehicle")!;
    assert.equal(vehicleUpdate.args[0], matchedVehicle);
    assert.equal(vehicleUpdate.args[1], 42);
    assert.equal(dashboardWrites.length, 1);
  } finally {
    Object.assign(__terminalCallbackDeps, originals);
  }

  console.log("Protractor callback reliability checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});