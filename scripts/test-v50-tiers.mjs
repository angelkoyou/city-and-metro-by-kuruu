// v5.0 回归：车型分级 T1–T6、自动配置只补主力车型、城市特色车补差价升级。
// 覆盖：F.TRUNK 一款一级、F.tierOf/tierScore 的城市定级与单调性、D 型车独立、
//       F.canAutoPick / autoConfigRun / allocPlan 的城市特色车门禁、
//       F.staleTech / techQuote / upgradeTech 对城市特色车的升级与状态更新。
// 不读写玩家存档。
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
const C = c.CM, CFG = C.CFG;
C.UI = function () {};
for (const name of ['settings', 'corp', 'fleet', 'cheat']) await load('js/' + name + '.js');
const F = C.Fleet;
C.Difficulty.loadGame('normal', null);

const spent = [], logs = [], toasts = [];
const mkG = (o = {}) => {
  const lines = o.lines || { L1: { id: 'L1', name: '1 号线' } };
  const net = { lines: lines, stations: {}, segments: {}, rideEdge: [], R: 1 };
  net.C = { routes: o.routes || [{ lineId: 'L1', cars: 8 }], rideEdge: [], R: 1, net: net };
  return {
    mapId: o.mapId || 'gz', clock: { y: o.y || 2012, m: 3, d: 1 },
    net: net, compiled: net.C,
    econ: {
      isFree: () => !!o.free, isInfinite: () => !!o.infinite, isSandbox: () => !!(o.free || o.infinite),
      difficulty: o.difficulty || 'normal', costIndex: () => 1,
      canAffordBuild: () => o.afford !== false, spendBuild: (x, t) => { spent.push(t); }, log() {},
    },
    fleet: Object.assign({ ver: 1, seq: 1, trains: o.trains || [], ops: {}, note: {} }, o.fleet || {}),
    model: { net: net, applyFleet() {}, trafficReady: () => true, resultsFor: () => null, solveNow() {} },
    touch() {}, emit(x, p) { toasts.push(p); }, logEvent(x) { logs.push(x); }, ym: () => (o.y || 2012) * 12 + 3,
  };
};
const TRAIN = (id, model, cars, line, bought) => ({ id: id, model: model, cars: cars, bought: bought == null ? 2010 * 12 : bought, cost: 1000, line: line == null ? 'L1' : line, svc: null });
const autoRoute = { lineId: 'L1', cars: 8, cycleSec: 3600, stIds: ['a', 'b'], stIdx: [0, 1], lenM: 2400, loop: false, label: '1 号线', cap: 2480, kmh: 80 };

// ================= 1. 主力车型 T1–T6，一款一级 =================
assert.equal(F.TRUNK.length, F.TIER_N, '主力车型数量与等级数量一致');
const tiers = F.TRUNK.map(id => F.model(id).t);
assert.deepEqual(Array.from(tiers), [1, 2, 3, 4, 5, 6], '主力车型按上市顺序写入 T1–T6');
assert.equal(new Set(tiers).size, F.TIER_N, '每个 T 级只有一款主力车型');
for (const id of F.TRUNK) {
  const m = F.model(id);
  assert.equal(F.isCity(m), false, '主力车型不是城市特色车型：' + id);
  assert.equal(F.tierOf(m), m.t, '等级直接取主力车型写入的 t：' + id);
  assert.equal(F.tierLabel(m), 'T' + m.t);
  assert.equal(F.tierKind(m), 'trunk');
  assert.equal(F.tierChip(m), 'T' + m.t + ' 主力');
}
// 等级顺序 = 性能顺序 = 上市年份顺序：后一级不会更慢、更小或更费电
for (let i = 1; i < F.TRUNK.length; i++) {
  const a = F.model(F.TRUNK[i - 1]), b = F.model(F.TRUNK[i]);
  assert.ok(b.from >= a.from, '等级与上市年份同序：' + b.id);
  assert.ok(b.cap >= a.cap, '后一级定员不下降：' + b.id);
  assert.ok(b.ops <= a.ops, '后一级运营成本不上升：' + b.id);
  assert.ok(b.kmh >= a.kmh, '后一级限速不下降：' + b.id);
  assert.ok(F.tierScore(b) > F.tierScore(a), '后一级综合性能更高：' + b.id);
}
console.log('PASS 1 主力车型 T1–T6，一款一级，等级与性能同序');

