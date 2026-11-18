// v4.5 回归：车站「是否启用」开关 + 预留站多线换乘规则。
// 覆盖数据模型、编译期停靠/换乘语义、运营费与商业收支、预留站升级前后的差异。不读写玩家存档。
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
const C = c.CM, M = C.Metro, TOD = C.TOD, CFG = C.CFG;
C.UI = function () {};
for (const src of ['settings', 'corp', 'fleet', 'screens']) await load('js/' + src + '.js');
C.useMap('tutorial');
const game = C.Game.create({ mode: 'free', tutorial: true, seed: 20000101 });
C.Fleet.ensure(game);
const city = game.city;

// 两条线路共用一个中间站：a — mid — b / a — mid — e
const net = M.empty();
const l1 = M.newLine(net), l2 = M.newLine(net);
const a = M.addStation(net, 10, 10, { size: 'M', type: 'underground' }, city);
const mid = M.addStation(net, 18, 10, { size: 'M', type: 'underground', reserved: true }, city);
const b = M.addStation(net, 26, 10, { size: 'M', type: 'underground' }, city);
const e = M.addStation(net, 18, 18, { size: 'M', type: 'underground' }, city);
const seg = (lid, x, y) => M.addSegment(net, lid, x, y, [], 'underground');
assert.ok(seg(l1, a, mid).id, '线路 1 接入预留站');
assert.ok(seg(l1, mid, b).id, '线路 1 从预留站继续');
assert.ok(seg(l2, a, mid).id, '线路 2 也能接入同一座预留站');
assert.ok(seg(l2, mid, e).id, '线路 2 从预留站继续');

// ================= 1. 数据模型与统一规则入口 =================
assert.equal(net.stations[mid].rsv, 1, '预留站标志存在');
assert.equal(net.stations[a].off, undefined, '正式站默认启用（旧存档无字段）');
assert.equal(M.stationOff(net.stations[a]), false);
assert.equal(M.stationOpen(net.stations[a]), true, '正式站默认启用');
assert.equal(M.stationOpen(net.stations[mid]), false, '预留站不算启用');
assert.equal(M.setStationEnabled(net, a, false).off, 1, '关闭写入 off=1');
assert.equal(M.stationOff(net.stations[a]), true);
assert.equal(M.stationOpen(net.stations[a]), false);
assert.equal(M.setStationEnabled(net, a, true).off, undefined, '恢复运营删除 off 字段');
assert.equal(M.stationOpen(net.stations[a]), true);
assert.equal(M.setStationEnabled(net, 'not-exist', false), null, '不存在的车站安全返回');
console.log('PASS 1 启用开关数据模型（默认启用 / 旧存档兼容 / 统一入口）');

// ================= 2. 预留站：可多线连接，但升级前不换乘、不计客流 =================
const C1 = M.compile(net, city), mi = C1.sIndex.get(mid);
assert.equal(C1.stationTracks[mi].size, 2, '预留站可被 2 条线路连接（未来换乘站）');
assert.equal(M.stationLines(net, mid).length, 2, '数据层按区段统计接入线路，不限制预留站');
assert.equal(C1.stationLines[mi].size, 0, '升级前不提供换乘');
assert.equal(C1.stationRoutes[mi].length, 0, '升级前没有停靠路线');
assert.equal(C1.serviced[mi], false, '升级前不计客流');
assert.ok(C1.routes.filter(r => r.stIds.indexOf(mid) >= 0).length >= 2, '两条线的列车都从预留站通过');
assert.ok(C1.routes.filter(r => r.stIds.indexOf(mid) >= 0).every(r => r.nStops === r.stIds.length - 1), '停靠站数排除预留站');
console.log('PASS 2 预留站多线连接 / 升级前无换乘无客流');

