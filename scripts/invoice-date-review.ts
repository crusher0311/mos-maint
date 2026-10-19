/** Date-scope experiment only: does NOT establish invoice counts or labor hours. */
export function retainDateConflict(
  review:{classification:string;date:string|null}, reason:string,
  hasInvoiceEvidence:boolean, start:string, end:string,
) {
  // Only a labor-only veto may be separated from period eligibility.
  // The review must have inspected every matched copy; SQL still checks peers.
  const stamp=review.date===null?NaN:Date.parse(review.date);
  const from=Date.parse(start),to=Date.parse(end);
  const outside=review.classification==="consistent_final_invoice_date"&&
    Number.isFinite(stamp)&&Number.isFinite(from)&&Number.isFinite(to)&&from<=to&&
    (stamp<from||stamp>to);
  return hasInvoiceEvidence||reason.startsWith("matched_copy")||
    (reason.startsWith("conflicting")&&!(reason==="conflicting_recorded_hours"&&outside));
}

export function reviewInvoiceDate(ids:string[],raws:any[]) {
  if(!raws.length)return {classification:"missing_source",date:null};
  let date:string|null=null,identity:string|null=null;
  for(const raw of raws) {
    if(!raw||!["WorkOrder","Invoice"].includes(raw.Type)||raw.WorkflowStage!=="Invoice"||
      (raw.Status!=null&&!["Invoice","Invoiced","Paid","Closed"].includes(raw.Status)))
      return {classification:"finality_unverified",date:null};
    const id=String(raw.ID??"").toLowerCase();
    if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)||
      !ids.includes(id)||(identity&&identity!==id))return {classification:"identity_conflict",date:null};
    identity=id;
    if(!["number","string"].includes(typeof raw.InvoiceNumber)||String(raw.InvoiceNumber).trim()===""||
      !Number.isFinite(Number(raw.InvoiceNumber))||Number(raw.InvoiceNumber)<0)
      return {classification:"number_unverified",date:null};
    const text=raw.InvoiceTime;
    if(typeof text!=="string"||!/^\d{4}-\d{2}-\d{2}T/.test(text))
      return {classification:"date_unverified",date:null};
    const calendar=new Date(text.slice(0,10)+"T00:00:00Z");
    const d=new Date(/(?:Z|[+-]\d{2}:\d{2})$/.test(text)?text:text+"Z");
    if(!Number.isFinite(+d)||d.getUTCFullYear()<1900||!Number.isFinite(+calendar)||
      calendar.toISOString().slice(0,10)!==text.slice(0,10))return {classification:"date_unverified",date:null};
    if(date&&date!==d.toISOString())return {classification:"date_conflict",date:null};
    date=d.toISOString();
  }
  return {classification:"consistent_final_invoice_date",date};
}

/** Local experiment: older nonfinal snapshots can only establish date scope. */
export function reviewInvoiceChronology(ids:string[],raws:any[]) {
  const reject=()=>({classification:"chronology_unverified",date:null});
  if(!raws.length)return reject();
  const finals=raws.filter(r=>r?.WorkflowStage==="Invoice");
  const earlier=raws.filter(r=>r?.WorkflowStage!=="Invoice");
  const reviewed=reviewInvoiceDate(ids,finals);
  if(reviewed.classification!=="consistent_final_invoice_date")return reviewed;
  if(!earlier.length)return reviewed;
  const identity=String(finals[0].ID).toLowerCase();
  const stamp=(s:any)=>{
    // Require explicit timezone and real calendar dates, not local cache times.
    if(typeof s!=="string"||!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(s))return NaN;
    const d=new Date(s),day=new Date(s.slice(0,10)+"T00:00:00Z");
    return Number.isFinite(+d)&&d.getUTCFullYear()>=1900&&Number.isFinite(+day)&&
      day.toISOString().slice(0,10)===s.slice(0,10)?+d:NaN;
  };
  const finalTimes=finals.map(r=>stamp(r.Header?.LastModifiedTime));
  if(finalTimes.some(t=>!Number.isFinite(t)))return reject();
  for(const raw of earlier) {
    const modified=stamp(raw?.Header?.LastModifiedTime);
    if(raw?.Type!=="WorkOrder"||String(raw.ID??"").toLowerCase()!==identity||
      !["Unassigned","ScheduledWork","InspectionInProgress","EstimateCompleted","WorkCompleted"].includes(raw.WorkflowStage)||
      (raw.Status!=null&&!["Open",raw.WorkflowStage].includes(raw.Status))||
      ![0,"0"].includes(raw.InvoiceNumber)||
      (raw.InvoiceTime!=null&&raw.InvoiceTime!==""&&!/^0001-01-01T00:00:00(?:\.0+)?$/.test(raw.InvoiceTime))||
      !Number.isFinite(modified)||modified>=Math.min(...finalTimes))return reject();
  }
  return reviewed;
}
