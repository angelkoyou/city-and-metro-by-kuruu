// 地图外设施（机场）的接驳口（玩家反馈：新白云机场任务没有地图边缘接驳口）。
// 1) 数据：地图外设施的接驳口必须正好落在地图边缘线上，不能落到图内或图外；
// 2) 定位：点任务卡上的机场、设施页的「定位接驳口」，镜头框到边缘线，高亮圈套在接驳口上，
//    不能再用「设施名标签」把接驳口盖住（之前正是标签压在接驳口上，玩家以为没有接驳口）；
// 3) 绘制：定位后接驳口在画面内、在顶栏下方，没有被提示卡或标签遮挡；
// 4) 「怎么做」：地图外机场的步骤要指向接驳口，并给出「定位接驳口」按钮。
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

const task = await fs.mkdtemp(path.join(os.tmpdir(), 'city-metro-gate-')), profile = path.join(task, 'profile');
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
const errors = [];
let port;
for (let i = 0; i < 100; i++) { try { port = Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; } catch { } await delay(100); }
if (!port) throw Error('No debug port');
const target = await httpJson('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent('about:blank'), 'PUT');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0; const waiting = new Map();
ws.onclose = () => { for (const w of waiting.values()) { clearTimeout(w.timer); w.bad(Error('Browser closed')); } waiting.clear(); };
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id) { const w = waiting.get(m.id); if (w) { clearTimeout(w.timer); waiting.delete(m.id); m.error ? w.bad(Error(JSON.stringify(m.error))) : w.ok(m.result); } }
  else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map(a => a.description || a.value).join(' '));
};
const send = (method, params = {}) => new Promise((ok, bad) => {
  const id = ++seq, timer = setTimeout(() => { waiting.delete(id); bad(Error('CDP timeout ' + method)); }, 120000);
  waiting.set(id, { ok, bad, timer }); ws.send(JSON.stringify({ id, method, params }));
});
const E = async exp => {
  const r = await send('Runtime.evaluate', { expression: exp, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};
const until = async (exp, ms = 180000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await E(exp)) return; await delay(150); } throw Error('Wait timeout: ' + exp + '\n' + errors.join('\n')); };

await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/' });
await until('!!window.CM?.ui&&!!document.querySelector(".start-menu")');
await E('CM.Settings.set("autosave",false);CM.Settings.set("sound",false);true');

