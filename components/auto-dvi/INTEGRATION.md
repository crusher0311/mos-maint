# Visit inspection frontend

Mount `VisitInspectionPanel` before the existing Auto DVI panel:

```tsx
import VisitInspectionPanel from "@/components/auto-dvi/VisitInspectionPanel";

return (
  <>
    <VisitInspectionPanel vin={vin} mileage={mileage} />
    {/* Preserve the existing legacy panel and all of its handlers here. */}
  </>
);
```

Rename the legacy panel trigger to **Existing inspection — legacy Auto DVI / RO workflow**. Do not invoke its generation or provider push from the new visit component.

The assigned directory restriction prevents this component task from modifying the existing `app/dashboard/vehicles/[vin]/plan/AutoDviPanel.tsx`; the owning agent must apply the mount and label.

## Contracts

- Imports the owning agent's `lib/auto-dvi/visit-model.ts` exports.
- `EMPTY_RESULT` is a result object, not a factory.
- GET `/api/auto-dvi/visits` includes `templateRevision`.
- `canManageSheets` gates template create/edit/delete; permission loss disables an already open editor without discarding its contents.
- POST visit writes include `revision`; template writes also include independently captured `templateRevision`.
- POST media upload returns the persisted record, followed by GET refresh.
- Media is server-owned. No removal control is exposed because the specified API defines upload and viewing only.
- Sheets use server-validated catalog IDs and immutable visit snapshots.
- Existing completed visits are never editable.
- No AI, demo findings, pricing, provider writes, or publishing endpoints are called.
- Focus, visible 30-second intervals and visibility restoration refresh the record. History is hidden until each authorization check completes.
- Dirty item drafts survive refresh. A stale base revision receives 409; replacement requires explicit comparison and confirmation.

Scoped CSS adopts the reference's warm-paper / forest shop-floor aesthetic and system typography. It does not modify global application theme.

## Full-parity boundary

Keep **all** existing Auto DVI controls in the existing-inspection panel: vehicle-specific generation, maintenance-plan/custom-item composition, duplicate hiding, voice dictation, AI photo assignment, existing media/removal, phone mode, recalls, RO selection, recommended-work option, and provider write. The new visit surface does not yet incorporate those capabilities. Its reusable catalog is not a replacement for vehicle-specific/custom inspections. Do not route a new visit through VIN-only legacy results/push endpoints; that would associate findings with the wrong visit.

## Offline checks

```sh
./node_modules/.bin/tsc --project components/auto-dvi/tsconfig.offline.json
node components/auto-dvi/offline-browser.mjs
```

The browser harness bundles the actual production component in memory and serves only an ephemeral loopback fixture. All API calls are replaced by a test-only in-memory fake, outbound browser requests are blocked, and no root workflow is started. No production data is read. The harness is not imported by the production surface.
