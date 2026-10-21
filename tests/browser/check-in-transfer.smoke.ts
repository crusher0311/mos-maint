import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import puppeteer from "puppeteer-core";
async function main(){
  const browser=await puppeteer.launch({executablePath:execFileSync("which",["chromium"],{encoding:"utf8"}).trim(),headless:true,args:["--no-sandbox","--disable-dev-shm-usage"]});
  try{
    const page=await browser.newPage(),errors:string[]=[];
    page.on("pageerror",error=>errors.push(String(error)));
    await page.setViewport({width:390,height:844});
    await page.goto("http://127.0.0.1:5000/transfer");
    await page.waitForSelector('input[type="email"]');
    await page.type('input[type="email"]',"recipient@example.invalid");
    async function click(text:string){
      await page.evaluate(text=>{const button=[...document.querySelectorAll("button")].find(b=>b.textContent?.includes(text));
        if(!button)throw Error(`Missing button: ${text}`);button.click();},text);
    }
    await click("Check coworker access");
    await page.waitForFunction(()=>document.body.innerText.includes("Selected advisor:"));
    await click("Save and offer transfer");
    await page.waitForFunction(()=>document.body.innerText.includes("Editing is paused"));
    await click("Cancel transfer");
    await page.waitForFunction(()=>!document.body.innerText.includes("Editing is paused"));
    await click("Save and offer transfer");
    await page.waitForFunction(()=>document.body.innerText.includes("Editing is paused"));
    await click("Refresh incoming transfers");
    await page.waitForFunction(()=>document.body.innerText.includes("Accept ownership and open"));
    await click("Accept ownership and open");
    await page.waitForFunction(()=>document.body.innerText.includes("Accepted ownership. Original check-in identity:"));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
    assert.deepEqual(errors,[]);
    console.log("PASS mobile coworker selection → offer → cancel → re-offer → explicit accept; no browser errors");
  }finally{await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
