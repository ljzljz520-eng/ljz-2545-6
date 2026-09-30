'use strict';
/**
 * 存储层：观察记录、公共注意（只读公共信息）、个人集合点的版本化合并。
 *
 * 合并纪律（需求核心）：
 * - 个人集合点离线编辑做字段级三路合并(base/server/client)，两台设备改不同点互不覆盖；
 * - 公共注意(notices) 是独立资源，只走专门的维护接口；集合同步路径【绝不】写入/覆盖 notices。
 * - 删除用墓碑合并：一端删除、另一端修改同一点时报冲突，而不是静默复活或静默丢失。
 */
const crypto = require('crypto');

function emptyCollection() {
  return {
    name: '我的夜跑集合',
    points: {},
    favorites: {},
    tombstones: {},
  };
}

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 字段级三路合并。
 * base/server/client 均为文档形态：{ name, points:{id->rec}, favorites:{id->rec}, tombstones:{id->true} }
 * 返回 { doc, conflicts:[{field, server, client, kind}] }
 */
function threeWayMerge(base, server, client, preferClient = false) {
  base = base || emptyCollection();
  server = server || emptyCollection();
  client = client || emptyCollection();
  const conflicts = [];

  // 1) 标量字段（preferClient=true 表示用户已显式决定：冲突字段取客户端值，仍记录在 conflicts）
  const name = mergeScalar('name', base.name, server.name, client.name, conflicts, preferClient);

  // 2) 键控集合（points / favorites）
  const result = { name, points: {}, favorites: {}, tombstones: {} };
  for (const key of ['points', 'favorites']) {
    const ids = new Set([
      ...Object.keys(base[key] || {}),
      ...Object.keys(server[key] || {}),
      ...Object.keys(client[key] || {}),
      ...Object.keys(base.tombstones || {}),
      ...Object.keys(server.tombstones || {}),
      ...Object.keys(client.tombstones || {}),
    ]);
    for (const id of ids) {
      const b = (base[key] || {})[id];
      const s = (server[key] || {})[id];
      const c = (client[key] || {})[id];
      const sDel = !!(server.tombstones || {})[id];
      const cDel = !!(client.tombstones || {})[id];
      const bDel = !!(base.tombstones || {})[id];

      if (sDel && cDel) continue;                 // 两端都删
      if (sDel && !cDel) {
        if (!bDel && c && !shallowEqual(b, c)) {
          // 服务端删除、客户端修改 -> 冲突；默认保留客户端（修改优先于陌生人删除），记录冲突
          conflicts.push({ field: key + '.' + id, kind: 'server-delete-client-edit' });
          result[key][id] = withRev(c);
        }
        // 否则跟随删除
        continue;
      }
      if (cDel && !sDel) {
        if (!bDel && s && !shallowEqual(b, s)) {
          conflicts.push({ field: key + '.' + id, kind: 'client-delete-server-edit' });
          result[key][id] = withRev(s);
        }
        continue;
      }
      if (sDel || cDel) continue;

      if (!s && c) { result[key][id] = withRev(c); continue; } // 客户端新增
      if (!c && s) { result[key][id] = s; continue; }          // 服务端新增
      if (!s && !c) continue;
      result[key][id] = mergeRecord(key + '.' + id, b || {}, s, c, conflicts, preferClient);
    }
  }
  return { doc: stripMeta(result), conflicts };
}

function mergeScalar(field, b, s, c, conflicts, preferClient = false) {
  if (s === c) return s === undefined ? b : s;
  if (s === b) return c;
  if (c === b) return s;
  conflicts.push({ field, kind: 'both-edited', server: s, client: c });
  return preferClient ? c : s;
}

function mergeRecord(path, b, s, c, conflicts, preferClient = false) {
  const out = { ...s };
  const fields = new Set([...Object.keys(s), ...Object.keys(c)]);
  for (const f of fields) {
    if (f === '_rev' || f === 'updatedAt') continue;
    const bv = b[f], sv = s[f], cv = c[f];
    if (sv === cv) out[f] = sv;
    else if (sv === bv) out[f] = cv;
    else if (cv === bv) out[f] = sv;
    else {
      // 嵌套坐标对象按分量再做一次标量三路合并
      if (isObject(sv) && isObject(cv) && isObject(bv || {})) {
        const sub = {};
        for (const sf of new Set([...Object.keys(sv), ...Object.keys(cv)])) {
          const x = bv[sf], y = sv[sf], z = cv[sf];
          if (y === z) sub[sf] = y;
          else if (y === x) sub[sf] = z;
          else if (z === x) sub[sf] = y;
          else {
            conflicts.push({ field: path + '.' + f + '.' + sf, kind: 'both-edited', server: y, client: z });
            sub[sf] = preferClient ? z : y;
          }
        }
        out[f] = sub;
      } else {
        conflicts.push({ field: path + '.' + f, kind: 'both-edited', server: sv, client: cv });
        out[f] = preferClient ? cv : sv;
      }
    }
  }
  return withRev(out);
}

