'use strict';

// Search query semantics shared by both backends (2026-09-23).
//
// A query is split on whitespace into terms; every term must occur in the
// file's content (any lines, any order) OR every term must occur in its path.
// Double quotes group words into one phrase term. Matching is case-insensitive
// and literal: no regular expressions. Before this, the whole query was one
// literal phrase, so "overlay appearance" found nothing that "appearance
// overlay" found (owner test 2026-09-23).

function parseSearchQuery(raw) {
  const text = String(raw || '').trim();
  const terms = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const value = (match[1] !== undefined ? match[1] : match[2]).trim();
    if (!value) continue;
    terms.push({ text: value, lower: value.toLowerCase(), phrase: match[1] !== undefined });
  }
  // Longest term first: the rarest is usually the longest, so backends that
  // run one expensive pass per term start with the most selective.
  const bySelectivity = [...terms].sort((a, b) => b.lower.length - a.lower.length);
  return { raw: text, terms: bySelectivity };
}

function matchesAllTerms(lowerText, terms) {
  if (!terms.length) return false;
  for (const term of terms) if (!lowerText.includes(term.lower)) return false;
  return true;
}

function snippetFor(content, terms) {
  const source = String(content || '');
  const lower = source.toLowerCase();
  let index = -1;
  let length = 0;
  for (const term of terms) {
    const at = lower.indexOf(term.lower);
    if (at >= 0 && (index < 0 || at < index)) { index = at; length = term.lower.length; }
  }
  if (index < 0) return source.slice(0, 160).replace(/\s+/g, ' ').trim();
  return source.slice(Math.max(0, index - 60), Math.min(source.length, index + length + 100)).replace(/\s+/g, ' ').trim();
}

module.exports = { parseSearchQuery, matchesAllTerms, snippetFor };
