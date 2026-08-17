// Global fleet business-hours guard for INLINE (web-process) backfill work.
//
// 2026-08-14 + 2026-08-17 incidents: per-shop smart-timing quiet windows can
// legitimately extend into mid-morning (a shop that "learned" 20:00–10:00
// local is ALLOWed at 9:30am), but a heavy fullpage chunk running inline on
// the shared web instance starves the event loop for EVERY shop's advisors
// during US business hours. Per-shop windows protect that shop; nothing
// protected the shared process — until this guard.
//
// Semantics:
// - Applies ONLY to the inline web lane. Queue/worker lanes are never gated
//   here (they don't touch web p95).
// - Blocks Mon–Fri between BLOCK_START and BLOCK_END UTC hours (default
//   12:00–23:00 UTC ≈ 6am PT – 6pm ET, covering all US shop timezones).
//   Weekends are open: weekend inline runs never produced complaints and
//   keep the fleet catching up.
// - Kill switch: FULLPAGE_INLINE_BUSINESS_BLOCK_DISABLED=true restores the
//   old behavior with no deploy semantics changes elsewhere.
// - Deferred shops simply aren't handled that tick; night ticks (and the
//   queue lane) pick them up — identical contract to the smart-timing gate.

function envHour(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 23 ? parsed : fallback;
}

export function inlineBusinessHoursBlock(now: Date = new Date()): {
  blocked: boolean;
  reason?: string;
} {
  if (process.env.FULLPAGE_INLINE_BUSINESS_BLOCK_DISABLED === "true") {
    return { blocked: false };
  }
  const startHour = envHour("FULLPAGE_INLINE_BLOCK_START_UTC_HOUR", 12);
  const endHour = envHour("FULLPAGE_INLINE_BLOCK_END_UTC_HOUR", 23);
  const day = now.getUTCDay(); // 0 Sun … 6 Sat
  if (day === 0 || day === 6) return { blocked: false };
  const hour = now.getUTCHours();
  const inWindow =
    startHour <= endHour
      ? hour >= startHour && hour < endHour
      : hour >= startHour || hour < endHour; // overnight wrap, just in case
  if (!inWindow) return { blocked: false };
  return {
    blocked: true,
    reason: `fleet business hours (${String(startHour).padStart(2, "0")}:00–${String(endHour).padStart(2, "0")}:00 UTC, Mon–Fri) — inline web lane deferred; queue lane and night ticks unaffected`,
  };
}
