/** Queue scheduling only: each processor retains its own authorization,
 * database limits, atomic claim and checkpoint behavior. Never calls providers. */
export type QueueOutcome = { claimed: number; status: string };
export interface ReportQueueWorkerDeps {
  general: () => Promise<QueueOutcome>;
  tires: () => Promise<QueueOutcome[]>;
  shouldStop: () => boolean;
  sleep: (ms: number) => Promise<void>;
  onError: (queue: "general" | "tires") => void;
}

export async function runReportQueueCycle(deps: ReportQueueWorkerDeps, tiresFirst = false) {
  let claimed = 0;
  let failed = false;
  const queues = tiresFirst ? ["tires", "general"] as const : ["general", "tires"] as const;
  for (const queue of queues) {
    if (deps.shouldStop()) break;
    try {
      const outcomes = queue === "general" ? [await deps.general()] : await deps.tires();
      claimed += outcomes.reduce((total, item) => total + item.claimed, 0);
      failed ||= outcomes.some(item => item.status === "failed");
    } catch {
      failed = true;
      deps.onError(queue);
    }
  }
  return { claimed, failed };
}

export async function runReportQueueWorker(deps: ReportQueueWorkerDeps) {
  let tiresFirst = false;
  while (!deps.shouldStop()) {
    const result = await runReportQueueCycle(deps, tiresFirst);
    tiresFirst = !tiresFirst;
    if (deps.shouldStop()) break;
    // Yield even with backlog. Errors and empty queues never spin.
    await deps.sleep(result.failed || !result.claimed ? 10_000 : 1_000);
  }
}
