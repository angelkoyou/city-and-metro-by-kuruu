// v4.8 回归：停用站 / 预留站视为不在线路上——从停靠站表、运营路线、调度与统计中排除。
// 覆盖：中间站跳过、终点站折返点前移、列车自动改属、恢复运营后复原、正常站不受影响。
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
const C = c.CM, M = C.Metro, F = C.Fleet, CFG = C.CFG;
C.UI = function () {};
for (const src of ['settings', 'corp', 'fleet', 'screens']) await load('js/' + src + '.js');
C.useMap('tutorial');
const game = C.Game.create({ mode: 'free', tutorial: true, seed: 20000101 });
C.Fleet.ensure(game);
const city = game.city;

// 一条五站直线：s1 — s2 — s3 — s4 — s5
const net = M.empty();
const lid = M.newLine(net);
const ids = [];
for (let k = 0; k < 5; k++) ids.push(M.addStation(net, 10 + k * 8, 10, { size: 'M', type: 'underground' }, city));
for (let k = 1; k < ids.length; k++) assert.ok(M.addSegment(net, lid, ids[k - 1], ids[k], [], 'underground').id);

const base = M.compile(net, city);
assert.equal(base.routes.length, 1, '一条线一条全程交路');
const R0 = base.routes[0];
assert.equal(R0.stIds.length, 5, '正常情况下列表包含全部五站');
assert.equal(R0.legSec.length, 4, '四个区间');
assert.equal(R0.nStops, 5);
assert.equal(M.stationOpen(net.stations[ids[2]]), true);
console.log('PASS 0 基线：五站线路编译为 5 站 / 4 区间');

// ================= 1. 中间站停用：不停靠、不进站点表、不减速 =================
M.setStationEnabled(net, ids[2], false);
const C1 = M.compile(net, city), R1 = C1.routes[0], mi = C1.sIndex.get(ids[2]);
assert.ok(R1.stIds.indexOf(ids[2]) < 0, '停用站不出现在运营路线的停靠站表');
assert.equal(R1.stIds.length, 4, '其余四站照常运营');
assert.equal(R1.legSec.length, 3, '跨过停用站的两段区间合并为一段');
assert.ok(R1.cycleSec < R0.cycleSec, '少停一站后周转时间变短');
assert.equal(R1.nStops, 4, '停靠站数不含停用站');
assert.equal(C1.stationTracks[mi].size, 1, '轨道结构仍接在这条线上（可以随时恢复）');
assert.equal(C1.stationRoutes[mi].length, 0, '停用站没有停靠路线');
assert.equal(C1.serviced[mi], false, '停用站不计入服务覆盖 / 服务缺口');
C1.routes.forEach(function (rt) { assert.ok(rt.stIdx.indexOf(mi) < 0, '运营路线的站台节点也不含停用站'); });
// 建图：停用站不应出现在任何上下客边或站台节点上
const gm = game.model;
const built = gm.buildMetro(C1);
let hit = 0;
for (let e = 0; e < built.eSt.length; e++) if (built.eSt[e] === mi && built.eType[e] === 0) hit++;
assert.equal(hit, 0, '停用站不产生上客边');
assert.equal(built.boardEdge[0].length, R1.stIdx.length, '上下客边数量与可停靠站数一致');
console.log('PASS 1 中间站停用后：跳过不停、区间合并、无站台节点、不计服务覆盖');

// ================= 2. 终点站停用：折返点前移到上一个可停靠站 =================
M.setStationEnabled(net, ids[2], true);
M.setStationEnabled(net, ids[4], false);
const C2 = M.compile(net, city), R2 = C2.routes[0];
assert.equal(R2.stIds.length, 4, '终点站停用后只运营到前一站');
assert.equal(R2.stIds[R2.stIds.length - 1], ids[3], '新的折返点是上一个可停靠站');
assert.ok(!R2.stIds.includes(ids[4]), '停用的终点站不在路线里');
assert.equal((R2.closedEnds || []).length, 1, '记录被前移的终点站，供列车改属');
assert.equal(R2.closedEnds[0], ids[4]);
assert.ok(R2.lenM < R0.lenM, '运营长度缩短到新折返点');
assert.equal(R2.legSec.length, 3, '站数减少后区间数同步减少');
console.log('PASS 2 终点站停用：折返点前移到上一个可停靠站');

// ================= 3. 列车调度：原终点列车自动改属新折返点，不退回车辆段 =================
game.net = net; game.compiled = C2;
C.Fleet.ensure(game);
game.fleet.trains.push({ id: 'tr1', line: lid, svc: ids[4], model: 'gen-a', cars: 4, cost: 0 });
const t1 = game.fleet.trains[game.fleet.trains.length - 1];
C.Fleet.sync(game);
assert.equal(t1.line, lid, '列车仍留在原线路');
assert.equal(t1.svc, ids[3], '列车改属新的折返点，而不是被退回车辆段');
console.log('PASS 3 终点停用后列车自动改属新折返点');

// ================= 4. 交路端点与停靠站：自动收敛到可停靠站 =================
const tp = C2.topo.get(lid);
const plan2 = M.svcStops(tp, { skip: [], from: ids[0], to: ids[4] });
assert.ok(plan2, '终点落在停用站时仍能生成交路计划');
assert.equal(tp.routes[plan2.ri].st[plan2.ib], ids[3], '终点自动收敛到上一个可停靠站');
const plan3 = M.svcStops(tp, { skip: ids.slice() });
assert.ok(plan3, '全部跳站时也保留可停靠的端点');
assert.equal(plan3.stops.length >= 2, true, '交路至少保留两站');
M.setStationEnabled(net, ids[4], true);
const C3 = M.compile(net, city), R3 = C3.routes[0];
assert.equal(R3.stIds.length, 5, '终点站恢复运营后重新纳入路线');
assert.ok(Math.abs(R3.cycleSec - R0.cycleSec) < 1e-6, '恢复后周转时间回到原值（不残留）');
console.log('PASS 4 交路端点收敛 + 恢复运营后完全复原');

// ================= 5. 预留站同样视为不存在 =================
net.stations[ids[1]].rsv = 1;
const C4 = M.compile(net, city), R4 = C4.routes[0], r1 = C4.sIndex.get(ids[1]);
assert.ok(!R4.stIds.includes(ids[1]), '预留站不在停靠站表里');
assert.equal(C4.stationTracks[r1].size, 1, '预留站仍记录轨道接入（未来换乘用）');
assert.equal(C4.stationRoutes[r1].length, 0, '预留站不提供停靠');
assert.equal(C4.serviced[r1], false, '预留站不计服务覆盖');
assert.equal(R4.legSec.length, 3, '预留站两侧区间合并');
delete net.stations[ids[1]].rsv;
console.log('PASS 5 预留站同样从运营路线剔除，只保留结构接入');

// ================= 6. 正常站点行为不受影响 =================
const C5 = M.compile(net, city), R5 = C5.routes[0];
for (const sid of ids) {
  const si = C5.sIndex.get(sid);
  assert.ok(R5.stIds.includes(sid), '正常站仍在路线里：' + sid);
  assert.ok(C5.stationRoutes[si].length === 1, '正常站有停靠路线');
  assert.equal(C5.serviced[si], true, '正常站参与服务覆盖');
}
assert.equal(R5.nStops, 5);
assert.equal(R5.cycleSec, R0.cycleSec);
console.log('PASS 6 正常站点行为不受影响');

console.log('ALL PASS v4.8 停用站 / 预留站从停靠、调度与统计中排除');
