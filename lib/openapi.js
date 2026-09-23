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
  ['get', '/api/repos', 'discovery', 'Caller-visible repositories', { json: obj({ repos: { type: 'array', items: obj({ repo: str(), viewUrl: str(), assetUrl: str() }) }, count: { type: 'integer' } }), capability: 'repoDiscovery', endpointKey: 'repos' }],
  ['get', '/openapi.json', 'discovery', 'This OpenAPI document', { json: { type: 'object' } }],
  ['get', '/api/docs', 'discovery', 'Interactive API explorer (HTML)', { html: true }],
  ['get', '/view', 'content', 'Redirect to the repository index', { auth: PUBLIC, status: '302' }],
  ['get', '/view/*', 'content', 'Render or browse a file or directory (HTML)', { html: true, query: [VERSION_Q, q('validate', 'For HTML files, 1 returns a JSON reference report.')], endpointKey: 'view' }],
  ['get', '/asset/:repo/*', 'content', 'Raw allowlisted asset', { binary: true, query: [VERSION_Q], capability: 'assetRead', endpointKey: 'assetRead' }],
  ['get', '/raw/:repo/*', 'content', 'Verbatim HTML file', { html: true, query: [VERSION_Q], capability: 'rawHtml', endpointKey: 'rawHtml' }],
  ['get', '/embed/:repo/*', 'content', 'Transformed embeddable HTML file', { html: true, capability: 'embeddedHtml', endpointKey: 'embeddedHtml' }],
  ['get', '/edit/*', 'content', 'Editor page (HTML)', { html: true, capability: 'editing', endpointKey: 'edit' }],
  ['post', '/api/save/*', 'content', 'Save a mounted file', { auth: WRITE, body: obj({ content: str(), expectedMtimeMs: MTIME }, ['content']), json: ref('Ok'), capability: 'editing', endpointKey: 'save' }],
  ['post', '/api/preview/*', 'content', 'Render draft content without writing', { auth: WRITE, body: obj({ content: str() }, ['content']), json: ref('Ok'), capability: 'editing', endpointKey: 'preview' }],
  ['get', '/api/appearance', 'appearance', 'List themes, palettes, aliases, picture sets and glass defaults (pollable; ETag)', { json: ref('Ok'), capability: 'appearance', endpointKey: 'appearance' }],
  ['get', '/api/appearance/themes/:slug', 'appearance', 'One theme by slug or alias', { json: ref('Ok'), capability: 'appearance', endpointKey: 'appearanceTheme' }],
  ['patch', '/api/appearance', 'appearance', 'Change themes, palettes, aliases, wallpaper folders or glass defaults (admin; overlay file; revision guard)', { auth: ADMIN, body: obj({ expectedRevision: { type: 'integer', minimum: 0 }, wallpapers: { type: 'object' }, themes: { type: 'object' } }, ['expectedRevision']), json: ref('Ok') }],
  ['post', '/api/appearance/themes/:slug/wallpapers/:mode', 'appearance', 'Upload a picture into the managed folder (raw image body; ?name= becomes the id)', { auth: ADMIN, query: [q('name', 'Picture id: lowercase letters, digits, hyphens.', { type: 'string' }, true)], rawBody: ['image/jpeg', 'image/png', 'image/webp'], json: ref('Ok'), status: '201' }],
  ['delete', '/api/appearance/themes/:slug/wallpapers/:mode/:id', 'appearance', 'Delete a managed picture', { auth: ADMIN, json: ref('Ok') }],
  ['get', '/wallpaper/:slug/:mode/:id', 'appearance', 'Wallpaper image from a theme catalog', { binary: true, capability: 'wallpapers', endpointKey: 'wallpaperImage' }],
  ['get', '/api/annotations/:repo/*', 'annotations', 'Read a file\'s annotations', { query: [q('state', 'Repeatable filter.', { type: 'string', enum: ['open', 'claimed', 'resolved'] })], json: ref('Ok'), capability: 'annotations', endpointKey: 'annotationRead' }],
  ['post', '/api/annotations/:repo/*', 'annotations', 'Create an annotation', { auth: WRITE, body: obj({ anchor: str(), anchorKind: { type: 'string', enum: ['heading', 'yamlKey', 'lineRange'] }, body: str(), author: str() }, ['anchor', 'body']), json: ref('Ok'), status: '201', capability: 'annotationWrite', endpointKey: 'annotationCreate' }],
  ['patch', '/api/annotations/:repo/*', 'annotations', 'Claim, resolve, reopen, reply to or redact an annotation', { auth: WRITE, body: obj({ id: str(), action: { type: 'string', enum: ['claim', 'resolve', 'reopen', 'reply', 'redact'] }, body: str(), author: str(), expectedMtimeMs: MTIME }, ['id', 'action']), json: ref('Ok'), capability: 'annotationWrite', endpointKey: 'annotationUpdate' }],
  ['get', '/api/repos/:repo/tree', 'content', 'Bounded directory tree of any served repo (managed or mapped)', { query: [q('path', 'Directory below the repo root.'), q('maxDepth', 'Depth bound.', { type: 'integer' }), q('maxEntries', 'Entry bound.', { type: 'integer' })], json: ref('Ok'), capability: 'repoRead', endpointKey: 'repoTree' }],
  ['get', '/api/repos/:repo/changes', 'content', 'Files changed since a timestamp in any served repo, newest first', { query: [q('since', 'Epoch milliseconds (compared against file mtimeMs).', { type: 'number' }), q('maxEntries', 'Entry bound.', { type: 'integer' })], json: ref('Ok'), capability: 'repoRead', endpointKey: 'repoChanges' }],
  ['get', '/api/repos/:repo/files/*', 'content', 'Read a text file from any served repo as JSON (content, mtimeMs, size)', { json: obj({ ok: { type: 'boolean' }, repo: str(), managed: { type: 'boolean' }, path: str(), content: str(), size: { type: 'integer' }, mtimeMs: { type: 'number' }, viewUrl: str() }), capability: 'repoRead', endpointKey: 'repoFileRead' }],
  ['get', '/api/managed-repos', 'managed-repos', 'List visible managed repositories', { json: ref('Ok'), capability: 'managedRepos', endpointKey: 'managedRepoList' }],
  ['post', '/api/managed-repos', 'admin', 'Register or create a managed repository', { auth: ADMIN, body: obj({ repoId: str(), path: str(), create: { type: 'boolean' } }, ['repoId']), json: ref('Ok'), status: '201' }],
  ['get', '/api/managed-repos/:repo/tree', 'managed-repos', 'Bounded directory tree', { query: [q('path', 'Directory below the repo root.'), q('maxDepth', 'Depth bound.', { type: 'integer' }), q('maxEntries', 'Entry bound.', { type: 'integer' })], json: ref('Ok'), capability: 'managedRepos', endpointKey: 'managedTree' }],
  ['get', '/api/managed-repos/:repo/changes', 'managed-repos', 'Files changed since a timestamp', { query: [q('since', 'Epoch milliseconds (compared against file mtimeMs).', { type: 'number' }), q('maxEntries', 'Entry bound.', { type: 'integer' })], json: ref('Ok'), capability: 'managedRepos', endpointKey: 'managedChanges' }],
  ['get', '/api/managed-repos/:repo/files/*', 'managed-repos', 'Read a managed file', { json: obj({ ok: { type: 'boolean' }, path: str(), content: str(), size: { type: 'integer' }, mtimeMs: { type: 'number' } }), capability: 'managedRepos', endpointKey: 'managedFileRead' }],
  ['put', '/api/managed-repos/:repo/files/*', 'managed-repos', 'Create or update a managed file', { auth: WRITE, body: obj({ content: str(), expectedMtimeMs: MTIME }, ['content']), json: ref('Ok'), capability: 'managedRepos', endpointKey: 'managedFileWrite' }],
  ['delete', '/api/managed-repos/:repo/files/*', 'managed-repos', 'Soft-delete (or hard-delete) a managed file', { auth: WRITE, query: [q('hard', '1 deletes permanently.')], json: ref('Ok'), capability: 'managedRepos' }],
  ['post', '/api/managed-repos/:repo/trash/:trashId/restore', 'managed-repos', 'Restore a soft-deleted file', { auth: WRITE, json: ref('Ok'), capability: 'managedRepos' }],
  ['delete', '/api/managed-repos/:repo/trash/:trashId', 'managed-repos', 'Permanently delete one trash item', { auth: WRITE, json: ref('Ok'), capability: 'managedRepos' }],
  ['get', '/api/search', 'content', 'Search every served repository the caller can view (managed and mapped)', { query: [q('q', 'Search text.', { type: 'string' }, true), q('scope', 'Repeatable repo or repo/path scope.'), q('limit', 'Result bound.', { type: 'integer' }), q('maxEntries', 'Candidate bound.', { type: 'integer' })], json: ref('Ok'), capability: 'search', endpointKey: 'search' }],
  ['get', '/api/search/suggest', 'content', 'Path suggestions across served repositories', { query: [q('q', 'Prefix text.', { type: 'string' }, true), q('scope', 'Repeatable scope.'), q('limit', 'Result bound.', { type: 'integer' }), q('maxEntries', 'Candidate bound.', { type: 'integer' })], json: ref('Ok'), capability: 'search', endpointKey: 'searchSuggest' }],
  ['post', '/api/publish', 'publish', 'Publish a new bundle (revision 1)', { auth: WRITE, body: BUNDLE, json: ref('Ok'), status: '201', capability: 'publish', endpointKey: 'publishCreate' }],
  ['post', '/api/publish/:slug', 'publish', 'Publish the next immutable revision', { auth: WRITE, body: { ...BUNDLE, required: ['files', 'expectedRevision'], properties: { ...BUNDLE.properties, expectedRevision: { type: 'integer', minimum: 1 } } }, json: ref('Ok'), capability: 'publish', endpointKey: 'publishUpdate' }],
  ['post', '/api/publish/:slug/revoke', 'publish', 'Revoke a published bundle', { auth: WRITE, body: REASON, json: ref('Ok'), capability: 'publish', endpointKey: 'publishRevoke' }],
  ['get', '/api/agent-keys', 'admin', 'List managed API keys', { auth: ADMIN, query: [q('state', 'Key state filter.'), q('agentId', 'Agent filter.'), q('includeAudit', '1 includes the audit projection.')], json: ref('Ok') }],
  ['post', '/api/agent-keys', 'admin', 'Create a managed API key (secret returned once)', { auth: ADMIN, body: obj({ agentId: str(), companyId: str(), label: str(), permissions: { type: 'object' }, repos: {} }, ['agentId']), json: ref('Ok'), status: '201' }],
  ['post', '/api/agent-keys/:keyId/rotate', 'admin', 'Rotate a managed API key', { auth: ADMIN, body: obj({}), json: ref('Ok') }],
  ['post', '/api/agent-keys/:keyId/revoke', 'admin', 'Revoke a managed API key', { auth: ADMIN, body: REASON, json: ref('Ok') }],
  ['get', '/api/grants', 'admin', 'List managed grants', { auth: ADMIN_READ, query: [q('sourceCompanyId', 'Filter.'), q('targetCompanyId', 'Filter.'), q('repoId', 'Filter.'), q('state', 'Filter.'), q('includeAudit', '1 includes the audit projection.')], json: ref('Ok') }],
  ['post', '/api/grants', 'admin', 'Create a managed grant', { auth: ADMIN, body: obj({ issuer: { type: 'object' }, subject: { type: 'object' }, repos: {}, permissions: { type: 'object' }, expiresAt: str() }, ['issuer', 'subject', 'expiresAt']), json: ref('Ok'), status: '201' }],
  ['post', '/api/grants/:grantId/renew', 'admin', 'Renew a managed grant', { auth: ADMIN, body: obj({ expiresAt: str(), rotateToken: { type: 'boolean' } }), json: ref('Ok') }],
  ['post', '/api/grants/:grantId/revoke', 'admin', 'Revoke a managed grant', { auth: ADMIN, body: obj({ reason: str(), issuer: { type: 'object' } }, ['reason']), json: ref('Ok') }],
];

