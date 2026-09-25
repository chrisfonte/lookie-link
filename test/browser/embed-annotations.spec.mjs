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

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT_DIR = path.join(TEST_DIR, '.artifacts');
const VIEWPORT = {width: 1280, height: 800};

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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-playwright-embed-ann-'));
  const docsPath = path.join(root, 'docs-repo');
  await fs.mkdir(path.join(docsPath, 'guides'), {recursive: true});
  await fs.writeFile(
    path.join(docsPath, 'guides', 'page.html'),
    '<!doctype html><html><head><title>Embed quiet</title></head><body><h1 id="top">Hello</h1><p>Body.</p></body></html>',
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
    annotationsEnabled: true,
    editingEnabled: false,
    rawHtmlEnabled: true,
    accessConfig: {humanDefault: 'full'},
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

test('/view HTML embed does not fetch /api/annotations or log CORS errors', {timeout: 45_000}, async (t) => {
  if (!browser) {
    t.skip(skipReason());
    return;
  }

  let fixture;
  let context;
  let page;
  try {
    fixture = await startFixture();
    context = await browser.newContext({viewport: VIEWPORT, colorScheme: 'dark'});
    page = await context.newPage();

    const consoleErrors = [];
    const annotationRequests = [];
    const failedAnnotationRequests = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
    page.on('request', (request) => {
      const url = request.url();
      if (/\/api\/annotations\//.test(url)) {
        annotationRequests.push(url);
      }
    });
    page.on('requestfailed', (request) => {
      const url = request.url();
      if (/\/api\/annotations\//.test(url)) {
        failedAnnotationRequests.push(url);
      }
    });
    page.on('response', (response) => {
      if (/\/api\/annotations\//.test(response.url()) && response.status() >= 400) {
        failedAnnotationRequests.push(`${response.status()} ${response.url()}`);
      }
    });

    await page.goto(`${fixture.origin}/view/docs/guides/page.html`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    // Let the sandboxed embed settle (theme sync, height posts) without waiting
    // on networkidle — that is what hung when annotations.js CORS-failed.
    await page.waitForSelector('iframe[data-embedded-html]', {timeout: 10_000});
    await page.waitForTimeout(1500);

    assert.deepEqual(annotationRequests, [], 'embedded HTML view must not call /api/annotations');
    assert.deepEqual(failedAnnotationRequests, [], 'no /api/annotations requests should fail');
    const annotationNoise = consoleErrors.filter((text) =>
      /annotations|CORS|Failed to fetch|ERR_FAILED/i.test(text));
    assert.deepEqual(annotationNoise, [], `unexpected console errors: ${annotationNoise.join(' | ')}`);
    assert.deepEqual(consoleErrors, [], `no console errors expected; got: ${consoleErrors.join(' | ')}`);
  } catch (error) {
    if (page && !page.isClosed()) {
      try {
        await fs.mkdir(ARTIFACT_DIR, {recursive: true});
        const screenshotPath = path.join(ARTIFACT_DIR, `embed-annotations-quiet-${Date.now()}.png`);
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
