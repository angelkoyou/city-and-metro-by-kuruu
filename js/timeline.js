'use strict';
// 建设回放（v2.6）：按时间顺序重现本局线网的形成过程
// 数据来源：Game.buildLog（每次确认建设的批次）；旧存档没有批次记录时，按车站与轨道的 built 年月推导。
(function (CM) {
  const U = CM.U;
  const h = U.h, ic = CM.icon;
  const UI = CM.UI;

  const arr = function (v) { return Array.isArray(v) ? v : []; };
  // v3.9：无番号线路（num = null）在回放里也保持 null，不能变成 0 号线
  const fin = function (v) { if (v == null || v === '') return null; const n = +v; return Number.isFinite(n) ? n : null; };
  const idOf = function (v) { return typeof v === 'string' ? v : (v && typeof v.id === 'string' ? v.id : null); };
  const nameOf = function (v) { return v && typeof v === 'object' && typeof v.name === 'string' ? v.name : null; };

  function dateText(y, m) { return y + ' 年 ' + m + ' 月'; }
  function stampOf(o) {
    const b = o && o.built;
    if (!Array.isArray(b) || !b[0]) return null;
    const y = fin(b[0]); if (y == null) return null;
    const m = fin(b[1]) || 1;
    return { y: y, m: m, ym: U.ymIndex(y, m) };
  }

  // 旧存档：按 built 年月把车站、轨道归入同一个月，线路的开通月取它最早的一段轨道
  function derive(g) {
    const net = (g && g.net) || { stations: {}, segments: {}, lines: {} };
    const byYm = new Map();
    const bucket = function (t) {
      let e = byYm.get(t.ym);
      if (!e) { e = { y: t.y, m: t.m, ym: t.ym, cost: 0, rm: 0, mod: 0, st: [], sg: [], ln: [], init: true }; byYm.set(t.ym, e); }
      return e;
    };
    for (const id in (net.stations || {})) {
      const s = net.stations[id], t = stampOf(s); if (!t) continue;
      const e = bucket(t);
      e.st.push({ id: id, name: s.name || '' });
      if (!s.inherited) e.init = false;
    }
    const open = Object.create(null);
    for (const id in (net.segments || {})) {
      const s = net.segments[id], t = stampOf(s); if (!t) continue;
      const e = bucket(t);
      e.sg.push(id);
      if (!s.inherited) e.init = false;
      const lid = s.line;
      if (lid && (open[lid] == null || t.ym < open[lid])) open[lid] = t.ym;
    }
    for (const lid in open) {
      const e = byYm.get(open[lid]), L = net.lines && net.lines[lid];
      if (e && L) e.ln.push({ id: lid, name: L.name || '', num: fin(L.num) });
    }
    return Array.from(byYm.values()).sort(function (a, b) { return a.ym - b.ym; });
  }

  let cache = { key: null, list: [] };
  // 回放节点：每次确认建设一项，按年月与记录顺序排列
  function entries(g) {
    if (!g || !g.net) return [];
    const key = (g.id || '') + '|' + (g.netVersion || 0) + '|' + (g.buildLog ? g.buildLog.length : 0);
    if (cache.key === key) return cache.list;
    const raw = Array.isArray(g.buildLog) && g.buildLog.length ? g.buildLog : derive(g);
    const list = [];
    for (let k = 0; k < raw.length; k++) {
      const e = raw[k]; if (!e || e.ym == null) continue;
      const y = fin(e.y), m = fin(e.m);
      if (y == null || m == null) continue;
      const st = [], ln = [], sg = [];
      for (const x of arr(e.st)) {
        const id = idOf(x); if (!id) continue;
        const cur = g.net.stations[id];
        st.push({ id: id, name: (cur && cur.name) || nameOf(x) || '' });
      }
      for (const x of arr(e.ln)) {
        const id = idOf(x); if (!id) continue;
        const cur = g.net.lines[id];
        ln.push({ id: id, name: (cur && cur.name) || nameOf(x) || '', num: fin(cur && cur.num) != null ? fin(cur.num) : fin(x && x.num) });
      }
      for (const x of arr(e.sg)) { const id = idOf(x); if (id) sg.push(id); }
      list.push({
        i: list.length, y: y, m: m, ym: fin(e.ym) != null ? fin(e.ym) : U.ymIndex(y, m),
        cost: fin(e.cost) || 0, rm: fin(e.rm) || 0, mod: fin(e.mod) || 0,
        init: !!e.init, st: st, sg: sg, ln: ln,
      });
    }
    // 批次按时间先后排列；同一月内保持记录顺序（排序稳定）
    list.sort(function (a, b) { return a.ym - b.ym || a.i - b.i; });
    for (let k = 0; k < list.length; k++) list[k].i = k;
    cache = { key: key, list: list };
    return list;
  }

  // 已回放到第 p 个节点时可见的车站、轨道与线路
  function view(list, p) {
    const st = new Set(), sg = new Set(), ln = new Set();
    const n = U.clamp(Math.round(p) || 0, 0, list.length);
    for (let k = 0; k < n; k++) {
      const e = list[k];
      for (const o of e.st) st.add(o.id);
      for (const id of e.sg) sg.add(id);
      for (const o of e.ln) ln.add(o.id);
    }
    return { st: st, sg: sg, ln: ln, n: n };
  }

  const boundsCache = new WeakMap();
  function bounds(net) {
    const hit = boundsCache.get(net); if (hit) return hit;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const id in net.stations) {
      const s = net.stations[id];
      if (!s || !Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
      if (s.x < x0) x0 = s.x; if (s.x > x1) x1 = s.x;
      if (s.y < y0) y0 = s.y; if (s.y > y1) y1 = s.y;
    }
    if (!Number.isFinite(x0)) { x0 = 0; y0 = 0; x1 = 1; y1 = 1; }
    const out = { x0: x0, y0: y0, x1: x1, y1: y1, w: Math.max(1e-6, x1 - x0), h: Math.max(1e-6, y1 - y0) };
    boundsCache.set(net, out);
    return out;
  }

  const SZ_R = { S: 2.1, M: 2.7, L: 3.3, XL: 3.9, XXL: 4.5, HUB: 5.1 };
  const hex = function (c, alt) { return typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c) ? c : alt; };
  function colorOf(line) {
    try { return hex(CM.Accessibility && CM.Accessibility.line ? CM.Accessibility.line(line) : (line && line.color), '#8b93a7'); }
    catch (e) { return '#8b93a7'; }
  }

  // 面板内的线网生长示意图（SVG 字符串，只用数字与已校验的颜色）
  // 注意：地图坐标的 y 已经向下（南）增大，SVG 的 y 也向下增大，不能再翻转一次，否则南北会颠倒
  function mapSvg(g, v, latest, w, hgt) {
    const box = bounds(g.net), pad = 9;
    const sc = Math.min((w - pad * 2) / box.w, (hgt - pad * 2) / box.h);
    const ox = pad + (w - pad * 2 - box.w * sc) / 2, oy = pad + (hgt - pad * 2 - box.h * sc) / 2;
    const px = function (x) { return (ox + (x - box.x0) * sc).toFixed(2); };
    const py = function (y) { return (oy + (y - box.y0) * sc).toFixed(2); };
    const freshSg = new Set(latest ? latest.sg : []), freshSt = new Set(latest ? latest.st.map(function (o) { return o.id; }) : []);
    const out = [];
    // 浅网格：让早期只有一两条线时也不显得空
    for (let x = 20; x < w; x += 30) out.push('<line x1="' + x + '" y1="0" x2="' + x + '" y2="' + hgt + '" stroke="rgba(128,140,165,.16)" stroke-width="1"/>');
    for (let y = 20; y < hgt; y += 30) out.push('<line x1="0" y1="' + y + '" x2="' + w + '" y2="' + y + '" stroke="rgba(128,140,165,.16)" stroke-width="1"/>');
    for (const id of v.sg) {
      const s = g.net.segments[id]; if (!s) continue;
      const A = g.net.stations[s.a], B = g.net.stations[s.b];
      if (!A || !B) continue;
      const line = g.net.lines[s.line];
      const col = colorOf(line);
      const pts = [px(A.x) + ',' + py(A.y)];
      for (const p of arr(s.pts)) if (Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])) pts.push(px(p[0]) + ',' + py(p[1]));
      pts.push(px(B.x) + ',' + py(B.y));
      const fresh = freshSg.has(id);
      out.push('<polyline points="' + pts.join(' ') + '" fill="none" stroke="' + col + '" stroke-width="' + (fresh ? 3.4 : 2.3) +
        '" stroke-linecap="round" stroke-linejoin="round" opacity="' + (fresh ? 1 : 0.82) + '"/>');
    }
    const linesAt = Object.create(null);
    for (const id of v.sg) { const s = g.net.segments[id]; if (s && s.a) (linesAt[s.a] || (linesAt[s.a] = new Set())).add(s.line); if (s && s.b) (linesAt[s.b] || (linesAt[s.b] = new Set())).add(s.line); }
    for (const sid of v.st) {
      const s = g.net.stations[sid]; if (!s) continue;
      const set = linesAt[sid], lid = set && set.size ? set.values().next().value : null;
      const col = lid && g.net.lines[lid] ? colorOf(g.net.lines[lid]) : '#8b93a7';
      const r = SZ_R[s.size] || SZ_R.M, fresh = freshSt.has(sid);
      if (fresh) out.push('<circle cx="' + px(s.x) + '" cy="' + py(s.y) + '" r="' + (r + 4.4) + '" fill="' + col + '" opacity=".16"/>');
      out.push('<circle cx="' + px(s.x) + '" cy="' + py(s.y) + '" r="' + r + '" fill="' + col + '" stroke="#ffffff" stroke-width="1"/>');
    }
    return out.join('');
  }

  // 回放中的「地图视图」：渲染器每帧读取，把正式线网压暗后只重绘已建部分。
  // 页面关闭或切换到其它页面时自动失效，不改变游戏状态。
  let viewState = null;
  function setView(g, v, latest, p) {
    viewState = {
      g: g, st: v.st, sg: v.sg, p: p || 0,
      freshSg: new Set(latest ? latest.sg : []),
      freshSt: new Set(latest ? latest.st.map(function (o) { return o.id; }) : []),
    };
  }
  function replay(g, ui) {
    if (!viewState || viewState.g !== g) return null;
    const top = ui && ui.stack && ui.stack[ui.stack.length - 1];
    if (!top || top.kind !== 'timeline') { viewState = null; return null; }
    return viewState;
  }
  // 把镜头对到当前已回放的线网；没有已建车站时用整张地图的线网范围
  function fit(ui) {
    const g = ui && ui.g ? ui.g() : null, R = ui && ui.R;
    if (!g || !R) return false;
    const st = viewState && viewState.st && viewState.st.size ? viewState.st : new Set(Object.keys(g.net.stations));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const id of st) {
      const s = g.net.stations[id];
      if (!s || !Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
      if (s.x < x0) x0 = s.x; if (s.x > x1) x1 = s.x;
      if (s.y < y0) y0 = s.y; if (s.y > y1) y1 = s.y;
    }
    if (!Number.isFinite(x0)) return false;
    const w = Math.max(3, x1 - x0), h = Math.max(3, y1 - y0);
    const pad = 96;
    const z = U.clamp(Math.min((R.w - pad) / w, (R.h - pad) / h), 5, 72);
    R.flyTo((x0 + x1) / 2, (y0 + y1) / 2, z);
    if (R.cam.fly) R.cam.fly.duration = 0.55;
    return true;
  }

  CM.Timeline = {
    derive: derive, entries: entries, view: view, bounds: bounds,
    dateText: dateText, colorOf: colorOf, mapSvg: mapSvg,
    setView: setView, replay: replay, fit: fit,
    reset: function () { cache = { key: null, list: [] }; viewState = null; },
  };

  // ======================== 回放页面 ========================
  UI.prototype.page_timeline = function () {
    const g = this.g(), self = this;
    // 回放是只读的：先把游戏暂停，避免看历史时时间继续走
    if (g.speed > 0) this.setSpeed(0);
    const list = CM.Timeline.entries(g);
    const el = h('div', { class: 'tl' });
    if (!list.length) {
      el.appendChild(h('div', { class: 'callout info' }, '本局还没有建设记录。建成第一条线路或第一座车站后，这里会按时间顺序记录每一次建设。'));
      el.appendChild(h('div', { class: 'note' }, '回放只读取本局的线网数据，不会改变游戏进度，也不消耗时间与资金。'));
      return { title: '建设回放', el: el };
    }
    const N = list.length;
    const ST = this.tlState || (this.tlState = { p: N, playing: false, speed: 1 });
    ST.p = U.clamp(Math.round(fin(ST.p) != null ? fin(ST.p) : N), 0, N);
    ST.speed = [0.5, 1, 2, 4].indexOf(+ST.speed) >= 0 ? +ST.speed : 1;

    // ---- 头部：当前时间、进度与线路/车站数 ----
    const dateEl = h('div', { class: 'tl-date' }, '开工前');
    const subEl = h('div', { class: 'tl-sub tiny muted' }, '');
    const countEl = h('div', { class: 'tl-count tiny' }, '');
    const bar = h('i', { style: { width: '0%' } });
    const head = h('div', { class: 'tl-head' },
      h('div', { class: 'tl-head-top' }, dateEl, countEl),
      subEl,
      h('div', { class: 'progress tl-bar' }, bar));

    // ---- 控制：播放/暂停、单步、速度、时间轴 ----
    const playBtn = h('button', { class: 'btn sm primary tl-play', 'data-silent': '1', onclick: function () { setPlaying(!ST.playing); } });
    const prevBtn = h('button', { class: 'btn sm tl-step', 'data-tip': '上一个建设节点', 'data-silent': '1', onclick: function () { setPlaying(false); ST.p = U.clamp(ST.p - 1, 0, N); apply(); } }, ic('back', 14));
    const nextBtn = h('button', { class: 'btn sm tl-step', 'data-tip': '下一个建设节点', 'data-silent': '1', onclick: function () { setPlaying(false); ST.p = U.clamp(ST.p + 1, 0, N); apply(); } }, ic('chev', 14));
    const speedBtns = [0.5, 1, 2, 4].map(function (v) {
      return h('button', { class: 'tl-spd' + (v === ST.speed ? ' on' : ''), 'data-silent': '1', 'data-v': v, onclick: function () { ST.speed = v; for (const b of speedBtns) b.classList.toggle('on', +b.dataset.v === v); } }, (v === 1 ? '1×' : v + '×'));
    });
    const range = h('input', { type: 'range', class: 'tl-range', min: '0', max: String(N), step: '1', value: String(ST.p), 'aria-label': '回放进度' });
    range.addEventListener('input', function () { setPlaying(false); ST.p = U.clamp(Math.round(+range.value) || 0, 0, N); apply(); });
    // 回放同时显示在左侧真实地图上；这个按钮把镜头对到当前已建线网
    const fitBtn = h('button', { class: 'btn sm tl-step', 'data-tip': '在左侧地图定位当前线网', 'aria-label': '在左侧地图定位当前线网', 'data-silent': '1', onclick: function () { CM.Timeline.fit(self); } }, ic('locate', 14));
    const ctl = h('div', { class: 'tl-ctl' },
      h('div', { class: 'tl-ctl-row' }, playBtn, prevBtn, nextBtn, fitBtn, h('span', { class: 'tl-spd-wrap' }, speedBtns)),
      range,
      h('div', { class: 'tl-ends tiny muted' }, h('span', null, '开工前'), h('span', null, list[N - 1].y + ' 年 ' + list[N - 1].m + ' 月')));

    // ---- 示意图与说明 ----
    // 高度按全网的长宽比自适应：线网越扁平，示意图越矮，避免早期大片留白
    const box0 = CM.Timeline.bounds(g.net);
    const MAP_W = 340, mapH = U.clamp(Math.round(MAP_W * box0.h / box0.w) + 26, 118, 186);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 ' + MAP_W + ' ' + mapH);
    svg.setAttribute('class', 'tl-svg');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    const map = h('div', { class: 'tl-map' }, svg);
    const hint = h('div', { class: 'tl-hint tiny muted' });

    // ---- 事件列表 ----
    const rowEls = list.map(function (e) {
      const tag = e.init ? '开局线网' : (e.ln.length ? '新线开通' : (e.st.length ? '新建车站' : '改建与拆除'));
      const heads = e.ln.map(function (o) {
        const L = g.net.lines[o.id] || { color: '#8b93a7', num: o.num, name: o.name };
        return h('span', { class: 'tl-ln' }, h('i', { style: { background: CM.Timeline.colorOf(L) } }), o.name || ((o.num || '') + ' 号线'));
      });
      const names = e.st.map(function (o) { return o.name; }).filter(Boolean);
      const shown = names.slice(0, 4).join('、');
      const more = names.length > 4 ? h('span', { class: 'tiny' }, ' 等 ' + names.length + ' 座') : null;
      const extra = [];
      if (!names.length && e.mod) extra.push('改建 ' + e.mod + ' 项');
      if (e.rm) extra.push('拆除 ' + e.rm + ' 项');
      const body = h('div', { class: 'tl-ev-b' },
        h('div', { class: 'tl-ev-top' }, h('b', { class: 'tl-ev-d' }, CM.Timeline.dateText(e.y, e.m)), h('span', { class: 'tl-ev-tag' }, tag)),
        heads.length ? h('div', { class: 'tl-ev-ln' }, heads) : null,
        shown ? h('div', { class: 'tl-ev-st' }, shown, more) : (extra.length ? h('div', { class: 'tl-ev-st' }, extra.join(' · ')) : null));
      const row = h('button', { class: 'tl-ev', 'data-silent': '1', onclick: function () { setPlaying(false); ST.p = e.i + 1; apply(); } },
        h('span', { class: 'tl-ev-k' }, String(e.i + 1)), body,
        e.cost > 0 ? h('span', { class: 'tl-ev-cost tiny muted' }, U.fmtMoney(e.cost)) : null);
      return row;
    });
    const listBox = h('div', { class: 'tl-list' }, rowEls);

    el.append(head, h('div', { class: 'tl-card' }, ctl), map, hint, h('div', { class: 'tl-sec-h tiny muted' }, '建设记录 · 按时间先后'), listBox);

    function setPlaying(on) {
      if (on && ST.p >= N) { ST.p = 0; }
      ST.playing = !!on; last = 0;
      playBtn.innerHTML = '';
      playBtn.appendChild(ic(on ? 'pause' : 'play', 14));
      playBtn.appendChild(h('span', null, on ? '暂停' : '播放'));
      playBtn.classList.toggle('on', !!on);
      playBtn.setAttribute('aria-label', on ? '暂停回放' : '播放回放');
      if (on) apply();
    }

    // 依当前进度刷新所有显示
    function apply() {
      const p = ST.p, e = p > 0 ? list[p - 1] : null;
      const v = CM.Timeline.view(list, p);
      CM.Timeline.setView(g, v, e, p);
      dateEl.textContent = e ? CM.Timeline.dateText(e.y, e.m) : '开工前';
      subEl.textContent = p > 0 ? '第 ' + p + ' / ' + N + ' 次建设' : '尚未建设';
      countEl.textContent = v.ln.size + ' 条线路 · ' + v.st.size + ' 座车站';
      bar.style.width = (N ? p / N * 100 : 0).toFixed(2) + '%';
      range.value = String(p);
      range.setAttribute('aria-valuetext', dateEl.textContent + ' · ' + subEl.textContent);
      prevBtn.disabled = p <= 0;
      nextBtn.disabled = p >= N;
      svg.innerHTML = CM.Timeline.mapSvg(g, v, e, MAP_W, mapH);
      hint.textContent = (p === 0 ? '拖动时间轴或按播放，从开工前开始重现本局线网。' : (p >= N ? '已回到当前线网：' + v.ln.size + ' 条线路、' + v.st.size + ' 座车站。' : '回放中：' + v.ln.size + ' 条线路、' + v.st.size + ' 座车站已建成。')) + ' 地图同步显示，可拖动、缩放查看。';
      for (let k = 0; k < rowEls.length; k++) {
        const r = rowEls[k];
        r.classList.toggle('on', k === p - 1);
        r.classList.toggle('future', k >= p);
      }
      if (e) {
        const r = rowEls[p - 1];
        if (r) {
          const top = r.offsetTop, bottom = top + r.offsetHeight;
          if (top < listBox.scrollTop) listBox.scrollTop = Math.max(0, top - 6);
          else if (bottom > listBox.scrollTop + listBox.clientHeight) listBox.scrollTop = bottom - listBox.clientHeight + 6;
        }
      } else listBox.scrollTop = 0;
    }

    // 自动播放：按速度推进，末尾停下；页面刷新后沿用进度
    let last = 0;
    this.live.push(function () {
      if (!ST.playing) return;
      const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      if (!last) { last = now; return; }
      const dt = now - last; last = now;
      ST.acc = (ST.acc || 0) + dt;
      const gap = 1000 / ST.speed;
      if (ST.acc < gap) return;
      ST.acc = 0;
      if (ST.p >= N) { setPlaying(false); return; }
      ST.p++;
      apply();
      if (ST.p >= N) setPlaying(false);
    });
    setPlaying(!!ST.playing && ST.p < N);
    apply();
    // 第一次打开时把地图对到本局线网，让左侧真实地图成为回放舞台
    if (!ST._fit) {
      ST._fit = true;
      requestAnimationFrame(function () { if (CM.Timeline.replay(g, self)) CM.Timeline.fit(self); });
    }

    return { title: '建设回放', el: el };
  };
})(window.CM);