const FORMS_ROUTES = [
  ['get', '/forms', 'forms', 'Forms index (HTML)', { html: true, capability: 'forms', endpointKey: 'forms' }],
  ['get', '/forms/new', 'forms', 'New-template page (HTML)', { html: true, capability: 'forms' }],
  ['post', '/forms', 'forms', 'Create a template from the browser builder', { auth: WRITE, form: true, status: '303', capability: 'forms' }],
  ['get', '/forms/entries', 'forms', 'Caller entry history across forms (HTML)', { html: true, capability: 'forms' }],
  ['get', '/forms/:templateId', 'forms', 'Form page (HTML)', { html: true, capability: 'forms' }],
  ['post', '/forms/:templateId', 'forms', 'Native form submit', { auth: WRITE, form: true, status: '303', capability: 'forms' }],
  ['post', '/forms/:templateId/delete', 'forms', 'Delete a draft template from the browser', { auth: WRITE, form: true, status: '303', capability: 'forms' }],
  ['post', '/forms/:templateId/clone', 'forms', 'Clone a template from the browser', { auth: WRITE, form: true, status: '303', capability: 'forms' }],
  ['post', '/forms/:templateId/archive', 'forms', 'Archive a template from the browser', { auth: WRITE, form: true, status: '303', capability: 'forms' }],
  ['post', '/forms/:templateId/restore', 'forms', 'Restore an archived template from the browser', { auth: WRITE, form: true, status: '303', capability: 'forms' }],
  ['get', '/forms/:templateId/configure', 'forms', 'Template builder (HTML)', { html: true, capability: 'forms' }],
  ['post', '/forms/:templateId/configure', 'forms', 'Save the builder draft', { auth: WRITE, form: true, status: '303', capability: 'forms' }],
  ['post', '/forms/:templateId/configure/publish', 'forms', 'Publish the builder draft', { auth: WRITE, form: true, status: '303', capability: 'forms' }],
  ['post', '/forms/:templateId/configure/restore-version', 'forms', 'Restore a published version into the draft', { auth: WRITE, form: true, status: '303', capability: 'forms' }],
  ['get', '/forms/:templateId/entries', 'forms', 'Entry history for one form (HTML)', { html: true, capability: 'forms' }],
  ['get', '/forms/:templateId/receipts/:submissionId', 'forms', 'Submission receipt (HTML)', { html: true, capability: 'forms' }],
  ['get', '/forms/:templateId/receipts/:submissionId/edit', 'forms', 'Correct a submission (HTML)', { html: true, capability: 'forms' }],
  ['get', '/api/forms/templates', 'forms', 'List templates', { json: ref('Ok'), capability: 'forms', endpointKey: 'formsTemplates' }],
  ['post', '/api/forms/templates', 'forms', 'Create a draft template', { auth: WRITE, body: obj({ id: str(), title: str(), fields: { type: 'array', items: { type: 'object' } }, destinationId: str() }, ['id', 'title', 'fields']), json: ref('Ok'), status: '201', capability: 'forms', endpointKey: 'formsTemplates' }],
  ['get', '/api/forms/templates/:templateId', 'forms', 'Read template management metadata', { json: ref('Ok'), capability: 'forms' }],
  ['patch', '/api/forms/templates/:templateId', 'forms', 'Revise a draft template', { auth: WRITE, body: obj({ revision: { type: 'integer', minimum: 1 }, title: str(), fields: { type: 'array', items: { type: 'object' } } }, ['revision']), json: ref('Ok'), capability: 'forms' }],
  ['delete', '/api/forms/templates/:templateId', 'forms', 'Delete a draft template', { auth: WRITE, json: ref('Ok'), capability: 'forms' }],
  ['post', '/api/forms/templates/:templateId/publish', 'forms', 'Publish the next immutable version', { auth: WRITE, body: obj({ revision: { type: 'integer', minimum: 1 } }), json: ref('Ok'), capability: 'forms' }],
  ['post', '/api/forms/templates/:templateId/clone', 'forms', 'Clone a template', { auth: WRITE, body: obj({ id: str(), title: str() }), json: ref('Ok'), status: '201', capability: 'forms' }],
  ['post', '/api/forms/templates/:templateId/archive', 'forms', 'Archive a template', { auth: WRITE, body: obj({ revision: { type: 'integer', minimum: 1 } }), json: ref('Ok'), capability: 'forms' }],
  ['post', '/api/forms/templates/:templateId/restore', 'forms', 'Restore an archived template', { auth: WRITE, body: obj({ revision: { type: 'integer', minimum: 1 } }), json: ref('Ok'), capability: 'forms' }],
  ['post', '/api/forms/:templateId/submissions', 'forms', 'Submit an entry', { auth: WRITE, body: obj({ values: { type: 'object' }, idempotencyKey: str() }, ['values']), json: ref('Ok'), status: '201', capability: 'forms', endpointKey: 'formsSubmissions' }],
  ['get', '/api/forms/:templateId/submissions', 'forms', 'List the caller\'s submissions', { json: ref('Ok'), capability: 'forms', endpointKey: 'formsSubmissions' }],
  ['get', '/api/forms/:templateId/submissions/:submissionId/history', 'forms', 'Submission correction history', { json: ref('Ok'), capability: 'forms' }],
];

const TAGS = [
  ['discovery', 'Caller-scoped discovery and API description'],
  ['content', 'Mounted repository viewing and editing'],
  ['annotations', 'File annotations'],
  ['managed-repos', 'Managed repositories and search'],
  ['publish', 'Immutable publishing'],
  ['admin', 'Administrative stores (admin token)'],
  ['appearance', 'Themes and wallpapers'],
  ['forms', 'Forms (mounted only when forms.enabled)'],
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
    ...(auth === ADMIN || auth === ADMIN_READ ? { description: 'Requires the store-specific admin token (admin token), not caller permissions.' } : {}),
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

function buildOpenApiDocument({ formsEnabled = false, version = '0.0.0', baseUrl = '/' } = {}) {
  const routes = formsEnabled ? [...CORE_ROUTES, ...FORMS_ROUTES] : CORE_ROUTES;
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
    tags: TAGS.filter(([name]) => formsEnabled || name !== 'forms').map(([name, description]) => ({ name, description })),
    security: [{ bearerAuth: [] }, { queryToken: [] }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'Static token, managed API key, managed grant, or admin token.' },
        queryToken: { type: 'apiKey', in: 'query', name: 'token', description: 'Read requests only; every mutation rejects query credentials.' },
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
