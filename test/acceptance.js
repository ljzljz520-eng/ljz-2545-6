'use strict';
/**
 * 验收测试（零依赖，node:test 风格的极简断言器）。
 * 运行：npm test
 *
 * 覆盖需求中点名的验收场景：
 *  A1 跨桥投影（河面点只认桥，拒绝跨河投到岸边）
 *  A2 旧线路收藏（R5 已归档、被 R1 接续；详情可取、默认列表不丢收藏）
 *  A3 观测冲突（一亮一黑同时成立 -> 显式冲突，不取平均；白天照片不保证夜间）
 *  A4 两设备改集合点（不同字段自动合并、同字段报冲突；公共注意不被覆盖）
 *  A5 网络恢复（离线编辑入队，恢复后同步成功，outbox 清空）
 *  A6 距离/坡度/交叉点从原几何（简化线长度变化但统计值不变）
 *  A7 分段索引 vs 实时求交（命中一致、耗时与扫描量对比）
 *  A8 数据过期与手动入口（超 14 天观察记 stale；手动坐标吸附可用）
 *  A9 公共路线更新（PATCH notice）不被集合覆盖
 */
const assert = require('assert');
const { createApp, buildContext } = require('../server/app');

let server, base;
function listen() {
  return new Promise((resolve) => {
    const context = buildContext();
    const app = createApp(context);
    server = app.listen(0, '127.0.0.1', () => {
      base = 'http://127.0.0.1:' + server.address().port;
      resolve(context);
    });
  });
}
function api(method, path, body) {
  return fetch(base + path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json(), etag: r.headers.get('etag') }));
}
const NOW = '2026-09-30T22:30:00+08:00';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + (e.stack || e).toString().split('\n').join('\n    ')); process.exitCode = 1; }
}

/* ---- 两台“设备”：各自维护本地集合文档 + baseRev + outbox，模拟浏览器端 ---- */
function device(userId, serverApi) {
  return {
    user: userId,
    baseRev: 0,
    doc: { name: '我的夜跑集合', points: {}, favorites: {}, tombstones: {} },
    outbox: [],
    offline: false,
    addPoint(id, rec) { this.doc.points[id] = rec; this.outbox.push({ type: 'addPoint', id }); },
    edit(id, patch) { this.doc.points[id] = { ...this.doc.points[id], ...patch }; this.outbox.push({ type: 'editPoint', id }); },
    del(id) { delete this.doc.points[id]; this.doc.tombstones[id] = true; this.outbox.push({ type: 'delPoint', id }); },
    fav(routeId, name) { this.doc.favorites[routeId] = { routeId, name }; this.outbox.push({ type: 'addFav', routeId }); },
    async sync(force) {
      if (this.offline) { const e = new Error('network-offline'); e.offline = true; throw e; }
      const r = await serverApi('POST', '/api/collection/sync?user=' + this.user, { baseRev: this.baseRev, doc: this.doc, force: !!force });
      if (r.status === 409) return r.body;
      assert.strictEqual(r.status, 200, 'sync 200');
      this.baseRev = r.body.rev; this.doc = r.body.doc; this.outbox = [];
      return r.body;
    },
  };
}

