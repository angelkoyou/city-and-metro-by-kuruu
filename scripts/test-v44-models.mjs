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
assert.equal(F.buyList(g2a, 'L1').defaultModel.id, 'gen-super', '2030 年起默认选中 T7 超级列车');
assert.ok(F.buyList(g2a, 'L1').list.every(m => m.id === 'gen-auto' || m.id === 'gen-super' || m.only160), '只卖当前一代主力（T6 / T7）与 160 专用车');
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
assert.equal(F.ownsModel(g3, 'gz-a8'), true, '买过之后记为已购置');
assert.equal(F.canAutoPick(g3, F.model('gz-a8')), false, 'v5.0：已购置的城市特色车型也不参与任何自动流程');
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
console.log('PASS 3 城市特色车型的已购置记录与旧存档迁移（不再作为自动选用的门禁）');

// ================= 4. v5.0：城市特色车与旧款主力一起升级到当前主力 =================
const g4 = mkG({ mapId: 'gz', y: 2012, trains: [
  TRAIN('T1', 'gen-a', 8, 'L1'),        // 旧款主力 → 可升级
  TRAIN('T2', 'gz-a8', 4, 'L1'),       // 城市特色车 → 同样可升级
  TRAIN('T3', 'gz-a8', 8, 'L1'),       // 城市特色车已满编
  TRAIN('T4', 'gen-a', 4, 'L2'),       // 别的线路
]});
assert.equal(F.canTechUpgrade(TRAIN('X', 'gz-a8', 4, 'L1')), true, '城市特色车可进入科技树升级');
assert.equal(F.canTechUpgrade(TRAIN('X', 'gen-a', 4, 'L1')), true);
assert.equal(F.latestModel(g4, 'L1').id, 'gen-eco', '升级目标仍取主力（T5）');
assert.equal(F.techTarget(g4, 'L1').m.id, 'gen-eco');
assert.deepEqual(Array.from(F.staleTech(g4, 'L1'), t => t.id), ['T1', 'T2', 'T3'], '旧款主力与城市特色车都在待升级列表');
const forced = g4.fleet.trains.filter(t => t.line === 'L1');
const q4 = F.techQuote(g4, forced, 'L1');
assert.equal(q4.n, 3, '报价包含城市特色车');
assert.equal(q4.reset, 3, '三列都换车型');
assert.equal(q4.target, F.model('gen-eco'));
const before4 = g4.fleet.trains.map(t => ({ model: t.model, cars: t.cars, bought: t.bought }));
const r4 = F.upgradeTech(g4, 'L1');
assert.equal(r4.ok, true);
assert.equal(g4.fleet.trains[0].model, 'gen-eco', '旧款主力升级到 T5');
assert.equal(g4.fleet.trains[1].model, 'gen-eco', '城市特色车也升级到当前主力');
assert.equal(g4.fleet.trains[1].cars, 8, '编组同步升到目标编组');
assert.equal(g4.fleet.trains[1].bought, g4.ym(), '换车型后车龄重置');
assert.equal(g4.fleet.trains[1].cost, Math.round(F.price(g4, F.model('gen-eco'), 8, 2012)), '车体成本按新车型入账');
assert.equal(g4.fleet.trains[2].model, 'gen-eco', '满编城市特色车同样换车型');
assert.equal(g4.fleet.trains[3].model, before4[3].model, '别的线路不受影响');
assert.equal(F.tierOf(F.model(g4.fleet.trains[1].model)), 5, '升级后等级为 T5');
assert.equal(F.model(g4.fleet.trains[1].model).cap, 320, '升级后定员取新车型');
// 无人驾驶 / D 型两条换车型通道同样按「可升级」处理（v5.0 起含城市特色车）
const g4a = mkG({ mapId: 'gz', y: 2030, trains: [TRAIN('A1', 'gz-a8', 6, 'L1'), TRAIN('A2', 'gen-a', 6, 'L1')] });
assert.deepEqual(Array.from(F.staleAuto(g4a, 'L1'), t => t.id), ['A1', 'A2'], '无人驾驶改装含城市特色车，目标是 T6');
const g4d = mkG({ mapId: 'gz', y: 2012, lines: { L1: { id: 'L1', name: '1 号线', speed: 160 } },
  trains: [TRAIN('D1', 'gz-a8', 6, 'L1'), TRAIN('D2', 'gen-a', 6, 'L1')] });
