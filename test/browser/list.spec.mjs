import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {after, before, test} from 'node:test';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const {chromium} = require('playwright');
const {createApp} = require('../../server.js');
const {TemplateRegistry} = require('../../lib/forms/template-registry.js');

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT_DIR = path.join(TEST_DIR, '.artifacts');
const PHONE_VIEWPORT = {width: 390, height: 844};
const TEMPLATE_ID = 'packing-checklist';

const listTemplate = {
  contractVersion: 1,
  resourceKind: 'form-template',
  templateId: TEMPLATE_ID,
  ownerId: 'operator',
  revision: 1,
  grammarVersion: 1,
  title: 'Packing checklist',
  kind: 'list',
};

let browser;
let launchError;

before(async () => {
  try {
    browser = await chromium.launch({headless: true});
  } catch (error) {
    launchError = error;
  }
});

after(async () => {
  if (browser) await browser.close();
});

async function startFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-list-browser-'));
  const templatesPath = path.join(root, 'templates');
  const destinationPath = path.join(root, 'subs');
  await fs.mkdir(templatesPath);
  await fs.mkdir(destinationPath);
  const registry = new TemplateRegistry({
    templatesPath,
    destinationIds: ['default'],
    logger: {warn() {}},
  });
  await registry.createDraft(structuredClone(listTemplate));

  const listener = http.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${listener.address().port}`;
  const app = createApp({
    mappings: {},
    accessConfig: {humanDefault: 'full'},
    formsConfig: {
      enabled: true,
      templatesPath,
      destinations: {default: destinationPath},
    },
    formsRegistry: registry,
    formsPublicOrigin: origin,
    formsAudit: () => {},
  });
  listener.on('request', app);
  return {
    origin,
    templatesPath,
    async close() {
      await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
      await fs.rm(root, {recursive: true, force: true});
    },
  };
}

function browserTest(name, run) {
  test(name, {timeout: 45_000}, async (t) => {
    if (!browser) {
      t.skip(`Playwright Chromium unavailable: ${launchError && launchError.message}`);
      return;
    }
    let fixture;
    let context;
    let page;
    try {
      fixture = await startFixture();
      context = await browser.newContext({viewport: PHONE_VIEWPORT, colorScheme: 'dark'});
      page = await context.newPage();
      await run({page, fixture});
    } catch (error) {
      if (page && !page.isClosed()) {
        try {
          await fs.mkdir(ARTIFACT_DIR, {recursive: true});
          await page.screenshot({
            path: path.join(ARTIFACT_DIR, `list-${Date.now()}.png`),
            fullPage: true,
          });
        } catch (_error) {}
      }
      throw error;
    } finally {
      if (context) await context.close();
      if (fixture) await fixture.close();
    }
  });
}

browserTest('list page at 390px autosaves a checkbox change', async ({page, fixture}) => {
  await page.goto(`${fixture.origin}/forms/${TEMPLATE_ID}`, {waitUntil: 'networkidle'});
  assert.match(await page.content(), /list-root/);
  assert.match(await page.content(), /Hide completed/);

  const statePath = path.join(fixture.templatesPath, TEMPLATE_ID, 'list-state.json');
  await assert.rejects(() => fs.access(statePath), 'GET must not create list-state.json');

  await page.fill('.list-add-form input[name="text"]', 'Sleeping bag');
  await page.click('.list-add-form button[type="submit"]');
  await page.waitForFunction(() => {
    const status = document.getElementById('list-save-status');
    return status && status.dataset.status === 'saved' && /Saved/.test(status.textContent);
  });

  const onDisk = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(onDisk.revision, 1);
  assert.equal(onDisk.items.length, 1);
  assert.equal(onDisk.items[0].text, 'Sleeping bag');
  assert.equal(onDisk.items[0].checked, false);

  await page.click('.list-check input[type="checkbox"]');
  await page.waitForFunction(() => {
    const status = document.getElementById('list-save-status');
    return status && status.dataset.status === 'saved';
  });
  const afterToggle = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(afterToggle.revision, 2);
  assert.equal(afterToggle.items[0].checked, true);

  // Shared chrome (the properties drawer) is out of scope; the list itself must fit.
  const wide = await page.evaluate(() => {
    const limit = document.documentElement.clientWidth + 1;
    return [...document.querySelectorAll('.list-card, .list-card *')]
      .filter((el) => el.getBoundingClientRect().right > limit)
      .slice(0, 5).map((el) => `${el.tagName}.${el.className}`);
  });
  assert.deepEqual(wide, [], 'list content must fit within 390px');

  if (process.env.LIST_SCREENSHOT) await page.screenshot({path: process.env.LIST_SCREENSHOT, fullPage: true});

  const touch = await page.evaluate(() => {
    const checkbox = document.querySelector('.list-check');
    const mark = document.querySelector('.list-check-mark');
    const box = checkbox.getBoundingClientRect();
    const markBox = mark.getBoundingClientRect();
    return {rowHeight: box.height, markSize: Math.min(markBox.width, markBox.height)};
  });
  assert.ok(touch.rowHeight >= 44, `touch row height ${touch.rowHeight}`);
  assert.ok(touch.markSize >= 28, `checkbox mark size ${touch.markSize}`);
});

async function addItems(page, texts) {
  for (const text of texts) {
    await page.fill('.list-add-form input[name="text"]', text);
    await page.click('.list-add-form button[type="submit"]');
    await page.waitForFunction((expected) => {
      const status = document.getElementById('list-save-status');
      return status && status.dataset.status === 'saved'
        && [...document.querySelectorAll('.list-check-text')].some((node) => node.textContent.includes(expected));
    }, text);
  }
}

const savedStatus = () => {
  const status = document.getElementById('list-save-status');
  return status && status.dataset.status === 'saved';
};

browserTest('rapid ticks during an in-flight save are all kept', async ({page, fixture}) => {
  await page.goto(`${fixture.origin}/forms/${TEMPLATE_ID}`, {waitUntil: 'networkidle'});
  await addItems(page, ['Tent', 'Lantern', 'Kettle']);
  let held = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route('**/api/forms/*/list', async (route) => {
    if (route.request().method() === 'PUT' && held === 0) {
      held += 1;
      await gate;
    }
    await route.continue();
  });
  const boxes = page.locator('.list-check input[type="checkbox"]');
  await boxes.nth(0).check();
  await page.waitForFunction(() => document.getElementById('list-save-status').dataset.status === 'saving');
  await boxes.nth(1).check();
  await boxes.nth(2).check();
  release();
  await page.waitForFunction(savedStatus);
  assert.equal(await boxes.nth(0).isChecked(), true);
  assert.equal(await boxes.nth(1).isChecked(), true);
  assert.equal(await boxes.nth(2).isChecked(), true);

  const fresh = await page.context().newPage();
  await fresh.goto(`${fixture.origin}/forms/${TEMPLATE_ID}`, {waitUntil: 'networkidle'});
  const checked = await fresh.locator('.list-check input[type="checkbox"]:checked').count();
  assert.equal(checked, 3, 'fresh read sees all three ticks');
});

browserTest('failed save keeps the intended tick and Retry saves it', async ({page, fixture}) => {
  await page.goto(`${fixture.origin}/forms/${TEMPLATE_ID}`, {waitUntil: 'networkidle'});
  await addItems(page, ['Tent']);
  await page.route('**/api/forms/*/list', (route) => route.request().method() === 'PUT' ? route.abort() : route.continue());
  await page.locator('.list-check input[type="checkbox"]').check();
  await page.waitForFunction(() => document.getElementById('list-save-status').dataset.status === 'error');
  assert.equal(await page.locator('.list-check input[type="checkbox"]').isChecked(), true);
  await page.unroute('**/api/forms/*/list');
  await page.click('[data-retry]');
  await page.waitForFunction(savedStatus);
  const onDisk = JSON.parse(await fs.readFile(path.join(fixture.templatesPath, TEMPLATE_ID, 'list-state.json'), 'utf8'));
  assert.equal(onDisk.items[0].checked, true);
});

browserTest('conflict keeps unsaved intent visible and offers explicit choices', async ({page, fixture}) => {
  await page.goto(`${fixture.origin}/forms/${TEMPLATE_ID}`, {waitUntil: 'networkidle'});
  await addItems(page, ['Tent']);
  const statePath = path.join(fixture.templatesPath, TEMPLATE_ID, 'list-state.json');
  const other = JSON.parse(await fs.readFile(statePath, 'utf8'));
  other.revision += 1;
  other.items.push({id: '11111111-1111-4111-8111-111111111111', text: 'Added elsewhere', sectionId: other.sections[0].id, checked: false});
  await fs.writeFile(statePath, JSON.stringify(other));

  await page.locator('.list-check input[type="checkbox"]').first().check();
  await page.waitForFunction(() => document.getElementById('list-save-status').dataset.status === 'error');
  assert.equal(await page.locator('.list-check input[type="checkbox"]').first().isChecked(), true, 'local tick still visible');
  assert.equal(await page.locator('[data-keep]').count(), 1);
  assert.equal(await page.locator('[data-latest]').count(), 1);
  assert.equal(JSON.parse(await fs.readFile(statePath, 'utf8')).items[0].checked, false, 'conflict did not overwrite');

  await page.click('[data-keep]');
  await page.waitForFunction(savedStatus);
  const merged = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(merged.items[0].checked, true);
});
