// 新建线路「选择番号」回归：按城市生成可选项、排除已占用番号、番号→本市实际配色、
// 非法/重复番号回退、现行番号用完时的扩展番号、以及既有线路/开局数据不受影响
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
await load('js/tools.js');   // 只用到原型上的纯函数，不实例化（不触碰画布）
const C = c.CM, M = C.Metro;

// ---------- 每座城市：可选项 = 1..本城配色表长度，颜色逐项对应 ----------
for (const id of C.MAP_ORDER) {
  C.useMap(id);
  const cols = C.DATA.lineColorsNice;
  assert.ok(cols.length >= 10, id + ' 有本市线路配色表');
  const opts = M.lineNoOptions(M.empty(), C.DATA);
  assert.equal(opts.length, cols.length, id + ' 可选项数量等于本市配色表长度');
  opts.forEach(function (o, i) {
    assert.equal(o.num, i + 1, id + ' 番号按顺序');
    assert.equal(o.name, (i + 1) + ' 号线', id + ' 名称使用所选番号');
    assert.equal(o.color, cols[i], id + ' 颜色使用该市该号线的实际配色');
    assert.equal(o.standard, true);
  });
  assert.equal(M.lineNoColor(1, C.DATA), cols[0]);
  assert.equal(M.lineNoColor(cols.length + 1, C.DATA), cols[0], id + ' 超出表长时循环取色');
}

// ---------- 选中番号后：编号、名称、颜色一次确定；已有线路不受影响 ----------
C.useMap('gz');
const cols = C.DATA.lineColorsNice, net = M.empty();
const l1 = M.newLine(net);
assert.equal(net.lines[l1].num, 1);
assert.equal(net.lines[l1].name, '1 号线');
assert.equal(net.lines[l1].color, cols[0], '不传番号时仍是原来的自动编号行为');
let opts = M.lineNoOptions(net, C.DATA);
assert.equal(opts.length, cols.length - 1);
assert.ok(!opts.some(o => o.num === 1), '已存在的 1 号线被排除');
const l5 = M.newLine(net, null, { num: 5 });
assert.equal(net.lines[l5].num, 5, '线路编号使用所选番号');
assert.equal(net.lines[l5].name, '5 号线', '线路名称使用所选番号');
assert.equal(net.lines[l5].color, cols[4], '自动应用广州 5 号线的实际颜色');
assert.equal(net.lines[l1].color, cols[0], '已有线路颜色不受影响');
assert.equal(net.lines[l1].name, '1 号线', '已有线路名称不受影响');
opts = M.lineNoOptions(net, C.DATA);
assert.ok(!opts.some(o => o.num === 5), '新建后 5 号线也被排除');
assert.equal(opts[0].num, 2, '剩余可选番号从最小空号开始');
assert.equal(M.lineNoAvailable(net, 5), false);
assert.equal(M.lineNoAvailable(net, 3), true);

// ---------- 非法 / 重复番号：回退到最小空号，不产生重号 ----------
for (const bad of [0, -2, 1.5, NaN, 'abc', 1, 5]) {
  const before = Object.keys(net.lines).length;
  const id = M.newLine(net, null, { num: bad });
  assert.equal(Object.keys(net.lines).length, before + 1);
  const L = net.lines[id];
  assert.ok(Number.isInteger(L.num) && L.num >= 1, '回退后仍是合法正整数：' + String(bad));
  assert.equal(L.name, L.num + ' 号线');
  assert.equal(L.color, M.lineNoColor(L.num, C.DATA));
  const nums = Object.values(net.lines).map(x => x.num);
  assert.equal(new Set(nums).size, nums.length, '线网中不存在重复番号：' + String(bad));
}

// ---------- 现行番号全部用完：给出扩展番号，颜色循环 ----------
const full = M.empty();
for (let n = 1; n <= cols.length; n++) M.newLine(full, null, { num: n });
assert.equal(M.lineNoOptions(full, C.DATA).length, 0, '无可选番号时返回空列表');
const fb = M.lineNoFallback(full, C.DATA);
assert.equal(fb.num, cols.length + 1);
assert.equal(fb.standard, false);
assert.equal(fb.color, cols[0], '扩展番号按本市配色循环');
assert.equal(fb.name, (cols.length + 1) + ' 号线');
const ext = M.newLine(full, null, { num: fb.num });
assert.equal(full.lines[ext].num, cols.length + 1);
assert.equal(full.lines[ext].color, cols[0]);
assert.equal(M.lineNoFallback(full, C.DATA).num, cols.length + 2, '扩展番号被占用后顺延');

