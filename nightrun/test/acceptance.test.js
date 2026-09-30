'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resetDb, startServer, call, NIGHT, NOON, G } = require('./helpers');

let D, server;

test.before(async () => { D = resetDb(); server = await startServer(D); });
test.after(() => server.srv.close());

/* 验收 1：跨桥投影
 * 取桥面中点附近的点：必须命中 bridge；取两岸等距的河面点，
 * 结果必须由真实几何投影决定，而不是按包围盒/屏幕距离。 */
test('跨桥投影：桥上点命中桥，河面点按真实几何分配', () => {
  const P = D.proj();
  const bridge = D.coords('bridge', 1);
  // 桥面第 4 个顶点（桥面段）的经纬度
  const probe = bridge[4];
  const hit = G.projectToPolyline(probe[0], probe[1], bridge, P);
  assert.ok(hit.distance < 1, '桥上点投影距离应≈0');
  assert.ok(hit.station > 500 && hit.station < 1100, '桩号应落在桥面段');

  // 河面点 x=1350 桥轴附近 y=150（水面），到 bridge 远、到 riverside 也有距离：
  // 构造一个位于 rainbow 桥轴正上方(y=600)的河面点：rainbow 桥面经过这里
  const rainbow = D.coords('rainbow', 1);
  const rp = rainbow[4];
  // 该点若误按 bbox，可能同时落在 riverside/bridge 包围盒；逐段投影只能选 rainbow
  const candidates = ['bridge', 'rainbow', 'riverside'].map(id => {
    const cs = D.coords(id, id === 'riverside' ? 2 : 1);
    const h = G.projectToPolyline(rp[0], rp[1], cs, P);
    return { id, d: h.distance };
  });
  candidates.sort((a, b) => a.d - b.d);
  assert.equal(candidates[0].id, 'rainbow', 'rainbow 桥上点应最贴近 rainbow 原几何');
  assert.ok(candidates[0].d < 1);
});

test('跨桥投影：/api/nearest 结果不随显示缩放/简化改变', async () => {
  const probe = D.coords('bridge', 1)[4];
  const r1 = await call(server.port, 'POST', '/api/nearest', { lon: probe[0], lat: probe[1], max_distance: 2000, now: NIGHT });
  const r2 = await call(server.port, 'POST', '/api/nearest', { lon: probe[0], lat: probe[1], max_distance: 100, now: NIGHT });
  assert.equal(r1.body.nearest.route_id, 'bridge');
  assert.equal(r2.body.nearest.route_id, 'bridge');
  // 详情里无论简化公差多大，距离与交叉数不变
  const d5 = await call(server.port, 'GET', `/api/routes/bridge/geometry?tolerance=5&now=${NIGHT}`);
  const d80 = await call(server.port, 'GET', `/api/routes/bridge/geometry?tolerance=80&now=${NIGHT}`);
  assert.equal(Math.round(d5.body.full_length_m), Math.round(d80.body.full_length_m));
  assert.ok(d80.body.simplified.length <= d5.body.simplified.length, '大公差点数不增加（仅显示差异）');
  assert.ok(d5.body.simplified.length <= d5.body.full.length);
  const det = await call(server.port, 'GET', `/api/routes/bridge?now=${NIGHT}`);
  assert.equal(det.body.route.length_m, d5.body.full_length_m);
  assert.equal(det.body.route.crossings_count, 1);
});

/* 验收 2：旧线路收藏
 * 收藏一条线后，它被标记 deprecated / 被新线取代，收藏仍可读，
 * 且公共侧几何更新不会覆盖个人集合点。 */
test('旧线路收藏：废弃后仍保留，公共几何更新不覆盖个人集合点', async () => {
  const uid = 'runner-oldline';
  // 收藏旧线 + 集合点
  let r = await call(server.port, 'PUT', '/api/collections/canal-old', {
    saved_at: '2026-01-01T10:00:00Z', saved_at_ts: 1767225600000,
    meeting: { lon: 120.191, lat: 30.244, label: '运河老桥头' }, meeting_ts: 1767225600001,
    base_geom_version: 1, base_obs_version: 0,
  }, uid);
  assert.equal(r.status, 200);

  // 列表默认不含废弃线，但收藏列表里有，且带 public.status
  r = await call(server.port, 'GET', '/api/collections', null, uid);
  const item = r.body.items.find(x => x.route_id === 'canal-old');
  assert.ok(item, '旧线路仍在收藏中');
  assert.equal(item.public.status, 'deprecated');

  // 公共侧再更新一次别的路线的几何，个人收藏不变
  const P = D.proj();
  const [x0, y0] = P.project(120.19, 30.243);
  const moved = [];
  for (let i = 0; i < 5; i++) { const ll = P.unproject(x0 + i * 150, y0 + 10); moved.push([ll[0], ll[1], 5]); }
  D.upsertRouteVersion({ id: 'canal-old', name: '运河老线（已废弃）', status: 'deprecated' }, moved, '行政变更');
  r = await call(server.port, 'GET', '/api/collections', null, uid);
  const item2 = r.body.items.find(x => x.route_id === 'canal-old');
  assert.deepEqual(item2.meeting, { lon: 120.191, lat: 30.244, label: '运河老桥头' });
  assert.equal(item2.public.geom_version, 2); // 公共版本前进，个人字段保留
});

