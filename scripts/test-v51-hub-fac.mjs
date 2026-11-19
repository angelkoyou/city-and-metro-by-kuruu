// v5.1 回归：作弊「设施建造」新增铁路客运站与汽车客运站两类枢纽。
// 覆盖：Fac.TYPES.bus 与 rail 完全同构（除名称与图标）、两类都进作弊菜单、
//       Cheat.addFac 默认接驳客流、Cheat.facList 走 Fac.pax 而不走 Fac.share、
//       两类枢纽的接驳口径逐字段一致、普通设施不受影响、
//       改类别与改接驳客流、存档往返、旧存档缺 pax 时的补齐、缓存签名随 pax 变化。
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
const C = c.CM, CFG = C.CFG, Fac = C.Fac;
C.UI = function () {};
for (const name of ['settings', 'corp', 'fleet', 'cheat']) await load('js/' + name + '.js');
const CB = C.Cheat;
C.Difficulty.loadGame('normal', null);
// 跨 realm 的对象原型不同，深比较前先转成本 realm 的普通值
const plain = v => v === undefined || v === null ? v : JSON.parse(JSON.stringify(v));

// ---- 假城市：100 × 100 格，全陆地 ----
const mkCity = () => ({
  W: 100, H: 100, N: 10000,
  cellAt: (x, y) => (x < 0 || y < 0 || x >= 100 || y >= 100) ? -1 : ((y | 0) * 100 + (x | 0)),
  landFrac: new Float32Array(10000).fill(1),
});
const mkG = (y = 2010) => {
  const g = {
    mapId: 'gz', city: mkCity(), clock: { y: y, m: 1, d: 1 }, year: () => y,
    model: { facIndex: () => -1, facStats: () => null },
  };
  C.game = g;
  return g;
};

// ================= 1. 类型表：汽车客运站与铁路客运站完全同构 =================
assert.ok(Fac.TYPES.rail && Fac.TYPES.bus, '设施系统里要有 rail 与 bus 两个类型');
const KEYS = ['p', 'hub', 'we', 'L', 'r', 'group'];
for (const k of KEYS) {
  assert.deepEqual(plain(Fac.TYPES.bus[k]), plain(Fac.TYPES.rail[k]), '汽车客运站要与铁路客运站同口径：' + k);
}
assert.equal(Fac.TYPES.bus.hub, true, '汽车客运站是交通枢纽');
assert.equal(Fac.TYPES.bus.name, '汽车客运站', '类别显示名');
assert.equal(Fac.TYPES.rail.name, '铁路客运站', '铁路客运站名称不变');
assert.notEqual(Fac.TYPES.bus.icon, Fac.TYPES.rail.icon, '两类要有各自的图标');
assert.ok(/^bus$/.test(Fac.TYPES.bus.icon), '汽车客运站用巴士图标');
assert.deepEqual(plain(Fac.TYPES.bus.p), { hb: 1 }, '吸引的出行目的是枢纽接驳');
assert.equal(Fac.TYPES.bus.r, 0.6, '默认场地半径与铁路客运站一致');

// ================= 2. 菜单：两类都在作弊工具的可选类别里 =================
for (const t of ['rail', 'bus']) {
  assert.ok(CB.FAC_TYPES.indexOf(t) >= 0, '作弊菜单要包含『' + t + '』');
}
assert.deepEqual(plain(CB.HUB_TYPES).sort(), ['bus', 'rail'], '枢纽类别清单');
for (const t of CB.FAC_TYPES) assert.ok(Fac.TYPES[t], '菜单里的每个类别都要有对应的设施类型：' + t);
assert.equal(CB.isHubType('bus'), true, 'bus 是枢纽');
assert.equal(CB.isHubType('rail'), true, 'rail 是枢纽');
assert.equal(CB.isHubType('shop'), false, '商圈不是枢纽');
assert.equal(CB.defPax('bus'), CB.HUB_PAX, '枢纽默认接驳客流');
assert.equal(CB.defPax('shop'), 0, '普通设施没有接驳客流');
// 原有八类仍在菜单里（不影响既有设施建造）
for (const t of ['shop', 'cbd', 'uni', 'hosp', 'scenic', 'park', 'stadium', 'venue']) {
  assert.ok(CB.FAC_TYPES.indexOf(t) >= 0, '原有类别不能丢：' + t);
}

// ================= 3. 建造：两类都能放，默认值一致 =================
let g = mkG(2010);
const rBus = CB.addFac(g, { x: 10.5, y: 10.5, t: 'bus' });
const rRail = CB.addFac(g, { x: 20.5, y: 20.5, t: 'rail' });
assert.equal(rBus.ok, true, '汽车客运站能建：' + (rBus.msg || ''));
assert.equal(rRail.ok, true, '铁路客运站能建：' + (rRail.msg || ''));
const bus = rBus.f, rail = rRail.f;
assert.equal(bus.t, 'bus', '记录里保存类别标识');
assert.equal(bus.pax, CB.HUB_PAX, '汽车客运站默认接驳客流');
assert.equal(rail.pax, CB.HUB_PAX, '铁路客运站默认接驳客流');
assert.equal(bus.r, rail.r, '两类默认规模一致');
assert.equal(bus.w, rail.w, '两类的出行需求字段一致（枢纽不使用）');
assert.match(bus.name, /汽车客运站/, '默认名称带类别名');
assert.match(rail.name, /铁路客运站/, '默认名称带类别名');

