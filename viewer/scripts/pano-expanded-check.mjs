import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const nav=JSON.parse(fs.readFileSync('viewer/public/spaces/wolhajeong/nav.pano.json','utf8'));
const base=process.env.VIEWER_URL||'http://127.0.0.1:5193';
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const errors=[];fs.mkdirSync('output/pano-additional-integration',{recursive:true});
try {
 const context=await browser.newContext({viewport:{width:1440,height:900}});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/listing.html?id=wolhajeong');
 await page.waitForFunction(()=>document.querySelector('#goPano')?.textContent.includes('38곳'));
 await page.locator('#goPano').click();
 await page.waitForFunction(()=>window.pano360?.current?.id==='yard');
 assert.equal(await page.evaluate(()=>pano360.nav.nodes.length),38);
 const seen=new Set(['yard']);
 // Traverse actual links, including backtracking, to check every capture is loadable.
 async function walk(id){
  for(const next of nav.nodes.find(n=>n.id===id).neighbors){
   if(seen.has(next))continue;seen.add(next);
   await page.evaluate(async id=>{await pano360.go(id);},next);
   assert.equal(await page.evaluate(()=>pano360.current.id),next);
   await walk(next);
   await page.evaluate(async id=>{await pano360.go(id);},id);
  }
 }
 await walk('yard');assert.equal(seen.size,38);
 await page.getByRole('button',{name:'메뉴',exact:true}).click();
 await page.getByRole('menuitem',{name:/촬영 지점 38곳/}).click();
 await page.screenshot({path:'output/pano-additional-integration/captures-desktop.png'});
 await page.locator('.capture-picker').getByRole('button',{name:'자쿠지 옆 통로',exact:true}).click();
 await page.waitForFunction(()=>pano360.current.id==='p094'&&!pano360.busy);
 const yaw=await page.evaluate(()=>pano360.look.yaw);
 await page.mouse.move(600,400);await page.mouse.down();await page.mouse.move(850,420,{steps:8});await page.mouse.up();
 assert.notEqual(await page.evaluate(()=>pano360.look.yaw),yaw);
 await page.screenshot({path:'output/pano-additional-integration/jacuzzi-desktop.png'});
 // Click a visible floor hotspot using its calibrated local bearing.
 const dst=await page.evaluate(()=>{const p=pano360,h=p.current.hotspots[0];p.look.set((p.current.imageYawDeg+h.yawDeg)*Math.PI/180,-.4);return {id:h.to,label:p.nav.byId.get(h.to).label};});
 await page.getByRole('button',{name:dst.label+'(으)로 이동',exact:true}).click();
 await page.waitForFunction(id=>pano360.current.id===id&&!pano360.busy,dst.id);
 await context.close();
 const mobile=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 const mp=await mobile.newPage();mp.on('pageerror',e=>errors.push(e.message));
 await mp.goto(base+'/pano.html?space=wolhajeong&node=bedroom');await mp.waitForFunction(()=>window.pano360?.current);
 await mp.getByRole('button',{name:'메뉴',exact:true}).tap();await mp.getByRole('menuitem',{name:/촬영 지점 38곳/}).tap();
 assert.equal(await mp.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await mp.screenshot({path:'output/pano-additional-integration/captures-mobile.png'});
 await mp.locator('.capture-picker').getByRole('button',{name:'욕실 안쪽',exact:true}).tap();
 await mp.waitForFunction(()=>pano360.current.id==='p095'&&!pano360.busy);
 await mobile.close();assert.deepEqual(errors,[]);
 console.log('PASS: listing entry, all 38 captures via connected graph, floor hotspot click, desktop drag, capture picker, mobile tap, no JS errors.');
} finally {await browser.close();}
