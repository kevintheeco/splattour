import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const browser = await chromium.launch({executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
 const page = await browser.newPage({viewport:{width:1280,height:900}});
 const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 const assets=[]; page.on('response',r=>{if(r.url().includes('wolhajeong-anchae-warm-600'))assets.push([r.status(),r.url()]);});
 const url='https://3dgstour.com/tour.html?scene=wolhajeong-anchae-warm-600&from=cloud&quality=mobile&onboarding=0';
 await page.goto(url);
 await page.waitForFunction(()=>window.splattour,null,{timeout:180000});
 await page.waitForTimeout(1500);
 const result=await page.evaluate(()=>({title:splattour.tour.title,count:splattour.splat.numSplats,source:splattour.tour.splatUrl}));
 assert.equal(result.count,1500000);
 assert.ok(result.source.includes('wolhajeong-anchae-warm-600'));
 assert.deepEqual(errors,[]);
 await fs.mkdir('output/anchae-link-review', {recursive:true});
 await page.screenshot({path:'output/anchae-link-review/remote-live.png'});
 console.log(JSON.stringify({url,...result,assets,errors},null,2));
} finally {await browser.close();}
