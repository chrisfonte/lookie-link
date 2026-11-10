'use strict';

// Byte-surgical edits of a hand-maintained block-style YAML file.
//
// Only the touched lines change; every other byte stays identical. A reflowing
// serializer (or `ops-yaml edit`) would re-wrap long scalars across the whole
// file, so the splicer works on the source lines and refuses (throws a
// SpliceError) anything it does not understand. Callers must then refuse the
// edit; they must never fall back to a serializer.
//
// Supported: block mappings, block sequences (indentless or indented),
// `- key: value` items, single-line and wrapped plain / single-quoted /
// double-quoted scalars, `key: []` expansion on append.
// Refused: flow mappings or lists on the target, anchors, aliases, tags,
// block scalars (| >), comments on the value line, multi-document files, tabs,
// CRLF, blank or comment lines inside a wrapped scalar.

const yaml = require('js-yaml');

class SpliceError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'SpliceError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const UNSUPPORTED = 'unsupported_shape';
const NOT_FOUND = 'pointer_not_found';

// ---- scalars ---------------------------------------------------------------

/**
 * YAML double-quoted scalar from any string. U+0085, U+2028 and U+2029 are
 * escaped because YAML 1.1 loaders treat them as line breaks.
 */
function dq(value) {
  let out = '';
  for (const ch of JSON.stringify(String(value))) {
    const code = ch.codePointAt(0);
    out += (code === 0x85 || code === 0x2028 || code === 0x2029) ? `\\u${code.toString(16).padStart(4, '0')}` : ch;
  }
  return out;
}

const SAFE_PLAIN = /^[A-Za-z_][A-Za-z0-9_./-]*$/;
const RESERVED_PLAIN = new Set(['null', 'true', 'false', 'yes', 'no', 'on', 'off', 'y', 'n']);

/**
 * Render a JS value as a single-line YAML token. Strings are plain only when
 * every YAML 1.1 and 1.2 loader reads them back as the same string, otherwise
 * double-quoted. Non-empty collections are refused.
 */
function renderScalar(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || /e/i.test(String(value))) {
      throw new SpliceError(UNSUPPORTED, 'number cannot be written as a plain YAML scalar');
    }
    return String(value);
  }
  if (typeof value === 'string') {
    return SAFE_PLAIN.test(value) && !RESERVED_PLAIN.has(value.toLowerCase()) ? value : dq(value);
  }
  if (Array.isArray(value) && value.length === 0) return '[]';
  throw new SpliceError(UNSUPPORTED, 'only scalar values can be written');
}

function renderKey(key) {
  return SAFE_PLAIN.test(key) && !RESERVED_PLAIN.has(key.toLowerCase()) ? key : dq(key);
}

function renderItem(item, pad) {
  const prefix = ' '.repeat(pad);
  if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
    const entries = Object.entries(item);
    if (entries.length === 0) throw new SpliceError(UNSUPPORTED, 'an empty mapping cannot be appended');
    return entries.map(([key, value], index) => `${prefix}${index === 0 ? '- ' : '  '}${renderKey(key)}: ${renderScalar(value)}`);
  }
  return [`${prefix}- ${renderScalar(item)}`];
}

// ---- pointers and plain-object helpers --------------------------------------

