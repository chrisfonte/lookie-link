'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const { safeResolve, toPosixPath } = require('./path-utils');

const SCHEMA_VERSION = 1;
const SUPPORTED_STATES = new Set(['open', 'claimed', 'resolved']);
const SUPPORTED_ANCHOR_KINDS = new Set(['heading', 'yamlKey', 'lineRange']);
const LINE_RANGE_PATTERN = /^#L(\d+)-L(\d+)$/;

function buildFileId(repo, relativePath) {
  return `${repo}/${toPosixPath(relativePath)}`;
}

function createEmptyDocument(repo, relativePath) {
  return {
    schema: SCHEMA_VERSION,
    file: buildFileId(repo, relativePath),
    annotations: [],
  };
}

function normalizeAnnotationFileData(raw, repo, relativePath) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid annotation sidecar: expected an object.');
  }

  if (raw.schema !== SCHEMA_VERSION) {
    throw new Error(`Unsupported annotation schema: ${raw.schema}`);
  }

  const annotations = Array.isArray(raw.annotations) ? raw.annotations : null;
  if (!annotations) {
    throw new Error('Invalid annotation sidecar: annotations must be an array.');
  }

  return {
    schema: SCHEMA_VERSION,
    file: buildFileId(repo, relativePath),
    annotations,
  };
}

async function resolveAnnotationPath(rootPath, repo, relativePath) {
  const sidecarRelativePath = path.posix.join(
    '.lookie-link',
    'annotations',
    repo,
    `${toPosixPath(relativePath)}.json`
  );

  return safeResolve(rootPath, sidecarRelativePath);
}

async function readAnnotationDocument(rootPath, repo, relativePath) {
  const sidecarPath = await resolveAnnotationPath(rootPath, repo, relativePath);

  let raw;
  let stat;
  try {
    [raw, stat] = await Promise.all([
      fs.readFile(sidecarPath, 'utf8'),
      fs.stat(sidecarPath),
    ]);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return {
        document: createEmptyDocument(repo, relativePath),
        mtimeMs: null,
        exists: false,
        sidecarPath,
      };
    }

    throw error;
  }

  const parsed = JSON.parse(raw);
  return {
    document: normalizeAnnotationFileData(parsed, repo, relativePath),
    mtimeMs: Math.trunc(stat.mtimeMs),
    exists: true,
    sidecarPath,
  };
}

