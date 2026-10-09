const {chromium}=require("../../artifacts/detect-dog-workflow/node_modules/@playwright/test");
const assert=require("node:assert/strict");
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.DEMO_CHROMIUM_PATH,headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const errors=[]; page.on("pageerror",e=>errors.push(e.message));
 page.on("dialog",d=>d.accept());
 const colors=[];
 for(const variant of ["colorful","pale","mono"]){
  await page.goto(`http://127.0.0.1:24100/?logo=${variant}&warnings=1`);
  const warning=page.getByText("Warning: a package was removed upstream. Manager review required.");
  await warning.waitFor();
  assert.equal(await warning.evaluate(el=>getComputedStyle(el).color),"rgb(155, 62, 36)");
  await page.screenshot({path:`/tmp/workflow-warnings-${variant}.png`,fullPage:true});
  await page.getByTestId("pilot-settings").click();
  await page.getByText("Current source: Shared shop branding",{exact:false}).waitFor();
  assert.equal(await page.locator('a[href="/dashboard/settings/branding"]').count(),1);
  const form=page.getByTestId("location-brand-form");
  assert.equal(await form.getByRole("button",{name:"Remove logo from draft"}).isDisabled(),true);
  colors.push(await page.getByTestId("dispatch-pilot").evaluate(el=>getComputedStyle(el).getPropertyValue("--primary").trim()));
  await page.screenshot({path:`/tmp/workflow-brand-${variant}.png`,fullPage:true});
  await form.getByRole("button",{name:"Save branding"}).click();
  await page.getByText("Current source: Location override",{exact:false}).waitFor();
  await page.reload();
  await page.getByTestId("pilot-settings").click();
  // Fixture state resets on reload; real persistence is covered by offline API tests.
  await form.getByRole("button",{name:"Save branding"}).click();
  await page.getByText("Current source: Location override",{exact:false}).waitFor();
  await page.getByRole("button",{name:"Restore automatic shop branding"}).click();
  await page.getByText("Current source: Shared shop branding",{exact:false}).waitFor();
 }
 assert.equal(new Set(colors).size,3);
 assert.deepEqual(errors,[]);
 await browser.close();
 console.log("Shared branding visual fixtures and manual/automatic controls passed for colorful, pale and monochrome logos.");
})().catch(e=>{console.error(e);process.exit(1);});
