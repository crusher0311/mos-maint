import assert from "node:assert/strict";
import {reconciliationMatches as match} from "../lib/jwt-reconciliation-identity";
const source={ID:"aaaa"},native={wo:"100",invoice:"90"};
const row={work_order_number:"aaaa",provenance:{sourceSystem:"protractor",sourceIds:[{system:"protractor",idValue:"AAAA"}]}};
const collision={work_order_number:"90",provenance:{sourceSystem:"protractor",sourceIds:[{system:"protractor",idValue:"bbbb"}]}};
assert.deepEqual(match([row,collision],native,source),[row]);
assert.equal(match([row,{...row,work_order_number:"100"}],native,source).length,2,"True duplicates remain ambiguous");
assert.equal(match([collision],native,source).length,0,"Never choose a number collision");
console.log("Reconciliation requires source identity and retains real duplicates");
