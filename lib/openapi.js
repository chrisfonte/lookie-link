'use strict';

// Machine-readable OpenAPI 3.1 description of the Lookie HTTP surface
// (API review 2026-09-23 item 4). The inventory below is hand-written but
// test-bound: test/openapi.test.js asserts its method:path set equals the
// registered application routes (and the forms router when enabled), and the
// route matrix test binds those routes to docs/CAPABILITIES.md.

const fs = require('node:fs');
const path = require('node:path');
const { ENDPOINT_TEMPLATES } = require('./agent-discovery');

const READ = 'read';
const WRITE = 'write';
const ADMIN = 'admin';
const ADMIN_READ = 'admin-read';
const FORMS_WRITE = 'forms-write'; // bearer OR browser context (cookie + CSRF + Origin)
const MARKERS_WRITE = 'markers-write'; // same two credential paths, marker routes
const PUBLIC = 'public';

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const str = (description) => (description ? { type: 'string', description } : { type: 'string' });
const obj = (properties, required = []) => ({
  type: 'object',
  ...(required.length ? { required } : {}),
  properties,
});

const q = (name, description, schema = { type: 'string' }, required = false) => ({
  name, in: 'query', required, description, schema,
});
const VERSION_Q = q('version', 'Published revision number.', { type: 'integer', minimum: 1 });
const MTIME = { type: 'number', description: 'Optional stale-write guard; a mismatch returns 409.' };
const BUNDLE = obj({
  slug: str(),
  entryPath: str(),
  metadata: { type: 'object' },
  privateMetadata: { type: 'object' },
  kit: {
    description: 'Optional kit name, or true for the configured default kit. At publish time HTML files receive an inlined <style data-kit data-kit-version> block; the revision record stores kit {name,version,revision}.',
    oneOf: [{ type: 'string' }, { type: 'boolean', const: true }],
  },
  files: {
    type: 'array',
    minItems: 1,
    items: obj({ path: str(), content: str(), encoding: { type: 'string', enum: ['utf8', 'base64'] } }, ['path', 'content']),
  },
}, ['files']);
const REASON = obj({ reason: str() }, ['reason']);
const FORM_POST = { contentType: 'application/x-www-form-urlencoded', schema: obj({ _csrf: str('Synchronizer token.') }, ['_csrf']) };

