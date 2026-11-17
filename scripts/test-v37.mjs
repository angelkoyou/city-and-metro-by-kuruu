// v3.7 回归：车型科技树（单主干 + 9 条城市支线 + 160 支线）、全城市一键补差价升级、
// 自动配置列车总开关、无限贷款独立开关（v3.8 从难度档解耦）、作弊设施读档后不消失。不读写玩家存档。
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

const F = C.Fleet, D = C.Difficulty, E = C.Economy;
D.loadGame('normal', null);   // 价格断言用无倍率基准

const spent = [], logs = [], toasts = [];
const mkG = (o = {}) => {
  const lines = o.lines || { L1: { id: 'L1', name: '1 号线' } };
  const net = { lines: lines, stations: {}, segments: {}, rideEdge: [], R: 1 };
  // C.net 必须指回 g.net，否则计划层会把本条线网当成草案、按「随线配车」预填列车
  net.C = { routes: o.routes || [{ lineId: 'L1', cars: 8 }], rideEdge: [], R: 1, net: net };
  return {
    mapId: o.mapId || 'bj', clock: { y: o.y || 2020, m: 3, d: 1 },
    net: net,
    econ: {
      isFree: () => !!o.free, isInfinite: () => !!o.infinite, isSandbox: () => !!(o.free || o.infinite),
      difficulty: o.difficulty || 'normal', costIndex: () => 1,
      canAffordBuild: () => o.afford !== false, spendBuild: (x, t) => { spent.push(t); }, log() {},
    },
    fleet: { ver: 1, seq: 1, trains: o.trains || [], ops: {}, note: {} },
    model: {
      net: net,
      applyFleet() {}, trafficReady: () => true, resultsFor: () => null, solveNow() {},
    },
    touch() {}, emit(x, p) { toasts.push(p); }, logEvent(x) { logs.push(x); }, ym: () => (o.y || 2020) * 12 + 3,
  };
};

// ================= 1. 科技树结构：单主干 + 9 条城市支线 + 160 支线 =================
assert.deepEqual(Array.from(F.TRUNK), ['gen-early', 'gen-classic', 'gen-steel', 'gen-a', 'gen-eco', 'gen-auto'], '主干 6 个世代');
assert.equal(F.CITY_ORDER.length, 9, '9 条城市支线');
assert.equal(Object.keys(F.CITY_BRANCH).length, 9);
for (const id of F.CITY_ORDER) assert.ok(Array.isArray(F.CITY_BRANCH[id]) && F.CITY_BRANCH[id].length, id + ' 支线不能为空');
// 每条支线的车型都必须存在、且属于该城市、按上市年递增
for (const id of F.CITY_ORDER) {
  const list = F.CITY_BRANCH[id].map(mid => F.model(mid));
  for (const m of list) assert.ok(m.maps && m.maps.indexOf(id) >= 0, id + ' 支线的 ' + m.id + ' 必须是本城专属车型');
  const yrs = list.map(m => m.from);
  assert.deepEqual(Array.from(yrs), Array.from(yrs).sort((a, b) => a - b), id + ' 支线按年份排列：' + yrs.join(','));
}
// 主干车型必须是通用车型（不限城市）
for (const id of F.TRUNK) {
  const m = F.model(id);
  assert.equal(m.maps, null, '主干 ' + id + ' 应为通用车型');
  assert.ok(!m.only160, '主干 ' + id + ' 不应是 160 专用');
}
assert.deepEqual(Array.from(F.BRANCH_160), ['gen-d160'], '160 支线只有 D 型车');
assert.equal(F.model('gen-d160').fixedCars, 8);
// 地图 → 城市支线：经典广州图与教程图
assert.equal(F.cityOfMap('gz'), 'gz');
assert.equal(F.cityOfMap('gz1990'), 'gz', '经典广州图归到广州支线');
assert.equal(F.cityOfMap('tutorial'), null, '教程图没有城市支线');
assert.equal(F.cityOfMap('nowhere'), null);
// rank：160 支线 > 城市支线 > 主干；同组按年份与序号
assert.ok(F.rank(F.model('gen-d160')) > F.rank(F.model('gz-a8')));
assert.ok(F.rank(F.model('gz-a8')) > F.rank(F.model('gen-auto')));
assert.ok(F.rank(F.model('tk-13000')) > F.rank(F.model('tk-05')), '同一支线内后上市的节点序号更大');
assert.equal(F.rank(null), 0);
console.log('PASS 科技树结构（主干 6 世代 / 9 城市支线 / 160 支线）');

