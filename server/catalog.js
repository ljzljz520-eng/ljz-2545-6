'use strict';
/**
 * 路线目录：从种子原几何派生所有空间事实。
 * 关键纪律：距离 / 坡度 / 交叉点 / 退出点都在 densify 后的【原几何】上计算；
 * simplify 后的几何只随接口附带（geometryDisplay），供前端缩放展示，绝不回传参与判断。
 */
const G = require('./geometry');

const SEG_M = 100; // 预先分段索引的分段长度

function pointInRect(p, r) {
  return p.x >= r.minX && p.x <= r.maxX && p.y >= r.minY && p.y <= r.maxY;
}

function buildCatalog(seed) {
  const routes = new Map();

  for (const r of seed.routes) {
    const points = G.densify(r.vertices, G.DENSIFY_STEP_M);
    for (const p of points) {
      p.bridge = (r.bridgeMarks || []).some((m) => pointInRect(p, m));
    }
    const lengthM = G.polylineLength(points);
    const segments = G.splitFixed(points, SEG_M);
    routes.set(r.id, {
      id: r.id,
      name: r.name,
      status: r.status || 'active',
      archivedAt: r.archivedAt || null,
      supersededBy: r.supersededBy || null,
      surface: r.surface || '',
      closed: !!r.closed,
      vertices: r.vertices,
      points,
      lengthM,
      gradeMax: G.maxGrade(points, 50),
      bounds: G.bbox(points, 0),
      segments,
      supplyIds: r.supplyIds || [],
      crossings: [],
      exits: [],
    });
  }

  // 交叉点（跨路线）：逐对原几何求交
  const ids = [...routes.keys()];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const A = routes.get(ids[i]);
      const B = routes.get(ids[j]);
      if (!G.bboxesOverlap(A.bounds, B.bounds)) continue;
      const ab = G.polylineCrossings(A.points, B.points);
      for (const h of ab) {
        A.crossings.push({ routeId: B.id, x: h.x, y: h.y, atM: h.atM });
        const ba = G.nearestOnPolyline({ x: h.x, y: h.y }, B.points);
        B.crossings.push({ routeId: A.id, x: h.x, y: h.y, atM: ba.atM });
      }
    }
  }

  // 退出点：把补给点投影到路线原几何（<=150m 才算关联）
  for (const s of seed.supplies) {
    for (const r of seed.routes) {
      if (!r.supplyIds.includes(s.id)) continue;
      const cat = routes.get(r.id);
      const near = G.nearestOnPolyline(s, cat.points);
      if (near.d <= 150) {
        cat.exits.push({
          id: 'exit-' + r.id + '-' + s.id,
          supplyId: s.id,
          name: s.name,
          atM: Math.round(near.atM),
          dM: Math.round(near.d),
          x: near.x,
          y: near.y,
        });
      }
    }
  }

  const supplies = new Map(seed.supplies.map((s) => [s.id, s]));
  return {
    city: seed.city,
    river: seed.river,
    bridges: seed.bridges,
    supplies,
    routes,
    /** 仅用于渲染的简化线（容差 18m），标注“不得用于判断” */
    displayGeometry(routeId) {
      const cat = routes.get(routeId);
      return G.simplify(cat.points, 18).map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
    },
  };
}

module.exports = { buildCatalog, SEG_M };
