/** Read-only archived-source assessment. No provider requests or database writes.
 * Counts source evidence, NOT approved SQL updates; target-row reconciliation
 * and a separately authorized apply are still required.
 */
import { getDb, getMongoClient } from "../lib/mongo";
import { protractorTechnician } from "../lib/integrations/protractor/technician";
import { writeFileSync } from "node:fs";

async function main() {
  const db=await getDb();
  const prefix="shop538-history-2026-10-08:";
  const job=await db.collection<{_id:string;status:string;completedDays:number}>("operator_history_import_jobs").findOne(
    {_id:"shop538-history-2026-10-08"},{projection:{status:1,completedDays:1},maxTimeMS:5000});
  if(job?.status!=="completed")throw Error("Completed archive required");
  const summary={assessedAt:new Date().toISOString(),shopId:538,mode:"read-only source assessment",
    pages:0,invoices:0,packages:0,lines:0,laborLines:0,
    recoverableLines:0,recoverableLaborLines:0,missingLineIds:0,
    packagesWithTechnicians:0,multiTechnicianPackages:0,distinctEmployeeIds:0,
    missingOrMalformedTechnicians:0,identityNameConflicts:0,
    targetRowsReconciled:false,productionWrites:0};
  const employees=new Map<string,Set<string>>();
  const arr=(v:any):any[]=>Array.isArray(v)?v:Array.isArray(v?.ItemCollection)?v.ItemCollection:[];
  const cursor=db.collection("operator_history_import_pages").find(
    {_id:{$gte:prefix,$lt:prefix+"\uffff"}} as any,
    {projection:{invoices:1},batchSize:1}).maxTimeMS(15000);
  for await(const page of cursor){
    summary.pages++;
    for(const invoice of arr(page.invoices)){
      summary.invoices++;
      for(const pkg of arr(invoice.ServicePackages)){
        summary.packages++;
        const techs=new Set<string>();
        for(const line of arr(pkg.ServicePackageLines)){
          summary.lines++;
          const labor=line.Type==="Labor";
          if(labor)summary.laborLines++;
          if(!line.ID&&!line.LineID)summary.missingLineIds++;
          const t=protractorTechnician(line.Technician,line.TechnicianName);
          if(t.technicianId&&t.technicianName){
            summary.recoverableLines++;
            if(labor)summary.recoverableLaborLines++;
            techs.add(t.technicianId);
            const names=employees.get(t.technicianId)??new Set<string>();
            names.add(t.technicianName);employees.set(t.technicianId,names);
          }else summary.missingOrMalformedTechnicians++;
        }
        if(techs.size)summary.packagesWithTechnicians++;
        if(techs.size>1)summary.multiTechnicianPackages++;
      }
    }
  }
  summary.distinctEmployeeIds=employees.size;
  summary.identityNameConflicts=[...employees.values()].filter(s=>s.size>1).length;
  const output=JSON.stringify(summary,null,2);
  writeFileSync("docs/reporting/burnett-technician-recovery-assessment.json",output+"\n");
  console.log(output);
}
main().catch(e=>{console.error(e.name);process.exitCode=1;})
  .finally(async()=>{await (await getMongoClient()).close();});
