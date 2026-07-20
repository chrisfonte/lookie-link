'use strict';

const fs = require('node:fs');

function captureWrite(stream, outputPath) {
  if (!outputPath) return;
  const original = stream.write.bind(stream);
  stream.write = (chunk, encoding, callback) => {
    fs.appendFileSync(outputPath, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), encoding || 'utf8'));
    return original(chunk, encoding, callback);
  };
}

captureWrite(process.stdout, process.env.LOOKIE_TEST_STDOUT);
captureWrite(process.stderr, process.env.LOOKIE_TEST_STDERR);

if (Object.prototype.hasOwnProperty.call(process.env, 'LOOKIE_TEST_STDIN')) {
  process.stdin[Symbol.asyncIterator] = async function* stdinFixture() {
    yield Buffer.from(process.env.LOOKIE_TEST_STDIN, 'utf8');
  };
}

global.fetch = async (input, init = {}) => {
  const url = String(input);
  const headers = new Headers(init.headers || {});
  const request = {
    url,
    method: init.method || 'GET',
    authorization: headers.get('authorization'),
    body: init.body || null,
  };
  if (process.env.LOOKIE_TEST_REQUESTS) {
    fs.appendFileSync(process.env.LOOKIE_TEST_REQUESTS, `${JSON.stringify(request)}\n`, 'utf8');
  }

  const token = process.env.LOOKIE_LINK_TOKEN || '';
  const scenario = process.env.LOOKIE_TEST_SCENARIO || 'success';
  if (scenario === 'transport-error') {
    throw new Error(`request failed with ${token}`);
  }
  if (scenario === 'conflict') {
    return new Response(JSON.stringify({ error: `stale write rejected for ${token}` }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (scenario === 'capability-fallback' && url.endsWith('/.well-known/agent.json')) {
    return new Response(JSON.stringify({ error: 'not available' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (url.includes('/files/')) {
    return new Response(JSON.stringify({ ok: true, content: 'mock content', lastModified: 100 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (url.endsWith('/api/whoami')) {
    return new Response(JSON.stringify({
      ok: true,
      subject: { agentId: 'test-agent' },
      capabilities: { read: true, publish: true, share: false },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
