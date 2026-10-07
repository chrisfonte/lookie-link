'use strict';

/*
 * Audio marker viewer: waveform from a peaks sidecar, a player driven by the
 * audio clock, marker lanes, an inspector, and save / write-back controls.
 * Plain script, no dependencies. Every network call lives in the `api` object
 * below so a route or field rename is a one-place change.
 *
 * Test hook: window.__audioMarkers = { getClock, setClock, state, ready }.
 */
(function () {
  // Opaque-origin sandboxed frames cannot fetch; bail before any network I/O.
  if (window.origin === 'null' || (typeof location !== 'undefined' && location.origin === 'null')) {
    return;
  }

  const bootEl = document.getElementById('audio-markers-boot');
  const app = document.querySelector('[data-am-app]');
  if (!bootEl || !app) {
    return;
  }
  let boot;
  try {
    boot = JSON.parse(bootEl.textContent);
  } catch (_error) {
    return;
  }

  // ---------------------------------------------------------------- api
  class ApiError extends Error {
    constructor(status, error, body) {
      super((error && error.message) || `Request failed (${status})`);
      this.status = status;
      this.code = (error && error.code) || 'request_failed';
      this.details = error && error.details;
      const top = body || {};
      const inner = error || {};
      this.currentRecordId = top.currentRecordId || inner.currentRecordId || (inner.details && inner.details.currentRecordId) || null;
      this.currentTargetSha256 = top.currentTargetSha256 || inner.currentTargetSha256 || (inner.details && inner.details.currentTargetSha256) || null;
    }
  }

  function withToken(url) {
    if (!boot.queryToken) {
      return url;
    }
    return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(boot.queryToken)}`;
  }

  async function readJson(response) {
    let body = null;
    try {
      body = await response.json();
    } catch (_error) {
      body = null;
    }
    if (!response.ok || (body && body.ok === false)) {
      throw new ApiError(response.status, body && body.error, body);
    }
    return body || {};
  }

  function query(params) {
    const search = new URLSearchParams();
    Object.keys(params).forEach((key) => {
      if (params[key] !== undefined && params[key] !== null) {
        search.set(key, params[key]);
      }
    });
    return search.toString();
  }

  async function postJson(url, payload) {
    const headers = { 'Content-Type': 'application/json' };
    if (boot.csrfToken) {
      headers['X-CSRF-Token'] = boot.csrfToken;
    }
    const response = await fetch(url, {
      method: 'POST', headers, credentials: 'same-origin', body: JSON.stringify(payload),
    });
    return readJson(response);
  }

  const api = {
    info: () => fetch(withToken(boot.infoUrl), { credentials: 'same-origin' }).then(readJson),
    async peaks() {
      const response = await fetch(withToken(boot.peaksUrl), { credentials: 'same-origin' });
      if (!response.ok) {
        throw new ApiError(response.status, null);
      }
      return response.arrayBuffer();
    },
    templates: () => fetch(withToken(boot.templatesUrl), { credentials: 'same-origin' }).then(readJson),
    template: (id) => fetch(withToken(`${boot.templatesUrl}/${encodeURIComponent(id)}`), { credentials: 'same-origin' }).then(readJson),
    records: (templateId) => fetch(withToken(`${boot.recordsUrl}?${query({ repo: boot.repo, path: boot.path, templateId })}`),
      { credentials: 'same-origin' }).then(readJson),
    history: (id) => fetch(withToken(`${boot.recordsUrl}/${encodeURIComponent(id)}/history`), { credentials: 'same-origin' }).then(readJson),
    record: (id) => fetch(withToken(`${boot.recordsUrl}/${encodeURIComponent(id)}`), { credentials: 'same-origin' }).then(readJson),
    context: (templateId) => fetch(withToken(`${boot.contextUrl}?${query({ repo: boot.repo, path: boot.path, template: templateId })}`),
      { credentials: 'same-origin' }).then(readJson),
    preview: (payload) => postJson(boot.previewUrl, payload),
    save: (payload) => postJson(boot.recordsUrl, payload),
  };

  // ---------------------------------------------------------------- helpers
  const REGION = 'region';
  const POINT = 'point';
  const NOTE_TYPE = 'note';
  const SPAN_TYPE = 'span'; // the free-form region type of the bundled freeform template
  const isFreeform = (typeId) => typeId === NOTE_TYPE || typeId === SPAN_TYPE;
  const freeTypeFor = (kind) => (kind === REGION ? SPAN_TYPE : NOTE_TYPE);
  const CAL_KEY = 'lookie.audio.calibrationMs';
  const NAME_KEY = 'lookie.audio.operatorName';
  const TAP_EDGE_KEY = 'lookie.audio.tapOnRelease';
  // Keys the viewer keeps for itself; a template key is never bound to these.
  const RESERVED_KEYS = new Set([' ', 'm', '[', ']', 's', 'l', '+', '=', '-', '0', '?', 'Delete', 'Backspace',
    'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Escape', 'Enter', 'Tab']);
  const FREEFORM_TEMPLATE = {
    templateId: 'freeform', revision: 0, title: 'Freeform', unit: 'ms', groups: [], markers: [], keys: {}, pickers: [],
  };

  const ui = {};
  app.querySelectorAll('[data-am]').forEach((node) => {
    ui[node.getAttribute('data-am')] = node;
  });

  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    Object.keys(props || {}).forEach((key) => {
      const value = props[key];
      if (value === undefined || value === null || value === false) {
        return;
      }
      if (key === 'class') {
        node.className = value;
      } else if (key === 'text') {
        node.textContent = value;
      } else if (key.startsWith('on')) {
        node.addEventListener(key.slice(2), value);
      } else if (key === 'value') {
        node.value = value;
      } else if (key === 'checked' || key === 'disabled' || key === 'hidden') {
        node[key] = Boolean(value);
      } else {
        node.setAttribute(key, value === true ? '' : String(value));
      }
    });
    children.flat(Infinity).forEach((child) => {
      if (child === null || child === undefined || child === false) {
        return;
      }
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    });
    return node;
  }

  const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

  function fmtTime(seconds, digits = 3) {
    const sign = seconds < 0 ? '-' : '';
    const total = Math.abs(seconds);
    const m = Math.floor(total / 60);
    const s = total - m * 60;
    return `${sign}${m}:${s.toFixed(digits).padStart(digits ? digits + 3 : 2, '0')}`;
  }

  function shortHash(value) {
    return value ? String(value).slice(0, 10) : '';
  }

  function newId() {
    return `m-${Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0')}`;
  }

  function readableOn(hex) {
    const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) {
      return null;
    }
    const n = parseInt(m[1], 16);
    const lin = (c) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    const lum = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
    return lum > 0.35 ? '#0b0d0f' : '#ffffff';
  }

  // ---------------------------------------------------------------- state
  const audio = new Audio();
  audio.preload = 'auto';
  audio.src = boot.assetUrl;
  app.append(audio);
  audio.hidden = true;

  function newSet(templateId, template) {
    return {
      templateId, template, record: null, latestId: null, history: null, baseline: new Map(), tags: {},
    };
  }

  const state = {
    boot,
    info: null,
    sampleRate: 44100,
    frames: 0,
    duration: 0,
    channels: 1,
    blockSize: 1152,
    peaks: null,
    templates: [],
    template: FREEFORM_TEMPLATE,
    context: null,
    markers: [],
    // One save is one record for one template. `main` is the open template; `notes`
    // is the freeform set that holds Notes-lane markers when main is not freeform.
    sets: { main: newSet('freeform', FREEFORM_TEMPLATE), notes: null },
    expectedTargetSha256: null,
    driftKept: new Set(),
    deleted: new Map(), // saved marker id -> type, removed in this session
    operatorName: '',
    selection: null, // { id, part: 'whole' | 'start' | 'end' }
    pending: null, // region begun with a key: { typeId, kind, startSample }
    active: { typeId: NOTE_TYPE, kind: POINT },
    view: { start: 0, span: 1 },
    loop: null, // { start, end } seconds
    loopOn: false,
    snapOn: false,
    ctx: null,
    calibrationMs: 0,
    tapOnRelease: false,
    lastTap: null,
    preview: null,
    saving: false,
    skipped: [],
    sizes: { w: 0, waveH: 0, rulerH: 26, imageH: 0 },
    ready: false,
  };

  // The main set's fields read straight through, so most code just says state.record.
  ['record', 'latestId', 'history', 'baseline', 'tags'].forEach((key) => {
    Object.defineProperty(state, key, {
      get: () => state.sets.main[key],
      set: (value) => { state.sets.main[key] = value; },
      enumerable: true,
    });
  });

  function setOf(m) {
    return state.sets.notes && isFreeform(m.type) ? state.sets.notes : state.sets.main;
  }

  function setMarkers(set) {
    return state.markers.filter((m) => setOf(m) === set);
  }

  function isReadOnly(m) {
    return !isFreeform(m.type) && !(state.template.markers || []).some((t) => t.id === m.type);
  }

  function minLen(m) {
    return typeDef(m.type).allowZeroLength ? 0 : 1;
  }

  function loadOperatorName() {
    let stored = '';
    try {
      stored = window.localStorage.getItem(NAME_KEY) || '';
    } catch (_error) {
      stored = '';
    }
    state.operatorName = stored || boot.operatorName || '';
  }

  function saveOperatorName(value) {
    state.operatorName = value;
    try {
      window.localStorage.setItem(NAME_KEY, value);
    } catch (_error) {
      // Storage may be blocked; the name still applies to this page.
    }
  }

  function loadCalibration() {
    try {
      const raw = window.localStorage.getItem(CAL_KEY);
      const value = Number(raw);
      state.calibrationMs = Number.isFinite(value) ? value : 0;
    } catch (_error) {
      state.calibrationMs = 0;
    }
  }

  function saveCalibration(value) {
    state.calibrationMs = value;
    try {
      window.localStorage.setItem(CAL_KEY, String(value));
    } catch (_error) {
      // Storage may be blocked; the value still applies to this page.
    }
  }

  function loadTapEdge() {
    try {
      state.tapOnRelease = window.localStorage.getItem(TAP_EDGE_KEY) === '1';
    } catch (_error) {
      state.tapOnRelease = false;
    }
  }

  function saveTapEdge(value) {
    state.tapOnRelease = Boolean(value);
    try {
      window.localStorage.setItem(TAP_EDGE_KEY, state.tapOnRelease ? '1' : '0');
    } catch (_error) {
      // Storage may be blocked; the choice still applies to this page.
    }
  }

  const secOf = (sample) => sample / state.sampleRate;
  const sampleOf = (sec) => Math.round(sec * state.sampleRate);

  function unitOf() {
    return state.template.unit || 'samples';
  }

  function toUnit(sample) {
    const unit = unitOf();
    if (unit === 'ms') {
      return (sample / state.sampleRate) * 1000;
    }
    if (unit === 'seconds') {
      return sample / state.sampleRate;
    }
    return sample;
  }

  function fromUnit(value) {
    const unit = unitOf();
    if (unit === 'ms') {
      return Math.round((value / 1000) * state.sampleRate);
    }
    if (unit === 'seconds') {
      return Math.round(value * state.sampleRate);
    }
    return Math.round(value);
  }

  function fmtUnit(sample) {
    const unit = unitOf();
    const value = toUnit(sample);
    if (unit === 'ms') {
      return `${Number(value.toFixed(3))} ms`;
    }
    if (unit === 'seconds') {
      return `${Number(value.toFixed(6))} s`;
    }
    return `${Math.round(value)} samples`;
  }

  // ---------------------------------------------------------------- template model
  function typeDef(typeId) {
    const found = (state.template.markers || []).find((type) => type.id === typeId);
    if (found) {
      return found;
    }
    if (typeId === SPAN_TYPE) return { id: typeId, label: 'Span', kind: REGION, multiple: true, freeform: true };
    return { id: typeId, label: typeId === NOTE_TYPE ? 'Note' : typeId, kind: typeId === NOTE_TYPE ? POINT : null, multiple: true, freeform: true };
  }

  function typeColor(m) {
    return typeDef(m.type).color || null;
  }

  function buildLanes() {
    const lanes = [];
    const groups = state.template.groups || [];
    groups.forEach((group) => {
      lanes.push({ id: group.id, label: group.label || group.id, types: [] });
    });
    let other = null;
    (state.template.markers || []).forEach((type) => {
      let lane = lanes.find((l) => l.id === type.group);
      if (!lane) {
        if (!other) {
          other = { id: '__other', label: 'Other', types: [] };
          lanes.push(other);
        }
        lane = other;
      }
      lane.types.push(type);
    });
    lanes.push({ id: '__notes', label: 'Notes', types: [], notes: true });
    return lanes;
  }

  function laneIdOf(lanes, m) {
    if (isFreeform(m.type)) {
      return '__notes';
    }
    const lane = lanes.find((l) => l.types.some((type) => type.id === m.type));
    return lane ? lane.id : '__notes';
  }

  // ---------------------------------------------------------------- marker model
  const startOf = (m) => (m.kind === REGION ? m.startSample : m.sample);
  const endOf = (m) => (m.kind === REGION ? m.endSample : m.sample);

  function serialize(m) {
    const out = { id: m.id, type: m.type, kind: m.kind };
    if (m.kind === REGION) {
      out.startSample = m.startSample;
      out.endSample = m.endSample;
    } else {
      out.sample = m.sample;
    }
    out.label = m.label || null;
    out.note = m.note || null;
    return out;
  }

  function fromRecordMarker(raw, origin) {
    const kind = raw.kind === REGION || raw.startSample !== undefined ? REGION : POINT;
    const m = {
      id: raw.id || newId(),
      type: raw.type || freeTypeFor(kind),
      kind,
      label: raw.label || '',
      note: raw.note || '',
      origin,
    };
    if (kind === REGION) {
      m.startSample = Math.round(raw.startSample);
      m.endSample = Math.round(raw.endSample);
    } else {
      m.sample = Math.round(raw.sample);
    }
    return m;
  }

  function setBaseline(set) {
    const target = set || state.sets.main;
    target.baseline = new Map(setMarkers(target).map((m) => [m.id, JSON.stringify(serialize(m))]));
  }

  function markerState(m) {
    const base = setOf(m).baseline.get(m.id);
    if (!base || base !== JSON.stringify(serialize(m))) {
      return 'unsaved';
    }
    return m.origin === 'target' ? 'target' : 'saved';
  }

  function isDirty(set) {
    const sets = set ? [set] : [state.sets.main, state.sets.notes].filter(Boolean);
    return sets.some((one) => {
      const list = setMarkers(one);
      return one.baseline.size !== list.length || list.some((m) => markerState(m) === 'unsaved') || keptDriftIds(one).length > 0;
    });
  }

  // Saved values the operator chose to keep over a drifted target; keeping one writes
  // it back on the next save, so it counts as touched.
  function keptDriftIds(set) {
    return set === state.sets.main ? Array.from(state.driftKept).filter((id) => findMarker(id)) : [];
  }

  function touchedIds(set) {
    const ids = new Set(setMarkers(set).filter((m) => markerState(m) === 'unsaved').map((m) => m.id));
    keptDriftIds(set).forEach((id) => ids.add(id));
    return Array.from(ids);
  }

  // Drift: the target's value for a marker differs from the saved marker.
  function driftFor(m) {
    const values = (state.context && state.context.targetValues) || {};
    const value = values[m.id];
    if (value === undefined || value === null || m.origin === 'target' || state.driftKept.has(m.id) || setOf(m) !== state.sets.main) {
      return null;
    }
    if (m.kind === REGION) {
      return typeof value === 'object' && (value.startSample !== m.startSample || value.endSample !== m.endSample) ? value : null;
    }
    return typeof value === 'number' && value !== m.sample ? value : null;
  }

  function fmtValue(value) {
    return typeof value === 'object' ? `${fmtUnit(value.startSample)} to ${fmtUnit(value.endSample)}` : fmtUnit(value);
  }

  function markerValue(m) {
    return m.kind === REGION ? { startSample: m.startSample, endSample: m.endSample } : m.sample;
  }

  function findMarker(id) {
    return state.markers.find((m) => m.id === id) || null;
  }

  function selectedMarker() {
    return state.selection ? findMarker(state.selection.id) : null;
  }

  function seedFromReads() {
    const reads = (state.context && state.context.reads) || {};
    const seeded = [];
    (state.template.markers || []).forEach((type) => {
      const value = reads[type.id];
      if (value === undefined || value === null) {
        return;
      }
      const id = type.multiple ? newId() : type.id;
      if (type.kind === REGION && typeof value === 'object') {
        seeded.push({
          id, type: type.id, kind: REGION, startSample: value.startSample, endSample: value.endSample, label: '', note: '', origin: 'target',
        });
      } else if (type.kind !== REGION && typeof value === 'number') {
        seeded.push({
          id, type: type.id, kind: POINT, sample: value, label: '', note: '', origin: 'target',
        });
      }
    });
    return seeded;
  }

  // Add or move a marker. A single-instance type is moved rather than duplicated.
  function placeMarker(def, kind, a, b) {
    const typeId = def.id;
    let m = !def.multiple && !isFreeform(typeId) ? state.markers.find((x) => x.type === typeId) : null;
    if (!m) {
      state.deleted.delete(!def.multiple && !isFreeform(typeId) ? typeId : '');
      m = {
        id: !def.multiple && !isFreeform(typeId) ? typeId : newId(), type: typeId, kind, label: '', note: '', origin: 'new',
      };
      state.markers.push(m);
    }
    m.kind = kind;
    if (kind === REGION) {
      m.startSample = Math.min(a, b);
      m.endSample = Math.max(a, b);
      delete m.sample;
    } else {
      m.sample = a;
      delete m.startSample;
      delete m.endSample;
    }
    state.selection = { id: m.id, part: 'whole' };
    return m;
  }

  // ---------------------------------------------------------------- constraints
  function validate(only) {
    const problems = [];
    const frames = state.frames;
    const unitExact = toUnit;
    const markers = state.markers;
    const byType = (id) => markers.filter((m) => m.type === id);
    const label = (m) => (typeDef(m.type).label || m.type);
    const add = (m, message) => problems.push({ markerId: m ? m.id : null, message, set: m && setOf(m) === state.sets.notes ? 'notes' : 'main' });

    markers.forEach((m) => {
      const a = startOf(m);
      const b = endOf(m);
      if (!Number.isFinite(a) || !Number.isFinite(b)) {
        add(m, `${label(m)}: position is not a number.`);
        return;
      }
      if (a < 0 || b > frames) {
        add(m, `${label(m)}: outside the file (0 to ${frames} samples).`);
      }
      if (m.kind === REGION && (minLen(m) ? b <= a : b < a)) {
        add(m, `${label(m)}: a region must end after it starts.`);
      }
    });

    (state.template.markers || []).forEach((type) => {
      const list = byType(type.id);
      const c = type.constraints || {};
      if (type.required && list.length === 0) {
        add(null, `${type.label || type.id}: required, none placed.`);
      }
      const limit = type.multiple ? c.maxCount : 1;
      if (Number.isFinite(limit) && list.length > limit) {
        add(list[limit], `${type.label || type.id}: at most ${limit} allowed.`);
      }
      list.forEach((m) => {
        const a = startOf(m);
        const b = endOf(m);
        if (Number.isFinite(c.min) && unitExact(a) < c.min) {
          add(m, `${label(m)}: earlier than the minimum ${c.min} ${unitOf()}.`);
        }
        if (Number.isFinite(c.max) && unitExact(b) > c.max) {
          add(m, `${label(m)}: later than the maximum ${c.max} ${unitOf()}.`);
        }
        if (c.after) {
          const others = byType(c.after);
          if (others.some((o) => a < endOf(o))) {
            add(m, `${label(m)}: must come after ${typeDef(c.after).label || c.after}.`);
          }
        }
        if (c.before) {
          const others = byType(c.before);
          if (others.some((o) => b > startOf(o))) {
            add(m, `${label(m)}: must come before ${typeDef(c.before).label || c.before}.`);
          }
        }
        if (c.within) {
          const others = byType(c.within);
          if (others.length && !others.some((o) => a >= startOf(o) && b <= endOf(o))) {
            add(m, `${label(m)}: must sit inside ${typeDef(c.within).label || c.within}.`);
          }
        }
        if (c.noOverlap && m.kind === REGION) {
          const clash = markers.find((o) => o !== m && o.kind === REGION
            && (state.template.markers.find((t) => t.id === o.type) || {}).group === c.noOverlap
            && o.startSample < m.endSample && m.startSample < o.endSample);
          if (clash) {
            add(m, `${label(m)}: overlaps ${label(clash)}.`);
          }
        }
      });
    });

    (state.template.pickers || []).forEach((picker) => {
      if (picker.required && !(state.tags && state.tags[picker.id])) {
        add(null, `${picker.label || picker.id}: choose a value.`);
      }
    });
    return only ? problems.filter((p) => p.set === only) : problems;
  }

  // ---------------------------------------------------------------- clock
  let anchor = null; // { perf, media }
  let injected = null;

  // What the browser says right now (or at the key event).
  function liveClock(event) {
    const ts = event && typeof event.timeStamp === 'number' ? event.timeStamp : performance.now();
    const playing = !audio.paused;
    let now = audio.currentTime;
    if (playing && anchor) {
      const dt = ts - anchor.perf;
      if (dt > -250 && dt < 250) {
        now = anchor.media + (dt / 1000) * audio.playbackRate;
      }
    }
    const ctx = state.ctx;
    return {
      now,
      playing,
      outputLatency: ctx ? ctx.outputLatency || 0 : 0,
      baseLatency: ctx ? ctx.baseLatency || 0 : 0,
    };
  }

  // Every value the heard-time formula uses. An injected field replaces its live
  // counterpart; a function is called with the key event. Injecting `now` implies
  // playing unless `playing: false` is given too.
  function clockValues(event) {
    const live = liveClock(event);
    const pick = (value, fallback) => (typeof value === 'function' ? value(event) : value === undefined ? fallback : value);
    const inj = injected || {};
    const out = {
      now: Number(pick(inj.now, live.now)),
      playing: inj.playing !== undefined ? Boolean(pick(inj.playing, live.playing)) : (inj.now !== undefined ? true : live.playing),
      outputLatency: Number(pick(inj.outputLatency, live.outputLatency)) || 0,
      baseLatency: Number(pick(inj.baseLatency, live.baseLatency)) || 0,
      calibrationMs: Number(pick(inj.calibrationMs, state.calibrationMs)) || 0,
    };
    out.latency = out.playing ? out.outputLatency + out.baseLatency + out.calibrationMs / 1000 : 0;
    return out;
  }

  // The moment the operator heard what they reacted to, in seconds.
  function heardTime(event) {
    const c = clockValues(event);
    const heard = clamp(c.now - c.latency, 0, state.duration);
    state.lastTap = {
      pressed: c.now,
      playing: c.playing,
      outputLatency: c.outputLatency,
      baseLatency: c.baseLatency,
      calibrationMs: c.calibrationMs,
      latency: c.latency,
      heard,
      sample: clamp(sampleOf(heard), 0, state.frames),
    };
    renderLatency();
    return state.lastTap;
  }

  function renderLatency() {
    const tap = state.lastTap;
    const ctx = state.ctx;
    const out = tap ? tap.outputLatency : (ctx && ctx.outputLatency) || 0;
    const base = tap ? tap.baseLatency : (ctx && ctx.baseLatency) || 0;
    const cal = tap ? tap.calibrationMs : state.calibrationMs;
    const total = out * 1000 + base * 1000 + cal;
    ui.latency.textContent = `Tap compensation: output ${(out * 1000).toFixed(1)} ms + base ${(base * 1000).toFixed(1)} ms + calibration ${cal.toFixed(1)} ms = ${total.toFixed(1)} ms${ctx ? '' : ' (audio not started)'}.`;
  }

  async function ensureContext() {
    if (state.ctx) {
      if (state.ctx.state === 'suspended') {
        await state.ctx.resume();
      }
      return;
    }
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) {
      return;
    }
    let ctx;
    try {
      ctx = new Ctor({ sampleRate: state.sampleRate });
    } catch (_error) {
      ctx = new Ctor();
    }
    try {
      ctx.createMediaElementSource(audio).connect(ctx.destination);
    } catch (_error) {
      // The element may already be routed; playback still works through it.
    }
    state.ctx = ctx;
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    renderLatency();
  }

  function togglePlay() {
    if (!audio.paused) {
      audio.pause();
      return;
    }
    ensureContext().catch(() => {});
    const playing = audio.play();
    if (playing && playing.catch) {
      playing.catch((error) => setAlert(`Playback did not start: ${error.message}`));
    }
  }

  function seek(seconds) {
    audio.currentTime = clamp(seconds, 0, state.duration);
    anchor = { perf: performance.now(), media: audio.currentTime };
    updatePlayhead();
  }

  // Selecting a marker moves the playhead to it (a region's start) and leaves the
  // play state alone. Called on selection, never on drag movement.
  function selectMarker(m, part) {
    state.selection = { id: m.id, part: part || 'whole' };
    seek(secOf(startOf(m)));
  }

  // Play from the selected marker: a paused player starts there, a playing one restarts there.
  function playFromSelected() {
    const m = selectedMarker();
    if (!m) {
      return false;
    }
    seek(secOf(startOf(m)));
    if (audio.paused) {
      ensureContext().catch(() => {});
      const playing = audio.play();
      if (playing && playing.catch) {
        playing.catch((error) => setAlert(`Playback did not start: ${error.message}`));
      }
    }
    setStatus(`Playing from ${fmtTime(secOf(startOf(m)))}.`);
    return true;
  }

  // ---------------------------------------------------------------- view geometry
  function minSpan() {
    return Math.max(0.001, (Math.max(state.sizes.w, 64) / 8) / state.sampleRate);
  }

  function setView(start, span) {
    const dur = Math.max(state.duration, 0.001);
    const nextSpan = clamp(span, Math.min(minSpan(), dur), dur);
    state.view.span = nextSpan;
    state.view.start = clamp(start, 0, Math.max(0, dur - nextSpan));
    drawAll();
  }

  function zoomAt(factor, focusSec) {
    const v = state.view;
    const frac = (focusSec - v.start) / v.span;
    const span = clamp(v.span * factor, Math.min(minSpan(), state.duration), state.duration);
    setView(focusSec - frac * span, span);
  }

  const xOf = (sec) => ((sec - state.view.start) / state.view.span) * state.sizes.w;
  const secAtX = (x) => state.view.start + (x / Math.max(state.sizes.w, 1)) * state.view.span;

  function pointerSec(event) {
    const rect = ui['wave-box'].getBoundingClientRect();
    return secAtX(event.clientX - rect.left);
  }

  // ---------------------------------------------------------------- drawing
  function themeColor(name, fallback) {
    const value = getComputedStyle(app).getPropertyValue(name).trim();
    return value || fallback;
  }

  function sizeCanvas(canvas, w, h) {
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pw, ph);
    return { ctx, dpr, pw, ph };
  }

  function measure() {
    const box = ui.stage.getBoundingClientRect();
    state.sizes.w = Math.max(0, Math.floor(box.width));
    const narrow = state.sizes.w < 600;
    const total = narrow ? 168 : 240;
    state.sizes.waveH = Math.max(1, state.channels) * Math.floor(total / Math.max(1, state.channels));
    state.sizes.imageH = state.context && state.context.image ? (narrow ? 64 : 72) : 0;
  }

  function drawWave() {
    const { w, waveH } = state.sizes;
    const { ctx, dpr, pw } = sizeCanvas(ui.wave, w, waveH);
    if (!state.peaks || !w) {
      return;
    }
    const peaks = state.peaks;
    const channels = state.channels;
    const blocks = Math.floor(peaks.length / channels);
    const bs = state.blockSize;
    const sr = state.sampleRate;
    const view = state.view;
    const chH = (waveH * dpr) / channels;
    const wave = themeColor('--accent', '#8fc0d4');
    const mid = themeColor('--border', '#42494f');
    for (let ch = 0; ch < channels; ch += 1) {
      const cy = chH * (ch + 0.5);
      ctx.fillStyle = mid;
      ctx.fillRect(0, Math.round(cy), pw, 1);
      ctx.fillStyle = wave;
      for (let px = 0; px < pw; px += 1) {
        const t0 = view.start + (px / pw) * view.span;
        const t1 = view.start + ((px + 1) / pw) * view.span;
        if (t1 < 0 || t0 > state.duration) {
          continue;
        }
        const b0 = clamp(Math.floor((t0 * sr) / bs), 0, blocks - 1);
        const b1 = clamp(Math.floor((t1 * sr) / bs), b0, blocks - 1);
        let v = 0;
        for (let b = b0; b <= b1; b += 1) {
          const value = peaks[b * channels + ch];
          if (value > v) {
            v = value;
          }
        }
        if (v === 0) {
          continue; // true silence stays the quiet centre line instead of a bright bar
        }
        const half = (v / 32768) * (chH / 2);
        ctx.fillRect(px, cy - half, 1, Math.max(1, half * 2));
      }
    }
    const blockPx = ((bs / sr) / view.span) * w;
    const base = 'Click or drag to scrub. Wheel zooms.';
    ui['wave-box'].title = blockPx > 2
      ? `${base} Drawn in ${((bs / sr) * 1000).toFixed(0)} ms blocks: flat steps, no detail below this.`
      : base;
  }

  function niceStep(span, w) {
    const target = (span / Math.max(w, 1)) * 90;
    const steps = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
    return steps.find((s) => s >= target) || steps[steps.length - 1];
  }

  function drawRuler() {
    const { w, rulerH } = state.sizes;
    const { ctx, dpr } = sizeCanvas(ui.ruler, w, rulerH);
    const view = state.view;
    const step = niceStep(view.span, w);
    const color = themeColor('--text-soft', '#8da0b0');
    ctx.scale(dpr, dpr);
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'top';
    const digits = step < 0.01 ? 3 : step < 1 ? 2 : 0;
    const first = Math.floor(view.start / step) * step;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let t = first; t <= view.start + view.span + step; t += step) {
      const x = Math.round(xOf(t)) + 0.5;
      ctx.moveTo(x, rulerH - 9);
      ctx.lineTo(x, rulerH);
      for (let k = 1; k < 5; k += 1) {
        const mx = Math.round(xOf(t + (step * k) / 5)) + 0.5;
        ctx.moveTo(mx, rulerH - 4);
        ctx.lineTo(mx, rulerH);
      }
      if (x >= 0 && x < w - 40) {
        ctx.fillText(fmtTime(Math.max(0, t), digits), x + 3, 2);
      }
    }
    ctx.stroke();
  }

  function drawImage() {
    const info = state.context && state.context.image;
    ui['image-box'].hidden = !info;
    if (!info || !state.imageEl || !state.imageEl.complete || !state.imageEl.naturalWidth) {
      return;
    }
    const { w, imageH } = state.sizes;
    const { ctx, dpr, pw, ph } = sizeCanvas(ui.image, w, imageH);
    const img = state.imageEl;
    const plot = info.plot || { left: 0, right: img.naturalWidth, top: 0, bottom: img.naturalHeight };
    const plotW = plot.right - plot.left;
    const sx = plot.left + (state.view.start / state.duration) * plotW;
    const sw = (state.view.span / state.duration) * plotW;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(img, sx, plot.top, Math.max(1, sw), plot.bottom - plot.top, 0, 0, pw, ph);
    void dpr;
  }

  function sourceItems() {
    const out = [];
    ((state.context && state.context.sources) || []).forEach((source) => {
      const as = source.as || {};
      (source.points || []).forEach((p) => out.push({
        kind: POINT, a: p.sample, b: p.sample, label: p.label || as.label || source.id, color: as.color, dashed: as.style === 'dashed', source: source.id,
      }));
      (source.regions || []).forEach((r) => out.push({
        kind: REGION, a: r.startSample, b: r.endSample, label: r.label || as.label || source.id, color: as.color, dashed: as.style === 'dashed', source: source.id,
      }));
    });
    return out;
  }

  function drawOverlay() {
    const { w, waveH } = state.sizes;
    const { ctx, dpr } = sizeCanvas(ui.over, w, waveH);
    ctx.scale(dpr, dpr);
    const soft = themeColor('--text-soft', '#8da0b0');
    const accent = themeColor('--accent', '#8fc0d4');
    const sr = state.sampleRate;
    const line = (x, color, dash, alpha) => {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.setLineDash(dash ? [4, 3] : []);
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, waveH);
      ctx.stroke();
      ctx.restore();
    };
    sourceItems().forEach((item) => {
      const color = item.color || soft;
      if (item.kind === POINT) {
        line(xOf(item.a / sr), color, item.dashed, 0.55);
      } else {
        ctx.save();
        ctx.globalAlpha = 0.12;
        ctx.fillStyle = color;
        ctx.fillRect(xOf(item.a / sr), 0, xOf(item.b / sr) - xOf(item.a / sr), waveH);
        ctx.restore();
        line(xOf(item.a / sr), color, item.dashed, 0.4);
        line(xOf(item.b / sr), color, item.dashed, 0.4);
      }
    });
    state.markers.forEach((m) => {
      const color = typeColor(m) || accent;
      const selected = state.selection && state.selection.id === m.id;
      const alpha = markerState(m) === 'target' ? 0.55 : 0.95;
      if (m.kind === REGION) {
        const x0 = xOf(m.startSample / sr);
        const x1 = xOf(m.endSample / sr);
        ctx.save();
        ctx.globalAlpha = selected ? 0.28 : 0.16;
        ctx.fillStyle = color;
        ctx.fillRect(x0, 0, x1 - x0, waveH);
        ctx.restore();
        line(x0, color, markerState(m) === 'target', alpha);
        line(x1, color, markerState(m) === 'target', alpha);
      } else {
        line(xOf(m.sample / sr), color, markerState(m) === 'target', alpha);
      }
    });
    if (state.pending) {
      const x0 = xOf(state.pending.startSample / sr);
      const x1 = xOf(audio.currentTime);
      ctx.save();
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = accent;
      ctx.fillRect(Math.min(x0, x1), 0, Math.abs(x1 - x0), waveH);
      ctx.restore();
      line(x0, accent, true, 0.9);
    }
    if (state.loop) {
      const x0 = xOf(state.loop.start);
      const x1 = xOf(state.loop.end);
      ctx.save();
      ctx.globalAlpha = state.loopOn ? 0.2 : 0.1;
      ctx.fillStyle = soft;
      ctx.fillRect(x0, 0, x1 - x0, waveH);
      ctx.restore();
    }
  }

  function drawAll() {
    measure();
    drawWave();
    drawRuler();
    drawImage();
    drawOverlay();
    renderLanes();
    updatePlayhead();
    updatePan();
  }

  function redrawMarkers() {
    drawOverlay();
    renderLanes();
    renderInspector();
    renderSavebar();
    renderTopControls();
  }

  // ---------------------------------------------------------------- playhead + loop
  function updatePlayhead() {
    const t = audio.currentTime || 0;
    const x = xOf(t);
    const visible = x >= -2 && x <= state.sizes.w + 2;
    ui.playhead.style.display = visible ? '' : 'none';
    ui.playhead.style.transform = `translateX(${x}px)`;
    ui.time.textContent = fmtTime(t);
  }

  function updatePan() {
    const range = state.duration - state.view.span;
    ui.pan.disabled = range <= 0.0005;
    ui.pan.value = range > 0 ? String(Math.round((state.view.start / range) * 1000)) : '0';
  }

  let lastLatencyAt = 0;
  function frame(now) {
    const t = audio.currentTime;
    anchor = { perf: performance.now(), media: t };
    if (!audio.paused) {
      if (state.loopOn && state.loop && t >= state.loop.end) {
        audio.currentTime = state.loop.start;
        anchor.media = state.loop.start;
      }
      const x = xOf(t);
      if (!drag && (x > state.sizes.w || x < 0) && state.view.span < state.duration) {
        setView(t - state.view.span * 0.1, state.view.span);
      }
    }
    updatePlayhead();
    if (state.pending) {
      drawOverlay();
    }
    if (now - lastLatencyAt > 250) {
      lastLatencyAt = now;
      renderLatency();
    }
    window.requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- lanes
  let lanes = [];

  function markerLabel(m) {
    return m.label || typeDef(m.type).label || m.type;
  }

  function markerEl(m) {
    const color = typeColor(m);
    const sr = state.sampleRate;
    const ms = markerState(m);
    const selected = state.selection && state.selection.id === m.id;
    const bad = validate().some((p) => p.markerId === m.id);
    const cls = ['am-marker', m.kind === REGION ? 'am-region' : 'am-point', `am-${ms}`];
    if (selected) {
      cls.push('am-selected');
    }
    if (bad) {
      cls.push('am-invalid');
    }
    const drift = driftFor(m);
    if (isReadOnly(m)) {
      cls.push('am-readonly');
    }
    const node = h('div', {
      class: cls.join(' '), 'data-marker-id': m.id, tabindex: '0', role: 'button',
      'aria-label': `${markerLabel(m)} ${fmtUnit(startOf(m))}${m.kind === REGION ? ` to ${fmtUnit(m.endSample)}` : ''}`,
      title: `${markerLabel(m)}${bad ? ' (constraint problem)' : ''}`,
    });
    if (color) {
      node.style.setProperty('--am-c', color);
      node.style.setProperty('--am-ink', ms === 'target' ? 'var(--text)' : readableOn(color));
    }
    if (m.kind === REGION) {
      const x0 = xOf(m.startSample / sr);
      const x1 = xOf(m.endSample / sr);
      node.style.left = `${x0}px`;
      node.style.width = `${Math.max(2, x1 - x0)}px`;
      node.append(
        h('span', { class: 'am-handle am-edge am-edge-l', 'data-part': 'start' }),
        h('span', { class: 'am-body', 'data-part': 'whole', text: markerLabel(m) }),
        h('span', { class: 'am-handle am-edge am-edge-r', 'data-part': 'end' }),
      );
    } else {
      node.style.left = `${xOf(m.sample / sr)}px`;
      node.append(
        h('span', { class: 'am-pline' }),
        h('span', { class: 'am-handle am-flag', 'data-part': 'whole', text: markerLabel(m) }),
      );
    }
    if (drift !== null) {
      node.classList.add('am-drifted');
      node.append(h('span', {
        class: 'am-drift', 'data-am-drift': m.id, text: '!',
        title: `Drift: saved ${fmtValue(markerValue(m))}; target now ${fmtValue(drift)}`,
      }));
    }
    node.addEventListener('focus', () => {
      if (!state.selection || state.selection.id !== m.id) {
        selectMarker(m, 'whole');
        drawOverlay();
        renderInspector();
      }
    });
    return node;
  }

  function deletedGhosts(laneId) {
    const values = (state.context && state.context.targetValues) || {};
    const sr = state.sampleRate;
    const out = [];
    state.deleted.forEach((typeId, id) => {
      const value = values[id];
      if (value === undefined || value === null || laneIdOf(lanes, { type: typeId }) !== laneId) {
        return;
      }
      const text = `Deleted here, but the target still holds ${fmtValue(value)}. Deleting never clears the target.`;
      const node = h('div', { class: `am-ghost am-ghost-deleted ${typeof value === 'number' ? 'am-point' : 'am-region'}`, title: text },
        h('span', { class: 'am-drift', 'data-am-drift-deleted': id, text: '!' }));
      const color = typeDef(typeId).color;
      if (color) {
        node.style.setProperty('--am-c', color);
      }
      if (typeof value === 'number') {
        node.style.left = `${xOf(value / sr)}px`;
      } else {
        const x0 = xOf(value.startSample / sr);
        node.style.left = `${x0}px`;
        node.style.width = `${Math.max(2, xOf(value.endSample / sr) - x0)}px`;
      }
      out.push(node);
    });
    return out;
  }

  function ghostEls(laneId) {
    const reads = (state.context && state.context.reads) || {};
    const out = deletedGhosts(laneId);
    const sr = state.sampleRate;
    (state.template.markers || []).forEach((type) => {
      const value = reads[type.id];
      if (value === undefined || value === null || laneIdOf(lanes, { type: type.id }) !== laneId) {
        return;
      }
      const mine = state.markers.find((m) => m.type === type.id);
      const same = mine && ((typeof value === 'number' && mine.sample === value)
        || (typeof value === 'object' && mine.startSample === value.startSample && mine.endSample === value.endSample));
      if (same) {
        return;
      }
      const node = h('div', {
        class: `am-ghost ${typeof value === 'number' ? 'am-point' : 'am-region'}`,
        title: `${type.label || type.id}: recorded in target`,
      });
      if (type.color) {
        node.style.setProperty('--am-c', type.color);
      }
      if (typeof value === 'number') {
        node.style.left = `${xOf(value / sr)}px`;
      } else {
        const x0 = xOf(value.startSample / sr);
        node.style.left = `${x0}px`;
        node.style.width = `${Math.max(2, xOf(value.endSample / sr) - x0)}px`;
      }
      out.push(node);
    });
    return out;
  }

  function renderLanes() {
    lanes = buildLanes();
    const root = ui.lanes;
    root.textContent = '';
    const laneEls = new Map();
    lanes.forEach((lane) => {
      const el = h('div', { class: `am-lane${lane.notes ? ' am-lane-notes' : ''}`, 'data-lane': lane.id },
        h('span', { class: 'am-lane-label', text: lane.label }));
      laneEls.set(lane.id, el);
      root.append(el);
    });
    state.markers.forEach((m) => {
      const el = laneEls.get(laneIdOf(lanes, m));
      if (el) {
        el.append(markerEl(m));
      }
    });
    lanes.forEach((lane) => ghostEls(lane.id).forEach((g) => laneEls.get(lane.id).append(g)));
    // Point flags that would overlap drop to a second row so each stays clickable. A flag that
    // would run past the right edge flips to the left of its line, so it is never clipped.
    const laneW = state.sizes.w;
    laneEls.forEach((el) => {
      const rowEnd = [-Infinity, -Infinity];
      let stacked = false;
      const flags = Array.from(el.querySelectorAll('.am-point.am-marker')).map((node) => {
        const x = parseFloat(node.style.left);
        const flag = node.querySelector('.am-flag');
        const width = (flag && flag.offsetWidth) || Math.min(176, 18 + (node.textContent || '').length * 6.4);
        const flip = laneW > 0 && x + width > laneW - 2 && x - width >= 0;
        if (flip) {
          node.classList.add('am-flip');
        }
        return { node, start: flip ? x - width : x, end: flip ? x : x + width };
      }).sort((a, b) => a.start - b.start);
      flags.forEach(({ node, start, end }) => {
        let row = rowEnd.findIndex((limit) => start >= limit);
        if (row < 0) {
          row = rowEnd[0] <= rowEnd[1] ? 0 : 1;
        }
        rowEnd[row] = end + 2;
        stacked = stacked || row > 0;
        node.style.setProperty('--am-row', String(row));
      });
      el.classList.toggle('am-lane-stacked', stacked);
    });
    if (!state.markers.length && laneEls.has('__notes')) {
      laneEls.get('__notes').append(h('span', { class: 'am-lane-empty', text: 'No markers yet. Press m while playing to add one.' }));
    }
    const sources = (state.context && state.context.sources) || [];
    sources.forEach((source) => {
      const as = source.as || {};
      const row = h('div', { class: 'am-lane am-lane-source', 'data-source': source.id },
        h('span', { class: 'am-lane-label', text: as.label || source.id }));
      const sr = state.sampleRate;
      (source.points || []).forEach((p) => {
        const tick = h('span', { class: `am-src-tick${as.style === 'dashed' ? ' am-dashed' : ''}`, title: `${p.label || as.label || source.id}: ${fmtTime(p.sample / sr)}` });
        tick.style.left = `${xOf(p.sample / sr)}px`;
        if (as.color) {
          tick.style.setProperty('--am-c', as.color);
        }
        row.append(tick);
      });
      (source.regions || []).forEach((r) => {
        const band = h('span', { class: `am-src-band${as.style === 'dashed' ? ' am-dashed' : ''}`, title: `${r.label || as.label || source.id}: ${fmtTime(r.startSample / sr)} to ${fmtTime(r.endSample / sr)}` });
        const x0 = xOf(r.startSample / sr);
        band.style.left = `${x0}px`;
        band.style.width = `${Math.max(2, xOf(r.endSample / sr) - x0)}px`;
        if (as.color) {
          band.style.setProperty('--am-c', as.color);
        }
        row.append(band);
      });
      root.append(row);
    });
  }

  // ---------------------------------------------------------------- snapping
  function snapSources(def) {
    const sourceId = def && def.snap && def.snap !== 'none' ? def.snap : null;
    if (!sourceId) {
      return null;
    }
    const source = ((state.context && state.context.sources) || []).find((s) => s.id === sourceId);
    if (!source) {
      return null;
    }
    const samples = [];
    (source.points || []).forEach((p) => samples.push(p.sample));
    (source.regions || []).forEach((r) => samples.push(r.startSample, r.endSample));
    return samples;
  }

  function snapSample(sample, def) {
    if (!state.snapOn) {
      return sample;
    }
    const candidates = snapSources(def);
    if (!candidates || !candidates.length) {
      return sample;
    }
    const reach = Math.max(1, Math.round((8 / Math.max(state.sizes.w, 1)) * state.view.span * state.sampleRate));
    let best = sample;
    let bestDist = reach + 1;
    candidates.forEach((c) => {
      const dist = Math.abs(c - sample);
      if (dist < bestDist) {
        best = c;
        bestDist = dist;
      }
    });
    return best;
  }

  // ---------------------------------------------------------------- pointer interaction
  let drag = null;

  function updateMarkerPart(m, part, sample, grab) {
    const def = typeDef(m.type);
    const sr = state.sampleRate;
    void sr;
    if (m.kind === POINT) {
      m.sample = clamp(snapSample(sample, def), 0, state.frames);
      return;
    }
    if (part === 'whole') {
      const len = grab.length;
      const start = clamp(snapSample(sample - grab.offset, def), 0, Math.max(0, state.frames - len));
      m.startSample = start;
      m.endSample = start + len;
    } else if (part === 'start') {
      m.startSample = clamp(snapSample(sample, def), 0, m.endSample - minLen(m));
    } else {
      m.endSample = clamp(snapSample(sample, def), m.startSample + minLen(m), state.frames);
    }
  }

  function onLanePointerDown(event) {
    if (event.button !== 0) {
      return;
    }
    const partEl = event.target.closest('[data-part]');
    const markerNode = event.target.closest('[data-marker-id]');
    const sample = clamp(sampleOf(pointerSec(event)), 0, state.frames);
    if (partEl && markerNode) {
      const m = findMarker(markerNode.getAttribute('data-marker-id'));
      if (!m) {
        return;
      }
      const part = m.kind === POINT ? 'whole' : partEl.getAttribute('data-part');
      selectMarker(m, part);
      if (isReadOnly(m)) {
        event.preventDefault();
        drawOverlay();
        renderInspector();
        focusMarker(m.id);
        return;
      }
      drag = {
        kind: 'move', id: m.id, part, moved: false, startX: event.clientX,
        grab: m.kind === REGION ? { length: m.endSample - m.startSample, offset: sample - m.startSample } : null,
      };
      event.preventDefault();
      drawOverlay();
      renderInspector();
      attachDrag();
      return;
    }
    if (event.target.closest('.am-lane-source')) {
      return;
    }
    const laneEl = event.target.closest('.am-lane');
    if (!laneEl) {
      return;
    }
    state.selection = null;
    drag = { kind: 'create', lane: laneEl.getAttribute('data-lane'), startSample: sample, startX: event.clientX, id: null };
    drawOverlay();
    renderInspector();
    attachDrag();
  }

  function laneRegionType(laneId) {
    const lane = lanes.find((l) => l.id === laneId);
    if (!lane || lane.notes) {
      return typeDef(SPAN_TYPE);
    }
    const active = state.active;
    const preferred = lane.types.find((t) => t.id === active.typeId && t.kind === REGION);
    return preferred || lane.types.find((t) => t.kind === REGION) || null;
  }

  function lanePointType(laneId) {
    const lane = lanes.find((l) => l.id === laneId);
    if (!lane || lane.notes) {
      return typeDef(NOTE_TYPE);
    }
    const active = state.active;
    return lane.types.find((t) => t.id === active.typeId && t.kind === POINT) || lane.types.find((t) => t.kind === POINT) || null;
  }

  function onDragMove(event) {
    if (!drag) {
      return;
    }
    if (!drag.moved && Math.abs(event.clientX - drag.startX) < 3) {
      return;
    }
    drag.moved = true;
    const sample = clamp(sampleOf(pointerSec(event)), 0, state.frames);
    if (drag.kind === 'scrub') {
      seek(pointerSec(event));
      return;
    }
    if (drag.kind === 'create') {
      if (!drag.id) {
        const def = laneRegionType(drag.lane);
        if (!def) {
          return;
        }
        const m = placeMarker(def, REGION, drag.startSample, drag.startSample + 1);
        drag.id = m.id;
        drag.def = def;
      }
      const m = findMarker(drag.id);
      const a = snapSample(drag.startSample, drag.def);
      const b = snapSample(sample, drag.def);
      m.startSample = Math.min(a, b);
      m.endSample = Math.max(Math.max(a, b), m.startSample + minLen(m));
      drawOverlay();
      renderLanes();
      return;
    }
    const m = findMarker(drag.id);
    if (m) {
      updateMarkerPart(m, drag.part, sample, drag.grab);
      drawOverlay();
      renderLanes();
    }
  }

  function onDragEnd() {
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragEnd);
    window.removeEventListener('pointercancel', onDragEnd);
    const finished = drag;
    drag = null;
    if (finished && finished.kind === 'create' && finished.id) {
      state.selection = { id: finished.id, part: 'whole' };
    }
    redrawMarkers();
    if (finished && (finished.kind === 'move' || finished.kind === 'create') && finished.id) {
      focusMarker(finished.id);
    }
  }

  // The pointer handlers stop the browser's own focus change, so the selected marker
  // takes focus here; Enter then plays from it instead of pressing the last button used.
  function focusMarker(id) {
    const node = ui.lanes.querySelector(`[data-marker-id="${id}"]`);
    if (node) {
      node.focus({ preventScroll: true });
    }
  }

  function attachDrag() {
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragEnd);
    window.addEventListener('pointercancel', onDragEnd);
  }

  function onScrubDown(event) {
    if (event.button !== 0) {
      return;
    }
    drag = { kind: 'scrub', moved: true, startX: event.clientX };
    seek(pointerSec(event));
    attachDrag();
    event.preventDefault();
  }

  function onLaneDblClick(event) {
    if (event.target.closest('[data-marker-id]') || event.target.closest('.am-lane-source')) {
      return;
    }
    const laneEl = event.target.closest('.am-lane');
    if (!laneEl) {
      return;
    }
    const def = lanePointType(laneEl.getAttribute('data-lane'));
    if (!def) {
      return;
    }
    const sample = snapSample(clamp(sampleOf(pointerSec(event)), 0, state.frames), def);
    placeMarker(def, POINT, sample);
    redrawMarkers();
  }

  function onWheel(event) {
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : 1;
    const dx = event.deltaX * unit;
    const dy = event.deltaY * unit;
    if (event.shiftKey || Math.abs(dx) > Math.abs(dy)) {
      const delta = (event.shiftKey ? dy || dx : dx);
      setView(state.view.start + (delta / Math.max(state.sizes.w, 1)) * state.view.span, state.view.span);
      return;
    }
    zoomAt(Math.exp(dy * 0.0018), pointerSec(event));
  }

  // ---------------------------------------------------------------- marker actions
  function activeDef() {
    if (isFreeform(state.active.typeId)) {
      return typeDef(freeTypeFor(state.active.kind));
    }
    return typeDef(state.active.typeId);
  }

  function addPointAt(def, sample) {
    placeMarker(def, POINT, snapSample(sample, def));
    redrawMarkers();
  }

  function tapType(typeId, event, forceKind) {
    const def = typeDef(typeId);
    const kind = forceKind || def.kind || POINT;
    const tap = heardTime(event);
    if (kind === POINT) {
      addPointAt(def, tap.sample);
      setStatus(`${def.label || def.id} at ${fmtTime(tap.heard)} (${tap.sample} samples).`);
      return;
    }
    if (state.pending && state.pending.typeId === def.id) {
      closePending(tap);
    } else {
      state.pending = { typeId: def.id, startSample: tap.sample };
      setStatus(`${def.label || def.id}: region open from ${fmtTime(tap.heard)}. Press the key again to close it.`);
      drawOverlay();
    }
  }

  function closePending(tap) {
    const pending = state.pending;
    if (!pending) {
      return;
    }
    const def = typeDef(pending.typeId);
    if (!def.allowZeroLength && Math.abs(tap.sample - pending.startSample) < 1) {
      state.pending = null;
      return;
    }
    const a = snapSample(pending.startSample, def);
    const b = snapSample(tap.sample, def);
    state.pending = null;
    placeMarker(def, REGION, a, b);
    setStatus(`${def.label || def.id} ${fmtTime(secOf(Math.min(a, b)))} to ${fmtTime(secOf(Math.max(a, b)))}.`);
    redrawMarkers();
  }

  function regionStartKey(event) {
    const def = state.active.kind === REGION ? activeDef() : typeDef(SPAN_TYPE);
    const tap = heardTime(event);
    state.pending = { typeId: def.id, startSample: tap.sample };
    setStatus(`Region open from ${fmtTime(tap.heard)}. Press ] to close it.`);
    drawOverlay();
  }

  function regionEndKey(event) {
    const tap = heardTime(event);
    if (state.pending) {
      closePending(tap);
      return;
    }
    const m = selectedMarker();
    if (m && !isReadOnly(m) && m.kind === REGION && tap.sample >= m.startSample + minLen(m)) {
      m.endSample = tap.sample;
      redrawMarkers();
    }
  }

  function deleteSelected() {
    const m = selectedMarker();
    if (!m || isReadOnly(m)) {
      return;
    }
    if (setOf(m) === state.sets.main && setOf(m).baseline.has(m.id)) {
      state.deleted.set(m.id, m.type);
    }
    state.markers = state.markers.filter((x) => x.id !== m.id);
    state.selection = null;
    redrawMarkers();
  }

  function nudgeSelected(direction, event) {
    const m = selectedMarker();
    if (!m) {
      seek(audio.currentTime + direction * (event.shiftKey ? 5 : 1));
      return;
    }
    if (isReadOnly(m)) {
      return;
    }
    const oneMs = Math.max(1, Math.round(state.sampleRate / 1000));
    const step = (event.altKey ? 1 : event.shiftKey ? 10 * oneMs : oneMs) * direction;
    const part = state.selection.part;
    if (m.kind === POINT) {
      m.sample = clamp(m.sample + step, 0, state.frames);
    } else if (part === 'start') {
      m.startSample = clamp(m.startSample + step, 0, m.endSample - minLen(m));
    } else if (part === 'end') {
      m.endSample = clamp(m.endSample + step, m.startSample + minLen(m), state.frames);
    } else {
      const len = m.endSample - m.startSample;
      const start = clamp(m.startSample + step, 0, state.frames - len);
      m.startSample = start;
      m.endSample = start + len;
    }
    redrawMarkers();
  }

  function toggleLoop() {
    const m = selectedMarker();
    if (m && m.kind === REGION) {
      state.loop = { start: secOf(m.startSample), end: secOf(m.endSample) };
      state.loopOn = true;
      if (audio.paused || audio.currentTime < state.loop.start || audio.currentTime > state.loop.end) {
        seek(state.loop.start);
      }
    } else if (state.loop) {
      state.loopOn = !state.loopOn;
    } else {
      setStatus('Select a region, then press l to loop it.');
      return;
    }
    renderTopControls();
    drawOverlay();
  }

  // ---------------------------------------------------------------- keyboard
  const HELP = [
    ['Space', 'Play or pause'],
    ['m', 'Add a note point at the heard time (works while playing)'],
    ['[  ]', 'Start and end a region at the heard time'],
    ['Template keys', 'Add that marker type at the heard time (a region type opens on the first press and closes on the second)'],
    ['Arrow keys', 'Nudge the selection 1 ms; Shift 10 ms; Alt 1 sample (no selection: seek 1 s, Shift 5 s)'],
    ['Enter', 'Play from the selected marker (selecting a marker also moves the playhead to it)'],
    ['Delete', 'Remove the selected marker'],
    ['l', 'Loop the selected region'],
    ['s', 'Snap to the reference source named by the marker type'],
    ['+  -  0', 'Zoom in, zoom out, fit the whole file'],
    ['Mouse wheel', 'Zoom at the pointer; Shift + wheel scrolls'],
    ['Drag on a lane', 'Create a region; drag handles to move a point or an edge; double-click adds a point'],
    ['Esc', 'Cancel a started region, clear the selection, close this panel'],
    ['?', 'Show or hide this panel'],
  ];

  function toggleHelp(force) {
    const open = force === undefined ? ui['help-panel'].hidden : force;
    ui['help-panel'].hidden = !open;
    ui.help.setAttribute('aria-expanded', String(open));
    if (open && !ui['help-panel'].childElementCount) {
      ui['help-panel'].append(
        h('h3', { text: 'Keyboard' }),
        h('dl', {}, HELP.map(([key, text]) => [h('dt', { text: key }), h('dd', { text })])),
        h('p', { class: 'am-muted', text: 'Taps while playing are corrected for output latency: the heard time is the pressed time minus the output and base latency and your calibration offset.' }),
        h('p', { class: 'am-muted', text: 'Set the Cal (ms) field in the top bar to shift taps earlier (positive) or later (negative) for your output device.' }),
        h('p', { class: 'am-muted', text: `The waveform is drawn from ${((state.blockSize / state.sampleRate) * 1000).toFixed(0)} ms blocks, so zoomed in far it shows flat steps and no detail below a block. Use typed samples, nudge or snap for precision.` }),
      );
    }
  }

  function isTyping(target) {
    if (!target || !target.tagName) {
      return false;
    }
    const tag = target.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) {
      return true;
    }
    return tag === 'INPUT' && !/^(checkbox|radio|button|range)$/.test(target.type);
  }

  function onKeyDown(event) {
    if (event.defaultPrevented) {
      return;
    }
    if (isTyping(event.target)) {
      if (event.key === 'Escape') {
        event.target.blur();
      }
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      return;
    }
    const key = event.key;
    const noteKey = state.sets.notes && state.sets.notes.template && state.sets.notes.template.keys
      ? state.sets.notes.template.keys[NOTE_TYPE] : null;
    const keys = { ...(noteKey ? { [NOTE_TYPE]: noteKey } : {}), ...(state.template.keys || {}) };
    const templateType = !event.altKey && !RESERVED_KEYS.has(key)
      && Object.keys(keys).find((id) => keys[id] === key && (id === NOTE_TYPE || (state.template.markers || []).some((t) => t.id === id)));
    if (templateType && key !== ' ') {
      event.preventDefault();
      armTap(event, (tapEvent) => tapType(templateType, tapEvent));
      return;
    }
    let handled = true;
    switch (key) {
      case ' ':
        togglePlay();
        break;
      case 'm':
        armTap(event, (tapEvent) => tapType(NOTE_TYPE, tapEvent, POINT));
        break;
      case '[':
        armTap(event, regionStartKey);
        break;
      case ']':
        armTap(event, regionEndKey);
        break;
      case 'Enter':
        // A focused button or link keeps its own Enter.
        if (event.target.closest && event.target.closest('button, a, summary')) {
          return;
        }
        handled = playFromSelected();
        break;
      case 's':
        toggleSnap();
        break;
      case 'l':
        toggleLoop();
        break;
      case '+':
      case '=':
        zoomAt(0.5, audio.currentTime);
        break;
      case '-':
        zoomAt(2, audio.currentTime);
        break;
      case '0':
        setView(0, state.duration);
        break;
      case '?':
        toggleHelp();
        break;
      case 'Delete':
      case 'Backspace':
        deleteSelected();
        break;
      case 'ArrowLeft':
        nudgeSelected(-1, event);
        break;
      case 'ArrowRight':
        nudgeSelected(1, event);
        break;
      case 'Home':
        seek(0);
        break;
      case 'Escape':
        if (!ui['help-panel'].hidden) {
          toggleHelp(false);
        } else if (state.pending) {
          state.pending = null;
          drawOverlay();
        } else {
          state.selection = null;
          redrawMarkers();
        }
        break;
      default:
        handled = false;
    }
    if (handled) {
      event.preventDefault();
    }
  }

  // Tap keys: by default the press is the tap (keydown timeStamp). With "Tap on
  // release" the press only arms the key and the keyup timeStamp is the tap.
  // Auto-repeat never taps; each press and release is its own tap.
  const armed = new Map(); // event.code -> action

  function armTap(event, action) {
    if (event.repeat) {
      return;
    }
    if (state.tapOnRelease) {
      armed.set(event.code || event.key, action);
      return;
    }
    action(event);
  }

  function onKeyUp(event) {
    const action = armed.get(event.code || event.key);
    if (action) {
      armed.delete(event.code || event.key);
      action(event);
      event.preventDefault();
      return;
    }
    // A focused button would otherwise click on Space release.
    if (event.key === ' ' && !isTyping(event.target)) {
      event.preventDefault();
    }
  }

  function toggleSnap() {
    state.snapOn = !state.snapOn;
    ui.snap.setAttribute('aria-pressed', String(state.snapOn));
    const names = (state.template.markers || []).filter((t) => t.snap && t.snap !== 'none').map((t) => t.snap);
    setStatus(state.snapOn
      ? (names.length ? `Snap on (${Array.from(new Set(names)).join(', ')}).` : 'Snap on, but no marker type names a source to snap to.')
      : 'Snap off.');
  }

  // ---------------------------------------------------------------- status + alerts
  function setStatus(text) {
    ui.status.textContent = text || '';
  }

  function setAlert(text) {
    ui.alert.hidden = !text;
    ui.alert.textContent = text || '';
  }

  // ---------------------------------------------------------------- top controls
  function renderTopControls() {
    ui.loop.setAttribute('aria-pressed', String(state.loopOn));
    ui.loop.classList.toggle('am-on', state.loopOn);
    ui.snap.classList.toggle('am-on', state.snapOn);
  }

  function navigateTo(mutate) {
    if (isDirty() && !window.confirm('Discard unsaved marker edits?')) {
      return false;
    }
    window.removeEventListener('beforeunload', onBeforeUnload);
    const url = new URL(window.location.href);
    mutate(url.searchParams);
    window.location.assign(url.toString());
    return true;
  }

  function onBeforeUnload(event) {
    if (isDirty()) {
      event.preventDefault();
      event.returnValue = '';
    }
  }

  const SKIPPED_SHOWN = 4;

  // "<n> template file(s) skipped: <file> (<reason>)"; every value goes in through textContent.
  function renderSkipped() {
    const list = (Array.isArray(state.skipped) ? state.skipped : []).filter((item) => item && item.file);
    ui.skipped.hidden = list.length === 0;
    if (!list.length) {
      ui.skipped.textContent = '';
      return;
    }
    const shown = list.slice(0, SKIPPED_SHOWN).map((item) => `${item.file}${item.reason ? ` (${item.reason})` : ''}`);
    const more = list.length > SKIPPED_SHOWN ? `; and ${list.length - SKIPPED_SHOWN} more` : '';
    ui.skipped.textContent = `${list.length} template file${list.length === 1 ? '' : 's'} skipped: ${shown.join('; ')}${more}`;
  }

  function renderPickers() {
    const templateSelect = ui.template;
    templateSelect.textContent = '';
    const list = state.templates.slice();
    if (!list.some((t) => t.templateId === state.template.templateId)) {
      list.unshift({ templateId: state.template.templateId, title: state.template.title || state.template.templateId });
    }
    list.forEach((t) => {
      templateSelect.append(h('option', { value: t.templateId, text: t.title || t.templateId }));
    });
    templateSelect.value = state.template.templateId;

    const recordSelect = ui.record;
    recordSelect.textContent = '';
    recordSelect.append(h('option', { value: '', text: state.latestId ? 'Latest' : 'None saved yet' }));
    const chain = state.history ? [state.history.latest, ...(state.history.predecessors || [])].filter(Boolean) : [];
    chain.forEach((r, index) => {
      const when = r.receiptAt ? new Date(r.receiptAt).toLocaleString() : r.recordId;
      const who = r.actor && r.actor.id ? ` by ${r.actor.id}` : '';
      recordSelect.append(h('option', { value: index === 0 ? '' : r.recordId, text: `${index === 0 ? 'Latest: ' : ''}${when}${who}` }));
    });
    recordSelect.value = state.record && state.latestId && state.record.recordId !== state.latestId ? state.record.recordId : '';
    recordSelect.disabled = !state.latestId;

    const typeSelect = ui.type;
    typeSelect.textContent = '';
    (state.template.markers || []).forEach((type) => {
      typeSelect.append(h('option', { value: type.id, text: `${type.label || type.id} (${type.kind})` }));
    });
    typeSelect.append(h('option', { value: 'note:point', text: 'Note (point)' }), h('option', { value: 'note:region', text: 'Note (region)' }));
    const first = (state.template.markers || [])[0];
    typeSelect.value = first ? first.id : 'note:point';
    applyActive(typeSelect.value);
  }

  function applyActive(value) {
    if (value === 'note:point' || value === 'note:region') {
      state.active = value === 'note:region' ? { typeId: SPAN_TYPE, kind: REGION } : { typeId: NOTE_TYPE, kind: POINT };
    } else {
      const def = typeDef(value);
      state.active = { typeId: def.id, kind: def.kind === REGION ? REGION : POINT };
    }
  }

  // The Add buttons take the same heard time as the keys, from the click event.
  function addAtPlayhead(kind, event) {
    const tap = heardTime(event);
    const t = tap.heard;
    const def = state.active.kind === kind ? activeDef() : typeDef(freeTypeFor(kind));
    const sample = tap.sample;
    const focusNew = () => {
      // Take focus off the toolbar button so Enter means "play from here", not "add again".
      const sel = state.selection;
      if (document.activeElement && typeof document.activeElement.blur === 'function') document.activeElement.blur();
      if (sel && sel.id) setTimeout(() => focusMarker(sel.id), 0);
    };
    if (kind === POINT) {
      addPointAt(def, sample);
      focusNew();
      return;
    }
    const end = Math.min(state.frames, sample + sampleOf(Math.min(1, Math.max(0.05, state.duration - t))));
    placeMarker(def, REGION, sample, Math.max(end, sample + 1));
    redrawMarkers();
    focusNew();
  }

  // ---------------------------------------------------------------- inspector
  function field(labelText, control, hint) {
    return h('label', { class: 'am-field am-field-block' }, h('span', { class: 'am-field-label', text: labelText }), control,
      hint ? h('span', { class: 'am-muted', text: hint }) : null);
  }

  function positionRow(m, key, title) {
    const sample = m[key];
    const unit = unitOf();
    const samplesInput = h('input', {
      type: 'number', step: '1', value: String(sample), 'aria-label': `${title} in samples`, 'data-am-pos': `${key}-samples`,
      onchange: (event) => applyPosition(m, key, Math.round(Number(event.target.value))),
    });
    const children = [h('span', { class: 'am-field-label', text: title }),
      h('span', { class: 'am-pos' }, samplesInput, h('span', { class: 'am-unit', text: 'samples' }))];
    if (unit !== 'samples') {
      const unitInput = h('input', {
        type: 'number', step: unit === 'ms' ? '0.001' : '0.000001', value: String(Number(toUnit(sample).toFixed(6))),
        'aria-label': `${title} in ${unit}`, 'data-am-pos': `${key}-unit`,
        onchange: (event) => applyPosition(m, key, fromUnit(Number(event.target.value))),
      });
      children.push(h('span', { class: 'am-pos' }, unitInput, h('span', { class: 'am-unit', text: unit })));
    }
    return h('div', { class: 'am-field am-field-block am-poswrap' }, children);
  }

  function applyPosition(m, key, sample) {
    if (!Number.isFinite(sample)) {
      renderInspector();
      return;
    }
    m[key] = sample;
    redrawMarkers();
  }

  function recordSummary() {
    const r = state.record;
    const box = h('div', { class: 'am-record' });
    if (!r) {
      box.append(h('p', { class: 'am-muted', text: state.markers.some((m) => m.origin === 'target')
        ? 'No saved set yet. Dashed markers are recorded in the target.' : 'No saved set for this template yet.' }));
      return box;
    }
    const rows = [
      ['Record', r.recordId],
      ['Author', r.actor && r.actor.id],
      ['Saved', r.receiptAt && new Date(r.receiptAt).toLocaleString()],
      ['Template', r.templateId ? `${r.templateId} rev ${r.templateRevision}` : null],
      ['Reason', r.reason],
    ];
    const p = r.projection;
    if (p) {
      rows.push(['Write-back', `${p.status || 'applied'}${p.kind ? ` (${p.kind})` : ''}`]);
      if (p.targetPath) {
        rows.push(['Target', p.targetPath]);
      }
      if (p.before || p.after) {
        rows.push(['Target hash', `${shortHash(p.before)} to ${shortHash(p.after)}`]);
      }
      if (Array.isArray(p.pointers)) {
        rows.push(['Pointers', String(p.pointers.length)]);
      }
    }
    const list = h('dl', { class: 'am-kv' });
    rows.filter((row) => row[1]).forEach(([k, v]) => list.append(h('dt', { text: k }), h('dd', { text: String(v) })));
    box.append(list);
    return box;
  }

  function renderInspector() {
    const root = ui.inspector;
    root.textContent = '';
    const m = selectedMarker();
    if (m) {
      const def = typeDef(m.type);
      const sameKind = (state.template.markers || []).filter((t) => t.kind === m.kind);
      const typeSelect = h('select', {
        'aria-label': 'Marker type', 'data-am-field': 'type',
        onchange: (event) => {
          m.type = event.target.value;
          redrawMarkers();
        },
      });
      sameKind.forEach((t) => typeSelect.append(h('option', { value: t.id, text: t.label || t.id })));
      typeSelect.append(h('option', { value: freeTypeFor(m.kind), text: m.kind === REGION ? 'Span' : 'Note' }));
      typeSelect.value = m.type;
      root.append(
        h('h3', { text: `${def.label || m.type} (${m.kind})` }),
        field('Type', typeSelect),
        ...(m.kind === REGION
          ? [positionRow(m, 'startSample', 'Start'), positionRow(m, 'endSample', 'End'),
            h('p', { class: 'am-muted', text: `Length ${fmtUnit(m.endSample - m.startSample)}` })]
          : [positionRow(m, 'sample', 'Position')]),
        field('Label', h('input', {
          type: 'text', value: m.label || '', 'data-am-field': 'label', maxlength: '200',
          oninput: (event) => { m.label = event.target.value; drawOverlay(); renderLanes(); renderSavebar(); },
        })),
        field('Note', h('textarea', {
          rows: '3', 'data-am-field': 'note', maxlength: '2000', text: m.note || '',
          oninput: (event) => { m.note = event.target.value; renderSavebar(); },
        })),
        h('div', { class: 'am-actions' },
          h('button', { type: 'button', class: 'am-btn', onclick: () => seek(secOf(startOf(m))), text: 'Go to' }),
          h('button', { type: 'button', class: 'am-btn', 'data-am': 'play-from', title: 'Play from this marker (Enter)', onclick: playFromSelected, text: 'Play from here' }),
          h('button', { type: 'button', class: 'am-btn am-btn-danger', 'data-am': 'delete', onclick: deleteSelected, text: 'Delete' })),
      );
      if (markerState(m) === 'target') {
        root.append(h('p', { class: 'am-muted', text: 'Recorded in the target; not yet saved as a marker set.' }));
      }
      const drift = driftFor(m);
      if (drift !== null) {
        root.append(h('div', { class: 'am-driftbox', 'data-am': 'driftbox' },
          h('h4', { text: 'The target changed since this was saved' }),
          h('dl', { class: 'am-kv' },
            h('dt', { text: 'Saved' }), h('dd', { text: fmtValue(markerValue(m)) }),
            h('dt', { text: 'Target' }), h('dd', { text: fmtValue(drift) })),
          h('div', { class: 'am-actions' },
            h('button', {
              type: 'button', class: 'am-btn', 'data-am': 'drift-keep', text: 'Keep saved (write back)',
              onclick: () => { state.driftKept.add(m.id); redrawMarkers(); },
            }),
            h('button', {
              type: 'button', class: 'am-btn', 'data-am': 'drift-target', text: 'Use target',
              onclick: () => {
                if (m.kind === REGION) { m.startSample = drift.startSample; m.endSample = drift.endSample; } else { m.sample = drift; }
                redrawMarkers();
              },
            }))));
      }
      if (isReadOnly(m)) {
        root.querySelectorAll('input, select, textarea, [data-am="delete"]').forEach((el) => { el.disabled = true; });
        root.append(h('p', { class: 'am-muted', text: 'This marker type is not in the open template. It is shown read-only and kept as saved.' }));
      }
    } else {
      root.append(h('h3', { text: `${state.template.title || state.template.templateId}` }), recordSummary());
      if (state.template.description) {
        root.append(h('p', { class: 'am-muted', text: state.template.description }));
      }
    }
    if ((state.template.pickers || []).length) {
      const box = h('div', { class: 'am-pickers' });
      state.template.pickers.forEach((picker) => {
        const select = h('select', {
          'aria-label': picker.label || picker.id, 'data-am-picker': picker.id,
          onchange: (event) => {
            state.tags = { ...(state.tags || {}) };
            if (event.target.value) {
              state.tags[picker.id] = event.target.value;
            } else {
              delete state.tags[picker.id];
            }
            renderSavebar();
            renderInspector();
          },
        }, h('option', { value: '', text: 'Choose' }),
        (picker.options || []).map((opt) => h('option', { value: opt.id, text: opt.label || opt.id })));
        select.value = (state.tags && state.tags[picker.id]) || '';
        box.append(field(`${picker.label || picker.id}${picker.required ? ' (required)' : ''}`, select));
      });
      root.append(box);
    }
    renderChecks();
  }

  // The problems that block Save, listed under the lanes so they are never hidden in a collapsed panel.
  function renderChecks() {
    const root = ui.checks;
    const problems = validate();
    root.textContent = '';
    root.hidden = problems.length === 0;
    if (!problems.length) {
      return;
    }
    root.append(h('h4', { text: `${problems.length} marker problem${problems.length === 1 ? '' : 's'} blocking Save` }),
      h('ul', {}, problems.map((p) => {
        const target = p.markerId ? findMarker(p.markerId) : null;
        const item = h('li', { class: 'am-check' });
        if (target) {
          item.append(h('button', {
            type: 'button', class: 'am-check-link', text: p.message,
            title: 'Select this marker',
            onclick: () => { selectMarker(target, 'whole'); redrawMarkers(); focusMarker(target.id); },
          }));
        } else {
          item.textContent = p.message;
        }
        return item;
      })));
  }

  // ---------------------------------------------------------------- record details panel
  function detailValue(detail) {
    const value = detail.value;
    if (detail.kind === 'list') {
      const items = Array.isArray(value) ? value : (value === undefined || value === null || value === '' ? [] : [value]);
      if (!items.length) {
        return null;
      }
      return h('ul', { class: 'am-detail-list' }, items.map((item) => h('li', { text: typeof item === 'string' ? item : JSON.stringify(item) })));
    }
    if (value === undefined || value === null || value === '') {
      return null;
    }
    if (detail.kind === 'yaml') {
      return h('pre', { class: 'am-detail-pre', tabindex: '0', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) });
    }
    return h('span', { text: typeof value === 'string' ? value : (typeof value === 'object' ? JSON.stringify(value) : String(value)) });
  }

  function noteRows() {
    return state.markers
      .filter((m) => m.origin === 'record' && (m.label || m.note))
      .map((m) => ({ label: m.label || typeDef(m.type).label || m.type, note: m.note || '', at: fmtUnit(startOf(m)) }));
  }

  function renderRecordPanel() {
    const root = ui['record-details'];
    root.textContent = '';
    const context = state.context || {};
    const details = Array.isArray(context.details) ? context.details : [];
    const documents = Array.isArray(context.documents) ? context.documents : [];
    const rows = details.map((detail) => ({ detail, node: detailValue(detail) })).filter((row) => row.node);
    if (rows.length) {
      const list = h('dl', { class: 'am-kv am-details', 'data-am': 'details' });
      rows.forEach(({ detail, node }) => {
        list.append(h('dt', { text: detail.label || detail.id }), h('dd', { 'data-detail-id': detail.id }, node));
      });
      root.append(list);
    }
    documents.forEach((doc) => {
      const head = h('div', { class: 'am-doc-head' }, h('span', { class: 'am-doc-label', text: doc.label || doc.id, title: doc.path || '' }));
      if (doc.truncated) {
        head.append(h('span', { class: 'am-badge', text: 'truncated', title: 'Only the start of this document is shown.' }));
      }
      root.append(h('div', { class: 'am-doc', 'data-doc-id': doc.id },
        head, h('pre', { class: 'am-detail-pre am-doc-text', tabindex: '0', text: String(doc.text === undefined || doc.text === null ? '' : doc.text) })));
    });
    if (!rows.length && !documents.length) {
      const notes = noteRows();
      if (notes.length) {
        const list = h('dl', { class: 'am-kv am-details', 'data-am': 'record-notes' });
        notes.forEach((n) => list.append(h('dt', { text: `${n.label} at ${n.at}` }), h('dd', { text: n.note || 'No note' })));
        root.append(list);
      } else {
        root.append(h('p', { class: 'am-muted', 'data-am': 'record-empty', text: 'No record notes.' }));
      }
    }
  }


  // ---------------------------------------------------------------- save bar
  function projectionDefs() {
    return (state.context && state.context.projections) || [];
  }

  function renderSavebar() {
    const root = ui.savebar;
    const keep = (name) => root.querySelector(`[data-am-field="${name}"]`);
    const reasonValue = keep('reason') ? keep('reason').value : '';
    const projValue = keep('projection') ? keep('projection').value : '';
    const acceptValue = keep('accept') ? keep('accept').checked : false;
    const keepFocus = document.activeElement && root.contains(document.activeElement) ? document.activeElement.getAttribute('data-am-field') : null;
    root.textContent = '';
    const main = state.sets.main;
    const notes = state.sets.notes;
    const needsReason = main.templateId !== 'freeform';
    const projections = projectionDefs();

    const reason = h('input', {
      type: 'text', value: reasonValue, maxlength: '500', 'data-am-field': 'reason', 'aria-required': needsReason ? 'true' : 'false',
      placeholder: needsReason ? 'Why (required)' : 'Why (optional)',
      oninput: () => applyButtonState(),
    });
    const operator = h('input', {
      type: 'text', value: state.operatorName, maxlength: '120', 'data-am-field': 'operator', placeholder: 'Your name',
      autocomplete: 'name',
      onchange: (event) => saveOperatorName(event.target.value.trim()),
      oninput: (event) => { state.operatorName = event.target.value; },
    });
    root.append(h('div', { class: 'am-save-row' }, field('Reason', reason), field('Saved as', operator)));

    let projectionSelect = null;
    let accept = null;
    if (projections.length) {
      projectionSelect = h('select', { 'aria-label': 'Write-back target', 'data-am-field': 'projection' },
        projections.map((p) => h('option', { value: p.id, text: p.label || p.id })));
      projectionSelect.value = projections.some((p) => p.id === projValue) ? projValue : projections[0].id;
      const acceptable = projections.some((p) => p.status || p.acceptable || p.canAccept);
      if (acceptable) {
        accept = h('input', { type: 'checkbox', 'data-am-field': 'accept' });
        accept.checked = acceptValue;
      }
      const row = [field('Write back to', projectionSelect)];
      if (accept) {
        row.push(h('label', { class: 'am-check-inline am-accept' }, accept, ' Mark accepted'));
      }
      root.append(h('div', { class: 'am-save-row am-save-target' }, row));
    }

    // One strong action: with a projection it is "Save and write back"; the plain save is a quiet alternative.
    const buttons = h('div', { class: 'am-actions' });
    if (projections.length) {
      buttons.append(
        h('button', { type: 'button', class: 'am-btn am-btn-primary', 'data-am': 'save-write', text: 'Save and write back', onclick: () => doSaveAll(true) }),
        h('button', { type: 'button', class: 'am-btn am-btn-text', 'data-am': 'preview', text: 'Preview write-back', onclick: () => doPreview() }),
        h('button', { type: 'button', class: 'am-btn am-btn-text', 'data-am': 'save', text: 'Save without write-back', onclick: () => doSaveAll(false) }),
      );
    } else {
      buttons.append(h('button', { type: 'button', class: 'am-btn am-btn-primary', 'data-am': 'save', text: 'Save', onclick: () => doSaveAll(false) }));
    }
    root.append(buttons);
    const reasonHint = h('p', { class: 'am-muted am-save-hint', 'data-am': 'reason-hint', role: 'status', hidden: 'hidden' });
    root.append(reasonHint);

    let notesButton = null;
    if (notes && needsSave(notes)) {
      notesButton = h('button', { type: 'button', class: 'am-btn am-btn-text', 'data-am': 'save-notes', text: 'Save notes', onclick: () => doSave(notes, false) });
      root.append(h('div', { class: 'am-actions am-actions-notes' }, notesButton,
        h('span', { class: 'am-muted', text: 'Notes are their own freeform set.' })));
    }
    if (main.record && main.latestId && main.record.recordId !== main.latestId) {
      root.append(h('p', { class: 'am-muted', text: 'You are viewing an older set. Saving writes a new set on top of the latest.' }));
    }
    const stillInTarget = Array.from(state.deleted.keys()).filter((id) => ((state.context && state.context.targetValues) || {})[id] !== undefined);
    if (stillInTarget.length) {
      root.append(h('p', { class: 'am-muted', 'data-am': 'deleted-note',
        text: `${stillInTarget.length} deleted marker${stillInTarget.length === 1 ? '' : 's'} still hold a value in the target (${stillInTarget.join(', ')}). Deleting never clears the target; the write-back skips absent markers.` }));
    }
    if (state.preview) {
      root.append(previewPanel(state.preview.projection || state.preview));
    }

    // The hint names the one thing that currently stops Save (or Save and write back), updated live.
    function applyButtonState() {
      const reasonOk = !needsReason || reason.value.trim().length > 0;
      const mainProblems = validate('main');
      const allProblems = validate();
      const noTarget = projections.length > 0 && Boolean(state.context) && !state.context.target;
      const ok = mainProblems.length === 0 && reasonOk;
      const notesOk = !notes || validate('notes').length === 0;
      const mainNeeds = needsSave(main);
      const notesNeeds = needsSave(notes);
      const save = buttons.querySelector('[data-am="save"]');
      let hint = '';
      if (state.saving) {
        hint = 'Saving\u2026';
      } else if (allProblems.length) {
        hint = `Fix the ${allProblems.length} marker problem${allProblems.length === 1 ? '' : 's'} above to save.`;
      } else if (!reasonOk) {
        hint = 'Type a reason to enable Save.';
      } else if (!mainNeeds && !notesNeeds) {
        hint = 'All changes saved.';
      } else if (noTarget) {
        hint = 'No record found for this file; save without write-back or pick another template.';
      } else if (isDirty()) {
        hint = 'Unsaved changes.';
      }
      save.disabled = state.saving || !(mainNeeds ? ok && notesOk : notesNeeds && notesOk);
      buttons.querySelectorAll('[data-am="preview"],[data-am="save-write"]').forEach((b) => { b.disabled = state.saving || !ok || noTarget; });
      buttons.querySelectorAll('button').forEach((b) => { b.title = b.disabled && hint ? hint : ''; });
      reasonHint.textContent = hint;
      reasonHint.hidden = !hint;
      if (notesButton) {
        notesButton.disabled = state.saving || !notesOk || !needsSave(notes);
        notesButton.title = notesButton.disabled && !notesOk ? 'Fix the listed problems first.' : '';
      }
    }
    applyButtonState();
    if (keepFocus) {
      const again = keep(keepFocus);
      if (again) {
        again.focus();
        if (again.setSelectionRange && again.type === 'text') {
          again.setSelectionRange(again.value.length, again.value.length);
        }
      }
    }
  }

  function previewPanel(result) {
    const panel = h('div', { class: 'am-preview', 'data-am': 'preview-result' }, h('h4', { text: 'Write-back preview (nothing written)' }));
    const list = h('dl', { class: 'am-kv' });
    if (Array.isArray(result.pointers)) {
      list.append(h('dt', { text: 'Pointers' }), h('dd', { text: result.pointers.join(', ') || 'none' }));
    }
    if (result.candidateSha256) {
      list.append(h('dt', { text: 'Candidate hash' }), h('dd', { text: shortHash(result.candidateSha256) }));
    }
    if (result.validator) {
      const v = result.validator;
      list.append(h('dt', { text: 'Validator' }), h('dd', { text: typeof v === 'object' ? `exit ${v.exit}` : String(v) }));
    }
    panel.append(list);
    if (result.diff) {
      panel.append(h('pre', { class: 'am-diff', text: typeof result.diff === 'string' ? result.diff : JSON.stringify(result.diff, null, 2) }));
    }
    return panel;
  }

  function buildBody(set, useProjection, previewOnly) {
    const root = ui.savebar;
    const reasonEl = root.querySelector('[data-am-field="reason"]');
    const projEl = root.querySelector('[data-am-field="projection"]');
    const acceptEl = root.querySelector('[data-am-field="accept"]');
    const name = (state.operatorName || '').trim();
    const body = {
      audio: { repo: boot.repo, path: boot.path },
      templateId: set.templateId,
      templateRevision: set.template && set.template.revision ? set.template.revision : null,
      markers: setMarkers(set).map(serialize),
      tags: set.tags || {},
      reason: reasonEl ? reasonEl.value.trim() : '',
      supersedesRecord: set.latestId ? { resourceKind: 'marker-record', id: set.latestId } : null,
      touched: touchedIds(set),
      projection: null,
    };
    if (name) {
      body.actor = { name };
    }
    if (set === state.sets.main && (useProjection || previewOnly) && projEl) {
      body.projection = {
        id: projEl.value,
        mode: previewOnly ? 'preview' : 'live',
        accept: Boolean(acceptEl && acceptEl.checked),
        expectedTargetSha256: state.expectedTargetSha256 || null,
      };
    }
    return body;
  }

  function describeError(error) {
    if (!(error instanceof ApiError)) {
      return `Request failed: ${error.message}`;
    }
    if (error.code === 'revision_conflict' || error.code === 'correction_conflict') {
      return 'A newer set was saved by someone else. Reload to see it before saving again.';
    }
    if (error.code === 'target_conflict' || error.code === 'stale_write') {
      return 'The write-back target changed since you opened this page. Reload to see its current values; nothing was written.';
    }
    const detail = error.details ? ` ${typeof error.details === 'string' ? error.details : JSON.stringify(error.details)}` : '';
    return `${error.message}${detail}`;
  }

  function showError(error) {
    setAlert(describeError(error));
    if (error instanceof ApiError && error.status === 409) {
      ui.alert.append(' ', h('button', {
        type: 'button', class: 'am-btn', text: 'Reload',
        onclick: () => {
          window.removeEventListener('beforeunload', onBeforeUnload);
          window.location.reload();
        },
      }));
    }
  }

  async function doPreview() {
    setAlert('');
    try {
      const result = await api.preview(buildBody(state.sets.main, true, true));
      state.preview = result;
      setStatus('Preview ready. Nothing was written.');
    } catch (error) {
      state.preview = null;
      showError(error);
    }
    renderSavebar();
  }

  // One POST for one set. Throws on failure; the caller shows the error.
  async function saveOne(set, useProjection) {
    const result = await api.save(buildBody(set, useProjection, false));
    adoptRecord(set, result.record);
    if (result.targetSha256After) {
      state.expectedTargetSha256 = result.targetSha256After;
      const values = (state.context && state.context.targetValues) || null;
      if (values && set === state.sets.main) {
        setMarkers(set).forEach((m) => { if (values[m.id] !== undefined) { values[m.id] = markerValue(m); } });
      }
    }
    state.preview = null;
    const p = result.record && result.record.projection;
    const recordId = shortHash(result.record && result.record.recordId);
    setStatus(p ? `Saved and written back. Record ${recordId}, write-back ${p.status || 'applied'}.` : `Saved record ${recordId}.`);
    refreshHistory(set);
  }

  function needsSave(set) {
    return Boolean(set) && (isDirty(set) || (!set.latestId && (set === state.sets.main || setMarkers(set).length > 0)));
  }

  // Save everything that needs saving: the template set first, then the freeform set.
  // A failure in the second leaves the first saved.
  async function doSaveAll(useProjection) {
    setAlert('');
    const { main, notes } = state.sets;
    const steps = [];
    if (needsSave(main) || useProjection) {
      steps.push([main, useProjection, 'main']);
    }
    if (needsSave(notes)) {
      steps.push([notes, false, 'notes']);
    }
    if (steps.some(([, , which]) => validate(which).length)) {
      setAlert('Fix the listed problems before saving.');
      return;
    }
    state.saving = true;
    renderSavebar();
    for (let i = 0; i < steps.length; i += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await saveOne(steps[i][0], steps[i][1]);
      } catch (error) {
        showError(error);
        if (i > 0) {
          setStatus('The template set was saved. The notes set was not.');
        }
        break;
      }
    }
    state.saving = false;
    redrawMarkers();
    renderPickers();
    renderRecordPanel();
  }

  async function doSave(set, useProjection) {
    setAlert('');
    if (validate(set === state.sets.main ? 'main' : 'notes').length) {
      setAlert('Fix the listed problems before saving.');
      return;
    }
    state.saving = true;
    renderSavebar();
    try {
      await saveOne(set, useProjection);
    } catch (error) {
      showError(error);
    }
    state.saving = false;
    redrawMarkers();
    renderPickers();
    renderRecordPanel();
  }

  function adoptRecord(set, record) {
    if (!record) {
      return;
    }
    set.record = record;
    set.latestId = record.recordId;
    set.history = null;
    set.tags = record.tags || {};
    state.markers = state.markers.filter((m) => setOf(m) !== set)
      .concat((record.markers || []).map((raw) => fromRecordMarker(raw, 'record')));
    state.selection = null;
    state.driftKept = new Set();
    if (set === state.sets.main) {
      state.deleted = new Map();
    }
    setBaseline(set);
  }

  async function refreshHistory(set) {
    if (!set.latestId) {
      return;
    }
    try {
      const result = await api.history(set.latestId);
      set.history = { latest: result.latest, predecessors: result.predecessors || [] };
      renderPickers();
    } catch (_error) {
      // The picker simply keeps its current options.
    }
  }

  async function loadSetRecords(set, wantedId) {
    let latest = null;
    if (boot.markersEnabled === false) { set.latestId = null; set.record = null; set.markers = set.markers || []; return; }
    try {
      const result = await api.records(set.templateId);
      latest = (result.records || []).find((r) => r.templateId === set.templateId) || null;
    } catch (_error) {
      latest = null;
    }
    set.latestId = latest ? latest.recordId : null;
    set.record = latest;
    if (wantedId && wantedId !== set.latestId) {
      try {
        const result = await api.history(wantedId);
        set.history = { latest: result.latest, predecessors: result.predecessors || [] };
        const chain = [result.latest, ...(result.predecessors || [])].filter(Boolean);
        if (result.latest) {
          set.latestId = result.latest.recordId;
        }
        set.record = chain.find((r) => r.recordId === wantedId) || set.record;
      } catch (_error) {
        try {
          const result = await api.record(wantedId);
          set.record = result.record || set.record;
        } catch (_inner) {
          setAlert('That marker set could not be opened.');
        }
      }
    } else if (latest) {
      try {
        const result = await api.history(latest.recordId);
        set.history = { latest: result.latest, predecessors: result.predecessors || [] };
      } catch (_error) {
        set.history = { latest, predecessors: [] };
      }
    }
  }

  function loadImage() {
    const image = state.context && state.context.image;
    if (!image || !image.url) {
      return;
    }
    const el = new Image();
    el.onload = () => { state.imageEl = el; drawAll(); };
    el.onerror = () => { setStatus('The reference image could not be loaded.'); };
    el.src = withToken(image.url);
  }

  async function init() {
    const markersOn = boot.markersEnabled !== false;
    if (!markersOn) document.documentElement.classList.add('audio-markers-off');
    loadCalibration();
    loadTapEdge();
    loadOperatorName();
    app.hidden = false;
    setStatus('Loading waveform...');
    let info;
    let buffer;
    try {
      [info, buffer] = await Promise.all([api.info(), api.peaks()]);
    } catch (error) {
      setAlert(`Could not load the waveform: ${describeError(error)}`);
      setStatus('');
      app.querySelector('.am-stage').hidden = true;
      app.append(h('audio', { controls: true, preload: 'metadata', src: boot.assetUrl }));
      return;
    }
    state.info = info;
    state.sampleRate = Number(info.sampleRate) || 44100;
    state.channels = Math.max(1, Number(info.channels) || 1);
    state.frames = Number(info.frames) || 0;
    state.duration = Number(info.durationSeconds) || state.frames / state.sampleRate;
    state.blockSize = Number(info.blockSize) || 1152;
    const even = buffer.byteLength - (buffer.byteLength % 2);
    state.peaks = new Uint16Array(even === buffer.byteLength ? buffer : buffer.slice(0, even));
    state.view = { start: 0, span: Math.max(state.duration, 0.001) };

    const [templateList, template, context, freeform] = await Promise.all([
      markersOn ? api.templates().catch(() => ({ templates: [] })) : Promise.resolve({ templates: [] }),
      markersOn ? api.template(boot.templateId).catch(() => null) : Promise.resolve(null),
      markersOn ? api.context(boot.templateId).catch(() => null) : Promise.resolve(null),
      (!markersOn || boot.templateId === 'freeform') ? Promise.resolve(null) : api.template('freeform').catch(() => null),
    ]);
    state.templates = templateList.templates || [];
    state.skipped = Array.isArray(templateList.skipped) ? templateList.skipped : [];
    state.template = (template && template.template) || (boot.templateId === 'freeform' ? FREEFORM_TEMPLATE : { ...FREEFORM_TEMPLATE, templateId: boot.templateId });
    if (!template && boot.templateId !== 'freeform') {
      setAlert(`Template ${boot.templateId} could not be loaded; showing it as freeform.`);
    }
    state.context = context;
    state.expectedTargetSha256 = (context && context.target && context.target.sha256) || null;
    const main = newSet(state.template.templateId, state.template);
    state.sets.main = main;
    state.sets.notes = main.templateId === 'freeform' ? null
      : newSet('freeform', (freeform && freeform.template) || FREEFORM_TEMPLATE);
    await Promise.all([loadSetRecords(main, boot.recordId), state.sets.notes ? loadSetRecords(state.sets.notes, null) : null]);

    const fromSet = (set) => (set.record ? (set.record.markers || []).map((raw) => fromRecordMarker(raw, 'record')) : []);
    state.markers = [...(main.record ? fromSet(main) : seedFromReads()), ...(state.sets.notes ? fromSet(state.sets.notes) : [])];
    main.tags = { ...((main.record && main.record.tags) || {}) };
    setBaseline(main);
    if (state.sets.notes) {
      setBaseline(state.sets.notes);
    }
    loadImage();

    renderPickers();
    renderSkipped();
    bindEvents();
    new ResizeObserver(() => drawAll()).observe(ui.stage);
    new MutationObserver(() => drawAll()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-color-scheme'] });
    if (boot.startSeconds) {
      audio.addEventListener('loadedmetadata', () => seek(boot.startSeconds), { once: true });
      seek(boot.startSeconds);
    }
    drawAll();
    redrawMarkers();
    renderRecordPanel();
    renderLatency();
    const bits = [`${state.template.title || state.template.templateId}${state.template.revision ? ` rev ${state.template.revision}` : ''}`];
    if (state.record) {
      bits.push(`record ${shortHash(state.record.recordId)}`);
    }
    if (state.context && !state.context.target) {
      bits.push('no target found');
    }
    setStatus(bits.join(' | '));
    state.ready = true;
    window.requestAnimationFrame(frame);
  }

  function bindEvents() {
    ui.cal.value = String(state.calibrationMs);
    ui.cal.addEventListener('change', () => {
      const value = Number(ui.cal.value);
      saveCalibration(Number.isFinite(value) ? value : 0);
      ui.cal.value = String(state.calibrationMs);
      renderLatency();
    });
    ui['tap-release'].checked = state.tapOnRelease;
    ui['tap-release'].addEventListener('change', () => {
      saveTapEdge(ui['tap-release'].checked);
      armed.clear();
      setStatus(state.tapOnRelease ? 'Taps register when the key is released.' : 'Taps register when the key is pressed.');
    });
    ui.play.addEventListener('click', togglePlay);
    audio.addEventListener('play', () => { ui.play.textContent = 'Pause'; ui.play.setAttribute('aria-pressed', 'true'); });
    audio.addEventListener('pause', () => { ui.play.textContent = 'Play'; ui.play.setAttribute('aria-pressed', 'false'); });
    audio.addEventListener('ended', () => { ui.play.textContent = 'Play'; ui.play.setAttribute('aria-pressed', 'false'); });
    audio.addEventListener('error', () => setAlert('The browser could not play this file.'));
    ui.loop.addEventListener('click', toggleLoop);
    ui.rate.addEventListener('change', () => { audio.playbackRate = Number(ui.rate.value) || 1; });
    ui['zoom-in'].addEventListener('click', () => zoomAt(0.5, audio.currentTime));
    ui['zoom-out'].addEventListener('click', () => zoomAt(2, audio.currentTime));
    ui['zoom-fit'].addEventListener('click', () => setView(0, state.duration));
    ui.snap.addEventListener('click', toggleSnap);
    ui.help.addEventListener('click', () => toggleHelp());
    ui.template.addEventListener('change', () => {
      if (!navigateTo((params) => { params.set('template', ui.template.value); params.delete('record'); })) {
        ui.template.value = state.template.templateId;
      }
    });
    ui.record.addEventListener('change', () => {
      navigateTo((params) => {
        if (ui.record.value) {
          params.set('record', ui.record.value);
        } else {
          params.delete('record');
        }
      });
    });
    ui.type.addEventListener('change', () => applyActive(ui.type.value));
    ui['add-point'].addEventListener('click', (event) => addAtPlayhead(POINT, event));
    ui['add-region'].addEventListener('click', (event) => addAtPlayhead(REGION, event));
    ui.pan.addEventListener('input', () => {
      const range = state.duration - state.view.span;
      setView((Number(ui.pan.value) / 1000) * range, state.view.span);
    });
    ui['inspector-toggle'].addEventListener('click', () => {
      const open = ui['inspector-toggle'].getAttribute('aria-expanded') !== 'true';
      ui['inspector-toggle'].setAttribute('aria-expanded', String(open));
      app.classList.toggle('am-inspector-closed', !open);
    });
    ui['record-toggle'].addEventListener('click', () => {
      const open = ui['record-toggle'].getAttribute('aria-expanded') !== 'true';
      ui['record-toggle'].setAttribute('aria-expanded', String(open));
      app.classList.toggle('am-record-closed', !open);
    });
    if (window.matchMedia('(max-width: 800px)').matches) {
      ui['inspector-toggle'].setAttribute('aria-expanded', 'false');
      app.classList.add('am-inspector-closed');
      ui['record-toggle'].setAttribute('aria-expanded', 'false');
      app.classList.add('am-record-closed');
    }
    ui['wave-box'].addEventListener('pointerdown', onScrubDown);
    ui.ruler.addEventListener('pointerdown', onScrubDown);
    ui['image-box'].addEventListener('pointerdown', onScrubDown);
    ui.stage.addEventListener('wheel', onWheel, { passive: false });
    ui.lanes.addEventListener('pointerdown', onLanePointerDown);
    ui.lanes.addEventListener('dblclick', onLaneDblClick);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('blur', () => armed.clear());
  }

  // ---------------------------------------------------------------- test hook
  window.__audioMarkers = {
    // The clock function receives the key event and returns
    // { pressed (seconds), playing?, outputLatency?, baseLatency? }.
    // The values the heard-time formula would use right now:
    // { now, playing, outputLatency, baseLatency, calibrationMs, latency } (seconds, except calibrationMs).
    getClock: () => ({ ...clockValues(), tapEdge: state.tapOnRelease ? 'release' : 'press' }),
    // setClock({ now, playing, outputLatency, baseLatency, calibrationMs }) replaces any of
    // those with a number or a function(event); setClock(null) restores the live clock.
    setClock(spec) {
      injected = typeof spec === 'function' ? { now: spec } : (spec && typeof spec === 'object' ? { ...spec } : null);
    },
    state,
    audio,
    api,
    get ready() { return state.ready; },
  };

  init();
}());