// ================= 2. 节点按年份自动点亮 =================
const t1990 = F.treeNodes('gz', 1990, 'gz');
assert.equal(t1990.city, 'gz');
assert.deepEqual(Array.from(t1990.trunk, n => n.lit), [true, true, true, true, false, false], '1990 年只点亮到 A 型车');
assert.deepEqual(Array.from(t1990.trunk, n => n.sale), [false, false, true, true, false, false], '1990 年在售钢制车与 A 型车');
assert.equal(t1990.branch.length, 3, '广州支线 3 个节点');
assert.equal(t1990.branch.filter(n => n.lit).length, 0, '1990 年广州专属车型都还没上市');
assert.equal(t1990.d160[0].lit, false, '1990 年还没有 160 支线');
const t2026 = F.treeNodes('gz', 2026, 'gz');
assert.equal(t2026.trunk.filter(n => !n.lit).length, 0, '2026 年主干全部点亮');
assert.equal(t2026.branch.filter(n => !n.lit).length, 0, '2026 年广州支线全部点亮');
assert.equal(t2026.d160[0].lit, true);
// retired：停售年份之后
assert.equal(t2026.trunk[0].retired, true);
assert.equal(t2026.trunk[0].sale, false);
// 别的城市的支线在本图不可买（own = false）
const tOther = F.treeNodes('gz', 2026, 'hk');
assert.equal(tOther.branch.length, 3);
assert.equal(tOther.branch.filter(n => n.own).length, 0, '在gz 图上香港车型不可买（只作展示）');
assert.equal(F.treeNodes('tutorial', 2026, null).branch.length, 0, '教程图没有城市支线');
console.log('PASS 科技树节点按年份自动点亮');

// ================= 3. 当前最新车型：按上市年取最新，不按城市优先 =================
const gz = (y, lid) => mkG({ mapId: 'gz', y: y, ...(lid ? { lines: { L1: { id: 'L1', name: '1 号线', speed: lid } } } : {}) });
assert.equal(F.latestModel(gz(2006), null).id, 'gz-l4', '2006 年本城最新是 L4 型（2005）');
assert.equal(F.latestModel(gz(2009), null).id, 'gen-eco', '2009 年主干节能车（2008）比 L4 型新');
assert.equal(F.latestModel(gz(2011), null).id, 'gz-a8', '2011 年国产 A 型（2010）反超');
assert.equal(F.latestModel(gz(2026), null).id, 'gen-auto', '无人驾驶时代固定全自动车');
assert.equal(F.latestModel(gz(2010, 160), 'L1').id, 'gen-d160', '160 线由 D 型车接管');
assert.equal(F.latestModel(gz(2000, 160), 'L1'), null, 'D 型车上市前 160 线没有可用车型');
// 速度向下兼容：线路 100 km/h 时只有 100 km/h 以上的车型可选
const fast = F.latestModel(gz(2012, 100), 'L1');
assert.ok(fast && fast.kmh >= 100, '100 km/h 线路只挑速度够用的车：' + (fast && fast.id));
console.log('PASS 当前最新车型（上市年最新 + 速度向下兼容）');