function parsePointer(pointer) {
  if (typeof pointer !== 'string' || (pointer !== '' && !pointer.startsWith('/'))) {
    throw new SpliceError(NOT_FOUND, 'a JSON pointer must start with "/"');
  }
  if (pointer === '') return [];
  return pointer.slice(1).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function formatPointer(segments) {
  return segments.map((segment) => `/${String(segment).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');
}

const isMapping = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((value, index) => deepEqual(value, b[index]));
  }
  if (isMapping(a)) {
    if (!isMapping(b)) return false;
    const keysA = Object.keys(a);
    return keysA.length === Object.keys(b).length
      && keysA.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]));
  }
  return false;
}

function child(container, segment) {
  if (Array.isArray(container)) return /^\d+$/.test(segment) && Number(segment) < container.length ? { value: container[Number(segment)], ok: true } : { ok: false };
  if (isMapping(container) && Object.prototype.hasOwnProperty.call(container, segment)) return { value: container[segment], ok: true };
  return { ok: false };
}

/** @returns {{found: boolean, value?: *}} */
function getAt(root, pointer) {
  let current = root;
  for (const segment of parsePointer(pointer)) {
    const next = child(current, segment);
    if (!next.ok) return { found: false };
    current = next.value;
  }
  return { found: true, value: current };
}

function parentAt(root, pointer) {
  const segments = parsePointer(pointer);
  if (segments.length === 0) throw new SpliceError(NOT_FOUND, 'the document root cannot be edited');
  const last = segments.pop();
  const parent = getAt(root, formatPointer(segments));
  if (!parent.found) return null;
  return { container: parent.value, last };
}

/** Replace an existing scalar leaf in a parsed document. Never creates paths. */
function setAt(root, pointer, value) {
  const at = parentAt(root, pointer);
  const existing = at && child(at.container, at.last);
  if (!existing || !existing.ok) throw new SpliceError(NOT_FOUND, 'pointer does not exist in target', { pointer });
  if (existing.value !== null && typeof existing.value === 'object' && !(existing.value instanceof Date)) {
    throw new SpliceError(UNSUPPORTED, 'pointer does not name a scalar in target', { pointer });
  }
  at.container[Array.isArray(at.container) ? Number(at.last) : at.last] = value;
}

/** Append to an existing list in a parsed document. */
function appendAt(root, pointer, item) {
  const found = getAt(root, pointer);
  if (!found.found) throw new SpliceError(NOT_FOUND, 'pointer does not exist in target', { pointer });
  if (!Array.isArray(found.value)) throw new SpliceError(UNSUPPORTED, 'pointer does not name a list in target', { pointer });
  found.value.push(item);
}

/**
 * Pointers the ops-yaml CLI requires for --allow-change: recurse mappings, a
 * key added or removed is that key's pointer, any list difference is the
 * list's pointer, scalars compare type-strict. Sorted.
 */
function declaredPointers(before, after) {
  const out = [];
  const walk = (a, b, segments) => {
    if (isMapping(a) && isMapping(b)) {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const key of keys) {
        const inA = Object.prototype.hasOwnProperty.call(a, key);
        const inB = Object.prototype.hasOwnProperty.call(b, key);
        if (inA && inB) walk(a[key], b[key], [...segments, key]);
        else out.push(formatPointer([...segments, key]));
      }
    } else if (!deepEqual(a, b)) {
      out.push(formatPointer(segments));
    }
  };
  walk(before, after, []);
  return out.sort();
}

/**
 * The pointer the CLI sees for a leaf pointer: the nearest enclosing list
 * (arrays are whole-field units), else the pointer itself.
 */
function collapseToListUnit(root, pointer) {
  const segments = parsePointer(pointer);
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    if (Array.isArray(current)) return formatPointer(segments.slice(0, index));
    const next = child(current, segments[index]);
    if (!next.ok) break;
    current = next.value;
  }
  return formatPointer(segments);
}

// ---- line structure ---------------------------------------------------------

const isBlank = (line) => line.trim() === '';
const isComment = (line) => line.trimStart().startsWith('#');
const isSkip = (line) => isBlank(line) || isComment(line);
const indentOf = (line) => line.length - line.trimStart().length;
const isDash = (line) => /^\s*-(\s|$)/.test(line);

/** Column where the content of a line starts (after `- ` for sequence items). */
function startCol(line) {
  const match = /^(\s*)-(\s+)(?=\S)/.exec(line);
  if (match) return match[1].length + 1 + match[2].length;
  if (isDash(line)) return indentOf(line) + 2;
  return indentOf(line);
}

/** Parse `key:` at the start of `content`; returns { key, end } (end is after the colon) or null. */
function parseKey(content) {
  if (content === '' || content.startsWith('- ') || content === '-') return null;
  const first = content[0];
  if (first === '"' || first === "'") {
    let i = 1;
    while (i < content.length) {
      if (first === '"' && content[i] === '\\') { i += 2; continue; }
      if (content[i] === first) {
        if (first === "'" && content[i + 1] === "'") { i += 2; continue; }
        break;
      }
      i += 1;
    }
    if (i >= content.length || content[i + 1] !== ':' || (content[i + 2] !== undefined && content[i + 2] !== ' ')) return null;
    const raw = content.slice(1, i);
    const key = first === "'" ? raw.replace(/''/g, "'") : JSON.parse(`"${raw}"`);
    return { key, end: i + 2 };
  }
  if ('[{&*!|>%@`#'.includes(first)) return null;
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] === ':' && (i + 1 === content.length || content[i + 1] === ' ')) {
      const key = content.slice(0, i).trimEnd();
      return key ? { key, end: i + 1 } : null;
    }
  }
  return null;
}

