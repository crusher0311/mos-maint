import assert from "node:assert/strict";
import {prepareInvoiceMetadataProposal as prepare,simulateInvoiceMetadataProposal as simulate} from "../scripts/invoice-metadata-repair-plan";
const id="11111111-1111-4111-8111-111111111111";
const raw={ID:id,Type:"Invoice",WorkflowStage:"Invoice",InvoiceNumber:123,
  InvoiceTime:"2026-10-16T12:00:00Z",ServicePackages:[],DeferredServicePackages:[]};
const record={shopId:227,sourceIds:[id],copies:[{shopId:227,raw}]};
const target={id:"hashed-local-target",shop_id:227,status:"closed",soft_delete:{isDeleted:false},
  provenance:{sourceSystem:"protractor",sourceIds:[{system:"protractor",idType:"invoice_id",idValue:id}]},
  custom_fields:{other:{nested:[1,2]},laborReporting:{sold:3}}};
const plan=prepare(record,[target]),after=simulate(plan,record,target);
assert.equal(plan.repairAuthorized,false);assert.equal(plan.livePreflightRequired,true);
assert.equal(plan.expectedInvoiceField,"absent");
assert.deepEqual(after.custom_fields.other,target.custom_fields.other);
assert.deepEqual(after.custom_fields.laborReporting,target.custom_fields.laborReporting);
assert.deepEqual(after.provenance,target.provenance);
assert.ok(!Object.hasOwn(target.custom_fields,"invoiceHours"));
assert.equal(prepare(record,[{...target,custom_fields:{...target.custom_fields,invoiceHours:null}}]).expectedInvoiceField,"null");
for(const rows of [[],[target,target],[{...target,shop_id:228}],
  [{...target,soft_delete:{isDeleted:true}}],[{...target,custom_fields:{invoiceHours:{version:1}}}],
  [{...target,provenance:{...target.provenance,sourceIds:[]}}]])assert.throws(()=>prepare(record,rows));
assert.throws(()=>simulate(plan,record,{...target,custom_fields:{...target.custom_fields,newValue:1}}));
assert.throws(()=>simulate({...plan,patch:{...plan.patch,value:{...plan.patch.value,sold:99}}},record,target));
assert.throws(()=>simulate(plan,{...record,copies:[{shopId:227,raw:{...raw,InvoiceNumber:456}}]},target));
assert.throws(()=>prepare({...record,copies:[{shopId:227,raw:{...raw,InvoiceNumber:0}}]},[target]));
console.log("PASS metadata plan: exact source/target binding, minimal patch, changed-state and ambiguous-owner vetoes");
