"use client";
import { DEFAULT_SOURCE_STATUSES } from "@/lib/shop-dispatch/source-preferences";
import { CommandForm } from "./CommandForm";
import type { WorkProps } from "./JobCard";
import styles from "./pilot.module.css";

export function SourceStatusPreferences({ board, busy, mutate }: Pick<WorkProps, "board" | "busy" | "mutate">) {
  const selected = board.sourceStatuses ?? DEFAULT_SOURCE_STATUSES;
  const options = Array.from(new Set([
    ...DEFAULT_SOURCE_STATUSES,
    ...selected,
    ...board.visits.map(visit => visit.sourceStatus).filter((status): status is string => !!status),
  ]));
  return <section className={styles.panel}>
    <div className={styles.eyebrow}>This location only</div>
    <h2>Source statuses on Dispatch</h2>
    <p><small>Choose the provider stages shown on this shop’s Dispatch board. These preferences are independent of dashboard filters and do not change technician job states or My work assignments. Manual visits remain visible.</small></p>
    <CommandForm revision={board.revision} testId="source-statuses-form" busy={busy} label="Save source statuses"
      submit={(data, expectedRevision) => {
        const custom = String(data.get("customStatus") ?? "").trim();
        const statuses = Array.from(new Set([...data.getAll("sourceStatus").map(String), ...(custom ? [custom] : [])]));
        return mutate({ type: "sourceStatuses", statuses }, expectedRevision);
      }}>
      <div role="group" aria-label="Visible provider source statuses">
        {options.map(status => <label className={styles.check} key={status}>
          <input type="checkbox" name="sourceStatus" value={status} defaultChecked={selected.includes(status)} />{status}
        </label>)}
      </div>
      <label>Add a custom provider stage<input name="customStatus" maxLength={80} placeholder="Exact provider stage name" /></label>
      <small>A custom stage is included when you save. Unchecked stages are hidden, not deleted. Use Show hidden statuses on Dispatch to review them.</small>
    </CommandForm>
  </section>;
}
