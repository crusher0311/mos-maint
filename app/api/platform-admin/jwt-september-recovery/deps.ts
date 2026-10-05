import { recoveryControl,recoveryStatus,recoveryStep } from "@/lib/data/repositories/jwt-september-recovery";
import { recoverJwtSource } from "@/scripts/recover-jwt-approved-invoices";

export const recoveryDeps={
  control:recoveryControl,
  status:recoveryStatus,
  step:recoveryStep,
  recover:(text:string)=>recoverJwtSource(text,{monthly:true,apply:true}),
};
