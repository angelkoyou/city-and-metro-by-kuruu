// 建设草稿回归：保存 / 载入 / 切换 / 改名 / 删除，草稿不会因新建草案而丢失，
// 载入按当前线网重放（不撤销保存后建成的线路），对象已变化时跳过并说明，随存档往返。
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const root = new URL('../', import.meta.url), memory = new Map();
const c = {
  console, performance, atob, btoa, TextEncoder, TextDecoder, setTimeout, clearTimeout,
  navigator: { hardwareConcurrency: 4, deviceMemory: 4 },
  matchMedia: () => ({ matches: false }),
  localStorage: {
    getItem: k => memory.get(k) ?? null,
    setItem: (k, v) => memory.set(k, String(v)),
    removeItem: k => memory.delete(k),
  },
};
c.window = c;
vm.createContext(c);
const load = async src => vm.runInContext(await readFile(new URL(src, root), 'utf8'), c, { filename: src });
for (const [, src] of (await readFile(new URL('index.html', root), 'utf8')).matchAll(/<script src="([^"]+)"/g)) {
  await load(src);
  if (src === 'js/save.js') break;
}
const C = c.CM, M = C.Metro;
C.UI = function () {};
for (const src of ['icons', 'settings', 'corp', 'fleet', 'screens', 'timeline', 'drafts']) await load('js/' + src + '.js');
assert.ok(C.Drafts, '建设草稿模块已注册');

C.useMap('tutorial');
const g = C.Game.create({ mode: 'free', tutorial: true, seed: 20261112 });
const net0 = JSON.stringify(g.net);
assert.equal(Array.isArray(g.drafts), true, '开局有草稿列表');
assert.equal(g.drafts.length, 0);
assert.equal(g.draft, null, '开局没有草案');

// 在草案里新建一条带两站一段轨道的线路
function addLine(num, x, y) {
  let ids = null;
  const r = g.edit(function (n) {
    const lid = M.newLine(n, null, { num: num });
    const a = M.addStation(n, x, y, { size: 'M' }, g.city);
    const b = M.addStation(n, x + 0.9, y, { size: 'M' }, g.city);
    n.stations[a].name = '甲' + num; n.stations[b].name = '乙' + num;
    const sg = M.addSegment(n, lid, a, b, [], 'underground').id;
    ids = { lid: lid, a: a, b: b, sg: sg };
    return { ok: true };
  });
  assert.ok(!r.error, '草案编辑成功：' + (r.error || ''));
  return ids;
}
const A = addLine(8, 10.5, 10.5);
const fundsBefore = g.econ.funds;

// ---------- 1. 保存：只记录改动，不改变正式线网与资金 ----------
let r = g.saveDraft({ name: '北线草案' });
assert.ok(r.ok, '保存成功：' + (r.error || ''));
assert.equal(r.updated, false, '第一次保存是新建');
assert.equal(g.drafts.length, 1);
const dA = g.drafts[0];
assert.equal(dA.name, '北线草案');
assert.equal(dA.seq, 1);
assert.equal(dA.at[0], g.clock.y, '记下保存时的年月');
assert.equal(Object.keys(dA.plan.add.lines).length, 1, '清单里有一条新线');
assert.equal(Object.keys(dA.plan.add.stations).length, 2, '清单里有两座新站');
assert.equal(Object.keys(dA.plan.add.segments).length, 1, '清单里有一段新轨道');
assert.equal(dA.sum.add, 4, '摘要把新线、两座新站与新轨道都算作新建');
assert.ok(dA.sum.cost >= 0 && Number.isFinite(dA.sum.cost));
assert.deepEqual(Array.from(dA.sum.lines), ['8 号线'], '摘要带线路名');
assert.equal(JSON.stringify(g.net), net0, '保存草稿不改变正式线网');
assert.equal(g.econ.funds, fundsBefore, '保存草稿不扣费');
assert.equal(g.draft.savedId, dA.id, '当前草案记住对应的草稿');
assert.equal(g.draftStatus().dirty, false, '刚保存的草案没有未保存修改');

// 清单是副本：之后继续编辑草案不会改写已保存的内容
g.edit(function (n) { n.stations[A.a].name = '甲8（改名）'; });
assert.equal(dA.plan.add.stations[A.a].name, '甲8', '已保存的清单不会被后续编辑改写');
assert.equal(g.draftStatus().dirty, true, '草案有未保存的修改');
r = g.saveDraft();
assert.ok(r.ok && r.updated, '再次保存覆盖同一份草稿');
assert.equal(g.drafts.length, 1, '覆盖不会新增草稿');
assert.equal(g.drafts[0].plan.add.stations[A.a].name, '甲8（改名）', '覆盖后清单更新');
assert.equal(g.draftStatus().dirty, false);

