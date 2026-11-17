// 时间控制回归：推进结束后空格 = 继续游戏；四档倍速直接显示在顶栏；空格仍是默认暂停键
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const root = new URL('../', import.meta.url);
const read = async p => readFile(new URL(p, root), 'utf8');
const [uiSrc, toolsSrc, gameSrc, keysSrc, cssSrc, enSrc] = await Promise.all([
  read('js/ui.js'), read('js/tools.js'), read('js/game.js'), read('js/keys.js'), read('css/style.css'), read('js/locales/en.js'),
]);

// ---------- 1. 默认键位：空格是「暂停 / 继续」，四档倍速各有快捷键 ----------
const kc = { console, window: null, CM: { Settings: { get: () => null, on() {}, set() {} } } };
kc.window = kc;
vm.createContext(kc);
vm.runInContext(keysSrc, kc, { filename: 'js/keys.js' });
const K = kc.CM.Keys;
const space = { code: 'Space', key: ' ', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
assert.equal(K.match(space), 'pause', '空格默认必须绑定「暂停 / 继续」');
for (const [id, code] of [['speed1', 'Digit1'], ['speed2', 'Digit2'], ['speed3', 'Digit3'], ['speed4', 'Digit4']]) {
  assert.ok(K.get(id).includes(code), id + ' 默认快捷键 ' + code);
}
assert.ok(K.get('jumpMonth').length && K.get('jumpQuarter').length && K.get('jumpYear').length, '三个推进按钮都有快捷键');

// ---------- 2. 顶栏结构：8× / 24× / 高峰慢放都不再藏在下拉里 ----------
const barStart = uiSrc.indexOf("h('div', { class: 'speed' }"), barEnd = uiSrc.indexOf("h('div', { class: 'jumps' }", barStart);
assert.ok(barStart > 0 && barEnd > barStart, '找到顶栏速度分段控件');
const bar = uiSrc.slice(barStart, barEnd);
for (const id of ['s1', 's2', 's3', 's4']) assert.ok(bar.includes("spd('" + id + "'"), id + ' 应在顶栏');
assert.ok(bar.includes("'8×'") && bar.includes("'24×'"), '8× / 24× 应直接显示');
assert.ok(bar.includes('self.tbtns.peak = b'), '高峰慢放按钮应在顶栏');
assert.ok(!bar.includes("timeFold('speed'"), '速度折叠按钮应已移除');
assert.ok(!uiSrc.includes('timeOptions.speed.menu'), '不应再有「更多倍速」下拉');
assert.ok(uiSrc.includes("timeFold('jump'"), '推进 3 个月 / 1 年 的下拉仍保留');
assert.ok(cssSrc.includes('.speed .sbtn.peak.on'), '高峰慢放开启态样式应存在');

// ---------- 3. 推进后待继续状态与空格拦截 ----------
assert.ok(uiSrc.includes('UI.prototype.resumeFromJump'), '应有推进后继续的实现');
assert.ok(uiSrc.includes('self._afterJump = true'), '推进完成应标记待继续');
assert.ok(uiSrc.includes('CM.Keys.match(e) === \'pause\''), '时间按钮上的空格应交给暂停键');
assert.ok(uiSrc.includes('self.jump(n)') && uiSrc.includes('e.detail > 0'), '鼠标点击推进按钮后应移走焦点');
assert.ok(toolsSrc.includes("this.ui._afterJump && CM.Keys.match(e) === 'pause'"), '报告打开时空格仍应恢复游戏');
assert.ok(uiSrc.includes("if (self._afterJump) self.resumeFromJump()"), '报告里的「继续」按钮也应恢复游戏');
assert.ok(gameSrc.includes('this.prevSpeed = this.speed;'), '推进前应记住速度');

// ---------- 4. 行为级：把速度控制方法单独跑起来 ----------
const start = uiSrc.indexOf('  UI.prototype.setSpeed = function'), end = uiSrc.indexOf('  // 高峰慢放', start);
assert.ok(start > 0 && end > start, '找到 setSpeed / togglePause / resumeFromJump 实现');
const block = uiSrc.slice(start, end);
const ctx = {
  console, snd() {},
  U: { clamp: (v, a, b) => Math.max(a, Math.min(b, v)) },
  CFG: { time: { speeds: [1, 3, 8, 24] } },
  CM: { Settings: { get: () => null } },
};
vm.createContext(ctx);
const UI = vm.runInContext('(function () { const UI = function () {}; ' + block + ' return UI; })()', ctx, { filename: 'ui-speed-block.js' });

const make = (speed, o = {}) => {
  const u = new UI();
  const g = { speed, jumping: !!o.jumping, prevSpeed: o.prevSpeed, econ: { failed: null }, setSpeed(s) { this.speed = s; } };
  u.g = () => g;
  u.prevSpeed = o.uiPrev || 1;
  u._afterJump = !!o.afterJump;
  u._jumpResumeSpeed = o.jumpResumeSpeed;
  u.closeTimeOptions = () => {};
  u.renderToolbar = () => {};
  u.isSaved = () => true;
  u.scheduleAutosave = () => {};
  u.toast = () => {};
  u.showFailure = () => {};
  u._closed = false;
  u.closeScreen = () => { u._closed = true; };
  u.screen = { classList: { contains: () => !!o.screenHidden }, querySelector: () => (o.report ? {} : null) };
  return { u, g };
};

// 推进结束后：空格收起报告并恢复推进前的倍速
{
  const { u, g } = make(0, { afterJump: true, jumpResumeSpeed: 3, report: true, prevSpeed: 3 });
  u.togglePause();
  assert.equal(g.speed, 3, '推进后空格恢复推进前的 3×');
  assert.equal(u._closed, true, '推进后空格应收起推进报告');
  assert.equal(u._afterJump, false, '待继续状态应消费掉');
  assert.equal(g.jumping, false, '空格不能启动新的时间推进');
}
// 推进前是暂停：沿用玩家上次选的速度
{
  const { u, g } = make(0, { afterJump: true, jumpResumeSpeed: 2, uiPrev: 2, screenHidden: true, prevSpeed: 0 });
  u.togglePause();
  assert.equal(g.speed, 2);
}
// 推进进行中：空格不打断结算
{
  const { u, g } = make(0, { jumping: true, afterJump: false });
  u.togglePause();
  assert.equal(g.speed, 0);
}
// 普通状态：空格仍然是暂停 / 继续
{
  const { u, g } = make(3, { uiPrev: 3 });
  u.togglePause(); assert.equal(g.speed, 0, '运行中按空格暂停');
  u.togglePause(); assert.equal(g.speed, 3, '暂停中按空格恢复上次速度');
}
// 手动改速度会结束「推进后待继续」状态
{
  const { u, g } = make(0, { afterJump: true, jumpResumeSpeed: 4 });
  u.setSpeed(2);
  assert.equal(g.speed, 2);
  assert.equal(u._afterJump, false);
}

// ---------- 5. 英文词条 ----------
for (const k of ['按住鼠标中键左右拖动', '旋转地图；点击指北针可回到全图并转正', '依次切换分析图层（加 Shift 反向）']) {
  assert.ok(enSrc.includes('"' + k + '"'), '英文词典缺少：' + k);
}
assert.ok(enSrc.includes('四档倍速与推进按钮都直接显示'), '帮助页整句英译应同步更新');

console.log('PASS test-time-controls: 空格继续游戏 · 顶栏四档倍速 · 边界与英文词条');
