/* app.js — 江湾夜跑单页应用。移动首页突出筛选；全部判定来自服务端原几何。 */
(function () {
  'use strict';
  const G = window.NRGeo, API = window.NRApi, Store = window.NRStore, MapV = window.NRMap;
  const view = document.getElementById('view');
  const toastEl = document.getElementById('toast');
  const netPill = document.getElementById('netPill');

  const state = {
    tab: 'home',
    filters: { lighting: 'any', max_slope: '', max_dist: '', supply_kind: '', supply_open: '', near_max: '' },
    location: null, // {lon, lat, source:'gps'|'manual', accuracy}
    lastRoutes: [],
    listNow: null,
    detailTol: 25,
    detailUseSimplified: true,
  };

  let toastTimer = null;
  function toast(msg, warn) {
    toastEl.textContent = msg;
    toastEl.className = 'toast' + (warn ? ' warn' : '');
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3600);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const LIGHT_LABEL = { lit: '照明良好', partial: '部分照明', dark: '观察为黑', unknown: '无近期夜证', conflict: '观察冲突' };
  function lightBadge(st) {
    return `<span class="badge ${st}">● ${LIGHT_LABEL[st] || st}</span>`;
  }
  function fmtPct(x) { return Math.round((x || 0) * 100) + '%'; }
  function fmtSlope(v) { return v == null ? '无高程' : (v * 100).toFixed(1) + '%'; }
  function fmtDate(ms) { return ms ? new Date(ms).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '—'; }

  /* ---------------- 网络状态 / 同步 ---------------- */
  function updateNet() {
    const on = navigator.onLine;
    netPill.textContent = on ? '在线' : '离线（编辑本地保存）';
    netPill.className = 'net-pill ' + (on ? 'online' : 'offline');
  }
  window.addEventListener('online', async () => { updateNet(); toast('网络恢复，正在合并离线编辑…'); await flushOutbox(true); });
  window.addEventListener('offline', () => { updateNet(); toast('已离线：集合点可继续编辑，恢复后合并', true); });

  async function flushOutbox(notice) {
    if (!navigator.onLine) return;
    try {
      const r = await Store.syncNow(API);
      if (r.synced) {
        toast(`已同步 ${r.synced} 条本地编辑` + (r.conflicts.length ? `，${r.conflicts.length} 处采用对方较新值` : ''));
        if (state.tab === 'collections') renderCollections();
      }
    } catch (e) { if (notice) toast('同步暂失败，已保留待重发', true); }
  }

  /* ---------------- Tab / 路由 ---------------- */
  document.querySelectorAll('.nav-tabs button').forEach(b => {
    b.addEventListener('click', () => navigate(b.dataset.tab));
  });
  function navigate(tab, param) {
    state.tab = tab;
    document.querySelectorAll('.nav-tabs button').forEach(b =>
      b.setAttribute('aria-current', b.dataset.tab === tab ? 'page' : 'false'));
    if (tab === 'home') renderHome();
    if (tab === 'collections') renderCollections();
    if (tab === 'about') renderAbout();
    if (tab === 'detail') renderDetail(param);
    location.hash = tab + (param ? '/' + encodeURIComponent(param) : '');
    view.focus();
  }
  window.addEventListener('hashchange', () => {
    const [t, p] = location.hash.replace(/^#/, '').split('/');
    if (t && t !== state.tab) navigate(t, p ? decodeURIComponent(p) : null);
  });

  /* ---------------- 首页：筛选为主角 ---------------- */
  function renderHome() {
    const f = state.filters;
    view.innerHTML = `
      <section class="filter-panel" aria-label="路线筛选">
        <h2>筛选今晚路线 <span class="hint">判定基于观察时刻，非白天照片</span></h2>

        <div class="chip-row" role="group" aria-label="照明">
          ${['any', 'lit', 'partial', 'dark', 'conflict', 'unknown'].map(v =>
            `<button class="chip" data-light="${v}" aria-pressed="${f.lighting === v}">${v === 'any' ? '不限照明' : LIGHT_LABEL[v]}</button>`).join('')}
        </div>

        <div class="field-row">
          <label class="field">最大距离
            <input type="number" id="fDist" min="0" step="100" inputmode="numeric" placeholder="如 3000（米）" value="${esc(f.max_dist)}">
          </label>
          <label class="field">最大坡度
            <input type="number" id="fSlope" min="0" max="20" step="0.5" inputmode="decimal" placeholder="如 4（%）" value="${esc(f.max_slope)}">
          </label>
        </div>
        <div class="field-row" style="margin-top:8px">
          <label class="field">补给类型
            <select id="fSupplyKind">
              <option value="">不限</option>
              <option value="water" ${f.supply_kind === 'water' ? 'selected' : ''}>饮水点</option>
              <option value="shop" ${f.supply_kind === 'shop' ? 'selected' : ''}>商店/贩卖机</option>
              <option value="toilet" ${f.supply_kind === 'toilet' ? 'selected' : ''}>卫生间</option>
            </select>
          </label>
          <label class="field">营业时段
            <select id="fSupplyOpen">
              <option value="">不限</option>
              <option value="1" ${f.supply_open === '1' ? 'selected' : ''}>此刻营业</option>
            </select>
          </label>
        </div>
        <label class="field" style="margin-top:8px">离我的定位不超过
          <input type="number" id="fNear" min="0" step="100" inputmode="numeric" placeholder="如 1000（米，留空不限）" value="${esc(f.near_max)}">
        </label>

        <div class="loc-bar">
          <button id="btnGps">📍 使用定位</button>
          <button class="btn secondary" id="btnManual">✍️ 手动输入位置</button>
          ${state.location ? '<button class="btn secondary" id="btnClearLoc">清除位置</button>' : ''}
        </div>
        <div class="loc-status ${state.location && state.location.source === 'manual' ? 'warn' : ''}" id="locStatus" aria-live="polite"></div>
      </section>

      <div id="list" aria-live="polite"><div class="empty">正在读取路线…</div></div>
    `;

    view.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => {
      state.filters.lighting = c.dataset.light;
      loadList(); renderHomeChrome();
    }));
    for (const [id, key] of [['fDist', 'max_dist'], ['fSlope', 'max_slope'], ['fNear', 'near_max']]) {
      view.querySelector('#' + id).addEventListener('change', e => { state.filters[key] = e.target.value; loadList(); });
    }
    view.querySelector('#fSupplyKind').addEventListener('change', e => { state.filters.supply_kind = e.target.value; loadList(); });
    view.querySelector('#fSupplyOpen').addEventListener('change', e => { state.filters.supply_open = e.target.value; loadList(); });
    view.querySelector('#btnGps').addEventListener('click', useGps);
    view.querySelector('#btnManual').addEventListener('click', manualLocationDialog);
    const clr = view.querySelector('#btnClearLoc');
    if (clr) clr.addEventListener('click', () => { state.location = null; Store.manualLocation(null); renderHome(); loadList(); });

    updateLocStatus();
    if (!state.lastRoutes.length) loadList(); else paintList(state.lastListData);
  }

  function renderHomeChrome() { // 仅更新 chip 高亮，不丢焦点
    view.querySelectorAll('.chip').forEach(c =>
      c.setAttribute('aria-pressed', String(state.filters.lighting === c.dataset.light)));
  }

  function updateLocStatus() {
    const el = view.querySelector('#locStatus');
    if (!el) return;
    const l = state.location;
    if (!l) { el.textContent = '未定位：可直接浏览，或手动输入起点（不依赖定位权限）。'; el.className = 'loc-status'; return; }
    const src = l.source === 'gps' ? `GPS（精度约 ${Math.round(l.accuracy || 0)} 米）` : '手动输入';
    el.textContent = `${src}：${l.lon.toFixed(5)}, ${l.lat.toFixed(5)}`;
    el.className = 'loc-status' + (l.source === 'manual' ? ' warn' : '');
  }

  /* ---------------- 定位：权限拒绝时的手动入口 ---------------- */
  function useGps() {
    if (!navigator.geolocation) { manualLocationDialog('浏览器不支持定位，请手动输入'); return; }
    const el = view.querySelector('#locStatus');
    el.textContent = '定位中…（若拒绝授权，可随时用手动输入）';
    navigator.geolocation.getCurrentPosition(pos => {
      state.location = { lon: pos.coords.longitude, lat: pos.coords.latitude, accuracy: pos.coords.accuracy, source: 'gps' };
      toast('已定位，正在按距离筛选');
      renderHome(); loadList();
    }, err => {
      const reason = err.code === 1 ? '定位权限被拒绝' : err.code === 3 ? '定位超时' : '定位不可用';
      el.textContent = reason + '。仍可手动输入坐标，功能不受限。';
      el.className = 'loc-status warn';
      toast(reason + '：已提供手动入口', true);
      setTimeout(() => manualLocationDialog(reason), 300);
    }, { enableHighAccuracy: true, timeout: 9000, maximumAge: 60000 });
  }

  function manualLocationDialog(reason) {
    const saved = Store.manualLocation();
    const lon = saved ? saved.lon : '', lat = saved ? saved.lat : '';
    const html = `
      <div class="form-row"><label>${esc(reason || '手动输入起点')}，经度（东经）</label>
        <input id="mLon" inputmode="decimal" placeholder="120.20" value="${lon}"></div>
      <div class="form-row"><label>纬度（北纬）</label>
        <input id="mLat" inputmode="decimal" placeholder="30.25" value="${lat}"></div>
      <div style="display:flex;gap:8px">
        <button class="btn" id="mOk">确定</button>
        <button class="btn secondary" id="mCancel">取消</button>
      </div>
      <div class="note-box safe" style="margin-top:10px">江湾市示例：桥南附近 120.213, 30.241；北岸滨河 120.195, 30.253</div>`;
    openDialog('手动位置（无定位权限入口）', html, () => {
      // 对话框挂在 document.body（#view 之外），必须用 document 查询
      const lon = parseFloat(document.getElementById('mLon').value);
      const lat = parseFloat(document.getElementById('mLat').value);
      if (!(lon >= -180 && lon <= 180) || !(lat >= -90 && lat <= 90)) { toast('请输入有效经纬度', true); return false; }
      state.location = { lon, lat, source: 'manual', accuracy: null };
      Store.manualLocation({ lon, lat });
      renderHome(); loadList();
      return true;
    });
  }

  /* ---------------- 列表数据 ---------------- */
  async function loadList() {
    const f = state.filters;
    const params = { lighting: f.lighting, max_slope: f.max_slope, max_dist: f.max_dist };
    if (f.supply_kind) params.supply_kind = f.supply_kind;
    if (f.supply_open) params.supply_open = f.supply_open;
    if (state.location) { params.lon = state.location.lon; params.lat = state.location.lat; params.near_max = f.near_max; }
    try {
      let data;
      if (navigator.onLine) {
        data = await API.routes(params);
        Store.cache.set('routes', data);
      } else {
        const c = Store.cache.get('routes');
        if (!c) throw new Error('离线且暂无缓存');
        data = c.val;
        toast('离线：显示上次缓存，照明/营业状态可能过期', true);
      }
      state.listNow = data.now;
      state.lastListData = data;
      state.lastRoutes = data.routes;
      data.routes.forEach(r => Store.rememberRouteName(r.id, r.name));
      paintList(data);
    } catch (e) {
      view.querySelector('#list').innerHTML =
        `<div class="empty">读取失败：${esc(e.message)}<br>可手动输入位置或稍后重试</div>`;
    }
  }

  function paintList(data) {
    const host = view.querySelector('#list');
    if (!host) return;
    if (!data.routes.length) {
      host.innerHTML = '<div class="empty">没有符合当前筛选的路线。可放宽坡度/照明条件。</div>';
      return;
    }
    host.innerHTML = `
      <div class="section-title">${data.count} 条路线 · 判定时刻 ${new Date(data.now).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（UTC+8）</div>
      ${data.routes.map(r => cardHtml(r, data)).join('')}
      <div class="note-box safe">徽章只描述<b>观察记录</b>，不等于安全保证。“无近期夜证/观察冲突”请点进查看证据与公共注意。</div>
    `;
    host.querySelectorAll('.route-card').forEach(c =>
      c.addEventListener('click', () => navigate('detail', c.dataset.id)));
  }

  function cardHtml(r, data) {
    const L = r.lighting;
    const badges = [lightBadge(L.status)];
    if (L.status !== 'unknown') badges.push(`<span class="badge">夜证覆盖 ${fmtPct(L.lit_coverage)}</span>`);
    if (L.stale) badges.push('<span class="badge stale">数据过期</span>');
    if (L.day_photo_only && L.day_photo_only.length && L.status === 'unknown')
      badges.push('<span class="badge stale">仅白天照片</span>');
    if (r.status === 'deprecated') badges.push('<span class="badge deprecated">旧线路</span>');
    if (r.supplies_open_now) badges.push(`<span class="badge open">${r.supplies_open_now} 处补给营业中</span>`);
    const dist = r.distance_to_route != null ? `<span>距你 ${Math.round(r.distance_to_route)} 米</span>` : '';
    return `
    <button class="route-card" data-id="${esc(r.id)}">
      <h3>${esc(r.name)} ${r.replaces ? '' : ''}</h3>
      <div class="meta">
        <span>${Math.round(r.length_m)} 米</span>
        <span>累计爬升 ${Math.round(r.ascent_m || 0)} 米</span>
        <span>最大坡度 ${fmtSlope(r.max_slope)}</span>
        <span>${r.crossings_count} 个平面交叉</span>
        ${dist}
      </div>
      <div class="badges">${badges.join('')}</div>
    </button>`;
  }

  /* ---------------- 路线详情 ---------------- */
  async function renderDetail(id) {
    view.innerHTML = '<div class="empty">读取路线…</div>';
    try {
      const data = await API.route(id, { tolerance: state.detailTol });
      Store.rememberRouteName(data.route.id, data.route.name);
      paintDetail(data.route, data.now);
    } catch (e) {
      view.innerHTML = `<div class="empty">读取失败：${esc(e.message)}<br><button class="btn" onclick="location.hash='#home'">返回筛选</button></div>`;
    }
  }

  function paintDetail(r, now) {
    const L = r.lighting;
    const coll = Store.getCollection(r.id);
    const saved = coll && !coll.deleted;
    const conflictNote = L.status === 'conflict'
      ? `<div class="note-box">同一路段存在互相矛盾的夜间观察（亮/不亮），桩号：
         ${L.conflict_ranges.map(x => `${G.fmtStation(x[0])}–${G.fmtStation(x[1])}`).join('；')}。
         请以下方最新夜访为准，或自行补一条观察。</div>` : '';
    const staleNote = L.stale ? `<div class="note-box">存在超过 180 天的旧夜访记录，已不计入当前判定，请重新夜访确认。</div>` : '';
    const dayNote = L.day_photo_only.length
      ? `<div class="note-box">白天照片仅证明灯杆/灯具存在，<b>不能保证夜间点亮</b>，不参与照明判定。</div>` : '';

    view.innerHTML = `
      <button class="back-link" id="back">← 返回筛选</button>
      <h2 style="margin:6px 0 2px">${esc(r.name)}</h2>
      <div class="badges">
        ${lightBadge(L.status)}
        ${L.stale ? '<span class="badge stale">含过期记录</span>' : ''}
        ${r.status === 'deprecated' ? '<span class="badge deprecated">旧线路（收藏仍保留）</span>' : ''}
      </div>

      <div class="map-wrap">
        <svg id="map" role="img" aria-label="${esc(r.name)} 路线图"></svg>
        <div class="map-toolbar">
          <label style="display:flex;align-items:center;gap:6px">
            <input type="checkbox" id="useSimp" ${state.detailUseSimplified ? 'checked' : ''}>
            绘制简化线（仅显示）
          </label>
          <label>简化公差 <input type="range" id="tol" min="5" max="80" value="${state.detailTol}" style="width:90px"></label>
          <span id="tolV">${state.detailTol} 米</span>
          <span id="geomInfo" class="badge"></span>
        </div>
      </div>

      ${conflictNote}${staleNote}${dayNote}
      <div id="notices"></div>

      <div class="section-title">几何指标（始终取自原几何，缩放/简化不变）</div>
      <div class="metric-grid">
        <div class="metric"><div class="k">总距离</div><div class="v">${G.fmtStation(r.length_m)}</div></div>
        <div class="metric"><div class="k">最大坡度 / 累计爬升</div><div class="v">${fmtSlope(r.max_slope)} · ${Math.round(r.ascent_m || 0)}m</div></div>
        <div class="metric"><div class="k">平面交叉点</div><div class="v">${r.crossings_count}</div></div>
        <div class="metric"><div class="k">几何 / 观察版本</div><div class="v">v${r.geom_version} / o${r.obs_version}</div></div>
      </div>

      <div class="section-title">交叉点（原几何计算）</div>
      <div id="crossList"></div>

      <div class="section-title">照明观察证据（可核查）</div>
      <ul class="evidence" id="evList"></ul>

      <div class="section-title">补给点与营业时段（当前 ${new Date(now).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}）</div>
      <div id="supplyList"></div>

      <div class="section-title">我的集合 / 退出点</div>
      <div id="collBox"></div>

      <div class="section-title">补充一条观察</div>
      <div id="reportBox"></div>
    `;

    view.querySelector('#back').addEventListener('click', () => navigate('home'));

    // 地图
    const svg = view.querySelector('#map');
    const colorBy = { lit: '#4ade80', partial: '#f59e0b', dark: '#ff7b7b', conflict: '#c084fc', unknown: '#8a97b3' };
    const points = [];
    for (const x of r.crossings) points.push({ lon: x.lon, lat: x.lat, kind: 'crossing', label: '交叉 ' + esc(x.other_route) });
    for (const s of r.supplies) points.push({ lon: s.lon, lat: s.lat, kind: 'supply', label: esc(s.name) + (s.open ? '·营业' : '·闭店') });
    if (coll && coll.meeting) points.push({ lon: coll.meeting.lon, lat: coll.meeting.lat, kind: 'meeting', label: '集合点' });
    if (coll && coll.exit_station != null) {
      const pt = stationToLonLat(r.coords, coll.exit_station);
      if (pt) points.push({ ...pt, kind: 'exit', label: '退出点' });
    }
    function drawMap() {
      MapV.render(svg, {
        routes: [{ id: r.id, coords: r.coords, simplified: r.coords_simplified, color: colorBy[L.status], width: 5, label: r.name }],
        points,
      }, { simplified: state.detailUseSimplified, maxHeight: 300 });
      const fullLen = G.polylineLength(r.coords);
      const simpLen = G.polylineLength(r.coords_simplified);
      view.querySelector('#geomInfo').textContent =
        `原线 ${r.coords.length}点/${Math.round(fullLen)}m，显示 ${r.coords_simplified.length}点/${Math.round(simpLen)}m（判定仍用原线）`;
    }
    drawMap();
    view.querySelector('#useSimp').addEventListener('change', e => { state.detailUseSimplified = e.target.checked; drawMap(); });
    view.querySelector('#tol').addEventListener('input', async e => {
      state.detailTol = Number(e.target.value);
      view.querySelector('#tolV').textContent = state.detailTol + ' 米';
      const g = await API.geometry(r.id, state.detailTol);
      r.coords_simplified = g.simplified;
      drawMap();
    });

    // 公共注意（只读，编辑集合不会影响）
    view.querySelector('#notices').innerHTML = r.notices.length
      ? r.notices.map(n => `<div class="note-box ${n.severity === 'warning' ? '' : 'info'}">${esc(n.message)}
          <div style="opacity:.7;margin-top:2px">公共注意 · 几何v${n.geom_version}/观察o${n.obs_version} · ${fmtDate(n.updated_at)}</div></div>`).join('')
      : '<div class="note-box safe">暂无公共注意。公共注意由维护者发布，个人收藏/集合操作不会覆盖它。</div>';

    view.querySelector('#crossList').innerHTML = r.crossings.length
      ? r.crossings.map(x => `<div class="kvline"><span class="k">与「${esc(x.other_route)}」交叉</span><span>桩号 ${G.fmtStation(x.station)}</span></div>`).join('')
      : '<div class="empty" style="padding:10px">无平面交叉</div>';

    view.querySelector('#evList').innerHTML = L.evidence.length
      ? L.evidence.map(e => `<li>
          <span class="tag ${e.lit ? 'lit' : 'dark'}" style="color:${e.lit ? 'var(--good)' : 'var(--bad)'}">${e.lit ? '点亮' : '未亮'}</span>
          ${G.fmtStation(e.cov_from)}–${G.fmtStation(e.cov_to)} ·
          ${e.source === 'night_visit' ? '夜间实访' : e.source === 'report' ? '跑友上报' : esc(e.source)} ·
          ${fmtDate(e.observed_at)} · ${esc(e.observer || '匿名')}
          ${e.in_window ? '' : '·<b style="color:var(--warn)">不在当前时段</b>'}
          ${e.stale ? '·<b style="color:var(--warn)">已过期</b>' : ''}
          <div style="color:var(--muted)">${esc(e.note || '')}</div></li>`).join('')
      : '<li>没有任何夜间观察。白天照片不计入。</li>';
    if (L.day_photo_only.length) {
      view.querySelector('#evList').innerHTML += L.day_photo_only.map(d =>
        `<li style="opacity:.8">📷 白天照片 ${G.fmtStation(d.cov_from)}–${G.fmtStation(d.cov_to)} · ${fmtDate(d.observed_at)} · ${esc(d.note || '')}（<b>不作夜证</b>）</li>`).join('');
    }

    view.querySelector('#supplyList').innerHTML = r.supplies.length
      ? r.supplies.map(s => `<div class="kvline">
          <span class="k">${{ water: '🚰 饮水', shop: '🏪 商店', toilet: '🚻 卫生间' }[s.kind] || s.kind} ${esc(s.name)}</span>
          <span class="${s.open ? '' : ''}" style="color:${s.open ? 'var(--good)' : 'var(--muted)'}">
            ${s.open ? '营业中' : '已闭店'} · 桩号 ${G.fmtStation(s.station_m)}<br>
            <small>${s.windows.map(w => `${w.days.length === 7 ? '每天' : '周' + w.days.join('')} ${w.start}–${w.end}`).join('，')}</small></span></div>`).join('')
      : '<div class="empty" style="padding:10px">暂无登记补给点</div>';

    renderCollBox(r, saved, coll);
    renderReportBox(r);
  }

  function stationToLonLat(coords, station) {
    const P0 = { lon: coords[0][0], lat: coords[0][1] };
    // 用 geo 的 stations 线性插值
    const sts = G.stations(coords);
    for (let i = 1; i < sts.length; i++) {
      if (sts[i] >= station) {
        const t = (station - sts[i - 1]) / (sts[i] - sts[i - 1] || 1);
        return { lon: coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * t,
                 lat: coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * t };
      }
    }
    return null;
  }

  /* ---------------- 集合点 / 退出点编辑（离线可用） ---------------- */
  function renderCollBox(r, saved, coll) {
    const box = view.querySelector('#collBox');
    const m = coll && coll.meeting_lon != null ? { lon: coll.meeting_lon, lat: coll.meeting_lat, label: coll.meeting_label } : null;
    const here = state.location;
    box.innerHTML = `
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn ${saved ? 'secondary' : ''}" id="btnSave">${saved ? '✓ 已收藏（再次点击取消）' : '☆ 收藏路线'}</button>
      </div>
      <div class="form-row" style="margin-top:10px">
        <label>集合点（经纬度，可用“用我当前位置”）</label>
        <div style="display:flex;gap:6px">
          <input id="mLon2" inputmode="decimal" placeholder="经度" value="${m ? m.lon.toFixed(6) : ''}">
          <input id="mLat2" inputmode="decimal" placeholder="纬度" value="${m ? m.lat.toFixed(6) : ''}">
        </div>
        <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap">
          ${here ? '<button class="btn secondary" id="mHere">用我当前位置</button>' : ''}
          <input id="mLabel" placeholder="集合点名称（如 桥南驿站）" value="${esc(m && m.label || '')}" style="flex:1;min-width:140px">
        </div>
      </div>
      <div class="form-row"><label>退出点桩号（米，0–${Math.round(r.length_m)}）</label>
        <input id="mExit" type="number" min="0" max="${Math.round(r.length_m)}" step="50" value="${coll && coll.exit_station != null ? Math.round(coll.exit_station) : ''}">
      </div>
      <div class="form-row"><label>个人备注（仅自己可见，不写入公共注意）</label>
        <textarea id="mNote">${esc(coll && coll.note || '')}</textarea></div>
      <button class="btn" id="mSaveColl">保存集合点</button>
      <div class="loc-status" id="collStatus"></div>
    `;
    const base = { geom_version: r.geom_version, obs_version: r.obs_version };
    box.querySelector('#btnSave').addEventListener('click', () => {
      if (!saved) {
        Store.localEdit(r.id, { saved_at: new Date().toISOString() }, base);
        toast(navigator.onLine ? '已收藏' : '离线收藏，联网后合并');
      } else {
        Store.localEdit(r.id, { deleted: true }, base);
        toast('已移出集合（离线队列保留）');
      }
      if (navigator.onLine) flushOutbox().then(() => renderDetail(r.id)); else renderDetail(r.id);
    });
    if (here) box.querySelector('#mHere').addEventListener('click', () => {
      box.querySelector('#mLon2').value = here.lon.toFixed(6);
      box.querySelector('#mLat2').value = here.lat.toFixed(6);
    });
    box.querySelector('#mSaveColl').addEventListener('click', () => {
      const lon = parseFloat(box.querySelector('#mLon2').value);
      const lat = parseFloat(box.querySelector('#mLat2').value);
      const label = box.querySelector('#mLabel').value.trim();
      const exitRaw = box.querySelector('#mExit').value;
      const note = box.querySelector('#mNote').value.trim();
      const patch = {};
      if (!isNaN(lon) && !isNaN(lat)) patch.meeting = { lon, lat, label };
      else if (label) { toast('请同时填写集合点经纬度', true); return; }
      if (exitRaw !== '') {
        const ex = Number(exitRaw);
        if (ex < 0 || ex > r.length_m) { toast('退出点桩号超出路线长度', true); return; }
        patch.exit_station = ex;
      }
      if (note !== (coll && coll.note || '')) patch.note = note;
      if (!Object.keys(patch).length) { toast('没有改动', true); return; }
      Store.localEdit(r.id, patch, base);
      box.querySelector('#collStatus').textContent =
        (navigator.onLine ? '已保存并合并。' : '已离线保存（本地队列），联网后与另一端按字段合并。') +
        ' 你的备注与公共注意互不覆盖。';
      if (navigator.onLine) flushOutbox().then(() => renderDetail(r.id));
    });
  }

  /* ---------------- 观察上报 ---------------- */
  function renderReportBox(r) {
    const box = view.querySelector('#reportBox');
    box.innerHTML = `
      <div class="field-row">
        <label class="field">观察类型
          <select id="rSrc">
            <option value="night_visit">夜间实访（可记亮/不亮）</option>
            <option value="report">跑友上报</option>
            <option value="day_photo">白天照片（只证明灯具存在）</option>
          </select></label>
        <label class="field">亮灯情况
          <select id="rLit"><option value="1">点亮</option><option value="0">未点亮</option><option value="">仅记灯具(白天)</option></select></label>
      </div>
      <div class="field-row" style="margin-top:8px">
        <label class="field">覆盖起(米)<input id="rFrom" type="number" value="0" min="0"></label>
        <label class="field">覆盖止(米)<input id="rTo" type="number" value="${Math.round(r.length_m)}" max="${Math.round(r.length_m)}"></label>
      </div>
      <div class="form-row"><label>观察日期时间（本地）<input id="rWhen" type="datetime-local"></label></div>
      <div class="form-row"><label>说明（可核查：灯具位置/维护单号等）<input id="rNote" placeholder="如：桥北引桥两盏灯维护中，工单号…"></label></div>
      <button class="btn" id="rSubmit">提交观察</button>
      <div class="loc-status" id="rStatus"></div>
    `;
    const when = box.querySelector('#rWhen');
    // datetime-local 取“墙上时间”：用 UTC+8 当前时刻格式化为不带时区的字符串
    const now = new Date();
    when.value = new Date(now.getTime() + 8 * 3600000 - now.getTimezoneOffset() * 60000)
      .toISOString().slice(0, 16);
    box.querySelector('#rSrc').addEventListener('change', e => {
      const litSel = box.querySelector('#rLit');
      if (e.target.value === 'day_photo') litSel.value = '';
    });
    box.querySelector('#rSubmit').addEventListener('click', async () => {
      const src = box.querySelector('#rSrc').value;
      const litRaw = box.querySelector('#rLit').value;
      const body = {
        source: src,
        lit: litRaw === '' ? null : litRaw === '1',
        cov_from: Number(box.querySelector('#rFrom').value),
        cov_to: Number(box.querySelector('#rTo').value),
        observed_at: new Date(when.value).getTime(),
        note: box.querySelector('#rNote').value.trim(),
        observer: Store.uid(),
      };
      try {
        const res = await API.observe(r.id, body);
        toast('已记录为观察版本 o' + res.obs_version + (res.warning ? '；' + res.warning : ''), !!res.warning);
        renderDetail(r.id);
      } catch (e) {
        box.querySelector('#rStatus').textContent = '提交失败：' + e.message + (e.status === 422 ? '（白天照片不能声明亮灯）' : '');
      }
    });
  }

  /* ---------------- 我的集合 ---------------- */
  async function renderCollections() {
    view.innerHTML = '<div class="empty">读取集合…</div>';
    let publicMap = {};
    try {
      if (navigator.onLine) {
        const pulled = await Store.pullCollections(API); // 内部已按字段合并进本地
        pulled.forEach(it => { publicMap[it.route_id] = it.public; });
      }
    } catch { /* 离线或失败：只用本地 */ }
    // 统一从合并后的本地存储渲染（pull 已把服务端字段合并进来）
    let items = Object.values(Store.getCollections())
      .filter(x => !x.deleted)
      .map(x => ({ ...x, public: publicMap[x.route_id] || x.public || null }));
    // 本地无 public 但在线时，pull 已附带；离线沿用已有缓存字段
    const pending = Store.outbox().length;
    if (!items.length) {
      view.innerHTML = `<div class="empty">还没有收藏。${navigator.onLine ? '' : '（离线模式）'}<br>
        去「路线筛选」收藏并设置集合点、退出点。</div>
        ${pending ? syncBar(pending) : ''}`;
      return;
    }
    view.innerHTML = `
      <div class="section-title">${items.length} 条收藏 · 个人字段离线可编辑，按字段合并</div>
      ${pending ? syncBar(pending) : ''}
      <div id="collItems"></div>
      <div class="note-box safe" style="margin-top:12px">同步规则：集合点/退出点/备注各自带时间戳，两台设备改不同字段会都保留；
        改同一字段取较新值。公共路线几何与「公共注意」是单独通道，永远不会被你的离线编辑覆盖。</div>
    `;
    const host = view.querySelector('#collItems');
    const names = Store.routeNames();
    host.innerHTML = items.map(it => {
      const p = it.public || {};
      const geoChanged = p.geom_version && it.base_geom_version && p.geom_version > it.base_geom_version;
      const obsChanged = p.obs_version && it.base_obs_version && p.obs_version > it.base_obs_version;
      return `
      <div class="route-card" data-id="${esc(it.route_id)}" role="button" tabindex="0" style="cursor:pointer">
        <h3>${esc(p.name || names[it.route_id] || it.route_id)}
          ${p.status === 'deprecated' ? '<span class="badge deprecated">旧线路</span>' : ''}
          ${(!p.name && names[it.route_id] && navigator.onLine === false) ? '<span class="badge">离线缓存名</span>' : ''}
          ${geoChanged ? '<span class="badge stale">几何已更新 v' + it.base_geom_version + '→v' + p.geom_version + '</span>' : ''}
          ${obsChanged ? '<span class="badge stale">有新观察 o' + it.base_obs_version + '→o' + p.obs_version + '</span>' : ''}
        </h3>
        <div class="meta">
          <span>集合点：${it.meeting_lon != null ? esc(it.meeting_label || '未命名') + ' (' + it.meeting_lon.toFixed(4) + ',' + it.meeting_lat.toFixed(4) + ')' : '未设置'}</span>
          <span>退出点：${it.exit_station != null ? G.fmtStation(it.exit_station) : '未设置'}</span>
        </div>
        ${it.note ? `<div class="note-box info" style="margin-top:6px">${esc(it.note)}</div>` : ''}
      </div>`;
    }).join('');
    host.querySelectorAll('.route-card').forEach(c => {
      const go = () => navigate('detail', c.dataset.id);
      c.addEventListener('click', go);
      c.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    });
  }
  function syncBar(pending) {
    return `<div class="note-box">本地待同步 ${pending} 条。
      <button class="btn" id="syncNow" style="margin-left:8px">立即合并</button></div>`;
  }
  document.addEventListener('click', e => {
    if (e.target.id === 'syncNow') flushOutbox(true).then(() => renderCollections());
  });

  /* ---------------- 说明 / 设计路径 ---------------- */
  function renderAbout() {
    view.innerHTML = `
      <h2>怎么用（手机与键盘路径一致）</h2>
      <div class="metric-grid">
        <div class="metric"><div class="k">1 · 筛选</div><div class="v" style="font-size:.85rem;font-weight:400">首页点照明徽章/填坡度距离。手机点按，键盘用 Tab 与 Enter 操作同一组控件。</div></div>
        <div class="metric"><div class="k">2 · 定位</div><div class="v" style="font-size:.85rem;font-weight:400">允许定位即按距离排；拒绝权限时点「手动输入位置」，输入经纬度继续。</div></div>
        <div class="metric"><div class="k">3 · 看证据</div><div class="v" style="font-size:.85rem;font-weight:400">详情页列出每条夜访的时间、覆盖桩号、观察人；冲突与过期有独立提示。</div></div>
        <div class="metric"><div class="k">4 · 存集合</div><div class="v" style="font-size:.85rem;font-weight:400">收藏、集合点、退出点、备注离线可改；两台设备按字段合并。</div></div>
      </div>
      <div class="note-box" style="margin-top:12px">本应用<b>不承诺安全</b>。“照明良好”只表示在给定观察时刻、由夜访记录覆盖的路段点亮；
        白天照片、过期记录都不会当作夜间保证。夜跑请结伴、注意施工与人流。</div>
      <div class="section-title">数据与算法可核查点</div>
      <ul class="evidence">
        <li>距离、坡度、交叉点、最近投影全部来自服务端保存的<b>原几何</b>；地图可切换简化显示线并调整公差，指标不变。</li>
        <li>照明判定只统计：夜间实访/跑友上报 + 覆盖桩号 + 当前处于其声明时段 + 180 天内；冲突给出桩号区间。</li>
        <li>空间查询提供两种实现：100m 预分段 R*Tree 索引 与 实时全几何求交，<code>/api/spatial/benchmark</code> 对比耗时并校验结果集一致。</li>
        <li>跨河最近点投影逐线段计算，桥与岸线不会因包围盒接近而误配。</li>
        <li>旧线路保留可收藏；公共路线更新与个人集合编辑分开合并，公共注意只读。</li>
      </ul>
      <div class="section-title">键盘操作</div>
      <ul class="evidence">
        <li>Tab 在筛选芯片、输入框、路线卡间移动，焦点有醒目描边；Enter/Space 激活卡片与按钮。</li>
        <li>三个主视图可直接访问：<a href="#home">#home</a> · <a href="#collections">#collections</a> · <a href="#about">#about</a></li>
      </ul>
    `;
  }

  /* ---------------- 简易对话框 ---------------- */
  function openDialog(title, inner, onOk) {
    const dlg = document.createElement('div');
    dlg.style.cssText = 'position:fixed;inset:0;background:rgba(5,8,16,.72);z-index:60;display:flex;align-items:center;justify-content:center;padding:16px';
    dlg.innerHTML = `<div role="dialog" aria-modal="true" aria-label="${esc(title)}"
      style="background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;max-width:420px;width:100%">
      <h2 style="margin:0 0 8px;font-size:1rem">${esc(title)}</h2>${inner}</div>`;
    document.body.appendChild(dlg);
    dlg.querySelector('#mCancel') && dlg.querySelector('#mCancel').addEventListener('click', () => dlg.remove());
    dlg.querySelector('#mOk').addEventListener('click', () => { if (onOk() !== false) dlg.remove(); });
    setTimeout(() => { const i = dlg.querySelector('input'); i && i.focus(); }, 0);
    dlg.addEventListener('keydown', e => { if (e.key === 'Escape') dlg.remove(); });
  }

  /* ---------------- 启动 ---------------- */
  updateNet();
  (async function boot() {
    const manual = Store.manualLocation();
    if (manual) state.location = { ...manual, source: 'manual' };
    const [hashT, hashP] = location.hash.replace(/^#/, '').split('/');
    if (hashT === 'detail') navigate('detail', decodeURIComponent(hashP));
    else if (hashT === 'collections') navigate('collections');
    else if (hashT === 'about') navigate('about');
    else navigate('home');
    if (navigator.onLine) flushOutbox(false);
  })();
})();