// ================= 2. 城市特色车型同尺定级 =================
// 同一把尺子：相邻两款主力车型综合性能的中点为分档线，正好落在中点时取高档
const scaleTier = m => {
  const s = F.tierScore(m);
  let t = 1;
  for (let i = 1; i < F.TRUNK.length; i++) {
    const cut = (F.tierScore(F.model(F.TRUNK[i - 1])) + F.tierScore(F.model(F.TRUNK[i]))) / 2;
    if (s >= cut) t++;
  }
  return t;
};
const gapTo = (m, t) => Math.abs(F.tierScore(m) - F.tierScore(F.model(F.TRUNK[t - 1])));
let cityCount = 0;
for (const city of F.CITY_ORDER) {
  for (const id of F.CITY_BRANCH[city]) {
    const m = F.model(id);
    cityCount++;
    const t = F.tierOf(m);
    assert.ok(t >= 1 && t <= F.TIER_N, '城市特色车型等级在 T1–T6 内：' + id);
    assert.equal(F.isCity(m), true);
    assert.equal(F.tierKind(m), 'city');
    assert.equal(F.tierLabel(m), 'T' + t);
    assert.equal(F.tierChip(m), 'T' + t + ' 城市');
    assert.equal(t, scaleTier(m), '城市特色车型按综合性能分档：' + id);
    // 定到的档位必须是综合性能最接近的主力车型之一（中点等距时允许取高档）
    const gaps = F.TRUNK.map((_, i) => gapTo(m, i + 1));
    assert.ok(gapTo(m, t) <= Math.min(...gaps) + 1e-9, '城市特色车型落在最接近的主力档位：' + id);
  }
}
assert.ok(cityCount >= 27, '覆盖全部城市特色车型');
// 性能更强的新车型不会被定到更低的等级（反例守护）
const pairs = [['hz-b1', 'hz-a'], ['wh-b1', 'wh-a'], ['bj-dk', 'bj-a'], ['gz-a1', 'gz-a8']];
for (const [a, b] of pairs) assert.ok(F.tierOf(F.model(b)) >= F.tierOf(F.model(a)), '性能更强的新车型等级不低于旧车型：' + b);
console.log('PASS 2 城市特色车型按同一性能标尺定级，与主力车型同档可比');

// ================= 3. D 型车保持独立 =================
const d = F.model('gen-d160');
assert.equal(F.is160Model(d), true);
assert.equal(F.TRUNK.indexOf(d.id), -1, 'D 型车不在主力 T 级序列里');
assert.equal(F.tierOf(d), 0, 'D 型车不参与 T 级评定');
assert.equal(F.tierLabel(d), 'D');
assert.equal(F.tierKind(d), 'd');
assert.equal(F.tierChip(d), 'D 型专用');
assert.equal(d.fixedCars, 8, '固定 8 节编组不变');
assert.equal(d.kmh, 160, '160 km/h 专用不变');
assert.equal(F.lineFit(d, 160), true);
assert.equal(F.lineFit(d, 80), false, 'D 型车仍不能上普通轨道');
console.log('PASS 3 D 型车独立：不参与 T 级，160 专用规则不变');