// ================= 4. 升级目标与待升级列车 =================
const g4 = mkG({ trains: [
  { id: 'T1', model: 'gen-a', cars: 8, bought: 2010 * 12, cost: 1000, line: 'L1' },      // 旧车型，满编
  { id: 'T2', model: 'bj-a', cars: 4, bought: 2018 * 12, cost: 900, line: 'L1' },       // 已是最新车型，编组不足
  { id: 'T3', model: 'bj-a', cars: 8, bought: 2018 * 12, cost: 1800, line: 'L1' },      // 最新 + 满编
  { id: 'T4', model: 'gen-a', cars: 6, bought: 2010 * 12, cost: 800, line: 'L2' },      // 别的线路
  { id: 'T5', model: 'gen-a', cars: 4, bought: 2010 * 12, cost: 600, line: 'L1' },      // 旧车型但编组偏小
]});
const tgt = F.techTarget(g4, 'L1');
assert.equal(tgt.m.id, 'bj-a', '2020 年北京最新是 bj-a');
assert.equal(tgt.cars, 8, '编组取线路上限与该车型上限的较小值');
assert.deepEqual(Array.from(F.staleTech(g4, 'L1'), t => t.id), ['T1', 'T2', 'T5'], '挑出换车型的与同车型扩编的，不含已满编与别线');
// 固定编组车型（D 型）目标编组固定 8 节，不按线路上限缩放
const g160 = mkG({ lines: { L1: { id: 'L1', name: '1 号线', speed: 160 } }, routes: [{ lineId: 'L1', cars: 6 }], y: 2020 });
assert.equal(F.techTarget(g160, 'L1').cars, 8, 'D 型车固定 8 节，不受站台上限 6 节影响');
// 当前编组大于目标时跳过（城市支线新车更短时不能把长编组降下来）
const gBig = mkG({ routes: [{ lineId: 'L1', cars: 6 }], trains: [{ id: 'T9', model: 'gen-a', cars: 8, bought: 0, cost: 1, line: 'L1' }] });
assert.equal(F.techTarget(gBig, 'L1').cars, 6);
assert.equal(F.staleTech(gBig, 'L1').length, 0, '编组已经超过目标时不提示降编');
console.log('PASS 升级目标（最新车型 + 线路允许的最大编组）');

// ================= 5. 补差价报价与一键升级 =================
const g5 = mkG({ trains: [
  { id: 'T1', model: 'gen-a', cars: 6, bought: 2010 * 12, cost: 1000, line: 'L1' },
  { id: 'T2', model: 'bj-a', cars: 4, bought: 2018 * 12, cost: 900, line: 'L1' },
]});
const list5 = F.staleTech(g5, 'L1');
assert.deepEqual(Array.from(list5, t => t.id), ['T1', 'T2']);
const q5 = F.techQuote(g5, list5, 'L1');
const bjA = F.model('bj-a');
const np8 = F.price(g5, bjA, 8, 2020);
const res1 = F.residual(g5, g5.fleet.trains[0]);
const res2 = F.residual(g5, g5.fleet.trains[1]);
assert.equal(q5.n, 2); assert.equal(q5.targetCars, 8);
assert.equal(q5.reset, 1, '换车型 1 列');
assert.equal(q5.expand, 1, '同车型扩编 1 列');
assert.ok(Math.abs(q5.credit - res1) < 1e-6, '残值抵扣只算换车型的那列');
assert.ok(Math.abs(q5.cost - (Math.max(0, np8 - res1) + Math.max(0, np8 - F.price(g5, bjA, 4, 2020)))) < 1e-6, '换车型扣残值，同车型只补编组差价');
assert.ok(q5.cost > 0 && q5.credit > 0);
const before5 = g5.fleet.trains.map(t => t.bought);
const r5 = F.upgradeTech(g5, 'L1');
assert.equal(r5.ok, true);
assert.equal(g5.fleet.trains[0].model, 'bj-a', '旧车型换到最新车型');
assert.equal(g5.fleet.trains[0].cars, 8, '编组升到最大');
assert.equal(g5.fleet.trains[0].bought, g5.ym(), '换车型后车龄重置');
assert.notEqual(g5.fleet.trains[0].bought, before5[0]);
assert.equal(g5.fleet.trains[1].bought, before5[1], '同车型扩编车龄不变');
assert.equal(g5.fleet.trains[1].cars, 8);
assert.ok(spent.some(s => /列车升级/.test(s)), '扣费走建设支出（可用专项资金）');
assert.ok(logs.some(l => /残值/.test(l.desc) && /车龄重置/.test(l.desc)), '日志写明残值抵扣与车龄重置');
assert.ok(F.upgradeTech(g5, 'L1').error, '已是最新与最长时再次调用会被拒绝');
// 资金不足：不扣费也不改车
const g5b = mkG({ afford: false, trains: [{ id: 'T1', model: 'gen-a', cars: 4, bought: 0, cost: 100, line: 'L1' }] });
assert.ok(F.upgradeTech(g5b, 'L1').error, '资金不足时拒绝升级');
assert.equal(g5b.fleet.trains[0].model, 'gen-a');
// 沙盒档（无限贷款 / 自由建造）不受资金限制
const g5c = mkG({ infinite: true, afford: false, trains: [{ id: 'T1', model: 'gen-a', cars: 4, bought: 0, cost: 100, line: 'L1' }] });
assert.equal(F.upgradeTech(g5c, 'L1').ok, true, '沙盒档可以直接升级');
console.log('PASS 一键补差价升级（残值抵扣 / 车龄重置 / 同车型扩编）');

