// v5.5 回归：科技树新增 T7 超级列车与 160 支线的 D 型超级列车。
// 覆盖：车型参数、T1–T7 分级与 D 型独立、价格模型自动算价、选型与购车门禁、
//       2030 年起的升级目标（普通线 → T7，160 线 → D 型超级列车）、图例色带随线路颜色变化。
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
const C = c.CM;
C.UI = function () {};
for (const name of ['settings', 'corp', 'fleet', 'cheat']) await load('js/' + name + '.js');
const F = C.Fleet;
C.Difficulty.loadGame('normal', null);

const spent = [], logs = [];
const mkG = (o = {}) => {
  const lines = o.lines || { L1: { id: 'L1', name: '1 号线' } };
  const net = { lines: lines, stations: {}, segments: {}, rideEdge: [], R: 1 };
  net.C = { routes: o.routes || [{ lineId: 'L1', cars: 8, cycleSec: 3600, stIds: ['a', 'b'], stIdx: [0, 1], lenM: 2400, loop: false, label: '1 号线', cap: 2480, kmh: 80 }], rideEdge: [], R: 1, net: net };
  return {
    mapId: o.mapId || 'bj', clock: { y: o.y || 2030, m: 3, d: 1 },
    net: net, compiled: net.C,
    econ: {
      isFree: () => !!o.free, isInfinite: () => !!o.infinite, isSandbox: () => !!(o.free || o.infinite),
      difficulty: 'normal', costIndex: () => (o.idx == null ? 1 : o.idx),
      canAffordBuild: () => o.afford !== false, spendBuild: (x, t) => { spent.push(t); }, log() {},
    },
    fleet: Object.assign({ ver: 1, seq: 1, trains: o.trains || [], ops: {}, note: {} }, o.fleet || {}),
    model: { net: net, applyFleet() {}, trafficReady: () => true, resultsFor: () => null, solveNow() {} },
    touch() {}, emit() {}, logEvent(x) { logs.push(x); }, ym: () => (o.y || 2030) * 12 + 3,
  };
};
const TRAIN = (id, model, cars, line, bought) => ({ id: id, model: model, cars: cars, bought: bought == null ? 2028 * 12 : bought, cost: 1000, line: line == null ? 'L1' : line, svc: null });

// ================= 1. 两款超级列车的参数 =================
const T7 = F.model('gen-super'), DS = F.model('gen-d160-super');
assert.equal(T7.id, 'gen-super');
assert.equal(T7.from, 2030, 'T7 解锁年份 2030');
assert.equal(T7.kmh, 120, 'T7 最高 120 km/h');
assert.equal(T7.cap, 800, 'T7 每节 800 人');
assert.equal(T7.ops, 0.5, 'T7 运营成本为基准的 0.5 倍');
assert.equal(T7.maps, null, 'T7 是通用车型');
assert.equal(T7.t, 7);
assert.equal(DS.id, 'gen-d160-super');
assert.equal(DS.from, 2030, 'D 型超级列车解锁年份 2030');
assert.equal(DS.kmh, 160, 'D 型超级列车最高 160 km/h');
assert.equal(DS.cap, 1000, 'D 型超级列车每节 1000 人');
assert.equal(DS.ops, 0.5, 'D 型超级列车运营成本为基准的 0.5 倍');
assert.equal(DS.only160, true, '只能在 160 轨道上运行');
assert.equal(DS.fixedCars, 8, '固定 8 节编组');
assert.equal(F.capOf({ model: DS.id, cars: 8 }), 8000, '整列 8 节 8000 人');
assert.equal(F.capOf({ model: T7.id, cars: 8 }), 6400, '整列 8 节 6400 人');
console.log('PASS 1 T7 超级列车与 D 型超级列车的参数（2030 / 120·160 km/h / 800·1000 人 / 0.5 倍运营成本）');

