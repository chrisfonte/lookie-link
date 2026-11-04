'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// A fresh process isolates both the config cache and the operator's environment.
// Run the real loader with empty home/project search roots, while resolving its
// dependencies from the checkout. No config file is supplied to the default case.
function isolatedLoader(t, assertions) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lookie-no-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configFile = path.resolve(__dirname, '../lib/config.js');
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('LOOKIE_LINK_') || ['PORT', 'HOSTNAME', 'ROOT_MAPPINGS'].includes(key)) delete env[key];
  }
  const script = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { createRequire } = require('node:module');
    const { compileFunction } = require('node:vm');
    const root = ${JSON.stringify(root)};
    os.homedir = () => path.join(root, 'home');
    const loaderPath = ${JSON.stringify(configFile)};
    const isolated = { exports: {} };
    compileFunction(fs.readFileSync(loaderPath, 'utf8'),
      ['require', 'module', 'exports', '__dirname'], { filename: loaderPath })(
      createRequire(loaderPath), isolated, isolated.exports, path.join(root, 'lib'));
    const config = isolated.exports;
    ${assertions}
  `;
  const result = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
}

test('missing config uses defaults on first load and reload in a clean process', (t) => {
  isolatedLoader(t, `
    assert.equal(fs.existsSync(path.join(root, 'lookie-link.yaml')), false);
    assert.equal(config.getPort(), 9876);
    assert.equal(config.getHostname(), 'localhost');
    assert.deepEqual(config.loadRootMappings(), {});
    assert.equal(config.getEditingEnabled(), false);
    assert.equal(config.getAnnotationsEnabled(), false);
    assert.equal(config.getRawHtmlEnabled(), false);
    assert.equal(config.getConfigPath(), null);
    assert.equal(config.getAppearanceOverlayPath(), null);
    assert.equal(config.readAppearanceOverlay(), null);
    assert.deepEqual(config.reloadConfig(), {});
    assert.equal(config.getPort(), 9876);
  `);
});

test('overlay path lookup before config loading does not require a config file', (t) => {
  isolatedLoader(t, `
    assert.equal(config.getAppearanceOverlayPath(), null);
    const overlay = path.join(root, 'custom-appearance.yaml');
    fs.writeFileSync(overlay, 'themes:\\n  example:\\n    label: Example\\n');
    process.env.LOOKIE_LINK_APPEARANCE_OVERLAY = overlay;
    assert.equal(config.getAppearanceOverlayPath(), overlay);
    assert.equal(config.reloadConfig().themes.example.label, 'Example');
    assert.equal(config.getPort(), 9876);
  `);
});

test('removing the selected config drops its sibling overlay on reload', (t) => {
  isolatedLoader(t, `
    const file = path.join(root, 'lookie-link.yaml');
    fs.writeFileSync(file, 'server:\\n  port: 1234\\n');
    fs.writeFileSync(path.join(root, 'appearance.yaml'), 'themes:\\n  example:\\n    label: Example\\n');
    assert.equal(config.getPort(), 1234);
    assert.equal(config.reloadConfig().themes.example.label, 'Example');
    fs.unlinkSync(file);
    assert.deepEqual(config.reloadConfig(), {});
    assert.equal(config.getConfigPath(), null);
    assert.equal(config.getAppearanceOverlayPath(), null);
    assert.equal(config.getPort(), 9876);
  `);
});
