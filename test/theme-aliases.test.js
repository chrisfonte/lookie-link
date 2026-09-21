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

  const { generateCustomThemeCss } = require('../lib/config');
  const css = generateCustomThemeCss([
    { slug: 'harbor-night', label: 'Harbor Night', aliases: ['old-harbor'], dark: { bg: '#0a0a1a', text: '#d8d8ff' }, light: {} },
  ]);
  assert.match(css, /:root\[data-color-scheme="old-harbor"\] \{/);
});
