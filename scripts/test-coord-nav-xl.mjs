// 鼠标坐标条与任务锚点的回归测试。
// 1) 纯逻辑：广州两张地图的阶段目标锚点必须落在同名地名（OSM 拾取）上，否则任务圈会画错地方；
// 2) 真实浏览器：页面底部的坐标条随指针更新，单位与精度写法固定，离开地图后隐藏，切到英文仍是 cells。
import os from 'node:os';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)), process.argv.includes('--dist') ? 'dist' : '');

// ---------------- 1. 任务锚点 ↔ 地名表 ----------------
{
  const CM = { CFG: {} };
  const ctx = { window: { CM }, CM, console };
  vm.createContext(ctx);
  const load = f => vm.runInContext(fsSync.readFileSync(path.join(root, f), 'utf8'), ctx);
  for (const f of ['js/geo_gz.js', 'js/geo_gz1990.js', 'js/geo_gz_fs.js', 'js/data_gz.js', 'js/data_gz1990.js']) load(f);

  // 与 data_*.js 的 PL 一致：同名条目按「地铁站 > 站台 / 路口 > 片区」取一个
  const rank = p => (p[3] === 'station' ? 0 : p[3] === 'stop' ? 1 : 2);
  const index = list => { const m = new Map(); for (const p of list) { const q = m.get(p[0]); if (!q || rank(p) < q.rank) m.set(p[0], { rank: rank(p), x: p[1], y: p[2] }); } return m; };
  const idx = index(CM.GEOS.gz1990.places), idxBig = index(CM.GEO.places);
  const km = (a, b, c, d) => Math.hypot(a - c, b - d) * 0.25;

  const goalOf = (D, id) => D.eras.flatMap(e => e.goals || []).find(g => g.id === id);
  const anchorOf = (g, name) => g.anchors.find(a => a.name === name);

  // 大图：大石画在大石站上（此前取成 23.0040 / 113.3080，落在长隆西侧，离站 2 km）
  const big = CM.DATA, g4 = goalOf(big, 'gz-g4');
  const ds = anchorOf(g4, '大石'), pds = idxBig.get('大石');
  assert.ok(ds && pds, '大图任务里要有「大石」锚点与同名地名');
  assert.ok(km(ds.x, ds.y, pds.x, pds.y) < 0.05, '大石锚点应落在大石站：' + ds.x.toFixed(2) + ',' + ds.y.toFixed(2));
  for (const [goal, name, place] of [['gz-g4', '番禺（市桥）', '市桥'], ['gz-g3', '珠江新城（花城大道）', '珠江新城'], ['gz-g2', '海珠广场', '海珠广场'], ['gz-g1', '老城（公园前）', '公园前']]) {
    const a = anchorOf(goalOf(big, goal), name), p = idxBig.get(place);
    assert.ok(a && p && km(a.x, a.y, p.x, p.y) < 0.05, goal + ' 的「' + name + '」应落在「' + place + '」');
  }

  // 经典图：地名表来自本图，锚点、地标都不能再被大图投影带偏（此前整体南移 39 格）
  const old = CM.DATA_GZ1990, og = goalOf(old, 'gz-g4');
  const ods = anchorOf(og, '大石'), pods = idx.get('大石');
  assert.ok(ods && pods, '经典图任务里要有「大石」锚点与同名地名');
  assert.ok(km(ods.x, ods.y, pods.x, pods.y) < 0.05, '经典图大石锚点应落在本图大石站');
  const zsjnt = old.landmarks.find(l => l.id === 'zsjnt'), pq = idx.get('公园前');
  assert.ok(zsjnt && pq, '经典图要有中山纪念堂地标与公园前地名');
  assert.ok(Math.abs(zsjnt.y - pq.y) < 4, '中山纪念堂应在公园前附近（y 差 ' + (zsjnt.y - pq[1]).toFixed(2) + ' 格约 ' + (zsjnt.y - pq[1]).toFixed(2) + ' 格）');
  assert.ok(zsjnt.y < 60, '经典图地标不能整体南移：中山纪念堂 y=' + zsjnt.y.toFixed(2));
  console.log('PASS 任务锚点与地名表一致');
}

