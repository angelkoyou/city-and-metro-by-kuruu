// 同一换乘站的站台之间禁止铺设轨道：只拦本次新增的组内直连段，其它连线能力完全保留
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
const C = c.CM;
C.UI = function () {};
for (const src of ['settings', 'corp', 'fleet', 'screens']) await load('js/' + src + '.js');
C.useMap('tutorial');
const g = C.Game.create({ mode: 'free', tutorial: true, seed: 20000101 });
const M = C.Metro, ERR = C.Game.XFER_LINK_ERROR;
assert.equal(typeof ERR, 'string', '错误文案常量存在');
assert.ok(ERR.length > 0);

// 建 6 座站台：A/B/C 用于换乘组，D 独立，E/F 靠得很近但没有任何换乘关系
const addSt = (id, name, x, y, year) => {
  g.net.stations[id] = { id: id, name: name, x: x, y: y, size: 'M', type: 'underground', built: [year, 1] };
  return id;
};
const A = addSt('xA', '甲', 10.5, 10.5, 2000);
const B = addSt('xB', '乙', 11.2, 10.5, 2001);
const Cc = addSt('xC', '丙', 12.0, 10.5, 2002);
const D = addSt('xD', '丁', 20.5, 20.5, 2003);
const E = addSt('xE', '戊', 11.9, 10.5, 2004);   // 与 C 很近，但没有手动换乘关系
const F = addSt('xF', '己', 12.6, 10.5, 2005);
const MID = addSt('xM', '中间站', 25.5, 25.5, 2006);
const L1 = M.newLine(g.net, null, { num: 1 });
const L2 = M.newLine(g.net, null, { num: 2 });
const L3 = M.newLine(g.net, null, { num: 3 });
const keyAB = C.Game.walkXferKey(A, B), keyBC = C.Game.walkXferKey(B, Cc);

const netNow = () => g.draft ? g.draft.net : g.net;
const segCount = () => Object.keys(netNow().segments).length;
const hasSeg = (line, a, b) => !!M.findSeg(netNow(), line, a, b);
const reset = () => { if (g.draft) g.cancelDraft(); };
const errIsXfer = r => !!(r && r.error === ERR);

// ---------- 1. 判定本身：两种关系、对称、传递成组、误拦截边界 ----------
g.walkXfer = { on: [], same: [] };
assert.equal(g.sameXferStation(A, B), false, '没有任何换乘关系时不是同一座站');
assert.equal(g.sameXferStation(A, A), false, '同一个车站对象不算');
assert.equal(g.sameXferStation(E, F), false, '物理距离近但未设关系不拦');

for (const type of ['on', 'same']) {
  g.walkXfer = { on: type === 'on' ? [keyAB] : [], same: type === 'same' ? [keyAB] : [] };
  assert.equal(g.sameXferStation(A, B), true, type + '：两站同组');
  assert.equal(g.sameXferStation(B, A), true, type + '：判定对称');
  assert.equal(g.sameXferStation(A, D), false, type + '：不同组不拦');
  assert.equal(g.sameXferStation(A, Cc), false, type + '：尚未连入组的第三站不拦');
}
g.walkXfer = { on: [keyAB], same: [keyBC] };
assert.equal(g.sameXferStation(A, Cc), true, 'A—B—C 传递成组，任意两站都算同一座站');
assert.equal(g.sameXferStation(A, E), false, '未加入组的近距站不受传递影响');

// ---------- 2. 草案编辑：只拦新增的组内直连段，自动回滚 ----------
for (const type of ['on', 'same']) {
  reset();
  g.walkXfer = { on: type === 'on' ? [keyAB] : [], same: type === 'same' ? [keyAB] : [] };
  const n0 = segCount();
  let r = g.edit(net => M.addSegment(net, L1, A, B, [], 'underground'));
  assert.ok(errIsXfer(r), type + '：A→B 被拦截');
  assert.equal(segCount(), n0, type + '：拦截后草案回滚，段数不变');
  assert.equal(hasSeg(L1, A, B), false, type + '：没有留下组内连接');

  reset();
  r = g.edit(net => M.addSegment(net, L1, B, A, [], 'underground'));
  assert.ok(errIsXfer(r), type + '：反向 B→A 同样拦截');

  reset();
  r = g.edit(net => M.addSegment(net, L1, A, D, [], 'underground'));
  assert.ok(!r.error, type + '：不同实际站点之间正常连线');
  assert.equal(hasSeg(L1, A, D), true);

  reset();
  r = g.edit(net => M.addSegment(net, L1, E, F, [], 'underground'));
  assert.ok(!r.error, type + '：近距但无换乘关系的两站正常连线');

  reset();
  r = g.edit(net => M.addSegment(net, L1, D, A, [], 'underground'));
  assert.ok(!r.error, type + '：反向连到组内成员以外的站正常');
}

