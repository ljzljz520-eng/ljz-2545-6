/*
 * db.js — 空间数据库层（SQLite + R*Tree）。
 *
 * 管理：
 *  - 路线原几何、几何版本(geom_version)、自然分段(segments)与固定里程分段索引(chunks)；
 *  - 观察版本(obs_version)：照明观察是不可变记录 + 版本号，前端据此发现冲突/过期；
 *  - 公共注意信息(notices) 与个人集合(collections)：合并路径完全分离。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const geo = require('./geo');

const CHUNK_M = 100; // 预分段粒度

let _db = null;

function connect(file) {
  if (_db) return _db;
  if (file && file !== ':memory:' && !file.startsWith('file:')) {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  _db = db;
  init(db);
  return db;
}

function init(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);

  CREATE TABLE IF NOT EXISTS routes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    surface TEXT,
    status TEXT NOT NULL DEFAULT 'active', -- active | deprecated
    replaces TEXT,                          -- 新线路指向旧线路 id
    length_m REAL NOT NULL,
    ascent_m REAL, max_slope REAL,
    crossings INTEGER NOT NULL DEFAULT 0,
    geom_version INTEGER NOT NULL DEFAULT 1,
    obs_version INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    city_center TEXT
  );

  CREATE TABLE IF NOT EXISTS route_versions (
    route_id TEXT NOT NULL,
    geom_version INTEGER NOT NULL,
    coords_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    note TEXT,
    PRIMARY KEY(route_id, geom_version)
  );

  CREATE TABLE IF NOT EXISTS segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    route_id TEXT NOT NULL,
    geom_version INTEGER NOT NULL,
    seg_index INTEGER NOT NULL,
    station_from REAL NOT NULL,
    station_to REAL NOT NULL,
    coords_json TEXT NOT NULL,
    UNIQUE(route_id, geom_version, seg_index)
  );

  -- 预分段空间索引：固定 100 m 的块 + R*Tree 包围盒
  CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    route_id TEXT NOT NULL,
    geom_version INTEGER NOT NULL,
    chunk_index INTEGER NOT NULL,
    station_from REAL NOT NULL,
    station_to REAL NOT NULL
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS chunks_rtree USING rtree(
    id, minLon, maxLon, minLat, maxLat
  );

  -- 交叉点全部由原几何两两计算后物化（几何版本变更即重算）
  CREATE TABLE IF NOT EXISTS crossings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    route_a TEXT NOT NULL, geom_va INTEGER NOT NULL,
    route_b TEXT NOT NULL, geom_vb INTEGER NOT NULL,
    station_a REAL NOT NULL, station_b REAL NOT NULL,
    lon REAL NOT NULL, lat REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    route_id TEXT NOT NULL,
    geom_version INTEGER NOT NULL,
    obs_version INTEGER NOT NULL,
    source TEXT NOT NULL,            -- night_visit | day_photo | report
    lit INTEGER,                     -- 1 点亮 / 0 未点亮 / NULL 仅存在
    cov_from REAL NOT NULL,
    cov_to REAL NOT NULL,
    observed_at INTEGER NOT NULL,
    schedule_json TEXT,
    observer TEXT,
    note TEXT,
    supersedes INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS supplies (
    id TEXT PRIMARY KEY,
    route_id TEXT,
    lon REAL NOT NULL, lat REAL NOT NULL,
    kind TEXT NOT NULL,              -- water | shop | toilet
    name TEXT NOT NULL,
    windows_json TEXT NOT NULL,
    station_m REAL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notices (
    id TEXT PRIMARY KEY,
    route_id TEXT,
    message TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'info', -- info | warning
    geom_version INTEGER, obs_version INTEGER,
    updated_at INTEGER NOT NULL
  );

  -- 个人集合（收藏/集合点/退出点）。每个可编辑字段带独立时间戳，
  -- 两设备同时编辑时按字段合并，绝不互相整体覆盖。
  CREATE TABLE IF NOT EXISTS collections (
    user_id TEXT NOT NULL,
    route_id TEXT NOT NULL,
    saved_at INTEGER,
    saved_at_ts INTEGER NOT NULL DEFAULT 0,
    meeting_lon REAL, meeting_lat REAL, meeting_label TEXT,
    meeting_ts INTEGER NOT NULL DEFAULT 0,
    exit_station REAL,
    exit_ts INTEGER NOT NULL DEFAULT 0,
    note TEXT, note_ts INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0,
    deleted_ts INTEGER NOT NULL DEFAULT 0,
    base_geom_version INTEGER,
    base_obs_version INTEGER,
    client_id TEXT,
    updated_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(user_id, route_id)
  );

  CREATE INDEX IF NOT EXISTS idx_segments ON segments(route_id, geom_version);
  CREATE INDEX IF NOT EXISTS idx_obs ON observations(route_id, geom_version);
  CREATE INDEX IF NOT EXISTS idx_chunks ON chunks(route_id, geom_version);
  `);
}

function getMeta(k) {
  const row = _db.prepare('SELECT value FROM meta WHERE key=?').get(k);
  return row ? row.value : null;
}
function setMeta(k, v) {
  _db.prepare(`INSERT INTO meta(key,value) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(k, v);
}

function cityCenter() {
  const raw = getMeta('city_center');
  return raw ? JSON.parse(raw) : { lon: 120.2, lat: 30.25 };
}

function proj() {
  const c = cityCenter();
  return geo.projector(c.lon, c.lat);
}

/* ---------------- 路线写入（带几何版本 + 重建索引） ---------------- */

