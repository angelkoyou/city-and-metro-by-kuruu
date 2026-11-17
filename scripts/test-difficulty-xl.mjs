// 开局难度倍率与「超大型」车站回归：收支挂点、存档往返、XL 单价外推、升级计费与换乘组对齐
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

const D = C.Difficulty, M = C.Metro, T = C.TOD, CFG = C.CFG, F = C.Fleet;
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, a + ' ≠ ' + b);

// ---------- 难度定义与非法值回退 ----------
// v3.8：无限贷款从难度档解耦为独立开关；难度档只剩 4 个经营档 + 自由建造
assert.equal(D.order.join(','), 'hard,normal,easy,beginner,free');
assert.equal(D.tiers.join(','), 'hard,normal,easy,beginner');
assert.equal(D.sandboxOf('free'), 'free');
assert.equal(D.sandboxOf('normal'), null);
assert.equal(D.sandboxOf('infinite'), null, '无限贷款不再是难度档');
assert.ok(D.isSandbox('free') && !D.isSandbox('normal'));
assert.equal(D.normalize('infinite'), 'normal', '旧档位名回退为一般');
assert.equal(D.of('free').name, '自由建造');
assert.equal(D.incomeMul('hard'), 0.8);
assert.equal(D.incomeMul('normal'), 1);
assert.equal(D.incomeMul('easy'), 1, '简单难度不再改全部收入');
assert.equal(D.incomeMul('beginner'), 1, '入门难度不再改全部收入');
assert.equal(D.grantMul('hard'), 1);
assert.equal(D.grantMul('normal'), 1);
assert.equal(D.grantMul('easy'), 1.2);
assert.equal(D.grantMul('beginner'), 1.3);
assert.equal(D.trackMul('hard'), 1);
assert.equal(D.trackMul('easy'), 1);
near(D.trackMul('beginner'), 0.7);
assert.equal(D.financeMul('easy'), 1);
assert.equal(D.financeMul('beginner'), 1.5);
// 三处加成共用同一套文案：难度名 + 数值
assert.equal(D.grantLabel('easy'), '简单难度 拨款+20%');
assert.equal(D.grantLabel('beginner'), '入门难度 拨款+30%');
assert.equal(D.costCutLabel('beginner'), '入门难度 建设费-30%');
assert.equal(D.financeLabel('beginner'), '入门难度 融资额度+50%');
assert.equal(D.normalize('nope'), 'normal');
assert.equal(D.normalize(undefined), 'normal');

// ---------- 收入倍率只作用于经营挑战 ----------
for (const [id, inc] of [['hard', 0.8], ['normal', 1], ['easy', 1], ['beginner', 1]]) {
  D.set(id);
  const e = new C.Economy('challenge', 1990, 1);
  assert.equal(e.difficulty, id, 'Economy 记住本局难度');
  const got = e.income('reward', 1000);
  near(got, 1000 * inc);
  near(e.cur.reward, 1000 * inc);
  const free = new C.Economy('free', 1990, 1);
  assert.equal(free.income('fare', 100), 100, '自由建造收入保持原值');
}

// ---------- 存档往返与旧档兼容 ----------
D.set('beginner');
const e0 = new C.Economy('challenge', 1990, 1);
const saved = JSON.parse(JSON.stringify(e0.serialize()));
assert.equal(saved.difficulty, 'beginner');
D.set('hard');
const restored = C.Economy.restore(saved);
assert.equal(restored.difficulty, 'beginner');
assert.equal(D.get(), 'beginner', '读档把全局倍率同步为存档难度');
near(restored.grantMul(), 1.3, 1e-9);
delete saved.difficulty;
const legacy = C.Economy.restore(saved);
assert.equal(legacy.difficulty, 'normal', '旧存档没有难度字段时按正常处理');
assert.equal(legacy.grantMul(), 1);
assert.equal(D.get(), 'normal');