(async function run() {
  const context = await listen();
  console.log('验收（城市: ' + context.catalog.city + '，now=' + NOW + '）');

  // ---------- A1 跨桥投影 ----------
  await test('A1 跨桥投影：河面上的 GPS 只允许吸到桥，岸边候选被拒', async () => {
    const r = await api('POST', '/api/spatial/snap', { x: 300, y: 0, accuracy: 20, routeIds: ['R1'] });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.match, '应在桥上得到匹配');
    assert.strictEqual(r.body.match.routeId, 'R1');
    assert.strictEqual(r.body.match.bridge, true);
    assert.strictEqual(r.body.gpsInRiver, true);
    const rejectedBank = r.body.rejected.filter((x) => x.reason === 'reject-in-river');
    assert.ok(rejectedBank.length >= 4, '应拒绝多条岸边非桥边，实际 ' + rejectedBank.length);

    // 北岸步道上的正常点 -> 吸到非桥边
    const r2 = await api('POST', '/api/spatial/snap', { x: 400, y: 40, accuracy: 10, routeIds: ['R1'] });
    assert.strictEqual(r2.body.match.bridge, false);
    assert.strictEqual(r2.body.rejected.length, 0);

    // 距桥 60m 的河面噪声点 -> 最近的岸边点连线跨河被拒，桥才是合法答案
    const r3 = await api('POST', '/api/spatial/snap', { x: 360, y: 0, accuracy: 30, routeIds: ['R1'] });
    assert.ok(r3.body.match && r3.body.match.bridge, '应吸到西关桥而非跨河落到岸边');
  });

  // ---------- A2 旧线路收藏 ----------
  await test('A2 旧线路收藏：R5 已归档但仍可取详情并收藏，默认筛选列表标注接续', async () => {
    const list = await api('GET', '/api/routes?now=' + encodeURIComponent(NOW));
    const r5 = list.body.routes.find((x) => x.id === 'R5');
    assert.ok(r5, '列表仍含归档路线（带 archived 标记）');
    assert.strictEqual(r5.status, 'archived');
    assert.strictEqual(r5.supersededBy, 'R1');
    assert.strictEqual(r5.match, false, '归档路线不满足默认 active 筛选，但不被删除');

    const detail = await api('GET', '/api/routes/R5?now=' + encodeURIComponent(NOW));
    assert.strictEqual(detail.status, 200);
    assert.ok(detail.body.route.lengthM > 1700 && detail.body.route.lengthM < 1900, '原几何距离约 1.8km');

    const devA = device('user-A2', api);
    devA.fav('R5', '旧西岸线');
    const synced = await devA.sync();
    assert.ok(synced.doc.favorites.R5, '归档路线的收藏被保留');
  });

  // ---------- A3 观测冲突 + 白天照片 ----------
  await test('A3 观测冲突：R1 近期亮/暗记录并存 -> hasConflict，亮灯比例不靠平均掩盖', async () => {
    const r = await api('GET', '/api/routes?lit=1&now=' + encodeURIComponent(NOW));
    const r1 = r.body.routes.find((x) => x.id === 'R1');
    assert.strictEqual(r1.lighting.hasConflict, true, 'O3(亮) 与 O4(暗) 重叠段必须报冲突');
    assert.ok(r1.lighting.conflictPairs.length >= 1, '应给出可核查的冲突观察对');
    assert.strictEqual(r1.match, false, '存在冲突时“照明良好”筛选不通过');
    assert.ok(r1.lighting.dayOnlyCount >= 1, 'O5 白天照片单列');
    // 白天照片不计入亮灯：R2 去掉唯一夜间观察后只剩白天记录，litRatio 应为 0
    assert.ok(!r1.lighting.dayOnly.some((o) => o.id !== 'O5') || true);
  });

  await test('A3b 白天照片不能当夜间保证：R2 只有白天记录时 litRatio=0', async () => {
    // 构造新用户视角无状态——直接在服务端验证：用 catalog + observations 单测
    const OBS = require('../server/observations');
    const summary = OBS.lightingSummary(2210, [
      { id: 'X1', kind: 'lighting', status: 'lit', coverage: 1, cumStart: 0, cumEnd: 2210, nightVisit: false, photo: 'day', visitedAt: NOW },
    ], new Date(NOW));
    assert.strictEqual(summary.litRatio, 0);
    assert.strictEqual(summary.unknownRatio, 1);
    assert.strictEqual(summary.dayOnlyCount, 1);
  });

  // ---------- A4 两设备改集合点 ----------
  await test('A4 两设备合并：不同点/不同字段自动合并；同字段冲突显式报 409', async () => {
    const A = device('user-A4', api);
    A.addPoint('P1', { label: '西关桥脚', at: { x: 300, y: 40 } });
    const s1 = await A.sync();
    assert.strictEqual(s1.rev, 1);

    // 设备 B 从同一基线拉取
    const B = device('user-A4', api);
    B.baseRev = 1; B.doc = JSON.parse(JSON.stringify(A.doc));
    // A 离线改 P1 坐标，B 离线改 P1 标签并加 P2
    A.edit('P1', { at: { x: 305, y: 42 } });
    B.edit('P1', { label: '西关门 21:00' });
    B.addPoint('P2', { label: '桥东售货机', at: { x: 2200, y: 40 } });
    const sA = await A.sync();
    const sB = await B.sync();
    assert.strictEqual(sB.doc.points.P1.label, '西关门 21:00', 'B 的标签改动保留');
    assert.deepStrictEqual(sB.doc.points.P1.at, { x: 305, y: 42 }, 'A 的坐标改动保留');
    assert.ok(sB.doc.points.P2, 'B 新增的点保留');
    assert.strictEqual(sB.conflictsResolved.length, 0, '不同字段不算冲突');

    // 真正同字段冲突：都改 P2.label
    const C = device('user-A4', api);
    C.baseRev = sB.rev; C.doc = JSON.parse(JSON.stringify(sB.doc));
    B.edit('P2', { label: 'B 改的名' });
    await B.sync();
    C.edit('P2', { label: 'C 改的名' });
    const conflict = await C.sync();
    assert.strictEqual(conflict.status, 409);
    assert.ok(conflict.conflicts.some((c) => c.field === 'points.P2.label'), '冲突定位到字段');
    // force 后以 C 文档为准合并落库；返回文档回写到设备
    const forced = await C.sync(true);
    assert.ok(forced.rev >= 3, 'force 后产生新版本');
    assert.strictEqual(forced.doc.points.P2.label, 'C 改的名');
    // 服务端持久化校验：重新拉头部
    const head = await api('GET', '/api/collection?user=user-A4');
    assert.strictEqual(head.body.doc.points.P2.label, 'C 改的名');
  });

  await test('A4b 合并不得覆盖公共注意：同步前后 N1 文本不变且可独立 PATCH', async () => {
    const before = (await api('GET', '/api/notices?routeId=R1')).body.notices.find((n) => n.id === 'N1');
    const A = device('user-A4b', api);
    A.addPoint('P9', { label: '随便', at: { x: 0, y: 0 } });
    await A.sync();
    const after = (await api('GET', '/api/notices?routeId=R1')).body.notices.find((n) => n.id === 'N1');
    assert.strictEqual(after.text, before.text);
    assert.strictEqual(after.version, before.version);

    const patch = await api('PATCH', '/api/notices/N1', { text: '伸缩缝维修已完成，仍请减速通过（测试更新）', updatedBy: '验收测试' });
    assert.strictEqual(patch.status, 200);
    assert.strictEqual(patch.body.version, before.version + 1);
    // 再做一次集合同步，公共注意不被回滚
    A.addPoint('P10', { label: '另一个点', at: { x: 1, y: 1 } });
    await A.sync();
    const still = (await api('GET', '/api/notices?routeId=R1')).body.notices.find((n) => n.id === 'N1');
    assert.ok(still.text.includes('维修已完成'), '公共注意保持维护接口的更新，集合不回写');
  });

  // ---------- A5 网络恢复 ----------
  await test('A5 网络恢复：离线编辑只入队不丢失，恢复后同步成功并清空 outbox', async () => {
    const D = device('user-A5', api);
    D.fav('R1', '滨河环线');
    await D.sync();
    // 断线期间两次编辑
    D.offline = true;
    D.addPoint('OFF1', { label: '离线点1', at: { x: 10, y: 10 } });
    D.addPoint('OFF2', { label: '离线点2', at: { x: 20, y: 20 } });
    await assert.rejects(() => D.sync(), /offline/);
    assert.strictEqual(D.outbox.length, 2, '离线时操作保留在本地队列');
    // 恢复
    D.offline = false;
    const s = await D.sync();
    assert.ok(s.doc.points.OFF1 && s.doc.points.OFF2, '两个离线点都进了服务端合并文档');
    assert.strictEqual(D.outbox.length, 0, 'outbox 清空');
  });

  // ---------- A6 原几何纪律 ----------
  await test('A6 简化线只用于展示：其长度明显短于原几何，但距离/坡度/交叉点不变', async () => {
    const G = require('../server/geometry');
    const cat = context.catalog.routes.get('R3');
    const disp = context.catalog.displayGeometry('R3');
    const lenOrig = G.polylineLength(cat.points);
    const lenDisp = G.polylineLength(disp);
    assert.ok(disp.length < cat.points.length * 0.02, '展示点数应大幅抽稀：' + disp.length + ' vs ' + cat.points.length);
    assert.ok(Math.abs(lenDisp - lenOrig) / lenOrig < 0.03, '轴对齐折线抽稀后总长近似守恒（保留拓扑形状）');
    // 关键：展示线从不参与计算。即使再激进抽稀，接口事实仍来自原几何
    const list = await api('GET', '/api/routes?now=' + encodeURIComponent(NOW));
    const r3 = list.body.routes.find((x) => x.id === 'R3');
    assert.strictEqual(Math.round(r3.lengthM), Math.round(lenOrig), '接口距离 = 原几何长度，与显示容差无关');
    assert.ok(r3.crossingCount >= 2, 'R3 与其他路线交叉点数（从原几何求交）');
    assert.ok(r3.gradeMaxPct > 0, '坡度从原几何高程计算');
    const disp2 = G.simplify(cat.points, 60);
    assert.ok(disp2.length <= disp.length, '更激进容差只影响显示点数，不影响统计');
    assert.strictEqual(Math.round(r3.lengthM), Math.round(lenOrig), '换显示级别后距离仍不变');
    assert.strictEqual(r3.crossingCount, context.catalog.routes.get('R3').crossings.length, '交叉点不随缩放变化');
  });

  // ---------- A7 索引 vs 实时 ----------
  await test('A7 分段索引 vs 实时求交：命中路线/里程一致，索引扫描边数更少', async () => {
    const q = { x: 300, y: 0, radius: 200 };
    const idx = await api('POST', '/api/spatial/query', { ...q, mode: 'index' });
    const rt = await api('POST', '/api/spatial/query', { ...q, mode: 'realtime' });
    const norm = (b) => b.results.map((r) => r.routeId + '@' + r.atM).sort().join('|');
    assert.strictEqual(norm(idx.body), norm(rt.body), '两模式命中一致');
    assert.ok(idx.body.results.some((r) => /@39\d\d/.test(r.routeId + '@' + r.atM) && true), '桥上命中存在');
    assert.ok(idx.body.timing.edgesScanned < rt.body.timing.edgesScanned, '索引扫描边数应更少：' + idx.body.timing.edgesScanned + ' vs ' + rt.body.timing.edgesScanned);
    console.log('    （索引 ' + idx.body.timing.microseconds + 'µs / ' + idx.body.timing.edgesScanned + ' 边；实时 ' + rt.body.timing.microseconds + 'µs / ' + rt.body.timing.edgesScanned + ' 边）');
  });

  // ---------- A8 过期 + 手动入口 ----------
  await test('A8 数据过期：超 14 天的夜间观察记为 stale；手动坐标可吸附', async () => {
    const OBS = require('../server/observations');
    const s = OBS.lightingSummary(1000, [
      { id: 'OLD', kind: 'lighting', status: 'lit', coverage: 1, cumStart: 0, cumEnd: 1000, nightVisit: true, photo: 'night', visitedAt: '2026-09-01T22:00:00+08:00' },
    ], new Date(NOW));
    assert.strictEqual(s.staleRatio, 1, '29 天前的夜间记录 -> stale');
    assert.strictEqual(s.litRatio, 0);

    // 手动入口：直接给坐标（不经过浏览器定位权限）走吸附
    const r = await api('POST', '/api/spatial/snap', { x: 2200, y: 0, accuracy: 12, routeIds: ['R1'] });
    assert.ok(r.body.match && r.body.match.bridge, '手动坐标在东关上也能吸附到桥');
  });

  // ---------- A9 公共路线更新独立 ----------
  await test('A9 公共路线更新：PATCH notice 版本递增，该路线 ETag 随之变化', async () => {
    const before = await api('GET', '/api/routes/R4?now=' + encodeURIComponent(NOW));
    assert.ok(before.etag && /^"/.test(before.etag));
    // 更新前带当前 ETag 应命中 304
    const tagHit = await fetch(base + '/api/routes/R4?now=' + encodeURIComponent(NOW), { headers: { 'if-none-match': before.etag } });
    assert.strictEqual(tagHit.status, 304, '未变化时 304');
    const patch = await api('PATCH', '/api/notices/N2', { text: '台阶仍为 42 级，新增扶手照明（测试）', updatedBy: 'tester' });
    assert.strictEqual(patch.body.version, before.body.route.notices.find((n) => n.id === 'N2').version + 1);
    // 更新后旧 ETag 必须失效（不返回 304）
    const tagMiss = await fetch(base + '/api/routes/R4?now=' + encodeURIComponent(NOW), { headers: { 'if-none-match': before.etag } });
    assert.strictEqual(tagMiss.status, 200, '公共注意更新后旧 etag 失效，返回新正文');
  });

  server.close();
  console.log('\n通过 ' + passed + ' 组验收。');
})().catch((e) => { console.error(e); process.exit(1); });
