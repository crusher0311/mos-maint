/**
 * Pure queue-window winner selection.  The durable claim remains the
 * authority for arrivals outside the bounded read window; this helper merely
 * prevents a known, exhausted winner in that window from taking a useful
 * queue slot.
 */
export interface CallbackSelectionEvent {
  key: string;
  shopId: number;
  objectType: string | null;
  objectId: string | null;
  operation: string | null;
  status?: string | null;
  /** PG claim uses `coalesce(operation, status)`, unlike Mongo's OR regex. */
  terminalFromCoalesce?: boolean;
  receivedAt?: Date;
  /**
   * Omitted for normal queue candidates. `false` denotes an exhausted row
   * included only to reproduce claim winner precedence.
   */
  replayEligible?: boolean;
  /**
   * Store-local final ordering key: Mongo ObjectId text or PG serial id.
   * It makes equal receivedAt winner selection match durable claims.
   */
  winnerTieBreaker?: string | number;
  /**
   * Mongo prefilter computes this from raw stored fields before any POST
   * operation normalization. When present it is authoritative.
   */
  terminalRank?: 0 | 1;
}

const TERMINAL_OPERATIONS = new Set([
  "DELETE",
  "INVOICED",
  "INVOICE",
  "CLOSED",
  "VOID",
]);

export function isTerminalCallbackOperation(operation: string | null | undefined): boolean {
  return TERMINAL_OPERATIONS.has(String(operation || "").trim().toUpperCase());
}

function eventTime(item: CallbackSelectionEvent): number {
  const time = item.receivedAt?.getTime();
  return Number.isFinite(time) ? time! : 0;
}

function compareTieBreaker(
  left: CallbackSelectionEvent,
  right: CallbackSelectionEvent,
): number {
  const a = left.winnerTieBreaker ?? left.key;
  const b = right.winnerTieBreaker ?? right.key;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/** True when `candidate` is the same winner claimCallbackEvent would prefer. */
export function callbackEventWins(
  candidate: CallbackSelectionEvent,
  current: CallbackSelectionEvent,
): boolean {
  const candidateTerminal = candidate.terminalRank ?? Number(isTerminalCallbackEvent(candidate));
  const currentTerminal = current.terminalRank ?? Number(isTerminalCallbackEvent(current));
  if (candidateTerminal !== currentTerminal) return candidateTerminal === 1;
  const timeDifference = eventTime(candidate) - eventTime(current);
  return timeDifference > 0 || (timeDifference === 0 && compareTieBreaker(candidate, current) > 0);
}

/** Match claimCallbackEvent's operation-or-status terminal predicate. */
export function isTerminalCallbackEvent(item: Pick<CallbackSelectionEvent, "operation" | "status">): boolean {
  if ((item as CallbackSelectionEvent).terminalFromCoalesce) {
    return isTerminalCallbackOperation(item.operation ?? item.status);
  }
  return isTerminalCallbackOperation(item.operation) || isTerminalCallbackOperation(item.status);
}

function objectIdentity(item: CallbackSelectionEvent): string {
  // Claim identity is object-scoped (not operation- or method-scoped), and
  // Mongo accepts historical numeric/string shopId representations.
  return JSON.stringify([
    Number(item.shopId),
    item.objectType,
    item.objectId,
  ]);
}

/**
 * Collapse a bounded selection window using authoritative terminal/newest
 * precedence, then return only winners still below the retry cap. Exhausted
 * winners are deliberately not completed, retried, or replaced by older
 * siblings; they remain durable review-needed notifications.
 */
export function callbackWindowWinners<T extends CallbackSelectionEvent>(
  candidates: T[],
  receivedNotBefore?: Date,
): T[] {
  const validReceivedNotBefore =
    receivedNotBefore instanceof Date && Number.isFinite(receivedNotBefore.getTime())
      ? receivedNotBefore
      : undefined;
  const activeCandidates = validReceivedNotBefore
    ? candidates.filter((item) => eventTime(item) >= validReceivedNotBefore.getTime())
    : candidates;
  const byIdentity = new Map<string, T>();
  for (const item of activeCandidates) {
    const identity = objectIdentity(item);
    const prior = byIdentity.get(identity);
    if (!prior || callbackEventWins(item, prior)) byIdentity.set(identity, item);
  }
  return [...byIdentity.values()];
}

export function replayableCallbackWindowWinners<T extends CallbackSelectionEvent>(
  candidates: T[],
  receivedNotBefore?: Date,
): { winners: T[]; coalesced: T[] } {
  const activeCandidates = receivedNotBefore instanceof Date && Number.isFinite(receivedNotBefore.getTime())
    ? candidates.filter((item) => eventTime(item) >= receivedNotBefore.getTime())
    : candidates;
  const winners = new Set(callbackWindowWinners(candidates, receivedNotBefore));
  return {
    winners: activeCandidates.filter((item) => winners.has(item) && item.replayEligible !== false),
    coalesced: activeCandidates.filter((item) => !winners.has(item) && item.replayEligible !== false),
  };
}