// 设置项白名单（apply 需要 DOM，测试中只校验取值归一化）
const realApply = C.Settings.apply;
C.Settings.apply = function () {};
C.Settings.set('difficulty', 'easy');
assert.equal(C.Settings.get('difficulty'), 'easy');
C.Settings.set('difficulty', 'bogus');
assert.equal(C.Settings.get('difficulty'), 'normal');
C.Settings.apply = realApply;

// ---------- 轨道与站台成本：条目仍按原价，减免在明细里单列一行 ----------
C.useMap('gz');
const y = 1990;
D.set('normal');
const stN = M.stationCost('underground', 'L', y), tkN = M.trackCost({ lenM: 1000, waterM: 0, hillM: 0, protM: 0 }, 'underground', y);
const todN = T.cost(2, y, 'M', false), upkeepN = T.stationCost(2, y, 'M', false);
const econ = new C.Economy('challenge', y, 1), gLike = { econ: econ, clock: { y: y } };
const priceN = F.price(gLike, F.eraModel('gz', y), 6, y), econCiN = econ.costIndex(y);
D.set('beginner');
near(M.stationCost('underground', 'L', y), stN, 1e-9);   // 造价函数本身不打折：明细里要能同时看到原价与减免
near(M.trackCost({ lenM: 1000, waterM: 0, hillM: 0, protM: 0 }, 'underground', y), tkN, 1e-9);
near(T.cost(2, y, 'M', false), todN, 1e-9);   // 商业开发不属于轨道与站台
near(T.stationCost(2, y, 'M', false), upkeepN);
near(F.price(gLike, F.eraModel('gz', y), 6, y), priceN, 1e-9);   // 购置列车不打折
assert.equal(econ.costIndex(y), econCiN, '票价/债务/任务奖励用的经济指数不受难度影响');
D.set('normal');

// 拨款：基础额度 × 难度倍率，入账时把难度那部分单独记在 grantBonus
D.set('normal');
const eNorm = new C.Economy('challenge', y, 1), grantN = eNorm.grantFor(y, 1);
D.set('easy');
const eEasy = new C.Economy('challenge', y, 1);
near(eEasy.grantFor(y, 1), grantN * 1.2, 1e-6);
near(eEasy.grantMul(), 1.2);
D.set('beginner');
const eBeg = new C.Economy('challenge', y, 1);
near(eBeg.grantFor(y, 1), grantN * 1.3, 1e-6);
eBeg.startMonth(y, 1);
near(eBeg.cur.grant, grantN * 1.3, 1e-6);
near(eBeg.cur.grantBonus, grantN * 0.3, 1e-6, '入门难度加成金额 = 基础拨款 × 30%');
assert.ok(eBeg.grantFactors(y, 1).some(f => f.kind === 'diff' && f.f === 1.3), '拨款依据里含难度一步');

// 融资额度：入门难度 +50%（年度额度与未偿本金上限同比例）
D.set('normal');
const eFinN = new C.Economy('challenge', y, 1), quotaN = eFinN.bondQuota('local', y), capN = eFinN.bondCap('local', y);
assert.ok(quotaN > 0, '本图开放债券融资');
D.set('beginner');
const eFinB = new C.Economy('challenge', y, 1);
near(eFinB.bondQuota('local', y), quotaN * 1.5, 1e-6);
near(eFinB.bondCap('local', y), capN * 1.5, 1e-6);
near(eFinB.financeMul(), 1.5);
D.set('normal');

// 困难难度保持原样：不加成拨款，收入倍率 -20% 仍作用在入账金额上
D.set('hard');
const eHard = new C.Economy('challenge', y, 1);
eHard.startMonth(y, 1);
near(eHard.grantFor(y, 1), grantN, 1e-6);
near(eHard.cur.grant, grantN * 0.8, 1e-6);
assert.equal(eHard.cur.grantBonus, 0, '困难没有难度加成项');

