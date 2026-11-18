// v4.3 回归：投标保证金在「无限贷款」下允许透支支付。
// 规则：保证金（铁路＋物业还有地价）从一般资金支付。无限贷款 / 自由建造下与建设、买车一致——
// 资金为负或余额不足都不拦投标；普通模式仍在投标时校验余额，不足即阻断且不扣费。
// 全部在临时 vm 与内存 localStorage 中运行，不读写玩家存档。
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const base = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = path.resolve(base, process.argv.includes('--dist') ? 'dist' : '');
const memory = new Map();
const c = {
  console, performance: globalThis.performance, atob, btoa, TextEncoder, TextDecoder, setTimeout, clearTimeout,
  navigator: { hardwareConcurrency: 4, deviceMemory: 4 }, matchMedia: () => ({ matches: false }),
  localStorage: { getItem: k => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, String(v)), removeItem: k => memory.delete(k) },
};
c.window = c; vm.createContext(c);
const load = async src => vm.runInContext(await readFile(path.join(root, src), 'utf8'), c, { filename: src });
for (const [, src] of (await readFile(path.join(root, 'index.html'), 'utf8')).matchAll(/<script src="([^"]+)"/g)) { await load(src); if (src === 'js/save.js') break; }
const C = c.CM, M = C.Metro;
C.UI = function () { };
for (const name of ['settings', 'corp', 'fleet']) await load('js/' + name + '.js');
const Corp = C.Corp;

// ---------------- 0. 一条确认可用的线网（monthly 的连通判定要用真实车站） ----------------
C.useMap('gz');
const g = C.Game.create({ mode: 'challenge', seed: 20261118 });
const n = M.empty(), lid = M.newLine(n), ids = [];
for (const [x, y] of [[73.26, 93.87], [96.72, 91.34], [120, 95]]) {
  for (let k = 0; k < 40; k++) {
    const px = x + k * 0.3;
    if (M.checkSite(g.city, px, y, 'underground').ok) { ids.push(M.addStation(n, px, y, { size: 'M', type: 'underground' }, g.city)); break; }
  }
}
assert.equal(ids.length, 3, '测试线网应有 3 座车站');
for (let i = 1; i < ids.length; i++) M.addSegment(n, lid, ids[i - 1], ids[i], [], 'underground');
g.edit(n2 => Object.assign(n2, { stations: n.stations, lines: n.lines, segments: n.segments }));
g.econ.funds = 1e10;
assert.equal(g.confirmDraft().ok, true, '测试线网应能建成');
g.model.solveNow(6);
assert.equal(g.model.trafficReady(), true, '交通结果应可评估');

const st = g.compiled.stations;
const ymNow = g.ym();
// 招标由 Corp.terms 生成方案（bond = 估算投资的 2%，铁路＋物业另有 8% 地价）
const mkTender = (id, type, est) => Corp.terms({
  id, type, title: '测试招标 ' + id, est, buildM: 36, opsM: type === 'upgrade' ? 96 : 120,
  expires: ymNow + 6, bid: null, forecast: 0, desc: '',
  anchors: [{ name: st[0].name, x: st[0].x, y: st[0].y, r: 1.2 }, { name: st[1].name, x: st[1].x, y: st[1].y, r: 1.2 }],
  area: { x: st[0].x, y: st[0].y, r: 2 },
});
// 每次都换一个干净的招标与项目状态，避免上一条用例的投标标记影响下一条
const reset = (t, funds, inf) => {
  g.corp = { v: 1, since: ymNow, rating: 60, done: 0, tenders: [t], contracts: [], closed: [], seq: 9, next: ymNow + 9999, cool: {}, ym: ymNow };
  g.econ.setInfLoan(!!inf);
  g.econ.funds = funds;
  return t;
};

// ---------------- 1. 普通模式：余额不足 → 拦截、不扣费、不产生投标 ----------------
{
  const t = reset(mkTender('T1', 'line', 200000), 0, false);
  const bond = t.opts.find(o => o.key === 'std').bond;
  assert.ok(bond > 0, '保证金应大于 0：' + bond);
  g.econ.funds = bond - 1;
  const before = g.econ.funds;
  const r = Corp.bid(g, 'T1', 'std');
  assert.ok(r.error, '普通模式余额不足应报错');
  assert.match(r.error, /一般资金不足以支付履约保证金/, '错误提示保持原文案：' + r.error);
  assert.equal(t.bid, null, '被拦截时不应记下投标');
  assert.equal(g.econ.funds, before, '被拦截时不应扣费');
  // 恰好够（>=）即可投标
  g.econ.funds = bond;
  const r2 = Corp.bid(g, 'T1', 'std');
  assert.equal(r2.ok, true, '余额恰好等于保证金时应可投标：' + JSON.stringify(r2));
  assert.ok(t.bid && t.bid.opt === 'std', '投标应记录方案');
  console.log('PASS 普通模式按保证金校验：差 1 万被拦截且不扣费，恰好够可以投标');
}