const insertRoute = () => _db.prepare(`INSERT INTO routes
  (id,name,surface,status,replaces,length_m,ascent_m,max_slope,crossings,
   geom_version,obs_version,updated_at,city_center)
  VALUES (@id,@name,@surface,@status,@replaces,@length_m,@ascent_m,@max_slope,
   @crossings,@geom_version,0,@updated_at,@city_center)`);

function upsertRouteVersion(r, coords, note) {
  const db = _db;
  const now = Date.now();
  const P = proj();
  const len = geo.polylineLength(coords);
  const sp = geo.slopeProfile(coords);
  const old = db.prepare('SELECT geom_version FROM routes WHERE id=?').get(r.id);
  const gv = old ? old.geom_version + 1 : 1;
  const bb = geo.bbox(coords);
  const cc = JSON.stringify(cityCenter());

  const tx = db.transaction(() => {
    if (old) {
      db.prepare(`UPDATE routes SET name=@name,surface=@surface,status=@status,replaces=@replaces,
        length_m=@length_m,ascent_m=@ascent_m,max_slope=@max_slope,geom_version=@geom_version,
        updated_at=@updated_at,city_center=@city_center WHERE id=@id`).run({
        id: r.id, name: r.name, surface: r.surface || 'mixed',
        status: r.status || 'active', replaces: r.replaces || null,
        length_m: len, ascent_m: sp.ascent, max_slope: sp.maxSlope,
        geom_version: gv, updated_at: now, city_center: cc,
      });
    } else {
      insertRoute().run({
        id: r.id, name: r.name, surface: r.surface || 'mixed',
        status: r.status || 'active', replaces: r.replaces || null,
        length_m: len, ascent_m: sp.ascent, max_slope: sp.maxSlope, crossings: 0,
        geom_version: gv, updated_at: now, city_center: cc,
      });
    }
    db.prepare(`INSERT INTO route_versions(route_id,geom_version,coords_json,created_at,note)
      VALUES(?,?,?,?,?)`).run(r.id, gv, JSON.stringify(coords), now, note || (old ? '几何更新' : '初始版本'));

    // 重建自然分段与固定里程分段（几何升版：清掉该路线所有旧版本的索引，避免孤儿）
    db.prepare('DELETE FROM chunks_rtree WHERE id IN (SELECT id FROM chunks WHERE route_id=?)').run(r.id);
    db.prepare('DELETE FROM chunks WHERE route_id=?').run(r.id);
    db.prepare('DELETE FROM segments WHERE route_id=? AND geom_version=?').run(r.id, gv);
    const natural = r.segments && r.segments.length
      ? splitByNatural(coords, r.segments)
      : [{ from: 0, to: len, pts: coords.map(c => P.project(c[0], c[1])) }];
    natural.forEach((seg, i) => {
      db.prepare(`INSERT INTO segments(route_id,geom_version,seg_index,station_from,station_to,coords_json)
        VALUES(?,?,?,?,?,?)`).run(r.id, gv, i, seg.from, seg.to,
        JSON.stringify(seg.pts.map(p => P.unproject(p[0], p[1]))));
    });
    const chunks = geo.chunkByStation(coords, P, CHUNK_M);
    const insC = db.prepare(`INSERT INTO chunks(route_id,geom_version,chunk_index,station_from,station_to)
      VALUES(?,?,?,?,?)`);
    const insR = db.prepare('INSERT INTO chunks_rtree(id,minLon,maxLon,minLat,maxLat) VALUES(?,?,?,?,?)');
    chunks.forEach((ch, i) => {
      const info = insC.run(r.id, gv, i, ch.from, ch.to);
      const ll = ch.pts.map(p => P.unproject(p[0], p[1]));
      const b = geo.bbox(ll);
      insR.run(info.lastInsertRowid, b.minLon, b.maxLon, b.minLat, b.maxLat);
    });
  });
  tx();
  return { geomVersion: gv, length_m: len, bbox: bb };
}

