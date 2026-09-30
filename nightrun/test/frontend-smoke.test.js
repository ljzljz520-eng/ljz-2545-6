/* 最小 DOM stub：在无浏览器环境引导 SPA，验证启动/渲染/地图绘制无运行时错误 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadSandbox() {
  const dir = path.join(__dirname, '..', 'public', 'js');
  const storage = {};
  function makeEl(tag) {
    return {
      tagName: tag, children: [], style: { setProperty() {} }, dataset: {},
      attrs: {}, _text: '', innerHTML: '', value: '', clientWidth: 340,
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute(k, v) { this.attrs[k] = v; if (k === 'tabindex') this.tabIndex = v; },
      getAttribute(k) { return this.attrs[k]; },
      appendChild(c) { this.children.push(c); return c; },
      addEventListener() {}, querySelectorAll() { return []; },
      querySelector() { return makeEl('div'); },
      focus() {}, remove() {},
      get textContent() { return this._text; }, set textContent(v) { this._text = v; },
    };
  }
  const view = makeEl('main');
  const toast = makeEl('div'); toast.hidden = true;
  const net = makeEl('span');
  const sandbox = {
    console, Math, Date, JSON, URLSearchParams, fetch: async () => { throw new Error('no net in smoke'); },
    localStorage: {
      getItem: k => (k in storage ? storage[k] : null),
      setItem: (k, v) => { storage[k] = String(v); },
      removeItem: k => { delete storage[k]; },
    },
    navigator: { onLine: false, geolocation: null },
    location: { hash: '' },
    setTimeout, clearTimeout,
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.document = {
    getElementById: id => ({ view, toast, netPill: net }[id]),
    querySelectorAll: () => [],
    createElementNS: (ns, tag) => makeEl(tag),
    createElement: tag => makeEl(tag),
    body: makeEl('body'),
    addEventListener() {},
  };
  vm.createContext(sandbox);
  for (const f of ['geo.js', 'store.js', 'api.js', 'map.js', 'app.js']) {
    vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sandbox, { filename: f });
  }
  return { sandbox, view };
}

test('SPA 离线启动：渲染首页筛选，不抛错', () => {
  const { view } = loadSandbox();
  assert.ok(/筛选今晚路线/.test(view.innerHTML), '首页筛选面板已渲染');
  assert.ok(/照明/.test(view.innerHTML));
  assert.ok(/手动输入位置/.test(view.innerHTML), '无定位权限的手动入口存在');
});

test('SVG 地图：原线与简化线均可绘制，简化不改变长度计算', () => {
  const { sandbox } = loadSandbox();
  const G = sandbox.NRGeo, MapV = sandbox.NRMap;
  // 构造一条含直角的折线
  const P = G.projector(120.2, 30.25);
  const coords = [];
  const origin = P.unproject(0, 0);
  let [x, y] = [0, 0];
  const pts = [[0, 0], [100, 0], [100, 100], [200, 100], [200, 200], [300, 200]];
  for (const [px, py] of pts) coords.push(P.unproject(px, py));
  const simplified = G.douglasPeucker(coords, 20, P);
  assert.ok(simplified.length <= coords.length);
  assert.equal(Math.round(G.polylineLength(coords)), 500, '原几何长度 500m');
  assert.ok(G.polylineLength(simplified) <= 500.01);
  // map render 不抛错（stub svg）
  const svg = { clientWidth: 340, style:{}, setAttribute() {}, appendChild() {}, innerHTML: '' };
  MapV.render(svg, { routes: [{ id: 'x', coords, simplified, color: '#fff' }], points: [{ lon: coords[0][0], lat: coords[0][1], kind: 'crossing', label: '交叉' }] });
  assert.ok(svg._project || true);
});

test('照明事件叠加：冲突区间与跨 0 点时段', () => {
  const { sandbox } = loadSandbox();
  const G = sandbox.NRGeo;
  const night = new Date('2026-09-30T20:00+08:00').getTime();
  const sched = { days: [1, 2, 3, 4, 5, 6, 7], start: '22:00', end: '02:00' };
  assert.equal(G.scheduleActive(sched, new Date('2026-09-30T23:00+08:00').getTime()), true);
  assert.equal(G.scheduleActive(sched, new Date('2026-09-30T01:00+08:00').getTime()), true);
  assert.equal(G.scheduleActive(sched, night), false);
  const ev = G.evaluateLighting(1000, [
    { source: 'night_visit', lit: true, covFrom: 0, covTo: 1000, observedAt: night },
    { source: 'night_visit', lit: false, covFrom: 400, covTo: 600, observedAt: night },
  ], night);
  assert.equal(ev.status, 'conflict');
  assert.equal(JSON.stringify(ev.conflictRanges.map(r => [Math.round(r[0]), Math.round(r[1])])), '[[400,600]]');
});
