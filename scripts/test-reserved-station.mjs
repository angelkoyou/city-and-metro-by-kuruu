// 预留站（v2.8.3）回归测试。
// 1) 计价：建筑费 = 正式站 1/5；拆迁补偿与正式站同额（不打折）；维护费同比例；升级只补 4/5、不重复收拆迁
// 2) 功能：可以接轨（建站与绘线两条路径一致），但编译后不服务（无站台）、不能作为换乘站；升级后开始服务
// 3) 界面：建站工具坞有「预留」入口与 Ctrl 提示；Ctrl+点击建站、Ctrl+绘线建站都能建出预留站；车站页有标记与「补建为正式站」按钮
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

const task = await fs.mkdtemp(path.join(os.tmpdir(), 'city-metro-rsv-')), profile = path.join(task, 'profile');
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
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/' });
  await until('!!window.CM?.ui&&!!document.querySelector(".start-menu")');
  await E('CM.Settings.set("autosave",false);CM.Settings.set("sound",false);true');
  await E('CM.newGame({map:"gz",mode:"challenge",seed:20261112});true');
  await until('!CM.isLoading()&&!!CM.game&&!CM.game.pending');
  await until('!!CM.game.model&&(!!CM.game.model.acc||CM.game.model.trafficReady())');
  await delay(1200);
  await E(`(function(){const b=[...document.querySelectorAll('button')].find(x=>/开始规划/.test(x.textContent));if(b)b.click();return true;})()`);
  await delay(600);

  // ---------------- 1. 纯逻辑：计价、拦截、编译 ----------------
  const report = await E(`(function(){
    const g=CM.game, M=CM.Metro, city=g.city, y=g.clock.y, CFG=CM.CFG;
    const out={};
    // 找一个可建站的空地（从地图中心向外找）；两点间隔足够避免站距冲突
    const spot=function(used){
      for(let r=0;r<60;r++)for(let dx=-r;dx<=r;dx++)for(let dy=-r;dy<=r;dy++){
        if(Math.max(Math.abs(dx),Math.abs(dy))!==r)continue;
        const x=city.W/2+dx, yy=city.H/2+dy;
        if(!M.checkSite(city,x,yy,'underground').ok)continue;
        if(used.some(p=>Math.hypot(p[0]-x,p[1]-yy)<8))continue;
        return [x,yy];
      }
      return null;
    };
    const used=[];
    const p1=spot(used); used.push(p1);
    const p2=spot(used); used.push(p2);
    const p3=spot(used); used.push(p3);
    out.p1=p1; out.p2=p2; out.p3=p3;
    if(!p1||!p2||!p3) throw Error('找不到可建站的空地');
    const mk=function(pt,reserved){
      let id=null;
      const r=g.edit(function(n){ id=M.addStation(n,pt[0],pt[1],{size:'M',type:'underground',reserved:reserved?1:0},city); return {}; });
      if(r&&r.error) throw Error(r.error);
      return id;
    };
    const rm=function(id){ g.edit(function(n){ M.removeStation(n,id); return {}; }); };
    const evalNow=function(){ return M.evaluate(g.draft?g.draft.net:g.net,g.net,city,y); };
    const itemOf=function(ev,kind,nameSub){ return ev.items.filter(function(i){ return i.kind===kind&&i.label.indexOf(nameSub)>=0; }); };
    const sum=function(a){ return a.reduce(function(s,i){ return s+i.amount; },0); };

    const full=M.stationCost('underground','M',y), rsvCost=M.reservedCost('underground','M',y);
    out.full=full; out.rsvCost=rsvCost;

    // A. 预留站：建筑费 1/5，拆迁按正式站标准
    const a=mk(p1,true);
    const stA=g.draft.net.stations[a];
    out.rsvFlag=stA.rsv===1;
    out.nameA=stA.name;
    let ev=evalNow();
    out.aBuild=sum(itemOf(ev,'construction',stA.name));
    out.aDem=sum(itemOf(ev,'demolition',stA.name));
    out.aTotal=ev.total;
    // 维护费系数
    out.aUpkeep=M.stationUpkeepFactor(stA);
    // 预留站可以接轨（v2.8.3）；两座正式站之间也可以。接轨不等于停靠：编译后仍不服务
    g.edit(function(n){ n.lines.__t={id:'__t',name:'测试线',color:'#336699',stations:[],segs:[]}; return {}; });
    const b0=mk(p2,false), b1x=mk(p3,false);
    out.rsvSegErr=M.addSegment(g.draft.net,'__t',a,b0).error||null;
    out.okSeg=!M.addSegment(g.draft.net,'__t',b0,b1x).error;
    {
      const CR=M.compile(g.draft.net,city), kr=CR.sIndex.get(a);
      out.rsvServiced=!!CR.serviced[kr];
      out.rsvLines=CR.stationLines[kr].size;
      out.rsvRoutes=CR.stationRoutes[kr].length;
      out.rsvTracks=CR.stationTracks[kr].size;
    }
    // 先接轨、后升级：清掉预留标记后，同一段轨道应立刻开始停靠
    g.edit(function(n){ delete n.stations[a].rsv; return {}; });
    {
      const CU=M.compile(g.draft.net,city), ku=CU.sIndex.get(a);
      out.wiredUpServiced=!!CU.serviced[ku];
      out.wiredUpRoutes=CU.stationRoutes[ku].length;
    }
    g.edit(function(n){ n.stations[a].rsv=1; return {}; });
    // 清掉测试线（避免影响后面的编译与服务判定）
    g.edit(function(n){ for(const k in n.segments) if(n.segments[k].line==='__t') delete n.segments[k]; delete n.lines.__t; return {}; });
    rm(a); rm(b0); rm(b1x);
    // B. 同位置的正式站：拆迁金额应与预留站一致
    const a2=mk(p1,false);
    const stB=g.draft.net.stations[a2];
    ev=evalNow();
    out.bBuild=sum(itemOf(ev,'construction',stB.name));
    out.bDem=sum(itemOf(ev,'demolition',stB.name));
    rm(a2);

    // C. 已建成的预留站升级：补交 4/5，拆迁不重复收
    const a3=mk(p1,true);
    const cf=g.confirmDraft();
    if(cf&&cf.ok===false) throw Error('确认建设失败：'+cf.reason);
    const stC=g.net.stations[a3];
    out.builtRsv=!!stC.rsv;
    // 建成后的预留站：维护费 1/5、不服务、无线路（不能换乘）
    const C0=g.compiled, k0=C0.sIndex.get(a3);
    out.builtUpkeep=M.stationUpkeepFactor(stC);
    out.servBuilt=!!C0.serviced[k0];
    out.linesBuilt=C0.stationLines[k0].size;
    ev=evalNow();
    const before=ev.total, demBefore=sum(itemOf(ev,'demolition',stC.name));
    g.edit(function(n){ delete n.stations[a3].rsv; return {}; });
    ev=evalNow();
    out.upDelta=ev.total-before;
    out.upDemDelta=sum(itemOf(ev,'demolition',stC.name))-demBefore;
    out.upItems=ev.items.filter(function(i){ return i.kind==='upgrade'; }).map(function(i){ return i.amount; });
    out.upFlag=g.draft.net.stations[a3].rsv||0;
    // 编译：升级后（仍未接轨）不服务；接轨后服务
    const C1=M.compile(g.draft.net,city), k1=C1.sIndex.get(a3);
    out.servBefore=C1.serviced[k1];
    out.routesBefore=C1.stationRoutes[k1].length;
    out.linesBefore=C1.stationLines[k1].size;
    const b1=mk(p2,false);
    g.edit(function(n){ n.lines.__u={id:'__u',name:'测试线二',color:'#336699',stations:[],segs:[]}; return {}; });
    const seg=M.addSegment(g.draft.net,'__u',a3,b1);
    out.segAfterUp=seg.error||null;
    const C2=M.compile(g.draft.net,city), k2=C2.sIndex.get(a3);
    out.servAfter=!!C2.serviced[k2];
    out.linesAfter=C2.stationLines[k2].size;
    // 收拾：删线、删站，保持草案干净
    g.edit(function(n){ for(const k in n.segments) if(n.segments[k].line==='__u') delete n.segments[k]; delete n.lines.__u; M.removeStation(n,a3); M.removeStation(n,b1); return {}; });
    out.draftStations=Object.keys(g.draft.net.stations).length;
    return out;
  })()`);

  console.log(JSON.stringify(report, null, 1));
  assert.equal(report.rsvFlag, true, 'Ctrl 建站应写入 rsv 标记');
  assert.ok(Math.abs(report.aBuild - report.rsvCost) < 1, '预留站建筑费应等于正式站的 1/5：' + report.aBuild + ' vs ' + report.rsvCost);
  assert.ok(report.aBuild < report.bBuild * 0.25, '预留站建筑费应显著低于正式站');
  assert.ok(Math.abs(report.aDem - report.bDem) < 1, '拆迁补偿应与正式站一致：' + report.aDem + ' vs ' + report.bDem);
  assert.ok(Math.abs(report.aUpkeep - 0.2) < 1e-9, '预留站维护费系数应为 0.2，实际 ' + report.aUpkeep);
  assert.ok(report.rsvSegErr === null, '预留站应能接轨，实际报错：' + report.rsvSegErr);
  assert.equal(report.okSeg, true, '正式站之间应能正常接轨');
  assert.equal(report.rsvTracks, 1, '接轨后应记录 1 条接入线路，实际 ' + report.rsvTracks);
  assert.equal(report.rsvServiced, false, '预留站接轨后仍不应服务（没有站台）');
  assert.equal(report.rsvRoutes, 0, '预留站不应有停靠路线');
  assert.equal(report.rsvLines, 0, '预留站不计入站台线路（不能作为换乘站）');
  assert.equal(report.wiredUpServiced, true, '已接轨的预留站升级后应自动开始停靠');
  assert.equal(report.wiredUpRoutes, 1, '升级后应有 1 条停靠路线，实际 ' + report.wiredUpRoutes);
  assert.equal(report.builtRsv, true, '确认建设后仍应保留预留标记');
  assert.ok(Math.abs(report.builtUpkeep - 0.2) < 1e-9, '已建成的预留站维护费系数应为 0.2');
  assert.equal(report.servBuilt, false, '预留站建成后也不应服务');
  assert.equal(report.linesBuilt, 0, '预留站不应有线路');
  assert.ok(Math.abs(report.upDelta - (report.full - report.rsvCost)) < 1.5, '升级应只补交 4/5 差价，实际 ' + report.upDelta + '，期望 ' + (report.full - report.rsvCost));
  assert.equal(report.upItems.length, 1, '升级应产生一条「预留站补建」条目，实际 ' + JSON.stringify(report.upItems));
  assert.ok(Math.abs(report.upItems[0] - (report.full - report.rsvCost)) < 1.5, '补建条目金额应为 4/5 差价');
  assert.ok(Math.abs(report.upDemDelta) < 1, '升级不应重复收拆迁费，实际增加 ' + report.upDemDelta);
  assert.equal(report.upFlag, 0, '升级后不应再有 rsv 标记');
  assert.equal(report.servBefore, false, '未接轨的站不应服务');
  assert.equal(report.routesBefore, 0, '未接轨的站不应有停靠路线');
  assert.equal(report.linesBefore, 0, '未接轨的站不应有线路（不能当换乘站）');
  assert.equal(report.segAfterUp, null, '升级后应能接轨，实际：' + report.segAfterUp);
  assert.equal(report.servAfter, true, '接轨后应进入服务');
  assert.equal(report.linesAfter, 1, '接轨后应有 1 条线路');

  // ---------------- 2. 界面：工具坞、Ctrl+点击、车站页 ----------------
  await E('CM.ui.tools.setTool("station");true');
  await delay(300);
  const bar = await E(`(function(){
    const el=document.querySelector('#toolopts');
    const btns=[...el.querySelectorAll('button')];
    const rsv=btns.find(b=>/预留/.test(b.textContent));
    return { text: el.textContent, hasRsv: !!rsv, tip: rsv?(rsv.getAttribute('data-tip')||''):'', pressed: rsv?rsv.getAttribute('aria-pressed'):null,
             hint: (el.querySelector('.to-hint')||{}).textContent||'' };
  })()`);
  assert.ok(bar.hasRsv, '建站工具坞应有「预留」入口');
  assert.ok(/1\/5/.test(bar.tip), '预留入口要说明费用是 1/5，实际：' + bar.tip);
  assert.ok(/Ctrl/.test(bar.hint), '建站提示要写明按住 Ctrl 建预留站，实际：' + bar.hint);

  // 用真实鼠标事件 + Ctrl 建站
  const pt = await E(`(function(){
    const g=CM.game, M=CM.Metro, city=g.city;
    for(let r=0;r<60;r++)for(let dx=-r;dx<=r;dx++)for(let dy=-r;dy<=r;dy++){
      if(Math.max(Math.abs(dx),Math.abs(dy))!==r)continue;
      const x=city.W/2+dx+0.5, y=city.H/2+dy+0.5;
      if(!M.checkSite(city,x,y,'underground').ok)continue;
      const p=CM.ui.R.P(x,y,CM.ui.R.trackH('underground'));
      if(p.x<260||p.y<320||p.x>CM.ui.R.w-420||p.y>CM.ui.R.h-240)continue;
      return {x:x,y:y,sx:p.x,sy:p.y};
    }
    return null;
  })()`);
  assert.ok(pt, '找不到可用于点击的空地');
  const before = await E('Object.keys(CM.game.draft?CM.game.draft.net.stations:{}).length');
  await E(`(function(){document.querySelectorAll('.toast').forEach(e=>e.remove());return true;})()`);
  await delay(300);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.sx, y: pt.sy, modifiers: 2 });
  await delay(200);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.sx, y: pt.sy, button: 'left', clickCount: 1, modifiers: 2 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.sx, y: pt.sy, button: 'left', clickCount: 1, modifiers: 2 });
  await delay(900);
  const after = await E(`(function(){
    const g=CM.game, net=g.draft?g.draft.net:g.net;
    const ids=Object.keys(net.stations), n=ids.length;
    const last=ids[ids.length-1];
    const s=last?net.stations[last]:null;
    return { n:n, id:last, name:s?s.name:'', rsv:s?!!s.rsv:false,
      box: !!document.querySelector('.rsv-box'),
      tags: [...document.querySelectorAll('#rightPanel .tag')].map(t=>t.textContent).join('|'),
      upBtn: [...document.querySelectorAll('#rightPanel button')].some(b=>/补建为正式站/.test(b.textContent)),
      toast: [...document.querySelectorAll('.toast')].map(t=>t.textContent).join(' ') };
  })()`);
  assert.equal(after.n, before + 1, 'Ctrl+点击应新建一座车站');
  assert.equal(after.rsv, true, 'Ctrl+点击建出的应是预留站');
  assert.ok(after.tags.includes('预留站'), '车站页应有「预留站」标记，实际：' + after.tags);
  assert.ok(after.box, '车站页应有预留站说明块');
  assert.ok(after.upBtn, '车站页应有「补建为正式站」按钮');
  assert.ok(/预留站/.test(after.toast) || /预留/.test(after.toast), '建站后要有提示，实际：' + after.toast);

  // 留一张截图供人工核对：预留站的地图符号、站名后缀与建设页说明
  await E(`CM.ui.flyTo(${pt.x}, ${pt.y}, 30);true`);
  await delay(900);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1272, y: 24 });
  await delay(400);
  const shot = path.join(os.tmpdir(), 'cm-rsv-1280.png');
  await send('Page.captureScreenshot', { format: 'png' }).then(r => fs.writeFile(shot, Buffer.from(r.data, 'base64')));
  // 再放大一张，便于核对预留站的符号本身（虚线空心圈 + 十字）；先取消选中，避免高亮环盖住符号
  await E(`(function(){window.__rsvHit=0;const P=CM.Renderer.prototype.paintStationCore;CM.Renderer.prototype.paintStationCore=function(ctx,C,i,s){if(s&&s.rsv)window.__rsvHit++;return P.apply(this,arguments);};return true;})()`);
  await E('CM.ui.select(null);true');
  await E(`CM.ui.flyTo(${pt.x}, ${pt.y}, 72);true`);
  await delay(900);
  const hit = await E('window.__rsvHit');
  console.log('rsv paint calls', hit);
  const shot2 = path.join(os.tmpdir(), 'cm-rsv-zoom.png');
  await send('Page.captureScreenshot', { format: 'png' }).then(r => fs.writeFile(shot2, Buffer.from(r.data, 'base64')));
  // 恢复选中，继续验证车站页的补建按钮
  await E(`CM.ui.select({kind:'station',id:${JSON.stringify(after.id)}});true`);
  await delay(500);

  // 点「补建为正式站」→ 草案里出现 upgrade 条目，rsv 被清掉
  // 点「补建为正式站」→ 草案总额从 1/5 变为正式站全价（新建的预留站因此按「新建正式站」结算）
  const totalBefore = await E(`(function(){const g=CM.game,net=g.draft?g.draft.net:g.net;return CM.Metro.evaluate(net,g.net,g.city,g.clock.y).total;})()`);
  await E(`(function(){const b=[...document.querySelectorAll('#rightPanel button')].find(x=>/补建为正式站/.test(x.textContent));if(b)b.click();return true;})()`);
  await delay(700);
  const upgraded = await E(`(function(){
    const g=CM.game, net=g.draft?g.draft.net:g.net;
    const s=net.stations[${JSON.stringify(after.id)}];
    const ev=CM.Metro.evaluate(net,g.net,g.city,g.clock.y);
    return { rsv:s?!!s.rsv:null, total:ev.total,
      build: ev.items.filter(i=>i.kind==='construction'||i.kind==='upgrade').map(i=>i.amount),
      box: !!document.querySelector('.rsv-box'),
      toast: [...document.querySelectorAll('.toast')].map(t=>t.textContent).join(' ') };
  })()`);
  assert.equal(upgraded.rsv, false, '点「补建为正式站」后应清除预留标记');
  assert.ok(Math.abs((upgraded.total - totalBefore) - (report.full - report.rsvCost)) < 1.5,
    '补建后总额应增加 4/5 差价，实际增加 ' + (upgraded.total - totalBefore) + '，期望 ' + (report.full - report.rsvCost));
  assert.ok(upgraded.build.length && upgraded.build[0] > 0, '补建应产生一笔建设费用，实际：' + JSON.stringify(upgraded.build));
  assert.equal(upgraded.box, false, '升级后不应再显示预留说明块');
  assert.ok(/补建为正式站/.test(upgraded.toast), '升级应有提示，实际：' + upgraded.toast);

  // ---------------- 2b. 绘线路径：Ctrl 绘线同样建预留站，并与正式站接轨 ----------------
  await E('CM.ui.tools.endChain(true);CM.ui.tools.setTool("line");CM.ui.tools.rsvNext=false;CM.ui.tools.ctrlDown=false;true');
  await E('CM.ui.flyTo(CM.game.city.W/2,CM.game.city.H/2,14);true');
  await delay(900);
  const lp = await E(`(function(){
    const g=CM.game, M=CM.Metro, city=g.city, net=g.draft?g.draft.net:g.net, R=CM.ui.R;
    const occ=Object.values(net.stations).map(function(s){ return [s.x,s.y]; });
    const pick=function(after){
      for(let r=0;r<70;r++)for(let dx=-r;dx<=r;dx++)for(let dy=-r;dy<=r;dy++){
        if(Math.max(Math.abs(dx),Math.abs(dy))!==r)continue;
        const x=city.W/2+dx+0.5, y=city.H/2+dy+0.5;
        if(!M.checkSite(city,x,y,'underground').ok)continue;
        if(occ.some(function(p){ return Math.hypot(p[0]-x,p[1]-y)<10; }))continue;
        if(after&&Math.hypot(after[0]-x,after[1]-y)<12)continue;
        const p=R.P(x,y,R.trackH('underground'));
        if(p.x<260||p.y<320||p.x>R.w-420||p.y>R.h-240)continue;
        return {x:x,y:y,sx:p.x,sy:p.y};
      }
      return null;
    };
    const A=pick(null), B=A?pick([A.x,A.y]):null;
    return {A:A,B:B};
  })()`);
  assert.ok(lp.A && lp.B, '绘线测试需要两处可用空地');
  const n0 = await E('Object.keys(CM.game.draft?CM.game.draft.net.stations:{}).length');
  await E('window.__askLine=CM.ui.askLineNumber;CM.ui.askLineNumber=null;true');
  // 起点：Ctrl+点击空地 → 新建预留站并开始新线路
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: lp.A.sx, y: lp.A.sy, modifiers: 2 });
  await delay(200);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: lp.A.sx, y: lp.A.sy, button: 'left', clickCount: 1, modifiers: 2 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: lp.A.sx, y: lp.A.sy, button: 'left', clickCount: 1, modifiers: 2 });
  await delay(700);
  // 终点：不按 Ctrl → 新建正式站并连接（预留站作为起点应能接轨）
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: lp.B.sx, y: lp.B.sy });
  await delay(200);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: lp.B.sx, y: lp.B.sy, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: lp.B.sx, y: lp.B.sy, button: 'left', clickCount: 1 });
  await delay(900);
  const drawn = await E(`(function(){
    const g=CM.game, M=CM.Metro, net=g.draft?g.draft.net:g.net;
    const ids=Object.keys(net.stations);
    const find=function(x,y){ return ids.find(function(id){ const s=net.stations[id]; return Math.hypot(s.x-x,s.y-y)<1.5; }); };
    const a=find(${lp.A.x},${lp.A.y}), b=find(${lp.B.x},${lp.B.y});
    const seg=Object.values(net.segments).find(function(s){ return (s.a===a&&s.b===b)||(s.a===b&&s.b===a); });
    const C=M.compile(net,g.city), ka=C.sIndex.get(a), kb=C.sIndex.get(b);
    return { n:ids.length, a:a, b:b, rsvA:a?!!net.stations[a].rsv:null, rsvB:b?!!net.stations[b].rsv:null,
      seg:!!seg, servA:ka!=null?!!C.serviced[ka]:null, servB:kb!=null?!!C.serviced[kb]:null,
      tracksA:ka!=null?C.stationTracks[ka].size:0 };
  })()`);
  assert.equal(drawn.n, n0 + 2, '绘线应新建两座车站');
  assert.equal(drawn.rsvA, true, 'Ctrl+绘线新建的起点应是预留站');
  assert.equal(drawn.rsvB, false, '未按 Ctrl 的终点应是正式站');
  assert.ok(drawn.seg, '预留站应能与正式站接轨（绘线路径）');
  assert.equal(drawn.servA, false, '接轨的预留站仍不服务（没有站台）');
  assert.equal(drawn.servB, false, '只有一座可停靠站的线路还不能运营（v4.8：预留站视为不存在，至少要两座可停靠站）');
  assert.equal(drawn.tracksA, 1, '预留站应记录 1 条接入线路');
  // 车站页：应显示接入的线路、说明「可先接轨」，并保留从此站绘线的入口
  await E(`CM.ui.select({kind:'station',id:${JSON.stringify(drawn.a)}});true`);
  await delay(600);
  const rsvPage = await E(`(function(){
    const el=document.querySelector('#rightPanel');
    return { tags:[...el.querySelectorAll('.tag')].map(function(t){ return t.textContent; }).join('|'),
      note:[...el.querySelectorAll('.note')].map(function(n){ return n.textContent; }).join(' '),
      draw:[...el.querySelectorAll('button')].some(function(b){ return /新建线路|延长|绘制/.test(b.textContent); }) };
  })()`);
  assert.ok(/●/.test(rsvPage.tags), '接轨后车站页应显示线路标签，实际：' + rsvPage.tags);
  assert.ok(/接轨/.test(rsvPage.note), '预留站建设页应说明可以先接轨，实际：' + rsvPage.note);
  assert.ok(rsvPage.draw, '预留站也应提供「从此站绘线」入口');
  // 取消选中并放大：核对「虚线预留站符号 + 轨道穿过」的显示
  await E(`CM.ui.select(null);CM.ui.flyTo(${lp.A.x},${lp.A.y},60);true`);
  await delay(900);
  const shot4 = path.join(os.tmpdir(), 'cm-rsv-line.png');
  await send('Page.captureScreenshot', { format: 'png' }).then(r => fs.writeFile(shot4, Buffer.from(r.data, 'base64')));
  await E('CM.ui.tools.endChain(true);CM.ui.askLineNumber=window.__askLine;true');
  await delay(200);

  // ---------------- 3. 英文界面：说明块整句翻译，不出现成片汉字 ----------------
  await E('CM.Settings.set("language","en");CM.I18n.apply("en");true');
  await delay(500);
  const enId = await E(`(function(){
    const g=CM.game,M=CM.Metro,city=g.city,net=g.draft?g.draft.net:g.net;
    for(let r=0;r<60;r++)for(let dx=-r;dx<=r;dx++)for(let dy=-r;dy<=r;dy++){
      if(Math.max(Math.abs(dx),Math.abs(dy))!==r)continue;
      const x=city.W/2+dx, y=city.H/2+dy;
      if(!M.checkSite(city,x,y,'underground').ok)continue;
      if(Object.values(net.stations).some(function(s){ return Math.hypot(s.x-x,s.y-y)<9; }))continue;
      let id=null; g.edit(function(n){ id=M.addStation(n,x,y,{size:'M',type:'underground',reserved:1},city); return {}; });
      CM.ui.select({kind:'station',id:id});
      return id;
    }
    return null;
  })()`);
  assert.ok(enId, '英文界面测试需要新建一座预留站');
  await delay(700);
  const en = await E(`(function(){
    const b=document.querySelector('.rsv-box');
    const btns=[...document.querySelectorAll('#rightPanel button')].map(function(x){ return x.textContent.trim(); });
    return { text: b?b.textContent:'', tags: [...document.querySelectorAll('#rightPanel .tag')].map(function(t){ return t.textContent; }).join('|'), btns: btns.join('|') };
  })()`);
  assert.ok(en.text, '英文界面应显示预留站说明块');
  assert.ok(!/[\u3400-\u9fff]/.test(en.text), '英文说明块不应残留汉字：' + en.text);
  assert.ok(/reserved station/i.test(en.text), '英文说明块应写明 reserved station：' + en.text);
  assert.ok(!/[\u3400-\u9fff]/.test(en.tags), '英文界面的标签不应残留汉字：' + en.tags);
  assert.ok(/Build as full station/i.test(en.btns), '英文界面的补建按钮文案应翻译，实际：' + en.btns);
  const shot3 = path.join(os.tmpdir(), 'cm-rsv-en.png');
  await send('Page.captureScreenshot', { format: 'png' }).then(r => fs.writeFile(shot3, Buffer.from(r.data, 'base64')));

  assert.deepEqual(errors, [], '控制台不应有报错：' + errors.join('\n'));
  console.log('PASS 预留站：计价 1/5 · 拆迁同额 · 升级补 4/5 · 可接轨但不停靠 · 建站与绘线两条路径一致 · 界面提示');
} finally {
  try { ws.close(); } catch { }
  edge.kill();
  server.close();
  await fs.rm(task, { recursive: true, force: true }).catch(() => { });
}