// ---------------- 2. 旧存档里没有 land 字段的招标：普通模式仍按保证金校验（NaN 回归） ----------------
{
  const t = reset(mkTender('T2', 'line', 200000), 0, false);
  const std = t.opts.find(o => o.key === 'std');
  assert.equal(std.land, 0, '新招标方案的地价应为 0');
  delete std.land;                      // 旧档：方案没有地价字段
  g.econ.funds = std.bond - 1;
  const r = Corp.bid(g, 'T2', 'std');
  assert.ok(r.error, '旧档招标在余额不足时也应被拦截（此前 NaN 比较会让校验失效）');
  assert.match(r.error, /（\d/, '提示应写出保证金金额，而不是 NaN：' + r.error);
  assert.ok(!/NaN/.test(r.error), '提示里不能出现 NaN：' + r.error);
  g.econ.funds = std.bond;
  assert.equal(Corp.bid(g, 'T2', 'std').ok, true, '余额够时旧档招标可以投标');
  console.log('PASS 旧档招标没有地价字段时不再因 NaN 跳过余额校验');
}

// ---------------- 3. 铁路＋物业：保证金与地价一起校验 ----------------
{
  const t = reset(mkTender('T3', 'tod', 200000), 0, false);
  const o = t.opts.find(x => x.key === 'std');
  assert.ok(o.land > 0, '铁路＋物业应有地价：' + o.land);
  g.econ.funds = o.bond + o.land - 1;
  const r = Corp.bid(g, 'T3', 'std');
  assert.ok(r.error, '只够保证金、不够地价时应被拦截');
  assert.match(r.error, /与地价/, '提示应说明地价：' + r.error);
  assert.ok(r.error.includes(C.U.fmtMoney(o.bond + o.land)), '提示金额应为保证金＋地价（' + C.U.fmtMoney(o.bond + o.land) + '）：' + r.error);
  g.econ.funds = o.bond + o.land;
  assert.equal(Corp.bid(g, 'T3', 'std').ok, true, '保证金与地价都够时可以投标');
  console.log('PASS 铁路＋物业按「保证金＋地价」校验，提示写明合计金额');
}

// ---------------- 4. 无限贷款：负余额也允许投标 ----------------
{
  const t = reset(mkTender('T4', 'line', 200000), 0, true);
  const bond = t.opts.find(o => o.key === 'std').bond;
  assert.equal(g.econ.isInfinite(), true, '无限贷款开关应生效');
  assert.equal(g.econ.isSandbox(), true, '无限贷款应视为沙盒');
  g.econ.funds = -500000;               // 已经严重负余额
  const before = g.econ.funds;
  const r = Corp.bid(g, 'T4', 'std');
  assert.equal(r.ok, true, '无限贷款下负余额也应能投标：' + JSON.stringify(r));
  assert.ok(t.bid && t.bid.opt === 'std', '投标应记录方案');
  assert.equal(g.econ.funds, before, '投标本身不扣款（中标后签约时才付）');
  // 余额为 0 与正常余额同样放行
  g.econ.funds = 0;
  assert.ok(Corp.bid(g, 'T4', 'low').error, '同一招标已投标，不能重复投标');
  const t2 = reset(mkTender('T4b', 'line', 200000), 0, true);
  assert.equal(Corp.bid(g, 'T4b', 'low').ok, true, '无限贷款下余额 0 也能投标');
  // 关掉开关立刻恢复普通模式的校验
  g.econ.setInfLoan(false);
  const t3 = reset(mkTender('T4c', 'line', 200000), -1, false);
  const r3 = Corp.bid(g, 'T4c', 'std');
  assert.ok(r3.error && /一般资金不足以支付履约保证金/.test(r3.error), '关掉无限贷款后应恢复拦截：' + JSON.stringify(r3));
  assert.equal(t3.bid, null, '关掉开关后被拦截的投标不应记录');
  console.log('PASS 无限贷款下负余额/零余额都能投标，关掉开关立刻恢复拦截');
}