// ---------- 内部调用（支线/拆分/开局接管）保持原行为：自定义名称 + 自动空号 ----------
const legacy = M.empty();
const a = M.newLine(legacy, '机场快线');
assert.equal(legacy.lines[a].num, 1);
assert.equal(legacy.lines[a].name, '机场快线');
const b = M.newLine(legacy, '2 号线支线');
assert.equal(legacy.lines[b].num, 2);
assert.equal(legacy.lines[b].name, '2 号线支线');
assert.equal(legacy.lines[b].color, cols[1]);

// ---------- 工具预览：默认番号/配色与可选项一致 ----------
C.game = { net: M.empty(), draft: null, netVersion: 0 };
const t = Object.create(C.Tools.prototype);
t.game = function () { return C.game; };
assert.equal(t.newLineNo(), 1);
assert.equal(t.lineName('new'), '新建线路（选番号）');
assert.equal(t.nextLineColor(true), cols[0], '预览色与默认番号的本市配色一致');
M.newLine(C.game.net, null, { num: 1 });
M.newLine(C.game.net, null, { num: 2 });
assert.equal(t.newLineNo(), 3, '已占用番号自动排除');
assert.equal(t.nextLineColor(true), cols[2], '预览色随默认番号更新');
for (let n = 3; n <= cols.length; n++) M.newLine(C.game.net, null, { num: n });
assert.equal(t.newLineNo(), cols.length + 1, '现行番号用完时预览回落到扩展番号');

// ---------- 开局接管的真实线路仍占号，颜色数据保持原样 ----------
C.useMap('bj');
const IN = C.DATA.initialNetwork;
assert.ok(IN && IN.lines.length >= 2, '北京开局仍有 1 号线与环线');
assert.equal(IN.lines[0].name, '1 号线');
assert.equal(IN.lines[0].color, C.DATA.lineColorsNice[0], '开局线路颜色数据未被改写');
const bjNet = M.empty();
for (const L of IN.lines) {
  const id = M.newLine(bjNet);
  if (L.color) bjNet.lines[id].color = L.color;
  if (L.name) bjNet.lines[id].name = L.name;
}
const bjOpts = M.lineNoOptions(bjNet, C.DATA);
assert.ok(!bjOpts.some(o => o.num === 1 || o.num === 2), '开局接管线路占用 1、2 号，不会重复出现');
assert.equal(bjOpts[0].num, 3);
assert.equal(bjOpts[0].color, C.DATA.lineColorsNice[2]);

// ---------- 自定义名称 / 颜色 / 番号 ----------
C.useMap('gz');
const custom = M.empty();
const c1 = M.newLine(custom, '  机场快线  ', { num: 7, color: '#12ABcd' });
assert.equal(custom.lines[c1].num, 7, '自定义番号（表内空号）生效');
assert.equal(custom.lines[c1].name, '机场快线', '自定义名称去掉首尾空格');
assert.equal(custom.lines[c1].color, '#12abcd', '自定义颜色统一为小写 hex');
const c2 = M.newLine(custom, '', { num: 50, color: '#ff00ff' });
assert.equal(custom.lines[c2].num, 50, '自定义番号可超出本市现行配色表范围');
assert.equal(custom.lines[c2].name, '50 号线', '名称留空时按番号自动命名');
assert.equal(custom.lines[c2].color, '#ff00ff', '表外番号也能使用自定义颜色');
const c3 = M.newLine(custom, '   ', { num: 51, color: 'rgb(1,2,3)' });
assert.equal(custom.lines[c3].name, '51 号线', '纯空格名称回落到自动命名');
assert.equal(custom.lines[c3].color, M.lineNoColor(51, C.DATA), '非法颜色回落到本市配色循环');
const c4 = M.newLine(custom, '测试支线'.repeat(10), { num: 52 });
assert.equal(custom.lines[c4].name.length, 32, '超长自定义名称被裁剪，避免撑破界面');
assert.equal(M.safeLineColor('#AABBCC', 1, C.DATA), '#aabbcc');
assert.equal(M.safeLineColor(null, 1, C.DATA), cols[0]);
assert.equal(M.safeLineColor('#fff', 1, C.DATA), cols[0], '三位简写不接受，回落到本市配色');
assert.ok(!M.lineNoOptions(custom, C.DATA).some(o => o.num === 7), '自定义番号同样从可选列表中排除');
assert.equal(M.lineNoAvailable(custom, 50), false, '自定义番号被占用后不能再选');

