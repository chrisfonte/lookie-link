'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');
const { JSDOM } = require('jsdom');

const CONFIG_MODULE_PATH = require.resolve('../lib/config');

// lib/config.js caches the parsed YAML in a module-level singleton, keyed by
// LOOKIE_LINK_CONFIG. Each helper call below writes a fresh temp config,
// points the env var at it, and reloads a clean copy of the module so tests
// never see another test's config.
function withThemesConfig(themes, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lookie-link-theme-alias-'));
  const configPath = path.join(dir, 'lookie-link.yaml');
  fs.writeFileSync(configPath, yaml.dump({ themes }), 'utf8');

  const previousEnv = process.env.LOOKIE_LINK_CONFIG;
  process.env.LOOKIE_LINK_CONFIG = configPath;
  delete require.cache[CONFIG_MODULE_PATH];

  const previousWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));

  try {
    // eslint-disable-next-line global-require
    const freshConfig = require('../lib/config');
    return fn(freshConfig, warnings);
  } finally {
    console.warn = previousWarn;
    delete require.cache[CONFIG_MODULE_PATH];
    if (previousEnv === undefined) {
      delete process.env.LOOKIE_LINK_CONFIG;
    } else {
      process.env.LOOKIE_LINK_CONFIG = previousEnv;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const HARBOR_NIGHT = {
  'harbor night': {
    aliases: ['old-harbor'],
    dark: { bg: '#0a0a1a', text: '#d8d8ff' },
    light: { bg: '#f5f5ff', text: '#202044' },
  },
};

test('an alias emits CSS selectors for both the canonical slug and the alias', () => {
  withThemesConfig(HARBOR_NIGHT, (config) => {
    const themes = config.loadCustomThemes();
    assert.equal(themes.length, 1);
    assert.equal(themes[0].slug, 'harbor-night');
    assert.deepEqual(themes[0].aliases, ['old-harbor']);

    const css = config.generateCustomThemeCss(themes);
    assert.match(css, /:root\[data-color-scheme="harbor-night"\] \{/);
    assert.match(css, /:root\[data-color-scheme="old-harbor"\] \{/);
    assert.match(css, /:root\[data-color-scheme="harbor-night"\]\[data-theme="light"\] \{/);
    assert.match(css, /:root\[data-color-scheme="old-harbor"\]\[data-theme="light"\] \{/);
    assert.match(css, /data-color-scheme="harbor-night"\] \[data-theme-name="harbor-night"\]/);
    assert.match(css, /data-color-scheme="old-harbor"\] \[data-theme-name="old-harbor"\]/);
  });
});

test('an alias is rejected when it collides with a built-in theme slug', () => {
  withThemesConfig(
    { 'harbor night': { aliases: ['slate'], dark: { bg: '#111', text: '#eee' } } },
    (config, warnings) => {
      const themes = config.loadCustomThemes();
      assert.equal(themes.length, 1);
      assert.deepEqual(themes[0].aliases, []);
      assert.ok(
        warnings.some((w) => w.includes('harbor night') && w.includes('slate')),
        `expected a warning naming the theme and alias, got: ${warnings.join(' | ')}`
      );
    }
  );
});

test('an alias is rejected when it collides with another custom theme\'s slug', () => {
  withThemesConfig(
    {
      reef: { dark: { bg: '#222', text: '#fff' } },
      'harbor night': { aliases: ['reef'], dark: { bg: '#111', text: '#eee' } },
    },
    (config, warnings) => {
      const themes = config.loadCustomThemes();
      const harborNight = themes.find((t) => t.slug === 'harbor-night');
      assert.deepEqual(harborNight.aliases, []);
      assert.ok(themes.some((t) => t.slug === 'reef'));
      assert.ok(
        warnings.some((w) => w.includes('harbor night') && w.includes('reef')),
        `expected a warning naming the theme and alias, got: ${warnings.join(' | ')}`
      );
    }
  );
});

test('an alias is rejected when it collides with another theme\'s alias', () => {
  withThemesConfig(
    {
      'harbor night': { aliases: ['classic'], dark: { bg: '#111', text: '#eee' } },
      reef: { aliases: ['classic'], dark: { bg: '#222', text: '#fff' } },
    },
    (config, warnings) => {
      const themes = config.loadCustomThemes();
      const harborNight = themes.find((t) => t.slug === 'harbor-night');
      const reef = themes.find((t) => t.slug === 'reef');
      assert.deepEqual(harborNight.aliases, ['classic']);
      assert.deepEqual(reef.aliases, []);
      assert.ok(
        warnings.some((w) => w.includes('reef') && w.includes('classic')),
        `expected a warning naming the theme and alias, got: ${warnings.join(' | ')}`
      );
    }
  );
});

test('a malformed alias is rejected with a clear message', () => {
  withThemesConfig(
    { 'harbor night': { aliases: ['Old Harbor!'], dark: { bg: '#111', text: '#eee' } } },
    (config, warnings) => {
      const themes = config.loadCustomThemes();
      assert.deepEqual(themes[0].aliases, []);
      assert.ok(
        warnings.some((w) => w.includes('harbor night') && w.includes('Old Harbor!')),
        `expected a warning naming the theme and alias, got: ${warnings.join(' | ')}`
      );
    }
  );
});

test('a duplicate alias within the same list is rejected on the second occurrence', () => {
  withThemesConfig(
    { 'harbor night': { aliases: ['old-harbor', 'old-harbor'], dark: { bg: '#111', text: '#eee' } } },
    (config) => {
      const themes = config.loadCustomThemes();
      assert.deepEqual(themes[0].aliases, ['old-harbor']);
    }
  );
});

test('an unknown theme name still fails open -- reserved/invalid names are skipped as before', () => {
  withThemesConfig({ slate: { dark: { bg: '#111', text: '#eee' } } }, (config) => {
    const themes = config.loadCustomThemes();
    assert.equal(themes.length, 0);
  });
});

// --- Picker / toolbar: aliases never appear as their own picker entry ---

test('aliases are absent from the theme picker but present in the label-reveal spans', () => {
  delete require.cache[require.resolve('../lib/renderer')];
  // eslint-disable-next-line global-require
  const renderer = require('../lib/renderer');
  renderer.setThemeList([
    { slug: 'slate', label: 'Slate' },
    { slug: 'harbor-night', label: 'Harbor Night', aliases: ['old-harbor'] },
  ]);
  try {
    const html = renderer.toolbarHtml();
    assert.match(html, /data-theme-item value="harbor-night"/);
    assert.doesNotMatch(html, /data-theme-item value="old-harbor"/);
    assert.match(html, /data-theme-name="harbor-night"/);
    assert.match(html, /data-theme-name="old-harbor"/);
  } finally {
    renderer.setThemeList(null);
  }
});

// --- Client-side: a saved alias choice renders and re-selects the canonical entry ---

async function bootThemeDom({ themes, storedScheme, pageScheme }) {
  delete require.cache[require.resolve('../lib/renderer')];
  // eslint-disable-next-line global-require
  const renderer = require('../lib/renderer');
  renderer.setThemeList(themes);
  const toolbar = renderer.toolbarHtml();
  const script = renderer.themeScript(null, pageScheme ? { scheme: pageScheme } : {});
  renderer.setThemeList(null);

  const dom = new JSDOM(`<!doctype html><html><body>${toolbar}${script}</body></html>`, {
    url: 'http://127.0.0.1:9876/view/docs/doc.md',
    runScripts: 'dangerously',
  });
  const { window } = dom;
  if (storedScheme) {
    window.localStorage.setItem('lookie-link-color-scheme', storedScheme);
  }
  // JSDOM's runScripts option only executes <script> tags parsed as part of
  // the document; re-run explicitly to be sure it fires after localStorage
  // is seeded (mirrors the annotations-client.test.js jsdom pattern).
  const scriptEl = window.document.querySelector('script');
  window.eval(scriptEl.textContent);
  return dom;
}

test('a saved choice equal to an alias renders the theme and selects the canonical picker entry', async () => {
  const themes = [
    { slug: 'slate', label: 'Slate' },
    { slug: 'harbor-night', label: 'Harbor Night', aliases: ['old-harbor'] },
  ];
  const dom = await bootThemeDom({ themes, storedScheme: 'old-harbor' });
  const { window } = dom;
  assert.equal(window.document.documentElement.getAttribute('data-color-scheme'), 'harbor-night');
  assert.equal(window.localStorage.getItem('lookie-link-color-scheme'), 'harbor-night');
  const canonicalItem = window.document.querySelector('[data-theme-item][value="harbor-night"]');
  assert.equal(canonicalItem.getAttribute('aria-current'), 'true');
});

test('an unknown saved slug still fails open -- it is left as-is and matches no picker entry', async () => {
  const themes = [
    { slug: 'slate', label: 'Slate' },
    { slug: 'harbor-night', label: 'Harbor Night', aliases: ['old-harbor'] },
  ];
  const dom = await bootThemeDom({ themes, storedScheme: 'not-a-real-theme' });
  const { window } = dom;
  assert.equal(window.document.documentElement.getAttribute('data-color-scheme'), 'not-a-real-theme');
  const items = window.document.querySelectorAll('[data-theme-item]');
  for (const item of items) {
    assert.equal(item.getAttribute('aria-current'), 'false');
  }
});

test('a page-level theme equal to an alias (a template presentation.theme) resolves like a slug', async () => {
  const themes = [
    { slug: 'slate', label: 'Slate' },
    { slug: 'harbor-night', label: 'Harbor Night', aliases: ['old-harbor'] },
  ];
  const dom = await bootThemeDom({ themes, pageScheme: 'old-harbor' });
  const { window } = dom;
  // A page-level scheme is authored on the template itself, not the saved
  // global preference, so it renders literally via the alias's own CSS
  // block rather than being rewritten.
  assert.equal(window.document.documentElement.getAttribute('data-color-scheme'), 'old-harbor');
  // The picker highlight still canonicalizes for the aria-current comparison,
  // even though the attribute itself is left as the alias.
  const canonicalItem = window.document.querySelector('[data-theme-item][value="harbor-night"]');
  assert.equal(canonicalItem.getAttribute('aria-current'), 'true');

  const { generateCustomThemeCss } = require('../lib/config');
  const css = generateCustomThemeCss([
    { slug: 'harbor-night', label: 'Harbor Night', aliases: ['old-harbor'], dark: { bg: '#0a0a1a', text: '#d8d8ff' }, light: {} },
  ]);
  assert.match(css, /:root\[data-color-scheme="old-harbor"\] \{/);
});

// --- Builder saves and Properties reporting: alias == installed (#389) ---

const http = require('node:http');
const { Duplex } = require('node:stream');

const ORIGIN = 'http://forms.example.test';

// Earlier tests in this file (and other test files run in the same process)
// require '../lib/renderer', mutate its module-level theme-list singleton via
// setThemeList, then leave require.cache pointing at whichever instance they
// last touched. '../server' (and the routes it wires up) binds its own
// reference to '../lib/renderer' the first time it is required, in THIS
// process -- so a plain require('../lib/renderer') here can silently resolve
// to a different singleton than the one routes.js reads from. Force a fresh,
// consistent module graph for every test below so setThemeList always reaches
// the same instance the app under test actually queries.
function freshServerModules() {
  for (const id of ['../lib/renderer', '../server', '../lib/forms/routes']) {
    delete require.cache[require.resolve(id)];
  }
  // eslint-disable-next-line global-require
  const renderer = require('../lib/renderer');
  // eslint-disable-next-line global-require
  const { createApp } = require('../server');
  return { setThemeList: renderer.setThemeList, createApp };
}

const { TemplateRegistry } = require('../lib/forms/template-registry');

function inject(app, route, init = {}) {
  return new Promise((resolve, reject) => {
    const socket = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });
    socket.remoteAddress = '127.0.0.1';
    const request = new http.IncomingMessage(socket);
    request.method = init.method || 'GET';
    request.url = route;
    request.headers = { host: 'forms.example.test' };
    for (const [name, value] of Object.entries(init.headers || {})) request.headers[name.toLowerCase()] = value;
    const body = init.body === undefined ? Buffer.alloc(0) : Buffer.from(String(init.body));
    if (body.length && request.headers['content-length'] === undefined) request.headers['content-length'] = String(body.length);
    const response = new http.ServerResponse(request);
    response.assignSocket(socket);
    const chunks = [];
    response.write = (chunk, encoding) => {
      if (chunk !== undefined && chunk !== null) chunks.push(Buffer.from(chunk, encoding));
      return true;
    };
    response.end = (chunk, encoding) => {
      if (chunk !== undefined && chunk !== null) chunks.push(Buffer.from(chunk, encoding));
      response.finished = true;
      response.emit('finish');
      return response;
    };
    response.on('finish', () => {
      const headers = response.getHeaders();
      resolve({
        status: response.statusCode,
        headers: { get(name) {
          const value = headers[String(name).toLowerCase()];
          return Array.isArray(value) ? value.join(', ') : value ?? null;
        } },
        text: async () => Buffer.concat(chunks).toString('utf8'),
      });
    });
    response.on('error', reject);
    request.push(body);
    request.push(null);
    app.handle(request, response, reject);
  });
}

function documentFor(html) {
  return new JSDOM(html).window.document;
}

async function browserPage(response) {
  const html = await response.text();
  return {
    html,
    document: documentFor(html),
    cookie: response.headers.get('set-cookie') && response.headers.get('set-cookie').split(';', 1)[0],
  };
}

function browserPost(server, route, body, cookie, headers = {}) {
  return server.request(route, {
    method: 'POST',
    headers: {
      Origin: ORIGIN,
      Cookie: cookie,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    body: body.toString(),
  });
}

function formValues(form, action) {
  const values = new URLSearchParams();
  for (const control of form.querySelectorAll('input, select, textarea')) {
    if (!control.name || control.disabled || (control.type === 'checkbox' && !control.checked)) continue;
    values.append(control.name, control.value);
  }
  if (action) values.set('_action', action);
  return values;
}

async function makeAliasServer(createApp) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lookie-theme-alias-server-'));
  const templatesPath = path.join(root, 'templates');
  const defaultRoot = path.join(root, 'default');
  fs.mkdirSync(templatesPath, { recursive: true });
  const registry = new TemplateRegistry({
    templatesPath,
    destinationIds: ['default'],
    clock: () => new Date('2026-09-21T12:00:00.000Z'),
    logger: { warn() {} },
  });
  await registry.createDraft({
    contractVersion: 1,
    resourceKind: 'form-template',
    templateId: 'training-log',
    ownerId: 'operator',
    revision: 1,
    grammarVersion: 1,
    destinationId: 'default',
    title: 'Training log',
    fields: [{ id: 'notes', type: 'long-text', label: 'Notes', required: true }],
  });
  const app = createApp({
    mappings: {},
    formsConfig: { enabled: true, templatesPath, destinations: { default: defaultRoot } },
    formsRegistry: registry,
    formsPublicOrigin: ORIGIN,
    formsAudit: () => {},
    formsAuthorize: () => true,
  });
  return {
    registry,
    request: (route, init) => inject(app, route, init),
    close: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('a builder save whose theme is an alias validates (container and template forms)', async () => {
  const { setThemeList, createApp } = freshServerModules();
  setThemeList([
    { slug: 'slate', label: 'Slate' },
    { slug: 'harbor-night', label: 'Harbor Night', aliases: ['old-harbor'] },
  ]);
  const server = await makeAliasServer(createApp);
  try {
    const configure = await browserPage(await server.request('/forms/training-log/configure'));
    const values = formValues(configure.document.querySelector('.builder-form'), 'save');
    values.set('theme', 'old-harbor');
    const saved = await browserPost(server, '/forms/training-log/configure', values, configure.cookie);
    assert.equal(saved.status, 200, 'a save whose theme is an alias is accepted, not refused');
    const after = await server.registry.getManagementTemplate('training-log');
    assert.equal(after.draft.presentation.theme, 'old-harbor', 'the alias is stored as given -- never rewritten to the canonical slug');

    // Same alias, through the container ("Group") builder body -- a distinct
    // validator (validContainerBuilderBody) with its own theme gate.
    await server.registry.createDraft({
      contractVersion: 1, resourceKind: 'form-template', templateId: 'fitness',
      ownerId: 'operator', revision: 1, grammarVersion: 1, title: 'Fitness', kind: 'container',
    });
    const containerConfigure = await browserPage(await server.request('/forms/fitness/configure'));
    const containerToken = (containerConfigure.html.match(/name="_csrf" value="([^"]+)"/) || [])[1];
    const containerValues = new URLSearchParams({
      _csrf: containerToken, _action: 'basics', revision: '1',
      title: 'Fitness', theme: 'old-harbor', themeMode: '',
    });
    const containerSaved = await browserPost(server, '/forms/fitness/configure', containerValues, containerConfigure.cookie);
    assert.equal(containerSaved.status, 303, 'a container save whose theme is an alias is accepted, not refused');
    const fitness = await server.registry.getManagementTemplate('fitness');
    assert.equal(fitness.draft.presentation.theme, 'old-harbor');
  } finally {
    setThemeList(null);
    await server.close();
  }
});

test('an unknown slug is still rejected by the builder validators (negative)', async () => {
  const { setThemeList, createApp } = freshServerModules();
  setThemeList([
    { slug: 'slate', label: 'Slate' },
    { slug: 'harbor-night', label: 'Harbor Night', aliases: ['old-harbor'] },
  ]);
  const server = await makeAliasServer(createApp);
  try {
    const configure = await browserPage(await server.request('/forms/training-log/configure'));
    const values = formValues(configure.document.querySelector('.builder-form'), 'save');
    values.set('theme', 'not-a-real-theme');
    const refused = await browserPost(server, '/forms/training-log/configure', values, configure.cookie);
    assert.equal(refused.status, 400);
    const unchanged = await server.registry.getManagementTemplate('training-log');
    assert.notEqual(unchanged.draft.presentation && unchanged.draft.presentation.theme, 'not-a-real-theme');
  } finally {
    setThemeList(null);
    await server.close();
  }
});

test('formProperties reports the theme for a template whose stored value is an alias', async () => {
  const { setThemeList, createApp } = freshServerModules();
  setThemeList([
    { slug: 'slate', label: 'Slate' },
    { slug: 'harbor-night', label: 'Harbor Night', aliases: ['old-harbor'] },
  ]);
  const server = await makeAliasServer(createApp);
  try {
    const before = await server.registry.getManagementTemplate('training-log');
    await server.registry.reviseDraft('training-log', before.draft.revision, {
      presentation: { theme: 'old-harbor' },
    });
    const page = await browserPage(await server.request('/forms/training-log'));
    const text = page.document.querySelector('.toolbar-properties').textContent;
    // The stored value is the (pre-rename) alias; Properties reports it as
    // installed via the theme's canonical label, since "old-harbor" itself
    // names nothing an author would recognize from the current picker.
    assert.match(text, /Harbor Night/, 'an aliased value is reported as installed, by its canonical label');
  } finally {
    setThemeList(null);
    await server.close();
  }
});
