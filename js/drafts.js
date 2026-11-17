'use strict';
// 建设草稿：把尚未确认的建设草案保存下来，之后可随时载入继续规划，或等资金充足时再确认建设。
// 草稿只记录「相对保存当时正式线网的改动」（新增 / 修改 / 删除），载入时按当前的正式线网重放：
// 保存草稿之后建成的线路与车站不会因为载入草稿而消失；草稿涉及的对象在此期间已经变化时跳过该项，
// 并在载入结果中逐条说明。草稿随本局进度一起保存（存档 / 导出都包含）。
(function (CM) {
  const U = CM.U, M = CM.Metro, h = U.h, ic = CM.icon, Game = CM.Game, UI = CM.UI;
  const KINDS = ['lines', 'stations', 'segments'];
  // 草稿名是玩家自己起的，属于数据：本地化时原样保留，不会被逐字改写
  const nm = function (s) { return CM.I18n && CM.I18n.keep ? CM.I18n.keep(s) : String(s == null ? '' : s); };
  const MAX = 10;          // 单局最多保存的草稿份数（控制存档体积）
  const NAME_MAX = 24;

  // 内容的稳定指纹：只用于比较同一对象在两次保存之间有没有变化
  function sig(o) {
    const s = JSON.stringify(o);
    let h1 = 2166136261;
    for (let i = 0; i < s.length; i++) { h1 ^= s.charCodeAt(i); h1 = Math.imul(h1, 16777619); }
    return (h1 >>> 0).toString(36) + ':' + s.length;
  }
  const same = function (a, b) { return JSON.stringify(a) === JSON.stringify(b); };

  // ---------------- 保存：草案相对正式线网的改写清单 ----------------
  function plan(base, dn) {
    const out = { v: 1, base: sig(base), add: {}, mod: {}, del: {} };
    for (const k of KINDS) {
      const A = out.add[k] = {}, O = out.mod[k] = {}, D = out.del[k] = {};
      const b = base[k] || {}, d = dn[k] || {};
      for (const id in d) {
        if (!b[id]) A[id] = M.clone(d[id]);   // 复制：草稿之后继续编辑也不会改动已保存的清单
        else if (!same(b[id], d[id])) O[id] = { o: M.clone(d[id]), was: JSON.stringify(b[id]) };
      }
      for (const id in b) if (!d[id]) D[id] = JSON.stringify(b[id]);
    }
    return out;
  }

  function segsAt(net, sid) {
    const out = [];
    for (const id in net.segments) { const s = net.segments[id]; if (s.a === sid || s.b === sid) out.push(s); }
    return out;
  }
  function segNameOf(net, s) {
    const a = s && net.stations[s.a], b = s && net.stations[s.b];
    return (a ? a.name : '?') + '—' + (b ? b.name : '?');
  }
  function segLabel(net, id) {
    const s = net.segments[id];
    return s ? segNameOf(net, s) : '（已拆除的轨道）';
  }
  const kindName = { lines: '线路', stations: '车站', segments: '轨道' };
  function label(k, o) { return o && o.name ? o.name : (kindName[k] || '对象'); }

  // ---------------- 载入：把改写清单重放到当前正式线网 ----------------
  function apply(net, P) {
    const N = M.clone(net), skipped = [];
    P = P || { add: {}, mod: {}, del: {} };
    const add = P.add || {}, mod = P.mod || {}, del = P.del || {};
    const addLine = add.lines || {}, addSt = add.stations || {}, addSg = add.segments || {};

    // 0) 编号避让：两份草稿各自从同一线网出发时，新对象会拿到相同编号（s12、g7…），
    //    若当前线网里已经有同号对象，说明是另一份草稿建成后留下的，给这份草稿的新对象重新编号。
    const usedSt = new Set(Object.keys(N.stations)), usedLn = new Set(Object.keys(N.lines)), usedSg = new Set(Object.keys(N.segments));
    let nextId = N.nextId || 1;
    const fresh = function (p, used) {
      let id;
      do { id = p + (nextId++); } while (used.has(id) || N.stations[id] || N.lines[id] || N.segments[id]);
      used.add(id);
      return id;
    };
    const stMap = new Map(), lnMap = new Map(), sgMap = new Map();
    // 同号对象可能是“这份草稿已经建成”，也可能是“另一份草稿从同一线网出发、拿到了相同编号”。
    // 前者按名称与位置认定为同一对象，跳过；后者重新编号，避免互相覆盖。
    const sameSt = function (a, b) { return !!a && !!b && Math.abs(+a.x - +b.x) < 1e-6 && Math.abs(+a.y - +b.y) < 1e-6 && a.type === b.type; };
    const sameLn = function (a, b) { return !!a && !!b && a.num === b.num && (a.root || '') === (b.root || ''); };
    const sameSg = function (a, b) { return !!a && !!b && a.a === b.a && a.b === b.b && a.line === b.line && a.type === b.type && JSON.stringify(a.pts || []) === JSON.stringify(b.pts || []); };
    const builtSt = new Set(), builtLn = new Set(), builtSg = new Set();
    for (const id in addSt) if (usedSt.has(id)) { if (sameSt(N.stations[id], addSt[id])) builtSt.add(id); else stMap.set(id, fresh('s', usedSt)); }
    for (const id in addLine) if (usedLn.has(id)) { if (sameLn(N.lines[id], addLine[id])) builtLn.add(id); else lnMap.set(id, fresh('l', usedLn)); }
    for (const id in addSg) if (usedSg.has(id)) { if (sameSg(N.segments[id], addSg[id])) builtSg.add(id); else sgMap.set(id, fresh('g', usedSg)); }
    const sid = function (id) { return stMap.get(id) || id; };
    const lid = function (id) { return lnMap.get(id) || id; };
    const gid = function (id) { return sgMap.get(id) || id; };
    const addedLines = new Set();
    for (const id in addLine) if (!builtLn.has(id)) addedLines.add(lid(id));

    // 1) 拆除：先轨道、再车站、最后线路，避免留下悬空引用；
    //    保存后又被改动或接入新轨道的对象不拆，只说明原因（不破坏玩家的新建设）
    for (const id in (del.segments || {})) {
      const cur = N.segments[id];
      if (!cur) continue;
      if (JSON.stringify(cur) !== del.segments[id]) { skipped.push('轨道「' + segLabel(N, id) + '」保存后已有改动，未拆除'); continue; }
      delete N.segments[id];
    }
    for (const id in (del.stations || {})) {
      const cur = N.stations[id];
      if (!cur) continue;
      if (JSON.stringify(cur) !== del.stations[id]) { skipped.push('车站「' + cur.name + '」保存后已有改动，未拆除'); continue; }
      if (segsAt(N, id).length) { skipped.push('车站「' + cur.name + '」保存后接入了新轨道，未拆除'); continue; }
      delete N.stations[id];
    }
    for (const id in (del.lines || {})) {
      const cur = N.lines[id];
      if (!cur) continue;
      if (M.lineSegs(N, id).length) { skipped.push('线路「' + cur.name + '」保存后又建了新轨道，未拆除'); continue; }
      delete N.lines[id];
    }

    // 2) 修改：只在对象与保存时完全一致时覆盖；保存后已经变化的对象保留现状
    for (const k of KINDS) {
      const list = mod[k] || {};
      for (const id in list) {
        const e = list[id], cur = N[k][id];
        if (!cur) continue;
        if (!e || !e.o || JSON.stringify(cur) !== e.was) { skipped.push(kindName[k] + '「' + label(k, (e && e.o) || cur) + '」保存后已变化，草稿中的调整未应用'); continue; }
        N[k][id] = M.clone(e.o);
      }
    }

    // 3) 新增：带上重新编好的编号，并同步各处引用（轨道的端点与线路、站台层、线路起点端）
    for (const id in addLine) {
      if (builtLn.has(id)) continue;
      const L = M.clone(addLine[id]), nid = lid(id);
      L.id = nid;
      if (L.root && stMap.has(L.root)) L.root = stMap.get(L.root);
      N.lines[nid] = L;
    }
    for (const id in addSt) {
      if (builtSt.has(id)) continue;
      const s = M.clone(addSt[id]), nid = sid(id);
      s.id = nid;
      if (s.lv) { const lv = {}; for (const key in s.lv) lv[lid(key)] = s.lv[key]; s.lv = lv; }
      if (s.pd) { const pd = {}; for (const key in s.pd) pd[lid(key)] = s.pd[key]; s.pd = pd; }
      N.stations[nid] = s;
    }
    for (const id in addSg) {
      if (builtSg.has(id)) continue;
      const s = M.clone(addSg[id]), nid = gid(id);
      s.id = nid; s.a = sid(s.a); s.b = sid(s.b); s.line = lid(s.line);
      if (!N.lines[s.line] || !N.stations[s.a] || !N.stations[s.b]) { skipped.push('轨道「' + segNameOf(N, s) + '」所依赖的线路或车站已被拆除，未加入'); continue; }
      N.segments[nid] = s;
    }

    // 4) 兜底：清掉引用了不存在对象的轨道（只可能来自上面重放的结果）
    for (const id in N.segments) {
      const s = N.segments[id];
      if (N.stations[s.a] && N.stations[s.b] && N.lines[s.line]) continue;
      skipped.push('轨道「' + segLabel(N, id) + '」无法并入当前线网，已移除');
      delete N.segments[id];
    }

    // 5) 番号冲突：保存后可能已建了同号线路，只改草稿新增的线路，已有线路不受影响
    const byNum = new Map();
    for (const id in N.lines) {
      const L = N.lines[id];
      if (L.num == null) continue;
      if (!byNum.has(L.num)) byNum.set(L.num, []);
      byNum.get(L.num).push(id);
    }
    byNum.forEach(function (ids, num) {
      if (ids.length < 2) return;
      for (let k = 1; k < ids.length; k++) {
        const id = ids[k];
        if (!addedLines.has(id)) continue;
        let free = 1;
        while (byNum.has(free)) free++;
        const L = N.lines[id], was = L.name;
        if (L.name === num + ' 号线') L.name = free + ' 号线';
        L.num = free;
        byNum.set(free, [id]);
        skipped.push('线路「' + was + '」的番号 ' + num + ' 已被占用，改为 ' + free + ' 号线');
      }
    });

    // 6) 编号游标：新增对象带着原有编号，游标要越过它们，之后新建不会再撞号
    let maxId = 0;
    for (const k of KINDS) for (const id in N[k]) { const n = M.idNum(id); if (Number.isFinite(n)) maxId = Math.max(maxId, n); }
    N.nextId = Math.max(N.nextId || 1, maxId + 1, nextId);

    return { net: N, skipped: skipped, changed: !same(N, net) };
  }

  function summarize(ev, dn, P) {
    const names = [];
    if (dn && dn.lines) for (const id in (P && P.add ? P.add.lines : {})) if (dn.lines[id]) names.push(dn.lines[id].name);
    for (const id of ev.affectedLines || []) { const L = dn && dn.lines ? dn.lines[id] : null; if (L && names.indexOf(L.name) < 0) names.push(L.name); }
    return {
      add: ev.changes.add.length, mod: ev.changes.mod.length, del: ev.changes.del.length,
      cost: Math.round(ev.total || 0), conflicts: ev.conflicts.length, lines: names.slice(0, 5),
    };
  }

  CM.Drafts = { MAX: MAX, sig: sig, plan: plan, apply: apply, summarize: summarize };

  // ==================== 游戏状态 ====================
  Game.prototype.findDraft = function (id) {
    const list = this.drafts || [];
    for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  };
  Game.prototype.nextDraftSeq = function () {
    let n = this.draftSeq || 0;
    for (const e of this.drafts || []) { const v = parseInt(String(e.id).replace(/^\D+/, ''), 10); if (Number.isFinite(v)) n = Math.max(n, v); }
    this.draftSeq = n;
    return n;
  };
  Game.prototype.nextDraftName = function () {
    const used = new Set((this.drafts || []).map(function (e) { return e.name; }));
    for (let n = 1; n < 999; n++) { const nm = '草案 ' + n; if (!used.has(nm)) return nm; }
    return '草案';
  };
  Game.prototype.draftStatus = function () {
    const d = this.draft;
    if (!d) return { has: false, saved: false, dirty: false, name: '' };
    const ent = d.savedId ? this.findDraft(d.savedId) : null;
    return { has: true, saved: !!ent, dirty: !ent || d.savedVer !== d.ver, name: ent ? ent.name : (d.name || ''), id: ent ? ent.id : null };
  };
  Game.prototype.draftDirty = function () {
    const d = this.draft;
    return !!d && (!d.savedId || d.savedVer !== d.ver);
  };
  // 保存草案：默认覆盖当前草案对应的草稿；asNew 时另存为新的一份
  Game.prototype.saveDraft = function (o) {
    o = o || {};
    const d = this.draft;
    if (!d) return { ok: false, error: '当前没有草案，先用建站、绘线等工具开始规划' };
    if (d.liveSnap) return { ok: false, error: '请先松开鼠标，再保存草稿' };
    if (this.jumping || this.pending) return { ok: false, error: '正在结算，请稍候再保存草稿' };
    const ev = this.draftEval();
    if (!ev.changed) return { ok: false, error: '草案还没有改动，暂时不需要保存' };
    this.drafts = this.drafts || [];
    let ent = null;
    if (!o.asNew) { const id = o.id || d.savedId; ent = id ? this.findDraft(id) : null; }
    if (!ent && this.drafts.length >= MAX) return { ok: false, error: '草稿已达 ' + MAX + ' 份上限，请先在「草稿」里删除不需要的草稿' };
    const rawName = String(o.name != null ? o.name : (ent ? ent.name : (d.name || ''))).trim().slice(0, NAME_MAX);
    const name = rawName || this.nextDraftName();
    const P = plan(this.net, d.net);
    const payload = {
      name: name,
      at: [this.clock.y, this.clock.m, this.clock.d],
      sum: summarize(ev, d.net, P),
      plan: P,
    };
    const updated = !!ent;
    if (ent) Object.assign(ent, payload);
    else {
      const seq = this.nextDraftSeq() + 1;
      this.draftSeq = seq;
      ent = Object.assign({ id: 'd' + seq, seq: seq }, payload);
      this.drafts.push(ent);
    }
    d.savedId = ent.id; d.savedVer = d.ver; d.name = name;
    this.idFloor = Math.max(this.idFloor || 0, d.net.nextId || 0);
    this.emit('drafts');
    this.emit('autosave', 'draft');
    return { ok: true, id: ent.id, name: name, updated: updated };
  };
  // 载入草稿：按当前正式线网重放这份草稿的改动，替换当前草案（草稿本身仍保留）
  Game.prototype.loadDraft = function (id) {
    const ent = this.findDraft(id);
    if (!ent) return { ok: false, error: '草稿不存在或已删除' };
    if (this.jumping || this.pending) return { ok: false, error: '正在结算，请稍候再载入草稿' };
    let r;
    try { r = CM.Drafts.apply(this.net, ent.plan); }
    catch (e) { console.error(e); return { ok: false, error: '载入草稿时出错：' + (e && e.message || e) }; }
    if (!r.changed) {
      if (r.skipped.length) return { ok: false, error: '草稿的改动无法应用：' + r.skipped[0] + (r.skipped.length > 1 ? '（共 ' + r.skipped.length + ' 项）' : ''), skipped: r.skipped };
      return { ok: false, error: '这份草稿的内容都已经建成（与当前线网一致）', empty: true };
    }
    const bad = M.validate(r.net);
    if (bad) return { ok: false, error: '草稿与当前线网无法合并：' + bad };
    this.model.cancelPredict();
    this.draft = { net: r.net, undo: [], redo: [], ver: 1, evalVer: -1, eval: null, compiled: null, compVer: -1, pred: { state: 'idle' }, savedId: ent.id, savedVer: 1, name: ent.name };
    this.idFloor = Math.max(this.idFloor || 0, r.net.nextId || 0);
    this.emit('draft');
    this.emit('drafts');
    this.emit('autosave', 'draft');
    return { ok: true, id: ent.id, name: ent.name, skipped: r.skipped, ent: ent };
  };
  Game.prototype.renameDraft = function (id, name) {
    const ent = this.findDraft(id);
    if (!ent) return { ok: false, error: '草稿不存在或已删除' };
    const v = String(name || '').trim().slice(0, NAME_MAX);
    if (!v) return { ok: false, error: '请填写草稿名称' };
    ent.name = v;
    if (this.draft && this.draft.savedId === id) this.draft.name = v;
    this.emit('drafts');
    this.emit('autosave', 'draft');
    return { ok: true, name: v };
  };
  Game.prototype.removeDraft = function (id) {
    const list = this.drafts || [];
    const k = list.findIndex(function (e) { return e.id === id; });
    if (k < 0) return { ok: false, error: '草稿不存在或已删除' };
    const ent = list.splice(k, 1)[0];
    // 当前草案是从这份草稿载入的：草稿没了，草案继续保留为未保存状态
    if (this.draft && this.draft.savedId === id) { this.draft.savedId = null; this.draft.savedVer = null; }
    this.emit('drafts'); this.emit('autosave', 'draft');
    return { ok: true, name: ent.name };
  };

  // ==================== 界面 ====================
  const money = function (v) { return U.fmtMoney(v || 0); };
  const atText = function (at) { return Array.isArray(at) && at.length ? at[0] + ' 年 ' + at[1] + ' 月' : '未知时间'; };
  // v3.8：资金不受限的两种情形（自由建造 / 开启无限贷款）不按资金限制草稿，可用资金视为不限
  const available = function (g) { return g.econ.isSandbox() ? Infinity : Math.max(0, g.econ.funds) + Math.max(0, g.econ.capex); };
  // 资金说明：自由建造完全不记账；无限贷款仍记账但可以透支建设
  const sandboxFund = function (g) {
    if (!g.econ.isSandbox()) return null;
    return g.econ.isInfinite() ? '无限贷款，资金不足也可建设' : '自由建造，资金不限';
  };
  const nChanges = function (ev) { return ev.changes.add.length + ev.changes.mod.length + ev.changes.del.length; };

  // 多按钮选择框（保存再切换、直接放弃、取消这类三选一）
  UI.prototype.askChoice = function (title, text, buttons, icon) {
    const self = this;
    const prevCls = this.screen.className;
    const prev = prevCls.indexOf('hidden') >= 0 ? null : Array.from(this.screen.childNodes);
    const prevEsc = this.screenEsc;
    const restore = function () {
      if (prev) { self.screen.innerHTML = ''; self.screen.className = prevCls + ' noanim'; prev.forEach(function (n) { self.screen.appendChild(n); }); self.screenEsc = prevEsc; }
      else self.closeScreen();
    };
    const acts = h('div', { class: 'modal-actions' });
    for (const b of buttons || []) {
      acts.appendChild(h('button', { class: 'btn ' + (b.cls || ''), onclick: function () { restore(); if (b.fn) b.fn(); } }, b.label));
    }
    const card = h('div', { class: 'card' }, this.cardHead(icon || 'help', 'b-blue', title), h('div', { class: 'note', style: { fontSize: '13px' } }, text), acts);
    this.openScreen(card, restore);
  };

  UI.prototype.draftNameDialog = function (o) {
    o = o || {};
    const self = this;
    const prevCls = this.screen.className;
    const prev = prevCls.indexOf('hidden') >= 0 ? null : Array.from(this.screen.childNodes);
    const prevEsc = this.screenEsc;
    const restore = function () {
      if (prev) { self.screen.innerHTML = ''; self.screen.className = prevCls + ' noanim'; prev.forEach(function (n) { self.screen.appendChild(n); }); self.screenEsc = prevEsc; }
      else self.closeScreen();
    };
    const input = h('input', { class: 'drf-in', type: 'text', maxlength: String(NAME_MAX), value: String(o.value || ''), placeholder: '例如：3 号线北延', 'aria-label': '草稿名称' });
    const err = h('div', { class: 'tiny bad', style: { minHeight: '16px' } });
    const ok = function () {
      const v = input.value.trim().slice(0, NAME_MAX);
      if (!v) { err.textContent = '请填写草稿名称'; try { input.focus(); } catch (e) { /* 忽略 */ } return; }
      restore(); o.onOk && o.onOk(v);
    };
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); ok(); } });
    const card = h('div', { class: 'card' },
      this.cardHead(o.icon || 'save', 'b-teal', o.title || '保存草稿'),
      h('div', { class: 'note', style: { fontSize: '13px' } }, o.note || '草稿只保存规划，不扣费、不改变正式线网。'),
      h('div', { class: 'field' }, h('label', null, '草稿名称'), input), err,
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn', onclick: restore }, '取消'), h('button', { class: 'btn primary', onclick: ok }, o.okLabel || '保存')));
    this.openScreen(card, restore);
    setTimeout(function () { try { input.focus(); input.select(); } catch (e) { /* 忽略 */ } }, 30);
  };

  // 写入草稿并给出提示；o 透传给 Game.saveDraft
  UI.prototype._writeDraft = function (o) {
    const g = this.g(); if (!g) return false;
    const r = g.saveDraft(o || {});
    if (!r.ok) { this.toast(r.error, 'bad'); return false; }
    this.toast(r.updated ? '已更新草稿「' + nm(r.name) + '」' : '已保存为草稿「' + nm(r.name) + '」', 'good');
    this.renderDraftbar();
    if (this.topIs(['drafts', 'build'])) this.rerenderPage();
    return true;
  };
  // 不打断当前操作的保存（放弃草案、切换草稿前用）：首次保存用自动名称，之后可改名
  UI.prototype._quickSaveDraft = function () {
    const g = this.g();
    if (!g || !g.draft) return false;
    if (!g.draftEval().changed) return true;
    return this._writeDraft({});
  };
  UI.prototype.saveDraft = function (o) {
    o = o || {};
    const g = this.g(); if (!g) return;
    if (!g.draft) { this.toast('当前没有草案：先用建站、绘线等工具规划，再保存', 'info'); return; }
    if (!g.draftEval().changed) { this.toast('草案还没有改动，暂时不需要保存', 'info'); return; }
    const st = g.draftStatus();
    if (!st.saved || o.asNew) {
      this.draftNameDialog({
        title: o.asNew ? '另存为新草稿' : '保存草稿',
        note: o.asNew ? '当前草案会另存为一份新草稿，原来的草稿保持不变。' : '草稿只保存规划，不扣费、不改变正式线网；资金不足时也可以先存下来，之后再载入。',
        value: o.asNew ? g.nextDraftName() : (g.draft.name || g.nextDraftName()),
        okLabel: o.asNew ? '另存为' : '保存草稿',
        onOk: function (name) { this._writeDraft({ name: name, asNew: !!o.asNew }); }.bind(this),
      });
      return;
    }
    this._writeDraft({});
  };
  UI.prototype.loadDraft = function (id) {
    const g = this.g(), self = this;
    const ent = g && g.findDraft(id); if (!ent) return;
    const go = function () {
      const r = g.loadDraft(id);
      if (!r.ok) { self.toast(r.error, 'bad'); return; }
      self.tools.chain = null; self.tools.bends = []; self.hoverConflict = null;
      self.selection = null; self.multi = null;
      self._draftNote = r.skipped && r.skipped.length
        ? { title: '草稿已载入，但有 ' + r.skipped.length + ' 项改动未应用', lines: r.skipped.slice(0, 8), bad: true }
        : { title: '草稿已载入：' + (r.ent.sum ? r.ent.sum.add + ' 项新建、' + r.ent.sum.mod + ' 项修改、' + r.ent.sum.del + ' 项拆除' : '可继续规划'), lines: [], bad: false };
      self.renderDraftbar();
      // 把镜头带到草稿新增的车站附近，便于接着规划
      const pts = [];
      for (const sid in g.draft.net.stations) if (!g.net.stations[sid]) pts.push(g.draft.net.stations[sid]);
      if (pts.length) self.flyToStations(pts);
      self.toast('已载入草稿「' + nm(r.name) + '」' + (r.skipped.length ? '，' + r.skipped.length + ' 项未应用' : ''), r.skipped.length ? 'info' : 'good');
      self.rerenderPage();
    };
    if (g.draft && g.draftDirty() && g.draftEval().changed) {
      this.askChoice('载入草稿「' + nm(ent.name) + '」？', '当前草案还有未保存的修改（' + nChanges(g.draftEval()) + ' 项）。载入草稿会用它替换当前草案。', [
        { label: '保存当前草案再载入', cls: 'primary', fn: function () { if (self._quickSaveDraft()) go(); } },
        { label: '放弃当前修改', cls: 'danger', fn: go },
        { label: '取消' },
      ], 'folder');
      return;
    }
    go();
  };
  UI.prototype.renameDraft = function (id) {
    const g = this.g(), self = this;
    const ent = g && g.findDraft(id); if (!ent) return;
    this.draftNameDialog({
      title: '重命名草稿', note: '名称只用于区分草稿，不影响建设内容。', value: ent.name, okLabel: '保存名称', icon: 'pencil',
      onOk: function (name) {
        const r = g.renameDraft(id, name);
        if (!r.ok) { self.toast(r.error, 'bad'); return; }
        self.renderDraftbar(); self.rerenderPage();
      },
    });
  };
  UI.prototype.deleteDraft = function (id) {
    const g = this.g(), self = this;
    const ent = g && g.findDraft(id); if (!ent) return;
    this.confirm('删除草稿「' + nm(ent.name) + '」？', '只删除这份草稿；正式线网与当前草案都不受影响。', '删除草稿', function () {
      const r = g.removeDraft(id);
      if (!r.ok) { self.toast(r.error, 'bad'); return; }
      self.toast('已删除草稿「' + nm(r.name) + '」', 'info');
      self.renderDraftbar(); self.rerenderPage();
    }, true, 'trash');
  };
  // 新建空草案：已有草案时先处理未保存的修改
  UI.prototype.newDraft = function () {
    const g = this.g(), self = this;
    if (!g) return;
    const start = function () {
      if (g.draft) g.cancelDraft();
      g.ensureDraft();
      self.tools.chain = null; self.tools.bends = []; self.selection = null; self.multi = null; self.hoverConflict = null;
      self.renderDraftbar();
      self.openPage('build', null, { root: true });
      self.toast('已新建空草案：可随时保存为草稿', 'info');
    };
    if (g.draft && g.draftDirty() && g.draftEval().changed) {
      this.askChoice('开始新的草案？', '当前草案还有未保存的修改（' + nChanges(g.draftEval()) + ' 项）。', [
        { label: '保存后新建', cls: 'primary', fn: function () { if (self._quickSaveDraft()) start(); } },
        { label: '放弃当前修改', cls: 'danger', fn: start },
        { label: '取消' },
      ], 'pencil');
      return;
    }
    start();
  };

  // ---------------- 草稿库页面 ----------------
  UI.prototype.page_drafts = function () {
    const g = this.g(), self = this;
    const el = h('div', { class: 'drf-page' });
    el.appendChild(h('div', { class: 'note' }, '草稿保存的是尚未确认的建设草案：保存与载入都不扣费，也不会改变正式线网与客流。可以同时保存多份，随时切换。'));

    if (this._draftNote) {
      const n = this._draftNote;
      el.appendChild(h('div', { class: 'callout ' + (n.bad ? 'warn' : 'info') },
        ic(n.bad ? 'warn' : 'info'),
        h('div', { class: 'ct' }, h('b', null, n.title), n.lines && n.lines.length ? h('div', { class: 'drf-note-lines tiny' }, n.lines.map(function (t) { return h('div', null, '· ' + t); })) : null)));
    }

    // 当前草案
    const st = g.draftStatus();
    const curSum = !g.draft ? '' : (st.saved ? (st.dirty ? '已保存为「' + nm(st.name) + '」，又有新修改' : '已保存为「' + nm(st.name) + '」') : '尚未保存');
    el.appendChild(this.sec('drf-cur', '当前草案', curSum, function () {
      const box = h('div');
      if (!g.draft) {
        box.append(
          h('div', { class: 'note' }, '当前没有草案。用底部的「建站」「绘线」「拆除」等工具开始规划，改动会先进入草案，确认建设后才扣费。'),
          h('div', { class: 'row', style: { marginTop: '8px', flexWrap: 'wrap' } },
            h('button', { class: 'btn sm', onclick: function () { self.newDraft(); } }, ic('pencil'), '新建空草案'),
            g.drafts.length ? h('button', { class: 'btn sm', onclick: function () { self.flyToDrafts(); } }, ic('folder'), '查看下方草稿') : null));
        return box;
      }
      const ev = g.draftEval(), can = g.canConfirm(), n = nChanges(ev);
      const kv = function (k, v, cls) { return h('div', { class: 'drf-kv-row' }, h('span', { class: 'drf-k' }, k), h('span', { class: 'drf-v ' + (cls || '') }, v)); };
      box.appendChild(h('div', { class: 'drf-kv' },
        kv('改动', ev.changed ? n + ' 项（新建 ' + ev.changes.add.length + ' · 修改 ' + ev.changes.mod.length + ' · 拆除 ' + ev.changes.del.length + '）' : '暂无改动'),
        kv('造价', money(ev.total)),
        kv('冲突', ev.conflicts.length ? ev.conflicts.length + ' 处，需先解决' : '无', ev.conflicts.length ? 'bad' : 'good'),
        kv('资金', can.ok ? '充足，可立即确认建设' : can.reason, can.ok ? 'good' : 'warn'),
        kv('保存状态', st.saved ? (st.dirty ? '已保存为「' + nm(st.name) + '」，此后又有修改' : '已保存为「' + nm(st.name) + '」') : '尚未保存为草稿')));
      box.appendChild(h('div', { class: 'row', style: { marginTop: '10px', flexWrap: 'wrap' } },
        h('button', { class: 'btn sm primary', onclick: function () { self.saveDraft(); }, disabled: !ev.changed }, ic('save'), st.saved && !st.dirty ? '更新草稿' : '保存草稿'),
        st.saved ? h('button', { class: 'btn sm', onclick: function () { self.saveDraft({ asNew: true }); } }, '另存为新草稿') : null,
        h('button', { class: 'btn sm', onclick: function () { self.openPage('build', null, { root: true }); } }, ic('hammer'), '打开建设草案'),
        h('button', { class: 'btn sm ghost danger', onclick: function () { self.discardDraft(); } }, '放弃草案')));
      return box;
    }, true, 'pencil'));

    // 已保存的草稿
    const list = (g.drafts || []).slice().sort(function (a, b) { return (b.seq || 0) - (a.seq || 0); });
    el.appendChild(this.sec('drf-list', '已保存的草稿', list.length ? list.length + ' 份' : '暂无', function () {
      const box = h('div');
      if (!list.length) {
        box.appendChild(h('div', { class: 'note' }, '还没有保存过草稿。做出改动后按草案栏的保存按钮，或在上方点「保存草稿」。'));
        return box;
      }
      const avail = available(g), sb = sandboxFund(g);
      list.forEach(function (ent) {
        const s = ent.sum || {};
        const on = g.draft && g.draft.savedId === ent.id;
        const cost = s.cost || 0;
        const fund = sb ? sb : (avail >= cost ? '资金充足（可用 ' + money(avail) + '）' : '还差 ' + money(cost - avail) + '（当前可用 ' + money(avail) + '）');
        const card = h('div', { class: 'drf-card' + (on ? ' on' : '') },
          h('div', { class: 'drf-top' },
            h('b', { 'data-no-i18n': '' }, ent.name),
            on ? h('span', { class: 'tag info' }, '当前草案') : null,
            h('span', { class: 'grow' }),
            h('span', { class: 'tiny muted' }, '保存于 ' + atText(ent.at))),
          h('div', { class: 'tiny' }, '新建 ' + (s.add || 0) + ' · 修改 ' + (s.mod || 0) + ' · 拆除 ' + (s.del || 0) + (s.conflicts ? ' · 保存时 ' + s.conflicts + ' 处冲突' : '')),
          s.lines && s.lines.length ? h('div', { class: 'drf-lines' }, s.lines.map(function (nm) { return h('span', { class: 'tag' }, nm); })) : null,
          h('div', { class: 'drf-money tiny' }, h('span', null, '保存时造价 ' + money(cost)), h('span', { class: 'drf-fund ' + (sb || avail >= cost ? 'good' : 'warn') }, fund)),
          h('div', { class: 'row', style: { marginTop: '8px', flexWrap: 'wrap' } },
            h('button', { class: 'btn sm primary', onclick: function () { self.loadDraft(ent.id); } }, ic('import'), '载入'),
            h('button', { class: 'btn sm', onclick: function () { self.renameDraft(ent.id); } }, ic('pencil'), '改名'),
            h('button', { class: 'btn sm ghost danger', onclick: function () { self.deleteDraft(ent.id); } }, ic('trash'), '删除')));
        box.appendChild(card);
      });
      if (list.length >= MAX) box.appendChild(h('div', { class: 'note' }, '已达到 ' + MAX + ' 份上限；保存新草稿前请先删除不需要的草稿。'));
      return box;
    }, true, 'folder'));

    el.appendChild(h('div', { class: 'note', style: { marginTop: '10px' } },
      h('b', null, '流程：'),
      h('div', null, '1. 用建站、绘线等工具规划，改动先进入草案；'),
      h('div', null, '2. 按「保存草稿」存下当前草案（可改名，可另存为新草稿）；'),
      h('div', null, '3. 去处理别的事、推进时间积累资金，或开始另一个草案；'),
      h('div', null, '4. 回到这里按「载入」，草稿会合并到当前线网，继续规划或确认建设。')));
    el.appendChild(h('div', { class: 'note', style: { marginTop: '6px' } }, '草稿会跟随本局进度一起保存。载入时以当前正式线网为基础，只补上草稿里尚未建成的部分：保存草稿之后新建的线路与车站不会被撤销；若草稿中的某个对象在此期间已经变化，会跳过这一项并在此说明。'));
    return { title: '建设草稿', el: el };
  };
  // 草稿页里没有地图镜头可飞，滚到列表即可
  UI.prototype.flyToDrafts = function () {
    const el = this.rBody && this.rBody.querySelector('.drf-card');
    if (el) { try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { el.scrollIntoView(); } }
  };
})(window.CM);
