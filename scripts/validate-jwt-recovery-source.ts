import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { captureApprovedRecoverySource } from "../lib/jwt-approved-recovery-source";
import { getAdapter } from "../lib/integrations/core/normalized-adapter";

// Offline validation only. Never opens a database or calls a provider.
const bundle=JSON.parse(readFileSync(process.argv[2],"utf8"));
assert.equal(bundle.shopId,227);
assert.equal(bundle.location,"701");
assert.equal(bundle.date,"2026-09-01");
assert.equal(bundle.invoices.length,21);
const {invoices}=captureApprovedRecoverySource(bundle.invoices);
const adapter=getAdapter("protractor");
assert.ok(adapter);
const cents=(v:number)=>Math.round(v*100);
let packages=0,lines=0,laborGross=0,laborDiscount=0,laborNet=0,quantity=0;
for(const invoice of invoices) {
  const mapped=adapter.mapWorkOrder(227,invoice);
  assert.equal(mapped.status,"closed");
  const packageIds=new Set<string>(),lineIds=new Set<string>();
  let gross=0,discount=0,net=0;
  for(const p of invoice.ServicePackages.ItemCollection) {
    assert.ok(p.ID && !packageIds.has(p.ID));
    packageIds.add(p.ID); packages++;
    assert.equal(p.IsInvoicing,true,"Disposition requires additional validation");
    assert.ok(Array.isArray(p.ServicePackageLines?.ItemCollection));
    for(const line of p.ServicePackageLines.ItemCollection) {
      assert.ok(line.ID && !lineIds.has(line.ID));
      lineIds.add(line.ID); lines++;
      if(line.Type==="Labor") {
        for(const field of ["Total","Discount","ExtendedTotal","Quantity"])
          assert.ok(typeof line[field]==="number" && Number.isFinite(line[field]));
        assert.equal(cents(line.Total)-cents(line.Discount),cents(line.ExtendedTotal));
        gross+=cents(line.Total); discount+=cents(line.Discount);
        net+=cents(line.ExtendedTotal); quantity+=line.Quantity;
      }
    }
  }
  assert.equal(net,cents(invoice.Summary.LaborTotal));
  assert.equal(cents(mapped.laborTotal!),net);
  for(const [field,key] of [["grandTotal","GrandTotal"],["partsTotal","PartsTotal"],["taxTotal","TaxTotal"]] as const)
    assert.equal(cents(mapped[field]!),cents(invoice.Summary[key]));
  laborGross+=gross; laborDiscount+=discount; laborNet+=net;
}
console.log(JSON.stringify({readOnly:true,invoices:invoices.length,packages,lines,
  grossLabor: laborGross/100,laborDiscount: laborDiscount/100,netLabor: laborNet/100,
  sourceLaborQuantity:Math.round(quantity*100)/100,
  warning:"Source internal reconciliation only; not native-report reconciliation or authorization to bypass fresh write conflict checks"},null,2));
