'use strict';
/* 潼川夜跑前端主控。 */
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

const state = {
  routes: [],
  now: null,
  filters: { maxKm: 8, maxGradePct: 8, lit: false, supplyNow: false },
  selectedId: null,
  loc: null,
  mapPayload: null,
};

// ---------- 工具 ----------
function pct(v) { return Math.round(v * 100); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function lightBadge(r) {
  const L = r.lighting;
  if (L.hasConflict) return '<span class="badge bad">照明记录冲突 · 待复核</span>';
  if (pct(L.litRatio) >= 80 && !L.hasConflict) return `<span class="badge good">近期夜间亮灯 ${pct(L.litRatio)}%</span>`;
  if (L.darkRatio > 0.3) return `<span class="badge bad">有记录“不亮” ${pct(L.darkRatio)}%</span>`;
  if (L.staleRatio > 0.3) return `<span class="badge warn">照明证据过期 ${pct(L.staleRatio)}%</span>`;
  return `<span class="badge">照明证据不足 ${pct(L.litRatio)}%</span>`;
}

// ---------- 拉取列表 ----------
async function fetchRoutes() {
  const list = $('#routeList');
  list.innerHTML = '<li class="route-sub">加载中…</li>';
  const f = state.filters;
  const q = new URLSearchParams();
  q.set('maxKm', f.maxKm);
  if (f.maxGradePct !== 20) q.set('maxGradePct', f.maxGradePct);
  if (f.lit) q.set('lit', '1');
  if (f.supplyNow) q.set('supplyNow', '1');
  try {
    const { data } = await NR.req('GET', '/api/routes?' + q.toString());
    state.routes = data.routes;
    state.now = data.now;
    renderStaleBanner(data.routes);
    renderList(data.routes);
    ensureMapPayload(data.routes);
  } catch (e) {
    list.innerHTML = '<li class="route-sub">列表加载失败：' + esc(e.message) + '。网络恢复后会自动重试。</li>';
    document.addEventListener('online', function one() { document.removeEventListener('online', one); fetchRoutes(); }, { once: true });
  }
}

function renderStaleBanner(routes) {
  const b = $('#staleBanner');
  const rows = [];
  for (const r of routes) {
    if (r.lighting.hasConflict) rows.push(`「${r.name}」存在互相矛盾的照明记录（未平均、未隐藏）`);
    else if (r.lighting.staleRatio > 0.3) rows.push(`「${r.name}」${pct(r.lighting.staleRatio)}% 路段的夜间照明证据已超 14 天`);
    if (r.lighting.dayOnlyCount > 0 && r.lighting.evidenceCount === 0) rows.push(`「${r.name}」只有白天照片，不能当作夜间照明保证`);
  }
  if (rows.length) { b.hidden = false; b.innerHTML = '⚠ 数据时效提示：' + rows.slice(0, 3).map(esc).join('；') + '。'; }
  else b.hidden = true;
}

function renderList(routes) {
  const list = $('#routeList');
  list.innerHTML = '';
  for (const r of routes) {
    const li = document.createElement('li');
    const openCount = r.supplies.filter((s) => s.openNow).length;
    const dim = r.match ? '' : ' dim';
    const failBits = [];
    if (!r.passes.distance) failBits.push('超距离');
    if (!r.passes.grade) failBits.push('超坡度');
    if (!r.passes.lighting) failBits.push('照明不满足');
    if (!r.passes.supply) failBits.push('无营业补给');
    if (!r.passes.archived) failBits.push('已归档');
    li.innerHTML = `
      <button class="route-card${dim}" data-id="${r.id}" type="button" aria-label="查看 ${esc(r.name)} 详情">
        <div class="route-top">
          <span class="route-name">${esc(r.name)}${r.status === 'archived' ? ' <span class="badge">已归档</span>' : ''}</span>
          <span class="route-dist">${(r.lengthM / 1000).toFixed(2)} km</span>
        </div>
        <div class="badges">
          ${lightBadge(r)}
          <span class="badge ${r.gradeMaxPct <= state.filters.maxGradePct ? 'info' : 'bad'}">最大坡度 ${r.gradeMaxPct.toFixed(1)}%</span>
          <span class="badge ${openCount ? 'good' : ''}">营业补给 ${openCount}/${r.supplies.length}</span>
          <span class="badge">交叉点 ${r.crossingCount}</span>
        </div>
        <div class="route-sub">${r.match ? '符合当前筛选' : '<span class="x">不符合：</span>' + failBits.map(esc).join('、')} · 路面 ${esc(r.surface)}</div>
        ${r.status === 'archived' ? `<div class="archive-note">该路线已归档（${esc(r.archivedAt || '')}），收藏仍可保留查看；维护者标注由 <b>${esc(r.supersededBy || '—')}</b> 接续。</div>` : ''}
      </button>`;
    list.appendChild(li);
  }
  if (!routes.length) list.innerHTML = '<li class="route-sub">没有符合条件的路线。</li>';
}

// ---------- 详情抽屉 ----------
$('#routeList').addEventListener('click', async (e) => {
  const card = e.target.closest('.route-card');
  if (!card) return;
  await openSheet(card.dataset.id);
});

async function openSheet(id) {
  const body = $('#sheetBody');
  body.innerHTML = '<p class="route-sub">加载路线详情（原几何距离/坡度/交叉点）…</p>';
  $('#sheet').hidden = false;
  const out = await NR.getRoute(id);
  if (out.notModified && out.cached) {
    body.innerHTML = '<p class="route-sub">观察与公共注意未变化（ETag 304），展示上次拉取的详情（' + fmtTime(out.cached.fetchedAt) + '）。</p>';
    return renderSheetBody(id, out.cached.route, true);
  }
  if (out.offline) {
    if (out.cached) {
      body.innerHTML = '<p class="route-sub">离线：以下是 <b>' + fmtTime(out.cached.fetchedAt) + '</b> 缓存的详情，照明/营业状态可能已过期，不作为当前保证。</p>';
      return renderSheetBody(id, out.cached.route, true);
    }
    body.innerHTML = '<p class="route-sub">离线且本机没有此路线缓存。网络恢复后可查看；照明等信息不会用陈旧数据冒充最新。</p>';
    return;
  }
  const r = out.data.route;
  const idx = state.routes.findIndex((x) => x.id === id);
  if (idx >= 0) state.routes[idx] = { ...state.routes[idx], ...r };
  renderSheetBody(id, r, false);
}

function renderSheetBody(id, r, fromCache) {
  const body = $('#sheetBody');
  const L = r.lighting;
  const exits = (r.supplies || []).map((s) => `
    <div class="exit-row">
      <span>${esc(s.name)} <span class="badge ${s.openNow ? 'good' : ''}">${s.openNow ? '现在营业' : '已关门'}</span>${s.water ? ' <span class="badge info">饮水</span>' : ''}</span>
      <span class="route-sub">${(s.atM / 1000).toFixed(2)}km 处 · 距线 ${s.dM}m<br>${esc(s.hours)}${s.note ? '<br>' + esc(s.note) : ''}</span>
    </div>`).join('');

  const notices = (r.notices || []).map((n) => `
    <div class="notice-box"><b>${n.kind === 'hazard' ? '危险/注意' : '通行'}（公共注意 v${n.version}）</b><br>${esc(n.text)}<br><span class="route-sub">${esc(n.updatedBy)} · ${fmtTime(n.updatedAt)}</span></div>`).join('') || '<p class="route-sub">暂无公共注意。</p>';

  const conflicts = (L.conflictPairs || []).map((c) =>
    `<div class="conflict-strip">${Math.round(c.atM)}m 处：观察 ${esc(c.litId)} 说“亮”、${esc(c.darkId)} 说“不亮”。两条都保留，等待夜间复核，不取平均。</div>`).join('');

  const dayBits = (L.dayOnly || []).map((o) => `<li class="day">${esc(o.id)} · 白天记录（${fmtTime(o.visitedAt)}）— ${esc(o.comment || '未验证夜间')}，<b>不计入亮灯比例</b></li>`).join('');

  const allObs = r.observations || [];
  const nightRows = allObs.filter((o) => o.kind === 'lighting' && o.nightVisit && o.photo === 'night')
    .map((o) => `<li>${esc(o.id)} · ${Math.round(o.cumStart)}-${Math.round(o.cumEnd)}m · ${o.status === 'lit' ? '亮' : '不亮'}（覆盖 ${Math.round((o.coverage || 0) * 100)}%）· ${fmtTime(o.visitedAt)} · ${esc(o.observer || '')}${o.comment ? ' · ' + esc(o.comment) : ''}</li>`).join('');
  const surfaceRows = allObs.filter((o) => o.kind !== 'lighting')
    .map((o) => `<li>${esc(o.id)} · ${Math.round(o.cumStart)}-${Math.round(o.cumEnd)}m · ${esc(o.status)} · ${fmtTime(o.visitedAt)}${o.comment ? ' · ' + esc(o.comment) : ''}</li>`).join('');

  body.innerHTML = `
    <h2 id="sheetTitle">${esc(r.name)} ${r.status === 'archived' ? '<span class="badge">已归档</span>' : ''}</h2>
    <p class="route-sub">${esc(r.surface)} · ${r.closed ? '环线' : '单程'} ${fromCache ? '· 数据指纹未变化' : ''}</p>
    <div class="stat-grid">
      <div class="stat"><div class="k">距离（原几何）</div><div class="v">${(r.lengthM / 1000).toFixed(2)} km</div></div>
      <div class="stat"><div class="k">最大坡度（50m窗口）</div><div class="v">${r.gradeMaxPct.toFixed(1)}%</div></div>
      <div class="stat"><div class="k">与其他路线交叉点</div><div class="v">${r.crossingCount}</div></div>
      <div class="stat"><div class="k">照明证据（夜间记录）</div><div class="v">${L.evidenceCount} 条</div></div>
    </div>
    <div class="sec-title">照明（仅统计夜间实地观察，窗口 ${L.staleDays} 天）</div>
    <div class="badges">
      <span class="badge good">亮 ${pct(L.litRatio)}%</span>
      <span class="badge bad">暗 ${pct(L.darkRatio)}%</span>
      <span class="badge warn">过期 ${pct(L.staleRatio)}%</span>
      <span class="badge">无近期证据 ${pct(L.unknownRatio)}%</span>
      ${L.hasConflict ? '<span class="badge bad">冲突 ' + pct(L.conflictRatio) + '%</span>' : ''}
    </div>
    <p class="route-sub">最近夜间观察：${fmtTime(L.latestAt)}；采样点距 ${L.sampleM}m。</p>
    ${conflicts}
    ${dayBits ? `<div class="sec-title">白天记录（仅证明灯柱存在，不作夜间保证）</div><ul class="evidence-list">${dayBits}</ul>` : ''}
    ${nightRows ? `<div class="sec-title">夜间观察证据（可逐条核查）</div><ul class="evidence-list">${nightRows}</ul>` : ''}
    ${surfaceRows ? `<div class="sec-title">路面/其他观察</div><ul class="evidence-list">${surfaceRows}</ul>` : ''}
    <div class="sec-title">补给与退出点（按当前时刻）</div>
    ${exits || '<p class="route-sub">无关联补给点。</p>'}
    <div class="sec-title">公共注意（独立维护，集合同步不会覆盖）</div>
    ${notices}
    <div class="sec-title">交叉路线位置</div>
    <p class="route-sub">${(r.crossings || []).map((c) => `${esc(c.routeId)}@${Math.round(c.atM)}m`).join('、') || '无'}</p>
    <div class="foot-note">
      以上距离、坡度、交叉点均由服务器在加密后的<b>原几何</b>上计算；地图上看到的是简化显示线，不作为这些数字的依据。<br>
      本站<b>不承诺该路线安全</b>。
    </div>
    <div style="display:flex;gap:8px;margin-top:10px">
      <button class="btn primary" id="btnFav" type="button">收藏到我的集合（可离线）</button>
      <button class="btn" id="btnLocateFrom" type="button">在地图上定位这条线</button>
    </div>`;

  $('#btnFav').onclick = () => {
    NR.applyLocal({ type: 'addFav', routeId: id, name: r.name });
    $('#btnFav').textContent = '已加入待同步收藏 ✓';
    renderKit();
  };
  $('#btnLocateFrom').onclick = () => { switchTab('map'); state.selectedId = id; drawMap(); };
}

$('#sheetClose').onclick = () => { $('#sheet').hidden = true; };
$('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') $('#sheet').hidden = true; });