// ================= 2. 科技树位置与分级 =================
assert.deepEqual(Array.from(F.TRUNK), ['gen-early', 'gen-classic', 'gen-steel', 'gen-a', 'gen-eco', 'gen-auto', 'gen-super'], '主干 7 款，T7 最后上市');
assert.equal(F.TIER_N, 7, '等级数量与主力车型数量一致');
assert.deepEqual(Array.from(F.TRUNK, id => F.model(id).t), [1, 2, 3, 4, 5, 6, 7], '一款一级，T7 超级列车是第 7 级');
assert.deepEqual(Array.from(F.BRANCH_160), ['gen-d160', 'gen-d160-super'], '160 科技线两款 D 型车');
assert.equal(F.isTrunk(T7), true);
assert.equal(F.is160Model(DS), true);
assert.equal(F.is160Model(T7), false, 'T7 是普通轨道车型');
assert.equal(F.isCity(T7), false);
assert.equal(F.tierOf(T7), 7);
assert.equal(F.tierLabel(T7), 'T7');
assert.equal(F.tierKind(T7), 'trunk');
assert.equal(F.tierChip(T7), 'T7 主力');
assert.equal(F.tierOf(DS), 0, 'D 型车不参与 T 级');
assert.equal(F.tierLabel(DS), 'D');
assert.equal(F.tierKind(DS), 'd');
assert.equal(F.tierChip(DS), 'D 型专用');
assert.ok(F.rank(T7) > F.rank(F.model('gen-auto')), 'T7 的节点序号晚于 T6');
assert.ok(F.rank(DS) > F.rank(F.model('gen-d160')), 'D 型超级列车晚于 D 型无人列车');
// 城市特色车型的定级沿用同一把尺子：新增 T7 后等级不变（T7 在指标上限之上，分档线不会被拉低）
for (const [id, t] of [['gz-a8', 4], ['sh-16', 5], ['pa-mp14', 4], ['hz-b1', 4]]) {
  assert.equal(F.tierOf(F.model(id)), t, '城市特色车型等级不变：' + id);
}
// T7 的综合性能指标到顶（2.0），T6/T7 的分档线也是 2.0；没有城市特色车型能达到这条线，
// 所以新增 T7 不会把任何既有城市车型抬到 T7，也不会改变它们的等级。
assert.equal(F.tierScore(T7), 2);
assert.equal(F.tierScore(F.model('gen-auto')), 2);
for (const city of F.CITY_ORDER) for (const id of F.CITY_BRANCH[city]) assert.ok(F.tierScore(F.model(id)) < 2, '城市特色车型的综合性能低于 T7 封顶线：' + id);
console.log('PASS 2 主干 T1–T7、160 支线两款 D 型车，城市车型定级不受影响');

// ================= 3. 价格模型自动算价 =================
// 现有价格模型：每节价格 = 定员^0.7 × 年代单价 × 5.6（年代单价 = 0.65 + 0.0083 × (年 − 1900)）
assert.equal(F.listPrice(310, 1985), 420, '复算 T4 大运量 A 型车得到现有价格 420');
assert.equal(F.listPrice(320, 2025), 540, '复算 T6 全自动无人驾驶车得到现有价格 540');
for (const id of ['gen-steel', 'gen-eco', 'gen-d160']) {
  const m = F.model(id), calc = F.listPrice(m.cap, m.from);
  assert.ok(Math.abs(calc - m.price) / m.price < 0.08, '复算现有车型误差在 8% 内：' + id + ' ' + calc + ' vs ' + m.price);
}
assert.equal(T7.price, F.listPrice(800, 2030), 'T7 售价由价格模型算出');
assert.equal(T7.price, 1040, 'T7 每节 1040 万元（1990 年不变价）');
assert.equal(DS.price, F.listPrice(1000, 2030), 'D 型超级列车售价由价格模型算出');
assert.equal(DS.price, 1220, 'D 型超级列车每节 1220 万元（1990 年不变价）');
assert.ok(T7.price > F.model('gen-auto').price, 'T7 比上一代贵');
assert.ok(DS.price > F.model('gen-d160').price, 'D 型超级列车比 D 型无人列车贵');
// 售价比：新车的每座造价与上一代持平（定员翻倍、价格按 0.7 次幂增长）
assert.ok(Math.abs((T7.price / T7.cap) / (F.model('gen-auto').price / F.model('gen-auto').cap) - 1) < 0.35, 'T7 每座造价与 T6 同一量级');
assert.ok(Math.abs((DS.price / DS.cap) / (F.model('gen-d160').price / F.model('gen-d160').cap) - 1) < 0.35, 'D 型超级列车每座造价与 D 型车同一量级');
// F.price 仍按「每节价格 × 编组 × 本城造价水平 × 当年造价指数 × 难度系数」计算
const gp = mkG({ y: 2030, idx: 2 });
assert.ok(Math.abs(F.price(gp, T7, 8, 2030) - T7.price * 8 * 2) < 1e-6, '当年造价指数照常相乘');
assert.ok(Math.abs(F.price(gp, DS, 8, 2030) - DS.price * 8 * 2) < 1e-6);
console.log('PASS 3 售价由现有价格模型自动算出（T7 1040 万/节、D 型超级列车 1220 万/节）');

