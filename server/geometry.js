'use strict';
/**
 * 几何引擎（二维局部“米坐标系” + 高程 z）。
 *
 * 约定：
 * - 种子数据坐标是虚构城市局部坐标，单位即米，无需投影换算（边界已在种子文档说明）。
 * - 距离、坡度、交叉点一律从【原几何】计算；simplify() 的产物只允许给渲染层使用。
 * - 所有折线在计算前 densify 到 <=5m，保证跨河多边形与坡度窗口不被长线段漏检。
 */

const DENSIFY_STEP_M = 5;

/** 两点欧氏距离（米） */
function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 折线累计长度（米） */
function polylineLength(pts) {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += dist(pts[i - 1], pts[i]);
  return total;
}

/**
 * 沿折线把长于 step 的线段切开，并对每一点线性插值高程。
 * 输入点可带 z（米），未提供则为 0。
 */
function densify(pts, step = DENSIFY_STEP_M) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (i === 0) {
      out.push({ x: p.x, y: p.y, z: p.z || 0 });
      continue;
    }
    const a = out[out.length - 1];
    const b = { x: p.x, y: p.y, z: p.z || 0 };
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(segLen / step));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      out.push({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        z: a.z + (b.z - a.z) * t,
      });
    }
  }
  return out;
}

