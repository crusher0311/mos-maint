# Archived: Workflow Manager Review Guide

**Retired October 24, 2026. Historical reference only, not current documentation.** The standalone workflow preview has been hidden; its former root and component links show a retirement notice. The instructions below describe the archived simulation, not the integrated Burnett shop. Source and fixtures are retained. For intentional isolated restoration, see the artifact README. The authenticated Shop Workflow and Enterprise Tire DVI are unchanged.

Detect Dog Shop Workflow preview · Reviewed October 24, 2026

## Contents

- 1. Read this first
- 2. The basic model and roles
- 3. Dispatch: see the whole shop
- 4. Vehicles and vehicle detail
- 5. Worked visit: arrival, planning and readiness
- 6. Worked visit: start, pause and resume
- 7. Worked visit: completion and downstream handoffs
- 8. My Work: the technician's view
- 9. Blockers, equipment, breaks and time
- 10. Experience: evidence, not qualifications
- 11. Brand settings, appearance and resets
- 12. Boundaries and possible improvements
- 13. Feedback worksheet
- 14. Glossary and evidence

## 1. Read this first

This guide describes the existing interactive preview at the root URL (/), not a proposed replacement. Use its numbered sections when sending feedback. You can read this document offline without the app.

**Three separate things:** Detect Dog Shop Workflow is the root presentation preview covered here. The authenticated Shop Workflow implementation at /dashboard/shop-workflow is a separate application feature. Enterprise Tire DVI at /tire-dvi/ is a separate demo and is not covered.

**Current preview:** Six presentation technicians, ten fictional vehicles and 25 simulated jobs share one local workflow. No real sign-in, provider writes, customer messages or live shop connection are involved. Demo role controls change the perspective; they are not security.

The default Burnett presentation uses staff labels and selected historical service evidence. Its vehicles, customers, repair orders, assignments and all timing are simulated. Location onboarding and staff identities/qualifications are not established by this preview. This guide reproduces no raw exports, real staff listings or personal customer data.

**How to use the exports:** Open the HTML in a browser. Choose Print → Save as PDF, using A4 or Letter paper, normal scale, and optionally disable browser headers/footers. No external fonts, images, scripts or network connection are needed. Notes spaces are for handwriting; edit the matching Markdown file to type and save comments. The HTML does not save typed feedback.

**Review prompt:** Is the distinction between a presentation and an operational shop system clear?

Notes: ____________________________________________________________

Notes: ____________________________________________________________

## 2. The basic model and roles

A **vehicle visit** groups the work for one vehicle: its concern, arrival time, promised-ready time and individual jobs. A vehicle is not one technician's appointment block. Different technicians can own different jobs on the same vehicle.

A **job** has an assigned technician, planned start, estimated duration, dependencies and work-session state. Jobs may be independent or must wait for earlier work. The alignment rack is shared equipment with one active job at a time, not an extra technician.

Simple flow (arrows mean sequence, not measured time):

```text
Arrival already recorded → Review jobs and plan → Ready to start?
  Dependency unfinished → Wait for prerequisite completion → Recheck
  Ready + technician/rack available → Person starts work
  Working → Person pauses with reason → Person resumes → Working
  Working → Person completes → Recheck downstream jobs
  All jobs complete → Summary says “Ready for pickup”
                      [No checkout or vehicle-release action]

Example dependency chain: Diagnosis → Repair → Alignment → Road test
Independent branch:       Oil service may run alongside that chain
```

**Dispatcher perspective:** See the shop-wide plan, open any vehicle, operate any job, and edit unfinished inactive jobs. There is no skill-certification restriction on assignment.

**Technician perspective:** Vehicle-detail controls are limited to the selected demo technician's jobs. My Work always operates as the selected technician, even if Demo role still says Dispatcher. My Work has no assignment editor; a dispatcher can edit through vehicle detail.

Changing Demo role opens Dispatch or My Work and closes vehicle detail. Changing Demo technician changes whose work you try; it does not reassign jobs.

**Review prompt:** Does this job-by-job ownership reflect your shop? Who should be able to change ownership?

Notes: ____________________________________________________________

Notes: ____________________________________________________________

## 3. Dispatch: see the whole shop

Dispatch shows vehicle/job totals, active work, ready idle jobs and vehicles whose projected finish is past their promise. “Next to watch” highlights the Outback's first unfinished job in its listed sequence; it is not an optimized next-job recommendation.

