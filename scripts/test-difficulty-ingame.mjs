// v3.6 回归：设置页可随时调整本局难度（除初始资金外），改动实时生效并随存档往返。
// 纯逻辑 vm，加载 index.html 到 js/save.js 后再补需要的模块，不启动浏览器。
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const base = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = path.resolve(base, process.argv.includes('--dist') ? 'dist' : '');
const memory = new Map();
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
c.window = c; c.CM = {};
vm.createContext(c);
const load = async src => vm.runInContext(await readFile(path.join(root, src), 'utf8'), c, { filename: src });
for (const [, src] of (await readFile(path.join(root, 'index.html'), 'utf8')).matchAll(/<script src="([^"]+)"/g)) {
  await load(src);
  if (src === 'js/save.js') break;
}
c.CM.UI = function () {};
for (const src of ['settings', 'corp', 'fleet', 'screens']) await load('js/' + src + '.js');

const C = c.CM, D = C.Difficulty, E = C.Economy, M = C.Metro, F = C.Fleet, CFG = C.CFG;
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, a + ' ≠ ' + b);
const y = 1990;
C.useMap('gz');

// ---------- 1. 可调整项：9 项里排除初始资金 ----------
assert.deepEqual(Array.from(D.KEYS), ['funds', 'grant', 'build', 'demolish', 'ops', 'train', 'task', 'finance', 'interest']);
assert.deepEqual(Array.from(D.GAME_KEYS), ['grant', 'build', 'demolish', 'ops', 'train', 'task', 'finance', 'interest']);
assert.equal(D.GAME_KEYS.includes('funds'), false, '初始资金不能在游戏中调整');

// ---------- 2. 微调必须真的作用到经济/造价/车队，而不是读档位预设 ----------
// 草案造价需要带 cellAt 的城市对象；自由建造开局会重置全局难度，所以放在设系数之前。
const cityGame = C.Game.create({ mode: 'free', seed: 20000104 });
D.set('normal');
const e = new E('challenge', y, 1);
const grant0 = e.grantFor(y, 1), quota0 = e.bondQuota('local', y);
const price0 = F.price({ econ: e, clock: { y: y } }, F.eraModel('gz', y), 6, y);
e.setDifficultyTune({ grant: 2, build: 0.5, demolish: 0.5, ops: 1.5, train: 0.8, task: 2, finance: 2, interest: 0.5, funds: 3 });
assert.equal(e.tune.grant, 2);
assert.equal(e.tune.funds, 1, '补丁里的 funds 被本局原值覆盖');
assert.equal(e.grantMul(), 2, '拨款倍率走实时系数');
assert.equal(D.grantMul(e.difficulty), 2, '当前档位查询也走实时系数');
assert.equal(D.buildMul(e.difficulty), 0.5);
assert.equal(D.trackMul(e.difficulty), 0.5);
assert.equal(D.demolishMul(e.difficulty), 0.5);
assert.equal(e.opsMul(), 1.5);
assert.equal(e.financeMul(), 2);
assert.equal(e.interestMul(), 0.5);
assert.equal(D.trainMul(e.difficulty), 0.8);
assert.equal(D.taskMul(e.difficulty), 2);
near(e.grantFor(y, 1), grant0 * 2);
near(e.bondQuota('local', y), quota0 * 2);
near(F.price({ econ: e, clock: { y: y } }, F.eraModel('gz', y), 6, y), price0 * 0.8);
assert.equal(D.get(), 'normal', '微调只改系数，不改档位与收入倍率');
assert.equal(D.gameCustom('normal'), true);

// 草案明细里的建设费减免也跟着实时系数走
const net0 = M.empty(), net1 = M.empty();
net1.stations.s1 = { id: 's1', x: 20.5, y: 20.5, name: '测试站', type: 'underground', size: 'L' };
const ev = M.evaluate(net1, net0, cityGame.city, y);
const stItem = ev.items.find(it => it.kind === 'construction' && /新建车站/.test(it.label));
const cut = ev.items.find(it => it.discount);
assert.ok(stItem && cut, '建设费减免条目存在');
near(cut.amount, -stItem.amount * 0.5, 1e-6, '减免 = 车站原价 × (1 − 0.5)');

// ---------- 3. 初始资金锁定 + 档位切换 ----------
const e2 = new E('challenge', y, 1);
e2.tune.funds = 1.4;                       // 模拟开局自定义了初始资金
e2.setDifficultyTune({ grant: 1.5 });
assert.equal(e2.tune.funds, 1.4, '调整系数不影响本局初始资金系数');
e2.resetDifficultyTune();
assert.equal(e2.tune.grant, 1, '恢复该档默认把 8 项系数还原');
assert.equal(e2.tune.funds, 1.4, '恢复该档默认仍保留初始资金');
assert.equal(D.gameCustom('normal'), false);
assert.equal(e2.setDifficultyLevel('easy'), 'easy');
assert.equal(e2.difficulty, 'easy');
assert.equal(e2.tune.grant, 1.2, '切档回填 easy 预设');
assert.equal(e2.tune.funds, 1.4, '切档不改初始资金');
assert.equal(e2.grantMul(), 1.2);
assert.equal(D.get(), 'easy');
assert.equal(e2.setDifficultyLevel('hard'), 'hard');
near(e2.income('reward', 1000), 800, 1e-9, '困难档收入 -20% 随切档生效');
e2.setDifficultyLevel('normal');