// 草案费用明细：新建一座车站，入门难度下多出「入门难度成本减免」，总额随之下降
C.useMap('tutorial');
const gT = C.Game.create({ mode: 'free', tutorial: true, seed: 20000101 });
const emptyNet = () => M.empty();
const oneStation = () => { const n = M.empty(); n.stations.s1 = { id: 's1', x: 20.5, y: 20.5, name: '测试站', type: 'underground', size: 'L' }; return n; };
const twoStations = () => { const n = oneStation(); n.stations.s2 = { id: 's2', x: 23.5, y: 20.5, name: '测试站二', type: 'underground', size: 'L' }; return n; };
D.set('normal');
const evN = M.evaluate(oneStation(), emptyNet(), gT.city, 1990);
assert.ok(evN.items.some(it => it.kind === 'construction' && /新建车站/.test(it.label)), '正常难度列出车站原价');
assert.ok(!evN.items.some(it => it.discount), '正常难度没有减免项');
D.set('beginner');
const evB = M.evaluate(oneStation(), emptyNet(), gT.city, 1990);
const stItem = evB.items.find(it => it.kind === 'construction' && /新建车站/.test(it.label));
const cut = evB.items.find(it => it.discount);
assert.ok(stItem, '入门难度仍列出车站原价');
assert.ok(cut && cut.label === '入门难度 建设费-30%', '入门难度新增成本减免项');
near(cut.amount, -stItem.amount * 0.3, 1e-6, '减免金额 = 车站原价 × 30%');
near(evB.total, evB.items.reduce((a, it) => a + it.amount, 0), 1e-6, '总额等于明细各行之和');
near(evB.total, evN.total - stItem.amount * 0.3, 1e-6, '总额 = 原价 − 减免');
const bk = evB.byKind; near(bk.construction + bk.demolition + bk.upgrade + bk.relocation, evB.total, 1e-6, '分类金额与总额一致');
// 加一座站，减免跟着条目一起变大（金额随公式自动更新）
const evB2 = M.evaluate(twoStations(), emptyNet(), gT.city, 1990);
const cut2 = evB2.items.find(it => it.discount);
const stSum = evB2.items.filter(it => it.kind === 'construction' && /新建车站/.test(it.label)).reduce((a, it) => a + it.amount, 0);
near(cut2.amount, -stSum * 0.3, 1e-6, '两座车站时减免随之翻倍');
D.set('normal');

// ---------- 大站档：配置与每城造价按比例外推 ----------
assert.ok(CFG.metro.sizes.includes('XL'), '规模顺序包含 XL');
assert.equal(CFG.metro.sizes[CFG.metro.sizes.length - 1], 'HUB', '枢纽型是最高档');
assert.deepEqual(Array.from(CFG.metro.sizes), ['S', 'M', 'L', 'XL', 'XXL', 'HUB']);
assert.equal(CFG.metro.stationCap.XL, 120000);
assert.equal(CFG.metro.stationCap.XXL, 160000, '巨型 16 万人次/时');
assert.equal(CFG.metro.stationCap.HUB, 400000, '枢纽型 40 万人次/时');
assert.equal(CFG.metro.carsBySize.XL, 8);
assert.equal(CFG.metro.carsBySize.XXL, 8, '巨型编组上限 8 节');
assert.equal(CFG.metro.carsBySize.HUB, 8, '枢纽型编组上限 8 节');
assert.equal(CFG.metro.sizeName.XL, '超大型');
assert.equal(CFG.metro.sizeName.XXL, '巨型');
assert.equal(CFG.metro.sizeName.HUB, '枢纽型');
assert.equal(T.SIZE.XL, 2.25);
assert.ok(T.SIZE.XXL > T.SIZE.XL && T.SIZE.HUB > T.SIZE.XXL, 'TOD 规模系数继续放大');
for (const id of C.MAP_ORDER) {
  C.useMap(id);
  for (const t of ['underground', 'elevated', 'surface']) {
    const row = CFG.cost.station[t];
    assert.ok(Number.isFinite(row.XL) && row.XL > row.L, id + '/' + t + ' 的 XL 造价按比例外推');
    const expect = row.L * (row.L / row.M);   // 单列的 XL 允许取整，误差控制在 6% 内
    assert.ok(Math.abs(row.XL - expect) / expect < 0.06, id + '/' + t + ' 的 XL 造价与 L/M 比例一致');
    // v3.3：巨型与枢纽型沿用同一条等比外推口径（XL/L 的比值逐档相乘）
    const r = row.XL / row.L;
    for (const [sz, prev] of [['XXL', 'XL'], ['HUB', 'XXL']]) {
      const want = row[prev] * r, got = row[sz];
      assert.ok(Number.isFinite(got) && got > row[prev], id + '/' + t + ' 的 ' + sz + ' 造价按比例外推');
      assert.ok(Math.abs(got - want) / want < 0.06, id + '/' + t + ' 的 ' + sz + ' 造价与 ' + prev + ' 比例一致：' + got + ' vs ' + want);
    }
  }
  const daily = CFG.ops.stationDaily;
  for (const sz of ['XL', 'XXL', 'HUB']) assert.ok(Number.isFinite(daily[sz]) && daily[sz] > daily[sz === 'XL' ? 'L' : sz === 'XXL' ? 'XL' : 'XXL'], id + ' 的 ' + sz + ' 运营费按比例外推');
  assert.ok(M.stationCost('underground', 'XL', y) > M.stationCost('underground', 'L', y), id + ' XL 造价高于 L');
  assert.ok(M.stationCost('underground', 'HUB', y) > M.stationCost('underground', 'XXL', y), id + ' 枢纽型造价高于巨型');
  assert.ok(CFG.ops.stationDaily.HUB > CFG.ops.stationDaily.XXL, id + ' 枢纽型运营费高于巨型');
}