// [method, express path, tag, summary, extra]
// extra: auth, query, body, json (success schema), html, status, capability, endpointKey
const CORE_ROUTES = [
  ['get', '/', 'content', 'Repository index (HTML)', { html: true }],
  ['get', '/healthz', 'discovery', 'Health check', { auth: PUBLIC, json: obj({ status: str(), editingEnabled: { type: 'boolean' }, annotationsEnabled: { type: 'boolean' }, rawHtmlEnabled: { type: 'boolean' } }) }],
  ['get', '/.well-known/agent.json', 'discovery', 'Caller-scoped agent discovery card', { json: ref('Discovery'), endpointKey: 'agentDiscovery' }],
  ['get', '/api/whoami', 'discovery', 'Caller identity, permissions, capabilities and endpoints', { json: ref('Discovery'), capability: 'whoami', endpointKey: 'whoami' }],
  ['get', '/api/repos', 'discovery', 'Caller-visible repositories', { json: obj({ ok: { type: 'boolean' }, repos: { type: 'array', items: obj({ repo: str(), viewUrl: str(), assetUrl: str() }) }, count: { type: 'integer' } }), capability: 'repoDiscovery', endpointKey: 'repos' }],
  ['get', '/openapi.json', 'discovery', 'This OpenAPI document', { json: { type: 'object' } }],
  ['get', '/api/docs', 'discovery', 'Interactive API explorer (HTML)', { html: true }],
  ['get', '/view', 'content', 'Redirect to the repository index', { auth: PUBLIC, status: '302' }],
  ['get', '/view/*', 'content', 'Render or browse a file or directory (HTML)', { pathNote: '{path} is "<repo>/<relative path>" (one catch-all segment; the agent card writes it as :repo/*path).',  html: true, query: [VERSION_Q, q('validate', 'For HTML files, 1 returns a JSON reference report (local assets/navigation plus advisory kit and pageContract sections).')], endpointKey: 'view' }],
  ['get', '/asset/:repo/*', 'content', 'Raw allowlisted asset', { binary: true, query: [VERSION_Q], capability: 'assetRead', endpointKey: 'assetRead' }],
  ['get', '/raw/:repo/*', 'content', 'Verbatim HTML file', { html: true, query: [VERSION_Q], capability: 'rawHtml', endpointKey: 'rawHtml' }],
  ['get', '/embed/:repo/*', 'content', 'Transformed embeddable HTML file', { html: true, capability: 'embeddedHtml', endpointKey: 'embeddedHtml' }],
  ['get', '/edit/*', 'content', 'Editor page (HTML)', { pathNote: '{path} is "<repo>/<relative path>" (one catch-all segment; the agent card writes it as :repo/*path).',  html: true, capability: 'editing', endpointKey: 'edit' }],
  ['post', '/api/save/*', 'content', 'Save a mounted file', { pathNote: '{path} is "<repo>/<relative path>" (one catch-all segment; the agent card writes it as :repo/*path).',  auth: WRITE, body: obj({ content: str(), expectedMtimeMs: MTIME }, ['content']), json: ref('Ok'), capability: 'editing', endpointKey: 'save' }],
  ['post', '/api/preview/*', 'content', 'Render draft content without writing', { pathNote: '{path} is "<repo>/<relative path>" (one catch-all segment; the agent card writes it as :repo/*path).',  auth: WRITE, body: obj({ content: str() }, ['content']), json: ref('Ok'), capability: 'editing', endpointKey: 'preview' }],
  ['get', '/api/appearance', 'appearance', 'List themes, palettes, aliases, picture sets and glass defaults (pollable; ETag)', { json: ref('Ok'), capability: 'appearance', endpointKey: 'appearance' }],
  ['get', '/api/appearance/themes/:slug', 'appearance', 'One theme by slug or alias', { json: ref('Ok'), capability: 'appearance', endpointKey: 'appearanceTheme' }],
  ['patch', '/api/appearance', 'appearance', 'Change themes, palettes, aliases, wallpaper folders or glass defaults (admin; overlay file; revision guard)', { auth: ADMIN, body: obj({ expectedRevision: { type: 'integer', minimum: 0 }, wallpapers: { type: 'object' }, themes: { type: 'object' } }, ['expectedRevision']), json: ref('Ok') }],
  ['post', '/api/appearance/themes/:slug/wallpapers/:mode', 'appearance', 'Upload a picture into the managed folder (raw image body; ?name= becomes the id)', { auth: ADMIN, query: [q('name', 'Picture id: lowercase letters, digits, hyphens.', { type: 'string' }, true)], rawBody: ['image/jpeg', 'image/png', 'image/webp'], json: ref('Ok'), status: '201' }],
  ['delete', '/api/appearance/themes/:slug/wallpapers/:mode/:id', 'appearance', 'Delete a managed picture', { auth: ADMIN, json: ref('Ok') }],
  ['get', '/wallpaper/:slug/:mode/:id', 'appearance', 'Wallpaper image from a theme catalog', { binary: true, capability: 'wallpapers', endpointKey: 'wallpaperImage' }],
  ['get', '/api/audio/:repo/*', 'audio', 'Audio file info: header fields, sample count, peaks location (generates the peaks sidecar when missing)', { json: obj({ ok: { type: 'boolean' }, repo: str(), path: str(), viewUrl: str(), assetUrl: str(), peaksUrl: str(), infoUrl: str(), sampleRate: { type: 'integer' }, channels: { type: 'integer' }, frames: { type: 'integer' }, durationSeconds: { type: 'number' }, sha256: str('SHA-256 of the audio bytes.'), blockSize: { type: 'integer' }, blocks: { type: 'integer' }, peakMode: str(), sidecar: obj({ location: str() }) }), errors: [413, 415, 503], capability: 'audio', endpointKey: 'audioInfo' }],
  ['get', '/api/peaks/:repo/*', 'audio', 'Waveform peaks as little-endian uint16 pairs (min/max per block per channel); X-Peaks-* headers carry the header fields, ?header=1 returns them as JSON', { binary: true, query: [q('header', '1 returns the JSON header instead of the binary peaks.', { type: 'string', enum: ['1'] })], errors: [413, 415, 503], capability: 'audio', endpointKey: 'audioPeaks' }],
  ['get', '/api/kits', 'kits', 'List hosted HTML kits (pollable; ETag). Projections include scope (bundled|shared|org), and for org kits org/currentVersion; effectiveVersion is <version> or <version>@<n>[+overlayHash]', { json: ref('Ok'), capability: 'kits', endpointKey: 'kits' }],
  ['get', '/api/kits/:name', 'kits', 'One hosted HTML kit by name (org show includes versions[]); deleted org kit → 410 gone', { json: ref('Ok'), capability: 'kits', endpointKey: 'kit', errors: [410] }],
  ['post', '/api/kits', 'kits', 'Create an org kit under orgs/default (admin; versions/1; name conflict or tombstone → 409)', { auth: ADMIN, body: obj({ name: str('^[a-z][a-z0-9-]{0,39}$'), label: str(), version: str(), description: str(), stylesheet: str('CSS text'), templates: { type: 'object', additionalProperties: str() }, examples: { type: 'object', additionalProperties: str() } }, ['name', 'label', 'version', 'stylesheet']), json: ref('Ok'), status: '201', capability: 'kits', errors: [409] }],
  ['put', '/api/kits/:name/files/:file', 'kits', 'Replace or add a file in an org kit (admin; writes immutable versions/<n+1>; bundled/shared → 403 read_only)', { auth: ADMIN, body: obj({ content: str() }), json: ref('Ok'), capability: 'kits' }],
  ['patch', '/api/kits/:name', 'kits', 'Set or clear a kit token overlay stored under orgs/default/overlays (admin; any visible kit; expectedRevision guard)', { auth: ADMIN, body: obj({ expectedRevision: str('Catalog revision from GET /api/kits'), tokens: { type: 'object', additionalProperties: str(), description: 'CSS custom properties; {} or null clears the overlay' }, label: str() }, ['expectedRevision']), json: ref('Ok'), capability: 'kits', errors: [409] }],
  ['delete', '/api/kits/:name', 'kits', 'Tombstone an org kit (admin; sets deletedAt; versions stay; show → 410; bundled/shared → 403 read_only)', { auth: ADMIN, json: ref('Ok'), capability: 'kits' }],
  ['get', '/kit/:name/kit.css', 'kits', 'Kit stylesheet (revalidate; includes overlay when present)', { binary: true, capability: 'kits', endpointKey: 'kitStylesheet' }],
  ['get', '/kit/:name/v/:version/kit.css', 'kits', 'Versioned kit stylesheet (immutable; :version is effectiveVersion; org historical @n snapshots stay servable)', { binary: true, capability: 'kits' }],
  ['get', '/kit/:name/files/:file', 'kits', 'Kit template or example file (text)', { html: true, capability: 'kits', endpointKey: 'kitFile' }],
  ['get', '/api/annotations/:repo/*', 'annotations', 'Read a file\'s annotations', { query: [q('state', 'Repeatable filter.', { type: 'string', enum: ['open', 'claimed', 'resolved'] })], json: ref('Ok'), capability: 'annotations', endpointKey: 'annotationRead' }],
  ['post', '/api/annotations/:repo/*', 'annotations', 'Create an annotation', { auth: WRITE, body: obj({ anchor: str('Starts with "#": a heading anchor ("#Heading text"), a YAML key path, or a line range "#L<start>-L<end>".'), anchorKind: { type: 'string', enum: ['heading', 'yamlKey', 'lineRange'] }, body: str(), author: str(), expectedMtimeMs: MTIME }, ['anchor', 'anchorKind', 'body', 'author']), json: ref('Ok'), status: '201', capability: 'annotationWrite', endpointKey: 'annotationCreate' }],
  ['patch', '/api/annotations/:repo/*', 'annotations', 'Claim, resolve, reopen, reply to or redact an annotation (resolve and reopen are idempotent: repeating returns 200 and re-stamps the time)', { auth: WRITE, body: obj({ id: str('Annotation id from the list.'), op: { type: 'string', enum: ['claim', 'resolve', 'reopen', 'reply', 'redact'] }, payload: obj({ claimedBy: str('claim: who claims (falls back to author)'), author: str('reply/redact: actor'), body: str('reply: text'), redactedBy: str('redact: who redacts (falls back to author)') }), expectedMtimeMs: MTIME }, ['id', 'op']), json: ref('Ok'), capability: 'annotationWrite', endpointKey: 'annotationUpdate' }],
  ['get', '/api/repos/:repo/tree', 'content', 'Bounded directory tree of any served repo (managed or mapped)', { query: [q('path', 'Directory below the repo root.'), q('maxDepth', 'Depth bound.', { type: 'integer' }), q('maxEntries', 'Entry bound.', { type: 'integer' })], json: ref('Ok'), capability: 'repoRead', endpointKey: 'repoTree' }],
  ['get', '/api/repos/:repo/changes', 'content', 'Files changed since a timestamp in any served repo, newest first', { query: [q('since', 'Epoch milliseconds, epoch seconds, or ISO-8601 (compared against file mtimeMs).', { type: 'string' }), q('maxEntries', 'Entry bound.', { type: 'integer' })], json: ref('Ok'), capability: 'repoRead', endpointKey: 'repoChanges' }],
  ['get', '/api/repos/:repo/files/*', 'content', 'Read a text file from any served repo as JSON (content, mtimeMs, size)', { json: obj({ ok: { type: 'boolean' }, repo: str(), managed: { type: 'boolean' }, path: str(), content: str(), size: { type: 'integer' }, mtimeMs: { type: 'number' }, viewUrl: str() }), capability: 'repoRead', endpointKey: 'repoFileRead' }],
  ['get', '/api/managed-repos', 'managed-repos', 'List visible managed repositories', { json: ref('Ok'), capability: 'managedRepos', endpointKey: 'managedRepoList' }],
  ['post', '/api/managed-repos', 'admin', 'Register or create a managed repository', { auth: ADMIN, body: obj({ repoId: str('Lowercase letters, digits, dots, underscores, hyphens.'), rootPath: str('Absolute path; must resolve inside managedRepos.allowRoots. Created if missing.'), label: str(), policy: obj({ softDelete: { type: 'boolean', description: 'Default true.' }, trashDirName: str('Single path segment; default ".trash".') }) }, ['repoId', 'rootPath']), json: ref('Ok'), status: '201' }],
  ['get', '/api/managed-repos/:repo/tree', 'managed-repos', 'Bounded directory tree', { query: [q('path', 'Directory below the repo root.'), q('maxDepth', 'Depth bound.', { type: 'integer' }), q('maxEntries', 'Entry bound.', { type: 'integer' })], json: ref('Ok'), capability: 'managedRepos', endpointKey: 'managedTree' }],
  ['get', '/api/managed-repos/:repo/changes', 'managed-repos', 'Files changed since a timestamp', { query: [q('since', 'Epoch milliseconds, epoch seconds, or ISO-8601 (compared against file mtimeMs).', { type: 'string' }), q('maxEntries', 'Entry bound.', { type: 'integer' })], json: ref('Ok'), capability: 'managedRepos', endpointKey: 'managedChanges' }],
  ['get', '/api/managed-repos/:repo/files/*', 'managed-repos', 'Read a managed file', { json: obj({ ok: { type: 'boolean' }, path: str(), content: str(), size: { type: 'integer' }, mtimeMs: { type: 'number' } }), capability: 'managedRepos', endpointKey: 'managedFileRead' }],
  ['put', '/api/managed-repos/:repo/files/*', 'managed-repos', 'Create or update a managed file', { auth: WRITE, body: obj({ content: str(), expectedMtimeMs: MTIME }, ['content']), json: ref('Ok'), capability: 'managedRepos', endpointKey: 'managedFileWrite' }],
  ['delete', '/api/managed-repos/:repo/files/*', 'managed-repos', 'Soft-delete (or hard-delete) a managed file', { auth: WRITE, query: [q('hard', '1 deletes permanently.')], json: ref('Ok'), capability: 'managedRepos' }],
  ['get', '/api/managed-repos/:repo/trash', 'managed-repos', 'List soft-deleted files (newest first)', { json: ref('Ok'), capability: 'managedRepos' }],
  ['post', '/api/managed-repos/:repo/trash/:trashId/restore', 'managed-repos', 'Restore a soft-deleted file', { auth: WRITE, json: ref('Ok'), capability: 'managedRepos' }],
  ['delete', '/api/managed-repos/:repo/trash/:trashId', 'managed-repos', 'Permanently delete one trash item', { auth: WRITE, json: ref('Ok'), capability: 'managedRepos' }],
  ['get', '/api/search', 'content', 'Search every served repository the caller can view (managed and mapped)', { query: [q('q', 'Search text: every whitespace-separated term must occur in the content (any order) or in the path; "quoted words" form one phrase; literal and case-insensitive.', { type: 'string' }, true), q('scope', 'Repeatable repo scope (alias: repo). Unknown query parameters are rejected; a scope naming no searchable repo is 400.'), q('limit', 'Result bound, integer >= 1.', { type: 'integer' }), q('maxEntries', 'Candidate-entry budget, shared fairly across repos (default 20000, max 40000).', { type: 'integer' })], json: ref('Ok'), capability: 'search', endpointKey: 'search' }],
  ['get', '/api/search/suggest', 'content', 'Path suggestions across served repositories', { query: [q('q', 'Prefix text.', { type: 'string' }, true), q('scope', 'Repeatable scope.'), q('limit', 'Result bound.', { type: 'integer' }), q('maxEntries', 'Candidate bound.', { type: 'integer' })], json: ref('Ok'), capability: 'search', endpointKey: 'searchSuggest' }],
  ['post', '/api/publish', 'publish', 'Publish a new bundle (revision 1); optional kit inlines the kit stylesheet into HTML files and records kit metadata on the revision', { auth: WRITE, body: BUNDLE, json: ref('Ok'), status: '201', capability: 'publish', endpointKey: 'publishCreate' }],
  ['post', '/api/publish/:slug', 'publish', 'Publish the next immutable revision; optional kit inlines as on create', { auth: WRITE, body: { ...BUNDLE, required: ['files', 'expectedRevision'], properties: { ...BUNDLE.properties, expectedRevision: { type: 'integer', minimum: 1 } } }, json: ref('Ok'), capability: 'publish', endpointKey: 'publishUpdate' }],
  ['post', '/api/publish/:slug/revoke', 'publish', 'Revoke a published bundle', { auth: WRITE, body: REASON, json: ref('Ok'), capability: 'publish', endpointKey: 'publishRevoke' }],
  ['get', '/api/publish', 'publish', 'List publications the caller may view (pollable; ETag); each summary includes kit for the current revision (or null)', { query: [q('state', 'Filter by state.', { type: 'string', enum: ['active', 'revoked'] })], json: ref('Ok'), capability: 'publish', endpointKey: 'publishList' }],
  ['get', '/api/publish/:slug', 'publish', 'One publication by slug, with its revision history (pollable; ETag); kit on the publication and each revision', { query: [VERSION_Q], json: ref('Ok'), capability: 'publish', endpointKey: 'publishGet' }],
  ['get', '/api/agent-keys', 'admin', 'List managed API keys', { auth: ADMIN, query: [q('state', 'Key state filter.'), q('agentId', 'Agent filter.'), q('includeAudit', '1 includes the audit projection.')], json: ref('Ok') }],
  ['post', '/api/agent-keys', 'admin', 'Create a managed API key (secret returned once)', { auth: ADMIN, body: obj({ label: str(), subject: obj({ agentId: str(), companyId: str(), label: str() }, ['agentId', 'companyId']), permissions: obj({ view: { type: 'boolean', description: 'Default true unless write or publish is set.' }, write: { type: 'boolean' }, publish: { type: 'boolean' } }), repos: { description: 'The string "all", an array of repo ids (whole-repo access), or an object mapping repo id to a scope ("all"/true or { paths: [...] }).' }, issuer: obj({ actorType: str(), actorId: str() }) }, ['label', 'subject']), json: ref('Ok'), status: '201' }],
  ['post', '/api/agent-keys/:keyId/rotate', 'admin', 'Rotate a managed API key', { auth: ADMIN, body: obj({ reason: str('Not persisted as the reason; only recorded as reasonProvided in the audit event.'), issuer: obj({ actorType: str(), actorId: str() }) }), json: ref('Ok') }],
  ['post', '/api/agent-keys/:keyId/revoke', 'admin', 'Revoke a managed API key', { auth: ADMIN, body: obj({ reason: str(), issuer: obj({ actorType: str(), actorId: str() }) }, ['reason']), json: ref('Ok') }],
  ['get', '/api/grants', 'admin', 'List managed grants', { auth: ADMIN_READ, query: [q('sourceCompanyId', 'Filter.'), q('targetCompanyId', 'Filter.'), q('repoId', 'Filter.'), q('state', 'Filter.'), q('includeAudit', '1 includes the audit projection.')], json: ref('Ok') }],
  ['post', '/api/grants', 'admin', 'Create a managed grant', { auth: ADMIN, body: obj({
    repoId: str(),
    sourceCompanyId: str('Must match the configured owner company of repoId.'),
    targetCompanyId: str(),
    issuer: obj({ role: { type: 'string', enum: ['board_user', 'ceo_agent', 'manager_agent', 'trusted_ops_agent'] }, companyId: str(), agentId: str('One of agentId or userId is required.'), userId: str() }, ['role', 'companyId']),
    subject: obj({ companyId: str('Defaults to targetCompanyId; must match it if given.'), agentIds: { type: 'array', items: { type: 'string' } }, userIds: { type: 'array', items: { type: 'string' } }, agents: { type: 'string', enum: ['all'], description: 'Set to "all" to target every agent in the company instead of named agentIds/userIds.' } }),
    permissions: obj({ view: { type: 'boolean', description: 'Default true unless write or publish is set.' }, write: { type: 'boolean' }, publish: { type: 'boolean' } }),
    paths: { type: 'array', items: { type: 'string' }, description: 'Repo-relative path scopes; empty means whole-repo.' },
    sourceIssueId: str(),
    reason: str(),
    expiresAt: str('ISO-8601; must be in the future.'),
    approvalId: str('Required when the grant requests write access, whole-repo access, a broad subject, or an expiry beyond 7 days.'),
    adapterAllowRoots: { type: 'array', items: { type: 'string' }, description: 'Cross-company grants only.' },
  }, ['repoId', 'sourceCompanyId', 'targetCompanyId', 'issuer', 'subject', 'sourceIssueId', 'reason', 'expiresAt']), json: ref('Ok'), status: '201' }],
  ['post', '/api/grants/:grantId/renew', 'admin', 'Renew a managed grant', { auth: ADMIN, body: obj({ issuer: obj({ role: { type: 'string', enum: ['board_user', 'ceo_agent', 'manager_agent', 'trusted_ops_agent'] }, companyId: str(), agentId: str(), userId: str() }, ['role', 'companyId']), reason: str(), expiresAt: str('ISO-8601; must be in the future.'), approvalId: str('May satisfy the approval requirement if the grant does not already carry one.'), rotateToken: { type: 'boolean', description: 'Default true; false keeps the existing bearer token.' } }, ['reason', 'expiresAt']), json: ref('Ok') }],
  ['post', '/api/grants/:grantId/revoke', 'admin', 'Revoke a managed grant', { auth: ADMIN, body: obj({ issuer: obj({ role: { type: 'string', enum: ['board_user', 'ceo_agent', 'manager_agent', 'trusted_ops_agent'] }, companyId: str(), agentId: str(), userId: str() }, ['role', 'companyId']), reason: str() }, ['issuer', 'reason']), json: ref('Ok') }],
];

