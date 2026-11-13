const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { createServer } = require('../scripts/serve.cjs');
const keys = ['black-mask-1','the-multitude-1','cipher-1','the-kabbalist-1','harlem-heroes-1'];
(async()=>{
 const server=createServer(); await new Promise(r=>server.listen(4174,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||'chrome'});
 try {
 const context=await browser.newContext(); const page=await context.newPage(); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 await context.route('https://accounts.google.com/**',r=>r.abort());
 await page.goto('http://127.0.0.1:4174/comics.html'); assert.equal(await page.locator('.read-free').count(),5);
 for(const key of keys){
 await page.goto('http://127.0.0.1:4174/freecomicreader/?issue='+key);
 await page.waitForFunction(()=>document.querySelector('#rCount').textContent==='1 / 25'&&document.querySelector('#spin').hidden,{},{timeout:60000});
 for(let n=1;n<=25;n++){
 await page.locator('#slider').evaluate((e,n)=>{e.value=n;e.dispatchEvent(new Event('input',{bubbles:true}));},n);
 await page.waitForFunction(n=>document.querySelector('#rCount').textContent===n+' / 25'&&document.querySelector('#spin').hidden&&document.querySelector('#pageSurface img')?.naturalWidth>0,n);
 }
 await page.locator('#backBtn').click(); await page.waitForFunction(()=>document.querySelector('#reader').hidden);
 await page.getByRole('button',{name:/^Read /}).last().click(); await page.waitForFunction(()=>!document.querySelector('#reader').hidden);
 console.log('PASS '+key+': all 25 pages and reopen');
 }
 await page.setViewportSize({width:390,height:844}); await page.goto('http://127.0.0.1:4174/freecomicreader/?issue=black-mask-1');
 await page.waitForFunction(()=>!document.querySelector('#reader').hidden);
 await page.waitForFunction(()=>document.querySelector('#spin').hidden&&document.querySelector('#pageSurface img')?.naturalWidth>0); await page.screenshot({path:'test-results/free-issue-mobile.png'});
 await page.locator('#backBtn').click(); await page.goto('http://127.0.0.1:4174/comics.html'); await page.locator('img').evaluateAll(async images=>{for(const image of images){image.loading='eager'; await image.decode();}}); await page.screenshot({path:'test-results/comics-mobile.png',fullPage:true});
 await context.setOffline(true); await page.goto('http://127.0.0.1:4174/freecomicreader/?issue=black-mask-1'); await page.waitForFunction(()=>!document.querySelector('#reader').hidden); await context.setOffline(false); console.log('PASS featured issue offline reload');
 await page.goto('http://127.0.0.1:4174/freecomicreader/?issue=not-approved'); await page.getByText('This free issue is not available.',{exact:false}).waitFor();
 assert.deepEqual(errors,[]); console.log('PASS mobile layout, invalid issue, no page errors');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