// ---------- 3. 传递组与取消关系 ----------
reset();
g.walkXfer = { on: [keyAB], same: [keyBC] };
assert.ok(errIsXfer(g.edit(net => M.addSegment(net, L1, A, Cc, [], 'underground'))), '传递组 A—C 也要拦截');
reset();
g.walkXfer = { on: [], same: [] };
assert.ok(!g.edit(net => M.addSegment(net, L1, A, B, [], 'underground')).error, '取消换乘关系后可正常连线');

// ---------- 4. 旧存档里已有的组内连接：不追溯、不误拦 ----------
reset();
g.walkXfer = { on: [], same: [] };
const legacy = M.addSegment(g.net, L2, A, B, [], 'underground');   // 模拟旧档 / 开局数据直接建网（不经 edit）
assert.ok(legacy.id, '开局、读档、教程直接建网不受 edit 约束');
g.walkXfer = { on: [keyAB], same: [] };
let r = g.edit(net => { net.stations[D].size = 'L'; });
assert.ok(!r.error, '旧档已有的组内连接不应让无关编辑被回滚');
assert.equal(netNow().stations[D].size, 'L', '无关编辑确实生效');
reset();
r = g.edit(net => { net.segments[legacy.id].line = L3; });   // 改线路归属不算新增连接
assert.ok(!r.error, '改线路归属 / 线形 / 建设方式不算新增连接');
assert.equal(netNow().segments[legacy.id].line, L3);
reset();

// ---------- 5. 其它绘制路径也拦得住 ----------
// 并线运行 runAlong：为另一条线在组内两站之间补一段共用轨道
r = g.edit(net => M.runAlong(net, L1, A, L2, B));
assert.ok(errIsXfer(r), '并线运行不能产生组内直连段');
assert.equal(hasSeg(L1, A, B), false);
reset();

// 拆站合并 removeStation：删掉中间站后两段会合成 A—B 直连段
g.walkXfer = { on: [], same: [] };
M.addSegment(g.net, L1, D, MID, [], 'underground');
M.addSegment(g.net, L1, MID, A, [], 'underground');
g.walkXfer = { on: [C.Game.walkXferKey(D, A)], same: [] };
r = g.edit(net => M.removeStation(net, MID));
assert.ok(errIsXfer(r), '拆站合并不能把两条轨道拼成组内直连段');
reset();

// 对正式网直接新增（createGen / restoreGen 的路径）仍不受影响
const direct = M.addSegment(g.net, L3, A, B, [], 'underground');
assert.ok(direct.id, '读档 / 开局重建线网不经过 edit，行为不变');

// ---------- 6. xferLinkViolation 只认「新增」：端点快照比较不含线路与线形 ----------
g.walkXfer = { on: [keyAB], same: [] };   // 回到 A—B 同组
const L4 = M.newLine(g.net, null, { num: 4 });
const snap = Object.create(null);
for (const id in g.net.segments) { const s = g.net.segments[id]; snap[id] = s.a < s.b ? s.a + '|' + s.b : s.b + '|' + s.a; }
assert.equal(g.xferLinkViolation(snap, g.net), null, '网没有任何变化时无违规');
g.net.segments[legacy.id].type = 'elevated';
assert.equal(g.xferLinkViolation(snap, g.net), null, '只改建设方式不算新增');
g.net.segments[legacy.id].line = L1;
assert.equal(g.xferLinkViolation(snap, g.net), null, '只改线路归属不算新增');
const added = M.addSegment(g.net, L4, A, B, [], 'underground');
assert.ok(added.id, '同组两站之间可存在多条不同线路的旧段');
assert.equal(g.xferLinkViolation(snap, g.net), ERR, '新增的组内直连段会被识别');
assert.equal(g.xferLinkViolation(null, g.net), null, '未开启检查时不做扫描');

console.log('PASS test-xfer-no-link: 两种换乘关系 / 传递组 / 反向 / 只拦新增 / 其它绘制路径 / 旧档兼容');