const FORMS_ROUTES = [
  ['get', '/forms', 'forms', 'Forms index (HTML)', { html: true, capability: 'forms', endpointKey: 'forms' }],
  ['get', '/forms/new', 'forms', 'New-template page (HTML)', { html: true, capability: 'forms' }],
  ['post', '/forms', 'forms', 'Create a template from the browser builder', { auth: FORMS_WRITE, form: true, status: '303', capability: 'forms' }],
  ['get', '/forms/entries', 'forms', 'Caller entry history across forms (HTML)', { html: true, capability: 'forms' }],
  ['get', '/forms/:templateId', 'forms', 'Form page (HTML)', { html: true, capability: 'forms' }],
  ['post', '/forms/:templateId', 'forms', 'Native form submit', { auth: FORMS_WRITE, form: true, status: '303', capability: 'forms' }],
  ['post', '/forms/:templateId/delete', 'forms', 'Delete a draft template from the browser', { auth: FORMS_WRITE, form: true, status: '303', capability: 'forms' }],
  ['post', '/forms/:templateId/clone', 'forms', 'Clone a template from the browser', { auth: FORMS_WRITE, form: true, status: '303', capability: 'forms' }],
  ['post', '/forms/:templateId/archive', 'forms', 'Archive a template from the browser', { auth: FORMS_WRITE, form: true, status: '303', capability: 'forms' }],
  ['post', '/forms/:templateId/restore', 'forms', 'Restore an archived template from the browser', { auth: FORMS_WRITE, form: true, status: '303', capability: 'forms' }],
  ['get', '/forms/:templateId/configure', 'forms', 'Template builder (HTML)', { html: true, capability: 'forms' }],
  ['post', '/forms/:templateId/configure', 'forms', 'Save the builder draft', { auth: FORMS_WRITE, form: true, status: '303', capability: 'forms' }],
  ['post', '/forms/:templateId/configure/publish', 'forms', 'Publish the builder draft', { auth: FORMS_WRITE, form: true, status: '303', capability: 'forms' }],
  ['post', '/forms/:templateId/configure/restore-version', 'forms', 'Restore a published version into the draft', { auth: FORMS_WRITE, form: true, status: '303', capability: 'forms' }],
  ['get', '/forms/:templateId/entries', 'forms', 'Entry history for one form (HTML)', { html: true, capability: 'forms' }],
  ['get', '/forms/:templateId/receipts/:submissionId', 'forms', 'Submission receipt (HTML)', { html: true, capability: 'forms' }],
  ['get', '/forms/:templateId/receipts/:submissionId/edit', 'forms', 'Correct a submission (HTML)', { html: true, capability: 'forms' }],
  ['get', '/api/forms/templates', 'forms', 'List templates', { json: ref('Ok'), capability: 'forms', endpointKey: 'formsTemplates' }],
  ['post', '/api/forms/templates', 'forms', 'Create a draft template', { auth: FORMS_WRITE, body: obj({
    templateId: str('Definition ID.'),
    grammarVersion: { type: 'integer' },
    title: str(),
    fields: { type: 'array', items: { type: 'object' }, description: 'Required unless parentId is set or kind is "container" or "list".' },
    destinationId: str('Required unless kind is "container", "parent", or "list".'),
    description: str(),
    tags: { type: 'array', items: { type: 'string' } },
    lineage: { type: 'object' },
    presentation: { type: 'object' },
    kind: { type: 'string', enum: ['form', 'container', 'parent', 'list'] },
    containerId: str(),
    memberOrder: { type: 'array', items: { type: 'string' }, description: 'Only valid on kind "container".' },
    parentId: str(),
    related: { type: 'object' },
    inherit: { ...obj({ exclude: { type: 'array', items: { type: 'string' } }, order: { type: 'array', items: { type: 'string' } } }), description: 'Only valid with parentId set.' },
  }, ['templateId', 'grammarVersion', 'title']), json: ref('Ok'), status: '201', capability: 'forms', endpointKey: 'formsTemplates' }],
  ['get', '/api/forms/templates/:templateId', 'forms', 'Read template management metadata', { json: ref('Ok'), capability: 'forms' }],
  ['patch', '/api/forms/templates/:templateId', 'forms', 'Revise a draft template (at least one field besides revision must change)', { auth: FORMS_WRITE, body: obj({
    revision: { type: 'integer', minimum: 1, description: 'Must match the current draft revision.' },
    grammarVersion: { type: 'integer' },
    destinationId: str(),
    title: str(),
    description: str(),
    tags: { type: 'array', items: { type: 'string' } },
    lineage: { type: 'object' },
    presentation: { type: 'object' },
    fields: { type: 'array', items: { type: 'object' } },
    containerId: str(),
    memberOrder: { type: 'array', items: { type: 'string' } },
    parentId: str(),
    related: { type: 'object' },
    inherit: { type: 'object' },
  }, ['revision']), json: ref('Ok'), capability: 'forms' }],
  ['delete', '/api/forms/templates/:templateId', 'forms', 'Delete a draft template (must already be archived)', { auth: FORMS_WRITE, body: obj({ revision: { type: 'integer', minimum: 1, description: 'Must match the current draft revision.' } }, ['revision']), json: ref('Ok'), capability: 'forms' }],
  ['post', '/api/forms/templates/:templateId/publish', 'forms', 'Publish the next immutable version', { auth: FORMS_WRITE, body: obj({ revision: { type: 'integer', minimum: 1, description: 'Optional; when given must match the current draft revision.' } }), json: ref('Ok'), capability: 'forms' }],
  ['post', '/api/forms/templates/:templateId/clone', 'forms', 'Clone a template', { auth: FORMS_WRITE, body: obj({ templateId: str('Defaults to "<source>-copy" (or "-copy-2", ...) when omitted.'), templateVersion: { type: 'integer', minimum: 1, description: 'Clones a published version instead of the current draft.' }, title: str('Defaults to "<source title> copy".') }), json: ref('Ok'), status: '201', capability: 'forms' }],
  ['post', '/api/forms/templates/:templateId/archive', 'forms', 'Archive a template', { auth: FORMS_WRITE, body: obj({ revision: { type: 'integer', minimum: 1, description: 'Must match the current draft revision.' } }, ['revision']), json: ref('Ok'), capability: 'forms' }],
  ['post', '/api/forms/templates/:templateId/restore', 'forms', 'Restore an archived template', { auth: FORMS_WRITE, body: obj({ revision: { type: 'integer', minimum: 1, description: 'Must match the current draft revision.' } }, ['revision']), json: ref('Ok'), capability: 'forms' }],
  ['get', '/api/forms/:templateId/list', 'forms', 'Read list current state (virtual revision 0 when absent)', { json: ref('Ok'), capability: 'forms', endpointKey: 'formsList' }],
  ['put', '/api/forms/:templateId/list', 'forms', 'Replace list current state with revision CAS (revision 0 creates)', { auth: FORMS_WRITE, body: obj({
    revision: { type: 'integer', minimum: 0, description: 'Expected revision; 0 when no list-state file exists yet.' },
    sections: { type: 'array', items: { type: 'object' } },
    items: { type: 'array', items: { type: 'object' } },
  }, ['revision', 'sections', 'items']), json: ref('Ok'), capability: 'forms', endpointKey: 'formsList' }],
  ['post', '/api/forms/:templateId/list/validate', 'forms', 'Validate a list-state candidate without writing', { auth: FORMS_WRITE, body: obj({
    revision: { type: 'integer', minimum: 0 },
    sections: { type: 'array', items: { type: 'object' } },
    items: { type: 'array', items: { type: 'object' } },
  }, ['revision', 'sections', 'items']), json: ref('Ok'), capability: 'forms' }],
  ['post', '/api/forms/:templateId/submissions', 'forms', 'Submit an entry', { auth: FORMS_WRITE, body: obj({
    values: { type: 'object' },
    idempotencyKey: str('Also accepted as the Idempotency-Key header; the header wins if both are present.'),
    eventAt: str('ISO-8601; with timezone/clientOffsetMinutes, backdates the entry.'),
    timezone: str(),
    clientOffsetMinutes: { type: 'integer' },
    supersedesRecord: { ...obj({ resourceKind: { type: 'string', enum: ['form-submission'] }, id: str() }, ['resourceKind', 'id']), description: 'Corrects a prior submission on this template; caller must own it or hold forms.read_submissions/forms.manage on it.' },
  }, ['values']), json: ref('Ok'), status: '201', capability: 'forms', endpointKey: 'formsSubmissions' }],
  ['get', '/api/forms/:templateId/submissions', 'forms', 'List the caller\'s submissions', { json: ref('Ok'), capability: 'forms', endpointKey: 'formsSubmissions' }],
  ['get', '/api/forms/:templateId/submissions/:submissionId/history', 'forms', 'Submission correction history', { json: ref('Ok'), capability: 'forms' }],
];