Technician lanes show planned job blocks, break windows and remaining predicted workload. The alignment-rack lane repeats rack jobs already shown on their technician lanes. These are the same jobs, not duplicate work.

Blocks show planned starts and illustrative predicted durations, not actual occupied-time records. Short blocks have a minimum visual width for readability. Planned overlaps are allowed and may overlap visually. The forecast can queue work without moving these planned blocks. There is no drag-and-drop scheduling.

Click a job block, a vehicle journey row or **Open the Outback** to open vehicle detail. In Vehicle journeys, **Search vehicles** filters by vehicle, fictional owner or repair-order number. Clear search restores the list; it does not change work. This search is on Dispatch, not the separate Vehicles directory.

**+15 min** advances the simulated shop clock and all active/paused session counters. It does not move real time, start jobs, finish jobs, contact anyone or update a provider. The clock begins at 10:15 and cannot advance beyond 17:00.

**Review prompt:** What should a dispatcher notice first: a ready job, an overloaded technician, a resource conflict or a promise at risk? Are overlapping plans clear enough?

Notes: ____________________________________________________________

Notes: ____________________________________________________________

## 4. Vehicles and vehicle detail

**Vehicles** lists each simulated visit with vehicle/RO, concern, recorded arrival, promise and job count. Click a row to inspect it. The preview does not create visits or edit arrival, concern or promise.

Vehicle detail shows arrival, earliest planned work, promised-ready time, illustrative finish, buffer or lateness and completed-job count. Each job shows ownership, planned time, status and four different time values.

- **Start job:** Requests an active session. Dependencies, the technician's current break, rack use and another active job can stop it.
- **Pause:** Requires a reason and confirmation. Reasons include Waiting for parts, Waiting for approval, Diagnostic research, Helping another technician and Taking a break. This records a local explanation, not a parts order or approval request.
- **Resume:** Restarts a paused session after start checks. Recorded active and waiting time are retained.
- **Complete:** Available only while active. It marks that job complete and immediately rechecks downstream prerequisites. There is no completion confirmation or undo; do not confuse this with completing the entire visit.
- **Assignment & time:** Dispatcher-only in vehicle detail. Edit ownership and the planned half-hour start for an idle or paused unfinished job, then choose Save changes. Pause an active job before editing. Completed jobs cannot be edited.

Assignment times must be half-hour slots, at or after recorded arrival and no earlier than 08:00, with the full predicted duration fitting before 17:00. The form's latest input time alone does not guarantee a valid fit. A saved plan does not start work or override dependencies. A future planned time does not itself prevent an otherwise eligible job from starting now.

An error explains why the requested action failed. Cancel leaves the proposed change unapplied. Escape closes a dialog and returns focus; closing vehicle detail does not stop work.

**Review prompt:** Is Complete too easy to press accidentally? What should a dispatcher see before changing a paused job's owner?

Notes: ____________________________________________________________

Notes: ____________________________________________________________

## 5. Worked visit: arrival, planning and readiness

For a reproducible fictional example, select **Demo dataset → Original fictional demo**, then confirm **Switch & reset schedule**. This discards current workflow edits. It returns to Dispatch at 10:15 with Dispatcher and the first demo technician selected. Branding and appearance are separate.

Open **2018 Subaru Outback / #1042**. All people and work in this example are fictional. Its arrival is already recorded as 08:00 and promise as 14:00; there is no arrival/check-in button to press.

The visit has Diagnosis → Control arm repair → Wheel alignment → Road test. Oil & filter service is independent. Initially Mara owns active Diagnosis; Eli owns Repair; Owen owns Alignment; Jules owns Road test; Tess owns Oil service. A single vehicle therefore crosses multiple technicians.

As Dispatcher, find Oil & filter service → **Assignment & time**. Choose **Eli Mercer**, set **10:30**, then **Save changes**. Ownership and the plan change; diagnosis dependencies do not. The oil job remains ready but not started. This is planning, not technician acceptance or customer authorization.

Repair is blocked until Diagnosis is complete; Alignment waits for Repair; Road test waits for Alignment. “Ready” means prerequisites are satisfied, not that parts, approval, qualifications, technician or rack availability have all been verified.

**Review prompt:** What information should confirm a vehicle has truly arrived? Should ready mean more than “earlier jobs complete”?

Notes: ____________________________________________________________

Notes: ____________________________________________________________

## 6. Worked visit: start, pause and resume