// ---------- 筛选交互 ----------
function bindFilters() {
  const km = $('#fMaxKm'), gr = $('#fMaxGrade');
  km.addEventListener('input', () => { $('#fMaxKmVal').textContent = km.value; state.filters.maxKm = +km.value; });
  gr.addEventListener('input', () => { $('#fMaxGradeVal').textContent = gr.value; state.filters.maxGradePct = +gr.value; });
  $('#fLit').addEventListener('change', (e) => { state.filters.lit = e.target.checked; });
  $('#fSupply').addEventListener('change', (e) => { state.filters.supplyNow = e.target.checked; });
  $('#btnApply').addEventListener('click', fetchRoutes);
  $('#btnReset').addEventListener('click', () => {
    km.value = 8; gr.value = 8; $('#fMaxKmVal').textContent = 8; $('#fMaxGradeVal').textContent = 8;
    $('#fLit').checked = false; $('#fSupply').checked = false;
    state.filters = { maxKm: 8, maxGradePct: 8, lit: false, supplyNow: false };
    fetchRoutes();
  });
}

// ---------- 地图 ----------
async function ensureMapPayload(routesArg) {
  const routes = routesArg || state.routes;
  // 需要桥梁/河/补给几何；从健康检查之外拿不到，改用内置镜像（随列表接口附带最优）。
  // 这里复用列表数据，另发一次 spatial 上下文成本高，因此桥河信息走 window.SEED_META（由 /api/map-meta 注入）。
  if (!state.mapPayload) {
    try {
      const { data } = await NR.req('GET', '/api/map-meta');
      state.mapPayload = { river: data.river, bridges: data.bridges, supplies: data.supplies };
    } catch (e) { state.mapPayload = { river: null, bridges: [], supplies: [] }; }
  }
  state.mapPayload.routes = routes;
  drawMap();
}

