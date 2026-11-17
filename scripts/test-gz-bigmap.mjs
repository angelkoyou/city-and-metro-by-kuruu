// 广州 gz 槽位第 4 版：60 × 48 km 大图替换回归（原 test-gz-foshan.mjs 的广佛扩展已停用）。
//  · 来源一致：gz 槽位仍是原来的 CM.GEOS.gz / CM.GEO / CM.DATA 引用，数据换成 240×192 / 60×48 km 大图；
//  · 配置隔离：只改 gz 自己的 cfg，其他地图与 config.js 基线保持原值；
//  · 扩展停用：geo_gz_fs.js 遇到 gzBig 直接跳过，主/后台线程仍加载同一组脚本；
//  · 数据完整：地理要素数量、投影、片区/地标/锚点边界、开局简报与城市经济口径；
//  · 存档兼容：第 1–3 版旧存档明确拒绝，第 4 版只按 240×192 解析；
//  · 界面：新增中文文案在英文词典里有整句译文。
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
};
c.window = c;
vm.createContext(c);
const sources = new Map();
const html = await load('index.html');
for (const [, src] of html.matchAll(/<script src="([^"]+)"/g)) {
  sources.set(src, await load(src));
  vm.runInContext(sources.get(src), c, { filename: src });
  if (src === 'js/save.js') break;
}
// 渲染与后台线程脚本在 save.js 之后，不参与上面的数据加载，单独读取文本做一致性检查
for (const src of ['js/render.js', 'js/tile-worker.js']) sources.set(src, await load(src));
const C = c.CM, U = C.U;
C.UI = function () {};
const m = C.MAPS.gz, G = C.GEO, D = C.DATA;
const W = 240, H = 192;

// ── 1. 运行时配置与地图登记 ───────────────────────────────────────────────
// 首次 useMap('gz') 会短路，所以必须在 maps.js 里把 gz 的 cfg 写进运行时 CFG
assert.equal(C.CFG.W, W); assert.equal(C.CFG.H, H);
assert.deepEqual(JSON.parse(JSON.stringify(C.CFG.START)), { y: 2000, m: 1, d: 1, minute: 360 });
assert.equal(C.CFG.ZONE, 6);
assert.deepEqual(Array.from(C.CFG.growth.popCurve[0]), [2000, 6.0e6]);
assert.equal(C.CFG.growth.histEnd, 2020);
assert.equal(C.CFG.macro.gdp0, 19000000);
assert.equal(G, m.geo, 'gz 槽位仍指向同一个 CM.GEO 对象');
assert.equal(G.gzBig, true, '大图标记：广佛扩展脚本据此停用');
assert.equal(m.id, 'gz'); assert.equal(m.mapVersion, 4); assert.equal(m.minVersion, 4);
assert.equal(m.scenario, 'gz-2000');
assert.equal(m.extent, undefined, '大图无坐标平移迁移规格');
assert.equal(m.migrate, undefined, '旧存档不做几何迁移');
assert.equal(m.cfg.W, W); assert.equal(m.cfg.H, H);
assert.equal(m.cfg.ZONE, 6);
assert.equal(m.cfg.START.y, 2000);
assert.equal(m.cfg.macro, C.CFG.macro, '城市经济口径随 gz 配置一起切换');
assert.deepEqual(JSON.parse(JSON.stringify(m.cam)), { cx: 79, cy: 96, zoom: 17 });
assert.deepEqual(JSON.parse(JSON.stringify(G.proj)), { lon0: 113.08, lat0: 23.34, kx: 409.6, ky: 443 });
C.useMap('gz');   // 短路返回后配置必须仍是大图口径
assert.equal(C.CFG.W, W); assert.equal(C.CFG.H, H); assert.equal(C.CFG.START.y, 2000);
console.log('PASS 运行时配置与登记：240×192 / 2000 年起 / 第 4 版 / proj 113.08,23.34');

