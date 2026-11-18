// v4.4 回归：新建线路默认车型、城市特色车型的「已购置」门禁、升级判断、自动配置。
// 统一规则入口：F.isCity / F.isTrunk / F.is160Model / F.ownsModel / F.canAutoPick /
//               F.canTechUpgrade / F.trunkModel / F.recommend。不读写玩家存档。
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
const C = c.CM, M = C.Metro, CFG = C.CFG;
C.UI = function () {};
for (const name of ['settings', 'corp', 'fleet', 'cheat']) await load('js/' + name + '.js');
const F = C.Fleet, E = C.Economy;
C.Difficulty.loadGame('normal', null);

const spent = [], logs = [], toasts = [];
const mkG = (o = {}) => {
  const lines = o.lines || { L1: { id: 'L1', name: '1 号线' } };
  const net = { lines: lines, stations: {}, segments: {}, rideEdge: [], R: 1 };
  net.C = { routes: o.routes || [{ lineId: 'L1', cars: 8 }], rideEdge: [], R: 1, net: net };
  const g = {
    mapId: o.mapId || 'gz', clock: { y: o.y || 2020, m: 3, d: 1 },
    net: net, compiled: net.C,
    econ: {
      isFree: () => !!o.free, isInfinite: () => !!o.infinite, isSandbox: () => !!(o.free || o.infinite),
      difficulty: o.difficulty || 'normal', costIndex: () => 1,
      canAffordBuild: () => o.afford !== false, spendBuild: (x, t) => { spent.push(t); }, log() {},
    },
    fleet: o.fleet === null ? undefined : Object.assign({ ver: 1, seq: 1, trains: o.trains || [], ops: {}, note: {} }, o.fleet || {}),
    model: { net: net, applyFleet() {}, trafficReady: () => true, resultsFor: () => null, solveNow() {} },
    touch() {}, emit(x, p) { toasts.push(p); }, logEvent(x) { logs.push(x); }, ym: () => (o.y || 2020) * 12 + 3,
  };
  return g;
};
const TRAIN = (id, model, cars, line, bought) => ({ id: id, model: model, cars: cars, bought: bought == null ? 2010 * 12 : bought, cost: 1000, line: line == null ? 'L1' : line, svc: null });
// 交路桩：serviceFloor 需要站数与线路长度，lineInfo 需要 cycleSec / stIds / label
const autoRoute = { lineId: 'L1', cars: 8, cycleSec: 3600, stIds: ['a', 'b'], stIdx: [0, 1], lenM: 2400, loop: false, label: '1 号线', cap: 2480, kmh: 80 };

// ================= 1. 车型归属与统一规则入口 =================
assert.equal(F.isCity(F.model('gz-a8')), true, '本城专属车型是城市特色车型');
assert.equal(F.isCity(F.model('gen-eco')), false, '通用车型不是城市特色车型');
assert.equal(F.isTrunk(F.model('gen-eco')), true, '节能车属于主干');
assert.equal(F.isTrunk(F.model('gz-a8')), false);
assert.equal(F.is160Model(F.model('gen-d160')), true, 'D 型车属于 160 支线');
for (const id of F.TRUNK) assert.equal(F.isCity(F.model(id)), false, '主干里不能有城市特色车型：' + id);
for (const id of ['gz', 'sh', 'bj', 'hz', 'wh', 'hk', 'tp', 'pa', 'tk'])
  for (const mid of F.CITY_BRANCH[id]) assert.equal(F.isCity(F.model(mid)), true, id + ' 支线 ' + mid);
// trunkModel / recommend：只从主干（160 取 D 型）里挑，绝不落到城市特色车型
for (const y of [1990, 2000, 2010, 2020, 2026, 2060]) {
  const m = F.trunkModel('gz', y, 80);
  assert.ok(m && !F.isCity(m), y + ' 年 80 km/h 的推荐车型必须是主干');
  assert.equal(F.recommend('gz', y, 80).id, m.id, 'recommend 与 trunkModel 同源');
}
assert.equal(F.trunkModel('gz', 2020, 160).id, 'gen-d160');
assert.equal(F.trunkModel('gz', 2000, 160), null, 'D 型车上市前 160 线没有主干车型');
assert.equal(F.trunkModel('gz', 2015, 130), null, '主干最快 120 km/h，不能退回城市特色车凑速度');
// 上海 2013 年只有 sh-16 能跑 120 km/h：v4.4 下宁可不配车，也不用城市特色车型
assert.equal(F.recommend('sh', 2013, 120), null, '自动选用绝不落到城市支线车型');
assert.equal(F.recommend('sh', 2026, 120).id, 'gen-auto', '主干全自动车上市后可以跑 120 km/h');
console.log('PASS 1 车型归属与统一规则入口');

