/**
 * Keep each database statement small without widening the caller's absolute
 * deadline. Month endpoints match normalized JavaScript timestamp precision.
 */
export function laborPartitions(shopIds: number[], start: Date, end: Date) {
  const partitions: [string, string, string][] = [];
  for (const shopId of [...new Set(shopIds)]) {
    let cursor = start.getTime();
    while (cursor <= end.getTime()) {
      const date = new Date(cursor);
      const next = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
      const finish = Math.min(end.getTime(), next - 1);
      partitions.push([`{${shopId}}`, new Date(cursor).toISOString(), new Date(finish).toISOString()]);
      cursor = next;
    }
  }
  return partitions;
}
