'use strict';

// Selector grammar for marker sources (design §3.1): a JSON-pointer-like path
// whose segments may carry `[*]` (every item of an array) and `[key=value]`
// (items whose `key` equals `value` as a string) suffixes, in any position:
//   /analysis/events[*]/start
//   /evidence[id=report]/path
// `~1` and `~0` unescape to `/` and `~` in keys and filter parts. Selection
// never throws; a path that matches nothing yields an empty list.

const MAX_RESULTS = 100000;
const UNITS = Object.freeze(['samples', 'ms', 'seconds']);

function unescapePart(text) {
  return text.replace(/~1/g, '/').replace(/~0/g, '~');
}

function escapePart(text) {
  return String(text).replace(/~/g, '~0').replace(/\//g, '~1');
}

// Split one pointer segment into its key and its bracket steps. Returns null on
// malformed brackets.
function parseSegment(segment) {
  const open = segment.indexOf('[');
  const keyText = open === -1 ? segment : segment.slice(0, open);
  const steps = [{ type: 'key', key: unescapePart(keyText) }];
  let rest = open === -1 ? '' : segment.slice(open);
  while (rest.length > 0) {
    const match = /^\[([^\]]*)\]/.exec(rest);
    if (!match) return null;
    const body = match[1];
    if (body === '*') {
      steps.push({ type: 'all' });
    } else {
      const eq = body.indexOf('=');
      if (eq < 1) return null;
      const condition = { key: unescapePart(body.slice(0, eq)), value: unescapePart(body.slice(eq + 1)) };
      const last = steps[steps.length - 1];
      // Adjacent filters on one array are ANDed: `[a=1][b=2]` keeps items matching both.
      if (last.type === 'filter') last.conditions.push(condition);
      else steps.push({ type: 'filter', conditions: [condition] });
    }
    rest = rest.slice(match[0].length);
  }
  return steps;
}

/**
 * Parse a selector into steps, or null when it is not a valid selector.
 * @param {string} pointer
 * @returns {Array<{type: 'key', key: string}|{type: 'all'}|{type: 'filter', conditions: Array<{key: string, value: string}>}>|null}
 */
function parseSelector(pointer) {
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) return null;
  if (pointer === '/') return [];
  const steps = [];
  for (const segment of pointer.slice(1).split('/')) {
    const parsed = parseSegment(segment);
    if (!parsed) return null;
    steps.push(...parsed);
  }
  return steps;
}

function isContainer(value) {
  return value !== null && typeof value === 'object';
}

function child(value, key) {
  if (Array.isArray(value)) {
    return /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length
      ? { found: true, value: value[Number(key)] }
      : { found: false };
  }
  if (isContainer(value) && Object.prototype.hasOwnProperty.call(value, key)) {
    return { found: true, value: value[key] };
  }
  return { found: false };
}

function filterMatches(item, step) {
  if (!isContainer(item) || Array.isArray(item)) return false;
  return step.conditions.every(({ key, value }) => {
    if (!Object.prototype.hasOwnProperty.call(item, key)) return false;
    const actual = item[key];
    if (isContainer(actual) || actual === null || actual === undefined) return false;
    return String(actual) === value;
  });
}

/**
 * Select values from a parsed document.
 * @param {*} doc parsed YAML/JSON
 * @param {string} pointer selector (see file header)
 * @returns {Array<{value: *, path: string}>} `path` is the concrete JSON pointer of each hit
 */
function select(doc, pointer) {
  const steps = parseSelector(pointer);
  if (!steps) return [];
  let frontier = [{ value: doc, path: '' }];
  for (const step of steps) {
    const next = [];
    for (const node of frontier) {
      if (step.type === 'key') {
        const hit = child(node.value, step.key);
        if (hit.found) next.push({ value: hit.value, path: `${node.path}/${escapePart(step.key)}` });
      } else if (!Array.isArray(node.value)) {
        continue;
      } else {
        node.value.forEach((item, index) => {
          if (step.type === 'all' || filterMatches(item, step)) next.push({ value: item, path: `${node.path}/${index}` });
        });
      }
      if (next.length > MAX_RESULTS) return next.slice(0, MAX_RESULTS);
    }
    frontier = next;
    if (frontier.length === 0) return [];
  }
  return frontier;
}

/** First selected value, or undefined. */
function selectFirst(doc, pointer) {
  const hits = select(doc, pointer);
  return hits.length > 0 ? hits[0].value : undefined;
}

/**
 * Convert a position to an integer sample index at `sampleRate`.
 * Returns null for non-numeric input, an unknown unit, or a missing rate when
 * the unit needs one.
 * @param {*} value number or numeric string
 * @param {'samples'|'ms'|'seconds'} unit
 * @param {number} [sampleRate]
 * @returns {number|null}
 */
function toSamples(value, unit, sampleRate) {
  if (typeof value === 'string' && value.trim() !== '') value = Number(value);
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (unit === 'samples') return Math.round(value);
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return null;
  if (unit === 'seconds') return Math.round(value * sampleRate);
  if (unit === 'ms') return Math.round((value / 1000) * sampleRate);
  return null;
}

module.exports = { UNITS, parseSelector, select, selectFirst, toSamples };
