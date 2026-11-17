// 任务锚点体检：把每座城市（含广州大图 gz 与经典图 gz1990）的阶段目标、历史任务、策略难题的锚点，
// 与本地图自带的地名表（CM.GEO.places，OSM 拾取）逐一对照，报告偏差。
//
// 用法：node scripts/audit-task-anchors.mjs           只报告，不判失败
//      node scripts/audit-task-anchors.mjs --strict  偏差超过阈值即退出码 1（回归测试用）
//
// 判定：锚点名去掉括号注释（「番禺（市桥）」→「番禺」）后若能在地名表里找到同名条目，
// 就按「锚点 ↔ 同名地名」算直线距离；同名条目有多条（同名路口 / 站台）时取最近的一条。
// 阈值：一般锚点 0.6 km（2.4 格），带半径的大范围锚点（r ≥ 5 格）放宽到 1.5 km。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

function loadCM(files, preset) {
  const CM = Object.assign({ CFG: {} }, preset || {});
  const ctx = { window: { CM }, CM, console };
  vm.createContext(ctx);
  for (const f of files) vm.runInContext(read(f), ctx);
  return CM;
}

const CELL_M = 250;
// 锚点名 → 候选地名：「番禺（市桥）」先试括号内的「市桥」（更具体），再试「番禺」；「广州火车站一带」去掉「一带」
const strip = s => String(s).replace(/(一带|附近|周边)$/g, '').trim();
const candidates = function (name) {
  const inner = /[（(](.*?)[）)]/.exec(name);
  const out = [];
  if (inner) out.push(strip(inner[1]));
  out.push(strip(name.replace(/[（(].*?[）)]/g, '')));
  out.push(strip(name));
  return [...new Set(out.filter(Boolean))];
};
const km = (a, b, c, d) => Math.hypot(a - c, b - d) * CELL_M / 1000;
// 阈值随锚点半径放宽：一般 0.6 km，半径 ≥ 4 格 1.0 km，≥ 5 格 1.5 km
const limitOf = r => (r >= 5 ? 1.5 : r >= 4 ? 1.0 : 0.6);

function placeIndex(geo) {
  const idx = new Map();
  for (const p of (geo && geo.places) || []) {
    const nm = p[0];
    if (!idx.has(nm)) idx.set(nm, []);
    idx.get(nm).push([p[1], p[2], p[3]]);
  }
  return idx;
}
function nearest(idx, name, x, y) {
  const list = idx.get(name);
  if (!list || !list.length) return null;
  let best = null;
  for (const q of list) { const d = km(x, y, q[0], q[1]); if (!best || d < best.d) best = { d, x: q[0], y: q[1], kind: q[2] }; }
  return best;
}

function tasksOf(D) {
  const out = [];
  for (const e of (D && D.eras) || []) for (const g of e.goals || []) out.push({ group: e.name, id: g.id, title: g.title, anchors: g.anchors || [] });
  for (const t of (D && D.histTasks) || []) out.push({ group: '历史任务', id: t.id, title: t.title, anchors: t.anchors || [] });
  for (const t of (D && D.scenarios) || []) out.push({ group: '策略难题', id: t.id, title: t.title, anchors: t.anchors || [] });
  return out;
}

const MAPS = [
  { id: 'gz', label: '广州（60×48 km 大图）', files: ['js/geo_gz.js', 'js/data_gz.js'], data: CM => CM.DATA, geo: CM => CM.GEO },
  { id: 'gz1990', label: '广州·佛山（168×144 经典图）', files: ['js/geo_gz.js', 'js/geo_gz1990.js', 'js/geo_gz_fs.js', 'js/data_gz.js', 'js/data_gz1990.js'], data: CM => CM.DATA_GZ1990, geo: CM => CM.GEOS.gz1990 },
];

const strict = process.argv.includes('--strict');
let bad = 0, checked = 0, skipped = 0;

for (const m of MAPS) {
  const CM = loadCM(m.files);
  const D = m.data(CM), geo = m.geo(CM), idx = placeIndex(geo);
  console.log('\n=== ' + m.label + ' ===');
  const rows = [];
  for (const t of tasksOf(D)) {
    for (const a of t.anchors) {
      if (!a || !isFinite(a.x) || !isFinite(a.y)) continue;
      checked++;
      // 标签里可能有两个地名（如「番禺（市桥）」），取离锚点最近的那个比对
      let hit = null, used = '';
      for (const c of candidates(a.name)) {
        const n = nearest(idx, c, a.x, a.y);
        if (n && (!hit || n.d < hit.d)) { hit = n; used = c; }
      }
      if (!hit) { skipped++; rows.push({ t, a, d: null, note: '地名表无同名条目，跳过' }); continue; }
      const lim = limitOf(a.r);
      if (hit.d > lim) bad++;
      rows.push({ t, a, d: hit.d, lim, note: used === strip(String(a.name)) ? '' : '按「' + used + '」比对' });
    }
  }
  for (const r of rows) {
    const flag = r.d == null ? '  · ' : (r.d > r.lim ? '  ✗ ' : '  ✓ ');
    const d = r.d == null ? '   —   ' : r.d.toFixed(2).padStart(5) + ' km';
    console.log(flag + (r.t.id + '            ').slice(0, 12) + (r.a.name + '                    ').slice(0, 20) + ' (' + r.a.x.toFixed(1) + ', ' + r.a.y.toFixed(1) + ')  ' + d + '  ' + r.note);
  }
}

console.log('\n共检查 ' + checked + ' 个锚点，偏差超阈值 ' + bad + ' 个，无同名地名可对照 ' + skipped + ' 个。');
if (strict && bad) { console.error('任务锚点与地名表不一致，请修正 data_*.js 中的坐标。'); process.exit(1); }
