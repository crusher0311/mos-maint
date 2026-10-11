/* Runs only against the already-running, synthetic/intercepted offline fixture. */
const {chromium}=require("../../artifacts/detect-dog-workflow/node_modules/@playwright/test");
const assert=require("node:assert/strict");
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.DEMO_CHROMIUM_PATH,headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1480,height:1100}});
  const errors=[];page.on("pageerror",e=>errors.push(e.message));
  await page.clock.install({time:new Date("2026-10-12T12:00:00Z")});
  await page.goto("http://127.0.0.1:24100/?schedule&usability",{waitUntil:"domcontentloaded",timeout:90000});
  await page.getByTestId("timeline-lane-tech").waitFor();
  await page.evaluate(()=>{
   const original=window.fetch;window.testWrites=[];window.testFault="";
   window.fetch=async(input,init)=>{
    if(String(input)==="/api/shop-dispatch"&&init?.method==="POST"){
     window.testWrites.push(JSON.parse(init.body));
     if(window.testFault==="network")throw Error("Synthetic disconnected transport");
     if(window.testFault==="server")return Response.json({error:"Synthetic unavailable"},{status:503});
    }
    return original(input,init);
   };
  });
  async function drop(job,lane,minute,queue=false){
   await page.getByTestId(`${queue?"timeline-queue":"timeline-block"}-${job}`).evaluate((el,{lane,minute})=>{
    const transfer=new DataTransfer();el.dispatchEvent(new DragEvent("dragstart",{bubbles:true,dataTransfer:transfer}));
    const target=document.querySelector(`[data-timeline-lane="${lane}"]`),rect=target.getBoundingClientRect();
    target.dispatchEvent(new DragEvent("drop",{bubbles:true,cancelable:true,dataTransfer:transfer,clientX:rect.left+(minute-450)*112/60,clientY:rect.top+30}));
   },{lane,minute});
  }
  await drop("job","tech",540);
  await page.getByTestId("schedule-save-status").waitFor();
  assert.equal(await page.getByTestId("timeline-details").count(),0,"routine drop does not open review");
  assert.equal(await page.evaluate(()=>window.testWrites.length),1);
  assert.equal((await page.evaluate(()=>window.testWrites[0])).command.authorized,true);
  await page.getByTestId("schedule-undo").click();
  await page.waitForFunction(()=>window.testWrites.length===2);
  await page.getByTestId("schedule-save-status").waitFor();
  assert.equal(await page.getByTestId("schedule-undo").count(),0,"Undo resolves after server confirmation");
  await page.getByTestId("schedule-job-job").click();
  assert.equal(await page.getByTestId("timeline-experience-warning").count(),0,"same-tech time edit has no experience warning");
  const drawer=await page.getByTestId("timeline-details").boundingBox();
  assert.ok(drawer.x>800 && drawer.y===0,"details are a right-side drawer");
  await page.keyboard.press("Escape");
  assert.equal(await page.getByTestId("timeline-details").count(),0);
  await page.evaluate(()=>{window.testFault="network";});
  await drop("job","tech",540);
  await page.getByTestId("schedule-retry").waitFor();
  assert.equal(await page.getByTestId("schedule-date").isDisabled(),true,"uncertain autosave locks date navigation");
  assert.equal(await page.getByTestId("timeline-mode-resource").isDisabled(),true);
  const request=await page.evaluate(()=>window.testWrites.at(-1));
  await page.evaluate(()=>{window.testFault="server";});
  await page.getByTestId("schedule-retry").click();
  assert.deepEqual(await page.evaluate(()=>window.testWrites.at(-1)),request);
  await page.evaluate(()=>{window.testFault="";});
  await page.getByTestId("schedule-retry").click();
  await page.getByTestId("schedule-undo").waitFor();
  assert.deepEqual(await page.evaluate(()=>window.testWrites.at(-1)),request);
  await page.getByRole("button",{name:"Close details",exact:true}).click();
  await page.getByTestId("timeline-queue-group-notes").waitFor();
  await page.getByTestId("timeline-queue-group-waiting").waitFor();
  await drop("example-16","tech-2",900,true);
  await page.getByTestId("timeline-experience-warning").waitFor();
  const count=await page.evaluate(()=>window.testWrites.length);
  await page.getByTestId("timeline-plan-save").click();
  assert.equal(await page.evaluate(()=>window.testWrites.length),count,"unfamiliar assignment cannot save without confirmation");
  await page.getByTestId("timeline-experience-confirm").check();
  await page.getByTestId("timeline-plan-technician").selectOption("tech-3");
  assert.equal(await page.getByTestId("timeline-experience-confirm").isChecked(),false,"confirmation resets when owner changes");
  await page.getByTestId("timeline-experience-confirm").check();
  await page.getByTestId("timeline-plan-save").click();
  await page.waitForFunction(n=>window.testWrites.length===n+1,count);
  await page.getByTestId("schedule-save-status").waitFor();
  await page.getByRole("button",{name:"Close details",exact:true}).click();
  await page.getByTestId("schedule-date").fill("2026-10-18");
  await page.getByTestId("timeline-closed-day").waitFor();
  assert.equal(await page.getByTestId("timeline-lane-tech").count(),0);
  await page.getByTestId("timeline-next-working-day").click();
  assert.equal(await page.getByTestId("schedule-date").inputValue(),"2026-10-19");
  await page.setViewportSize({width:390,height:844});
  await page.getByTestId("timeline-search").fill("Fictional Test Vehicle");
  assert.deepEqual(errors,[]);
  console.log("Offline usability browser passed: autosave, undo, exact retry, global locks, advisory confirmation, drawer, queue groups and closed day.");
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
