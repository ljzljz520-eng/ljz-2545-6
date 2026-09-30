'use strict';
/**
 * 照明与补给判定。
 *
 * 立场（需求核心）：
 * - “照明良好”是一条【夜间实地观察】：必须 nightVisit=true 且 photo==='night'，
 *   带访问时间与覆盖范围。白天照片（photo==='day'）只能证明“灯柱存在”，
 *   不能当夜间亮灯保证 —— 它们单独计数展示，不进入 lit 比例。
 * - 观察会过期：超过 STALE_DAYS 的夜间观察，覆盖段标记 stale（旧证据，不是当前保证）。
 * - 互相冲突的观察（同一段近期记录一亮一黑）不取平均、不藏起，标记 conflict 待复核。
 */

const DAY_MS = 86400000;
const STALE_DAYS = 14;
const CONFLICT_GAP = 0.5; // lit coverage 与 dark coverage 相差 >=0.5 视为冲突
const SAMPLE_M = 50;

/**
 * 从时间字符串/Date 构造“当地墙上时间” {date, dow(0=Mon), hm}。
 * 直接解析 ISO 的年月日时分，避免运行环境时区（容器常为 UTC）改变补给时段判断。
 */
function wallTime(input) {
  if (input && typeof input === 'object' && 'hm' in input && 'dow' in input) return input;
  let y, mo, d, hh, mi, str;
  const m = !(input instanceof Date) ? String(input || '').match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/) : null;
  if (m) {
    str = String(input);
    [, y, mo, d, hh, mi] = m.map(Number);
  } else {
    const n = input instanceof Date ? input : new Date();
    // 兜底：按 Asia/Shanghai 取当地时间
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(n);
    const get = (t) => Number(parts.find((x) => x.type === t).value);
    y = get('year'); mo = get('month'); d = get('day'); hh = get('hour') % 24; mi = get('minute');
  }
  const dow = (new Date(Date.UTC(y, mo - 1, d)).getUTCDay() + 6) % 7;
  return { date: y + '-' + mo + '-' + d + ' ' + hh + ':' + mi, dow, hm: hh * 60 + mi, year: y, month: mo, day: d };
}

