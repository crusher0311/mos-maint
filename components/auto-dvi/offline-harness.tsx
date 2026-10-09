import React from "react";
import { createRoot } from "react-dom/client";
import VisitInspectionPanel from "./VisitInspectionPanel";
import {
  applyVisitAction, BUILTIN_SHEETS, EMPTY_RESULT, validateSheet,
  type Sheet, type VisitRecord, type HistoryEntry,
} from "../../lib/auto-dvi/visit-model";

// This entry is test-only and is never imported by the production component.
let record: VisitRecord = { revision: 0, visits: [] };
let templates: Sheet[] = [];
let templateRevision = 0;
let shared = true;
let nextId = 0;
const historicalVisit = {
  id: "historic-fixture", roNumber: "OFFLINE-OLD", mileage: 42618,
  createdAt: "2025-01-14T10:30:00Z", completedAt: "2025-01-14T11:10:00Z",
  status: "complete" as const, sheet: BUILTIN_SHEETS[0], sheets: [BUILTIN_SHEETS[0]],
  results: { "tire.lf": { ...EMPTY_RESULT, rating: "red" as const, notes: "Historical fixture only", values: {}, media: [] } },
};
const calls: Array<{ url: string; action?: string }> = [];
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const payload = () => ({
  ok: true, record: structuredClone(record), templateRevision, templates: structuredClone(templates), canManageSheets: true,
  history: shared ? [{ shopId: 17, shopName: "Offline history shop", visit: historicalVisit } satisfies HistoryEntry] : [],
  sharingReason: shared ? undefined : "Shared history is not authorized.",
});
window.fetch = async (input, init) => {
  const url = String(input);
  if (!url.startsWith("/api/auto-dvi/visits") && !url.startsWith("/api/auto-dvi/visit-media")) throw new Error(`Offline harness blocked unexpected request: ${url}`);
  await new Promise(resolve => setTimeout(resolve, 25));
  if (init?.method !== "POST") { calls.push({ url }); return response(payload()); }
  const media = init.body instanceof FormData;
  const body = media ? Object.fromEntries((init.body as FormData).entries()) : JSON.parse(String(init.body));
  calls.push({ url, action: media ? "upload" : body.action });
  try {
    if (Number(body.revision) !== record.revision && !String(body.action).startsWith("template")) return response({ ok: false, error: "Revision conflict" }, 409);
    if (media) {
      const visit = record.visits.find(v => v.id === body.visitId)!;
      if (visit.status === "complete") return response({ ok: false, error: "Completed" }, 409);
      const file = body.file as File;
      const result = visit.results[String(body.itemId)] || structuredClone(EMPTY_RESULT);
      visit.results[String(body.itemId)] = { ...result, media: [...result.media, { mediaId: "offline-media", filename: file.name, kind: "photo" }] };
      record.revision++;
    } else if (String(body.action).startsWith("template")) {
      if (body.templateRevision !== templateRevision) return response({ ok: false, error: "Template conflict" }, 409);
      if (body.action === "templateSave") {
        const sheet = validateSheet(body.sheet);
        templates = [...templates.filter(s => s.id !== sheet.id), sheet];
      } else templates = templates.filter(s => s.id !== body.sheetId);
      templateRevision++;
    } else record = applyVisitAction(record, body, new Date(1739000000000 + (++nextId) * 86400000).toISOString(), `offline-${nextId}`);
    return response(payload());
  } catch (error) { return response({ ok: false, error: error instanceof Error ? error.message : "Invalid" }, 400); }
};

declare global {
  interface Window {
    __dvi: {
      calls: typeof calls;
      getRecord: () => VisitRecord;
      external: () => void;
      revoke: () => void;
      templates: () => Sheet[];
    };
  }
}
window.__dvi = {
  calls, getRecord: () => structuredClone(record), templates: () => structuredClone(templates),
  external: () => { record.revision++; record.visits[0].results["tire.lf"] = { ...structuredClone(EMPTY_RESULT), notes: "Another technician's saved entry" }; },
  revoke: () => { shared = false; },
};
createRoot(document.getElementById("root")!).render(<React.StrictMode><VisitInspectionPanel vin="1HGBH41JXMN109186" mileage={null} /></React.StrictMode>);
