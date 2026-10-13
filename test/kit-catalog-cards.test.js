'use strict';
// Ops kit catalog cards (v1.29): the component ships, stays opt-in, and the showcase example
// wires every thumbnail to a lightbox target that exists.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const KIT = path.join(__dirname, '..', 'kits', 'ops');
const css = fs.readFileSync(path.join(KIT, 'kit.css'), 'utf8');
const examples = fs.readFileSync(path.join(KIT, 'EXAMPLES.html'), 'utf8');

test('kit.css ships the catalog card parts and the neutral pill', () => {
  for (const selector of ['.gallery.catalog figure', '.gallery .photo-strip', '.gallery .photo-strip img',
    '.gallery.catalog figcaption', '.gallery figcaption .meta', '.gallery figcaption blockquote', '.pill.muted',
    '.gallery.catalog figure[id]', '.gallery.catalog figure:target']) {
    assert.ok(css.includes(selector + '{'), `missing rule ${selector}`);
  }
});

test('catalog rules are opt-in: plain gallery rules are unchanged', () => {
  assert.ok(css.includes('.gallery img{width:100%;height:170px;object-fit:cover;display:block;background:var(--surface-2)}'));
  assert.ok(css.includes('.gallery figcaption{padding:8px 10px;font-size:12px;color:var(--muted)}'));
});

test('showcase catalog demo: every zoom link has a lightbox target, every image has alt text', () => {
  const start = examples.indexOf('id="catalog-demo"');
  assert.ok(start > 0, 'catalog demo section missing');
  const section = examples.slice(start, examples.indexOf('<h2', start + 1));
  const hrefs = [...section.matchAll(/class="photo-zoom" href="#([^"]+)"/g)].map((m) => m[1]);
  assert.ok(hrefs.length >= 5, 'expected lead photos and strip photos');
  for (const id of hrefs) assert.ok(section.includes(`id="${id}" class="photo-lightbox"`), `no lightbox for #${id}`);
  for (const img of section.matchAll(/<a class="photo-zoom"[^>]*><img src="[^"]*"[^>]*>/g)) {
    assert.match(img[0], / alt="[^"]+"/, 'thumbnail without alt text');
  }
  assert.ok(section.includes('class="photo-strip"') && section.includes('pill muted') && section.includes('class="pending"'));
  for (const m of section.matchAll(/<a href="#([^"]+)">/g)) assert.ok(section.includes(`<figure id="${m[1]}">`), `deep link #${m[1]} has no card`);
});
