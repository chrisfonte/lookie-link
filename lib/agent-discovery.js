'use strict';

const { canAccessPath, canAccessRepo } = require('./access-control');

const ENDPOINT_TEMPLATES = Object.freeze({
  agentDiscovery: '/.well-known/agent.json',
  whoami: '/api/whoami',
  repos: '/api/repos',
  view: '/view/:repo/*path',
  assetRead: '/asset/:repo/*path',
  edit: '/edit/:repo/*path',
  save: '/api/save/:repo/*path',
  preview: '/api/preview/:repo/*path',
  annotationRead: '/api/annotations/:repo/*path',
  annotationCreate: '/api/annotations/:repo/*path',
  annotationUpdate: '/api/annotations/:repo/*path',
  rawHtml: '/raw/:repo/*path',
  embeddedHtml: '/embed/:repo/*path',
  managedRepoList: '/api/managed-repos',
  managedFileRead: '/api/managed-repos/:repo/files/*path',
  managedFileWrite: '/api/managed-repos/:repo/files/*path',
  managedTree: '/api/managed-repos/:repo/tree',
  managedChanges: '/api/managed-repos/:repo/changes',
  search: '/api/search',
  searchSuggest: '/api/search/suggest',
  publishCreate: '/api/publish',
  publishUpdate: '/api/publish/:slug',
  publishRevoke: '/api/publish/:slug/revoke',
  wallpaperImage: '/wallpaper/:scheme/:mode/:id',
  appearance: '/api/appearance',
  repoTree: '/api/repos/:repo/tree',
  repoChanges: '/api/repos/:repo/changes',
  repoFileRead: '/api/repos/:repo/files/*path',
  appearanceTheme: '/api/appearance/themes/:slug',
  forms: '/forms',
  formsTemplates: '/api/forms/templates',
  formsSubmissions: '/api/forms/:templateId/submissions',
});

function storeIsEnabled(store) {
  return Boolean(store && typeof store.isEnabled === 'function' && store.isEnabled());
}

function sanitizeSubject(subject) {
  if (!subject || typeof subject !== 'object') {
    return null;
  }

  const sanitized = {};
  for (const key of ['companyId', 'agentId', 'label']) {
    if (typeof subject[key] === 'string' && subject[key].trim()) {
      sanitized[key] = subject[key];
    }
  }
  return Object.keys(sanitized).length > 0 ? sanitized : null;
}

function serializePermissions(permissions) {
  const source = permissions && typeof permissions === 'object' ? permissions : {};
  const write = source.write === true || source.edit === true;
  return {
    view: source.view === true,
    write,
    edit: write,
    publish: source.publish === true,
  };
}

function serializeScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    return [];
  }

  return scopes
    .filter((scope) => scope && typeof scope === 'object')
    .map((scope) => ({
      type: ['all', 'directory', 'file'].includes(scope.type) ? scope.type : 'all',
      path: typeof scope.path === 'string' ? scope.path : '',
    }));
}

function managedRepoIds(managedRepoStore) {
  if (!storeIsEnabled(managedRepoStore) || typeof managedRepoStore.listRepos !== 'function') {
    return new Set();
  }

  try {
    const result = managedRepoStore.listRepos();
    const repos = result && Array.isArray(result.repos) ? result.repos : [];
    return new Set(repos
      .filter((repo) => repo && typeof repo.id === 'string')
      .map((repo) => repo.id));
  } catch {
    return new Set();
  }
}

function buildRepoScopes(accessContext, mappings, managedRepoStore) {
  const managedIds = managedRepoIds(managedRepoStore);
  const repoIds = new Set(Object.keys(mappings || {}));

  return [...repoIds]
    .sort()
    .filter((repo) => canAccessPath(accessContext, 'view', repo, '', 'directory'))
    .map((repo) => ({
      repo,
      managed: managedIds.has(repo),
      scopes: accessContext.mode === 'unrestricted' || accessContext.allRepos
        ? [{ type: 'all', path: '' }]
        : serializeScopes(accessContext.repos && accessContext.repos[repo]),
    }))
    .filter((entry) => entry.scopes.length > 0);
}

function hasAnyPermission(accessContext, repoScopes, action) {
  return repoScopes.some((entry) => canAccessPath(accessContext, action, entry.repo, '', 'directory'));
}

function enabledRoute(routeAvailability, key) {
  return Boolean(routeAvailability && routeAvailability[key]);
}

