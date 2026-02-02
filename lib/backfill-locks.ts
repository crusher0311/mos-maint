import sql from '@/lib/db/postgres';

export async function acquireAdvisoryLock(lockKey: number): Promise<boolean> {
  const result = await sql`SELECT pg_try_advisory_lock(${lockKey}) as acquired`;
  return result[0]?.acquired === true;
}

export async function releaseAdvisoryLock(lockKey: number): Promise<void> {
  await sql`SELECT pg_advisory_unlock(${lockKey})`;
}

export function generateLockKey(shopId: string, operation: string): number {
  let hash = 0;
  const str = `${shopId}:${operation}`;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}

export async function withAdvisoryLock<T>(
  lockKey: number,
  fn: () => Promise<T>,
  timeout: number = 0
): Promise<{ success: boolean; result?: T; skipped?: boolean }> {
  const acquired = await acquireAdvisoryLock(lockKey);
  
  if (!acquired) {
    return { success: false, skipped: true };
  }
  
  try {
    const result = await fn();
    return { success: true, result };
  } finally {
    await releaseAdvisoryLock(lockKey);
  }
}

export async function getGlobalBackfillLock(maxConcurrent: number = 3): Promise<number | null> {
  for (let slot = 1; slot <= maxConcurrent; slot++) {
    const lockKey = 1000000 + slot;
    const acquired = await acquireAdvisoryLock(lockKey);
    if (acquired) {
      return lockKey;
    }
  }
  return null;
}

export async function releaseGlobalBackfillLock(lockKey: number): Promise<void> {
  await releaseAdvisoryLock(lockKey);
}