const MARKER_PROBLEM = obj({
  sourceId: str(), markerId: str(), detailId: str(), documentId: str(), message: str('Neutral explanation; never an absolute path.'),
}, ['sourceId', 'message']);
const MARKER_TEMPLATES_LIST = obj({
  ok: { type: 'boolean' },
  templates: { type: 'array', items: obj({
    templateId: str(), revision: { type: 'integer' }, title: str(), unit: { type: 'string', enum: ['samples', 'ms', 'seconds'] },
    markerCount: { type: 'integer' }, hasProjections: { type: 'boolean' }, source: { type: 'string', enum: ['bundled', 'stored', 'file'] }, writable: { type: 'boolean' },
  }) },
  skipped: { type: 'array', description: 'Template files that were present but not used.', items: obj({
    file: str('Base name only.'), source: { type: 'string', enum: ['stored', 'file'] }, reason: str('First validation message or parse error class.'),
  }, ['file', 'source', 'reason']) },
}, ['ok', 'templates', 'skipped']);
const MARKER_CONTEXT = obj({
  ok: { type: 'boolean' },
  template: obj({ templateId: str(), revision: { type: 'integer' }, unit: str() }),
  target: { type: ['object', 'null'], description: 'Root-relative path, sha256 and mtimeMs of the located file, or null.' },
  targetSha256: { type: ['string', 'null'] },
  sources: { type: 'array', items: { type: 'object', description: 'Reference overlay { id, as, points[], regions[] } in samples.' } },
  reads: { type: 'object', description: 'Marker id to sample or { startSample, endSample }.' },
  targetValues: { type: 'object', description: 'Same as reads: values currently present in the target.' },
  image: { type: ['object', 'null'], description: '{ url, plot } for a time-aligned strip, or null.' },
  details: { type: 'array', description: 'Values read from a resolved source document.', items: obj({
    id: str(), label: str(), kind: { type: 'string', enum: ['text', 'number', 'list', 'yaml'] },
    value: { description: 'string, number, array of strings, or null when the value is absent.', oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'array', items: { type: 'string' } }, { type: 'null' }] },
  }, ['id', 'label', 'kind', 'value']) },
  documents: { type: 'array', description: 'Text or markdown files located under a root, truncated at their byte limit.', items: obj({
    id: str(), label: str(), text: str(), truncated: { type: 'boolean' }, path: str('Root-relative path.'),
  }, ['id', 'label', 'text', 'truncated', 'path']) },
  projections: { type: 'array', items: obj({ id: str(), kind: str(), label: str(), acceptable: { type: 'boolean' } }) },
  problems: { type: 'array', items: MARKER_PROBLEM },
}, ['ok', 'template', 'sources', 'reads', 'targetValues', 'details', 'documents', 'projections', 'problems']);