function buildDiscoveryState({
  accessContext,
  mappings,
  editingEnabled,
  annotationsEnabled,
  rawHtmlEnabled,
  managedRepoStore,
  publishStore,
  publishedRepo,
  routeAvailability,
  wallpaperCatalog,
  formsEnabled,
}) {
  const publishEnabled = storeIsEnabled(publishStore);
  const repoScopes = buildRepoScopes(accessContext, mappings, managedRepoStore);
  const hasViewScope = hasAnyPermission(accessContext, repoScopes, 'view');
  const hasWriteScope = hasAnyPermission(accessContext, repoScopes, 'write');
  const managedEnabled = storeIsEnabled(managedRepoStore)
    && repoScopes.some((entry) => entry.managed)
    && enabledRoute(routeAvailability, 'managedRepoList')
    && enabledRoute(routeAvailability, 'managedFileRead');
  const publishAllowed = publishEnabled
    && Boolean(publishedRepo)
    && canAccessRepo(accessContext, 'publish', publishedRepo)
    && enabledRoute(routeAvailability, 'publishCreate');

  const capabilities = {
    whoami: enabledRoute(routeAvailability, 'whoami'),
    repoDiscovery: enabledRoute(routeAvailability, 'repos'),
    assetRead: hasViewScope && enabledRoute(routeAvailability, 'assetRead'),
    editing: Boolean(editingEnabled && hasWriteScope
      && enabledRoute(routeAvailability, 'edit')
      && enabledRoute(routeAvailability, 'save')),
    annotations: Boolean(annotationsEnabled && hasViewScope
      && enabledRoute(routeAvailability, 'annotationRead')),
    annotationWrite: Boolean(annotationsEnabled && hasWriteScope
      && enabledRoute(routeAvailability, 'annotationCreate')
      && enabledRoute(routeAvailability, 'annotationUpdate')),
    rawHtml: Boolean(rawHtmlEnabled && hasViewScope && enabledRoute(routeAvailability, 'rawHtml')),
    embeddedHtml: Boolean(rawHtmlEnabled && hasViewScope && enabledRoute(routeAvailability, 'embeddedHtml')),
    managedRepos: managedEnabled,
    // Search and the generic read routes cover every repo the caller can view,
    // managed or plainly mapped (API roadmap R2).
    search: Boolean(hasViewScope && enabledRoute(routeAvailability, 'search')),
    repoRead: Boolean(hasViewScope && enabledRoute(routeAvailability, 'repoTree') && enabledRoute(routeAvailability, 'repoFileRead')),
    publish: publishAllowed,
    // Appearance: any theme with a picture set makes the image route useful.
    wallpapers: Boolean(wallpaperCatalog && Object.keys(wallpaperCatalog).length && enabledRoute(routeAvailability, 'wallpaperImage')),
    // Forms live on a mounted router (invisible to app-level route scanning),
    // so availability comes from the config flag the server mounted them with.
    forms: Boolean(formsEnabled),
    // The pollable appearance list; admin writes on the same resource are not advertised.
    appearance: enabledRoute(routeAvailability, 'appearance'),
  };

  const endpoints = {
    agentDiscovery: ENDPOINT_TEMPLATES.agentDiscovery,
    whoami: ENDPOINT_TEMPLATES.whoami,
    repos: ENDPOINT_TEMPLATES.repos,
  };
  if (hasViewScope && enabledRoute(routeAvailability, 'view')) endpoints.view = ENDPOINT_TEMPLATES.view;
  if (capabilities.assetRead) endpoints.assetRead = ENDPOINT_TEMPLATES.assetRead;
  if (capabilities.editing) {
    endpoints.edit = ENDPOINT_TEMPLATES.edit;
    endpoints.save = ENDPOINT_TEMPLATES.save;
  }
  if (editingEnabled && hasViewScope && enabledRoute(routeAvailability, 'preview')) {
    endpoints.preview = ENDPOINT_TEMPLATES.preview;
  }
  if (capabilities.annotations) endpoints.annotationRead = ENDPOINT_TEMPLATES.annotationRead;
  if (capabilities.annotationWrite) {
    endpoints.annotationCreate = ENDPOINT_TEMPLATES.annotationCreate;
    endpoints.annotationUpdate = ENDPOINT_TEMPLATES.annotationUpdate;
  }
  if (capabilities.rawHtml) endpoints.rawHtml = ENDPOINT_TEMPLATES.rawHtml;
  if (capabilities.embeddedHtml) endpoints.embeddedHtml = ENDPOINT_TEMPLATES.embeddedHtml;
  if (capabilities.managedRepos) {
    endpoints.managedRepoList = ENDPOINT_TEMPLATES.managedRepoList;
    endpoints.managedFileRead = ENDPOINT_TEMPLATES.managedFileRead;
    if (hasWriteScope && enabledRoute(routeAvailability, 'managedFileWrite')) {
      endpoints.managedFileWrite = ENDPOINT_TEMPLATES.managedFileWrite;
    }
    if (enabledRoute(routeAvailability, 'managedTree')) endpoints.managedTree = ENDPOINT_TEMPLATES.managedTree;
    if (enabledRoute(routeAvailability, 'managedChanges')) endpoints.managedChanges = ENDPOINT_TEMPLATES.managedChanges;
  }
  if (capabilities.search) {
    endpoints.search = ENDPOINT_TEMPLATES.search;
    if (enabledRoute(routeAvailability, 'searchSuggest')) endpoints.searchSuggest = ENDPOINT_TEMPLATES.searchSuggest;
  }
  if (capabilities.publish) {
    endpoints.publishCreate = ENDPOINT_TEMPLATES.publishCreate;
    if (enabledRoute(routeAvailability, 'publishUpdate')) endpoints.publishUpdate = ENDPOINT_TEMPLATES.publishUpdate;
    if (enabledRoute(routeAvailability, 'publishRevoke')) endpoints.publishRevoke = ENDPOINT_TEMPLATES.publishRevoke;
  }
  if (capabilities.repoRead) {
    endpoints.repoTree = ENDPOINT_TEMPLATES.repoTree;
    endpoints.repoFileRead = ENDPOINT_TEMPLATES.repoFileRead;
    if (enabledRoute(routeAvailability, 'repoChanges')) endpoints.repoChanges = ENDPOINT_TEMPLATES.repoChanges;
  }
  if (capabilities.wallpapers) endpoints.wallpaperImage = ENDPOINT_TEMPLATES.wallpaperImage;
  if (capabilities.appearance) {
    endpoints.appearance = ENDPOINT_TEMPLATES.appearance;
    if (enabledRoute(routeAvailability, 'appearanceTheme')) endpoints.appearanceTheme = ENDPOINT_TEMPLATES.appearanceTheme;
  }
  if (capabilities.forms) {
    endpoints.forms = ENDPOINT_TEMPLATES.forms;
    endpoints.formsTemplates = ENDPOINT_TEMPLATES.formsTemplates;
    endpoints.formsSubmissions = ENDPOINT_TEMPLATES.formsSubmissions;
  }

  return { capabilities, endpoints, repoScopes };
}

