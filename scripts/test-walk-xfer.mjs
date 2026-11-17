// 手动换乘关系回归：默认无换乘、站外换乘/长距离换乘、类型互斥、改名同步、换乘组聚合、归一化与存档往返
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
for (const src of ['settings', 'corp', 'fleet', 'screens']) await load('js/' + src + '.js');
C.useMap('tutorial');
const g = C.Game.create({ mode: 'free', tutorial: true, seed: 20000101 });
const city = g.city, model = g.model;

// 默认规则：两座靠得再近也不自动生成换乘
assert.equal(JSON.stringify(C.Game.walkXferDefault()), JSON.stringify({ on: [], same: [] }));
assert.equal(JSON.stringify(g.walkXfer), JSON.stringify({ on: [], same: [] }), '新游戏默认没有任何换乘关系');

// 找一对实际步行路径落在换乘上限内的坐标
let pair = null;
for (let x = 4; x < city.W - 6 && !pair; x += 2) {
  for (let y = 4; y < city.H - 6 && !pair; y += 2) {
    const a = { x: x + 0.5, y: y + 0.5, id: 'probe' };
    const targets = [];
    for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [2, 0], [0, 2]]) {
      targets.push({ x: a.x + dx, y: a.y + dy, id: 't' + dx + '_' + dy });
    }
    const links = model.walkTransferPreview(a, targets);
    if (links.length) {
      const t = targets.find(o => o.id === links[0].station);
      pair = { a: { x: a.x, y: a.y }, b: { x: t.x, y: t.y } };
    }
  }
}
assert.ok(pair, '未找到近距可步行站点对');

// computeAccess 只需要车站坐标与运营标记，可直接构造编译结果
const Cx = {
  stations: [{ id: 'sA', x: pair.a.x, y: pair.a.y }, { id: 'sB', x: pair.b.x, y: pair.b.y }],
  serviced: [true, true],
};
const key = C.Game.walkXferKey('sA', 'sB');
const transfers = () => model.computeAccess(Cx).transfers;

model.walkXfer = C.Game.walkXferDefault();
assert.equal(transfers().length, 0, '默认不生成任何换乘');

model.walkXfer = { auto: true, on: [], off: [] };
assert.equal(transfers().length, 0, '旧格式的自动规则也不会恢复自动判定');

model.walkXfer = { on: [key], same: [] };
const walk = transfers();
assert.equal(walk.length, 2, '手动指定的站外换乘生成一对双向边');
assert.ok(walk.every(t => t.manual === true && t.same === false), '站外换乘带正确标记');
assert.ok(walk.every(t => t.m > 0 && t.walkM === t.m), '站外换乘按实际步行距离计时');

model.walkXfer = { on: [], same: [key] };
const same = transfers();
assert.equal(same.length, 2, '长距离换乘同样生成一对双向边');
assert.ok(same.every(t => t.same === true && t.m === 0 && t.walkM > 0), '长距离换乘零时间但保留步行路径长度');

model.walkXfer = { on: [], same: [] };
assert.equal(transfers().length, 0, '取消关系后换乘立即消失');

// 规则归一化：旧格式迁移、顺序错误、重复与两种关系冲突
const norm = C.Game.walkXferNormalize({ auto: true, on: [key, key, 'sB|sA'], off: ['sA|sC'], same: [key] });
assert.equal(JSON.stringify(norm), JSON.stringify({ on: [], same: [key] }), '旧格式迁移且长距离换乘关系优先');
assert.equal(JSON.stringify(C.Game.walkXferNormalize(null)), JSON.stringify({ on: [], same: [] }), '无规则字段的空存档保持默认');
assert.equal(C.Game.walkXferNormalize({ on: ['sA|sB'], same: [] }).on.length, 1, '旧存档里手动指定的站外换乘保留');

// 建站先后：年月优先、同月按编号
g.net.stations.sA = { id: 'sA', name: '先建站', x: pair.a.x, y: pair.a.y, size: 'M', type: 'underground', built: [2000, 1] };
g.net.stations.sB = { id: 'sB', name: '后建站', x: pair.b.x, y: pair.b.y, size: 'M', type: 'underground', built: [2001, 5] };
assert.ok(C.Game.stationCmp(g.net, 'sA', 'sB') < 0, '按建成年月判断先后');

// 指定任一种关系后，后建站自动改用先建站的站名
g.walkXfer = { on: [], same: [] };
g.walkXferSetLink(key, 'same');
assert.equal(g.net.stations.sA.name, '先建站');
assert.equal(g.net.stations.sB.name, '先建站', '长距离换乘：后建站跟随先建站站名');
assert.equal(g.walkXfer.same.length, 1);
assert.equal(JSON.stringify(g.model.walkXfer), JSON.stringify(g.walkXfer), '规则变更已注入模型');

