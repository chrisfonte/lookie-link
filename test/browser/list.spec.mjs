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

async function startFixture({seed = true, title} = {}) {
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
  if (seed) await registry.createDraft({...structuredClone(listTemplate), ...(title ? {title} : {})});

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

function browserTest(name, run, {seed = true, title} = {}) {
  test(name, {timeout: 45_000}, async (t) => {
    if (!browser) {
      t.skip(`Playwright Chromium unavailable: ${launchError && launchError.message}`);
      return;
    }
    let fixture;
    let context;
    let page;
    try {
      fixture = await startFixture({seed, title});
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

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `document overflows 390px by ${overflow}px`);

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

browserTest('native UI creates a List and the page is usable', async ({page, fixture}) => {
  await page.goto(`${fixture.origin}/forms/new?kind=list`, {waitUntil: 'networkidle'});
  assert.equal(await page.locator('select[name="kind"]').inputValue(), 'list');
  await page.fill('input[name="title"]', 'Weekend shopping');
  await page.click('form[action="/forms"] button[type="submit"]');
  await page.waitForURL(/\/forms\/weekend-shopping\/configure/);
  assert.match(await page.locator('main').innerText(), /Not published yet/);
  const draft = JSON.parse(await fs.readFile(path.join(fixture.templatesPath, 'weekend-shopping', 'draft.json'), 'utf8'));
  assert.equal(draft.kind, 'list');
  assert.equal(draft.fields, undefined);
  await page.getByRole('button', {name: 'Publish'}).click();
  await page.waitForLoadState('networkidle');
  assert.doesNotMatch(await page.locator('main').innerText(), /Not published yet/);
  await page.goto(`${fixture.origin}/forms/weekend-shopping`, {waitUntil: 'networkidle'});
  assert.match(await page.content(), /list-root/);
  await addItems(page, ['Milk']);
  const state = JSON.parse(await fs.readFile(path.join(fixture.templatesPath, 'weekend-shopping', 'list-state.json'), 'utf8'));
  assert.equal(state.items[0].text, 'Milk');
}, {seed: false});

const LONG_WORD = 'Supercalifragilisticexpialidocious'.repeat(3);
const MID_WORD = 'Supercalifragilisticexpialidocious';

browserTest('long synthetic title, section and item stay inside the 390px document', async ({page, fixture}) => {
  const statePath = path.join(fixture.templatesPath, TEMPLATE_ID, 'list-state.json');
  await fs.writeFile(statePath, JSON.stringify({
    contractVersion: 1,
    resourceKind: 'form-list-state',
    templateId: TEMPLATE_ID,
    revision: 1,
    updatedAt: new Date().toISOString(),
    sections: [{id: 'long', title: `${MID_WORD}-section title that goes on`}],
    items: [{id: '33333333-3333-4333-8333-333333333333', text: `${LONG_WORD} item text that also goes on`, sectionId: 'long', checked: false, owner: `${MID_WORD}-owner`}],
  }));
  await page.goto(`${fixture.origin}/forms/${TEMPLATE_ID}`, {waitUntil: 'networkidle'});
  const metrics = await page.evaluate(() => {
    const root = document.documentElement;
    const limit = root.clientWidth + 1;
    return {
      overflow: root.scrollWidth - root.clientWidth,
      wide: [...document.querySelectorAll('body *')]
        .filter((el) => el.checkVisibility() && el.getBoundingClientRect().right > limit)
        .slice(0, 5).map((el) => `${el.tagName}.${el.className}`),
    };
  });
  assert.deepEqual(metrics.wide, []);
  assert.ok(metrics.overflow <= 0, `document overflows 390px by ${metrics.overflow}px`);
  if (process.env.LIST_SCREENSHOT) await page.screenshot({path: process.env.LIST_SCREENSHOT.replace('.png', '-long.png'), fullPage: true});
  // Touch targets stay at least 44px tall with long content, in both modes.
  await page.getByRole('button', {name: 'Edit list'}).click();
  await page.getByRole('button', {name: 'Edit item'}).click();
  const heights = await page.evaluate(() => [...document.querySelectorAll('.list-check, .list-icon-btn, .list-mode-btn, .list-add-btn, .list-layout select, .list-layout input:not([type="checkbox"])')]
    .filter((el) => el.checkVisibility()).map((el) => el.getBoundingClientRect().height));
  assert.ok(heights.length >= 8 && heights.every((height) => height >= 44), `touch heights ${heights}`);
  const editOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(editOverflow <= 0, `edit mode overflows 390px by ${editOverflow}px`);
}, {title: `${LONG_WORD} title`});

browserTest('Remove needs confirmation and removes only the chosen item', async ({page, fixture}) => {
  await page.goto(`${fixture.origin}/forms/${TEMPLATE_ID}`, {waitUntil: 'networkidle'});
  await addItems(page, ['Tent', 'Lantern', 'Kettle']);
  await page.locator('.list-item', {hasText: 'Kettle'}).locator('input[type="checkbox"]').check();
  await page.waitForFunction(savedStatus);
  const statePath = path.join(fixture.templatesPath, TEMPLATE_ID, 'list-state.json');
  const before = JSON.parse(await fs.readFile(statePath, 'utf8'));

  await page.getByRole('button', {name: 'Edit list'}).click();
  const lantern = page.locator('.list-item', {hasText: 'Lantern'});
  await lantern.getByRole('button', {name: 'Edit item'}).click();
  await lantern.getByRole('button', {name: 'Remove item'}).click();
  // First press only arms the button; nothing is removed or saved yet.
  assert.equal(await page.locator('.list-item').count(), 3);
  assert.equal(JSON.parse(await fs.readFile(statePath, 'utf8')).revision, before.revision);
  await page.locator('.list-item', {hasText: 'Lantern'}).getByRole('button', {name: 'Confirm remove item'}).click();
  await page.waitForFunction(savedStatus);

  const after = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.deepEqual(after.items.map((item) => item.text), ['Tent', 'Kettle']);
  const byText = (state, text) => state.items.find((item) => item.text === text);
  assert.equal(byText(after, 'Tent').id, byText(before, 'Tent').id);
  assert.equal(byText(after, 'Kettle').id, byText(before, 'Kettle').id);
  assert.equal(byText(after, 'Kettle').checked, true);
  assert.equal(byText(after, 'Tent').checked, false);

  // Arming one item then ticking another disarms the removal.
  await page.locator('.list-item', {hasText: 'Tent'}).getByRole('button', {name: 'Edit item'}).click();
  await page.locator('.list-item', {hasText: 'Tent'}).getByRole('button', {name: 'Remove item'}).click();
  await page.locator('.list-item', {hasText: 'Kettle'}).locator('input[type="checkbox"]').uncheck();
  await page.waitForFunction(savedStatus);
  assert.equal(await page.getByRole('button', {name: 'Confirm remove item'}).count(), 0);
  const fresh = await page.context().newPage();
  await fresh.goto(`${fixture.origin}/forms/${TEMPLATE_ID}`, {waitUntil: 'networkidle'});
  assert.equal(await fresh.locator('.list-item').count(), 2);
});


// ---- check-first layout, large generic list ---------------------------------

const SECTION_COUNT = 18;
const ITEM_COUNT = 104;

async function seedLargeList(fixture, {labelSuffix = ''} = {}) {
  // Synthetic, generic data only: "Aisle N" sections, "Sample item N" rows.
  const sections = [{id: 'general', title: 'General'}];
  for (let index = 1; index < SECTION_COUNT; index += 1) sections.push({id: `aisle-${index}`, title: `Aisle ${index}`});
  const items = [];
  for (let index = 0; index < ITEM_COUNT; index += 1) {
    const sectionIndex = 1 + (index % (SECTION_COUNT - 1));
    items.push({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      text: `Sample item ${index + 1}${labelSuffix}`,
      sectionId: sections[sectionIndex].id,
      checked: false,
    });
  }
  await fs.writeFile(path.join(fixture.templatesPath, TEMPLATE_ID, 'list-state.json'), JSON.stringify({
    contractVersion: 1,
    resourceKind: 'form-list-state',
    templateId: TEMPLATE_ID,
    revision: 1,
    updatedAt: new Date().toISOString(),
    sections,
    items,
  }));
}

const rowByLabel = (page, label) => page.locator('.list-item').filter({has: page.locator('.list-check-text', {hasText: new RegExp(`^${label}$`)})});
const overflowOf = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

browserTest('check mode is compact: no edit clutter, empty section hidden, rows fit the first screen', async ({page, fixture}) => {
  await seedLargeList(fixture);
  await page.goto(`${fixture.origin}/forms/${TEMPLATE_ID}`, {waitUntil: 'networkidle'});
  assert.equal(await page.locator('.list-section').count(), SECTION_COUNT - 1, 'empty General hidden');
  assert.equal(await page.locator('.list-item').count(), ITEM_COUNT);
  assert.equal(await page.locator('.list-section-header h2', {hasText: 'General'}).count(), 0);

  // Clutter gate: geometry can pass while every row still carries its buttons.
  // Normal mode must expose zero edit controls anywhere in the list.
  const clutter = await page.evaluate(() => ({
    rowControls: document.querySelectorAll('#list-root button, #list-root select, #list-root input:not([type="checkbox"])').length,
    visibleButtons: [...document.querySelectorAll('.list-layout button')].filter((el) => el.checkVisibility()).map((el) => el.textContent.trim()),
    newSection: document.getElementById('list-add-section').checkVisibility(),
  }));
  assert.equal(clutter.rowControls, 0, 'no per-row buttons, selects or inputs in check mode');
  assert.deepEqual(clutter.visibleButtons.sort(), ['Add', 'Edit list']);
  assert.equal(clutter.newSection, false, 'add-section is edit-only');

  const metrics = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.list-item')];
    const heights = rows.map((row) => row.getBoundingClientRect().height);
    const inFirstScreen = rows.filter((row) => row.getBoundingClientRect().bottom <= window.innerHeight).length;
    return {maxRow: Math.max(...heights), inFirstScreen, firstTop: rows[0].getBoundingClientRect().top};
  });
  assert.ok(metrics.maxRow <= 60, `row height ${metrics.maxRow}`);
  assert.ok(metrics.inFirstScreen >= 6, `only ${metrics.inFirstScreen} rows fit the first 844px screen`);
  assert.ok(metrics.firstTop < 560, `first row starts at ${metrics.firstTop}px`);
  assert.ok(await overflowOf(page) <= 0);
  const sizes = await page.evaluate(() => [...document.querySelectorAll('.list-check, .list-mode-btn, .list-add-btn')].map((el) => el.getBoundingClientRect().height));
  assert.ok(sizes.every((height) => height >= 44), `touch heights ${sizes}`);
  if (process.env.LIST_SCREENSHOT) await page.screenshot({path: process.env.LIST_SCREENSHOT.replace('.png', '-check.png')});
});

browserTest('check, filter, edit mode and reload keep state; Done editing returns', async ({page, fixture}) => {
  await seedLargeList(fixture);
  await page.goto(`${fixture.origin}/forms/${TEMPLATE_ID}`, {waitUntil: 'networkidle'});
  const statePath = path.join(fixture.templatesPath, TEMPLATE_ID, 'list-state.json');

  await page.locator('.list-item', {hasText: 'Sample item 1'}).first().locator('input[type="checkbox"]').check();
  await page.waitForFunction(savedStatus);
  await page.fill('#list-filter', 'Sample item 2');
  const filtered = await page.locator('.list-item').count();
  assert.ok(filtered > 0 && filtered < ITEM_COUNT, `filter narrowed to ${filtered}`);

  // Into edit mode: filter and checked state survive, empty sections stay filtered out while narrowed.
  await page.getByRole('button', {name: 'Edit list'}).click();
  assert.equal(await page.inputValue('#list-filter'), 'Sample item 2');
  assert.equal(await page.locator('.list-item').count(), filtered);
  await page.fill('#list-filter', '');
  assert.equal(await page.locator('.list-section').count(), SECTION_COUNT, 'edit mode shows the empty section');
  assert.equal(await rowByLabel(page, 'Sample item 1').locator('input').isChecked(), true);
  assert.equal(await page.locator('#list-add-section').isVisible(), true);

  // Inline edit (no window.prompt), reassign section, remove with confirmation.
  page.on('dialog', () => { throw new Error('window.prompt/alert must not be used'); });
  const row = rowByLabel(page, 'Sample item 3');
  await row.getByRole('button', {name: 'Edit item'}).click();
  await page.locator('.list-item.is-open input[name="text"]').fill('Renamed sample');
  await page.getByRole('button', {name: 'Save item text'}).click();
  await page.waitForFunction(savedStatus);
  const renamed = page.locator('.list-item', {hasText: 'Renamed sample'});
  await renamed.getByRole('button', {name: 'Edit item'}).click();
  await renamed.locator('select[data-action="section"]').selectOption('general');
  await page.waitForFunction(savedStatus);
  let disk = JSON.parse(await fs.readFile(statePath, 'utf8'));
  const moved = disk.items.find((item) => item.text === 'Renamed sample');
  assert.equal(moved.sectionId, 'general');
  assert.equal(moved.id, '00000000-0000-4000-8000-000000000002', 'id preserved across edit and move');
  await page.locator('.list-item', {hasText: 'Renamed sample'}).getByRole('button', {name: 'Remove item'}).click();
  await page.locator('.list-item', {hasText: 'Renamed sample'}).getByRole('button', {name: 'Confirm remove item'}).click();
  await page.waitForFunction(savedStatus);

  // Add a section, then add an item into it from the always-visible quick add.
  await page.fill('#list-add-section input[name="title"]', 'Extras');
  await page.click('#list-add-section button');
  await page.waitForFunction(savedStatus);
  await page.selectOption('#list-add-form select[name="section"]', {label: 'Extras'});
  await page.fill('#list-add-form input[name="text"]', 'Spare item');
  await page.click('#list-add-form button[type="submit"]');
  await page.waitForFunction(savedStatus);

  await page.getByRole('button', {name: 'Done editing'}).click();
  assert.equal(await page.getByRole('button', {name: 'Edit list'}).count(), 1);
  assert.equal(await page.locator('#list-root button, #list-root select').count(), 0, 'edit controls gone after Done editing');
  assert.equal(await page.locator('#list-add-section').isVisible(), false);
  assert.equal(await page.locator('.list-section-header h2', {hasText: 'Extras'}).count(), 1, 'populated new section shows');
  assert.equal(await page.locator('.list-section-header h2', {hasText: 'General'}).count(), 0, 'General is empty again after the removal, so it is hidden');

  // Reload: server state is exactly what was done.
  await page.reload({waitUntil: 'networkidle'});
  disk = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(disk.items.length, ITEM_COUNT);
  assert.equal(await page.locator('.list-item').count(), ITEM_COUNT);
  assert.equal(await rowByLabel(page, 'Sample item 1').locator('input').isChecked(), true);
  assert.equal(await page.locator('.list-item', {hasText: 'Spare item'}).count(), 1);
  assert.equal(await page.locator('.list-item', {hasText: 'Renamed sample'}).count(), 0);
});

browserTest('jump to section and hide completed work on the large list', async ({page, fixture}) => {
  await seedLargeList(fixture);
  await page.goto(`${fixture.origin}/forms/${TEMPLATE_ID}`, {waitUntil: 'networkidle'});
  const options = await page.locator('#list-jump option').count();
  assert.equal(options, SECTION_COUNT, 'placeholder plus 17 populated sections');
  await page.selectOption('#list-jump', 'aisle-15');
  const focused = await page.evaluate(() => document.activeElement && document.activeElement.textContent);
  assert.equal(focused, 'Aisle 15');
  await page.locator('.list-item').first().locator('input').check();
  await page.waitForFunction(savedStatus);
  await page.check('#list-hide-completed');
  assert.equal(await page.locator('.list-item').count(), ITEM_COUNT - 1);
});

browserTest('large list with long labels stays inside the document at 390px and desktop', async ({page, fixture}) => {
  await seedLargeList(fixture, {labelSuffix: ` ${MID_WORD}${MID_WORD}`});
  await page.goto(`${fixture.origin}/forms/${TEMPLATE_ID}`, {waitUntil: 'networkidle'});
  assert.ok(await overflowOf(page) <= 0, 'phone check mode');
  await page.getByRole('button', {name: 'Edit list'}).click();
  await page.getByRole('button', {name: 'Edit item'}).first().click();
  assert.ok(await overflowOf(page) <= 0, 'phone edit mode');
  await page.setViewportSize({width: 1280, height: 900});
  assert.ok(await overflowOf(page) <= 0, 'desktop edit mode');
  await page.getByRole('button', {name: 'Done editing'}).click();
  assert.ok(await overflowOf(page) <= 0, 'desktop check mode');
  if (process.env.LIST_SCREENSHOT) await page.screenshot({path: process.env.LIST_SCREENSHOT.replace('.png', '-desktop.png')});
});

browserTest('keyboard: toggling keeps focus on the row and the checkbox is focusable', async ({page, fixture}) => {
  await seedLargeList(fixture);
  await page.goto(`${fixture.origin}/forms/${TEMPLATE_ID}`, {waitUntil: 'networkidle'});
  await page.locator('.list-item input[type="checkbox"]').first().focus();
  await page.keyboard.press('Space');
  await page.waitForFunction(savedStatus);
  const stillFocused = await page.evaluate(() => document.activeElement && document.activeElement.matches('input[data-action="toggle"]'));
  assert.equal(stillFocused, true, 'focus stays on the toggled checkbox after re-render');
});