// 自然分段：按给出的桩号切点（如桥头/桥尾）
function splitByNatural(coords, cuts) {
  const P = proj();
  const p = coords.map(c => P.project(c[0], c[1]));
  const cum = [0];
  for (let i = 1; i < p.length; i++) cum[i] = cum[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  const bounds = [0, ...cuts.slice().sort((a, b) => a - b), cum[cum.length - 1]];
  return bounds.slice(0, -1).map((from, i) => {
    const to = bounds[i + 1];
    const pts = [];
    for (let k = 0; k < p.length; k++) {
      if (cum[k] >= from - 1e-6 && cum[k] <= to + 1e-6) pts.push(p[k]);
      if (cum[k] > to) break;
    }
    if (pts[0] === undefined || geo.pointSegMeter) { /* noop */ }
    return { from, to, pts: pts.length ? pts : [p[0]] };
  });
}

function rebuildAllCrossings() {
  const db = _db;
  db.prepare('DELETE FROM crossings').run();
  const rs = db.prepare('SELECT id, geom_version FROM routes').all();
  const getCoords = (id, gv) => JSON.parse(db.prepare(
    'SELECT coords_json c FROM route_versions WHERE route_id=? AND geom_version=?').get(id, gv).c);
  const ins = db.prepare(`INSERT INTO crossings
    (route_a,geom_va,route_b,geom_vb,station_a,station_b,lon,lat)
    VALUES(?,?,?,?,?,?,?,?)`);
  const P = proj();
  const upd = db.prepare('UPDATE routes SET crossings=? WHERE id=?');
  const counts = {};
  const tx = db.transaction(() => {
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
      const A = rs[i], B = rs[j];
      const xs = geo.polylineCrossings(getCoords(A.id, A.geom_version), getCoords(B.id, B.geom_version), P);
      for (const x of xs) {
        ins.run(A.id, A.geom_version, B.id, B.geom_version, x.stationA, x.stationB, x.lon, x.lat);
        counts[A.id] = (counts[A.id] || 0) + 1;
        counts[B.id] = (counts[B.id] || 0) + 1;
      }
    }
    for (const r of rs) upd.run(counts[r.id] || 0, r.id);
  });
  tx();
}

/* ---------------- 观察写入（不可变 + obs_version） ---------------- */

