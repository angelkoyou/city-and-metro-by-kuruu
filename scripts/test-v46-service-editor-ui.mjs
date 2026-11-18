// v4.6 UI 回归：新增交路页面换乘站悬停提示、预留站/停用站停靠过滤、每条交路独立日客流。
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

const task = await fs.mkdtemp(path.join(os.tmpdir(), 'city-metro-st46-')), profile = path.join(task, 'profile');
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
  const shot = async name => { const r = await send('Page.captureScreenshot', { format: 'png' }); await fs.mkdir(path.join(root, 'shots'), { recursive: true }); await fs.writeFile(path.join(root, 'shots', name + '.png'), Buffer.from(r.data, 'base64')); };
  const until = async (exp, ms = 150000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await E(exp)) return; await delay(150); } throw Error('Wait timeout: ' + exp + '\n' + errors.join('\n')); };

  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 980, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/' });
  await until('!!window.CM?.ui&&!!document.querySelector(".start-menu")');
  await E('CM.Settings.set("autosave",false);CM.Settings.set("sound",false);true');
  await E('CM.newGame({map:"gz",mode:"challenge",seed:20261118});true');
  await until('!CM.isLoading()&&!!CM.game&&!CM.game.pending', 180000);
  await until('!!CM.game.model&&(!!CM.game.model.acc||CM.game.model.trafficReady())', 180000);
  await delay(600);
  await E(`(function(){const b=[...document.querySelectorAll('button')].find(x=>/开始规划/.test(x.textContent));if(b)b.click();return true;})()`);
  await delay(300);

  // 建一条五站主线 + 一条在中间站接轨的支线，制造一座真实换乘站；
  // 再把其中一站停用、一站设为预留站，用来验证新增交路的停靠过滤。
  const built = await E(`(()=>{
    const g=CM.game,M=CM.Metro,c=g.city;let base=null;
    for(let dy=-14;dy<=14&&!base;dy++)for(let dx=-14;dx<=14&&!base;dx++){
      const cy=Math.round(c.H/2)+dy,cx=Math.round(c.W/2)+dx;
      const pts=[-8,-4,0,4,8].map(k=>[cx+k,cy]),extra=[cx,cy+4];
      if(pts.concat([extra]).every(p=>M.checkSite(c,p[0],p[1],'underground').ok))base={pts:pts,extra:extra};
    }
    if(!base)return null;
    const l1=M.newLine(g.net),l2=M.newLine(g.net);
    const s=base.pts.map(p=>M.addStation(g.net,p[0],p[1],{size:'M',type:'underground'},c));
    const e=M.addStation(g.net,base.extra[0],base.extra[1],{size:'M',type:'underground'},c);
    for(let k=1;k<s.length;k++)M.addSegment(g.net,l1,s[k-1],s[k],[],'underground');
    M.addSegment(g.net,l2,s[2],e,[],'underground');
    g.net.stations[s[1]].off=1;
    g.net.stations[s[3]].rsv=1;
    g.refreshOperations();
    return {l1:l1,l2:l2,s:s,e:e,off:s[1],rsv:s[3],xfer:s[2]};
  })()`);
  assert.ok(built, '前提：能构造两条线路与换乘站');
  const J = v => JSON.stringify(v);
  const compiled = await E(`(()=>{const C=CM.game.compiled,k=C.sIndex.get(${J(built.xfer)});return {routes:C.routes.filter(r=>r.lineId===${J(built.l1)}).length,lines:C.stationLines[k]?C.stationLines[k].size:0,off:CM.Metro.stationOpen(CM.game.net.stations[${J(built.off)}]),rsv:CM.Metro.stationOpen(CM.game.net.stations[${J(built.rsv)}])}})()`);
  assert.ok(compiled.routes >= 1, '前提：主线有全程交路');
  assert.equal(compiled.lines, 2, '前提：中间站是两线换乘站');
  assert.equal(compiled.off, false); assert.equal(compiled.rsv, false);
  console.log('PASS 0 构造换乘站 + 停用站 + 预留站');

  // ---------------- 1. 新增交路页：停靠站与起讫站排除预留/停用站 ----------------
  await E(`CM.ui.showServiceEditor(${J(built.l1)});true`);
  await until('!!document.querySelector(".fo-sv-stops")');
  const chips = await E(`(()=>[...document.querySelectorAll('.fo-sv-stop')].map(e=>({id:e.getAttribute('data-station'),xfer:e.getAttribute('data-xfer')||'',cls:e.className,text:e.textContent.trim(),tip:e.getAttribute('data-tip')||''})))()`);
  assert.ok(chips.length >= 3, '停靠站里至少还有三座运营中的站');
  assert.ok(!chips.some(c => c.id === built.off || c.id === built.rsv), '预留站与停用站不得出现在停靠选择项里：' + JSON.stringify(chips));
  assert.ok(chips.some(c => c.id === built.xfer), '换乘站仍可停靠');
  const xchip = chips.find(c => c.id === built.xfer);
  assert.ok(xchip.cls.includes('xfer'), '换乘站 chip 带换乘标记');
  assert.ok(xchip.xfer.split(',').includes(built.l2), 'data-xfer 列出可换乘线路');
  const opts = await E(`[...document.querySelectorAll('.fo-sv-row select')].map(s=>[...s.options].map(o=>o.textContent.trim()))`);
  const offName = await E(`CM.game.net.stations[${J(built.off)}].name`), rsvName = await E(`CM.game.net.stations[${J(built.rsv)}].name`);
  assert.ok(opts.length >= 2, '起讫站下拉存在');
  assert.ok(opts.every(list => !list.includes(offName) && !list.includes(rsvName)), '起讫站下拉也不列出预留站与停用站');
  console.log('PASS 1 新增交路停靠站/起讫站排除预留站与停用站');

  // ---------------- 2. 悬停换乘站显示可换乘线路 ----------------
  await E(`(()=>{const e=[...document.querySelectorAll('.fo-sv-stop')].find(x=>x.getAttribute('data-station')===${J(built.xfer)});if(!e)return false;e.dispatchEvent(new MouseEvent('mouseenter',{bubbles:false}));return true;})()`);
  await until('!!document.querySelector(".fo-sv-xfer")');
  const info = await E(`(()=>{const x=document.querySelector('.fo-sv-xfer');return {text:x.textContent.trim(),tags:[...x.querySelectorAll('.tag')].map(t=>t.textContent.trim())}})()`);
  const l2name = await E(`CM.game.net.lines[${J(built.l2)}].name`);
  assert.match(info.text, /本站可换乘/, '悬停提示条写明「本站可换乘」');
  assert.ok(info.text.includes(l2name), '提示条列出可换乘线路名：' + info.text);
  assert.ok(info.tags.length >= 1, '提示条给出带线路色的线路标签');
  await shot('v46-service-editor');
  console.log('PASS 2 悬停换乘站显示可换乘线路');

  // ---------------- 3. 每条交路独立日客流，合计等于线路总客流 ----------------
  await E('CM.ui.closeScreen();true');
  await until('!!(CM.game.model.stDaily&&!CM.game.model.dailyStale)', 240000);
  const riders = await E(`(()=>{const g=CM.game,F=CM.Fleet,lid=${J(built.l1)};const sv=F.serviceRiders(g,lid);let sum=0;for(const v of sv.values())sum+=v;return {n:sv.size,sum:sum,line:F.lineRiders(g,lid)}})()`);
  assert.ok(riders.n >= 1, '至少有一条交路的独立客流');
  assert.ok(Math.abs(riders.sum - riders.line) < 1e-6, '所有交路客流合计 === 线路总客流');
  await E(`CM.ui.openPage("fleet",null,{root:true});true`);
  await until('!!document.querySelector(".fleet-line-tbl")');
  const l1name = await E(`CM.game.net.lines[${J(built.l1)}].name`);
  const fleetText = await E(`(()=>{const t=[...document.querySelectorAll('.fleet-grp')].find(x=>x.textContent.includes(${J(l1name)}));return t?t.parentElement.textContent:''})()`);
  assert.match(fleetText, /日客流/, '车队页显示每条线路与每条交路的日客流');
  console.log('PASS 3 每条交路独立客流 / 合计守恒 / 车队页显示');

  // ---------------- 4. 英文界面新增文案无汉字残留 ----------------
  await E(`CM.ui.showServiceEditor(${J(built.l1)});true`);
  await until('!!document.querySelector(".fo-sv-stops")');
  await E('CM.I18n.apply("en");true');
  await delay(350);
  const enInfo = await E(`(()=>{const x=document.querySelector('.fo-sv-xfer');const b=[...document.querySelectorAll('.fo-sv-stop')][0];return {tip:x?x.textContent.trim():'',chip:b?b.getAttribute('data-tip'):''}})()`);
  assert.ok(!/[\u3400-\u9fff]/.test(enInfo.tip), '英文提示条不残留汉字：' + enInfo.tip);
  await E('CM.I18n.apply("zh-CN");true');
  console.log('PASS 4 英文界面新增交路文案齐全');

  assert.deepEqual(errors, [], '不应有 JS 异常：' + errors.join('\n'));
  console.log('ALL PASS v4.6 UI 新增交路换乘悬停 / 站点过滤 / 交路独立客流');
} finally {
  try { ws && ws.close(); } catch { }
  try { edge.kill(); } catch { }
  try { server.close(); } catch { }
  try { await fs.rm(task, { recursive: true, force: true }); } catch { }
}