// ================= 4. 自动配置只补主力车型 =================
const g4 = mkG({ y: 2012 });
g4.fleet.autoConfig = true;
F.markOwned(g4, 'gz-a8');
assert.equal(F.ownsModel(g4, 'gz-a8'), true, '玩家确实买过城市特色车型');
assert.equal(F.canAutoPick(g4, F.model('gz-a8')), false, '已购置的城市特色车型也不能被自动选用');
for (const id of F.TRUNK) assert.equal(F.canAutoPick(g4, F.model(id)), true, '主力车型可自动选用：' + id);
assert.equal(F.canAutoPick(g4, d), true, 'D 型车可自动选用');
for (const city of F.CITY_ORDER) for (const id of F.CITY_BRANCH[city]) assert.equal(F.canAutoPick(g4, F.model(id)), false, '城市特色车型一律不自动选用：' + id);
// 车辆段有同型空闲车：先调车；城市特色车再合适也不会被调走
const g5 = mkG({ y: 2012, routes: [autoRoute], trains: [
  { id: 'C1', model: 'gz-a8', cars: 8, bought: 0, cost: 1, line: null },
  { id: 'M1', model: 'gen-eco', cars: 8, bought: 0, cost: 1, line: null },
] });
g5.fleet.autoConfig = true;
const need = F.lineInfo(g5, 'L1').reduce((a, x) => a + Math.max(x.peakNeed, x.floor), 0);
assert.ok(need > 0, '前提：交路有最低服务需求');
const r5 = F.autoConfigRun(g5);
assert.equal(g5.fleet.trains[0].line, null, '城市特色车留在车辆段');
assert.equal(g5.fleet.trains[1].line, 'L1', '主力空闲车被调上线');
assert.ok(r5.bought > 0, '仍缺的部分自动购买主力车型');
assert.ok(g5.fleet.trains.filter(t => t.line === 'L1').every(t => !F.isCity(F.model(t.model))), '自动配置后的线上列车全是主力车型');
assert.ok(g5.fleet.trains.filter(t => t.line === 'L1').every(t => t.model === 'gen-eco'), '自动购买的是当年主力目标车型');
assert.equal(g5.fleet.trains.filter(t => !t.line).length, 1, '只有城市特色车留在车辆段');
// 智能分配同样不碰城市特色车
assert.equal(F.allocPlan(g5).moved, 0, '配齐后没有可分配的列车');
assert.equal(F.allocPlan(g5).left, 0, '城市特色车不计入可分配列车');
// 补车报价永远只列主力车型
const g6 = mkG({ y: 2012, routes: [{ ...autoRoute, kmh: 130 }], lines: { L1: { id: 'L1', name: '1 号线', speed: 130 } } });
const fill = F.fillCost(g6, F.allocPlan(g6));
assert.equal(fill.rows.length, 0, '当年主力没有能跑 130 km/h 的车型时不自动补车，也不退而买城市特色车');
console.log('PASS 4 自动配置 / 智能分配只补主力车型，城市特色车只能手动购买与调入');

// ================= 5. 新款主力解锁后：旧款主力与城市特色车都可补差价升级 =================
// 1985 年 A 型车（T4）上市：上一代 B 型车（T3）与城市特色车都进入待升级列表
const g7 = mkG({ mapId: 'bj', y: 1985, trains: [
  TRAIN('T1', 'gen-steel', 8, 'L1'),
  TRAIN('T2', 'bj-dk', 6, 'L1'),
  TRAIN('T3', 'gen-steel', 8, 'L2'),
] });
assert.equal(F.techTarget(g7, 'L1').m.id, 'gen-a', '1985 年主力目标升到 T4 大运量 A 型车');
assert.deepEqual(Array.from(F.staleTech(g7, 'L1'), t => t.id), ['T1', 'T2'], '旧款主力与城市特色车都在待升级列表');
assert.equal(g7.fleet.trains[2].id, 'T3', '别的线路不受影响');
// 1984 年 A 型车尚未上市：B 型车不是待升级，城市特色车仍可升级
const g7b = mkG({ mapId: 'bj', y: 1984, trains: [TRAIN('T1', 'gen-steel', 8, 'L1'), TRAIN('T2', 'bj-dk', 6, 'L1')] });
assert.deepEqual(Array.from(F.staleTech(g7b, 'L1'), t => t.id), ['T2'], '当年主力仍是 B 型车时，B 型车不提示升级；城市特色车仍可升级');
assert.equal(F.techTarget(g7b, 'L1').m.id, 'gen-steel');