// ================= 4. 选型：2030 年起的最新车型 =================
assert.equal(F.trunkModel('bj', 2029, 120).id, 'gen-auto', '2029 年主力仍是无人驾驶车');
assert.equal(F.trunkModel('bj', 2030, 120).id, 'gen-super', '2030 年起主力换成 T7');
assert.equal(F.dModelFor('bj', 2029).id, 'gen-d160', '2029 年 160 线仍是 D 型无人列车');
assert.equal(F.dModelFor('bj', 2030).id, 'gen-d160-super', '2030 年起 160 线是 D 型超级列车');
assert.equal(F.trunkModel('bj', 2030, 160).id, 'gen-d160-super');
assert.equal(F.recommend('bj', 2030, 80).id, 'gen-super');
assert.equal(F.eraModel('bj', 2030).id, 'gen-super', '2030 年之后开局的默认车型');
assert.equal(F.lineFit(T7, 160), false, 'T7 不能上 160 轨道');
assert.equal(F.lineFit(DS, 80), false, 'D 型超级列车不能上普通轨道');
assert.equal(F.lineFit(DS, 160), true);
const g30 = mkG({ y: 2030, lines: { a: { id: 'a', speed: 80 }, b: { id: 'b', speed: 160 } } });
const shop80 = F.buyList(g30, 'a'), shop160 = F.buyList(g30, 'b');
assert.equal(shop80.defaultModel.id, 'gen-super', '普通线路默认选中 T7');
assert.equal(shop160.defaultModel.id, 'gen-d160-super', '160 线路默认选中 D 型超级列车');
assert.ok(shop80.list.every(m => !m.only160), '普通线路买不到 D 型车');
assert.ok(shop160.list.every(m => m.only160), '160 线路只卖 D 型车');
assert.ok(shop160.list.some(m => m.id === 'gen-d160-super'), 'D 型超级列车可以买');
assert.ok(shop80.list.some(m => m.id === 'gen-super'));
assert.equal(F.buy(g30, 'a', null, 'gen-a', 6, 1).error.indexOf('停售') >= 0, true, '旧车型在 2030 年已停售');
assert.equal(F.buy(g30, 'a', null, 'gen-super', 8, 1).ok, true, 'T7 可以购买');
assert.equal(g30.fleet.trains[0].model, 'gen-super');
console.log('PASS 4 2030 年起普通线选 T7、160 线选 D 型超级列车，购车列表与停售规则同步');

// ================= 5. 升级目标：普通线 → T7，160 线 → D 型超级列车 =================
const gU = mkG({ y: 2030, trains: [
  TRAIN('A1', 'gen-auto', 8, 'L1', 2026 * 12),
  TRAIN('A2', 'gen-eco', 6, 'L1', 2020 * 12),
] });
assert.equal(F.techTarget(gU, 'L1').m.id, 'gen-super', '普通线的升级目标是 T7');
assert.deepEqual(Array.from(F.staleTech(gU, 'L1'), t => t.id), ['A1', 'A2'], 'T6 也进入待升级列表');
const qU = F.techQuote(gU, gU.fleet.trains.filter(t => t.line === 'L1'), 'L1');
assert.equal(qU.target.id, 'gen-super');
assert.equal(qU.targetCars, 8);
const rU = F.upgradeTech(gU, 'L1');
assert.equal(rU.ok, true);
assert.equal(rU.n, 2);
for (const t of gU.fleet.trains) {
  assert.equal(t.model, 'gen-super');
  assert.equal(t.cars, 8);
  assert.equal(F.tierOf(F.model(t.model)), 7, '升级后等级为 T7');
  assert.equal(F.model(t.model).cap, 800);
  assert.equal(F.model(t.model).ops, 0.5);
}
assert.equal(F.staleTech(gU, 'L1').length, 0, '升级后没有待升级列车');

