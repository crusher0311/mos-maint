/** Preview only: credit documents never contribute ordinary invoice hours. */
export function reviewCredit(ids:string[], raws:any[], invoiceEvidence:boolean) {
  if(invoiceEvidence)return {classification:"invoice_evidence_present",date:null};
  if(!raws.length)return {classification:"missing_source",date:null};
  let date:string|null=null;
  for(const raw of raws) {
    if(raw?.Type!=="CreditSlip")return {classification:"not_exclusively_credit",date:null};
    if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(raw.ID))||
      !ids.includes(String(raw.ID).toLowerCase()))return {classification:"identity_unverified",date:null};
    if(raw.WorkflowStage!=="Invoice" ||
      (raw.Status!=null&&!["Invoice","Invoiced","Paid","Closed"].includes(raw.Status)) ||
      !["number","string"].includes(typeof raw.InvoiceNumber)||!(Number(raw.InvoiceNumber)>0))
      return {classification:"finality_unverified",date:null};
    const text=raw.InvoiceTime;
    if(typeof text!=="string"||!/^\d{4}-\d{2}-\d{2}T/.test(text))
      return {classification:"date_unverified",date:null};
    const calendar=new Date(text.slice(0,10)+"T00:00:00Z");
    const d=new Date(/(?:Z|[+-]\d{2}:\d{2})$/.test(text)?text:text+"Z");
    if(!Number.isFinite(+d)||d.getUTCFullYear()<1900||!Number.isFinite(+calendar)||
      calendar.toISOString().slice(0,10)!==text.slice(0,10))
      return {classification:"date_unverified",date:null};
    if(date&&date!==d.toISOString())return {classification:"conflicting_dates",date:null};
    date=d.toISOString();
  }
  return {classification:"verified_credit",date};
}
