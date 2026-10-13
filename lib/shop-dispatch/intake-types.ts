import { z } from "zod";

const text=z.string().trim().min(1).max(160);
const instant=z.string().datetime().nullable();
export const intakeDetailsSchema=z.object({
  customer:text, vehicle:text,
  contactId:z.string().uuid().transform(v=>v.toLowerCase()).nullable(), vehicleId:z.string().uuid().transform(v=>v.toLowerCase()).nullable(),
  newCustomer:z.object({firstName:text,lastName:text,phone1:z.string().max(40),email:z.union([z.string().email(),z.literal("")])}).strict().nullable(),
  newVehicle:z.object({vin:z.string().regex(/^[A-HJ-NPR-Z0-9]{17}$/),year:z.number().int().min(1900).max(2100),make:text,model:text}).strict().nullable(),
  identityConfirmed:z.boolean(),
  concerns:z.array(text).min(1).max(20),
  mileage:z.number().int().min(0).max(2000000).nullable(),
  customerPlan:z.enum(["waiting","drop-off","unknown"]),
  neededBy:instant,promiseAt:instant,nextUpdateAt:instant,
  commitmentsConfirmed:z.boolean(),
}).strict().superRefine((v,ctx)=>{
  if(v.contactId&&v.newCustomer||v.vehicleId&&v.newVehicle)ctx.addIssue({code:"custom",message:"Choose an existing identity or a new one, not both"});
  if((v.promiseAt||v.nextUpdateAt)&&!v.commitmentsConfirmed)ctx.addIssue({code:"custom",message:"Confirm customer commitments separately"});
});
export type IntakeDetails=z.infer<typeof intakeDetailsSchema>;
export interface WorkflowIntake {
  requestId?:string;
  appointmentId:string|null; checkedInAt:string; checkedInBy:string;
  details:IntakeDetails;
}
export interface TicketIntent {
  id:string;visitId:string;actor:string;digest:string;createdAt:string;
  status:"pending"|"uncertain"|"confirmed";message:string;
  payload:IntakeDetails;contactId:string;vehicleId:string;workOrderId:string;
  /** A persisted stage is a write admission, not evidence of success. Never replay it. */
  attempted:("contact"|"vehicle"|"workOrder")[];
}
export const intakeRequestSchema=z.discriminatedUnion("action",[
  z.object({action:z.literal("checkIn"),requestId:z.string().uuid(),revision:z.number().int().nonnegative(),appointmentId:z.string().min(1).max(100).nullable(),details:intakeDetailsSchema}).strict(),
  z.object({action:z.literal("update"),requestId:z.string().uuid(),revision:z.number().int().nonnegative(),visitId:z.string().min(1).max(100),details:intakeDetailsSchema}).strict(),
  z.object({action:z.literal("link"),requestId:z.string().uuid(),revision:z.number().int().nonnegative(),visitId:z.string().min(1).max(100),roNumber:z.string().regex(/^\d{1,15}$/),expectedSourceId:z.string().uuid(),confirmed:z.literal(true)}).strict(),
  z.object({action:z.literal("create"),requestId:z.string().uuid(),revision:z.number().int().nonnegative(),visitId:z.string().min(1).max(100),confirmed:z.literal(true)}).strict(),
  z.object({action:z.literal("reconcile"),visitId:z.string().min(1).max(100)}).strict(),
]);
