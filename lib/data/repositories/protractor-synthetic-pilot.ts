/** Persistence for the explicitly approved shop-66 synthetic CLI pilot only. */
import assert from "node:assert/strict";
import type {UpdateOptions, InsertOneOptions} from "mongodb";
import {getDb,getMongoClient} from "../../mongo";
function marker(id:unknown){
  assert.equal(typeof id,"string");
  assert.match(id as string,/^synthetic-pilot:[0-9a-f-]{36}$/i);
}
export async function findSyntheticPilotShop(){
  return (await getDb()).collection("shops").findOne({shopId:66},
    {projection:{name:1,integrationProvider:1},maxTimeMS:3000});
}
export async function findSyntheticPilotMarker(id:string){
  marker(id);
  return (await getDb()).collection<any>("auto_dvi_durable_v1").findOne({_id:id});
}
export async function updateSyntheticPilotMarker(filter:any,update:any,options?:UpdateOptions){
  marker(filter?._id);
  return (await getDb()).collection<any>("auto_dvi_durable_v1").updateOne(filter,update,options);
}
export async function insertSyntheticPilotMarker(doc:any,options?:InsertOneOptions){
  marker(doc?._id);assert.equal(doc.shopId,66);assert.equal(doc.kind,"operator-synthetic-pilot");
  return (await getDb()).collection<any>("auto_dvi_durable_v1").insertOne(doc,options);
}
export async function closeSyntheticPilotConnection(){
  await (await getMongoClient()).close();
}
