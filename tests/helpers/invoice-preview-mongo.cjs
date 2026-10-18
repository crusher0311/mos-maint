// Offline-only Mongo stub for the disposable PostgreSQL integration test.
const Module = require("node:module");
const original = Module._load;
const invoices=[333,334].map(n=>({
  ID:`10000000-0000-0000-0000-000000000${n}`,Type:"Invoice",WorkflowStage:"Invoice",
  InvoiceNumber:n,InvoiceTime:"2026-10-16T12:00:00Z",ServicePackages:[{
    ID:"job",Status:"Completed",IsInvoicing:true,BilledHours:2,
    ServicePackageLines:[{ID:"line",Type:"Labor",BilledHours:2}],
  }],
}));
const archived=[invoices[1]];
const digest=require("node:crypto").createHash("sha256").update(JSON.stringify(archived)).digest("hex");
Module._load = function(id,...args) {
  if (id === "mongodb") return { MongoClient: class {
    async connect() {}
    async close() {}
    db() { return {collection: name => {
      if(name==="enterprise_accounts") return {findOne:async()=>({name:"JWT",shopIds:Array.from({length:10},(_,i)=>227+i)})};
      if(["protractor_work_orders","normalized_work_orders"].includes(name)) return {find:()=>({
        hint(){return this},limit(){return this},async toArray(){return []}
      })};
      if(["protractor_invoice_cache","protractor_invoices"].includes(name)) return {find:filter=>({
        sort(){return this},hint(){return this},limit(){return this},
        async toArray(){
          if(name==="protractor_invoices"||filter?._id?.$gt)return [];
          const doc={_id:"cache-row",shopId:227,invoiceId:invoices[0].ID,invoice:invoices[0]};
          return filter?._id?.$in&&!filter._id.$in.includes("cache-row")?[]:[doc];
        }
      })};
      if(name==="operator_history_import_pages") return {find:filter=>({sort(){return this},batchSize(){return this},
        async *[Symbol.asyncIterator](){
          if(filter._id.$gte==="protractor-weekend-2026-10-17:227:")
            yield {shopId:227,invoices:archived,digest};
        }})};
      throw Error("Unexpected Mongo operation");
    }} }
  }};
  return original.call(this,id,...args);
};
