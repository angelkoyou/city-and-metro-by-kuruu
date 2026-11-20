// v5.3 回归：线路示意图里的地铁导航（纯逻辑，不开浏览器）。
// 覆盖：三种策略各自选到不同方案、候车按实际发车频率、换乘次数与换乘站、
//       经过站点与区间（高亮数据）、票价（统一/按里程、160 轨道取高）、各种无法规划的情况。
// 线网是手工构造的，不读写玩家存档。
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const root = new URL('../', import.meta.url), memory = new Map();
const c = {
  console, performance, atob, btoa, TextEncoder, TextDecoder, setTimeout, clearTimeout,
  navigator: { hardwareConcurrency: 4, deviceMemory: 4 },
  matchMedia: () => ({ matches: false }),
  localStorage: { getItem: k => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, String(v)), removeItem: k => memory.delete(k) },
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
await load('js/nav.js');
const NV = C.Nav;
// 数组产自 vm 上下文，原型与测试文件不同，deepEqual 会判不等：先拷到当前 Realm
const deep = (actual, expected, msg) => assert.deepEqual(Array.from(actual), expected, msg);
assert.ok(NV && NV.plans, 'CM.Nav 必须挂到全局');

// ---------------- 线网 ----------------
// 1 号线 A-B-C-D，2 号线 D-E-F（换乘一次，最快）
// 3 号线 A-G-H-F（直达，但班次少：换乘最少）
// 4 号线 A-P-F（距离最短，但班次极少：最便宜）
// 5 号线 F-Z（160 轨道，验证高票价）
const ST = [
  ['sA', '甲站'], ['sB', '乙站'], ['sC', '丙站'], ['sD', '丁站'], ['sE', '戊站'], ['sF', '己站'],
  ['sG', '庚站'], ['sH', '辛站'], ['sP', '壬站'], ['sZ', '癸站'], ['sX', '未开通站'], ['sY', '孤立站'],
];
const stations = ST.map(x => ({ id: x[0], name: x[1] }));
const sIndex = new Map(stations.map((s, i) => [s.id, i]));
const mkRoute = (lid, ids, secs, lens) => ({
  lineId: lid, label: lid, loop: false, stIds: ids, stIdx: ids.map(id => sIndex.get(id)),
  legSec: secs, legLenM: lens, legSegs: secs.map((_, k) => [{ id: lid + '-' + k }]), segRefs: secs.map((_, k) => ({ id: lid + '-' + k })),
  lvPen: ids.map(() => 0), nStops: ids.length,
});
const routes = [
  mkRoute('L1', ['sA', 'sB', 'sC', 'sD'], [120, 120, 120], [2000, 2000, 2000]),
  mkRoute('L2', ['sD', 'sE', 'sF'], [100, 100], [1500, 1500]),
  mkRoute('L3', ['sA', 'sG', 'sH', 'sF'], [150, 150, 150], [4000, 4000, 4000]),
  mkRoute('L4', ['sA', 'sP', 'sF'], [300, 300], [1500, 1500]),
  mkRoute('L5', ['sF', 'sZ'], [300], [8000]),
];
routes.forEach((r, i) => { r.id = i; });
const net = {
  lines: {
    L1: { id: 'L1', name: '1 号线', color: '#e4002b', speed: 80 },
    L2: { id: 'L2', name: '2 号线', color: '#0072ce', speed: 80 },
    L3: { id: 'L3', name: '3 号线', color: '#00a651', speed: 80 },
    L4: { id: 'L4', name: '4 号线', color: '#f5a623', speed: 80 },
    L5: { id: 'L5', name: '机场快线', color: '#7b5cd6', speed: 160 },
  },
};
const stationLines = stations.map(() => new Set());
for (const rt of routes) for (const si of rt.stIdx) stationLines[si].add(rt.lineId);
const mkC = () => {
  const C0 = {
    net: net, stations: stations, sIndex: sIndex, routes: routes, stationLines: stationLines,
    serviced: stations.map((s, i) => s.id !== 'sX' && s.id !== 'sY'), s160: new Uint8Array(stations.length),
  };
  for (const si of sIndex.values()) { /* 保留全部站 */ }
  C0.s160[sIndex.get('sF')] = 1; C0.s160[sIndex.get('sZ')] = 1;
  return C0;
};
const FREQ = [10, 6, 1.5, 1, 6];
const mkG = (freq) => {
  const F = freq || FREQ.slice();
  const dir = [];
  for (const f of F) dir.push(f, f);
  const C0 = mkC();
  return {
    clock: { y: 2010, m: 1, d: 1, minute: 480 }, net: net,
    model: {
      net: { C: C0, acc: null },
      hourPeriod: [0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 0],
      resultsFor: () => ({ per: [{ freq: F, freqDir: dir }] }),
      fare: { mode: 'dist', flat: 2, km0: 6, step: 3, inc: 1, cap: 5 },
      fare160: { mode: 'dist', flat: 6, km0: 6, step: 6, inc: 2, cap: 20 },
    },
    econ: {},
  };
};

