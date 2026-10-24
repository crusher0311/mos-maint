const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../mos-tools-extension/adapters/shopmonkey-buttons.js');

function fixture() {
  class Element {
    constructor() { this.children = []; this.attributes = {}; this.style = {}; this.handlers = {}; }
    appendChild(el) { el.parentElement = this; this.children.push(el); }
    remove() {
      if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(c => c !== this);
      this.parentElement = null;
    }
    setAttribute(k, v) { this.attributes[k] = v; }
    getAttribute(k) { return this.attributes[k]; }
    contains(el) { return this === el || this.children.some(c => c.contains(el)); }
    querySelectorAll(selector) {
      const found = [];
      for (const child of this.children) {
        if (selector === 'button[title="Print"]' && child.title === 'Print') found.push(child);
        found.push(...child.querySelectorAll(selector));
      }
      return found;
    }
    getClientRects() { return [{}]; }
    addEventListener(name, cb) { this.handlers[name] = cb; }
    click() { this.handlers.click({ preventDefault() {}, stopPropagation() {} }); }
  }
  const header = new Element();
  const tags = new Element();
  header.appendChild(tags);
  let row = new Element();
  row.style.flexWrap = '';
  header.appendChild(row);
  const toolbar = new Element();
  const split = new Element();
  const nativePrint = new Element();
  nativePrint.title = 'Print';
  row.appendChild(toolbar);
  toolbar.appendChild(split);
  split.appendChild(nativePrint);
  const anchor = new Element();
  anchor.setAttribute('data-testid', 'addLabelBtnOrder-order-a');
  tags.appendChild(anchor);
  const document = {
    createElement: () => new Element(),
    querySelectorAll: () => [anchor],
    getElementById: id => row.children.find(e => e.id === id),
  };
  let context = { provider: 'shopmonkey', shopId: 'shop-a', roId: 'order-a' };
  let time = 100;
  const requests = [];
  const controller = create({ document, now: () => time, getContext: () => context,
    send: (msg, callback) => requests.push({ msg, callback }) });
  return { controller, requests, document, anchor, toolbar, nativePrint,
    row: () => row,
    group: () => document.getElementById('mos-shopmonkey-actions'),
    context: value => { context = value; },
    tick: ms => { time += ms; },
    replaceRow: () => {
      row.remove();
      row = new Element();
      row.style.flexWrap = '';
      header.appendChild(row);
      toolbar.remove();
      row.appendChild(toolbar);
    },
  };
}
const allowed = { success: true, floatingButtonEnabled: true, features: { oil_sticker: true } };

test('injects a full-width row below native Print without moving native controls', () => {
  const f = fixture();
  f.controller.update();
  assert.equal(f.group(), undefined);
  f.requests[0].callback(allowed);
  assert.deepEqual(f.group().children.slice(0, 2).map(e => e.textContent), ['Detect Dog', 'Print']);
  const group = f.group();
  assert.deepEqual(f.row().children, [f.toolbar, group]);
  assert.equal(f.row().style.flexWrap, 'wrap');
  assert.match(group.style.cssText, /flex:0 0 100%/);
  assert.equal(f.nativePrint.parentElement.parentElement, f.toolbar);
  f.controller.update();
  assert.equal(f.group(), group);
  group.children[0].click();
  assert.equal(f.requests[1].msg.action, 'OPEN_SIDE_PANEL');
  group.children[1].click();
  assert.equal(f.requests[2].msg.action, 'OPEN_STICKER_PANEL');
  assert.equal(f.requests[2].msg.context.roId, 'order-a');
  assert.equal(f.requests.some(r => /PRINT_STICKER|CREATE.*JOB/.test(r.msg.action)), false);
  f.replaceRow();
  f.controller.update();
  assert.ok(f.group());
  assert.notEqual(f.group(), group);
});

test('unknown/disabled settings and hidden Print preference do not expose buttons', () => {
  const f = fixture();
  f.controller.update();
  f.requests[0].callback({ success: false });
  assert.equal(f.group(), undefined);
  f.controller.invalidate();
  f.requests[1].callback({ ...allowed, floatingButtonEnabled: false,
    buttonVisibility: { shopmonkey: { oil_sticker: false } } });
  assert.equal(f.group(), undefined);
  assert.equal(f.row().style.flexWrap, '');
});

test('late settings and detached clicks cannot target another order or shop', () => {
  const f = fixture();
  f.controller.update();
  const first = f.requests[0];
  f.context({ provider: 'shopmonkey', shopId: 'shop-b', roId: 'order-b' });
  f.controller.update();
  first.callback(allowed);
  assert.equal(f.group(), undefined);
  assert.equal(f.requests.length, 1); // no matching order-b anchor
  f.anchor.setAttribute('data-testid', 'addLabelBtnOrder-order-b');
  f.controller.update();
  f.requests[1].callback(allowed);
  const oldButton = f.group().children[1];
  f.context({ provider: 'shopmonkey', shopId: 'shop-c', roId: 'order-b' });
  oldButton.click();
  assert.equal(f.requests.filter(r => r.msg.action === 'OPEN_STICKER_PANEL').length, 0);
});

test('expired settings fail closed during retry; hung requests can retry', () => {
  const f = fixture();
  f.controller.update();
  f.requests[0].callback(allowed);
  f.tick(30001);
  f.controller.update();
  assert.equal(f.group(), undefined);
  f.controller.update();
  assert.equal(f.group(), undefined);
  f.tick(10001);
  f.controller.update();
  assert.equal(f.requests.length, 3);
  f.requests[1].callback(allowed);
  assert.equal(f.group(), undefined);
  f.requests[2].callback(allowed);
  assert.ok(f.group());
});
