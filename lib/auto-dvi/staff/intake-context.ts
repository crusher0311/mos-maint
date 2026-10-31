import {z} from "zod";
import type {CachedPlan} from "../../plan-cache";

export const intakeContextSchema = z.object({
  vin: z.string().regex(/^[A-HJ-NPR-Z0-9]{17}$/),
  mileage: z.number().int().min(0).max(9_999_999),
  distanceUnit: z.enum(["miles", "kilometers"]),
}).strict();
export type IntakeContextRequest = z.infer<typeof intakeContextSchema>;
export type IntakeContext = {
  status: "available" | "missing" | "unavailable" | "preparing";
  coverage: "sufficient" | "limited" | "unknown";
  checks: {title: string; timing: "overdue" | "dueSoon"}[];
};
export function projectIntakeContext(cached: CachedPlan | null): IntakeContext {
  if (!cached) return {status: "missing", coverage: "unknown", checks: []};
  return {status: "available",
    coverage: cached.plan.oemMissing ? "limited" : cached.plan.dataQuality ? cached.plan.dataQuality.sufficient ? "sufficient" : "limited" : "unknown",
    checks: (["overdue", "dueSoon"] as const).flatMap(timing =>
      (cached.plan.buckets[timing] ?? []).slice(0, 20).map(item => ({title: item.title.slice(0, 160), timing}))).slice(0, 20)};
}
/** Keep slots until underlying reads settle, not merely until the UI deadline.
 * This prevents timed-out optional work from creating unbounded concurrent reads. */
export function createIntakeContextReader(limit = 4, deadlineMs = 2500) {
  let active = 0;
  return async (read: () => Promise<CachedPlan | null>): Promise<IntakeContext> => {
    const unavailable: IntakeContext = {status: "unavailable", coverage: "unknown", checks: []};
    if (active >= limit) return unavailable;
    active++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = Promise.resolve().then(read).then(projectIntakeContext).catch(() => unavailable)
      .finally(() => {active--;});
    try {
      return await Promise.race([work, new Promise<IntakeContext>(resolve => {
        timer = setTimeout(() => resolve(unavailable), deadlineMs);
      })]);
    } finally {if (timer) clearTimeout(timer);}
  };
}
