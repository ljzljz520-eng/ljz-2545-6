/* 预分段 R*Tree 索引 vs 实时全几何求交：
 * 在多个查询点上重复计时，并断言两种策略结果集一致。 */
'use strict';
const D = require('../server/db');
const G = require('../server/geo');
const { seed } = require('../server/seed');

D.connect(':memory:');
const info = seed();

const P = D.proj();
// 查询点：桥面、河面、桥头、公园边、老城、远处
const queryPoints = [];
const add = (id, idx, pad) => {
  const c = D.coords(id, D.getRoute(id).geom_version)[idx];
  queryPoints.push({ name: id + '#v' + idx, lon: c[0], lat: c[1] + pad });
};
add('bridge', 3, 0.001);
add('bridge', 7, 0);
add('rainbow', 4, 0.0008);
add('riverside', 10, 0.0005);
add('park', 2, 0.0012);
add('oldtown', 2, 0.002);
queryPoints.push({ name: 'far', lon: 120.3, lat: 30.32 });

const MAXD = 1200;
function preindexed(lon, lat) {
  const padLon = MAXD / G.R_EARTH * G.R2D;
  const padLat = padLon / Math.cos(D.cityCenter().lat * Math.PI / 180);
  const cand = D.candidatesPreIndexed(lon, lat, Math.max(padLon, padLat));
  const hits = [];
  for (const c of cand) {
    const h = G.projectToPolyline(lon, lat, D.coords(c.route_id, c.geom_version), P);
    if (h.distance <= MAXD) hits.push(c.route_id);
  }
  return new Set(hits);
}
function realtime(lon, lat) {
  return new Set(D.candidatesRealtime(lon, lat, MAXD, P).map(h => h.route_id));
}

const N = 200;
let tPre = 0, tRt = 0, allSame = true;
const rows = [];
for (const q of queryPoints) {
  const a = preindexed(q.lon, q.lat), b = realtime(q.lon, q.lat);
  const same = a.size === b.size && [...a].every(x => b.has(x));
  allSame = allSame && same;
  let s = process.hrtime.bigint();
  for (let i = 0; i < N; i++) preindexed(q.lon, q.lat);
  const e1 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) realtime(q.lon, q.lat);
  const e2 = process.hrtime.bigint();
  const pMs = Number(e1 - s) / 1e6 / N, rtMs = Number(e2 - e1) / 1e6 / N;
  tPre += pMs; tRt += rtMs;
  rows.push({ point: q.name, hits: [...a].join(',') || '-', pre: pMs.toFixed(3), realtime: rtMs.toFixed(3), same });
}
console.table(rows);
console.log('结果集全部一致:', allSame);
console.log(`平均耗时 预分段=${(tPre / rows.length).toFixed(3)}ms 实时=${(tRt / rows.length).toFixed(3)}ms 加速比=${(tRt / tPre).toFixed(2)}x`);
console.log('注：预分段需在 geom_version 变更时重建（写放大），实时求交无过期风险但随路线总长度线性增长。');
if (!allSame) process.exit(1);
