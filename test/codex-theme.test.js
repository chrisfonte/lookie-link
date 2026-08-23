const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { BUILT_IN_THEMES } = require('../lib/config');
const { getThemeList, setThemeList } = require('../lib/renderer');
const { transformEmbedHtml } = require('../lib/embed-html');

const stylesheet = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');

function channel(value) {
  const linear = value / 255;
  return linear <= 0.04045 ? linear / 12.92 : ((linear + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const parts = hex.slice(1).match(/.{2}/g).map((part) => Number.parseInt(part, 16));
  return 0.2126 * channel(parts[0]) + 0.7152 * channel(parts[1]) + 0.0722 * channel(parts[2]);
}

function contrast(a, b) {
  const [bright, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (bright + 0.05) / (dark + 0.05);
}

test('Codex is a reserved built-in theme with a renderer fallback label', () => {
  assert.ok(BUILT_IN_THEMES.includes('codex'));
  setThemeList(null);
  assert.deepEqual(getThemeList().find((theme) => theme.slug === 'codex'), {
    slug: 'codex',
    label: 'Codex',
  });
});

test('Codex dark and light palettes expose the complete viewer contract', () => {
  const dark = stylesheet.match(/:root\[data-color-scheme="codex"\]\s*\{([^}]*)\}/)?.[1] || '';
  const light = stylesheet.match(/:root\[data-color-scheme="codex"\]\[data-theme="light"\]\s*\{([^}]*)\}/)?.[1] || '';
  const required = [
    'bg', 'bg-elev', 'bg-code', 'text', 'text-soft', 'accent', 'border', 'link',
    'page-bg', 'toolbar-bg', 'toolbar-btn-bg', 'toolbar-btn-hover',
    'toolbar-btn-text', 'toc-active-bg', 'heading-font',
  ];
  for (const property of required) {
    assert.match(dark, new RegExp(`--${property}:`), `dark palette omits --${property}`);
    assert.match(light, new RegExp(`--${property}:`), `light palette omits --${property}`);
  }
  assert.match(stylesheet, /data-color-scheme="codex"\] \[data-theme-name="codex"\]/);
});

test('Codex primary text and links meet WCAG AA contrast on their base surfaces', () => {
  assert.ok(contrast('#dfdfdf', '#181818') >= 4.5);
  assert.ok(contrast('#8db5ff', '#181818') >= 4.5);
  assert.ok(contrast('#1a1c1f', '#ffffff') >= 4.5);
  assert.ok(contrast('#005fb8', '#ffffff') >= 4.5);
});

test('Codex palette reaches theme-following authored HTML and hostile schemes fall back', () => {
  const options = {
    repo: 'docs',
    rootPath: path.join(__dirname, '..'),
    relativePath: 'docs/example.html',
    mappings: { docs: path.join(__dirname, '..') },
    canAccess: () => true,
  };
  const html = transformEmbedHtml('<main data-lookie-follow-theme>Theme me</main>', {
    ...options,
    themeMode: 'dark',
    themeScheme: 'codex',
  });
  assert.match(html, /data-color-scheme="codex"/);
  assert.match(html, /:root\[data-color-scheme="codex"\][^}]*--lookie-bg: #181818/);

  const hostile = transformEmbedHtml('<p>Safe</p>', {
    ...options,
    themeMode: 'dark',
    themeScheme: 'codex\" onload=alert(1)',
  });
  assert.match(hostile, /data-color-scheme="slate"/);
  assert.doesNotMatch(hostile, /onload=alert/);
});