// ================= 2. 新建线路 / 购车弹窗的默认车型 =================
// F.available 把本城车型排在最前，旧版 showTrainShop 的 list[0] 因此会默认选中城市特色车
const g2 = mkG({ mapId: 'gz', y: 2012 });
assert.equal(F.available('gz', 2012)[0].maps !== null, true, '前提：本城车型排在购车列表首位');
const bl = F.buyList(g2, 'L1');
assert.ok(bl.defaultModel && !F.isCity(bl.defaultModel), '默认选中必须是主干车型');
assert.equal(bl.defaultModel.id, F.recommend('gz', 2012, 80).id, '默认选中与随线配车同源');
assert.equal(bl.defaultModel.id, 'gen-eco', '2012 年广州的主干默认是节能车，不是国产 A 型');
// 160 轨道：默认选中 D 型车
const g2d = mkG({ mapId: 'gz', y: 2012, lines: { L1: { id: 'L1', name: '1 号线', speed: 160 } } });
assert.equal(F.buyList(g2d, 'L1').defaultModel.id, 'gen-d160');
// 无人驾驶时代：只卖全自动车与 D 型车，默认值仍是主干
const g2a = mkG({ mapId: 'gz', y: 2030 });
assert.equal(F.buyList(g2a, 'L1').defaultModel.id, 'gen-auto');
assert.ok(F.buyList(g2a, 'L1').list.every(m => m.id === 'gen-auto' || m.only160));
// 车辆段（lid 为空）也一样不默认城市特色车
assert.ok(!F.isCity(F.buyList(g2, null).defaultModel));
console.log('PASS 2 新建线路与购车弹窗默认车型只取主干');

// ================= 3. 「已购置」门禁 =================
const g3 = mkG({ mapId: 'gz', y: 2012 });
assert.equal(F.ownsModel(g3, 'gz-a8'), false, '没买过的城市特色车型不可用');
assert.equal(F.ownsModel(g3, 'gen-eco'), true, '主干车型恒可用');
assert.equal(F.ownsModel(g3, 'gen-d160'), true, '160 支线恒可用');
assert.equal(F.canAutoPick(g3, F.model('gz-a8')), false, '未购置的城市特色车型不能被自动选中');
assert.equal(F.canAutoPick(g3, F.model('gen-eco')), true);
F.markOwned(g3, 'gz-a8');
assert.equal(F.ownsModel(g3, 'gz-a8'), true, '买过之后解锁');
assert.equal(F.canAutoPick(g3, F.model('gz-a8')), true);
assert.equal(g3.fleet.owned.length, 1, 'owned 去重');
F.markOwned(g3, 'gz-a8');
assert.equal(g3.fleet.owned.length, 1);
// 购买列车时自动登记（F.buy → newTrain → markOwned）
const g3b = mkG({ mapId: 'gz', y: 2012, free: true });
const buyR = F.buy(g3b, null, null, 'gz-a8', 6, 1);
assert.equal(buyR.ok, true);
assert.equal(F.ownsModel(g3b, 'gz-a8'), true, '购车弹窗里手动购买会记入 owned');
// 车队里已有该车型、但旧存档没有 owned 字段时，按现有列车补记
const g3c = mkG({ mapId: 'gz', y: 2012, routes: [autoRoute], trains: [TRAIN('T1', 'gz-a8', 6, 'L1')] });
assert.equal(g3c.fleet.owned, undefined, '前提：模拟旧存档没有 owned');
F.ensure(g3c);
assert.equal(F.ownsModel(g3c, 'gz-a8'), true, '旧存档按现有列车补记已购置状态');
assert.ok(Array.isArray(g3c.fleet.owned) && g3c.fleet.owned.indexOf('gz-a8') >= 0);
console.log('PASS 3 城市特色车型的已购置门禁与旧存档迁移');

