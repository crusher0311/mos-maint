import { AsyncLocalStorage } from "node:async_hooks";
import { readFleetHistoryContext, renewFleetHistoryGrant } from "@/lib/data/repositories/protractor-fleet-history";
import { connectionBinding, storedAccountBinding } from "./connection-identity";
import { isProtractorShopRecord } from "./shop-eligibility";
import { fleetHistoryWindow, validateFleetHistoryConfig, type FleetHistoryPermit } from "./fleet-history-policy";
export const FLEET_HISTORY_KEY = "protractor-physical-transport-v1";
const storage = new AsyncLocalStorage<FleetHistoryPermit & { active: boolean }>();
export const getFleetHistoryContext = () => storage.getStore();
export function fleetShopBinding(shop: any): string {
  storedAccountBinding(shop);
  const id = shop.protractorConnectionId || shop.protractor?.connectionId;
  const key = shop.protractorApiKey || shop.protractor?.apiKey;
  if (!id || !key) throw new Error("Missing Protractor identity");
  return connectionBinding(id, key);
}
export async function assertFleetHistoryContext(shopId?: number, connectionId?: string): Promise<void> {
  const ctx = storage.getStore();
  if (!ctx?.active || (shopId !== undefined && ctx.shopId !== shopId)) throw new Error("Fleet history context invalid");
  const { state, rows } = await readFleetHistoryContext(ctx.shopId);
  const shop = rows.length === 1 ? rows[0] : null;
  const config = validateFleetHistoryConfig(state?.fleetHistoryConfig);
  const grant = state?.fleetHistoryGrant;
  if (!shop || !isProtractorShopRecord(shop) || fleetShopBinding(shop) !== ctx.binding ||
    (connectionId !== undefined && String(shop.protractorConnectionId || shop.protractor?.connectionId).trim().toLowerCase() !== connectionId.trim().toLowerCase()) ||
    config.revision !== ctx.revision || !fleetHistoryWindow(config, shop).allowed ||
    state?.operatorStop?.active !== false || state?.canary?.mode !== "live" ||
    state?.canary?.generation !== ctx.generation || state?.canary?.endedBy ||
    grant?.owner !== ctx.owner || grant?.shopId !== ctx.shopId || grant?.binding !== ctx.binding ||
    state?.fleetHistoryRunner?.owner !== ctx.owner || +new Date(state?.fleetHistoryRunner?.expiresAt) <= Date.now() ||
    !(grant.expiresAt instanceof Date) || +grant.expiresAt <= Date.now() || grant.consumed >= 500)
    throw new Error("Fleet history paused, expired or superseded");
}
export async function withFleetHistory<T>(permit: FleetHistoryPermit, work: () => Promise<T>): Promise<T> {
  let active = true;
  let busy = false;
  const context = Object.freeze({ ...permit, get active() { return active; } });
  return storage.run(context, async () => {
    const timer = setInterval(async () => {
      if (busy || !active) return; busy = true;
      try {
        await assertFleetHistoryContext();
        const r = await renewFleetHistoryGrant(permit);
        if (!r.matchedCount) active = false;
      } catch { active = false; } finally { busy = false; }
    }, 20000);
    try { return await work(); } finally { active = false; clearInterval(timer); }
  });
}
