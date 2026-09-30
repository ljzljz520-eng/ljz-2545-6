/*
 * geo.js — 夜跑城市的共享几何/时间判定核心（UMD，Node 与浏览器共用）。
 *
 * 关键不变量（见 docs/ALGORITHMS.md）：
 *  - 距离、坡度、交叉点、桩号(station)一律从【原几何】计算；
 *  - 简化线(Douglas–Peucker)仅用于展示，不参与任何判定；
 *  - 因此地图缩放/简化公差变化不会改变筛选与“最近路线”结果。
 *  - “照明良好”是带【观察时刻 + 覆盖区间 + 生效时段】的观察结论：
 *    白天照片只证明灯具存在，绝不证明夜间点亮。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NRGeo = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const R_EARTH = 6371008.8;
  const D2R = Math.PI / 180;
  const R2D = 180 / Math.PI;
  const TZ_OFFSET_MIN = 8 * 60; // 江湾市固定 UTC+8，保证测试可复现
  const STALE_LIGHTING_MS = 180 * 24 * 3600 * 1000; // 照明观察 180 天后视为过期

  // ---------- 基础大地测量 ----------

  function haversine(lon1, lat1, lon2, lat2) {
    const dLat = (lat2 - lat1) * D2R;
    const dLon = (lon2 - lon1) * D2R;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLon / 2) ** 2;
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  // coords: [[lon, lat, ele?], ...]，ele 可选（米）
  function stations(coords) {
    const s = [0];
    for (let i = 1; i < coords.length; i++) {
      s[i] = s[i - 1] + haversine(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
    }
    return s;
  }

  function polylineLength(coords) {
    const s = stations(coords);
    return s[s.length - 1] || 0;
  }

  function bbox(coords) {
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const c of coords) {
      if (c[0] < minLon) minLon = c[0];
      if (c[0] > maxLon) maxLon = c[0];
      if (c[1] < minLat) minLat = c[1];
      if (c[1] > maxLat) maxLat = c[1];
    }
    return { minLon, maxLon, minLat, maxLat };
  }

  // 坡度全部来自原几何的高程采样；无高程时返回 null
  function slopeProfile(coords, stats) {
    const s = stats || stations(coords);
    let ascent = 0, descent = 0, maxAbs = 0, maxSigned = 0;
    let hasEle = coords.some(c => typeof c[2] === 'number');
    if (!hasEle) return { ascent: null, descent: null, maxSlope: null, meanSlope: null };
    for (let i = 1; i < coords.length; i++) {
      const d = s[i] - s[i - 1];
      if (d < 1e-6) continue;
      const dh = (coords[i][2] ?? 0) - (coords[i - 1][2] ?? 0);
      const g = dh / d;
      if (dh > 0) ascent += dh; else descent -= dh;
      if (Math.abs(g) > maxAbs) { maxAbs = Math.abs(g); maxSigned = g; }
    }
    return {
      ascent, descent,
      maxSlope: maxAbs,
      maxSlopeSigned: maxSigned,
      meanSlope: s[s.length - 1] > 0 ? ascent / s[s.length - 1] : 0,
    };
  }

  // ---------- 局部投影（城市尺度等距圆柱投影，米） ----------

  function projector(lon0, lat0) {
    const kx = R_EARTH * D2R * Math.cos(lat0 * D2R);
    const ky = R_EARTH * D2R;
    return {
      lon0, lat0,
      project(lon, lat) { return [(lon - lon0) * kx, (lat - lat0) * ky]; },
      unproject(x, y) { return [lon0 + x / kx, lat0 + y / ky]; },
    };
  }

  function pointSegMeter(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const L2 = dx * dx + dy * dy;
    let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx, cy = ay + t * dy;
    return { dist: Math.hypot(px - cx, py - cy), t, cx, cy };
  }

  // 点→折线最近投影。cross-bridge 正确性靠原几何逐段求交，不看包围盒距离。
  function projectToPolyline(lon, lat, coords, proj) {
    let best = null;
    let cum = 0;
    for (let i = 0; i < coords.length - 1; i++) {
      const a = proj.project(coords[i][0], coords[i][1]);
      const b = proj.project(coords[i + 1][0], coords[i + 1][1]);
      const p = proj.project(lon, lat);
      const r = pointSegMeter(p[0], p[1], a[0], a[1], b[0], b[1]);
      const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (!best || r.dist < best.distance) {
        const lonlat = proj.unproject(r.cx, r.cy);
        best = {
          distance: r.dist,
          station: cum + r.t * segLen,
          segIndex: i,
          t: r.t,
          lon: lonlat[0],
          lat: lonlat[1],
        };
      }
      cum += segLen;
    }
    return best;
  }

  // ---------- 折线 × 折线交叉（原几何） ----------

  function segIntersect(p1, p2, p3, p4) {
    const x1 = p1[0], y1 = p1[1], x2 = p2[0], y2 = p2[1];
    const x3 = p3[0], y3 = p3[1], x4 = p4[0], y4 = p4[1];
    const d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (Math.abs(d) < 1e-12) return null;
    const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / d;
    const u = ((x2 - x1) * (y1 - y3) - (y2 - y1) * (x1 - x3)) / d;
    if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
    return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1), t, u };
  }

  // 返回 [{stationA, stationB, lon, lat}]，坐标为投影米，桩号为沿原几何里程
  function polylineCrossings(coordsA, coordsB, proj) {
    const out = [];
    const pa = coordsA.map(c => proj.project(c[0], c[1]));
    const pb = coordsB.map(c => proj.project(c[0], c[1]));
    let cumA = 0;
    for (let i = 0; i < pa.length - 1; i++) {
      const a1 = pa[i], a2 = pa[i + 1];
      const la = Math.hypot(a2[0] - a1[0], a2[1] - a1[1]);
      let cumB = 0;
      for (let j = 0; j < pb.length - 1; j++) {
        const b1 = pb[j], b2 = pb[j + 1];
        const lb = Math.hypot(b2[0] - b1[0], b2[1] - b1[1]);
        const hit = segIntersect(a1, a2, b1, b2);
        if (hit) {
          const ll = proj.unproject(hit.x, hit.y);
          out.push({
            stationA: cumA + hit.t * la,
            stationB: cumB + hit.u * lb,
            lon: ll[0], lat: ll[1],
            segA: i, segB: j,
          });
        }
        cumB += lb;
      }
      cumA += la;
    }
    return out;
  }

  // ---------- 简化线（仅展示） ----------

  function douglasPeucker(coords, tolMeters, proj) {
    if (coords.length < 3) return coords.slice();
    const p = coords.map(c => proj.project(c[0], c[1]));
    const keep = new Array(coords.length).fill(false);
    keep[0] = keep[coords.length - 1] = true;
    const stack = [[0, coords.length - 1]];
    while (stack.length) {
      const [lo, hi] = stack.pop();
      let maxD = -1, idx = -1;
      const a = p[lo], b = p[hi];
      for (let k = lo + 1; k < hi; k++) {
        const d = pointSegMeter(p[k][0], p[k][1], a[0], a[1], b[0], b[1]).dist;
        if (d > maxD) { maxD = d; idx = k; }
      }
      if (maxD > tolMeters && idx > 0) {
        keep[idx] = true;
        stack.push([lo, idx], [idx, hi]);
      }
    }
    return coords.filter((_, i) => keep[i]);
  }

  // 把折线按固定里程重新采样切分（用于“预先分段索引”）
  function chunkByStation(coords, proj, chunkM) {
    const p = coords.map(c => proj.project(c[0], c[1]));
    const chunks = [];
    let cur = [p[0]];
    let curStart = 0, cum = 0;
    for (let i = 1; i < p.length; i++) {
      const segLen = Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
      let remain = segLen, start = p[i - 1];
      while (remain > 0) {
        const left = chunkM - (cum - curStart);
        if (remain + 1e-9 < left) {
          cur.push(p[i]);
          cum += remain;
          remain = 0;
        } else {
          const cut = [start[0] + (p[i][0] - start[0]) * (left / remain),
                       start[1] + (p[i][1] - start[1]) * (left / remain)];
          cur.push(cut);
          chunks.push({ from: curStart, to: curStart + left, pts: cur });
          cur = [cut];
          curStart += left;
          cum = curStart;
          start = cut;
          remain -= left;
        }
      }
    }
    if (cur.length > 1) chunks.push({ from: curStart, to: cum, pts: cur });
    return chunks;
  }

  // ---------- 时间窗 / 照明观察语义 ----------

  // schedule: {days:[1..7], start:"HH:MM", end:"HH:MM"}，可跨 0 点
  function scheduleActive(schedule, nowMs, tzMin) {
    if (!schedule) return true; // 无时段声明 = 不能判定当前有效，调用方按需处理
    const off = (tzMin == null ? TZ_OFFSET_MIN : tzMin) * 60 * 1000;
    const local = new Date(nowMs + off);
    const day = local.getUTCDay() === 0 ? 7 : local.getUTCDay(); // 周一=1
    if (schedule.days && schedule.days.length && !schedule.days.includes(day)) return false;
    const mins = local.getUTCHours() * 60 + local.getUTCMinutes();
    const [sh, sm] = schedule.start.split(':').map(Number);
    const [eh, em] = schedule.end.split(':').map(Number);
    const s = sh * 60 + sm, e = eh * 60 + em;
    return s <= e ? (mins >= s && mins < e) : (mins >= s || mins < e);
  }

  function isStale(observedAtMs, nowMs, staleMs) {
    return nowMs - observedAtMs > (staleMs == null ? STALE_LIGHTING_MS : staleMs);
  }

  /*
   * evaluateLighting：把当前时刻“有效且未过期”的夜间观察覆盖区间叠加。
   * observations: [{source:'night_visit'|'day_photo'|'report', lit:bool|null,
   *   covFrom, covTo, observedAt, schedule}]
   * 返回：
   *   status: lit | partial | dark | unknown | conflict
   *   litCoverage: 0..1（被“点亮”覆盖的长度占比）
   *   conflictRanges / evidence(可核查证据) / dayPhotoOnly / stale 标记
   */
  function evaluateLighting(lengthM, observations, nowMs, opts) {
    opts = opts || {};
    const staleMs = opts.staleMs || STALE_LIGHTING_MS;
    const active = [];
    const staleRecs = [];
    const dayPhotos = [];
    const evidence = [];

    for (const o of observations || []) {
      const from = Math.max(0, o.covFrom || 0);
      const to = Math.min(lengthM, o.covTo == null ? lengthM : o.covTo);
      if (o.source === 'day_photo') {
        dayPhotos.push({ from, to, observedAt: o.observedAt, note: o.note });
        continue; // 白天照片：绝不作为夜间点亮证据
      }
      const inWindow = scheduleActive(o.schedule, nowMs);
      const stale = isStale(o.observedAt, nowMs, staleMs);
      if (stale) staleRecs.push({ from, to, lit: o.lit, observedAt: o.observedAt });
      if (o.lit == null) continue;
      evidence.push({
        source: o.source, lit: !!o.lit, from, to,
        observedAt: o.observedAt, inWindow, stale,
        observer: o.observer, note: o.note,
      });
      if (inWindow && !stale) active.push({ from, to, lit: !!o.lit, obs: o });
    }

    // 事件扫描叠加区间
    const events = [];
    for (const a of active) {
      events.push([a.from, 1, a.lit ? 1 : 0], [a.to, -1, a.lit ? 1 : 0]);
    }
    events.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    let litLen = 0, darkLen = 0, conflictLen = 0, covered = 0;
    const conflictRanges = [];
    let prev = 0, litN = 0, darkN = 0;
    function flush(to) {
      if (to <= prev) return;
      const d = to - prev;
      if (litN || darkN) covered += d;
      if (litN && darkN) { conflictLen += d; conflictRanges.push([prev, to]); }
      else if (litN) litLen += d;
      else if (darkN) darkLen += d;
    }
    for (const [x, delta, isLit] of events) {
      flush(x);
      if (isLit) litN += delta; else darkN += delta;
      prev = x;
    }
    flush(lengthM);

    let status;
    const litCoverage = lengthM > 0 ? litLen / lengthM : 0;
    if (conflictLen > 0) status = 'conflict';
    else if (!active.length) status = 'unknown';
    else if (litCoverage >= (opts.litThreshold || 0.8)) status = 'lit';
    else if (litCoverage > 0) status = 'partial';
    else status = 'dark';

    return {
      status, litCoverage, litLength: litLen, darkLength: darkLen,
      conflictLength: conflictLen, conflictRanges,
      covered, unknownLength: lengthM - covered,
      evidence, stale: staleRecs.length > 0, staleRecords: staleRecs,
      dayPhotoOnly: dayPhotos,
      observedAtLatest: active.reduce((m, a) => Math.max(m, a.obs.observedAt || 0), 0) || null,
    };
  }

  // 补给点营业时段（可多个窗口）；windows: [{days,start,end}]
  function supplyOpen(windows, nowMs, tzMin) {
    if (!windows || !windows.length) return { open: false, reason: 'no-hours' };
    for (const w of windows) if (scheduleActive(w, nowMs, tzMin)) return { open: true, window: w };
    return { open: false, reason: 'closed' };
  }

  function fmtStation(m) {
    if (m == null) return '';
    return m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m';
  }

  return {
    R_EARTH, R2D, TZ_OFFSET_MIN, STALE_LIGHTING_MS,
    haversine, stations, polylineLength, bbox, slopeProfile,
    projector, pointSegMeter, projectToPolyline,
    segIntersect, polylineCrossings,
    douglasPeucker, chunkByStation,
    scheduleActive, isStale, evaluateLighting, supplyOpen,
    fmtStation,
  };
});