// ---------- 2. 新建草案不会丢草稿；草稿仍可载入 ----------
g.cancelDraft();
assert.equal(g.draft, null);
assert.equal(g.drafts.length, 1, '放弃当前草案后草稿仍在');
const B = addLine(9, 10.5, 12.5);
r = g.saveDraft({ name: '东西线' });
assert.ok(r.ok, '第二份草稿保存成功');
assert.equal(g.drafts.length, 2, '可以同时保存多份');
assert.notEqual(g.drafts[0].id, g.drafts[1].id, '草稿 id 不重复');
g.cancelDraft();
assert.equal(g.drafts.length, 2, '草稿不会因新建 / 放弃草案而丢失');

r = g.loadDraft(dA.id);
assert.ok(r.ok, '载入草稿成功：' + (r.error || ''));
assert.equal(g.draft.savedId, dA.id, '载入后草案对应这份草稿');
assert.equal(g.draftStatus().dirty, false, '载入的草稿是干净状态');
const names = function (n) { return Object.values(n.stations).map(function (s) { return s.name; }); };
assert.ok(names(g.draft.net).indexOf('甲8（改名）') >= 0 && names(g.draft.net).indexOf('乙8') >= 0, '载入的草案包含草稿里的车站');
assert.ok(names(g.draft.net).indexOf('甲9') < 0, '不会带入另一份草稿的内容');
assert.equal(JSON.stringify(g.net), net0, '载入草稿不改变正式线网');

// ---------- 3. 载入按当前线网重放：保存后建成的线路不会被撤销 ----------
// 先把「东西线」草稿真正建成
r = g.loadDraft(g.drafts[1].id);
assert.ok(r.ok, '载入第二份草稿');
const conf = g.confirmDraft();
assert.ok(conf.ok, '确认建设成功：' + (conf.reason || ''));
assert.ok(g.net.stations[B.a] && g.net.stations[B.b], '第二份草稿已建成');
assert.equal(g.draft, null);
assert.equal(g.drafts.length, 2, '建成后草稿仍然保留');
// 再载入较早保存的第一份草稿：它保存时还没有东西线
r = g.loadDraft(dA.id);
assert.ok(r.ok, '在正式线网变化后仍可载入草稿');
assert.ok(names(g.draft.net).indexOf('甲8（改名）') >= 0, '草稿中的新站加回来了');
assert.ok(names(g.draft.net).indexOf('甲9') >= 0, '保存草稿之后建成的车站不会被撤销');
assert.ok(Object.values(g.draft.net.segments).some(function (s) { return s.id === B.sg; }), '保存草稿之后建成的轨道不会被撤销');
const ids8 = Object.values(g.draft.net.stations).filter(function (s) { return s.name === '甲8（改名）' || s.name === '乙8'; }).map(function (s) { return s.id; });
const ids9 = Object.values(g.draft.net.stations).filter(function (s) { return s.name === '甲9' || s.name === '乙9'; }).map(function (s) { return s.id; });
assert.equal(new Set(ids8.concat(ids9)).size, 4, '两份草稿从同一线网出发、编号相同时，载入会重新编号，不会互相覆盖');
assert.equal(g.draftEval().changes.add.filter(function (t) { return t.indexOf('乙9') >= 0; }).length, 0, '已建成的部分不再计入新建');
// 已建成的草稿再载入：没有可重放的改动
const built = g.drafts[1];
g.cancelDraft();
r = g.loadDraft(built.id);
assert.equal(r.ok, false);
assert.equal(r.empty, true, '已建成的草稿不会生成空草案');