// ── 2. 地理数据就是 60×48 km 大图 ────────────────────────────────────────
const counts = { water: 6945, roads: 72873, rail: 5837, parks: 1303, reserves: 5, woods: 1669, admin: 189, places: 2884, names: 8114 };
for (const [k, n] of Object.entries(counts)) assert.equal((G[k] || []).length, n, '大图 ' + k + ' 要素数量');
assert.equal(G.streets.split('!').length, 26602, '大图街巷数量');
const geoSrc = sources.get('js/geo_gz.js');
assert.match(geoSrc, /240×192 格 \/ 60 × 48 km/, 'geo_gz.js 头部说明大图规格');
assert.match(geoSrc, /CM\.GEO = \(CM\.GEOS = CM\.GEOS \|\| \{\}\)\.gz = /, '仍注册到 gz 槽位，引用兼容');
assert.match(geoSrc, /CM\.GEO\.gzBig = true/, '写入大图标记');
const Geo = C.Geo.init();
assert.equal(Geo.src, G);
assert.equal(Geo.roads.length, counts.roads);
assert.equal(Geo.streets.length, 26602);
assert.equal(Geo.places.length, counts.places);
for (const r of Geo.roads) {
  for (let i = 0; i < r.p.length; i++) {
    const v = r.p[i];
    assert.ok(Number.isFinite(v) && v >= -8 && v <= (i % 2 ? H + 8 : W + 8), '解码后的道路坐标落在大图范围内');
  }
}
console.log('PASS 地理数据：OSM 要素数量、投影、gzBig 标记与 Geo.init 解码边界');

// ── 3. 佛山西扩只作用于 gz1990，大图不受影响 ───────────────────────────────
assert.ok(C.GEO_FS && C.GEO_FS.map === 'gz1990', '扩展脚本只作用于 gz1990');
assert.equal(C.GEO_FS.dx, 48, '西扩 48 格元数据保留');
assert.equal(C.GEO.roads.length, 72873, '大图道路未被追加佛山近似数据');
assert.equal(C.GEO.water.length, 6945, '大图水系未被平移或改写');
const fsSrc = sources.get('js/geo_gz_fs.js');
assert.match(fsSrc, /CM\.GEOS\.gz1990/, '扩展脚本优先取 gz1990');
assert.match(fsSrc, /if \(!G \|\| G\.foshanExtended \|\| G\.gzBig\) return;/, '扩展脚本在大图下直接返回');
assert.ok(html.includes('<script src="js/geo_gz.js"></script>'), '入口仍加载 geo_gz.js');
assert.ok(html.includes('<script src="js/geo_gz1990.js"></script>'), '入口加载 gz1990 地理数据');
assert.ok(html.includes('<script src="js/data_gz1990.js"></script>'), '入口加载 gz1990 场景数据');
assert.ok(html.indexOf('js/geo_gz1990.js') < html.indexOf('js/geo_gz_fs.js'), 'gz1990 在扩展脚本之前加载');
const renderSrc = sources.get('js/render.js'), workerSrc = sources.get('js/tile-worker.js');
assert.match(renderSrc, /const GEO_EXT = \{[^}]*gz1990: 'geo_gz_fs\.js'/, '主线程把扩展脚本传给 gz1990 的后台线程');
assert.match(workerSrc, /if \(m\.geoExt\) importScripts\(m\.geoExt\)/, '后台线程加载同一个扩展脚本');
assert.match(renderSrc, /CM\.GEO_FS\.map === CM\.mapId/, '西扩遮罩减淡按地图判断');
console.log('PASS 扩展归属：佛山西扩只作用于 gz1990，大图坐标与要素不受影响');

