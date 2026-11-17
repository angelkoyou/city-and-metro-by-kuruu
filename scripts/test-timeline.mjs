// 建设回放：批次记录、旧档推导、时间顺序、累积视图与示意图数据
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
for (const src of ['icons', 'settings', 'corp', 'fleet', 'screens', 'timeline']) await load('js/' + src + '.js');
assert.ok(C.Timeline, '建设回放模块已注册');
const T = C.Timeline, M = C.Metro;

C.useMap('tutorial');
const g = C.Game.create({ mode: 'free', tutorial: true, seed: 20261109 });
const net = g.net;

// ---------- 1. 旧存档推导：按 built 年月归并，线路取最早的一段 ----------
T.reset();
const L1 = M.newLine(net, null, { num: 1 }), L2 = M.newLine(net, null, { num: 2 });
const A = M.addStation(net, 10.5, 10.5, { size: 'M' }, g.city);
const B = M.addStation(net, 11.5, 10.5, { size: 'M' }, g.city);
const Cc = M.addStation(net, 12.5, 10.5, { size: 'L' }, g.city);
net.stations[A].name = '甲'; net.stations[B].name = '乙'; net.stations[Cc].name = '丙';
net.stations[A].built = [2001, 3]; net.stations[B].built = [2001, 3]; net.stations[Cc].built = [2002, 7];
const s1 = M.addSegment(net, L1, A, B, [], 'underground').id;
const s2 = M.addSegment(net, L1, B, Cc, [], 'underground').id;
const s3 = M.addSegment(net, L2, A, Cc, [], 'underground').id;
net.segments[s1].built = [2001, 3]; net.segments[s2].built = [2002, 7]; net.segments[s3].built = [2002, 7];
net.lines[L1].name = '一号线'; net.lines[L2].name = '二号线';

const d = T.derive(g);
assert.equal(d.length, 2, '两个建设月份 → 两个回放节点');
assert.equal(d[0].y + '-' + d[0].m, '2001-3');
assert.equal(d[1].y + '-' + d[1].m, '2002-7');
assert.equal(Array.from(d[0].st.map(x => x.id)).sort().join(','), [A, B].sort().join(','), '2001 年 3 月建了两座站');
assert.equal(Array.from(d[0].ln.map(x => x.id)).join(','), L1, '1 号线在 2001 年 3 月开通（取最早的一段）');
assert.equal(Array.from(d[1].ln.map(x => x.id)).join(','), L2, '2 号线在 2002 年 7 月开通');
assert.equal(d[0].st[0].name, '甲', '推导结果带站名');

// 开局接管的真实线路：整批都是继承来的，标记为「开局线网」
net.stations[A].inherited = true; net.stations[B].inherited = true; net.segments[s1].inherited = true;
T.reset();
const dInit = T.derive(g);
assert.equal(dInit[0].init, true, '整批为开局接管的车站与轨道 → 开局线网');
assert.equal(dInit[1].init, false, '玩家自己建的月份不算开局线网');
delete net.stations[A].inherited; delete net.stations[B].inherited; delete net.segments[s1].inherited;

// ---------- 2. 批次记录：顺序、月内先后、名称与已删除对象的兜底 ----------
g.buildLog = [
  { y: 2004, m: 5, ym: C.U.ymIndex(2004, 5), cost: 120000, st: [{ id: A, name: '甲' }], sg: [], ln: [] },
  { y: 2003, m: 2, ym: C.U.ymIndex(2003, 2), cost: 0, st: [{ id: B, name: '乙' }], sg: [s2], ln: [{ id: L1, name: '一号线', num: 1 }] },
  { y: 2003, m: 2, ym: C.U.ymIndex(2003, 2), cost: 5000, st: [], sg: [], ln: [], rm: 2, mod: 1 },
  { y: 2005, m: 1, ym: C.U.ymIndex(2005, 1), cost: 0, st: [{ id: 'gone', name: '已拆除站' }], sg: [], ln: [{ id: 'goneLine', name: '已撤销线路', num: 9 }] },
];
T.reset();
let list = T.entries(g);
assert.equal(list.length, 4, '四个批次');
assert.equal(Array.from(list.map(e => e.ym)).join(','), [C.U.ymIndex(2003, 2), C.U.ymIndex(2003, 2), C.U.ymIndex(2004, 5), C.U.ymIndex(2005, 1)].join(','), '按年月排序，月内保持记录顺序');
assert.equal(list[0].i, 0); assert.equal(list[3].i, 3);
assert.equal(list[1].cost, 5000, '同一月的第二个批次仍在原位置');
assert.equal(list[2].st[0].name, '甲');
assert.equal(list[3].st[0].name, '已拆除站', '车站已不存在时沿用记录时的站名');
assert.equal(list[3].ln[0].name, '已撤销线路', '线路已不存在时沿用记录时的线路名');
assert.equal(list[3].ln[0].num, 9);
// 名称以后来的改动为准（仍存在时）
net.stations[A].name = '甲（改名）';
T.reset();
list = T.entries(g);
assert.equal(list[2].st[0].name, '甲（改名）', '仍存在的对象显示当前站名');
net.stations[A].name = '甲';

// ---------- 3. 累积视图：进度 0 / 中间 / 满 ----------
T.reset();
list = T.entries(g);
let v = T.view(list, 0);
assert.equal(v.st.size, 0); assert.equal(v.sg.size, 0); assert.equal(v.ln.size, 0);
v = T.view(list, 2);
assert.equal(v.st.size, 1, '前两个节点累计一座站（第二个批次只有改建/拆除）');
assert.equal(v.sg.size, 1, '累计一段轨道');
assert.equal(v.ln.size, 1);
v = T.view(list, list.length);
assert.equal(v.st.size, 3, '全部节点累计三座站（含已拆除的记录）');
assert.equal(v.sg.size, 1);
v = T.view(list, 99);
assert.equal(v.st.size, 3, '超出范围按满进度处理');
v = T.view(list, -5);
assert.equal(v.st.size, 0, '负数按 0 处理');

