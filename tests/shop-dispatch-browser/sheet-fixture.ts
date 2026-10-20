// Synthetic, memory-only catalog for the offline browser fixture. Never imported by app routes.
import { STAFF_SHEET_TEMPLATES, sheetSchema, type StaffSheet } from "../../lib/auto-dvi/staff/model";
import type { SheetRequest, SheetSnapshot } from "../../components/shop-dispatch/use-sheet-catalog";

export function createSheetFixture(params: URLSearchParams) {
  const seed = structuredClone(STAFF_SHEET_TEMPLATES[0]);
  const tires = seed.items.filter(item => item.id.startsWith("tire")).slice(0, 2);
  const brakes = seed.items.filter(item => item.id.startsWith("brake")).slice(0, 2);
  const battery = seed.items.find(item => item.id === "battery")!;
  const selected = [...tires, ...brakes, battery];
  const arrival: StaffSheet = { id: "arrival-check", version: 2, name: "Arrival & roadworthiness", items: selected };
  let data: SheetSnapshot = {
    scope: params.has("sheetsEnterprise") ? "enterprise" : "shop",
    scopeLabel: params.has("sheetsEnterprise") ? "Cedar Automotive Group · synthetic" : "Cedar Motor Service · synthetic",
    canManage: !params.has("sheetsReadonly"), revision: 23,
    sheets: [
      { ...structuredClone(arrival), version: 1, items: selected.slice(0, 3) },
      arrival,
      { id: "brake-diagnosis", version: 1, name: "Focused brake inspection", items: seed.items.filter(item => item.id.startsWith("brake")) },
      { id: "winter-tires", version: 1, name: "Winter tire check", items: tires },
    ],
    archivedSheetIds: ["winter-tires"], defaultSheet: "arrival-check@2",
    templates: [{ id: "battery-template", version: 1, name: "Battery & charging", items: [battery] }],
    inspectionEnabled: !params.has("sheetsOff"),
  };
  const receipts = new Map<string, { payload: string; snapshot: SheetSnapshot }>();
  let lostReceipt = false, injectedConflict = false, failedRead = false;
  return async (init?: RequestInit): Promise<Response> => {
    if (params.has("sheetsDenied")) return Response.json({ error: "No DVI catalog entitlement in this synthetic scenario." }, { status: 403 });
    if (init?.method !== "POST") {
      if (params.has("sheetsLoadError") && !failedRead) { failedRead = true; throw new Error("Synthetic network failure. Retry loading sheets."); }
      return Response.json(data);
    }
    const request = JSON.parse(String(init.body)) as SheetRequest;
    const payload = JSON.stringify(request);
    const receipt = receipts.get(request.requestId);
    if (receipt) return receipt.payload === payload ? Response.json(receipt.snapshot) :
      Response.json({ error: "Request ID already used for different work." }, { status: 409 });
    if (!data.canManage) return Response.json({ error: "Only the managing organization can change these sheets." }, { status: 403 });
    if (params.has("sheetsConflict") && !injectedConflict) { data.revision++; injectedConflict = true; }
    if (request.revision !== data.revision) return Response.json({ error: "The synthetic catalog changed. Retain your draft or explicitly discard and reload." }, { status: 409 });
    const command = request.command;
    const next = structuredClone(data);
    if (command.type === "save") {
      const versions = next.sheets.filter(sheet => sheet.id === command.sheet.id);
      const base = Math.max(0, ...versions.map(sheet => sheet.version));
      if (command.sheet.version !== base) return Response.json({ error: "Expected latest base version." }, { status: 409 });
      const result = sheetSchema.safeParse({ ...command.sheet, version: base + 1 });
      if (!result.success) return Response.json({ error: result.error.issues.map(issue => issue.message).join(" · ") }, { status: 400 });
      if (result.data.items.some(item => item.fields.some(field => field.type === "select" &&
        (!field.options?.length || field.options.some(option => !option.trim()) || new Set(field.options).size !== field.options.length)))) {
        return Response.json({ error: "Select fields need nonempty, unique options." }, { status: 400 });
      }
      next.sheets.push(result.data);
      if (command.makeDefault || next.defaultSheet.split("@")[0] === result.data.id) next.defaultSheet = `${result.data.id}@${result.data.version}`;
    } else if (command.type === "default") {
      const sheet = next.sheets.find(sheet => `${sheet.id}@${sheet.version}` === command.sheet);
      if (!sheet || next.archivedSheetIds.includes(sheet.id)) return Response.json({ error: "Choose an active approved version." }, { status: 400 });
      next.defaultSheet = command.sheet;
    } else if (command.type === "archive") {
      if (command.archived && next.defaultSheet.split("@")[0] === command.sheetId) return Response.json({ error: "Select a replacement default first." }, { status: 400 });
      next.archivedSheetIds = command.archived ? [...new Set([...next.archivedSheetIds, command.sheetId])] : next.archivedSheetIds.filter(id => id !== command.sheetId);
    }
    next.revision++;
    data = next;
    receipts.set(request.requestId, { payload, snapshot: structuredClone(next) });
    if (params.has("sheetsUncertain") && !lostReceipt) { lostReceipt = true; throw new Error("Synthetic receipt lost after commit. Retry the exact save."); }
    return Response.json(data);
  };
}
