// v3.4 / v3.5 回归：160 统一票价、编组与站台规模门槛、160 轨道 D 型改装、
// TOD 第 5 级巨型门槛、同车型小编组补差价扩编。不读写玩家存档。
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const root = new URL('../', import.meta.url), memory = new Map();
const c = { console, performance, atob, btoa, TextEncoder, TextDecoder, setTimeout, clearTimeout, navigator: { hardwareConcurrency: 4 }, matchMedia: () => ({ matches: false }), localStorage: { getItem: k => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, String(v)), removeItem: k => memory.delete(k) } };
c.window = c; vm.createContext(c);
const load = async src => vm.runInContext(await readFile(new URL(src, root), 'utf8'), c, { filename: src });
for (const [, src] of (await readFile(new URL('index.html', root), 'utf8')).matchAll(/<script src="([^"]+)"/g)) { await load(src); if (src === 'js/save.js') break; }
const C = c.CM, M = C.Metro, CFG = C.CFG;
C.UI = function () {}; for (const name of ['settings', 'corp', 'fleet']) await load('js/' + name + '.js');
const F = C.Fleet, E = C.Economy, T = C.TOD, Model = C.Model;
C.Difficulty = null;   // 价格断言用无难度倍率的基准

// ---------------- 1. 160 速度轨道统一票价 ----------------
const f0 = E.defaultFare(), f160 = E.defaultFare160();
assert.equal(f160.mode, f0.mode, '160 统一票价与常规票价计费方式一致');
assert.equal(f160.flat, f0.flat * (CFG.metro.std160.fareX || 2), '起步价按 std160.fareX 放大');
if (f0.mode === 'dist') assert.equal(f160.inc, f0.inc * (CFG.metro.std160.fareX || 2), '每段加价同比放大');
assert.ok(E.normFare160(null).flat > 0, '旧档缺字段时回落到默认票价');
assert.equal(E.normFare160({ mode: 'flat', flat: 5 }).mode, 'flat', '统一票价结构可读回');
assert.equal(typeof E.prototype.setFare160, 'function');
assert.equal(typeof E.prototype.setFare160Auto, 'function');
assert.equal(typeof E.prototype.fare160HikeEffect, 'function');
// 联合签名：常规票价或 160 统一票价任一变动都要让出行重算
const mkModelFare = (a, b) => ({ fare: a, fare160: b });
assert.notEqual(Model.fareKeyAll(mkModelFare(f0, f160)), Model.fareKeyAll(mkModelFare(f0, { ...f160, flat: f160.flat + 1 })), '160 票价变动改变签名');
assert.notEqual(Model.fareKeyAll(mkModelFare(f0, f160)), Model.fareKeyAll(mkModelFare({ ...f0, flat: f0.flat + 1 }, f160)), '常规票价变动改变签名');
assert.equal(Model.fareKeyAll(mkModelFare(f0, f160)), Model.fareKeyAll(mkModelFare({ ...f0 }, { ...f160 })), '票价不变则签名稳定');
// 自动调价：开启时记下基准，物价翻倍后 160 票价按同一比例上调，且不影响常规票价
const e = Object.create(E.prototype);
let idx = 1;
Object.assign(e, {
  fare: { ...f0 }, fare160: { ...f160 }, fareMark: null, fare160Mark: null, mods: [],
  fareAuto: null, fare160Auto: null, fareNote: 0,
  costIndex: () => idx, isFree: () => false, fareReal: () => 1,
});
e.setFare160Auto(true, 2000);
const stdBefore = e.fare.flat, f160Before = e.fare160.flat;
idx = 2;
const yr = e.fareYearly(2001, 1);
assert.equal(yr.changed160, true, '160 统一票价随物价调整');
assert.equal(yr.changed, false, '未开启常规自动调价时常规票价不动');
assert.equal(e.fare.flat, stdBefore, '常规票价不受 160 自动调价影响');
assert.ok(e.fare160.flat > f160Before, '160 票价按物价上调');
assert.ok(e.setFare160({ ...e.fare160, flat: e.fare160.flat + 10 }, 2001, 6) < 0, '大幅涨价降低满意度');
console.log('PASS 160 轨道统一票价与自动调价');