function assertSupportedDocument(lines) {
  let first = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.includes('\r')) throw new SpliceError(UNSUPPORTED, 'CRLF line endings are not supported');
    if (/^[ ]*\t/.test(line)) throw new SpliceError(UNSUPPORTED, 'tab indentation is not supported');
    if (index === 0 && line.charCodeAt(0) === 0xfeff) throw new SpliceError(UNSUPPORTED, 'a byte order mark is not supported');
    if (/^(---|\.\.\.)(\s|$)/.test(line)) {
      if (/^---\s*$/.test(line) && lines.slice(0, index).every(isSkip)) { first = index + 1; continue; }
      throw new SpliceError(UNSUPPORTED, 'multi-document files are not supported');
    }
    if (line.startsWith('%') && lines.slice(0, index).every(isSkip)) throw new SpliceError(UNSUPPORTED, 'YAML directives are not supported');
  }
  return first;
}

function rootBlock(lines, first) {
  let at = first;
  while (at < lines.length && isSkip(lines[at])) at += 1;
  if (at >= lines.length) throw new SpliceError(NOT_FOUND, 'the document is empty');
  return { lo: first, hi: lines.length, indent: indentOf(lines[at]), kind: isDash(lines[at]) ? 'seq' : 'map' };
}

/** Lines that belong to the value of the key on `keyLine` (key content column `col`). */
function valueExtent(lines, keyLine, col, limit) {
  let last = keyLine;
  for (let j = keyLine + 1; j < limit; j += 1) {
    const line = lines[j];
    if (isSkip(line)) continue;
    const indent = indentOf(line);
    if (indent < col) break;
    if (indent === col && !isDash(line)) break;
    last = j;
  }
  return { lo: keyLine + 1, hi: last + 1 };
}

function blockFromExtent(lines, extent, fallbackIndent) {
  let at = extent.lo;
  while (at < extent.hi && isSkip(lines[at])) at += 1;
  if (at >= extent.hi) return { lo: extent.lo, hi: extent.hi, indent: fallbackIndent, kind: 'map', empty: true };
  return { lo: extent.lo, hi: extent.hi, indent: indentOf(lines[at]), kind: isDash(lines[at]) ? 'seq' : 'map' };
}

function seqItems(lines, block) {
  const starts = [];
  for (let j = block.lo; j < block.hi; j += 1) {
    if (!isSkip(lines[j]) && indentOf(lines[j]) === block.indent && isDash(lines[j])) starts.push(j);
  }
  return starts.map((lo, n) => {
    let hi = n + 1 < starts.length ? starts[n + 1] : block.hi;
    while (hi > lo + 1 && isSkip(lines[hi - 1])) hi -= 1;
    return { lo, hi, col: startCol(lines[lo]) };
  });
}

function findKey(lines, block, key) {
  for (let j = block.lo; j < block.hi; j += 1) {
    const line = lines[j];
    if (isSkip(line) || startCol(line) !== block.indent) continue;
    const parsed = parseKey(line.slice(block.indent));
    if (parsed && parsed.key === key) return { line: j, col: block.indent, end: parsed.end };
  }
  return null;
}

/**
 * Resolve a pointer to either { type: 'key', line, col, end } (the `key:` line of the last
 * step) or { type: 'item', lo, hi, col } (a sequence item).
 */