const MARKER_BODY_RECORD = obj({
  audio: obj({ repo: str(), path: str() }, ['repo', 'path']),
  templateId: str('Marker template id.'),
  templateRevision: { type: 'integer', minimum: 1, description: 'Template revision the markers were made against.' },
  markers: { type: 'array', items: { type: 'object', description: 'Marker { id, type, ... } with sample positions.' } },
  tags: { type: 'object', description: 'Template-declared tag values.' },
  reason: str('Required when the template requires one.'),
  supersedesRecord: obj({ id: str() }, ['id']),
  actor: obj({ name: str('Self-asserted display name (browser callers only).') }),
  touched: { type: 'array', items: { type: 'string' }, description: 'Marker ids written back by a projection.' },
  overrides: { type: 'array', items: { type: 'object' }, description: 'Operator overrides of soft constraints, each { markerId, ... }.' },
  projection: obj({
    id: str('Projection id declared by the template.'),
    mode: { type: 'string', enum: ['live'] },
    accept: { type: 'boolean' },
    expectedTargetSha256: str('SHA-256 of the target file the caller last read; required.'),
  }, ['id']),
}, ['audio', 'templateId', 'templateRevision', 'markers']);
const MARKER_CONFLICT_NOTE = 'Stale writes answer 409 revision_conflict (currentRecordId or currentRevision), target_conflict (currentTargetSha256) or sidecar_conflict; invalid positions or constraints answer 422 validation_error.';