// ---------- 4. 示意图数据：包围盒、投影与 SVG 片段 ----------
const box = T.bounds(net);
assert.ok(box.x1 > box.x0 && box.w > 0 && box.h > 0, '包围盒有效且宽高不会为 0');
const svg0 = T.mapSvg(g, T.view(list, 0), null, 340, 212);
assert.ok(!svg0.includes('<polyline') && !svg0.includes('<circle'), '开工前没有可画的线网（只有底网格）');
const svg = T.mapSvg(g, T.view(list, 2), list[1], 340, 212);
assert.ok(svg.includes('<polyline'), '画出了轨道');
assert.ok(svg.includes('<circle'), '画出了车站');
assert.ok(!/[<>]script/i.test(svg) && !svg.includes('NaN'), 'SVG 片段不含脚本与非法数值');

// 南北方向必须与地图一致：y 越小（北）越靠上，不能再翻转一次
const dirNet = {
  stations: { n: { id: 'n', x: 5, y: 2, size: 'M' }, s: { id: 's', x: 5, y: 10, size: 'M' } },
  segments: { q: { id: 'q', a: 'n', b: 's', line: 'l', type: 'underground', pts: [] } },
  lines: { l: { id: 'l', num: 1, color: '#ff0000' } },
};
const dirSvg = T.mapSvg({ net: dirNet }, { st: new Set(['n', 's']), sg: new Set(['q']), ln: new Set(['l']) }, null, 200, 200);
const cys = [...dirSvg.matchAll(/<circle cx="[\d.]+" cy="([\d.]+)"/g)].map(m => +m[1]);
assert.equal(cys.length, 2, '示意图画出了两座车站');
assert.ok(cys[0] < cys[1], '北侧车站在上方（y 轴与地图同向）');

// 回放视图只在回放页打开时有效，关闭后不再影响地图
T.setView(g, T.view(list, 2), list[1], 2);
assert.ok(T.replay(g, { stack: [{ kind: 'timeline' }] }), '回放页打开时提供地图视图');
assert.equal(T.replay(g, { stack: [{ kind: 'help' }] }), null, '切到其它页面后回放视图失效');
assert.equal(T.replay(g, { stack: [{ kind: 'timeline' }] }), null, '失效后不会残留');

// ---------- 5. 与真实建设流程对接：确认建设后写入批次 ----------
// 用一个干净的对局验证：前面的用例已经往同一张线网里塞了重叠轨道，不适合再确认建设
const g2 = C.Game.create({ mode: 'free', tutorial: true, seed: 20261110 });
const net2 = g2.net;
T.reset();
const before = g2.buildLog.length;
const startYear = g2.clock.y, startMonth = g2.clock.m;
const r = g2.edit(function (n) {
  const lid = M.newLine(n, null, { num: 7 });
  const a = M.addStation(n, 10.5, 10.5, { size: 'M' }, g2.city);
  const b = M.addStation(n, 11.4, 10.5, { size: 'M' }, g2.city);
  M.addSegment(n, lid, a, b, [], 'underground');
  return { ok: true };
});
assert.ok(!r.error, '草案编辑成功：' + (r.error || ''));
const conf = g2.confirmDraft();
assert.ok(conf.ok, '确认建设成功：' + (conf.reason || ''));
assert.equal(g2.buildLog.length, before + 1, '每次确认建设写入一条批次');
const e = g2.buildLog[g2.buildLog.length - 1];
assert.equal(e.y + '-' + e.m, startYear + '-' + startMonth, '批次记录建设时的年月');
assert.equal(e.st.length, 2, '批次记下两座新站');
assert.equal(e.sg.length, 1, '批次记下一段新轨道');
assert.equal(e.ln.length, 1, '新开的线路记入批次');
assert.ok(e.cost >= 0 && Number.isFinite(e.cost), '批次带建设费用');
assert.equal(g2.net.stations[e.st[0].id].built[0], startYear, '新站写入建成年份');
T.reset();
const after = T.entries(g2);
assert.equal(after.length, g2.buildLog.length, '批次与回放节点一一对应');
assert.equal(after[after.length - 1].st.length, 2, '回放节点能取到新站');
assert.ok(after[after.length - 1].st.every(x => !!x.name), '回放节点带站名');
assert.ok(after[after.length - 1].ln[0].name, '回放节点带线路名');

// ---------- 6. 存档往返：批次随存档保存；旧档没有批次时按 built 推导 ----------
const snap = JSON.parse(JSON.stringify(g2.serialize()));
assert.ok(Array.isArray(snap.buildLog) && snap.buildLog.length === g2.buildLog.length, '存档包含建设批次');
T.reset();
const restored = { id: 'x', netVersion: 0, buildLog: snap.buildLog.map(x => x), net: snap.net };
const again = T.entries(restored);
assert.equal(again.length, after.length, '读档后回放节点数量不变');
assert.equal(again[again.length - 1].st.length, 2);
T.reset();
const noLog = { id: 'y', netVersion: 0, buildLog: [], net: snap.net };
const derived = T.entries(noLog);
assert.ok(derived.length > 0, '没有批次记录时按 built 推导出回放节点');
assert.ok(derived.every(x => Number.isFinite(x.y) && x.m >= 1 && x.m <= 12), '推导节点的年月合法');
assert.ok(derived.some(x => x.st.length > 0), '推导节点包含车站');

console.log('PASS test-timeline: ' + after.length + ' 个回放节点，' + derived.length + ' 个推导节点');