function drawMap() {
  if (!state.mapPayload || !state.mapPayload.routes || !state.mapPayload.routes.length) return;
  const opts = { selectedId: state.selectedId, loc: state.loc };
  const sel = state.routes.find((r) => r.id === state.selectedId);
  if (sel && Array.isArray(sel.supplies)) opts.exits = sel.supplies;
  if (state.matched) opts.matched = state.matched;
  NRMap.render($('#map'), state.mapPayload, opts);
}

function setLocStatus(html, tone) {
  const n = $('#locStatus');
  n.innerHTML = html;
  n.style.color = tone === 'bad' ? 'var(--bad)' : tone === 'good' ? 'var(--good)' : 'var(--muted)';
}

function locateMe() {
  if (!navigator.geolocation) {
    setLocStatus('此浏览器不支持定位。请展开下方“手动入口”，直接输入坐标。', 'bad');
    $('#manualEntry').open = true;
    return;
  }
  setLocStatus('正在请求定位权限…');
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      // 原型城市为局部米坐标：真实部署此处做投影转换；这里用固定偏移模拟
      const x = Math.round(pos.coords.latitude * 1000) % 2400;
      const y = Math.round(pos.coords.longitude * 100) % 400 - 200;
      state.loc = { x, y, accuracy: pos.coords.accuracy || 15 };
      setLocStatus(`已定位（原型偏移坐标 ${x}, ${y}，精度约 ${Math.round(state.loc.accuracy)}m）。正在做跨桥感知吸附…`, 'good');
      await runSnap(state.loc);
    },
    (err) => {
      const map = {
        1: '定位权限被拒绝。你可以随时用下方<b>手动入口</b>输入坐标，不依赖系统定位。',
        2: '位置不可用（信号/设备）。建议手动输入或稍后重试。',
        3: '定位请求超时。可重试或手动输入。',
      };
      setLocStatus(map[err.code] || '定位失败。', 'bad');
      $('#manualEntry').open = true;
    },
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 10000 }
  );
}

