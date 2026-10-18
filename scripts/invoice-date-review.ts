/** Date-scope experiment only: does NOT establish invoice counts or labor hours. */
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