// ================= 4. 设施表口径：枢纽走 Fac.pax，不走 Fac.share =================
let list = CB.facList();
assert.equal(list.length, 2, '两座设施都进入设施表');
const fB = list.find(f => f.id === bus.id), fR = list.find(f => f.id === rail.id);
assert.ok(fB && fR, '按 id 能取到两座设施');
for (const [tag, f] of [['汽车客运站', fB], ['铁路客运站', fR]]) {
  assert.equal(f.T.hub, true, tag + '在设施表里是枢纽');
  assert.equal(Fac.pax(f, 2010), CB.HUB_PAX * 1e4, tag + '的接驳客流要按万人次/日换算：' + Fac.pax(f, 2010));
  assert.equal(Fac.share(f, 2010), 0, tag + '不按「占全市比例」吸引');
  assert.match(Fac.sizeText(f, 2010), /万人次\/日/, tag + '的规模说明按接驳客流写');
  assert.deepEqual(plain(f.p), { hb: 1 }, tag + '的出行目的是枢纽接驳');
}
// 两类枢纽的接驳口径逐字段一致（sim.js 的 hubTours 只用这些字段）
for (const k of ['p', 'r', 'we', 'L']) {
  assert.deepEqual(plain(fB[k]), plain(fR[k]), '两类枢纽在设施表里的口径要一致：' + k);
}
assert.equal(fB.T.decay, fR.T.decay, '距离衰减一致');
assert.equal(Fac.pax(fB, 2010), Fac.pax(fR, 2010), '同样的默认值产生同样的接驳量');
assert.equal(Fac.sizeText(fB, 2010), Fac.sizeText(fR, 2010), '两类的参考规模文字一致');

// ================= 5. 普通设施不受影响 =================
g = mkG(2010);
const rShop = CB.addFac(g, { x: 30.5, y: 30.5, t: 'shop' });
assert.equal(rShop.ok, true, '商圈还能照常建');
assert.equal(rShop.f.t, 'shop', '类别标识不变');
assert.equal(rShop.f.pax, 0, '普通设施不会被写上接驳客流');
const fShop = CB.facList().find(f => f.id === rShop.f.id);
assert.equal(fShop.T.hub, undefined, '普通设施不是枢纽');
assert.equal(Fac.pax(fShop, 2010), 0, '普通设施没有接驳客流');
assert.ok(Fac.share(fShop, 2010) > 0, '普通设施仍按出行需求比例吸引：' + Fac.share(fShop, 2010));
assert.equal(fShop.w.length, 1, '普通设施仍用出行需求曲线');
assert.match(Fac.sizeText(fShop, 2010), /占全市/, '普通设施的规模说明仍是占比口径');

// ================= 6. 改类别：接驳客流跟着补 / 归零 =================
g = mkG(2010);
const rec = CB.addFac(g, { x: 40.5, y: 40.5, t: 'shop' }).f;
assert.equal(rec.pax, 0, '普通设施初始没有接驳客流');
CB.setFac(g, rec.id, { t: 'bus' });
assert.equal(rec.t, 'bus', '类别可改成汽车客运站');
assert.equal(rec.pax, CB.HUB_PAX, '改成枢纽要补上默认接驳客流');
CB.setFac(g, rec.id, { pax: 7.5 });
assert.equal(rec.pax, 7.5, '接驳客流可改');
CB.setFac(g, rec.id, { pax: 999 });
assert.equal(rec.pax, 50, '接驳客流上限 50 万人次/日');
CB.setFac(g, rec.id, { t: 'rail' });
assert.equal(rec.t, 'rail', '枢纽之间可以互换');
assert.equal(rec.pax, 50, '枢纽之间互换保留已有接驳客流');
CB.setFac(g, rec.id, { t: 'shop' });
assert.equal(rec.pax, 0, '改回普通设施时接驳客流归零');

// ================= 7. 存档往返 =================
g = mkG(2010);
const a1 = CB.addFac(g, { x: 50.5, y: 50.5, t: 'bus', pax: 3.5 }).f;
const a2 = CB.addFac(g, { x: 60.5, y: 60.5, t: 'shop' }).f;
const packed = CB.pack(CB.of(g));
assert.equal(packed.cfacs.length, 2, '打包带上两座设施');
const back = CB.restore(JSON.parse(JSON.stringify(packed)));
const b1 = back.cfacs.find(x => x.id === a1.id), b2 = back.cfacs.find(x => x.id === a2.id);
assert.equal(b1.t, 'bus', '读档保留类别');
assert.equal(b1.pax, 3.5, '读档保留接驳客流：' + b1.pax);
assert.equal(b2.pax, 0, '普通设施读档后仍是 0');
// 旧存档（v5.1 之前没有 pax 字段）里的枢纽：按默认值补齐
const legacy = CB.restore({ cfacs: [
  { id: 'cf1', name: '旧汽车站', t: 'bus', x: 10, y: 10, r: 0.6, open: 2000, w: 0.005 },
  { id: 'cf2', name: '旧商圈', t: 'shop', x: 20, y: 20, r: 1, open: 2000, w: 0.005 },
] });
assert.equal(legacy.cfacs[0].pax, CB.HUB_PAX, '旧存档的枢纽按默认接驳客流补齐');
assert.equal(legacy.cfacs[1].pax, 0, '旧存档的普通设施没有接驳客流');

// ================= 8. 缓存签名：改接驳客流必须让设施表重建 =================
g = mkG(2010);
CB.addFac(g, { x: 70.5, y: 70.5, t: 'bus' });
const sig0 = CB.sig();
CB.setFac(g, g.cheat.cfacs[0].id, { pax: 9 });
const sig1 = CB.sig();
assert.notEqual(sig1, sig0, '接驳客流变化要反映到设施表缓存签名：' + sig0 + ' → ' + sig1);

console.log('PASS v5.1 hub facilities: rail/bus symmetric (name & icon only differ), both in the cheat menu, hub demand via Fac.pax (default 2×10k/day), non-hub facilities unchanged, type switch resets pax, save round-trip and legacy fills');
