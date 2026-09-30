'use strict';
/* API 客户端 + 离线本地库。
 * - 列表不缓存（筛选结果随“现在”变化）；路线详情用 ETag 缓存，观察更新后服务端指纹变化。
 * - 集合点本地可离线编辑（points/favorites/tombstones + outbox），联网后三路合并同步。
 */
(function () {
  const LS = {
    collection: 'nr.collection.v1',
    baseRev: 'nr.baseRev.v1',
    outbox: 'nr.outbox.v1',
    routeCache: 'nr.routeCache.v1',
    etags: 'nr.etags.v1',
    user: 'nr.user.v1',
  };

  function read(k, fallback) {
    try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
  }
  function write(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  const userId = (() => {
    let u = read(LS.user, null);
    if (!u) { u = 'u-' + Math.random().toString(36).slice(2, 8); write(LS.user, u); }
    return u;
  })();

  async function req(method, path, body, opts = {}) {
    const init = { method, headers: {} };
    if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
    if (opts.etag) init.headers['if-none-match'] = opts.etag;
    const r = await fetch(path, init);
    if (r.status === 304) return { notModified: true, etag: r.headers.get('etag') };
    const text = await r.text();
    const data = text ? JSON.parse(text) : {};
    if (!r.ok) throw Object.assign(new Error(data.error || ('http-' + r.status)), { status: r.status, data });
    return { data, etag: r.headers.get('etag') };
  }

  // ---- 集合点本地编辑 ----
  function localCollection() {
    return read(LS.collection, { name: '我的夜跑集合', points: {}, favorites: {}, tombstones: {} });
  }
  function saveLocalCollection(doc) { write(LS.collection, doc); }
  function getOutbox() { return read(LS.outbox, []); }
  function setOutbox(q) { write(LS.outbox, q); }

  function applyLocal(op) {
    const doc = localCollection();
    const id = op.id || ('L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5));
    if (op.type === 'addPoint') {
      doc.points[id] = { label: op.label, at: op.at, createdAt: op.at2 || new Date().toISOString() };
    } else if (op.type === 'editPoint') {
      if (doc.points[op.id]) doc.points[op.id] = { ...doc.points[op.id], ...op.patch };
    } else if (op.type === 'delPoint') {
      delete doc.points[op.id];
      doc.tombstones[id] = true;
    } else if (op.type === 'addFav') {
      doc.favorites[op.routeId] = { routeId: op.routeId, name: op.name, savedAt: new Date().toISOString() };
    } else if (op.type === 'delFav') {
      delete doc.favorites[op.routeId];
    }
    saveLocalCollection(doc);
    const q = getOutbox();
    q.push({ ...op, id: (op.type === 'addPoint') ? id : op.id, clientTime: new Date().toISOString() });
    setOutbox(q);
    return id;
  }

  /**
   * 同步：将本地整份文档（已包含离线编辑）按 baseRev 提交三路合并。
   * 409 冲突时返回 conflicts，让用户显式选择 force（本原型默认不静默覆盖）。
   */
  async function sync(force = false) {
    const doc = localCollection();
    const baseRev = read(LS.baseRev, 0);
    const { data } = await req('POST', '/api/collection/sync?user=' + encodeURIComponent(userId), { baseRev, doc, force });
    if (data.status === 409) {
      return { ok: false, conflicts: data.conflicts || [], headRev: data.headRev, head: data.head, mergedPreview: data.mergedPreview };
    }
    // 成功：服务端合好的文档成为新本地基线；清空已提交 outbox
    write(LS.collection, data.doc);
    write(LS.baseRev, data.rev);
    setOutbox([]);
    return { ok: true, rev: data.rev, doc: data.doc, conflictsResolved: data.conflictsResolved || [] };
  }

  async function pull() {
    const { data } = await req('GET', '/api/collection?user=' + encodeURIComponent(userId));
    // 初次拉取：以服务端为空基线初始化（保留本地未同步编辑，等 sync 时合并）
    if (read(LS.baseRev, null) === null) {
      write(LS.baseRev, data.rev);
      if (getOutbox().length === 0) write(LS.collection, data.doc);
    }
    return data;
  }

  window.NR = {
    userId, LS, read, write,
    online: () => navigator.onLine,
    req,
    listRoutes: (query) => req('GET', '/api/routes?' + query),
    getRoute: async (id) => {
      const etags = read(LS.etags, {});
      const cache = read(LS.routeCache, {});
      try {
        const out = await req('GET', '/api/routes/' + encodeURIComponent(id), undefined, { etag: etags[id] });
        if (out.notModified) return { notModified: true, cached: cache[id] || null };
        if (out.etag) { etags[id] = out.etag; write(LS.etags, etags); }
        cache[id] = { route: out.data.route, fetchedAt: new Date().toISOString() };
        write(LS.routeCache, cache);
        return out;
      } catch (e) {
        return { offline: true, error: e, cached: cache[id] || null };
      }
    },
    spatialQuery: (body) => req('POST', '/api/spatial/query', body),
    snap: (body) => req('POST', '/api/spatial/snap', body),
    addObservation: (body) => req('POST', '/api/observations', body),
    updateNotice: (id, body) => req('PATCH', '/api/notices/' + encodeURIComponent(id), body),
    localCollection, saveLocalCollection, applyLocal, getOutbox, setOutbox,
    getBaseRev: () => read(LS.baseRev, 0),
    sync, pull,
  };
})();