// ---------- 4. 整局存档往返（Game.create / serialize / Game.restore） ----------
const tune0 = { funds: 1.4, grant: 1, build: 1, demolish: 1, ops: 1, train: 1, task: 1, finance: 1, interest: 1 };
const gs = C.Game.create({ mode: 'challenge', difficulty: 'normal', tune: tune0, seed: 20000103, name: '本局难度测试' });
assert.equal(gs.econ.difficulty, 'normal');
assert.ok(gs.econ.funds > CFG.economy.startFunds, '开局初始资金按自定义系数放大（开局还会结算首月拨款）');
assert.equal(gs.econ.tune.funds, 1.4);
const grant1 = gs.econ.grantFor(y, 1);
gs.econ.setDifficultyTune({ grant: 2.5, train: 0.6 });
assert.equal(gs.econ.tune.funds, 1.4, '游戏中改系数后初始资金仍锁定');
near(gs.econ.grantFor(y, 1), grant1 * 2.5);
const saved = JSON.parse(JSON.stringify(gs.serialize()));
assert.equal(saved.econ.tune.grant, 2.5, '存档带上本局系数');
assert.equal(saved.econ.tune.train, 0.6);
assert.equal(saved.econ.tune.funds, 1.4);
D.set('hard');                                   // 读档前把全局难度改掉，检验是否由存档覆盖
const re = C.Game.restore(saved);
assert.equal(re.econ.difficulty, 'normal', '读档恢复本局档位');
assert.equal(re.econ.tune.grant, 2.5, '读档恢复本局系数');
assert.equal(re.econ.tune.funds, 1.4);
assert.equal(re.econ.grantMul(), 2.5, '读档后倍率仍按本局系数');
assert.equal(D.get(), 'normal', '读档把全局档位同步为本局档位');
near(re.econ.grantFor(y, 1), grant1 * 2.5);

// 旧存档没有 tune：按档位预设补齐，设置页不会显示与全局不一致的 1
delete saved.econ.tune;
const legacy = C.Game.restore(JSON.parse(JSON.stringify(saved)));
assert.equal(legacy.econ.tune.grant, D.presetOf(legacy.econ.difficulty).grant, '旧档按档位预设补齐');

// 边界：困难档玩家把 8 项系数调成与「一般」预设完全一致时，读档不能让 match()
// 把档位改过去 —— 收入倍率必须始终跟着存档里记录的档位走。
const tricky = JSON.parse(JSON.stringify(gs.serialize()));
tricky.econ.difficulty = 'hard';
tricky.econ.tune = D.presetOf('normal');
const tr = C.Game.restore(tricky);
assert.equal(tr.econ.difficulty, 'hard', '读档保留存档里的困难档');
assert.equal(D.get(), 'hard', '全局档位不被系数匹配的另一档覆盖');
assert.equal(D.incomeMul(), 0.8, '收入倍率仍按困难档 -20%');
assert.equal(tr.econ.tune.grant, 1, '自定义系数原样恢复');

// 开局同理：开局界面选困难档、系数恰好微调成另一档预设
D.set('normal');
const gc = C.Game.create({ mode: 'challenge', difficulty: 'hard', tune: D.presetOf('normal'), seed: 20000104 });
assert.equal(gc.econ.difficulty, 'hard');
assert.equal(D.get(), 'hard', '开局档位不被系数匹配的另一档覆盖');
assert.equal(D.incomeMul(), 0.8, '开局收入倍率按所选档位');

// 设置里的「下次开局难度」不应被本局调整污染
const nextLevel = C.Settings.get('difficulty');
gs.econ.setDifficultyLevel('easy');
assert.equal(C.Settings.get('difficulty'), nextLevel, '本局改档不影响下次开局设置');

// ---------- 5. 新增界面文案英文整句覆盖 ----------
{
  const c2 = { console, Intl, localStorage: { getItem: () => null, setItem() {}, removeItem() {} } };
  c2.window = c2; c2.CM = {};
  vm.createContext(c2);
  for (const f of ['js/util.js', 'js/config.js', 'js/locales/en.js', 'js/i18n.js']) {
    vm.runInContext(await readFile(path.join(root, f), 'utf8'), c2, { filename: f });
  }
  const I = c2.CM.I18n, han = s => /[\u3400-\u9fff]/.test(s);
  I.apply('en');
  const strings = [
    '本局难度', '本局：', ' · 自定义', '难度档位', '恢复该档默认',
    '除初始资金外，8 项系数可随时调整；改动立即生效并写入本局存档。初始资金只在开局时确定。',
    '自由建造不限资金，本局难度系数不生效；开始经营挑战后可在此调整。',
    '开始经营挑战后，可在这里随时调整本局难度系数（初始资金除外）。',
    '切换档位会把 8 项系数回填为该档默认值；困难档还会把所有收入降低 20%。',
    '把 8 项系数恢复为当前档位的默认值，初始资金保持不变',
    '只重置可调整的项目，不改变本局已经确定的初始资金。',
    '本局难度已调整，改动已写入存档',
    '每月政府拨款', '轨道、车站及站台升级的建造费', '拆迁与搬迁补偿',
    '列车运行与车站运营费用', '新购列车的价格', '任务与挑战奖励',
    '年度发债额度与未偿本金上限', '新发行债券的利率',
  ];
  for (const s of strings) assert.ok(!han(I.text(s)), '英文残留汉字：' + s + ' => ' + I.text(s));
  assert.equal(han(I.text('本局难度')), false);
  console.log('PASS 新增难度文案英文覆盖（%d 条）', strings.length);
}

console.log('PASS 本局难度随时调整：实时倍率、初始资金锁定、档位切换、存档往返');
console.log('ALL PASS v3.6 in-game difficulty');