Diagnosis starts active in this scenario with 22 recorded active minutes. Click **Pause**, choose **Waiting for parts**, then **Pause job**. It becomes paused; dependent Repair remains blocked.

Close the detail and press **+15 min** once. The clock becomes 10:30. Diagnosis still has 22 active minutes and now has 15 paused-waiting minutes. Other active jobs gain active minutes too. Nothing automatically resolves the parts wait.

Reopen the Outback. Start the reassigned Oil & filter service. Eli is initially free, so it can run independently while Diagnosis waits. A person must decide that this parallel work is physically safe; the preview does not model every bay, tool or vehicle-access conflict.

Resume Diagnosis. Its timers are retained and the pause reason is cleared. Press **Complete** while Diagnosis is active. Repair becomes ready immediately, but it does not start itself. Alignment and Road test remain blocked. Completion does not require the predicted time to have elapsed.

To try the technician view, choose **Demo role → Technician** and select Mara: My Work reflects the same changes. Select Eli to see the reassigned oil job and ready Repair. These are perspective switches, not separate user accounts.

**Review prompt:** Who should clear a parts or approval wait? Should resuming require evidence rather than only a button?

Notes: ____________________________________________________________

Notes: ____________________________________________________________

## 7. Worked visit: completion and downstream handoffs

While Eli's Oil service is active, try starting his now-ready Repair. The preview asks **Switch active work?** Choose **Pause current & start** only if intended. Oil service pauses with reason “Switched to another job,” retaining its time, and Repair starts. Cancel leaves Oil service active.

Complete Repair while it is active. Alignment becomes ready. Switch back to Dispatcher to operate the remaining jobs in vehicle detail, or select each owning technician. Start and complete Alignment, then start and complete Road test. Owen must be outside his break and the shared rack must be free before Alignment can start.

Also resume and complete Eli's paused Oil service. The independent branch counts toward the visit total; completing Road test alone is not enough. If another job occupies a technician or the rack, resolve it explicitly as explained in section 9.

The UI updates readiness automatically after completion; people still start every next job. There is no recipient acknowledgment, notification or automatic assignment at a handoff.

When all five jobs are complete, the Dispatch summary can say **Ready for pickup**. This is a display label. There is no checkout, payment, key release, customer pickup confirmation, closing or removal of the vehicle in this preview. Completed jobs remain visible and cannot be reopened.

**Review prompt:** What must happen between “all jobs complete” and safe vehicle release? Who should accept each handoff?

Notes: ____________________________________________________________

Notes: ____________________________________________________________

## 8. My Work: the technician's view

My Work shows the selected technician's jobs, with active work first, unfinished work before completed work, and planned time ordering within those groups. The banner identifies active work and remaining predicted workload.

Each card includes job/vehicle, planned start, vehicle promise, status, risk and book/predicted/active/waiting values. Use Start job, Pause, Resume and Complete under the same rules as vehicle detail. **See vehicle workflow** opens the wider visit and its dependencies.

My Work does not edit assignments. Its controls always act for the selected demo technician. Vehicle detail uses the separate Demo role to decide whether all jobs or only that technician's jobs are controllable.

An empty queue suggests asking the dispatcher for work or selecting a different demo technician. It does not automatically assign the next job. The phone layout is an individual-job view, not a separate synchronized mobile service.

**Review prompt:** Can a technician easily identify the next eligible job and why another job is waiting? What context is missing on a phone?

Notes: ____________________________________________________________

Notes: ____________________________________________________________

## 9. Blockers, equipment, breaks and time

**Two separate ideas:** Readiness asks whether prerequisites are complete. Session state says idle, active, paused or completed. Paused does not mean completed; a pause reason is not an independently managed blocker record.

**One active job per technician:** Starting another eligible job requires explicit pause-current consent. It preserves the old job's counters. If another check fails first, such as a break or occupied rack, resolve that before switching.

**One active alignment-rack job:** A competing rack job cannot start until a person pauses or completes the current rack job. Changing technicians does not bypass this check. Pausing makes the rack available in the simulation; physical rack clearing is not modeled.

**Breaks:** A start or resume during that technician's break is rejected. Advancing time into a break does not automatically pause existing work. Active minutes still accrue. Forecasts account for breaks, so forecast behavior is not identical to timer behavior.