// ================= 6. 自动配置列车 =================
// 交路桩：serviceFloor 需要站数与线路长度，lineInfo 需要 cycleSec / stIds / label
const autoRoute = { lineId: 'L1', cars: 8, cycleSec: 3600, stIds: ['a', 'b'], stIdx: [0, 1], lenM: 2400, loop: false, label: '1 号线', cap: 2480, kmh: 80 };
const mkAuto = (o = {}) => {
  const g = mkG({ y: 2020, ...o, routes: o.routes || [autoRoute] });
  g.fleet.autoConfig = o.on !== false;
  return g;
};
const need6 = (g) => F.lineInfo(g, 'L1').reduce((a, x) => a + Math.max(x.peakNeed, x.floor), 0);
const gA = mkAuto();
const needA = need6(gA);
assert.ok(needA > 0, '测试前提：交路有最低服务需求');
const ra = F.autoConfigRun(gA);
assert.equal(ra.bought, needA, '没有空闲车时按需购买');
assert.equal(gA.fleet.trains.length, needA);
assert.ok(gA.fleet.trains.every(t => t.line === 'L1' && t.model === 'bj-a' && t.cars === 8), '买的是该时代主流车型与本线最长编组');
assert.equal(F.autoConfigRun(gA).bought, 0, '已配齐后再跑不重复买');
// 车辆段有同型号空闲车：先调车，不买车
const gB = mkAuto({ trains: [
  { id: 'T1', model: 'bj-a', cars: 8, bought: 0, cost: 1, line: null },
  { id: 'T2', model: 'bj-a', cars: 8, bought: 0, cost: 1, line: null },
]});
const rb = F.autoConfigRun(gB);
assert.equal(rb.moved, 2, '优先从车辆段调空闲车');
assert.equal(rb.bought, needA - 2, '不足部分才买');
assert.equal(gB.fleet.trains[0].line, 'L1');
assert.equal(gB.fleet.trains[0].svc, F.lineInfo(gB, 'L1')[0].id, '调到具体交路');
// 编组超过站台上限 / 型号不是主流车型的空闲车不调
const gC = mkAuto({ routes: [{ ...autoRoute, cars: 6 }], trains: [
  { id: 'T1', model: 'bj-a', cars: 8, bought: 0, cost: 1, line: null },
  { id: 'T2', model: 'gen-a', cars: 6, bought: 0, cost: 1, line: null },
]});
const rc = F.autoConfigRun(gC);
assert.equal(rc.moved, 0, '编组放不下、非主流车型的空闲车都不调');
// 资金不足：一列也不买，每月初提示一次
const gD = mkAuto({ afford: false });
const rd = F.autoConfigRun(gD);
assert.equal(rd.bought, 0, '资金不足时不买车');
assert.equal(gD.fleet.trains.length, 0);
assert.equal(rd.short, needA);
assert.ok(toasts.some(t => t && /自动配置列车/.test(t.text) && t.kind === 'bad'), '弹出资金不足提示');
const nD = toasts.length;
F.autoConfigRun(gD);
assert.equal(toasts.length, nD, '同一个月不重复提示');
assert.ok(gD.fleet.note.autoCfgYm > 0 && Object.keys(gD.fleet.note).length <= 2, 'note 不会随月份无限增长');
// 开关关闭时什么都不做
const gE = mkAuto({ on: false });
assert.equal(F.autoConfigRun(gE).bought, 0);
assert.equal(gE.fleet.trains.length, 0);
console.log('PASS 自动配置列车（先调车、后买车、资金不足每月提示）');