async function runSnap(loc) {
  try {
    const { data } = await NR.snap({ x: loc.x, y: loc.y, accuracy: loc.accuracy, radius: 120 });
    if (!data.match) {
      setLocStatus(`附近 ${data.maxSnap}m 内没有可吸附的路线（河面点只允许吸到桥上）。可调整位置或手动输入。`, 'bad');
      state.matched = null;
    } else {
      state.matched = data.match;
      const rej = data.rejected.length;
      setLocStatus(
        `吸附到 <b>${esc(data.match.routeId)}</b> ${Math.round(data.match.atM)}m 处${data.match.bridge ? '（桥上）' : ''}，距离 ${data.match.distanceM}m。` +
        (data.unconfident ? ' <b style="color:var(--warn)">位置精度较差，结果不肯定。</b>' : '') +
        (rej ? ` 已拒绝 ${rej} 条会“跨河投影”的岸边候选。` : ''),
        data.unconfident ? 'bad' : 'good');
    }
    drawMap();
  } catch (e) {
    setLocStatus('吸附请求失败（' + esc(e.message) + '）。离线时定位结果仅本地显示，不会上传。', 'bad');
  }
}

async function compareSpatial() {
  const box = $('#spatialResult');
  box.hidden = false;
  const p = state.loc || { x: 300, y: 0 };
  box.innerHTML = '正在分别用【分段索引】与【实时求交】查询…';
  try {
    const [a, b] = await Promise.all([
      NR.spatialQuery({ x: p.x, y: p.y, radius: 200, mode: 'index' }),
      NR.spatialQuery({ x: p.x, y: p.y, radius: 200, mode: 'realtime' }),
    ]);
    const same = JSON.stringify(a.data.results.map((r) => r.routeId + ':' + r.atM).sort()) ===
      JSON.stringify(b.data.results.map((r) => r.routeId + ':' + r.atM).sort());
    box.innerHTML = `
      <div class="spatial-grid">
        <div class="spatial-cell"><h4>预先分段索引（250m 网格 + 100m 段）</h4>
          <table>
            <tr><td>耗时</td><td>${a.data.timing.microseconds} µs</td></tr>
            <tr><td>网格单元</td><td>${a.data.timing.gridCells}</td></tr>
            <tr><td>候选段</td><td>${a.data.timing.candidateSegments}</td></tr>
            <tr><td>扫描边</td><td>${a.data.timing.edgesScanned}</td></tr>
            <tr><td>命中</td><td>${a.data.results.length} 条路线</td></tr>
          </table>
        </div>
        <div class="spatial-cell"><h4>实时空间求交（遍历原几何）</h4>
          <table>
            <tr><td>耗时</td><td>${b.data.timing.microseconds} µs</td></tr>
            <tr><td>扫描边</td><td>${b.data.timing.edgesScanned}</td></tr>
            <tr><td>命中</td><td>${b.data.results.length} 条路线</td></tr>
          </table>
        </div>
      </div>
      <p class="match-equal">${same ? '✓ 两模式命中路线与里程完全一致（距离都在原几何上算，索引只负责裁剪）' : '⚠ 两模式结果不同，应以实时原几何结果为准排查索引'}</p>
      <p class="route-sub">命中：${a.data.results.map((r) => `${r.routeId}@${r.atM}m${r.bridge ? '(桥)' : ''} ${r.distanceM}m`).join('，')}</p>`;
  } catch (e) {
    box.innerHTML = '查询失败：' + esc(e.message);
  }
}

