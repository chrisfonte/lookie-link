'use strict';

const crypto = require('node:crypto');

function compareCodePoints(left, right) {
  const leftPoints = [...left].map((character) => character.codePointAt(0));
  const rightPoints = [...right].map((character) => character.codePointAt(0));
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index];
  }
  return leftPoints.length - rightPoints.length;
}

function normalizeString(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError('unpaired Unicode surrogate');
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError('unpaired Unicode surrogate');
    }
  }
  return value.normalize('NFC');
}

function quoteString(value) {
  let result = '"';
  for (const character of normalizeString(value)) {
    const codePoint = character.codePointAt(0);
    if (character === '"') result += '\\"';
    else if (character === '\\') result += '\\\\';
    else if (character === '\b') result += '\\b';
    else if (character === '\t') result += '\\t';
    else if (character === '\n') result += '\\n';
    else if (character === '\f') result += '\\f';
    else if (character === '\r') result += '\\r';
    else if (codePoint <= 0x1f) result += `\\u${codePoint.toString(16).padStart(4, '0')}`;
    else result += character;
  }
  return `${result}"`;
}

function serialize(value, ancestors) {
  if (value === null) return 'null';
  if (typeof value === 'string') return quoteString(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical numbers must be finite');
    if (Object.is(value, -0)) throw new TypeError('canonical numbers must not be negative zero');
    return String(value);
  }
  if (typeof value !== 'object') throw new TypeError(`unsupported canonical value type: ${typeof value}`);
  if (ancestors.has(value)) throw new TypeError('canonical values must not contain cycles');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) throw new TypeError('canonical arrays must not be sparse');
      }
      return `[${value.map((entry) => serialize(entry, ancestors)).join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('canonical objects must be plain objects');
    if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError('canonical objects must not have symbol keys');
    const entries = [];
    const normalizedKeys = new Set();
    for (const key of Object.keys(value)) {
      const normalizedKey = normalizeString(key);
      if (normalizedKeys.has(normalizedKey)) throw new TypeError('object keys must be unique after normalization');
      normalizedKeys.add(normalizedKey);
      entries.push([normalizedKey, value[key]]);
    }
    entries.sort(([left], [right]) => compareCodePoints(left, right));
    return `{${entries.map(([key, entry]) => `${quoteString(key)}:${serialize(entry, ancestors)}`).join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function canonicalize(value) {
  return `${serialize(value, new Set())}\n`;
}

function schemaDigest(template) {
  if (template === null || typeof template !== 'object' || Array.isArray(template)) {
    throw new TypeError('template must be an object');
  }
  const schema = {
    grammarVersion: template.grammarVersion,
    fields: template.fields,
  };
  return crypto.createHash('sha256').update(canonicalize(schema), 'utf8').digest('hex');
}

module.exports = {
  canonicalize,
  schemaDigest,
};
