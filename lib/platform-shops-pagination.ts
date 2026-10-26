/** Pure fleet filtering. Pagination must never redefine the bulk-action scope. */
export function paginateShops<T extends Record<string, any>>(shops: T[], params: URLSearchParams, now = Date.now()) {
  const search = (params.get("search") || "").trim().toLowerCase();
  const kpi = params.get("kpiFilter");
  const trial = params.get("trialFilter") || "all";
  const review = params.get("reviewFilter") || "all";
  const sort = params.get("sortBy");
  const active = (s: T) => !s.isLocked && ["active", "trial"].includes(s.billing.status);
  const founder = (s: T) => s.billing.plan === "detect_dog_founder" && s.billing.status === "active";
  const time = (v: unknown) => {
    const n = new Date(v as string).getTime();
    return Number.isFinite(n) ? n : Infinity;
  };
  const filtered = shops.filter(s => {
    if (kpi === "activeOrTrial" && !active(s)) return false;
    if (kpi === "detectDogFounder" && !founder(s)) return false;
    if (search && ![s.name, s.locationIdentifier, s.enterpriseName, s.shopId].some(v => String(v ?? "").toLowerCase().includes(search))) return false;
    const ends = s.trial?.endsAt ? time(s.trial.endsAt) : null;
    if (trial === "trial_active" && !(ends !== null && ends > now)) return false;
    if (trial === "ending_7" || trial === "ending_3") {
      if (!(ends !== null && ends > now && (s.trial?.daysLeft ?? 999) <= (trial === "ending_7" ? 7 : 3))) return false;
    }
    if (trial === "expired" && !(ends !== null && ends <= now)) return false;
    if (trial === "no_card" && !(ends !== null && !s.cardOnFile)) return false;
    const status = s.reviewStatus || "approved";
    if (review === "needs_review" ? !["pending", "flagged"].includes(status) : review !== "all" && review !== status) return false;
    if (params.get("stickerOutreachOnly") === "true" &&
      !(s.stickerActivity?.inactive === true && !["unknown", "unavailable"].includes(s.stickerActivity.state))) return false;
    return true;
  }).sort((a, b) => {
    if (sort === "oldestStickerActivity" || sort === "trialEndsAt") {
      const value = (s: T) => sort === "trialEndsAt" ? time(s.trial?.endsAt) :
        !s.stickerActivity || ["unknown", "unavailable"].includes(s.stickerActivity.state) ? Infinity : time(s.stickerActivity.sortAt);
      const x = value(a), y = value(b);
      if (x !== y) return x < y ? -1 : 1;
    }
    const aTime = time(a.createdAt), bTime = time(b.createdAt);
    if (aTime !== bTime) return aTime > bTime ? -1 : 1;
    return String(a.shopId).localeCompare(String(b.shopId), undefined, { numeric: true });
  });
  const totalPages = Math.max(1, Math.ceil(filtered.length / 50));
  const requested = Number(params.get("page") || 1);
  const page = Math.min(totalPages, Math.max(1, Number.isSafeInteger(requested) ? requested : 1));
  return {
    shops: filtered.slice((page - 1) * 50, page * 50),
    pagination: { page, pageSize: 50, total: filtered.length, totalPages },
    bulkEligibleShops: filtered.filter(s => !!s.trial?.endsAt && !s.cardOnFile)
      .map(s => ({ shopId: s.shopId, name: s.name, trial: s.trial, cardOnFile: s.cardOnFile })),
    bulkApprovePendingShops: filtered.filter(s => (s.reviewStatus || "approved") === "pending")
      .map(s => ({ shopId: s.shopId, name: s.name, reviewStatus: s.reviewStatus })),
    fleet: { total: shops.length, activeOrTrial: shops.filter(active).length,
      active: shops.filter(s => active(s) && s.billing.status === "active").length,
      trialing: shops.filter(s => active(s) && s.billing.status === "trial").length,
      founder: shops.filter(founder).length, updatedAt: new Date(now).toISOString() },
  };
}

export function summaryShopIds(params: URLSearchParams): string[] | null {
  const raw = params.get("shopIds");
  if (!raw) return null;
  const ids = [...new Set(raw.split(",").map(s => s.trim()))];
  if (!ids.length || ids.length > 50 || ids.some(s => !/^[a-zA-Z0-9_-]{1,80}$/.test(s))) return null;
  return ids.sort();
}