// ================= 3. 升级为正式站：自动按正式规则启用换乘与客流 =================
delete net.stations[mid].rsv;
const C2 = M.compile(net, city), m2 = C2.sIndex.get(mid);
assert.equal(C2.stationLines[m2].size, 2, '升级后成为换乘站');
assert.ok(C2.stationRoutes[m2].length >= 2, '升级后两条线都停靠');
assert.equal(C2.serviced[m2], true, '升级后参与客流计算');
assert.equal(C2.stationTracks[m2].size, 2, '结构接入不变');
assert.ok(C2.routes.filter(r => r.stIds.indexOf(mid) >= 0).every(r => r.nStops === r.stIds.length), '升级后按正式站计停靠数');
console.log('PASS 3 升级为正式站后自动按正式站规则启用换乘与客流');

// ================= 4. 停用：停运、不计客流、不提供换乘、不算运营费 =================
M.setStationEnabled(net, mid, false);
const C3 = M.compile(net, city), m3 = C3.sIndex.get(mid);
assert.equal(C3.stationLines[m3].size, 0, '停用后不再提供换乘');
assert.equal(C3.stationRoutes[m3].length, 0, '停用后没有停靠路线');
assert.equal(C3.serviced[m3], false, '停用后不计客流');
assert.equal(C3.stationTracks[m3].size, 2, '停用只是运营开关，轨道结构仍接入（可随时恢复）');
assert.ok(C3.routes.filter(r => r.stIds.indexOf(mid) >= 0).every(r => r.nStops === r.stIds.length - 1), '停用站通过不停靠');
assert.equal(M.stationUpkeepFactor(net.stations[mid]), 0, '停用站不再支付日常运营费');
assert.equal(M.stationUpkeepFactor(net.stations[a]), 1, '启用站按原价支付');
net.stations[mid].rsv = 1;
assert.equal(M.stationUpkeepFactor(net.stations[mid]), 0, '停用的预留站同样不收费');
assert.ok(M.stationUpkeepFactor(net.stations[b]) > 0);
delete net.stations[mid].rsv;
net.stations[mid].off = 1;
assert.ok(Math.abs(M.stationUpkeepFactor({ size: 'M', type: 'underground', rsv: 1 }) - CFG.cost.reservedRatio) < 1e-9, '仅预留站仍按 1/5 计维护费');
// 恢复：所有运营语义回到正式站
M.setStationEnabled(net, mid, true);
const C4 = M.compile(net, city), m4 = C4.sIndex.get(mid);
assert.equal(C4.stationLines[m4].size, 2, '恢复运营后换乘立刻生效');
assert.equal(C4.serviced[m4], true);
assert.equal(M.stationUpkeepFactor(net.stations[mid]), 1);
console.log('PASS 4 停用后停运 / 无客流 / 无换乘 / 免运营费，恢复后复原');

// ================= 5. 商业开发（TOD）与每日车站运营费 =================
const fake = (Cmp) => ({
  clock: { y: 2000 }, net: net,
  model: {
    net: { C: Cmp }, dailyStale: false,
    stDailyWk: { inn: Cmp.stations.map(() => 5000), out: Cmp.stations.map(() => 5000), xfer: Cmp.stations.map(() => 2000) },
    stDailyWe: { inn: Cmp.stations.map(() => 3000), out: Cmp.stations.map(() => 3000), xfer: Cmp.stations.map(() => 1000) },
  },
});
// 启用时本站有客流 → 有商业收入；停用时不计入收入也不计维护成本
net.stations[mid].tod = 1;
const live = TOD.daily(fake(C2), 'wd');
assert.ok(live.rev > 0 && live.cost > 0, '前提：正式站有商业收支');
M.setStationEnabled(net, mid, false);
const offNet = M.compile(net, city);
const dailyOff = TOD.daily(fake(offNet), 'wd');
assert.ok(dailyOff.rev < live.rev, '停用站不再产生商业收入');
assert.ok(dailyOff.cost < live.cost, '停用站不再产生商业维护成本');
M.setStationEnabled(net, mid, true);
console.log('PASS 5 停用站不参与客流收入与商业维护费');

console.log('ALL PASS v4.5 车站启用开关 / 预留站多线换乘');
