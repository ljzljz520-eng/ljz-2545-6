'use strict';
/**
 * 预先分段索引 vs 实时空间求交 的可重复对比。
 * 在 12 个查询点（河岸、桥面、河面、远离路线）上各跑 N 次取中位数。
 * 距离结论两种模式必须一致；索引模式扫描的边数与耗时显著更少。
 */
const { buildContext } = require('../server/app');

function median(arr) { arr.sort((a, b) => a - b); return arr[Math.floor(arr.length / 2)]; }

const ctx = buildContext();
const points = [
  { x: 300, y: 0 }, { x: 2200, y: 0 }, { x: 360, y: 0 },
  { x: 400, y: 40 }, { x: 1200, y: -40 }, { x: 1100, y: 140 },
  { x: 700, y: 700 }, { x: 1500, y: 300 }, { x: 2200, y: 600 },
  { x: 300, y: -600 }, { x: 2400, y: 900 }, { x: -80, y: 120 },
];
const N = 40;
const rows = [];
for (const p of points) {
  const tI = [], tR = [], eI = [], eR = [];
  let same = true;
  for (let i = 0; i < N; i++) {
    const qi = ctx.spatialQuery({ ...p, radius: 200, mode: 'index' });
    const qr = ctx.spatialQuery({ ...p, radius: 200, mode: 'realtime' });
    tI.push(qi.timing.microseconds); tR.push(qr.timing.microseconds);
    eI.push(qi.timing.edgesScanned); eR.push(qr.timing.edgesScanned);
    const key = (b) => b.results.map((r) => r.routeId + '@' + r.atM).join('|');
    if (key(qi) !== key(qr)) same = false;
  }
  rows.push({ p, usI: median(tI), usR: median(tR), eI: median(eI), eR: median(eR), same });
}
console.log('查询点'.padEnd(18), '索引µs'.padStart(8), '实时µs'.padStart(8), '索引边'.padStart(7), '实时边'.padStart(7), ' 一致');
for (const r of rows) {
  const tag = `(${r.p.x},${r.p.y})`.padEnd(18);
  console.log(tag, String(r.usI).padStart(8), String(r.usR).padStart(8), String(r.eI).padStart(7), String(r.eR).padStart(7), r.same ? '  ✓' : '  ✗');
}
const mismatch = rows.filter((r) => !r.same).length;
console.log('\n结论：' + (mismatch ? '存在不一致，需排查' : '两种模式命中完全一致；索引扫描边数平均约为实时的 ' +
  Math.round(rows.reduce((a, r) => a + r.eI / r.eR, 0) / rows.length * 100) + '%'));
process.exit(mismatch ? 1 : 0);
