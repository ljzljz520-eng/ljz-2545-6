'use strict';
const http = require('http');
const D = require('../server/db');
const { createApi } = require('../server/api');
const G = require('../server/geo');
const express = require('express');
const { seed } = require('../server/seed');

function resetDb() {
  // db.js 是带状态的单例模块；resetForTest 在同一模块实例上重建内存库
  D.resetForTest(seed);
  return D;
}

function startServer(Dmod) {
  const app = express();
  app.use('/api', createApi({ db: Dmod || D, geo: G }));
  return new Promise(resolve => {
    const srv = app.listen(0, () => resolve({ srv, port: srv.address().port }));
  });
}

function call(port, method, p, body, userId) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      port, path: p, method,
      headers: Object.assign({ 'Content-Type': 'application/json' },
        data ? { 'Content-Length': Buffer.byteLength(data) } : {},
        userId ? { 'X-User-Id': userId } : {}),
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        let j = null; try { j = JSON.parse(buf); } catch {}
        resolve({ status: res.statusCode, body: j, raw: buf });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const NIGHT = new Date('2026-09-30T20:30+08:00').getTime();
const NOON = new Date('2026-09-30T12:00+08:00').getTime();

module.exports = { resetDb, startServer, call, NIGHT, NOON, G };
