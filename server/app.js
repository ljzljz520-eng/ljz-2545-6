'use strict';
/**
 * 潼川夜跑 · HTTP 入口（零框架，node:http）。
 * 静态文件来自 /public；数据接口前缀 /api。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const seed = require('../data/city.seed.json');
const { buildCatalog } = require('./catalog');
const { createSpatialDb, upsertCatalog } = require('./spatial-db');
const { createStore } = require('./store');
const { createService } = require('./service');

const PORT = Number(process.env.PORT || 4173);
const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function buildContext() {
  const catalog = buildCatalog(seed);
  const spatialDb = createSpatialDb(':memory:');
  upsertCatalog(spatialDb, catalog, 100);
  const store = createStore(spatialDb);
  store.seed(seed, new Date().toISOString());
  return createService({ catalog, store, spatialDb });
}

function createApp(service) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return handleApi(service, req, res, url);
    return serveStatic(url, res);
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1e6) reject(new Error('body-too-large'));
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj, headers = {}) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(buf);
}

async function handleApi(service, req, res, url) {
  const now = service.parseNow(url);
  try {
    const p = url.pathname;

    if (req.method === 'GET' && p === '/api/routes') {
      return sendJson(res, 200, { now: now.toISOString(), routes: service.listRoutes(url.searchParams, now) });
    }
    if (req.method === 'GET' && /^\/api\/routes\/[^/]+$/.test(p)) {
      const id = decodeURIComponent(p.split('/').pop());
      const out = service.getRoute(id, now, req.headers['if-none-match']);
      if (out.status === 404) return sendJson(res, 404, { error: 'not-found' });
      if (out.status === 304) { res.writeHead(304, { etag: out.etag }); return res.end(); }
      return sendJson(res, 200, { now: now.toISOString(), route: out.body }, { etag: out.etag });
    }
    if (req.method === 'GET' && p === '/api/observations') {
      return sendJson(res, 200, { observations: service.listObservations(url.searchParams.get('routeId')) });
    }
    if (req.method === 'POST' && p === '/api/observations') {
      const body = await readJson(req);
      const out = service.addObservation(body, now);
      return sendJson(res, out.status, out.body || out);
    }
    if (req.method === 'GET' && p === '/api/notices') {
      return sendJson(res, 200, { notices: service.listNotices(url.searchParams.get('routeId')) });
    }
    if (req.method === 'PATCH' && /^\/api\/notices\/[^/]+$/.test(p)) {
      const id = decodeURIComponent(p.split('/').pop());
      const body = await readJson(req);
      const out = service.updateNotice(id, body, now);
      return sendJson(res, out.status, out.body || out);
    }
    if (req.method === 'POST' && p === '/api/spatial/query') {
      const body = await readJson(req);
      return sendJson(res, 200, service.spatialQuery(body));
    }
    if (req.method === 'POST' && p === '/api/spatial/snap') {
      const body = await readJson(req);
      return sendJson(res, 200, service.snap(body));
    }
    if (req.method === 'GET' && p === '/api/collection') {
      const userId = url.searchParams.get('user') || 'demo';
      return sendJson(res, 200, service.getCollection(userId));
    }
    if (req.method === 'POST' && p === '/api/collection/sync') {
      const userId = url.searchParams.get('user') || 'demo';
      const body = await readJson(req);
      const out = service.syncCollection(userId, body, now);
      return sendJson(res, out.status, out);
    }
    if (req.method === 'GET' && p === '/api/collection/revs') {
      const userId = url.searchParams.get('user') || 'demo';
      return sendJson(res, 200, { revs: service.listCollectionRevs(userId) });
    }
    if (req.method === 'GET' && p === '/api/health') {
      return sendJson(res, 200, { ok: true, city: service.catalog.city, now: now.toISOString() });
    }
    if (req.method === 'GET' && p === '/api/map-meta') {
      const { parseHours } = require('./observations');
      return sendJson(res, 200, {
        city: service.catalog.city,
        river: service.catalog.river,
        bridges: service.catalog.bridges,
        supplies: [...service.catalog.supplies.values()].map((s) => ({ ...s, openNow: parseHours(s.hours, now).open })),
      });
    }
    return sendJson(res, 404, { error: 'unknown-api' });
  } catch (e) {
    return sendJson(res, 500, { error: 'server-error', message: e.message });
  }
}

function serveStatic(url, res) {
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('404'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

if (require.main === module) {
  const service = buildContext();
  createApp(service).listen(PORT, () => {
    console.log('潼川夜跑原型 http://localhost:' + PORT);
  });
}

module.exports = { createApp, buildContext };
