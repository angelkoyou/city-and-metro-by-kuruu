'use strict';
// 作弊工具（v2.9.6）：人口密度刷子 + 自定义设施。
// 两个工具都不做「只改画面」的假效果：
//   · 人口密度刷子把「人/km²」换算成每格人口写进 city.pop，和城市自身增长出来的人口一样进入交通小区与出行需求；
//   · 自定义设施进入设施表（CM.Fac.list），和其他重要设施一起参与出行吸引、由设施图层画出圆点与标注。
(function (CM) {
  const U = CM.U, CFG = CM.CFG;
  const h = U.h, ic = CM.icon;

  // 每次单击增加的人口密度（人/km²）。与「图层 · 人口密度」同一口径（图例 0–6 万人/km²，颜色越深越大）
  // v3.0：人口密度刷子改成连续滑块——1–10 万人/km²，作用半径 1–10 km（内部按格计算，1 格 250 m）。
  // DENS / RADII 仍保留为「常用档位」，供滑块的刻度与测试引用；真正生效的是 T.popDens（人/km²）与 T.popR（km）。
  const DENS = [10000, 20000, 30000, 40000, 50000, 60000, 70000, 80000, 90000, 100000];
  const RADII = [1, 2, 3, 5, 8, 10];               // 作用半径（km）
  const CELL_KM2 = Math.pow(CFG.CELL_M / 1000, 2);  // 每格面积：0.0625 km²
  // 自定义设施：类别取设施系统里的非枢纽类型（铁路站 / 机场需要外生的旅客量，不在这里做）
  const FAC_TYPES = ['shop', 'cbd', 'uni', 'hosp', 'scenic', 'park', 'stadium', 'venue'];
  const SHARES = [0.002, 0.005, 0.01, 0.02];       // 占全市该目的出行吸引的比例
  const SIZES = [{ r: 0.6, name: '小' }, { r: 1, name: '中' }, { r: 1.6, name: '大' }];
  const MAX_FAC = 60, MAX_OPS = 60, MAX_MARKS = 400;
  const FILL = 0.04;                               // city.growMonth 每月吸收的超额比例（人口）
  const WALK = function () { return (CFG.walk && CFG.walk.maxAccessM ? CFG.walk.maxAccessM : 1125) / CFG.CELL_M; };

  const Cheat = { DENS: DENS, RADII: RADII, FAC_TYPES: FAC_TYPES, SHARES: SHARES, SIZES: SIZES, CELL_KM2: CELL_KM2, MAX_FAC: MAX_FAC };
  CM.Cheat = Cheat;

  // 密度与人口：1 人/km² 落在 250 m 的格子上是 0.0625 人
  Cheat.peopleOf = function (dens) { return dens * CELL_KM2; };
  Cheat.densText = function (v) {
    const en = CM.I18n && CM.I18n.get && CM.I18n.get() === 'en';
    return en ? U.fmtInt(v) + ' people/km²' : U.fmtNum(v / 1e4, 1) + ' 万人/km²';
  };
  // 这一格现在的常住人口密度（人/km²），与人口密度图层的取值同一口径
  Cheat.densAt = function (g, x, y) {
    const c = g.city.cellAt(x, y);
    return c < 0 ? 0 : g.city.pop[c] / CELL_KM2;
  };

  // ---------------- 状态 ----------------
  Cheat.empty = function () {
    return { marks: [], cfacs: [], ops: [], res: {}, totalPop: 0, totalFac: 0, used: false, readout: null, lastAt: null, lastBox: null, seq: 0, ver: 0 };
  };
  Cheat.of = function (g) {
    g = g || CM.game;
    if (!g) return Cheat.empty();
    if (!g.cheat || typeof g.cheat !== 'object') g.cheat = Cheat.empty();
    const s = g.cheat;
    if (!Array.isArray(s.marks)) s.marks = [];
    if (!Array.isArray(s.cfacs)) s.cfacs = [];
    if (!Array.isArray(s.ops)) s.ops = [];
    if (!s.res || typeof s.res !== 'object') s.res = {};
    if (!(s.seq >= 0)) s.seq = 0;
    if (!(s.ver >= 0)) s.ver = 0;
    return s;
  };
  // 设施表的缓存版本：改动自定义设施后要让 CM.Fac.list 重建（见 facility.js 里的 _facCV）
  Cheat.ver = function () {
    const g = CM.game;
    return g && g.cheat && g.cheat.ver ? g.cheat.ver : 0;
  };
  // 自定义设施的内容签名：cache 键带上它，读档后即使 ver 相同也不会误用上一局的设施表
  Cheat.sig = function () {
    const g = CM.game, s = g && g.cheat && Array.isArray(g.cheat.cfacs) ? g.cheat.cfacs : [];
    return s.map(function (c) { return c.id + ':' + c.t + ':' + c.x + ':' + c.y + ':' + c.r + ':' + c.open; }).join(',');
  };
  Cheat.pack = function (s) {
    return {
      marks: s.marks.map(function (m) { return { x: m.x, y: m.y, r: m.r }; }),
      cfacs: s.cfacs.map(function (c) { return { id: c.id, name: c.name, t: c.t, x: c.x, y: c.y, r: c.r, open: c.open, w: c.w }; }),
      res: s.res, totalPop: s.totalPop, totalFac: s.totalFac, used: s.used, seq: s.seq,
    };
  };
  Cheat.restore = function (raw) {
    const s = Cheat.empty();
    if (!raw || typeof raw !== 'object') return s;
    const num = function (v) { return Number.isFinite(+v) ? +v : 0; };
    for (const m of Array.isArray(raw.marks) ? raw.marks.slice(-MAX_MARKS) : []) {
      if (!m || !Number.isFinite(+m.x) || !Number.isFinite(+m.y)) continue;
      s.marks.push({ x: +m.x, y: +m.y, r: U.clamp(Math.round(num(m.r) || 3), 1, 8) });
    }
    for (const c of Array.isArray(raw.cfacs) ? raw.cfacs.slice(-MAX_FAC) : []) {
      if (!c || !Number.isFinite(+c.x) || !Number.isFinite(+c.y) || FAC_TYPES.indexOf(c.t) < 0) continue;
      s.cfacs.push({ id: String(c.id || ('cf' + (s.cfacs.length + 1))), name: String(c.name || '自定义设施').slice(0, 20), t: c.t,
        x: +c.x, y: +c.y, r: U.clamp(num(c.r) || 1, 0.4, 3), open: num(c.open), w: U.clamp(num(c.w) || 0.005, 0.0001, 0.2) });
    }
    s.totalPop = num(raw.totalPop); s.totalFac = s.cfacs.length; s.used = !!raw.used;
    s.seq = Math.max(Math.round(num(raw.seq)), s.cfacs.length);
    if (raw.res && typeof raw.res === 'object') for (const k in raw.res) {
      const v = raw.res[k];
      if (!v || !(+v.p > 0)) continue;
      s.res[k] = { p: num(v.p), bp: v.bp == null ? null : num(v.bp) };
    }
    s.ver = 1;   // 读档后设施表要重建
    return s;
  };
  Cheat.on = function () { return !!(CM.Settings && CM.Settings.get('cheatOn')); };
  Cheat.set = function (on) { if (CM.Settings) CM.Settings.set('cheatOn', !!on); };
  // 进入工具时把图层切到对应的那张：改动立刻看得见（人口密度 / 设施）
  Cheat.onTool = function (t) {
    const ui = CM.ui;
    if (!ui || !ui.setLayer) return;
    const want = t === 'popbrush' ? 'pop' : (t === 'facbuild' ? 'fac' : null);
    if (want && ui.layer !== want) ui.setLayer(want);
  };

  // ---------------- 人口密度 ----------------
  const cellOk = function (city, c) { return c >= 0 && c < city.N && city.lu[c] !== CM.LU.WATER && city.landFrac[c] >= 0.3; };
  // 从中心向四周递减：中心 100%，边缘约 25%（1.5 次幂，靠近中心衰减慢、边缘收得快）
  Cheat.falloff = function (t) { return 1 - 0.75 * Math.pow(U.clamp(t, 0, 1), 1.5); };
  Cheat.planDensity = function (g, x, y, r) {
    const city = g.city, R = Math.max(1, Math.round(r)), cx = Math.floor(x), cy = Math.floor(y), list = [], frac = [];
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const d = Math.hypot(dx, dy);
      if (d > R) continue;
      const i = cx + dx, j = cy + dy;
      if (i < 0 || j < 0 || i >= city.W || j >= city.H) continue;
      const c = j * city.W + i;
      if (cellOk(city, c)) { list.push(c); frac.push(Cheat.falloff(d / Math.max(1, R))); }
    }
    return { cells: list, frac: frac, ok: list.length > 0 };
  };
  const noteRes = function (s, c, dp, bp) {
    const r = s.res[c] || (s.res[c] = { p: 0, bp: null });
    if (dp > 0 && r.bp == null) r.bp = bp;
    r.p += dp || 0;
  };
  // 半径内每格加上同样的密度（人/km²），不再做中心衰减：画出来就是图上那一圈颜色一起加深
  // dens：人/km²；km：作用半径（公里）。每格按到中心的距离递减（中心满值、边缘约 25%）
  Cheat.applyDensity = function (g, x, y, dens, km) {
    const R = Math.max(1, Math.round((km || 3) / (CFG.CELL_M / 1000)));
    const plan = Cheat.planDensity(g, x, y, R);
    if (!plan.ok) return { ok: false, msg: '这片是水面：没有可以容纳人口的地块' };
    const city = g.city, s = Cheat.of(g), dp = Cheat.peopleOf(dens);
    const op = { kind: 'dens', x: x, y: y, r: R, dens: dens, cells: [] };
    let total = 0;
    for (let k = 0; k < plan.cells.length; k++) {
      const c = plan.cells[k], add = dp * plan.frac[k], base = city.pop[c];
      city.pop[c] += add; op.cells.push([c, add]); noteRes(s, c, add, base); total += add;
    }
    s.marks.push({ x: x, y: y, r: R });
    while (s.marks.length > MAX_MARKS) s.marks.shift();
    s.totalPop += total; s.used = true;
    s.lastAt = { x: x, y: y }; s.lastBox = { x0: x - R, y0: y - R, x1: x + R, y1: y + R };
    Cheat.pushOp(s, op);
    return { ok: true, cells: plan.cells.length, people: total, dens: dens, km: km || 3 };
  };

  // ---------------- 自定义设施 ----------------
  // 变成设施系统认识的对象（CM.Fac.list 把它们接在真实设施后面）：位置、场地、启用年份、出行吸引都用同一套字段
  Cheat.facList = function () {
    const g = CM.game, Fac = CM.Fac;
    const s = g && g.cheat && Array.isArray(g.cheat.cfacs) ? g.cheat.cfacs : [];
    if (!s.length || !Fac) return [];
    const out = [];
    for (const c of s) {
      const T = Fac.TYPES[c.t]; if (!T) continue;
      out.push({
        k: 0, id: c.id, name: c.name, label: c.name, t: c.t, T: T, x: c.x, y: c.y, r: c.r, lmK: -1,
        open: c.open, close: null, w: [[0, c.w]], pax: null, p: T.p, we: null, note: '', src: null, ext: null, rw: null, gen: null, cus: true,
      });
    }
    return out;
  };
  Cheat.facById = function (id) {
    const g = CM.game, s = g && g.cheat;
    return s && Array.isArray(s.cfacs) ? (s.cfacs.find(function (c) { return c.id === id; }) || null) : null;
  };
  Cheat.addFac = function (g, at) {
    const s = Cheat.of(g), Fac = CM.Fac;
    if (s.cfacs.length >= MAX_FAC) return { ok: false, msg: '最多添加 ' + MAX_FAC + ' 座自定义设施' };
    const c = g.city.cellAt(at.x, at.y);
    if (c < 0 || g.city.landFrac[c] < 0.3) return { ok: false, msg: '这里不能建：水面或未成陆的地块' };
    const t = FAC_TYPES.indexOf(at.t) >= 0 ? at.t : 'shop', T = Fac.TYPES[t];
    s.seq++;
    const rec = {
      id: 'cf' + s.seq, name: String(at.name || (T.name + ' ' + s.seq)).slice(0, 20), t: t,
      x: at.x, y: at.y, r: at.r != null ? at.r : T.r, open: at.open != null ? at.open : Math.floor(g.year()),
      w: at.w != null ? at.w : 0.005,
    };
    s.cfacs.push(rec); s.totalFac = s.cfacs.length; s.used = true; s.ver++;
    s.lastAt = { x: at.x, y: at.y }; s.lastBox = { x0: at.x - rec.r, y0: at.y - rec.r, x1: at.x + rec.r, y1: at.y + rec.r };
    Cheat.pushOp(s, { kind: 'fac', id: rec.id });
    return { ok: true, f: rec };
  };
  // 改属性：名称只影响显示；类别 / 需求 / 规模 / 年份会改变出行吸引，需要重算
  Cheat.setFac = function (g, id, patch) {
    const rec = Cheat.facById(id);
    if (!rec) return false;
    let model = false;
    if (patch.name != null) { const n = String(patch.name).trim().slice(0, 20); if (n && n !== rec.name) { rec.name = n; Cheat.of(g).ver++; } }
    if (patch.t != null && FAC_TYPES.indexOf(patch.t) >= 0 && patch.t !== rec.t) { rec.t = patch.t; model = true; }
    if (patch.r != null && +patch.r > 0 && +patch.r !== rec.r) { rec.r = U.clamp(+patch.r, 0.4, 3); model = true; }
    if (patch.w != null && +patch.w > 0 && +patch.w !== rec.w) { rec.w = U.clamp(+patch.w, 0.0001, 0.2); model = true; }
    if (patch.open != null && +patch.open !== rec.open) { rec.open = Math.round(+patch.open); model = true; }
    if (model) { Cheat.of(g).ver++; Cheat.schedule(g); }
    return true;
  };
  Cheat.delFac = function (g, id) {
    const s = Cheat.of(g), i = s.cfacs.findIndex(function (c) { return c.id === id; });
    if (i < 0) return false;
    s.cfacs.splice(i, 1); s.totalFac = s.cfacs.length; s.ver++;
    s.ops = s.ops.filter(function (o) { return !(o.kind === 'fac' && o.id === id); });
    s.used = s.totalPop > 0 || s.cfacs.length > 0;
    Cheat.schedule(g);
    return true;
  };
  const facBox = function (f) { return { x0: f.x - f.r, y0: f.y - f.r, x1: f.x + f.r, y1: f.y + f.r }; };

  Cheat.pushOp = function (s, op) { s.ops.push(op); while (s.ops.length > MAX_OPS) s.ops.shift(); };

  // ---------------- 撤销 / 清除 ----------------
  Cheat.undo = function (g) {
    const s = Cheat.of(g), op = s.ops.pop();
    if (!op) return false;
    if (op.kind === 'dens') {
      const city = g.city;
      for (const it of op.cells) { const c = it[0]; city.pop[c] = Math.max(0, city.pop[c] - it[1]); const r = s.res[c]; if (r) { r.p -= it[1]; if (r.p <= 0.001) delete s.res[c]; } }
      s.totalPop = Math.max(0, s.totalPop - op.cells.length * Cheat.peopleOf(op.dens));
      const mi = s.marks.findIndex(function (m) { return Math.abs(m.x - op.x) < 1e-6 && Math.abs(m.y - op.y) < 1e-6 && m.r === op.r; });
      if (mi >= 0) s.marks.splice(mi, 1);
    } else if (op.kind === 'fac') {
      const i = s.cfacs.findIndex(function (c) { return c.id === op.id; });
      if (i < 0) return false;
      s.cfacs.splice(i, 1); s.totalFac = s.cfacs.length; s.ver++;
    }
    s.used = s.totalPop > 0 || s.cfacs.length > 0;
    Cheat.schedule(g);
    return true;
  };
  Cheat.clear = function (g) {
    const s = Cheat.of(g), city = g.city;
    let any = false;
    for (const k in s.res) {
      const r = s.res[k], c = +k;
      if (!(c >= 0 && c < city.N)) continue;
      city.pop[c] = Math.max(0, city.pop[c] - r.p);
      any = true;
    }
    s.res = {}; s.marks = []; s.totalPop = 0;
    if (s.cfacs.length) { s.cfacs = []; s.totalFac = 0; s.ver++; any = true; }
    s.ops = []; s.used = false;
    if (any) Cheat.schedule(g);
    return any;
  };

  // ---------------- 每月补回 ----------------
  // 城市增长机制每月把超出人口曲线的部分按 4% 吸收（见 city.growMonth），注入的人口会被一起吃掉。
  // 这里按「注入前底数 + 注入量」把这一格补回来，作弊效果才不会逐月衰减。
  Cheat.hold = function (g) {
    const s = g && g.cheat;
    if (!s || !s.res || !g.city) return;
    const city = g.city;
    let n = 0;
    for (const k in s.res) {
      const r = s.res[k], c = +k;
      if (!(c >= 0 && c < city.N) || !(r.p > 0)) continue;
      const floor = (r.bp == null ? 0 : r.bp) + r.p;
      if (city.pop[c] < floor - 0.5) { city.pop[c] = Math.min(floor, city.pop[c] + Math.max(1, r.p * FILL * 2.5)); n++; }
    }
    if (n) city.version++;
  };

  // ---------------- 重算与读数 ----------------
  let timer = null, pending = null;
  Cheat.schedule = function (g) {
    g = g || CM.game;
    if (!g) return;
    Cheat.markBefore(g);
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () { timer = null; Cheat.refresh(g); }, 300);
  };
  // 走和月结同一条刷新路径（refreshCityGen：小区 → 需求 → 步行接驳 → 网络）：自定义设施增减会改变
  // 设施节点的数量，只重建小区与需求的话接驳表（acc.zl / zCov 的下标 Z+k）还是旧的，设施客流就落不到车站上
  Cheat.refresh = function (g) {
    const model = g && g.model;
    if (!model || !model.refreshCityGen) return;
    const C = (g.compiled && g.compiled.C) || (model.net && model.net.C) || null;
    const t0 = performance.now();
    g.city.version++;   // 人口是直接改进去的（没走增长机制），让按城市版本缓存的量一起失效
    try {
      const it = model.refreshCityGen(C);
      let r = it.next();
      while (!r.done && performance.now() - t0 < 6000) r = it.next();
    } catch (e) { console.error(e); }
    model.wake(2);
    Cheat.awaitImpact(g);
  };
  Cheat.netC = function (g) { return (g && g.compiled && g.compiled.C) || (g && g.model && g.model.net && g.model.net.C) || null; };
  // 矩形（格）外扩步行范围（约 1,125 m）内的车站
  Cheat.stationsIn = function (g, x0, y0, x1, y1, reach) {
    const C = Cheat.netC(g);
    if (!C || !C.stations) return [];
    const W = reach == null ? WALK() : reach, out = [];
    for (let i = 0; i < C.stations.length; i++) {
      const s = C.stations[i];
      if (!s || !Number.isFinite(s.x)) continue;
      if (C.serviced && C.serviced[i] === false) continue;
      const dx = Math.max(x0 - s.x, 0, s.x - x1), dy = Math.max(y0 - s.y, 0, s.y - y1);
      const d = Math.hypot(dx, dy);
      if (d <= W) out.push({ i: i, name: s.name, x: s.x, y: s.y, d: d });
    }
    out.sort(function (a, b) { return a.d - b.d; });
    return out;
  };
  Cheat.markBefore = function (g) {
    const model = g && g.model, sd = model && model.stDaily;
    if (!sd || !sd.inn) return;
    if (!pending || pending.g !== g) pending = { g: g, ver: model.version, cells: new Map(), sd: sd.inn, at: performance.now() };
    pending.ver = model.version;
    if (!pending.sd) pending.sd = sd.inn;
    const s = Cheat.of(g), R = WALK(), list = [];
    for (const m of s.marks) list.push({ x0: m.x - m.r, y0: m.y - m.r, x1: m.x + m.r, y1: m.y + m.r });
    for (const c of s.cfacs) list.push(facBox(c));
    for (const b of list) for (const it of Cheat.stationsIn(g, b.x0, b.y0, b.x1, b.y1, R)) if (!pending.cells.has(it.i)) pending.cells.set(it.i, sd.inn[it.i] + sd.out[it.i]);
    // 最近的车站：读数用它（客流会在车站之间重新分配，合计可能互相抵消）
    const box = s.lastBox;
    if (box) {
      const near = Cheat.stationsIn(g, box.x0, box.y0, box.x1, box.y1, R);
      pending.near = near.length ? near[0].i : null;
      if (pending.near != null && !pending.cells.has(pending.near)) pending.cells.set(pending.near, sd.inn[pending.near] + sd.out[pending.near]);
    }
  };
  Cheat.awaitImpact = function (g) {
    const pb = pending;
    if (!pb || pb.g !== g) return;
    const t0 = performance.now();
    const tick = function () {
      if (pending !== pb) return;
      const model = g.model, sd = model && model.stDaily;
      const done = sd && sd.inn && sd.inn !== pb.sd && model.settled && model.version > pb.ver;
      if (!done && performance.now() - t0 < 15000) { setTimeout(tick, 200); return; }
      if (!sd || !sd.inn) return;
      let gain = 0, up = 0, top = null, n = 0, near = null;
      pb.cells.forEach(function (v, i) {
        if (i >= sd.inn.length) return;
        const d = (sd.inn[i] + sd.out[i]) - v;
        if (Math.abs(d) < 0.5) return;
        gain += d; if (d > 0) up += d; n++;
        if (d > 0 && (!top || d > top.d)) top = { i: i, d: d };
      });
      const C = Cheat.netC(g);
      const nm = function (i) { return C && C.stations[i] ? C.stations[i].name : ''; };
      if (pb.near != null && pb.near < sd.inn.length && pb.cells.has(pb.near)) near = { i: pb.near, name: nm(pb.near), d: (sd.inn[pb.near] + sd.out[pb.near]) - pb.cells.get(pb.near) };
      Cheat.of(g).readout = { gain: gain, up: up, n: n, near: near, top: top ? { name: nm(top.i), d: top.d } : null, at: Date.now() };
      pending = null;
      if (CM.ui && CM.ui.renderToolOpts) CM.ui.renderToolOpts();
      // 属性面板开着的时候把结果也刷一遍（正在输入框里打字时不打断）
      const ui = CM.ui, ae = document.activeElement;
      if (ui && ui.stack && ui.stack.length) {
        const top = ui.stack[ui.stack.length - 1];
        if (top && top.kind === 'cfac' && !(ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName))) ui.rerenderPage();
      }
    };
    setTimeout(tick, 220);
  };

  // ---------------- 交互 ----------------
  // 悬停：人口刷子不留任何地图标志，也不弹提示气泡；设施建造给一句放置说明
  Cheat.hover = function (T, sx, sy, w) {
    const g = CM.game;
    T.hover = null;
    if (!g) return;
    T.R.cv.style.cursor = 'crosshair';
    if (T.tool === 'popbrush') {
      T.ui.setTooltip(null);
      T.cursorDens = Cheat.densAt(g, w.x, w.y);
      return;
    }
    const TY = CM.Fac && CM.Fac.TYPES[T.facKind] ? CM.Fac.TYPES[T.facKind] : null;
    T.ui.setTooltip({
      title: '设施建造',
      lines: ['单击放置一座' + (TY ? TY.name : '设施') + '，立即打开属性面板',
        '可改名称、类别、出行需求、规模与启用年份；建成后计入设施图层与周边车站客流'],
    }, sx, sy);
  };
  // 悬停指示（v3.0）：人口刷子画出作用半径圆圈（虚线，随所选 km 变化），设施建造画放置点
  Cheat.drawOverlay = function (ctx, R, T) {
    const c = T.cursor; if (!c) return;
    if (T.tool === 'popbrush') {
      const km = T.popR || 3, r = km / (CFG.CELL_M / 1000), p0 = R.P(c.x, c.y, 0);
      ctx.save();
      ctx.strokeStyle = 'rgba(233,100,31,0.9)'; ctx.lineWidth = 2; ctx.setLineDash([7, 5]);
      ctx.beginPath();
      for (let k = 0; k <= 72; k++) { const a = k / 72 * Math.PI * 2, p = R.P(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r, 0); if (k) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); }
      ctx.stroke();
      // 中心到边缘的递减示意：两圈内环（50% 与 25% 半径）
      ctx.setLineDash([3, 5]); ctx.lineWidth = 1;
      for (const f of [0.5, 0.28]) { ctx.beginPath(); for (let k = 0; k <= 48; k++) { const a = k / 48 * Math.PI * 2, p = R.P(c.x + Math.cos(a) * r * f, c.y + Math.sin(a) * r * f, 0); if (k) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); } ctx.stroke(); }
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(233,100,31,0.95)'; ctx.beginPath(); ctx.arc(p0.x, p0.y, 3.2, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    } else if (T.tool === 'facbuild') {
      const p0 = R.P(c.x, c.y, 0);
      ctx.save(); ctx.strokeStyle = 'rgba(15,143,168,0.95)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(p0.x, p0.y, 7, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([3, 3]); ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(p0.x, p0.y, 14, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
  };
  // 提交（工具层在松开鼠标时调用）：人口刷子写密度，设施建造放一座并打开属性面板
  Cheat.commit = function (T, d) {
    const g = CM.game;
    if (!g || !d || !Cheat.on()) return;
    if (T.tool === 'popbrush') {
      const r = Cheat.applyDensity(g, d.x2, d.y2, T.popDens, T.popR);
      if (!r.ok) { T.ui.toast(r.msg, 'bad'); return; }
      T.ui.toast('人口密度 +' + Cheat.densText(T.popDens) + '（半径 ' + r.km + ' km、中心向四周递减）：' + r.cells + ' 格、人口 +' + U.fmtInt(Math.round(r.people)), 'good');
    } else {
      const r = Cheat.addFac(g, { x: d.x2, y: d.y2, t: T.facKind });
      if (!r.ok) { T.ui.toast(r.msg, 'bad'); return; }
      T.ui.toast('已添加设施「' + r.f.name + '」：可在这里改名称、类别、需求与年份', 'good');
      T.ui.openPage('cfac', r.f.id);
    }
    Cheat.schedule(g);
    T.ui.renderToolOpts();
  };

  // ---------------- 属性面板（右侧详情页：kind = 'cfac'） ----------------
  // 名称、类别、出行需求、规模、启用年份都可以改；改了吸引就按新的重算一次 OD
  Cheat.pageFac = function (id) {
    const ui = CM.ui, g = CM.game, Fac = CM.Fac;
    const rec = Cheat.facById(id);
    if (!rec || !g) return null;
    const f = Fac.byId(id), yr = g.year(), el = h('div');
    const active = !!f && Fac.active(f, yr, g.city);
    // 分段选择：类别有八项（英文名很长），允许换行，不让文字竖排或挤出面板
    const seg = function (cur, list, set, wrap) {
      const box = h('div', { class: 'seg-ctl sm', style: wrap ? { flexWrap: 'wrap', maxWidth: '100%', rowGap: '3px' } : null });
      for (const o of list) box.appendChild(h('button', {
        class: cur === o[0] ? 'on' : '', 'data-tip': o[2] || null, 'data-silent': '1',
        style: { whiteSpace: 'nowrap', flex: wrap ? '0 0 auto' : null },
        onclick: function () { if (cur !== o[0]) { set(o[0]); ui.rerenderPage(); } },
      }, o[1]));
      return box;
    };
    const row = function (label, ctl, note) {
      return h('div', { class: 'to-grp', style: { gap: '8px', margin: '8px 0', flexWrap: 'wrap', whiteSpace: 'normal' } },
        h('span', { class: 'to-k', style: { minWidth: '64px' } }, label), ctl, note ? h('span', { class: 'tiny muted' }, note) : null);
    };
    el.appendChild(h('div', { class: 'row', style: { flexWrap: 'wrap', marginBottom: '8px' } },
      h('span', { class: 'tag' }, ic(f ? f.T.icon : 'pin'), ' ', f ? f.T.name : ''),
      h('span', { class: 'tag info' }, '自定义设施'),
      h('span', { class: 'tag ' + (active ? 'good' : 'warn') }, active ? '运营中' : (yr < rec.open ? Math.round(rec.open) + ' 年启用' : '暂未运营'))));
    el.appendChild(h('div', { class: 'note', style: { margin: '0 0 6px' } },
      '自定义设施不写入人口与岗位，而是作为独立的出行目的地加入设施表：它的出行需求直接改变各车站的客流。'));
    // 名称
    const nameIn = h('input', { type: 'text', value: rec.name, maxlength: '20', 'aria-label': '设施名称', placeholder: '设施名称', style: { flex: '1 1 140px', minWidth: '120px' } });
    nameIn.addEventListener('change', function () {
      Cheat.setFac(g, id, { name: nameIn.value });
      ui.rerenderPage(); ui.toast('已改名为「' + Cheat.facById(id).name + '」', 'info');
    });
    nameIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') nameIn.blur(); });
    el.appendChild(row('名称', nameIn));
    // 类别
    const kinds = FAC_TYPES.map(function (k) {
      const T = Fac.TYPES[k], ps = Object.keys(T.p).map(function (q) { return CFG.trips.name[q]; }).join('、');
      return [k, h('span', null, ic(T.icon, 13), ' ', T.name), T.name + '：以' + ps + '出行为主'];
    });
    el.appendChild(row('类别', seg(rec.t, kinds, function (v) { Cheat.setFac(g, id, { t: v }); ui.toast('类别改为' + Fac.TYPES[v].name, 'info'); }, true)));
    // 规模（场地半径）
    const sizes = SIZES.map(function (z) { return [z.r, z.name, '场地半径 ' + z.r + ' 格（约 ' + Math.round(z.r * CFG.CELL_M) + ' m）：决定占地与场内步行']; });
    el.appendChild(row('规模', seg(rec.r, sizes, function (v) { Cheat.setFac(g, id, { r: v }); })));
    // 出行需求（占全市该目的出行吸引的比例）
    const shares = SHARES.map(function (v) { return [v, U.fmtPct(v, 1), '占全市该目的出行吸引的 ' + U.fmtPct(v, 1) + '：越大，来这里的出行越多，周边车站客流越高']; });
    const wIn = h('input', { type: 'text', inputmode: 'decimal', value: String(+(rec.w * 100).toFixed(2)), 'aria-label': '出行需求百分比', style: { width: '62px' } });
    wIn.addEventListener('change', function () {
      const v = parseFloat(String(wIn.value).replace(/[^\d.\-]/g, ''));
      if (!(v > 0) || v > 20) { ui.toast('出行需求填 0–20 之间（单位 %）', 'bad'); wIn.value = String(+(rec.w * 100).toFixed(2)); return; }
      Cheat.setFac(g, id, { w: v / 100 }); ui.rerenderPage();
    });
    el.appendChild(row('出行需求', h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } },
      seg(rec.w, shares, function (v) { Cheat.setFac(g, id, { w: v }); }), h('span', { class: 'tiny muted' }, '或'), wIn, h('span', { class: 'tiny muted' }, '% '))));
    // 启用年份
    const yIn = h('input', { type: 'text', inputmode: 'numeric', value: String(Math.round(rec.open)), 'aria-label': '启用年份', style: { width: '68px' } });
    yIn.addEventListener('change', function () {
      const v = parseInt(String(yIn.value).replace(/[^\d]/g, ''), 10);
      if (!(v >= 1800 && v <= 2200)) { ui.toast('启用年份填 1800–2200', 'bad'); yIn.value = String(Math.round(rec.open)); return; }
      Cheat.setFac(g, id, { open: v }); ui.rerenderPage();
    });
    el.appendChild(row('启用年份', h('div', { class: 'row', style: { gap: '6px' } },
      yIn, h('span', { class: 'tiny muted' }, '年'),
      h('button', { class: 'btn sm ghost', 'data-silent': '1', onclick: function () { Cheat.setFac(g, id, { open: Math.floor(yr) }); ui.rerenderPage(); } }, '设为今年'))));
    // 结果（模拟）
    if (active) {
      const a = g.model.facIndex(id) >= 0 ? g.model.facStats(id, 'avg') : null;
      if (a) {
        const vol = a.inn + a.out, mt = a.innM + a.outM;
        el.appendChild(h('div', { class: 'stat-grid' },
          ui.stat('周平均到访', U.fmtPeople(vol) + ' 人次', '模拟结果', 'muted'),
          ui.stat('乘地铁比例', U.fmtPct(vol > 0 ? mt / vol : 0, 0), '周平均', 'muted')));
      } else el.appendChild(h('div', { class: 'note' }, '客流正在计算，稍后显示。'));
    } else el.appendChild(h('div', { class: 'callout info' }, '这座设施要到 ' + Math.round(rec.open) + ' 年才启用，目前不参与出行计算。'));
    el.appendChild(h('div', { class: 'note', style: { marginTop: '8px' } },
      '出行需求用「占全市该目的出行吸引的比例」，与其他重要设施的参考规模同一口径；改动后立即重算 OD 与车站客流。'));
    el.appendChild(h('div', { class: 'row', style: { marginTop: '10px', flexWrap: 'wrap' } },
      h('button', { class: 'btn sm primary', onclick: function () { Cheat.refresh(g); ui.toast('已按新的属性重算客流', 'good'); ui.rerenderPage(); } }, ic('refresh', 14), '立即重算'),
      h('button', { class: 'btn sm ghost', onclick: function () { if (ui.locateFacility && f) ui.locateFacility(f); } }, ic('pin', 14), '定位'),
      h('button', { class: 'btn sm ghost danger', onclick: function () { const nm = rec.name; if (Cheat.delFac(g, id)) { ui.back(); ui.toast('已删除设施「' + nm + '」', 'info'); } } }, ic('trash', 14), '删除设施')));
    return { title: rec.name, el: el };
  };
})(window.CM);
