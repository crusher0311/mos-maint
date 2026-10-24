import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { readAppFueledQrDestination, requireAppFueledQrDestination } from "../lib/appfueled-qr-destination";
import { resolveStickerScan } from "../lib/sticker-redirect";
import { featuresForPlan } from "../lib/plan-feature-tiers";
const vin = "1HGCM82633A004352", url = "https://reports.example.com/car/a", ref = "a".repeat(24);
let receipts: string[] = [url];
let reads = 0;
const db: any = {collection: (name: string) => {
  assert.equal(name,"partner_vhi_links");
  return {aggregate: (pipeline: any[], options: any) => {
    reads++;
    assert.deepEqual(pipeline[0],{$match:{partnerId:"appfueled",shopId:42,vin}});
    assert.equal(options.maxTimeMS,1500);
    return {toArray: async () => [...new Set(receipts)].slice(0,2).map(_id => ({_id}))};
  }};
}};
test("uses canonical inbox, not receipt time, and never mutates stored data", async () => {
  receipts = [url,url];
  assert.equal(await readAppFueledQrDestination(db,42,vin),url);
  receipts = [url,url+"new",url];
  assert.equal(await readAppFueledQrDestination(db,42,vin),null,"A-B-A receipts do not prove ordering");
  receipts = [];
  assert.equal(await readAppFueledQrDestination(db,42,vin),null);
  receipts = ["javascript:alert(1)"];
  assert.equal(await readAppFueledQrDestination(db,42,vin),null);
  receipts = [url];
  const before = reads;
  await assert.rejects(requireAppFueledQrDestination(db,42,vin,async()=>false),{status:403});
  assert.equal(reads,before);
  assert.deepEqual(receipts,[url]);
  assert.equal(await requireAppFueledQrDestination(db,42,vin,async()=>true),url);
  await assert.rejects(requireAppFueledQrDestination(db,42,"bad",async()=>true),{status:409});
  assert.equal(featuresForPlan("detect_dog_founder").appfueled_vhi_qr,false);
  assert.equal(featuresForPlan("professional").appfueled_vhi_qr,false);
});
test("shop choice remains separate, missing data never silently falls back", async () => {
  const deps = {resolveVehicle: async () => vin, canViewVhi: async()=>true, appfueledUrl: async()=>url};
  const shop: any = {stickerConfig:{scanDestination:"appfueled",appointmentUrl:"https://shop.example.com/book"}};
  assert.equal((await resolveStickerScan(shop,42,ref,deps)).url,url);
  assert.deepEqual(await resolveStickerScan(shop,42,ref,{...deps,appfueledUrl:async()=>null}),{kind:"none",url:null});
  assert.deepEqual(await resolveStickerScan(shop,42,null,deps),{kind:"none",url:null});
  assert.equal((await resolveStickerScan({...shop,stickerConfig:{...shop.stickerConfig,scanDestination:"appointment"}},42,ref,{
    ...deps,appfueledUrl:async()=>{throw Error("must not read AppFueled when opted out");},
  })).url,"https://shop.example.com/book");
});
test("both print paths preflight received destination and preserve custom QR precedence", () => {
  for (const file of ["app/api/sticker/generate/route.ts","app/api/extension/sticker/route-handler.ts"]) {
    const text = readFileSync(file,"utf8");
    assert.match(text,/createStickerQrTarget\(db,[^;]+scanDestination\)/);
    assert.match(text,/error instanceof AppFueledQrUnavailable/);
    assert.match(text,/qrSource/);
  }
  assert.doesNotMatch(readFileSync("lib/data/repositories/appfueled-shop-mappings.ts","utf8"),/revokeShopPermanentVhiLinks/);
});
