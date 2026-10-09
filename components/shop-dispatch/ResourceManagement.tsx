"use client";
import { resourcesFor } from "@/lib/shop-dispatch/model";
import { CommandForm } from "./CommandForm";
import type { WorkProps } from "./JobCard";
import styles from "./pilot.module.css";

export function ResourceManagement({ board, busy, mutate }: Pick<WorkProps, "board" | "busy" | "mutate">) {
  const resources = resourcesFor(board);
  return <section className={styles.panel}>
    <div className={styles.eyebrow}>Shared lanes</div><h2>Bays & equipment</h2>
    <p><small>Name each shared bay or piece of equipment used in job plans. Each resource has its own timeline lane and allows one local active session at a time. Deactivation retains history; reassign unfinished jobs first.</small></p>
    {resources.map(resource => <details key={resource.id}>
      <summary>{resource.name} · {resource.active ? "Active" : "Inactive"}</summary>
      <CommandForm revision={board.revision} testId={`resource-form-${resource.id}`} busy={busy} label="Update resource"
        submit={(data, expectedRevision) => mutate({ type: "resource", id: resource.id, name: String(data.get("name")), active: data.get("active") === "on" }, expectedRevision)}>
        <label>Bay or equipment name<input name="name" required maxLength={160} defaultValue={resource.name} /></label>
        <label className={styles.check}><input name="active" type="checkbox" defaultChecked={resource.active} />Available for new plans</label>
      </CommandForm>
    </details>)}
    {!resources.length && <div className={styles.empty}>No shared resources. Add a bay or equipment lane when work needs a reserved space.</div>}
    <details><summary>Add a bay or equipment lane</summary>
      <CommandForm testId="resource-create-form" busy={busy} label="Add resource" creation reset
        submit={data => mutate({ type: "resource", id: String(data.get("creationId")), name: String(data.get("name")), active: true })}>
        <label>Bay or equipment name<input name="name" required maxLength={160} placeholder="e.g. Bay 2 or tire balancer" /></label>
      </CommandForm>
    </details>
  </section>;
}
