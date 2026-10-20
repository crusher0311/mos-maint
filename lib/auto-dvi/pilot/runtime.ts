import { staffDependencies } from "../staff/runtime";
import { requireThat } from "../../shop-dispatch/model";
import { connectionHash, PILOT_SHOP } from "./model";
import type { PilotDependencies } from "./service";

async function configured(expected?: string) {
  const api = await import("../../integrations/protractor");
  const config = await api.resolveProtractorConfig(PILOT_SHOP);
  requireThat(config.configured && config.shopId === PILOT_SHOP, "Exact CAR Experts provider connection required", 409);
  requireThat(!expected || connectionHash(config.connectionId) === expected, "Pilot connection changed", 409);
  return {api, config};
}
export const pilotDependencies: PilotDependencies = {...staffDependencies, provider: {
  async connection() { return connectionHash((await configured()).config.connectionId); },
  async read(guid, expected) {
    const {api, config} = await configured(expected);
    const result = await api.protractorFetch<any>(`/WorkOrder/${guid}`, config, {}, 0, PILOT_SHOP,
      {priority: true, maxRetries: 0, timeoutMs: 15000});
    requireThat(result.ok && result.data, "Exact provider read unavailable", 503);
    return result.data;
  },
  async send(guid, payload, expected) {
    const {api, config} = await configured(expected);
    // Explicit accepted-risk synthetic lane, NOT VerifiedProtractorCapabilities.
    // Single native inspection POST. No WorkOrder/pricing writer or SOAP fallback.
    return (await api.protractorFetch(`/WorkOrder/${guid}/Inspection`, config,
      {method: "POST", body: JSON.stringify(payload)}, 0, PILOT_SHOP,
      {priority: true, maxRetries: 0, timeoutMs: 15000})).ok;
  },
}};
