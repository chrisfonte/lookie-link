#!/usr/bin/env node
'use strict';

// Naive-user query battery for /api/search (2026-09-23).
//
// Runs the queries a person types without reading the docs and refuses (exit 1)
// when the surface answers them badly. Every case must either work or refuse
// with a named error; a silent empty result or a silent clamp is a failure.
// Point it at any instance:  node scripts/search-battery.js http://127.0.0.1:9876
// Optional: LOOKIE_TOKEN=... for a bearer; TERM_A/TERM_B override the two words
// (defaults are words that occur in this project's own docs).

const base = (process.argv[2] || process.env.LOOKIE_URL || 'http://127.0.0.1:9876').replace(/\/$/, '');
const a = process.env.TERM_A || 'search';
const b = process.env.TERM_B || 'scope';
const headers = process.env.LOOKIE_TOKEN ? { authorization: `Bearer ${process.env.LOOKIE_TOKEN}` } : {};

async function search(qs) {
  const res = await fetch(`${base}/api/search?${qs}`, { headers });
  let body = null;
  try { body = await res.json(); } catch (_) { body = null; }
  return { status: res.status, body };
}

const cases = [
  ['two words in either order give the same files', async () => {
    const x = await search(`q=${a}+${b}&limit=100`);
    const y = await search(`q=${b}+${a}&limit=100`);
    if (x.status !== 200 || y.status !== 200) return `status ${x.status}/${y.status}`;
    const key = (r) => r.results.map((f) => `${f.repo}/${f.path}`).sort().join('\n');
    if (x.body.count === 0) return `no results for "${a} ${b}" (choose TERM_A/TERM_B that co-occur)`;
    return key(x.body) === key(y.body) ? null : `different files for reversed order (${x.body.count} vs ${y.body.count})`;
  }],
  ['a quoted phrase is not searched with its quote characters', async () => {
    const r = await search(`q=%22${a}+${b}%22`);
    if (r.status !== 200) return `status ${r.status}`;
    const terms = r.body.terms;
    if (!Array.isArray(terms)) return 'response does not echo terms';
    return terms.some((t) => t.includes('"')) ? 'quote characters survived into a term' : null;
  }],
  ['a misspelled scope is refused, not an empty result', async () => {
    const r = await search(`q=${a}&scope=no-such-repo-zz`);
    return r.status === 400 && r.body && r.body.error && r.body.error.code ? null : `status ${r.status} (expected 400 with error.code)`;
  }],
  ['limit=0 is refused, not clamped', async () => {
    const r = await search(`q=${a}&limit=0`);
    return r.status === 400 ? null : `status ${r.status}, count=${r.body && r.body.count}`;
  }],
  ['an unknown parameter is refused', async () => {
    const r = await search(`q=${a}&repos=x`);
    return r.status === 400 ? null : `status ${r.status}`;
  }],
  ['an empty query is refused', async () => {
    const r = await search('q=%20');
    return r.status === 400 ? null : `status ${r.status}`;
  }],
  ['every result carries totalMatches and backend', async () => {
    const r = await search(`q=${a}&limit=3`);
    if (r.status !== 200) return `status ${r.status}`;
    return typeof r.body.totalMatches === 'number' && typeof r.body.backend === 'string' ? null : 'missing totalMatches or backend';
  }],
];

(async () => {
  let failed = 0;
  for (const [name, run] of cases) {
    let problem;
    try { problem = await run(); } catch (error) { problem = error.message; }
    console.log(`${problem ? 'FAIL' : 'ok  '}  ${name}${problem ? `  — ${problem}` : ''}`);
    if (problem) failed += 1;
  }
  console.log(failed ? `${failed} of ${cases.length} battery cases failed against ${base}` : `battery clean against ${base}`);
  process.exit(failed ? 1 : 0);
})();
