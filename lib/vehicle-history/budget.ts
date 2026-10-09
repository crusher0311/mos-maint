/**
 * A response deadline is not a database cancellation primitive. Repositories
 * additionally use statement_timeout/maxTimeMS. Callers must not start more
 * work after the deadline; this also bounds pool-acquisition delays.
 */
export function historyBudget(milliseconds = 8000) {
  const deadline = Date.now() + milliseconds;
  return async <T>(work: () => Promise<T>): Promise<T> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Vehicle history deadline exceeded");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Vehicle history deadline exceeded")), remaining);
        }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  };
}