function parseHours(hours, now = new Date()) {
  // 返回 {open, reason}；now 可为 Date / ISO 字符串 / wallTime
  const h = String(hours || '').trim();
  const wall = wallTime(now);
  const isWeekend = wall.dow >= 5;

  if (/^24h$/i.test(h)) return { open: true, rule: '24h' };

  const windows = h.split(';').map((w) => w.trim()).filter(Boolean);
  const weekdayKeys = ['mo-fr', 'mon-fri', 'weekday', 'weekdays', '工作日'];
  const weekendKeys = ['sa-su', 'sat-sun', 'weekend', 'weekends', '周末'];
  for (const w of windows) {
    const m = w.match(/^([A-Za-z\-一-龥]*)\s*(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
    if (!m) continue;
    const prefix = (m[1] || '').trim().toLowerCase();
    const applies = prefix === ''
      || (!isWeekend && weekdayKeys.includes(prefix))
      || (isWeekend && weekendKeys.includes(prefix));
    if (!applies) continue;
    const openHm = +m[2] * 60 + +m[3];
    const closeHm = +m[4] * 60 + +m[5];
    return { open: wall.hm >= openHm && wall.hm < closeHm, rule: w };
  }
  return { open: false, rule: h, reason: 'unknown-schedule' };
}

function ageDays(visitedAt, now) {
  const t = Date.parse(visitedAt);
  if (Number.isNaN(t)) return Infinity;
  return (now.getTime() - t) / DAY_MS;
}

/**
 * 计算路线照明摘要。
 * obs 已按 routeId 过滤。返回：
 * { litRatio, darkRatio, staleRatio, unknownRatio, conflict, conflictSegments,
 *   dayOnlyCount, dayOnly:[{id,...}], evidence:[...], latestAt, oldestAt }
 */
function lightingSummary(routeLengthM, obs, now = new Date()) {
  const lightObs = obs.filter((o) => o.kind === 'lighting');
  const night = lightObs.filter((o) => o.nightVisit && o.photo === 'night');
  const dayOnly = lightObs.filter((o) => !(o.nightVisit && o.photo === 'night'));

  const n = Math.max(1, Math.round(routeLengthM / SAMPLE_M));
  const samples = new Array(n).fill(null); // 每段放最新有效（夜间）观察
  for (const o of night) {
    const age = ageDays(o.visitedAt, now);
    const i0 = Math.max(0, Math.floor((o.cumStart || 0) / SAMPLE_M));
    const i1 = Math.min(n - 1, Math.floor((o.cumEnd ?? routeLengthM) / SAMPLE_M));
    for (let i = i0; i <= i1; i++) {
      const cur = samples[i];
      if (!cur || Date.parse(o.visitedAt) > Date.parse(cur.visitedAt)) {
        samples[i] = o;
      }
    }
  }

  // 冲突：同一 50m 段内存在时间窗 STALE_DAYS 内、结论相反且覆盖差 >=0.5 的两条记录
  const conflictSample = new Array(n).fill(false);
  const conflictPairs = [];
  for (let i = 0; i < n; i++) {
    const i0 = i * SAMPLE_M;
    const i1 = i0 + SAMPLE_M;
    const here = night.filter((o) =>
      ageDays(o.visitedAt, now) <= STALE_DAYS &&
      (o.cumStart || 0) < i1 && (o.cumEnd ?? routeLengthM) > i0);
    const lits = here.filter((o) => o.status === 'lit');
    const darks = here.filter((o) => o.status === 'dark');
    if (lits.length && darks.length) {
      const litCov = Math.max(...lits.map((o) => o.coverage || 0));
      const darkCov = Math.max(...darks.map((o) => o.coverage || 0));
      if (Math.abs(litCov - darkCov) >= CONFLICT_GAP) {
        conflictSample[i] = true;
        for (const d of darks) conflictPairs.push({ litId: lits[0].id, darkId: d.id, atM: i0 + SAMPLE_M / 2 });
      }
    }
  }

  let lit = 0, dark = 0, stale = 0, unknown = 0, conflict = 0;
  for (let i = 0; i < n; i++) {
    if (conflictSample[i]) { conflict++; continue; }
    const o = samples[i];
    if (!o) { unknown++; continue; }
    const age = ageDays(o.visitedAt, now);
    if (age > STALE_DAYS) { stale++; continue; }
    if (o.status === 'lit') lit++;
    else if (o.status === 'dark') dark++;
    else unknown++;
  }

  const dated = night.map((o) => Date.parse(o.visitedAt)).filter(Number.isFinite);
  return {
    sampledAt: now.toISOString(),
    sampleM: SAMPLE_M,
    staleDays: STALE_DAYS,
    litRatio: lit / n,
    darkRatio: dark / n,
    staleRatio: stale / n,
    unknownRatio: unknown / n,
    conflictRatio: conflict / n,
    conflictPairs: conflictPairs.slice(0, 6),
    hasConflict: conflict > 0,
    dayOnlyCount: dayOnly.length,
    dayOnly: dayOnly.map((o) => ({ id: o.id, visitedAt: o.visitedAt, comment: o.comment || '' })),
    evidenceCount: night.length,
    latestAt: dated.length ? new Date(Math.max(...dated)).toISOString() : null,
    oldestAt: dated.length ? new Date(Math.min(...dated)).toISOString() : null,
  };
}

/** 当前补给窗口（沿路线关联点 + 此刻是否开放） */
function supplyWindow(exits, supplies, now) {
  return exits.map((e) => {
    const s = supplies.get(e.supplyId);
    const h = parseHours(s ? s.hours : '', now);
    return {
      exitId: e.id,
      name: e.name,
      atM: e.atM,
      dM: e.dM,
      x: e.x,
      y: e.y,
      water: !!(s && s.water),
      hours: s ? s.hours : '',
      openNow: h.open,
      note: s && s.note ? s.note : null,
      reason: h.reason || null,
    };
  });
}

/** 筛选：此刻是否存在开放补给（退出点半径内） */
function hasOpenSupply(exits, supplies, now) {
  return supplyWindow(exits, supplies, now).some((s) => s.openNow);
}

module.exports = {
  STALE_DAYS,
  SAMPLE_M,
  parseHours,
  lightingSummary,
  supplyWindow,
  hasOpenSupply,
  ageDays,
};
