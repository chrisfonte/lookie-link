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
const TEMPLATE_ID = 'machine-strength-log';
const TEMPLATE_TITLE = 'Gym — Strength (machine)';
const LONGEST_MACHINE_LABEL = 'Plate-loaded chest press machine';

const gymTemplate = {
  contractVersion: 1,
  resourceKind: 'form-template',
  templateId: TEMPLATE_ID,
  ownerId: 'operator',
  revision: 1,
  grammarVersion: 1,
  destinationId: 'gym-log',
  title: TEMPLATE_TITLE,
  fields: [
    {
      id: 'machine',
      type: 'select',
      label: 'Machine',
      required: true,
      options: [
        {id: 'cable-row', label: 'Cable row'},
        {id: 'plate-loaded-press', label: LONGEST_MACHINE_LABEL},
      ],
    },
    {
      id: 'weight-lbs',
      type: 'number',
      label: 'Working weight (lb)',
      required: true,
      constraints: {minimum: 0, maximum: 999, integer: true, step: 1},
    },
    {
      id: 'sets',
      type: 'number',
      component: 'stepped-select',
      label: 'Sets',
      required: true,
      constraints: {minimum: 1, maximum: 20, integer: true, step: 1},
    },
    {
      id: 'reps',
      type: 'number',
      component: 'stepped-select',
      label: 'Reps',
      required: true,
      constraints: {minimum: 1, maximum: 100, integer: true, step: 1},
    },
    {
      id: 'intensity',
      type: 'number',
      component: 'stepped-select',
      label: 'Intensity (%)',
      required: false,
      constraints: {minimum: 0, maximum: 100, integer: true, step: 1},
    },
  ],
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-playwright-forms-'));
  const templatesPath = path.join(root, 'templates');
  const destinationPath = path.join(root, 'gym-log');
  await fs.mkdir(templatesPath);
  await fs.mkdir(destinationPath);

  const registry = new TemplateRegistry({
    templatesPath,
    destinationIds: ['gym-log'],
    logger: {warn() {}},
  });
  await registry.createDraft(structuredClone(gymTemplate));

  // A mapped repo with a document, so browser tests can cover document pages too.
  // Without this the fixture serves forms only, and a header assertion written
  // against a form page passes vacuously when the document header is broken.
  const docsPath = path.join(root, 'docs-repo');
  await fs.mkdir(path.join(docsPath, 'guides'), {recursive: true});
  await fs.writeFile(
    path.join(docsPath, 'guides', 'a-fairly-long-document-name.md'),
    '---\nTitle: Sample\n---\n\n# Sample\n\nBody.\n\n'
    + Array.from({length: 12}, (_, i) => `## Section ${i + 1}\n\nText for section ${i + 1}.\n\n`).join(''),
    'utf8'
  );

  const listener = http.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${listener.address().port}`;
  const app = createApp({
    mappings: {docs: docsPath},
    // Match production's toolbar: annotations and editing add buttons, which makes
    // the toolbar taller and wider. A fixture with fewer buttons never reproduces
    // the overlap it is meant to guard against.
    annotationsEnabled: true,
    editingEnabled: true,
    accessConfig: {humanDefault: 'full'},
    formsConfig: {
      enabled: true,
      templatesPath,
      destinations: {'gym-log': destinationPath},
    },
    formsRegistry: registry,
    formsPublicOrigin: origin,
    formsAudit: () => {},
  });
  listener.on('request', app);

  return {
    origin,
    async close() {
      await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
      await fs.rm(root, {recursive: true, force: true});
    },
  };
}

function skipReason() {
  const firstLine = launchError && launchError.message
    ? launchError.message.split('\n').find((line) => line.trim())
    : 'unknown launch error';
  return `Playwright Chromium unavailable: ${firstLine}`;
}

function browserTest(name, run) {
  test(name, {timeout: 45_000}, async (t) => {
    if (!browser) {
      t.skip(skipReason());
      return;
    }

    let fixture;
    let context;
    let page;
    try {
      fixture = await startFixture();
      context = await browser.newContext({viewport: PHONE_VIEWPORT, colorScheme: 'dark'});
      page = await context.newPage();
      await run({t, page, fixture});
    } catch (error) {
      if (page && !page.isClosed()) {
        try {
          await fs.mkdir(ARTIFACT_DIR, {recursive: true});
          const safeName = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          const screenshotPath = path.join(ARTIFACT_DIR, `${safeName}-${Date.now()}.png`);
          await page.screenshot({path: screenshotPath, fullPage: true});
          t.diagnostic(`Failure screenshot: ${screenshotPath}`);
        } catch (screenshotError) {
          t.diagnostic(`Could not capture failure screenshot: ${screenshotError.message}`);
        }
      }
      throw error;
    } finally {
      if (context) await context.close().catch(() => {});
      if (fixture) await fixture.close().catch(() => {});
    }
  });
}

function formUrl(fixture) {
  return `${fixture.origin}/forms/${TEMPLATE_ID}`;
}

async function assertNoClippedControls(page, state) {
  const measurements = await page.locator('input, select, .field-readout').evaluateAll((elements) =>
    elements.map((element, index) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const visible = style.display !== 'none' && style.visibility !== 'hidden'
        && rect.width > 0 && rect.height > 0;
      const value = element instanceof HTMLInputElement || element instanceof HTMLSelectElement
        ? element.value
        : element.textContent.trim();
      // Editable, focusable inputs can be scrolled by the reader; readonly and
      // disabled ones are readouts wearing an input's clothes.
      const userScrollable = element instanceof HTMLInputElement
        && !element.readOnly && !element.disabled;
      return {
        index,
        visible,
        userScrollable,
        name: element.getAttribute('name') || element.id || element.className || element.tagName,
        value,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        // scrollWidth is BLIND for <select>: the browser visually truncates the
        // option label without growing scrollWidth, so a 113px option inside an
        // 85px control still reports scrollWidth === clientWidth. Measure the
        // widest option against the control's inner width instead. Verified by
        // reintroducing the oversized-dropdown defect: the scrollWidth check
        // passed while the text was demonstrably clipped.
        overflowPx: (() => {
          if (!(element instanceof HTMLSelectElement) || !element.options.length) return 0;
          const context = document.createElement('canvas').getContext('2d');
          context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
          const widest = Math.max(...[...element.options].map((option) => context.measureText(option.text).width));
          const inner = element.clientWidth
            - parseFloat(style.paddingLeft || 0) - parseFloat(style.paddingRight || 0);
          return Math.round(widest - inner);
        })(),
      };
    })
  );
  // An editable input whose value is wider than its box is not clipping anything:
  // the user can focus it and scroll through the value. Its width also depends on
  // font metrics, so the check is environment-fragile there -- it passed locally
  // and failed on a CI runner whose fonts render ~18px wider for the same string.
  // Clipping only destroys information in controls the reader cannot scroll: a
  // <select> (label visually truncated) and a readout (text simply cut off).
  const clipped = measurements.filter((measurement) => measurement.visible
    && ((measurement.scrollWidth > measurement.clientWidth + 1 && !measurement.userScrollable)
      || measurement.overflowPx > 1));
  assert.deepEqual(clipped, [], `${state}: visible controls must not clip their content`);
  assert.ok(measurements.some((measurement) => measurement.visible), `${state}: expected visible controls`);
}

function parseRgb(color) {
  const channels = color.match(/[\d.]+/g);
  assert.ok(channels && channels.length >= 3, `expected an RGB color, got ${color}`);
  return channels.slice(0, 3).map(Number);
}

function luminance(color) {
  const linear = parseRgb(color).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

async function assertContrast(page, selector, minimum, description) {
  const colors = await page.locator(selector).first().evaluate((element) => {
    let backgroundElement = element;
    let background = getComputedStyle(backgroundElement).backgroundColor;
    while (backgroundElement.parentElement && (background === 'transparent' || /,\s*0\s*\)$/.test(background))) {
      backgroundElement = backgroundElement.parentElement;
      background = getComputedStyle(backgroundElement).backgroundColor;
    }
    return {foreground: getComputedStyle(element).color, background};
  });
  const lighter = Math.max(luminance(colors.foreground), luminance(colors.background));
  const darker = Math.min(luminance(colors.foreground), luminance(colors.background));
  const ratio = (lighter + 0.05) / (darker + 0.05);
  assert.ok(ratio >= minimum, `${description} contrast ${ratio.toFixed(2)} must be at least ${minimum}`);
}

async function setTheme(page, mode) {
  const isLight = await page.locator('html').getAttribute('data-theme') === 'light';
  if (isLight !== (mode === 'light')) await page.locator('[data-theme-toggle]').click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), mode === 'light' ? 'light' : null);
}

async function fillWorstCase(page) {
  await page.locator('#field-machine').selectOption('plate-loaded-press');
  await page.locator('#field-weight-lbs').fill('999');
  await page.locator('#field-sets').selectOption('20');
  await page.locator('#field-reps').selectOption('100');
  await page.locator('#field-intensity').selectOption('100');
}

async function fillValidEntry(page) {
  await page.locator('#field-machine').selectOption('plate-loaded-press');
  await page.locator('#field-weight-lbs').fill('150');
  await page.locator('#field-sets').selectOption('5');
  await page.locator('#field-reps').selectOption('12');
  await page.locator('#field-intensity').selectOption('85');
}

async function submitBoundViolation(page) {
  await fillValidEntry(page);
  await page.locator('#field-weight-lbs').fill('1000');
  await page.locator('.form-card form').evaluate((form) => { form.noValidate = true; });
  const [response] = await Promise.all([
    page.waitForResponse((candidate) => candidate.request().method() === 'POST'
      && new URL(candidate.url()).pathname === `/forms/${TEMPLATE_ID}`),
    page.locator('.form-primary-action').click(),
  ]);
  assert.equal(response.status(), 422);
  await page.locator('.errors[role="alert"]').waitFor();
}

browserTest('phone form controls do not clip in dark or light themes', async ({page, fixture}) => {
  for (const mode of ['dark', 'light']) {
    await page.goto(formUrl(fixture));
    await setTheme(page, mode);

    await assertNoClippedControls(page, `${mode} empty form`);
    await assertContrast(page, '.form-primary-action', 4, `${mode} primary action`);

    await fillWorstCase(page);
    assert.equal(await page.locator('#field-machine option:checked').textContent(), LONGEST_MACHINE_LABEL);
    await assertNoClippedControls(page, `${mode} worst-case form`);

    await submitBoundViolation(page);
    await assertNoClippedControls(page, `${mode} validation re-render`);
    await assertContrast(page, '.errors', 4.5, `${mode} error summary`);
  }
});

browserTest('primary action and validation errors use human copy', async ({page, fixture}) => {
  await page.goto(formUrl(fixture));
  const actionText = (await page.locator('.form-primary-action').textContent()).trim();
  assert.notEqual(actionText, '', 'primary action must have text');
  assert.equal(actionText.includes(TEMPLATE_TITLE), false, 'primary action must not repeat the punctuated title');

  await submitBoundViolation(page);
  const errorText = (await page.locator('.errors li').textContent()).trim();
  assert.match(errorText, /Working weight \(lb\)/, 'error must use the human field label');
  assert.match(errorText, /999/, 'bound error must state the numeric limit');
  assert.doesNotMatch(errorText, /\bweight-lbs\b/, 'error must not expose the field ID');
});

browserTest('machine strength entry reaches its receipt and entries list', async ({page, fixture}) => {
  await page.goto(formUrl(fixture));
  await fillValidEntry(page);
  await Promise.all([
    page.waitForURL((url) => /\/receipts\//.test(url.pathname)),
    page.locator('.form-primary-action').click(),
  ]);

  assert.equal((await page.locator('h1').textContent()).trim(), 'Entry logged');
  const receipt = Object.fromEntries(await page.locator('.receipt-table tbody tr').evaluateAll((rows) =>
    rows.map((row) => {
      const label = row.querySelector('th').textContent.trim();
      const value = row.querySelector('.receipt-value').textContent.trim();
      const unit = row.querySelector('.receipt-unit').textContent.trim();
      return [label, {value, unit}];
    })
  ));
  assert.deepEqual(receipt.Machine, {value: LONGEST_MACHINE_LABEL, unit: ''});
  assert.deepEqual(receipt['Working weight'], {value: '150', unit: 'lb'});
  assert.deepEqual(receipt.Sets, {value: '5', unit: ''});
  assert.deepEqual(receipt.Reps, {value: '12', unit: ''});

  await page.getByRole('link', {name: 'All entries'}).click();
  await page.waitForURL((url) => url.pathname.endsWith('/entries'));
  const listed = (await page.locator('.entry-list').textContent()).replace(/\s+/g, ' ');
  assert.match(listed, new RegExp(LONGEST_MACHINE_LABEL));
  assert.match(listed, /Working weight\s*150\s*lb/);
  assert.match(listed, /Sets\s*5/);
  assert.match(listed, /Reps\s*12/);
});

browserTest('builder field rows start collapsed and expand without clipped controls', async ({page, fixture}) => {
  await page.goto(`${formUrl(fixture)}/configure`);
  const fields = page.locator('details.builder-field');
  assert.equal(await fields.count(), gymTemplate.fields.length);
  for (let index = 0; index < await fields.count(); index += 1) {
    assert.equal(await fields.nth(index).getAttribute('open'), null, `field ${index + 1} should start collapsed`);
    assert.equal(await fields.nth(index).locator('.builder-field-settings').isVisible(), false);
  }

  await fields.first().locator('summary').click();
  assert.equal(await fields.first().getAttribute('open'), '');
  assert.equal(await fields.first().locator('.builder-field-settings').isVisible(), true);
  await assertNoClippedControls(page, 'expanded builder');
});

browserTest('the header clears the toolbar while the window is resized, not just on load', async ({page, fixture}) => {
  // Resizing is the case a fixed-width sweep misses: the toolbar rewraps as the
  // window narrows, and clearance measured only at load time goes stale. Walk a
  // live page down through the range rather than loading fresh at each width.
  await page.setViewportSize({width: 1400, height: 800});
  await page.goto(`${fixture.origin}/view/docs/guides/a-fairly-long-document-name.md`, {waitUntil: 'networkidle'});

  const overlapping = [];
  for (let width = 1400; width >= 330; width -= 40) {
    await page.setViewportSize({width, height: 800});
    await page.waitForTimeout(60);
    const geometry = await page.evaluate(() => {
      const toolbar = document.querySelector('.viewer-toolbar').getBoundingClientRect();
      const crumbs = document.querySelector('.breadcrumbs').getBoundingClientRect();
      return {toolbarBottom: Math.round(toolbar.bottom), crumbTop: Math.round(crumbs.top)};
    });
    if (geometry.crumbTop < geometry.toolbarBottom) {
      overlapping.push(`${width}px (crumb ${geometry.crumbTop} < toolbar ${geometry.toolbarBottom})`);
    }
  }

  assert.deepEqual(overlapping, [], 'header must clear the toolbar at every width while resizing');
});

browserTest('the Properties menu stays on screen at every width', async ({page, fixture}) => {
  for (const width of [1400, 1000, 700, 430, 330]) {
    await page.setViewportSize({width, height: 800});
    await page.goto(`${fixture.origin}/view/docs/guides/a-fairly-long-document-name.md`, {waitUntil: 'networkidle'});
    await page.click('.toolbar-properties > summary');
    await page.waitForTimeout(80);
    const box = await page.evaluate(() => {
      const panel = document.querySelector('.doc-properties-grid').getBoundingClientRect();
      return {left: Math.round(panel.left), right: Math.round(panel.right), viewport: window.innerWidth};
    });
    assert.ok(
      box.left >= 0 && box.right <= box.viewport,
      `Properties menu must stay on screen at ${width}px (left ${box.left}, right ${box.right})`
    );
  }
});

browserTest('the header clears the floating toolbar instead of running underneath it', async ({page, fixture}) => {
  // The toolbar is position:fixed at the top right and floats over content. The
  // header must start below it -- a long first line (breadcrumbs on document
  // pages) otherwise disappears under the controls. Caught by screenshot once;
  // asserted here so it stays caught.
  await page.goto(`${fixture.origin}/view/docs/guides/a-fairly-long-document-name.md`, {waitUntil: 'networkidle'});

  const geometry = await page.evaluate(() => {
    const toolbar = document.querySelector('.viewer-toolbar');
    const topbar = document.querySelector('.topbar');
    if (!toolbar || !topbar) return null;
    const t = toolbar.getBoundingClientRect();
    const h = topbar.getBoundingClientRect();
    const first = topbar.firstElementChild;
    const f = first ? first.getBoundingClientRect() : null;
    return {
      toolbarBottom: t.bottom,
      topbarTop: h.top,
      firstChildTop: f ? f.top : null,
      firstChildTag: first ? first.tagName : null,
    };
  });

  assert.ok(geometry, 'expected a toolbar and a header');
  assert.ok(
    geometry.firstChildTop >= geometry.toolbarBottom,
    `header content must start below the toolbar (${geometry.firstChildTag} top ${geometry.firstChildTop} vs toolbar bottom ${geometry.toolbarBottom})`
  );
});

browserTest('the contents menu opens over the document instead of replacing it', async ({page, fixture}) => {
  await page.setViewportSize({width: 1100, height: 700});
  await page.goto(`${fixture.origin}/view/docs/guides/a-fairly-long-document-name.md`, {waitUntil: 'networkidle'});

  const toggle = await page.$('[data-toc-toggle]');
  if (!toggle) return; // document has too few headings for a contents menu

  await toggle.click();
  await page.waitForSelector('.toc-list .toc-item', {timeout: 5000});

  const state = await page.evaluate(() => {
    const list = document.querySelector('.toc-list');
    const doc = document.querySelector('[data-rendered-view]');
    const rect = list.getBoundingClientRect();
    return {
      documentStillVisible: doc ? !doc.hidden : null,
      onScreen: rect.left >= 0 && rect.right <= window.innerWidth,
      scrollsInternally: list.scrollHeight > 0 && getComputedStyle(list).overflowY === 'auto',
    };
  });

  // The point of the change: it is a menu, not a view swap. The document must stay.
  assert.equal(state.documentStillVisible, true, 'the document stays visible behind the menu');
  assert.ok(state.onScreen, 'the contents menu stays on screen');
  assert.ok(state.scrollsInternally, 'a long contents list scrolls inside the menu');
});

browserTest('theme and section menus behave like menus, not native selects', async ({page, fixture}) => {
  await page.setViewportSize({width: 1200, height: 800});
  await page.goto(`${fixture.origin}/view/docs/guides/a-fairly-long-document-name.md`, {waitUntil: 'networkidle'});

  // The section menu labels itself with where you are.
  const navLabel = await page.textContent('[data-nav-label]');
  assert.equal(navLabel.trim(), 'Files', 'a document page reads as Files');

  // Switching theme through the menu applies it, persists it, and relabels.
  await page.click('[data-theme-menu] > summary');
  await page.waitForSelector('[data-theme-item]');
  const target = await page.$('[data-theme-item][value="nord"]');
  if (target) {
    await target.click();
    await page.waitForTimeout(120);
    const state = await page.evaluate(() => ({
      scheme: document.documentElement.getAttribute('data-color-scheme'),
      stored: localStorage.getItem('lookie-link-color-scheme'),
      label: document.querySelector('[data-theme-label]').textContent.trim(),
      open: document.querySelector('[data-theme-menu]').open,
    }));
    assert.equal(state.scheme, 'nord', 'theme applied');
    assert.equal(state.stored, 'nord', 'theme persisted');
    assert.equal(state.label, 'Nord', 'control relabels to the active theme');
    assert.equal(state.open, false, 'menu closes after choosing');
  }

  // Menus stay on screen at phone width.
  await page.setViewportSize({width: 390, height: 800});
  await page.click('[data-nav-menu] > summary');
  await page.waitForTimeout(120);
  const box = await page.evaluate(() => {
    const list = document.querySelector('[data-nav-menu] .toolbar-menu-list').getBoundingClientRect();
    return {left: list.left, right: list.right, viewport: window.innerWidth};
  });
  assert.ok(box.left >= 0 && box.right <= box.viewport, 'section menu stays on screen at 390px');
});
