'use strict';

// Geometry checks for annotated diagrams (svg.dg-canvas). inspectDiagrams runs
// inside the page, so it must stay self-contained: no closures, no imports.
function inspectDiagrams() {
  const luminance = (color) => {
    const v = color.match(/[\d.]+/g).slice(0, 3).map(Number).map((n) => n / 255)
      .map((n) => (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4));
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  };
  const contrast = (a, b) => {
    const x = luminance(a);
    const y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return {l: r.left, t: r.top, r: r.right, b: r.bottom};
  };
  // Screen-space polylines for one leader; a jump between samples is a new subpath.
  const chains = (el) => {
    const total = el.getTotalLength();
    const matrix = el.getScreenCTM();
    if (!total || !matrix) return [];
    const step = Math.max(total / 240, 0.5);
    const out = [[]];
    let last = null;
    for (let d = 0; d <= total + 0.001; d += step) {
      const p = el.getPointAtLength(Math.min(d, total)).matrixTransform(matrix);
      if (last && Math.hypot(p.x - last.x, p.y - last.y) > step * matrix.a * 1.6 + 0.6) out.push([]);
      out[out.length - 1].push({x: p.x, y: p.y});
      last = p;
    }
    return out.filter((chain) => chain.length > 1);
  };
  const crosses = (p1, p2, p3, p4) => {
    const side = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const d1 = side(p3, p4, p1);
    const d2 = side(p3, p4, p2);
    const d3 = side(p1, p2, p3);
    const d4 = side(p1, p2, p4);
    return d1 * d2 < 0 && d3 * d4 < 0;
  };
  const figures = [...document.querySelectorAll('svg.dg-canvas')].map((svg) => {
    const view = svg.viewBox.baseVal;
    const frame = box(svg);
    const scale = (frame.r - frame.l) / view.width;
    const name = (el) => (el.tagName.toLowerCase() === 'circle'
      ? `marker ${el.parentNode.textContent.trim()}` : el.textContent.trim());
    const texts = [...svg.querySelectorAll('text')];
    const outside = texts.filter((t) => {
      const b = box(t);
      return b.l < frame.l - 0.5 || b.t < frame.t - 0.5 || b.r > frame.r + 0.5 || b.b > frame.b + 0.5;
    }).map(name);
    // A marker's footprint is its circle; every other label is its text box.
    const footprints = [...svg.querySelectorAll('text, .dg-marker circle')]
      .filter((el) => !(el.tagName.toLowerCase() === 'text' && el.closest('.dg-marker')))
      .map((el) => ({name: name(el), ...box(el)}));
    const collisions = [];
    for (let i = 0; i < footprints.length; i += 1) {
      for (let j = i + 1; j < footprints.length; j += 1) {
        const a = footprints[i];
        const b = footprints[j];
        const w = Math.min(a.r, b.r) - Math.max(a.l, b.l);
        const h = Math.min(a.b, b.b) - Math.max(a.t, b.t);
        if (w > 1 && h > 1) collisions.push([a.name, b.name]);
      }
    }
    const leaders = [...svg.querySelectorAll('.dg-leader')].map(chains);
    // A leader may end beside its label; it must not run through any label's text.
    const struck = footprints.filter((f) => !f.name.startsWith('marker ') && leaders.some((leader) => leader
      .some((chain) => chain.some((p) => p.x > f.l + 1.5 && p.x < f.r - 1.5 && p.y > f.t + 1.5 && p.y < f.b - 1.5))))
      .map((f) => f.name);
    let leaderCrossings = 0;
    for (let i = 0; i < leaders.length; i += 1) {
      for (let j = i + 1; j < leaders.length; j += 1) {
        const ends = [...leaders[i], ...leaders[j]].flatMap((chain) => [chain[0], chain[chain.length - 1]]);
        let hit = false;
        for (const a of leaders[i]) for (const b of leaders[j]) {
          for (let m = 1; m < a.length && !hit; m += 1) for (let n = 1; n < b.length && !hit; n += 1) {
            // Lines that only meet at an endpoint are joined, not crossed.
            if (crosses(a[m - 1], a[m], b[n - 1], b[n])
              && !ends.some((e) => Math.hypot(e.x - a[m].x, e.y - a[m].y) < 3)) hit = true;
          }
        }
        if (hit) leaderCrossings += 1;
      }
    }
    const card = svg.closest('.dg');
    const background = card ? getComputedStyle(card).backgroundColor : null;
    const themed = background ? [...svg.querySelectorAll('.dg-label, .dg-detail, .dg-view')]
      .map((t) => contrast(getComputedStyle(t).fill, background)) : [];
    const markers = [...svg.querySelectorAll('.dg-marker text')].map((t) => t.textContent.trim());
    const key = card ? card.querySelector('.dg-key') : null;
    const expected = key ? Array.from({length: key.children.length}, (_, i) => String(i + 1)) : null;
    const scroll = svg.closest('.dg-scroll');
    const names = (svg.getAttribute('aria-labelledby') || '').split(' ').filter(Boolean);
    return {
      title: svg.querySelector('title') ? svg.querySelector('title').textContent : '',
      named: names.length > 0 && names.every((id) => {
        const el = document.getElementById(id);
        return !!(el && el.textContent.trim());
      }),
      renderedWidth: Math.round(frame.r - frame.l),
      minTextPx: texts.length
        ? Number(Math.min(...texts.map((t) => parseFloat(getComputedStyle(t).fontSize) * scale)).toFixed(1)) : null,
      outside,
      collisions,
      struck,
      leaderCrossings,
      minThemedContrast: themed.length ? Number(Math.min(...themed).toFixed(2)) : null,
      markerKeyMatch: expected ? [...new Set(markers)].sort().join() === [...expected].sort().join() : null,
      needsSidewaysScroll: scroll ? scroll.scrollWidth > scroll.clientWidth + 1 : false,
    };
  });
  const root = document.documentElement;
  return {pageOverflow: root.scrollWidth > root.clientWidth, figures};
}

// Failures block a handoff. Notices need a human look but can be legitimate.
function diagramProblems(report, {minTextPx = 10, minContrast = 4.5} = {}) {
  const failures = [];
  const notices = [];
  if (report.pageOverflow) failures.push('page scrolls sideways');
  report.figures.forEach((figure, index) => {
    const at = `diagram ${index + 1} (${figure.title || 'untitled'})`;
    if (!figure.named) failures.push(`${at}: title/desc missing or not referenced by aria-labelledby`);
    for (const label of figure.outside) failures.push(`${at}: "${label}" is outside the canvas`);
    for (const [a, b] of figure.collisions) failures.push(`${at}: "${a}" overlaps "${b}"`);
    for (const label of figure.struck) failures.push(`${at}: a leader line runs through "${label}"`);
    if (figure.markerKeyMatch === false) failures.push(`${at}: marker numbers do not match the key`);
    if (figure.minTextPx !== null && figure.minTextPx < minTextPx) {
      failures.push(`${at}: smallest text renders at ${figure.minTextPx}px (minimum ${minTextPx}px)`);
    }
    if (figure.minThemedContrast !== null && figure.minThemedContrast < minContrast) {
      failures.push(`${at}: label contrast ${figure.minThemedContrast}:1 is below ${minContrast}:1`);
    }
    if (figure.leaderCrossings) notices.push(`${at}: ${figure.leaderCrossings} pair(s) of leader lines cross; confirm it is intended`);
    if (figure.needsSidewaysScroll) notices.push(`${at}: needs sideways scrolling at this width`);
  });
  return {failures, notices};
}

module.exports = {inspectDiagrams, diagramProblems};
