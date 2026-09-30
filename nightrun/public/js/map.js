/* map.js — 无依赖 SVG 地图。绘制 simplified 或 full 几何，但不据其计算任何指标。 */
(function () {
  'use strict';
  const G = window.NRGeo;

  // 经纬度 → SVG 视口（保持比例）
  // 根据几何包围盒（米）计算紧凑画幅：等比缩放 + 居中，短轴用最小画幅避免扁线撑满空白。
  // 注意：这是纯展示变换；指标与判定全部来自服务端原几何。
  function fitFrame(coordsList, maxW, maxH, pad) {
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const cs of coordsList) for (const [lon, lat] of cs) {
      if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
    }
    const midLat = (minLat + maxLat) / 2 * Math.PI / 180;
    const sxM = Math.max(1, (maxLon - minLon) * Math.cos(midLat) * 111320);
    const syM = Math.max(1, (maxLat - minLat) * 111320);
    const aspect = sxM / syM;
    // 宽线（滨河路）→ 扁画幅；纵线/环线 → 较高画幅；高随宽高比连续变化
    const maxWUsed = maxW;
    let h = Math.max(110, Math.min(300, maxWUsed / Math.max(aspect, 1)));
    if (aspect < 1) h = Math.min(300, maxWUsed / aspect); // 纵向路线
    const w = maxWUsed;
    const scale = Math.min((w - pad * 2) / sxM, (h - pad * 2) / syM);
    const drawW = sxM * scale, drawH = syM * scale;
    const ox = (w - drawW) / 2, oy = (h - drawH) / 2;
    return {
      w, h,
      project(lon, lat) {
        const x = ox + (lon - minLon) * Math.cos(midLat) * 111320 * scale;
        const y = h - (oy + (lat - minLat) * 111320 * scale);
        return [x, y];
      },
    };
  }

  function el(tag, attrs) {
    const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
    return n;
  }

  function pathD(coords, pr) {
    return coords.map((c, i) => {
      const [x, y] = pr.project(c[0], c[1]);
      return (i ? 'L' : 'M') + x.toFixed(1) + ',' + y.toFixed(1);
    }).join('');
  }

  /* render(svg, layers)
   * layers: { routes:[{id,color,coords,simplified,width?}], points:[{lon,lat,kind,label,id}] }
   */
  function render(svg, layers, opts) {
    opts = opts || {};
    const maxW = opts.width || svg.clientWidth || 340;
    const useSimplified = opts.simplified !== false;
    const all = (layers.routes || []).map(r => useSimplified && r.simplified ? r.simplified : r.coords);
    if (!all.length) return;
    const frame = fitFrame(all, maxW, opts.maxHeight || 320, 22);
    const w = frame.w, h = frame.h;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.style.height = 'auto';
    svg.innerHTML = '';
    const pr = frame;
    svg._project = pr;

    // 网格底色（河带示意）
    svg.appendChild(el('rect', { x: 0, y: 0, width: w, height: h, fill: '#0f1626' }));

    for (const r of layers.routes || []) {
      const geom = useSimplified && r.simplified ? r.simplified : r.coords;
      // 底光
      svg.appendChild(el('path', {
        d: pathD(geom, pr), fill: 'none', stroke: r.color || '#5ad1ff',
        'stroke-width': (r.width || 4) + 3, 'stroke-linecap': 'round',
        'stroke-linejoin': 'round', opacity: 0.18,
      }));
      const pth = el('path', {
        d: pathD(geom, pr), fill: 'none', stroke: r.color || '#5ad1ff',
        'stroke-width': r.width || 4, 'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      });
      pth.setAttribute('data-route', r.id || '');
      if (r.label) {
        pth.setAttribute('tabindex', '0');
        pth.setAttribute('role', 'img');
        pth.setAttribute('aria-label', r.label);
      }
      svg.appendChild(pth);
    }

    const icon = { crossing: ['#ffd166', '×'], supply: ['#4ade80', '◆'], meeting: ['#ff7b7b', '●'], exit: ['#c084fc', '▼'], user: ['#ffffff', '◎'] };
    for (const pt of layers.points || []) {
      const [x, y] = pr.project(pt.lon, pt.lat);
      const [color, ch] = icon[pt.kind] || ['#9fb3d1', '•'];
      const g = el('g', { tabindex: pt.label ? '0' : '-1', role: pt.label ? 'img' : undefined, 'aria-label': pt.label || '' });
      g.appendChild(el('circle', { cx: x, cy: y, r: pt.kind === 'user' ? 9 : 7, fill: color, opacity: 0.25 }));
      const t = el('text', { x, y: y + 4, 'text-anchor': 'middle', 'font-size': 12, fill: color });
      t.textContent = ch;
      g.appendChild(t);
      if (pt.label) {
      const lbl = el('text', { x: x + 10, y: y + 3, 'font-size': 10, fill: '#dbe7ff' });
      lbl.textContent = pt.label; g.appendChild(lbl);
      }
      g.dataset.pointId = pt.id || '';
      svg.appendChild(g);
    }
  }

  window.NRMap = { render };
})();
