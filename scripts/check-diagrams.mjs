#!/usr/bin/env node
// Check annotated diagrams on a served page at desktop and phone widths, light and dark.
// Reports labels outside the canvas, overlapping labels or markers, marker/key mismatches,
// unreadably small text, low label contrast and page overflow; saves one screenshot per
// diagram card so the result can be looked at, not just measured.
//
//   node scripts/check-diagrams.mjs <url> [--out <dir>] [--widths 1280,390] [--min-text 10]
//
// <url> may be a Lookie /view or /embed address, or any page that uses svg.dg-canvas.
// Exit code 1 means at least one failure. Notices never fail the run.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {chromium} = require('playwright');
const {inspectDiagrams, diagramProblems} = require('../lib/diagram-checks');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args.splice(at, 2)[1];
};
const out = option('--out', null);
const widths = option('--widths', '1280,390').split(',').map(Number);
const minTextPx = Number(option('--min-text', '10'));
const url = args[0];
if (!url || widths.some((width) => !width)) {
  console.error('usage: node scripts/check-diagrams.mjs <url> [--out <dir>] [--widths 1280,390] [--min-text 10]');
  process.exit(2);
}
if (out) fs.mkdirSync(out, {recursive: true});

const browser = await chromium.launch({headless: true});
const runs = [];
let failed = false;
try {
  for (const width of widths) for (const mode of ['light', 'dark']) {
    const context = await browser.newContext({viewport: {width, height: 1000}});
    await context.addInitScript((theme) => {
      localStorage.setItem('lookie-link-color-scheme', 'github');
      localStorage.setItem('lookie-link-theme', theme);
    }, mode);
    const page = await context.newPage();
    const target = new URL(url);
    if (target.pathname.startsWith('/embed/')) {
      target.searchParams.set('lookie-theme', mode);
      target.searchParams.set('lookie-scheme', 'github');
    }
    await page.goto(target.href, {waitUntil: 'load'});
    await page.waitForTimeout(600);
    // On /view the artifact is a child frame; measuring the shell would pass vacuously.
    const frame = page.frames().find((f) => f !== page.mainFrame() && f.url().includes('/embed/')) || page.mainFrame();
    const found = await frame.locator('svg.dg-canvas').count();
    if (!found) {
      failed = true;
      runs.push({width, mode, failures: ['no svg.dg-canvas found on the page'], notices: [], figures: []});
      await context.close();
      continue;
    }
    const report = await frame.evaluate(inspectDiagrams);
    const {failures, notices} = diagramProblems(report, {minTextPx});
    if (failures.length) failed = true;
    if (out) {
      await frame.evaluate(() => { document.documentElement.style.scrollBehavior = 'auto'; });
      const cards = frame.locator('.dg:has(svg.dg-canvas)');
      for (let i = 0; i < await cards.count(); i += 1) {
        await cards.nth(i).scrollIntoViewIfNeeded();
        await page.waitForTimeout(150);
        await cards.nth(i).screenshot({path: path.join(out, `diagram-${i + 1}-${mode}-${width}.png`)});
      }
    }
    runs.push({width, mode, failures, notices, ...report});
    await context.close();
  }
} finally {
  await browser.close();
}
if (out) fs.writeFileSync(path.join(out, 'diagram-check.json'), `${JSON.stringify(runs, null, 2)}\n`);
for (const run of runs) {
  const tag = `${run.width}px ${run.mode}`;
  for (const failure of run.failures) console.log(`FAIL  ${tag}  ${failure}`);
  for (const notice of run.notices) console.log(`note  ${tag}  ${notice}`);
}
console.log(failed ? 'FAIL' : `PASS  ${runs.length} renders, ${runs[0].figures.length} diagram(s) each`);
process.exit(failed ? 1 : 0);
