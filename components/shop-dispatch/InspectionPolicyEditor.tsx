"use client";
import type { InspectionPolicy, PolicyDraft } from "@/lib/auto-dvi/staff/inspection-policy";
import styles from "./sheet-manager.module.css";

const roles = ["owner", "manager", "advisor"] as const;
export const defaultPolicyDraft = (): PolicyDraft => ({
  completionMode: "required-checks",
  publishRoles: [...roles],
  deliverRoles: [...roles],
});
export function draftFromPolicy(policy?: InspectionPolicy | null): PolicyDraft {
  return policy ? {
    completionMode: policy.completionMode,
    publishRoles: [...policy.publishRoles],
    deliverRoles: [...policy.deliverRoles],
  } : defaultPolicyDraft();
}

export function InspectionPolicyEditor({ policy, draft, canManage, locked, blocked, pending, onEdit, onChange, onSave, onDiscard }: {
  policy?: InspectionPolicy | null;
  draft: PolicyDraft | null;
  canManage: boolean;
  locked: boolean;
  blocked: boolean;
  pending: boolean;
  onEdit: () => void;
  onChange: (draft: PolicyDraft) => void;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const value = draft ?? draftFromPolicy(policy);
  const roleNames = (values: PolicyDraft["publishRoles"]) => values.length
    ? values.map(role => role.charAt(0).toUpperCase() + role.slice(1)).join(", ")
    : "Disabled — no roles allowed";
  return <section className={styles.panel} aria-label="Inspection completion policy" style={{ marginBottom: 20 }}>
    <div className={styles.row}>
      <div><div className={styles.eyebrow}>New inspection settings</div><h3>Completion and delivery policy</h3></div>
      <span className={styles.badge}>{draft ? "Unsaved policy draft" : policy ? `Policy v${policy.version}` : "Default policy · not explicitly saved"}</span>
    </div>
    <p><small>Completion mode is pinned when an inspection starts; changing it applies only to new inspections. Publishing and delivery must be allowed by both the inspection&apos;s pinned policy and the current shop policy. Current role restriction changes therefore also affect existing inspections. These role lists restrict access, never grant new permissions; existing account permission restrictions still apply.</small></p>
    <p><small>Evidence requirements are configured per item in the existing sheet editor, independent of rating. Notes, photos, recommendations and required measurements are not made optional by selecting a completion mode.</small></p>
    {policy && <p><small>Saved by <span className={styles.identity}>{policy.actor}</span> · <time dateTime={policy.at}>{policy.at}</time> · version {policy.version}</small></p>}
    {draft ? <>
      <fieldset disabled={blocked || !canManage} className={styles.form}>
        <legend><strong>Completion policy draft</strong></legend>
        <label>Completion mode
          <select value={value.completionMode} onChange={event => onChange({ ...value, completionMode: event.target.value as PolicyDraft["completionMode"] })}>
            <option value="required-checks">Required checks</option>
            <option value="captured-findings">Captured findings</option>
          </select>
        </label>
        <small>Required checks: complete required checklist checks. Captured findings: complete captured findings rather than requiring every checklist rating. Per-item evidence requirements still apply.</small>
        <div className={styles.fields}>
          {(["publishRoles", "deliverRoles"] as const).map(key => <fieldset key={key}>
            <legend><strong>{key === "publishRoles" ? "Roles allowed to publish" : "Roles allowed to deliver"}</strong></legend>
            {roles.map(role => <label key={role} className={styles.check}>
              <input type="checkbox" checked={value[key].includes(role)} onChange={event => onChange({
                ...value, [key]: roles.filter(candidate => candidate === role ? event.target.checked : value[key].includes(candidate)),
              })} />{role.charAt(0).toUpperCase() + role.slice(1)}
            </label>)}
            {!value[key].length && <small>{key === "publishRoles" ? "Publishing" : "Delivery"} will be disabled.</small>}
          </fieldset>)}
        </div>
        <small>Leave every role unchecked to disable that action. Saving is explicit; changes are never saved automatically.</small>
      </fieldset>
      <div className={`${styles.row} ${styles.footer}`}>
        <small>{pending ? "Exact policy request and draft retained until acknowledged." : "Policy draft stays local. Sheet changes, refresh and workspace navigation are locked."}</small>
        <div className={styles.actions}>
          <button disabled={blocked} onClick={onDiscard}>Discard policy draft</button>
          <button className={styles.primary} disabled={blocked || !canManage} onClick={onSave}>Save inspection policy</button>
        </div>
      </div>
    </> : <>
      <dl>
        <dt>Completion mode</dt><dd>{value.completionMode === "required-checks" ? "Required checks" : "Captured findings"}</dd>
        <dt>Publish roles</dt><dd>{roleNames(value.publishRoles)}</dd>
        <dt>Deliver roles</dt><dd>{roleNames(value.deliverRoles)}</dd>
      </dl>
      {canManage && <button disabled={locked || blocked} onClick={onEdit}>Edit inspection policy</button>}
    </>}
  </section>;
}