// ================= 7. 难度档 + 无限贷款独立开关（v3.8） =================
assert.equal(D.order.join(','), 'hard,normal,easy,beginner,free', '无限贷款已从难度档移除');
assert.equal(D.tiers.join(','), 'hard,normal,easy,beginner', '设置页只切 4 个经营档位');
assert.equal(D.match(D.presetOf('free')), 'normal', '系数与一般相同的自由建造不参与 match，避免误判');
assert.equal(D.sandboxOf('infinite'), null, '无限贷款不再是难度档');
// 无限贷款：独立开关，只解除透支上限；收支照常记账，融资与满意度规则不变
D.loadGame('hard', null);
const ei = new E('challenge', 2020, 1);
ei.difficulty = 'hard';
const hardFunds = ei.funds, hardIncome = C.Difficulty.incomeMul('hard');
assert.equal(ei.isInfinite(), false, '默认关闭');
assert.equal(ei.canAffordBuild(1e9), false, '关闭时按资金校验');
assert.equal(ei.setInfLoan(true), true);
assert.equal(ei.isInfinite(), true); assert.equal(ei.isFree(), false); assert.equal(ei.isSandbox(), true);
assert.equal(ei.canAfford(1e9), true, '资金不足也能付');
assert.equal(ei.canAffordBuild(1e9), true, '资金不足也能建设');
assert.equal(ei.funds, hardFunds, '开关不改变现有资金');
assert.equal(C.Difficulty.incomeMul('hard'), hardIncome, '开关不改变该难度的收入倍率');
assert.equal(ei.canBorrow(), true, '无限贷款仍可发债，额度按该难度结算');
assert.equal(ei.bondBlock('local'), null, '不再拦截发债');
ei.funds = 100;
ei.spend('ops', 500);
assert.ok(ei.funds < 0, '支出照常记账，可以透支为负');
ei.funds = -1e9;
assert.equal(ei.checkFailure(2020), null, '缺钱不再判失败');
assert.equal(ei.negMonths, 0, '负余额月数不累计');
// 满意度失败没有被豁免：这是「不该动的其他规则」
ei.sat = 10; ei.lowSatMonths = CFG.economy.satFailMonths;
const fInf = ei.checkFailure(2020);
assert.ok(fInf && fInf.reasons.some(r => /满意度/.test(r)), '满意度长期过低仍然失败');
assert.equal(fInf.reasons.some(r => /负债下限|负余额/.test(r)), false, '失败原因里不再出现缺钱');
assert.ok(ei.warnings().some(w => /交通预警/.test(w.text)), '满意度预警照常显示');
// 关掉开关：恢复原有贷款限制（负余额月数重新累计、负债下限重新生效）
ei.failed = null; ei.lowSatMonths = 0; ei.sat = 80;
ei.setInfLoan(false);
assert.equal(ei.isInfinite(), false);
assert.equal(ei.canAffordBuild(1e9), false, '关闭后恢复资金校验');
ei.funds = -1e9;
const fOff = ei.checkFailure(2020);
assert.ok(fOff && fOff.reasons.some(r => /负债下限/.test(r)), '关闭后负债下限重新生效');
// 自由建造：恒为关闭，且不允许开启
const ef = new E('challenge', 2020, 1);
ef.difficulty = 'free';
assert.equal(ef.isFree(), true);
assert.equal(ef.setInfLoan(true), false, '自由建造不提供无限贷款');
assert.equal(ef.isInfinite(), false, '自由建造不是无限贷款');
const f0 = ef.funds;
ef.spend('ops', 999);
ef.income('fare', 500);
assert.equal(ef.funds, f0, '自由建造不改动资金');
assert.equal(ef.checkFailure(2020), null);
assert.equal(ef.canBorrow(), false);
// 存档：开关随存档保存，旧档（把无限贷款当难度档）自动迁移
D.loadGame('normal', null);
const es = new E('challenge', 2020, 1);
es.difficulty = 'normal'; es.funds = -5e8; es.setInfLoan(true);
const snap = JSON.parse(JSON.stringify(es.serialize()));
assert.equal(snap.infLoan, true, '开关写进存档');
assert.equal(snap.difficulty, 'normal', '档位仍是普通档');
const er = E.restore(snap);
assert.equal(er.isInfinite(), true, '读档后开关仍生效');
assert.equal(er.difficulty, 'normal', '读档后难度不被开关改写');
const legacyInf = JSON.parse(JSON.stringify(snap));
delete legacyInf.infLoan;
legacyInf.difficulty = 'infinite';
legacyInf.tune = null;
const el2 = E.restore(legacyInf);
assert.equal(el2.isInfinite(), true, '旧版无限贷款档迁移为「一般 + 开关开启」');
assert.equal(el2.difficulty, 'normal', '旧档位名归一为一般');
// 旧档兼容：mode = 'free' 但没有 difficulty 时仍按自由建造处理
const legacyFree = new E('free', 2020, 1);
legacyFree.difficulty = null;
assert.equal(legacyFree.isFree(), true, '旧自由建造档继续按资金不限处理');
D.loadGame('normal', null);
console.log('PASS 难度档 + 无限贷款开关：透支 / 免缺钱失败 / 关掉复原 / 存档与旧档迁移');

