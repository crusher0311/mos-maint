import { z } from "zod";
import type { Board, Technician } from "./model";

const identifier = z.string().trim().min(1).max(100).regex(/^[\w.:@+-]+$/);
export const scheduleLaneViewSchema = z.object({
  id: identifier,
  name: z.string().trim().min(1).max(60),
  technicianIds: z.array(identifier).max(40),
  skillKeys: z.array(z.string().trim().min(1).max(160)).max(100),
}).strict().refine(view => view.technicianIds.length + view.skillKeys.length > 0,
  "Choose at least one technician or confirmed skill");
export type ScheduleLaneView = z.infer<typeof scheduleLaneViewSchema>;
export interface ScheduleLaneViews { views: ScheduleLaneView[]; selectedId: string | null }

/** Presentation only. Never pass this subset to a capacity or assignment check. */
export function visibleLaneTechnicians(board: Board): Technician[] {
  const view = board.scheduleViews?.views.find(v => v.id === board.scheduleViews?.selectedId);
  if (!view) return board.technicians;
  return board.technicians.filter(t => t.active && (
    view.technicianIds.includes(t.id) ||
    t.skills?.some(s => s.status === "confirmed" && view.skillKeys.includes(s.key))
  ));
}
