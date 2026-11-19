// v5.1 作弊设施：铁路客运站 / 汽车客运站。
// 1) 设施建造的类别菜单同时有「铁路客运站」与「汽车客运站」，选中后 facKind 跟着切。
// 2) 单击地图放下汽车客运站：进入设施表与模型，属性面板出现「接驳客流」（不是「出行需求」），
//    周平均接驳 > 0（枢纽按 Fac.pax 计入 OD）。
// 3) 改成铁路客运站：接驳客流保留、面板仍是接驳客流口径；改成商圈后回到「出行需求」。
// 4) 英文界面下工具条与属性面板没有残留汉字；全程无脚本异常。
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

const task = await fs.mkdtemp(path.join(os.tmpdir(), 'city-metro-hub-')), profile = path.join(task, 'profile');
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
try {
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
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/' });
  await until('!!window.CM?.ui&&!!document.querySelector(".start-menu")');
  await E('CM.Settings.set("autosave",false);CM.Settings.set("sound",false);true');
  await E('CM.newGame({map:"bj",mode:"challenge",seed:20261119});true');
  await until('!CM.isLoading()&&!!CM.game&&!CM.game.pending');
  await until('!!CM.game.model&&(!!CM.game.model.acc||CM.game.model.trafficReady())', 240000);
  await delay(1200);
  await E('(function(){const b=[...document.querySelectorAll("button")].find(function(x){return /开始规划/.test(x.textContent);});if(b)b.click();return true;})()');
  await E('CM.ui.closeScreen();true');
  await until('CM.ui.screen.classList.contains("hidden")', 30000);
  await until('!!(CM.game.model.stDaily&&CM.game.model.stDaily.inn&&CM.game.model.stDaily.inn.length)', 240000);
  await E('CM.game.setSpeed(0);CM.ui.toasts.replaceChildren();CM.ui.closePanel(true);true');
  await delay(400);

  // ---------------- 1. 类别菜单 ----------------
  await E('CM.Cheat.set(true);true');
  const menu = await E(`(function(){
    CM.tools.setTool('facbuild');
    CM.ui._toKey=null; CM.ui.renderToolOpts();
    const btns=[...document.querySelectorAll('#toolopts button')].map(function(b){return {t:b.textContent.trim(),tip:b.getAttribute('data-tip')||''};});
    const find=function(n){return btns.find(function(b){return b.t===n;});};
    return {all:btns.map(function(b){return b.t;}),rail:!!find('铁路客运站'),bus:!!find('汽车客运站'),shop:!!find('商圈'),
      busTip:find('汽车客运站')?find('汽车客运站').tip:'',kind:CM.tools.facKind};
  })()`);
  assert.equal(menu.rail, true, '类别菜单要有铁路客运站：' + JSON.stringify(menu.all));
  assert.equal(menu.bus, true, '类别菜单要有汽车客运站：' + JSON.stringify(menu.all));
  assert.equal(menu.shop, true, '原有类别不能丢：' + JSON.stringify(menu.all));
  assert.match(menu.busTip, /枢纽/, '汽车客运站的说明要写明是枢纽：' + menu.busTip);
  assert.match(menu.busTip, /接驳/, '汽车客运站的说明要写明接驳客流：' + menu.busTip);

  // 选中汽车客运站
  const picked = await E(`(function(){
    const b=[...document.querySelectorAll('#toolopts button')].find(function(x){return x.textContent.trim()==='汽车客运站';});
    b.click();
    return {kind:CM.tools.facKind};
  })()`);
  assert.equal(picked.kind, 'bus', '点选汽车客运站后工具类别跟着切');

  // ---------------- 2. 放下汽车客运站 ----------------
  const pick = await E(`(function(){
    const g=CM.game,C=g.model.net.C,list=[];
    for(let i=0;i<C.stations.length;i++){const s=C.stations[i];if(!s||!isFinite(s.x))continue;
      const d=g.model.stDaily.inn[i]+g.model.stDaily.out[i]; if(d>500)list.push({i:i,x:s.x,y:s.y,name:s.name,d:d});}
    list.sort(function(a,b){return a.d-b.d;});
    const best=list[Math.floor(list.length*0.3)];
    return {i:best.i,x:best.x,y:best.y,name:best.name};
  })()`);
  assert.ok(pick && pick.i >= 0, '需要一座有客流的车站');
  const clickAt = async (wx, wy) => E(`(function(){
    const t=CM.tools,p=CM.R.P(${wx},${wy},0);
    const ev={clientX:p.x,clientY:p.y,button:0,shiftKey:false,altKey:false,ctrlKey:false,metaKey:false,pointerType:'mouse',pointerId:1,preventDefault:function(){}};
    t.onDown(ev); t.onUp(ev); return {x:p.x,y:p.y};
  })()`);
  const ver0 = await E('CM.game.model.version'), at0 = await E('CM.game.cheat.readout?CM.game.cheat.readout.at:0');
  await clickAt(pick.x + 0.6, pick.y + 0.6);
  await until('CM.game.cheat.cfacs.length===1', 20000);
  const placed = await E(`(function(){
    const g=CM.game,c=g.cheat.cfacs[0];
    const rp=document.getElementById('rightPanel'), body=rp&&rp.querySelector('.p-body');
    return {t:c.t,pax:c.pax,r:c.r,name:c.name,page:(CM.ui.stack.length?CM.ui.stack[CM.ui.stack.length-1].kind:''),
      text:body?body.textContent:'',tips:[...document.querySelectorAll('.p-body button')].map(function(b){return b.getAttribute('data-tip')||'';}).join(' ')};
  })()`);
  assert.equal(placed.t, 'bus', '放下的是汽车客运站');
  assert.ok(placed.pax > 0, '汽车客运站要带默认接驳客流：' + placed.pax);
  assert.equal(placed.page, 'cfac', '放下后立即打开属性面板');
  assert.match(placed.text, /接驳客流/, '属性面板要有接驳客流：' + placed.text.slice(0, 200));
  assert.doesNotMatch(placed.text, /出行需求/, '枢纽不使用出行需求比例：' + placed.text.slice(0, 200));
  assert.match(placed.text, /万人次\/日/, '接驳客流的单位要写清楚');
  await until('CM.game.model.version>' + ver0, 20000);
  await until('CM.game.cheat.readout&&CM.game.cheat.readout.at>' + at0 + '&&CM.game.model.settled&&!CM.game.model.dailyStale', 180000);
  const demand = await E(`(function(){
    const g=CM.game,c=g.cheat.cfacs[0],i=g.model.facIndex(c.id),st=i>=0?g.model.facStats(c.id,'avg'):null;
    const f=CM.Fac.byId(c.id);
    return {inModel:i>=0,vol:st?st.inn+st.out:0,metro:st?st.innM+st.outM:0,
      pax:CM.Fac.pax(f,g.year()),share:CM.Fac.share(f,g.year()),hub:!!f.T.hub,size:CM.Fac.sizeText(f,g.year())};
  })()`);
  assert.equal(demand.inModel, true, '汽车客运站要进入模型');
  assert.equal(demand.hub, true, '设施表里是枢纽');
  assert.equal(demand.pax, placed.pax * 1e4, '接驳客流按万人次/日换算：' + demand.pax);
  assert.equal(demand.share, 0, '枢纽不按占全市比例吸引');
  assert.match(demand.size, /万人次\/日/, '参考规模按接驳客流写：' + demand.size);
  assert.ok(demand.vol > 0, '汽车客运站要有接驳客流：' + demand.vol);
  assert.ok(demand.metro > 0, '接驳客流里要有地铁承担的部分：' + demand.metro);

  // ---------------- 3. 改成铁路客运站：同一套接驳口径 ----------------
  const rail = await E(`(function(){
    const g=CM.game,c=g.cheat.cfacs[0];
    CM.Cheat.setFac(g,c.id,{t:'rail'});
    return {t:c.t,pax:c.pax};
  })()`);
  assert.equal(rail.t, 'rail', '类别可改为铁路客运站');
  assert.equal(rail.pax, placed.pax, '两类之间互换保留接驳客流');
  await delay(1800);
  const railPage = await E(`(function(){
    const g=CM.game,c=g.cheat.cfacs[0],f=CM.Fac.byId(c.id);
    const rp=document.getElementById('rightPanel'), body=rp&&rp.querySelector('.p-body');
    return {t:f.t,hub:!!f.T.hub,pax:CM.Fac.pax(f,g.year()),text:body?body.textContent:''};
  })()`);
  assert.equal(railPage.t, 'rail', '设施表里的类别跟着改');
  assert.equal(railPage.pax, placed.pax * 1e4, '铁路客运站与汽车客运站口径相同：' + railPage.pax);
  assert.match(railPage.text, /接驳客流/, '换成铁路客运站后仍是接驳客流面板');

  // ---------------- 4. 改回商圈：恢复出行需求 ----------------
  const shop = await E(`(function(){
    const g=CM.game,c=g.cheat.cfacs[0];
    CM.Cheat.setFac(g,c.id,{t:'shop'});
    CM.ui.rerenderPage();
    const rp=document.getElementById('rightPanel'), body=rp&&rp.querySelector('.p-body');
    return {t:c.t,pax:c.pax,text:body?body.textContent:''};
  })()`);
  assert.equal(shop.t, 'shop', '类别可改回普通设施');
  assert.equal(shop.pax, 0, '普通设施没有接驳客流');
  assert.match(shop.text, /出行需求/, '普通设施要用出行需求：' + shop.text.slice(0, 200));

  // ---------------- 5. 英文界面 ----------------
  await E(`(function(){
    const g=CM.game,c=g.cheat.cfacs[0];
    CM.Cheat.setFac(g,c.id,{t:'bus',pax:3});
    CM.ui.rerenderPage(); CM.I18n.apply('en'); CM.ui._toKey=null; CM.ui.renderToolOpts(); CM.ui.rerenderPage();
    return true;
  })()`);
  await delay(600);
  const en = await E(`(function(){
    const han=/[\\u3400-\\u9fff]/;
    const opts=document.querySelector('#toolopts').textContent||'';
    const tips=[...document.querySelectorAll('#toolopts button')].map(function(b){return b.getAttribute('data-tip')||'';}).join(' ');
    const rp=document.getElementById('rightPanel'), body=(rp&&rp.querySelector('.p-body')||{}).textContent||'';
    return {opts:opts.slice(0,400),body:body.slice(0,400),len:body.length,
      bad:han.test(opts)||han.test(tips)||han.test(body),
      hasCoach:/Coach terminal/i.test(opts),hasRail:/Passenger Railway Station/i.test(opts)};
  })()`);
  assert.ok(en.len > 40, '英文界面下属性面板要正常渲染：' + JSON.stringify(en).slice(0, 300));
  assert.equal(en.hasCoach, true, '英文类别名要出现 Coach terminal：' + en.opts);
  assert.equal(en.hasRail, true, '英文类别名要出现 Passenger Railway Station：' + en.opts);
  assert.equal(en.bad, false, '英文界面残留汉字：' + JSON.stringify(en).slice(0, 600));
  await E('CM.I18n.apply("zh-CN");true');

  assert.deepEqual(errors, [], '控制台不应有异常：' + errors.join('\n'));
  console.log('PASS v5.1 hub facility UI: both categories in the build menu, coach terminal placed via click → hub demand > 0 with metro share, switching to railway keeps the same connection basis, switching to retail restores trip demand, English UI clean');
} finally {
  try { edge.kill(); } catch { }
  server.close();
  await fs.rm(task, { recursive: true, force: true }).catch(() => { });
}