// ================= 8. 作弊设施读档后不消失 =================
const Fac = C.Fac, Cheat = C.Cheat;
assert.equal(typeof Fac.clearCache, 'function', '设施表要能主动清缓存');
assert.equal(typeof Cheat.sig, 'function', '作弊设施要有内容签名');
const fac0 = { id: 'cf1', name: '测试设施', t: 'shop', x: 40, y: 30, r: 1, open: 2020, w: 1000 };
C.game = { cheat: { cfacs: [fac0] } };
const sig1 = Cheat.sig();
assert.ok(sig1.indexOf('cf1') === 0, '签名包含设施内容');
const l1 = Fac.list(null);
assert.ok(l1.some(f => f.id === 'cf1' && f.cus), '自定义设施进入设施表');
assert.equal(Fac.list(null), l1, '内容不变时命中缓存');
C.game = { cheat: { cfacs: [] } };          // 读档：同一 ver，但内容变了
assert.notEqual(Cheat.sig(), sig1);
const l2 = Fac.list(null);
assert.notEqual(l2, l1, '内容签名变化后缓存失效');
assert.equal(l2.some(f => f.id === 'cf1'), false, '读档后不会残留上一局的设施');
C.game = { cheat: { cfacs: [{ ...fac0, name: '改名后' }] } };
assert.ok(Fac.list(null).some(f => f.id === 'cf1' && f.name === '改名后'), '改内容也立即生效');
Fac.clearCache();
const l3 = Fac.list(null);
assert.ok(l3.some(f => f.id === 'cf1'), 'clearCache 之后重新建表，内容照旧');
C.game = null;
console.log('PASS 作弊设施读档后不消失（缓存键带内容签名 + 主动清缓存）');

console.log('ALL PASS v3.7 科技树 / 一键升级 / 自动配置 / 沙盒难度 / 设施缓存');
