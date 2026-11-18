// 更新公告回归（v3.8 起）：保证公告按版本累积、不覆盖旧记录、每条都有英文译文。
// 维护流程：改游戏 → GAME_VERSION 主/次版本 +1 → CM.NEWS 最前插入 6 条 → 补 en.js → 跑本脚本。
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
for (const f of ['js/util.js', 'js/config.js', 'js/news.js', 'js/locales/en.js']) {
  vm.runInContext(await readFile(path.join(root, f), 'utf8'), c, { filename: f });
}
const CFG = c.CM.CFG, NEWS = c.CM.NEWS, EN = c.CM.I18N_EN;
const han = s => /[\u3400-\u9fff]/.test(String(s));
const nums = v => String(v).split('.').map(n => parseInt(n, 10) || 0);
const cmp = (a, b) => { const x = nums(a), y = nums(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; };
const releaseLine = v => String(v || '').split('.').slice(0, 2).join('.');

// ---------------- 1. 结构 ----------------
assert.ok(Array.isArray(NEWS), 'CM.NEWS 必须是数组');
assert.ok(NEWS.length >= 19, '历史公告不能删除：当前只有 ' + NEWS.length + ' 个版本');
const seen = new Set();
for (const n of NEWS) {
  assert.ok(n && typeof n.v === 'string' && /^\d+\.\d+(?:\.\d+)?$/.test(n.v), '版本号格式错误：' + JSON.stringify(n && n.v));
  assert.ok(!seen.has(n.v), '版本号重复：' + n.v); seen.add(n.v);
  assert.match(n.date, /^\d{4}-\d{2}-\d{2}$/, n.v + ' 的日期格式错误');
  assert.ok(!Number.isNaN(Date.parse(n.date)), n.v + ' 的日期无法解析');
  assert.ok(typeof n.title === 'string' && n.title.trim(), n.v + ' 缺少标题');
  assert.ok(Array.isArray(n.items) && n.items.length === 6, n.v + ' 必须正好 6 条摘要（当前 ' + (n.items || []).length + '）');
  for (const t of n.items) {
    assert.equal(typeof t, 'string');
    assert.ok(t.trim().length >= 8, n.v + ' 有过短的摘要：' + JSON.stringify(t));
  }
}

// ---------------- 2. 倒序与日期 ----------------
for (let i = 1; i < NEWS.length; i++) {
  assert.ok(cmp(NEWS[i - 1].v, NEWS[i].v) > 0, '版本必须严格倒序：' + NEWS[i - 1].v + ' 在 ' + NEWS[i].v + ' 之前');
  assert.ok(Date.parse(NEWS[i - 1].date) >= Date.parse(NEWS[i].date), '日期必须随版本递减：' + NEWS[i - 1].v + ' / ' + NEWS[i].v);
}

// ---------------- 3. 与游戏版本一致 ----------------
assert.match(CFG.GAME_VERSION, /^\d+\.\d+(?:\.\d+)?$/, 'GAME_VERSION 格式错误');
assert.equal(releaseLine(CFG.GAME_VERSION), releaseLine(NEWS[0].v), '游戏版本与最新公告的主、次版本必须一致');

// ---------------- 4. 旧记录原样保留 ----------------
const ORIGINAL = [
  ['2.0', '2026-10-22', '建起你的城市地铁网'],
  ['2.1', '2026-10-27', '更多城市，更自由的地铁规划'],
  ['2.2', '2026-10-29', '把机场与新城区连起来'],
  ['2.3', '2026-10-30', '地铁改变城市'],
  ['2.4', '2026-10-31', '北京与更顺手的规划'],
  ['2.5', '2026-11-04', '地铁公司与线网管理'],
];
for (const [v, date, title] of ORIGINAL) {
  const n = NEWS.find(x => x.v === v);
  assert.ok(n, '历史公告被删除：v' + v);
  assert.equal(n.date, date, 'v' + v + ' 的日期被改动');
  assert.equal(n.title, title, 'v' + v + ' 的标题被改动');
  assert.equal(n.items.length, 6, 'v' + v + ' 的条目数被改动');
}
// 2.6–4.1 是本次整理补录的版本，必须连续覆盖，不能跳号丢批次
for (const v of ['2.6', '2.7', '2.8', '2.9', '3.0', '3.1', '3.2', '3.3', '3.4', '3.5', '3.6', '3.7', '3.8', '3.9', '4.0', '4.1']) {
  assert.ok(NEWS.some(n => n.v === v), '缺少版本公告：v' + v);
}

// ---------------- 5. 英文整句齐全 ----------------
const missing = [];
for (const n of NEWS) {
  if (!EN[n.title]) missing.push(n.title);
  for (const t of n.items) if (!EN[t]) missing.push(t.slice(0, 24) + '…');
}
assert.deepEqual(missing, [], '以下公告缺少英文整句词条：\n' + missing.join('\n'));
for (const n of NEWS) {
  assert.ok(!han(EN[n.title]), '公告标题译文残留汉字：' + n.title);
  for (const t of n.items) assert.ok(!han(EN[t]), '公告译文残留汉字：' + t.slice(0, 24));
}

console.log('PASS 更新公告：%d 个版本 / 最新 V%s / 旧记录完整 / 英文 %d 条整句', NEWS.length, NEWS[0].v, NEWS.length * 7);
console.log('ALL PASS v4.1 更新公告累积与词条');
