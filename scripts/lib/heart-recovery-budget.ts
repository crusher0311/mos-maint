/** Wait only for real background capacity. Never turn fail-open into permission. */
export async function waitForRecoverySlot(
  acquire:()=>Promise<{acquired:boolean;fallback?:boolean;timedOut?:boolean}>,
  sleep:(ms:number)=>Promise<void> = ms=>new Promise(r=>setTimeout(r,ms)),
  now:()=>number = Date.now,
) {
  const deadline=now()+120_000;
  do {
    const slot=await acquire();
    if(slot.fallback || slot.acquired&&slot.timedOut)throw new Error("Shared budget unavailable; refusing fail-open");
    if(slot.acquired)return;
    if(now()>=deadline)break;
    await sleep(1000);
  }while(now()<deadline);
  throw new Error("Shared budget busy for two minutes; stopped before provider request");
}

/** Uses the existing bucket and TTL index, without authorizing index creation. */
export async function existingBudgetDatabase(db:any) {
  const col=db.collection("tekmetric_rate_buckets");
  const indexes=await col.listIndexes().toArray();
  const ttl=indexes.find((i:any)=>i.expireAfterSeconds===0&&Object.keys(i.key).length===1&&i.key.expiresAt===1);
  if(!ttl)throw new Error("Shared budget TTL index missing; installation is not authorized");
  return {
    collection:(name:string)=>{
      if(name!=="tekmetric_rate_buckets")throw new Error("Shared budget collection mismatch");
      return {
        createIndex:async()=>ttl.name,
        findOneAndUpdate:col.findOneAndUpdate.bind(col),
        updateOne:col.updateOne.bind(col),
      };
    },
  };
}