// ---------- 集合页 ----------
function renderKit() {
  const doc = NR.localCollection();
  const outbox = NR.getOutbox();
  $('#kitRev').textContent = '本地基线 rev ' + NR.getBaseRev() + (outbox.length ? ` · ${outbox.length} 条待同步` : ' · 已同步');
  $('#outboxList').innerHTML = outbox.length
    ? outbox.map((o) => `<li>待同步：${esc(o.type)} ${esc(o.label || o.routeId || o.id || '')}（离线编辑，${fmtTime(o.clientTime)}）</li>`).join('')
    : '';
  $('#pointList').innerHTML = Object.entries(doc.points || {}).map(([id, p]) =>
    `<li><span>📍 ${esc(p.label)} <span class="route-sub">(${p.at.x}, ${p.at.y})</span></span>
      <span><button class="btn mini" data-delp="${id}" type="button">删除</button></span></li>`).join('') || '<li class="route-sub">还没有集合点。</li>';
  $('#favList').innerHTML = Object.entries(doc.favorites || {}).map(([rid, f]) =>
    `<li><span>⭐ ${esc(f.name)}</span><span><button class="btn mini" data-route="${rid}" type="button">查看</button> <button class="btn mini" data-delf="${rid}" type="button">取消</button></span></li>`).join('') || '<li class="route-sub">还没有收藏。归档路线的收藏也会保留在此。</li>';

  $$('#pointList [data-delp]').forEach((b) => b.onclick = () => { NR.applyLocal({ type: 'delPoint', id: b.dataset.delp }); renderKit(); });
  $$('#favList [data-delf]').forEach((b) => b.onclick = () => { NR.applyLocal({ type: 'delFav', routeId: b.dataset.delf }); renderKit(); });
  $$('#favList [data-route]').forEach((b) => b.onclick = () => openSheet(b.dataset.route));
}