const gD = mkG({
  y: 2030, lines: { L1: { id: 'L1', name: '1 号线', speed: 160 } },
  routes: [{ lineId: 'L1', cars: 8, cycleSec: 3600, stIds: ['a', 'b'], stIdx: [0, 1], lenM: 2400, loop: false, label: '1 号线', cap: 4000, kmh: 160 }],
  trains: [TRAIN('D1', 'gen-d160', 8, 'L1', 2015 * 12), TRAIN('D2', 'gen-a', 6, 'L1', 2020 * 12)],
});
assert.equal(F.techTarget(gD, 'L1').m.id, 'gen-d160-super', '160 线的升级目标是 D 型超级列车');
assert.deepEqual(Array.from(F.staleTech(gD, 'L1'), t => t.id), ['D1', 'D2'], '旧 D 型车也要升级');
const qD = F.techQuote(gD, gD.fleet.trains.filter(t => t.line === 'L1'), 'L1');
assert.equal(qD.target.id, 'gen-d160-super');
assert.equal(qD.targetCars, 8, 'D 型固定 8 节');
const rD = F.upgradeTech(gD, 'L1');
assert.equal(rD.ok, true);
for (const t of gD.fleet.trains) {
  assert.equal(t.model, 'gen-d160-super');
  assert.equal(t.cars, 8);
  assert.equal(F.model(t.model).cap, 1000);
  assert.equal(F.model(t.model).kmh, 160);
}
assert.equal(F.tierOf(F.model(gD.fleet.trains[0].model)), 0, 'D 型车仍是独立支线');
assert.ok(spent.some(s => /列车升级/.test(s)), '升级记为建设支出');
// 2030 年前的 160 线目标仍是 D 型无人列车
const gD29 = mkG({ y: 2029, lines: { L1: { id: 'L1', name: '1 号线', speed: 160 } }, routes: [{ lineId: 'L1', cars: 8, cycleSec: 3600, stIds: ['a', 'b'], stIdx: [0, 1], lenM: 2400, loop: false, label: '1 号线', cap: 4000, kmh: 160 }] });
assert.equal(F.techTarget(gD29, 'L1').m.id, 'gen-d160');
console.log('PASS 5 2030 年起普通线升级到 T7、160 线升级到 D 型超级列车，参数与等级同步');

// ================= 6. 图例：原创式样，色带随线路颜色变化 =================
assert.equal(T7.look.era, 'super');
assert.equal(DS.look.era, 'superD');
assert.equal(T7.look.band, 'line', 'T7 的色带取线路颜色');
assert.equal(DS.look.band, 'line', 'D 型超级列车的色带取线路颜色');
const red = F.sideSVG(T7, '#d0021b', 168), blue = F.sideSVG(T7, '#0a6cff', 168), green = F.sideSVG(DS, '#1a9c3c', 168);
assert.ok(red.indexOf('#d0021b') >= 0, 'T7 图例带线路色');
assert.ok(blue.indexOf('#0a6cff') >= 0);
assert.ok(red !== blue, '换一条线路，图例跟着变色');
assert.ok(green.indexOf('#1a9c3c') >= 0, 'D 型超级列车图例带线路色');
assert.ok(green.indexOf('#d0021b') < 0, '不会混用别的线路颜色');
assert.equal(red === green, false, '两款车的图例是不同式样');
for (const s of [red, blue, green]) {
  assert.ok(!/undefined|NaN|null/.test(s), '图例 SVG 不含无效值');
  assert.ok(s.indexOf('<svg') === 0 || s.indexOf('<svg') > 0);
  assert.ok((s.match(/<rect|<path/g) || []).length > 10, '图例包含完整的车身、车窗、色带与车鼻');
}
// 既有车型的图例不受影响：色带仍按各自的 look 取值
assert.ok(F.sideSVG(F.model('gen-a'), '#c8102e', 168).indexOf('#c8102e') >= 0);
assert.ok(F.sideSVG(F.model('gen-d160'), '#c8102e', 168).indexOf('#c8102e') >= 0);
console.log('PASS 6 两款图例为独立式样，色带随所属线路颜色变化');

console.log('ALL PASS v5.5 T7 超级列车 / D 型超级列车 / 价格模型 / 升级目标 / 图例');
