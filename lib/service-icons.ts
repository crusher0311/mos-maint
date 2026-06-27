/**
 * Single source of truth for resolving a maintenance item's
 * `serviceKey`/`title` to a service-icon key (oil drop, differential, cabin
 * air filter, etc.).
 *
 * This module is intentionally PURE (no React, no `fs`) so it can be imported
 * by both the `"use client"` `ServiceIcon` component and server-side API
 * routes. The customer-facing report and the external/partner VHI API resolve
 * icons through the exact same logic, so they always agree on which pictogram
 * a given service maps to.
 *
 * The actual inline SVG artwork lives server-side in `lib/vhi-icons.ts`
 * (`getServiceIconSet`/`getServiceIconSvg`) so we don't pull ~160KB of SVG
 * strings into the client bundle.
 */

/**
 * icon-key -> public artwork path. The browser component renders these files
 * directly; the server SVG set reads their contents to inline them for
 * partners (who can't load our relative `/icons/service/*.svg` paths).
 */
export const ICON_KEY_TO_IMAGE: Record<string, string> = {
  brake_pads_front: "/icons/service/brakes.svg",
  brake_pads_rear: "/icons/service/brakes.svg",
  brake_fluid: "/icons/service/brake_fluid.svg",
  wiper_blades: "/icons/service/wiper_blades.svg",
  transmission_fluid: "/icons/service/transmission_fluid.svg",
  engine_air_filter: "/icons/service/air_filter.svg",
  cabin_air_filter: "/icons/service/cabin_air_filter.svg",
  spark_plugs: "/icons/service/spark_plugs.svg",
  engine_oil: "/icons/service/oil_change.svg",
  oil_change: "/icons/service/oil_change.svg",
  tires_rotate: "/icons/service/tire_rotation.svg",
  coolant: "/icons/service/coolant.svg",
  differential_rear: "/icons/service/differential.svg",
  differential_front: "/icons/service/differential.svg",
  serpentine_belt: "/icons/service/serpentine_belt.svg",
  transfer_case: "/icons/service/transfer_case.svg",
  battery: "/icons/service/battery.svg",
  power_steering: "/icons/service/power_steering.svg",
  fuel_system: "/icons/service/fuel_system.svg",
  coolant_hoses: "/icons/service/coolant_hoses.svg",
  front_shocks: "/icons/service/shocks.svg",
  rear_shocks: "/icons/service/shocks.svg",
  wheel_alignment: "/icons/service/wheel_alignment.svg",
  lubricate: "/icons/service/lubricate.svg",
  bolt_torque: "/icons/service/bolt_torque.svg",
  oil_reminder: "/icons/service/oil_reminder.svg",
  chassis_body: "/icons/service/chassis_body.svg",
  general_service: "/icons/service/general_service.svg",
};

/**
 * Keyword -> icon-key matching, applied (in order) against the lowercased
 * title/serviceKey when there is no direct key match. Order matters: more
 * specific phrases must come before broad ones (e.g. "differential front"
 * before bare "differential").
 */
export const titleKeywordMap: Array<[string[], string]> = [
  [["torque", "re-torque", "retorque", "bolt", "nut"], "bolt_torque"],
  [["propeller shaft", "prop shaft", "driveshaft", "drive shaft", "lubricate"], "lubricate"],
  [["oil reminder", "maint reqd", "oil reset", "reset oil", "oil replacement reminder"], "oil_reminder"],
  [["chassis", "body", "tighten"], "chassis_body"],
  [["serpentine", "drive belt", "accessory belt", "v-belt", "timing belt"], "serpentine_belt"],
  [["transfer case"], "transfer_case"],
  [["differential front", "front differential"], "differential_front"],
  [["differential rear", "rear differential"], "differential_rear"],
  [["differential"], "differential_rear"],
  [["transmission", "trans fluid", "atf"], "transmission_fluid"],
  [["coolant hose", "radiator hose", "heater hose"], "coolant_hoses"],
  [["coolant", "antifreeze"], "coolant"],
  [["brake pad", "front brake", "rear brake", "brake shoe"], "brake_pads_front"],
  [["brake fluid"], "brake_fluid"],
  [["cabin filter", "cabin air"], "cabin_air_filter"],
  [["air filter", "engine filter"], "engine_air_filter"],
  [["spark plug", "ignition"], "spark_plugs"],
  [["oil change", "engine oil", "motor oil", "oil filter"], "oil_change"],
  [["tire rotat", "rotate tire"], "tires_rotate"],
  [["wiper", "windshield wiper"], "wiper_blades"],
  [["battery"], "battery"],
  [["power steering", "steering fluid"], "power_steering"],
  [["fuel system", "fuel inject", "fuel filter", "fuel induction"], "fuel_system"],
  [["shock", "strut", "suspension"], "front_shocks"],
  [["wheel align", "alignment"], "wheel_alignment"],
  [["inspect", "check", "examine", "visual"], "general_service"],
];

/**
 * The general/default fallback icon key. Items with no specific match resolve
 * to this so partners (and our UI) never render a missing icon.
 */
export const DEFAULT_SERVICE_ICON_KEY = "general_service";

/**
 * The DVI-finding triangle is a JSX-only icon in the component (no artwork
 * file); the server SVG set hand-authors markup for it under this key.
 */
export const DVI_FINDING_ICON_KEY = "dvi_finding";

/**
 * Keys we have a concrete icon for (artwork file or the DVI-finding marker).
 * A `serviceKey` that exactly matches one of these short-circuits keyword
 * matching.
 */
export const KNOWN_ICON_KEYS: Set<string> = new Set([
  ...Object.keys(ICON_KEY_TO_IMAGE),
  DVI_FINDING_ICON_KEY,
]);

/**
 * Resolve a `serviceKey`/`title` to a service-icon key. Always returns a real
 * key present in the service-icon set (falls back to the general icon), so
 * callers never have to special-case "no icon".
 *
 * Resolution order (matches the customer-facing report):
 *  1. DVI findings -> the warning-triangle icon.
 *  2. An exact `serviceKey` match against a known icon key.
 *  3. Keyword match against the title (then serviceKey).
 *  4. The general/default icon.
 */
export function resolveServiceIconKey(serviceKey: string | null, title?: string): string {
  if (!serviceKey && !title) return DEFAULT_SERVICE_ICON_KEY;

  if (serviceKey?.startsWith("dvi_finding") || serviceKey?.startsWith("dvi_unmapped")) {
    return DVI_FINDING_ICON_KEY;
  }

  if (serviceKey && KNOWN_ICON_KEYS.has(serviceKey)) return serviceKey;

  const titleLower = (title || serviceKey || "").toLowerCase();
  for (const [keywords, iconKey] of titleKeywordMap) {
    if (keywords.some((kw) => titleLower.includes(kw))) return iconKey;
  }

  return DEFAULT_SERVICE_ICON_KEY;
}