$('#pointForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const label = $('#pfLabel').value.trim();
  if (!label) return;
  NR.applyLocal({ type: 'addPoint', label, at: { x: +$('#pfX').value, y: +$('#pfY').value } });
  $('#pfLabel').value = '';
  renderKit();
});

async function doSync() {
  const box = $('#conflictBox');
  if (!navigator.onLine) {
    box.hidden = false;
    box.innerHTML = '<h4>离线中</h4>编辑已保存在本机，网络恢复后会自动尝试同步。';
    return;
  }
  const res = await NR.sync(false);
  if (res.ok) {
    box.hidden = !res.conflictsResolved.length;
    if (res.conflictsResolved.length) {
      box.innerHTML = '<h4>已自动解决的字段差异</h4>' + res.conflictsResolved.map((c) => `<div>${esc(c.field)}（${esc(c.kind)}）已按字段合并</div>`).join('');
    }
    renderKit();
  } else {
    box.hidden = false;
    box.innerHTML = `<h4>存在真正的冲突（两台设备改了同一字段）</h4>
      ${res.conflicts.map((c) => `<div class="conflict-row"><span>${esc(c.field)}</span>
        <span><button class="btn mini" data-keep="server" data-f="${esc(c.field)}" type="button">用服务端</button>
        <button class="btn mini" data-keep="client" data-f="${esc(c.field)}" type="button">用我的</button></span></div>`).join('')}
      <p class="route-sub">预览合并已在服务器生成；选择后会以 force 提交。公共注意信息不在合并范围，不会被改动。</p>`;
    $$('#conflictBox [data-keep]').forEach((btn) => btn.onclick = async () => {
      const field = btn.dataset.f;
      const keep = btn.dataset.keep;
      // 极简解决：按选择覆盖冲突字段（服务端值或本地值）
      const local = NR.localCollection();
      const setPath = (obj, path, val) => { const ks = path.split('.'); let o = obj; for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]]; o[ks[ks.length - 1]] = val; };
      const getPath = (obj, path) => path.split('.').reduce((o, k) => (o || {})[k], obj);
      const conflict = res.conflicts.find((c) => c.field === field);
      if (keep === 'server' && conflict) {
        if (field === 'name') local.name = res.head.name;
        else setPath(local, field, getPath(res.head, field));
      }
      NR.saveLocalCollection(local);
      const r2 = await NR.sync(true);
      if (r2.ok) box.hidden = true;
      renderKit();
    });
  }
}

