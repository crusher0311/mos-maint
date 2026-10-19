import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {auditChild,collectChildEvidence,financialProjection} from "../scripts/invoice-owner-financial-audit";
const owner="11111111-1111-4111-8111-111111111111";
const ownerHash=createHash("sha256").update(`1:${owner}`).digest("hex");
const raw={ID:owner,Payments:[{ID:"p",Amount:25,TipAmount:2}]};
const row={amount:"25.00",tip_amount:"2.00",refunded_amount:null,
  provenance:{sourceIds:[{system:"protractor",idType:"payment_id",idValue:"p"}]}};
assert.equal(auditChild("normalized_payments",row,ownerHash,collectChildEvidence([raw],1)).reason,"verified");
assert.equal(auditChild("normalized_payments",{...row,amount:"26"},ownerHash,collectChildEvidence([raw],1)).reason,"stored_value_mismatch");
assert.equal(auditChild("normalized_payments",row,ownerHash,collectChildEvidence([],1)).reason,"missing_source_child");
assert.equal(auditChild("normalized_payments",row,"other",collectChildEvidence([raw],1)).reason,"conflicting_child_owner");
assert.equal(auditChild("normalized_payments",row,ownerHash,collectChildEvidence([raw,
  {...raw,Payments:[{ID:"p",Amount:24,TipAmount:2}]}],1)).reason,"conflicting_child_values");
assert.equal(auditChild("normalized_payments",row,ownerHash,collectChildEvidence([raw,
  {...raw,Payments:[{ID:"p",TipAmount:2}]}],1)).reason,"conflicting_child_values","Missing is not zero");
assert.equal(financialProjection("normalized_line_items",{quantity:1.125,unitPrice:2.555}).quantity,"1.125");
assert.throws(()=>financialProjection("normalized_payments",{amount:NaN}));
console.log("PASS child financial audit: decimal scales, missing values, owner/copy conflicts and stored mismatches");