// ---------------- 2. 真实浏览器 ----------------
const candidates = [process.env.CM_BROWSER, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].filter(Boolean);
let browser;
for (const p of candidates) { try { await fs.access(p); browser = p; break; } catch { } }
if (!browser) throw Error('No Chromium browser found. Set CM_BROWSER to its executable path.');

const task = await fs.mkdtemp(path.join(os.tmpdir(), 'city-metro-coord-')), profile = path.join(task, 'profile');
await fs.mkdir(profile);
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    const f = path.resolve(root, '.' + (u.pathname === '/' ? '/index.html' : decodeURIComponent(u.pathname)));
    if (!f.startsWith(root + path.sep)) throw Error('outside');
    const b = await fs.readFile(f);
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' })[path.extname(f)] || 'application/octet-stream');
    res.end(b);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r, j) => server.once('error', j).listen(0, '127.0.0.1', r));

const edge = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + profile], { windowsHide: true, stdio: 'ignore' });
const delay = ms => new Promise(r => setTimeout(r, ms));
const httpJson = (url, method = 'GET') => new Promise((ok, bad) => {
  const u = new URL(url);
  const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method }, res => {
    let b = ''; res.on('data', d => { b += d; }); res.on('end', () => { try { ok(JSON.parse(b)); } catch (e) { bad(e); } });
  });
  req.on('error', bad); req.end();
});
let ws, send;
try {
  let port;
  for (let i = 0; i < 100; i++) { try { port = Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; } catch { } await delay(100); }
  if (!port) throw Error('No debug port');
  const target = await httpJson('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent('about:blank'), 'PUT');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let seq = 0; const waiting = new Map(), errors = [];
  ws.onclose = () => { for (const w of waiting.values()) { clearTimeout(w.timer); w.bad(Error('Browser closed')); } waiting.clear(); };
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id) { const w = waiting.get(m.id); if (w) { clearTimeout(w.timer); waiting.delete(m.id); m.error ? w.bad(Error(JSON.stringify(m.error))) : w.ok(m.result); } }
    else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map(a => a.description || a.value).join(' '));
  };
  send = (method, params = {}) => new Promise((ok, bad) => {
    const id = ++seq, timer = setTimeout(() => { waiting.delete(id); bad(Error('CDP timeout ' + method)); }, 90000);
    waiting.set(id, { ok, bad, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  const E = async exp => {
    const r = await send('Runtime.evaluate', { expression: exp, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  };
  const until = async (exp, ms = 120000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await E(exp)) return; await delay(150); } throw Error('Wait timeout: ' + exp + '\n' + errors.join('\n')); };
  const move = async (x, y) => { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 }); await delay(140); };

  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/' });
  await until('!!window.CM?.ui&&!!document.querySelector(".start-menu")');
  await E('CM.Settings.set("autosave",false);CM.Settings.set("sound",false);true');
  await E('CM.newGame({map:"gz",mode:"challenge",seed:20261111});true');
  await until('!CM.isLoading()&&!!CM.game&&!CM.game.pending');
  // 广州大图开局没有既有线网，等到交通模型就绪即可（不必等站点客流）
  await until('!!CM.game.model.acc||CM.game.model.trafficReady&&CM.game.model.trafficReady()', 300000);
  await delay(2500);
  await E('CM.ui.closeScreen();CM.game.setSpeed(0);CM.ui.toasts.replaceChildren();true');
  await until('!!document.querySelector("#coordBar")');

  const read = () => E(`(()=>{const el=document.querySelector("#coordBar");const cs=getComputedStyle(el);return {hidden:el.classList.contains("hidden"),opacity:+cs.opacity,
    xy:el.querySelector(".cb-xy").textContent,unit:el.querySelector(".cb-unit").textContent,ll:el.querySelector(".cb-ll").textContent,
    rect:(()=>{const r=el.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),bottom:Math.round(innerHeight-r.bottom),right:Math.round(innerWidth-r.right)}})()}})()`);

  assert.equal((await read()).hidden, true, '指针还没进地图时不显示坐标');
  await move(460, 520);
  const a1 = await read();
  assert.equal(a1.hidden, false, '指针进入地图后显示坐标');
  assert.ok(a1.opacity > 0.9, '显示时完整可见');
  assert.match(a1.xy, /^X -?\d+\.\d{1,2} · Y -?\d+\.\d{1,2} 格$/, '格式：X / Y 各带 1–2 位小数，单位「格」');
  assert.match(a1.unit, /^1 格 = 250 m · 精度 0\.\d{1,2} 格 = [\d.]+ m$/, '单位与精度写清楚：' + a1.unit);
  assert.match(a1.ll, /^\d+\.\d{4}°[EW] \d+\.\d{4}°[NS]$/, '同时给出经纬度：' + a1.ll);
  assert.ok(a1.rect.x >= 60 && a1.rect.x <= 110 && a1.rect.bottom >= 40 && a1.rect.bottom <= 120, '坐标条贴在页面左下角、比例尺上方：' + JSON.stringify(a1.rect));
  assert.ok(a1.rect.w < 420, '不会被撑得过宽：' + a1.rect.w);

  // 指针移动 → 数值跟着变，且方向正确：往东 X 变大、往南 Y 变大
  await move(700, 520);
  const a2 = await read();
  const num = s => s.match(/-?\d+\.\d+/g).map(Number);
  assert.ok(num(a2.xy)[0] > num(a1.xy)[0], '往右移动 X 变大');
  await move(700, 700);
  const a3 = await read();
  assert.ok(num(a3.xy)[1] > num(a2.xy)[1], '往下移动 Y 变大');

  // 指针离开地图（移到右侧面板上）→ 隐藏
  await E('CM.ui.openTop("money");true');
  await until('!!document.querySelector("#rightPanel .p-body .sec")');
  await delay(600);
  const rp = await E('(()=>{const el=document.querySelector("#rightPanel .p-body .sec");const r=el.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+12),cls:document.querySelector("#rightPanel").className,tag:(document.elementFromPoint(r.x+r.width/2,r.y+12)||{}).className}})()');
  await move(rp.x, rp.y);
  const off = await read();
  assert.equal(off.hidden, true, '指针在面板上时隐藏，避免显示上一次的位置（点 ' + rp.x + ',' + rp.y + ' 落在 ' + rp.tag + '）');

  // 缩放到很近时精度提高
  await E('CM.ui.closePanel();CM.R.zoomAt(innerWidth/2,innerHeight/2,4);true');
  await delay(500);
  await move(640, 450);
  const deep = await read();
  assert.match(deep.unit, /精度 0\.01 格 = 2\.5 m/, '放大后精度到 0.01 格（2.5 m）：' + deep.unit);

  // 英文界面
  await E('CM.Settings.set("language","en");CM.I18n.apply("en");true');
  await delay(400);
  await move(600, 500);
  const en = await read();
  assert.match(en.xy, /cells$/, '英文下单位是 cells：' + en.xy);
  assert.match(en.unit, /^1 cell = 250 m · precision 0\.\d+ cell = [\d.]+ m$/, '英文下也写明单位与精度：' + en.unit);
  await E('CM.Settings.set("language","zh-CN");CM.I18n.apply("zh-CN");true');
  await delay(300);

  // 截图：坐标条在真实地图上的位置（1280 与 1024 两种宽度，确认不与工具栏 / 悬浮入口重叠）
  await E('CM.ui.closePanel();CM.R.zoomAt(innerWidth/2,innerHeight/2,1/4);true');
  await delay(6000);
  for (const [w, h] of [[1280, 900], [1024, 700]]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await delay(1200);
    await move(Math.round(w * 0.42), Math.round(h * 0.55));
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const out = path.join(os.tmpdir(), 'cm-coord-' + w + '.png');
    await fs.writeFile(out, Buffer.from(shot.data, 'base64'));
    console.log('shot', out);
  }

  assert.deepEqual(errors, [], '浏览器报错：\n' + errors.join('\n'));
  console.log('PASS 坐标条');
} finally {
  try { await send('Browser.close'); } catch { }
  try { ws && ws.close(); } catch { }
  edge.kill();
  server.closeAllConnections();
  await new Promise(r => server.close(r));
  await fs.rm(task, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
}
