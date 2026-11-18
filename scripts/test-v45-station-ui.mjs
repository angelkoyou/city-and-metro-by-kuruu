// v4.5 UI 回归：车站「是否启用」开关的真实界面行为与状态同步。
// 用隔离 Chromium 跑真实页面，不读写玩家存档。
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

const task = await fs.mkdtemp(path.join(os.tmpdir(), 'city-metro-st45-')), profile = path.join(task, 'profile');
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
  await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/' });
  await until('!!window.CM?.ui&&!!document.querySelector(".start-menu")');
  await E('CM.Settings.set("autosave",false);CM.Settings.set("sound",false);true');
  await E('CM.newGame({map:"gz",mode:"challenge",seed:20261118});true');
  await until('!CM.isLoading()&&!!CM.game&&!CM.game.pending', 180000);
  await until('!!CM.game.model&&(!!CM.game.model.acc||CM.game.model.trafficReady())', 180000);
  await delay(800);
  await E(`(function(){const b=[...document.querySelectorAll('button')].find(x=>/开始规划/.test(x.textContent));if(b)b.click();return true;})()`);
  await delay(400);

  // 找一座已建成、正在服务、非预留的车站；空线网的开局就即时建一条两站线路（只为本测试构造，不写存档）
  const sid = await E(`(()=>{const g=CM.game,M=CM.Metro,c=g.city,C=g.model.net&&g.model.net.C;
    if(C)for(let i=0;i<C.stations.length;i++)if(C.serviced[i]&&!C.stations[i].rsv&&!C.stations[i].off)return C.stations[i].id;
    const spot=function(used){for(let r=0;r<60;r++)for(let dx=-r;dx<=r;dx++)for(let dy=-r;dy<=r;dy++){
      if(Math.max(Math.abs(dx),Math.abs(dy))!==r)continue;
      const x=c.W/2+dx,yy=c.H/2+dy;
      if(!M.checkSite(c,x,yy,'underground').ok)continue;
      if(used.some(p=>Math.hypot(p[0]-x,p[1]-yy)<8))continue;
      return [x,yy];
    }return null;};
    const used=[],p1=spot(used);if(!p1)return null;used.push(p1);const p2=spot(used);
    if(!p1||!p2)return null;
    const lid=M.newLine(g.net);
    const a=M.addStation(g.net,p1[0],p1[1],{size:'M',type:'underground'},c);
    const b=M.addStation(g.net,p2[0],p2[1],{size:'M',type:'underground'},c);
    M.addSegment(g.net,lid,a,b,[],'underground');
    g.refreshOperations();
    return a;})()`);
  assert.ok(sid, '前提：有一座运营中的车站');
  const k = await E(`CM.game.model.net.C.sIndex.get(${JSON.stringify(sid)})`);
  const before = await E(`(()=>{const g=CM.game,C=g.model.net.C;return {serviced:C.serviced[${k}],lines:C.stationLines[${k}].size,tracks:C.stationTracks[${k}].size,upkeep:CM.Metro.stationUpkeepFactor(g.net.stations[${JSON.stringify(sid)}])}})()`);
  assert.equal(before.serviced, true, '前提：车站原本在运营');
  assert.ok(before.tracks >= 1, '前提：车站接了线路');

  // ---------------- 1. 默认启用：车站页显示运营状态条 ----------------
  await E(`CM.ui.openPage("station",${JSON.stringify(sid)},{root:true});true`);
  await until('!!document.querySelector(".st-onoff")');
  const on0 = await E(`(()=>{const b=document.querySelector(".st-onoff");return {text:b.textContent,btn:b.querySelector("button").textContent.trim(),off:b.classList.contains("off"),bad:!!document.querySelector(".tag.bad")}})()`);
  assert.match(on0.text, /车站运营中/, '默认显示「车站运营中」');
  assert.equal(on0.btn, '停用本站');
  assert.equal(on0.off, false, '启用态不带 off 样式');
  console.log('PASS 1 车站页默认显示「车站运营中」');

  // ---------------- 2. 停用：数据、编译、界面同步 ----------------
  await E('document.querySelector(".st-onoff button").click();true');
  await until(`CM.game.net.stations[${JSON.stringify(sid)}].off===1`);
  const off = await E(`(()=>{const g=CM.game,C=g.model.net.C;return {off:g.net.stations[${JSON.stringify(sid)}].off,
    serviced:C.serviced[${k}],lines:C.stationLines[${k}].size,tracks:C.stationTracks[${k}].size,
    upkeep:CM.Metro.stationUpkeepFactor(g.net.stations[${JSON.stringify(sid)}]),
    onoff:(document.querySelector(".st-onoff")||{}).textContent||"",
    btn:(document.querySelector(".st-onoff button")||{}).textContent||"",
    offCls:(document.querySelector(".st-onoff")||{}).classList?.contains("off"),
    tag:[...document.querySelectorAll(".tag")].map(x=>x.textContent).join("|"),
    callout:document.body.textContent.includes("这座车站已停用")}})()`);
  assert.equal(off.serviced, false, '停用后编译结果不再服务本站');
  assert.equal(off.lines, 0, '停用后不提供换乘');
  assert.equal(off.tracks, before.tracks, '停用只是运营开关，轨道结构仍接入');
  assert.equal(off.upkeep, 0, '停用后不再支付日常运营费');
  assert.match(off.onoff, /车站已停用/, '状态条改为「车站已停用」');
  assert.equal(off.btn, '恢复运营', '按钮改为恢复运营');
  assert.equal(off.offCls, true, '停用态带警示样式');
  assert.match(off.tag, /已停用/, '车站标签明确标出停用');
  assert.equal(off.callout, true, '概况页写明停用影响');
  await shot('v45-station-off');
  console.log('PASS 2 停用后停运 / 无换乘 / 免运营费，界面同步反映');

  // ---------------- 3. 恢复运营：一键复原 ----------------
  await E('document.querySelector(".st-onoff button").click();true');
  await until(`!CM.game.net.stations[${JSON.stringify(sid)}].off`);
  const back = await E(`(()=>{const g=CM.game,C=g.model.net.C;return {serviced:C.serviced[${k}],lines:C.stationLines[${k}].size,
    upkeep:CM.Metro.stationUpkeepFactor(g.net.stations[${JSON.stringify(sid)}]),
    onoff:(document.querySelector(".st-onoff")||{}).textContent||"",btn:(document.querySelector(".st-onoff button")||{}).textContent||""}})()`);
  assert.equal(back.serviced, true, '恢复后重新服务');
  assert.equal(back.lines, before.lines, '恢复后换乘线路数复原');
  assert.equal(back.upkeep, 1, '恢复后重新支付运营费');
  assert.match(back.onoff, /车站运营中/);
  assert.equal(back.btn, '停用本站');
  console.log('PASS 3 恢复运营按正式站规则复原');

  // ---------------- 4. 英文界面：停用状态无汉字残留 ----------------
  await E('document.querySelector(".st-onoff button").click();true');
  await until(`CM.game.net.stations[${JSON.stringify(sid)}].off===1`);
  await E('CM.I18n.apply("en");true');
  await delay(350);
  await E(`CM.ui.rerenderPage();true`);
  await until('!!document.querySelector(".st-onoff")');
  const enBar = await E(`(()=>{const b=document.querySelector(".st-onoff");return {text:b.textContent,btn:b.querySelector("button").textContent.trim(),han:/[\\u3400-\\u9fff]/.test(b.textContent)}})()`);
  assert.equal(enBar.han, false, '英文状态条不得残留汉字：' + enBar.text);
  assert.match(enBar.text, /Station closed|closed/i);
  assert.match(enBar.btn, /Reopen/i);
  await E('CM.I18n.apply("zh-CN");true');
  console.log('PASS 4 停用状态英文文案齐全');

  assert.deepEqual(errors, [], '不应有 JS 异常：' + errors.join('\n'));
  console.log('ALL PASS v4.5 UI 车站启用开关 / 停用状态 / 一键恢复 / 英文');
} finally {
  try { ws && ws.close(); } catch { }
  try { edge.kill(); } catch { }
  try { server.close(); } catch { }
  try { await fs.rm(task, { recursive: true, force: true }); } catch { }
}