assert.deepEqual(Array.from(F.staleD(g4d, 'L1'), t => t.id), ['D1', 'D2'], '160 轨道上的城市特色车也改装为 D 型');
console.log('PASS 4 城市特色车与旧款主力一起补差价升级到当前主力');

// ================= 5. 升级后的等级 / 性能 / 配属状态 =================
const g5 = mkG({ mapId: 'gz', y: 2012, trains: [
  TRAIN('C1', 'gz-a8', 4, 'L1'),
  TRAIN('C2', 'gz-a8', 8, 'L1'),
  TRAIN('C3', 'gen-a', 4, 'L1'),
]});
g5.fleet.trains[0].svc = 'ccw';
const before5 = g5.fleet.trains.map(t => ({ model: t.model, bought: t.bought, line: t.line, svc: t.svc }));
const q5 = F.techQuote(g5, g5.fleet.trains.filter(t => t.line === 'L1'), 'L1');
assert.equal(q5.n, 3);
assert.ok(q5.credit > 0, '城市特色车按残值抵扣');
const r5 = F.upgradeTech(g5, 'L1');
assert.equal(r5.ok, true);
assert.equal(g5.fleet.trains[0].model, 'gen-eco');
assert.equal(g5.fleet.trains[0].cars, 8, '小编组城市特色车升级后达到目标编组');
assert.equal(g5.fleet.trains[0].bought, g5.ym(), '车龄重置');
assert.equal(g5.fleet.trains[0].line, before5[0].line, '配属线路不变');
assert.equal(g5.fleet.trains[0].svc, before5[0].svc, '配属交路不变');
assert.equal(F.tierOf(F.model(g5.fleet.trains[0].model)), 5, '等级更新为 T5');
assert.equal(F.model(g5.fleet.trains[0].model).cap, 320, '定员随车型更新');
assert.ok(spent.some(s => /列车升级/.test(s)), '扣费走建设支出');
assert.ok(logs.some(l => /残值/.test(l.desc)), '日志写明残值抵扣');
console.log('PASS 5 升级后等级、性能与配属状态同步更新');

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
// 车辆段里的城市特色车（即使已购置、车队里就有）也不参与智能分配与自动配置
const gB = withResults(mkAuto({ trains: [{ id: 'X1', model: 'gz-a8', cars: 8, bought: 0, cost: 1, line: null }] }));
const pB = F.allocPlan(gB);
assert.equal(pB.moved, 0, '城市特色车不参与智能分配');
assert.equal(pB.left, 0, '城市特色车不计入可分配列车');
assert.ok(pB.unmet > 0, '缺口仍然存在，等待主力车型补足');
const rb = F.autoConfigRun(gB);
assert.equal(gB.fleet.trains[0].line, null, '自动配置不会把城市特色车调上线');
assert.ok(rb.bought > 0, '缺口改由自动购买主力车型补足');
assert.ok(gB.fleet.trains.filter(t => t.line === 'L1').every(t => !F.isCity(F.model(t.model))), '自动配置买的都是主力车型');
// 补车报价也只列主力车型；主力没有能跑的车型时不补车
const gC = mkAuto({ routes: [{ ...autoRoute, kmh: 130 }], lines: { L1: { id: 'L1', name: '1 号线', speed: 130 } } });
const fillC = F.fillCost(gC, F.allocPlan(gC));
assert.ok(fillC.rows.every(r => !F.isCity(r.m)), 'fillCost 不买城市特色车型');
assert.equal(fillC.rows.length, 0, '主力没有能跑 130 km/h 的车型时直接不补车');
console.log('PASS 6 自动配置只补主力车型，城市特色车只能手动调派');

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

console.log('ALL PASS v5.0 车型分级 / 自动配置只补主力 / 城市特色车补差价升级');
