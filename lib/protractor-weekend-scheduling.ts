/** Pure round-robin policy. Does not advance ingestion checkpoints or grants. */
export function weekendShopOrder<T>(shops: readonly T[], next: number): T[] {
  if(!shops.length)return [];
  const start=Number.isSafeInteger(next)&&next>=0?next%shops.length:0;
  return [...shops.slice(start),...shops.slice(0,start)];
}
export function weekendNextShopIndex(current: number, length: number): number {
  return length>0?(current+1)%length:0;
}
