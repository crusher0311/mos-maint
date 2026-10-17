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
const digest=require("node:crypto").createHash("sha256").update(JSON.stringify(invoices)).digest("hex");
Module._load = function(id,...args) {
  if (id === "mongodb") return { MongoClient: class {
    async connect() {}
    async close() {}
    db() { return {collection: name => {
      if(name==="enterprise_accounts") return {findOne:async()=>({name:"JWT",shopIds:Array.from({length:10},(_,i)=>227+i)})};
      if(name==="operator_history_import_pages") return {find:filter=>({sort(){return this},batchSize(){return this},
        async *[Symbol.asyncIterator](){
          if(filter._id.$gte==="protractor-weekend-2026-10-17:227:")
            yield {shopId:227,invoices,digest};
        }})};
      throw Error("Unexpected Mongo operation");
    }} }
  }};
  return original.call(this,id,...args);
};