// ---------- 4. 对象在保存后变化：跳过该项并说明，保留正式线网 ----------
g.cancelDraft();
// 草稿 C：把已建成的乙9 站改名（修改），同时新增一座车站（保证仍有可应用的改动）
g.edit(function (n) {
  n.stations[B.b].name = '草稿改名';
  const s = M.addStation(n, 10.5, 10.5, { size: 'M' }, g.city);
  n.stations[s].name = '草稿新站';
});
r = g.saveDraft({ name: '改名方案' });
assert.ok(r.ok);
const dC = g.drafts[g.drafts.length - 1];
assert.equal(Object.keys(dC.plan.mod.stations).length, 1, '清单里记录一处车站修改');
assert.equal(Object.keys(dC.plan.add.stations).length, 1, '清单里记录一座新增车站');
// 正式网络里同一座车站又被改了名
g.cancelDraft();
g.edit(function (n) { n.stations[B.b].name = '正式改名'; });
assert.ok(g.confirmDraft().ok);
r = g.loadDraft(dC.id);
assert.ok(r.ok, '部分改动仍可载入：' + (r.error || ''));
assert.ok(r.skipped.length >= 1, '有未应用的改动');
assert.ok(r.skipped.join('；').indexOf('草稿改名') >= 0 || r.skipped.join('；').indexOf('乙9') >= 0, '说明里指出是哪座车站：' + r.skipped.join('；'));
assert.equal(g.draft.net.stations[B.b].name, '正式改名', '保存后的正式改动不被草稿覆盖');
assert.notEqual(g.draft.net.stations[B.b].name, '草稿改名');
assert.ok(names(g.draft.net).indexOf('草稿新站') >= 0, '其余改动照常应用');

// ---------- 5. 删除在保存后已变化的物体：不拆，保留玩家后来的建设 ----------
g.cancelDraft();
g.edit(function (n) {
  M.removeSegment(n, B.sg);
  const s = M.addStation(n, 10.5, 14.5, { size: 'M' }, g.city);
  n.stations[s].name = '拆除测试站';
});
r = g.saveDraft({ name: '拆东西线' });
assert.ok(r.ok);
const dD = g.drafts[g.drafts.length - 1];
assert.equal(Object.keys(dD.plan.del.segments).length, 1, '清单里记录一段拆除');
g.cancelDraft();
// 正式网络里把这段轨道改成曲线（等价于之后又改动过）
g.edit(function (n) { n.segments[B.sg].curve = 'arc'; });
assert.ok(g.confirmDraft().ok);
r = g.loadDraft(dD.id);
assert.ok(r.ok, '其余改动照常载入：' + (r.error || ''));
assert.ok(g.draft.net.segments[B.sg], '保存后被改动过的轨道不按草稿拆除');
assert.ok(r.skipped.join('；').indexOf('未拆除') >= 0, '说明里给出未拆除的原因：' + r.skipped.join('；'));

// ---------- 6. 番号冲突：只给草稿新增的线路改号，不碰已有线路 ----------
const g3 = C.Game.create({ mode: 'free', tutorial: true, seed: 20261113 });
let ids3 = null;
const r3 = g3.edit(function (n) {
  const lid = M.newLine(n, null, { num: 12 });
  const a = M.addStation(n, 10.5, 10.5, { size: 'M' }, g3.city);
  const b = M.addStation(n, 11.4, 10.5, { size: 'M' }, g3.city);
  n.stations[a].name = '丙'; n.stations[b].name = '丁';
  const sg = M.addSegment(n, lid, a, b, [], 'underground').id;
  ids3 = { lid: lid, sg: sg };
  return { ok: true };
});
assert.ok(!r3.error);
assert.ok(g3.saveDraft({ name: '三号线方案' }).ok);
const dE = g3.drafts[0];
g3.cancelDraft();
// 正式建一条同样是 3 号线的线路
g3.edit(function (n) {
  const lid = M.newLine(n, null, { num: 12 });
  const a = M.addStation(n, 10.5, 12.5, { size: 'M' }, g3.city);
  const b = M.addStation(n, 11.4, 12.5, { size: 'M' }, g3.city);
  M.addSegment(n, lid, a, b, [], 'underground');
  return { ok: true };
});
assert.ok(g3.confirmDraft().ok);
r = g3.loadDraft(dE.id);
assert.ok(r.ok, '番号冲突时仍可载入：' + (r.error || ''));
const realLine = Object.values(g3.net.lines).filter(function (L) { return L.num === 12; })[0];
assert.ok(realLine, '正式线网有 12 号线');
const dNet = g3.draft.net;
assert.equal(dNet.lines[realLine.id].num, 12, '正式线网的 12 号线不受影响');
const addedLine = Object.values(dNet.lines).filter(function (L) { return L.id !== realLine.id; });
assert.equal(addedLine.length, 1, '草稿新增的线路仍在');
assert.notEqual(addedLine[0].num, 12, '草稿新增的线路已改号');
assert.ok(addedLine[0].num >= 1 && addedLine[0].num <= 999, '改号后仍是合法番号');
const addedSegs = Object.values(dNet.segments).filter(function (s) { return s.line === addedLine[0].id; });
assert.ok(addedSegs.length >= 1, '草稿的轨道仍在新增线路上');
assert.ok(addedSegs.every(function (s) { return dNet.stations[s.a] && dNet.stations[s.b]; }), '轨道的端点车站都存在');
assert.equal(Object.values(dNet.segments).filter(function (s) { return s.line === realLine.id; }).length, 1, '没有把草稿的轨道并进正式线路');
assert.ok(r.skipped.join('；').indexOf('番号') >= 0, '说明里提到番号冲突：' + r.skipped.join('；'));
// 线网仍然合法
assert.equal(M.validate(g3.draft.net), null, '载入后的草案线网结构合法');