let shots = 0;
for (const map of ['gz', 'gz1990', 'bj', 'sh']) {
  await E(`CM.newGame({map:"${map}",mode:"challenge",seed:20261112});true`);
  await until('!CM.isLoading()&&!!CM.game&&!CM.game.pending');
  await until('!!CM.game.model&&(!!CM.game.model.acc||CM.game.model.trafficReady())');
  await delay(900);
  await E(`(function(){const b=[...document.querySelectorAll('button')].find(x=>/开始规划/.test(x.textContent));if(b)b.click();const g=CM.game;g.clock.y=2022;g.clock.m=1;g.econ.cur.y=g.clock.y;g.model.setYear(g.clock.y);g.compiled=CM.Metro.compile(g.net,g.city);g.model.setNetwork(g.compiled);return true;})()`);
  await delay(700);

  // ---------- 1. 接驳口必须在地图边缘线上 ----------
  const geo = await E(`(function(){
    const W=CM.CFG.W,H=CM.CFG.H,out={W:W,H:H,fac:[]};
    for(const f of CM.Fac.list()) if(f.ext){
      const p=CM.Fac.portal(f);
      const onEdge=Math.abs(p.ex)<1e-6||Math.abs(p.ex-(W-1))<1e-6||Math.abs(p.ey)<1e-6||Math.abs(p.ey-(H-1))<1e-6||Math.abs(p.ex-W)<1e-6||Math.abs(p.ey-H)<1e-6;
      out.fac.push({id:f.id,name:f.name,onEdge:onEdge,ex:p.ex,ey:p.ey,x:p.x,y:p.y});
    }
    return out;
  })()`);
  assert.ok(geo.fac.length > 0, map + ' 应有地图外设施');
  for (const f of geo.fac) assert.equal(f.onEdge, true, map + '/' + f.id + ' 的接驳口不在边缘线上：' + JSON.stringify(f));

  // ---------- 2. 定位到接驳口 + 3. 画面里真的画出来了 ----------
  const view = await E(`(function(){
    const f=CM.Fac.list().find(function(x){return !!x.ext;});
    CM.ui.locateFacility(f);
    return {id:f.id, ex:CM.Fac.portal(f).ex, ey:CM.Fac.portal(f).ey};
  })()`);
  // 等镜头飞到接驳口（暂停时帧率不定，按投影位置稳定来判断，而不是只看 cam.fly）
  let prev = null, stable = 0;
  for (let i = 0; i < 60; i++) {
    const cur = await E(`(function(){const q=CM.R.P(${view.ex},${view.ey},0,{});return [Math.round(q.x),Math.round(q.y),!!CM.R.cam.fly];})()`);
    stable = prev && Math.abs(cur[0] - prev[0]) < 2 && Math.abs(cur[1] - prev[1]) < 2 ? stable + 1 : 0;
    prev = cur;
    if (stable >= 2 && !cur[2]) break;
    await delay(200);
  }
  // 还有残影就落到目标位置：动画不是这条测试要检查的东西
  await E('(function(){const c=CM.R.cam;if(c.fly){c.cx=c.fly.tx;c.cy=c.fly.ty;c.zoom=c.fly.tzm;c.fly=null;CM.R.computeTransform&&CM.R.computeTransform();}return true;})()');
  // 暂停时不一定有新帧：先截一张图逼出一帧，再读到接驳口已经画出来为止
  await send('Page.captureScreenshot', { format: 'jpeg', quality: 30 }).catch(() => {});
  await until(`(function(){const p=CM.R._portals||[];return p.some(function(o){return o.f.id==='${view.id}';});})()`, 8000);
  await delay(200);
  const look = await E(`(function(){
    const hl=CM.R.hl, f=CM.Fac.list().find(function(x){return x.id==='${view.id}';});
    const p=CM.Fac.portal(f), R=CM.R, vp=CM.ui.mapViewport();
    const q=R.P(p.ex,p.ey,0,{});
    const g=(R._portals||[]).filter(function(o){return o.f.id===f.id;})[0]||null;
    return {kind:hl&&hl.kind, hx:hl&&hl.x, hy:hl&&hl.y, label:hl&&hl.label?String(hl.label):'',
      sx:Math.round(q.x), sy:Math.round(q.y), vp:{x0:vp.x0,y0:vp.y0,x1:vp.x1,y1:vp.y1},
      drawn:!!g, r:hl&&hl.r, gate:g&&{sx:Math.round(g.sx),sy:Math.round(g.sy)}, cam:{cx:CM.R.cam.cx,cy:CM.R.cam.cy,zoom:CM.R.cam.zoom,fly:!!CM.R.cam.fly},
      card:g&&g.card?{x:Math.round(g.card.x),y:Math.round(g.card.y),w:Math.round(g.card.w),h:Math.round(g.card.h)}:null};
  })()`);
  assert.equal(look.kind, 'circle', map + ' 定位后应高亮一个圆圈');
  const dRing = Math.hypot(look.hx - view.ex, look.hy - view.ey);
  assert.ok(Math.abs(dRing - (look.r || 0)) < 0.05, map + ' 高亮圈应切着接驳口（圆心到接驳口 = 半径），实际 ' + JSON.stringify(look));
  assert.equal(look.label, '', map + ' 定位接驳口时不应再画压住接驳口的名字标签');
  if (!look.drawn) {
    const dbg = await E(`(function(){const R=CM.R,g=CM.game,f=CM.Fac.list().find(function(x){return !!x.ext;});return {layer:R.layer,layerFade:R.layerFade,under:R.cam.under,preview:!!g.preview,ids:(R._portals||[]).map(function(o){return o.f.id;}),fid:f&&f.id,fx:f&&[f.x,f.y],yr:g.clock.y,open:f&&f.open};})()`);
    console.log('DBG ' + map, JSON.stringify(dbg));
  }
  assert.equal(look.drawn, true, map + ' 接驳口应真的画出来');
  assert.ok(look.sy > look.vp.y0 + 30, map + ' 接驳口不应被顶栏盖住：' + JSON.stringify(look));
  assert.ok(look.sy < look.vp.y1 - 20, map + ' 接驳口应在画面内：' + JSON.stringify(look));
  assert.ok(look.sx > look.vp.x0 + 20 && look.sx < look.vp.x1 - 20, map + ' 接驳口应在画面内：' + JSON.stringify(look));
  // 提示卡放在边缘线外侧，不能压住接驳口（南北两侧在上下方，东西两侧在左右方）
  if (look.card) {
    const dx = Math.max(look.card.x - look.sx, 0, look.sx - (look.card.x + look.card.w));
    const dy = Math.max(look.card.y - look.sy, 0, look.sy - (look.card.y + look.card.h));
    assert.ok(Math.hypot(dx, dy) >= 10, map + ' 提示卡不应压住接驳口：' + JSON.stringify(look));
  }

  // ---------- 4. 设施页与「怎么做」都给出接驳口入口 ----------
  const ui = await E(`(function(){
    const f=CM.Fac.list().find(function(x){return !!x.ext;});
    const pg=CM.ui.page_facility(f.id), txt=pg.el.textContent||'';
    const btns=[].slice.call(pg.el.querySelectorAll('button')).map(function(b){return (b.textContent||'').trim();});
    const t={type:'facShare',fac:f.id,target:0.16,title:'测试',progress:{text:'地铁 0%',ok:false}};
    const H=CM.HowTo.task(t,CM.game);
    const steps=H.sections[0].steps.map(function(s){return {what:s.what,acts:(s.acts||[]).map(function(a){return a.label;})};});
    return {hasBtn:btns.indexOf('定位接驳口')>=0, text:txt.indexOf('接驳口')>=0, gateStep:steps.some(function(s){return s.acts.indexOf('定位接驳口')>=0;}), steps:steps.slice(0,3)};
  })()`);
  assert.equal(ui.hasBtn, true, map + ' 设施页应有「定位接驳口」按钮');
  if (map === 'gz') {
    await E(`(function(){CM.ui.openPage('facility','gz_newair');return true;})()`);
    await delay(600);
    const r2 = await send('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(os.tmpdir(), 'cm-gate-facility.png'), Buffer.from(r2.data, 'base64'));
    console.log('shot ' + path.join(os.tmpdir(), 'cm-gate-facility.png'));
  }
  assert.equal(ui.gateStep, true, map + ' 「怎么做」的地图外机场步骤应带「定位接驳口」按钮：' + JSON.stringify(ui.steps, null, 1));
  console.log('PASS ' + map + '：' + geo.fac.map(f => f.name + ' 接驳口 (' + f.ex.toFixed(1) + ', ' + f.ey.toFixed(1) + ')').join('；'));
  if (shots++ === 0) {
    const r = await send('Page.captureScreenshot', { format: 'png', clip: { x: Math.max(0, look.sx - 260), y: Math.max(0, look.sy - 200), width: 520, height: 340, scale: 2 } });
    await fs.writeFile(path.join(os.tmpdir(), 'cm-gate-fix.png'), Buffer.from(r.data, 'base64'));
  }
}

assert.deepEqual(errors, [], '运行期不应有报错：\n' + errors.join('\n'));
console.log('test-ext-portal: all assertions passed');
await send('Browser.close').catch(() => { });
ws.close(); server.close(); edge.kill();