/** Ramer-Douglas-Peucker，仅供展示缩放；不参与任何距离/坡度/判断计算 */
function simplify(pts, toleranceM) {
  if (pts.length < 3) return pts.slice();
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxD = -1;
    let index = -1;
    const a = pts[first];
    const b = pts[last];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    for (let i = first + 1; i < last; i++) {
      let d;
      if (len2 === 0) d = Math.hypot(pts[i].x - a.x, pts[i].y - a.y);
      else {
        const t = Math.max(0, Math.min(1, ((pts[i].x - a.x) * dx + (pts[i].y - a.y) * dy) / len2));
        d = Math.hypot(pts[i].x - (a.x + t * dx), pts[i].y - (a.y + t * dy));
      }
      if (d > maxD) {
        maxD = d;
        index = i;
      }
    }
    if (maxD > toleranceM && index > 0) {
      keep[index] = true;
      stack.push([first, index], [index, last]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** 包围盒 + 边距 */
function bbox(pts, pad = 0) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

function bboxesOverlap(a, b) {
  return !(a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY);
}

/**
 * 最大坡度（爬升米 / 水平米），窗口 >=windowM（默认 50m）取最大值。
 * 从 densify 后的原几何计算，避免稀疏折线导致的坡度失真。
 */
function maxGrade(pts, windowM = 50) {
  let worst = 0;
  let j = 0;
  let horiz = 0;
  let climb = 0;
  for (let i = 1; i < pts.length; i++) {
    horiz += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    climb += pts[i].z - pts[i - 1].z;
    while (horiz > windowM && j < i - 1) {
      horiz -= Math.hypot(pts[j + 1].x - pts[j].x, pts[j + 1].y - pts[j].y);
      climb -= pts[j + 1].z - pts[j].z;
      j++;
    }
    if (horiz >= windowM * 0.8) {
      const g = Math.abs(climb) / horiz;
      if (g > worst) worst = g;
    }
  }
  return worst;
}

/** 把折线按约 segLen 米定长切段，记录 cumStart/cumEnd 与中点；从 densify 原几何切。
 * 注意：新段与上一段共享边界点 pts[i]，chunk = pts.slice(i0, i+1) 的全局里程
 * 起点是 i0 处的累计长度（chunkAt0），不是“上一段闭合时的 cum”——两者差一个边。 */
function splitFixed(pts, segLen = 100) {
  const segs = [];
  let cum = 0;           // 到 pts[i] 的全局累计
  let chunkAt0 = 0;      // 当前段首点 pts[i0] 的全局累计
  let i0 = 0;
  const flush = (i) => {
    const chunk = pts.slice(i0, i + 1);
    segs.push({
      segIndex: segs.length,
      i0, i1: i,
      cumStart: chunkAt0,
      cumEnd: cum,
      mid: chunk[Math.floor(chunk.length / 2)],
      bbox: bbox(chunk, 2),
      points: chunk,
    });
  };
  for (let i = 1; i < pts.length; i++) {
    cum += dist(pts[i - 1], pts[i]);
    if (cum - chunkAt0 >= segLen || i === pts.length - 1) {
      flush(i);
      chunkAt0 = cum;   // 下一段首点 pts[i] 的全局累计
      i0 = i;
    }
  }
  return segs;
}

/** 两线段是否相交（含端点），返回交点或 null */
function segmentIntersection(p1, p2, p3, p4) {
  const r = { x: p2.x - p1.x, y: p2.y - p1.y };
  const s = { x: p4.x - p3.x, y: p4.y - p3.y };
  const denom = r.x * s.y - r.y * s.x;
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((p3.x - p1.x) * s.y - (p3.y - p1.y) * s.x) / denom;
  const u = ((p3.x - p1.x) * r.y - (p3.y - p1.y) * r.x) / denom;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return { x: p1.x + t * r.x, y: p1.y + t * r.y };
}

/**
 * 两条折线的全部交叉点（densify 之后逐段求交）。
 * 去重网格 2m。返回 [{x,y,fromA,atM(距A起点米)}]
 */
function polylineCrossings(ptsA, ptsB) {
  const hits = [];
  const seen = new Set();
  let cumA = 0;
  for (let i = 0; i < ptsA.length - 1; i++) {
    const a0 = ptsA[i], a1 = ptsA[i + 1];
    for (let j = 0; j < ptsB.length - 1; j++) {
      const hit = segmentIntersection(a0, a1, ptsB[j], ptsB[j + 1]);
      if (hit) {
        const key = Math.round(hit.x / 2) + ':' + Math.round(hit.y / 2);
        if (!seen.has(key)) {
          seen.add(key);
          const t = Math.hypot(hit.x - a0.x, hit.y - a0.y) / Math.max(1e-9, dist(a0, a1));
          hits.push({ x: hit.x, y: hit.y, atM: cumA + t * dist(a0, a1) });
        }
      }
    }
    cumA += dist(a0, a1);
  }
  return hits;
}

/** 点到线段的最近信息 {d, cx, cy, t} */
function pointSegInfo(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * dx, cy = a.y + t * dy;
  return { d: Math.hypot(p.x - cx, p.y - cy), cx, cy, t };
}

/** 点到折线最近点 {d, atM, x, y, edgeIndex} */
function nearestOnPolyline(p, pts) {
  let best = { d: Infinity };
  let cum = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const info = pointSegInfo(p, pts[i], pts[i + 1]);
    if (info.d < best.d) {
      best = { d: info.d, atM: cum + info.t * dist(pts[i], pts[i + 1]), x: info.cx, y: info.cy, edgeIndex: i };
    }
    cum += dist(pts[i], pts[i + 1]);
  }
  return best;
}

/** 点是否在（凸/凹）多边形内，射线法 */
function pointInPolygon(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i];
    if ((b.y > p.y) !== (a.y > p.y) && p.x < ((a.x - b.x) * (p.y - b.y)) / (a.y - b.y) + b.x) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * GPS 点吸附到候选路线（“跨桥投影”核心）。
 *
 * 背景：河面宽，GPS 有横向误差，直接对每条路线做最近点投影时，
 * GPS 漂在河面上会错误吸到河岸步道（连线跨河），而桥才是合法跨越。
 *
 * 规则：
 * 1. 候选边来自请求给定的候选路线（先经粗半径过滤）；
 * 2. 非桥边：若 GPS->垂足 的直线与河流多边形发生“穿越”（进/出奇数交点），拒绝；
 * 3. 桥边（bridge=true）：允许跨河；若 GPS 本身落在河内，仅允许桥边；
 * 4. 精度 accuracy 放宽判定半径，超过阈值的低精度位置直接给出 unconfident；
 * 5. 平局时桥优先（桥上 GPS 同时离桥与引道近）。
 */
function snapToRoutes(p, candidates, river, opts = {}) {
  const accuracy = opts.accuracy || 15;
  const maxSnap = opts.maxSnap != null ? opts.maxSnap : 30 + accuracy * 2; // 米
  const gpsInRiver = pointInPolygon(p, river);
  const ranked = [];

  for (const cand of candidates) {
    const pts = cand.points; // densify 原几何
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const info = pointSegInfo(p, a, b);
      if (info.d > maxSnap) continue;
      const isBridge = !!a.bridge || !!b.bridge;
      let status = 'ok';
      if (gpsInRiver && !isBridge) status = 'reject-in-river';
      else if (!isBridge && crossesPolygon(p, { x: info.cx, y: info.cy }, river)) {
        status = 'reject-crosses-river';
      }
      ranked.push({
        routeId: cand.routeId,
        edgeIndex: i,
        d: info.d,
        atM: cand.cumBefore + edgeCum(pts, i) + info.t * dist(a, b),
        x: info.cx,
        y: info.cy,
        bridge: isBridge,
        status,
      });
    }
  }

  const usable = ranked
    .filter((r) => r.status === 'ok')
    .sort((u, v) => (u.d - v.d) || (v.bridge - u.bridge));
  const rejected = ranked.filter((r) => r.status !== 'ok');
  const best = usable[0] || null;
  return {
    match: best,
    unconfident: best ? best.d > 20 + accuracy : true,
    rejected: rejected.map((r) => ({ routeId: r.routeId, edgeIndex: r.edgeIndex, d: r.d, reason: r.status })),
    maxSnap,
    gpsInRiver,
  };
}

function edgeCum(pts, i) {
  let cum = 0;
  for (let k = 0; k < i; k++) cum += dist(pts[k], pts[k + 1]);
  return cum;
}

/**
 * 线段 p->q 是否“穿过”多边形环：与环相交且非贴边。
 * 用交点数奇偶 + 端点内外判断：一个端点在内一个在外，或与环有 2 个以上穿越交点。
 */
function crossesPolygon(p, q, ring) {
  let crossings = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const hit = segmentIntersection(p, q, a, b);
    if (hit) crossings++;
  }
  const pin = pointInPolygon(p, ring);
  const qin = pointInPolygon(q, ring);
  return pin !== qin || crossings >= 2;
}

module.exports = {
  DENSIFY_STEP_M,
  dist,
  polylineLength,
  densify,
  simplify,
  bbox,
  bboxesOverlap,
  maxGrade,
  splitFixed,
  segmentIntersection,
  polylineCrossings,
  pointSegInfo,
  nearestOnPolyline,
  pointInPolygon,
  crossesPolygon,
  snapToRoutes,
};
