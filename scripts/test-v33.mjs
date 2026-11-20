// Isolated v3.3 regressions: giant / interchange-hub stations, TOD levels 4–5 and the driverless-only era.
// Never reads or writes player saves.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const root = new URL('../', import.meta.url), memory = new Map();
const c = { console, performance, atob, btoa, TextEncoder, TextDecoder, setTimeout, clearTimeout, navigator: { hardwareConcurrency: 4 }, matchMedia: () => ({ matches: false }), localStorage: { getItem: k => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, String(v)), removeItem: k => memory.delete(k) } };
c.window = c; vm.createContext(c);
const load = async src => vm.runInContext(await readFile(new URL(src, root), 'utf8'), c, { filename: src });
for (const [, src] of (await readFile(new URL('index.html', root), 'utf8')).matchAll(/<script src="([^"]+)"/g)) { await load(src); if (src === 'js/save.js') break; }
const C = c.CM, M = C.Metro;
C.UI = function () {}; for (const name of ['settings', 'corp', 'fleet']) await load('js/' + name + '.js');
const F = C.Fleet, mc = C.CFG.metro, T = C.TOD;

// ---------------- 1. 巨型 / 枢纽型车站 ----------------
assert.deepEqual(Array.from(mc.sizes), ['S', 'M', 'L', 'XL', 'XXL', 'HUB'], '规模顺序');
assert.equal(mc.stationCap.XXL, 160000, '巨型 16 万人次/时');
assert.equal(mc.stationCap.HUB, 400000, '枢纽型 40 万人次/时');
assert.equal(mc.carsBySize.XXL, 8); assert.equal(mc.carsBySize.HUB, 8);
assert.equal(mc.sizeName.XXL, '巨型'); assert.equal(mc.sizeName.HUB, '枢纽型');
assert.ok(mc.std160.sizeMin.includes('XXL') && mc.std160.sizeMin.includes('HUB'), '160 轨道允许大型及以上');
for (const type of ['underground', 'elevated', 'surface']) {
  const tbl = C.CFG.cost.station[type];
  for (let i = 2; i < mc.sizes.length; i++) assert.ok(tbl[mc.sizes[i]] > tbl[mc.sizes[i - 1]], type + ' 造价逐档上升：' + mc.sizes[i]);
  // 沿用 L→XL 的比例继续外推，不另立口径
  const r1 = tbl.XL / tbl.L, r2 = tbl.XXL / tbl.XL, r3 = tbl.HUB / tbl.XXL;
  assert.ok(Math.abs(r1 - r2) < 0.02 && Math.abs(r2 - r3) < 0.02, type + ' 造价比例一致');
  for (const sz of mc.sizes) assert.ok(M.stationCost(type, sz, 1990) > 0, type + ' ' + sz + ' 造价');
}
for (let i = 1; i < mc.sizes.length; i++) assert.ok(C.CFG.ops.stationDaily[mc.sizes[i]] > C.CFG.ops.stationDaily[mc.sizes[i - 1]], '日运营费逐档上升：' + mc.sizes[i]);
const ratioOps = C.CFG.ops.stationDaily.XXL / C.CFG.ops.stationDaily.XL;
assert.ok(Math.abs(ratioOps - C.CFG.ops.stationDaily.XL / C.CFG.ops.stationDaily.L) < 0.02, '运营费按同一比例外推');
assert.ok(Math.abs(ratioOps - 1.733) < 0.01);

// ---------------- 2. TOD 第 4、5 级 ----------------
assert.equal(T.LEVELS.length, 6, 'TOD 六级');
assert.equal(T.LEVELS[4].name, '周边片区综合开发');
assert.equal(T.LEVELS[5].name, 'TOD 枢纽开发');
for (let l = 2; l < T.LEVELS.length; l++) {
  assert.ok(T.LEVELS[l].k > T.LEVELS[l - 1].k, '收入系数递增：' + l);
  assert.ok(T.LEVELS[l].cost > T.LEVELS[l - 1].cost, '投入递增：' + l);
  assert.ok(T.LEVELS[l].upkeep < T.LEVELS[l - 1].upkeep, '年维护率递减：' + l);
}
assert.ok(T.SIZE.XXL > T.SIZE.XL && T.SIZE.HUB > T.SIZE.XXL, '商业开发按站厅规模放大');
const y0 = 2000;
for (let l = 1; l < T.LEVELS.length; l++) {
  assert.ok(T.cost(l, y0, 'M', false) > T.cost(l - 1, y0, 'M', false), '累计投入递增：' + l);
  assert.ok(T.stationDaily(l, 10000, false, y0) > T.stationDaily(l - 1, 10000, false, y0), '单站日收入递增：' + l);
  assert.ok(T.stationCost(l, y0, 'M', false) > 0, '单站日成本为正：' + l);
}
assert.ok(T.stationDaily(5, 10000, true, y0) > T.stationDaily(4, 10000, false, y0), '枢纽换乘站有溢价');
// 4、5 级的投入与维护随站厅规模放大：枢纽型换乘站的投入最高
assert.ok(T.cost(5, y0, 'HUB', true) > T.cost(5, y0, 'L', false), '大站投入更高');
assert.ok(T.stationCost(5, y0, 'HUB', true) > T.stationCost(5, y0, 'M', false), '大站维护更高');
assert.equal(C.CFG.metroLed.tod.length, T.LEVELS.length, '地铁带动的开发权重与级数一致');

