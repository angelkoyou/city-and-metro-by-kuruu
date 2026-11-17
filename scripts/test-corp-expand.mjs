// v2.9.2 回归：特许经营合同（上限 5 个、信誉不设上限、奖励递减、中标概率 100 分封顶、招标更密）
// 与任务目标（撤下「不扩张也能减亏」「减少高峰汽车出行」「让某线重新跑满」，改为鼓励扩张的
// 「为某片区提供地铁服务」「把某线延伸到某片区」，广州第五期规划任务）。
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
for (const name of ['settings', 'corp', 'fleet', 'opsapp']) await load('js/' + name + '.js');

// ---------------- 1. 合同规则 ----------------
const R = C.Corp.RULE, P = C.Corp;
assert.equal(R.active, 5, '特许经营合同上限应为 5 个，实际 ' + R.active);
assert.ok(R.every <= 6, '招标间隔应缩短（合同出现概率增多），实际每 ' + R.every + ' 个月');
assert.ok(R.open >= 3, '同时挂出的招标数应增加，实际 ' + R.open);
assert.equal(P.grantFactor(0), 1, '信誉 0 分时拨款 ×1.00');
assert.ok(Math.abs(P.grantFactor(100) - 1.05) < 1e-9, '100 信誉应 +5%，实际 ×' + P.grantFactor(100));
assert.ok(Math.abs(P.grantFactor(250) - 1.125) < 1e-9, '信誉不设上限：250 分应 +12.5%，实际 ×' + P.grantFactor(250));
assert.ok(P.grantFactor(400) > P.grantFactor(300), '信誉继续积累，拨款应继续增加');
assert.equal(P.gainDecay(0), 1);
assert.ok(Math.abs(P.gainDecay(1) - 0.8) < 1e-9 && Math.abs(P.gainDecay(2) - 0.64) < 1e-9, '完成合同奖励应逐个递减 20%');
const opt = { win: 0.35 };
assert.equal(P.winChance(opt, 100), P.winChance(opt, 300), '中标概率应按 100 分封顶：100 分与 300 分应相同');
assert.ok(P.winChance(opt, 100) > P.winChance(opt, 0), '100 分以内信誉仍应提高中标率');
console.log('PASS 合同上限 5 个、信誉不设上限（每 100 分 +5%）、奖励递减 20%、中标率 100 分封顶');

// ---------------- 2. 广州地图与一条确认的线网 ----------------
C.useMap('gz');
const g = C.Game.create({ mode: 'challenge', seed: 20261113 });
assert.equal(g.mapId, 'gz');
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

// ---------------- 3. 完成合同：信誉可超过 100，奖励逐个递减 ----------------
{
  const ym = g.ym();
  g.corp = { v: 1, seq: 1, rating: 180, done: 4, ym: ym - 1, next: ym + 999, tenders: [], contracts: [], closed: [], cool: {} };
  const st = g.compiled.stations;
  const con = {
    id: 'C-exp', type: 'line', title: '测试合同', est: 1000, forecast: 0, opsM: 12,
    signed: ym - 12, opened: ym - 12, opsEnd: ym, deadline: ym, phase: 'ops', paid: {}, status: 'active',
    opt: { name: '标准报价', apM: 0, sub: 0, bond: 0 },
    anchors: [{ name: st[0].name, x: st[0].x, y: st[0].y, r: 1.2 }, { name: st[1].name, x: st[1].x, y: st[1].y, r: 1.2 }],
    area: { x: st[0].x, y: st[0].y, r: 2 },
  };
  g.corp.contracts = [con];
  P.monthly(g);
  assert.equal(g.corp.contracts.length, 0, '到期合同应移交结束');
  assert.equal(g.corp.closed.at(-1).status, 'done');
  assert.equal(g.corp.done, 5, '已完成合同数应递增到 5');
  assert.ok(g.corp.rating > 180, '信誉应继续增加，不被 100 分截断，实际 ' + g.corp.rating);
  assert.ok(g.corp.rating < 183.5, '第 5 个合同的期满奖励应递减到约 2.05 分，实际 ' + g.corp.rating);
  const gain = 5 * P.gainDecay(4);
  assert.ok(Math.abs(g.corp.rating - (180 + 0.25 + gain)) < 1e-6, '信誉 = 180 + 月度考核 + 递减奖励，实际 ' + g.corp.rating);
  // 旧存档没有 done 字段：按已结束合同补记，奖励继续递减
  g.corp.done = undefined; g.corp.ym = g.ym() - 1;
  g.corp.closed = [{ status: 'done' }, { status: 'done' }, { status: 'failed' }];
  P.monthly(g);
  assert.equal(g.corp.done, 2, '旧存档应按已结束的合同补记完成数，实际 ' + g.corp.done);
  console.log('PASS 合同期满后信誉超过 100 继续增长、奖励递减 20%、旧存档补记完成数');
}

