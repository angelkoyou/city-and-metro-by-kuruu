// v2.9.3 三处铁路枢纽（广州南站 / 广州白云站 / 广州新塘站）的接入回归。
// 玩家反馈：地图上只有普通地铁站标记，看不到广州火车站那样的枢纽站房与客流气泡。
//  · 数据：地标 + 设施成对存在，坐标与启用时点就是任务给定值，配置与广州火车站逐项一致；
//  · 新档：按年份阶梯落成（2010 南站 / 2023 新塘 / 2024 白云），落成后设施即为枢纽；
//  · 旧档：读档时地标状态位缺失（旧版本存档没有这三个 id），必须由读档流程补点亮，
//    不能等到下一次跨月，否则玩家读档后看到的仍是空地；
//  · 地形：中心格落在水面但场地内有陆地时也要启用，避免跨河/临江地标永久点不亮。
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const root = new URL('../', import.meta.url);
const load = src => readFile(new URL(src, root), 'utf8');
const c = {
  console, performance, atob, btoa, TextEncoder, TextDecoder, setTimeout, clearTimeout,
  navigator: { hardwareConcurrency: 4, deviceMemory: 4 },
  matchMedia: () => ({ matches: false }),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  requestAnimationFrame: () => 0,
};
c.window = c;
vm.createContext(c);
const sources = new Map();
const html = await load('index.html');
for (const [, src] of html.matchAll(/<script src="([^"]+)"/g)) {
  const code = await load(src);
  sources.set(src, code);
  vm.runInContext(code, c, { filename: src });
  if (src === 'js/save.js') break;
}
const C = c.CM;
C.UI = function () {};
C.useMap('gz');
C.Geo.init();
const D = C.DATA;

// ── 1. 三处枢纽：地标 + 设施成对，坐标与启用时点就是给定值 ──────────────────
const HUBS = [
  { lm: 'gznz', fac: 'gz_south', name: '广州南站', x: 75.69, y: 155.01, year: 2010, at: [2010, 2] },
  { lm: 'gzbyz', fac: 'gz_baiyun', name: '广州白云站', x: 65.93, y: 65.11, year: 2024, at: [2024, 1] },
  { lm: 'gzxtz', fac: 'gz_xintang', name: '广州新塘站', x: 212.53, y: 90.76, year: 2023, at: [2023, 10] },
];
const ref = D.landmarks.find(l => l.id === 'gzzhan');
assert.ok(ref, '广州火车站地标必须存在，作为配置基准');
const refFac = C.Fac.list().find(f => f.id === 'gz_rail');
assert.ok(refFac, '广州火车站设施必须存在');
const ks = [];
for (const h of HUBS) {
  const k = D.landmarks.findIndex(l => l.id === h.lm), lm = D.landmarks[k];
  ks.push(k);
  assert.ok(k >= 0, '缺少地标 ' + h.lm);
  assert.equal(lm.name, h.name);
  assert.equal(lm.kind, 'rail', h.name + ' 必须与广州火车站同为 rail');
  assert.equal(lm.year, h.year, h.name + ' 落成年份');
  assert.ok(Math.abs(lm.x - h.x) < 1e-6 && Math.abs(lm.y - h.y) < 1e-6, h.name + ' 坐标必须与给定格网一致');
  assert.ok(lm.pin, h.name + ' 坐标由作者给定，要标记 pin 跳过 OSM 同名校正');
  assert.equal(lm.w, ref.w, h.name + ' 站房宽度与广州火车站一致');
  assert.equal(lm.d, ref.d, h.name + ' 站房进深与广州火车站一致');
  const f = C.Fac.list().find(x => x.id === h.fac);
  assert.ok(f, '缺少设施 ' + h.fac);
  assert.equal(f.t, 'rail', h.fac + ' 类型');
  assert.equal(f.lmK, k, h.fac + ' 必须挂在对应地标上');
  assert.ok(Math.abs(f.open - (h.at[0] + (h.at[1] - 1) / 12)) < 1e-6, h.fac + ' 启用时点（' + h.at[0] + '.' + h.at[1] + '）');
  assert.equal(f.T.hub, true, h.fac + ' 必须是枢纽（决定地图标注与气泡）');
  assert.deepEqual(Array.from(f.p), Array.from(refFac.p), h.fac + ' 接驳需求参数与广州火车站一致');
  assert.equal(f.r, refFac.r, h.fac + ' 服务半径与广州火车站一致');
}
console.log('PASS 三处枢纽：地标 + 设施成对，坐标 / 尺寸 / 启用时点 / 枢纽参数与广州火车站一致');