// ================= 4. 科技树升级判定完全排除城市特色车 =================
const g4 = mkG({ mapId: 'gz', y: 2012, trains: [
  TRAIN('T1', 'gen-a', 8, 'L1'),        // 主干旧车 → 可升级
  TRAIN('T2', 'gz-a8', 4, 'L1'),       // 城市特色车 → 不可进科技树升级，只可扩编
  TRAIN('T3', 'gz-a8', 8, 'L1'),       // 城市特色车已满编
  TRAIN('T4', 'gen-a', 4, 'L2'),       // 别的线路
]});
assert.equal(F.canTechUpgrade(TRAIN('X', 'gz-a8', 4, 'L1')), false);
assert.equal(F.canTechUpgrade(TRAIN('X', 'gen-a', 4, 'L1')), true);
assert.equal(F.latestModel(g4, 'L1').id, 'gen-eco', '升级目标取主干');
assert.equal(F.techTarget(g4, 'L1').m.id, 'gen-eco');
assert.deepEqual(Array.from(F.staleTech(g4, 'L1'), t => t.id), ['T1'], '城市特色车不进待升级列表');
// 即使外部硬把城市特色车塞进 list，报价与执行也不会给它换车型
const forced = g4.fleet.trains.filter(t => t.line === 'L1');
const q4 = F.techQuote(g4, forced, 'L1');
assert.equal(q4.n, 1, 'techQuote 自己再过滤一次，只算主干车');
assert.equal(q4.reset, 1);
const r4 = F.upgradeTech(g4, 'L1');
assert.equal(r4.ok, true);
assert.equal(g4.fleet.trains[0].model, 'gen-eco');
assert.equal(g4.fleet.trains[1].model, 'gz-a8', '城市特色车不会被换成主干车型');
assert.equal(g4.fleet.trains[1].cars, 4, '也不会被科技树流程顺手扩编');
assert.equal(g4.fleet.trains[1].bought, 2010 * 12, '车龄不变');
// 无人驾驶 / D 型改装两条换车型通道同样排除
const g4a = mkG({ mapId: 'gz', y: 2030, trains: [TRAIN('A1', 'gz-a8', 6, 'L1'), TRAIN('A2', 'gen-a', 6, 'L1')] });
assert.deepEqual(Array.from(F.staleAuto(g4a, 'L1'), t => t.id), ['A2'], '无人驾驶改装不含城市特色车');
const g4d = mkG({ mapId: 'gz', y: 2012, lines: { L1: { id: 'L1', name: '1 号线', speed: 160 } },
  trains: [TRAIN('D1', 'gz-a8', 6, 'L1'), TRAIN('D2', 'gen-a', 6, 'L1')] });
assert.deepEqual(Array.from(F.staleD(g4d, 'L1'), t => t.id), ['D2'], 'D 型改装不含城市特色车');
console.log('PASS 4 科技树升级 / 改装判定与流程完全排除城市特色车');

// ================= 5. 城市特色车只能同车型补差价扩编 =================
const g5 = mkG({ mapId: 'gz', y: 2012, trains: [
  TRAIN('C1', 'gz-a8', 4, 'L1'),
  TRAIN('C2', 'gz-a8', 8, 'L1'),
  TRAIN('C3', 'gen-a', 4, 'L1'),
]});
assert.deepEqual(Array.from(F.cityStaleCars(g5, 'L1'), t => t.id), ['C1'], '只有编组不足的城市特色车可扩编');
assert.equal(F.staleTech(g5, 'L1').length, 1, '同线的主干车仍走科技树升级，两套流程互不干扰');
const before = g5.fleet.trains.map(t => ({ model: t.model, bought: t.bought }));
const r5 = F.upgradeCityCars(g5, 'L1');
assert.equal(r5.ok, true);
assert.equal(g5.fleet.trains[0].cars, 8, '编组扩到线路上限');
assert.equal(g5.fleet.trains[0].model, before[0].model, '车型不变');
assert.equal(g5.fleet.trains[0].bought, before[0].bought, '车龄不变');
assert.equal(g5.fleet.trains[2].model, 'gen-a', '主干车不受城市特色车扩编影响');
assert.equal(g5.fleet.trains[2].cars, 4);
assert.ok(F.upgradeCityCars(g5, 'L1').error, '已扩满后再次调用被拒绝');
assert.ok(spent.some(s => /城市特色车扩编/.test(s)), '扣费走建设支出');
assert.ok(logs.some(l => /城市特色车/.test(l.desc) && /补差价/.test(l.desc)));
console.log('PASS 5 城市特色车补差价升级仅限编组升级');

