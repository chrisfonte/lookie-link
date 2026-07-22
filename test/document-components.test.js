'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const STYLESHEET = path.join(__dirname, '..', 'public', 'style.css');
const SECTION_MARKER = 'Document components';

// Components a rendered document may use. Names match the Ops HTML Kit so the
// vocabulary is shared rather than forked.
const COMPONENTS = [
  'eyebrow', 'lead', 'grid-2', 'grid-3', 'card', 'tile', 'stat',
  'callout', 'badges', 'badge', 'pill', 'chip', 'scorebar', 'timeline',
];

function documentComponentSection() {
  const css = fs.readFileSync(STYLESHEET, 'utf8');
  const marker = css.indexOf(SECTION_MARKER);
  assert.notEqual(marker, -1, `stylesheet must contain the "${SECTION_MARKER}" section`);
  // Start at the opening of the comment block that introduces the section, not at
  // the marker itself -- slicing mid-comment leaves an unterminated /* that the
  // comment stripper cannot match, so prose leaks into the selector parsing.
  const start = css.lastIndexOf('/*', marker);
  return css.slice(start === -1 ? marker : start);
}

test('document components are defined and scoped to rendered content', () => {
  const section = documentComponentSection();
  for (const component of COMPONENTS) {
    assert.match(
      section,
      new RegExp(`\\.content\\s[^{]*\\.${component.replace('-', '\\-')}\\b`),
      `.${component} must be defined and scoped under .content`
    );
  }
});

test('document components never hardcode a colour', () => {
  // The load-bearing rule. Documents borrow the kit's component vocabulary, not
  // its palette: every colour must resolve from the active theme so the reader
  // keeps control and the theme picker keeps working. A hardcoded colour here
  // silently breaks theming for every document that uses the component, which is
  // exactly the kind of regression a reviewer skims past.
  const section = documentComponentSection();
  const withoutComments = section.replace(/\/\*[\s\S]*?\*\//g, '');

  const offenders = [];
  for (const [index, line] of withoutComments.split('\n').entries()) {
    const declaration = line.split('/*')[0];
    if (/#[0-9a-fA-F]{3,8}\b/.test(declaration)) offenders.push(`hex on line ${index + 1}: ${line.trim()}`);
    if (/\b(?:rgba?|hsla?)\s*\(/.test(declaration)) offenders.push(`function colour on line ${index + 1}: ${line.trim()}`);
    // Named colours are only a problem where a colour is expected; `transparent`
    // and `currentColor` are theme-neutral and allowed.
    const named = declaration.match(/:\s*(red|blue|green|black|white|grey|gray|orange|purple|yellow|pink|silver|navy|teal)\b/i);
    if (named) offenders.push(`named colour on line ${index + 1}: ${line.trim()}`);
  }

  assert.deepEqual(offenders, [], 'document component colours must all come from var(--…) theme tokens');
});

test('document components cannot restyle viewer chrome', () => {
  // Every selector in the section must begin at .content. A bare `.card { … }`
  // would leak into the toolbar and breadcrumbs.
  const section = documentComponentSection();
  const withoutComments = section.replace(/\/\*[\s\S]*?\*\//g, '');

  const selectors = withoutComments
    .split('}')
    .map((block) => block.split('{')[0].trim())
    .filter(Boolean)
    .flatMap((selector) => selector.split(',').map((part) => part.trim()))
    .filter(Boolean);

  assert.ok(selectors.length > 0, 'expected component selectors');
  const unscoped = selectors.filter((selector) => !selector.startsWith('.content'));
  assert.deepEqual(unscoped, [], 'every document component selector must be scoped under .content');
});