// ---------------- 2. 编组与站台规模门槛 ----------------
assert.equal(M.formationSize(4), null, '4 节编组不设门槛');
assert.equal(M.formationSize(6), 'M', '6 节编组要中型及以上');
assert.equal(M.formationSize(8), 'L', '8 节编组要大型及以上');
const short6 = M.formationShort(null, 6, [{ size: 'S', name: '小站' }]);
assert.ok(short6 && short6.bad.length === 1 && short6.need === 'M', '6 节轨道拒绝小型站');
assert.equal(M.formationShort(null, 6, [{ size: 'M', name: '中型站' }]), null, '6 节轨道接受中型站');
assert.equal(M.formationShort(null, 6, [{ size: 'HUB', name: '枢纽站' }]), null, '6 节轨道接受枢纽型站');
const short8 = M.formationShort(null, 8, [{ size: 'S', name: '小站' }, { size: 'M', name: '中型站' }, { size: 'L', name: '大型站' }]);
assert.ok(short8 && short8.bad.length === 2 && short8.need === 'L', '8 节轨道只接受大型及以上');
assert.equal(M.formationShort(null, 8, [{ size: 'XL', name: '超大型站' }, { size: 'XXL', name: '巨型站' }]), null);
// 一条线的最长编组由沿线最小站台决定
const net = {
  stations: { A: { id: 'A', size: 'S' }, B: { id: 'B', size: 'L' } },
  lines: { L1: { id: 'L1', name: '1 号线' } },
  segments: { g1: { id: 'g1', line: 'L1', a: 'A', b: 'B', pts: [] }, g2: { id: 'g2', line: 'L1', a: 'B', b: 'A', pts: [] } },
};
assert.equal(M.formationCars(net, 'L1'), 4, '沿线最小站台决定线路编组');
net.stations.A.size = 'M'; assert.equal(M.formationCars(net, 'L1'), 6);
net.stations.A.size = 'XL'; assert.equal(M.formationCars(net, 'L1'), 8);
console.log('PASS 6/8 编组站台规模门槛');

// ---------------- 测试用游戏对象 ----------------
const spent = [], logs = [];
const mkG = (o = {}) => {
  const lines = o.lines || { L1: { id: 'L1', name: '1 号线' } };
  return {
    mapId: 'bj', clock: { y: 2020, m: 3, d: 1 }, net: { lines: lines, stations: {}, segments: {} },
    econ: { isFree: () => false, costIndex: () => 1, canAffordBuild: () => true, spendBuild: (x, t) => { spent.push(t); }, log() {}, difficulty: null },
    fleet: { ver: 1, seq: 1, trains: o.trains || [], ops: {} },
    model: { net: { C: { routes: o.routes || [{ lineId: 'L1', cars: 8 }] } }, applyFleet() {} },
    touch() {}, emit() {}, logEvent(x) { logs.push(x); }, ym: () => 2020 * 12 + 3,
  };
};

// ---------------- 3. 升级为 160 轨道：非 D 型车补差价改装 ----------------
const t160 = [
  { id: 'T1', model: 'gen-a', cars: 6, bought: 2010 * 12, cost: 1000, line: 'L1' },
  { id: 'T2', model: 'gen-d160', cars: 8, bought: 2010 * 12, cost: 2000, line: 'L1' },
  { id: 'T3', model: 'gen-steel', cars: 4, bought: 2010 * 12, cost: 500, line: 'L2' },
];
const g160 = mkG({ lines: { L1: { id: 'L1', name: '1 号线', speed: 160 } }, trains: t160.slice() });
assert.deepEqual(Array.from(F.staleD(g160, 'L1'), t => t.id), ['T1'], '只挑本线非 D 型车');
const qd = F.dQuote(g160, F.staleD(g160, 'L1'));
assert.equal(qd.n, 1); assert.equal(qd.carsEach, 8); assert.ok(qd.cost > 0, '补差价为正');
const bought0 = g160.fleet.trains[0].bought, cost0 = g160.fleet.trains[0].cost;
const rd = F.upgradeD(g160, 'L1');
assert.equal(rd.ok, true); assert.equal(rd.cars, 8);
assert.equal(g160.fleet.trains[0].model, 'gen-d160', '车型改为 D 型');
assert.equal(g160.fleet.trains[0].cars, 8, '固定 8 节编组');
assert.equal(g160.fleet.trains[0].bought, bought0, '车龄不变');
assert.ok(g160.fleet.trains[0].cost > cost0, '补差价累加到车体成本');
assert.equal(g160.fleet.trains[2].model, 'gen-steel', '其它线路不受影响');
assert.ok(F.upgradeD(g160, 'L1').error, '重复升级会被拒绝');
assert.ok(spent.some(s => /列车升级/.test(s)) && logs.some(l => /改装为 D 型车/.test(l.desc)), '扣费与日志已记录');
// 160 线的站台必须大型及以上：编译期有兜底校验
assert.ok(CFG.metro.std160.sizeMin.indexOf('S') < 0 && CFG.metro.std160.sizeMin.indexOf('M') < 0, '小型 / 中型站不在 160 允许清单');
assert.ok(CFG.metro.std160.sizeMin.indexOf('L') >= 0 && CFG.metro.std160.sizeMin.indexOf('XXL') >= 0, '大型 / 巨型站允许 160');
console.log('PASS 160 轨道 D 型补差价升级');

// ---------------- 4. TOD 第 5 级只有巨型及以上 ----------------
assert.equal(T.LEVELS[5].min, 'XXL');
assert.equal(T.minName(4), '超大型'); assert.equal(T.minName(5), '巨型');
assert.equal(T.maxLv('L'), 3); assert.equal(T.maxLv('XL'), 4);
assert.equal(T.maxLv('XXL'), 5); assert.equal(T.maxLv('HUB'), 5);
assert.equal(T.topSize(), '巨型');
assert.ok(/第 4 级需超大型/.test(T.gateText()) && /第 5 级需巨型/.test(T.gateText()), '门槛说明逐级列出');
assert.ok(/巨型及以上到第 5 级/.test(T.capText()) && /超大型到第 4 级/.test(T.capText()), '分组说明与门槛一致');
console.log('PASS TOD 第 5 级巨型门槛');

