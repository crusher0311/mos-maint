# Detect Dog — shop workflow prototype

Frontend-only presentation. Root opens Burnett dispatch, without authentication.
`/preview/workflow/ShopWorkflow` remains available for the canvas. The named entry is
`src/components/mockups/workflow/ShopWorkflow.tsx`. No external fonts, images,
API calls or production imports. Only brand settings persist in browser localStorage;
workflow state is in memory. No package or backend changes.

## Burnett presentation and branding

- Employee labels and a reviewed aggregate service shortlist come from the supplied
  YTD export (January 2–October 7, 2026). Vehicles, customers, ROs, assignment,
  shifts and every duration remain fictional. This does not onboard the location.
- Experience shows deduplicated ordinary-invoice evidence, not skill rankings.
  Exact-row deduplication is a presentation assumption, not a verified job identity.
  Broad categories, free checks and bundled packages are not equivalent repairs.
  Name aliases remain separate; the active roster is not confirmed.
- Technician Hours agree with billed hours in 99.78% of positive billed-hour rows;
  timing semantics are unverified. No speed predictions are learned from this data.
- The offline allowlisted summarizer in `scripts/summarize-sales.py` excludes
  customer fields and unrestricted free-text package names. Only its static summary
  enters the frontend, never the raw CSV. It deliberately includes authorized staff
  names: this presentation is not an anonymized public dataset.
- Demo dataset switches reset the workflow after confirmation. Reset workflow
  preserves the current dataset and branding; refresh starts the Burnett scenario.
- Brand settings support enterprise name/colors/raster logo, inherited location
  styling or isolated local overrides, enterprise-wide system font and density.
  Two presentation locations share the same simulated schedule, not real tenants.
  Save, reload, local override, re-inheritance, logo removal and separate brand reset
  are functional. No URLs/SVGs or external image requests; raster logos capped at 256KB.
- Initial styling is proposed, not Burnett's official brand. A supplied official
  logo and approved colors can be applied locally. No production permission model
  or server settings were implemented.

Presentation: open the Outback, pause diagnosis for parts, edit the ready oil job,
resume and complete diagnosis, and watch repair become ready. Then open Experience
to explain the evidence and Brand settings to demonstrate enterprise inheritance.

The parent application's TypeScript project excludes this artifact because its
Vite entry, aliases and dependencies are checked independently. Production
navigation, auth and service code are unchanged.

The isolated Vite workflow also exposes a fixed-loopback forwarding listener on
port 5000 for the workspace's existing Preview tab. Both addresses serve this
same demo, including HMR. Keep the original MOS Maintenance MVP workflow stopped
while using this preview; it must not be started to test the prototype.

## Visual direction

**Industrial dispatch ledger / fieldwork precision.** Sage paper, deep pine,
mineral mint and burnt-orange time markers. System Aptos/Segoe UI text with local
Consolas/SFMono time labels. Dense horizontal planning, readable vehicle ledgers,
quiet opacity/translate feedback, reduced-motion support. Status always has text,
not just color. My Work is a responsive individual-job view with 44–48px controls.

## Rules

- Six presentation technicians, ten fictional vehicles and 25 simulated jobs share one React state.
- The alignment rack is a separate single-capacity resource, not a technician.
  Its job appears on both the assigned tech and resource lanes.
- Readiness and session are separate: prerequisites decide ready/blocked;
  idle/active/paused/completed decides session. A paused job is not completed.
- One active job per technician. Starting other work requires an explicit
  pause-current confirmation. One active rack job at a time. Technician breaks
  prevent starting during the break window.
- Techs can control only their own jobs in vehicle details. Dispatcher can manage
  every job. My Work always acts as the selected demo technician. The Demo role /
  technician controls are a perspective switch, not security or authentication.
- Pause requires a reason. Resume preserves time. Complete is available only for
  active jobs, and immediately rechecks prerequisites. No automatic completion.
- Dispatcher can edit inactive, unfinished jobs through labeled controls.
  Half-hour planned starts must be after arrival and fit the 08:00–17:00 plan.
  Pause an active job before reassigning; completed jobs are immutable.
- Planned overlaps are deliberately allowed (not optimized or silently moved).
  Forecast follows planned-order queues, dependencies, breaks and rack capacity.
- Book labor is fictional billed allowance. Predicted tech time is an illustrative
  median of **7–12 invented comparable jobs per task**, not trained AI and not
  actual historical shop data. Active time and paused waiting are separate.
  Unstarted queue time is excluded from both session timers.
- +15 min advances only the simulated clock. Active sessions gain active minutes;
  paused sessions gain waiting minutes. Sessions do not start/finish automatically.
- Finish projection uses remaining predicted time (minimum five minutes), a
  fictional 30-minute remaining hold for paused work, dependencies, planned-order
  technician queues, breaks and rack capacity. Risk = finish past promise;
  Watch = 0–30 minutes buffer; On track = more than 30 minutes. Deterministic,
  illustrative, not a promise or dispatch optimizer.
