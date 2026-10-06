'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');
const {youtubeSource, replaceYoutubeEmbeds} = require('../lib/youtube-player');
const base = 'https://www.youtube.com/embed/D8PikZ1KhUo';
test('clips preserve bounds but strip provider identity, arbitrary query and fragment', () => {
  assert.deepEqual(youtubeSource(base + '?start=02407&end=2425&origin=https://private.invalid&token=secret#private'), {
    src: base + '?start=2407&end=2425', watch: 'https://www.youtube.com/watch?v=D8PikZ1KhUo&t=2407s'
  });
  assert.equal(youtubeSource(base.replace('www.youtube.com','youtube-nocookie.com')).src, base.replace('www.youtube.com','www.youtube-nocookie.com'));
});
test('rejects arbitrary providers, credentials, invalid ids and ambiguous windows', () => {
  for (const url of ['javascript:alert(1)', base.replace('https:', 'http:'), base.replace('www.youtube.com', 'www.youtube.com.evil.test'), base.replace('www.youtube.com', 'user@www.youtube.com'), base + '/extra', base + '?start=-1', base + '?start=1&start=2', base + '?start=20&end=10', base + '?start=NaN']) assert.equal(youtubeSource(url), null, url);
});
test('transformation keeps fallback and safely treats authored titles as text', () => {
  const doc = new JSDOM(`<body><iframe title="&lt;img src=x onerror=alert(1)&gt;" src="${base}?start=10&amp;end=20"></iframe><iframe src="https://example.com/embed"></iframe><iframe src="${base}" srcdoc="hello"></iframe></body>`).window.document;
  replaceYoutubeEmbeds(doc);
  const link = doc.querySelector('[data-lookie-youtube]');
  assert.equal(link.href, 'https://www.youtube.com/watch?v=D8PikZ1KhUo&t=10s');
  assert.equal(link.querySelector('img'), null);
  assert.equal(doc.querySelectorAll('iframe').length, 2);
});
