type Phase = "begin" | "lookup" | "update" | "commit";

/** Retry only a statement failure propagated unchanged after a completed rollback.
 * Connection/commit/rollback failures have ambiguous outcomes and must pause.
 */
export async function overnightTransaction<T>(options: {
  transaction: (body: (tx: any) => Promise<T>) => Promise<T>;
  operation: (tx: any, statement: <R>(phase: "lookup" | "update", run: () => Promise<R>) => Promise<R>) => Promise<T>;
  beforeAttempt: (attempt: number) => Promise<void>;
  log: (event: {attempt: number; phase: Phase; sqlState: string; retry: boolean}) => void;
  sleep?: (ms: number) => Promise<void>;
}): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    await options.beforeAttempt(attempt);
    let phase: Phase = "begin";
    let statementFailure: unknown;
    try {
      return await options.transaction(async tx => {
        const result = await options.operation(tx, async (current, run) => {
          phase = current;
          try { return await run(); }
          catch (error) { statementFailure = error; throw error; }
        });
        phase = "commit";
        return result;
      });
    } catch (error) {
      const code = (error as {code?: string})?.code;
      const sqlState = typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : "unknown";
      const message = (error as {message?: string})?.message;
      const timeout = (sqlState === "57014" && message === "canceling statement due to statement timeout") ||
        (sqlState === "55P03" && message === "canceling statement due to lock timeout");
      const retry = error === statementFailure && timeout && attempt < 3;
      options.log({attempt, phase, sqlState, retry});
      if (!retry) throw error;
      await (options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(attempt * 500);
    }
  }
}
