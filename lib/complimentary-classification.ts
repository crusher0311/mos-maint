const COMPLIMENTARY_TITLE_PATTERNS: RegExp[] = [
  /reset\b.*(?:oil|service|maintenance|minder|reminder|display|light|monitor|assyst|cbs|interval)/i,
  /(?:oil|service|maintenance)\s*(?:life|replacement)?\s*(?:reminder|reset|monitor|display|light)/i,
  /^(?:perform |do )?road test/i,
  /^(?:perform |do )?test drive/i,
  /^(?:visual(?:ly)?|perform)?\s*inspect/i,
  /^check\b/i,
  /^verify\b/i,
  /^measure\b/i,
  /^adjust\s+(?:headlight|parking\s*brake)/i,
  /^brief diagnostic/i,
  /\blubricate\b(?!.*(?:transm|diff|axle|transfer))/i,
  /\btighten\b.*(?:bolt|nut|fastening|chassis|body)/i,
  /\bre-?torque\b/i,
  /flush underbody/i,
  /activate\s*(?:automatic\s+)?(?:roll-?over|protection|tire\s+pressure|tpms)/i,
  /adapt service interval/i,
  /multi-?point inspection/i,
  /tire pressure (?:check|set|monitor)/i,
  /set tire pressure/i,
  /fill (?:fuel|gas) tank/i,
  /replace (?:intelligent key|remote control key|key fob|fob)\s*battery/i,
  /(?:sunroof|sun roof|sliding roof).*(?:check|clean|lubricate)/i,
  /clean\s+(?:and\s+)?lubricate\s+(?:sun|sliding)\s*roof/i,
  /drain diesel exhaust fluid/i,
  /^replace (?:misc\.?\s*)?light\s*bulb/i,
  /^replace lighting$/i,
  /verify check control/i,
  /reset tire pressure/i,
];

const COMPLIMENTARY_SERVICE_KEYS = new Set([
  "oil_reminder",
  "oil_replacement_reminder",
  "reset_oil_replacement_reminder",
  "chassis_body",
  "tighten_nuts_bolts",
  "multi_point_inspection",
  "tire_pressure",
  "tire_pressure_check",
]);

export function isComplimentaryItem(item: {
  serviceKey?: string;
  key?: string;
  title?: string;
}): boolean {
  const key = (item.serviceKey || item.key || "").toLowerCase();
  if (COMPLIMENTARY_SERVICE_KEYS.has(key)) return true;

  const title = (item.title || item.key || "").trim();
  if (!title) return false;

  return COMPLIMENTARY_TITLE_PATTERNS.some((p) => p.test(title));
}