// ---------------- 5. 自由建造（资金不限）同样不拦 ----------------
{
  const t = reset(mkTender('T5', 'tod', 200000), -800000, false);
  const oldMode = g.econ.mode;
  g.econ.mode = 'free';
  try {
    assert.equal(g.econ.isFree(), true, '自由建造应视为资金不限');
    const r = Corp.bid(g, 'T5', 'std');
    assert.equal(r.ok, true, '自由建造下负余额也应能投标：' + JSON.stringify(r));
    assert.ok(t.bid, '投标应记录方案');
  } finally { g.econ.mode = oldMode; }
  console.log('PASS 自由建造（资金不限）下投标不受余额限制');
}

// ---------------- 6. 无限贷款不放宽其他规则：履约名额仍是 5 个 ----------------
{
  const t = reset(mkTender('T6', 'line', 200000), -500000, true);
  g.corp.contracts = [{ id: 'C1' }, { id: 'C2' }, { id: 'C3' }, { id: 'C4' }, { id: 'C5' }];
  const r = Corp.bid(g, 'T6', 'std');
  assert.ok(r.error, '名额已满时应拒绝投标');
  assert.match(r.error, /最多 5 个/, '拒绝原因应是履约名额，而不是资金：' + r.error);
  assert.equal(t.bid, null, '名额不足时不应记录投标');
  console.log('PASS 无限贷款不放宽履约名额：已满 5 个时仍拒绝投标');
}

// ---------------- 7. 中标结算：负余额照常扣保证金，合同正常签署 ----------------
// 用扩容改造招标：线网只有 4 节编组，开通条件不成立，合同保持在建设期，便于只看签约时的扣款
{
  const t = reset(mkTender('T7', 'upgrade', 200000), -500000, true);
  t.line = lid; t.cars0 = 4;
  const bond = t.opts.find(o => o.key === 'std').bond;
  const r = Corp.bid(g, 'T7', 'std');
  assert.equal(r.ok, true, '无限贷款下应能投标');
  g.corp.ym = ymNow - 1;   // 月度结算只在新月份执行
  t.bid.ym = ymNow - 1;   // 评标在上个月投标后的下月初公布
  t.bid.p = 1;            // 固定中标，结果与随机数无关
  const before = g.econ.funds;
  Corp.monthly(g);
  assert.equal(g.corp.contracts.length, 1, '中标后应生成履约中的合同');
  const con = g.corp.contracts[0];
  assert.equal(con.status, 'active', '合同应进入履约状态');
  assert.equal(con.phase, 'build', '测试用的扩容合同仍应在建设期（不触发开通收款）');
  assert.ok(Math.abs(con.paid.bond - bond) < 0.01, '合同应记下已付保证金 ' + bond + '，实际 ' + con.paid.bond);
  assert.ok(Math.abs(g.econ.funds - (before - bond)) < 0.01, '保证金应从一般资金扣除（可以变成负数），实际 ' + g.econ.funds);
  assert.ok(g.econ.funds < 0, '扣款后仍是负余额，说明没有把负余额截断：' + g.econ.funds);
  assert.match((g.econ.flow.at(-1) || {}).note || '', /履约保证金/, '流水应记一笔履约保证金');
  console.log('PASS 中标签约时负余额照常扣保证金 ' + Math.round(bond) + ' 万：余额 ' + Math.round(g.econ.funds) + ' 万，合同正常进入履约');
}

// ---------------- 8. canAfford / spend 的底层语义与投标一致 ----------------
{
  g.econ.setInfLoan(true); g.econ.funds = -12345;
  assert.equal(g.econ.canAfford(1e9), true, '无限贷款下任意金额都可支付');
  const before = g.econ.funds;
  g.econ.spend('pppOut', 100);
  assert.ok(Math.abs(g.econ.funds - (before - 100)) < 1e-9, '支出仍照常记账，只是允许负余额');
  g.econ.setInfLoan(false);
  assert.equal(g.econ.canAfford(1e9), false, '普通模式仍按余额判断');
  assert.equal(g.econ.canAfford(0), true, '零费用操作在负余额时也允许');
  console.log('PASS canAfford 与 spend 语义：无限贷款放行、普通模式按余额、零费用不拦');
}

console.log('ALL PASS v4.3 无限贷款下的投标保证金');
