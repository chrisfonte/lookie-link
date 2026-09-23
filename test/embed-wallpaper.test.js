'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const {JSDOM} = require('jsdom');
const {wallpaperControlsHtml, wallpaperControlsScript} = require('../lib/embed-wallpaper');

function setup() {
  const dom = new JSDOM('<!doctype html><div class="viewer-toolbar">' + wallpaperControlsHtml() + '</div><iframe data-embedded-html></iframe>' + wallpaperControlsScript(), {runScripts:'dangerously'});
  const win = dom.window;
  const frame = win.document.querySelector('iframe');
  const menu = win.document.querySelector('[data-wallpaper-menu]');
  const sent = [];
  frame.contentWindow.postMessage = message => sent.push(message);
  const valid = {type:'lookie-link:wallpaper-state', choices:[{id:'first',label:'First'},{id:'second',label:'Second'}],choice:'first',opacity:80,blur:0};
  const post = (data, source = frame.contentWindow) => win.dispatchEvent(new win.MessageEvent('message', {source,data}));
  return {dom,win,frame,menu,sent,valid,post};
}

test('wallpaper toolbar accepts only bounded state from its embedded window', () => {
  const t = setup();
  try {
    t.post(t.valid, t.win);
    assert.equal(t.menu.hidden, true);
    for (const patch of [
      {opacity:NaN}, {opacity:49}, {blur:17}, {blur:'1'}, {choice:'unknown'},
      {choices:[]}, {choices:Array(51).fill({id:'a',label:'A'})},
      {choices:[{id:'none',label:'A'}]}, {choices:[{id:'x',label:'x'.repeat(81)}]},
      {choices:[{id:'x',label:'A'},{id:'x',label:'B'}]},
    ]) {
      t.post({...t.valid,...patch});
      assert.equal(t.menu.hidden,true);
    }
    t.post({...t.valid,choices:[{id:'first',label:'<img src=x onerror=alert(1)>'}]});
    assert.equal(t.menu.hidden,false);
    assert.equal(t.menu.querySelector('img'),null);
    assert.equal(t.menu.querySelector('option[value="first"]').textContent,'<img src=x onerror=alert(1)>');
    assert.equal(t.sent.at(-1).type,'lookie-link:wallpaper-toolbar-ready');
  } finally { t.dom.window.close(); }
});

test('wallpaper toolbar cycles, sends numeric controls, and clears on navigation', () => {
  const t=setup();
  try {
    t.post(t.valid);
    const click = selector => t.menu.querySelector(selector).click();
    click('[data-wallpaper-previous]');
    assert.equal(t.sent.at(-1).choice,'second');
    click('[data-wallpaper-next]');
    assert.equal(t.sent.at(-1).choice,'first');
    const select=t.menu.querySelector('[data-wallpaper-choice]');
    select.value='none'; select.dispatchEvent(new t.win.Event('change'));
    assert.equal(t.sent.at(-1).choice,'none');
    click('[data-wallpaper-next]');
    assert.equal(t.sent.at(-1).choice,'first');
    const range=t.menu.querySelector('[data-wallpaper-opacity]');
    range.value='62'; range.dispatchEvent(new t.win.Event('input'));
    assert.equal(t.sent.at(-1).opacity,62);
    click('[data-wallpaper-reset]');
    assert.equal(t.sent.at(-1).type,'lookie-link:reset-wallpaper');
    t.menu.open=true;
    t.win.document.dispatchEvent(new t.win.KeyboardEvent('keydown',{key:'Escape'}));
    assert.equal(t.menu.open,false);
    t.menu.open=true;
    t.win.dispatchEvent(new t.win.Event('blur'));
    assert.equal(t.menu.open,true, 'blur without frame focus keeps the menu');
    t.frame.dispatchEvent(new t.win.Event('load'));
    assert.equal(t.menu.hidden,true);
    assert.equal(t.sent.at(-1).type,'lookie-link:request-wallpaper-state');
  } finally { t.dom.window.close(); }
});


test('empty theme catalogs clear prior choices and disable cycling', () => {
  const t=setup();
  try {
    t.post(t.valid);
    t.post({...t.valid,choices:[],choice:'none'});
    assert.equal(t.menu.querySelectorAll('option').length,1);
    assert.equal(t.menu.querySelector('select').value,'none');
    assert.equal(t.menu.querySelector('[data-wallpaper-next]').disabled,true);
    assert.equal(t.menu.querySelector('[data-wallpaper-previous]').disabled,true);
    assert.equal(t.menu.querySelector('select').disabled,true);
    t.post(t.valid);
    assert.equal(t.menu.querySelector('select').disabled,false);
    assert.equal(t.menu.querySelectorAll('option').length,3);
    assert.equal(t.menu.querySelector('[data-wallpaper-next]').disabled,false);
  } finally { t.dom.window.close(); }
});
