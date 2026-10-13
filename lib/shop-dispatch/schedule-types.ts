import { z } from "zod";

const id=z.string().trim().min(1).max(100).regex(/^[\w.:@+-]+$/);
const clock=z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const instant=z.string().datetime({offset:true});
export const openingSchema=z.object({day:z.number().int().min(0).max(6),start:clock,end:clock}).strict()
  .refine(v=>v.start<v.end,"Opening time must precede closing time; split overnight shifts.");
const absence=z.object({start:instant,end:instant}).strict().refine(v=>Date.parse(v.start)<Date.parse(v.end),"Time off must end after it starts.");
const lane=z.object({id,weekly:z.array(openingSchema).max(21),timeOff:z.array(absence).max(60)}).strict();
export const scheduleSettingsSchema=z.object({
  enabled:z.boolean(),
  timeZone:z.string().max(80).refine(v=>{try{new Intl.DateTimeFormat("en",{timeZone:v});return true;}catch{return false;}},"Use a valid IANA timezone."),
  weekly:z.array(openingSchema).max(21),
  technicians:z.array(lane).max(40),
  resources:z.array(lane).max(40),
  bufferMinutes:z.number().int().min(0).max(120),
  leadMinutes:z.number().int().min(0).max(10080),
}).strict();
export type ScheduleSettings=z.infer<typeof scheduleSettingsSchema>;
export interface CalendarAppointment {
  customer?:string;contactId?:string;vehicleId?:string;concerns?:string[];mileage?:number;
  id:string; ro:string; title:string; start:string|null; end:string|null;
  technicianSourceIds:string[];
}
export interface AppointmentSnapshot {
  startDate:string;endDate:string;fetchedAt:string;complete:boolean;
  appointments:CalendarAppointment[];warning?:string;
}
export interface ScheduleHold {
  id:string;owner:string;requestId:string;digest:string;createdAt:string;expiresAt:string;
  start:string;end:string;technicianId:string;resourceId:string|null;skillKey:string|null;
  releasedAt:string|null;
}
export interface ScheduleState {
  settings?:ScheduleSettings;
  appointments?:AppointmentSnapshot;
  holds:ScheduleHold[];
}
export const availabilityQuerySchema=z.object({
  startDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  durationMinutes:z.coerce.number().int().min(15).max(480),
  technicianId:id.optional(),
  resourceId:id.optional(),
  skillKey:z.string().trim().min(1).max(160).optional(),
}).strict();
export type AvailabilityQuery=z.infer<typeof availabilityQuerySchema>;
export interface AvailableSlot {start:string;end:string;technicianId:string;resourceId:string|null}
export interface AvailabilityResult {
  timeZone:string|null;revision:number;generatedAt:string;appointmentFetchedAt:string|null;
  available:boolean;reasons:string[];warnings:string[];slots:AvailableSlot[];truncated:boolean;
}