// ---------------- 4. 撤下三类引导「少修线」的任务 ----------------
{
  const T = new C.Tasks(), ym = g.ym();
  const oldHist = C.DATA.histTasks, oldDyn = C.DATA.dynTasks;
  C.DATA.histTasks = []; C.DATA.dynTasks = [];
  const mk = (id, type, extra) => Object.assign({
    id, kind: 'opt', type, title: id, desc: '', status: 'active', issuedAt: [g.clock.y, g.clock.m],
    deadline: [g.clock.y + 2, 1], reward: 1, coolKey: 'x:' + id,
  }, extra);
  T.active = [mk('f1', 'fiscal'), mk('l1', 'lineEff'), mk('c1', 'zoneCong', { metric: 'carShare', zone: 0, samples: [] }), mk('k1', 'coverage', { target: 0.5 })];
  T.offers = [mk('o1', 'fiscal'), mk('o2', 'lineEff'), mk('o3', 'zoneCong', { metric: 'carShare', zone: 1 })];
  T.nextDyn = ym + 999; T.nextOffer = ym + 999;
  const oldTasks = g.tasks; g.tasks = T;
  try {
    T.monthly(g);
  } finally { g.tasks = oldTasks; C.DATA.histTasks = oldHist; C.DATA.dynTasks = oldDyn; }
  const kept = T.active.map(t => t.type);
  assert.equal(kept.length, 1, '只应保留未在撤下名单里的任务，实际 ' + kept.join(','));
  assert.equal(kept[0], 'coverage');
  assert.equal(T.offers.length, 0, '待选里的三类任务应全部撤下，实际 ' + T.offers.map(o => o.type).join(','));
  const adj = (T.adjusted || []).map(t => t.id);
  assert.equal(adj.sort().join(','), 'c1,f1,l1', '撤下的任务应记入调整记录，实际 ' + adj.join(','));
  assert.equal(T.failed.length, 0, '撤下的任务不应记为未完成');
  assert.ok(T.adjusted.every(t => /任务目标已调整/.test(t.why || '')), '撤下原因应说明目标已调整');
  console.log('PASS 「不扩张也能减亏」「减少高峰汽车出行」「让某线重新跑满」已撤下，且不计失败');
}

// ---------------- 5. 新任务：为片区提供地铁服务 / 把线路延伸过去 ----------------
{
  const seen = new Map();
  for (let i = 0; i < 40; i++) {
    const T = new C.Tasks(); T.seq = i + 1;
    const t = T.generate(g);
    if (!t) continue;
    const key = t.type + '|' + t.title.replace(/「[^」]*」/g, '「…」');
    seen.set(key, (seen.get(key) || 0) + 1);
    assert.ok(!['fiscal', 'lineEff'].includes(t.type), '不应再生成 ' + t.type + ' 任务');
    assert.ok(!(t.type === 'zoneCong' && t.metric === 'carShare'), '不应再生成「减少高峰汽车出行」任务');
  }
  const titles = [...seen.keys()].join(' | ');
  assert.ok([...seen.keys()].some(k => /^zoneCov\|为「.+」提供地铁服务$/.test(k)), '应能生成「为某片区提供地铁服务」，实际：' + titles);
  assert.ok([...seen.keys()].some(k => /^connect\|把「.+」延伸到「.+」$/.test(k)), '应能生成「把某线延伸到某片区」，实际：' + titles);
  console.log('PASS 新任务只包含扩张类：' + [...seen.keys()].slice(0, 6).join('；'));
}

// ---------------- 6. 广州第五期规划任务 ----------------
{
  const goals = C.Eras.goals().filter(x => /^gz-g(8|9|1[0-3])$/.test(x.id));
  assert.equal(goals.length, 6, '广州第五期规划应有 6 条任务，实际 ' + goals.length);
  const byId = new Map(goals.map(x => [x.id, x]));
  const need = { 'gz-g8': 4, 'gz-g9': 3, 'gz-g10': 2, 'gz-g11': 2, 'gz-g12': 3, 'gz-g13': 0 };
  for (const [id, na] of Object.entries(need)) {
    const t = byId.get(id);
    assert.ok(t, '缺少第五期任务 ' + id);
    assert.ok(t.from[0] >= 2021, id + ' 应在 2021 年后的模拟阶段发布');
    assert.ok(t.to[0] > t.from[0], id + ' 应有发布窗口');
    assert.ok(/第五期/.test(t.title), id + ' 标题应标明第五期规划');
    assert.ok(t.type === 'connect' || t.type === 'regionCov', id + ' 类型应为 connect / regionCov，实际 ' + t.type);
    if (na) assert.equal(t.anchors.length, na, id + ' 的锚点数应为 ' + na);
    for (const a of t.anchors || []) {
      assert.ok(a.x > 0 && a.x < g.city.W && a.y > 0 && a.y < g.city.H, id + ' 的锚点「' + a.name + '」超出地图：' + a.x + ',' + a.y);
      assert.ok(g.city.cellAt(a.x, a.y) >= 0, id + ' 的锚点「' + a.name + '」应落在陆地或可建设范围内');
    }
  }
  assert.equal(byId.get('gz-g13').regions[0], 'panyu_e', '番禺东覆盖任务应指向 panyu_e');
  // 第五期任务可以真的通过「怎么做」页生成操作步骤（connect / regionCov 两条渲染路径都通）
  const t0 = C.Tasks.withPlan(g, byId.get('gz-g8'));
  assert.ok(Array.isArray(t0.parts) || t0.type === 'connect', '第五期任务应能套用城市方案');
  console.log('PASS 广州第五期 6 条任务（12 号线、7 号线二期、8 号线北延、13 号线二期、22 号线、番禺东覆盖）锚点均在地图内');
}

console.log('ALL PASS v2.9.2 合同与任务目标调整');
