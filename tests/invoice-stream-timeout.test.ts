import assert from "node:assert/strict";
import { invoiceStreamTimeout } from "../lib/invoice-stream-timeout";
async function main(){
  const calls:number[]=[];
  const timeout=invoiceStreamTimeout(async ms=>{calls.push(ms);});
  for(const remaining of [45000,44900,30000,5000,4999,4500,3999,999,500])
    await timeout(remaining);
  assert.deepEqual(calls,[5000,4000,3000,1]);
  // New transaction must install settings even if prior transaction cached them.
  await invoiceStreamTimeout(async ms=>{calls.push(ms);})(45000);
  assert.equal(calls.at(-1),5000);
  const capped:number[]=[];
  const lower=invoiceStreamTimeout(async ms=>{capped.push(ms);},500);
  await lower(45000);await lower(40000);await lower(250);
  assert.deepEqual(capped,[500,1]);
  let attempts=0;
  const failure=invoiceStreamTimeout(async()=>{if(++attempts===1)throw Error("SET failed");});
  await assert.rejects(failure(45000),/SET failed/);
  await failure(45000);
  assert.equal(attempts,2,"failed settings must never be cached");
  console.log("PASS: transaction-local timeout cache, shrinking deadline, lower cap, failed SET");
}
main().catch(e=>{console.error(e);process.exitCode=1;});
