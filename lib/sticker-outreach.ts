const WEEK = 7 * 24 * 60 * 60 * 1000;
function date(value: unknown): number | null {
  if (!(typeof value === "string" || value instanceof Date)) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}
export function stickerOutreach(shop: any, row: any, available: boolean, now = Date.now(), eligible = false) {
  const last = date(row?.lastAt);
  const created = date(shop.activatedAt) ?? date(shop.createdAt);
  const state = !available ? "unavailable" : last !== null ? "recorded" :
    row?.count > 0 || created === null ? "unknown" : "never-recorded";
  const anchor = last ?? created;
  const canceled = ["canceled", "cancelled", "churned"].includes(shop.billing?.status) || shop.billing?.plan === "churned";
  return {
    state, lastAt: last === null ? null : new Date(last).toISOString(),
    evidence: last === null ? null : row?.evidence || "legacy-generation",
    inactive: available && eligible && !canceled && (state === "recorded" || state === "never-recorded") &&
      anchor !== null && now - anchor >= WEEK,
    sortAt: anchor === null ? null : new Date(anchor).toISOString(),
  };
}