// ================= 6. 自动配置只买主干车型 =================
const mkAuto = (o = {}) => {
  const g = mkG({ mapId: 'gz', y: 2012, ...o, routes: o.routes || [autoRoute] });
  g.fleet.autoConfig = o.on !== false;
  return g;
};
const need = g => F.lineInfo(g, 'L1').reduce((a, x) => a + Math.max(x.peakNeed, x.floor), 0);
const gA = mkAuto();
const nA = need(gA);
assert.ok(nA > 0, '前提：交路有最低服务需求');
const ra = F.autoConfigRun(gA);
assert.equal(ra.bought, nA);
assert.ok(gA.fleet.trains.every(t => t.model === 'gen-eco'), '自动配置买的必须是主干目标车型，不是 gz-a8');
assert.ok(gA.fleet.trains.every(t => !F.isCity(F.model(t.model))), '自动配置绝不购买城市特色车型');
// 造出真实的高峰缺口，让智能分配确实需要向车辆段要车
const withResults = g => {
  const net = g.model.net;
  net.R = 1; net.rideEdge = [[0]]; net.C.R = 1; net.C.rideEdge = [[0]];
  g.model.resultsFor = () => ({ per: [0, 1, 2, 3].map(() => ({ freq: [10], load: [0] })) });
  return g;
};
// 车队里已有城市特色车 = 已购置，这时可以参与智能分配；未购置时统一门禁会挡住
const gB = withResults(mkAuto({ trains: [{ id: 'X1', model: 'gz-a8', cars: 8, bought: 0, cost: 1, line: null }] }));
assert.ok(F.allocPlan(gB).moved > 0, '已购置的城市特色车可以参与智能分配');
const origOwns = F.ownsModel;
F.ownsModel = function (gg, m) { return origOwns(gg, m) && (typeof m === 'string' ? m : m.id) !== 'gz-a8'; };
assert.equal(F.allocPlan(gB).moved, 0, '未购置的城市特色车不参与智能分配');
F.ownsModel = origOwns;
// 补车报价也只列主干车型；主干没有能跑的车型时不补车
const gC = mkAuto({ routes: [{ ...autoRoute, kmh: 130 }], lines: { L1: { id: 'L1', name: '1 号线', speed: 130 } } });
const fillC = F.fillCost(gC, F.allocPlan(gC));
assert.ok(fillC.rows.every(r => !F.isCity(r.m)), 'fillCost 不买城市特色车型');
assert.equal(fillC.rows.length, 0, '主干没有能跑 130 km/h 的车型时直接不补车');
console.log('PASS 6 自动配置只买主干、城市特色车需购置后才参与');

// ================= 7. 随线配车（草案）不自动选城市特色车型 =================
const g7 = mkG({ mapId: 'gz', y: 2012 });
const draftNet = { lines: { L1: { id: 'L1', name: '1 号线' } }, stations: {}, segments: {}, rideEdge: [], R: 1 };
draftNet.C = { routes: [{ ...autoRoute, cars: 8 }], rideEdge: [], R: 1, net: draftNet };
const plan7 = F.plan(g7, draftNet);
assert.ok(plan7 && plan7[0], '草案预测能算出配车计划');
assert.ok(plan7[0].avail[0] > 0, '按主干车型补足最低服务水平');
assert.ok((plan7[0].units[0] || []).every(u => !F.isCity(u.m)), '草案预填的列车不是城市特色车型');
// 主干没有能跑的速度时不预填（不崩溃、也不落到城市支线）
const g7b = mkG({ mapId: 'gz', y: 2012 });
const fastNet = { lines: { L1: { id: 'L1', name: '1 号线' } }, stations: {}, segments: {}, rideEdge: [], R: 1 };
fastNet.C = { routes: [{ ...autoRoute, cars: 8, kmh: 130 }], rideEdge: [], R: 1, net: fastNet };
const plan7b = F.plan(g7b, fastNet);
assert.ok(plan7b && plan7b[0], '主干没有合适车型时也不崩');
assert.equal(plan7b[0].avail[0], 0, '不会用城市特色车型凑速度');
console.log('PASS 7 草案随线配车只按主干补足');

console.log('ALL PASS v4.4 车型配置 / 购置门禁 / 升级判定 / 自动配置');