function resolve(lines, segments, first) {
  if (segments.length === 0) throw new SpliceError(NOT_FOUND, 'the document root cannot be edited');
  let block = rootBlock(lines, first);
  for (let s = 0; s < segments.length; s += 1) {
    const segment = segments[s];
    const last = s === segments.length - 1;
    let node;
    if (block.kind === 'map') {
      const found = block.empty ? null : findKey(lines, block, segment);
      if (!found) throw new SpliceError(NOT_FOUND, 'pointer does not exist in target');
      node = { type: 'key', ...found };
      if (last) return node;
      const rest = lines[found.line].slice(found.col + found.end).trim();
      if (rest !== '') {
        if (/^[[{]/.test(rest)) throw new SpliceError(UNSUPPORTED, 'flow collections on the pointer path are not supported');
        throw new SpliceError(NOT_FOUND, 'pointer does not exist in target');
      }
      block = blockFromExtent(lines, valueExtent(lines, found.line, found.col, block.hi), found.col + 2);
    } else {
      if (!/^\d+$/.test(segment)) throw new SpliceError(NOT_FOUND, 'pointer does not exist in target');
      const items = seqItems(lines, block);
      const item = items[Number(segment)];
      if (!item) throw new SpliceError(NOT_FOUND, 'pointer does not exist in target');
      node = { type: 'item', ...item };
      if (last) return node;
      const content = lines[item.lo].slice(item.col);
      if (!parseKey(content)) throw new SpliceError(NOT_FOUND, 'pointer does not exist in target');
      block = { lo: item.lo, hi: item.hi, indent: item.col, kind: 'map' };
    }
  }
  throw new SpliceError(NOT_FOUND, 'pointer does not exist in target');
}

/** Check that `text` (value + wrapped continuation) is exactly one plain or quoted scalar with nothing after it. */
function assertSingleScalar(text, wrapped) {
  const first = text[0];
  if (first === undefined) return;
  if ('{[&*!|>%@`'.includes(first)) throw new SpliceError(UNSUPPORTED, 'the target value is a flow collection, anchor, alias, tag or block scalar');
  if (first === '#') throw new SpliceError(UNSUPPORTED, 'the target value line carries a comment');
  if (first === "'" || first === '"') {
    let i = 1;
    let closed = false;
    while (i < text.length) {
      if (first === '"' && text[i] === '\\') { i += 2; continue; }
      if (text[i] === first) {
        if (first === "'" && text[i + 1] === "'") { i += 2; continue; }
        closed = true;
        break;
      }
      i += 1;
    }
    if (!closed) throw new SpliceError(UNSUPPORTED, 'unterminated quoted scalar');
    if (text.slice(i + 1).trim() !== '') throw new SpliceError(UNSUPPORTED, 'the target value line carries a comment or trailing content');
    return;
  }
  if (/(^|\s)#/.test(text)) throw new SpliceError(UNSUPPORTED, 'the target value line carries a comment');
  if (wrapped && /(^|\n)\s*(-\s|-$)/.test(text.slice(text.indexOf('\n') + 1))) {
    throw new SpliceError(UNSUPPORTED, 'unexpected sequence entry inside a scalar');
  }
}

function assertNoSkipInside(lines, lo, hi) {
  for (let j = lo; j < hi; j += 1) {
    if (isSkip(lines[j])) throw new SpliceError(UNSUPPORTED, 'blank or comment lines inside a wrapped scalar are not supported');
  }
}

// ---- edit planning -----------------------------------------------------------

/**
 * An edit in ORIGINAL line coordinates: replace `deleteCount` lines at `start`
 * with `insert`.
 */
function planSet(lines, segments, token, first) {
  const node = resolve(lines, segments, first);
  if (node.type === 'key') {
    const line = lines[node.line];
    const prefix = line.slice(0, node.col + node.end);
    const rest = line.slice(node.col + node.end).trim();
    const extent = valueExtent(lines, node.line, node.col, lines.length);
    if (rest === '') {
      if (extent.hi > node.line + 1) throw new SpliceError(UNSUPPORTED, 'the target is a collection, not a scalar');
      return { start: node.line, deleteCount: 1, insert: [`${prefix} ${token}`] };
    }
    assertNoSkipInside(lines, node.line + 1, extent.hi);
    const text = [rest, ...lines.slice(node.line + 1, extent.hi).map((l) => l.trim())].join('\n');
    assertSingleScalar(text, extent.hi > node.line + 1);
    return { start: node.line, deleteCount: extent.hi - node.line, insert: [`${prefix} ${token}`] };
  }
  const content = lines[node.lo].slice(node.col);
  if (parseKey(content) || content.startsWith('- ')) throw new SpliceError(UNSUPPORTED, 'the target is a collection, not a scalar');
  assertNoSkipInside(lines, node.lo + 1, node.hi);
  const text = [content.trim(), ...lines.slice(node.lo + 1, node.hi).map((l) => l.trim())].join('\n');
  assertSingleScalar(text, node.hi > node.lo + 1);
  return { start: node.lo, deleteCount: node.hi - node.lo, insert: [`${lines[node.lo].slice(0, node.col)}${token}`] };
}

function planAppend(lines, segments, item, first) {
  const node = resolve(lines, segments, first);
  if (node.type !== 'key') throw new SpliceError(UNSUPPORTED, 'a list nested directly in a list cannot be appended to');
  const line = lines[node.line];
  const prefix = line.slice(0, node.col + node.end);
  const rest = line.slice(node.col + node.end).trim();
  const extent = valueExtent(lines, node.line, node.col, lines.length);
  if (rest === '') {
    const block = blockFromExtent(lines, extent, node.col);
    if (block.empty || block.kind !== 'seq') throw new SpliceError(UNSUPPORTED, 'the target is not a block list');
    return { start: extent.hi, deleteCount: 0, insert: renderItem(item, block.indent) };
  }
  if (rest === '[]') {
    if (extent.hi > node.line + 1) throw new SpliceError(UNSUPPORTED, 'an empty flow list is followed by nested lines');
    return { start: node.line, deleteCount: 1, insert: [prefix, ...renderItem(item, node.col)] };
  }
  if (rest.startsWith('[') || rest.startsWith('{')) throw new SpliceError(UNSUPPORTED, 'a non-empty flow list is not supported');
  throw new SpliceError(UNSUPPORTED, 'the target is not a list');
}

function applyEdits(lines, edits) {
  const ordered = edits.map((edit, index) => ({ ...edit, index }));
  // Descending by start; at equal starts apply the replacement first so the
  // insertion that belongs before it lands above it. Insertions at the same
  // point keep their op order.
  ordered.sort((a, b) => b.start - a.start
    || (a.deleteCount > 0 ? 0 : 1) - (b.deleteCount > 0 ? 0 : 1)
    || b.index - a.index);
  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = i + 1; j < ordered.length; j += 1) {
      const a = ordered[i];
      const b = ordered[j];
      const aEnd = a.start + a.deleteCount;
      const bEnd = b.start + b.deleteCount;
      const overlap = a.deleteCount > 0 && b.deleteCount > 0 && a.start < bEnd && b.start < aEnd;
      const inside = (a.deleteCount === 0 && b.start < a.start && a.start < bEnd)
        || (b.deleteCount === 0 && a.start < b.start && b.start < aEnd);
      if (overlap || inside) throw new SpliceError(UNSUPPORTED, 'two edits touch the same lines');
    }
  }
  const out = lines.slice();
  for (const edit of ordered) out.splice(edit.start, edit.deleteCount, ...edit.insert);
  return out;
}

/**
 * Apply several set/append operations to source text in one pass. Every
 * operation is resolved against the ORIGINAL lines, so edits cannot disturb
 * each other. Returns the candidate text and the edits (original coordinates).
 *
 * @param {string} text
 * @param {Array<{op: 'set', pointer: string, token: string}|{op: 'append', pointer: string, item: *}>} ops
 */
function applyOps(text, ops) {
  const lines = text.split('\n');
  const first = assertSupportedDocument(lines);
  const edits = ops.map((entry) => {
    const segments = parsePointer(entry.pointer);
    if (entry.op === 'set') return planSet(lines, segments, entry.token, first);
    if (entry.op === 'append') return planAppend(lines, segments, entry.item, first);
    throw new SpliceError(UNSUPPORTED, `unknown operation "${entry.op}"`);
  });
  return { text: applyEdits(lines, edits).join('\n'), edits };
}

/** Single-operation conveniences over line arrays (pure: return a new array). */
function setScalar(lines, pointer, token) {
  const first = assertSupportedDocument(lines);
  const edit = planSet(lines, parsePointer(pointer), token, first);
  return applyEdits(lines, [edit]);
}

function appendListItem(lines, pointer, item) {
  const first = assertSupportedDocument(lines);
  const edit = planAppend(lines, parsePointer(pointer), item, first);
  return applyEdits(lines, [edit]);
}

// ---- diff and proof -----------------------------------------------------------

const MAX_EDIT_DISTANCE = 2000;

function myersOps(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  const maxD = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = maxD + 1;
  const v = new Int32Array(2 * maxD + 3);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= maxD && found < 0; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1; }
      v[offset + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
  }
  if (found < 0) return null;
  const ops = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d -= 1) {
    const prev = trace[d];
    const k = x - y;
    const down = k === -d || (k !== d && prev[offset + k - 1] < prev[offset + k + 1]);
    const prevK = down ? k + 1 : k - 1;
    const prevX = prev[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push({ t: '=', x: x - 1, y: y - 1 }); x -= 1; y -= 1; }
    ops.push(down ? { t: '+', x: prevX, y: prevY } : { t: '-', x: prevX, y: prevY });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) { ops.push({ t: '=', x: x - 1, y: y - 1 }); x -= 1; y -= 1; }
  return ops.reverse();
}

