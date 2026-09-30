/*
 * api.js — 夜跑城市 API。
 * 距离/坡度/交叉/照明/补给全部在服务端从【原几何 + 观察版本】计算，
 * 客户端只展示，不在缩放或简化后的几何上重新判定。
 */
'use strict';
const express = require('express');
// db/geo 通过 createApi({db,geo}) 注入，避免循环依赖

function createApi(deps) {
  const D = deps.db;
  const G = deps.geo;
  const router = express.Router();
  router.use(express.json({ limit: '1mb' }));

  function nowMs(q) {
    const t = q && q.now ? Number(q.now) : NaN;
    return Number.isFinite(t) && t > 0 ? t : Date.now();
  }
  function userId(req) {
    return req.header('x-user-id') || (req.body && req.body.userId) || 'anon';
  }

  // 单条路线的完整判定视图
  function routeView(r, now, opts) {
    opts = opts || {};
    const coords = D.coords(r.id, r.geom_version);
    const obs = D.observationsFor(r.id, r.geom_version);
    const lighting = G.evaluateLighting(r.length_m, obs, now);
    const supplies = D.suppliesFor(r.id).map(s => {
      const o = G.supplyOpen(s.windows, now);
      return {
        id: s.id, kind: s.kind, name: s.name,
        lon: s.lon, lat: s.lat, station_m: s.station_m,
        open: o.open, openReason: o.reason, windows: s.windows,
      };
    });
    const view = {
      id: r.id, name: r.name, surface: r.surface, status: r.status,
      replaces: r.replaces,
      length_m: r.length_m, ascent_m: r.ascent_m, max_slope: r.max_slope,
      crossings_count: r.crossings,
      geom_version: r.geom_version, obs_version: r.obs_version,
      updated_at: r.updated_at,
      lighting: {
        status: lighting.status,
        lit_coverage: lighting.litCoverage,
        conflict_ranges: lighting.conflictRanges,
        stale: lighting.stale,
        observed_at_latest: lighting.observedAtLatest,
        day_photo_only: lighting.dayPhotoOnly.map(d => ({
          cov_from: d.from, cov_to: d.to, observed_at: d.observedAt, note: d.note,
        })),
        evidence: lighting.evidence.map(e => ({
          source: e.source, lit: e.lit, cov_from: e.from, cov_to: e.to,
          observed_at: e.observedAt, in_window: e.inWindow, stale: e.stale,
          observer: e.observer, note: e.note,
        })),
      },
      supplies_open_now: supplies.filter(s => s.open).length,
      supplies,
    };
    if (opts.withGeom) {
      view.coords = coords;
      const tol = opts.tolerance == null ? 25 : Number(opts.tolerance);
      view.coords_simplified = G.douglasPeucker(coords, tol, D.proj());
      const P = D.proj();
      view.crossings = D.crossingsFor(r.id).map(x => {
        const otherId = x.route_a === r.id ? x.route_b : x.route_a;
        return {
          other_route: otherId,
          station: x.route_a === r.id ? x.station_a : x.station_b,
          lon: x.lon, lat: x.lat,
        };
      }).sort((a, b) => a.station - b.station);
      view.notices = D.noticesFor(r.id);
      // 自然分段
      view.segments = D.raw().prepare(
        'SELECT seg_index,station_from,station_to FROM segments WHERE route_id=? AND geom_version=? ORDER BY seg_index')
        .all(r.id, r.geom_version);
    }
    return view;
  }

  /* GET /api/routes — 移动首页：筛选为主角 */
  router.get('/routes', (req, res) => {
    const q = req.query;
    const now = nowMs(q);
    const includeDeprecated = q.include_deprecated === '1' || q.include_deprecated === 'true';
    let rows = D.allRoutes(includeDeprecated);

    const maxDist = q.max_dist ? Number(q.max_dist) : Infinity;
    const maxSlope = q.max_slope != null && q.max_slope !== '' ? Number(q.max_slope) / 100 : Infinity;
    const wantLight = (q.lighting || 'any'); // any|lit|partial|dark|unknown|conflict
    const supplyKind = q.supply_kind || null;
    const needOpen = q.supply_open === '1' || q.supply_open === 'true';
    const origin = q.lon != null && q.lat != null
      ? { lon: Number(q.lon), lat: Number(q.lat) } : null;
    const originMax = q.near_max ? Number(q.near_max) : null;
    const P = D.proj();

    const out = [];
    for (const r of rows) {
      const v = routeView(r, now);
      if (r.length_m > maxDist) continue;
      if (r.max_slope != null && r.max_slope > maxSlope) continue;
      if (wantLight !== 'any' && v.lighting.status !== wantLight) continue;
      if (supplyKind) {
        const hit = v.supplies.find(s => s.kind === supplyKind);
        if (!hit) continue;
        if (needOpen && !hit.open) continue;
      } else if (needOpen && v.supplies_open_now === 0) continue;
      if (origin) {
        const cs = D.coords(r.id, r.geom_version);
        v.distance_to_route = G.projectToPolyline(origin.lon, origin.lat, cs, P).distance;
        if (originMax != null && v.distance_to_route > originMax) continue;
      }
      out.push(v);
    }
    if (origin) out.sort((a, b) => a.distance_to_route - b.distance_to_route);
    else out.sort((a, b) => b.lighting.lit_coverage - a.lighting.lit_coverage || a.length_m - b.length_m);

    res.json({
      now,
      tz_offset_min: G.TZ_OFFSET_MIN,
      stale_after_days: Math.round(G.STALE_LIGHTING_MS / 86400000),
      count: out.length,
      routes: out,
    });
  });

  /* GET /api/routes/:id — 详情（原几何 + 简化展示线 + 交叉点 + 公共注意） */
  router.get('/routes/:id', (req, res) => {
    const r = D.getRoute(req.params.id);
    if (!r) return res.status(404).json({ error: 'not_found' });
    const now = nowMs(req.query);
    const tol = req.query.tolerance != null ? Number(req.query.tolerance) : 25;
    const v = routeView(r, now, { withGeom: true, tolerance: tol });
    res.json({ now, route: v });
  });

  /* GET /api/routes/:id/geometry?tolerance= — 只取几何，验证简化不改变判定 */
  router.get('/routes/:id/geometry', (req, res) => {
    const r = D.getRoute(req.params.id);
    if (!r) return res.status(404).json({ error: 'not_found' });
    const tol = req.query.tolerance != null ? Number(req.query.tolerance) : 25;
    const full = D.coords(r.id, r.geom_version);
    const simp = G.douglasPeucker(full, tol, D.proj());
    res.json({
      route_id: r.id, geom_version: r.geom_version,
      full, simplified: simp,
      full_length_m: G.polylineLength(full),
      simplified_length_m: G.polylineLength(simp),
      note: 'simplified 仅用于绘制；距离/坡度/交叉判定始终使用 full',
    });
  });

  /* POST /api/nearest — 提示定位：点 → 最近路线（原几何投影，跨桥正确） */
  router.post('/nearest', (req, res) => {
    const { lon, lat, max_distance = 1000 } = req.body || {};
    if (typeof lon !== 'number' || typeof lat !== 'number') {
      return res.status(400).json({ error: 'lon,lat required (numbers)' });
    }
    const now = nowMs(req.body);
    const P = D.proj();
    const hits = [];
    for (const r of D.allRoutes(false)) {
      const cs = D.coords(r.id, r.geom_version);
      const hit = G.projectToPolyline(lon, lat, cs, P);
      if (hit.distance <= max_distance) {
        hits.push({
          route_id: r.id, name: r.name,
          distance_m: hit.distance, station_m: hit.station,
          snapped_lon: hit.lon, snapped_lat: hit.lat,
          geom_version: r.geom_version,
        });
      }
    }
    hits.sort((a, b) => a.distance_m - b.distance_m);
    res.json({
      query: { lon, lat, max_distance }, now,
      nearest: hits[0] || null, candidates: hits,
      note: '投影在原几何逐段计算；跨桥时只会命中实际最近的桥面/岸线段',
    });
  });

  /* GET /api/hints — 定位提示 + 数据过期 + 版本状态 */
  router.get('/hints', (req, res) => {
    const now = nowMs(req.query);
    const routes = D.allRoutes(false);
    const stale = [];
    for (const r of routes) {
      const obs = D.observationsFor(r.id, r.geom_version);
      const ev = G.evaluateLighting(r.length_m, obs, now);
      if (ev.stale || ev.status === 'unknown') {
        stale.push({
          route_id: r.id, status: ev.status, stale: ev.stale,
          observed_at_latest: ev.observedAtLatest,
          day_photo_only: ev.dayPhotoOnly.length > 0,
        });
      }
    }
    res.json({
      now,
      stale_window_days: Math.round(G.STALE_LIGHTING_MS / 86400000),
      location_services: '/nearest 需要由客户端提供坐标；无定位权限时走手动入口',
      stale_routes: stale,
      versions: routes.map(r => ({
        route_id: r.id, geom_version: r.geom_version, obs_version: r.obs_version,
        updated_at: r.updated_at,
      })),
    });
  });

  /* POST /api/routes/:id/observations — 提交观察（夜间/白天严格区分） */
  router.post('/routes/:id/observations', (req, res) => {
    const r = D.getRoute(req.params.id);
    if (!r) return res.status(404).json({ error: 'not_found' });
    const b = req.body || {};
    if (!['night_visit', 'day_photo', 'report'].includes(b.source)) {
      return res.status(400).json({ error: 'source must be night_visit | day_photo | report' });
    }
    if (b.source === 'day_photo' && b.lit != null) {
      return res.status(422).json({ error: 'day_photo 不能声明夜间亮灯(lit 必须为空)' });
    }
    const len = r.length_m;
    const covFrom = Math.max(0, Number(b.cov_from || 0));
    const covTo = Math.min(len, Number(b.cov_to != null ? b.cov_to : len));
    if (!(covTo > covFrom)) return res.status(400).json({ error: 'bad coverage' });
    const row = D.addObservation({
      routeId: r.id, source: b.source,
      lit: b.lit === undefined || b.lit === null ? null : !!b.lit,
      covFrom, covTo,
      observedAt: Number(b.observed_at) || Date.now(),
      schedule: b.schedule || null, observer: b.observer, note: b.note,
    });
    res.status(201).json({
      id: row.id, route_id: row.route_id, geom_version: row.geom_version,
      obs_version: row.obs_version,
      warning: b.source === 'day_photo' ? '白天照片仅证明灯具存在，不作为夜间照明证据' : null,
    });
  });

  /* GET /api/spatial/benchmark — 预分段索引 vs 实时求交（结果必须一致） */
  router.get('/spatial/benchmark', (req, res) => {
    const q = req.query;
    const lon = q.lon != null ? Number(q.lon) : 120.214;
    const lat = q.lat != null ? Number(q.lat) : 30.25;
    const maxDist = q.max_distance != null ? Number(q.max_distance) : 2000;
    const P = D.proj();
    const padLon = maxDist / G.R_EARTH * G.R2D;
    const padLat = padLon / Math.cos(D.cityCenter().lat * Math.PI / 180);

    // A: R*Tree 预分段
    const t0 = process.hrtime.bigint();
    const cand = D.candidatesPreIndexed(lon, lat, Math.max(padLon, padLat));
    const preHits = [];
    for (const c of cand) {
      const cs = D.coords(c.route_id, c.geom_version);
      const hit = G.projectToPolyline(lon, lat, cs, P);
      if (hit.distance <= maxDist) {
        preHits.push({ route_id: c.route_id, geom_version: c.geom_version, distance_m: hit.distance, station_m: hit.station });
      }
    }
    const t1 = process.hrtime.bigint();

    // B: 实时全量原几何求交
    const real = D.candidatesRealtime(lon, lat, maxDist, P)
      .map(h => ({ route_id: h.route_id, geom_version: h.geom_version, distance_m: h.hit.distance, station_m: h.hit.station }));
    const t2 = process.hrtime.bigint();

    const key = h => h.route_id + '@' + h.geom_version;
    const ka = new Set(preHits.map(key)), kb = new Set(real.map(key));
    const same = ka.size === kb.size && [...ka].every(k => kb.has(k));
    res.json({
      query: { lon, lat, max_distance: maxDist },
      preindexed: {
        ms: Number(t1 - t0) / 1e6, candidates: cand.length, hits: preHits.sort((a, b) => a.distance_m - b.distance_m),
      },
      realtime: {
        ms: Number(t2 - t1) / 1e6, hits: real.sort((a, b) => a.distance_m - b.distance_m),
      },
      result_set_identical: same,
      chunk_m: D.CHUNK_M,
      note: '预分段索引快但需在几何版本变更时重建；实时求交无过期成本但 O(全部线段)。结果集一致才可切换。',
    });
  });

  /* ---- 个人集合：字段级合并（与公共路线/注意更新完全分开） ---- */

  function collectionToJson(c) {
    if (!c) return null;
    return {
      user_id: c.user_id, route_id: c.route_id,
      saved_at: c.saved_at, saved_at_ts: c.saved_at_ts,
      meeting: (c.meeting_lon == null) ? null : { lon: c.meeting_lon, lat: c.meeting_lat, label: c.meeting_label },
      meeting_ts: c.meeting_ts,
      exit_station: c.exit_station, exit_ts: c.exit_ts,
      note: c.note, note_ts: c.note_ts,
      deleted: !!c.deleted, deleted_ts: c.deleted_ts,
      base_geom_version: c.base_geom_version, base_obs_version: c.base_obs_version,
      client_id: c.client_id, updated_at: c.updated_at,
    };
  }

  router.get('/collections', (req, res) => {
    const uid = userId(req);
    const items = D.listCollections(uid).map(collectionToJson);
    // 附带公共侧当前版本，前端据此检测“收藏的旧线路已更新”，但不覆盖个人内容
    const enriched = items.map(it => {
      const r = D.getRoute(it.route_id);
      return {
        ...it,
        public: r ? {
          status: r.status, geom_version: r.geom_version, obs_version: r.obs_version,
          length_m: r.length_m, name: r.name,
        } : null,
      };
    });
    res.json({ user_id: uid, items: enriched });
  });

  // 把入参归一化为 mergeCollection 认识的扁平字段；未出现的字段不放入（部分更新）
  function normalizeIncoming(b, ts, clientId) {
    const incoming = { route_id: b.route_id, client_id: clientId !== undefined ? clientId : b.client_id };
    if (b.saved_at !== undefined) { incoming.saved_at = b.saved_at; incoming.saved_at_ts = b.saved_at_ts || ts; }
    if (b.meeting !== undefined) {
      incoming.meeting_lon = b.meeting ? b.meeting.lon : null;
      incoming.meeting_lat = b.meeting ? b.meeting.lat : null;
      incoming.meeting_label = b.meeting ? b.meeting.label : null;
      incoming.meeting_ts = b.meeting_ts || ts;
    }
    if (b.meeting_lon !== undefined) incoming.meeting_lon = b.meeting_lon;
    if (b.meeting_lat !== undefined) incoming.meeting_lat = b.meeting_lat;
    if (b.meeting_label !== undefined) incoming.meeting_label = b.meeting_label;
    if (b.meeting_ts != null && incoming.meeting_ts === undefined) incoming.meeting_ts = b.meeting_ts;
    if (b.exit_station !== undefined) { incoming.exit_station = b.exit_station; incoming.exit_ts = b.exit_ts || ts; }
    if (b.note !== undefined) { incoming.note = b.note; incoming.note_ts = b.note_ts || ts; }
    if (b.deleted !== undefined) { incoming.deleted = b.deleted ? 1 : 0; incoming.deleted_ts = b.deleted_ts || ts; }
    if (b.base_geom_version !== undefined) incoming.base_geom_version = b.base_geom_version;
    if (b.base_obs_version !== undefined) incoming.base_obs_version = b.base_obs_version;
    return incoming;
  }

  // 单条 upsert（字段级合并，部分更新）
  router.put('/collections/:routeId', (req, res) => {
    const uid = userId(req);
    const incoming = normalizeIncoming(req.body || {}, Date.now());
    const merged = D.mergeCollection(uid, req.params.routeId, incoming);
    res.json({ item: collectionToJson(merged), merged: true });
  });

  // 批量同步（网络恢复后重放 outbox）
  router.post('/collections/sync', (req, res) => {
    const uid = userId(req);
    const ts = Date.now();
    const clientId = req.body && req.body.client_id;
    const items = ((req.body && req.body.items) || []).map(b => normalizeIncoming(b, ts, clientId));
    const { results, conflicts } = D.syncCollections(uid, items, clientId);
    res.json({
      items: results.map(collectionToJson),
      conflicts: conflicts.map(c => ({
        route_id: c.route_id, dropped_fields: c.dropped,
        server_meeting: { lon: c.server.meeting_lon, lat: c.server.meeting_lat, label: c.server.meeting_label },
        server_note: c.server.note, server_exit: c.server.exit_station,
      })),
      note: '个人集合按字段时间戳合并；公共注意(notices)从不由此接口写入',
    });
  });

  /* GET /api/notices — 公共注意信息只读通道 */
  router.get('/notices', (req, res) => {
    const rows = D.raw().prepare('SELECT * FROM notices ORDER BY updated_at DESC').all();
    res.json({ notices: rows });
  });

  return router;
}

module.exports = { createApi };