// ================= 1. 三种策略各选各的 =================
const P = NV.plans(mkG(), 'sA', 'sF');
assert.equal(P.ok, true, 'A → F 应能规划：' + (P.error || ''));
const T = P.items.time, X = P.items.xfer, M = P.items.fare;
assert.ok(T && X && M, '三种策略都要有结果');

// 时间最短：1 号线换 2 号线，一站在丁站换乘，23.8 分钟（含候车 8 分钟 + 换乘步行 4 分钟）
deep(T.legs.map(l => l.kind), ['ride', 'ride'], '时间最短应是一段换乘两段乘车');
deep(T.legs.map(l => l.lineId), ['L1', 'L2'], '时间最短走 1 号线 → 2 号线');
deep(T.legs[0].stopIds, ['sA', 'sB', 'sC', 'sD'], '第一段经过 A B C D');
deep(T.legs[0].segIds, ['L1-0', 'L1-1', 'L1-2'], '第一段的高亮区间');
deep(T.legs[1].segIds, ['L2-0', 'L2-1'], '第二段的高亮区间');
deep(T.stIds, ['sA', 'sB', 'sC', 'sD', 'sE', 'sF'], '整条行程经过的站点顺序');
deep(T.xferIds, ['sD'], '换乘站是丁站');
assert.equal(T.transfers, 1, '换乘一次');
assert.equal(Math.round(T.minutes), 24, '时间最短约 24 分钟：' + T.minutes);
assert.ok(Math.abs(T.rideMin - 11.833) < 0.01, '乘车 7.5 + 4.33 分钟：' + T.rideMin);
assert.ok(Math.abs(T.waitMin - 8) < 0.01, '候车 3 + 5 分钟：' + T.waitMin);
assert.ok(Math.abs(T.walkMin - 4) < 0.01, '换乘步行 4 分钟：' + T.walkMin);
assert.equal(Math.round(T.fare * 10) / 10, 3, '9 km 按里程票价 3 元：' + T.fare);
assert.equal(Math.round(T.km * 10) / 10, 9, '乘距 9 km');

// 换乘最少：3 号线直达（0 次换乘），29 分钟
assert.equal(X.transfers, 0, '换乘最少应选直达');
deep(X.legs.map(l => l.lineId), ['L3'], '换乘最少走 3 号线');
assert.equal(Math.round(X.minutes), 29, '直达 29 分钟：' + X.minutes);

// 车费最便宜：4 号线 3 km（票价 2 元），虽然要等 30 分钟
deep(M.legs.map(l => l.lineId), ['L4'], '车费最便宜走 4 号线');
assert.equal(Math.round(M.fare * 10) / 10, 2, '3 km 内是起步价 2 元：' + M.fare);
assert.equal(Math.round(M.km * 10) / 10, 3, '乘距 3 km');
assert.ok(M.minutes > T.minutes, '最便宜的方案明显更慢：' + M.minutes);

// 三种方案互不相同（用指纹判断）
assert.notEqual(T.sig, X.sig); assert.notEqual(T.sig, M.sig); assert.notEqual(X.sig, M.sig);

// 方向：非环线写终点站名
assert.equal(T.legs[0].dirName, '丁站', '1 号线往丁站方向');
assert.equal(T.legs[1].dirName, '己站', '2 号线往己站方向');
console.log('PASS 1 三种策略各选各的（时间 24 / 换乘 0 次 / 票价 2 元）');

