// v4.8 UI 回归：停用车站后，运营路线、列车动画与调度都把它当作不存在。
// 隔离 Chromium + 临时 profile + 本地 http，不读写玩家存档。
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)), process.argv.includes('--dist') ? 'dist' : '');
const candidates = [process.env.CM_BROWSER, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].filter(Boolean);
let browser;
for (const p of candidates) { try { await fs.access(p); browser = p; break; } catch { } }
if (!browser) throw Error('No Chromium browser found. Set CM_BROWSER to its executable path.');

const task = await fs.mkdtemp(path.join(os.tmpdir(), 'city-metro-st48-')), profile = path.join(task, 'profile');
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
const errors = [];
try {
  let port;
  for (let i = 0; i < 100; i++) { try { port = Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; } catch { } await delay(100); }
  if (!port) throw Error('No debug port');
  const target = await httpJson('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent('http://127.0.0.1:' + server.address().port + '/'), 'PUT');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let seq = 0; const waiting = new Map();
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
  const shot = async (name, clip) => {
    const r = await send('Page.captureScreenshot', clip ? { format: 'png', clip, captureBeyondViewport: false } : { format: 'png' });
    await fs.mkdir(path.join(root, 'shots'), { recursive: true });
    await fs.writeFile(path.join(root, 'shots', name + '.png'), Buffer.from(r.data, 'base64'));
  };
  const until = async (exp, ms = 150000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await E(exp)) return; await delay(150); } throw Error('Wait timeout: ' + exp + '\n' + errors.join('\n')); };

  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 940, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/' });
  await until('!!window.CM?.ui&&!!document.querySelector(".start-menu")');
  await E('CM.Settings.set("autosave",false);CM.Settings.set("sound",false);true');
  await E('CM.newGame({map:"gz",mode:"free",seed:20261118});true');
  await until('!CM.isLoading()&&!!CM.game&&!CM.game.pending', 180000);
  await delay(600);
  await E(`(function(){const b=[...document.querySelectorAll('button')].find(x=>/开始规划/.test(x.textContent));if(b)b.click();return true;})()`);
  await delay(300);

  const built = await E(`(()=>{
    const g=CM.game,M=CM.Metro,c=g.city;let base=null;
    for(let dy=-14;dy<=14&&!base;dy++)for(let dx=-14;dx<=14&&!base;dx++){
      const cy=Math.round(c.H/2)+dy,cx=Math.round(c.W/2)+dx;
      const pts=[-8,-4,0,4,8].map(k=>[cx+k,cy]);
      if(pts.every(p=>M.checkSite(c,p[0],p[1],'underground').ok))base=pts;
    }
    if(!base)return null;
    const l=M.newLine(g.net);
    const s=base.map(p=>M.addStation(g.net,p[0],p[1],{size:'M',type:'underground'},c));
    for(let k=1;k<s.length;k++)M.addSegment(g.net,l,s[k-1],s[k],[],'underground');
    g.refreshOperations();
    return {lid:l,s:s};
  })()`);
  assert.ok(built, '前提：能构造五站线路');
  await delay(500);
  await until('!!CM.game.model.net&&CM.game.model.net.R===1', 120000);

  const before = await E(`(()=>{const g=CM.game,C=g.compiled,rt=C.routes[0],n=g.model.net;
    return {st:rt.stIds.length,legs:rt.legSec.length,nStops:rt.nStops,cycle:Math.round(rt.cycleSec),board:n.boardEdge[0].length,
      serviced:!!C.serviced[C.sIndex.get(${JSON.stringify(built.s[2])})]};})()`);
  assert.equal(before.st, 5, '基线：五站');
  assert.equal(before.legs, 4, '基线：四个区间');
  assert.equal(before.serviced, true, '基线：中间站服务中');

  // 停用中间站：游戏内即时生效
  await E(`CM.game.setStationEnabled(${JSON.stringify(built.s[2])},false);true`);
  await delay(700);
  await until(`CM.game.compiled.routes[0].stIds.length===${before.st - 1}`, 120000);
  const mid = await E(`(()=>{const g=CM.game,C=g.compiled,rt=C.routes[0],n=g.model.net;
    const a=CM.agents; a.syncNetwork(n);
    const gs=[...a.groups.values()][0];
    return {st:rt.stIds.length,legs:rt.legSec.length,cycle:Math.round(rt.cycleSec),board:n.boardEdge[0].length,
      has:(rt.stIds||[]).indexOf(${JSON.stringify(built.s[2])})>=0,
      tracks:C.stationTracks[C.sIndex.get(${JSON.stringify(built.s[2])})].size,
      routes:C.stationRoutes[C.sIndex.get(${JSON.stringify(built.s[2])})].length,
      serviced:!!C.serviced[C.sIndex.get(${JSON.stringify(built.s[2])})],
      animLegs:gs?gs.legs.length:0,animCycle:gs?Math.round(gs.cycle):0};})()`);
  assert.equal(mid.has, false, '停用站不在运营路线的站点表里');
  assert.equal(mid.st, 4, '运营站减少到四座');
  assert.equal(mid.legs, 3, '跨站区间合并为三段');
  assert.equal(mid.board, 4, '上下客边只剩四座可停靠站');
  assert.equal(mid.animLegs, 6, '动画只保留 4 站的往返区段（不再停靠停用站）');
  assert.ok(Math.abs(mid.animCycle - mid.cycle) < 1, '动画循环时长与运营周转时间一致');
  assert.ok(mid.cycle < before.cycle, '少停一站后周转时间变短');
  assert.equal(mid.tracks, 1, '轨道结构仍接在这条线上');
  assert.equal(mid.routes, 0, '停用站没有停靠路线');
  assert.equal(mid.serviced, false, '停用站不计服务覆盖');
  console.log('PASS 1 停用中间站：路线跳过、区间合并、动画不停、统计排除');

  // 终点站停用：折返点前移，界面上的交路名称与运行计划同步
  await E(`CM.game.setStationEnabled(${JSON.stringify(built.s[4])},false);true`);
  await delay(700);
  await until(`!CM.game.compiled.routes[0].stIds.includes(${JSON.stringify(built.s[4])})`, 120000);
  const term = await E(`(()=>{const g=CM.game,C=g.compiled,rt=C.routes[0];
    return {last:rt.stIds[rt.stIds.length-1],closed:(rt.closedEnds||[]).slice(),st:rt.stIds.length};})()`);
  assert.equal(term.last, built.s[3], '折返点前移到上一座可停靠站');
  assert.equal(term.closed.length, 1, '记录停用的原终点站');
  assert.equal(term.closed[0], built.s[4]);
  await E(`CM.ui.openObj('line',${JSON.stringify(built.lid)},'ops');true`);
  await until('!!document.querySelector(".fo-svc-h")');
  await delay(300);
  const card = await E(`(()=>{const c=document.querySelector('.fo-svc'),t=c?c.textContent:'';return {has:!!c,tags:[...c.querySelectorAll('.tag')].map(x=>x.textContent).join('|'),text:t.slice(0,80)};})()`);
  assert.ok(card.has, '列车运营页正常打开');
  await E(`(()=>{const e=[...document.querySelectorAll('.fo-svc')].find(x=>x.offsetParent);if(e)e.scrollIntoView({block:'center'});return true;})()`);
  await delay(300);
  await shot('v48-station-off');
  console.log('PASS 2 停用终点站：折返点前移 + 运行计划同步，截图 shots/v48-station-off.png');

  assert.deepEqual(errors, [], '不应有 JS 异常：' + errors.join('\n'));
  console.log('ALL PASS v4.8 UI 停用站从停靠、动画与调度中排除');
} finally {
  try { ws && ws.close(); } catch { }
  try { edge.kill(); } catch { }
  try { server.close(); } catch { }
  try { await fs.rm(task, { recursive: true, force: true }); } catch { }
}