/* 验收 3：观测冲突
 * bridge 同时存在“全亮”和“350–900 不亮”的近期夜访：
 * API 必须给出 conflict 与桩号区间；中午两条都不在时段 → unknown；
 * 白天照片永远不能产生 lit。 */
test('观测冲突：夜间冲突给区间，中午 unknown，白天照片不作夜证', async () => {
  let r = await call(server.port, 'GET', `/api/routes/bridge?now=${NIGHT}`);
  assert.equal(r.body.route.lighting.status, 'conflict');
  assert.ok(r.body.route.lighting.conflict_ranges.length >= 1);
  const [from, to] = r.body.route.lighting.conflict_ranges[0];
  assert.ok(from >= 340 && to <= 910, `冲突区间应落在350-900附近: ${from}-${to}`);

  const list = await call(server.port, 'GET', `/api/routes?lighting=conflict&now=${NIGHT}`);
  assert.ok(list.body.routes.some(x => x.id === 'bridge'));

  r = await call(server.port, 'GET', `/api/routes/bridge?now=${NOON}`);
  assert.equal(r.body.route.lighting.status, 'unknown');

  // rainbow：只有白天照片 + 过期夜访 → unknown 且标记 day_photo_only/stale
  r = await call(server.port, 'GET', `/api/routes/rainbow?now=${NIGHT}`);
  assert.equal(r.body.route.lighting.status, 'unknown');
  assert.equal(r.body.route.lighting.day_photo_only.length, 1);

  // 提交白天照片却声称亮灯 → 422
  const bad = await call(server.port, 'POST', '/api/routes/rainbow/observations', {
    source: 'day_photo', lit: true, cov_from: 0, cov_to: 100, observed_at: NIGHT,
  });
  assert.equal(bad.status, 422);

  // 合法夜访提交后 obs_version 前进
  const ok = await call(server.port, 'POST', '/api/routes/rainbow/observations', {
    source: 'night_visit', lit: true, cov_from: 0, cov_to: 600, observed_at: NIGHT - 86400000,
    schedule: { days: [1, 2, 3, 4, 5, 6, 7], start: '18:00', end: '23:00' }, observer: 'test', note: '夜跑实测',
  });
  assert.equal(ok.status, 201);
  assert.ok(ok.body.obs_version >= 3);
});

/* 验收 4：两设备改集合点
 * A 改集合点坐标，B 同时改退出点与备注；两边同步后字段都保留。
 * 同字段（备注）双端各改一次：时间戳较新者胜，较旧字段被报告为 dropped。 */