function buildCallerDocument(accessContext, repoScopes) {
  return {
    auth: {
      mode: accessContext.mode,
      type: accessContext.authType || (accessContext.mode === 'unrestricted' ? 'human' : 'none'),
      source: accessContext.source || null,
      queryToken: Boolean(accessContext.queryToken),
    },
    subject: sanitizeSubject(accessContext.subject),
    permissions: serializePermissions(accessContext.permissions),
    repoScopes,
  };
}

// Appearance is an agent-addressable surface: every parameter here can be put
// on a viewer URL, and every picture id here resolves at the wallpaperImage
// template. Shared by both discovery documents so whoami and the agent card
// never disagree.
function buildThemesBlock(options) {
  const wallpaperCatalog = options.wallpaperCatalog || {};
  const wallpaperDefaults = options.wallpaperDefaults || { panelOpacity: 72, blur: 12 };
  return {
      parameters: {
        scheme: 'lookie-scheme',
        mode: 'lookie-theme',
        wallpaper: 'lookie-wallpaper',
        panelOpacity: 'lookie-panel',
        blur: 'lookie-blur',
      },
      modes: ['dark', 'light'],
      wallpapers: {
        imageUrl: ENDPOINT_TEMPLATES.wallpaperImage,
        none: 'none',
        panelOpacity: { min: 50, max: 100, default: wallpaperDefaults.panelOpacity },
        blur: { min: 0, max: 16, default: wallpaperDefaults.blur },
      },
      available: (options.themes || []).map((theme) => {
        const sets = wallpaperCatalog[theme.slug];
        return {
          id: theme.slug,
          label: theme.label,
          aliases: [...(theme.aliases || [])],
          wallpapers: sets
            ? { dark: sets.dark, light: sets.light, panelOpacity: sets.panelOpacity, blur: sets.blur }
            : { dark: [], light: [], panelOpacity: wallpaperDefaults.panelOpacity, blur: wallpaperDefaults.blur },
        };
      }),
  };
}

function buildWhoAmIDocument(options) {
  const state = buildDiscoveryState(options);
  return {
    ok: true,
    ...buildCallerDocument(options.accessContext, state.repoScopes),
    capabilities: state.capabilities,
    endpoints: state.endpoints,
    themes: buildThemesBlock(options),
  };
}

function buildAgentDiscoveryDocument(options) {
  const state = buildDiscoveryState(options);
  return {
    ok: true,
    schemaVersion: 1,
    name: 'lookie-link',
    themes: buildThemesBlock(options),
    version: options.version,
    generatedAt: new Date().toISOString(),
    instance: {
      baseUrl: options.baseUrl,
      mode: 'private-network',
    },
    authentication: {
      bearerToken: true,
      queryTokenForReadRequests: true,
    },
    discovery: {
      whoamiUrl: ENDPOINT_TEMPLATES.whoami,
      reposUrl: ENDPOINT_TEMPLATES.repos,
      agentJsonUrl: ENDPOINT_TEMPLATES.agentDiscovery,
      openapiUrl: '/openapi.json',
      apiDocsUrl: '/api/docs',
    },
    caller: buildCallerDocument(options.accessContext, state.repoScopes),
    capabilities: state.capabilities,
    endpoints: state.endpoints,
  };
}

module.exports = {
  ENDPOINT_TEMPLATES,
  buildAgentDiscoveryDocument,
  buildWhoAmIDocument,
};