function validateAnchor(anchor, anchorKind) {
  if (!SUPPORTED_ANCHOR_KINDS.has(anchorKind)) {
    throw new Error('Unsupported anchorKind. Expected heading, yamlKey, or lineRange.');
  }

  if (typeof anchor !== 'string' || !anchor.trim()) {
    throw new Error('Anchor is required.');
  }

  const normalized = anchor.trim();
  if (!normalized.startsWith('#')) {
    throw new Error('Anchor must start with "#".');
  }

  if (anchorKind === 'lineRange') {
    const match = normalized.match(LINE_RANGE_PATTERN);
    if (!match) {
      throw new Error('lineRange anchors must use the form #L<start>-L<end>.');
    }

    const start = Number(match[1]);
    const end = Number(match[2]);
    if (end < start) {
      throw new Error('lineRange anchor end must be greater than or equal to start.');
    }
  }
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required.`);
  }

  return value.trim();
}

function nextAnnotationId(annotations, isoTimestamp) {
  const prefix = isoTimestamp.slice(0, 10);
  let max = 0;

  for (const annotation of annotations) {
    if (!annotation || typeof annotation.id !== 'string') {
      continue;
    }

    const match = annotation.id.match(new RegExp(`^${prefix}-(\\d{3})$`));
    if (!match) {
      continue;
    }

    max = Math.max(max, Number(match[1]));
  }

  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}

function buildAnnotation(input, existingAnnotations) {
  const anchor = requireNonEmptyString(input.anchor, 'anchor');
  const anchorKind = requireNonEmptyString(input.anchorKind, 'anchorKind');
  const body = requireNonEmptyString(input.body, 'body');
  const author = requireNonEmptyString(input.author, 'author');

  validateAnchor(anchor, anchorKind);

  const createdAt = new Date().toISOString();

  return {
    id: nextAnnotationId(existingAnnotations, createdAt),
    anchor,
    anchorKind,
    body,
    author,
    createdAt,
    state: 'open',
    claimedBy: null,
    claimedAt: null,
    resolvedAt: null,
    replies: [],
  };
}

function buildReply(payload) {
  return {
    author: requireNonEmptyString(payload && payload.author, 'payload.author'),
    body: requireNonEmptyString(payload && payload.body, 'payload.body'),
    createdAt: new Date().toISOString(),
  };
}

function applyAnnotationOperation(annotation, op, payload) {
  if (!annotation) {
    throw new Error('Annotation not found.');
  }

  if (!SUPPORTED_STATES.has(annotation.state)) {
    throw new Error(`Unsupported annotation state: ${annotation.state}`);
  }

  switch (op) {
    case 'claim': {
      const claimedBy = requireNonEmptyString(
        payload && (payload.claimedBy || payload.author),
        'payload.claimedBy'
      );
      return {
        ...annotation,
        state: 'claimed',
        claimedBy,
        claimedAt: new Date().toISOString(),
        resolvedAt: null,
      };
    }
    case 'resolve':
      return {
        ...annotation,
        state: 'resolved',
        resolvedAt: new Date().toISOString(),
      };
    case 'reopen':
      return {
        ...annotation,
        state: 'open',
        claimedBy: null,
        claimedAt: null,
        resolvedAt: null,
      };
    case 'reply':
      return {
        ...annotation,
        replies: [...(Array.isArray(annotation.replies) ? annotation.replies : []), buildReply(payload)],
      };
    default:
      throw new Error('Unsupported op. Expected claim, resolve, reopen, or reply.');
  }
}

function filterAnnotationsByState(document, states) {
  if (!states || states.length === 0) {
    return document;
  }

  const normalizedStates = new Set(states.map((state) => String(state).trim()).filter(Boolean));
  for (const state of normalizedStates) {
    if (!SUPPORTED_STATES.has(state)) {
      throw new Error(`Unsupported state filter: ${state}`);
    }
  }

  return {
    ...document,
    annotations: document.annotations.filter((annotation) => normalizedStates.has(annotation.state)),
  };
}

async function writeAnnotationDocument(sidecarPath, document, expectedMtimeMs) {
  let currentStat = null;
  try {
    currentStat = await fs.stat(sidecarPath);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      throw error;
    }
  }

  if (expectedMtimeMs !== undefined) {
    const expected = Math.trunc(Number(expectedMtimeMs));
    if (!Number.isFinite(expected)) {
      throw new Error('Invalid expectedMtimeMs value.');
    }

    const current = currentStat ? Math.trunc(currentStat.mtimeMs) : null;
    if (current !== expected) {
      const error = new Error('Annotation sidecar changed on disk since you last read it.');
      error.code = 'ESTALE';
      error.currentMtimeMs = current;
      throw error;
    }
  }

  await fs.mkdir(path.dirname(sidecarPath), { recursive: true });

  const tempPath = path.join(
    path.dirname(sidecarPath),
    `.lookie-link-annotations-tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );

  try {
    await fs.writeFile(tempPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    await fs.rename(tempPath, sidecarPath);
  } catch (error) {
    try {
      await fs.unlink(tempPath);
    } catch (_cleanupError) {
      // best effort cleanup
    }
    throw error;
  }

  const updatedStat = await fs.stat(sidecarPath);
  return {
    document,
    mtimeMs: Math.trunc(updatedStat.mtimeMs),
  };
}

async function createAnnotation(rootPath, repo, relativePath, input) {
  const existing = await readAnnotationDocument(rootPath, repo, relativePath);
  const annotation = buildAnnotation(input, existing.document.annotations);
  const nextDocument = {
    ...existing.document,
    annotations: [...existing.document.annotations, annotation],
  };

  const saved = await writeAnnotationDocument(existing.sidecarPath, nextDocument);
  return {
    annotation,
    mtimeMs: saved.mtimeMs,
    document: saved.document,
  };
}

async function updateAnnotation(rootPath, repo, relativePath, input) {
  const id = requireNonEmptyString(input && input.id, 'id');
  const op = requireNonEmptyString(input && input.op, 'op');
  const existing = await readAnnotationDocument(rootPath, repo, relativePath);
  const index = existing.document.annotations.findIndex((annotation) => annotation && annotation.id === id);

  if (index === -1) {
    throw new Error('Annotation not found.');
  }

  const updatedAnnotation = applyAnnotationOperation(existing.document.annotations[index], op, input.payload || {});
  const annotations = existing.document.annotations.slice();
  annotations[index] = updatedAnnotation;

  const saved = await writeAnnotationDocument(
    existing.sidecarPath,
    {
      ...existing.document,
      annotations,
    },
    input.expectedMtimeMs
  );

  return {
    annotation: updatedAnnotation,
    mtimeMs: saved.mtimeMs,
    document: saved.document,
  };
}

module.exports = {
  SCHEMA_VERSION,
  SUPPORTED_STATES,
  createEmptyDocument,
  readAnnotationDocument,
  filterAnnotationsByState,
  createAnnotation,
  updateAnnotation,
};
