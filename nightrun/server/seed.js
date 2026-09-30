/*
 * seed.js — 虚构城市「江湾市」种子数据。
 * 河流把城市分南北，两座桥（江湾大桥/彩虹步行桥）提供跨河路线。
 * 观察数据刻意覆盖：夜间点亮、夜间未亮、冲突、过期、仅白天照片。
 */
'use strict';
const path = require('path');
const db = require('./db');
const geo = require('./geo');

const CITY = { lon: 120.2, lat: 30.25 };

function P() { return db.proj(); }

// 工具：沿航向生成点串
function gen(base, steps) {
  const P_ = P();
  let [x, y] = P_.project(base[0], base[1]);
  const out = [[...base]];
  for (const [dx, dy, ele] of steps) {
    x += dx; y += dy;
    const ll = P_.unproject(x, y);
    out.push(ele == null ? [ll[0], ll[1]] : [ll[0], ll[1], ele]);
  }
  return out;
}

const DAY = 24 * 3600 * 1000;
const NOW = Date.now();

function seed() {
  db.setCityCenter(CITY);

  /* ---------- 路线 ----------
   * 坐标用投影米描述：x 东向，y 北向。河在 y≈0 一带（约 120 m 宽）。
   */
  const routes = {
    // 滨河线：北岸东西向，平坦
    riverside: {
      meta: { id: 'riverside', name: '北岸滨河线', surface: 'paved' },
      coords: gen([120.185, 30.2525], [
        ...Array.from({ length: 16 }, (_, i) => [180, (i % 2 ? 12 : -12), 8 + Math.round(i / 3)]),
      ]),
    },
    // 江湾大桥线：南北穿河（桥在 x≈1350m），有桥坡
    bridge: {
      meta: { id: 'bridge', name: '江湾大桥线', surface: 'mixed', segments: null },
      coords: (() => {
        const P_ = P();
        const [bx, by] = P_.project(120.2, 30.25); // 桥轴 x≈0
        const start = P_.unproject(bx + 1350, by + 1500);
        return gen(start, [
          [0, -180, 10], [0, -180, 12], [0, -150, 22], [0, -150, 26], // 北引桥上坡
          [0, -150, 27], [0, -150, 26],                               // 桥面
          [0, -150, 14], [0, -150, 6], [0, -180, 4], [0, -180, 3],   // 南引桥下坡
        ]);
      })(),
    },
    // 彩虹步行桥线：另一座桥，x≈-900m，缓坡
    rainbow: {
      meta: { id: 'rainbow', name: '彩虹步行桥线', surface: 'paved' },
      coords: (() => {
        const P_ = P();
        const [bx, by] = P_.project(120.2, 30.25);
        const start = P_.unproject(bx - 900, by + 1200);
        return gen(start, [
          [0, -150, 6], [0, -150, 10], [0, -150, 12], [0, -150, 11],
          [0, -150, 8], [0, -150, 5], [0, -150, 4], [0, -150, 3],
        ]);
      })(),
    },
    // 公园环线：有坡
    park: {
      meta: { id: 'park', name: '南山公园环线', surface: 'trail' },
      coords: gen([120.212, 30.232], [
        [200, 40, 20], [180, -120, 45], [60, -200, 70],
        [-160, -120, 40], [-220, 60, 15], [-120, 200, 10], [60, 160, 8],
      ]),
    },
    // 老城区短打：部分路段照明差
    oldtown: {
      meta: { id: 'oldtown', name: '老城短打线', surface: 'paved' },
      coords: gen([120.183, 30.235], [
        [160, 0, 6], [0, 150, 7], [170, 0, 6], [0, -160, 7], [150, 0, 6],
      ]),
    },
  };

  const lengths = {};
  for (const key of Object.keys(routes)) {
    const r = routes[key];
    const info = db.upsertRouteVersion(r.meta, r.coords);
    lengths[key] = info.length_m;
  }

  // 旧版滨河线（v1）被 v2 取代：先插 v1，再更新几何生成 v2
  // （riverside 当前已是 v1，这里直接做一次几何更新）
  const rsV2 = gen([120.184, 30.2522], [
    ...Array.from({ length: 18 }, (_, i) => [170, (i % 3 === 0 ? 18 : -10), 8 + Math.round(i / 4)]),
  ]);
  db.upsertRouteVersion(routes.riverside.meta, rsV2, '滨河步道东延 300 米');

  // 已废弃的老线路：被新线取代
  const legacy = {
    meta: { id: 'canal-old', name: '运河老线（已废弃）', surface: 'paved', status: 'deprecated', replaces: null },
    coords: gen([120.19, 30.243], [[140, 0, 5], [140, 0, 5], [0, 140, 5], [140, 0, 5]]),
  };
  db.upsertRouteVersion(legacy.meta, legacy.coords);

  db.rebuildAllCrossings();

  /* ---------- 照明观察（不可变记录） ---------- */
  const nightSchedule = { days: [1, 2, 3, 4, 5, 6, 7], start: '18:00', end: '06:00' };

  // riverside: 0-2000 夜间点亮（近期）
  db.addObservation({
    routeId: 'riverside', source: 'night_visit', lit: true,
    covFrom: 0, covTo: lengths.riverside, observedAt: NOW - 5 * DAY,
    schedule: nightSchedule, observer: '夜跑志愿者-阿岚', note: '整线路灯正常，桥下 800-950 米偏暗',
  });
  // 桥上段有两条互相冲突的近期观察
  db.addObservation({
    routeId: 'bridge', source: 'night_visit', lit: true,
    covFrom: 0, covTo: lengths.bridge, observedAt: NOW - 9 * DAY,
    schedule: nightSchedule, observer: '跑团A', note: '桥面新装投光灯，全亮',
  });
  db.addObservation({
    routeId: 'bridge', source: 'report', lit: false,
    covFrom: 350, covTo: 900, observedAt: NOW - 2 * DAY,
    schedule: nightSchedule, observer: '跑友-黑鱼', note: '桥北引桥段两盏灯不亮（维护中）',
  });
  // rainbow：仅白天照片（不能证明夜间）
  db.addObservation({
    routeId: 'rainbow', source: 'day_photo', lit: null,
    covFrom: 0, covTo: lengths.rainbow, observedAt: NOW - 20 * DAY,
    observer: '地图贡献者', note: '白天实拍，桥两侧可见灯杆',
  });
  // rainbow: 一条很久以前的夜间记录 -> 过期
  db.addObservation({
    routeId: 'rainbow', source: 'night_visit', lit: true,
    covFrom: 0, covTo: lengths.rainbow, observedAt: NOW - 240 * DAY,
    schedule: nightSchedule, observer: '旧跑团记录', note: '当时亮灯',
  });
  // park：公园灯，只到 21:30
  db.addObservation({
    routeId: 'park', source: 'night_visit', lit: true,
    covFrom: 0, covTo: lengths.park, observedAt: NOW - 12 * DAY,
    schedule: { days: [1, 2, 3, 4, 5, 6, 7], start: '18:00', end: '21:30' },
    observer: '公园管理处', note: '21:30 熄灯，山道段无独立照明',
  });
  // oldtown：前段亮、后段近期夜访确认黑
  db.addObservation({
    routeId: 'oldtown', source: 'night_visit', lit: true,
    covFrom: 0, covTo: 320, observedAt: NOW - 30 * DAY,
    schedule: nightSchedule, observer: '社区夜巡', note: '巷口灯亮',
  });
  db.addObservation({
    routeId: 'oldtown', source: 'night_visit', lit: false,
    covFrom: 320, covTo: lengths.oldtown, observedAt: NOW - 3 * DAY,
    schedule: nightSchedule, observer: '夜跑志愿者-阿岚', note: '拆迁围挡后无灯',
  });

  /* ---------- 补给点（营业时段） ---------- */
  const mkSupply = (id, routeId, kind, name, lonlat, windows) => {
    const P_ = P();
    let station = null;
    if (routeId) {
      const c = db.latestCoords(routeId);
      station = geo.projectToPolyline(lonlat[0], lonlat[1], c, P_).station;
    }
    db.putSupply({
      id, route_id: routeId, lon: lonlat[0], lat: lonlat[1],
      kind, name, windows_json: JSON.stringify(windows), station_m: station, updated_at: NOW,
    });
  };
  const daily = (s, e) => [{ days: [1, 2, 3, 4, 5, 6, 7], start: s, end: e }];
  mkSupply('sup-01', 'riverside', 'water', '滨河直饮点A', [120.19, 30.2527], daily('05:00', '23:00'));
  mkSupply('sup-02', 'riverside', 'shop', '东门便利店', [120.205, 30.2530], daily('00:00', '23:59'));
  mkSupply('sup-03', 'bridge', 'water', '桥南驿站', [120.2 + 0.0125, 30.2385], daily('06:00', '22:00'));
  mkSupply('sup-04', 'bridge', 'shop', '桥头自动贩卖机', [120.2 + 0.0125, 30.262], daily('00:00', '23:59'));
  mkSupply('sup-05', 'park', 'water', '公园北门饮水台', [120.213, 30.236], daily('05:30', '21:00'));
  mkSupply('sup-06', 'rainbow', 'toilet', '彩虹桥公共卫生间', [120.2 - 0.0085, 30.260], daily('05:00', '22:00'));
  mkSupply('sup-07', null, 'shop', '24小时药店(桥南)', [120.2 + 0.014, 30.237], daily('00:00', '23:59'));

  /* ---------- 公共注意信息（任何人编辑集合都不得覆盖） ---------- */
  db.putNotice({
    id: 'n-bridge-1', route_id: 'bridge',
    message: '桥北引桥 350–900 米有路灯维修（2026-09 登记），结伴通过。',
    severity: 'warning', geom_version: 1, obs_version: 2, updated_at: NOW - 2 * DAY,
  });
  db.putNotice({
    id: 'n-riverside-1', route_id: 'riverside',
    message: '滨河步道周末 19:00–21:00 人流密集，控制配速。',
    severity: 'info', geom_version: 2, obs_version: 1, updated_at: NOW - 10 * DAY,
  });
  db.putNotice({
    id: 'n-oldtown-1', route_id: 'oldtown',
    message: '老城短打线后段（320 米后）夜间无照明，不建议单人夜跑。',
    severity: 'warning', geom_version: 1, obs_version: 2, updated_at: NOW - 3 * DAY,
  });

  return { lengths, CITY };
}

if (require.main === module) {
  const started = Date.now();
  const info = seed();
  // eslint-disable-next-line no-console
  console.log('seeded', JSON.stringify({ routes: info.lengths, ms: Date.now() - started }, null, 2));
}

module.exports = { seed, CITY };