const MARKERS_ROUTES = [
  ['get', '/api/markers/templates', 'markers', 'List marker templates (bundled and stored) and the template files that were skipped', { json: MARKER_TEMPLATES_LIST, capability: 'markers', endpointKey: 'markerTemplates' }],
  ['get', '/api/markers/templates/:templateId', 'markers', 'Read one marker template', { json: ref('Ok'), capability: 'markers' }],
  ['post', '/api/markers/templates', 'markers', 'Create a marker template (template admin)', { auth: MARKERS_WRITE, body: obj({
    templateId: str('Marker template id.'),
    title: str(),
    unit: { type: 'string', enum: ['samples', 'ms', 'seconds'] },
    groups: { type: 'array', items: { type: 'object' } },
    markers: { type: 'array', items: { type: 'object' } },
    keys: { type: 'object' },
    sources: { type: 'array', items: { type: 'object' } },
    projections: { type: 'array', items: { type: 'object' } },
  }, ['templateId']), json: ref('Ok'), status: '201', errors: [409, 422], capability: 'markers' }],
  ['patch', '/api/markers/templates/:templateId', 'markers', 'Revise a marker template (template admin); expectedRevision is required', { auth: MARKERS_WRITE, body: obj({
    expectedRevision: { type: 'integer', minimum: 1, description: 'Must match the current revision; revision is accepted as an alias.' },
  }, ['expectedRevision']), json: ref('Ok'), errors: [409, 422], capability: 'markers' }],
  ['delete', '/api/markers/templates/:templateId', 'markers', 'Remove a marker template (template admin); history is kept', { auth: MARKERS_WRITE, body: obj({
    expectedRevision: { type: 'integer', minimum: 1 },
  }, ['expectedRevision']), json: ref('Ok'), errors: [409, 422], capability: 'markers' }],
  ['get', '/api/markers/context', 'markers', 'Resolved sources, target reads, details, documents and projection list for one audio file and template (root-relative paths only)', { json: MARKER_CONTEXT, query: [
    q('repo', 'Repository or audio root id.', { type: 'string' }, true),
    q('path', 'Audio file path below the repository.', { type: 'string' }, true),
    q('template', 'Marker template id.', { type: 'string' }, true),
  ], errors: [409, 413, 415, 503], capability: 'markers', endpointKey: 'markerContext' }],
  ['get', '/api/markers/records', 'markers', 'Latest marker record per template for one audio file (keyed by its SHA-256); all=1 lists every record', { json: ref('Ok'), query: [
    q('repo', 'Repository or audio root id.', { type: 'string' }, true),
    q('path', 'Audio file path below the repository.', { type: 'string' }, true),
    q('templateId', 'Only this template.', { type: 'string' }),
    q('all', '1 lists every record, not only the latest.', { type: 'string', enum: ['1'] }),
  ], errors: [413, 415, 503], capability: 'markers', endpointKey: 'markerRecords' }],
  ['get', '/api/markers/records/:recordId', 'markers', 'Read one marker record', { json: ref('Ok'), capability: 'markers' }],
  ['get', '/api/markers/records/:recordId/history', 'markers', 'Supersession history of a marker record', { json: ref('Ok'), capability: 'markers' }],
  ['post', '/api/markers/records', 'markers', `Save an immutable marker record (write permission on the audio path); optional live projection write-back. ${MARKER_CONFLICT_NOTE}`, { auth: MARKERS_WRITE, body: MARKER_BODY_RECORD, json: ref('Ok'), status: '201', errors: [409, 413, 415, 422, 503], capability: 'markers' }],
  ['post', '/api/markers/preview', 'markers', 'Dry-run the constraint check and a projection; writes nothing durable', { auth: MARKERS_WRITE, body: MARKER_BODY_RECORD, json: ref('Ok'), errors: [409, 413, 415, 422, 503], capability: 'markers', endpointKey: 'markerPreview' }],
];

