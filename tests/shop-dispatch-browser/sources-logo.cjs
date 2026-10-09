const {chromium}=require("../../artifacts/detect-dog-workflow/node_modules/@playwright/test");
const assert=require("node:assert/strict");
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.DEMO_CHROMIUM_PATH,headless:true});
 try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const errors=[];page.on("pageerror",e=>errors.push(e.message));
 await page.goto("http://127.0.0.1:24100/?sources");
 const id=s=>page.getByTestId(s);
 await id("pilot-search").fill("RO #123");
 assert.equal(await page.locator('[data-testid^="visit-protractor:"]').count(),1);
 await id("pilot-manage").click();
 const prefs=id("source-statuses-form");
 for(const box of await prefs.locator('input[name="sourceStatus"]').all())await box.uncheck();
 await prefs.getByLabel("Unassigned",{exact:true}).check();
 await prefs.getByRole("button",{name:"Save source statuses"}).click();
 await prefs.getByRole("status").filter({hasText:"Saved"}).waitFor();
 const intake=id("sync-form");
 await intake.locator('[name="roNumber"]').fill("#125");
 await intake.getByRole("button",{name:"Fetch by RO number"}).click();
 await intake.getByRole("status").filter({hasText:"Saved"}).waitFor();
 await id("pilot-dispatch").click();await id("pilot-search").fill("");
 assert.equal(await page.locator('[data-testid^="visit-protractor:"]').count(),2);
 await page.getByLabel("Show hidden statuses").check();
 assert.equal(await page.locator('[data-testid^="visit-protractor:"]').count(),3);
 await id("pilot-settings").click();
 const logo=await page.evaluate(()=>{
   const c=document.createElement("canvas");c.width=800;c.height=800;
   const ctx=c.getContext("2d"),image=ctx.createImageData(800,800);
   let seed=42;for(let i=0;i<image.data.length;i++){seed=(seed*1664525+1013904223)>>>0;image.data[i]=i%4===3?255:seed>>>24;}
   ctx.putImageData(image,0,0);return c.toDataURL("image/png").split(",")[1];
 });
 const form=id("location-brand-form"),buffer=Buffer.from(logo,"base64");assert(buffer.length>120*1024);
 await form.locator('input[type="file"]').setInputFiles({name:"large-logo.png",mimeType:"image/png",buffer});
 await form.getByRole("button",{name:"Save branding"}).click();
 await page.getByText("Current source: Location override",{exact:false}).waitFor();
 const stored=await id("dispatch-pilot").locator("header img").first().getAttribute("src");
 assert(stored?.startsWith("data:image/"));assert(stored.length<=180000);
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 assert.deepEqual(errors,[]);
 console.log("Offline browser: RO search/intake, status persistence, hidden visit recovery, large-logo resize/save, mobile passed.");
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
