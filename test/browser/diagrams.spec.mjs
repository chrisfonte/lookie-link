import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {test} from 'node:test';
const require = createRequire(import.meta.url);
const {chromium} = require('playwright');
const {createApp} = require('../../server');
const {renderPreviewHtml} = require('../../lib/renderer');
const {JSDOM} = require('jsdom');
const kit = path.resolve('kits/ops');

// getBBox() is text-local: map all four corners into the root SVG's coordinates.
// This covers translated/rotated ancestors and non-zero viewBox origins.
function diagramLabelBounds() {
  return [...document.querySelectorAll('.dg-canvas')].map(svg => {
    const v = svg.viewBox.baseVal;
    return [...svg.querySelectorAll('text')].every(text => {
      const b = text.getBBox();
      const matrix = svg.getScreenCTM().inverse().multiply(text.getScreenCTM());
      return [[b.x,b.y],[b.x+b.width,b.y],[b.x,b.y+b.height],[b.x+b.width,b.y+b.height]]
        .every(([x,y]) => {
          const p = new DOMPoint(x,y).matrixTransform(matrix);
          return p.x >= v.x && p.y >= v.y && p.x <= v.x+v.width && p.y <= v.y+v.height;
        });
    });
  });
}

test('annotated diagrams survive publishing and sanitization at desktop and phone widths', {timeout: 90000}, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lookie-diagrams-'));
  const app = createApp({mappings: {kit}, accessConfig: {humanDefault: 'full'}, rawHtmlEnabled:true,
    publishConfig: {areaPath: path.join(temp, 'published')},
    kitsConfig: {enabled: true, managedFolder: path.join(temp, 'kits')}});
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({headless:true});
    const files = ['diagram-examples.html', 'EXAMPLES.html', 'README.md', 'theme-follow-demo.html'].map(file => ({path:file, content:fs.readFileSync(path.join(kit,file),'utf8')}));

    // Exercise the separate sanitized document path, including a handler/script canary.
    const sanitized = renderPreviewHtml({repo:'kit',repoRoot:kit,relativePath:'diagram-examples.html',
      source:files[0].content.replace('</body>', '<script>window.diagramCanary=1</script><svg onload="window.diagramCanary=2"></svg></body>')});
    const doc = new JSDOM(sanitized).window.document;
    assert.equal(doc.querySelectorAll('script,[onload]').length,0);
    for(const svg of doc.querySelectorAll('.dg-canvas')) {
      assert.ok(svg.getAttribute('viewBox'));
      for(const id of svg.getAttribute('aria-labelledby').split(' ')) assert.ok(doc.getElementById(id)?.textContent);
      assert.ok(svg.querySelectorAll('text').length>=6);
    }
    assert.equal(doc.querySelectorAll('.dg-canvas').length,2);
    const published = await fetch(base+'/api/publish', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({slug:'diagram-test', kit:'ops', entryPath:'diagram-examples.html', files})});
    assert.equal(published.status,201);
    const route = '/published/diagram-test/diagram-examples.html';
    const report = await (await fetch(base+'/view'+route+'?validate=1')).json();
    assert.deepEqual(report.kit.warnings, []);
    assert.deepEqual(report.pageContract.warnings, []);
    assert.equal(report.summary.missingLocalAssetCount,0);
    assert.equal(report.summary.missingNavigationTargetCount,0);
    const page = await browser.newPage();
    for(const width of [1280,390]) for(const mode of ['light','dark']) {
      await page.setViewportSize({width,height:900});
      await page.goto(base+'/embed'+route+`?lookie-theme=${mode}&lookie-scheme=github`,{waitUntil:'load'});
      const metrics = await page.evaluate(() => {
        const root = document.documentElement;
        return {overflow:root.scrollWidth>root.clientWidth,
          canary:window.diagramCanary,
          handlers:document.querySelectorAll('[onload]').length,
          canvases:[...document.querySelectorAll('.dg-canvas')].map(svg=>({
            refs:svg.getAttribute('aria-labelledby').split(' ').map(id=>!!document.getElementById(id)?.textContent.trim()),
            labels:svg.querySelectorAll('text').length, paths:svg.querySelectorAll('path').length,
            width:svg.getBoundingClientRect().width,
            labelColor:getComputedStyle(svg.querySelector('.dg-label')).fill})),
          arrows:[...document.querySelectorAll('.farrow svg')].map(s=>s.getBoundingClientRect().width),
          regions:[...document.querySelectorAll('.dg-scroll')].map(s=>({focus:s.tabIndex,role:s.getAttribute('role'),scroll:s.scrollWidth>s.clientWidth})),
          flow:getComputedStyle(document.querySelector('.dg-flow-stack')).flexDirection};
      });
      assert.equal(metrics.overflow,false,JSON.stringify(metrics));
      assert.equal(metrics.canary,undefined);
      assert.equal(metrics.handlers,0);
      assert.equal(metrics.canvases.length,2);
      for(const c of metrics.canvases) {assert.deepEqual(c.refs,[true,true]);assert.ok(c.labels>=6);assert.ok(c.paths>=2);assert.ok(c.width>=640);}
      assert.deepEqual(await page.evaluate(diagramLabelBounds),[true,true]);
      // Negative geometry canary: a locally valid label translated off-canvas must fail.
      const translated = page.locator('.dg-canvas g[transform]').first();
      const originalTransform = await translated.getAttribute('transform');
      const label = translated.locator('text');
      const originalPosition = await label.evaluate(el=>[el.getAttribute('x'),el.getAttribute('y')]);
      await label.evaluate(el=>{el.setAttribute('x','30');el.setAttribute('y','30');});
      assert.equal(await label.evaluate(el=>{
        const b=el.getBBox(),v=el.ownerSVGElement.viewBox.baseVal;
        return b.x>=v.x && b.y>=v.y && b.x+b.width<=v.x+v.width && b.y+b.height<=v.y+v.height;
      }),true,'the old local-only check would accept this label');
      await translated.evaluate(el=>el.setAttribute('transform','translate(2000 2000)'));
      assert.deepEqual(await page.evaluate(diagramLabelBounds),[true,false]);
      await translated.evaluate((el,value)=>el.setAttribute('transform',value),originalTransform);
      await label.evaluate((el,[x,y])=>{el.setAttribute('x',x);el.setAttribute('y',y);},originalPosition);
      assert.deepEqual(metrics.arrows,[24,24]);
      assert.equal(metrics.flow,width===390?'column':'row');
      for(const region of metrics.regions) {assert.equal(region.focus,0);assert.equal(region.role,'region');assert.equal(region.scroll,width===390);}
      if(width===390) {
        await page.locator('.dg-scroll').first().focus();
        await page.keyboard.press('ArrowRight');
        await page.waitForTimeout(200);
        assert.ok(await page.locator('.dg-scroll').first().evaluate(el=>el.scrollLeft)>0,'keyboard must move diagram');
      }
      await page.evaluate(()=>{document.documentElement.style.scrollBehavior='auto';window.scrollTo(0,900);});
      assert.ok(Math.abs(await page.locator('.topnav').evaluate(el=>el.getBoundingClientRect().top))<2,'navigation stays pinned');
      // Negative containment check: the assertion above must notice an escaped wide canvas.
      if(width===390) {
        await page.addStyleTag({content:'.dg-scroll{overflow:visible!important}'});
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth),true);
      }
    }
    // Existing consumer: the full component showcase still fits at phone width.
    await page.goto(base+'/embed/published/diagram-test/EXAMPLES.html');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth),false);
    assert.deepEqual(await page.locator('.farrow svg').evaluateAll(els=>els.map(el=>el.getBoundingClientRect().width)),[24,24]);
  } finally {
    if(browser) await browser.close();
    await new Promise(resolve=>server.close(resolve));
    fs.rmSync(temp,{recursive:true,force:true});
  }
});