// ── 2. 新档：按年份阶梯落成 ────────────────────────────────────────────────
const city = new C.City();
city.generate(20261112, 2000);
const step = {};
for (const y of [2009, 2010, 2022, 2023, 2024]) {
  city.activateLandmarks(y);
  step[y] = ks.map(k => city.landmarkOn[k]);
}
assert.deepEqual(step[2009], [0, 0, 0], '2009 年三站都还没落成');
assert.deepEqual(step[2010], [1, 0, 0], '2010 年只有广州南站');
assert.deepEqual(step[2022], [1, 0, 0], '2022 年白云站与新塘站仍未落成');
assert.deepEqual(step[2023], [1, 0, 1], '2023 年新塘站落成');
assert.deepEqual(step[2024], [1, 1, 1], '2024 年起三站齐全');
for (const h of HUBS) {
  const f = C.Fac.list(city).find(x => x.id === h.fac);
  assert.equal(C.Fac.active(f, 2025, city), true, h.fac + ' 落成后必须处于启用状态');
  assert.equal(C.Fac.active(f, h.year - 1, city), false, h.fac + ' 落成前不应启用');
}
console.log('PASS 年份阶梯：2010 南站 / 2023 新塘 / 2024 白云，落成即启用');

// ── 3. 旧存档：地标状态位缺失时，读档流程必须补点亮 ──────────────────────────
const full = city.serialize();
const cut = D.landmarks.length - 3;
const old = Object.assign({}, full, {
  landmarkIds: full.landmarkIds.slice(0, cut),
  landmarkOn: full.landmarkOn.slice(0, cut),
});
assert.ok(!old.landmarkIds.includes('gznz'), '模拟的旧存档里不应含有新地标 id');
const oldCity = new C.City();
oldCity.generate(20261112, 2000);
oldCity.restore(old, 2025);
assert.deepEqual(ks.map(k => oldCity.landmarkOn[k]), [0, 0, 0], '只 restore 的话旧存档里三站仍是 0（这就是玩家看到空地的原因）');
for (const h of HUBS) {
  const f = C.Fac.list(oldCity).find(x => x.id === h.fac);
  assert.equal(C.Fac.active(f, 2025, oldCity), false, h.fac + ' 在地标未启用时不应出现枢纽气泡');
}
// 读档流程里补的那一步（见 game.js restoreGen 之后）
oldCity.activateLandmarks(2025 + 5 / 12);
assert.deepEqual(ks.map(k => oldCity.landmarkOn[k]), [1, 1, 1], '读档补点亮后三站都应启用');
for (const h of HUBS) {
  const f = C.Fac.list(oldCity).find(x => x.id === h.fac);
  assert.equal(C.Fac.active(f, 2025, oldCity), true, h.fac + ' 补点亮后必须能出枢纽气泡');
}
const gameSrc = sources.get('js/game.js');
const afterRestore = gameSrc.slice(gameSrc.indexOf('yield* g.city.restoreGen(s.city, g.clock.y)'));
assert.ok(/activateLandmarks\(/.test(afterRestore.slice(0, 600)), 'game.js 读档后要立刻补点地标，不能等下一次跨月');
console.log('PASS 旧存档：restore 后补点亮，三站立即出枢纽，不必等到跨月');

// ── 4. 地形兜底：中心格落水但场地有陆地时仍启用 ──────────────────────────────
const wet = new C.City();
wet.generate(20261112, 2000);
const k0 = ks[0];
const c0 = wet.cellAt(D.landmarks[k0].x, D.landmarks[k0].y);
const cells = wet.landmarkCells(D.landmarks[k0]);
const keep = cells.find(cc => cc !== c0 && wet.landFrac[cc] >= 0.5);
assert.ok(keep !== undefined, '广州南站场地里应有陆地格');
wet.landmarkOn[k0] = 0;
for (const cc of cells) if (cc !== keep) wet.landFrac[cc] = 0.1;   // 除一格陆地外全按水面
wet.landFrac[c0] = 0.1;                                            // 中心格也在水里
assert.ok(wet.activateLandmarks(2010), '中心格落水但场地有陆地时仍应启用');
assert.equal(wet.landmarkOn[k0], 1, '地形兜底：不能因为中心点压在水面就永久点不亮');
console.log('PASS 地形兜底：中心格落水但场地有陆地时照常启用');

console.log('ALL PASS v2.9.3 铁路枢纽接入（数据 / 年份阶梯 / 旧存档补点亮 / 地形兜底）');
