'use strict';
// 规划顾问（v3.0）：HUD 常驻入口，按影响把「现在该做什么」拆成三列——
//   覆盖缺口最大的 3 个片区、最拥挤的 3 个区间、当前资金可负担的下一步建议。
// 每一项都可以点击：定位到地图上的位置，并切换到对应图层（覆盖缺口 / 车站客流）。
// 数据全部来自现有的模拟结果（小区覆盖、断面客流、线路配属与造价估算），不引入新的求解。
(function (CM) {
  const U = CM.U, CFG = CM.CFG, h = U.h;
  const A = CM.Advisor = {};
  const pct = function (v) { return U.fmtPct(v, 0); };
  const people = function (v) { return U.fmtPeople(v); };

  // 覆盖缺口：人口 + 岗位多、但步行 15 分钟可达车站的比例低的小区（按「未覆盖的出行量」排序）
  A.gaps = function (g) {
    const m = g && g.model, acc = m && m.net && m.net.acc;
    if (!acc || !acc.zCov || !m.zPop) return [];
    const out = [];
    for (let z = 0; z < m.Z; z++) {
      const pj = (m.zPop[z] || 0) + (m.zJobs[z] || 0);
      if (pj < 8000) continue;
      const cov = acc.zCov[z] || 0;
      if (cov > 0.25) continue;
      out.push({ z: z, pj: pj, cov: cov, x: m.zCx[z], y: m.zCy[z], name: g.zoneName(z) });
    }
    out.sort(function (a, b) { return b.pj * (1 - b.cov) - a.pj * (1 - a.cov); });
    return out.slice(0, 3);
  };

  // 最拥挤区间：工作日早高峰各交路的最大断面客流 ÷ 该时段运力（发车频率 × 单列定员）
  A.crowded = function (g) {
    const m = g && g.model, net = m && m.net, C0 = net && net.C;
    if (!C0 || !m.resultsFor) return [];
    const res = m.resultsFor('wd'), P = res && res.per && res.per[0];
    if (!P || !P.load) return [];
    const out = [];
    for (let r = 0; r < C0.routes.length; r++) {
      const rt = C0.routes[r], re = net.rideEdge && net.rideEdge[r];
      if (!re || !re.length) continue;
      const f = P.freq ? (P.freq[r] || 0) : 0, capT = m.capOf(r, net);
      const cap = f * capT;
      if (!(cap > 1)) continue;
      let mx = 0, q0 = 0;
      for (let q = 0; q < re.length; q++) { const v = P.load[re[q]] || 0; if (v > mx) { mx = v; q0 = q; } }
      if (mx <= 0) continue;
      const st = rt.stIdx || [];
      if (st.length < 2) continue;
      // 区间客流的下标对应「第 k 段」，取 k 与 k+1 两站作为区间名；k 上限留一段，避免出现「A—A」
      const k = Math.min(st.length - 2, Math.max(0, q0));
      const A0 = C0.stations[st[k]], B0 = C0.stations[st[k + 1]];
      out.push({
        r: r, lf: mx / cap, load: mx, cap: cap, f: f,
        x: A0 && B0 ? (A0.x + B0.x) / 2 : (A0 ? A0.x : null), y: A0 && B0 ? (A0.y + B0.y) / 2 : (A0 ? A0.y : null),
        line: g.net.lines[rt.lineId], lineName: g.net.lines[rt.lineId] ? g.net.lines[rt.lineId].name : rt.lineId,
        a: A0 ? A0.name : '', b: B0 ? B0.name : '',
      });
    }
    out.sort(function (a, b) { return b.lf - a.lf; });
    return out.slice(0, 3);
  };

  // 当前资金可负担的下一步：按「拥挤 → 覆盖 → 扩张」的优先级给出 1–3 条可执行建议
  A.next = function (g) {
    // v3.8：资金不受限（自由建造 / 开启无限贷款）时不按资金判定建议可行性
    const out = [], sb = g.econ.isSandbox(), funds = sb ? Infinity : g.econ.funds;
    const y = g.clock.y, ci = g.econ.costIndex ? g.econ.costIndex(y) : 1;
    // 一列车的价格（用当年在售的推荐车型估算）
    let carCost = 0;
    if (CM.Fleet && CM.Fleet.eraModel) {
      const m0 = CM.Fleet.eraModel(g.mapId, y);
      if (m0) carCost = CM.Fleet.price(g, m0, Math.min(8, m0.max || 8), y);
    }
    const cr = A.crowded(g), gp = A.gaps(g);
    // 1) 拥挤最严重且已经超载：买车或加长编组
    if (cr[0] && cr[0].lf > 0.95) {
      const x = cr[0], n = Math.max(1, Math.ceil((x.lf - 1) * x.f / 4));
      const cost = carCost * n;
      out.push({
        kind: 'crowd', icon: 'train', title: (x.lineName || '线路') + '：' + (x.a ? x.a + '—' + x.b : '最拥挤区间') + ' 满载 ' + pct(x.lf),
        desc: '早高峰最挤的区间已经' + (x.lf > 1 ? '超载' : '接近满载') + '。建议买 ' + n + ' 列同型车，或把编组加长到站台上限。',
        cost: cost, ok: funds >= cost, go: { layer: 'station', x: x.x, y: x.y, kind: 'line', id: x.line ? Object.keys(g.net.lines).find(function (k) { return g.net.lines[k] === x.line; }) : null },
      });
    }
    // 2) 覆盖缺口最大的片区：把最近线路延伸过去（粗估 2–4 km、2 座车站）
    if (gp[0]) {
      const p = gp[0], perKm = CFG.cost.trackPerKm.underground * ci, st = CFG.cost.station.underground.M * ci;
      const est = perKm * 3 + st * 2;
      out.push({
        kind: 'cover', icon: 'pin', title: '「' + p.name + '」还没有地铁覆盖',
        desc: '人口与岗位约 ' + people(p.pj) + '，步行 15 分钟可达车站的比例只有 ' + pct(p.cov) + '。建议从最近的线路延伸 2–3 站（粗估 3 km、2 座地下站）。',
        cost: est, ok: funds >= est, go: { layer: 'gap', x: p.x, y: p.y },
      });
    }
    // 3) 资金还很充裕：新建一条线，把前两个缺口串起来
    if (gp.length >= 2) {
      const a = gp[0], b = gp[1], km = Math.max(3, Math.round(U.dist(a.x, a.y, b.x, b.y) * CFG.CELL_M * 1.2 / 1000));
      const est = CFG.cost.trackPerKm.underground * ci * km + CFG.cost.station.underground.M * ci * 4;
      out.push({
        kind: 'newline', icon: 'route', title: '新建一条线：' + a.name + ' — ' + b.name,
        desc: '两处合计约 ' + people(a.pj + b.pj) + ' 人尚未覆盖，直线距离约 ' + km + ' km。若资金充足，这比逐段延伸更能形成网络。',
        cost: est, ok: funds >= est, go: { layer: 'gap', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      });
    }
    // 4) 都不缺：给出「保持运营」的提示，避免顾问空白
    if (!out.length) {
      const x = cr[0];
      out.push({
        kind: 'ok', icon: 'check', title: '线网暂时没有明显短板',
        desc: x ? '最挤的 ' + (x.lineName || '线路') + ' 区间满载 ' + pct(x.lf) + '，还有余量。可以先把资金留给下一轮扩张，或开发车站商业提高收入。' : '覆盖与运力都还够用。可以推进时间观察城市增长，或开发车站商业。',
        cost: 0, ok: true, go: x ? { layer: 'station', x: x.x, y: x.y } : null,
      });
    }
    return out.slice(0, 3);
  };

  A.data = function (g) { return { gaps: A.gaps(g), crowded: A.crowded(g), next: A.next(g) }; };

  // 顾问面板：三列，点击任一项定位并切图层
  A.open = function (ui) {
    const g = ui.g && ui.g();
    if (!g) return;
    const d = A.data(g), self = ui;
    const jump = function (go) {
      if (!go) return;
      self.closeScreen();
      if (go.layer && self.setLayer) self.setLayer(go.layer);
      if (go.kind === 'line' && go.id && self.openObj) { self.openObj('line', go.id, 'ops'); return; }
      if (isFinite(go.x) && isFinite(go.y) && CM.R && CM.R.flyTo) CM.R.flyTo(go.x, go.y, Math.max(22, CM.R.cam.zoom));
    };
    const item = function (main, sub, go, extra) {
      return h('button', { class: 'adv-item', 'data-tip': '点击定位并切换到对应图层', onclick: function () { jump(go); } },
        h('b', null, main), h('small', null, sub), extra ? h('span', { class: 'adv-cost ' + (extra.ok ? 'good' : 'bad') }, extra.text) : null);
    };
    const gapCol = h('div', { class: 'adv-col' },
      h('div', { class: 'adv-h' }, '覆盖缺口（前 3）'),
      d.gaps.length ? d.gaps.map(function (x) { return item(x.name, '人口 + 岗位 ' + people(x.pj) + ' · 已覆盖 ' + pct(x.cov), { layer: 'gap', x: x.x, y: x.y }); })
        : h('div', { class: 'note' }, '主要片区都已有地铁覆盖。'));
    const crowdCol = h('div', { class: 'adv-col' },
      h('div', { class: 'adv-h' }, '最拥挤区间（早高峰）'),
      d.crowded.length ? d.crowded.map(function (x) {
        return item((x.lineName || '线路') + (x.a ? '：' + x.a + '—' + x.b : ''), '满载率 ' + pct(x.lf) + ' · ' + U.fmtInt(x.load) + ' 人/时', { layer: 'station', x: x.x, y: x.y });
      }) : h('div', { class: 'note' }, '还没有运营中的线路。'));
    const nextCol = h('div', { class: 'adv-col wide' },
      h('div', { class: 'adv-h' }, '可负担的下一步'),
      d.next.map(function (x) {
        return item(x.title, x.desc, x.go, x.cost > 0 ? { ok: x.ok, text: (x.ok ? '资金够 · 约 ' : '还差 · 约 ') + U.fmtMoney(x.cost) } : null);
      }),
      h('div', { class: 'note' }, (g.econ.isFree() ? '自由建造：资金不限。' : g.econ.isInfinite() ? '无限贷款：资金不足也可建设，当前 ' + U.fmtMoney(g.econ.funds) + '。' : '当前可用资金 ' + U.fmtMoney(g.econ.funds) + '。') + '建议按「先补覆盖、再解拥挤、最后扩张」的顺序看，数字是粗估，实际以建设草案为准。'));
    const card = h('div', { class: 'card wide adv-card' },
      ui.cardHead('guide', 'b-teal', '规划顾问'),
      h('div', { class: 'note' }, '按影响排序，每项都可以点击定位。'),
      h('div', { class: 'adv-cols' }, gapCol, crowdCol, nextCol));
    ui.openScreen(card, function () { ui.closeScreen(); });
  };

  // HUD 角标：显示当前建议条数（地铁芯、满意度旁边）
  A.badge = function (g) {
    try { const d = A.data(g); return d.gaps.length + d.crowded.length; } catch (e) { return 0; }
  };
  // 入口的显隐与角标：跟随地铁芯的同一次刷新（月结、读档、买车后都会走 updateOpsDock）
  if (CM.UI) CM.UI.prototype.updateAdvDock = function () {
    const b = this.advDock, g = this.g && this.g();
    if (!b) return;
    const show = !!g && !g.tutorial;
    b.classList.toggle('hidden', !show);
    if (!show) return;
    const n = A.badge(g), v = b.querySelector('.sd-v');
    if (v && v._n !== n) { v._n = n; v.textContent = n ? n + ' 项' : '—'; }
    const dot = b.querySelector('.sd-dot');
    if (dot) { dot.style.display = n ? '' : 'none'; dot.textContent = n ? String(n) : ''; }
  };
})(window.CM);