// ---------------- 2b. 第 4 级需超大型、第 5 级需巨型及以上（v3.4 / v3.5） ----------------
assert.equal(T.LEVELS[4].min, 'XL'); assert.equal(T.LEVELS[5].min, 'XXL');
for (const [sz, cap] of [['S', 3], ['M', 3], ['L', 3], ['XL', 4], ['XXL', 5], ['HUB', 5]]) {
  assert.equal(T.maxLv(sz), cap, sz + ' 能开发的最高等级');
  assert.equal(T.sizeOk('XL', sz), cap >= 4, sz + ' 是否达到超大型门槛');
  assert.equal(T.sizeOk('XXL', sz), cap === 5, sz + ' 是否达到巨型门槛');
}
assert.equal(T.minName(4), '超大型'); assert.equal(T.minName(5), '巨型');
assert.equal(T.topSize(), '巨型');
assert.ok(/第 4 级需超大型/.test(T.gateText()) && /第 5 级需巨型/.test(T.gateText()), '门槛说明逐级列出');
// 规模顺序一旦调整，门槛要跟着走：巨型以下停在第 4 级，超大型以下停在第 3 级
const xlAt = C.CFG.metro.sizes.indexOf('XL'), xxAt = C.CFG.metro.sizes.indexOf('XXL');
for (const sz of C.CFG.metro.sizes) {
  const i = C.CFG.metro.sizes.indexOf(sz);
  assert.equal(T.maxLv(sz), i >= xxAt ? 5 : i >= xlAt ? 4 : 3, sz + ' 与规模顺序一致');
}

// ---------------- 3. 无人驾驶时代：只卖全自动无人驾驶车 ----------------
const seq = { n: 0 }, spent = [], logs = [];
const mkG = (y, trains, lines) => ({
  mapId: 'bj', clock: { y: y, m: 3, d: 1 }, net: { lines: lines || { L1: { id: 'L1', name: '1 号线' } } },
  econ: { isFree: () => false, costIndex: () => 1, canAffordBuild: () => true, spendBuild: (o, t) => { spent.push(t); }, log() {}, difficulty: null },
  fleet: { ver: 1, seq: 1, trains: trains || [] }, model: { applyFleet() {} }, touch() {}, emit() {}, logEvent(e) { logs.push(e); },
});
assert.equal(F.autoOn('bj', 2024), false, '2024 年还没上市');
assert.equal(F.autoOn('bj', 2025), true, '2025 年上市');
const gA = mkG(2026, [], { a: { id: 'a', speed: 80 }, b: { id: 'b', speed: 160 } });
assert.deepEqual(Array.from(F.buyList(gA, 'a').list, m => m.id), ['gen-auto'], '普通线路只卖全自动无人驾驶车');
assert.deepEqual(Array.from(F.buyList(gA, 'b').list, m => m.id), ['gen-d160'], '160 线路只卖 D 型无人列车（无人驾驶车跑不了 160）');
assert.deepEqual(Array.from(F.buyList(gA, 'a').soon, m => m.id), ['gen-super'], '无人驾驶时代只剩下一代主力（2030 年的 T7 超级列车）在「即将开放」里');
const gOld = mkG(2024, [], { a: { id: 'a', speed: 80 } });
assert.ok(F.buyList(gOld, 'a').list.length > 1, '上市前仍按年代卖多种车型');
assert.ok(F.buyList(gOld, 'a').list.every(m => !m.only160));
assert.equal(F.recommend('bj', 2026, 80).id, 'gen-auto');
assert.equal(F.recommend('bj', 2026, 160).id, 'gen-d160');
assert.equal(F.eraModel('bj', 2026).id, 'gen-auto');
assert.ok(F.buy(gA, null, null, 'gen-a', 4, 1).error.includes('停售'), '停售车型不能购买');

// ---------------- 4. 一键补差价升级（编组不变） ----------------
const gU = mkG(2026, [
  { id: 'T1', model: 'gen-a', cars: 8, cost: 1000, line: 'L1' },
  { id: 'T2', model: 'gen-eco', cars: 6, cost: 800, line: 'L1' },
  { id: 'T3', model: 'gen-d160', cars: 8, cost: 900, line: 'L1' },
  { id: 'T4', model: 'gen-a', cars: 4, cost: 500, line: null },
]);
assert.deepEqual(Array.from(F.staleAuto(gU, 'L1'), t => t.id), ['T1', 'T2'], 'D 型车与车辆段列车不在升级范围');
const auto = F.model('gen-auto'), q = F.autoQuote(gU, F.staleAuto(gU, 'L1'));
const delta = (F.price(gU, auto, 8) - F.price(gU, F.model('gen-a'), 8)) + (F.price(gU, auto, 6) - F.price(gU, F.model('gen-eco'), 6));
assert.equal(q.n, 2); assert.equal(q.cars, 14); assert.equal(q.cost, delta);
const up = F.upgradeAuto(gU, 'L1');
assert.equal(up.ok, true); assert.equal(up.n, 2); assert.equal(up.cost, delta);
assert.deepEqual(Array.from(gU.fleet.trains, t => t.model), ['gen-auto', 'gen-auto', 'gen-d160', 'gen-a'], '只改本线非 D 型车');
assert.deepEqual(Array.from(gU.fleet.trains, t => t.cars), [8, 6, 8, 4], '编组不变');
assert.equal(gU.fleet.trains[0].cost, 1000 + F.price(gU, auto, 8) - F.price(gU, F.model('gen-a'), 8), '购置成本累加');
assert.ok(spent.some(s => /列车升级/.test(s)), '升级记为建设支出');
assert.equal(F.staleAuto(gU, 'L1').length, 0, '升级后没有待改装列车');
assert.ok(F.upgradeAuto(gU, 'L1').error, '没有可升级列车时报错');
console.log('PASS giant/interchange-hub stations, TOD levels 4–5, driverless-only sales and one-click upgrade');
console.log('ALL PASS v3.3 station sizes / TOD / driverless fleet');
