// v4.6 回归：速度取 min(轨道限速, 车型限速)、区间载客稳定、无车交路不产生客流、
// 每条交路独立客流且合计等于线路总客流、新增交路编译期过滤预留/停用站。
// 全部在隔离 VM + 内存存储里跑，不读写玩家存档。
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
for (const src of ['settings', 'corp', 'fleet', 'screens', 'agents']) await load('js/' + src + '.js');
const F = C.Fleet;
C.useMap('tutorial');
const game = C.Game.create({ mode: 'free', tutorial: true, seed: 20000101 });
F.ensure(game);
const city = game.city;

// 一条四站直线线路，轨道设计速度 120 km/h（直线段没有弯道限速，方便精确比较）
const net = M.empty(), lid = M.newLine(net);
net.lines[lid].speed = 120;
const ids = [10, 18, 26, 34].map(x => M.addStation(net, x, 10, { size: 'M', type: 'underground' }, city));
for (let k = 1; k < ids.length; k++) M.addSegment(net, lid, ids[k - 1], ids[k], [], 'underground');

// ================= 1. 实际速度上限与时刻表 =================
const Cd = M.compile(net, city), rtD = Cd.routes[0];
assert.equal(rtD.kmh, 120, '编译路线记录轨道设计速度');
assert.equal(rtD.runKmh, 120, '没有配属列车时按设计速度运行');
assert.ok(rtD.legVBase.length === rtD.legLenM.length && rtD.legCurve.length === rtD.legLenM.length,
  '保存自由流速度与弯道限速，避免反复降速叠加');
const cycle120 = rtD.cycleSec, leg0_120 = rtD.legSec[0];

const t70 = M.timing(rtD, 70);
assert.ok(t70.cycleSec > cycle120, '降速后周转时间变长');
assert.ok(t70.legSec[0] > leg0_120, '降速后区间用时变长');
for (let k = 0; k < rtD.legLenM.length; k++) {
  assert.ok(t70.legV[k] <= rtD.legVBase[k] * (70 / 120) + 1e-6, '区间速度不得超过车型限速');
}
assert.equal(M.applyTiming(rtD, 70), true, '第一次按 70 km/h 重算');
assert.equal(rtD.runKmh, 70);
assert.equal(M.applyTiming(rtD, 70), false, '同一上限重复调用不重复降速（幂等）');
assert.ok(Math.abs(rtD.cycleSec - t70.cycleSec) < 1e-6);
assert.equal(M.applyTiming(rtD, 120), true, '换回快车可以恢复设计速度');
assert.ok(Math.abs(rtD.cycleSec - cycle120) < 1e-6, '恢复后周转时间回到设计值，不残留降速');
assert.equal(M.applyTiming({}, 80), false, '缺少区间几何的简化路线安全跳过');

const C70 = M.compile(net, city, { [lid]: 70 });
assert.equal(C70.routes[0].runKmh, 70, 'compile 第三参数可直接按实际速度编译');
assert.ok(C70.routes[0].cycleSec > cycle120);
assert.equal(M.compile(net, city).routes[0].runKmh, 120, '不传上限时仍是设计速度');
console.log('PASS 1 实际速度 = min(轨道限速, 车型限速)，时刻表可重算/恢复且不会叠加');

// ================= 2. 统一准入与车队计划 =================
const m80 = F.model('gen-steel'), m120 = F.model('gen-auto'), mD = F.model('gen-d160');
assert.equal(m80.kmh, 80); assert.equal(m120.kmh, 120);
assert.equal(F.lineFit(m80, 120), true, '普通轨道上慢车可以上线');
assert.equal(F.lineFit(m80, 160), false, '普通车型不能上 160 高速轨道');
assert.equal(F.lineFit(mD, 80), false, 'D 型专用车不能跑普通轨道');
assert.equal(F.lineFit(mD, 160), true, '160 轨道仍由 D 型专用车运营');
const gFit = { net: { lines: { fast: { speed: 120 }, hsr: { speed: 160 } } } };
assert.equal(F.fitModel(gFit, 'fast', m80), true, '120 线路购车列表不再按速度排除慢车');
assert.equal(F.fitModel(gFit, 'hsr', m80), false);
assert.equal(F.fitModel(gFit, 'fast', mD), false);
assert.equal(F.fitModel(gFit, 'hsr', mD), true);
assert.equal(F.routeCapKmh({ kmh: 120 }, { units: [[{ m: { kmh: 70 } }, { m: { kmh: 100 } }], [{ m: { kmh: 90 } }]] }), 70,
  '路线速度上限取配属列车里最慢的车型');
assert.equal(F.routeCapKmh({ kmh: 120 }, { units: [[{ m: { kmh: 160 } }], []] }), 120, '快车不能把线路拉得比轨道更快');
assert.equal(F.routeCapKmh({ kmh: 120 }, null), 120);

