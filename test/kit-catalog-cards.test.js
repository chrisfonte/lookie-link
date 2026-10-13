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

// rule body for a selector, e.g. rule('.pill.muted') -> 'background:...;color:...'
function rule(selector) {
  const at = css.indexOf(selector + '{');
  assert.ok(at >= 0, `missing rule ${selector}`);
  return css.slice(at + selector.length + 1, css.indexOf('}', at));
}

test('kit.css ships the catalog card parts with their working properties', () => {
  assert.match(rule('.gallery.catalog figure'), /display:flex/);
  assert.match(rule('.gallery.catalog .photo-strip'), /display:flex/);
  assert.match(rule('.gallery.catalog .photo-strip img'), /height:64px/);
  assert.match(rule('.gallery.catalog figcaption .meta'), /font-size:12px/);
  assert.match(rule('.gallery.catalog figcaption blockquote'), /border-left:3px solid var\(--accent\)/);
  assert.match(rule('.gallery.catalog figure[id]'), /scroll-margin-top:64px/);
  assert.match(rule('.gallery.catalog figure:target'), /outline:3px solid var\(--accent\)/);
  assert.match(rule('.pill.muted'), /background:var\(--surface-2\);color:var\(--muted\)/);
});

test('catalog rules are opt-in: every v1.29 gallery selector is scoped to .gallery.catalog', () => {
  const end = css.indexOf('/* end v1.29 catalog cards */');
  assert.ok(end > 0, 'end-of-block marker missing');
  const block = css.slice(css.indexOf('/* v1.29 catalog cards'), end)
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors = [...block.matchAll(/(^|\n)([^/\n{][^{]*)\{/g)].flatMap((m) => m[2].split(','));
  assert.ok(selectors.length >= 10);
  for (const sel of selectors) assert.ok(sel.trim().startsWith('.gallery.catalog'), `unscoped selector: ${sel}`);
  assert.ok(css.includes('.gallery img{width:100%;height:170px;object-fit:cover;display:block;background:var(--surface-2)}'));
  assert.ok(css.includes('.gallery figcaption{padding:8px 10px;font-size:12px;color:var(--muted)}'));
});

test('showcase catalog demo: every zoom link has a lightbox target, every image has alt text', () => {
  const start = examples.indexOf('id="catalog-demo"');
  assert.ok(start > 0, 'catalog demo section missing');
  const section = examples.slice(start, examples.indexOf('<h2', start + 1));
  const zooms = [...section.matchAll(/<a\b[^>]*class="photo-zoom"[^>]*>/g)].map((m) => m[0]);
  const hrefs = zooms.map((a) => (a.match(/href="#([^"]+)"/) || [])[1]);
  assert.ok(hrefs.every(Boolean), 'zoom link without a fragment href');
  assert.ok(hrefs.length >= 5, 'expected lead photos and strip photos');
  for (const id of hrefs) {
    const box = section.match(new RegExp(`<a\\b[^>]*id="${id}"[^>]*>\\s*<img src="[^"]*"[^>]*>`));
    assert.ok(box && box[0].includes('class="photo-lightbox"'), `no lightbox for #${id}`);
    assert.ok(box[0].includes('aria-hidden="true"'), `lightbox #${id} image is not aria-hidden`);
  }
  for (const a of zooms) {
    const img = section.slice(section.indexOf(a) + a.length).match(/^\s*<img src="[^"]*"[^>]*>/);
    assert.ok(img, `zoom link without an image: ${a}`);
    assert.match(img[0], / alt="[^"]+"/, 'thumbnail without alt text');
  }
  assert.ok(section.includes('class="photo-strip"') && section.includes('pill muted') && section.includes('class="pending"'));
  for (const box of section.matchAll(/<a\b[^>]*class="photo-lightbox"[^>]*>/g)) {
    const close = (box[0].match(/href="#([^"]+)"/) || [])[1];
    assert.ok(close && section.includes(`<figure id="${close}">`), `lightbox closes to missing card #${close}`);
  }
  for (const m of section.matchAll(/<a href="#([^"]+)">/g)) assert.ok(section.includes(`<figure id="${m[1]}">`), `deep link #${m[1]} has no card`);
});
