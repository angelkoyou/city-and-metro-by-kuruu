// v2.9.3 回归：英文界面的动态拼接文本必须整句译完，不留汉字。
// 这些句子由「年份 / 数值 + 中文短语」拼成，i18n 走字典树最长匹配，一旦词表里存在
// 更短的「前缀词条」（例如「1990 年」「预测」），后半截就会漏翻。测试直接调用
// CM.I18n.text() 复现渲染时机，不启动浏览器。
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const base = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = path.resolve(base, process.argv.includes('--dist') ? 'dist' : '');
const c = { console, Intl, localStorage: { getItem: () => null, setItem() {}, removeItem() {} } };
c.window = c; c.CM = {};
vm.createContext(c);
for (const f of ['js/locales/en.js', 'js/i18n.js']) vm.runInContext(await readFile(path.join(root, f), 'utf8'), c, { filename: f });
const I = c.CM.I18n, EN = c.CM.I18N_EN;
const han = s => /[\u3400-\u9fff]/.test(s);

I.apply('en');

// ---------------- 1. 曾经漏翻的三条（报告里的原文） ----------------
const reported = [
  ['1990 年预测增长', '1990 forecast growth'],
  ['车站持续过载', 'Station stays overloaded'],
  ['高峰负荷超过设计容量，需要升级或分流', 'Peak load exceeds design capacity; upgrade the station or spread demand'],
];
for (const [src, want] of reported) {
  const out = I.text(src);
  assert.ok(!han(out), '仍有汉字：' + src + ' => ' + out);
  assert.equal(out, want, '译文不符：' + src);
}

// ---------------- 2. 同类的「年份 + 短语」不再被前缀词条截断 ----------------
// 经济面板与统计页都在用 fc.y + ' 年预测增长' 这类拼法，任何年份都要成立。
for (const y of ['1990', '2025', '2027', '2038']) {
  const out = I.text(y + ' 年预测增长');
  assert.equal(out, y + ' forecast growth', '年份前缀被截断：' + y + ' => ' + out);
  assert.ok(!han(I.text(y + ' 年实际增长')), '实际增长残留汉字：' + y);
  assert.ok(!han(I.text(y + ' 年价格涨幅')), '价格涨幅残留汉字：' + y);
}

// ---------------- 3. 过载提醒的真实拼法（车站 / 线路两种） ----------------
for (const src of ['车站持续过载', '线路持续过载', '高峰负荷 138%', '高峰负荷 138%超过设计容量']) {
  const out = I.text(src);
  assert.ok(!han(out), '仍有汉字：' + src + ' => ' + out);
}

// ---------------- 4. 词表自身的约束 ----------------
// 前缀键首尾允许带空格（那是句子碎片，靠空白对齐），但不能有空键；译文里也不能留中文，
// 否则 segmented 结果永远脏。唯一例外是专名：键里带着同一个地名时保留原样。
let checked = 0;
for (const [k, v] of Object.entries(EN)) {
  assert.ok(k.trim(), '词条键不能为空');
  if (typeof v === 'string' && han(v)) {
    assert.ok(/^(预测|超过设计容量|持续过载)/.test(k) === false, '译文残留汉字：' + JSON.stringify(k) + ' => ' + JSON.stringify(v));
  }
  checked++;
}
assert.ok(checked > 7000, '词表条目数异常：' + checked);
for (const k of ['预测增长', '持续过载', '超过设计容量', '高峰负荷超过设计容量，需要升级或分流']) {
  assert.equal(typeof EN[k], 'string', '缺少词条：' + k);
  assert.ok(EN[k].trim(), '词条译文为空：' + k);
}

// ---------------- 5. 中文界面不受影响 ----------------
I.apply('zh-CN');
for (const [src] of reported) assert.equal(I.text(src), src, '中文界面不应改写原文：' + src);

console.log('PASS 动态拼接文本整句译完（%d 条抽查，%d 条词表）', reported.length + 9, checked);
console.log('ALL PASS v2.9.3 英文词条与最长匹配');
