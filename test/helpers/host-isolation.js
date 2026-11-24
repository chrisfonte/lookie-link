'use strict';

// Host isolation for the test suite.
//
// Lookie-Link reads its operator config from LOOKIE_LINK_CONFIG, then
// ~/.config/lookie-link/lookie-link.yaml, then a lookie-link.yaml in the
// checkout root; the CLI reads ~/.config/lookie-link/auth.yaml; kits, peaks and
// caches default under the home directory; and several LOOKIE_LINK_* variables
// change behaviour. Without isolation, a developer's real config (or a stray
// exported variable) changes test results, so the suite passes on one machine
// and fails on another or in CI.
//
// Every test entry point loads this module first (`node --require` in the npm
// scripts and CI, an import at the top of each browser spec). It:
//   - points HOME, USERPROFILE and the XDG base directories at a fresh
//     temporary directory, so os.homedir() and ~ expansion never reach the
//     real home;
//   - removes inherited LOOKIE_LINK_* and the legacy PORT, HOSTNAME and
//     ROOT_MAPPINGS overrides;
//   - points LOOKIE_LINK_CONFIG at an empty config inside that directory, so
//     no fallback candidate (home or checkout root) is ever consulted. Tests
//     that need config still set LOOKIE_LINK_CONFIG to their own fixture;
//   - keeps Playwright pointed at the browsers installed under the real home.
//
// Child processes inherit the isolated environment. A nested load (for example
// a `node --test` child of an isolated runner) reuses the parent's directory.
// test/host-isolation.test.js fails when the suite runs without this module.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MARKER = 'LOOKIE_TEST_ISOLATED_HOME';
const STRIPPED_KEYS = new Set(['PORT', 'HOSTNAME', 'ROOT_MAPPINGS']);

function defaultPlaywrightBrowsersPath(env, realHome) {
  if (process.platform === 'darwin') return path.join(realHome, 'Library', 'Caches', 'ms-playwright');
  if (process.platform === 'win32') {
    return path.join(env.LOCALAPPDATA || path.join(realHome, 'AppData', 'Local'), 'ms-playwright');
  }
  return path.join(env.XDG_CACHE_HOME || path.join(realHome, '.cache'), 'ms-playwright');
}

function isolate() {
  const env = process.env;
  const inherited = env[MARKER];
  if (inherited && env.HOME === inherited && fs.existsSync(inherited)) {
    return inherited;
  }

  if (!env.PLAYWRIGHT_BROWSERS_PATH) {
    env.PLAYWRIGHT_BROWSERS_PATH = defaultPlaywrightBrowsersPath(env, os.homedir());
  }

  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lookie-test-host-')));
  const home = path.join(root, 'home');
  const dirs = {
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  const configDir = path.join(root, 'config');
  fs.mkdirSync(configDir);
  const configFile = path.join(configDir, 'lookie-link.yaml');
  fs.writeFileSync(configFile, '# Empty config written by test/helpers/host-isolation.js\n{}\n');

  for (const key of Object.keys(env)) {
    if (key.startsWith('LOOKIE_LINK_') || STRIPPED_KEYS.has(key)) delete env[key];
  }
  env.HOME = home;
  env.USERPROFILE = home;
  Object.assign(env, dirs);
  env.LOOKIE_LINK_CONFIG = configFile;
  env[MARKER] = home;

  process.on('exit', () => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Best effort: a leftover directory under the OS temp dir is harmless.
    }
  });
  return home;
}

module.exports = { isolatedHome: isolate(), MARKER };