// ---------- 大站档：升级计费、组对齐、规模顺序 ----------
C.useMap('tutorial');
D.set('normal');
const g = C.Game.create({ mode: 'free', tutorial: true, seed: 20000101 });
const mkNet = function (size) {
  const n = M.empty();
  n.stations.s1 = { id: 's1', x: 20.5, y: 20.5, name: '测试站', type: 'underground', size: size };
  return n;
};
const up = M.evaluate(mkNet('XL'), mkNet('L'), g.city, g.clock.y);
assert.ok(up.items.some(it => it.kind === 'upgrade'), 'L → XL 产生升级费用');
assert.ok(up.total > 0, 'L → XL 升级费用为正');
const down = M.evaluate(mkNet('L'), mkNet('XL'), g.city, g.clock.y);
assert.ok(down.changes.mod.some(s => s.indexOf('缩减') >= 0), 'XL → L 记为缩减');

// 旧档对齐只升不降：XL 组内站不应被降到 L
g.net.stations.xa = { id: 'xa', x: 30.5, y: 30.5, name: '甲', type: 'underground', size: 'XL' };
g.net.stations.xb = { id: 'xb', x: 31.5, y: 30.5, name: '乙', type: 'underground', size: 'S' };
g.walkXfer = { on: [C.Game.walkXferKey('xa', 'xb')], same: [] };
const aligned = g.walkXferAlignSizes();
assert.equal(aligned, 1);
assert.equal(g.net.stations.xa.size, 'XL', '组内 XL 不被降级');
assert.equal(g.net.stations.xb.size, 'XL', '组内小站升到 XL');

// 新开局难度写入游戏并随存档恢复
D.set('normal');
const easyGame = C.Game.create({ mode: 'challenge', difficulty: 'easy', seed: 20000102, name: '难度测试' });
assert.equal(easyGame.econ.difficulty, 'easy');
assert.equal(D.get(), 'easy');
const roundTrip = JSON.parse(JSON.stringify(easyGame.serialize()));
D.set('hard');
const reGame = C.Game.restore(roundTrip);
assert.equal(reGame.econ.difficulty, 'easy', '读档恢复本局难度');
assert.equal(D.get(), 'easy');

console.log('test-difficulty-xl: PASS');
