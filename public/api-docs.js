// Lookie API explorer: renders /openapi.json and sends try-it requests.
(function () {
  'use strict';
  var root = document.querySelector('[data-api-docs]');
  if (!root) return;
  var nav = root.querySelector('[data-api-docs-nav]');
  var detail = root.querySelector('[data-api-docs-operation]');
  var tokenInput = root.querySelector('[data-api-docs-token]');
  var TOKEN_KEY = 'lookie-api-docs-token';
  var spec = null;

  try { tokenInput.value = sessionStorage.getItem(TOKEN_KEY) || ''; } catch (_e) { /* storage unavailable */ }
  tokenInput.addEventListener('input', function () {
    try { sessionStorage.setItem(TOKEN_KEY, tokenInput.value); } catch (_e) { /* ignore */ }
  });

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      if (key === 'text') node.textContent = attrs[key];
      else node.setAttribute(key, attrs[key]);
    });
    (children || []).forEach(function (child) { if (child) node.appendChild(child); });
    return node;
  }

  function resolveRef(schema) {
    var seen = 0;
    while (schema && schema.$ref && seen++ < 10) {
      var parts = schema.$ref.replace(/^#\//, '').split('/');
      schema = parts.reduce(function (acc, part) { return acc && acc[part]; }, spec);
    }
    return schema;
  }

  function exampleFor(schema, depth) {
    schema = resolveRef(schema);
    if (!schema || depth > 4) return null;
    if (schema.example !== undefined) return schema.example;
    if (schema.enum) return schema.enum[0];
    if (schema.type === 'object' || schema.properties) {
      var out = {};
      Object.keys(schema.properties || {}).forEach(function (key) {
        out[key] = exampleFor(schema.properties[key], depth + 1);
      });
      return out;
    }
    if (schema.type === 'array') return [exampleFor(schema.items, depth + 1)];
    if (schema.type === 'integer' || schema.type === 'number') return 1;
    if (schema.type === 'boolean') return false;
    if (schema.type === 'string') return '';
    return null;
  }

  function renderNav() {
    var groups = {};
    Object.keys(spec.paths).forEach(function (p) {
      Object.keys(spec.paths[p]).forEach(function (method) {
        var op = spec.paths[p][method];
        var tag = (op.tags && op.tags[0]) || 'other';
        (groups[tag] = groups[tag] || []).push({ path: p, method: method, op: op });
      });
    });
    nav.textContent = '';
    var order = (spec.tags || []).map(function (t) { return t.name; });
    Object.keys(groups).sort(function (a, b) { return order.indexOf(a) - order.indexOf(b); }).forEach(function (tag) {
      nav.appendChild(el('h2', { text: tag }));
      groups[tag].forEach(function (entry) {
        var button = el('button', { type: 'button', title: entry.op.summary || '' }, [
          el('span', { class: 'method', text: entry.method.toUpperCase() }),
          el('span', { text: entry.path }),
        ]);
        button.addEventListener('click', function () {
          nav.querySelectorAll('button').forEach(function (b) { b.removeAttribute('aria-current'); });
          button.setAttribute('aria-current', 'true');
          renderOperation(entry);
        });
        nav.appendChild(button);
      });
    });
  }

  function renderOperation(entry) {
    var op = entry.op;
    detail.textContent = '';
    detail.appendChild(el('h2', {}, [el('span', { class: 'method', text: entry.method.toUpperCase() }), el('code', { text: entry.path })]));
    detail.appendChild(el('p', { text: op.summary || '' }));
    if (op.description) detail.appendChild(el('p', { class: 'soft', text: op.description }));
    var inputs = [];
    (op.parameters || []).forEach(function (param, index) {
      var id = 'api-docs-param-' + index;
      var input = el('input', { id: id, type: 'text', placeholder: (param.schema && param.schema.type) || 'string' });
      inputs.push({ param: param, input: input });
      detail.appendChild(el('label', { for: id, text: param.name + ' (' + param.in + (param.required ? ', required' : '') + ')' + (param.description ? ' - ' + param.description : '') }));
      detail.appendChild(input);
    });
    var body = null;
    var content = op.requestBody && op.requestBody.content;
    var contentType = content && Object.keys(content)[0];
    if (contentType) {
      body = el('textarea', { id: 'api-docs-body', spellcheck: 'false' });
      var example = exampleFor(content[contentType].schema, 0);
      body.value = contentType === 'application/json' ? JSON.stringify(example, null, 2)
        : new URLSearchParams(example || {}).toString();
      detail.appendChild(el('label', { for: 'api-docs-body', text: 'Body (' + contentType + ')' }));
      detail.appendChild(body);
    }
    var send = el('button', { type: 'button', class: 'send', text: 'Send' });
    var output = el('div', { 'aria-live': 'polite' });
    detail.appendChild(send);
    detail.appendChild(output);
    send.addEventListener('click', function () {
      var url = entry.path;
      var query = new URLSearchParams();
      inputs.forEach(function (item) {
        var value = item.input.value;
        if (item.param.in === 'path') {
          var encoded = item.param.name === 'path' ? value.split('/').map(encodeURIComponent).join('/') : encodeURIComponent(value);
          url = url.replace('{' + item.param.name + '}', encoded);
        } else if (value !== '') {
          query.append(item.param.name, value);
        }
      });
      if (query.toString()) url += '?' + query.toString();
      var headers = {};
      if (tokenInput.value) headers.Authorization = 'Bearer ' + tokenInput.value;
      var init = { method: entry.method.toUpperCase(), headers: headers, credentials: 'same-origin' };
      if (body) {
        headers['Content-Type'] = contentType;
        init.body = body.value;
      }
      output.textContent = 'Sending ' + init.method + ' ' + url + '...';
      fetch(url, init).then(function (response) {
        return response.text().then(function (text) {
          var pretty = text;
          try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch (_e) { /* not JSON */ }
          var headerLines = [];
          response.headers.forEach(function (value, name) { headerLines.push(name + ': ' + value); });
          output.textContent = '';
          output.appendChild(el('p', { text: 'Status ' + response.status + ' ' + response.statusText }));
          output.appendChild(el('pre', { text: headerLines.join('\n') }));
          output.appendChild(el('pre', { text: pretty }));
        });
      }).catch(function (error) {
        output.textContent = 'Request failed: ' + error.message;
      });
    });
  }

  var specUrl = root.getAttribute('data-spec-url') || '/openapi.json';
  var pageToken = new URLSearchParams(location.search).get('token');
  if (pageToken) specUrl += '?token=' + encodeURIComponent(pageToken);
  fetch(specUrl, { headers: tokenInput.value ? { Authorization: 'Bearer ' + tokenInput.value } : {} })
    .then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    })
    .then(function (document_) { spec = document_; renderNav(); })
    .catch(function (error) { nav.textContent = 'Could not load openapi.json: ' + error.message; });
}());