/**
 * Line diff as hunks. `oldStart` / `newStart` are 1-based; for a pure
 * insertion `oldStart` is the line the new lines go before.
 *
 * @returns {Array<{oldStart: number, oldLines: string[], newStart: number, newLines: string[]}>}
 */
function diffLines(a, b) {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > prefix && endB > prefix && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }
  const midA = a.slice(prefix, endA);
  const midB = b.slice(prefix, endB);
  if (midA.length === 0 && midB.length === 0) return [];
  const ops = myersOps(midA, midB);
  if (ops === null) {
    return [{ oldStart: prefix + 1, oldLines: midA, newStart: prefix + 1, newLines: midB }];
  }
  const hunks = [];
  let current = null;
  const flush = () => { if (current) hunks.push(current); current = null; };
  for (const op of ops) {
    if (op.t === '=') { flush(); continue; }
    if (!current) current = { oldStart: prefix + op.x + 1, oldLines: [], newStart: prefix + op.y + 1, newLines: [] };
    if (op.t === '-') current.oldLines.push(midA[op.x]);
    else current.newLines.push(midB[op.y]);
  }
  flush();
  return hunks;
}

/**
 * Prove a candidate: its js-yaml parse deep-equals the expected object, and
 * (when the edits are given) the line diff touches only the lines the edits
 * could touch.
 *
 * @param {string} sourceText
 * @param {string} candidateText
 * @param {*} expectedObject
 * @param {{edits?: Array<{start: number, deleteCount: number, insert: string[]}>}} [options]
 * @returns {{equal: boolean, bounded: boolean, hunks: Array, error?: string}}
 */
