'use strict';
/* 极简 SVG 示意地图。
 * 重要纪律：地图只拿 geometryDisplay（简化线，render-only）画形状；
 * 任何距离/坡度标签来自服务端基于原几何的计算，前端不从 SVG 坐标反推距离。
 */
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  let cached = null; // {routes, transform, world}

  function worldBounds(routes, river) {
    let minX = -200, minY = -700, maxX = 2600, maxY = 950;
    if (river && river.ring) {
      minX = Math.min(minX, ...river.ring.map((p) => p.x));
      maxX = Math.max(maxX, ...river.ring.map((p) => p.x));
      minY = Math.min(minY, ...river.ring.map((p) => p.y));
      maxY = Math.max(maxY, ...river.ring.map((p) => p.y));
    }
    for (const r of routes) {
      for (const p of (r.geometryDisplay || [])) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
    }
    const pad = 60;
    return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
  }

  function makeTransform(b, w, h) {
    const sx = w / (b.maxX - b.minX);
    const sy = h / (b.maxY - b.minY);
    const s = Math.min(sx, sy);
    const ox = (w - (b.maxX - b.minX) * s) / 2 - b.minX * s;
    const oy = (h - (b.maxY - b.minY) * s) / 2 + b.maxY * s;
    return { s, ox, oy, X: (x) => ox + x * s, Y: (y) => oy - y * s };
  }

  function el(tag, attrs, parent) {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }

  function polyPath(points, t) {
    return points.map((p, i) => (i ? 'L' : 'M') + t.X(p.x).toFixed(1) + ',' + t.Y(p.y).toFixed(1)).join(' ');
  }

  function render(svg, payload, opts = {}) {
    const { routes, river, bridges, supplies } = payload;
    const rect = svg.getBoundingClientRect();
    const W = rect.width || 340;
    const H = rect.height || 320;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const b = worldBounds(routes, river);
    const t = makeTransform(b, W, H);
    cached = { routes, t };
    svg.innerHTML = '';

    // 河道
    if (river) {
      const pts = river.ring.map((p) => `${t.X(p.x).toFixed(1)},${t.Y(p.y).toFixed(1)}`).join(' ');
      el('polygon', { points: pts, fill: '#123a5e', opacity: '0.8' }, svg);
      el('text', { x: t.X(1200), y: t.Y(0) + 4, fill: '#7fb6e6', 'font-size': 11, 'text-anchor': 'middle' }, svg).textContent = '潼川';
    }
    // 桥
    for (const br of (bridges || [])) {
      const cx = br.deck.x;
      el('rect', {
        x: t.X(cx - 12 / 2), y: t.Y(br.rect.maxY),
        width: 12 * t.s, height: (br.rect.maxY - br.rect.minY) * t.s,
        fill: '#d8c98a', opacity: 0.85, rx: 2,
      }, svg);
      el('text', { x: t.X(cx), y: t.Y(br.rect.maxY) + 13, fill: '#e8dfb0', 'font-size': 9, 'text-anchor': 'middle' }, svg).textContent = br.name;
    }
    // 路线（简化几何）
    const palette = { R1: '#6ee7ff', R2: '#8be28b', R3: '#b79bff', R4: '#f6a96b', R5: '#7c88ad' };
    for (const r of routes) {
      const d = polyPath(r.geometryDisplay || [], t);
      el('path', {
        d, fill: 'none',
        stroke: opts.selectedId === r.id ? '#ffffff' : (palette[r.id] || '#9aa6cf'),
        'stroke-width': opts.selectedId === r.id ? 4 : 2.4,
        'stroke-linejoin': 'round', 'stroke-linecap': 'round',
        opacity: r.status === 'archived' ? 0.45 : 0.95,
        'stroke-dasharray': r.status === 'archived' ? '5 4' : undefined,
      }, svg);
      const first = (r.geometryDisplay || [])[0];
      if (first) el('text', { x: t.X(first.x) + 4, y: t.Y(first.y) - 4, fill: palette[r.id] || '#9aa6cf', 'font-size': 9.5 }, svg).textContent = r.name;
    }
    // 补给
    for (const s of (supplies || [])) {
      el('circle', { cx: t.X(s.x), cy: t.Y(s.y), r: 3.2, fill: s.openNow ? '#4ade80' : '#5a6385', stroke: '#0b1020' }, svg);
    }
    // 退出点
    if (opts.exits) for (const e of opts.exits) {
      el('circle', { cx: t.X(e.x), cy: t.Y(e.y), r: 3, fill: 'none', stroke: '#fbbf24', 'stroke-width': 1.4 }, svg);
    }
    // 定位点
    if (opts.loc) {
      el('circle', { cx: t.X(opts.loc.x), cy: t.Y(opts.loc.y), r: 7, fill: 'none', stroke: '#6ee7ff', 'stroke-width': 1.2, opacity: 0.6 }, svg);
      el('circle', { cx: t.X(opts.loc.x), cy: t.Y(opts.loc.y), r: 3.5, fill: '#6ee7ff' }, svg);
    }
    if (opts.matched) {
      el('circle', { cx: t.X(opts.matched.x), cy: t.Y(opts.matched.y), r: 5, fill: '#4ade80', stroke: '#06281a', 'stroke-width': 1.2 }, svg);
      el('line', {
        x1: t.X(opts.loc.x), y1: t.Y(opts.loc.y),
        x2: t.X(opts.matched.x), y2: t.Y(opts.matched.y),
        stroke: '#4ade80', 'stroke-dasharray': '3 3', 'stroke-width': 1,
      }, svg);
    }
    return cached;
  }

  function projectWorld(x, y) {
    if (!cached) return null;
    const { t } = cached;
    return { sx: t.X(x), sy: t.Y(y) };
  }

  window.NRMap = { render, projectWorld };
})();