test('两设备集合点：不同字段合并保留，同字段新者胜，公共注意不被覆盖', async () => {
  const uid = 'runner-two-device';
  const t0 = 1767225600000; // 2026-01-01
  // 设备 A：集合点
  let r = await call(server.port, 'PUT', '/api/collections/bridge', {
    saved_at: '2026-01-01T10:00:00Z', saved_at_ts: t0,
    meeting: { lon: 120.2131, lat: 30.2386, label: '桥南驿站' }, meeting_ts: t0 + 1,
    base_geom_version: 1, base_obs_version: 2, client_id: 'deviceA',
  }, uid);
  assert.equal(r.status, 200);

  // 设备 B 离线期间基于同一旧状态编辑退出点+备注，再批量同步
  const bEdits = [
    { route_id: 'bridge', exit_station: 400, exit_ts: t0 + 20, client_id: 'deviceB' },
  ];
  r = await call(server.port, 'POST', '/api/collections/sync', { items: bEdits }, uid);
  assert.equal(r.status, 200);
  let merged = r.body.items.find(x => x.route_id === 'bridge');
  assert.deepEqual(merged.meeting, { lon: 120.2131, lat: 30.2386, label: '桥南驿站' }, 'A 的集合点保留');
  assert.equal(merged.exit_station, 400, 'B 的退出点合并进来');

  // 同字段竞争：服务端先有较新备注；B 用更旧 ts 再写，应被丢弃并报告
  await call(server.port, 'PUT', '/api/collections/bridge', { note: 'A新备注-带雨衣', note_ts: t0 + 50 }, uid);
  r = await call(server.port, 'POST', '/api/collections/sync', { items: [
    { route_id: 'bridge', note: 'B旧备注', note_ts: t0 + 5, client_id: 'deviceB' },
  ] }, uid);
  assert.ok(r.body.conflicts.some(c => c.route_id === 'bridge' && c.dropped_fields.includes('note')));

  // A 用更新的 ts 写备注
  r = await call(server.port, 'PUT', '/api/collections/bridge', { note: 'A新备注-带雨衣', note_ts: t0 + 50 }, uid);
  assert.equal(r.body.item.note, 'A新备注-带雨衣');

  // 再同步 B 较新备注（时间戳更新）→ 新者胜
  r = await call(server.port, 'POST', '/api/collections/sync', { items: [
    { route_id: 'bridge', note: 'B更新备注-配速6分', note_ts: t0 + 80, client_id: 'deviceB' },
  ] }, uid);
  merged = r.body.items.find(x => x.route_id === 'bridge');
  assert.equal(merged.note, 'B更新备注-配速6分');
  assert.deepEqual(merged.meeting, { lon: 120.2131, lat: 30.2386, label: '桥南驿站' });
  assert.equal(merged.exit_station, 400);

  // 公共注意未受影响
  const notices = await call(server.port, 'GET', '/api/notices');
  const n = notices.body.notices.find(x => x.id === 'n-bridge-1');
  assert.ok(n && /路灯维修/.test(n.message));
});

/* 验收 5：网络恢复
 * 设备离线连续编辑（收藏、集合点、退出点、删除另一条），
 * 恢复后用 sync 批量重放：全部落地；删除使用墓碑；与已有服务端状态合并。 */
test('网络恢复：离线 outbox 批量重放、墓碑删除、与服务端合并', async () => {
  const uid = 'runner-offline';
  const base = Date.now();
  const offlineEdits = [
    { route_id: 'riverside', saved_at: new Date(base).toISOString(), saved_at_ts: base + 1,
      meeting: { lon: 120.195, lat: 30.2526, label: '东门' }, meeting_ts: base + 2,
      exit_station: 1500, exit_ts: base + 3, base_geom_version: 2, base_obs_version: 1, client_id: 'offline1' },
    { route_id: 'park', saved_at: new Date(base + 10).toISOString(), saved_at_ts: base + 10,
      base_geom_version: 1, base_obs_version: 1, client_id: 'offline1' },
    { route_id: 'oldtown', saved_at: new Date(base + 11).toISOString(), saved_at_ts: base + 11,
      deleted: 1, deleted_ts: base + 100, client_id: 'offline1' },
  ];
  const r = await call(server.port, 'POST', '/api/collections/sync', { items: offlineEdits }, uid);
  assert.equal(r.status, 200);
  assert.equal(r.body.items.length, 3);

  const list = await call(server.port, 'GET', '/api/collections', null, uid);
  const ids = list.body.items.map(x => x.route_id);
  assert.ok(ids.includes('riverside'));
  assert.ok(ids.includes('park'));
  assert.ok(!ids.includes('oldtown'), '墓碑删除生效，不出现在列表');

  // 被删除条目底层仍可查到（墓碑保留，防止旧设备“复活”）
  const tomb = D.getCollection(uid, 'oldtown');
  assert.equal(tomb.deleted, 1);

  // 一个离线期间服务端已被另一设备更新过集合点坐标；同步按字段合并，双方共存
  await call(server.port, 'PUT', '/api/collections/riverside', {
    meeting: { lon: 120.2, lat: 30.253, label: '另一设备改的点' }, meeting_ts: base + 200,
  }, uid);
  const r2 = await call(server.port, 'POST', '/api/collections/sync', { items: [
    { route_id: 'riverside', note: '离线下写的备注', note_ts: base + 50, client_id: 'offline1' },
  ] }, uid);
  const item = r2.body.items.find(x => x.route_id === 'riverside');
  assert.equal(item.note, '离线下写的备注');
  assert.equal(item.meeting.label, '另一设备改的点', '坐标采用时间戳更新的另一设备值');
  assert.equal(item.exit_station, 1500, '退出点仍保留');
});
