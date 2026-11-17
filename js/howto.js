'use strict';
// 任务「怎么做」（v2.9 玩家反馈：按钮只会跳到笼统的新手指南，看不出这一条任务到底该干什么）：
// 按任务的判定条件与当前城市状况，生成「做什么 · 在哪里 · 按什么顺序」的操作步骤，每一步都带能直接点的入口
//（建站、绘线、确认建设、切图层、定位、打开列车运营、改票价、车站商业开发…与手动操作完全等价）。
// 输出结构：{ title, sections: [{ key, label, core, text, ok, order, steps: [{ icon, what, where, acts, en }] }], notes, notesEn, guide }
// guide 是「新手指南」里对应的一节，作为兜底；数字、地名与差距全部取自本局当前数据，模型尚未算完时降级为空。
// 每一步另带一句英文（en，含「在哪里」），英文界面直接用它，避免动态数字与地名被逐词替换成破碎的英文。
(function (CM) {
  const U = CM.U, CFG = CM.CFG;

  // ---------------- 文本小工具 ----------------
  const pct = function (v, d) { return U.fmtPct(isFinite(v) ? v : 0, d == null ? 1 : d); };
  const num = function (v, d) { return U.fmtNum(isFinite(v) ? v : 0, d == null ? 1 : d); };
  const km = function (cells) { return num(cells * CFG.CELL_M / 1000, 1) + ' km'; };
  const keyHint = function (id) { const k = CM.Keys && CM.Keys.hint(id); return k ? '（' + k + '）' : ''; };
  const keyEn = function (id) { const k = CM.Keys && CM.Keys.hint(id); return k ? ' (' + k + ')' : ''; };
  const list = function (names) { return names.join('、'); };
  const listEn = function (names) { return names.join(', '); };

  // 一步：icon 图标 / what 做什么 / where 在哪里做 / acts 能直接点的操作 / en 英文（含位置，供英文界面使用）
  const S = function (icon, what, where, acts, en) { return { icon: icon, what: what, where: where || '', acts: acts ? [].concat(acts).filter(Boolean) : [], en: en || '' }; };
  const A = function (label, icon, run) { return { label: label, icon: icon, run: run, en: label }; };
  // 动作按钮的英文标签（英文界面用）
  const EN = function (a, en) { a.en = en; return a; };

  // ---------------- 可以点的入口（走 UI 公开方法，与手动操作等价） ----------------
  const aStation = function () { return A('切到「建站」', 'station', function (ui) { ui.tools.setTool('station'); }); };
  const aLine = function () { return A('切到「绘线」', 'route', function (ui) { ui.tools.setTool('line'); }); };
  const aConfirm = function () { return A('确认建设', 'hammer', function (ui) { ui.confirmDraft(); }); };
  const aLayer = function (id, label, icon) { return A(label, icon, function (ui) { ui.setLayer(id); }); };
  const aLoc = function (name, x, y, r) { return A('定位「' + name + '」', 'locate', function (ui) { ui.locatePoint(x, y, name, r || 1.5); }); };
  const aZone = function (z, label) { return A('定位片区', 'locate', function (ui) { ui.locateZone(z, label); }); };
  // 任务里的片区是一个名字、可能对应多个区域（如「荃湾与沙田新市镇」）：一起高亮并框住
  const aArea = function (t) { return t && t.regions && t.regions.length ? A('定位片区', 'locate', function (ui) { ui.locateAreas(t.regions, t.areaName); }) : null; };
  const aStationPage = function (sid, tab) {
    return A('打开车站', 'station', function (ui) {
      if (tab) { ui._tab = ui._tab || {}; ui._tab.station = tab; }
      ui.select({ kind: 'station', id: sid });
    });
  };
  const aFacility = function (fid) { return A('打开设施详情', 'pin', function (ui) { ui.select({ kind: 'facility', id: fid }); }); };
  // 地图外设施（机场等）：线路要修到地图边缘线上的接驳口才算接通，定位也定位到接驳口而不是机场名所在的位置
  const aGate = function (f) { return A('定位接驳口', 'locate', function (ui) { ui.locateFacility(f); }); };
  const aOps = function (lid) { return A('列车运营', 'train', function (ui) { ui.openObj('line', lid, 'ops'); }); };
  const aLinePage = function (lid) { return A('打开线路', 'route', function (ui) { ui.openPage('line', lid); }); };
  const aTod = function (sid) {
    return A('车站商业开发', 'bag', function (ui) {
      ui.open = ui.open || {}; ui.open['st-tod'] = true;
      ui._tab = ui._tab || {}; ui._tab.station = 'info';
      ui.select({ kind: 'station', id: sid });
    });
  };
  const aFare = function () {
    return A('调票价', 'ticket', function (ui) {
      ui.open = ui.open || {}; ui.open['fi-fare'] = true; ui.finTab = 'ov';
      ui.openPage('finance', 'ov');
    });
  };
  // 英文界面下按钮也要说英文：统一在渲染时按当前语言取 a.en
  const btnEn = { station: 'Station tool', line: 'Draw line tool', confirm: 'Confirm build', open: 'Open', locate: 'Locate', zone: 'Locate district', ops: 'Train ops', tod: 'Station TOD', fare: 'Fare', layer: 'Layer' };

  // ---------------- 取数（模型可能还没算完，一律降级） ----------------
  const accOf = function (g) { const m = g && g.model; return m && m.net ? m.net.acc : null; };
  const compOf = function (g) { return (g && g.compiled) || null; };
  // 离某点最近的运营车站（含距离，单位格）
  const nearStation = function (g, x, y) {
    const c = compOf(g); if (!c || !c.stations) return null;
    let best = null;
    for (let i = 0; i < c.stations.length; i++) {
      if (!c.serviced[i]) continue;
      const s = c.stations[i], d = U.dist(s.x, s.y, x, y);
      if (!best || d < best.d) best = { s: s, d: d, i: i };
    }
    return best;
  };
  // 锚点处半径内有没有运营车站
  const anchorHit = function (g, a) {
    const c = compOf(g); if (!c) return false;
    for (let i = 0; i < c.stations.length; i++) { const s = c.stations[i]; if (c.serviced[i] && U.dist(s.x, s.y, a.x, a.y) <= a.r) return true; }
    return false;
  };
  // 经过锚点的线路
  const routeOf = function (g, anchors) {
    const T = CM.Tasks; if (!T || !T.routeThrough || !anchors || !anchors.length) return null;
    try { return T.routeThrough(g, anchors); } catch (e) { return null; }
  };
  // 某条线路上最小编组限制的车站
  const tightStation = function (g, lineId) {
    const c = compOf(g); let best = null;
    if (!c) return null;
    for (let i = 0; i < c.stations.length; i++) {
      const s = c.stations[i];
      if (!c.stationLines[i] || !c.stationLines[i].has || !c.stationLines[i].has(lineId)) continue;
      const cap = (CFG.metro.carsBySize || {})[s.size] || 4;
      if (!best || cap < best.cap) best = { s: s, cap: cap };
    }
    return best;
  };
  // 车站该升到哪一档才能把高峰负荷压到目标以下
  const sizeFor = function (peak, target) {
    const sizes = CFG.metro.sizes || ['S', 'M', 'L', 'XL'];
    for (const sz of sizes) if (peak / Math.max(1, CFG.metro.stationCap[sz]) <= target) return sz;
    return sizes[sizes.length - 1];
  };
  const sizeEn = function (sz) { return ({ S: 'Small', M: 'Medium', L: 'Large', XL: 'Extra large' })[sz] || sz; };
  const sizeZh = function (sz) { return (CFG.metro.sizeName || {})[sz] || sz; };

  // ---------------- 各任务类型的步骤 ----------------
  const MAKE = {};

  // ============ 网络连通（历史任务与设施接入都用它） ============
  MAKE.connect = function (t, g, ev) {
    const own = (t.anchors || []).filter(function (a) { return a && isFinite(a.x); });
    if (!own.length) return { icon: 'route', steps: [S('info', '这条任务没有可以定位的地点，按任务说明修好线路即可。', '', null, 'This task has no place to locate — just build the line described in the task.')] };
    const hit = own.map(function (a) { return anchorHit(g, a); });
    const miss = own.filter(function (a, i) { return !hit[i]; });
    const marks = own.map(function (a, i) { return (hit[i] ? '✓ ' : '✗ ') + a.name; });
    const steps = [];
    steps.push(S('target', '先核对目标：' + marks.join('、') + (miss.length ? '，还差 ' + miss.length + ' 处' : '，各处都已有车站'),
      '任务卡「目标与进度」里点地名也能直接定位',
      own.slice(0, 5).map(function (a) { return aLoc(a.name, a.x, a.y, a.r || 2); }),
      'Check the targets: ' + marks.join(', ') + (miss.length ? ' — ' + miss.length + ' still missing.' : ' — every place already has a station.')));
    if (miss.length) {
      steps.push(S('station', '在还缺车站的 ' + miss.length + ' 处（' + list(miss.map(function (a) { return a.name; })) + '）圆圈半径约 ' + Math.round((miss[0].r || 3) * CFG.CELL_M) + ' m 内各建一座车站',
        '底部工具坞「建站」' + keyHint('tool.station') + '：点圆圈内的空地；红色冲突处不能建，换个位置',
        [aStation()].concat(miss.slice(0, 4).map(function (a) { return aLoc(a.name, a.x, a.y, a.r || 2); })),
        'Build a station within about ' + Math.round((miss[0].r || 3) * CFG.CELL_M) + ' m of each of the ' + miss.length + ' missing places (' + listEn(miss.map(function (a) { return a.name; })) + '). Bottom toolbar → Station' + keyEn('tool.station') + '; click open ground inside the circle. Red conflicts cannot be built on.'));
    }
    steps.push(S('route', miss.length ? '用「绘线」把这些车站连进现有线网：一条线走完最省事，中途换乘也算连通' : '车站都有了，缺的是连接：用「绘线」把它们接到同一条线或能换乘的线路上',
      '底部工具坞「绘线」' + keyHint('tool.line') + '：从一处车站拖到另一处，Shift + 点击可加转弯点',
      [aLine()],
      miss.length ? 'Connect these stations to the existing network with Draw line: one line all the way is simplest, and a transfer also counts. Bottom toolbar → Draw line' + keyEn('tool.line') + '.'
        : 'The stations exist but are not linked: use Draw line to put them on one line, or on lines that connect to each other. Bottom toolbar → Draw line' + keyEn('tool.line') + '.'));
    steps.push(S('info', '注意：只有车站、没有线路经过不算连通（车站上要有线路运营）', '车站详情里「经过线路」为空就说明还没接上', null,
      'A station with no line through it does not count — the station details will show no lines if it is not connected yet.'));
    steps.push(S('hammer', '没有红色冲突后确认建设，新线立刻投入运营', '屏幕底部草案栏右侧「确认建设」' + keyHint('build.confirm'), [aConfirm()],
      'When there are no red conflicts, confirm the build — the new line starts running at once. Confirm build sits at the right of the draft bar at the bottom' + keyEn('build.confirm') + '.'));
    steps.push(S('check', '回到本页看目标逐处变成 ✓；任务在每月初结算', '', null,
      'Come back to this page and watch each target turn ✓. Tasks settle at the start of each month.'));
    return { icon: 'route', order: miss.length ? '定位 → 建站 → 接线 → 确认建设' : '接线 → 确认建设', steps: steps,
      notes: t.avoid ? ['这条任务不能经过「' + t.avoid.name + '」一带：绕开它连通才有效。'] : [],
      notesEn: t.avoid ? ['This task must not pass through ' + t.avoid.name + ': connect around it.'] : [] };
  };
  MAKE.budgetConnect = function (t, g, ev) {
    const r = MAKE.connect(t, g, ev), spent = Math.max(0, ((g.econ && g.econ.built) || 0) - (t.spent0 || 0));
    r.steps.splice(Math.max(1, r.steps.length - 2), 0, S('wallet', '盯住造价：已花 ' + U.fmtMoney(spent) + '，预算 ' + U.fmtMoney(t.budget) + '，超出即判失败',
      '草案栏会实时显示本次花费；高架、地面比地下便宜，取直、少设站也能省', [aConfirm()],
      'Watch the cost: ' + U.fmtMoney(spent) + ' spent of a ' + U.fmtMoney(t.budget) + ' budget — going over fails the task. The draft bar shows the running cost; elevated and surface track are cheaper than underground, and straight routes with fewer stations save more.'));
    r.order = '定位 → 建站（省着建）→ 接线 → 核对预算 → 确认建设';
    return r;
  };

  // ============ 覆盖类 ============
  const coverSteps = function (t, g, ev, zoneMode) {
    const a = accOf(g), cov = zoneMode ? (a ? a.zCov[t.zone] : 0) : (a ? a.coverage : 0);
    const target = t.target || 0.5, steps = [];
    if (zoneMode) {
      steps.push(S('map', '先定位「' + g.zoneName(t.zone) + '」片区，看它的人口与现状覆盖（目前 ' + pct(cov, 0) + '，目标 ' + pct(target, 0) + '）',
        '地图会自动移到片区范围', [aZone(t.zone)],
        'Start by locating ' + g.zoneName(t.zone) + ': coverage is ' + pct(cov, 0) + ' now, target ' + pct(target, 0) + '. The map will frame the district.'));
    }
    steps.push(S('lyCover', '打开「地铁覆盖」图层：绿色是步行 15 分钟内能到车站的范围，灰色是要补的空洞',
      '左下角「图层」→ 地铁 →「地铁覆盖」', [aLayer('cover', '覆盖图层', 'lyCover')],
      'Open the Coverage layer: green is within a 15-minute walk of a station, grey is the gap to fill. Bottom-left Layers → Metro → Coverage.'));
    steps.push(S('lyPop', '找人口最密、又还没被绿色覆盖的地方', '左下角「图层」→ 城市 →「人口密度」', [aLayer('pop', '人口密度图层', 'lyPop')],
      'Find the densest places still outside the green area. Bottom-left Layers → City → Population density.'));
    steps.push(S('station', '在那里建站（每站覆盖半径约 750 m，站距 1 km 左右最划算）', '底部工具坞「建站」' + keyHint('tool.station'), [aStation()],
      'Build stations there — each covers roughly 750 m, and spacing of about 1 km gives the most coverage per unit of cost. Bottom toolbar → Station' + keyEn('tool.station') + '.'));
    steps.push(S('route', '把新站接进线网：覆盖只算「有线路经过的车站」，只建站不接线不计', '底部工具坞「绘线」' + keyHint('tool.line'), [aLine()],
      'Link the new stations into the network: coverage only counts stations with a line through them — a station alone does not help. Bottom toolbar → Draw line' + keyEn('tool.line') + '.'));
    steps.push(S('hammer', '确认建设', '屏幕底部草案栏右侧「确认建设」' + keyHint('build.confirm'), [aConfirm()],
      'Confirm the build — right side of the draft bar at the bottom' + keyEn('build.confirm') + '.'));
    steps.push(S('info', '步行按实际道路计算：隔着河、铁路或没有路的地方要绕行，必要时在对面补一站', '覆盖图层的灰色缝隙就是走不到的地方', null,
      'Walking follows real roads: rivers, railways and missing paths force detours, so add a station on the other side when needed. The grey seams in the coverage layer are exactly those spots.'));
    return { icon: 'target', order: '看图层 → 建站 → 接线 → 确认建设', steps: steps };
  };
  MAKE.coverage = function (t, g, ev) { return coverSteps(t, g, ev, false); };
  MAKE.zoneCov = function (t, g, ev) { return coverSteps(t, g, ev, true); };
  MAKE.regionCov = function (t, g, ev) {
    const a = accOf(g), cov = a && t.regions ? (function () {
      try { return CM.Tasks.regionCoverage(g, t.regions); } catch (e) { return 0; }
    })() : 0;
    const r = coverSteps(t, g, ev, false);
    r.steps.unshift(S('map', '目标片区：' + (t.areaName || '指定片区') + '，目前 ' + pct(cov, 0) + ' 的人口能步行到车站，目标 ' + pct(t.target || 0, 0),
      '点下面的按钮直接定位', [aArea(t)],
      'Target district: ' + (t.areaName || 'the district named in the task') + ' — ' + pct(cov, 0) + ' of residents can walk to a station, target ' + pct(t.target || 0, 0) + '. Use the button below to jump there.'));
    return r;
  };

  // ============ 缓解拥堵（早高峰汽车出行占比 / 拥堵指数） ============
  MAKE.zoneCong = function (t, g, ev) {
    const z = t.zone, name = g.zoneName(z), a = accOf(g), cov = a ? a.zCov[z] : 0;
    const near = (function () {
      try { const m = g.model; return nearStation(g, m.zCx[z], m.zCy[z]); } catch (e) { return null; }
    })();
    const steps = [];
    steps.push(S('map', '先定位「' + name + '」片区，看它现在的状况：' + (ev && ev.text ? ev.text : '查看任务进度'),
      '地图会自动框住这个片区', [aZone(z)],
      'Locate ' + name + ' and check where it stands' + (ev && ev.text ? '' : ' on the task card') + '. The map will frame the district.'));
    steps.push(S('lyCong', '打开「道路拥堵」图层，找早高峰最红的那几条路', '左下角「图层」→ 交通 →「道路拥堵」',
      [A('拥堵图层', 'lyCong', function (ui) { ui.R.layerOpt.cong = 'am'; ui.setLayer('cong'); })],
      'Open the Road congestion layer and find the reddest roads in the morning peak. Bottom-left Layers → Traffic → Road congestion.'));
    steps.push(S('lyFlow', '再打开「出行方向」：这些车主要开去哪里？线路要顺着这个方向修才有用', '左下角「图层」→ 交通 →「出行方向」',
      [aLayer('flow', '出行方向图层', 'lyFlow')],
      'Then open Travel direction: where are these cars going? A line has to follow that direction to help. Bottom-left Layers → Traffic → Travel direction.'));
    if (cov < 0.7) {
      steps.push(S('station', '片区里只有 ' + pct(cov, 0) + ' 的范围能步行到车站——先在人口最密处补站' + (near ? '（最近的运营车站「' + near.s.name + '」离片区中心约 ' + km(near.d) + '）' : '（片区附近还没有运营车站）'),
        '底部工具坞「建站」' + keyHint('tool.station'), [aStation(), aZone(z)],
        'Only ' + pct(cov, 0) + ' of the district is within walking reach of a station — add stations where people are densest' + (near ? ' (the nearest open station, ' + near.s.name + ', is about ' + km(near.d) + ' away)' : ' (no station operates near this district yet)') + '. Bottom toolbar → Station' + keyEn('tool.station') + '.'));
    } else {
      steps.push(S('station', '片区覆盖已有 ' + pct(cov, 0) + '，问题多半不在地上而在线路上：往下看接线与班次', '', null,
        'Coverage is already ' + pct(cov, 0) + ', so the problem is probably the line rather than access — see the connection and frequency steps below.'));
    }
    steps.push(S('route', '把线接到居民真正要去的地方（多半是市中心或就业区），一条线直达最容易把人从车上拉下来；换乘越多越不如开车',
      '底部工具坞「绘线」' + keyHint('tool.line') + '：可连到已有车站换乘', [aLine()],
      'Run the line where residents actually go — usually the centre or the job districts. A one-seat ride is what pulls people out of cars; each extra transfer makes driving look better. Bottom toolbar → Draw line' + keyEn('tool.line') + '.'));
    steps.push(S('train', '线路已经通了但占比不降：多半是等车久或太挤。打开线路的「列车运营」加密班次、加编组',
      '线路详情 →「列车运营」：发车间隔、投入列车与编组',
      (function () { const L = g.net && g.net.lines ? Object.keys(g.net.lines) : []; return L.length ? [aOps(L[0])] : []; })(),
      'If the line already runs and the share still will not move, waiting or crowding is the cause: open Train operations and run more trains or longer ones. Line details → Train operations.'));
    steps.push(S('ticket', '别用降价凑指标：票价低于任务发布时的月份不计入样本，连续月数也会断', '财政 → 概览 → 票价', [aFare()],
      'Do not cut fares to game the metric: months with a fare below the level at issue are excluded, and the consecutive streak resets. Finance → Overview → Fare.'));
    steps.push(S('calMonth', '这个指标按最近 3 个月平均：改完要等 2–3 个月才在数字上体现，别在最后一个月才动手', '任务卡上的「已有 N 个月记录」就是进度', null,
      'The metric is a 3-month average, so changes take 2–3 months to show — do not wait until the final month. The "N months recorded" line on the task card is the progress.'));
    return { icon: 'car', order: '定位片区 → 看拥堵与出行方向 → 补覆盖 → 接线 → 加运力 → 确认建设 → 等 3 个月',
      steps: steps, notes: ['记录满 3 个月才开始结算；中间任何一个月不达标都会重新计数。'],
      notesEn: ['Settlement starts once 3 months are recorded; any month below target restarts the count.'] };
  };

  // ============ 车站拥挤 ============
  MAKE.stationCrowd = function (t, g, ev) {
    const c = compOf(g), i = c && c.sIndex ? c.sIndex.get(t.station) : undefined, st = i === undefined ? null : c.stations[i];
    const cap = st ? CFG.metro.stationCap[st.size] : 0, peak = st ? (function () {
      const sd = g.model.stDailyWk || g.model.stDaily;
      return sd && sd.peak ? sd.peak[i] || 0 : 0;
    })() : 0;
    const need = peak > 0 ? sizeFor(peak, t.target || 0.9) : null;
    const steps = [];
    steps.push(S('locate', st ? '先看清「' + st.name + '」有多挤：' + (ev && ev.text ? ev.text : '当前高峰负荷') : '先在地图上找到这座车站',
      '任务卡上的站名按钮也能定位', st ? [aStationPage(t.station, 'info')] : [],
      st ? 'See how crowded ' + st.name + ' is' + (ev && ev.text ? '' : '') + '. The station name on the task card also locates it.' : 'Find the station on the map first.'));
    steps.push(S('lyStation', '打开「车站客流」图层，确认是这一座挤，还是整条线都挤', '左下角「图层」→ 地铁 →「车站客流」',
      [A('车站客流图层', 'lyStation', function (ui) { ui.R.layerOpt.stView = 'load'; ui.setLayer('station'); })],
      'Open the Station load layer to see whether one station is tight or the whole line is. Bottom-left Layers → Metro → Station load.'));
    if (st) {
      steps.push(S('hammer', '扩建车站：当前' + sizeZh(st.size) + '（' + U.fmtPeople(cap) + ' 人/小时）' +
        (need && CFG.metro.sizes.indexOf(need) > CFG.metro.sizes.indexOf(st.size) ? '，升到' + sizeZh(need) + '就够把负荷压到 ' + pct(t.target || 0.9, 0) + ' 以内' : '，已经是最大一档，只能靠分流'),
        '车站详情 →「建设」→ 车站规模（改完记得确认建设）', [aStationPage(t.station, 'build')],
        'Enlarge the station: it is ' + sizeEn(st.size) + ' (' + U.fmtPeople(cap) + ' people/hour)' + (need && CFG.metro.sizes.indexOf(need) > CFG.metro.sizes.indexOf(st.size) ? ', and ' + sizeEn(need) + ' is enough to bring the load under ' + pct(t.target || 0.9, 0) : ' — already the largest size, so share the load instead') + '. Station details → Build → Station size, then confirm the build.'));
    }
    steps.push(S('route', '若已是超大型仍不够：把经过这里的一条线改到附近另一座车站，或修平行线分流', '「绘线」里改接另一座车站，也可以新建一座站外换乘站', [aLine()],
      'If it is already extra large and still tight, reroute one of its lines to a nearby station, or build a parallel line to take the load. Use Draw line, or add a station linked by an out-of-station transfer.'));
    steps.push(S('hammer', '确认建设后看高峰负荷是否降到目标以下', '草案栏「确认建设」' + keyHint('build.confirm'), [aConfirm()],
      'Confirm the build, then check that the peak load falls below the target. Draft bar → Confirm build' + keyEn('build.confirm') + '.'));
    return { icon: 'people', order: '定位 → 看负荷 → 扩建车站 → 确认建设', steps: steps,
      notes: ['统计口径是工作日高峰小时；扩建当月就会生效，不必等下个月。'],
      notesEn: ['Measured in the weekday peak hour; the enlargement takes effect the same month — no need to wait.'] };
  };

  // ============ 线路满载率（最挤区段 / 全网） ============
  const loadSteps = function (t, g, ev, lineId) {
    const T = CM.Tasks, lf = lineId && T && T.crowdOf ? (T.crowdOf(g).find(function (x) { return x.lid === lineId; }) || null) : null;
    const tgt = t.target || 0.85, need = lf ? lf.lf / Math.max(0.01, tgt) : 0;
    const L = lineId && g.net && g.net.lines ? g.net.lines[lineId] : null;
    const routes = lineId && compOf(g) ? compOf(g).routes.filter(function (r) { return r.lineId === lineId; }) : [];
    const cars = routes.length ? Math.min.apply(null, routes.map(function (r) { return r.cars; })) : 0;
    const steps = [];
    steps.push(S('train', L ? '先看「' + L.name + '」的运力：编组 ' + (cars || '—') + ' 节，最挤区段满载率 ' + (lf ? pct(lf.lf, 0) : '—') + '，目标 ' + pct(tgt, 0) +
      (need > 1 ? '，运力要提高约 ' + Math.round((need - 1) * 100) + '%' : '') : '先找到最挤的那条线',
      '线路详情 →「列车运营」：编组、发车间隔与投入列车', L ? [aOps(lineId), aLinePage(lineId)] : [],
      L ? 'Check capacity on ' + L.name + ': ' + (cars || '—') + ' cars, the busiest section runs at ' + (lf ? pct(lf.lf, 0) : '—') + ' against a ' + pct(tgt, 0) + ' target' + (need > 1 ? ' — capacity needs to rise by about ' + Math.round((need - 1) * 100) + '%' : '') + '. Line details → Train operations.'
        : 'Find the busiest line first.'));
    steps.push(S('station', '加编组：8 节封顶，而且受沿线最小车站限制——先看哪座车站的站台最短', '车站详情 →「建设」→ 车站规模；超大型/大型才放得下 8 节',
      (function () { const tight = lineId ? tightStation(g, lineId) : null; return tight ? [aStationPage(tight.s.id, 'build')] : []; })(),
      'Add cars: 8 is the maximum, and the shortest platform on the line sets the limit — check which station is the tightest. Station details → Build → Station size; only Large and Extra large fit 8 cars.'));
    steps.push(S('train', '加密班次：缩短发车间隔（最短 2 分钟）、把闲置列车投到早高峰', '列车运营里的「发车频率」与「投入列车」', null,
      'Run more trains: shorten the headway (2 minutes is the floor) and put idle trains into the morning peak. Use the frequency and fleet settings in Train operations.'));
    steps.push(S('route', '编组与班次都到顶还挤：修平行线，或让另一条线分担这一段的客流', '底部工具坞「绘线」', [aLine()],
      'If cars and frequency are both maxed out, build a parallel line or let another line take part of this section. Bottom toolbar → Draw line.'));
    steps.push(S('lyStation', '改完打开「车站客流」图层看断面是否降下来', '左下角「图层」→ 地铁 →「车站客流」', [aLayer('station', '车站客流图层', 'lyStation')],
      'Afterwards open the Station load layer to see whether the section load has come down. Bottom-left Layers → Metro → Station load.'));
    return { icon: 'people', order: '看运力 → 加编组 → 加密班次 → 不行再分流', steps: steps };
  };
  MAKE.lineCrowd = function (t, g, ev) { return loadSteps(t, g, ev, t.line); };
  MAKE.lineLoad = function (t, g, ev) { const rt = routeOf(g, t.anchors); return loadSteps(t, g, ev, rt && rt.all ? rt.route.lineId : null); };
  MAKE.netLoad = function (t, g, ev) {
    const T = CM.Tasks, top = T && T.crowdOf ? T.crowdOf(g)[0] : null;
    return loadSteps(t, g, ev, top ? top.lid : null);
  };

  // ============ 列车编组 ============
  MAKE.lineCars = function (t, g, ev) {
    const rt = routeOf(g, t.anchors), lid = rt && rt.all ? rt.route.lineId : (t.line || null);
    const tight = lid ? tightStation(g, lid) : null;
    const goal = t.max ? '不超过 ' + t.max + ' 节' : '不少于 ' + t.min + ' 节';
    const goalEn = t.max ? 'at most ' + t.max + ' cars' : 'at least ' + t.min + ' cars';
    const steps = [];
    steps.push(S('train', '目标：这条线的列车编组' + goal + '。编组上限由沿线最短的站台决定（小型 4 节、中型 6 节、大型与超大型 8 节）',
      '线路详情 →「列车运营」看当前编组', lid ? [aOps(lid)] : [],
      'Goal: train length ' + goalEn + '. The maximum is set by the shortest platform on the line (Small 4, Medium 6, Large and Extra large 8 cars). See the current length in Line details → Train operations.'));
    if (tight) steps.push(S('station', '沿线最紧的是「' + tight.s.name + '」（' + sizeZh(tight.s.size) + '，最多 ' + tight.cap + ' 节）：先把它扩建',
      '车站详情 →「建设」→ 车站规模', [aStationPage(tight.s.id, 'build')],
      'The tightest station is ' + tight.s.name + ' (' + sizeEn(tight.s.size) + ', up to ' + tight.cap + ' cars) — enlarge it first. Station details → Build → Station size.'));
    steps.push(S('hammer', '确认建设，再回到列车运营把编组调到位', '草案栏「确认建设」' + keyHint('build.confirm'), [aConfirm()],
      'Confirm the build, then set the train length in Train operations. Draft bar → Confirm build' + keyEn('build.confirm') + '.'));
    steps.push(S('info', '编组加大后车厢更多、运力更高，但每公里成本也上升，注意票价与满载率别一起失控', '', null,
      'Longer trains carry more but cost more per kilometre — keep an eye on fares and load factors.'));
    return { icon: 'train', order: '看编组 → 扩站台 → 调编组', steps: steps };
  };

  // ============ 客流增长 ============
  MAKE.ridership = function (t, g, ev) {
    const d = g.model && g.model.daily, cur = d ? d.metro : 0, gap = Math.max(0, (t.target || 0) - cur);
    const steps = [];
    steps.push(S('lyPop', '先看差多少：' + (ev && ev.text ? ev.text : '当前客流') + (gap > 0 ? '，还差约 ' + U.fmtPeople(gap) + ' 人次/日' : ''),
      '点下面的按钮打开人口密度图层', [aLayer('pop', '人口密度图层', 'lyPop')],
      'Check the gap' + (gap > 0 ? ': about ' + U.fmtPeople(gap) + ' more rides per day are needed' : '') + '. The button opens the population density layer.'));
    steps.push(S('lyCover', '在人口多、还没有地铁的片区找机会：一片几万人的居住区接一条线，客流就上来了', '左下角「图层」→ 地铁 →「地铁覆盖」',
      [aLayer('cover', '覆盖图层', 'lyCover')],
      'Look for dense districts without metro: connecting a residential area of tens of thousands brings ridership quickly. Bottom-left Layers → Metro → Coverage.'));
    steps.push(S('station', '延伸既有线或修新线接进去：建站 → 绘线 → 确认建设', '底部工具坞「建站」「绘线」', [aStation(), aLine()],
      'Extend an existing line or build a new one into it: Station → Draw line → Confirm build (bottom toolbar).'));
    steps.push(S('train', '已有线网也能挖潜：加密班次、减少换乘，等车短了、直达多了，原本开车的人会转过来', '线路详情 →「列车运营」', null,
      'The existing network can still grow: run more trains and cut transfers — shorter waits and one-seat rides win drivers over. Line details → Train operations.'));
    steps.push(S('ticket', '票价过高会压客流：先看「票务收入与满意度影响」里的预估再动', '财政 → 概览 → 票价', [aFare()],
      'High fares hold ridership down: check the estimate under fare revenue and satisfaction before changing anything. Finance → Overview → Fare.'));
    return { icon: 'train', order: '看缺口 → 补覆盖 → 建站接线 → 加密班次 → 确认建设', steps: steps };
  };

  // ============ 设施接驳比例 ============
  MAKE.facShare = function (t, g, ev) {
    const f = CM.Fac && CM.Fac.byId ? CM.Fac.byId(t.fac) : null;
    const gate = f && f.ext && CM.Fac.portal ? CM.Fac.portal(f) : null;
    const near = f && !gate ? nearStation(g, f.x, f.y) : null;
    const nmEn = f && CM.I18n ? CM.I18n.text(f.name) : (f ? f.name : '');
    // 英文那句里的比例直接取数（ev.text 是中文拼出来的，塞进英文会中英混排）
    const shareNow = f && CM.Tasks && CM.Tasks.facShareOf ? (function () {
      try { const r = CM.Tasks.facShareOf(g.model, f, t.basis); return r ? r.share : null; } catch (e) { return null; }
    })() : null;
    const steps = [];
    steps.push(S('pin', f ? '先看「' + f.name + '」的接驳情况：' + (ev && ev.text ? ev.text : '当前乘地铁比例') : '先打开设施详情',
      gate ? '设施详情里写着它在地图外多远、接驳口在哪个方向' : '设施详情里的「附近地铁站与接驳」会列出步行时间', f ? [aFacility(f.id), gate ? aGate(f) : null] : [],
      f ? 'Check access at ' + nmEn + ': ' + (shareNow != null ? pct(shareNow, 0) + ' of trips use metro.' : 'see the current metro share on the facility page.') +
        (gate ? ' The details give the distance outside the map and the direction of the boundary connection.' : ' The facility details list walking times under nearby stations and access.') : 'Open the facility details first.'));
    if (gate) {
      // 地图外的机场：地图上只有边缘线上的接驳口能建站接通（在机场名附近建站走不到，也不计接通）
      const et = CM.Fac.extText(f), shortEn = CM.I18n ? CM.I18n.text(CM.Fac.shortName(f)) : CM.Fac.shortName(f);
      const dirEn = { N: 'north', S: 'south', E: 'east', W: 'west', NE: 'north-east', NW: 'north-west', SE: 'south-east', SW: 'south-west' }[f.ext.dir] || '';
      steps.push(S('station', '「' + CM.Fac.shortName(f) + '」' + et + '，图上只有地图边缘线上的接驳口：用「绘线」或「建站」把线路修到那个虚线圆（靠近会自动吸附到边缘线），出现双向箭头即接通',
        '点下面的按钮直接定位到接驳口；地图外的提示卡也可以直接点',
        [aGate(f), aStation(), aLine()],
        shortEn + ' is about ' + f.ext.km + ' km beyond the ' + dirEn + ' edge of the map, and the only place to build is the boundary connection on that edge: run a line or build a station at the dashed circle (placement snaps to the edge). Two-way arrows confirm the link. The button below flies to it; the off-map card can be clicked too.'));
    } else {
      steps.push(S('station', near ? '最近的车站「' + near.s.name + '」直线约 ' + km(near.d) + '；步行超过 7 分钟就要在设施 400 m 内补站（越近越好，250 m 内可免费移站）' : '设施附近没有车站：在 400 m 内建站',
        '底部工具坞「建站」' + keyHint('tool.station'), f ? [aStation(), A('定位设施', 'locate', function (ui) { ui.locatePoint(f.x, f.y, f.name, Math.max(0.8, f.r || 1), 3); })] : [aStation()],
        near ? 'The nearest station, ' + near.s.name + ', is about ' + km(near.d) + ' away in a straight line. If the walk is over 7 minutes, add a station within 400 m (closer is better; moving a station up to 250 m is free). Bottom toolbar → Station' + keyEn('tool.station') + '.'
          : 'No station near the facility: build one within 400 m. Bottom toolbar → Station' + keyEn('tool.station') + '.'));
    }
    steps.push(S('route', '把站接进线网，并让主要客源能一条线直达：换乘越多，越多人改开车', '底部工具坞「绘线」' + keyHint('tool.line'), [aLine()],
      'Link the station into the network and give the main catchments a one-seat ride — each transfer pushes more people back to cars. Bottom toolbar → Draw line' + keyEn('tool.line') + '.'));
    steps.push(S('train', '到访量大就升级车站、加密班次，别让乘客等太久', '车站详情 →「建设」；线路 →「列车运营」', null,
      'With high footfall, enlarge the station and run more trains so nobody waits long. Station details → Build; line → Train operations.'));
    steps.push(S('ticket', '票价低于任务发布时的月份不计入样本，别靠降价冲比例', '财政 → 概览 → 票价', [aFare()],
      'Months below the fare level at issue are excluded, so cutting fares will not count. Finance → Overview → Fare.'));
    return { icon: 'pin', order: gate ? '看接驳 → 修到边缘接驳口 → 接线直达 → 提升运力' : '看接驳 → 就近建站 → 接线直达 → 提升运力', steps: steps };
  };

  // ============ 运营收支 ============
  const moneySteps = function (t, g, ev, fiscal) {
    const led = g.econ && g.econ.ledger && g.econ.ledger.length ? g.econ.ledger[g.econ.ledger.length - 1] : null;
    const rev = led && led.ops > 0 ? ((led.fare || 0) + (led.commerce || 0) - (led.todCost || 0)) / led.ops : 0;
    const kmNow = CM.Milestones && CM.Milestones.netInfo ? CM.Milestones.netInfo(g).km : 0;
    const steps = [];
    steps.push(S('chart', '先看账：上月（票款 + 车站商业收入）是运营费用的 ' + pct(rev, 0) + '，目标 ' + pct(t.target || 0, 0) +
      (fiscal && t.kmCap ? '；线网 ' + num(kmNow, 1) + ' km，上限 ' + num(t.kmCap, 1) + ' km（超出即当月不计）' : ''),
      '财政 → 概览里能看到本月收支明细', [aFare()],
      'Read the books: last month fare and station-commerce revenue covered ' + pct(rev, 0) + ' of operating costs, target ' + pct(t.target || 0, 0) +
      (fiscal && t.kmCap ? '; the network is ' + num(kmNow, 1) + ' km against a ' + num(t.kmCap, 1) + ' km cap (going over voids the month)' : '') + '. Finance → Overview has the breakdown.'));
    steps.push(S('ticket', '小步上调票价：看「按新票价估算」，客流降幅小、票款上升就是划算的；涨幅明显高于物价会掉满意度', '财政 → 概览 → 票价 → 应用新票价', [aFare()],
      'Raise fares in small steps: use the estimate under the new fare — a small ridership drop with higher revenue is worth it. A rise well above inflation costs satisfaction. Finance → Overview → Fare → Apply.'));
    steps.push(S('bag', '开发高客流车站的商业（TOD）：客流越大的站，净收益越高', '车站详情 →「商业开发（TOD）」→ 选一档升级', (function () {
      const c = compOf(g), sd = g.model && g.model.stDaily;
      if (!c || !sd || !sd.inn) return [];
      let best = null;
      for (let i = 0; i < c.stations.length; i++) { const v = (sd.inn[i] || 0) + (sd.out[i] || 0) + (sd.xfer[i] || 0); if (!best || v > best.v) best = { s: c.stations[i], v: v }; }
      return best ? [aTod(best.s.id)] : [];
    })(),
      'Develop station commerce (TOD) at the busiest stations: the higher the footfall, the higher the net income. Station details → Station TOD → pick a level.'));
    steps.push(S('train', '把客流做大、摊薄每车公里成本：加密班次、加强接驳、减少换乘', '线路详情 →「列车运营」；覆盖不足处加站', null,
      'Grow ridership to spread the cost per car-kilometre: more trains, better access, fewer transfers. Line details → Train operations; add stations where coverage is thin.'));
    if (fiscal) steps.push(S('info', '别再延长线网：里程超过上限的月份直接判为不达标，宁可先把现有网络的客流做密', '城市统计里能看线网里程', null,
      'Stop extending the network: any month over the length cap fails outright — better to densify the existing network. The city stats show the length.'));
    steps.push(S('calMonth', t.sustain ? '需要连续 ' + t.sustain + ' 个月达标（任务卡上有进度点）' : '按月结算，改完下个月初就能看到新数值', '', null,
      t.sustain ? 'Needs ' + t.sustain + ' consecutive months on target (the task card shows the dots).' : 'Settled monthly — the new figure appears at the start of next month.'));
    return { icon: 'coin', order: '看账 → 调票价 → 开发车站商业 → 做密客流', steps: steps };
  };
  MAKE.recovery = function (t, g, ev) { return moneySteps(t, g, ev, false); };
  MAKE.fiscal = function (t, g, ev) { return moneySteps(t, g, ev, true); };

  // ============ 老线路效率（每公里日客流） ============
  MAKE.lineEff = function (t, g, ev) {
    const L = t.line && g.net && g.net.lines ? g.net.lines[t.line] : null;
    const steps = [];
    steps.push(S('chart', '这个指标是「日客流 ÷ 线路长度」：' + (ev && ev.text ? ev.text : '当前每公里客流') + '，要么把客流做大，要么把线缩短', '线路详情里能看长度与各站客流', L ? [aLinePage(t.line)] : [],
      'This is daily riders divided by line length' + (ev && ev.text ? '' : '') + ': either grow ridership or shorten the line. Line details show the length and station totals.'));
    steps.push(S('station', '沿线补站：在人口与就业密集、但站距过大的地方加站，站距 1 km 左右最能吃到客流', '底部工具坞「建站」' + keyHint('tool.station'), [aStation()],
      'Add stations along the line where housing and jobs are dense but spacing is too wide — about 1 km apart catches the most riders. Bottom toolbar → Station' + keyEn('tool.station') + '.'));
    steps.push(S('train', '加密班次、减少换乘，让沿线的人愿意坐', '线路详情 →「列车运营」', L ? [aOps(t.line)] : [],
      'Run more trains and cut transfers so people along the line choose it. Line details → Train operations.'));
    steps.push(S('bag', '在客流最大的车站做商业开发，站本身也更有吸引力', '车站详情 →「商业开发（TOD）」', null,
      'Develop commerce at the busiest station — it makes the station itself more attractive. Station details → Station TOD.'));
    steps.push(S('info', '末端几站几乎没人上下：拆掉空驶段，分母变小、每公里客流立刻上去', '「拆除」工具可以拆掉指定区段', null,
      'If the last few stops see almost nobody, remove the empty tail: a smaller denominator lifts riders per kilometre at once. The Demolish tool removes the chosen section.'));
    return { icon: 'trend', order: '看现状 → 沿线补站 → 加密 → 裁掉空驶段', steps: steps };
  };

  // ============ 换乘枢纽 ============
  MAKE.xferHub = function (t, g, ev) {
    const c = compOf(g); let n = 0;
    if (c && c.stationLines) c.stationLines.forEach(function (s) { if (s.size >= 2) n++; });
    const steps = [];
    steps.push(S('network', '现在全城有 ' + n + ' 座换乘站（两条及以上线路共站），目标 ' + (t.target || 0) + ' 座', '线路示意图里能一眼看出哪些站有多条线', null,
      'The city has ' + n + ' interchange stations (two or more lines calling at one station), target ' + (t.target || 0) + '. The network map shows them at a glance.'));
    steps.push(S('route', '找两条线路交叉或相邻的位置：绘线时点到已有车站，就建成同一座换乘站', '底部工具坞「绘线」' + keyHint('tool.line') + '：经过已有车站会自动共站', [aLine()],
      'Find where two lines cross or run close: click an existing station while drawing and both lines call there. Bottom toolbar → Draw line' + keyEn('tool.line') + '.'));
    steps.push(S('info', '站外换乘（步行 500 m 内）也算连通，但换乘站要的是同一座车站，注意别只连了两座挨着的站', '', null,
      'An out-of-station transfer within 500 m also connects lines, but an interchange needs one shared station — do not just link two stations standing next to each other.'));
    return { icon: 'network', order: '找交叉点 → 共站 → 确认建设', steps: steps };
  };

  // ---------------- 复合任务的各个分项 ----------------
  MAKE.direct = function (t, g, ev) {
    const rt = routeOf(g, t.anchors);
    const names = (t.anchors || []).map(function (a) { return a.name; });
    const steps = [S('route', '要的是「同一条线直达 ' + list(names) + '」：换乘不算' + (rt && !rt.all && rt.n > 1 ? '，现在只覆盖了 ' + rt.n + ' 处' : ''), '绘线时把这几个地方串在同一条线路上', null,
      'The goal is one line straight through ' + listEn(names) + ' — transfers do not count' + (rt && !rt.all && rt.n > 1 ? '; only ' + rt.n + ' are on it so far' : '') + '. Draw them onto the same line.')];
    const miss = (t.anchors || []).filter(function (a) { return !anchorHit(g, a); });
    if (miss.length) steps.push(S('station', '先把缺站的 ' + miss.length + ' 处（' + list(miss.map(function (a) { return a.name; })) + '）补上', '底部工具坞「建站」', [aStation()].concat(miss.slice(0, 4).map(function (a) { return aLoc(a.name, a.x, a.y, a.r || 2); })),
      'First give the ' + miss.length + ' places without a station (' + listEn(miss.map(function (a) { return a.name; })) + ') one. Bottom toolbar → Station.'));
    steps.push(S('route', '再用一条线把它们依次串起来：中途可以拐弯，别断开', '底部工具坞「绘线」' + keyHint('tool.line'), [aLine()],
      'Then thread them onto one line: bends are fine, breaks are not. Bottom toolbar → Draw line' + keyEn('tool.line') + '.'));
    steps.push(S('hammer', '确认建设', '草案栏「确认建设」', [aConfirm()],
      'Confirm the build. Draft bar → Confirm build.'));
    return { icon: 'route', order: '补站 → 一条线串起来 → 确认建设', steps: steps };
  };
  MAKE.loop = function (t, g, ev) {
    return { icon: 'route', order: '成环 → 接放射线', steps: [
      S('route', '环线要满足三条：长度 ≥ ' + num(t.minKm, 0) + ' km、把' + (t.label || t.place || '市中心') + '圈在里面、串起 ' + (t.minRadials || 2) + ' 条放射线', '任务卡上会显示当前环长与放射线数量', null,
        'The loop needs three things: at least ' + num(t.minKm, 0) + ' km, surrounding ' + (t.label || t.place || 'the centre') + ', and connecting ' + (t.minRadials || 2) + ' radial lines. The task card shows the current length and count.'),
      S('route', '用「绘线」首尾相接：最后一站连回起点，线路会自动成为环线', '底部工具坞「绘线」' + keyHint('tool.line'), [aLine()],
        'With Draw line, close the circuit: connect the last station back to the first and it becomes a loop. Bottom toolbar → Draw line' + keyEn('tool.line') + '.'),
      S('route', '在环上接入放射线：把穿过环的线路共站（并线），环内、环外都有它的站才算一条放射线', '「绘线」点到环上已有车站即共站', null,
        'Attach radials to the ring: share a station with the lines that cross it. A line counts as a radial only when it has stations both inside and outside the ring.'),
      S('hammer', '确认建设后回来看环长与放射线数量', '草案栏「确认建设」', [aConfirm()],
        'Confirm, then come back to check the length and radial count. Draft bar → Confirm build.')] };
  };
  MAKE.hub = function (t, g, ev) {
    return { icon: 'network', order: '建一座站 → 多线共站', steps: [
      S('station', '在' + (t.place || '指定地点') + '建一座车站，让 ' + (t.lines || 2) + ' 条线路都在这里停靠', '底部工具坞「建站」', [aStation()],
        'Build one station at ' + (t.place || 'the named place') + ' where ' + (t.lines || 2) + ' lines all call. Bottom toolbar → Station.'),
      S('route', '每条线经过时都点到这同一座车站（共站），不要建两座挨着的站', '「绘线」点到已有车站自动共站', [aLine()],
        'Have every line stop at that same station — do not build two stations side by side. Draw line snaps to existing stations.'),
      S('check', '车站详情里「经过线路」达到 ' + (t.lines || 2) + ' 条即达成', '', null,
        'The goal is met when the station details list ' + (t.lines || 2) + ' lines.')] };
  };
  MAKE.cross = function (t, g, ev) {
    return { icon: 'route', order: '让轨道跨过江面', steps: [
      S('route', '目标：' + (t.label || '跨江') + ' ' + (t.target || 1) + ' 段（共线只算一次）。桥和隧道都算，跨江段另有附加造价', '绘线时直接跨过水面即可', null,
        'Goal: ' + (t.target || 1) + ' water crossing(s) — shared track counts once. Bridges and tunnels both count, and crossings carry an extra cost. Just draw across the water.'),
      S('hammer', '确认建设', '草案栏「确认建设」', [aConfirm()],
        'Confirm the build. Draft bar → Confirm build.')] };
  };
  MAKE.typeKm = function (t, g, ev) {
    const names = [].concat(t.seg || []).map(function (x) { return CFG.metro.typeName[x] || x; });
    const namesEn = [].concat(t.seg || []).map(function (x) { return CFG.metro.typeName[x] === '地下' ? 'underground' : (x === 'elevated' ? 'elevated' : 'surface'); });
    return { icon: 'route', order: '选建设方式 → 绘线', steps: [
      S('route', '目标：' + names.join('或') + '线路 ' + (t.target || 0) + ' km。建站或绘线时切换建设方式', '底部工具坞上的建设方式切换；车站详情 →「建设」里也能改', null,
        'Goal: ' + (t.target || 0) + ' km of ' + namesEn.join(' or ') + ' line. Switch the construction type while placing stations or drawing. Use the switch on the bottom toolbar, or Station details → Build.'),
      S('hammer', '确认建设', '草案栏「确认建设」', [aConfirm()],
        'Confirm the build. Draft bar → Confirm build.')] };
  };
  MAKE.spacing = function (t, g, ev) {
    const rt = routeOf(g, t.anchors);
    const avg = rt && rt.all && rt.route.stIdx.length > 1 ? rt.route.lenM / (rt.route.stIdx.length - (rt.route.loop ? 0 : 1)) : null;
    const goal = t.max ? '平均站距不超过 ' + Math.round(t.max) + ' m' : '平均站距不少于 ' + Math.round(t.min) + ' m';
    const goalEn = t.max ? 'average spacing no more than ' + Math.round(t.max) + ' m' : 'average spacing at least ' + Math.round(t.min) + ' m';
    return { icon: 'station', order: '看站距 → 加站或减站', steps: [
      S('target', goal + (avg ? '，现在 ' + Math.round(avg) + ' m' : '（线路建成后统计）'), '线路详情里能看到各站间距', null,
        'Target: ' + goalEn + (avg ? ', currently ' + Math.round(avg) + ' m' : ' (measured once the line exists)') + '. Line details show the gaps between stations.'),
      S('station', t.max ? '站距太大：在中间加站' : '站距太密：拆掉或合并中间的小站', '底部工具坞「建站」/「拆除」', [aStation()],
        t.max ? 'Spacing is too wide: add stations in between. Bottom toolbar → Station.' : 'Spacing is too tight: remove or merge the small stations in between. Bottom toolbar → Demolish.'),
      S('hammer', '确认建设', '草案栏「确认建设」', [aConfirm()],
        'Confirm the build. Draft bar → Confirm build.')] };
  };
  MAKE.lineSpeed = function (t, g, ev) {
    const rt = routeOf(g, t.anchors);
    return { icon: 'timer', order: '取直 → 减站 → 再看要不要提速', steps: [
      S('timer', '目标：运行速度 ≥ ' + (t.kmh || 60) + ' km/h' + (rt && rt.all ? '，现在 ' + rt.route.kmh + ' km/h' : ''), '线路详情里能看到运行速度', null,
        'Target: at least ' + (t.kmh || 60) + ' km/h' + (rt && rt.all ? ', currently ' + rt.route.kmh + ' km/h' : '') + '. Line details show the running speed.'),
      S('route', '先把线取直：弯道限速约 √(0.8 × 半径)，半径 250 m 只有 51 km/h，把车站移出弯道、减少急弯最有效', '「修改」工具拖动车站或转弯点；线形可选「平滑」', null,
        'Straighten first: curve speed is about √(0.8 × radius), so a 250 m radius allows only 51 km/h. Move stations out of curves and remove sharp bends. Use the Edit tool, or the smooth alignment option.'),
      S('train', '减少停站：跳站或取消客流极小的站，起停损失每站约 1 分钟', '线路详情 →「列车运营」里可设快车/跳站', null,
        'Stop less: skip or drop very low-demand stops — each stop costs about a minute. Train operations lets you run express or skip-stop services.'),
      S('info', '最后才考虑提速档位：100 km/h 需要曲线半径 ≥ 400 m，120 km/h 需要 ≥ 600 m，半径不够花钱也没用', '车站/轨道详情里能看曲线半径', null,
        'Only then consider a higher speed class: 100 km/h needs a radius of at least 400 m and 120 km/h at least 600 m — money is wasted if the radius is too small. Station and track details show the radius.')] };
  };
  MAKE.lineTrain = function (t, g, ev) { return MAKE.lineCars(t, g, ev); };
  MAKE.noStation = function (t, g, ev) {
    const c = compOf(g); let n = 0;
    if (c && t.regions) {
      try {
        const set = new Set(t.regions);
        c.stations.forEach(function (s, i) { const rg = g.city.regionAt(s.x, s.y); if (c.serviced[i] && rg && set.has(rg.id)) n++; });
      } catch (e) { /* 区域信息不可用时只作提示 */ }
    }
    return { icon: 'map', order: '拆除或移出', steps: [
      S('map', (t.areaName || '指定片区') + '内现在有 ' + n + ' 座运营车站，目标 0 座', '打开覆盖图层能看到车站位置', [aArea(t), aLayer('cover', '覆盖图层', 'lyCover')],
        (t.areaName || 'The district') + ' currently has ' + n + ' open stations and needs none. The coverage layer shows where they are.'),
      S('station', '把车站移出该片区（250 m 内免费），或直接拆除这段线路', '「修改」工具拖动车站；「拆除」工具拆线路', null,
        'Move the stations out of the district (up to 250 m is free) or demolish that section. Use the Edit tool to drag stations, the Demolish tool for track.'),
      S('hammer', '确认建设', '草案栏「确认建设」', [aConfirm()],
        'Confirm the build. Draft bar → Confirm build.')] };
  };
  MAKE.coTrack = function (t, g, ev) {
    return { icon: 'route', order: '共线 → 直通', steps: [
      S('route', '目标：共线直通的轨道 ' + (t.target || 0) + ' km。两条线共用同一段轨道即可（不加转弯点、直接连已有轨道就免费沿用）', '「绘线」连到已有轨道上；线路右键可「贯通、拆开」', null,
        'Goal: ' + (t.target || 0) + ' km of shared through-running track. Two lines simply use the same section — connect straight to existing track with no extra bend and it is reused for free. Draw line onto existing track; the line menu has through-run and split.'),
      S('hammer', '确认建设', '草案栏「确认建设」', [aConfirm()],
        'Confirm the build. Draft bar → Confirm build.')] };
  };
  MAKE.share = function (t, g, ev) {
    return { icon: 'metro', order: '补覆盖 → 直达 → 班次 → 票价', steps: [
      S('lyCover', '全市分担率要再提高：先把还没覆盖的人口接进来', '左下角「图层」→ 地铁 →「地铁覆盖」', [aLayer('cover', '覆盖图层', 'lyCover')],
        'To lift the citywide share, first bring in the population without coverage. Bottom-left Layers → Metro → Coverage.'),
      S('route', '让主要出行方向能一条线直达，换乘越少越好', '底部工具坞「绘线」', [aLine()],
        'Give the main travel directions a one-seat ride — fewer transfers is better. Bottom toolbar → Draw line.'),
      S('train', '加密班次、加编组：等车久、太挤都会把人赶回车里', '线路详情 →「列车运营」', null,
        'Run more and longer trains: long waits and crowding push people back into cars. Line details → Train operations.'),
      S('ticket', '票价过高会压低分担率', '财政 → 概览 → 票价', [aFare()],
        'High fares hold the share down. Finance → Overview → Fare.')] };
  };
  MAKE.lineRiders = function (t, g, ev) {
    const rt = routeOf(g, t.anchors);
    return { icon: 'trend', order: '沿线补站 → 加密 → 缩短', steps: [
      S('trend', '目标：这条线每公里日客流 ' + U.fmtPeople(t.perKm || 0) + ' 人次' + (rt && rt.all ? '（' + rt.route.line.name + '）' : ''), '线路详情里能看长度与客流', null,
        'Target: ' + U.fmtPeople(t.perKm || 0) + ' riders per kilometre per day' + (rt && rt.all ? ' on ' + rt.route.line.name : '') + '. Line details show length and ridership.'),
      S('station', '沿线人口与就业密集处补站、把周边接驳做起来', '底部工具坞「建站」', [aStation()],
        'Add stations where housing and jobs are dense along the line, and improve access around them. Bottom toolbar → Station.'),
      S('train', '加密班次、减少换乘，让沿线的人愿意坐', '线路详情 →「列车运营」', rt && rt.all ? [aOps(rt.route.lineId)] : [],
        'Run more trains and cut transfers so people along the line choose it. Line details → Train operations.')] };
  };
  MAKE.regionShare = function (t, g, ev) {
    return { icon: 'metro', order: '补覆盖 → 接到目的地 → 少换乘', steps: [
      S('map', (t.areaName || '片区') + '居民出行乘地铁的比例要再提高：先看片区里哪里还走不到车站', '定位片区后打开「地铁覆盖」', [aArea(t), aLayer('cover', '覆盖图层', 'lyCover')],
        'The metro share of trips by residents in ' + (t.areaName || 'this district') + ' needs to rise: start with the parts that cannot reach a station. Locate the district, then open Coverage.'),
      S('station', '在人口最密处补站，别让居民先走十几分钟', '底部工具坞「建站」', [aStation()],
        'Add stations where people are densest so residents do not walk a quarter of an hour first. Bottom toolbar → Station.'),
      S('lyFlow', '线路要顺着居民的去向修（多半是市中心或就业区）', '左下角「图层」→ 交通 →「出行方向」', [aLayer('flow', '出行方向图层', 'lyFlow')],
        'Follow where residents actually go — usually the centre or job districts. Bottom-left Layers → Traffic → Travel direction.'),
      S('train', '班次密、不挤、换乘少，比例才上得去', '线路详情 →「列车运营」', null,
        'Frequent, uncrowded trains with few transfers are what move the share. Line details → Train operations.')] };
  };
  MAKE.regionCommute = function (t, g, ev) {
    return { icon: 'timer', order: '缩短步行 → 加密班次 → 减少换乘', steps: [
      S('timer', '门到门 = 两端步行 + 候车 + 乘车 + 换乘：' + (ev && ev.text ? ev.text : '先看当前平均通勤'), '打开「通勤时间」图层看哪个片区最红', [aArea(t), aLayer('commute', '通勤时间图层', 'timer')],
        'Door to door = walking at both ends + waiting + riding + transfers' + (ev && ev.text ? '' : '') + '. Open the Commute time layer to see which district is reddest.'),
      S('station', '步行是大头（权重 1.6 倍）：在居民区 750 m 内补站，或把站移近', '底部工具坞「建站」；「修改」可拖动车站', [aStation()],
        'Walking dominates (weighted 1.6×): add stations within 750 m of homes, or move an existing one closer. Bottom toolbar → Station; Edit drags stations.'),
      S('train', '候车 = 发车间隔的一半：加密班次最直接，尤其早高峰', '线路详情 →「列车运营」', null,
        'Waiting is half the headway: more trains is the most direct fix, especially in the morning peak. Line details → Train operations.'),
      S('route', '减少换乘：让主要通勤方向一条线直达；距离长可设快车跳站', '线路详情 →「列车运营」里可设快车', [aLine()],
        'Cut transfers: give the main commute a one-seat ride, and run express or skip-stop services on long corridors. Train operations has the express options.')] };
  };
  MAKE.xferShare = function (t, g, ev) {
    return { icon: 'network', order: '分散换乘点', steps: [
      S('network', '目标：换乘客流在' + (t.areaName || '这一带') + '的比例不超过 ' + pct(t.target || 0.5, 0) + '——换乘太集中说明大家被迫在这里换', '线路示意图里能看到换乘站位置', [aArea(t)],
        'Target: no more than ' + pct(t.target || 0.5, 0) + ' of all transfers happen in ' + (t.areaName || 'this area') + ' — heavy concentration means people are forced to change there. The network map shows the interchanges.'),
      S('route', '开直达线路、或在另一个方向建换乘点，把换乘分散开', '底部工具坞「绘线」', [aLine()],
        'Add direct lines, or create an interchange in another direction to spread transfers out. Bottom toolbar → Draw line.')] };
  };
  MAKE.budget = function (t, g, ev) {
    const spent = Math.max(0, ((g.econ && g.econ.built) || 0) - (t.spent0 || 0));
    return { icon: 'wallet', order: '省着建 → 盯住花费', steps: [
      S('wallet', '已花 ' + U.fmtMoney(spent) + '，预算 ' + U.fmtMoney(t.budget || 0) + '，超出即判失败', '草案栏会实时显示本次建设的花费', null,
        U.fmtMoney(spent) + ' spent of a ' + U.fmtMoney(t.budget || 0) + ' budget — going over fails the goal. The draft bar shows the running cost.'),
      S('route', '省钱三招：用高架或地面代替地下（约三分之一）、取直少绕、少设站（一座站占大头）', '建站/绘线时切换建设方式', null,
        'Three ways to save: use elevated or surface instead of underground (about a third of the cost), keep the route straight, and build fewer stations (a station is the big-ticket item). Switch the construction type while building.'),
      S('hammer', '确认建设前再看一眼总价', '草案栏「确认建设」', [aConfirm()],
        'Check the total once more before confirming. Draft bar → Confirm build.')] };
  };
  MAKE.lineCost = function (t, g, ev) {
    return { icon: 'wallet', order: '换建设方式 → 取直 → 少设站', steps: [
      S('wallet', '这段线路的造价要控制在 ' + U.fmtMoney(t.budget || 0) + ' 以内', '线路建成后任务卡会显示实际造价', null,
        'This section has to come in under ' + U.fmtMoney(t.budget || 0) + '. The task card shows the actual cost once it is built.'),
      S('route', '高架/地面比地下便宜得多；取直、少绕、避开需要拆迁的街区', '「修改」工具拖动车站与转弯点', null,
        'Elevated and surface are far cheaper than underground; keep it straight, avoid detours and built-up blocks that need demolition. Edit drags stations and bends.'),
      S('hammer', '确认建设', '草案栏「确认建设」', [aConfirm()],
        'Confirm the build. Draft bar → Confirm build.')] };
  };
  MAKE.todNet = function (t, g, ev) {
    return { icon: 'bag', order: '挑客流大的站 → 开发', steps: [
      S('bag', (t.areaName || '片区') + '里要开发 ' + (t.stations || 1) + ' 座车站的商业，且每月净收益为正' + (t.net ? '（目标 ≥ ' + U.fmtMoney(t.net) + '）' : ''), '左下角「图层」→ 地铁 →「商业开发」能看出哪些站值得开发', [aArea(t), aLayer('tod', '商业开发图层', 'bag')],
        'Develop commerce at ' + (t.stations || 1) + ' station(s) in ' + (t.areaName || 'the district') + ' with a positive monthly net' + (t.net ? ' (target at least ' + U.fmtMoney(t.net) + ')' : '') + '. Bottom-left Layers → Metro → Commerce shows which stations are worth it.'),
      S('bag', '从客流最大的车站开始：客流越大，商业净收益越高；等级越高收益越高，但成本也高', '车站详情 →「商业开发（TOD）」→ 选一档，确认建设', null,
        'Start with the busiest stations: higher footfall means higher net income, and higher levels earn more but cost more. Station details → Station TOD → pick a level, then confirm.')] };
  };
  MAKE.regionPull = function (t, g, ev) {
    return { icon: 'trend', order: '换乘 → 客流 → 开发', steps: [
      S('trend', '要让' + (t.areaName || '片区') + '里出现 ' + (t.target || 1) + ' 座带动强的车站（换乘、客流与商业开发都能提高这个值）', '打开「城市发展」图层看带动强度', [aArea(t), aLayer('dev', '城市发展图层', 'trend')],
        'Get ' + (t.target || 1) + ' station(s) in ' + (t.areaName || 'the district') + ' with strong uplift — interchanges, ridership and commerce all raise it. Open the Development layer to see the strength.'),
      S('route', '先把车站做成换乘站：多一条线经过，带动明显上升', '底部工具坞「绘线」', [aLine()],
        'Turn the station into an interchange first: one more line lifts the uplift noticeably. Bottom toolbar → Draw line.'),
      S('bag', '再做车站商业开发，客流与开发强度一起上', '车站详情 →「商业开发（TOD）」', null,
        'Then develop station commerce so footfall and intensity rise together. Station details → Station TOD.')] };
  };

  // ---------------- 组装 ----------------
  const FALLBACK = { icon: 'flag', steps: [S('info', '这条任务按任务卡上的目标与当前值比较即可：差值就是还要补的部分。', '需要具体做法时可以看「新手指南」', null,
    'Compare the target with the current value on the task card — the gap is what is left. See the Player Guide for general advice.')] };
  const GUIDE_OF = { combo: 'build', zoneCong: 'cong', stationCrowd: 'crowd', lineCrowd: 'crowd', lineCars: 'crowd', netLoad: 'crowd',
    recovery: 'money', fiscal: 'money', coverage: 'zone', zoneCov: 'zone', regionCov: 'zone', ridership: 'zone', lineEff: 'zone',
    share: 'zone', regionShare: 'zone', facShare: 'fac', connect: 'start', budgetConnect: 'start', xferHub: 'build', direct: 'build', loop: 'build' };

  const partLabel = function (p) {
    const K = (CM.Tasks && CM.Tasks.PART_KIND) || {};
    return K[p.kind] || '目标';
  };

  CM.HowTo = {
    // 按任务生成指引：sections 里每一项是一组步骤（复合任务按分项分组，单项任务只有一组）
    task: function (t, g) {
      if (!t) return null;
      const ev = t.progress || (CM.Tasks && CM.Tasks.evaluate ? CM.Tasks.evaluate(t, g) : null);
      const sections = [], notes = [], notesEn = [];
      if (t.type === 'combo' && t.parts && t.parts.length) {
        const parts = (ev && ev.parts) || [];
        t.parts.forEach(function (p, i) {
          // 分项本身通常不带地点：与 Tasks.evaluatePart 一致，用任务的锚点兜底（否则「同一条线直达」这类步骤说不出是哪些地方）
          const pp = (p.anchors && p.anchors.length) ? p : Object.assign({ anchors: t.anchors }, p);
          const r = MAKE[p.type] ? MAKE[p.type](pp, g, parts[i] || null) : FALLBACK;
          const st = parts[i] || {};
          sections.push({ key: p.type + ':' + i, label: partLabel(p), core: !!p.core, text: st.text || '', ok: !!st.ok, order: r.order || '', steps: r.steps || [] });
          for (const n of r.notes || []) notes.push(n);
          for (const n of r.notesEn || []) notesEn.push(n);
        });
        // 同一方面的分项（例如两项都是「网络形态」）加序号，免得几条之间的标题一模一样
        const counts = {}, seen = {};
        for (const s of sections) counts[s.label] = (counts[s.label] || 0) + 1;
        for (const s of sections) if (counts[s.label] > 1) { seen[s.label] = (seen[s.label] || 0) + 1; s.label = s.label + ' ' + seen[s.label] + '/' + counts[s.label]; }
      } else {
        const r = MAKE[t.type] ? MAKE[t.type](t, g, ev) : FALLBACK;
        sections.push({ key: t.type, label: '', text: (ev && ev.text) || '', ok: !!(ev && ev.ok), order: r.order || '', steps: r.steps || [] });
        for (const n of r.notes || []) notes.push(n);
        for (const n of r.notesEn || []) notesEn.push(n);
      }
      return { title: t.title || '', sections: sections, notes: notes, notesEn: notesEn, guide: GUIDE_OF[t.type] || null };
    },
    // 给测试与调试用：某个类型是否有专门的步骤（复合任务按分项分组，单独处理）
    has: function (type) { return type === 'combo' || !!MAKE[type]; },
    types: function () { return Object.keys(MAKE); },
    // 步骤按钮的显示文字：英文界面用固定译名，地名交给 i18n（会转写为拼音）
    actText: function (a, en) {
      if (!en) return a.label;
      const map = { '切到「建站」': 'Station tool', '切到「绘线」': 'Draw line', '确认建设': 'Confirm build', '定位片区': 'Locate district', '定位接驳口': 'Locate boundary connection',
        '打开车站': 'Open station', '打开设施详情': 'Open facility', '列车运营': 'Train ops', '打开线路': 'Open line',
        '车站商业开发': 'Station TOD', '调票价': 'Fare', '覆盖图层': 'Coverage layer', '人口密度图层': 'Density layer',
        '出行方向图层': 'Travel direction layer', '拥堵图层': 'Congestion layer', '车站客流图层': 'Station load layer', '通勤时间图层': 'Commute time layer' };
      if (map[a.label]) return map[a.label];
      const m = /^定位「(.+)」$/.exec(a.label);
      if (m) return 'Locate "' + (CM.I18n ? CM.I18n.text(m[1]) : m[1]) + '"';
      return CM.I18n ? CM.I18n.text(a.label) : a.label;
    }
  };
})(window.CM);