// ---------- 7. 页面与名称：默认名称、改名、删除 ----------
assert.equal(g3.nextDraftName(), '草案 1', '默认名称避开已用名称');
assert.ok(g3.renameDraft(dE.id, '三号线（改名）').ok);
assert.equal(g3.findDraft(dE.id).name, '三号线（改名）');
assert.equal(g3.draft.name, '三号线（改名）', '当前草案的名称随草稿更新');
const beforeDel = g3.drafts.length;
assert.ok(g3.removeDraft(dE.id).ok);
assert.equal(g3.drafts.length, beforeDel - 1, '删除一份草稿');
assert.equal(g3.draft.savedId, null, '删除后当前草案变为未保存');
assert.equal(g3.draftStatus().saved, false);
assert.ok(g3.draft.net, '当前草案内容不受删除影响');

// ---------- 8. 份数上限 ----------
const limitGame = C.Game.create({ mode: 'free', tutorial: true, seed: 20261114 });
for (let i = 0; i < C.Drafts.MAX; i++) limitGame.drafts.push({ id: 'x' + i, name: '占位 ' + i, plan: { add: {}, mod: {}, del: {} }, sum: null });
limitGame.edit(function (n) { const a = M.addStation(n, 10.5, 10.5, { size: 'M' }, limitGame.city); n.stations[a].name = '上限站'; return { ok: true }; });
r = limitGame.saveDraft({ name: '超额' });
assert.equal(r.ok, false);
assert.ok(r.error.indexOf(String(C.Drafts.MAX)) >= 0, '达到上限时给出明确提示：' + r.error);

// ---------- 9. 随存档往返：草稿列表与当前草案都保留 ----------
const snap = JSON.parse(JSON.stringify(g.serialize()));
assert.ok(Array.isArray(snap.drafts) && snap.drafts.length >= 3, '存档里带草稿列表');
assert.ok(snap.activeDraft && snap.activeDraft.net, '存档里带当前草案');
const g4 = C.Game.restore(snap);
assert.equal(g4.drafts.length, g.drafts.length, '读档后草稿数量一致');
assert.equal(g4.drafts[0].name, g.drafts[0].name);
assert.equal(Object.keys(g4.drafts[0].plan.add.stations).length, Object.keys(g.drafts[0].plan.add.stations).length, '清单内容保留');
assert.ok(g4.draft, '当前草案随存档恢复');
assert.equal(g4.draft.net.stations[B.b].name, g.draft.net.stations[B.b].name, '草案内容一致');
assert.equal(g4.draft.savedId, g.draft.savedId, '保存状态一致');
assert.equal(g4.draftStatus().dirty, g.draftStatus().dirty);
assert.equal(g4.draftSeq, g.draftSeq, '草稿序号恢复，之后新建不会撞 id');
// 读档后的草稿仍然可以载入
const target = g4.drafts[0];
g4.cancelDraft();
const rr = g4.loadDraft(target.id);
assert.ok(rr.ok, '读档后载入草稿成功：' + (rr.error || ''));
assert.equal(M.validate(g4.draft.net), null, '读档后载入的草案线网合法');

// 旧存档没有草稿字段：读档为空，不报错
const legacy = JSON.parse(JSON.stringify(g4.serialize()));
delete legacy.drafts; delete legacy.activeDraft;
const g5 = C.Game.restore(legacy);
assert.deepEqual(Array.from(g5.drafts), [], '旧存档没有草稿');
assert.equal(g5.draft, null, '旧存档没有当前草案');
assert.equal(g5.serialize().drafts, undefined, '没有草稿时不写空字段');

// 结构损坏的当前草案被丢弃，正式进度不受影响
const broken = JSON.parse(JSON.stringify(g4.serialize()));
broken.activeDraft.net.segments['bad'] = { id: 'bad', a: 'nothere', b: 'nothere2', line: 'noline' };
const g6 = C.Game.restore(broken);
assert.equal(g6.draft, null, '无法校验收到的草案被丢弃');

console.log('test-drafts: all assertions passed');