// ── 4. 其他城市地图与配置完全不动 ─────────────────────────────────────────
const others = {
  tutorial: [48, 40, 2000, 1], hz: [188, 136, 2000, 4], hk: [176, 120, 1970, 3],
  tk: [140, 132, 1950, 3], tp: [136, 120, 1990, 2], pa: [152, 148, 1900, 3],
  wh: [152, 156, 2000, 4], sh: [152, 152, 1990, 2], bj: [204, 156, 1990, 1],
};
for (const [id, spec] of Object.entries(others)) {
  const x = C.MAPS[id];
  assert.ok(x, '地图 ' + id + ' 仍在');
  assert.deepEqual([x.cfg.W, x.cfg.H, x.cfg.START.y, x.mapVersion], spec, '地图 ' + id + ' 参数未变');
  assert.ok(x.geo && x.geo !== G, '地图 ' + id + ' 仍用自己的地理数据');
}
assert.equal(C.CFG.CELL_M, 250);
assert.match(C.CFG.GAME_VERSION, /^\d+\.\d+/);   // 只校验格式：版本号随公告递增，不再写死
console.log('PASS 隔离性：9 张其他地图的格网、起始年份、版本与地理数据均未改动');

// ── 5. 场景数据完整性与坐标边界 ───────────────────────────────────────────
assert.equal(D.city, '广州');
assert.equal(D.regions.length, 31, '大图 31 个片区');
assert.equal(D.landmarks.length, 36, '大图 36 处地标（33 处 + 南站 / 白云站 / 新塘站三处铁路枢纽）');
assert.equal(D.defaultRegion.open, 2000, '外围片区 2000 年开放');
assert.equal((D.eras || []).length, 5, '当前项目的发展阶段区块保留');
assert.equal((D.scenarios || []).length, 2, '当前项目的可选挑战区块保留');
assert.match(D.briefing.lead, /^2000 年的广州/, '开局简报按大图 2000 年口径');
assert.ok(!D.dataNote.some(r => /近似地理/.test(r[0])), '不再出现广佛近似地理说明');
assert.equal(D.places.length, G.places.length, '车站命名用地名表与大图一致');
assert.equal(D.airport.buildable, 'underground');
assert.equal(D.airport.runway.length, 2, '旧白云机场跑道按大图投影换算');
const dataSrc = sources.get('js/data_gz.js');
assert.equal((dataSrc.match(/^    briefing: \{/gm) || []).length, 1, 'briefing 只声明一次');
assert.equal((dataSrc.match(/^    dataNote: \[/gm) || []).length, 1, 'dataNote 只声明一次');
assert.equal((dataSrc.match(/^    taskNote: /gm) || []).length, 1, 'taskNote 只声明一次');
const inBounds = (x, y, tag) => assert.ok(Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= W && y >= 0 && y <= H, tag + ' 坐标越界：' + x + ',' + y);
for (const lm of D.landmarks) inBounds(lm.x, lm.y, '地标 ' + lm.id);
for (const f of D.facilities) if (f.at) inBounds(f.at[0], f.at[1], '设施 ' + f.id);
for (const t of D.histTasks || []) for (const a of t.anchors || []) inBounds(a.x, a.y, '任务 ' + t.id);
for (const e of D.eras || []) for (const goal of e.goals || []) for (const a of goal.anchors || []) inBounds(a.x, a.y, '阶段目标 ' + goal.id);
console.log('PASS 场景数据：31 片区 / 36 地标 / 简报与数据说明按大图口径，锚点全在图内');

// ── 5b. v2.9.3 三处新建铁路枢纽：与广州火车站同类型、同配置 ──────────────────
{
  const ref = D.landmarks.find(l => l.id === 'gzzhan'), refF = D.facilities.find(f => f.id === 'gz_rail');
  assert.ok(ref && refF, '广州火车站的地标与设施仍在');
  // 坐标按需求给定，且载入时的 OSM 同名地点校正不搬动它们（pin）
  const spec = [
    { id: 'gznz', fid: 'gz_south', name: '广州南站', x: 75.69, y: 155.01, year: 2010, open: 2010 + 1 / 12 },
    { id: 'gzbyz', fid: 'gz_baiyun', name: '广州白云站', x: 65.93, y: 65.11, year: 2024, open: 2024 },
    { id: 'gzxtz', fid: 'gz_xintang', name: '广州新塘站', x: 212.53, y: 90.76, year: 2023, open: 2023 + 9 / 12 },
  ];
  for (const s of spec) {
    const lm = D.landmarks.find(l => l.id === s.id), f = D.facilities.find(x => x.id === s.fid);
    assert.ok(lm, '缺少地标 ' + s.id);
    assert.equal(lm.kind, ref.kind, s.name + ' 与广州火车站同类型');
    assert.deepEqual([lm.x, lm.y], [s.x, s.y], s.name + ' 坐标按需求给定（未被 OSM 校正搬动）');
    assert.deepEqual([lm.w, lm.d, lm.rot], [ref.w, ref.d, ref.rot], s.name + ' 站房尺寸与朝向同广州火车站');
    assert.equal(lm.year, s.year, s.name + ' 落成年份');
    assert.ok(f, '缺少设施 ' + s.fid);
    assert.equal(f.t, refF.t, s.name + ' 设施类型同为铁路客运站');
    assert.equal(f.lm, s.id, s.name + ' 设施引用自己的站房地标');
    assert.deepEqual(f.pax, refF.pax, s.name + ' 接驳客流曲线与广州火车站一致');
    assert.equal(f.ext, undefined, s.name + ' 不是地图外接驳点');
  }
  // 解析后的启用时点：南站 2010.2、白云站 2024.1、新塘站 2023.10；四项铁路枢纽的客流在同一口径下相同
  const Fac = C.Fac, list = Fac.list();
  for (const s of spec) {
    const f = list.find(x => x.id === s.fid);
    assert.ok(f, '设施表里没有 ' + s.fid);
    assert.ok(Math.abs(f.open - s.open) < 1e-6, s.name + ' 启用时点为 ' + f.open + '，应为 ' + s.open);
    assert.equal(f.close, null, s.name + ' 不设停用年份');
    assert.equal(Math.round(Fac.pax(f, 2026) / 1e4 * 1e6) / 1e6, Math.round(Fac.pax(list.find(x => x.id === 'gz_rail'), 2026) / 1e4 * 1e6) / 1e6, s.name + ' 客流与广州火车站一致');
  }
  console.log('PASS 三处新建铁路枢纽：南站 2010.2 / 白云站 2024.1 / 新塘站 2023.10，类型与配置同广州火车站');
}

// ── 6. 存档版本兼容 ───────────────────────────────────────────────────────
const envelope = (mv, city) => {
  const payload = { meta: { map: 'gz', mapVersion: mv }, clock: { y: 2000, m: 1, d: 1 }, city: city || {}, net: {}, econ: {}, tasks: {} };
  const body = JSON.stringify(payload);
  return JSON.stringify({ format: C.CFG.SAVE_FORMAT, version: 2, body, checksum: U.fnv(body) });
};
// 第 1–3 版广州存档不再拒绝：它们归位到 gz1990（原 168×144 广佛图），第 1、2 版按 extent 两步迁移到第 3 版。
const typedCity = (w, h) => Object.fromEntries(['pop', 'jobs', 'bh', 'taken', 'lu', 'street', 'urbanYear'].map(k => [k, U.packTyped(new Float32Array(w * h), 'f32')]));
const legacyEnvelope = (mv, w, h) => {
  const payload = {
    meta: { map: 'gz', mapVersion: mv }, clock: { y: 1990, m: 1, d: 1 },
    city: typedCity(w, h), net: { stations: {}, lines: {}, segments: {}, nextId: 1 },
    econ: { mode: 'free', funds: 1000 }, tasks: { active: [], done: [], failed: [], cool: {} }, macro: {},
  };
  const body = JSON.stringify(payload);
  return JSON.stringify({ format: C.CFG.SAVE_FORMAT, version: 2, body, checksum: U.fnv(body) });
};
for (const [mv, w, h] of [[1, 120, 96], [2, 120, 144], [3, 168, 144]]) {
  const parsed = C.Save.parseEnvelope(legacyEnvelope(mv, w, h)).payload;
  assert.equal(parsed.meta.map, 'gz1990', '第 ' + mv + ' 版广州存档归位到 gz1990');
  assert.equal(parsed.meta.mapVersion, 3, '第 ' + mv + ' 版迁移到第 3 版');
  assert.equal(parsed.city.pop.n, 168 * 144, '第 ' + mv + ' 版按 168×144 重建城市数据');
}
assert.throws(() => C.Save.parseEnvelope(envelope(5)), /暂不兼容/, '未来版本存档应明确拒绝');
const fullCity = () => Object.fromEntries(['pop', 'jobs', 'bh', 'taken', 'lu', 'street', 'urbanYear'].map(k => [k, U.packTyped(new Float32Array(W * H), 'f32')]));
assert.throws(() => C.Save.parseEnvelope(envelope(4, {})), /城市数据不完整或尺寸不符/, '第 4 版也按 240×192 校验');
assert.doesNotThrow(() => C.Save.parseEnvelope(envelope(4, fullCity())), '第 4 版存档按新格网通过校验');
const keep4 = C.Save.parseEnvelope(envelope(4, fullCity())).payload;
assert.equal(keep4.meta.map, 'gz', '第 4 版存档仍留在大图');
console.log('PASS 存档兼容：v1–v3 归位 gz1990 并迁移到第 3 版、v4 留在大图、v5 拒绝');

// ── 7. 建局与读档往返 ─────────────────────────────────────────────────────
const g = C.Game.create({ mode: 'free', unlockAll: true });
assert.equal(g.city.W, W); assert.equal(g.city.H, H);
assert.equal(g.clock.y, 2000);
assert.equal(g.city.regions.length, D.regions.length + 1, '31 个片区 + 1 个默认外围片区');
const snap = JSON.parse(JSON.stringify(g.serialize()));
assert.equal(snap.meta.mapVersion, 4);
assert.equal(snap.meta.map, 'gz');
const g2 = C.Game.restore(snap);
assert.equal(g2.city.W, W); assert.equal(g2.city.H, H);
assert.equal(g2.city.regions.length, D.regions.length + 1);
console.log('PASS 建局与读档：240×192 格网、31 片区与第 4 版标记完整恢复');

// ── 8. 英文界面词条 ───────────────────────────────────────────────────────
const uiStrings = new Set();
const put = v => { if (typeof v === 'string' && /[一-龥]/.test(v)) uiStrings.add(v); };
put(m.title); put(m.sub); put(m.desc); put(m.tagline); put(m.intro);
for (const t of m.tags) put(t);
for (const f of m.facts) for (const x of f) put(x);
for (const f of m.features) for (const x of f) put(x);
for (const h of m.highlights) put(h[1]);
put(D.briefing.lead); for (const row of D.briefing.modes) for (const x of row) put(x);
for (const d of D.dataNote) { put(d[0]); put(d[2]); }
put(C.CFG.macro.area);
for (const r of D.regions) { put(r.name); put(r.note); }
const expected = [
  m.title, m.sub, m.desc, m.tagline, m.intro,
  ...m.tags, ...m.facts.flat(), ...m.features.flat(), ...m.highlights.map(h => h[1]),
  D.briefing.lead, ...D.briefing.modes.flatMap(r => r.slice(1)),
  C.CFG.macro.area,
  '番禺中（市桥·沙头）', '黄埔东（南岗·穗东）', '白云北（太和·龙归·大源）', '增城西（永宁）',
  '2014 年增城撤市设区，此前为县级市（史实）',
].filter(s => typeof s === 'string' && /[一-龥]/.test(s));
for (const s of expected) {
  assert.ok(uiStrings.has(s), '英文词条清单与当前数据同步：' + s.slice(0, 20));
  assert.ok(C.I18N_EN[s] !== undefined, '英文词条齐备：' + s.slice(0, 32));
}
console.log('PASS 英文界面：' + expected.length + ' 条大图新增/改动文案均有整句译文');

// ── 9. gz1990 经典图：承载第 1–3 版广州存档 ───────────────────────────────
const M0 = C.MAPS.gz1990;
assert.ok(M0, 'gz1990 已登记');
assert.equal(M0.id, 'gz1990');
assert.deepEqual([M0.cfg.W, M0.cfg.H, M0.cfg.ZONE], [168, 144, 4], '经典图保持 168×144 / 交通小区 4 格');
assert.equal(M0.cfg.START.y, 1990, '经典图 1990 年开局');
assert.equal(M0.cfg.ZONE, 4, '交通小区边长与旧存档的小区编号一致');
assert.equal(M0.mapVersion, 3, '经典图停在第 3 版');
assert.equal(M0.minVersion, undefined, '不设最低版本：第 1–3 版存档都能进');
assert.equal(M0.geo, C.GEOS.gz1990, 'geo 指向独立槽位，不占 CM.GEO');
assert.notEqual(M0.geo, C.MAPS.gz.geo, '与大图是两份地理数据');
assert.equal(M0.data, C.MAPS.gz1990.data, 'data 指向经典图场景数据');
assert.equal(M0.cfg.macro.gdp0, 2620000, '城市经济按 1990 年口径，未被大图 macro 覆盖');

const G0 = M0.geo, D0 = M0.data;
assert.ok(G0.foshanExtended, '佛山要素已就地补齐');
assert.ok(Math.abs(G0.proj.lon0 - 113.0828125) < 1e-9, '西扩后投影原点回到第 3 版位置');
assert.equal(D0.regions.length, 33, '27 个基础片区 + 6 个佛山片区');
assert.equal(D0.regions.filter(r => /^fs_/.test(r.id)).map(r => r.id).join(','), 'fs_north,fs_dali,fs_chancheng,fs_shunde,fs_link,fs_ext', '6 个佛山片区按 2010 年开放');
assert.ok(D0.regions.filter(r => /^fs_/.test(r.id)).every(r => r.open === 2010), '佛山片区统一 2010 年');
assert.equal(D0.landmarks.length, 34, '34 处地标（含广州南站 gznz）');
assert.ok(D0.landmarks.some(l => l.id === 'gznz'), '大图没有的广州南站仍在本图');
assert.ok(C.GEO_FS && C.GEO_FS.map === 'gz1990' && C.GEO_FS.dx === 48, '西扩元数据只属于本图');
assert.ok(G0.streets.split('!').length > 15000, '佛山街巷已并入常显底图');

// 本图能独立建局、读档往返，且不把大图配置带进来
C.useMap('gz1990');
assert.equal(C.CFG.W, 168); assert.equal(C.CFG.H, 144); assert.equal(C.CFG.ZONE, 4);
const g0 = C.Game.create({ mode: 'free', unlockAll: true });
assert.equal(g0.clock.y, 1990, '经典图 1990 年开局');
assert.deepEqual([g0.city.W, g0.city.H], [168, 144]);
assert.equal(g0.city.regions.length, 34, '33 个片区 + 1 个默认外围片区');
const back0 = C.Game.restore(JSON.parse(JSON.stringify(g0.serialize())));
assert.deepEqual([back0.city.W, back0.city.H], [168, 144], '经典图存档按 168×144 恢复');
assert.equal(back0.clock.y, 1990);
C.useMap('gz');
assert.equal(C.CFG.W, 240, '切回大图后配置复原');
assert.equal(C.CFG.START.y, 2000);
console.log('PASS gz1990 经典图：168×144 / 1990 年 / 33 片区 / 独立建局与读档，与大图互不干扰');

console.log('test-gz-bigmap: all assertions passed');