// ================= 2. 候车按当前时段的发车频率 =================
// 1 号线班次降到 2 列/时（候车 15 分钟）：最快方案应改走 3 号线直达
const slow = NV.plans(mkG([2, 6, 1.5, 1, 6]), 'sA', 'sF');
deep(slow.items.time.legs.map(l => l.lineId), ['L3'], '班次变稀后最快方案改走直达线');
assert.ok(slow.items.time.minutes < 30, '直达仍是 29 分钟：' + slow.items.time.minutes);
console.log('PASS 2 候车按实际发车频率计算');

// ================= 3. 160 轨道按高票价计 =================
const Z = NV.plans(mkG(), 'sA', 'sZ');
assert.equal(Z.ok, true, 'A → Z 应能规划');
const zt = Z.items.time;
deep(zt.legs.map(l => l.lineId), ['L1', 'L2', 'L5'], '经过 160 轨道到癸站');
assert.equal(Math.round(zt.km160 * 10) / 10, 8, '160 轨道 8 km');
// 常规票价：17 km → 2 + ceil(11/3) = 6；160 票价：8 km → 6 + ceil(2/6)×2 = 8
assert.equal(Math.round(zt.fare * 10) / 10, 8, '160 轨道按 160 票价取高：' + zt.fare);
console.log('PASS 3 160 轨道按 160 票价取高');

// ================= 4. 统一票价时三种策略退化为比时间 =================
const flat = mkG();
flat.model.fare = { mode: 'flat', flat: 2 };
flat.model.fare160 = { mode: 'flat', flat: 4 };
const F1 = NV.plans(flat, 'sA', 'sF');
assert.equal(Math.round(F1.items.time.fare * 10) / 10, 2, '统一票价 2 元');
assert.equal(Math.round(F1.items.xfer.fare * 10) / 10, 2, '直达同样 2 元');
assert.equal(Math.round(F1.items.fare.fare * 10) / 10, 2, '最便宜也是 2 元');
deep(F1.items.fare.legs.map(l => l.lineId), ['L1', 'L2'], '票价相同时按耗时选，不会去等 30 分钟的车');
console.log('PASS 4 统一票价时最便宜退化为最快');

// ================= 5. 无法规划的情况 =================
const same = NV.plans(mkG(), 'sA', 'sA');
assert.equal(same.ok, false); assert.equal(same.error, '起点与终点相同');
const none = NV.plans(mkG(), 'sA', null);
assert.equal(none.ok, false); assert.equal(none.empty, true, '没选终点时是空状态，不是错误');
const bad = NV.plans(mkG(), 'sA', 'nope');
assert.equal(bad.ok, false); assert.match(bad.error, /不在/);
const shut = NV.plans(mkG(), 'sA', 'sX');
assert.equal(shut.ok, false); assert.match(shut.error, /未开通/);
// 服务中但没有任何运营线路经过的站：单独标成 serviced 来构造「没有线路连接」
const g6 = mkG();
g6.model.net.C.serviced[sIndex.get('sY')] = 1;
const noLine = NV.plans(g6, 'sA', 'sY');
assert.equal(noLine.ok, false); assert.match(noLine.error, /没有运营中的线路/);
console.log('PASS 5 同站 / 未开通 / 孤立站 / 未知站都能给出原因');

// ================= 6. 车站清单 =================
const list = NV.stations(mkG());
const ids = list.map(s => s.id);
assert.ok(ids.indexOf('sX') < 0 && ids.indexOf('sY') < 0, '未开通与孤立站不出现在清单里');
assert.ok(ids.length === 10, '运营站 10 座：' + ids.join(','));
assert.ok(list.every(s => s.name), '清单里每座站都有名字');
console.log('PASS 6 车站清单只列运营中的车站');

// ================= 7. 票价文字 =================
// UI 还没加载时的兜底格式
assert.equal(NV.fareText(0), '免费');
assert.equal(NV.fareText(2), '¥2');
assert.equal(NV.fareText(2.5), '¥2.5');
// 有 UI.fmtFare 时与经营面板同一口径（去掉「/次」）
C.UI.fmtFare = function (v) { return '¥' + v.toFixed(1) + '/次'; };
assert.equal(NV.fareText(2), '¥2.0');
assert.equal(NV.fareText(0), '免费', '免费不受格式化影响');
console.log('PASS 7 票价文字');

console.log('ALL PASS v5.3 地铁导航（7 组）');