// ---------------- 5. 同车型小编组补差价扩编 ----------------
const carsTrains = [
  { id: 'T1', model: 'gen-a', cars: 4, bought: 2010 * 12, cost: 1000, line: 'L1' },
  { id: 'T2', model: 'gen-steel', cars: 6, bought: 2010 * 12, cost: 900, line: 'L1' },
  { id: 'T3', model: 'gen-a', cars: 8, bought: 2010 * 12, cost: 2000, line: 'L1' },
  { id: 'T4', model: 'gen-d160', cars: 8, bought: 2010 * 12, cost: 2000, line: 'L1' },
  { id: 'T5', model: 'gen-a', cars: 4, bought: 2010 * 12, cost: 1000, line: 'L2' },
];
const fresh = () => carsTrains.map(t => ({ ...t }));
const gc = mkG({ trains: fresh() });
assert.equal(F.lineCars(gc, 'L1'), 8, '线路上限来自运营编译结果');
assert.deepEqual(Array.from(F.staleCars(gc, 'L1'), t => t.id), ['T1', 'T2'], '只挑本线可扩编的同车型列车');
const qc = F.carsQuote(gc, F.staleCars(gc, 'L1'), 'L1');
assert.equal(qc.n, 2); assert.equal(qc.added, 6, '4→8 加 4 节、6→8 加 2 节');
assert.equal(qc.cars, 16); assert.equal(qc.to, 8); assert.ok(qc.cost > 0, '补差价为正');
assert.deepEqual(Array.from(qc.kinds), ['A 型车', 'B 型车'], '按原车型分别列出');
const a0 = F.model('gen-a'), s0 = F.model('gen-steel');
const expectCost = (F.price(gc, a0, 8, 2020) - F.price(gc, a0, 4, 2020)) + (F.price(gc, s0, 8, 2020) - F.price(gc, s0, 6, 2020));
assert.ok(Math.abs(qc.cost - expectCost) < 1e-6, '按当年同车型价格补差价');
const b1 = gc.fleet.trains[0].bought, c1 = gc.fleet.trains[0].cost;
const rc = F.upgradeCars(gc, 'L1');
assert.equal(rc.ok, true); assert.equal(rc.added, 6);
assert.equal(gc.fleet.trains[0].cars, 8); assert.equal(gc.fleet.trains[1].cars, 8);
assert.equal(gc.fleet.trains[0].model, 'gen-a', '车型不变');
assert.equal(gc.fleet.trains[1].model, 'gen-steel', '车型不变');
assert.equal(gc.fleet.trains[0].bought, b1, '车龄不变');
assert.ok(gc.fleet.trains[0].cost > c1, '补差价累加到车体成本');
assert.equal(gc.fleet.trains[4].cars, 4, '其它线路不受影响');
assert.ok(F.upgradeCars(gc, 'L1').error, '全部扩编后重复调用会被拒绝');
assert.ok(spent.some(s => /列车扩编/.test(s)) && logs.some(l => /加挂车厢/.test(l.desc)), '扣费与日志已记录');
// 线路上限变小 / 车型上限更小 / 160 线：扩编目标与可见性
const g6 = mkG({ routes: [{ lineId: 'L1', cars: 6 }], trains: fresh() });
assert.equal(F.carsTarget(g6, 'L1', g6.fleet.trains[0]), 6, '目标不超过线路上限');
assert.deepEqual(Array.from(F.staleCars(g6, 'L1'), t => t.id), ['T1'], '已到线路上限的列车不再提示');
const gFixed = mkG({ trains: [{ id: 'T9', model: 'gen-d160', cars: 8, bought: 0, cost: 1, line: 'L1' }] });
assert.equal(F.staleCars(gFixed, 'L1').length, 0, '固定编组车型不可扩编');
const g160b = mkG({ lines: { L1: { id: 'L1', name: '1 号线', speed: 160 } }, trains: fresh() });
assert.equal(F.staleCars(g160b, 'L1').length, 0, '160 线走 D 型改装，不重复提示扩编');
const gNoC = mkG({ routes: [], trains: fresh() });
gNoC.net = { lines: { L1: { id: 'L1' } }, stations: { A: { size: 'L' }, B: { size: 'L' } }, segments: { g1: { id: 'g1', line: 'L1', a: 'A', b: 'B', pts: [] } } };
assert.equal(F.lineCars(gNoC, 'L1'), 8, '无编译结果时按实时站厅规模兜底');
console.log('PASS 同车型小编组补差价扩编');

console.log('ALL PASS v3.4 / v3.5 fare, platform, TOD and consist upgrades');
