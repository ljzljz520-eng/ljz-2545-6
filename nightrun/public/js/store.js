/* store.js — 前端本地存储 + 离线 outbox + 字段级集合合并（与 server/db.js 同规则） */
(function () {
  'use strict';
  const K_UID = 'nr.uid';
  const K_COLL = 'nr.collections';
  const K_OUTBOX = 'nr.outbox';
  const K_CACHE = 'nr.cache';
  const K_VERS = 'nr.versions';
  const K_MANUAL = 'nr.manualLocation';

  function uid() {
    let u = localStorage.getItem(K_UID);
    if (!u) { u = 'u-' + Math.random().toString(36).slice(2, 10); localStorage.setItem(K_UID, u); }
    return u;
  }
  function read(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }
  function write(k, v) { localStorage.setItem(k, JSON.stringify(v)); }

  // 与服务端完全一致的字段级 LWW 合并（个人集合点离线编辑）
  const FIELDS = [
    ['saved_at', 'saved_at_ts'],
    ['meeting_lon', 'meeting_ts'], ['meeting_lat', 'meeting_ts'], ['meeting_label', 'meeting_ts'],
    ['exit_station', 'exit_ts'], ['note', 'note_ts'],
  ];
  function normalize(it) {
    return {
      user_id: it.user_id, route_id: it.route_id,
      saved_at: it.saved_at ?? null, saved_at_ts: it.saved_at_ts || 0,
      meeting_lon: it.meeting ? it.meeting.lon : (it.meeting_lon ?? null),
      meeting_lat: it.meeting ? it.meeting.lat : (it.meeting_lat ?? null),
      meeting_label: it.meeting ? (it.meeting.label ?? null) : (it.meeting_label ?? null),
      meeting_ts: it.meeting_ts || 0,
      exit_station: it.exit_station ?? null, exit_ts: it.exit_ts || 0,
      note: it.note ?? null, note_ts: it.note_ts || 0,
      deleted: it.deleted ? 1 : 0, deleted_ts: it.deleted_ts || 0,
      base_geom_version: it.base_geom_version ?? null, base_obs_version: it.base_obs_version ?? null,
      client_id: it.client_id || null,
    };
  }
  function mergeOne(localRaw, incomingRaw) {
    const local = normalize(localRaw);
    const inc = normalize(incomingRaw);
    const out = { ...local };
    for (const [f, ts] of FIELDS) {
      if (inc[f] !== null && inc[f] !== undefined && inc[ts] >= local[ts]) { out[f] = inc[f]; out[ts] = inc[ts]; }
    }
    if (inc.deleted_ts >= local.deleted_ts) { out.deleted = inc.deleted; out.deleted_ts = inc.deleted_ts; }
    if (inc.base_geom_version != null) out.base_geom_version = inc.base_geom_version;
    if (inc.base_obs_version != null) out.base_obs_version = inc.base_obs_version;
    return out;
  }

  const Store = {
    uid,
    getCollections() { return read(K_COLL, {}); },
    saveCollections(c) { write(K_COLL, c); },
    getCollection(routeId) { return this.getCollections()[routeId] || null; },
    // 本地编辑：打时间戳并入队
    localEdit(routeId, patch, base) {
      const all = this.getCollections();
      const now = Date.now();
      const cur = all[routeId] || { user_id: uid(), route_id: routeId };
      const inc = { ...cur, ...patch, client_id: 'local' };
      // 每个被编辑的字段组都打上本次时间戳（含退出点），保证 outbox 自描述
      if (patch.saved_at !== undefined && !inc.saved_at_ts) inc.saved_at_ts = now;
      if (patch.meeting !== undefined && !inc.meeting_ts) inc.meeting_ts = now;
      if (patch.exit_station !== undefined && !inc.exit_ts) inc.exit_ts = now;
      if (patch.note !== undefined && !inc.note_ts) inc.note_ts = now;
      if (patch.deleted !== undefined && !inc.deleted_ts) inc.deleted_ts = now;
      if (base) { inc.base_geom_version = base.geom_version; inc.base_obs_version = base.obs_version; }
      const merged = mergeOne(cur, inc);
      all[routeId] = merged;
      this.saveCollections(all);
      this.enqueue(merged);
      return merged;
    },
    enqueue(item) {
      const q = read(K_OUTBOX, []);
      q.push({ item: normalize(item), queued_at: Date.now() });
      write(K_OUTBOX, q);
    },
    outbox() { return read(K_OUTBOX, []); },
    clearOutbox() { write(K_OUTBOX, []); },

    // 网络恢复：批量同步，服务端返回权威值后再合并（双端都新的字段保留各自最新）
    async syncNow(api) {
      const q = this.outbox();
      if (!q.length) return { synced: 0, conflicts: [] };
      const resp = await api.syncCollections(q.map(x => x.item));
      const all = this.getCollections();
      // 服务端条目带嵌套 meeting，先归一化再按字段合并
      for (const srvRaw of resp.items) {
        const srv = normalize(srvRaw);
        all[srv.route_id] = mergeOne(all[srv.route_id] || srv, srv);
      }
      this.saveCollections(all);
      this.clearOutbox();
      return { synced: q.length, conflicts: resp.conflicts || [] };
    },

    // 拉取个人集合（服务端可能含另一设备的更新）
    async pullCollections(api) {
      const resp = await api.getCollections();
      const all = this.getCollections();
      for (const srvRaw of resp.items) {
        const srv = normalize(srvRaw);
        const local = all[srv.route_id];
        all[srv.route_id] = local ? mergeOne(local, srv) : srv;
      }
      this.saveCollections(all);
      return resp.items;
    },

    cache: {
      get(key) { const c = read(K_CACHE, {}); return c[key]; },
      set(key, val) { const c = read(K_CACHE, {}); c[key] = { val, at: Date.now() }; write(K_CACHE, c); },
    },
    versions() { return read(K_VERS, {}); },
    setVersions(v) { write(K_VERS, v); },
    routeNames() { return read('nr.routeNames', {}); },
    rememberRouteName(id, name) {
      const m = read('nr.routeNames', {});
      if (id && name && m[id] !== name) { m[id] = name; write('nr.routeNames', m); }
    },
    manualLocation(loc) {
      if (loc === undefined) return read(K_MANUAL, null);
      if (loc === null) localStorage.removeItem(K_MANUAL);
      else write(K_MANUAL, loc);
    },
    online: () => navigator.onLine,
  };

  window.NRStore = Store;
})();
