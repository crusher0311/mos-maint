"use client";
import { useEffect, useState, type CSSProperties } from "react";
import { useDispatchBoard } from "@/lib/shop-dispatch/client";
import { elapsed } from "@/lib/shop-dispatch/model";
import { isVisitVisible } from "@/lib/shop-dispatch/source-preferences";
import { AuditView } from "./AuditView";
import { BrandSettings } from "./BrandSettings";
import { JobCard } from "./JobCard";
import { Management } from "./Management";
import { Timeline } from "./Timeline";
import { VisitDetail } from "./VisitDetail";
import { contrast, dateLabel, minutes, projection, resolvedBranding } from "./helpers";
import { normalizeRoNumber } from "./ro-number";
import styles from "./pilot.module.css";

type View = "dispatch" | "work" | "manage" | "settings" | "audit";
export default function DispatchPilot() {
  const api = useDispatchBoard();
  const { snapshot, error, busy, lastReceived, refresh, needsRetry, retry } = api;
  const [view, setView] = useState<View>("dispatch");
  const [selected, setSelected] = useState<string | null>(null);
  const [tick, setTick] = useState(() => Date.now());
  const [search, setSearch] = useState("");
  const [customerPlan, setCustomerPlan] = useState("all");
  const [ride, setRide] = useState("all");
  const [loaner, setLoaner] = useState("all");
  const [history, setHistory] = useState(false);
  const [showHiddenStatuses, setShowHiddenStatuses] = useState(false);
  // Clock display only. Fetch polling and visibility refresh belong to useDispatchBoard.
  useEffect(() => { const timer = window.setInterval(() => setTick(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const brand = resolvedBranding(snapshot).brand;
  const theme = { "--primary": brand.primary, "--accent": brand.accent, "--on-primary": contrast(brand.primary), "--on-accent": contrast(brand.accent) } as CSSProperties;
  const age = lastReceived ? Math.max(0, tick - lastReceived) : null;
  const stale = age !== null && age > 30000;
  const now = snapshot && lastReceived ? Date.parse(snapshot.serverNow) + Math.max(0, tick - lastReceived) : tick;
  const work = snapshot ? { board: snapshot.board, actor: snapshot.actor, now, busy: busy || needsRetry || stale, mutate: api.mutate } : null;
  const open = snapshot?.board.visits.filter(v => !v.closed) ?? [];
  const activeJobs = snapshot?.board.jobs.filter(j => j.status === "active") ?? [];
  const pausedJobs = snapshot?.board.jobs.filter(j => j.status === "paused") ?? [];
  const searchTerm = search.trim().toLowerCase();
  const roSearch = normalizeRoNumber(search).toLowerCase();
  const visits = (snapshot?.board.visits ?? []).filter(v => v.closed === history &&
    (showHiddenStatuses && snapshot?.actor.manager || isVisitVisible(v, snapshot?.board.sourceStatuses)) &&
    (`${v.ro} ${v.vehicle} ${v.customer}`.toLowerCase().includes(searchTerm) ||
      (!!roSearch && normalizeRoNumber(v.ro).toLowerCase().includes(roSearch))) &&
    (customerPlan === "all" || v.transport.customerPlan === customerPlan) &&
    (ride === "all" || v.transport.ride === ride) && (loaner === "all" || v.transport.loaner === loaner));
  const detail = snapshot?.board.visits.find(v => v.id === selected);
  function navigate(next: View) { setView(next); setSelected(null); }
  return <main className={styles.root} style={theme} data-testid="dispatch-pilot">
    <header className={styles.header}>
      <div className={styles.identity}>{brand.logo && <img className={styles.logo} src={brand.logo} alt={`${brand.name} logo`} />}
        <div><div className={styles.eyebrow}>{brand.name} / one-location pilot{snapshot ? ` / location ${snapshot.shopId}` : ""}</div><h1>Shop workflow</h1><small>Read-only upstream intake. Local dispatch, sessions and customer plans.</small></div>
      </div>
      <div><div className={styles.actions}><span className={styles.chip}>{!snapshot ? "Integration unverified" : error ? "Disconnected / save error" : stale ? "Stale snapshot" : "Pilot API connected"}</span>
        <button data-testid="pilot-refresh" disabled={busy} onClick={() => void refresh()}>Refresh board</button></div>
        <small>Last successful refresh: {lastReceived ? `${new Date(lastReceived).toLocaleTimeString()} · ${Math.floor((age ?? 0) / 1000)}s ago` : "Not received"}<br />
          {snapshot ? `${snapshot.actor.email} · ${snapshot.actor.manager ? "Manager access" : snapshot.actor.technicianId ? "Assigned technician" : "Read-only actor"}` : "Live data and integration are unverified until a successful fetch."}</small>
      </div>
    </header>
    {error && <div className={styles.notice} role="alert" data-testid="pilot-error"><strong>{error}</strong><br />
      {!snapshot ? "The pilot may not be enabled for this location, or the API is unavailable. No demo data or auth bypass is used. Refresh to retry." : "Entries remain in their forms with their original base revision. For a revision conflict (409), refresh the board, then use Reload latest form to explicitly discard the stale draft, review latest values and re-enter your change. Refresh alone never rebases an edit."}
    </div>}
    {needsRetry && <div className={styles.notice} role="alert">The last save is unconfirmed. Other changes are blocked until it is resolved. Retry uses the exact same request, not a new action.
      <div className={styles.actions}><button disabled={busy} data-testid="pilot-retry" onClick={() => void retry()}>Retry unconfirmed save</button></div>
    </div>}
    {stale && <div className={styles.notice} role="status">This snapshot is over 30 seconds old. Session clocks are local projections from the last server time, not proof of a live connection. Refresh before changing work.</div>}
    {snapshot?.sourceSyncWarning && <div className={styles.notice} role="alert" data-testid="source-sync-warning"><strong>Source intake needs attention</strong><p>{snapshot.sourceSyncWarning}</p><small>The local board may not include every provider update. Existing visits and My work assignments remain available; refreshing does not guarantee source recovery.</small></div>}
    {!snapshot ? error ? <section className={styles.empty}><h2>Pilot data unavailable</h2><p>Nothing has been loaded or changed. Contact a manager if this location is not enabled.</p><button onClick={() => void refresh()}>Try fetching again</button></section> :
      <section aria-busy="true" aria-label="Loading pilot data"><p>Connecting to the signed-in location…</p><div className={styles.skeleton} /><div className={styles.skeleton} /><div className={styles.skeleton} /></section> :
      <>
        <nav className={styles.nav} aria-label="Pilot workspace">
          <button data-testid="pilot-dispatch" aria-current={view === "dispatch" ? "page" : undefined} onClick={() => navigate("dispatch")}>Dispatch</button>
          <button data-testid="pilot-work" aria-current={view === "work" ? "page" : undefined} onClick={() => navigate("work")}>My work</button>
          {snapshot.actor.manager && <button data-testid="pilot-manage" aria-current={view === "manage" ? "page" : undefined} onClick={() => navigate("manage")}>Roster & intake</button>}
          <button data-testid="pilot-settings" aria-current={view === "settings" ? "page" : undefined} onClick={() => navigate("settings")}>Brand settings</button>
          <button data-testid="pilot-audit" aria-current={view === "audit" ? "page" : undefined} onClick={() => navigate("audit")}>Audit</button>
        </nav>
        {view === "dispatch" && work && (detail ? <VisitDetail key={detail.id} visit={detail} {...work} onBack={() => setSelected(null)} /> : <>
          <div className={styles.stats}>
            <div className={styles.stat}><small>Open vehicles</small><strong>{open.length}</strong><small>{open.filter(v => v.transport.customerPlan === "waiting").length} customers waiting · {open.filter(v => v.transport.customerPlan === "drop-off").length} drop-offs</small></div>
            <div className={styles.stat}><small>Active sessions</small><strong>{activeJobs.length}</strong><small>{minutes(activeJobs.reduce((sum, j) => sum + elapsed(j, now).activeMs, 0))} active time</small></div>
            <div className={styles.stat}><small>Paused / waiting sessions</small><strong>{pausedJobs.length}</strong><small>{minutes(pausedJobs.reduce((sum, j) => sum + elapsed(j, now).waitingMs, 0))} waiting time</small></div>
            <div className={styles.stat}><small>Transport attention</small><strong>{open.filter(v => ["needed", "arranged"].includes(v.transport.ride) || ["requested", "assigned"].includes(v.transport.loaner)).length}</strong><small>Resolve before closing visits</small></div>
          </div>
          <section className={styles.panel}>
            <div className={styles.row}><h2>{history ? "Closed visit history" : "Today’s shop"}</h2><button data-testid="pilot-history" aria-pressed={history} onClick={() => setHistory(!history)}>{history ? "Show open visits" : "View closed history"}</button></div>
            <div className={styles.fields}>
              <label>Find vehicle, customer or RO number<input data-testid="pilot-search" type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="RO number, vehicle or customer…" /></label>
              <label>Customer plan<select value={customerPlan} onChange={e => setCustomerPlan(e.target.value)}><option value="all">All plans</option>{["unknown", "waiting", "drop-off", "returning"].map(p => <option key={p}>{p}</option>)}</select></label>
              <label>Ride filter<select value={ride} onChange={e => setRide(e.target.value)}><option value="all">All ride states</option>{["none", "needed", "arranged", "completed"].map(p => <option key={p}>{p}</option>)}</select></label>
              <label>Loaner filter<select value={loaner} onChange={e => setLoaner(e.target.value)}><option value="all">All loaner states</option>{["none", "requested", "assigned", "returned"].map(p => <option key={p}>{p}</option>)}</select></label>
            </div>
            {snapshot.actor.manager && <label className={styles.check}><input data-testid="pilot-show-hidden-statuses" type="checkbox" checked={showHiddenStatuses} onChange={e => setShowHiddenStatuses(e.target.checked)} />Show hidden statuses · this view only</label>}
            <small>Source status visibility applies to Dispatch only, not technician job states or My work.</small>
          </section>
          <Timeline board={snapshot.board} visits={visits} now={now} select={setSelected} />
          <section className={styles.panel}><h2>Vehicle journeys <small>/ {visits.length}</small></h2>
            {visits.map(visit => {
              const jobs = snapshot.board.jobs.filter(j => j.visitId === visit.id);
              return <button className={styles.visit} key={visit.id} data-testid={`visit-${visit.id}`} onClick={() => setSelected(visit.id)}>
                <div className={styles.row}><div><strong>{visit.vehicle}</strong><small>#{visit.ro} · {visit.customer || "Customer not supplied"} · {visit.provider}</small></div><div><strong>{jobs.filter(j => j.status === "completed").length}/{jobs.length} complete</strong><small>Promise {dateLabel(visit.promiseAt)}</small></div></div>
                <div className={styles.actions}><span className={styles.chip}>{visit.transport.customerPlan}</span><span className={styles.chip}>Ride: {visit.transport.ride}</span><span className={styles.chip}>Loaner: {visit.transport.loaner}{visit.transport.loanerId ? ` · ${visit.transport.loanerId}` : ""}</span></div>
                <small>{projection(snapshot.board, visit, now)}</small>
                {visit.sourceStatus && <small>Source status: {visit.sourceStatus}{!isVisitVisible(visit, snapshot.board.sourceStatuses) ? " · hidden by saved preferences" : ""}</small>}
                {jobs.some(j => j.sourceRemoved) && <small className={styles.warning}>Warning: a package was removed upstream. Manager review required.</small>}
              </button>;
            })}
            {!visits.length && <div className={styles.empty}><h3>No {history ? "closed" : "open"} visits match this view.</h3><p>{snapshot.actor.manager ? "Provider callbacks feed visits automatically. Check Show hidden statuses or source preferences in Roster & intake; recover a missing visit by RO number, or create a manual visit if needed." : "Provider callbacks feed visits automatically. A manager reviews and assigns work. Your assigned jobs remain available in My work even when their source status is hidden here."}</p><button onClick={() => { setSearch(""); setCustomerPlan("all"); setRide("all"); setLoaner("all"); }}>Clear search & transport filters</button></div>}
          </section>
        </>)}
        {view === "work" && work && <section data-testid="pilot-my-work"><div className={styles.row}><div><h2>My work</h2><p><small>Assigned to your signed-in login only. Active and paused time are separate; estimates are manually entered.</small></p></div><span className={`${styles.mono} ${styles.chip}`}>{new Date(now).toLocaleTimeString()}</span></div>
          {!snapshot.actor.technicianId ? <div className={styles.empty}><h3>No active employee mapping</h3><p>A manager must map your existing login email to an active roster member. Manager access does not invent a technician assignment.</p></div> :
            <>
              {(["active", "paused", "idle", "completed"] as const).map(status => {
                const jobs = snapshot.board.jobs.filter(j => j.technicianId === snapshot.actor.technicianId && j.status === status && !snapshot.board.visits.find(v => v.id === j.visitId)?.closed);
                return <section className={styles.panel} key={status}><h2>{status === "active" ? "Working now" : status === "paused" ? "Paused · waiting" : status === "idle" ? "Assigned queue" : "Completed work"} <small>/ {jobs.length}</small></h2>
                  {!jobs.length && <small>No jobs in this state.</small>}
                  {jobs.map(job => <div key={job.id}><small>RO {snapshot.board.visits.find(v => v.id === job.visitId)?.ro} · {snapshot.board.visits.find(v => v.id === job.visitId)?.vehicle}</small><JobCard job={job} {...work} /></div>)}
                </section>;
              })}
            </>}
        </section>}
        {view === "manage" && snapshot.actor.manager && work && <Management {...work} />}
        {view === "settings" && work && <BrandSettings key={snapshot.shopId} snapshot={snapshot} {...work} saveEnterpriseBrand={api.saveEnterpriseBrand} />}
        {view === "audit" && <AuditView board={snapshot.board} />}
        <footer><small>Server-backed pilot · revision {snapshot.board.revision} · board saved {dateLabel(snapshot.board.updatedAt)}. Protractor intake is read-only and verified per fetched work order, not by this board connection.</small></footer>
      </>}
  </main>;
}