// ---------- v3.9：既有线路改番号 / 自定义名称 / 无番号线路 ----------
C.useMap('gz');
const ren = M.empty();
const r1 = M.newLine(ren, null, { num: 3 });
assert.equal(ren.lines[r1].name, '3 号线');
let rr = M.setLineNo(ren, r1, 8);
assert.equal(rr.ok, true);
assert.equal(ren.lines[r1].num, 8, '既有线路可以改号');
assert.equal(ren.lines[r1].name, '8 号线', '自动名称随番号更新');
assert.equal(M.lineNoTaken(ren, 8, r1), false, '改号时不会把自己算成占用');
assert.equal(M.lineNoAvailable(ren, 3), true, '旧番号被释放');

const r2 = M.newLine(ren, '机场快线', { num: 4 });
rr = M.setLineNo(ren, r2, 8);
assert.ok(rr.error, '改成已被占用的番号会被拒绝');
assert.equal(ren.lines[r2].num, 4, '校验失败时不留下半改状态');
assert.equal(ren.lines[r2].name, '机场快线', '校验失败时名称也不变');
for (const bad of [0, -1, 1.5, 1000, 'abc']) {
  assert.ok(M.setLineNo(ren, r2, bad).error, '非法番号被拒绝：' + String(bad));
  assert.equal(ren.lines[r2].num, 4);
}
rr = M.setLineNo(ren, r2, 5, '');
assert.equal(rr.ok, true);
assert.equal(ren.lines[r2].name, '5 号线', '名称留空时恢复按番号自动命名');
rr = M.setLineNo(ren, r2, null, '');
assert.ok(rr.error, '不使用番号时必须填写名称');
rr = M.setLineNo(ren, r2, null, '机场快线');
assert.equal(rr.ok, true);
assert.equal(ren.lines[r2].num, null, '线路可以完全不使用番号');
assert.equal(ren.lines[r2].name, '机场快线', '无番号线路直接显示自定义名称');
assert.equal(M.lineNoUsed(ren).has(4), false, '无番号线路不占用番号');
assert.equal(M.lineNoAvailable(ren, 4), true, '释放的番号可以再次选择');
assert.equal(M.lineNameAuto(ren.lines[r2]), false);
assert.equal(M.lineDisplayName(ren.lines[r2]), '机场快线');
rr = M.setLineNo(ren, r2, 6);
assert.equal(ren.lines[r2].num, 6, '无番号线路可以重新指定番号');
assert.equal(ren.lines[r2].name, '机场快线', '自定义名称在改号后保持不变');

// 新建时直接选择「不使用番号」
const no = M.newLine(ren, '博物馆线', { noNum: true });
assert.equal(ren.lines[no].num, null);
assert.equal(ren.lines[no].name, '博物馆线');
assert.equal(ren.lines[no].color, '#607d8b', '无番号线路默认中性配色，不借用 1 号线颜色');
const no2 = M.newLine(ren, null, { noNum: true });
assert.equal(ren.lines[no2].num, null);
assert.equal(ren.lines[no2].name, '新线路', '无番号又没填名称时给占位名');
assert.equal(M.lineNoUsed(ren).size, 2, '只有使用番号的线路占用号');
assert.equal(M.lineNoOptions(ren, C.DATA).length, cols.length - 2, '无番号线路不影响可选番号数量');

// 旧存档兼容：只有 num + 名称、没有额外标记的线路照常工作
const legacyLine = { id: 'l9', num: 2, name: '2 号线', color: '#123456' };
assert.equal(M.lineNameAuto(legacyLine), true, '旧存档的默认名称按自动名处理');
assert.equal(M.lineDisplayName(legacyLine), '2 号线');
const legacyCustom = { id: 'l9', num: 2, name: '环线', color: '#123456' };
assert.equal(M.lineNameAuto(legacyCustom), false, '旧存档里的自定义名称保持不动');
// 存档往返：num / name 是线网对象的一部分，直接 JSON 往返即可保持
const back = JSON.parse(JSON.stringify(ren));
assert.equal(back.lines[r1].num, 8);
assert.equal(back.lines[r2].name, '机场快线');
assert.equal(back.lines[no].num, null);

console.log('PASS test-line-number: ' + C.MAP_ORDER.length + ' 座城市的番号/配色、自定义名称/颜色/番号与边界行为');
console.log('PASS test-line-number: 既有线路改号、无番号命名、旧存档兼容');