**Four time values:** Book labor is a fictional billed allowance, not a stopwatch. Predicted tech time is illustrative; in the fictional demo it represents medians from 7–12 invented comparisons, not trained AI. Active session minutes count only active work. Paused waiting counts only paused sessions. Neither session counter includes time spent unstarted in a queue. All counters advance only with +15 min.

**Finish and promise risk:** The deterministic projection uses planned-order technician queues, dependencies, breaks, rack capacity and remaining predicted time, with a minimum five minutes for unfinished work. A paused job adds a fixed fictional 30-minute remaining hold, not a parts ETA or countdown. It does not learn speed from the historical export.

- **At risk:** Projected finish is later than the promise.
- **Watch:** There are zero through 30 minutes of buffer.
- **On track:** More than 30 minutes of buffer.

These are planning illustrations, not customer commitments or optimized schedules. Work can exceed prediction without completing automatically. Remaining-work figures omit paused holds and queue delays; a workload percentage is not a measured efficiency score.

**Person vs automatic:** People assign, choose planned times, start, pause, resume and complete. The preview validates requests, updates local counters when the clock advances, rechecks dependencies, and recalculates displayed risk. It never orders parts, asks for approval, dispatches staff or sends customer notifications.

**Review prompt:** Which waits need an owner or ETA? Should a paused rack job reserve the rack? What should happen when work crosses a break?

Notes: ____________________________________________________________

Notes: ____________________________________________________________

## 10. Experience: evidence, not qualifications

Experience always shows the separate Burnett historical evidence, even while the schedule uses the Original fictional demo. Search by technician label, category or approved package filters the displayed evidence. Clear search restores it.

The page describes source coverage, possible aliases kept separate, hours-field agreement, recent observed activity and top observed categories/packages. It is alphabetical, not a technician ranking. The guide deliberately does not reproduce employee listings or source records.

Counts are deduplicated ordinary-invoice service-package entries, not independent repair counts. Broad categories, free checks and bundled packages do not prove equivalent work. Exact-row deduplication is a presentation assumption, not verified job identity. Per-label invoice totals must not be summed as unique shop invoices.

The exported Technician Hours mostly agree with billed hours; their meaning as actual clock time is unverified. Neither speed, attendance, current roster nor independent skill is established. Missing approved packages do not mean no experience. This page does not qualify technicians, restrict assignment or train the demo predictions.

**Review prompt:** What evidence and manager confirmation would you require before treating history as a qualification? Are the warnings understandable?

Notes: ____________________________________________________________

Notes: ____________________________________________________________

## 11. Brand settings, appearance and resets

**Brand settings:** Choose Enterprise defaults or Location identity. Edit display names, primary/accent colors and a local PNG/JPEG/WebP logo up to 256 KB. URLs and SVGs are not accepted. The live draft preview is not an applied change.

Location identity can **Inherit enterprise colors and logo**. Turn inheritance off to edit an isolated local style; enterprise changes then leave that override untouched. Turn inheritance on to use enterprise styling again. Typography (system sans/serif) and density (comfortable/compact) apply enterprise-wide. Warning/status colors keep their meaning.

Choose **Apply branding** to apply and save in this browser; **Discard draft** restores the applied configuration. Navigating away from Brand settings loses unapplied drafts. Changing the topbar presentation location applies the saved location choice and can also replace the current draft. Use Apply or Discard deliberately before switching context.

The two presentation locations share the same simulated schedule; they are not separate live tenants. A location selection inside the Brand settings form is a draft until applied. The proposed theme is not official Burnett branding.

**Appearance:** The topbar offers Light, Dark or System. System is the default and follows OS changes; an explicit choice does not. Appearance is separate from branding and workflow. Printing the preview uses a light palette. This exported guide has its own light print layout.

**What survives?**

- Workflow Reset asks for confirmation, restores the current dataset's original jobs/assignments/timers at 10:15, returns to Dispatch/Dispatcher and the first technician. It preserves saved branding and appearance.
- Switching Demo dataset asks for confirmation and resets the schedule and perspective. Saved branding and appearance remain.
- Browser refresh loses all workflow edits and returns to the default Burnett scenario. Saved branding, presentation location and appearance normally remain.
- Reset branding asks for confirmation and replaces enterprise/location styles, logos, typography, density and presentation location with defaults. Workflow and appearance remain unchanged.
- Branding cannot be saved/applied if browser storage is blocked or full; an error is shown and the draft remains. Appearance still works for the session if it cannot be saved; invalid/unavailable stored appearance falls back to System on reload.