function withRev(rec) {
  return { ...rec, _rev: (rec._rev || 0) + 1 };
}

function shallowEqual(a, b) {
  if (!isObject(a) || !isObject(b)) return a === b;
  const ka = Object.keys(a).filter((k) => k !== '_rev' && k !== 'updatedAt');
  const kb = Object.keys(b).filter((k) => k !== '_rev' && k !== 'updatedAt');
  if (ka.length !== kb.length) return false;
  return ka.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));
}

/** 输出前清理内部字段（墓碑在服务端保留为真实墓碑，随 doc 下发供下一轮 base） */
function stripMeta(doc) {
  return doc;
}

function createStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS observations (
      id TEXT PRIMARY KEY, route_id TEXT, kind TEXT, status TEXT,
      coverage REAL, cum_start REAL, cum_end REAL,
      night_visit INTEGER, photo TEXT, visited_at TEXT,
      observer TEXT, comment TEXT, created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS notices (
      id TEXT PRIMARY KEY, route_id TEXT, kind TEXT, text TEXT,
      at_x REAL, at_y REAL, updated_at TEXT, updated_by TEXT, version INTEGER
    );
    CREATE TABLE IF NOT EXISTS collection_revs (
      user_id TEXT NOT NULL, rev INTEGER NOT NULL, doc TEXT NOT NULL,
      created_at TEXT, PRIMARY KEY(user_id, rev)
    );
    CREATE TABLE IF NOT EXISTS collection_meta (
      user_id TEXT PRIMARY KEY, head_rev INTEGER, base_doc TEXT
    );
  `);

  function seed(seedData, nowIso) {
    const insObs = db.prepare(`INSERT OR IGNORE INTO observations
      (id,route_id,kind,status,coverage,cum_start,cum_end,night_visit,photo,visited_at,observer,comment,created_at)
      VALUES (@id,@route_id,@kind,@status,@coverage,@cum_start,@cum_end,@night_visit,@photo,@visited_at,@observer,@comment,@created_at)`);
    const insNotice = db.prepare(`INSERT OR IGNORE INTO notices
      (id,route_id,kind,text,at_x,at_y,updated_at,updated_by,version)
      VALUES (@id,@route_id,@kind,@text,@at_x,@at_y,@updated_at,@updated_by,@version)`);
    const tx = db.transaction(() => {
      for (const o of seedData.observations) {
        insObs.run({
          id: o.id, route_id: o.routeId, kind: o.kind, status: o.status,
          coverage: o.coverage, cum_start: o.cumStart, cum_end: o.cumEnd,
          night_visit: o.nightVisit ? 1 : 0, photo: o.photo,
          visited_at: o.visitedAt, observer: o.observer, comment: o.comment || '',
          created_at: nowIso,
        });
      }
      for (const n of seedData.notices) {
        insNotice.run({
          id: n.id, route_id: n.routeId, kind: n.kind, text: n.text,
          at_x: n.at ? n.at.x : null, at_y: n.at ? n.at.y : null,
          updated_at: n.updatedAt, updated_by: n.updatedBy, version: 1,
        });
      }
    });
    tx();
  }

  // ---- observations ----
  function listObservations(routeId) {
    const rows = routeId
      ? db.prepare('SELECT * FROM observations WHERE route_id=? ORDER BY visited_at DESC').all(routeId)
      : db.prepare('SELECT * FROM observations ORDER BY visited_at DESC').all();
    return rows.map(rowToObs);
  }

  function addObservation(o, nowIso) {
    const id = o.id || ('O' + crypto.randomBytes(4).toString('hex'));
    db.prepare(`INSERT INTO observations
      (id,route_id,kind,status,coverage,cum_start,cum_end,night_visit,photo,visited_at,observer,comment,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, o.routeId, o.kind || 'lighting', o.status,
      o.coverage == null ? null : o.coverage, o.cumStart, o.cumEnd,
      o.nightVisit ? 1 : 0, o.photo || (o.nightVisit ? 'night' : 'day'),
      o.visitedAt, o.observer || 'anonymous', o.comment || '', nowIso);
    return getObservation(id);
  }

  function getObservation(id) {
    const r = db.prepare('SELECT * FROM observations WHERE id=?').get(id);
    return r ? rowToObs(r) : null;
  }

  function rowToObs(r) {
    return {
      id: r.id, routeId: r.route_id, kind: r.kind, status: r.status,
      coverage: r.coverage, cumStart: r.cum_start, cumEnd: r.cum_end,
      nightVisit: !!r.night_visit, photo: r.photo, visitedAt: r.visited_at,
      observer: r.observer, comment: r.comment, createdAt: r.created_at,
    };
  }

  // ---- notices（公共注意，独立维护，永不被集合同步触碰）----
  function listNotices(routeId) {
    const rows = routeId
      ? db.prepare('SELECT * FROM notices WHERE route_id=? ORDER BY updated_at DESC').all(routeId)
      : db.prepare('SELECT * FROM notices ORDER BY updated_at DESC').all();
    return rows.map(rowToNotice);
  }

  function updateNotice(id, patch, nowIso) {
    const cur = db.prepare('SELECT * FROM notices WHERE id=?').get(id);
    if (!cur) return null;
    const next = {
      text: patch.text != null ? patch.text : cur.text,
      kind: patch.kind != null ? patch.kind : cur.kind,
    };
    db.prepare('UPDATE notices SET text=?, kind=?, updated_at=?, updated_by=?, version=? WHERE id=?')
      .run(next.text, next.kind, nowIso, patch.updatedBy || cur.updated_by, cur.version + 1, id);
    return rowToNotice(db.prepare('SELECT * FROM notices WHERE id=?').get(id));
  }

  function rowToNotice(r) {
    return {
      id: r.id, routeId: r.route_id, kind: r.kind, text: r.text,
      at: r.at_x == null ? null : { x: r.at_x, y: r.at_y },
      updatedAt: r.updated_at, updatedBy: r.updated_by, version: r.version,
    };
  }

  // ---- collections：版本化三路合并 ----
  function getHead(userId) {
    const meta = db.prepare('SELECT * FROM collection_meta WHERE user_id=?').get(userId);
    if (!meta) return { rev: 0, doc: emptyCollection() };
    return { rev: meta.head_rev, doc: JSON.parse(db.prepare('SELECT doc FROM collection_revs WHERE user_id=? AND rev=?').get(userId, meta.head_rev).doc) };
  }

  function saveHead(userId, doc, nowIso) {
    const head = getHead(userId);
    const rev = head.rev + 1;
    db.prepare('INSERT INTO collection_revs(user_id,rev,doc,created_at) VALUES (?,?,?,?)')
      .run(userId, rev, JSON.stringify(doc), nowIso);
    db.prepare(`INSERT INTO collection_meta(user_id,head_rev,base_doc) VALUES (?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET head_rev=excluded.head_rev`)
      .run(userId, rev, JSON.stringify(doc));
    return rev;
  }

  function getBase(userId, rev) {
    if (!rev || rev === 0) return emptyCollection();
    const row = db.prepare('SELECT doc FROM collection_revs WHERE user_id=? AND rev=?').get(userId, rev);
    return row ? JSON.parse(row.doc) : null;
  }

  function syncCollection(userId, payload, nowIso) {
    const head = getHead(userId);
    const baseRev = payload.baseRev || 0;
    const base = getBase(userId, baseRev);
    if (base === null) {
      return { status: 409, error: 'base-revision-unknown', headRev: head.rev, head: head.doc };
    }
    const { doc: merged, conflicts } = threeWayMerge(base, head.doc, payload.doc || {}, !!payload.force);
    if (conflicts.length && !payload.force) {
      return { status: 409, error: 'merge-conflict', conflicts, headRev: head.rev, head: head.doc, mergedPreview: merged };
    }
    const rev = saveHead(userId, merged, nowIso);
    return { status: 200, rev, doc: merged, conflictsResolved: conflicts.length ? conflicts : [] };
  }

  /** 测试用：历史版本检视（观察版本/集合版本可核查） */
  function listCollectionRevs(userId) {
    return db.prepare('SELECT rev, created_at FROM collection_revs WHERE user_id=? ORDER BY rev').all(userId);
  }

  function reset() {
    db.exec('DELETE FROM observations; DELETE FROM notices; DELETE FROM collection_revs; DELETE FROM collection_meta;');
  }

  return {
    seed, reset,
    listObservations, addObservation, getObservation,
    listNotices, updateNotice,
    getHead, saveHead, syncCollection, listCollectionRevs, getBase,
    threeWayMerge,
  };
}

module.exports = { createStore, threeWayMerge, emptyCollection };
