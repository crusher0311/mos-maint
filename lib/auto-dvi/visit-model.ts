export type Rating = "green" | "yellow" | "red";
export interface Field { id:string; label:string; type:"number"|"text"|"select"; unit?:string; options?:string[] }
export interface InspectionItem { id:string; name:string; kind:"tire"|"battery"|"check"; position?:string; fields:Field[] }
export interface Media { mediaId:string; kind:"photo"|"video"; filename:string|null }
export interface Result { rating:Rating|null; notes:string; recommendation:string; values:Record<string,string|number>; media:Media[] }
export interface Sheet { id:string; name:string; itemIds:string[]; requiredFields:Record<string,string[]> }
export interface Visit { id:string; roNumber:string; mileage:number|null; createdAt:string; completedAt?:string; status:"in_progress"|"complete"; sheet:Sheet; sheets:Sheet[]; results:Record<string,Result> }
export interface VisitRecord { revision:number; visits:Visit[] }
export interface HistoryEntry { shopId:number; shopName:string; visit:Visit }
export const EMPTY_RESULT:Result={rating:null,notes:"",recommendation:"",values:{},media:[]};
const tireFields:Field[]=[
  {id:"size",label:"Actual tire size",type:"text"},
  {id:"unit",label:"Tread unit",type:"select",options:["32nds","mm"]},
  ...["inner","center","outer"].map(id=>({id,label:`${id[0].toUpperCase()+id.slice(1)} tread`,type:"number" as const})),
  {id:"beforePsi",label:"Before pressure",type:"number",unit:"PSI"},
  {id:"afterPsi",label:"After pressure (optional)",type:"number",unit:"PSI"},
];
export const CATALOG:InspectionItem[]=[
  ...[["lf","Left front"],["rf","Right front"],["lr","Left rear"],["rr","Right rear"]].map(([id,name])=>({id:`tire.${id}`,name:`${name} tire`,position:name,kind:"tire" as const,fields:tireFields})),
  {id:"battery",name:"Battery",kind:"battery",fields:[{id:"ratedCca",label:"Rated CCA",type:"number"},{id:"measuredCca",label:"Measured CCA",type:"number"},{id:"testResult",label:"Manual battery test result",type:"select",options:["pass","monitor","fail"]}]},
  {id:"brakes",name:"Brake visual safety check",kind:"check",fields:[]},
  {id:"lights",name:"Exterior lighting safety check",kind:"check",fields:[]},
  {id:"fluids",name:"Under-hood fluid condition and levels",kind:"check",fields:[]},
  {id:"steering",name:"Steering and suspension visual check",kind:"check",fields:[]},
  {id:"wipers",name:"Wipers and windshield condition",kind:"check",fields:[]},
];
const allIds=CATALOG.map(i=>i.id);
const fullFields=Object.fromEntries(CATALOG.map(i=>[i.id,i.fields.filter(f=>f.id!=="afterPsi").map(f=>f.id)]));
export const BUILTIN_SHEETS:Sheet[]=[
  {id:"basic",name:"Basic inspection",itemIds:allIds.slice(0,7),requiredFields:{}},
  {id:"tire",name:"Tire and safety inspection",itemIds:allIds.slice(0,7),requiredFields:Object.fromEntries(Object.entries(fullFields).filter(([id])=>allIds.slice(0,7).includes(id)))},
  {id:"comprehensive",name:"Detailed vehicle inspection",itemIds:allIds,requiredFields:fullFields},
];
export class VisitError extends Error { constructor(message:string,public status=400){super(message);} }
export function normalizeVisitVin(value:unknown):string {
  if(typeof value!=="string"||!/^[A-HJ-NPR-Z0-9]{17}$/i.test(value.trim()))throw new VisitError("A valid 17-character VIN is required");
  return value.trim().toUpperCase();
}
function text(value:unknown,max:number,label:string):string {
  if(typeof value!=="string"||value.length>max)throw new VisitError(`Invalid ${label}`);
  return value.trim();
}
export function validateSheet(raw:any):Sheet {
  if(!raw||typeof raw!=="object")throw new VisitError("Invalid sheet");
  const id=text(raw.id,80,"sheet ID"),name=text(raw.name,100,"sheet name");
  if(!/^[a-zA-Z0-9_-]+$/.test(id)||!name)throw new VisitError("Sheet needs a name and stable ID");
  if(!Array.isArray(raw.itemIds)||!raw.itemIds.length||raw.itemIds.length>CATALOG.length||new Set(raw.itemIds).size!==raw.itemIds.length)throw new VisitError("Choose distinct inspection items");
  const requiredFields:Record<string,string[]>={};
  for(const itemId of raw.itemIds){
    const item=CATALOG.find(i=>i.id===itemId);if(!item)throw new VisitError("Unknown inspection item");
    const fields=raw.requiredFields?.[itemId]??[];
    if(!Array.isArray(fields)||fields.some(f=>!item.fields.some(x=>x.id===f)))throw new VisitError("Unknown required measurement");
    requiredFields[itemId]=[...new Set(fields)] as string[];
  }
  return {id,name,itemIds:[...raw.itemIds],requiredFields};
}
export function validateResult(itemId:string,raw:any,media:Media[]=[]):Result {
  const item=CATALOG.find(i=>i.id===itemId);if(!item||!raw)throw new VisitError("Unknown inspection item");
  if(raw.rating!==null&&!["green","yellow","red"].includes(raw.rating))throw new VisitError("Choose a valid rating");
  const values:Record<string,string|number>={};
  if(!raw.values||typeof raw.values!=="object"||Array.isArray(raw.values))throw new VisitError("Invalid measurements");
  for(const [key,value]of Object.entries(raw.values)){
    const field=item.fields.find(f=>f.id===key);if(!field)throw new VisitError("Unknown measurement");
    if(value==="")continue;
    if(field.type==="number"){
      if(typeof value!=="number"||!Number.isFinite(value)||value<0||value>10000)throw new VisitError(`Invalid ${field.label}`);
      values[key]=value;
    }else{
      const v=text(value,100,field.label);
      if(field.options&&!field.options.includes(v))throw new VisitError(`Invalid ${field.label}`);
      values[key]=v;
    }
  }
  return {rating:raw.rating,notes:text(raw.notes??"",1000,"notes"),recommendation:text(raw.recommendation??"",1000,"recommendation"),values,media};
}
export function completionErrors(visit:Visit):string[] {
  const errors:string[]=[];
  for(const id of visit.sheet.itemIds){
    const item=CATALOG.find(i=>i.id===id)!;const r=visit.results[id];
    if(!r?.rating)errors.push(`${item.name}: document a rating (including good results)`);
    for(const key of visit.sheet.requiredFields[id]??[]){
      if(r?.values[key]===undefined||r.values[key]==="")errors.push(`${item.name}: ${item.fields.find(f=>f.id===key)?.label??key} is required`);
    }
  }
  return errors;
}
export function applyVisitAction(record:VisitRecord,action:any,now:string,newId:string):VisitRecord {
  const next=structuredClone(record);
  if(action.action==="start"){
    if(next.visits.some(v=>v.status==="in_progress"))throw new VisitError("Finish the existing visit before starting another",409);
    if(next.visits.length>=50)throw new VisitError("Visit storage limit reached; archive review required",409);
    const roNumber=text(action.roNumber??"",80,"repair order");
    if(!roNumber)throw new VisitError("Repair order or visit reference is required");
    if(next.visits.some(v=>v.roNumber===roNumber))throw new VisitError("This visit reference already exists",409);
    const mileage=action.mileage??null;
    if(mileage!==null&&(!Number.isSafeInteger(mileage)||mileage<0||mileage>2000000))throw new VisitError("Invalid mileage");
    const sheet=structuredClone(BUILTIN_SHEETS[1]);
    next.visits.unshift({id:newId,roNumber,mileage,createdAt:now,status:"in_progress",sheet,sheets:[sheet],results:{}});
  }else{
    const v=next.visits.find(v=>v.id===action.visitId);
    if(!v)throw new VisitError("Visit not found",404);
    if(v.status==="complete")throw new VisitError("Completed reports are immutable; start a new visit",409);
    if(action.action==="save"){
      if(!v.sheet.itemIds.includes(action.itemId))throw new VisitError("Item is not on this sheet");
      v.results[action.itemId]=validateResult(action.itemId,action.result,v.results[action.itemId]?.media??[]);
    }else if(action.action==="selectSheet"){
      v.sheet=validateSheet(action.sheet);
      v.sheets=v.sheets.filter(s=>s.id!==v.sheet.id);v.sheets.push(structuredClone(v.sheet));
      if(v.sheets.length>20)throw new VisitError("Too many sheets on one visit");
    }else if(action.action==="complete"){
      const errors=completionErrors(v);if(errors.length)throw new VisitError(errors.join("; "));
      v.status="complete";v.completedAt=now;
    }else throw new VisitError("Unknown visit action");
  }
  next.revision++;
  return next;
}
