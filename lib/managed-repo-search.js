'use strict';

const path = require('node:path');
const { buildHref, buildAssetHref } = require('./path-utils');
const { parseSearchQuery, matchesAllTerms, snippetFor } = require('./search-query');

const SEARCHABLE_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.yaml', '.yml', '.json', '.csv', '.html', '.htm']);
const DEFAULT_RESULT_LIMIT = 50;
const MAX_RESULT_LIMIT = 100;
// Candidate-entry budget for one search. It is shared FAIRLY across the
// candidate repos (each gets an equal slice, at least MIN_REPO_ENTRIES), so a
// fleet of large repos is sampled evenly instead of the first repo eating the
// whole budget (observed 2026-09-23: 20 served repos, several with >5000
// entries, unscoped search never left the first one). A proper index is
// roadmap R8; until then scope the search when you know the repo.
const DEFAULT_MAX_ENTRIES = 20000;
const MAX_SEARCH_ENTRIES = 40000;
const MIN_REPO_ENTRIES = 500;
const MAX_REPO_ENTRIES = 5000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
// The read budget is fair-shared across repos too (2026-09-23): with a single
// pool the first few repos consumed it and later repos could only path-match.
const MIN_REPO_BYTES = 1024 * 1024;

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

function candidateRepos(repos, scopeFilter, canView) {
  return repos
    .filter((repo) => scopeFilter.size === 0 || scopeFilter.has(repo.id))
    .filter((repo) => canView(repo.id, '', 'directory'))
    .sort((left, right) => left.id.localeCompare(right.id));
}

async function searchManagedRepos(options) {
  const parsed = parseSearchQuery(options.query);
  if (!parsed.terms.length) throw new Error('q is required.');
  const terms = parsed.terms;
  const limit = boundedInteger(options.limit, DEFAULT_RESULT_LIMIT, MAX_RESULT_LIMIT);
  const maxEntries = boundedInteger(options.maxEntries, DEFAULT_MAX_ENTRIES, MAX_SEARCH_ENTRIES);
  const scopeFilter = normalizeScopeFilter(options.scope);
  const repos = candidateRepos(options.repos, scopeFilter, options.canView);
  const results = [];
  let remainingEntries = maxEntries;
  let bytesRead = 0;
  let truncated = false;

  const skipped = [];
  const perRepo = Math.min(MAX_REPO_ENTRIES, Math.max(MIN_REPO_ENTRIES, Math.floor(maxEntries / Math.max(1, repos.length))));
  const bytesPerRepo = Math.max(MIN_REPO_BYTES, Math.floor(MAX_TOTAL_BYTES / Math.max(1, repos.length)));
  outer: for (const repo of repos) {
    if (remainingEntries <= 0) { truncated = true; break; }
    let tree;
    try {
      tree = await options.store.listTree(repo, '', {
        maxDepth: 10,
        maxEntries: Math.min(perRepo, remainingEntries),
        includeEntry: (entry) => entry.type === 'file' && options.canView(repo.id, entry.path, 'file'),
        shouldDescend: (entry) => options.canView(repo.id, entry.path, 'directory'),
      });
    } catch (error) {
      // A served root that is absent or unreadable on this host (a repo that
      // has not synced here yet) must not fail the whole search: skip it and
      // say so.
      if (error && ['ENOENT', 'EACCES', 'ENOTDIR', 'EPERM'].includes(error.code)) { skipped.push(repo.id); continue; }
      throw error;
    }
    remainingEntries -= tree.visited;
    truncated = truncated || tree.truncated;
    let repoBytes = 0;

    for (const entry of tree.entries) {
      if (!SEARCHABLE_EXTENSIONS.has(path.extname(entry.path).toLowerCase())) continue;
      const pathMatches = matchesAllTerms(entry.path.toLowerCase(), terms);
      let content = '';
      let bodyMatches = false;
      if (entry.size <= MAX_FILE_BYTES && repoBytes + entry.size <= bytesPerRepo && bytesRead + entry.size <= MAX_TOTAL_BYTES) {
        try {
          const file = await options.store.readFile(repo, entry.path);
          content = file.content;
          bytesRead += Buffer.byteLength(content, 'utf8');
          repoBytes += Buffer.byteLength(content, 'utf8');
          bodyMatches = matchesAllTerms(content.toLowerCase(), terms);
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
        snippet: snippetFor(content, terms),
        lastModified: entry.mtimeMs,
        viewUrl: buildHref(repo.id, entry.path),
        rawUrl: buildAssetHref(repo.id, entry.path),
      });
      if (results.length >= limit) { truncated = true; break outer; }
    }
  }

  results.sort((left, right) => right.score - left.score || right.lastModified - left.lastModified || left.repo.localeCompare(right.repo) || left.path.localeCompare(right.path));
  return { results, count: results.length, totalMatches: results.length, truncated, skippedRepos: skipped, reposSearched: repos.length, terms: terms.map((t) => t.text), limits: { results: limit, entries: maxEntries, entriesPerRepo: perRepo, fileBytes: MAX_FILE_BYTES, totalBytes: MAX_TOTAL_BYTES, bytesPerRepo } };
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
    let tree;
    try {
      tree = await options.store.listTree(repo, '', {
        maxDepth: 10,
        maxEntries: Math.min(Math.min(MAX_REPO_ENTRIES, Math.max(MIN_REPO_ENTRIES, Math.floor(maxEntries / Math.max(1, repos.length)))), remainingEntries),
        includeEntry: (entry) => options.canView(repo.id, entry.path, entry.type === 'directory' ? 'directory' : 'file'),
        shouldDescend: (entry) => options.canView(repo.id, entry.path, 'directory'),
      });
    } catch (error) {
      if (error && ['ENOENT', 'EACCES', 'ENOTDIR', 'EPERM'].includes(error.code)) continue;
      throw error;
    }
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
