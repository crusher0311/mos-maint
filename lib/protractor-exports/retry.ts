/** Recovery resets only attempt bookkeeping, never baseline/window/cursor.
 * The caller must authorize the current grant before invoking this operation. */
export async function retryExportState(states: any, id: string): Promise<boolean> {
  const state = await states.findOne({ _id: id });
  if (!state || state.failure === "payload_retention_expired" ||
      (!state.pending && !state.failure)) return false;
  if (state.leaseUntil && state.leaseUntil > new Date()) return false;
  const result = await states.updateOne({
    _id: id, attempts: state.attempts,
    $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lt: new Date() } }],
  }, { $set: { attempts: 0 }, $unset: { retryAt: "", failure: "" } });
  return result.matchedCount === 1;
}