g.net.stations.sB.name = '另一个名字';
g.walkXferSetLink(key, 'on');
assert.equal(g.net.stations.sB.name, '先建站', '站外换乘同样同步站名');
assert.equal(g.walkXfer.same.length, 0, '一个站对只能有一种关系');
assert.equal(g.walkXfer.on.length, 1);

g.walkXferSetLink(key, null);
assert.equal(g.walkXfer.on.length + g.walkXfer.same.length, 0, '可以完全移除关系');

// 存档往返：关系与统一后的站名都会保存
g.walkXferSetLink(key, 'same');
const saved = JSON.parse(JSON.stringify(g.serialize()));
assert.equal(JSON.stringify(saved.walkXfer), JSON.stringify({ on: [], same: [key] }));
const g2 = C.Game.restore(saved);
assert.equal(g2.walkXfer.same.length, 1);
assert.equal(g2.walkXfer.same[0], key);
assert.equal(JSON.stringify(g2.model.walkXfer), JSON.stringify(g2.walkXfer), '读档后规则注入模型');
assert.equal(g2.net.stations.sB.name, '先建站', '读档后仍保持统一站名');

// 换乘组：站外换乘与长距离换乘都把站台并入同一座换乘站，线路取并集，组按建成先后排序
g.net.stations.sC = { id: 'sC', name: '第三站', x: pair.a.x + 1, y: pair.a.y + 1, size: 'M', type: 'underground', built: [2002, 3] };
const keyBC = C.Game.walkXferKey('sB', 'sC');
g.walkXfer = { on: [key], same: [keyBC] };
const sigA = g.stationGroupSig();
assert.ok(sigA && sigA.indexOf(key) >= 0 && sigA.indexOf(keyBC) >= 0, '换乘组签名包含两种关系');
const grp = g.stationGroup('sA');
assert.equal(JSON.stringify(grp), JSON.stringify(['sA', 'sB', 'sC']), '两种关系连成的三座站台属于同一组且按建成先后排序');
assert.equal(JSON.stringify(g.stationGroup('sC')), JSON.stringify(grp), '组内任一座站台都得到同一个换乘组');
assert.equal(JSON.stringify(g.stationGroup('sZ')), JSON.stringify(['sZ']), '没有关系的站台自成一个组');
const fakeNet = {
  stations: { sA: {}, sB: {}, sC: {} },
  lines: { l1: { id: 'l1' }, l2: { id: 'l2' } },
  segments: { e1: { a: 'sA', b: 'sB', line: 'l1' }, e2: { a: 'sB', b: 'sC', line: 'l2' } },
};
assert.equal(JSON.stringify(g.stationGroupLines(fakeNet, grp)), JSON.stringify(['l1', 'l2']), '整组可乘坐线路去重合并');
g.walkXfer = { on: [], same: [key] };
assert.notEqual(g.stationGroupSig(), sigA, '规则变化后换乘组缓存签名跟着变化');
assert.equal(g.stationGroup('sA').length, 2, '规则变化后换乘组立即重算');

// 站台规模一致性：新增关系时检查合并后的整个换乘组，改规模时目标扩展为整组
g.net.stations.sD = { id: 'sD', name: '第四站', x: pair.a.x + 2, y: pair.a.y + 2, size: 'L', type: 'underground', built: [2003, 2] };
g.walkXfer = { on: [], same: [] };
const keyBD = C.Game.walkXferKey('sB', 'sD');
const bad = g.walkXferSetLink(keyBD, 'same');
assert.ok(bad && bad.error && bad.error.indexOf('站台规模不一致') >= 0, '规模不一致时返回冲突提示');
assert.equal(g.walkXfer.on.length + g.walkXfer.same.length, 0, '冲突时规则不写入');

g.walkXfer = { on: [key], same: [] };
const bad2 = g.walkXferSetLink(keyBD, 'on');
assert.ok(bad2 && bad2.error, '新站与已有换乘组的整组规模不一致时同样被拒');
assert.equal(g.walkXfer.on.length, 1, '冲突不改动已有关系');

g.net.stations.sD.size = 'M';
assert.equal(g.walkXferSetLink(keyBD, 'on'), null, '整组一致时添加成功');
assert.equal(g.walkXfer.on.length, 2);
assert.equal(JSON.stringify(g.stationGroupExpand(['sA'])), JSON.stringify(['sA', 'sB', 'sD']), '改规模时目标扩展为整组');
assert.equal(JSON.stringify(g.stationGroupExpand(['sZ'])), JSON.stringify(['sZ']), '无换乘关系的站只扩自己');

// 旧存档对齐：只升不降，统一到组内最大规模
g.net.stations.sB.size = 'L';
assert.ok(g.walkXferAlignSizes() > 0, '组内规模不一致时发生对齐');
assert.ok(['sA', 'sB', 'sD'].every(function (id) { return g.net.stations[id].size === 'L'; }), '对齐到组内最大规模');
assert.equal(g.net.stations.sC.size, 'M', '组外车站不受影响');

console.log('PASS manual transfer rules');
process.exit(0);