// 真实 F.plan：配一列 80 km/h 的慢车到 120 线路，慢车必须进入 units，整条交路降速，最短路图边权同步
const Cf = M.compile(net, city);
let e = 0;
const rideEdge = Cf.routes.map(rt => {
  const a = [];
  for (let k = 0; k < rt.legSec.length; k++) { a.push(e++, e++); }
  return Int32Array.from(a);
});
const eT0 = new Float32Array(e);
const fnet = { C: Cf, rideEdge: rideEdge, eT0: eT0 };
const fg = {
  mapId: 'tutorial', clock: { y: 2030 }, ym: () => 2030 * 12, net: net,
  fleet: { ver: 1, ops: {}, owned: ['gen-steel'], trains: [
    { id: 'T1', model: 'gen-steel', cars: 4, bought: 2000, line: lid, svc: null },
  ] },
};
const cycleBefore = Cf.routes[0].cycleSec;
const pl = F.plan(fg, fnet);
assert.equal(pl[0].units[0].length, 1, '慢车进入配属列车，不再被「速度不够」挡在门外');
assert.equal(pl[0].avail[0], 1);
assert.equal(pl[0].blocked, 0, '慢车不算不能上线');
assert.equal(pl[0].slow, 1, '但仍标记为降速运行，供界面提示');
assert.equal(pl[0].runKmh, 80, '实际速度上限 = 车型限速');
assert.equal(Cf.routes[0].runKmh, 80);
assert.ok(Cf.routes[0].cycleSec > cycleBefore, '周转变长，最低需要列车随之重算');
const expectT = Cf.routes[0].legSec[0] / 60 + CFG.metro.dwell / 60;
assert.ok(Math.abs(eT0[rideEdge[0][0]] - expectT) < 1e-5, '乘车边旅行时间同步到新时刻表');
assert.ok(Math.abs(eT0[rideEdge[0][1]] - expectT) < 1e-5, '反向乘车边同样同步');
assert.ok(pl[0].floor >= 1);
console.log('PASS 2 准入统一入口 / 慢车上线降速 / 周转与最短路边权同步');

// ================= 3. 区间载客稳定、上下客只在停站 =================
const A = Object.create(C.Agents.prototype);
let legCalls = 0;
A.legLoad = () => { legCalls++; return 0.42 + legCalls * 0.07; };
const tt = { g: { r: 0, legs: [{ k: 0, rev: false }, { k: 1, rev: false }] }, leg: 0, id: 1 };
const L0 = tt.g.legs[0], model1 = { version: 1 }, W = {};
const o1 = A.legOccupancy(tt, L0, model1, W), o2 = A.legOccupancy(tt, L0, model1, W);
assert.equal(o1, o2, '同一区间内载客数不随帧/时段权重波动');
assert.equal(legCalls, 1, '同一区间只取一次断面客流');
const o3 = A.legOccupancy(tt, L0, { version: 2 }, W);
assert.equal(legCalls, 2, '求解版本变化后允许重新取一次断面客流');
assert.notEqual(o3, o1);
const runners = [];
A.trainRiders(tt, { door: 1, state: 'run' }, 4, model1, W, runners);
assert.equal(runners.length, 0, '区间行驶途中没有上下客动画');
console.log('PASS 3 区间行驶载客锁定 / 上下客只发生在停站');

// ================= 4. 无车交路不计客流 + 交路独立客流与合计守恒 =================
const NP = 4, pHours = [3, 6, 3, 12];
const N = 4, R = 3;
const fakeNet = {
  N: N, R: R,
  boardEdge: [Int32Array.from([0, 1]), Int32Array.from([2]), Int32Array.from([3])],
  C: { routes: [
    { lineId: 'L', loop: false }, { lineId: 'L', loop: false }, { lineId: 'L', loop: true },
  ] },
};
const per = [];
for (let p = 0; p < NP; p++) {
  const P = {
    stIn: new Float32Array(N), stOut: new Float32Array(N), stXfer: new Float32Array(N),
    load: Float32Array.from([10, 20, 30, 40]),
    freq: Float32Array.from([6, 0, 8]),           // 第 1 条交路完全没有列车运营
    freqDir: new Float32Array(2 * R),
  };
  P.freqDir[4] = 4; P.freqDir[5] = 2;               // 环线顺行/逆行 2:1
  per.push(P);
}
const sd = C.Model.prototype.stationDaily.call({ pHours: pHours }, per, fakeNet);
let hSum = 0; for (let p = 0; p < NP; p++) hSum += pHours[p] * (p === 3 ? 0.9 : 1);
const e0 = 30 * hSum, e2 = 40 * hSum;
assert.ok(Math.abs(sd.routeBoard[0] - e0) < 1e-3, '有车交路按上车边累计日客流');
assert.equal(sd.routeBoard[1], 0, '完全没有列车运营的交路日客流为 0');
assert.ok(Math.abs(sd.routeBoard[2] - e2) < 1e-3);
assert.equal(sd.routeBoardDir[2], 0, '无车交路两个方向都不计');
assert.equal(sd.routeBoardDir[3], 0);
assert.ok(Math.abs(sd.routeBoardDir[0] - sd.routeBoard[0]) < 1e-3, '非环线两个方向记同一份客流（UI 只取方向 0）');
assert.ok(Math.abs(sd.routeBoardDir[4] / sd.routeBoard[2] - 4 / 6) < 1e-4, '环线按发车频率比例拆分到两个方向');
assert.ok(Math.abs(sd.routeBoardDir[5] / sd.routeBoard[2] - 2 / 6) < 1e-4);
assert.ok(Math.abs(sd.routeBoardDir[4] + sd.routeBoardDir[5] - sd.routeBoard[2]) < 1e-3, '环线拆分后合计守恒');