function addObservation(o) {
  const db = _db;
  const route = db.prepare('SELECT geom_version, obs_version FROM routes WHERE id=?').get(o.routeId);
  if (!route) throw new Error('route not found: ' + o.routeId);
  const gv = route.geom_version;
  const nv = route.obs_version + 1;
  const info = db.prepare(`INSERT INTO observations
    (route_id,geom_version,obs_version,source,lit,cov_from,cov_to,observed_at,
     schedule_json,observer,note,supersedes,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    o.routeId, gv, nv, o.source,
    o.lit === undefined || o.lit === null ? null : (o.lit ? 1 : 0),
    o.covFrom, o.covTo, o.observedAt,
    o.schedule ? JSON.stringify(o.schedule) : null,
    o.observer || null, o.note || null, o.supersedes || null, Date.now());
  db.prepare('UPDATE routes SET obs_version=? WHERE id=?').run(nv, o.routeId);
  return db.prepare('SELECT * FROM observations WHERE id=?').get(info.lastInsertRowid);
}

function observationsFor(routeId, geomVersion) {
  const rows = _db.prepare(`SELECT * FROM observations WHERE route_id=? AND geom_version=?
    ORDER BY obs_version`).all(routeId, geomVersion);
  return rows.map(r => ({
    id: r.id, source: r.source, lit: r.lit == null ? null : !!r.lit,
    covFrom: r.cov_from, covTo: r.cov_to, observedAt: r.observed_at,
    schedule: r.schedule_json ? JSON.parse(r.schedule_json) : null,
    observer: r.observer, note: r.note, obsVersion: r.obs_version,
    supersedes: r.supersedes, createdAt: r.created_at,
  }));
}

/* ---------------- 读取 ---------------- */

function getRoute(id) { return _db.prepare('SELECT * FROM routes WHERE id=?').get(id); }
function allRoutes(includeDeprecated) {
  return _db.prepare(includeDeprecated
    ? 'SELECT * FROM routes ORDER BY id'
    : "SELECT * FROM routes WHERE status='active' ORDER BY id").all();
}
function coords(id, gv) {
  const row = _db.prepare(
    'SELECT coords_json c FROM route_versions WHERE route_id=? AND geom_version=?').get(id, gv);
  return row ? JSON.parse(row.c) : null;
}
function latestCoords(id) {
  const r = getRoute(id);
  return r ? coords(id, r.geom_version) : null;
}
function crossingsFor(routeId) {
  return _db.prepare(`SELECT * FROM crossings WHERE route_a=? OR route_b=?`).all(routeId, routeId);
}
function suppliesFor(routeId) {
  return _db.prepare('SELECT * FROM supplies WHERE route_id=? ORDER BY station_m').all(routeId)
    .map(s => ({ ...s, windows: JSON.parse(s.windows_json) }));
}
function noticesFor(routeId) {
  return _db.prepare('SELECT * FROM notices WHERE route_id=? ORDER BY updated_at DESC').all(routeId);
}
function putNotice(n) {
  _db.prepare(`INSERT INTO notices(id,route_id,message,severity,geom_version,obs_version,updated_at)
    VALUES(@id,@route_id,@message,@severity,@geom_version,@obs_version,@updated_at)
    ON CONFLICT(id) DO UPDATE SET message=excluded.message,severity=excluded.severity,
      geom_version=excluded.geom_version,obs_version=excluded.obs_version,updated_at=excluded.updated_at`)
    .run(n);
}
function putSupply(s) {
  _db.prepare(`INSERT INTO supplies(id,route_id,lon,lat,kind,name,windows_json,station_m,updated_at)
    VALUES(@id,@route_id,@lon,@lat,@kind,@name,@windows_json,@station_m,@updated_at)
    ON CONFLICT(id) DO UPDATE SET lon=excluded.lon,lat=excluded.lat,kind=excluded.kind,
      name=excluded.name,windows_json=excluded.windows_json,station_m=excluded.station_m,
      updated_at=excluded.updated_at`).run(s);
}

/* ---------------- 两种空间求交策略 ---------------- */

// A：预分段索引（chunks R*Tree 命中 → 候选路线）。
// 只取当前 geom_version 且 status='active'，保证与实时策略候选集合语义一致。
function candidatesPreIndexed(lon, lat, pad, opts) {
  const includeDeprecated = opts && opts.includeDeprecated;
  const rows = _db.prepare(`SELECT DISTINCT c.route_id, c.geom_version
    FROM chunks_rtree r
    JOIN chunks c ON c.id = r.id
    JOIN routes rt ON rt.id = c.route_id AND rt.geom_version = c.geom_version
    WHERE r.minLon <= ? AND r.maxLon >= ? AND r.minLat <= ? AND r.maxLat >= ?
      ${includeDeprecated ? '' : "AND rt.status = 'active'"}`)
    .all(lon + pad, lon - pad, lat + pad, lat - pad);
  return rows;
}

// B：实时空间求交（直接对全部当前原几何逐段投影，无索引）
function candidatesRealtime(lon, lat, maxDist, P) {
  const routes = allRoutes(false);
  const hits = [];
  for (const r of routes) {
    const cs = coords(r.id, r.geom_version);
    const hit = geo.projectToPolyline(lon, lat, cs, P);
    if (hit.distance <= maxDist) hits.push({ route_id: r.id, geom_version: r.geom_version, hit });
  }
  return hits;
}

/* ---------------- 个人集合：字段级合并 ---------------- */

const FIELDS = [
  ['saved_at', 'saved_at_ts'],
  ['meeting_lon', 'meeting_ts'], ['meeting_lat', 'meeting_ts'], ['meeting_label', 'meeting_ts'],
  ['exit_station', 'exit_ts'],
  ['note', 'note_ts'],
];

/*
 * mergeCollection：个人集合点离线编辑与服务端状态合并。
 * 规则：逐字段比较时间戳，新者胜；删除用墓碑(deleted/deleted_ts)。
 * 不触碰 notices（公共注意信息走另一条只读通道）。
 */
function mergeCollection(userId, routeId, incomingRaw) {
  const db = _db;
  const now = Date.now();
  // 归一化：字段出现但缺时间戳时兜底（PUT/批量同步共用此入口）
  const incoming = { ...incomingRaw };
  const ensureTs = (fields, tsKey) => {
    if (fields.some(f => incoming[f] !== undefined) && incoming[tsKey] == null) incoming[tsKey] = now;
  };
  ensureTs(['saved_at'], 'saved_at_ts');
  ensureTs(['meeting_lon', 'meeting_lat', 'meeting_label'], 'meeting_ts');
  ensureTs(['exit_station'], 'exit_ts');
  ensureTs(['note'], 'note_ts');
  if (incoming.deleted !== undefined && incoming.deleted_ts == null) incoming.deleted_ts = now;
  const cur = db.prepare('SELECT * FROM collections WHERE user_id=? AND route_id=?').get(userId, routeId);
  const base = cur || {
    user_id: userId, route_id: routeId,
    saved_at: null, saved_at_ts: 0,
    meeting_lon: null, meeting_lat: null, meeting_label: null, meeting_ts: 0,
    exit_station: null, exit_ts: 0,
    note: null, note_ts: 0,
    deleted: 0, deleted_ts: 0,
    base_geom_version: incoming.base_geom_version ?? null,
    base_obs_version: incoming.base_obs_version ?? null,
    client_id: incoming.client_id ?? null,
  };
  const merged = { ...base };
  function pick(col, key, tsKey) {
    if (incoming[key] === undefined) return;
    const incTs = incoming[tsKey] || now;
    const curVal = cur ? cur[key] : null;
    const curTs = cur ? (cur[tsKey] || 0) : 0;
    // 目标字段服务端尚无值（两设备改不同字段）→ 直接采纳；否则按字段时间戳新者胜
    if ((curVal === null || curVal === undefined) || incTs >= curTs) {
      merged[key] = incoming[key];
      merged[tsKey] = incTs;
    }
  }
  pick(null, 'saved_at', 'saved_at_ts');
  pick(null, 'meeting_lon', 'meeting_ts');
  pick(null, 'meeting_lat', 'meeting_ts');
  pick(null, 'meeting_label', 'meeting_ts');
  pick(null, 'exit_station', 'exit_ts');
  pick(null, 'note', 'note_ts');
  if (incoming.deleted !== undefined &&
      (incoming.deleted_ts || 0) >= (cur ? (cur.deleted_ts || 0) : 0)) {
    merged.deleted = incoming.deleted ? 1 : 0;
    merged.deleted_ts = incoming.deleted_ts || now;
  }
  merged.updated_at = now;
  if (incoming.base_geom_version != null) merged.base_geom_version = incoming.base_geom_version;
  if (incoming.base_obs_version != null) merged.base_obs_version = incoming.base_obs_version;

  db.prepare(`INSERT INTO collections
    (user_id,route_id,saved_at,saved_at_ts,meeting_lon,meeting_lat,meeting_label,meeting_ts,
     exit_station,exit_ts,note,note_ts,deleted,deleted_ts,base_geom_version,base_obs_version,
     client_id,updated_at)
    VALUES (@user_id,@route_id,@saved_at,@saved_at_ts,@meeting_lon,@meeting_lat,@meeting_label,
     @meeting_ts,@exit_station,@exit_ts,@note,@note_ts,@deleted,@deleted_ts,
     @base_geom_version,@base_obs_version,@client_id,@updated_at)
    ON CONFLICT(user_id,route_id) DO UPDATE SET
     saved_at=excluded.saved_at, saved_at_ts=excluded.saved_at_ts,
     meeting_lon=excluded.meeting_lon, meeting_lat=excluded.meeting_lat,
     meeting_label=excluded.meeting_label, meeting_ts=excluded.meeting_ts,
     exit_station=excluded.exit_station, exit_ts=excluded.exit_ts,
     note=excluded.note, note_ts=excluded.note_ts,
     deleted=excluded.deleted, deleted_ts=excluded.deleted_ts,
     base_geom_version=excluded.base_geom_version, base_obs_version=excluded.base_obs_version,
     client_id=excluded.client_id, updated_at=excluded.updated_at`).run(merged);
  return getCollection(userId, routeId);
}

function getCollection(userId, routeId) {
  return _db.prepare('SELECT * FROM collections WHERE user_id=? AND route_id=?').get(userId, routeId);
}
function listCollections(userId) {
  return _db.prepare('SELECT * FROM collections WHERE user_id=? AND deleted=0 ORDER BY saved_at_ts DESC').all(userId);
}

/* ---------------- 批量同步（多条目 outbox 重放） ---------------- */

function syncCollections(userId, items, clientId) {
  const results = [], conflicts = [];
  const tx = _db.transaction(() => {
    for (const it of items) {
      const before = getCollection(userId, it.route_id);
      const after = mergeCollection(userId, it.route_id, { ...it, client_id: clientId });
      results.push(after);
      // 冲突：服务端该字段已有值，且传入值时间戳更旧 → 丢弃并回报
      if (before) {
        const dropped = [];
        for (const [k, ts] of FIELDS) {
          if (it[k] !== undefined && before[k] !== null && (it[ts] || 0) < (before[ts] || 0)) dropped.push(k);
        }
        if (it.deleted !== undefined && before.deleted === 1 &&
            (it.deleted_ts || 0) < (before.deleted_ts || 0)) dropped.push('deleted');
        if (dropped.length) conflicts.push({ route_id: it.route_id, dropped, server: before });
      }
    }
  });
  tx();
  return { results, conflicts };
}

function resetForTest(seeder) {
  if (_db) { try { _db.close(); } catch {} _db = null; }
  connect(':memory:');
  if (seeder) seeder();
  return _db;
}

function setCityCenter(c) { setMeta('city_center', JSON.stringify(c)); }
function raw() { return _db; }

module.exports = {
  connect, init, resetForTest, raw, setMeta, getMeta, setCityCenter, cityCenter, proj,
  upsertRouteVersion, rebuildAllCrossings,
  addObservation, observationsFor,
  getRoute, allRoutes, coords, latestCoords, crossingsFor,
  suppliesFor, noticesFor, putNotice, putSupply,
  candidatesPreIndexed, candidatesRealtime,
  mergeCollection, getCollection, listCollections, syncCollections,
  CHUNK_M,
};
