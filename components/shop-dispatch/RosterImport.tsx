"use client";
import { useRef, useState } from "react";
import { CommandForm } from "./CommandForm";
import type { WorkProps } from "./JobCard";
import styles from "./pilot.module.css";

interface ProviderEmployee { id: string; name: string; active: boolean; historical?: boolean; lastSeenAt?: string | null; recentActivity?: boolean }
interface Roster { employees: ProviderEmployee[]; truncated: boolean; source: "provider" | "history"; warning?: string }

function isHistorical(roster: Roster, employee: ProviderEmployee) {
  return roster.source === "history" || employee.historical === true;
}

export function RosterImport({ board, busy, mutate }: Pick<WorkProps, "board" | "busy" | "mutate">) {
  const [roster, setRoster] = useState<Roster | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  async function load() {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true); setError("");
    try {
      // Explicit manager click only: never mount-fetch, poll or auto-import staff.
      const response = await fetch("/api/shop-dispatch/roster", { credentials: "include", cache: "no-store" });
      const data: unknown = await response.json();
      if (!response.ok) {
        const message = data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : "Provider staff could not be loaded. Try again.";
        throw new Error(message);
      }
      if (!data || typeof data !== "object" || !("employees" in data) || !Array.isArray(data.employees) ||
        !("truncated" in data) || typeof data.truncated !== "boolean" ||
        !("source" in data) || (data.source !== "provider" && data.source !== "history") ||
        ("warning" in data && data.warning !== undefined && typeof data.warning !== "string") ||
        !data.employees.every((employee: unknown) => employee && typeof employee === "object" &&
          "id" in employee && typeof employee.id === "string" && "name" in employee && typeof employee.name === "string" &&
          "active" in employee && typeof employee.active === "boolean" &&
          (!("historical" in employee) || employee.historical === undefined || typeof employee.historical === "boolean") &&
          (!("recentActivity" in employee) || employee.recentActivity === undefined || typeof employee.recentActivity === "boolean") &&
          (!("lastSeenAt" in employee) || employee.lastSeenAt === undefined || employee.lastSeenAt === null ||
            (typeof employee.lastSeenAt === "string" && Number.isFinite(Date.parse(employee.lastSeenAt)))))) throw new Error("Provider staff response was invalid. Try loading again.");
      setRoster(data as Roster);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Provider staff could not be loaded. Try again."); }
    finally { inFlight.current = false; setLoading(false); }
  }
  // Only historical candidates are grouped; the provider's current list keeps its order and status.
  const primaryEmployees = roster?.employees.filter(employee => !isHistorical(roster, employee) || employee.recentActivity === true) ?? [];
  const pastEmployees = roster?.employees.filter(employee => isHistorical(roster, employee) && employee.recentActivity !== true) ?? [];
  return <div className={styles.rosterReview}>
    <div className={styles.eyebrow}>Manager review · read-only upstream</div><h3>Review provider staff</h3>
    <p><small>Provider names are not proof of a technician role or availability. Historical names are not proof of current employment. Review each candidate, then explicitly select and save each technician. Nothing is selected by default. No MOS accounts are created.</small></p>
    <button type="button" data-testid="roster-load" disabled={busy || loading} onClick={() => void load()}>{loading ? "Loading provider staff…" : error ? "Retry loading provider staff" : roster ? "Reload provider staff" : "Load provider staff"}</button>
    {loading && <div className={styles.skeleton} role="status" aria-label="Loading provider staff" />}
    {error && <p className={styles.error} role="alert">{error}</p>}
    {roster && !loading && !error && <>
      {(roster.source === "history" || roster.employees.some(employee => employee.historical)) && <p className={styles.notice} role="status">Fallback repair-order history may include former employees. Current employment status is unknown; selectable historical candidates are not confirmed active upstream. Recent activity means valid invoiced, non-credit work within the last 30 days. Last seen reflects available archive coverage, not proof of employment or availability. The provider’s current employee list is unchanged.</p>}
      {roster.warning && <p className={styles.notice} role="status">{roster.warning}</p>}
      {roster.truncated && <p className={styles.notice} role="status">This provider response is truncated. Staff not listed here may still exist upstream. Add missing technicians by name if needed.</p>}
      {!roster.employees.length && <div className={styles.empty}>No provider staff returned. You can still add technicians by name above.</div>}
      {roster.source === "history" && primaryEmployees.length > 0 && <div className={styles.rosterGroup}><h3>Seen in the last 30 days</h3></div>}
      {primaryEmployees.map(employee => <ReviewedEmployee key={employee.id} employee={employee} historical={isHistorical(roster, employee)} board={board} busy={busy} mutate={mutate} />)}
      {pastEmployees.length > 0 && <section className={styles.rosterGroup} aria-label="Possible past employees">
        <h3>Possible past employees</h3>
        <p><small>No qualifying activity was found in the last 30 days in the available archive. These candidates remain selectable for leave or loan cases; absence of recent work does not establish that someone has left.</small></p>
        {pastEmployees.map(employee => <ReviewedEmployee key={employee.id} employee={employee} historical board={board} busy={busy} mutate={mutate} />)}
      </section>}
    </>}
  </div>;
}

function ReviewedEmployee({ employee, historical, board, busy, mutate }: Pick<WorkProps, "board" | "busy" | "mutate"> & { employee: ProviderEmployee; historical: boolean }) {
  const linked = board.technicians.find(technician => technician.sourceId === employee.id);
  return <div className={styles.reviewEntry}>
    <div className={styles.row}><strong>{employee.name}</strong><span className={styles.chip}>{historical ? "Historical · current status unknown" : employee.active ? "Active upstream" : "Inactive upstream"}</span></div>
    {historical && <p><small>Last seen: {employee.lastSeenAt ? <time dateTime={employee.lastSeenAt}>{new Date(employee.lastSeenAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}</time> : "unknown"}{employee.recentActivity === true ? " · Qualifying activity in the last 30 days" : ""}</small></p>}
    {linked && <p><small>Already linked to {linked.name}. Existing login and assignments are preserved.</small></p>}
    <CommandForm testId={`roster-review-${employee.id}`} busy={busy} creation label="Save reviewed technician"
      submit={(data, expectedRevision) => {
        if (data.get("reviewed") !== "on") throw new Error("Select this staff member only after reviewing their technician role.");
        return mutate({ type: "importTechnician", sourceId: employee.id, id: String(data.get("technicianId")) || String(data.get("creationId")) }, expectedRevision);
      }}>
      <label className={styles.check}><input type="checkbox" name="reviewed" required />I reviewed this staff member and want them on the technician roster</label>
      <label>Local technician lane<select name="technicianId" defaultValue={linked?.id ?? ""}>
        <option value="">Create a new technician lane</option>
        {board.technicians.map(technician => <option key={technician.id} value={technician.id}>{technician.name}{technician.active ? "" : " · inactive"}</option>)}
      </select></label>
      <small>Choose an existing lane to avoid duplicates. Saving revalidates the candidate and preserves the lane’s login and assignments; it does not grant account access. {historical ? "Historical candidates are selectable locally, not confirmed current provider employees." : "Inactive staff remain subject to manager review."}</small>
    </CommandForm>
  </div>;
}