function proveCandidate(sourceText, candidateText, expectedObject, options = {}) {
  const hunks = diffLines(sourceText.split('\n'), candidateText.split('\n'));
  let equal = false;
  let error;
  try {
    equal = deepEqual(yaml.load(candidateText), expectedObject);
  } catch (caught) {
    error = caught && caught.name ? caught.name : 'ParseError';
  }
  let bounded = true;
  if (Array.isArray(options.edits)) {
    const removed = hunks.reduce((sum, hunk) => sum + hunk.oldLines.length, 0);
    const added = hunks.reduce((sum, hunk) => sum + hunk.newLines.length, 0);
    bounded = hunks.length <= options.edits.length
      && removed <= options.edits.reduce((sum, edit) => sum + edit.deleteCount, 0)
      && added <= options.edits.reduce((sum, edit) => sum + edit.insert.length, 0)
      && hunks.every((hunk) => {
        const lo = hunk.oldStart - 1;
        const hi = lo + hunk.oldLines.length;
        return options.edits.some((edit) => lo >= edit.start - edit.insert.length && hi <= edit.start + edit.deleteCount + edit.insert.length);
      });
  }
  return { equal, bounded, hunks, ...(error ? { error } : {}) };
}

module.exports = {
  SpliceError,
  dq,
  renderScalar,
  parsePointer,
  formatPointer,
  deepEqual,
  getAt,
  setAt,
  appendAt,
  declaredPointers,
  collapseToListUnit,
  applyOps,
  setScalar,
  appendListItem,
  diffLines,
  proveCandidate,
};
