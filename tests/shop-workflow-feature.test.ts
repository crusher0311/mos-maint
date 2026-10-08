import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { readFileSync } from "node:fs";
import { featuresForPlan, PLAN_FALLBACK_KEYS } from "../lib/plan-feature-tiers";
import { filterNavItemsByFeatures } from "../lib/sidebar-nav";
let shop:any=null;
const loader=Module as any,original=loader._load;
loader._load=function(id:string,...args:any[]){
 if(id==="./mongo")return {getDb:async()=>({collection:(name:string)=>({findOne:async()=>name==="shops"?shop:{featureSettings:{shop_workflow:true}}})})};
 if(id==="mongodb")return {ObjectId:class{static isValid(){return false;}constructor(public value:string){} }};
 if(id==="./db/drizzle")return {getDb:()=>({select:()=>({from:async()=>[{key:"shop_workflow",status:"active",includedInTiers:["elite","trial"]}]})})};
 if(id==="./db/schema/platform-features")return {platformFeatures:{}};
 if(id==="./db/wave4-write-mode")return {isIdentityPgCanonical:()=>false};
 if(id==="./data/repositories/pg/identity")return {};
 return original.call(this,id,...args);
};
const {getFeatureEntitlements}=require("../lib/featureResolver");
test("workflow is opt-in per shop across all plans, including founder",async()=>{
 for(const plan of Object.keys(PLAN_FALLBACK_KEYS)){
  assert.equal(featuresForPlan(plan).shop_workflow,false);
  for(const override of [undefined,false,true]){
   shop={shopId:10,enterpriseId:"enterprise",billing:{plan,status:"active"},enabledFeatures:override===undefined?{}:{shop_workflow:override}};
   const e=await getFeatureEntitlements(10);
   assert.equal(e.effectiveFeatures.shop_workflow,override===true,`${plan}/${override}`);
   assert.equal(e.isFeatureEnabled("shop_workflow"),override===true);
  }
 }
 shop=null;assert.equal((await getFeatureEntitlements(10)).isFeatureEnabled("shop_workflow"),false);
});
test("nav hides the workflow entirely; both page and API have server gates",()=>{
 const nav=[{name:"Workflow",featureId:"shop_workflow"},{name:"Dashboard"}];
 assert.equal(filterNavItemsByFeatures(nav,[]).length,1);
 assert.equal(filterNavItemsByFeatures(nav,["shop_workflow"]).length,2);
 const sidebar=readFileSync("components/ui/Sidebar.tsx","utf8");
 assert.match(sidebar,/href: "\/dashboard\/shop-workflow",\s*featureId: "shop_workflow"/);
 assert.match(readFileSync("app/dashboard/shop-workflow/page.tsx","utf8"),/isFeatureEnabled\("shop_workflow"\)/);
 assert.match(readFileSync("lib/shop-dispatch/http.ts","utf8"),/isFeatureEnabled\("shop_workflow"\)/);
 assert.doesNotMatch(readFileSync("lib/shop-dispatch/http.ts","utf8"),/SHOP_DISPATCH_PILOT_SHOP_IDS/);
});
