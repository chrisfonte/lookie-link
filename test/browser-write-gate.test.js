'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createBrowserWriteGate } = require('../lib/browser-write-gate');

const ORIGIN = 'https://lookie.example.test';

async function setup(t, options = {}) {
  const audits = [];
  const gate = createBrowserWriteGate({ publicOrigins: [ORIGIN], audit: (event, req, details) => audits.push(details), ...options });
  const app = express();
  app.get('/context', (req, res) => res.json({ csrf: gate.issueContext(req, res), again: gate.tokenFor(req) }));
  app.all('/guarded', (req, res) => {
    if (!gate.check(req, res, { mutation: req.method !== 'GET', type: 'markers.test' })) return;
    res.json({ ok: true });
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function context() {
    const response = await fetch(`${base}/context`);
    const cookie = response.headers.get('set-cookie');
    return { cookie: cookie.split(';')[0], setCookie: cookie, csrf: (await response.json()).csrf };
  }
  async function post(headers) {
    const response = await fetch(`${base}/guarded`, { method: 'POST', headers });
    return { status: response.status, body: await response.json() };
  }
  return { gate, audits, base, context, post };
}

test('issueContext sets an HttpOnly SameSite=Lax cookie, Secure when every origin is https', async (t) => {
  const { context } = await setup(t);
  const { setCookie } = await context();
  assert.match(setCookie, /^lookie_markers_context=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Path=\//);
  assert.match(setCookie, /Secure/);
});

test('cookie is not Secure for http origins and the context is reused', async (t) => {
  const { context, base } = await setup(t, { publicOrigins: ['http://127.0.0.1:9999'] });
  const first = await context();
  assert.doesNotMatch(first.setCookie, /Secure/);
  const again = await fetch(`${base}/context`, { headers: { cookie: first.cookie } });
  assert.equal(again.headers.get('set-cookie'), null);
  const body = await again.json();
  assert.equal(body.csrf, first.csrf);
  assert.equal(body.again, first.csrf);
});

test('happy path: matching Origin, cookie and token', async (t) => {
  const { context, post } = await setup(t);
  const { cookie, csrf } = await context();
  const result = await post({ origin: ORIGIN, cookie, 'x-csrf-token': csrf });
  assert.deepEqual(result, { status: 200, body: { ok: true } });
  const viaReferer = await post({ referer: `${ORIGIN}/view/page`, cookie, 'x-csrf-token': csrf });
  assert.equal(viaReferer.status, 200);
});

test('origin rejected: missing, mismatched, or disagreeing headers', async (t) => {
  const { context, post, audits } = await setup(t);
  const { cookie, csrf } = await context();
  for (const headers of [
    { cookie, 'x-csrf-token': csrf },
    { origin: 'https://other.example.test', cookie, 'x-csrf-token': csrf },
    { origin: ORIGIN, referer: 'https://other.example.test/x', cookie, 'x-csrf-token': csrf },
  ]) {
    const result = await post(headers);
    assert.equal(result.status, 403);
    assert.equal(result.body.error.code, 'origin_rejected');
  }
  assert.equal(audits.at(-1).outcome, 'rejected_origin');
});

test('no configured origin refuses every browser mutation', async (t) => {
  const { context, post } = await setup(t, { publicOrigins: [] });
  const { cookie, csrf } = await context();
  assert.equal((await post({ origin: ORIGIN, cookie, 'x-csrf-token': csrf })).body.error.code, 'origin_rejected');
});

test('csrf rejected: missing token, wrong token, unknown context', async (t) => {
  const { context, post, audits } = await setup(t);
  const { cookie, csrf } = await context();
  for (const headers of [
    { origin: ORIGIN, cookie },
    { origin: ORIGIN, cookie, 'x-csrf-token': `${csrf}x` },
    { origin: ORIGIN, cookie: 'lookie_markers_context=unknown', 'x-csrf-token': csrf },
    { origin: ORIGIN },
  ]) {
    const result = await post(headers);
    assert.equal(result.status, 403);
    assert.equal(result.body.error.code, 'csrf_rejected');
  }
  assert.equal(audits.at(-1).outcome, 'rejected_csrf');
});

test('bearer skips Origin and CSRF; bearer plus context cookie is ambiguous', async (t) => {
  const { context, post } = await setup(t);
  assert.equal((await post({ authorization: 'Bearer token-value' })).status, 200);
  const { cookie, csrf } = await context();
  const ambiguous = await post({ authorization: 'Bearer token-value', cookie, origin: ORIGIN, 'x-csrf-token': csrf });
  assert.equal(ambiguous.status, 400);
  assert.equal(ambiguous.body.error.code, 'ambiguous_credentials');
  assert.equal((await post({ authorization: 'Bearer ' })).status, 403);
});

test('GETs skip the origin and token checks', async (t) => {
  const { base } = await setup(t);
  const response = await fetch(`${base}/guarded`);
  assert.equal(response.status, 200);
});

test('the context map is capped at 10000', async (t) => {
  const contexts = new Map();
  const { gate } = await setup(t, { contexts });
  const res = { append() {} };
  for (let i = 0; i < 10005; i += 1) gate.issueContext({ get: () => null }, res);
  assert.equal(contexts.size, 10000);
});