const TAGS = [
  ['discovery', 'Caller-scoped discovery and API description'],
  ['content', 'Mounted repository viewing and editing'],
  ['annotations', 'File annotations'],
  ['managed-repos', 'Managed repositories and search'],
  ['publish', 'Immutable publishing'],
  ['admin', 'Administrative stores (admin token)'],
  ['appearance', 'Themes and wallpapers'],
  ['kits', 'Hosted HTML kits'],
  ['audio', 'Audio info and waveform peaks'],
  ['forms', 'Forms (mounted only when forms.enabled)'],
  ['markers', 'Audio marker templates and records (mounted only when markers.enabled)'],
];

function openApiPath(expressPath) {
  return expressPath.replace(/:([A-Za-z]+)/g, '{$1}').replace(/\*/g, '{path}');
}

function operationId(method, expressPath) {
  const words = expressPath
    .replace(/\*/g, 'path')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.replace(/^./, (c) => c.toUpperCase()));
  return `${method}${words.join('') || 'Root'}`;
}

function securityFor(auth) {
  if (auth === PUBLIC) return [];
  if (auth === FORMS_WRITE || auth === MARKERS_WRITE) return [{ bearerAuth: [] }, { browserContext: [] }];
  if (auth === WRITE || auth === ADMIN) return [{ bearerAuth: [] }];
  return [{ bearerAuth: [] }, { queryToken: [] }];
}

const ERROR_RESPONSE = { $ref: '#/components/responses/Error' };

