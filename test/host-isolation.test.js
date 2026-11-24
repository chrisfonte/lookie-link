'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// The suite must never see the host's Lookie-Link config, home directory or
// exported LOOKIE_LINK_* settings. test/helpers/host-isolation.js arranges that
// and every npm test script and CI step preloads it. This file fails when the
// suite is started without it, instead of silently reading host config.

const MARKER = 'LOOKIE_TEST_ISOLATED_HOME';
const HOW = 'run the suite with `npm test` (or `node --require ./test/helpers/host-isolation.js --test test/*.test.js`)';

test('the suite runs with an isolated home and config', () => {
  assert.ok(process.env[MARKER], `host isolation is not loaded: ${HOW}`);
  assert.equal(os.homedir(), process.env[MARKER]);
  assert.ok(
    path.resolve(os.homedir()).startsWith(fs.realpathSync(os.tmpdir()) + path.sep),
    'the isolated home lives under the OS temp directory'
  );
  for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']) {
    assert.ok(process.env[key].startsWith(os.homedir() + path.sep), `${key} is inside the isolated home`);
  }
  assert.equal(fs.existsSync(path.join(os.homedir(), '.config', 'lookie-link')), false);
});

test('the default config is the empty isolated config, never a home or checkout file', () => {
  const config = require('../lib/config');
  const configPath = config.getConfigPath() || (config.reloadConfig(), config.getConfigPath());
  assert.equal(configPath, process.env.LOOKIE_LINK_CONFIG);
  assert.ok(configPath.startsWith(path.dirname(os.homedir()) + path.sep));
  assert.deepEqual(config.reloadConfig(), {});
  assert.equal(config.getPort(), 9876);
  assert.deepEqual(config.loadRootMappings(), {});
});

test('host LOOKIE_LINK_* and legacy overrides do not reach the suite', () => {
  for (const key of Object.keys(process.env)) {
    if (key === 'LOOKIE_LINK_CONFIG') continue;
    assert.equal(key.startsWith('LOOKIE_LINK_'), false, `${key} leaked from the host`);
  }
  for (const key of ['PORT', 'HOSTNAME', 'ROOT_MAPPINGS']) {
    assert.equal(process.env[key], undefined, `${key} leaked from the host`);
  }
});

test('the preload isolates a run that starts with a decoy host home', (t) => {
  const decoy = fs.mkdtempSync(path.join(os.tmpdir(), 'lookie-decoy-host-'));
  t.after(() => fs.rmSync(decoy, { recursive: true, force: true }));
  const decoyConfigDir = path.join(decoy, '.config', 'lookie-link');
  fs.mkdirSync(decoyConfigDir, { recursive: true });
  fs.writeFileSync(path.join(decoyConfigDir, 'lookie-link.yaml'), 'server:\n  port: 1234\n');
  const env = { ...process.env, HOME: decoy, USERPROFILE: decoy, LOOKIE_LINK_ENABLE_EDITING: 'true' };
  for (const key of [MARKER, 'LOOKIE_LINK_CONFIG', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']) {
    delete env[key];
  }
  const script = `
    const config = require(${JSON.stringify(path.resolve(__dirname, '../lib/config'))});
    process.stdout.write(JSON.stringify({
      home: require('node:os').homedir(),
      port: config.getPort(),
      editing: config.getEditingEnabled(),
    }));
  `;
  const result = spawnSync(process.execPath, [
    '--require', path.resolve(__dirname, 'helpers/host-isolation.js'), '-e', script,
  ], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout.trim().split('\n').pop());
  assert.notEqual(observed.home, decoy);
  assert.equal(observed.port, 9876);
  assert.equal(observed.editing, false);
});