// 报价：换车型按「新车当年价 − 旧车残值」补差价，城市特色车同样按残值抵扣
const list7 = g7.fleet.trains.filter(t => t.line === 'L1');
const q7 = F.techQuote(g7, list7, 'L1');
const np7 = F.price(g7, F.model('gen-a'), 8, 1985);
const res7 = list7.reduce((a, t) => a + F.residual(g7, t), 0);
assert.equal(q7.n, 2);
assert.equal(q7.reset, 2, '两列都换车型');
assert.equal(q7.targetCars, 8);
assert.ok(Math.abs(q7.credit - res7) < 1e-6, '残值抵扣包含城市特色车');
assert.ok(Math.abs(q7.cost - Math.max(0, np7 - F.residual(g7, list7[0])) - Math.max(0, np7 - F.residual(g7, list7[1]))) < 1e-6, '补差价沿用残值抵扣口径');
// 执行：车型、编组、车龄、成本、等级、性能与配属全部同步更新
g7.fleet.trains[0].svc = 'cw';
const r7 = F.upgradeTech(g7, 'L1');
assert.equal(r7.ok, true);
assert.equal(r7.n, 2);
for (const t of [g7.fleet.trains[0], g7.fleet.trains[1]]) {
  const m = F.model(t.model);
  assert.equal(t.model, 'gen-a', '升级到当年主力车型');
  assert.equal(t.cars, 8, '编组升到目标编组');
  assert.equal(t.bought, g7.ym(), '换车型后车龄重置');
  assert.equal(t.cost, Math.round(np7), '车体成本按新车型入账');
  assert.equal(F.tierOf(m), 4, '等级更新为 T4');
  assert.equal(m.cap, 310, '定员取新车型');
  assert.equal(m.kmh, 80, '限速取新车型');
  assert.equal(m.ops, 0.96, '运营成本取新车型');
  assert.equal(t.line, 'L1', '配属线路不变');
}
assert.equal(g7.fleet.trains[0].svc, 'cw', '配属交路不变');
assert.equal(g7.fleet.trains[2].model, 'gen-steel', '其他线路的列车不动');
assert.equal(F.staleTech(g7, 'L1').length, 0, '升级后没有待升级列车');
assert.ok(F.upgradeTech(g7, 'L1').error, '重复升级会被拒绝');
assert.ok(spent.some(s => /列车升级/.test(s)), '扣费走建设支出');
assert.ok(logs.some(l => /残值/.test(l.desc) && /车龄重置/.test(l.desc)), '日志写明残值抵扣与车龄重置');
console.log('PASS 5 旧款主力与城市特色车一键补差价升级，等级 / 性能 / 配属同步更新');

// ================= 6. 160 轨道：城市特色车升级为独立支线的 D 型车 =================
const g8 = mkG({ y: 2020, lines: { L1: { id: 'L1', name: '1 号线', speed: 160 } }, routes: [{ ...autoRoute, kmh: 160 }], trains: [
  TRAIN('T1', 'gz-a8', 6, 'L1'),
  TRAIN('T2', 'gen-d160', 8, 'L1', 2015 * 12),
] });
assert.equal(F.techTarget(g8, 'L1').m.id, 'gen-d160', '160 轨道的升级目标仍是 D 型车');
assert.equal(F.techTarget(g8, 'L1').cars, 8, 'D 型车固定 8 节');
assert.deepEqual(Array.from(F.staleTech(g8, 'L1'), t => t.id), ['T1'], '只有非 D 型车待升级，D 型车本身不动');
const r8 = F.upgradeTech(g8, 'L1');
assert.equal(r8.ok, true);
assert.equal(g8.fleet.trains[0].model, 'gen-d160', '城市特色车在 160 轨道上升级为 D 型车');
assert.equal(g8.fleet.trains[0].cars, 8, '按 D 型车固定 8 节');
assert.equal(F.tierOf(F.model(g8.fleet.trains[0].model)), 0, 'D 型车不参与 T 级');
assert.equal(g8.fleet.trains[1].model, 'gen-d160');
assert.equal(g8.fleet.trains[1].bought, 2015 * 12, '原有 D 型车的车龄不变');
assert.ok(F.upgradeD(g8, 'L1').error, '没有可改装列车时报错');
console.log('PASS 6 160 轨道上的城市特色车升级为 D 型车，D 型车本身不被改动');

// ================= 7. 旧存档：城市特色车保留，不会自动换车型 =================
const g9 = mkG({ y: 2020, trains: [TRAIN('C1', 'gz-a8', 6, 'L1', 2012 * 12)] });
assert.equal(g9.fleet.trains[0].model, 'gz-a8');
assert.equal(F.canTechUpgrade(g9.fleet.trains[0]), true, '可以升级，但不是自动的');
assert.equal(g9.fleet.trains[0].model, 'gz-a8', '不点升级不会自动换车型');
assert.ok(F.ownsModel(g9, 'gz-a8'), '已购置记录保留');
console.log('PASS 7 旧存档的城市特色车保留原车型，升级是可选项');

console.log('ALL PASS v5.0 车型分级 / 自动配置门禁 / 城市特色车升级');
