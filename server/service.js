'use strict';
/**
 * API 服务层：筛选 = 距离 + 坡度 + 照明观察 + 补给时段的组合；
 * 空间查询提供 index / realtime 两模式并回传耗时，供“预先分段索引 vs 实时空间求交”比较。
 */
const crypto = require('crypto');
const G = require('./geometry');
const OBS = require('./observations');
const spatial = require('./spatial-db');

function parseNow(url) {
  const t = url.searchParams.get('now');
  if (t) {
    const d = new Date(t);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

function createService({ catalog, store, spatialDb }) {
  const etags = new Map(); // routeId -> 数据指纹（观察/注意变化时变）

  function routeEtag(routeId) {
    const obs = store.listObservations(routeId);
    const notices = store.listNotices(routeId);
    const h = crypto.createHash('sha1');
    h.update(JSON.stringify({ routeId, v: 2, obs: obs.map((o) => [o.id, o.visitedAt, o.status]), notices: notices.map((n) => [n.id, n.version, n.updatedAt]) }));
    return '"' + h.digest('hex').slice(0, 16) + '"';
  }

  function routeSummary(routeId, now) {
    const cat = catalog.routes.get(routeId);
    if (!cat) return null;
    const obs = store.listObservations(routeId);
    const notices = store.listNotices(routeId);
    const light = OBS.lightingSummary(cat.lengthM, obs, now);
    const exits = OBS.supplyWindow(cat.exits, catalog.supplies, now);
    return {
      id: cat.id,
      name: cat.name,
      status: cat.status,
      archivedAt: cat.archivedAt,
      supersededBy: cat.supersededBy,
      surface: cat.surface,
      closed: cat.closed,
      lengthM: Math.round(cat.lengthM),
      gradeMaxPct: Math.round(cat.gradeMax * 1000) / 10,
      crossingCount: cat.crossings.length,
      lighting: light,
      supplies: exits,
      notices,
      etag: routeEtag(routeId),
    };
  }

  function listRoutes(query, now) {
    const maxKm = query.get('maxKm') ? Number(query.get('maxKm')) : null;
    const maxGradePct = query.get('maxGradePct') != null && query.get('maxGradePct') !== '' ? Number(query.get('maxGradePct')) : null;
    const lit = query.get('lit') === '1';
    const litThreshold = query.get('litThreshold') ? Number(query.get('litThreshold')) : 0.8;
    const supplyNow = query.get('supplyNow') === '1';
    const includeArchived = query.get('includeArchived') === '1';

    const rows = [];
    for (const id of catalog.routes.keys()) {
      const s = routeSummary(id, now);
      const cat = catalog.routes.get(id);
      const passes = {
        archived: includeArchived || s.status === 'active',
        distance: maxKm == null || s.lengthM / 1000 <= maxKm,
        grade: maxGradePct == null || s.gradeMaxPct <= maxGradePct,
        // 亮灯比例达阈值，且没有未解决冲突段（冲突不隐藏，只是不满足“照明良好”筛选）
        lighting: !lit || (s.lighting.litRatio >= litThreshold && !s.lighting.hasConflict),
        supply: !supplyNow || s.supplies.some((x) => x.openNow),
      };
      s.match = Object.values(passes).every(Boolean);
      s.passes = passes;
      // 展示几何：简化线，明确标注用途
      s.geometryDisplay = catalog.displayGeometry(id);
      s.geometryDisplayRole = 'render-only';
      void cat;
      rows.push(s);
    }
    // 排序：匹配优先，然后亮灯比例降序、距离升序
    rows.sort((a, b) => (Number(b.match) - Number(a.match)) || (b.lighting.litRatio - a.lighting.litRatio) || (a.lengthM - b.lengthM));
    return rows;
  }

  function getRoute(id, now, ifNoneMatch) {
    if (!catalog.routes.has(id)) return { status: 404 };
    const etag = routeEtag(id);
    if (ifNoneMatch === etag) return { status: 304, etag };
    const cat = catalog.routes.get(id);
    const s = routeSummary(id, now);
    s.points = cat.points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z * 10) / 10, bridge: !!p.bridge }));
    s.pointsRole = 'original-densified-authoritative';
    s.geometryDisplay = catalog.displayGeometry(id);
    s.geometryDisplayRole = 'render-only-do-not-recompute';
    s.crossings = cat.crossings;
    s.observations = store.listObservations(id);
    return { status: 200, body: s, etag };
  }

  /**
   * 空间查询：半径内路线分段。
   * mode=index 走 SQLite 网格索引；mode=realtime 全量遍历原几何。
   * 两种模式都以 nearestOnPolyline 的原几何距离为最终判定，结果应一致。
   */
  function spatialQuery(body) {
    const now = body.now ? new Date(body.now) : new Date();
    const x = Number(body.x), y = Number(body.y), r = Number(body.radius || 200);
    const routeFilter = Array.isArray(body.routeIds) && body.routeIds.length ? new Set(body.routeIds) : null;
    const results = [];

    if (body.mode === 'realtime') {
      const t0 = process.hrtime.bigint();
      let edgesScanned = 0;
      for (const cat of catalog.routes.values()) {
        if (routeFilter && !routeFilter.has(cat.id)) continue;
        edgesScanned += cat.points.length - 1;
        const near = G.nearestOnPolyline({ x, y }, cat.points);
        if (near.d <= r) {
          results.push({ routeId: cat.id, distanceM: Math.round(near.d * 10) / 10, atM: Math.round(near.atM), x: near.x, y: near.y, bridge: !!cat.points[near.edgeIndex].bridge });
        }
      }
      const us = Number(process.hrtime.bigint() - t0) / 1000;
      return { mode: 'realtime', results: results.sort((a, b) => a.distanceM - b.distanceM || a.atM - b.atM), timing: { microseconds: Math.round(us), edgesScanned, strategy: 'full-scan-densified-original' } };
    }

    // index
    const t0 = process.hrtime.bigint();
    const cells = spatial.cellListForRadius(x, y, r);
    const placeholders = cells.map(() => '(?,?)').join(',');
    const flat = cells.flat();
    const candidateRows = spatialDb.prepare(
      `SELECT DISTINCT route_id, seg_index FROM seg_grid WHERE (gx,gy) IN (${placeholders})`
    ).all(...flat);
    let edgesScanned = 0;
    const seen = new Set();
    const byRoute = new Map();
    for (const row of candidateRows) {
      if (routeFilter && !routeFilter.has(row.route_id)) continue;
      const key = row.route_id + ':' + row.seg_index;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!byRoute.has(row.route_id)) byRoute.set(row.route_id, []);
      byRoute.get(row.route_id).push(row.seg_index);
    }
    // 候选段按连续性分组（连续段共享边界点，可拼成一段原几何切片）；
    // 不连续的段之间不能人为连成折线，否则“跳跃边”会产生假最近点。
    for (const [routeId, segIndexes] of byRoute) {
      const cat = catalog.routes.get(routeId);
      segIndexes.sort((u, v) => u - v);
      const groups = [];
      let cur = [];
      for (const si of segIndexes) {
        if (cur.length && si !== cur[cur.length - 1] + 1) { groups.push(cur); cur = []; }
        cur.push(si);
      }
      if (cur.length) groups.push(cur);

      for (const group of groups) {
        const pts = [];
        let offsetM = null;
        for (const si of group) {
          const seg = cat.segments[si];
          if (offsetM === null) offsetM = seg.cumStart;
          const from = pts.length ? 1 : 0;
          for (let k = from; k < seg.points.length; k++) pts.push(seg.points[k]);
          edgesScanned += seg.points.length - 1;
        }
        const near = G.nearestOnPolyline({ x, y }, pts);
        if (near.d <= r) {
          results.push({
            routeId,
            distanceM: Math.round(near.d * 10) / 10,
            atM: Math.round(offsetM + near.atM),
            x: near.x, y: near.y,
            bridge: !!pts[near.edgeIndex].bridge,
          });
        }
      }
    }
    // 与 realtime 语义对齐：每条路线只保留一个全局最近点（平局取里程最小）
    const bestByRoute = new Map();
    for (const hit of results) {
      const cur = bestByRoute.get(hit.routeId);
      if (!cur || hit.distanceM < cur.distanceM || (hit.distanceM === cur.distanceM && hit.atM < cur.atM)) {
        bestByRoute.set(hit.routeId, hit);
      }
    }
    const finalResults = [...bestByRoute.values()];
    const us = Number(process.hrtime.bigint() - t0) / 1000;
    return {
      mode: 'index',
      results: finalResults.sort((a, b) => a.distanceM - b.distanceM || a.atM - b.atM),
      timing: {
        microseconds: Math.round(us),
        gridCells: cells.length,
        candidateSegments: candidateRows.length,
        edgesScanned,
        strategy: 'grid-250m + fixed-100m segments merged, exact distance on original geometry',
      },
    };
  }

  /** 跨桥感知的 GPS 吸附（提示定位） */
  function snap(body) {
    const x = Number(body.x), y = Number(body.y);
    const accuracy = Number(body.accuracy || 15);
    const routeIds = Array.isArray(body.routeIds) ? body.routeIds : [...catalog.routes.keys()];
    const radius = Number(body.radius || 120);
    const candidates = routeIds
      .map((id) => catalog.routes.get(id))
      .filter(Boolean)
      .filter((cat) => G.bboxesOverlap(cat.bounds, { minX: x - radius, minY: y - radius, maxX: x + radius, maxY: y + radius }))
      .map((cat) => ({ routeId: cat.id, points: cat.points, cumBefore: 0 }));
    const res = G.snapToRoutes({ x, y }, candidates, catalog.river.ring, { accuracy, maxSnap: body.maxSnap || (30 + accuracy * 2) });
    if (res.match) {
      res.match.distanceM = Math.round(res.match.d * 10) / 10;
      res.match.atM = Math.round(res.match.atM);
      delete res.match.d;
    }
    return res;
  }

  function addObservation(body, now) {
    if (!body.routeId || !catalog.routes.has(body.routeId)) return { status: 400, error: 'unknown-route' };
    if (!body.visitedAt) return { status: 400, error: 'visitedAt-required' };
    if (body.kind === 'lighting' && body.photo === 'day') {
      // 允许记录，但强制夜访标记为 false，服务端不信任“白天=夜间亮”
      body.nightVisit = false;
    }
    const saved = store.addObservation({ ...body, kind: body.kind || 'lighting' }, now.toISOString());
    etags.delete(body.routeId);
    return { status: 201, body: saved };
  }

  return {
    listRoutes, getRoute, spatialQuery, snap,
    addObservation,
    listObservations: (routeId) => store.listObservations(routeId),
    listNotices: (routeId) => store.listNotices(routeId),
    updateNotice: (id, patch, now) => {
      const n = store.updateNotice(id, patch, now.toISOString());
      return n ? { status: 200, body: n } : { status: 404 };
    },
    syncCollection: (userId, payload, now) => store.syncCollection(userId, payload, now.toISOString()),
    getCollection: (userId) => store.getHead(userId),
    listCollectionRevs: (userId) => store.listCollectionRevs(userId),
    parseNow,
    catalog,
  };
}

module.exports = { createService };
