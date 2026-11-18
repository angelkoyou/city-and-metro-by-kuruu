// v4.7 UI 回归：窄屏下「列车运营」交路卡片的标题排版——交路名独占一行、指标标签另起一行。
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

const task = await fs.mkdtemp(path.join(os.tmpdir(), 'city-metro-st47-')), profile = path.join(task, 'profile');
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
  // 用户截图就是窄侧栏宽度：直接按 420px 视口验证
  await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/' });
  await until('!!window.CM?.ui&&!!document.querySelector(".start-menu")');
  await E('CM.Settings.set("autosave",false);CM.Settings.set("sound",false);true');
  await E('CM.newGame({map:"gz",mode:"free",seed:20261118});true');
  await until('!CM.isLoading()&&!!CM.game&&!CM.game.pending', 180000);
  await delay(600);
  await E(`(function(){const b=[...document.querySelectorAll('button')].find(x=>/开始规划/.test(x.textContent));if(b)b.click();return true;})()`);
  await delay(300);

  const lid = await E(`(()=>{
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
    g.net.lines[l].name='11 号线（顺行）';
    g.refreshOperations();
    return l;
  })()`);
  assert.ok(lid, '前提：能构造一条五站线路');
  await delay(400);

  await E(`CM.ui.openObj('line',${JSON.stringify(lid)},'ops');true`);
  await until('!!document.querySelector(".fo-svc-h")');
  await delay(400);
  await E(`(()=>{const e=document.querySelector('.fo-svc');if(e)e.scrollIntoView({block:'center'});return true;})()`);
  await delay(200);

  const m = await E(`(()=>{
    const card=document.querySelector('.fo-svc'),h=card.querySelector('.fo-svc-h'),b=h.querySelector('b'),meta=card.querySelector('.fo-svc-meta');
    const cr=card.getBoundingClientRect(),br=b.getBoundingClientRect();
    return {cardW:Math.round(cr.width),nameW:Math.round(br.width),nameH:Math.round(br.height),name:b.textContent.trim(),
      headTags:h.querySelectorAll('.tag').length,metaTags:meta?meta.querySelectorAll('.tag').length:0,
      metaTop:meta?Math.round(meta.getBoundingClientRect().top):0,nameBottom:Math.round(br.bottom)};
  })()`);
  assert.equal(m.name, '11 号线（顺行）', '交路名完整显示');
  assert.equal(m.headTags, 0, '名称行不再混入指标标签');
  assert.ok(m.metaTags >= 2, '指标标签移到独立的一行');
  assert.ok(m.nameH <= 24, '交路名保持单行高度（不被挤成竖排）：' + JSON.stringify(m));
  assert.ok(m.nameW > m.cardW * 0.6, '交路名占满整行宽度：' + JSON.stringify(m));
  assert.ok(m.metaTop >= m.nameBottom - 2, '指标行位于名称行下方');
  console.log('PASS 1 交路名独占一行，指标标签另起一行');

  // 长自定义名称：名称行内自然折行，不挤压标签，也不溢出卡片
  await E(`(()=>{const g=CM.game;g.net.lines[${JSON.stringify(lid)}].name='十一号线大站快车（顺行）';g.refreshOperations();return true;})()`);
  await delay(500);
  await E(`CM.ui.openObj('line',${JSON.stringify(lid)},'ops');true`);
  await until('!!document.querySelector(".fo-svc-h")');
  await delay(300);
  const long = await E(`(()=>{const card=document.querySelector('.fo-svc'),b=card.querySelector('.fo-svc-h b'),meta=card.querySelector('.fo-svc-meta');
    const cr=card.getBoundingClientRect(),br=b.getBoundingClientRect(),mr=meta.getBoundingClientRect();
    return {cardW:Math.round(cr.width),nameW:Math.round(br.width),nameH:Math.round(br.height),nameRight:Math.round(br.right),cardRight:Math.round(cr.right),metaTop:Math.round(mr.top),nameBottom:Math.round(br.bottom)};})()`);
  assert.ok(long.nameH <= 24, '13 字名称在 366px 侧栏里仍是一行：' + JSON.stringify(long));
  assert.ok(long.nameRight <= long.cardRight + 1, '名称不溢出卡片');
  assert.ok(long.metaTop >= long.nameBottom - 2, '长名称下指标行仍在下方');
  console.log('PASS 2 长交路名不溢出、不挤压指标行');

  const clip = await E(`(()=>{const r=document.querySelector('.fo-svc').getBoundingClientRect();const x=Math.max(0,Math.round(r.x-6)),y=Math.max(0,Math.round(r.y-6));return {x:x,y:y,width:Math.min(Math.round(r.width+12),420-x),height:Math.min(Math.round(r.height+12),900-y),scale:1};})()`);
  await shot('v47-ops-header', clip);
  console.log('PASS 3 截图 shots/v47-ops-header.png');

  assert.deepEqual(errors, [], '不应有 JS 异常：' + errors.join('\n'));
  console.log('ALL PASS v4.7 交路卡片标题排版');
} finally {
  try { ws && ws.close(); } catch { }
  try { edge.kill(); } catch { }
  try { server.close(); } catch { }
  try { await fs.rm(task, { recursive: true, force: true }); } catch { }
}
