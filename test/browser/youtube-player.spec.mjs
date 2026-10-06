import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {chromium} = require('playwright');
const {createApp} = require('../../server.js');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-video-test-'));
let server, browser;
try {
  await fs.writeFile(path.join(root,'clip.html'), '<!doctype html><body><h1>Research clip</h1><iframe title="Example clip" src="https://www.youtube.com/embed/D8PikZ1KhUo?start=2407&amp;end=2425&amp;token=never-forward"></iframe></body>');
  server = http.createServer(createApp({mappings:{docs:root},editingEnabled:false,rawHtmlEnabled:true,accessConfig:{humanDefault:'full'}}));
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({headless:true});
  for (const viewport of [{width:1280,height:800},{width:390,height:844}]) {
    const page = await browser.newPage({viewport});
    const requests = [];
    await page.route('https://www.youtube.com/**', async route => {
      requests.push({url:route.request().url(), headers:await route.request().allHeaders()});
      await route.fulfill({contentType:'text/html',body:'<!doctype html><title>Fixture provider</title><p>Player fixture</p>'});
    });
    const response = await page.goto(origin + '/view/docs/clip.html?private-value=never-forward');
    assert.equal(response.status(),200);
    const child = page.frameLocator('[data-embedded-html]');
    const link = child.locator('[data-lookie-youtube]');
    await link.waitFor();
    assert.equal(requests.length,0,'provider must not load before a click');
    const embedded = page.frames().find(f=>f.url().includes('/embed/'));
    assert.match((await page.request.get(embedded.url())).headers()['content-security-policy'], /sandbox allow-scripts allow-forms allow-popups/);
    assert.equal(await embedded.evaluate(()=>{try { return !!parent.document; } catch {return false;}}),false);
    await embedded.evaluate(()=>setTimeout(()=>parent.postMessage({type:'lookie-link:open-video',src:'https://www.youtube.com/embed/D8PikZ1KhUo'},'*'),6000));
    await page.waitForTimeout(6200);
    assert.equal(await page.locator('[data-lookie-video-player]').count(),0,'no gesture must not open a player');
    // A gesture is insufficient: only the actual report window and allowed URL count.
    await page.locator('body').click({position:{x:5,y:5}});
    await page.evaluate(()=>window.postMessage({type:'lookie-link:open-video',src:'https://www.youtube.com/embed/D8PikZ1KhUo'},'*'));
    await embedded.evaluate(()=>parent.postMessage({type:'lookie-link:open-video',src:'https://evil.test/embed/D8PikZ1KhUo'},'*'));
    await page.waitForTimeout(100);
    assert.equal(await page.locator('[data-lookie-video-player]').count(),0,'wrong source / malicious URL rejected');
    await link.click();
    const dialog = page.locator('[data-lookie-video-player]');
    await dialog.waitFor({state:'visible'});
    await page.waitForFunction(()=>document.querySelector('[data-lookie-video-player] iframe')?.contentWindow);
    await page.waitForTimeout(150);
    assert.equal(requests.length,1);
    assert.equal(requests[0].headers.referer,origin+'/');
    assert.equal(requests[0].url.includes('never-forward'),false);
    const url = new URL(requests[0].url);
    assert.equal(url.searchParams.get('start'),'2407');
    assert.equal(url.searchParams.get('end'),'2425');
    const box=await dialog.boundingBox();
    assert.ok(box.x>=0 && box.x+box.width<=viewport.width);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.getByRole('button',{name:'Close video',exact:true}).click();
    assert.equal(await dialog.locator('iframe').count(),0);
    await page.waitForTimeout(100);
    assert.equal(await link.evaluate(el=>document.activeElement===el),true,'focus returns to clip');
    await link.click();
    await dialog.waitFor({state:'visible'});
    await page.keyboard.press('Escape');
    await dialog.waitFor({state:'hidden'});
    assert.equal(await dialog.locator('iframe').count(),0);
    await page.close();
  }
  console.log('YouTube viewer: desktop/mobile, gesture, isolation, origin-only referrer, bounds and close PASS');
} finally {
  await browser?.close();
  if(server) await new Promise(resolve=>server.close(resolve));
  await fs.rm(root,{recursive:true,force:true});
}
