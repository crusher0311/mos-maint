import test from "node:test";
import assert from "node:assert/strict";
import { protractorTechnician as map } from "../lib/integrations/protractor/technician";
test("structured employees retain independent identities and names", () => {
  assert.deepEqual(map({ID:"a",Name:" Tech A "}),{technicianId:"a",technicianName:"Tech A"});
  assert.deepEqual(map({ID:"b",Name:{FirstName:"Tech",LastName:"B"}}),{technicianId:"b",technicianName:"Tech B"});
  assert.notEqual(map({ID:"a",Name:"Same"}).technicianId,map({ID:"b",Name:"Same"}).technicianId);
});
test("missing and malformed employees never produce object strings or guessed identities",()=>{
  for(const v of [null,undefined,{},[],42,{Name:{}},{ID:{}}, "[object Object]"])
    assert.deepEqual(map(v),{technicianId:undefined,technicianName:undefined});
  assert.equal(map("Legacy").technicianName,"Legacy");
  assert.equal(map({ID:"a"},"Fallback").technicianName,"Fallback");
});
