'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, '..');
const cliPath = path.join(root, 'bin', 'lookie.js');
const fetchMockPath = path.join(__dirname, 'fixtures', 'cli-fetch-mock.js');

async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lookie-cli-test-'));
  const requestsPath = path.join(home, 'requests.jsonl');
  const stdoutPath = path.join(home, 'stdout.log');
  const stderrPath = path.join(home, 'stderr.log');
  return {
    home,
    requestsPath,
    env(overrides = {}) {
      return {
        ...process.env,
        HOME: home,
        NODE_OPTIONS: `--require=${fetchMockPath}`,
        LOOKIE_TEST_REQUESTS: requestsPath,
        LOOKIE_TEST_STDOUT: stdoutPath,
        LOOKIE_TEST_STDERR: stderrPath,
        ...overrides,
      };
    },
    async output(stream) {
      const outputPath = stream === 'stderr' ? stderrPath : stdoutPath;
      try {
        return await fs.readFile(outputPath, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') return '';
        throw error;
      }
    },
    async requests() {
      try {
        const text = await fs.readFile(requestsPath, 'utf8');
        return text.trim().split('\n').filter(Boolean).map(JSON.parse);
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
    },
    async close() {
      await fs.rm(home, { recursive: true, force: true });
    },
  };
}

async function run(args, options = {}) {
  return execFileAsync(process.execPath, [cliPath, ...args], {
    cwd: root,
    ...options,
  });
}

test('auth login reads a token from stdin without echo and stores mode 0600', async () => {
  const item = await fixture();
  const secret = 'stdin-only-token';
  try {
    const result = await run(['auth', 'login', '--instance', 'https://lookie.example.test/', '--token-stdin'], {
      env: item.env({ LOOKIE_LINK_TOKEN: '', LOOKIE_TEST_STDIN: `${secret}\n` }),
    });
    assert.doesNotMatch(result.stdout, new RegExp(secret));
    assert.doesNotMatch(await item.output('stdout'), new RegExp(secret));
    assert.doesNotMatch(await item.output('stderr'), new RegExp(secret));

    const authPath = path.join(item.home, '.config', 'lookie-link', 'auth.yaml');
    const stat = await fs.stat(authPath);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.match(await fs.readFile(authPath, 'utf8'), /lookie\.example\.test/);
  } finally {
    await item.close();
  }
});

test('base URL priority is flag, stored config, environment, then localhost', async () => {
  const item = await fixture();
  try {
    await run(['auth', 'login', '--instance', 'https://stored.example.test', '--token-stdin'], {
      env: item.env({ LOOKIE_LINK_TOKEN: '', LOOKIE_TEST_STDIN: 'stored-token\n' }),
    });
    await run(['whoami'], {
      env: item.env({ LOOKIE_LINK_BASE_URL: 'https://environment.example.test', LOOKIE_LINK_TOKEN: 'env-token' }),
    });
    await run(['--instance', 'https://flag.example.test', 'whoami'], {
      env: item.env({ LOOKIE_LINK_BASE_URL: 'https://environment.example.test', LOOKIE_LINK_TOKEN: 'env-token' }),
    });
    const requests = await item.requests();
    assert.equal(new URL(requests[0].url).host, 'stored.example.test');
    assert.equal(new URL(requests[1].url).host, 'flag.example.test');

    const empty = await fixture();
    try {
      await run(['whoami'], { env: empty.env({ LOOKIE_LINK_BASE_URL: '', LOOKIE_LINK_TOKEN: '' }) });
      assert.equal(new URL((await empty.requests())[0].url).origin, 'http://localhost:9876');
    } finally {
      await empty.close();
    }
  } finally {
    await item.close();
  }
});

test('requests prefer Authorization headers and never put tokens in URLs', async () => {
  const item = await fixture();
  const secret = 'header-only-token';
  try {
    await run(['--base-url', 'https://lookie.example.test', 'whoami'], {
      env: item.env({ LOOKIE_LINK_TOKEN: secret }),
    });
    const [request] = await item.requests();
    assert.equal(request.authorization, `Bearer ${secret}`);
    assert.doesNotMatch(request.url, new RegExp(secret));
    assert.equal(new URL(request.url).search, '');
  } finally {
    await item.close();
  }
});

test('capabilities falls back to whoami for older instances', async () => {
  const item = await fixture();
  try {
    const result = await run(['--instance', 'https://lookie.example.test', 'capabilities'], {
      env: item.env({ LOOKIE_LINK_TOKEN: 'fallback-token', LOOKIE_TEST_SCENARIO: 'capability-fallback' }),
    });
    const payload = JSON.parse(await item.output('stdout'));
    assert.equal(payload.source, '/api/whoami');
    assert.equal(payload.capabilities.read, true);
    assert.deepEqual((await item.requests()).map((request) => new URL(request.url).pathname), [
      '/.well-known/agent.json',
      '/api/whoami',
    ]);
  } finally {
    await item.close();
  }
});

test('conflicts use exit code 5 and secrets are redacted from errors', async () => {
  const item = await fixture();
  const secret = 'never-log-this-token';
  try {
    await assert.rejects(
      run(['--instance', 'https://lookie.example.test', 'write', 'notes/file.md', '--content', 'update'], {
        env: item.env({ LOOKIE_LINK_TOKEN: secret, LOOKIE_TEST_SCENARIO: 'conflict' }),
      }),
      (error) => {
        assert.equal(error.code, 5);
        return true;
      }
    );
    const stderr = await item.output('stderr');
    assert.match(stderr, /\[redacted\]/);
    assert.doesNotMatch(stderr, new RegExp(secret));
    assert.doesNotMatch(await item.output('stdout'), new RegExp(secret));
  } finally {
    await item.close();
  }
});

test('transport failures do not log configured tokens', async () => {
  const item = await fixture();
  const secret = 'transport-secret-token';
  try {
    await assert.rejects(
      run(['--instance', 'https://lookie.example.test', 'repos'], {
        env: item.env({ LOOKIE_LINK_TOKEN: secret, LOOKIE_TEST_SCENARIO: 'transport-error' }),
      }),
      (error) => {
        assert.equal(error.code, 6);
        return true;
      }
    );
    const stderr = await item.output('stderr');
    assert.doesNotMatch(stderr, new RegExp(secret));
    assert.match(stderr, /\[redacted\]/);
  } finally {
    await item.close();
  }
});

test('core CLI commands map to their HTTP endpoints without socket access', async () => {
  const item = await fixture();
  const publishFile = path.join(item.home, 'artifact.bin');
  await fs.writeFile(publishFile, Buffer.from([0, 1, 2, 3]));
  const env = item.env({ LOOKIE_LINK_TOKEN: 'command-token', LOOKIE_LINK_BASE_URL: 'https://lookie.example.test' });
  try {
    const commands = [
      ['whoami'],
      ['repos'],
      ['read', 'notes/file.md'],
      ['tree', 'notes', '--path', 'folder', '--max-depth', '2'],
      ['changes', 'notes', '--since', '2026-01-01T00:00:00Z'],
      ['write', 'notes/file.md', '--content', 'new text', '--expected-mtime', '100'],
      ['delete', 'notes/file.md'],
      ['search', 'query text', '--scope', 'notes'],
      ['search', 'suggest', 'que'],
      ['publish', publishFile, '--slug', 'artifact'],
      ['publish', publishFile, '--slug', 'artifact', '--expected-revision', '1'],
      ['publish', 'revoke', 'artifact', '--reason', 'expired'],
    ];
    for (const args of commands) await run(args, { env });
    const requests = await item.requests();
    assert.deepEqual(requests.map(({ method }) => method), [
      'GET', 'GET', 'GET', 'GET', 'GET', 'PUT', 'DELETE', 'GET', 'GET', 'POST', 'POST', 'POST',
    ]);
    assert.equal(new URL(requests[9].url).pathname, '/api/publish');
    assert.equal(new URL(requests[10].url).pathname, '/api/publish/artifact');
    assert.equal(new URL(requests[11].url).pathname, '/api/publish/artifact/revoke');
    assert.equal(JSON.parse(requests[9].body).files[0].encoding, 'base64');
  } finally {
    await item.close();
  }
});
