/* api.js — 极简 fetch 封装，全部筛选/判定参数交给服务端 */
(function () {
  'use strict';
  function qs(params) {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null && v !== '') u.set(k, v);
    }
    const s = u.toString();
    return s ? '?' + s : '';
  }
  async function req(path, opts) {
    const headers = Object.assign({ 'X-User-Id': window.NRStore.uid() }, (opts && opts.headers) || {});
    if (opts && opts.body) headers['Content-Type'] = 'application/json';
    const r = await fetch(path, Object.assign({}, opts, { headers }));
    if (!r.ok) {
      let msg = r.status;
      try { msg = (await r.json()).error || msg; } catch {}
      const e = new Error(msg); e.status = r.status; throw e;
    }
    return r.json();
  }
  window.NRApi = {
    routes: (params) => req('/api/routes' + qs(params)),
    route: (id, params) => req('/api/routes/' + encodeURIComponent(id) + qs(params)),
    geometry: (id, tol) => req(`/api/routes/${encodeURIComponent(id)}/geometry` + qs({ tolerance: tol })),
    nearest: (body) => req('/api/nearest', { method: 'POST', body: JSON.stringify(body) }),
    hints: (params) => req('/api/hints' + qs(params)),
    observe: (id, body) => req(`/api/routes/${encodeURIComponent(id)}/observations`, { method: 'POST', body: JSON.stringify(body) }),
    benchmark: (params) => req('/api/spatial/benchmark' + qs(params)),
    notices: () => req('/api/notices'),
    getCollections: () => req('/api/collections'),
    putCollection: (routeId, body) => req('/api/collections/' + encodeURIComponent(routeId), { method: 'PUT', body: JSON.stringify(body) }),
    syncCollections: (items) => req('/api/collections/sync', { method: 'POST', body: JSON.stringify({ items, client_id: 'web' }) }),
  };
})();
