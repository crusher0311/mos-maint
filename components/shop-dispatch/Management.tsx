"use client";
import { CommandForm } from "./CommandForm";
import type { WorkProps } from "./JobCard";
import { ResourceManagement } from "./ResourceManagement";
import { RosterImport } from "./RosterImport";
import { SourceStatusPreferences } from "./SourceStatusPreferences";
import { normalizeRoNumber } from "./ro-number";
import styles from "./pilot.module.css";

export function Management({ board, actor, busy, mutate }: WorkProps) {
  if (!actor.manager) return <section className={styles.empty}><h2>Manager access required</h2><p>A manager can update this shop’s roster, resources and intake preferences.</p></section>;
  return <div className={styles.grid}>
    <section className={styles.panel}><h2>Technician roster</h2><p><small>Add technicians by name, even without a MOS account. Leave the login email blank for local dispatch only. To link an existing MOS login later, edit the same technician’s email; their lane and assignments stay intact. This does not create accounts or verify provider assignments or availability. Reassign unfinished work before deactivating.</small></p>
      {board.technicians.map(tech => <details key={tech.id}><summary>{tech.name} · {tech.active ? "Active" : "Inactive"}</summary>
        <CommandForm revision={board.revision} testId={`technician-form-${tech.id}`} busy={busy} label="Update employee" submit={(data, expectedRevision) => mutate({ type: "technician", id: tech.id, name: String(data.get("name")), email: String(data.get("email")), active: data.get("active") === "on" }, expectedRevision)}>
          <label>Employee name<input name="name" required maxLength={160} defaultValue={tech.name} /></label>
          <label>Existing MOS login email · optional<input name="email" type="email" maxLength={160} defaultValue={tech.email} /><small>Blank means no signed-in My work access. Managers can still dispatch and record sessions.</small></label>
          <label className={styles.check}><input type="checkbox" name="active" defaultChecked={tech.active} />Active roster member</label>
        </CommandForm>
      </details>)}
      {!board.technicians.length && <div className={styles.empty}>No technicians yet. Add a name or review provider staff to enable local assignments.</div>}
      <details><summary>Add a technician</summary>
        <CommandForm testId="technician-create-form" busy={busy} label="Add technician" reset creation submit={data => mutate({ type: "technician", id: String(data.get("creationId")), name: String(data.get("name")), email: String(data.get("email")), active: true })}>
          <label>Technician name<input name="name" required maxLength={160} /></label>
          <label>Existing MOS login email · optional<input name="email" type="email" maxLength={160} /></label>
        </CommandForm>
      </details>
      <RosterImport board={board} busy={busy} mutate={mutate} />
    </section>
    <section><ResourceManagement board={board} busy={busy} mutate={mutate} /><SourceStatusPreferences board={board} busy={busy} mutate={mutate} /><div className={styles.panel}><div className={styles.eyebrow}>Local intake</div><h2>Create a manual visit</h2>
      <CommandForm testId="visit-create-form" busy={busy} label="Create visit" reset creation submit={data => mutate({ type: "visit", id: String(data.get("creationId")), ro: String(data.get("ro")), vehicle: String(data.get("vehicle")), customer: String(data.get("customer")) })}>
        <label>Repair order number<input name="ro" required maxLength={160} /></label>
        <label>Vehicle<input name="vehicle" required maxLength={160} /></label>
        <label>Customer · optional<input name="customer" maxLength={160} /></label>
      </CommandForm>
    </div><div className={styles.panel}><div className={styles.eyebrow}>Read-only upstream</div><h2>Protractor intake</h2>
      <p><small>Visits arrive automatically through provider callbacks. To recover a missing visit, fetch its RO number in the current shop. This pilot does not write to Protractor. New imported jobs must be authorized and assigned by a manager before work starts. Connection remains unverified until intake succeeds.</small></p>
      <CommandForm testId="sync-form" busy={busy} label="Fetch by RO number" submit={data => {
        const roNumber = normalizeRoNumber(String(data.get("roNumber")));
        if (!roNumber) throw new Error("Enter an RO number after the optional # or RO prefix.");
        return mutate({ type: "syncNumber", roNumber });
      }}>
        <label>RO number<input required name="roNumber" maxLength={160} placeholder="e.g. 18427 or RO #18427" /></label>
      </CommandForm>
    </div></section>
  </div>;
}