- Reset is confirmed, then restores original data, role, clock and dispatch.
  Refresh also resets everything. No pending network/loading state exists because
  all data is synchronous and local. Mutation validation errors have actionable
  dialogs/forms; search and My Work have composed empty states.
- Dialogs trap keyboard focus, close with Escape and return focus. Nested action
  dialogs make the underlying vehicle drawer inert. Reduced motion is respected.

## Review scenario

1. On dispatch, open **2018 Subaru Outback / #1042** or “Open the Outback.”
2. Diagnosis is active for **Mara Voss**. Pause → Waiting for parts → Pause job.
3. Optionally close the drawer and advance +15 min. Waiting grows; active does not.
4. Reopen Outback. Oil & filter service is independently ready. Assignment & time
   → Eli Mercer → 10:30 → Save changes. Diagnosis dependencies are untouched.
5. Resume diagnosis, then Complete. Control arm repair becomes ready immediately;
   alignment stays blocked until repair, road test until alignment.
6. Use Demo role → Technician, Mara selected. My Work shares those changes.
   Switch to Eli to operate the reassigned oil-service job.
7. Start repair while Eli is active on oil service to review pause-current consent.
8. Try Nina’s brake work, pause reasons, break-time starts, resource exclusion,
   editable half-hour plans, vehicle search and reset. Review My Work at 390px.

## Pure model exports / tests

From this artifact directory:
- `npm test` — offline model tests covering handoffs, timers, assignments, rack
  constraints, breaks, switching active work, promise risk, immutability and reset.
- `npm run typecheck` — isolated TypeScript check.
- `PORT=24087 BASE_PATH=/ npm run build` — frontend bundle only.
- With the isolated preview workflow running, `npm run test:browser` — full
  desktop-to-mobile scenario, keyboard focus, reset and request isolation.
  On NixOS use `DEMO_CHROMIUM_PATH=$(command -v chromium) npm run test:browser`
  to use the system browser rather than a downloaded browser with missing libraries.
  `DEMO_TEST_URL` can target the artifact's proxied preview address.
  These commands never start the root production-connected application.

`src/components/mockups/workflow/_shared/model.ts` exports:

Types: `Session`, `Readiness`, `Technician`, `Vehicle`, `Job`, `ShopState`,
`ShopAction`, `Result`.

Constants: `DAY_START`, `DAY_END`, `PAUSE_REASONS`.

Functions: `formatTime`, `parseTime`, `createDemoState`, `getReadiness`,
`getPrerequisites`, `getActiveJob`, `getJobStatus`, `getWorkload`,
`projectSchedule`, `getPromiseRisk`, `applyAction`.

`applyAction(state, action)` never mutates its input; returns `{ok, state, message}`
and optional `conflictingJobId` on failure. Actions: `advance`, `pause`, `start`,
`complete`, `assign`, `reset`. `createDemoState()` produces independent seed data.
`projectSchedule()` returns an ID-keyed record of projected `{start,end}` minutes.

## Stable UI selectors

- `dispatch-view`, `dispatch-timeline`, `shop-clock`, `advance-clock`
- `nav-dispatch`, `nav-vehicles`, `nav-my-work`
- `demo-role`, `demo-technician`, `reset-demo`, `open-scenario`
- `lane-t1` … `lane-t6`, `lane-rack`
- `vehicle-v1` … `vehicle-v10`, `directory-v1` … `directory-v10`
- `timeline-j1` etc.; rack jobs use `timeline-j3-rack-job` (present in both
  assigned-tech and rack lanes; scope within lane); `rack-j3`, `rack-j14`, `rack-j21`
- `vehicle-workflow`, `workflow-job-j1` … `workflow-job-j25`
- `pause-j1`, `start-j1`, `complete-j1`, `edit-j1` (by job ID);
  blocked starts are disabled with `blocked-j2` prerequisite explanation
- `pause-form`, `edit-form`, `switch-form`, `error-form`, `reset-form`
- `pause-reason`, `assignment-tech`, `assignment-start`, `confirm-action`,
  `action-error`, `toast`
- `my-work-view`, `my-job-j1` etc., `vehicles-view`
- Accessible names: “Search vehicles”, “Demo role”, “Demo technician”,
  “Close [dialog title]”. Dialogs have `role=dialog` with descriptive names.

## Unresolved product decisions

No real certifications/skill gating; dispatcher override is unrestricted. Planned
overlap is visible but not rejected, and a half-hour slot is a plan, not a start
authorization. Work may run past prediction; minimum-five-minute forecast is a
demo approximation. Waiting-for-parts hold is fixed rather than ETA-driven.
No undo after completion, split sessions, multi-day plans, arrival/intake editing,
promise editing, customer approvals, inventory or notifications. Lunch breaks
block starting but do not auto-pause a running session. An occupied rack requires
explicit pause/completion, not a technician-switch side effect. Production
permissions, concurrency, auditing, accessibility testing with assistive devices
and validated historical estimates require separate product/backend decisions.
