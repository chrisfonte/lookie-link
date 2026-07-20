'use strict';

const path = require('node:path');
const { buildHref, buildAssetHref } = require('./path-utils');

const SEARCHABLE_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.yaml', '.yml', '.json', '.csv', '.html', '.htm']);
const DEFAULT_RESULT_LIMIT = 50;
const MAX_RESULT_LIMIT = 100;
const DEFAULT_MAX_ENTRIES = 2000;
const MAX_SEARCH_ENTRIES = 5000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;

function boundedInteger(value, fallback, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(maximum, Math.trunc(number)));
}

function normalizeScopeFilter(scope) {
  const values = Array.isArray(scope) ? scope : scope == null ? [] : [scope];
  return new Set(values.flatMap((value) => String(value || '').split(','))
    .map((value) => value.trim())
    .filter(Boolean));
}

function snippet(content, query) {
  const source = String(content || '');
  const index = source.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return source.slice(0, 160).replace(/\s+/g, ' ').trim();
  return source.slice(Math.max(0, index - 60), Math.min(source.length, index + query.length + 100))
    .replace(/\s+/g, ' ')
    .trim();
}

function candidateRepos(repos, scopeFilter, canView) {
  return repos
    .filter((repo) => scopeFilter.size === 0 || scopeFilter.has(repo.id))
    .filter((repo) => canView(repo.id, '', 'directory'))
    .sort((left, right) => left.id.localeCompare(right.id));
}

async function searchManagedRepos(options) {
  const query = String(options.query || '').trim();
  if (!query) throw new Error('q is required.');
  const lowerQuery = query.toLowerCase();
  const limit = boundedInteger(options.limit, DEFAULT_RESULT_LIMIT, MAX_RESULT_LIMIT);
  const maxEntries = boundedInteger(options.maxEntries, DEFAULT_MAX_ENTRIES, MAX_SEARCH_ENTRIES);
  const scopeFilter = normalizeScopeFilter(options.scope);
  const repos = candidateRepos(options.repos, scopeFilter, options.canView);
  const results = [];
  let remainingEntries = maxEntries;
  let bytesRead = 0;
  let truncated = false;

  outer: for (const repo of repos) {
    if (remainingEntries <= 0) { truncated = true; break; }
    const tree = await options.store.listTree(repo, '', {
      maxDepth: 10,
      maxEntries: remainingEntries,
      includeEntry: (entry) => entry.type === 'file' && options.canView(repo.id, entry.path, 'file'),
      shouldDescend: (entry) => options.canView(repo.id, entry.path, 'directory'),
    });
    remainingEntries -= tree.visited;
    truncated = truncated || tree.truncated;

    for (const entry of tree.entries) {
      if (!SEARCHABLE_EXTENSIONS.has(path.extname(entry.path).toLowerCase())) continue;
      const pathMatches = entry.path.toLowerCase().includes(lowerQuery);
      let content = '';
      let bodyMatches = false;
      if (entry.size <= MAX_FILE_BYTES && bytesRead + entry.size <= MAX_TOTAL_BYTES) {
        try {
          const file = await options.store.readFile(repo, entry.path);
          content = file.content;
          bytesRead += Buffer.byteLength(content, 'utf8');
          bodyMatches = content.toLowerCase().includes(lowerQuery);
        } catch (error) {
          if (!error || !['ENOENT', 'EACCES'].includes(error.code)) throw error;
          continue;
        }
      } else {
        truncated = true;
      }
      if (!pathMatches && !bodyMatches) continue;
      results.push({
        repo: repo.id,
        path: entry.path,
        score: pathMatches && bodyMatches ? 2 : 1,
        snippet: snippet(content, query),
        lastModified: entry.mtimeMs,
        viewUrl: buildHref(repo.id, entry.path),
        rawUrl: buildAssetHref(repo.id, entry.path),
      });
      if (results.length >= limit) { truncated = true; break outer; }
    }
  }

  results.sort((left, right) => right.score - left.score || right.lastModified - left.lastModified || left.repo.localeCompare(right.repo) || left.path.localeCompare(right.path));
  return { results, count: results.length, truncated, limits: { results: limit, entries: maxEntries, fileBytes: MAX_FILE_BYTES, totalBytes: MAX_TOTAL_BYTES } };
}

async function suggestManagedRepos(options) {
  const query = String(options.query || '').trim().toLowerCase();
  if (!query) throw new Error('q is required.');
  const limit = boundedInteger(options.limit, 25, MAX_RESULT_LIMIT);
  const maxEntries = boundedInteger(options.maxEntries, DEFAULT_MAX_ENTRIES, MAX_SEARCH_ENTRIES);
  const scopeFilter = normalizeScopeFilter(options.scope);
  const repos = candidateRepos(options.repos, scopeFilter, options.canView);
  const suggestions = [];
  let remainingEntries = maxEntries;
  let truncated = false;

  outer: for (const repo of repos) {
    if (remainingEntries <= 0) { truncated = true; break; }
    const tree = await options.store.listTree(repo, '', {
      maxDepth: 10,
      maxEntries: remainingEntries,
      includeEntry: (entry) => options.canView(repo.id, entry.path, entry.type === 'directory' ? 'directory' : 'file'),
      shouldDescend: (entry) => options.canView(repo.id, entry.path, 'directory'),
    });
    remainingEntries -= tree.visited;
    truncated = truncated || tree.truncated;
    for (const entry of tree.entries) {
      if (!entry.path.toLowerCase().includes(query)) continue;
      suggestions.push({ repo: repo.id, path: entry.path, type: entry.type });
      if (suggestions.length >= limit) { truncated = true; break outer; }
    }
  }
  suggestions.sort((left, right) => left.repo.localeCompare(right.repo) || left.path.localeCompare(right.path));
  return { suggestions, count: suggestions.length, truncated, limits: { results: limit, entries: maxEntries } };
}

module.exports = {
  searchManagedRepos,
  suggestManagedRepos,
  MAX_RESULT_LIMIT,
  MAX_SEARCH_ENTRIES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
};