const fakeG = { model: { net: fakeNet, stDaily: sd, dailyStale: false } };
const svc = F.serviceRiders(fakeG, 'L');
assert.equal(svc.size, 4, '每条交路一行（环线按顺行/逆行拆两行）');
assert.ok(Math.abs(svc.get('0:0') - sd.routeBoard[0]) < 1e-3);
assert.equal(svc.get('1:0'), 0);
assert.equal(svc.get('2:0'), sd.routeBoardDir[4]);
assert.equal(svc.get('2:1'), sd.routeBoardDir[5]);
let lineTotal = 0; for (let r = 0; r < R; r++) lineTotal += sd.routeBoard[r];
assert.ok(Math.abs(F.lineRiders(fakeG, 'L') - lineTotal) < 1e-3, '所有交路客流量合计 === 线路总客流量');
assert.equal(F.serviceRiders({ model: { net: fakeNet, stDaily: null, dailyStale: true } }, 'L').size, 0,
  '日客流还没算好时不返回过期数据');
console.log('PASS 4 无车交路零客流 / 每条交路独立客流 / 合计严格等于线路总客流');

// ================= 5. 编译期兜底过滤预留站与停用站 =================
M.setStationEnabled(net, ids[1], false);   // 已关闭运营
net.stations[ids[2]].rsv = 1;              // 预留站
const Cx = M.compile(net, city), tpx = Cx.topo.get(lid);
const res = M.svcStops(tpx, { skip: [] });
assert.ok(res, '仍能编译出交路');
const stSeq = tpx.routes[res.ri].st;
assert.ok(res.stops.length >= 2, '至少保留两端可停靠的站');
assert.ok(res.stops.every(i => M.stationOpen(net.stations[stSeq[i]])),
  '预留站与停用站都不作为交路停靠站（编辑器过滤之外编译期再兜一次底）');
const res2 = M.svcStops(tpx, { skip: ids.slice() });
assert.ok(res2, '端点仍要保留，交路几何才能首尾闭合');
assert.equal(res2.stops.length, 2, '中间站全部跳过/不可用时只剩两个端点');
assert.ok(res2.stops.every(i => i === res2.ia || i === res2.ib), '保留的正是区间两端');
// 端点没有站台时也只影响上下客（buildMetro 的 shut 边），不破坏路线本身
assert.ok(M.svcStops(tpx, { skip: [], from: ids[0], to: ids[3] }).stops.length >= 2);
M.setStationEnabled(net, ids[1], true);
delete net.stations[ids[2]].rsv;
const Cok = M.compile(net, city);
assert.ok(M.svcStops(Cok.topo.get(lid), { skip: [] }).stops.length === ids.length,
  '恢复运营 / 补建为正式站后按正式站规则重新计入停靠');
console.log('PASS 5 新增交路停靠站编译期排除预留站与停用站，恢复后自动生效');

// ================= 6. 真实线网：无车线路频率与日客流立即归零 =================
game.net = net;                                   // 第 5 节末尾已把停用/预留站恢复成正式站
game.compiled = M.compile(net, city);
game.model.setNetwork(game.compiled);
assert.equal(typeof game.model.fleetSource, 'function', '真实游戏挂载了车队计划');
const wd0 = game.model.ctxs.wd.per[0], mnet = game.model.net;
assert.equal(wd0.freq.length, mnet.R);
assert.ok(Array.from(wd0.freq).every(f => f === 0), '一辆车都没有时，线网重建立即把所有交路发车频率归零');
assert.ok(Array.from(wd0.freqDir).every(f => f === 0), '两个方向的频率同步归零');
assert.ok((F.plan(game, mnet) || []).every(p => p.avail[0] === 0), '车队计划里没有可用列车');
const sdReal = game.model.stationDaily(game.model.ctxs.wd.per, mnet);
assert.ok(Array.from(sdReal.routeBoard).every(v => v === 0), '完全没有列车运营的线路不产生日客流量');
console.log('PASS 6 线网重建后无车交路频率 / 线路日客流立即归零');

console.log('ALL PASS v4.6 速度 / 客流 / 交路统计 / 交路站点过滤');
