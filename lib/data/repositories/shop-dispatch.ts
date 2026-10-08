import { getDb } from "@/lib/data/db";
import { emptyBoard, type Board, type Brand, type Receipt } from "@/lib/shop-dispatch/model";

interface BoardDoc extends Board { _id:string }
export interface EnterpriseBrandDoc {
  _id:string;revision:number;brand:Brand|null;receipts:Receipt[];
  audit:{at:string;actor:string;name:string|null;primary:string|null;accent:string|null;logoDigest:string|null}[];
}
// Single-document CAS: assignments, session events, loaner ownership, audit and
// idempotency receipt commit together. The built-in _id index is sufficient.
export async function readDispatchBoard(shopId:number):Promise<Board>{
  const db=await getDb();
  const document=await db.collection<BoardDoc>("shop_dispatch_pilots").findOne({_id:`shop:${shopId}`},{maxTimeMS:5000});
  if(!document)return emptyBoard();
  const {_id,...board}=document;return board;
}
export async function saveDispatchBoard(shopId:number,expectedRevision:number,board:Board):Promise<boolean>{
  const db=await getDb();const collection=db.collection<BoardDoc>("shop_dispatch_pilots");
  const _id=`shop:${shopId}`;
  if(expectedRevision===0){
    try{await collection.insertOne({_id,...board},{writeConcern:{w:"majority",wtimeoutMS:5000}});return true;}
    catch(error){if((error as {code?:number}).code===11000)return false;throw error;}
  }
  const result=await collection.replaceOne({_id,revision:expectedRevision},board,{writeConcern:{w:"majority",wtimeoutMS:5000}});
  return result.modifiedCount===1;
}
export async function readDispatchEnterpriseBrand(enterpriseId:string):Promise<EnterpriseBrandDoc>{
  const db=await getDb();
  return await db.collection<EnterpriseBrandDoc>("shop_dispatch_enterprise_brands").findOne({_id:enterpriseId},{maxTimeMS:5000})
    ?? {_id:enterpriseId,revision:0,brand:null,receipts:[],audit:[]};
}
export async function saveDispatchEnterpriseBrand(value:EnterpriseBrandDoc,expectedRevision:number):Promise<boolean>{
  const db=await getDb();const collection=db.collection<EnterpriseBrandDoc>("shop_dispatch_enterprise_brands");
  if(expectedRevision===0){
    try{await collection.insertOne(value,{writeConcern:{w:"majority",wtimeoutMS:5000}});return true;}
    catch(error){if((error as {code?:number}).code===11000)return false;throw error;}
  }
  return (await collection.replaceOne({_id:value._id,revision:expectedRevision},value,{writeConcern:{w:"majority",wtimeoutMS:5000}})).modifiedCount===1;
}
