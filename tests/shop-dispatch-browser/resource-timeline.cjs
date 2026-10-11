const {chromium}=require("../../artifacts/detect-dog-workflow/node_modules/@playwright/test");
const assert=require("node:assert/strict");
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.DEMO_CHROMIUM_PATH,headless:true});
 try {
 const page=await browser.newPage({viewport:{width:1500,height:1100}});
 const errors=[];page.on("pageerror",e=>errors.push(e.message));
 await page.clock.install({time:new Date("2026-10-12T12:00:00Z")});
 await page.goto("http://127.0.0.1:24100/?schedule&resourceTimeline");
 await page.getByTestId("timeline-mode-resource").click();
 await page.getByTestId("timeline-lane-rack").waitFor();
 assert.equal(await page.getByTestId("timeline-lane-rack").locator("[data-job-block]").count(),3);
 await page.getByTestId("timeline-hold-fixture-rack-hold").waitFor();
 for(const id of ["lift-retired","missing-equipment",""]) await page.getByTestId(`timeline-lane-${id}`).waitFor();
 await page.getByTestId("schedule-job-example-12").getByText("Duration unknown",{exact:false}).waitFor();
 await page.getByTestId("schedule-job-job").click();
 assert.equal(await page.getByTestId("timeline-plan-technician-preserved").inputValue(),"Example technician 1");
 await page.getByTestId("timeline-plan-resource").selectOption("lift-east");
 await page.getByTestId("timeline-plan-time").fill("09:00");
 await page.getByTestId("timeline-mode-technician").click();
 await page.getByTestId("timeline-draft-mode").waitFor();
 await page.getByTestId("timeline-mode-resource").click();
 // Observe the exact atomic payload, with synthetic 409 / response-loss faults.
 await page.evaluate(()=>{
  const original=window.fetch;window.requests=[];window.fault="conflict";
  window.fetch=async(input,init)=>{
   if(String(input)==="/api/shop-dispatch"&&init?.method==="POST"){
    const body=JSON.parse(init.body);window.requests.push(body);
    if(window.fault==="conflict"){window.fault="";return Response.json({error:"Synthetic revision conflict"},{status:409});}
    if(window.fault==="lost"){
     const result=await original(input,init);window.confirmed=await result.clone().json();
     window.fault="retry";throw Error("Synthetic response lost");
    }
    if(window.fault==="retry"){window.fault="";return Response.json(window.confirmed);}
   }
   return original(input,init);
  };
 });
 await page.getByTestId("timeline-plan-save").click();
 await page.getByText("Saves are paused after a conflict",{exact:false}).waitFor();
 assert.equal(await page.getByTestId("timeline-plan-resource").inputValue(),"lift-east");
 await page.getByRole("button",{name:"Refresh schedule & find availability",exact:true}).click();
 await page.getByTestId("timeline-plan-review").click();
 await page.evaluate(()=>{window.fault="lost";});
 await page.getByTestId("timeline-plan-save").click();
 await page.getByRole("button",{name:"Retry unconfirmed change",exact:true}).waitFor();
 assert.equal(await page.getByTestId("timeline-plan-resource").isDisabled(),true);
 await page.getByRole("button",{name:"Retry unconfirmed change",exact:true}).click();
 await page.getByTestId("timeline-lane-lift-east").getByTestId("schedule-job-job").waitFor();
 const requests=await page.evaluate(()=>window.requests);
 assert.equal(requests.length,3);
 assert.deepEqual(requests[1],requests[2]);
 assert.equal(requests[1].command.resource,"lift-east");
 assert.equal(requests[1].command.technicianId,"tech");
 assert.equal(requests[1].command.authorized,true);
 assert.deepEqual(requests[1].command.prerequisites,[]);
 assert.equal("bookMinutes" in requests[1].command,false);
 assert.equal(await page.getByTestId("timeline-plan-save").isDisabled(),true);
 await page.getByTestId("timeline-plan-review").click();
 assert.equal(await page.getByTestId("timeline-plan-save").isDisabled(),false);
 // A forbidden resource window fails preview, without another request.
 await page.getByTestId("timeline-plan-resource").selectOption("rack");
 await page.getByTestId("timeline-plan-time").fill("12:00");
 await page.getByTestId("timeline-plan-save").click();
 await page.getByTestId("timeline-error").getByText("conflicts",{exact:false}).waitFor();
 assert.equal(await page.evaluate(()=>window.requests.length),3);
 // Dragging stages a resource draft, never an immediate mutation.
 await page.getByRole("button",{name:"Close details",exact:true}).click();
 await page.getByTestId("timeline-block-example-14").evaluate(el=>{
  const transfer=new DataTransfer();
  el.dispatchEvent(new DragEvent("dragstart",{bubbles:true,dataTransfer:transfer}));
  const lane=document.querySelector('[data-timeline-lane="lift-east"]');
  const rect=lane.getBoundingClientRect();
  lane.dispatchEvent(new DragEvent("drop",{bubbles:true,cancelable:true,dataTransfer:transfer,clientX:rect.left+952,clientY:rect.top+30}));
 });
 assert.equal(await page.getByTestId("timeline-plan-resource").inputValue(),"lift-east");
 assert.equal(await page.getByTestId("timeline-plan-technician-preserved").inputValue(),"Example technician 6");
 assert.equal(await page.evaluate(()=>window.requests.length),3);
 await page.getByRole("button",{name:"Close details",exact:true}).click();
 const handle=page.getByTestId("timeline-resize-job");
 await handle.scrollIntoViewIfNeeded();
 const bounds=await handle.boundingBox();
 await page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);
 await page.mouse.down();
 await page.mouse.move(bounds.x+bounds.width/2+28,bounds.y+bounds.height/2,{steps:5});
 await page.mouse.up();
 assert.equal(await page.getByTestId("timeline-plan-resource").inputValue(),"lift-east");
 assert.equal(await page.getByTestId("timeline-plan-minutes").inputValue(),"75");
 assert.equal(await page.evaluate(()=>window.requests.length),3);
 assert.deepEqual(errors,[]);
 console.log("Resource timeline: retained lanes, holds, unknown duration, mode-safe draft, conflict, uncertain retry and time-off rejection passed.");
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
