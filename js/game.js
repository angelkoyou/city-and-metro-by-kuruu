'use strict';
// 游戏状态与流程：时钟、日/月结算、跳月/跳年、建设草案、预测与存档序列化
(function (CM) {
  const U = CM.U, CFG = CM.CFG, D = CM.DATA, M = CM.Metro;

  function Game() {
    U.Emitter.call(this);
    this.speed = 0;
    this.pending = null;
    this.jumping = null;
    this.draft = null;
    this.events = [];
    this.history = [];
    this.netVersion = 0;
    this.rev = 0;            // 持久状态版本：日结算、建设、票价等变化时递增（时钟另行比较）
    this.favs = { stations: [], lines: [] };
    // 建设回放（v2.6）：每次确认建设记一条批次，用于按时间轴重现线网的形成过程
    this.buildLog = [];
    // 建设草稿：保存的草案改动清单（存档时随进度一起保存，见 js/drafts.js）
    this.drafts = [];
    this.draftSeq = 0;
    this.idFloor = 0;        // 草案专用的编号水位：多份草稿不会分配到相同编号
    this.walkXfer = Game.walkXferDefault();
    this.cheat = CM.Cheat ? CM.Cheat.empty() : null;   // 作弊注入的流水（人口刷子 / 设施建造，v2.9.5）
  }
  Game.prototype = Object.create(U.Emitter.prototype);
  CM.Game = Game;
  Game.prototype.touch = function () { this.rev++; };

  // ---------------- 换乘关系规则 ----------------
  // 两座靠得很近的车站默认「互不相干」：系统不再自动生成站外换乘，只有玩家手动指定的站对才生效。
  // 指定时必须选一种关系：
  //   on   —— 站外换乘：按实际步行路径计时，地图上以虚线 ⇄ 标示；
  //   same —— 长距离换乘：零步行时间，两站白点用白芯通道连成一体并共用站名。
  // 两种关系连起来的车站都视为同一座换乘站：共用站名、合并线路与客流数据。
  // 规则随存档保存；旧格式 {auto, on, off} 读档时迁移（on 保留为站外换乘，auto/off 丢弃）。
  Game.walkXferKey = function (a, b) {
    const x = String(a), y = String(b);
    return x < y ? x + '|' + y : y + '|' + x;
  };
  Game.walkXferDefault = function () { return { on: [], same: [] }; };
  Game.walkXferNormalize = function (raw) {
    const out = Game.walkXferDefault();
    if (!raw || typeof raw !== 'object') return out;
    const clean = function (v) {
      if (!Array.isArray(v)) return [];
      const seen = new Set(), arr = [];
      for (const k of v) {
        if (typeof k !== 'string') continue;
        const p = k.split('|');
        if (p.length !== 2 || !p[0] || !p[1] || p[0] >= p[1] || seen.has(k)) continue;
        seen.add(k); arr.push(k);
        if (arr.length >= 2000) break;
      }
      return arr;
    };
    out.same = clean(raw.same);
    const same = new Set(out.same);
    out.on = clean(raw.on).filter(function (k) { return !same.has(k); });
    return out;
  };
  // 建站先后：先比建成年月（继承站带历史年份），同月再比车站编号（newId 递增），最后按 id 兜底
  Game.stationCmp = function (net, a, b) {
    const A = net.stations[a], B = net.stations[b];
    if (!A || !B) return 0;
    const ba = A.built, bb = B.built;
    if (ba || bb) {
      if (!bb) return -1;
      if (!ba) return 1;
      const d = (ba[0] - bb[0]) * 12 + ((ba[1] || 1) - (bb[1] || 1));
      if (d) return d;
    }
    const na = parseInt(String(a).replace(/^\D+/, ''), 10), nb = parseInt(String(b).replace(/^\D+/, ''), 10);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return a < b ? -1 : a > b ? 1 : 0;
  };
  // 有换乘关系的车站并成一组（多线枢纽可一次串起三站以上），每组按建成先后排序
  Game.prototype.walkXferGroups = function () {
    const w = this.walkXfer || Game.walkXferDefault(), net = this.net, par = new Map();
    if (!net) return [];
    const find = function (x) { while (par.get(x) !== x) x = par.get(x); return x; };
    const uni = function (a, b) {
      if (!par.has(a)) par.set(a, a);
      if (!par.has(b)) par.set(b, b);
      const ra = find(a), rb = find(b);
      if (ra !== rb) par.set(ra, rb);
    };
    for (const k of (w.on || []).concat(w.same || [])) {
      const p = k.split('|');
      if (p.length === 2 && net.stations[p[0]] && net.stations[p[1]]) uni(p[0], p[1]);
    }
    const groups = new Map();
    for (const id of par.keys()) { const r = find(id); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(id); }
    const out = Array.from(groups.values());
    for (const g of out) g.sort(function (a, b) { return Game.stationCmp(net, a, b); });
    return out;
  };
  // ---------------- 换乘组：两种关系连起来的车站视为同一座换乘站 ----------------
  // 组按建成先后排序，第一个是「代表站」：共用站名、概况入口、地图连线拾取的落点。
  // 缓存签名随网络版本与规则内容变化，避免每帧重建并查集。
  Game.prototype.stationGroupSig = function () {
    const w = this.walkXfer || Game.walkXferDefault(), on = w.on || [], same = w.same || [];
    return this.netVersion + '|' + on.length + '|' + same.length + '|' + on.join(',') + '|' + same.join(',');
  };
  Game.prototype.stationGroupMap = function () {
    const sig = this.stationGroupSig();
    if (this._xferGroupSig === sig && this._xferGroupMap) return this._xferGroupMap;
    const map = new Map();
    for (const grp of this.walkXferGroups()) for (const id of grp) map.set(id, grp);
    this._xferGroupSig = sig; this._xferGroupMap = map;
    return map;
  };
  // 返回包含 id 的换乘组（含自身）；没有换乘关系时返回 [id]
  Game.prototype.stationGroup = function (id) {
    const grp = this.stationGroupMap().get(id);
    return grp && grp.length > 1 ? grp : [id];
  };
  // ---------------- 同一换乘站的站台之间禁止铺设轨道 ----------------
  // 站外换乘（on）与长距离换乘（same）都会把两座站台并成同一座换乘站，逻辑上它们就是同一个站：
  // 再在两者之间画一段轨道既无意义，也会让线网把「换乘」误当成「坐一站车」。这里只拦截这种站对，
  // 不同换乘组、没有任何手动换乘关系的近距站、以及同一座车站对象上的普通换乘都不受影响。
  Game.XFER_LINK_ERROR = '同一座换乘站的站台之间不能再铺设轨道';
  // 是否属于同一换乘组（含 A—B—C 传递成组）。a === b 不算：那由 addSegment 原有的自环检查处理。
  Game.prototype.sameXferStation = function (a, b) {
    if (!a || !b || a === b) return false;
    const grp = this.stationGroup(a);
    return grp.length > 1 && grp.indexOf(b) >= 0;
  };
  // 只检查「本次草案编辑新增的」轨道段：before 是编辑前的 段id → 端点对 快照。
  // 端点对不比较线路归属，所以改线路、改线形、改建设方式都不算新增；旧存档里已有的组内连接也不追溯。
  // 返回错误文案或 null。
  Game.prototype.xferLinkViolation = function (before, net) {
    if (!before || !net || !net.segments) return null;
    for (const id in net.segments) {
      const s = net.segments[id];
      const key = s.a < s.b ? s.a + '|' + s.b : s.b + '|' + s.a;
      if (before[id] === key) continue;
      if (this.sameXferStation(s.a, s.b)) return Game.XFER_LINK_ERROR;
    }
    return null;
  };
  // 组内所有线路（去重）：换乘站详情、地图站标与线网图都据此显示完整可乘坐线路
  Game.prototype.stationGroupLines = function (net, grp) {
    const seen = new Set(), out = [];
    for (const sid of grp) {
      if (!net.stations[sid]) continue;
      for (const lid of M.stationLines(net, sid)) if (!seen.has(lid) && net.lines[lid]) { seen.add(lid); out.push(lid); }
    }
    return out;
  };
  // 后建站自动改用组内最先建成车站的名字；同时同步草案中的同名车站。返回被改名的站 id
  Game.prototype.walkXferSyncNames = function (forced) {
    const changed = [];
    for (const grp of this.walkXferGroups()) {
      const first = this.net.stations[grp[0]];
      if (!first) continue;
      const nm = forced && typeof forced.name === 'string' && grp.indexOf(forced.id) >= 0 ? forced.name : first.name;
      for (const id of grp) {
        const st = this.net.stations[id], ds = this.draft && this.draft.net && this.draft.net.stations[id];
        if (st && st.name !== nm) { st.name = nm; changed.push(id); }
        if (ds && ds.name !== nm) ds.name = nm;
      }
    }
    return changed;
  };
  // 规则变更不改动轨道、不收费，但要立即重编译网络（重算换乘表）并重新求解客流
  Game.prototype.walkXferApply = function () {
    if (!this.walkXfer) this.walkXfer = Game.walkXferDefault();
    const renamed = this.walkXferSyncNames();
    if (this.model) this.model.walkXfer = this.walkXfer;
    this.rev++;
    this.refreshOperations();
    this.emit('walkXfer', { renamed: renamed });
  };
  // ---------------- 换乘组的站台规模一致性 ----------------
  // 同一座换乘站内的所有站台必须同为小型 / 中型 / 大型。新增关系时检查的是「合并后的整组」：
  // 若 a、b 各自已属于某个换乘组，加这条边后两组会并成一组，两边所有站台都要参与比较。
  // 返回 null 表示可添加，否则返回 { error, sizes }，error 直接用于界面提示。
  Game.prototype.walkXferSizeCheck = function (key) {
    const net = this.net;
    if (!net || !key || typeof key !== 'string') return null;
    const p = key.split('|');
    if (p.length !== 2 || !net.stations[p[0]] || !net.stations[p[1]]) return null;
    const ids = new Set([p[0], p[1]]);
    for (const grp of this.walkXferGroups()) {
      if (grp.indexOf(p[0]) < 0 && grp.indexOf(p[1]) < 0) continue;
      for (const id of grp) ids.add(id);
    }
    const sizes = new Set();
    for (const id of ids) { const st = net.stations[id]; if (st) sizes.add(st.size || 'M'); }
    return sizes.size > 1 ? { error: '站台规模不一致，无法添加换乘关系', sizes: Array.from(sizes) } : null;
  };
  // 任何改规模的入口都先把目标扩展为整组，保证升级、缩站、批量修改后组内仍然一致
  Game.prototype.stationGroupExpand = function (ids) {
    const out = [], seen = new Set();
    for (const id of ids) for (const sid of this.stationGroup(id)) {
      if (seen.has(sid)) continue;
      seen.add(sid); out.push(sid);
    }
    return out;
  };
  // 旧存档里可能已有规模不一致的换乘组：只升不降，统一到组内最大规模
  Game.prototype.walkXferAlignSizes = function () {
    const names = CFG.metro.sizes || ['S', 'M', 'L', 'XL'], ord = {};
    names.forEach(function (sz, i) { ord[sz] = i; });
    let n = 0;
    for (const grp of this.walkXferGroups()) {
      let top = 0;
      for (const id of grp) { const s = this.net.stations[id]; if (s) top = Math.max(top, ord[s.size] != null ? ord[s.size] : 1); }
      const sz = names[Math.min(names.length - 1, top)];
      for (const id of grp) { const s = this.net.stations[id]; if (s && s.size !== sz) { s.size = sz; n++; } }
    }
    return n;
  };
  // type: 'on' 站外换乘 | 'same' 长距离换乘 | null 移除关系；一个站对只能有一种关系
  // 只有新增关系才校验规模：切换类型、移除关系不受影响；失败时返回 { error } 且不改动规则
  Game.prototype.walkXferSetLink = function (key, type) {
    if (!this.walkXfer) this.walkXfer = Game.walkXferDefault();
    if (!key || typeof key !== 'string' || key.split('|').length !== 2) return;
    const w = this.walkXfer;
    const existed = w.on.indexOf(key) >= 0 || w.same.indexOf(key) >= 0;
    if ((type === 'on' || type === 'same') && !existed) {
      const bad = this.walkXferSizeCheck(key);
      if (bad) return bad;
    }
    for (const list of ['on', 'same']) { const i = w[list].indexOf(key); if (i >= 0) w[list].splice(i, 1); }
    if (type === 'on' || type === 'same') w[type].push(key);
    this.walkXferApply();
    return null;
  };

  // 开局与无有效缓存的读档完成四轮交通求解：createGen / restoreGen 交给工作线程流水线（等待时让出 CM.SIM_WAIT），
  // 由载入界面驱动、不阻塞页面；create / restore 为同步版本（主线程求解，结果逐位相同）
  function drain(gen) { for (;;) { const r = gen.next(); if (r.done) return r.value; } }
  const lp = function (p, label) { if (CM.loadProgress) CM.loadProgress(p, label); };
  Game.create = function (opts) { return drain(Game.createGen(opts, true)); };
  Game.restore = function (s) { return drain(Game.restoreGen(s, true)); };
  Game.createGen = function* (opts, sync) {
    const g = new Game();
    let complete=false;
    try {
      g.id = U.uid('g');
      g.mapId = CM.mapId || 'gz';   // 当前地图（CM.useMap 已切换好数据）
      g.name = opts.name || ((D.city || '广州') + ' ' + CFG.START.y);
      // v3.8：无限贷款从难度档解耦为独立开关；难度档只剩四档经营 + 自由建造
      const gameMode = opts.mode === 'free' ? 'free' : 'challenge';
      g.mode = gameMode;
      if (CM.Difficulty) {
        // 自由建造资金不限、难度恒为 free；经营挑战用玩家选的档位 + 开局界面微调过的 9 项系数。
        // v3.6：走 loadGame 而非 adopt，避免系数恰好匹配另一档时把档位（收入倍率）改掉。
        const lvl = gameMode === 'free' ? 'free' : CM.Difficulty.normalize(opts.difficulty || 'normal');
        CM.Difficulty.loadGame(lvl, CM.Difficulty.isSandbox(lvl) ? null : (opts.tune || null));
      }
      g.seed = opts.seed || (CFG.START.y * 10000 + 101);
      if (opts.tutorial) g.tutorial = { step: 0, done: [], started: Date.now() };
      g.createdAt = Date.now();
      g.clock = Object.assign({}, CFG.START);
      if (CM.applyMoneyEra) CM.applyMoneyEra(g.clock.y, g.clock.m);   // 货币时期（巴黎）：显示货币随日期
      g.city = new CM.City();
      const pre = opts.mode === 'free' && !opts.tutorial && opts.startYear && Math.round(opts.startYear) > CFG.START.y;
      lp(0.06, '准备地图');
      yield* g.city.generateGen(g.seed, g.clock.y);
      lp(0.2, '生成城市与道路');
      g.model = new CM.Model(g.city);
      g.walkXfer = Game.walkXferDefault(); g.model.walkXfer = g.walkXfer;
      g.model.habitAge = Game.habitAge(g);
      g.model.setYear(g.clock.y);
      g.model.setDayType(CM.Model.dayType(g.clock.y, g.clock.m, g.clock.d));
      g.traffic = { v: CFG.TRAFFIC_MODEL };
      g.net = M.empty();
      g.mapInit = buildInitialNetwork(g);   // 开局既有地铁（东京 1950 年等），只在新建时生成一次，随存档保存
      g.compiled = M.compile(g.net, g.city);
      g.model.setNetwork(g.compiled);
      lp(0.3, '建立交通模型');
      g.econ = new CM.Economy(g.mode, g.clock.y, g.clock.m);
      // v3.8：无限贷款独立开关（自由建造不提供，恒为关闭）
      g.econ.setInfLoan(gameMode !== 'free' && !!opts.infLoan);
      g.model.fare = g.econ.fare;
      g.model.fare160 = g.econ.fare160;
      g.tasks = new CM.Tasks();
      g.model.onSolveProgress = function (f) { lp(0.3 + (pre ? 0.08 : 0.62) * f, '计算居民出行'); };
      try { if (sync) g.model.solveNow(4); else yield* g.model.solveGen(4); } finally { g.model.onSolveProgress = null; }
      g.econ.startMonth(g.clock.y, g.clock.m);
      const e0 = D.events && D.events[0];
      if (e0) g.logEvent({ tag: e0.tag || '史实', title: e0.title, desc: e0.desc });
      g.firedEvents = { 0: 1 };
      g.tasks.monthly(g).forEach(function (o) { g.logTask(o); });
      // 城市经济：真实城市开局即接入（教程不启用）；开局当月已发生的经济事件一并记录
      if (CM.Macro) for (const x of CM.Macro.create(g) || []) g.logMacroEvent(x);
      g.recordHistory();
      if (CM.Eras) { const er = CM.Eras.month(g); if (er) g.logEra(er, false); }
      // 自由建造选项（v2.2）：解锁全图（未开放区域也可建设，城市仍按历史开放与发展）；自定义起始年份（先按默认开局年份生成，
      // 再逐月快速推演到所选年份的 1 月，见 prehistoryGen）
      g.unlockAll = opts.mode === 'free' && !opts.tutorial && !!opts.unlockAll; g.city.unlockAll = g.unlockAll;
      const sy = opts.mode === 'free' && !opts.tutorial && opts.startYear ? U.clamp(Math.round(opts.startYear), CFG.START.y, CFG.growth.histEnd || 2020) : 0;
      if (sy > CFG.START.y) yield* g.prehistoryGen(sy, sync, opts.onProgress);
      if (CM.Eras) CM.Eras.ensureBases(g);   // 城市发展对比基准：本局开始规划时（v2.2 阶段可视化）
      if (CM.Milestones) CM.Milestones.onStart(g);
      complete=true;
      return g;
    } finally {
      if(!complete&&g.model){
        g.model.retired=true;
        g.model.cancelPredict();
        if(CM.CarPool)CM.CarPool.pump();
        if(CM.OdPool)CM.OdPool.pump();
      }
    }
  };

  // 开局时已运营的真实地铁：直接属于玩家，不收取历史建设费；之后正常产生运营费用与票款，可改造、扩建或拆除
  function buildInitialNetwork(g) {
    const IN = D.initialNetwork; if (!IN) return null;
    const net = g.net, city = g.city, desc = [], byName = {};
    for (const L of IN.lines) {
      const lid = M.newLine(net);
      if (L.color) net.lines[lid].color = L.color;
      if (L.name) net.lines[lid].name = L.name;
      if (L.model) net.lines[lid].model0 = L.model;   // 开局列车的车型
      let prev = null, first = null, count = 0;
      // st[5]：这一站与到这一站的区间的建设方式
      const stationOf = function (st) {
        // 同名车站为换乘站（北京 1 号线与环线在复兴门换乘，v2.4）：共用同一座车站
        let sid = byName[st[0]];
        if (!sid) {
          sid = M.addStation(net, st[1], st[2], { size: st[3] || L.size || 'M', type: st[5] || L.type || 'underground' }, city);
          const s = net.stations[sid]; s.name = st[0]; s.built = [st[4] || L.year || CFG.START.y, 1]; s.site = [s.x, s.y]; s.inherited = true;
          byName[st[0]] = sid; count++;
        }
        return sid;
      };
      for (const st of L.stations) {
        const sid = stationOf(st);
        if (prev) M.addSegment(net, lid, prev, sid, [], st[5] || L.type || 'underground');
        if (!first) first = sid;
        prev = sid;
      }
      if (L.loop && prev && first && prev !== first) M.addSegment(net, lid, prev, first, [], L.type || 'underground');   // 环线：首尾相连
      desc.push(net.lines[lid].name + (L.loop ? '（环线，' : ' ' + L.stations[0][0] + '—' + L.stations[L.stations.length - 1][0] + '（') + L.stations.length + ' 站）');
    }
    M.normalizeLines(net);
    for (const id in net.segments) { net.segments[id].built = [IN.year || CFG.START.y, 1]; net.segments[id].inherited = true; }
    return { metro: (IN.note ? IN.note + '：' : '') + desc.join('；'), year: CFG.START.y };
  }

  Game.prototype.prehistoryGen = function* (toYear, sync, onProgress) {
    const city = this.city, model = this.model, y0 = this.clock.y;
    let n = 0;
    while (U.ymIndex(this.clock.y, this.clock.m) < U.ymIndex(toYear, 1)) {
      let y = this.clock.y, m = this.clock.m + 1; if (m > 12) { m = 1; y++; }
      this.clock = Object.assign({}, this.clock, { y: y, m: m, d: 1 });
      const yr = y + (m - 1) / 12;
      if (m === 1 && onProgress) onProgress(y, toYear);
      if (m === 1) lp(0.38 + 0.45 * (y - y0) / Math.max(1, toYear - y0), '推演城市发展 · ' + y + ' 年');
      city.applyReplan(yr);
      if (CM.applyMoneyEra) CM.applyMoneyEra(y, m);
      model.setYear(yr);
      D.events.forEach((e, k) => { if (!this.firedEvents[k] && U.ymIndex(e.y, e.m) <= U.ymIndex(y, m)) { this.firedEvents[k] = 1; if (CM.Eras) CM.Eras.applyStrike(this, e); this.logEvent({ tag: e.tag, title: e.title, desc: e.desc + (CM.Eras ? CM.Eras.fxNote(e) : "") }); } });
      if (this.macro && CM.Macro) for (const x of CM.Macro.month(this, y, m)) this.logMacroEvent(x);
      const ef = this.macro && CM.Macro ? CM.Macro.cityFactors(this) : null;
      if (D.airport && yr >= D.airport.closeYear + 7 / 12 && city.lu.some(function (v) { return v === CM.LU.AIRPORT; })) city.closeAirport();
      let roads = false;
      for (const r of city.applyReclaim(y)) { roads = true; this.logEvent({ tag: r.tag || '史实', title: '填海成陆：' + r.name, desc: r.desc || '' }); }
      if (city.applyRoads(y)) roads = true;
      city.activateLandmarks(y);
      const tot = city.totals();
      for (let k = 0; k < city.regions.length; k++) {
        const rg = city.regions[k];
        if (city.regionOpen[k] || rg.open == null) continue;
        if (rg.id === 'airport' && D.airport && D.airport.closeYear < 9999 && yr < D.airport.closeYear + 7 / 12) continue;
        const byYear = y >= rg.open, early = rg.pop && tot.pop >= rg.pop * (ef && ef.dev < -0.03 ? 1.03 : 1) && y >= rg.open - (ef && ef.dev > 0.02 ? 4 : 3);
        if (byYear || early) { city.openRegion(k, y, m); this.logEvent({ tag: byYear ? '史实' : '模拟', title: '新区域开放：' + rg.name, desc: (byYear ? '参考 ' + rg.open + ' 年开放' : '城市人口增长，提前开放（参考 ' + rg.open + ' 年）') + (rg.note ? '。' + rg.note : '') + city.openNote(k) }); roads = true; }
      }
      const econF = this.macro && CM.Macro ? CM.Macro.applyFactors(this) : null;
      city.growMonth({ year: yr, monthIndex: this.ym(), zoneAccess: model.zoneAccessNorm, cellWalk: null, coverage: 0, econ: econF });
      if (CM.Cheat) CM.Cheat.hold(this);   // 作弊注入按增长机制的吸收比例补回，长期有效（v2.9.5）
      if (roads) city.updateStreets();
      if (this.macro && CM.Macro) CM.Macro.sample(this);
      if (CM.Eras) { const er = CM.Eras.month(this); if (er) this.logEra(er, false); }
      // 每 5 年刷新一次道路网络与可达性（新区、道路与人口分布改变了出行条件）
      if (m === 1 && (y - y0) % 5 === 0) {
        city.buildGraphs(); const C = M.compile(this.net, city);
        yield* model.refreshCityGen(C);
        this.compiled = C; if (sync) model.solveNow(1); else yield* model.solveGen(1);
      }
      if ((++n & 3) === 0) yield;
    }
    city.updateStreets(); city.buildGraphs();
    const C = M.compile(this.net, city);
    yield* model.refreshCityGen(C);
    this.compiled = C;
    model.setYear(this.clock.y); model.setDayType(CM.Model.dayType(this.clock.y, this.clock.m, this.clock.d));
    model.onSolveProgress = function (f) { lp(0.84 + 0.12 * f, '计算居民出行'); };
    try { if (sync) model.solveNow(4); else yield* model.solveGen(4); } finally { model.onSolveProgress = null; }
    // 按所选年份重新开账：票价、拨款口径与任务从这一年开始；开局前的任务与统计不保留
    this.econ = new CM.Economy(this.mode, this.clock.y, this.clock.m);
    model.fare = this.econ.fare;
    model.fare160 = this.econ.fare160;
    if (this.macro && CM.Macro) CM.Macro.sync(this);
    this.tasks = new CM.Tasks();
    this.events = this.events.filter(function (e) { return e.tag !== '任务'; });
    this.econ.startMonth(this.clock.y, this.clock.m);
    this.tasks.monthly(this).forEach((o) => this.logTask(o));
    this.history = [];
    this.recordHistory();
    this.startYear = this.clock.y;
    this.name = this.name.replace(/\d{4}$/, String(this.clock.y));
    this.logEvent({ tag: '自由建造', title: '从 ' + this.clock.y + ' 年开始规划', desc: CFG.START.y + '–' + (this.clock.y - 1) + ' 年的城市发展按历史资料与发展规则推演，开局时' + (this.mapInit && this.mapInit.metro ? '只有既有地铁' : '尚无地铁') + '。' });
  };

  Game.prototype.year = function () { return this.clock.y + (this.clock.m - 1) / 12 + (this.clock.d - 1) / 365; };
  Game.prototype.ym = function () { return U.ymIndex(this.clock.y, this.clock.m); };
  Game.prototype.logEvent = function (e) {
    e.y = e.y || this.clock.y; e.m = e.m || this.clock.m;
    this.events.push(e);
    if (this.events.length > 400) this.events.shift();
    this.emit('event', e);
  };
  // 经济事件：记入城市纪事的事件列表（史实 / 模拟），说明本城受影响的程度
  Game.prototype.logEra = function (er, toast) {
    const E = CM.Eras, e = er.era, to = E.endOf(E.list().indexOf(e));
    if (er.prev && er.prev.text) {
      const pe = E.byId(er.prev.id);
      this.logEvent({ tag: '阶段总结', title: '阶段总结：' + (pe ? pe.name : er.prev.id), desc: er.prev.text });
      if (CM.Milestones) CM.Milestones.onEra(this, pe, er.prev, 'end');
    }
    this.logEvent({ tag: e.tag || '史实', title: '进入发展阶段：' + e.name + '（' + e.from + (to ? '–' + to : ' 年起') + '）', desc: e.summary || '' });
    if (CM.Milestones) CM.Milestones.onEra(this, e, null, 'start');
    if (toast) this.emit('era', er);   // 阶段横幅（界面显示；跳月期间待结束后显示）
  };

  Game.prototype.logMacroEvent = function (x) {
    const ev = x.ev, f = x.f, k = f.k, neg = Math.min.apply(null, ev.lv) < 0;
    const peak = ev.lv.reduce(function (a, v) { return Math.abs(v) > Math.abs(a) ? v : a; }, 0) * k;
    const lvl = Math.abs(peak) < 0.005 ? '较小' : (Math.abs(peak) < 0.02 ? '中等' : (Math.abs(peak) < 0.045 ? '较大' : '严重'));
    const sim = ev.tag === '模拟', name = ev.title.replace(/^模拟：/, '');
    this.logEvent({ tag: ev.tag || '史实', kind: 'econ', econId: ev.id, title: (sim ? '经济（模拟）：' : '经济：') + name, desc: ev.desc + (neg ? ' 对本城经济的影响：' + lvl + '。' : ' 对本城经济的带动：' + lvl + '。') + (CM.Eras ? CM.Eras.macroNote(ev.id) : '') });
    this.emit('histEvent', { y: ev.y || this.clock.y, m: ev.m || this.clock.m, tag: ev.tag || '史实', title: name, desc: ev.desc, econ: true, neg: neg, lvl: lvl, fx: CM.Eras ? CM.Eras.macroFx(ev.id) : null });
    this.emit('macroEvent', x);
  };
  Game.prototype.logTask = function (o) {
    const t = o.task;
    if (o.type === 'issued') { this.logEvent({ tag: '任务', title: '新任务：' + t.title, desc: t.desc }); this.emit('toast', { kind: 'info', text: '新任务：' + t.title }); }
    else if (o.type === 'done' && t.partial) { this.logEvent({ tag: '任务', title: '任务部分完成：' + t.title, desc: (t.desc ? t.desc + ' ' : '') + (this.econ.mode === 'challenge' ? '主体目标已达成，获得奖励拨款 ' + U.fmtMoney(t.reward) + '，拨款不受影响。' : '') }); this.emit('toast', { kind: 'good', text: '任务部分完成：' + t.title + '（任务 → 已完成 可查看详情）' }); }
    else if (o.type === 'done') { this.logEvent({ tag: '任务', title: '任务完成：' + t.title, desc: (t.desc ? t.desc + ' ' : '') + (this.econ.mode === 'challenge' ? '获得奖励拨款 ' + U.fmtMoney(t.reward) + '。' : '') }); this.emit('toast', { kind: 'good', text: '任务完成：' + t.title + '（任务 → 已完成 可查看详情）' }); }
    else if (o.type === 'failed') { this.logEvent({ tag: '任务', title: '任务未完成：' + t.title, desc: this.econ.mode !== 'challenge' ? '自由建造模式下无后果' : (t.kind === 'opt' ? '可选挑战：未来 6 个月满意度 −2，拨款不受影响' : (function () { const P = CM.Tasks.failPenalty(t); return '后果：未来 ' + P.months + ' 个月（含本月）拨款 ×' + P.factor + '，满意度 ' + P.sat; })()) }); this.emit('toast', { kind: 'bad', text: '任务未完成：' + t.title }); }
    else if (o.type === 'withdrawn') { this.logEvent({ tag: '任务', title: '任务撤销：' + t.title, desc: t.why || '这处设施已经停用，任务取消，没有奖惩。' }); this.emit('toast', { kind: 'info', text: '任务撤销：' + t.title }); }
    // 可选挑战（v2.3）：只提示，玩家在任务面板中决定是否接受
    else if (o.type === 'offer') { this.logEvent({ tag: '任务', title: '可选挑战：' + t.title, desc: (t.theme ? t.theme + '。' : '') + t.desc }); this.emit('toast', { kind: 'info', text: '新的可选挑战：' + t.title, offer: t.id }); }
  };

  // ---------------- 时钟 ----------------
  Game.prototype.setSpeed = function (s) { this.speed = s; this.emit('speed', s); };
  Game.validImpact = function (r) {
    return !!r && r.status === 'done' && Array.isArray(r.at) && r.at.length === 2 && r.at.every(Number.isFinite) &&
      ['base', 'draft'].every(k => r[k] && ['car', 'commute', 'cong'].every(v => Number.isFinite(r[k][v]))) &&
      ['roads', 'roadsWorse'].every(k => Array.isArray(r[k]) && r[k].length <= 5 && r[k].every(v => typeof v.name === 'string' && ['vc0', 'vc1', 'delta'].every(n => Number.isFinite(v[n]))));
  };
  Game.prototype.updateTrafficImpact = function () {
    const plan = this._impactPlan, m = this.model;
    if (!plan || this.draft || this.pending || this.jumping || m.predJob || !m.trafficReady() || m.hasReviewWork()) return;
    if (plan.version !== this.netVersion) { this._impactPlan = null; return; }
    const cityVersion = this.city.version, roadVersion = this.city.roadVersion, year = m.year, fare = CM.Model.fareKeyAll(m);
    this.impactReport = { status: 'calculating', at: [this.clock.y, this.clock.m] };
    const beforeC = M.compile(plan.before, this.city);
    m.predict(this.compiled, plan.lines, res => {
      if (this._impactPlan !== plan || m.retired) return;
      if (this.netVersion !== plan.version || this.city.version !== cityVersion || this.city.roadVersion !== roadVersion || m.year !== year || CM.Model.fareKeyAll(m) !== fare) {
        this.impactReport = { status: 'waiting', at: [this.clock.y, this.clock.m] }; return;
      }
      this._impactPlan = null;

      this.impactReport = { status: 'done', at: [this.clock.y, this.clock.m], stable: !!res.stable,
        base: res.base, draft: res.draft, roads: res.roads || [], roadsWorse: res.roadsWorse || [], lines: res.lines || [], stations: res.stations || [], lineLF: res.lineLF || [], hot: res.hot || [], induced: res.induced || null, cost: plan.cost || 0, summary: plan.summary || "", ops: CM.Impact ? CM.Impact.opsInputs(this, beforeC, this.compiled) : null };
      this.touch(); this.emit('trafficImpact');
    }, beforeC);
  };
  Game.prototype.update = function (dt) {
    // 交通求解的每帧预算（v2.3 高密度线网）：上一帧除求解外的主线程耗时较少时，把余量让给求解（最多 solverBudgetMaxMs），
    // 大线网改线后更快收敛；画面吃紧时回到基础预算，不降低帧率
    // 镜头移动、拖动时（v2.5 性能）优先保证画面与输入：求解和月结只拿最低预算。只改调度，计算轮次与结果不变
    const P = CFG.perf, moving = !!(CM.R && CM.R.interacting), other = Math.max(0, ((CM.R && CM.R.lastFrameMs) || 0) - (this._solveMs || 0));
    const budget = moving ? P.solverInputMs : U.clamp((P.frameTargetMs || 13) - other, P.solverBudgetMs, P.solverBudgetMaxMs || P.solverBudgetMs);
    if (this.jumping) { this.stepJump(); return; }
    if (this.pending) {
      const t0 = performance.now(), slice = moving ? 3 : 6;
      while (this.pending && performance.now() - t0 < slice) {
        const r = this.pending.next();
        if (r.done) this.pending = null;
        else if (r.value === CM.SIM_WAIT) break;
      }
      this.model.step(moving ? 1 : 2);
      return;
    }
    if (this.speed > 0 && !this.econ.failed) this.advanceClock(dt);
    const ts = performance.now();
    this.model.step(budget);
    this._solveMs = performance.now() - ts;
    if(CM.TrafficCache)CM.TrafficCache.tick(this);
    if(this.model.trafficReady()&&this.tasks.active.some(t=>t.type==='zoneCong'&&!t.metric))this.tasks.rebaseCongestion(this);
    if(this.model.trafficReady()&&!this.model.hasReviewWork()&&this.taskRecheckYM===this.ym()){
      this.taskRecheckYM=null;this.tasks.monthly(this).forEach(o=>this.logTask(o));this.touch();this.emit('tasksUpdated');
    }
    this.updateTrafficImpact();
  };
  // 日终：按当天的日类型（工作日 / 周末）结算票款与运营费用，推进日期；返回是否跨月
  Game.prototype.dayType = function () { return CM.Model.dayType(this.clock.y, this.clock.m, this.clock.d); };
  Game.prototype.endDay = function () {
    const dt = this.dayType();
    this.econ.day(this.model.dailyFor(dt), this.compiled, this.clock.y, dt);
    // 车站商业开发（TOD，v2.3）：广告与商铺租金，按当天客流逐日计入非票务收入；v2.5 起逐日扣除开发后的运营与维护成本
    if (CM.TOD) { const v = CM.TOD.daily(this, dt); if (v.rev > 0) this.econ.income('commerce', v.rev); if (v.cost > 0) this.econ.spend('todCost', v.cost); }
    this.clock.d++;
    this.rev++;
    if (this.clock.d > U.daysInMonth(this.clock.y, this.clock.m)) {
      this.clock.d = 1;
      this.econ.closeMonth();
      const f = this.econ.checkFailure(this.clock.y, this.inTransition(U.ymIndex(this.clock.y, this.clock.m) + 1));
      this.clock.m++;
      if (this.clock.m > 12) { this.clock.m = 1; this.clock.y++; }
      this.model.setDayType(this.dayType());
      if (f) this.onFailure(f);
      return true;
    }
    this.model.setDayType(this.dayType());
    this.emit('day');
    return false;
  };
  // 交通模型升级过渡期（旧存档升级当月，至该月月末结算）：满意度不因统计口径变化而下降，任务不判失败、连续进度不清零
  Game.prototype.inTransition = function (ym) { const t = this.traffic; return !!(t && t.until != null && ym <= t.until); };
  Game.prototype.onFailure = function (f) {
    this.setSpeed(0);
    this.logEvent({ tag: '经营', title: '经营挑战失败', desc: f.reasons.join('；') });
    this.emit('failed', f);
  };

  // 月度处理（分步执行，避免画面卡顿）
  // 交通刷新节奏（v2.6）：全部时段的出行要算几千个起点的最短路，后期一个月要好几秒，而网络不变时城市每月的变化很小。
  // 网络、票价或车队变动后的半年每月刷新（客流还在调整），之后每 3 个月，稳定两年后每 6 个月。
  // 道路通车、区域开放、大片新城区、重要设施变化、事件引起的出行变化、有任务当月到期时，都立即刷新。
  // 规则只看日期与局面，普通推进与快进走同一条路，结果相同；没有算完的交通（如刚改票价）也算到期
  const DEMAND_SHIFT = 0.03, DEMAND_SHIFT_LONG = 0.1;
  Game.prototype.trafficDue = function (yr, bigChange) {
    const model = this.model, ym = this.ym();
    if (bigChange || !model.trafficReady()) return true;
    // 网络、票价与车队的变动：记下月份，存档保存
    const fareKey = CM.Model.fareKeyAll(model), fleetVer = this.fleet ? this.fleet.ver : 0;
    if (this._seenNet !== this.netVersion || this._seenFare !== fareKey || this._seenFleet !== fleetVer) {
      if (this._seenNet !== undefined) this.trafficChangedYm = ym;
      this._seenNet = this.netVersion; this._seenFare = fareKey; this._seenFleet = fleetVer;
    }
    if (this.trafficChangedYm == null) this.trafficChangedYm = ym;
    // 线网刚变化时客流还在爬升，勤算；越稳定越省。半年以上的长跳看不到每月的变化，节奏再放宽（v2.6）
    const long = this.jumping && this.jumping.months >= 6;
    const age = ym - this.trafficChangedYm, every = long ? (age < 6 ? 3 : age < 24 ? 6 : 12) : (age < 6 ? 1 : age < 24 ? 3 : 6);
    if (ym % every === 0) return true;
    // 重要设施开放或停用：设施表一变，客流去向就变
    if (CM.Fac && model.fn) { const city = this.city, key = CM.Fac.list(city).filter(function (f) { return CM.Fac.active(f, yr, city); }).map(function (f) { return f.id; }).join(','); if (key !== model.fn.key) return true; }
    // 事件与阶段引起的出行强度变化（大型活动、战争、疫情）
    if (CM.Eras && this._demandRef) {
      const now = CM.Eras.demand(yr), ref = this._demandRef;
      const shift = long ? DEMAND_SHIFT_LONG : DEMAND_SHIFT;
      if (Math.abs(now.hub / ref.hub - 1) > shift || now.rate.some(function (v, i) { return Math.abs(v / ref.rate[i] - 1) > shift; })) return true;
    }
    // 当月到期的任务要用新结果判定
    return this.tasks.active.some(function (t) { return t.deadline && U.ymIndex(t.deadline[0], t.deadline[1]) <= ym; });
  };
  Game.prototype.monthGen = function* () {
    const y = this.clock.y, m = this.clock.m, city = this.city, model = this.model;
    // 城市更新前停止旧预测，避免分步刷新后恢复到旧需求或旧路网的计算中。
    if (this.draft) this.invalidatePrediction('城市正在更新，请在结算完成后重新计算预测');
    model.cancelPredict();
    const oldFacKey = model.fn.key;
    const yr = y + (m - 1) / 12;
    if (CM.applyMoneyEra && CM.applyMoneyEra(y, m)) this.emit('money');   // 货币改革（巴黎 1960、2002）：只改变显示货币，内部记账单位不变
    // 票价随物价（v2.6.1）：1 月自动调价或提醒
    if (m === 1) {
      const fy = this.econ.fareYearly(y, m);
      if (fy.changed) { model.fare = this.econ.fare; model.wake(2); this.logEvent({ tag: '经营', title: '票价随物价调整', desc: CM.UI.fareText(this.econ.fare, true) }); }
      if (fy.changed160) { model.fare160 = this.econ.fare160; model.wake(2); this.logEvent({ tag: '经营', title: '160 轨道票价随物价调整', desc: '全网 160 轨道：' + CM.UI.fareText(this.econ.fare160, true) }); }
      if (!fy.changed && fy.remind) {
        this.logEvent({ tag: '经营', title: '票价实际水平只有开局时的 ' + Math.round(fy.real * 100) + '%', desc: '物价上涨后，票价一直没有调整。可以在财政页调价，或开启随物价自动调价。' });
        this.emit('toast', { kind: 'info', text: '票价实际水平只有开局时的 ' + Math.round(fy.real * 100) + '%，运营成本却一直在涨', fare: true });
      }
    }
    // 历史事件
    D.events.forEach((e, k) => {
      if (this.firedEvents[k]) return;
      if (U.ymIndex(e.y, e.m) <= U.ymIndex(y, m)) { this.firedEvents[k] = 1; this.logEvent({ tag: e.tag, title: e.title, desc: e.desc + (CM.Eras ? CM.Eras.fxNote(e) : '') }); this.emit('histEvent', e); if (CM.Milestones) CM.Milestones.onEvent(this, e, k); }
    });
    // 提前布局的回报（v2.6）与片区规划变化（码头关闭后改作商务区）
    if (CM.Eras) for (const x of CM.Eras.foresightMonth(this, y, m)) {
      const desc = x.hit ? x.f.hit.replace('{st}', x.hit.name) + (x.reward > 0 ? ' 开发商出资 ' + U.fmtMoney(x.reward) + '。' : '') : x.f.miss;
      this.logEvent({ tag: '模拟', title: x.f.title, desc: desc });
      this.emit('histEvent', { y: y, m: m, tag: '模拟', title: x.f.title, desc: desc, fx: null });
    }
    city.applyReplan(yr);
    // 城市经济：1 月结算上一年 GDP 与地方财政、确定本年预算与经济周期；触发到期的经济事件（每个事件只生效一次）
    if (this.macro && CM.Macro) for (const x of CM.Macro.month(this, y, m)) this.logMacroEvent(x);
    const ef = this.macro && CM.Macro ? CM.Macro.cityFactors(this) : null;
    if (D.airport && yr >= D.airport.closeYear + 7 / 12) {
      if (city.lu.some(function (v) { return v === CM.LU.AIRPORT; })) city.closeAirport();
    }
    let roadsChanged = false;
    // 系统填海：到达年份的填海土地成陆（之后可开发与建设）
    for (const r of city.applyReclaim(y)) {
      roadsChanged = true;
      this.logEvent({ tag: r.tag || '史实', title: '填海成陆：' + r.name, desc: r.desc || '新土地将逐步开发，之后可以在此建站与铺轨。' });
      this.emit('toast', { kind: 'info', text: '填海成陆：' + r.name });
      if (CM.Milestones) CM.Milestones.onReclaim(this, r);
    }
    const before = city.roadsBuilt.slice();
    if (city.applyRoads(y)) {
      roadsChanged = true;
      const told = new Set();
      city.roadGroups.forEach((r, k) => {
        if (before[k] || !city.roadsBuilt[k] || !r.notable || !r.name || told.has(r.name) || r.cls < 2) return;
        told.add(r.name);
        this.logEvent({ tag: r.sim ? '模拟' : '史实', title: r.name + (r.sim ? '建成（模拟规划）' : '通车（参考）'), desc: '' });
      });
    }
    const lmBefore = city.landmarkOn.slice();
    city.activateLandmarks(y);
    if (CM.Milestones) CM.Milestones.onLandmarks(this, lmBefore);
    // 区域开放
    let regionOpened = false;
    const tot = city.totals();
    for (let k = 0; k < city.regions.length; k++) {
      const rg = city.regions[k];
      if (city.regionOpen[k] || rg.open == null) continue;
      if (rg.id === 'airport' && D.airport && D.airport.closeYear < 9999 && yr < D.airport.closeYear + 7 / 12) continue;
      const byYear = y >= rg.open;
      // 人口提前达到门槛时可提前开放；经济繁荣时提前窗口放宽一年，衰退时门槛略为提高
      const early = rg.pop && tot.pop >= rg.pop * (ef && ef.dev < -0.03 ? 1.03 : 1) && y >= rg.open - (ef && ef.dev > 0.02 ? 4 : 3);
      if (byYear || early) {
        city.openRegion(k, y, m); regionOpened = true;
        const why = byYear ? '参考 ' + rg.open + ' 年开放' : '城市人口增长，提前开放（参考 ' + rg.open + ' 年）';
        this.logEvent({ tag: byYear ? '史实' : '模拟', title: '新区域开放：' + rg.name, desc: why + (rg.note ? '。' + rg.note : '') + city.openNote(k) });
        this.emit('toast', { kind: 'info', text: '新区域开放：' + rg.name });
      }
    }
    yield;
    // 城市发展
    const acc = model.net ? model.net.acc : null;
    const econF = this.macro && CM.Macro ? CM.Macro.applyFactors(this) : null;
    const gr = city.growMonth({ year: yr, monthIndex: this.ym(), zoneAccess: model.zoneAccessNorm, cellWalk: acc ? acc.cellWalk : null, coverage: acc ? acc.coverage : 0, econ: econF, pull: this.metroPull() });
    if (CM.Cheat) CM.Cheat.hold(this);   // 同上：作弊注入每月补回（v2.9.5）
    yield;
    // 交通刷新节奏（v2.6）：见 trafficDue。不刷新的月份沿用上次的出行结果（模型年份也不变，结果仍算有效），城市发展与经营照常按月结算
    this._graphsDirty = this._graphsDirty || gr.streetsChanged;
    const bigChange = roadsChanged || regionOpened || gr.newUrban >= Math.max(32, Math.ceil(city.N * .005));
    if (this.trafficDue(yr, bigChange)) {
      model.setYear(yr);
      if (this._graphsDirty || roadsChanged) { if (roadsChanged) city.updateStreets(); yield* city.buildGraphsGen(); this._graphsDirty = false; yield; }
      // 编译与模型刷新分多步执行；this.compiled 与模型网络在同一步内一起替换
      // 线网与线路几何没变时沿用上次的编译结果（只取决于线网和城市几何，与日期无关）：省去几十毫秒的同步编译，以及随之重建的三维轨道网格与线网缓存图（v2.6）
      const compKey = this.netVersion + ':' + city.geoVer + ':' + city.terrainVer;
      const C = this._compKey === compKey && this.compiled ? this.compiled : M.compile(this.net, city);
      this._compKey = compKey;
      yield;
      yield* model.refreshCityGen(C);
      this.compiled = C;
      // Small monthly growth uses one warm-start round; topology/facility changes get four.
      const majorTrafficChange = bigChange || model.fn.key !== oldFacKey;
      // 跳月 / 跳年时只算两轮，下一次刷新接着收敛（v2.6）；结束后实时求解继续补足
      yield* model.solveGen(majorTrafficChange ? (this.jumping ? 2 : 4) : 1);
      this._demandRef = CM.Eras ? CM.Eras.demand(yr) : null;
    }
    this.tasks.prepareTrafficReviews(this);
    if (model.hasReviewWork()) yield* model.solveReviewsGen();
    if (this.macro && CM.Macro) CM.Macro.sample(this);   // 本月的岗位与交通效率（年度 GDP 取全年平均）
    yield;
    // 经营与任务：上月已封账，先开新月账本，任务奖励记入新月，最后按本月任务结果发放拨款
    // 满意度按周平均日（5 个工作日 + 2 个周末日）计算，通勤时间按工作日；升级过渡期内不因统计口径变化而下降
    this.econ.updateSatisfaction(model.daily, model, y, m, { protect: this.inTransition(this.ym()) });
    this.econ.openMonth(y, m);
    if (model.trafficReady()) this.tasks.rebaseCongestion(this);
    this.tasks.monthly(this).forEach((o) => this.logTask(o));
    if(model.hasReviewWork()){yield* model.solveReviewsGen();this.tasks.monthly(this).forEach(o=>this.logTask(o));}
    if (CM.Corp) CM.Corp.monthly(this);   // 政府合同（v2.5）：评标、履约考核与付费、招标；履约信誉影响本月拨款
    if (CM.Fleet && this.fleet) CM.Fleet.monthly(this);   // 车队（v2.5）：高峰运力不足、列车超龄提示
    this.econ.payGrant(y, m);
    this.econ.serviceDebt(y, m);   // 债券：到期利息与本金、逾期处理（每月一次，不会重复结算）
    this.recordHistory();
    // 拥堵变化的年度基准：每年 1 月记一次（保留上一年的一份）；还没有时先记下当前月份
    if (m === 1 || !(this.congRef && this.congRef.year)) { const sn = this.congSnapshot(); if (sn) { const R = this.congRef || (this.congRef = {}); if (R.year && R.year.ym < sn.ym) R.yearPrev = R.year; R.year = sn; } }
    if (CM.Eras) { const er = CM.Eras.month(this); if (er) this.logEra(er, true); }   // 历史发展阶段的开始、结束与总结（v2.2）
    if (CM.Milestones) CM.Milestones.onMonth(this);
    if (this.draft) {
      this.draft.evalVer = -1; this.draft.compVer = -1;
      this.invalidatePrediction('城市状态已更新（' + y + '年' + m + '月），请重新计算预测');
    }
    this.emit('month', { y: y, m: m });
  };

  // ---------------- 债券融资（经营挑战） ----------------
  Game.prototype.issueBond = function (kind, term, amount) {
    if (this.jumping || this.pending) return { ok: false, error: '正在结算，请稍候再发行债券' };
    const r = this.econ.issueBond(kind, term, amount, { y: this.clock.y, m: this.clock.m, d: this.clock.d });
    if (!r.ok) return r;
    const b = r.bond, D0 = CM.Economy.BOND_DEF[kind];
    this.rev++;
    this.logEvent({ tag: '经营', title: '发行' + D0.name + ' ' + U.fmtMoney(b.amount), desc: term + ' 年期，年利率 ' + (b.rate * 100).toFixed(2) + '%，每年付息、' + (b.issued[0] + term) + '年' + b.issued[1] + '月到期还本；资金进入建设专项资金，只能用于地铁建设及改扩建。' });
    this.emit('finance');
    return r;
  };
  // 月度历史：客流、分担率与拥堵为周平均日（v1.9 起，tm: 2）；此前的记录为典型工作日口径（不重算）
  Game.prototype.recordHistory = function () {
    const d = this.model.daily || {}, dw = this.model.dailyWk || {}, de = this.model.dailyWe || {};
    const tot = this.city.totals();
    const last = this.econ.ledger[this.econ.ledger.length - 1];
    this.history.push({
      y: this.clock.y, m: this.clock.m, pop: tot.pop, jobs: tot.jobs, share: d.metroShare || 0, cong: d.cong || 1, commute: dw.commute || d.commute || 0,
      riders: d.metro || 0, sat: this.econ.sat, funds: this.econ.isFree() ? null : this.econ.funds, coverage: d.coverage || 0,
      debt: this.econ.isFree() ? null : this.econ.debtTotal(), capex: this.econ.isFree() ? null : this.econ.capex,
      fare: last ? last.fare : 0, ops: last ? last.ops : 0, grant: last ? last.grant : 0, stations: this.compiled.stations.length,
      trips: d.trips || 0, crowd: d.crowdShare || 0, ridersWk: dw.metro || 0, ridersWe: de.metro || 0, tm: CFG.TRAFFIC_MODEL,
    });
    if (this.history.length > 1200) this.history.shift();
  };

  // ---------------- 跳月 / 跳年 ----------------
  Game.prototype.startJump = function (months) {
    if (this.jumping || this.pending) return false;
    if (this.draft) this.invalidatePrediction();
    const t = U.ymIndex(this.clock.y, this.clock.m) + months;
    const ty = Math.floor(t / 12), tm = t % 12 + 1;
    const td = Math.min(this.clock.d, U.daysInMonth(ty, tm));
    const snap = this.snapshotMetrics();
    const total = Math.max(1, months * 30);
    this.jumping = { months: months, target: [ty, tm, td], from: [this.clock.y, this.clock.m, this.clock.d], snap: snap, progress: 0, total: total, gen: this.jumpGen(ty, tm, td, months, total) };
    this.prevSpeed = this.speed;
    this.speed = 0;
    this.emit('jump', this.jumping);
    return true;
  };
  Game.prototype.jumpGen = function* (ty, tm, td, months, total) {
    let n = 0;
    const tgt = U.ymIndex(ty, tm) * 32 + td;
    while (U.ymIndex(this.clock.y, this.clock.m) * 32 + this.clock.d < tgt && !this.econ.failed) {
      const crossed = this.endDay();
      n++;
      this.jumping.progress = Math.min(0.98, n / total);
      if (crossed) {
        yield* this.monthGen();
        // monthGen 已发布本月的两类日期结果，避免重复求解。
      }
      if ((n & 7) === 0) yield;
    }
    if (!this.model.trafficReady()) yield* this.model.solveGen(1);
  };
  // 跳转时求解在等工作线程（v2.1）：本次先返回、不空转，分配一完成（CarPool.onReq）就立即继续，不必等下一帧
  // 时间推进卡片覆盖地图期间（v2.3）：地图降频重绘（见 main.js），只改调度、不改结算结果
  // 细粒度时间片（v2.5 性能）：每片约 10 ms，片与片之间让出主线程（输入与卡片动画照常），不等下一帧就接着算，总耗时不增加
  const nextTask = (function () {
    if (typeof MessageChannel === 'undefined') return function (f) { setTimeout(f, 0); };
    const ch = new MessageChannel(); let fn = null;
    ch.port1.onmessage = function () { const f = fn; fn = null; if (f) f(); };
    return function (f) { fn = f; ch.port2.postMessage(0); };
  })();
  Game.prototype.stepJump = function () {
    const j = this.jumping, t0 = performance.now();
    if (!j || this.model.retired) return;
    j.waiting = false;
    while (performance.now() - t0 < CFG.perf.jumpSliceMs) {
      const r = j.gen.next();
      if (!r.done && r.value === CM.SIM_WAIT) {
        j.waiting = true;
        const self = this;
        if (!j.resume) j.resume = function () { if (self.jumping === j && j.waiting && !self.model.retired) self.stepJump(); };
        if (CM.CarPool) CM.CarPool.onReq = j.resume;
        break;
      }
      if (r.done) {
        if (CM.CarPool && CM.CarPool.onReq === j.resume) CM.CarPool.onReq = null;
        this.jumping = null;
        this.speed = 0;
        this.recordHistoryIfNeeded();
        const res = { from: j.from, to: [this.clock.y, this.clock.m, this.clock.d], before: j.snap, after: this.snapshotMetrics(), failed: this.econ.failed };
        this.emit('jumpDone', res);
        return;
      }
    }
    const now = performance.now();
    if (now - (j.shownAt || 0) > 33) { j.shownAt = now; this.emit('jumpProgress', j.progress); }
    if (!j.waiting && !j.next) {
      const self = this; j.next = true;
      nextTask(function () { j.next = false; if (self.jumping === j && !j.waiting && !self.model.retired) self.stepJump(); });
    }
  };
  Game.prototype.recordHistoryIfNeeded = function () {};
  Game.prototype.snapshotMetrics = function () {
    const d = this.model.daily || {};
    const tot = this.city.totals();
    let open = 0; for (let k = 0; k < this.city.regions.length; k++) open += this.city.regionOpen[k];
    const dw = this.model.dailyWk || {}, de = this.model.dailyWe || {};
    return { pop: tot.pop, jobs: tot.jobs, funds: this.econ.funds, capex: this.econ.capex, debt: this.econ.debtTotal(), share: d.metroShare || 0, cong: d.cong || 1, commute: dw.commute || d.commute || 0, riders: d.metro || 0, sat: this.econ.sat, regions: open, events: this.events.length, tasksDone: this.tasks.done.length, tasksFailed: this.tasks.failed.length,
      coverage: d.coverage || 0, stations: this.compiled.stations.length, fiscF: this.econ.fiscalFactor(), macroRecs: this.macro ? this.macro.rec.length : 0, ridersWk: dw.metro || 0, ridersWe: de.metro || 0 };
  };

  // ---------------- 建设草案 ----------------
  Game.prototype.ensureDraft = function () {
    if (!this.draft) {
      const net = M.clone(this.net);
      // 多份草稿可能都从同一线网出发：编号游标统一从本局专用水位开始，
      // 避免两份草稿各自分配出相同编号，载入时互相覆盖。
      net.nextId = Math.max(this.idFloor || 0, net.nextId || 1);
      this.draft = { net: net, undo: [], redo: [], ver: 1, evalVer: -1, eval: null, compiled: null, compVer: -1, pred: { state: 'idle' } };
      this.emit('draft');
    }
    return this.draft;
  };
  // 草案编辑：出错、抛出异常或产生不完整网络时整体回滚，不留下失效轨道
  Game.prototype.edit = function (fn) {
    const d = this.ensureDraft();
    const snap = JSON.stringify(d.net);
    // 只有存在手动换乘关系时才记录轨道端点快照：绝大多数局面零额外开销。
    // 这是所有玩家绘制路径（绘线、共线运营、并线运行、拆站合并、支线整理、自动修复）的统一兜底。
    const w = this.walkXfer || Game.walkXferDefault();
    const xferBefore = ((w.on && w.on.length) || (w.same && w.same.length)) ? (function () {
      const before = Object.create(null);
      for (const id in d.net.segments) { const s = d.net.segments[id]; before[id] = s.a < s.b ? s.a + '|' + s.b : s.b + '|' + s.a; }
      return before;
    })() : null;
    let r;
    try { r = fn(d.net); } catch (e) { console.error(e); r = { error: '操作未能完成，已撤回（' + e.message + '）' }; }
    if (!(r && r.error)) { const bad = M.validate(d.net); if (bad) r = { error: '操作已撤回：' + bad }; }
    if (!(r && r.error) && xferBefore) { const bad = this.xferLinkViolation(xferBefore, d.net); if (bad) r = { error: bad }; }
    if (r && r.error) { d.net = JSON.parse(snap); return r; }
    d.undo.push(snap); if (d.undo.length > 120) d.undo.shift();
    d.redo = [];
    d.ver++;
    this.idFloor = Math.max(this.idFloor || 0, d.net.nextId || 0);
    this.invalidatePrediction();
    this.emit('draft');
    return r || {};
  };
  // 拖动等连续编辑：开始时记一次撤销点
  Game.prototype.beginLive = function () { const d = this.ensureDraft(); d.liveSnap = JSON.stringify(d.net); };
  Game.prototype.liveEdit = function (fn) { const d = this.ensureDraft(); fn(d.net); d.ver++; this.idFloor = Math.max(this.idFloor || 0, d.net.nextId || 0); this.invalidatePrediction(); this.emit('draftLive'); };
  Game.prototype.endLive = function (changed) {
    const d = this.draft; if (!d || !d.liveSnap) return;
    if (changed) { d.undo.push(d.liveSnap); if (d.undo.length > 120) d.undo.shift(); d.redo = []; }
    else d.net = JSON.parse(d.liveSnap);
    d.liveSnap = null; d.ver++; this.invalidatePrediction(); this.emit('draft');
  };
  Game.prototype.undo = function () {
    const d = this.draft; if (!d || !d.undo.length) return false;
    d.redo.push(JSON.stringify(d.net)); d.net = JSON.parse(d.undo.pop()); d.ver++;
    this.invalidatePrediction(); this.emit('draft'); return true;
  };
  Game.prototype.redo = function () {
    const d = this.draft; if (!d || !d.redo.length) return false;
    d.undo.push(JSON.stringify(d.net)); d.net = JSON.parse(d.redo.pop()); d.ver++;
    this.invalidatePrediction(); this.emit('draft'); return true;
  };
  Game.prototype.cancelDraft = function () {
    if (!this.draft) return;
    this.model.cancelPredict();
    this.draft = null;
    this.emit('draft');
  };
  Game.prototype.draftEval = function () {
    const d = this.draft; if (!d) return null;
    if (d.evalVer !== d.ver) {
      d.eval = M.evaluate(d.net, this.net, this.city, this.clock.y);
      if (CM.Fleet && this.fleet) CM.Fleet.draftExtra(this, d.eval);   // 随线配车（v2.5）：新线与延长后补足最低服务所需列车，费用计入建设
      d.evalVer = d.ver;
    }
    return d.eval;
  };
  Game.prototype.draftCompiled = function () {
    const d = this.draft; if (!d) return null;
    if (d.compVer !== d.ver) { d.compiled = M.compile(d.net, this.city); d.compVer = d.ver; }
    return d.compiled;
  };
  Game.prototype.canConfirm = function () {
    const ev = this.draftEval();
    if (!ev) return { ok: false, reason: '没有草案' };
    if (this.draft.liveSnap) return { ok: false, reason: '请先松开鼠标或结束当前拖动，再确认建设' };
    if (!ev.changed) return { ok: false, reason: '草案没有变化' };
    if (ev.conflicts.length) return { ok: false, reason: '存在 ' + ev.conflicts.length + ' 处冲突，需先解决' };
    if (!this.econ.canAffordBuild(ev.total)) return { ok: false, reason: '资金不足：需要 ' + U.fmtMoney(ev.total) + '，当前一般资金 ' + U.fmtMoney(this.econ.funds) + (this.econ.capex > 0.5 ? ' + 建设专项资金 ' + U.fmtMoney(this.econ.capex) : '') };
    if (this.jumping || this.pending) return { ok: false, reason: '正在结算，请稍候' };
    return { ok: true };
  };
  Game.prototype.confirmDraft = function () {
    const can = this.canConfirm();
    if (!can.ok) return can;
    const ev = this.draftEval(), d = this.draft, beforeNet = M.clone(this.net);
    // 扣费（按类别记入当月收支）
    // 建设费用先从建设专项资金（债券募集）支付，不足部分用一般资金
    this.econ.spendBuild(ev.byKind, '地铁建设（' + ev.changes.add.length + ' 项新建、' + ev.changes.mod.length + ' 项修改）', { y: this.clock.y, m: this.clock.m, d: this.clock.d });
    for (const dm of ev.demolitions) this.city.demolish(dm.c, dm.frac);
    // 本次建设新增的对象：写入建成年月，并记入建设回放（v2.6）
    const buildSt = [], buildSg = [], buildLn = [];
    for (const id in d.net.lines) if (!this.net.lines[id]) buildLn.push(id);
    for (const id in d.net.stations) if (!this.net.stations[id]) { d.net.stations[id].built = [this.clock.y, this.clock.m]; buildSt.push(id); }
    // 新建、改建与搬迁后的位置成为新的“付费选址”，之后的免费微调以此为基准
    for (const id in d.net.stations) { const s = d.net.stations[id], o = this.net.stations[id]; if (o && !s.site) s.site = [o.x, o.y]; }
    for (const id of ev.siteReset || []) { const s = d.net.stations[id]; if (s) s.site = [s.x, s.y]; }
    for (const id in d.net.segments) if (!this.net.segments[id]) { d.net.segments[id].built = [this.clock.y, this.clock.m]; buildSg.push(id); }
    // 轨道的“已付费长度”：之后的免费小幅调整以此为基准累计
    for (const id in d.net.segments) { const v = ev.paidLen && ev.paidLen[id]; if (v != null) d.net.segments[id].paidLen = Math.round(v); }
    // 收藏：记下被拆除或改名对象的最新名称（读档后已拆除的收藏仍显示原名）
    const fv = this.favs; fv.names = fv.names || {};
    for (const id of fv.stations) { const s = d.net.stations[id] || this.net.stations[id]; if (s) fv.names[id] = s.name; }
    for (const id of fv.lines) { const L = d.net.lines[id] || this.net.lines[id]; if (L) fv.names[id] = L.name; }
    M.normalizeLines(d.net);
    for (const id in d.net.segments) d.net.segments[id].base = null;
    const summary = ev.changes.add.length + ' 项新建、' + ev.changes.mod.length + ' 项修改、' + ev.changes.del.length + ' 项拆除';
    // 拥堵变化的对比基准：新增车站的建设确认前，记下此刻的工作日早高峰道路拥堵（拥堵图层「建设以来」与之对比）
    const newSt = Object.keys(d.net.stations).filter(function (id) { return !this.net.stations[id]; }, this);
    if (newSt.length) {
      const sn = this.congSnapshot();
      if (sn) { const names = Array.from(ev.affectedLines).map(function (lid) { return d.net.lines[lid] && d.net.lines[lid].name; }).filter(Boolean); sn.label = names.length ? names.slice(0, 2).join('、') + (names.length > 2 ? ' 等' : '') : newSt.length + ' 座新站'; (this.congRef || (this.congRef = {})).build = sn; }
    }
    // 建设回放：按「确认建设」的先后记录批次，回放时可按时间顺序重现
    if (buildSt.length || buildSg.length || buildLn.length || ev.changes.del.length) {
      this.buildLog.push({
        y: this.clock.y, m: this.clock.m, ym: U.ymIndex(this.clock.y, this.clock.m),
        cost: Math.round(ev.total || 0),
        // 记下当时的站名与线路名：日后改名或拆除，回放里仍能显示建的是什么
        st: buildSt.map(function (id) { const s = d.net.stations[id]; return { id: id, name: s ? s.name : '' }; }),
        ln: buildLn.map(function (id) { const L = d.net.lines[id]; return { id: id, name: L ? L.name : '', num: L ? L.num : null }; }),
        sg: buildSg,
        rm: ev.changes.del.length, mod: ev.changes.mod.length,
      });
      if (this.buildLog.length > 3000) this.buildLog.splice(0, this.buildLog.length - 3000);
    }
    this.net = d.net;
    this.netVersion++;
    this.rev++;
    this.compiled = M.compile(this.net, this.city);
    if (CM.Fleet && this.fleet) { CM.Fleet.applyAdd(this, ev.fleetAdd); CM.Fleet.sync(this); this.fleet.ver++; }   // 随线配车落实；拆除线路的列车回到车辆段
    this.model.cancelPredict();
    // 沿线拆迁减少了人口与就业：立即重算小区人口岗位与出行需求，不等到月度结算
    if (ev.demolitions.length) { this.model.buildZones(); this.model.buildDemand(); }
    this.model.setNetwork(this.compiled);
    this._impactPlan = { before: beforeNet, version: this.netVersion, lines: Array.from(ev.affectedLines), cost: ev.total || 0, summary: summary };
    this.impactReport = { status: 'waiting', at: [this.clock.y, this.clock.m] };
    this.draft = null;
    this.logEvent({ tag: '建设', title: '建设完成并投入运营', desc: summary + (ev.total > 0 ? '，费用 ' + U.fmtMoney(ev.total) : '，无费用') });
    if (CM.Milestones) CM.Milestones.onNetwork(this);
    this.emit('network');
    this.emit('draft');
    this.emit('toast', { kind: 'good', text: '建设完成，已投入运营' + (ev.total > 0 ? '（' + U.fmtMoney(ev.total) + '）' : '') });
    this.emit('autosave', 'build');
    return { ok: true };
  };

  // 运营组织变化（运行交路，v2.5）：不改动轨道、不收费，立即重新编译并按新的路线求解；草案随之重新检查
  Game.prototype.refreshOperations = function () {
    this.netVersion++; this.rev++;
    this.compiled = M.compile(this.net, this.city);
    if (CM.Fleet && this.fleet) { CM.Fleet.sync(this); this.fleet.ver++; }
    this.model.cancelPredict();
    this.model.setNetwork(this.compiled);
    const d = this.draft; if (d) { d.compVer = -1; d.evalVer = -1; this.invalidatePrediction(); }
    this.emit('network');
    this.emit('autosave', 'build');
  };
  // 预测
  Game.prototype.invalidatePrediction = function (msg) {
    const d = this.draft; if (!d) return;
    d.autoVer = null;   // 票价、月份等外部条件变化时，即使草案版本没变也要允许自动重算。
    if (d.pred.state === 'running') this.model.cancelPredict();
    if (d.pred.state !== 'idle') d.pred = { state: 'stale', msg: msg || '草案已修改，预测需要重新计算', last: d.pred.result || d.pred.last };
    this.emit('prediction');
  };
  Game.prototype.requestPrediction = function () {
    const d = this.draft; if (!d) return;
    if (this.pending || this.jumping || this.model.refreshing) {
      this.invalidatePrediction('正在进行城市结算，请稍后重新计算预测');
      return;
    }
    const ev = this.draftEval();
    const C = this.draftCompiled();
    const ver = d.ver;
    const affected = Array.from(ev.affectedLines);
    const self = this;
    d.pred = { state: 'running', progress: 0, ver: ver };
    const gen = this.model.predict(C, affected, function (res) {
      if (!self.draft || self.draft.ver !== ver) return;
      res.conditions.y = self.clock.y; res.conditions.m = self.clock.m;
      self.draft.pred = { state: 'done', result: res, ver: ver };
      self.emit('prediction');
    });
    d.pred.gen = gen;
    this.emit('prediction');
  };

  // ---------------- 查询 ----------------
  Game.prototype.zoneName = function (z) {
    const m = this.model;
    const x = m.zCx[z], y = m.zCy[z];
    let best = null, bd = 1e9;
    for (const p of D.places) { const d = U.dist(x, y, p[1], p[2]); if (d < bd) { bd = d; best = p[0]; } }
    // 附近有地名时只说地名（v2.6.1 玩家反馈）：片区按街道划分、范围很大，「石榴岗一带（官洲·生物岛）」读起来像在岛上
    if (bd < 5) return best + '一带';
    const rg = this.city.regionAt(x, y);
    return '片区' + (rg ? '（' + rg.name.replace(/（.*）/, '') + '）' : '');
  };
  // 片区早高峰拥堵：默认工作日（通勤口径）
  Game.prototype.zoneCong = function (z, dt) {
    const model = this.model, P = model.resultsFor(dt === 'we' ? 'we' : 'wd').per[0], road = model.road;
    let num = 0, den = 0;
    for (let a = 0; a < road.nA; a++) {
      if (model.arcZone[a] !== z) continue;
      const v = P.arcVol[a]; if (v <= 0) continue;
      num += v * road.arcLen[a] * (P.arcTime[a] / road.arcT0[a]); den += v * road.arcLen[a];
    }
    return den > 0 ? num / den : 1;
  };
  // 发展阶段名称：由各地图的场景数据提供（stages 为 [截止年份（不含）, 名称]，stageLast 为史料截止前的最后阶段）
  Game.prototype.stageName = function () {
    // 历史发展阶段（v2.2）：有 DATA.eras 的地图显示当前阶段名称
    if (CM.Eras && CM.Eras.enabled()) { const e = CM.Eras.current(this.year()); if (e) return e.name; }
    const y = this.clock.y;
    for (const s of D.stages || []) if (y < s[0]) return s[1];
    if (y <= CFG.growth.histEnd) return D.stageLast || '发展期';
    return D.fictional ? '持续发展' : '模拟未来';
  };

  // 地铁带动发展（v2.3 玩家反馈：城市发展在很大程度上受地铁建设影响）：每座运营车站对周边约 1 km 产生吸引，
  // 强度 = 基础 + 换乘（每多一条线）+ 客流 + 车站商业开发，开通后约 4 年逐步形成（先快后慢）。
  // 返回每格的吸引值 field、线网成熟度 M（按地铁覆盖比例）与车站吸引的权重 w；每月一次，按车站数 × 周边格子计算
  Game.prototype.metroPull = function () {
    const m = this.model, net = m.net, C = net && net.C, acc = net && net.acc, city = this.city, W = city.W, H = city.H, G = CFG.metroLed;
    if (!C || !C.stations.length || !acc || !G) return null;
    const sd = m.stDailyWk && !m.dailyStale && m.stDailyWk.inn.length === C.stations.length ? m.stDailyWk : null;
    const field = new Float32Array(city.N), now = this.clock.y + (this.clock.m - 1) / 12;
    const top = [];
    for (let i = 0; i < C.stations.length; i++) {
      const s = C.stations[i], st = this.net.stations[s.id]; if (!st || (C.serviced && !C.serviced[i])) continue;
      // v3.3：第 4、5 级 TOD 是片区 / 枢纽级开发，带动半径从约 1 km 扩到 2–3 km
      const R = G.radius * (st.tod >= 5 ? 3 : st.tod >= 4 ? 2 : 1);
      const age = st.built ? now - st.built[0] - (st.built[1] - 1) / 12 : G.years, x = U.clamp(age / G.years, 0, 1), ramp = 1 - (1 - x) * (1 - x);
      const lines = C.stationLines[i] ? C.stationLines[i].size : 1, flow = sd ? sd.inn[i] + sd.out[i] + sd.xfer[i] : 0;
      const k = (G.base + G.xfer * Math.max(0, lines - 1) + G.flow * Math.min(1, flow / G.flowFull) + (G.tod[st.tod || 0] || 0)) * ramp;
      if (k <= 0.001) continue;
      top.push({ name: st.name, x: s.x, y: s.y, k: k });
      const i0 = Math.max(0, Math.floor(s.x - R)), i1 = Math.min(W - 1, Math.ceil(s.x + R)), j0 = Math.max(0, Math.floor(s.y - R)), j1 = Math.min(H - 1, Math.ceil(s.y + R));
      for (let j = j0; j <= j1; j++) for (let q = i0; q <= i1; q++) { const d = Math.hypot(q + 0.5 - s.x, j + 0.5 - s.y) / R; if (d < 1) field[j * W + q] += k * (1 - d) * (1 - d); }
    }
    if (!top.length) return null;
    top.sort(function (a, b) { return b.k - a.k; });
    const y = U.clamp(((acc.coverage || 0) - G.cov0) / (G.cov1 - G.cov0), 0, 1), M = y * y * (3 - 2 * y);
    return { field: field, M: M, w: G.wMin + (1 - G.wMin) * M, top: top.slice(0, 24), all: top };
  };
  // 地铁出行习惯（v2.3）：编译线网中车站 s 已开通的年数（按开通月份与当前日期；草案中的新站为 0）
  Game.habitAge = function (g) { return function (C, s) { const st = g.net.stations[C.stations[s].id], c = g.clock; return st && st.built ? c.y + (c.m - 1) / 12 - st.built[0] - (st.built[1] - 1) / 12 : 0; }; };

  // 拥堵变化的对比基准（v2.3）：工作日早高峰各路段的拥堵比（行驶时间 ÷ 自由流时间）按 0.01 一档存成字节（255 为未知）。
  // build：最近一次新增车站的建设确认前；year / yearPrev：每年 1 月。随存档保存；道路网络变化时按路段键重新对应
  Game.prototype.congSnapshot = function () {
    const m = this.model, road = m.road, P = m.resultsFor('wd').per[0];
    if (!road || !P || !P.arcTime || P.arcTime.length !== road.nA || !P.stats) return null;   // 发布的结果副本带统计（还没算过一轮的不记）
    const q = new Uint8Array(road.nA);
    for (let a = 0; a < road.nA; a++) q[a] = Math.max(0, Math.min(254, Math.round((P.arcTime[a] / road.arcT0[a] - 1) * 100)));
    return { ym: this.ym(), q: q, road: road };
  };
  // 对比用的基准（与当前道路网络对齐）；kind：build 建设以来，year 一年来（取 12 个月以前的一份）
  Game.prototype.congRefFor = function (kind) {
    const R = this.congRef; if (!R) return null;
    const ref = kind === 'year' ? (R.yearPrev && this.ym() - R.year.ym < 12 ? R.yearPrev : R.year) : R.build;
    if (!ref) return null;
    const road = this.model.road;
    if (ref.road !== road) {
      if (ref.road && ref.road.links) {
        const map = new Map(), old = ref.road, q = new Uint8Array(road.nA).fill(255);
        old.links.forEach(function (L) { map.set(L.key, L); });
        for (const L of road.links) { const o = map.get(L.key); if (!o) continue; const same = o.verts[0] === L.verts[0]; for (let d = 0; d < 2; d++) q[2 * L.id + d] = ref.q[2 * o.id + (same ? d : 1 - d)]; }
        ref.q = q;
      } else if (ref.q.length !== road.nA) return null;
      ref.road = road;
    }
    return ref;
  };
  const b64 = function (u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = function (s) { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
  Game.packCong = function (R) {
    const out = {}; let any = false;
    for (const k of ['build', 'year', 'yearPrev']) { const r = R && R[k]; if (r && r.q) { out[k] = { ym: r.ym, label: r.label || '', q: b64(r.q) }; any = true; } }
    return any ? out : undefined;
  };
  Game.unpackCong = function (S) {
    if (!S) return null; const out = {};
    for (const k of ['build', 'year', 'yearPrev']) { const r = S[k]; if (r && typeof r.q === 'string') { try { out[k] = { ym: r.ym, label: r.label || '', q: unb64(r.q), road: null }; } catch (e) { /* 损坏的基准忽略 */ } } }
    return out;
  };

  // ---------------- 存档 ----------------
  Game.prototype.serialize = function () {
    return {
      meta: { gameId: this.id, name: this.name, mode: this.mode, seed: this.seed, createdAt: this.createdAt, gameVersion: CFG.GAME_VERSION, map: this.mapId || 'gz', mapVersion: (CM.MAPS[this.mapId || 'gz'] || {}).mapVersion || 1, scenario: (CM.MAPS[this.mapId || 'gz'] || {}).scenario || '', mapFp: (CM.MAPS[this.mapId || 'gz'] || {}).fp || '' },
      clock: Object.assign({}, this.clock),
      city: this.city.serialize(),
      net: this.net,
      walkXfer: this.walkXfer,   // 手动换乘关系：on 站外换乘、same 长距离换乘
      econ: this.econ.serialize(),
      tasks: this.tasks.serialize(),
      corp: this.corp || undefined,   // 地铁公司的政府合同：招标、履约中与已结束的合同、履约信誉（v2.5）
      fleet: this.fleet || undefined,   // 车队：列车（车型、编组、购置年月与价格、配属线路与交路）与各线运营模式（v2.5）
      opsNote: this.opsNote || undefined,   // 地铁芯的过载提醒：持续月数与静默期（v2.5）
      events: this.events.slice(-300),
      history: this.history.slice(-1200),
      firedEvents: this.firedEvents, trafficYear: this.model.year, trafficChangedYm: this.trafficChangedYm,
      unlockAll: this.unlockAll || undefined, startYear: this.startYear || undefined, eraLog: this.eraLog || undefined,
      eraBase: this.eraBase || undefined, startBase: this.startBase || undefined,
      favs: this.favs,
      buildLog: this.buildLog && this.buildLog.length ? this.buildLog : undefined,   // 建设回放：每次确认建设的批次（v2.6）
      drafts: this.drafts && this.drafts.length ? this.drafts : undefined,   // 建设草稿：保存的草案改动清单
      draftIdFloor: this.idFloor || undefined,   // 草案编号水位（多份草稿的编号不重复）
      activeDraft: this.draft ? Game.packActiveDraft(this.draft) : undefined,   // 未确认的当前草案（重新打开进度后可继续）
      tutorial: this.tutorial || null,
      voices: this.voices || undefined,   // 地铁圈：关注的市民与他们的动态存档（v2.3）
      congRef: this.congRef ? Game.packCong(this.congRef) : undefined,   // 拥堵变化的对比基准（v2.3）
      milestones: this.milestones || null,
      mapInit: this.mapInit || null,
      macro: this.macro && CM.Macro ? CM.Macro.serialize(this.macro) : null,
      traffic: this.traffic || { v: CFG.TRAFFIC_MODEL },
      rulesRevision: CFG.RULES_REVISION,
      taskRecheckYM: this.taskRecheckYM ?? null,
      impactReport: Game.validImpact(this.impactReport) ? this.impactReport : null,
      cheat: CM.Cheat && this.cheat && this.cheat.used ? CM.Cheat.pack(this.cheat) : undefined,   // 作弊注入（v2.9.5）：只存记号与累计量，撤销栈不存档
    };
  };
  // 当前草案的存档表示：只保存线网快照与保存状态，撤销栈与预测缓存读档后重建
  Game.packActiveDraft = function (d) {
    return { net: d.net, ver: d.ver, savedId: d.savedId || null, savedVer: d.savedVer == null ? null : d.savedVer, name: d.name || null };
  };
  // 草稿列表：只接受结构完整的条目；旧存档没有该字段时为空
  Game.restoreDrafts = function (raw) {
    const out = [];
    if (!Array.isArray(raw)) return out;
    for (const e of raw.slice(-16)) {
      if (!e || typeof e.id !== 'string' || !e.plan || typeof e.plan !== 'object') continue;
      const P = e.plan;
      if (!P.add || !P.mod || !P.del || typeof P.add !== 'object' || typeof P.mod !== 'object' || typeof P.del !== 'object') continue;
      out.push({
        id: e.id,
        name: String(e.name || '').slice(0, 24) || '草案',
        at: Array.isArray(e.at) ? e.at.slice(0, 3) : null,
        seq: Number.isFinite(+e.seq) ? +e.seq : 0,
        plan: P,
        sum: e.sum && typeof e.sum === 'object' ? e.sum : null,
      });
    }
    return out;
  };
  // 未确认的草案：线网结构完整时恢复，否则丢弃（正式进度不受影响）
  Game.restoreActiveDraft = function (raw, g) {
    if (!raw || !raw.net || typeof raw.net !== 'object') return null;
    const net = raw.net;
    if (!net.stations || !net.segments || !net.lines) return null;
    // 结构性检查：坐标与引用必须齐全，否则读档后的草案无法绘制或结算
    for (const id in net.stations) {
      const s = net.stations[id];
      if (!s || !Number.isFinite(+s.x) || !Number.isFinite(+s.y) || typeof s.name !== 'string') return null;
    }
    for (const id in net.lines) if (!net.lines[id] || typeof net.lines[id] !== 'object') return null;
    if (M.validate(net)) return null;
    const ver = Math.max(1, Math.floor(+raw.ver) || 1);
    const d = { net: net, undo: [], redo: [], ver: ver, evalVer: -1, eval: null, compiled: null, compVer: -1, pred: { state: 'idle' } };
    if (raw.savedId && g.drafts.some(function (e) { return e.id === raw.savedId; })) {
      d.savedId = raw.savedId;
      d.savedVer = Math.max(0, Math.floor(+raw.savedVer) || 0);
    }
    if (raw.name) d.name = String(raw.name).slice(0, 24);
    return d;
  };
  Game.restoreGen = function* (s, sync) {
    const g = new Game();
    let complete = false;
    try {
      if (CM.Difficulty) {
        // 旧自由建造档没有 difficulty：补成 free；无限贷款开关由 Economy.restore 读入（旧档按档位名迁移）
        const sd = s.econ && s.econ.difficulty, mm = s.meta || {};
        const lvl = mm.mode === 'free' && (!sd || sd === 'normal') ? 'free' : (sd || 'normal');
        CM.Difficulty.loadGame(lvl, s.econ && s.econ.tune ? s.econ.tune : null);
      }
      const m = s.meta;
      g.id = m.gameId; g.name = m.name; g.mode = m.mode; g.seed = m.seed; g.createdAt = m.createdAt;
      g.mapId = m.map || 'gz';   // 调用前 CM.useMap 已切换到该地图
      if (s.tutorial) g.tutorial = s.tutorial;
      if (s.voices) g.voices = s.voices;
      g.cheat = CM.Cheat ? CM.Cheat.restore(s.cheat) : null;   // 作弊记号（v2.9.5）：人口 / 岗位本身已在城市存档里
      g.congRef = Game.unpackCong(s.congRef);
      g.clock = Object.assign({}, s.clock);
      if (CM.applyMoneyEra) CM.applyMoneyEra(g.clock.y, g.clock.m);
      g.city = new CM.City();
      yield* g.city.generateGen(g.seed, CFG.START.y, {deferGraphs:true});
      yield* g.city.restoreGen(s.city, g.clock.y);
      // 读档后补点地标（v2.9.3）：新版本新增的地标在旧存档里没有状态位（restore 只会把存档里已有的地标恢复成启用）。
      // 若存档年份已经过了落成年，这里立刻补点亮，不必等到下一次跨月——否则玩家读档后看到的还是空地，
      // 会以为新加的站房没做进去。必须在构建交通模型之前，让当月的接驳需求就把新枢纽算进去。
      try { g.city.activateLandmarks(g.clock.y + (g.clock.m - 1) / 12); } catch (e) { console.error(e); }
      // 全图解锁要在编译线网之前恢复：线路几何带有可建设范围的判断（玩家反馈：读档后已建线路在未开放区段报冲突）
      g.unlockAll = !!s.unlockAll && g.mode === 'free'; g.city.unlockAll = g.unlockAll;
      lp(0.3, '恢复城市');
      // 交通模型版本：1.8 及更早的存档为 1（典型工作日、通勤与其他两类出行），载入时升级到当前模型
      const tv = (s.traffic && s.traffic.v) || 1, upgrade = tv < CFG.TRAFFIC_MODEL;
      const rulesUpgrade = (s.rulesRevision || 0) < CFG.RULES_REVISION;
      // 台北松山机场（v1.9 起可地下建设）：旧存档中该区域仍为未开放，读档时开放（机场照常运营，用地不开发）
      let airportOpened = null;
      if (D.airport && D.airport.buildable) {
        const k = g.city.regions.findIndex(function (r) { return r.id === 'airport'; });
        if (k >= 0 && !g.city.regionOpen[k] && g.city.regions[k].open != null && g.city.regions[k].open <= g.clock.y) { g.city.openRegion(k, g.clock.y, g.clock.m); airportOpened = g.city.regions[k]; }
      }
      // 先设置存档年份，再构建一次需求，避免构造器按开局年完整求一遍后立即丢弃。
      g.model = new CM.Model(g.city, {deferDemand:true});
      g.walkXfer = Game.walkXferNormalize(s.walkXfer); g.model.walkXfer = g.walkXfer;
      g.model.habitAge = Game.habitAge(g);
      g.model.setYear(s.trafficYear != null ? s.trafficYear : g.clock.y + (g.clock.m - 1) / 12);   // 不刷新的月份里，交通结果对应的年份早于当前日期（v2.6）
      g.model.setDayType(CM.Model.dayType(g.clock.y, g.clock.m, g.clock.d));
      g.model.buildZones(); g.model.buildDemand();
      g.net = s.net;
      // 建设回放：新存档直接读批次；旧存档按车站与轨道的建成年月推导一次，之后继续追加
      g.buildLog = Array.isArray(s.buildLog) ? s.buildLog.filter(function (e) { return e && Number.isFinite(e.y) && Number.isFinite(e.m) && e.ym !== undefined; }) : [];
      if (!g.buildLog.length && CM.Timeline) g.buildLog = CM.Timeline.derive(g);
      // 建设草稿：先恢复草稿列表，再恢复未确认的当前草案（草案的“已保存”状态引用草稿 id）
      g.drafts = Game.restoreDrafts(s.drafts);
      g.draftSeq = g.drafts.reduce(function (n, e) { const v = parseInt(String(e.id).replace(/^\D+/, ''), 10); return Number.isFinite(v) ? Math.max(n, v) : n; }, 0);
      g.draft = Game.restoreActiveDraft(s.activeDraft, g);
      // 编号水位：读档后新开的草稿要继续避开已保存草稿用过的编号
      g.idFloor = Math.max(0, Math.floor(+s.draftIdFloor) || 0);
      for (const e of g.drafts) {
        for (const k of ['lines', 'stations', 'segments']) {
          const list = e.plan && e.plan.add && e.plan.add[k];
          if (!list) continue;
          for (const id in list) { const v = M.idNum(id); if (Number.isFinite(v)) g.idFloor = Math.max(g.idFloor, v + 1); }
        }
      }
      if (g.draft) g.idFloor = Math.max(g.idFloor, g.draft.net.nextId || 0);
      // 旧存档里已有的手动换乘关系：读档时同样统一为组内先建站的站名
      g.walkXferSyncNames();
      // 旧存档里规模不一致的换乘组统一到组内最大规模（只升不降），保证整组一致规则
      g.walkXferAlignSizes();
      g.compiled = M.compile(g.net, g.city);
      g.model.setNetwork(g.compiled);
      g.econ = CM.Economy.restore(s.econ);
      // v3.4：160 轨道改为全网统一票价。旧存档把票价存在各条线路上，取第一条 160 线路的设定迁移过来，
      // 然后清掉线路上的旧字段（新存档不再写入），避免以后误用
      if (!s.econ.fare160) {
        let legacy = null;
        for (const id in g.net.lines) { const L0 = g.net.lines[id]; if (L0 && L0.fare160 != null && M.lineKmh(L0) >= 160) { legacy = M.fare160Of(L0); break; } }
        if (legacy) { g.econ.fare160 = CM.Economy.normFare160(legacy); g.econ.fare160Mark = g.econ.fareMark != null ? g.econ.fareMark : null; }
      }
      for (const id in g.net.lines) if (g.net.lines[id]) delete g.net.lines[id].fare160;
      g.model.fare = g.econ.fare;
      g.model.fare160 = g.econ.fare160;
      g.tasks = CM.Tasks.restore(s.tasks);
      g.corp = s.corp && Array.isArray(s.corp.contracts) ? s.corp : null;
      g.fleet = s.fleet && Array.isArray(s.fleet.trains) ? s.fleet : null;
      if (g.fleet && CM.Fleet) g.model.fleetSource = function (net) { return CM.Fleet.plan(g, net); };
      g.opsNote = s.opsNote || null;
      g.trafficChangedYm = s.trafficChangedYm ?? null;
      g.events = s.events || []; g.history = s.history || []; g.firedEvents = s.firedEvents || {};
      g.favs = { stations: (s.favs && s.favs.stations) || [], lines: (s.favs && s.favs.lines) || [], names: (s.favs && s.favs.names) || {} };
      g.mapInit = s.mapInit || null;
      g.unlockAll = !!s.unlockAll && g.mode === 'free'; g.city.unlockAll = g.unlockAll;
      const kept = g.city.keepLegacyOpen(g.net, g.tasks, g.clock.y, g.clock.m).map(k => g.city.regions[k].name).join('、');
      // 任务锚点校正：早期版本把任务锚点写成经纬度（广州「大石」等几处取错），而锚点在发布时已复制进存档，
      // 这里按任务编号换成当前数据里的位置，避免旧存档继续显示错位的目标圈
      if (CM.Tasks && CM.Tasks.prototype.rebaseAnchors) { try { g.tasks.rebaseAnchors(g); } catch (e) { console.error(e); } }
      g.startYear = s.startYear || null; g.eraLog = s.eraLog || null;
      g.eraBase = s.eraBase || null; g.startBase = s.startBase || null;
      g.taskRecheckYM = s.taskRecheckYM ?? null;
      g.impactReport = !(s.mapUpgrade && !s.mapUpgrade.displayOnly) && Game.validImpact(s.impactReport) ? s.impactReport : null;
      g.milestones = s.milestones || null;
      lp(0.42, '恢复交通模型');
      const cacheHit = !upgrade && !airportOpened && !s.__mapMigratedFrom && !s.mapUpgrade && CM.TrafficCache && CM.TrafficCache.restore(g, s.__trafficState);
      if (!cacheHit) {
        g.model.onSolveProgress = f => lp(0.42 + 0.53 * f, '恢复居民出行');
        try { if (sync) g.model.solveNow(4); else yield* g.model.solveGen(4); } finally { g.model.onSolveProgress = null; }
        if (s.__trafficKey && !upgrade && !airportOpened && !s.__mapMigratedFrom && !s.mapUpgrade && CM.TrafficCache) CM.TrafficCache.put(s.__trafficKey, CM.TrafficCache.capture(g));
      }
      if (!cacheHit && s.__trafficKey && CM.TrafficCache) CM.TrafficCache.track(g, s.__trafficKey);
      if (CM.Milestones) CM.Milestones.backfill(g);
      if (CM.Eras) {
        CM.Eras.attach(g);
        if (s.mapUpgrade && !s.mapUpgrade.displayOnly) CM.Eras.rebaseMap(g);
        CM.Eras.ensureBases(g, true);
      }
      // 城市经济：有数据则恢复；1.7 及更早的存档（或数据不完整）从当前状态接入，不补造过去的记录，不改变已有资金与债务。
      // 接入失败时本局不启用经济模拟，原存档不受影响
      g.macro = null;
      if (CM.Macro && CM.Macro.enabled()) {
        try { CM.Macro.attach(g, s.macro || null); }
        catch (e) {
          console.error(e);
          try { g.macro = null; CM.Macro.attach(g, null); g.macroNote = '存档中的城市经济数据无法识别，已从当前状态重新接入'; }
          catch (e2) { console.error(e2); g.macro = null; g.econ.fisc = null; g.econ.quoteFn = null; g.macroError = '城市经济数据未能初始化（' + (e2 && e2.message || e2) + '），本局暂不启用；原存档未受影响'; }
        }
        if (g.macro && !s.macro) g.macroNote = '城市经济自 ' + g.clock.y + ' 年 ' + g.clock.m + ' 月起接入：此前的经济数据未记录，不作补造';
      }
      // 地图版本升级（范围扩展）：新增范围已按存档年份生成；城市经济按新范围调整统计口径。其余进度不变
      // mapUpgrade 由迁移函数写入解析出的副本（导入时随副本保存一次）；正常保存不再包含它，因此只执行一次
      if (s.mapUpgrade) {
        const mu = s.mapUpgrade;
        const ab = s.macro && s.macro.areaRebase;
        if (g.macro && CM.Macro && CM.Macro.rebaseArea && ab) {
          try {
            const c = g.city, W = c.W, b = ab.oldBox; let inBox = 0;
            for (let j = b[1]; j < b[1] + b[3]; j++) for (let i = b[0]; i < b[0] + b[2]; i++) inBox += c.jobs[j * W + i];
            CM.Macro.rebaseArea(g, c.totals().jobs / Math.max(1, inBox));
            delete g.macro.areaRebase;
          } catch (e) { console.error(e); }
        }
        g.backupFailed = s.__backupFailed || null;
        g.mapUpgradeInfo = mu;
        if (mu.displayOnly) {
          g.logEvent({ tag: '版本', title: '地图展示更新', desc: mu.note });
          g.upgradeNote = s.__backupFailed ? '地图展示已更新；升级前备份未能建立，不会自动保存，原存档保持不变' : '地图展示已更新，原有线网与经营进度保留；升级前的存档已单独备份';
        } else {
        g.logEvent({ tag: '版本', title: '地图范围扩展（第 ' + mu.from + ' 版 → 第 ' + mu.to + ' 版）', desc: (mu.note ? mu.note + '。' : '') + '新增范围按 ' + g.clock.y + ' 年的城市状态生成，原有车站、线路、资金、债务、任务与历史记录全部保留；城市经济按新范围调整统计口径。' });
        g.upgradeNote = s.__backupFailed ? '存档已在内存中升级到新的地图范围；升级前备份未能建立（' + s.__backupFailed + '），不会自动保存，原存档保持不变' :
          (mu.imported ? '导入的进度已接入大地图，原导入文件保持不变；新增区域按存档年份生成' : '地图范围已扩展：新增区域按 ' + g.clock.y + ' 年生成（升级前的原存档已另存为「升级前备份」，可在存档列表中载入或导出）');
        }
      }
      // 交通模型升级：保留原有建设、资金、债务、历史结算与任务进度；已结算的历史不重算。升级当月设过渡保护（见 inTransition）
      if (upgrade) {
        g.traffic = { v: CFG.TRAFFIC_MODEL, from: m.gameVersion || '1.8.0', at: [g.clock.y, g.clock.m, g.clock.d], until: g.ym() + 1 };
        if (g.model.trafficReady()) g.tasks.rebaseCongestion(g);
        for (const t of g.tasks.active) if (t.type === 'ridership' && !t.basis) t.basis = 'wd';   // 进行中的客流任务沿用发布时的口径（典型工作日）
        if (g.macro && CM.Macro && CM.Macro.rebaseTE) { try { CM.Macro.rebaseTE(g); } catch (e) { console.error(e); } }
        g.logEvent({ tag: '版本', title: '交通模型升级（v' + CFG.GAME_VERSION + '）', desc: '存档来自 v' + g.traffic.from + '。日常交通改为轻量增量更新，重大变化增加计算，交通任务接近奖惩门槛时复核。旧拥堵目标按可替代需求调整，无法改善时不处罚；原有线网、资金、债务和已结算历史保留，升级当月保护满意度与任务。' });
        g.backupFailed = s.__backupFailed || null;
        g.upgradeNote = (s.__backupFailed ? '存档已在内存中升级到 v' + CFG.GAME_VERSION + ' 交通模型；升级前备份未能建立（' + s.__backupFailed + '），不会自动保存，原存档保持不变' :
          '存档已升级到 v' + CFG.GAME_VERSION + ' 交通模型（升级前的原存档已另存为「升级前备份」，可在存档列表中载入或导出）') + (s.__mapMigratedFrom ? '；地图范围同时扩展' : '');
      } else g.traffic = Object.assign({ v: CFG.TRAFFIC_MODEL }, s.traffic);
      if (s.mapUpgrade && !s.mapUpgrade.displayOnly) g.traffic.until = Math.max(g.traffic.until || 0, g.ym() + 1);
      if (rulesUpgrade) {
        g.backupFailed = s.__backupFailed || null;
        g.traffic.until = Math.max(g.traffic.until || 0, g.ym() + 1);
        g.upgradeNote = (g.upgradeNote ? g.upgradeNote + '；' : '') + '经营与任务规则已更新，旧票制、线网及历史账目保留' +
          (g.backupFailed ? '；升级前备份未能建立，不会自动保存，原存档保持不变' : (s.__backupSlot ? '（原存档已另存为升级前备份）' : ''));
        g.logEvent({ tag: '版本', title: '经营与建设功能更新', desc: (s.mapUpgrade && !s.mapUpgrade.displayOnly ? '地图范围同时扩展，' : '') + '保留原票制、站线、资金、债务、任务与已结算历史；更新后的规则只影响未来经营与任务评估，升级当月提供任务与满意度保护。' });
      }
      if ((s.city.terrainRevision || 1) < (D.terrainRevision || 1)) {
        const correction = D.terrainCorrection || {};
        g.backupFailed = s.__backupFailed || null;
        g.upgradeNote = (g.upgradeNote ? g.upgradeNote + '；' : '') + (correction.summary || '历史海岸线已校正，原有车站和线路保留') +
          (g.backupFailed ? '；升级前备份未能建立（' + g.backupFailed + '），不会自动保存，原存档保持不变' : (s.__backupSlot ? '（原存档已另存为升级前备份）' : ''));
        g.logEvent({ tag: '版本', title: correction.title || '历史海岸线校正', desc: correction.desc || '在原地图范围内更新填海与机场边界，按存档年份修正水陆用地；保留原有车站、线路、资金、债务及已结算的历史记录。' });
      }
      if ((s.city.displayRevision || 1) < (D.displayRevision || 1)) {
        g.backupFailed = s.__backupFailed || null;
        g.upgradeNote = (g.upgradeNote ? g.upgradeNote + '；' : '') + '地图展示已调整，原有线网与经营进度保留' +
          (g.backupFailed ? '；升级前备份未能建立，不会自动保存，原存档保持不变' : (s.__backupSlot ? '（原存档已另存为升级前备份）' : ''));
        g.logEvent({ tag: '版本', title: '地图展示调整', desc: '相关片区按当前地图与存档年份恢复为城市发展用地；保留原有车站、线路、资金、债务及已结算历史。' });
      }
      if (kept) {
        g.logEvent({ tag: '版本', title: '已有车站所在区域保持开放', desc: kept + '。已有车站及旧任务所在的区域和连片保留建设权限。' });
        g.upgradeNote = (g.upgradeNote ? g.upgradeNote + '；' : '') + '已有车站与任务所在的区域保持开放：' + kept;
      }
      if (airportOpened) g.logEvent({ tag: '规则', title: '新区域开放：' + airportOpened.name, desc: (D.airport.name || '机场') + '照常运营，用地不开发；范围内可以地下设站与地下穿越（v1.9 起）。' });
      complete = true;
      return g;
    } finally {
      // 取消或载入出错后，尚未发出的后台任务不再继续占用线程。
      if (!complete && g.model) { g.model.retired = true; g.model.cancelPredict(); if (CM.CarPool) CM.CarPool.pump(); if (CM.OdPool) CM.OdPool.pump(); }
    }
  };
  Game.prototype.peakSlowNow = function (minute) {
    if (!CM.Settings || !CM.Settings.get('peakSlow') || !(this.speed > 1) || this.dayType() !== 'wd') return false;
    const m = minute == null ? this.clock.minute : minute;
    return CFG.time.peaks.some(function (p) { return m >= p[0] && m < p[1]; });
  };

  Game.prototype.clockRate = function (minute) {
    const base = CFG.time.speeds[this.speed - 1] || 0, m = minute == null ? this.clock.minute : minute;
    if (m < 360 && (!CM.Settings || CM.Settings.get('nightFast') !== false)) return base * CFG.time.nightFast;
    return this.peakSlowNow(m) ? 1 : base;
  };

  Game.prototype.visualRate = function () {
    if (!(this.speed > 0) || this.jumping) return 0;
    return this.peakSlowNow() ? 1 : Math.min(CFG.time.speeds[this.speed - 1], CFG.time.visualMaxSpeed);
  };

  Game.prototype.advanceClock = function (dt) {
    let left = dt;
    for (let guard = 0; guard < 8 && left > 1e-9; guard++) {
      const m = this.clock.minute, rate = this.clockRate(m);
      if (!(rate > 0)) return;
      let edge = m < 360 ? 360 : 1440;
      for (const p of CFG.time.peaks) { if (m < p[0] && p[0] < edge) edge = p[0]; else if (m >= p[0] && m < p[1] && p[1] < edge) edge = p[1]; }
      const perSec = rate / CFG.time.secPerHour * 60, need = (edge - m) / perSec;
      if (left < need) { this.clock.minute = m + left * perSec; return; }
      left -= need;
      this.clock.minute = edge;
      if (edge >= 1440) {
        this.clock.minute = 0;
        if (this.endDay()) { this.pending = this.monthGen(); return; }
      }
    }
  };

})(window.CM);
