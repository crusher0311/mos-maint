/** Atomic Mongo update: omitted DOT fields are unknown, not explicit clears.
 * Only carry within the same provider RO/shop/job/part and unchanged quantity.
 * Incoming jobs/parts are authoritative: never resurrect a removed line.
 * Carried entries remain visibly marked as older evidence for report consumers.
 */
const productFields=["partNumber","brand","model","width","ratio","diameter","name","description","constructionType","loadIndex","speedRating"];
export function preserveDotFields(previous:any, incoming:any):any {
  const valid=(v:any)=>v!==null&&v!==undefined&&v!=="";
  if(!incoming||!valid(incoming.id)||!valid(incoming.shopId)||previous?.id!==incoming.id||previous?.shopId!==incoming.shopId||!Array.isArray(incoming.jobs))return incoming;
  return {...incoming,jobs:incoming.jobs.map((job:any)=>{
    if(!job||!valid(job.id)||!Array.isArray(job.parts)||incoming.jobs.filter((j:any)=>j?.id===job.id).length!==1)return job;
    const oldJobs=(Array.isArray(previous.jobs)?previous.jobs:[]).filter((j:any)=>j?.id===job.id);
    if(oldJobs.length!==1)return job;
    return {...job,parts:job.parts.map((part:any)=>{
      if(!part||!valid(part.id)||Object.hasOwn(part,"dotNumbers")||job.parts.filter((p:any)=>p?.id===part.id).length!==1)return part;
      const oldParts=(Array.isArray(oldJobs[0].parts)?oldJobs[0].parts:[]).filter((p:any)=>p?.id===part.id);
      if(oldParts.length!==1||part.quantity==null||oldParts[0].quantity!==part.quantity||!Array.isArray(oldParts[0].dotNumbers))return part;
      if(productFields.some(k=>JSON.stringify(oldParts[0][k]??null)!==JSON.stringify(part[k]??null)))return part;
      return {...part,dotNumbers:[...oldParts[0].dotNumbers],_mosDotInherited:true};
    })};
  })};
}
export function dotPreservingUpdate(update: { $set: Record<string, any>; $setOnInsert?: Record<string, any>; $unset?: Record<string, any> }): any {
  const raw=update.$set.data;
  if(!raw||!Array.isArray(raw.jobs)||raw.id==null||raw.shopId==null)return update;
  const safeArray=(v:any)=>({$cond:[{$isArray:v},v,[]]});
  const identity=(a:any,b:any)=>({$and:[{$ne:[{$ifNull:[a,null]},null]},{$ne:[a,""]},{$eq:[a,b]}]});
  const fields:Record<string,any>=Object.fromEntries(Object.entries(update.$set).filter(([,v])=>v!==undefined).map(([k,v])=>[k,{$literal:v}]));
  const oldJobs={$filter:{input:safeArray("$data.jobs"),as:"matchJob",cond:identity("$$newJob.id","$$matchJob.id")}};
  const oldParts={$filter:{input:safeArray("$$oldJob.parts"),as:"matchPart",cond:identity("$$newPart.id","$$matchPart.id")}};
  const part={$let:{vars:{oldPart:{$arrayElemAt:[oldParts,0]}},in:{$cond:[
    {$and:[
      {$eq:[{$type:"$$newPart"},"object"]},
      {$eq:[{$type:"$$newPart.dotNumbers"},"missing"]},
      {$ne:[{$ifNull:["$$newPart.quantity",null]},null]},
      {$eq:["$$newPart.quantity","$$oldPart.quantity"]},
      ...productFields.map(k=>({$eq:[{$ifNull:[`$$newPart.${k}`,null]},{$ifNull:[`$$oldPart.${k}`,null]}]})),
      {$isArray:"$$oldPart.dotNumbers"},{$eq:[{$size:oldJobs},1]},{$eq:[{$size:oldParts},1]},
      {$eq:[{$size:{$filter:{input:{$literal:raw.jobs},as:"incomingJob",cond:identity("$$newJob.id","$$incomingJob.id")}}},1]},
      {$eq:[{$size:{$filter:{input:"$$newJob.parts",as:"incomingPart",cond:identity("$$newPart.id","$$incomingPart.id")}}},1]},
    ]},
    {$mergeObjects:["$$newPart",{dotNumbers:"$$oldPart.dotNumbers",_mosDotInherited:true}]},
    "$$newPart",
  ]}}};
  const job={$cond:[
    {$and:[{$eq:[{$type:"$$newJob"},"object"]},{$isArray:"$$newJob.parts"}]},
    {$let:{vars:{oldJob:{$arrayElemAt:[oldJobs,0]}},in:{$mergeObjects:[
      "$$newJob",{parts:{$map:{input:"$$newJob.parts",as:"newPart",in:part}}},
    ]}}},
    "$$newJob",
  ]};
  fields.data={$cond:[
    {$and:[identity("$data.id",{$literal:raw.id}),identity("$data.shopId",{$literal:raw.shopId})]},
    {$mergeObjects:[{$literal:raw},{jobs:{$map:{input:{$literal:raw.jobs},as:"newJob",in:job}}}]},
    {$literal:raw},
  ]};
  for(const [key,value] of Object.entries(update.$setOnInsert||{})){
    if(key in fields)throw new Error("Conflicting insert/update path");
    fields[key]={$cond:[{$eq:[{$type:"$_id"},"missing"]},{$literal:value},`$${key}`]};
  }
  return [{$set:fields},...(update.$unset?[{$unset:Object.keys(update.$unset)}]:[])];
}