Saved settings are local to this browser, not shared accounts, devices or a server. Do not use this preview as the only record of real work.

**Review prompt:** Are draft versus saved changes obvious? Are the separate reset actions safe and predictable?

Notes: ____________________________________________________________

Notes: ____________________________________________________________

## 12. Boundaries and possible improvements

**Implemented preview behavior:** Local job ownership, prerequisites, session transitions, single-active-work constraints, one rack, fixed breaks, editable half-hour plans, simulated timers/projections, history presentation and browser-local branding/appearance.

**Separate production-side code/documentation only:** The authenticated /dashboard/shop-workflow route checks session and shop entitlement. Its documentation describes persisted visits, permissions, source intake, concurrency handling, audit history and optional operational readiness/handoff/final-check controls. Those capabilities are not available through this root preview and must not be inferred from its role selector. Source code and documents do not establish deployment, activation, live data correctness or shop readiness. None was checked against live services for this guide.

**Not implemented in this preview:** Arrival/intake editing, creating/deleting visits or jobs, promise editing, changing dependencies, certifications, approval/parts workflows, real ETA input, customer messages, inventory, handoff acknowledgment, undo/reopening completion, split sessions, multi-day plans, concurrency/audit records, checkout or vehicle release.

**Unknowns requiring review:** Actual technician roster and qualifications; what historical hours truly measure; safe physical parallel work; validated duration estimates; operational permissions; accessibility with users' assistive devices; and whether the production counterpart is enabled anywhere.

**Ideas to discuss, not features being promised:** Stronger readiness checks; an owner and ETA for waits; handoff acceptance; completion confirmation/correction; rack reservations while paused; clearer planned-overlap warnings; and a distinct vehicle-release checklist. Record priorities below rather than assuming these exist.

**Review prompt:** Which missing capability prevents useful evaluation, and which can wait? What current behavior should remain unchanged?

Notes: ____________________________________________________________

Notes: ____________________________________________________________

## 13. Feedback worksheet

Use section numbers and exact on-screen labels. Describe observed behavior separately from the behavior you want. Do not include real customer records, credentials or raw exports.

Priority suggestions: **Must fix** (blocks safe use or understanding), **Should improve** (meaningful friction), **Nice to have** (optional).

### Feedback item A

Stage / guide section: ______________________________________________

Action tried and what happened: _____________________________________

Concern and who is affected: ________________________________________

Proposed change: ___________________________________________________

Priority and reason: ________________________________________________

Keep unchanged: ___________________________________________________

### Feedback item B

Stage / guide section: ______________________________________________

Action tried and what happened: _____________________________________

Concern and who is affected: ________________________________________

Proposed change: ___________________________________________________

Priority and reason: ________________________________________________

Keep unchanged: ___________________________________________________

### Feedback item C

Stage / guide section: ______________________________________________

Action tried and what happened: _____________________________________

Concern and who is affected: ________________________________________

Proposed change: ___________________________________________________

Priority and reason: ________________________________________________

Keep unchanged: ___________________________________________________

## 14. Glossary and evidence

- **RO:** Repair order; the identifying number shown beside a vehicle.
- **Visit:** A vehicle's group of individual jobs and its arrival/promise context.
- **Dependency / prerequisite:** Earlier work that must be complete before a job starts.
- **Ready:** Prerequisites complete; other start constraints may still prevent work.
- **Session:** Whether a job is idle, active, paused or completed.
- **Planned start:** A chosen schedule position, not automatic start authorization.
- **Book labor:** Illustrative billed allowance, distinct from elapsed work.
- **Predicted tech time:** Invented duration estimate, not measured performance.
- **Promise buffer:** Minutes between illustrative finish and promised-ready time.
- **Resource:** Shared equipment; this preview models one alignment rack.
- **Inheritance:** A location uses enterprise colors/logo instead of a local override.
- **Local browser storage:** Settings kept in this browser rather than on a server.

Evidence reviewed: the Detect Dog artifact README; ShopWorkflow, DispatchBoard, VehicleWorkflow, JobActions, MyWork, Experience and BrandSettings components; the workflow model and local state/settings hooks. Production scope was checked only against app/dashboard/shop-workflow/page.tsx, docs/shop-dispatch-pilot.md and docs/workflow-operations.md. No live database or provider records were accessed.

This is a dated review snapshot, not a service manual or evidence of production activation. Future preview changes may make individual instructions outdated.
