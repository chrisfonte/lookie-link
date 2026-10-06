#!/usr/bin/env node
// Check annotated diagrams on a served page at desktop and phone widths, light and dark.
// Reports labels outside the canvas, overlapping labels or markers, marker/key mismatches,
// unreadably small text, low label contrast and page overflow; saves one screenshot per
// diagram card so the result can be looked at, not just measured.
//
//   node scripts/check-diagrams.mjs <url> [--out <dir>] [--widths 1280,390] [--min-text 10]
//
// <url> may be a Lookie /view or /embed address, or any page that uses svg.dg-canvas.
// On /view the first /embed/ child frame is measured.
// Exit 0 pass, 1 at least one failure, 2 usage error. Notices never fail the run.
// Needs the repository's development dependencies (Playwright).
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {chromium} = require('playwright');
const {inspectDiagrams, diagramProblems} = require('../lib/diagram-checks');

const usage = (reason) => {
  console.error(`check-diagrams: ${reason}`);
  console.error('usage: node scripts/check-diagrams.mjs <url> [--out <dir>] [--widths 1280,390] [--min-text 10]');
  process.exit(2);
};
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  if (at === -1) return fallback;
  const value = args.splice(at, 2)[1];
  if (value === undefined || value.startsWith('--')) usage(`${name} needs a value`);
  return value;
};
const out = option('--out', null);
const widths = option('--widths', '1280,390').split(',').map(Number);
const minTextPx = Number(option('--min-text', '10'));
if (args.length !== 1 || args[0].startsWith('--')) usage('give exactly one URL');
if (widths.some((width) => !Number.isInteger(width) || width < 200)) usage('--widths takes whole pixel widths of 200 or more');
if (!Number.isFinite(minTextPx) || minTextPx <= 0) usage('--min-text takes a positive number');
let url;
try {
  url = new URL(args[0]).href;
} catch {
  usage(`not a URL: ${args[0]}`);
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
    let report;
    try {
      report = await frame.evaluate(inspectDiagrams);
    } catch (error) {
      // An unexpected page shape is a failed check, never a silent crash.
      failed = true;
      runs.push({width, mode, failures: [`could not inspect the page: ${error.message.split('\n')[0]}`], notices: [], figures: []});
      await context.close();
      continue;
    }
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