// ---------- 观察表单 ----------
function initObsForm() {
  const sel = $('#obRoute');
  sel.innerHTML = state.routes.map((r) => `<option value="${r.id}">${r.name}</option>`).join('');
  const now = new Date();
  $('#obWhen').value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

async function submitObservation(e) {
  e.preventDefault();
  const msg = $('#obsMsg');
  if (!navigator.onLine) { msg.style.color = 'var(--bad)'; msg.textContent = '离线时不能提交观察；已不会假装成功。请联网后再提交。'; return; }
  const night = $$('input[name=obVisit]:checked')[0].value === 'night';
  const body = {
    routeId: $('#obRoute').value,
    kind: $('#obStatus').value === 'surface' ? 'surface' : 'lighting',
    status: $('#obStatus').value === 'surface' ? 'stairs' : $('#obStatus').value,
    coverage: +$('#obCov').value,
    cumStart: +$('#obS').value,
    cumEnd: +$('#obE').value,
    nightVisit: night,
    photo: night ? 'night' : 'day',
    visitedAt: $('#obWhen').value + ':00+08:00',
    comment: $('#obComment').value,
    observer: NR.userId,
  };
  try {
    await NR.addObservation(body);
    msg.style.color = 'var(--good)';
    msg.textContent = night ? '已记录为夜间观察，将进入照明计算。' : '已记录；因是白天观察，不会计入夜间亮灯比例。';
    fetchRoutes();
  } catch (err) {
    msg.style.color = 'var(--bad)';
    msg.textContent = '提交失败：' + err.message;
  }
}

// ---------- tab 与键盘 ----------
const TAB_IDS = ['routes', 'map', 'kit', 'info'];
function switchTab(t) {
  TAB_IDS.forEach((id) => { $('#tab-' + id).hidden = id !== t; });
  $$('.tabbtn').forEach((b) => {
    const on = b.dataset.tab === t;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  if (t === 'map') drawMap();
  if (t === 'kit') renderKit();
  if (t === 'info' && state.routes.length) initObsForm();
}
$$('.tabbtn').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (e.key >= '1' && e.key <= '4') { switchTab(TAB_IDS[+e.key - 1]); return; }
  if (e.key === 'f' || e.key === 'F') { switchTab('routes'); $('#fMaxKm').focus(); }
  if (e.key === 'l' || e.key === 'L') { switchTab('map'); locateMe(); }
  if (e.key === 'm' || e.key === 'M') { switchTab('map'); $('#manualEntry').open = true; $('#mx').focus(); }
  if (e.key === 's' || e.key === 'S') { switchTab('kit'); doSync(); }
  if (e.key === 'Escape') $('#sheet').hidden = true;
});

// ---------- 网络状态 ----------
function paintNet() {
  const on = navigator.onLine;
  $('#netDot').querySelector('.dot').className = 'dot ' + (on ? 'online' : 'offline');
  $('#netText').textContent = on ? '在线' : '离线';
}
window.addEventListener('online', async () => {
  paintNet();
  if (NR.getOutbox().length) await doSync();
  fetchRoutes();
});
window.addEventListener('offline', paintNet);

// ---------- 启动 ----------
function bindMap() {
  $('#btnLocate').onclick = locateMe;
  $('#btnSpatial').onclick = compareSpatial;
  $('#btnManualSnap').onclick = () => {
    state.loc = { x: +$('#mx').value, y: +$('#my').value, accuracy: +$('#macc').value };
    setLocStatus(`手动位置 (${state.loc.x}, ${state.loc.y})，精度 ${state.loc.accuracy}m。跨桥感知吸附中…`, 'good');
    runSnap(state.loc);
  };
  $('#obsForm').addEventListener('submit', submitObservation);
  $('#btnSync').onclick = doSync;
}

(async function boot() {
  paintNet();
  bindFilters();
  bindMap();
  await NR.pull().catch(() => {});
  renderKit();
  await fetchRoutes();
})();
