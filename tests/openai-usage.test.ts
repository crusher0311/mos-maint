import test from "node:test";
import assert from "node:assert/strict";
import OpenAI from "openai";
import { boundedUsageWriter, usageRecord, summarizeAiUsage, trackedAiFetch, wasAutomaticallyTracked } from "../lib/openai-usage";
test("prices actual chat and Responses usage, cached tokens and dated models", () => {
  const a = usageRecord({feature:"test"}, "gpt-4o-mini", {usage:{prompt_tokens:1000,completion_tokens:100,prompt_tokens_details:{cached_tokens:500}}},200,1);
  assert.equal(a.estimatedCostUsd, 0.0001725);
  const b=usageRecord({feature:"test"},"unused",{model:"gpt-4.1-2025-04-14",usage:{input_tokens:1000,output_tokens:100,input_tokens_details:{cached_tokens:500}}},200,1);
  assert.equal(b.totalTokens,1100); assert.equal(b.estimatedCostUsd,0.00205);
});
test("unknown model, missing usage and integration billing remain explicitly unpriced",()=>{
  for(const r of [
    usageRecord({feature:"t"},"unknown",{usage:{prompt_tokens:10,completion_tokens:2}},200,1),
    usageRecord({feature:"t"},"gpt-4o-mini",{},200,1),
    usageRecord({feature:"t",source:"replit"},"gpt-4o-mini",{usage:{prompt_tokens:10,completion_tokens:2}},200,1),
  ]) assert.equal(r.estimatedCostUsd,null);
});
test("transport preserves response and records each attempt without sensitive payloads",async()=>{
  const records:any[]=[]; let calls=0;
  const f=trackedAiFetch({feature:"feature",shopId:12},async r=>{records.push(r)},async()=>{
    calls++;return Response.json(calls===1 ? {error:{message:"private"}} :
      {id:"chat-test",model:"gpt-4o-mini",choices:[{message:{content:"private"}}],usage:{prompt_tokens:2,completion_tokens:1}},
      {status:calls===1?429:200,headers:{"x-request-id":"test-request"}});
  });
  const init={method:"POST",body:JSON.stringify({model:"gpt-4o-mini",messages:[{content:"private"}]})};
  assert.equal((await f("https://example.test",init)).status,429);
  assert.equal((await (await f("https://example.test",init)).json()).id,"chat-test");
  assert.equal(records.length,2);assert.equal(records[0].isRateLimited,true);
  assert.equal(wasAutomaticallyTracked("chat-test"),true);
  assert.equal(JSON.stringify(records).includes("private"),false);
  assert.equal(records[1].shopId,12);
});
test("transport errors and storage failures do not hide provider outcome",async()=>{
  const records:any[]=[];const error=new Error("private network detail");
  await assert.rejects(trackedAiFetch({feature:"t"},async r=>{records.push(r)},async()=>{throw error})("https://example.test"),e=>e===error);
  assert.equal(records[0].statusCode,599);assert.equal(JSON.stringify(records).includes("private"),false);
  const f=trackedAiFetch({feature:"t"},async()=>{throw Error("private")},async()=>Response.json({id:"safe"}));
  assert.equal((await f("https://example.test")).status,200);
});
test("legacy and partial records produce honest coverage counts",()=>{
  const out=summarizeAiUsage([{timestamp:new Date(),endpoint:"old",totalTokens:10},
    usageRecord({feature:"new",shopId:1},"gpt-4o-mini",{usage:{prompt_tokens:10,completion_tokens:2}},200,1)]);
  assert.equal(out.totals.requests,2);assert.equal(out.totals.legacyRequests,1);
  assert.equal(out.totals.unpricedRequests,1);assert.equal(out.totals.unknownUsageRequests,1);
});
test("real SDK fetch captures retry attempts and response ID for legacy deduplication", async()=>{
  const rows:any[]=[];
  const client=new OpenAI({apiKey:"offline-test-only",maxRetries:1,
    fetch:trackedAiFetch({feature:"sdk",shopId:7},async r=>{rows.push(r)},async()=>{
      return rows.length===0
        ? Response.json({error:{message:"retry",type:"rate_limit_error"}},{status:429,headers:{"retry-after-ms":"1"}})
        : Response.json({id:"chat-sdk",object:"chat.completion",created:1,model:"gpt-4o-mini",
          choices:[{index:0,message:{role:"assistant",content:"ok"},finish_reason:"stop"}],
          usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}});
    })});
  const response=await client.chat.completions.create({model:"gpt-4o-mini",messages:[{role:"user",content:"private"}]});
  assert.equal(response.choices[0].message.content,"ok");assert.equal(rows.length,2);
  assert.equal(rows[0].model,"gpt-4o-mini");assert.equal(rows[1].estimatedCostUsd,0.0000027);
  assert.ok(wasAutomaticallyTracked(response.id));
});
test("slow accounting is bounded and keeps slots until real writes finish",async()=>{
  let release!:()=>void;let writes=0;
  const pending=new Promise<void>(r=>{release=r});
  const writer=boundedUsageWriter(async()=>{writes++;await pending},5,1);
  await assert.rejects(writer({}),/timed out/);
  await assert.rejects(writer({}),/capacity/);
  assert.equal(writes,1);
  release();await new Promise(r=>setTimeout(r,0));
  await writer({});assert.equal(writes,2);
});
