'use strict';
// 地铁导航（v5.3）：在线路示意图里选起点与终点，按「时间最短 / 换乘最少 / 车费最便宜」给出乘车方案。
// 与运营完全同源：站点、交路、区间用时与发车频率都取编译线网 C 与当前时段的求解结果，不另建一套线网；
// 停用站与预留站本来就不在 C.routes 里，因此不会被导航选中（与「视为不存在」的口径一致）。
//
// 三种策略都在同一张「车站 + 车上」图上做 Dijkstra，只是边权不同：
//   时间最短   —— 实际耗时：乘车（含停站）+ 候车（发车间隔的一半）+ 换乘步行；
//   换乘最少   —— 上车次数优先（一次上车记 1e6 秒），同等换乘次数时再比耗时；
//   车费最便宜 —— 计费里程优先（160 轨道按高票价的倍数折算），同等票价时再比耗时。
// 票价本身按全网一张票计（换乘不另收费）：常规票价按总乘距算，用到 160 轨道时再与 160 票价取高。
(function (CM) {
  const U = CM.U, M = CM.Metro, h = U.h;
  const INF = Infinity;
  const BOARD_BIG = 1e6;    // 「换乘最少」的第二目标：一次上车 = 1e6 秒，远大于任何真实行程
  const FARE_BIG = 1e7;     // 「车费最便宜」的第一目标：1 公里计费里程 = 1e7 秒
  const STRATS = [
    { key: 'time', label: '时间最短' },
    { key: 'xfer', label: '换乘最少' },
    { key: 'fare', label: '车费最便宜' }
  ];
  // 起点 / 终点 / 当前策略由面板读写；换一张地图或重开一局时由 NetMap 清空
  const state = { from: null, to: null, strategy: 'time' };
  const NAV = { STRATS: STRATS, state: state };

  function compiled(g) {
    const m = g && g.model, net = m && m.net;
    return (net && net.C) || (g && g.compiled) || null;
  }
  function lineOf(G, lid) { return G.lines[lid] || null; }
  function lineName(G, lid) { const L = lineOf(G, lid); return L ? L.name : lid; }
  function lineColor(G, lid) {
    const L = lineOf(G, lid);
    if (!L) return '#607d8b';
    return CM.Accessibility && CM.Accessibility.line ? CM.Accessibility.line(L) : (L.color || '#607d8b');
  }
  // 票价文字：与经营面板同一个 fmtFare，去掉「/次」后缀（导航结果里只写金额）
  function fareText(v) {
    if (!(v > 0)) return '免费';
    // 兜底（界面模块还没加载时）也要去掉多余的小数位，别写出「¥2.0」
    const s = CM.UI && CM.UI.fmtFare ? CM.UI.fmtFare(v) : ((CM.CFG.money.sym || '¥') + String(+v.toFixed(2)));
    return String(s).replace(/\/次$/, '');
  }
  NAV.fareText = fareText;

  // ---------------- 可选车站 ----------------
  // 只列运营中的车站（C.serviced）：停用站、预留站、没有线路经过的车站都不出现
  NAV.stations = function (g) {
    const C = compiled(g);
    if (!C || !C.stations) return [];
    const out = [];
    C.stations.forEach(function (s, i) {
      if (C.serviced && !C.serviced[i]) return;
      out.push({ id: s.id, name: s.name, idx: i, lines: C.stationLines && C.stationLines[i] ? Array.from(C.stationLines[i]) : [] });
    });
    const lang = CM.I18n && CM.I18n.get() === 'en' ? 'en' : 'zh-Hans-CN';
    out.sort(function (a, b) {
      const x = String(CM.I18n ? CM.I18n.text(a.name) : a.name), y = String(CM.I18n ? CM.I18n.text(b.name) : b.name);
      return x.localeCompare(y, lang) || (a.id < b.id ? -1 : 1);
    });
    return out;
  };

  // ---------------- 图 ----------------
  // 节点：0…N-1 为车站（站厅），其后每站台两个节点（k×2+0 顺向、k×2+1 逆向）。
  // 边：board（车站→车上，含候车）、alight（车上→车站）、ride（车上→车上）、walk（站外换乘的两站之间）。
  function build(g) {
    const C = compiled(g);
    if (!C || !C.routes || !C.stations) return { error: '线网还没有编译，无法规划' };
    const net = C.net || (g && g.net) || {};
    const lines = net.lines || {};
    const N = C.stations.length, R = C.routes, mc = CM.CFG.metro || {};
    const off = new Int32Array(R.length);
    let nNodes = N;
    for (let r = 0; r < R.length; r++) { off[r] = nNodes; nNodes += 2 * R[r].stIds.length; }
    const nSt = new Int32Array(nNodes);
    for (let i = 0; i < N; i++) nSt[i] = i;
    for (let r = 0; r < R.length; r++) {
      const rt = R[r];
      for (let k = 0; k < rt.stIds.length; k++) { nSt[off[r] + 2 * k] = rt.stIdx[k]; nSt[off[r] + 2 * k + 1] = rt.stIdx[k]; }
    }
    // 当前时段的发车频率（列/小时，按方向）：与 metroSkim 的 freq / freqDir 同一来源
    const res = g && g.model && g.model.resultsFor ? g.model.resultsFor('wd') : null;
    // 车队模块在 index.html 里排在 nav.js 之后，这里按需取，不能在模块顶层捕获
    const FT = CM.Fleet;
    const per0 = FT && FT.periodOf ? FT.periodOf(g) : 0;
    const pp = res && res.per && res.per.length ? res.per[Math.max(0, Math.min(res.per.length - 1, per0))] : null;
    const freq = function (r, d) {
      if (!pp || !pp.freq) return 0;
      if (pp.freqDir && pp.freqDir.length >= 2 * r + 2) return +pp.freqDir[2 * r + (d > 0 ? 0 : 1)] || 0;
      return +pp.freq[r] || 0;
    };
    let live = 0;
    for (let r = 0; r < R.length; r++) live += freq(r, 1) + freq(r, -1);
    // 全网都没有频率（刚读档、还没有求解结果）时按最低服务水平兜底，避免导航一片空白；
    // 只有个别交路没有车时仍然视为停运，与模拟里「没有列车不能上车」一致
    const fallback = live > 0 ? 0 : Math.max(1, (mc.fMin && mc.fMin[0]) || 6);
    const fr = function (r, d) { const f = freq(r, d); return f > 0 ? f : fallback; };
    // 同一车站、同一去向的多条交路合并候车（先来先上）：候车 = 发车间隔的一半 = 30 / 合计频率
    const groups = new Map();
    for (let r = 0; r < R.length; r++) {
      const rt = R[r], n = rt.stIds.length; if (n < 2) continue;
      for (let k = 0; k < n; k++) for (let q = 0; q < 2; q++) {
        const d = q === 0 ? 1 : -1;
        if (!rt.loop && ((d > 0 && k === n - 1) || (d < 0 && k === 0))) continue;
        const f = fr(r, d); if (!(f > 0)) continue;
        const nx = rt.stIds[(k + d + n) % n], key = rt.lineId + '|' + rt.stIds[k] + '|' + nx;
        groups.set(key, (groups.get(key) || 0) + f);
      }
    }
    const adj = new Array(nNodes), add = function (a, e) { e.from = a; (adj[a] || (adj[a] = [])).push(e); };
    const fw = fareWeights(g);
    for (let r = 0; r < R.length; r++) {
      const rt = R[r], n = rt.stIds.length; if (n < 2) continue;
      if (!lines[rt.lineId]) continue;
      const is160 = M.lineKmh && M.lineKmh(lines[rt.lineId]) >= 160;
      const base = off[r];
      for (let k = 0; k < n; k++) {
        for (let q = 0; q < 2; q++) {
          const d = q === 0 ? 1 : -1;
          // 非环线：该方向在终点站不能再上车、在起点站不能下车；
          // 但终点站一定要有下车边（否则在终点换乘、或坐到底都出不了站）
          const noBoard = !rt.loop && ((d > 0 && k === n - 1) || (d < 0 && k === 0));
          const noAlight = !rt.loop && ((d > 0 && k === 0) || (d < 0 && k === n - 1));
          const f = fr(r, d); if (!(f > 0)) continue;
          const nx = rt.stIds[(k + d + n) % n], key = rt.lineId + '|' + rt.stIds[k] + '|' + nx;
          const wait = 30 / Math.max(0.5, groups.get(key) || f);
          const lv = rt.lvPen && rt.lvPen[k] ? (mc.levelXferMin || 0) : 0;
          const node = base + 2 * k + q, sid = rt.stIdx[k];
          // 上车：候车 + 非主站台层的垂直通道
          if (!noBoard) add(sid, { to: node, kind: 'board', sec: (wait + lv) * 60, km: 0, r: r, lineId: rt.lineId, k: k, d: d });
          // 下车：同样要走出非主站台层
          if (!noAlight) add(node, { to: sid, kind: 'alight', sec: lv * 60, km: 0, r: r, lineId: rt.lineId, k: k, d: d });
          if (noBoard) continue;
          // 乘车：区间运行 + 到站停站
          const li = d > 0 ? k : k - 1;
          const sec = ((rt.legSec && rt.legSec[li] != null) ? rt.legSec[li] : 60) + (mc.dwell || 0);
          const km = (rt.legLenM && rt.legLenM[li] != null) ? rt.legLenM[li] / 1000 : 0;
          const refs = (rt.legSegs && rt.legSegs[li]) || (rt.segRefs && rt.segRefs[li] ? [rt.segRefs[li]] : []);
          const segIds = refs.map(function (x) { return x && x.id != null ? x.id : x; }).filter(function (x) { return x != null; });
          add(node, {
            to: base + 2 * ((k + d + n) % n) + q, kind: 'ride', sec: sec, km: km, r: r, lineId: rt.lineId, d: d, segIds: segIds,
            fareUnits: fw.dist ? km * (is160 ? fw.ratio : 1) : (is160 ? fw.p160 : 0), is160: is160
          });
        }
      }
    }
    // 站外换乘与长距离换乘：acc.transfers 的 a / b 是 C 站索引
    const model = g && g.model, mnet = model && model.net;
    if (mnet && mnet.acc && mnet.acc.transfers && mnet.C === C) {
      const mpm = (CM.CFG.walk && CM.CFG.walk.mPerMin) || 75;
      for (const tr of mnet.acc.transfers) {
        const m = tr.same ? 0 : (tr.m || 0), sec = m / mpm * 60;
        add(tr.a, { to: tr.b, kind: 'walk', sec: sec, km: 0, m: m, same: !!tr.same });
        add(tr.b, { to: tr.a, kind: 'walk', sec: sec, km: 0, m: m, same: !!tr.same });
      }
    }
    return {
      C: C, lines: lines, N: N, nNodes: nNodes, off: off, nSt: nSt, adj: adj,
      // 换乘步行：站内换乘按固定 4 分钟计（游戏方式选择里的 transferPen，含站台间走动）
      xferSec: ((CM.CFG.choice && CM.CFG.choice.transferPen) || 4) * 60
    };
  }

  // 计费里程的权重：按里程计费时 160 轨道按起步价倍数折算；统一票价时只区分「会不会上 160 轨道」
  function fareWeights(g) {
    const m = (g && g.model) || {}, e = (g && g.econ) || {}, def = CM.CFG.fareDefault || { mode: 'flat', flat: 2 };
    const f = m.fare || e.fare || def, f6 = m.fare160 || e.fare160 || null;
    if (f && f.mode === 'dist' && f.inc > 0) {
      return { dist: true, ratio: (f6 && f6.flat > 0 && f.flat > 0) ? Math.max(1, f6.flat / f.flat) : 1, p160: 0 };
    }
    const p160 = f6 && (f6.flat || 0) > (f ? (f.flat || 0) : 0) ? 1 : 0;
    return { dist: false, ratio: 1, p160: p160 };
  }
  NAV.fareWeights = fareWeights;

  // 一次票价：换乘不另收费，按总乘距算；用到 160 轨道时与 160 票价（按 160 段的乘距）取高
  function fareOf(g, plan) {
    const m = (g && g.model) || {}, e = (g && g.econ) || {}, def = CM.CFG.fareDefault || { mode: 'flat', flat: 2 };
    const f = m.fare || e.fare || def, f6 = m.fare160 || e.fare160 || null;
    let v = 0;
    try { v = CM.Model ? CM.Model.fareAt(f, plan.km) : (f.flat || 0); } catch (err) { v = f.flat || 0; }
    if (plan.km160 > 0 && f6) {
      let w = 0;
      try { w = CM.Model.fareAt(f6, plan.km160); } catch (err) { w = f6.flat || 0; }
      if (w > v) v = w;
    }
    return v;
  }
  NAV.fareOf = fareOf;

  // ---------------- 最短路 ----------------
  // 返回边序列；边权随策略变化，但都是可加的标量，所以同一套 Dijkstra 就够了
  function search(G, from, to, mode) {
    const adj = G.adj, n = G.nNodes;
    const dist = new Float64Array(n).fill(INF), prev = new Int32Array(n).fill(-1), pe = new Array(n);
    const heap = new U.Heap(2048);
    dist[from] = 0; heap.push(0, from);
    const pen = G.xferSec, big = mode === 'xfer' ? BOARD_BIG : 0, fm = mode === 'fare' ? FARE_BIG : 0;
    while (heap.n) {
      const u = heap.pop(), du = heap.lastKey;
      if (du > dist[u] + 1e-9) continue;
      if (u === to) break;
      const list = adj[u]; if (!list) continue;
      const pk = pe[u] ? pe[u].kind : '';
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        let c = e.sec;
        // 换乘步行只算在「不是第一次上车、也不是刚走完站外换乘」的上车边上
        if (e.kind === 'board') {
          if (u !== from && pk !== 'walk') c += pen;
          if (big) c += big;
        }
        if (fm && e.kind === 'ride') c += fm * (e.fareUnits || 0);
        const v = e.to, nd = du + c;
        if (nd < dist[v] - 1e-9) { dist[v] = nd; prev[v] = u; pe[v] = e; heap.push(nd, v); }
      }
    }
    if (!(dist[to] < INF)) return null;
    const chain = [];
    for (let v = to; v !== from;) { const e = pe[v]; if (!e) return null; chain.push(e); v = prev[v]; }
    chain.reverse();
    return chain;
  }

  // 把边序列整理成可展示的方案：分段（每次上车一段）、换乘站、经过站点、耗时构成与票价
  function describe(G, chain, key) {
    const C = G.C, sid = function (i) { return C.stations[i].id; };
    const legs = [], stations = [];
    let cur = null, boards = 0, rideSec = 0, waitSec = 0, walkSec = 0, km = 0, km160 = 0, lastKind = '';
    const pushSt = function (i) { if (!stations.length || stations[stations.length - 1] !== i) stations.push(i); };
    pushSt(G.nSt[chain[0].from]);
    for (const e of chain) {
      if (e.kind === 'board') {
        const first = boards === 0;
        boards++;
        const pen = (!first && lastKind !== 'walk') ? G.xferSec : 0;
        waitSec += e.sec; walkSec += pen;
        cur = {
          kind: 'ride', lineId: e.lineId, r: e.r, d: e.d, stops: [G.nSt[e.from]], sec: 0, wait: e.sec, xferWalk: pen,
          km: 0, km160: 0, segIds: []
        };
      } else if (e.kind === 'ride' && cur) {
        cur.sec += e.sec; cur.km += e.km; rideSec += e.sec; km += e.km;
        if (e.is160) { cur.km160 += e.km; km160 += e.km; }
        cur.stops.push(G.nSt[e.to]);
        for (const id of (e.segIds || [])) if (cur.segIds.indexOf(id) < 0) cur.segIds.push(id);
        pushSt(G.nSt[e.to]);
      } else if (e.kind === 'alight') {
        if (cur) { legs.push(cur); cur = null; }
      } else if (e.kind === 'walk') {
        if (cur) { legs.push(cur); cur = null; }
        legs.push({ kind: 'walk', from: G.nSt[e.from], to: G.nSt[e.to], m: e.m || 0, sec: e.sec });
        walkSec += e.sec;
        pushSt(G.nSt[e.to]);
      }
      lastKind = e.kind;
    }
    if (cur) legs.push(cur);
    // 每一段：终点站名、方向说明（环线写顺行/逆行，其余写终点站）
    for (const leg of legs) {
      if (leg.kind !== 'ride') { leg.fromId = sid(leg.from); leg.toId = sid(leg.to); continue; }
      const rt = C.routes[leg.r], n = rt.stIds.length;
      leg.line = lineOf(G, leg.lineId);
      leg.fromId = sid(leg.stops[0]); leg.toId = sid(leg.stops[leg.stops.length - 1]);
      leg.stopIds = leg.stops.map(sid);
      leg.nStops = Math.max(0, leg.stops.length - 1);
      if (rt.loop) leg.dirName = leg.d > 0 ? '顺行' : '逆行';
      else leg.dirName = G.C.stations[leg.d > 0 ? rt.stIdx[n - 1] : rt.stIdx[0]].name;
    }
    // 换乘站：上一段结束的地方（ride 的终点站 / 站外步行的落点）＝ 下一段上车的地方
    const xferIds = [];
    for (let i = 1; i < legs.length; i++) xferIds.push(legs[i - 1].toId);
    const totalSec = rideSec + waitSec + walkSec;
    const plan = {
      key: key, ok: true, legs: legs, minutes: totalSec / 60, rideMin: rideSec / 60, waitMin: waitSec / 60, walkMin: walkSec / 60,
      transfers: Math.max(0, boards - 1), km: km, km160: km160,
      stIds: stations.map(sid), xferIds: xferIds
    };
    // 高亮用：所有区间编号
    const segs = [];
    for (const leg of legs) if (leg.kind === 'ride') for (const id of leg.segIds) if (segs.indexOf(id) < 0) segs.push(id);
    plan.segIds = segs;
    // 方案指纹：三种策略结果相同时界面只提示一次
    plan.sig = legs.map(function (l) { return l.kind === 'ride' ? 'r' + l.lineId + ':' + l.stopIds.join(',') : 'w' + l.toId + ':' + Math.round(l.m); }).join('|');
    plan.fare = fareOf(G.game, plan);
    plan.fareText = fareText(plan.fare);
    return plan;
  }

  // ---------------- 对外：三种策略 ----------------
  NAV.plans = function (g, fromId, toId) {
    const C = compiled(g);
    if (!C || !C.stations) return { ok: false, error: '线网还没有编译，无法规划' };
    if (!fromId || !toId) return { ok: false, empty: true, error: '' };
    const idx = function (id) { return C.sIndex && C.sIndex.get ? C.sIndex.get(id) : C.stations.findIndex(function (s) { return s.id === id; }); };
    const a = idx(fromId), b = idx(toId);
    if (a == null || a < 0 || b == null || b < 0) return { ok: false, error: '起点或终点不在这张线网里' };
    if (a === b) return { ok: false, same: true, error: '起点与终点相同' };
    if (C.serviced && (!C.serviced[a] || !C.serviced[b])) return { ok: false, error: '该站暂未开通运营' };
    const G = build(g);
    if (G.error) return { ok: false, error: G.error };
    G.game = g;
    const items = {};
    for (const s of STRATS) {
      const chain = search(G, a, b, s.key);
      if (chain) items[s.key] = describe(G, chain, s.key);
    }
    if (!items.time && !items.xfer && !items.fare) return { ok: false, error: '两站之间没有运营中的线路连接' };
    return { ok: true, items: items, from: fromId, to: toId, C: C, G: G };
  };
  NAV._build = build; // TEMP DEBUG

  // ---------------- 图中高亮 ----------------
  const CLS = ['nav-hl', 'nav-st', 'nav-x'];
  NAV.clear = function (root) {
    const svg = root && root.querySelector ? root.querySelector('.nm-svg') : null;
    if (!svg) return;
    svg.classList.remove('nav-on');
    for (const c of CLS) svg.querySelectorAll('.' + c).forEach(function (el) { el.classList.remove(c); });
  };
  NAV.highlight = function (root, plan) {
    NAV.clear(root);
    const svg = root && root.querySelector ? root.querySelector('.nm-svg') : null;
    if (!svg || !plan || !plan.ok) return;
    svg.classList.add('nav-on');
    const segs = new Set(plan.segIds || []), sts = new Set(plan.stIds || []), xf = new Set(plan.xferIds || []);
    const lids = new Set();
    for (const leg of plan.legs || []) if (leg.kind === 'ride') lids.add(leg.lineId);
    svg.querySelectorAll('.nm-lines > g[data-segment]').forEach(function (el) {
      if (segs.has(el.getAttribute('data-segment'))) el.classList.add('nav-hl');
    });
    // 区间也可能是「同一条线共用走廊」的几个分组：没有 data-segment 的旧结构按线路兜底
    if (!segs.size) svg.querySelectorAll('.nm-lines > g[data-line]').forEach(function (el) { if (lids.has(el.getAttribute('data-line'))) el.classList.add('nav-hl'); });
    // 线路端点徽标：用到的线路保持清晰，其余跟着压暗
    svg.querySelectorAll('.nm-badges g[data-line]').forEach(function (el) { if (lids.has(el.getAttribute('data-line'))) el.classList.add('nav-hl'); });
    svg.querySelectorAll('.nm-dots > *[data-st], .nm-labels text[data-st]').forEach(function (el) {
      const id = el.getAttribute('data-st');
      if (!sts.has(id)) return;
      el.classList.add('nav-st');
      if (xf.has(id)) el.classList.add('nav-x');
    });
  };

  // ---------------- 面板 ----------------
  function nodeName(G, id) {
    const C = G && G.C, i = C && C.sIndex ? C.sIndex.get(id) : -1;
    const s = i != null && i >= 0 ? C.stations[i] : null;
    return s ? (CM.I18n ? CM.I18n.text(s.name) : s.name) : '';
  }
  function lineChip(G, lid) {
    const L = lineOf(G, lid), badge = L && M.lineBadge ? M.lineBadge(L) : (lid || '');
    return h('span', { class: 'nm-nav-badge', style: { background: lineColor(G, lid), color: CM.Accessibility && CM.Accessibility.ink ? CM.Accessibility.ink(lineColor(G, lid)) : '#fff' } }, badge);
  }
  // 「32 号线」这类只有线路号的名字：徽标里已经写着 32，换乘行不再重复一遍名称；
  // 「机场快线」这种徽标只是缩写（机场）的，仍然把全名写出来
  function badgeCovers(G, lid) {
    const L = lineOf(G, lid);
    if (!L) return true;
    const b = M.lineBadge ? M.lineBadge(L) : '';
    if (!/^[0-9A-Za-z]{1,4}$/.test(b)) return false;
    const rest = String(L.name || '').split(b).join('').replace(/号线|线路|线|line/gi, '').replace(/\s+/g, '');
    return rest === '';
  }
  // 一段乘车：线路徽标、方向、经过站点、站数与分段耗时
  function legCard(G, leg, xfSet) {
    const name = function (id) { return nodeName(G, id); };
    const stops = h('div', { class: 'nm-nav-stops' });
    leg.stopIds.forEach(function (id, i) {
      if (i) stops.appendChild(document.createTextNode(' → '));
      const t = name(id);
      stops.appendChild(xfSet.has(id) ? h('b', { class: 'nm-nav-xstop' }, t) : document.createTextNode(t));
    });
    const mins = Math.max(1, Math.round(leg.sec / 60));
    return h('div', { class: 'nm-nav-leg' },
      h('div', { class: 'nm-nav-legh' },
        lineChip(G, leg.lineId), h('b', null, lineName(G, leg.lineId)),
        h('span', { class: 'tiny muted' }, '往 ' + leg.dirName + ' 方向')),
      stops,
      h('div', { class: 'tiny muted nm-nav-legm' }, leg.nStops + ' 站 · 乘车 ' + mins + ' 分钟 · 候车 ' + Math.round(leg.wait / 60) + ' 分钟'));
  }
  function transferRow(G, atId, leg) {
    const name = nodeName(G, atId);
    const walk = leg.xferWalk > 0 ? Math.round(leg.xferWalk / 60) : 0;
    return h('div', { class: 'nm-nav-xf' },
      h('span', { class: 'nm-nav-xfdot' }),
      '在 ' + name + ' 换乘', lineChip(G, leg.lineId),
      badgeCovers(G, leg.lineId) ? null : h('b', null, lineName(G, leg.lineId)),
      walk > 0 ? h('span', { class: 'tiny muted' }, ' · 站内步行 ' + walk + ' 分钟') : null);
  }
  function walkRow(G, leg) {
    return h('div', { class: 'nm-nav-xf walk' },
      h('span', { class: 'nm-nav-xfdot' }),
      '步行 ' + U.fmtNum(Math.round(leg.m), 0) + ' 米到 ' + nodeName(G, leg.toId),
      h('span', { class: 'tiny muted' }, '· ' + Math.max(1, Math.round(leg.sec / 60)) + ' 分钟'));
  }

  NAV.panel = function (g, opts) {
    opts = opts || {};
    const st = state, list = NAV.stations(g), ids = new Set(list.map(function (s) { return s.id; }));
    if (st.from && !ids.has(st.from)) st.from = null;
    if (st.to && !ids.has(st.to)) st.to = null;
    if (!st.from && opts.seed && ids.has(opts.seed)) st.from = opts.seed;

    const out = h('div', { class: 'nm-nav-out' });
    const pick = function (val, which) {
      const el = h('select', {
        class: 'nm-nav-sel', 'aria-label': which === 'from' ? '起点车站' : '终点车站',
        onchange: function () { st[which] = el.value || null; if (which === 'from' && st.to === st.from) st.to = null; draw(); }
      }, h('option', { value: '' }, '选择车站'), list.map(function (s) { return h('option', { value: s.id }, CM.I18n ? CM.I18n.text(s.name) : s.name); }));
      el.value = val || '';
      return el;
    };
    const selA = pick(st.from, 'from'), selB = pick(st.to, 'to');
    const swap = h('button', {
      class: 'hbtn nm-nav-swap', 'aria-label': '交换起点与终点', 'data-tip': '交换起点与终点', 'data-silent': '1',
      onclick: function () {
        const a = st.from; st.from = st.to; st.to = a;
        selA.value = st.from || ''; selB.value = st.to || ''; draw();
      }
    }, '⇅');
    const tabs = h('div', { class: 'seg-ctl sm nm-nav-tabs', 'aria-label': '路线策略' }, STRATS.map(function (s) {
      return h('button', {
        'data-strat': s.key, class: st.strategy === s.key ? 'on' : '', 'aria-pressed': st.strategy === s.key ? 'true' : 'false', 'data-silent': '1',
        onclick: function () { if (st.strategy === s.key) return; st.strategy = s.key; syncTabs(); draw(); }
      }, s.label);
    }));
    const syncTabs = function () {
      tabs.querySelectorAll('button').forEach(function (b) {
        const on = b.getAttribute('data-strat') === st.strategy;
        b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    };

    // 结果区：一次算三种策略，切页签不再重算；高亮交给 NetMap 的 onPlan
    function draw() {
      out.innerHTML = '';
      let plans = null;
      try { plans = NAV.plans(g, st.from, st.to); }
      catch (err) { plans = { ok: false, error: '规划失败：' + (err && err.message ? err.message : err) }; console.error(err); }
      if (!st.from || !st.to) {
        out.appendChild(h('div', { class: 'nm-nav-hint' }, '选择起点与终点站，查看三种乘车方案。'));
        out.appendChild(h('div', { class: 'tiny muted' }, '也可以直接点击图中的车站：先点起点，再点终点。'));
        if (opts.onPlan) opts.onPlan(null);
        return;
      }
      if (!plans.ok) {
        out.appendChild(h('div', { class: 'nm-nav-hint warn' }, plans.error || '无法规划这条行程'));
        if (opts.onPlan) opts.onPlan(null);
        return;
      }
      const item = plans.items[st.strategy] || plans.items.time;
      const G = plans.G;
      if (!item) {
        out.appendChild(h('div', { class: 'nm-nav-hint warn' }, '这条策略下没有可行方案'));
        if (opts.onPlan) opts.onPlan(null);
        return;
      }
      // 三种策略一致时说明一句，免得玩家以为切换没生效
      const same = STRATS.filter(function (s) { return s.key !== st.strategy && plans.items[s.key] && plans.items[s.key].sig === item.sig; }).map(function (s) { return s.label; });
      const xfSet = new Set(item.xferIds || []);
      const lineSeq = [];
      for (const leg of item.legs) if (leg.kind === 'ride' && lineSeq[lineSeq.length - 1] !== leg.lineId) lineSeq.push(leg.lineId);
      const head = h('div', { class: 'nm-nav-sum' },
        h('div', { class: 'nm-nav-big' }, h('b', null, String(Math.max(1, Math.round(item.minutes)))), h('span', null, '分钟')),
        h('div', { class: 'nm-nav-kv' },
          h('span', null, '换乘 ' + item.transfers + ' 次'),
          h('span', null, '票价 ' + item.fareText),
          h('span', null, U.fmtNum(item.km, 1) + ' km')),
        h('div', { class: 'nm-nav-lines' }, lineSeq.map(function (lid) { return lineChip(G, lid); })));
      out.appendChild(head);
      out.appendChild(h('div', { class: 'tiny muted nm-nav-break' },
        '乘车 ' + Math.round(item.rideMin) + ' 分钟 · 候车 ' + Math.round(item.waitMin) + ' 分钟 · 换乘步行 ' + Math.round(item.walkMin) + ' 分钟'));
      if (same.length) out.appendChild(h('div', { class: 'tiny muted nm-nav-same' }, '与「' + same.join('、') + '」相同'));
      const box = h('div', { class: 'nm-nav-route' });
      item.legs.forEach(function (leg, i) {
        if (leg.kind === 'walk') {
          box.appendChild(walkRow(G, leg));
          const nxt = item.legs[i + 1];
          if (nxt && nxt.kind === 'ride') box.appendChild(h('div', { class: 'nm-nav-xf sub' }, '换乘', lineChip(G, nxt.lineId),
            badgeCovers(G, nxt.lineId) ? null : h('b', null, lineName(G, nxt.lineId))));
          return;
        }
        const prev = item.legs[i - 1];
        if (prev && prev.kind === 'ride') box.appendChild(transferRow(G, prev.toId, leg));
        box.appendChild(legCard(G, leg, xfSet));
      });
      // 终点
      const last = item.legs[item.legs.length - 1];
      if (last) box.appendChild(h('div', { class: 'nm-nav-end' }, '到达 ' + nodeName(G, last.toId)));
      out.appendChild(box);
      out.appendChild(h('div', { class: 'tiny muted nm-nav-note' },
        '按当前时段的发车频率与运行速度估算：候车取发车间隔的一半，站内换乘按 ' + Math.round((CM.CFG.choice && CM.CFG.choice.transferPen) || 4) + ' 分钟步行计。'));
      if (opts.onPlan) opts.onPlan(item, plans);
    }

    const el = h('div', { class: 'nm-nav', 'aria-label': '地铁导航' },
      h('div', { class: 'nm-nav-head' },
        h('span', { class: 'nm-nav-title' }, CM.icon('route', 16), h('b', null, '地铁导航')),
        h('button', { class: 'hbtn nm-nav-close', 'aria-label': '关闭导航', 'data-tip': '关闭导航', 'data-silent': '1', onclick: function () { if (opts.onClose) opts.onClose(); } }, CM.icon('close'))),
      h('div', { class: 'nm-nav-od' },
        h('label', { class: 'nm-nav-f' }, h('span', null, '起点'), selA),
        swap,
        h('label', { class: 'nm-nav-f' }, h('span', null, '终点'), selB)),
      tabs,
      out);
    draw();
    return {
      el: el,
      refresh: function () { selA.value = st.from || ''; selB.value = st.to || ''; syncTabs(); draw(); },
      pickStation: function (sid) {
        if (!ids.has(sid)) return;
        // 点图选站：先点起点、再点终点；两端都选好后再点一次＝重新选起点
        if (!st.from || (st.from && st.to)) { st.from = sid; st.to = null; }
        else st.to = sid;
        selA.value = st.from || ''; selB.value = st.to || ''; draw();
      }
    };
  };

  NAV.reset = function () { state.from = null; state.to = null; state.strategy = 'time'; };
  CM.Nav = NAV;
})(window.CM);