function buildOperation(method, expressPath, tag, summary, extra) {
  const auth = extra.auth || READ;
  const parameters = [...expressPath.matchAll(/:([A-Za-z]+)/g)].map((match) => ({
    name: match[1], in: 'path', required: true, schema: { type: 'string' },
  }));
  if (expressPath.includes('*')) {
    parameters.push({ name: 'path', in: 'path', required: true, description: 'File path below the repository (may contain slashes).', schema: { type: 'string' } });
  }
  parameters.push(...(extra.query || []));

  const successStatus = extra.status || '200';
  let content;
  if (extra.html) content = { 'text/html': { schema: { type: 'string' } } };
  else if (extra.binary) content = { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } };
  else if (extra.json) content = { 'application/json': { schema: extra.json } };
  const success = { description: successStatus.startsWith('3') ? 'Redirect' : 'Success', ...(content ? { content } : {}) };

  const operation = {
    operationId: operationId(method, expressPath),
    summary,
    tags: [tag],
    ...(auth === ADMIN || auth === ADMIN_READ ? { description: 'Requires the store-specific admin token (admin token), not caller permissions; that token is not a caller credential and is refused on content routes.' } : {}),
    ...(auth === FORMS_WRITE ? { description: 'Agents: bearer token. Browsers: form context cookie + X-CSRF-Token from the served form page + an Origin matching a configured public origin. 403 origin_rejected / csrf_rejected name the missing piece. Errors are JSON for API callers; HTML/browser form routes answer text/plain unless Accept prefers JSON.' } : {}),
    ...(auth === MARKERS_WRITE ? { description: 'Agents: bearer token. Browsers: the marker context cookie + X-CSRF-Token from the served viewer page + an Origin matching a configured public origin. 403 origin_rejected / csrf_rejected name the missing piece.' } : {}),
    ...(extra.pathNote ? { description: extra.pathNote } : {}),
    security: securityFor(auth),
    ...(parameters.length ? { parameters } : {}),
    responses: {
      [successStatus]: success,
      400: ERROR_RESPONSE,
      401: ERROR_RESPONSE,
      403: ERROR_RESPONSE,
      404: ERROR_RESPONSE,
      500: ERROR_RESPONSE,
    },
  };
  if (auth === PUBLIC) {
    delete operation.responses[401];
    delete operation.responses[403];
  }
  if (Array.isArray(extra.errors)) {
    for (const code of extra.errors) {
      operation.responses[String(code)] = ERROR_RESPONSE;
    }
  }
  if (extra.rawBody) {
    operation.requestBody = { required: true, content: Object.fromEntries(extra.rawBody.map((type) => [type, { schema: { type: 'string', format: 'binary' } }])) };
  } else if (extra.body) {
    operation.requestBody = { required: true, content: { 'application/json': { schema: extra.body } } };
  } else if (extra.form) {
    operation.requestBody = { required: true, content: { [FORM_POST.contentType]: { schema: FORM_POST.schema } } };
  }
  if (extra.capability) operation['x-lookie-capability'] = extra.capability;
  if (extra.endpointKey && ENDPOINT_TEMPLATES[extra.endpointKey]) operation['x-lookie-endpoint-key'] = extra.endpointKey;
  return operation;
}

function buildOpenApiDocument({
  formsEnabled = false, markersEnabled = false, version = '0.0.0', baseUrl = '/',
} = {}) {
  const routes = [
    ...CORE_ROUTES,
    ...(formsEnabled ? FORMS_ROUTES : []),
    ...(markersEnabled ? MARKERS_ROUTES : []),
  ];
  const paths = {};
  for (const [method, expressPath, tag, summary, extra] of routes) {
    const key = openApiPath(expressPath);
    paths[key] = paths[key] || {};
    paths[key][method] = buildOperation(method, expressPath, tag, summary, extra);
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Lookie-Link API',
      version,
      description: 'Caller-scoped file viewing, annotation, managed-repository, publishing and forms API. docs/CAPABILITIES.md is the authoritative route matrix; this document is test-bound to it.',
    },
    servers: [{ url: baseUrl }],
    tags: TAGS.filter(([name]) => (formsEnabled || name !== 'forms') && (markersEnabled || name !== 'markers')).map(([name, description]) => ({ name, description })),
    security: [{ bearerAuth: [] }, { queryToken: [] }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'Static token, managed API key, managed grant, or admin token.' },
        queryToken: { type: 'apiKey', in: 'query', name: 'token', description: 'Read requests only; every mutation rejects query credentials.' },
        browserContext: { type: 'apiKey', in: 'header', name: 'X-CSRF-Token', description: 'Browser path for forms mutations: the synchronizer token from the served form page, sent with the form context cookie AND an Origin header matching a configured public origin. Agents do not scrape this: present bearerAuth instead. Refusals name the missing piece: 403 origin_rejected or 403 csrf_rejected.' },
      },
      schemas: {
        Error: obj({
          ok: { type: 'boolean', const: false },
          error: obj({
            code: str('Stable snake_case identifier.'),
            message: str(),
            details: { type: 'array', items: obj({ path: str(), message: str() }) },
          }, ['code', 'message']),
        }, ['ok', 'error']),
        Ok: { type: 'object', properties: { ok: { type: 'boolean' } }, additionalProperties: true },
        Kit: obj({
          name: str(),
          label: str(),
          version: str('Manifest version string.'),
          effectiveVersion: str('bundled/shared: <version>[+overlayHash]; org: <version>@<currentVersion>[+overlayHash]'),
          scope: { type: 'string', enum: ['bundled', 'shared', 'org'] },
          org: str('Present when scope is org; R15a is always "default".'),
          currentVersion: { type: 'integer', minimum: 1, description: 'Org kits only.' },
          versions: {
            type: 'array',
            description: 'Show only; org kits.',
            items: obj({
              version: { type: 'integer', minimum: 1 },
              createdAt: str(),
              sizeBytes: { type: 'integer', minimum: 0 },
            }),
          },
          source: { type: 'string', enum: ['bundled', 'config', 'shared', 'org'] },
          writable: { type: 'boolean' },
          stylesheetUrl: str(),
          pinnedStylesheetUrl: str(),
          overlay: { type: 'object', nullable: true },
        }, ['name', 'label', 'version', 'effectiveVersion', 'scope', 'source', 'writable']),
        Discovery: { type: 'object', properties: { ok: { type: 'boolean' }, capabilities: { type: 'object' }, endpoints: { type: 'object' } }, additionalProperties: true },
      },
      responses: {
        Error: { description: 'Error envelope', content: { 'application/json': { schema: ref('Error') } } },
      },
    },
  };
}

// The try-it explorer: public/api-docs.html (body fragment) inside the shared
// baseHtml shell so it follows the viewer theme; public/api-docs.js drives it.
let apiDocsBody = null;
function renderApiDocsPage({ customThemeCss = '' } = {}) {
  if (apiDocsBody === null) {
    apiDocsBody = fs.readFileSync(path.join(__dirname, '..', 'public', 'api-docs.html'), 'utf8');
  }
  // Required lazily: renderer pulls in the markdown/sanitizer stack.
  const { baseHtml } = require('./renderer');
  return baseHtml({ title: 'Lookie API explorer', body: apiDocsBody, customThemeCss });
}

module.exports = { buildOpenApiDocument, openApiPath, renderApiDocsPage };
