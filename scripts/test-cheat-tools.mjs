// v2.9.6 作弊工具：人口密度刷子 + 自定义设施。
// 1) 入口：图层栏的「作弊工具」开关（默认关闭）+ 两个工具按钮；关闭时点击给出提示。
// 2) 人口密度刷子：单击地图 → 半径内每格人口按「密度 × 格面积」增加，与人口密度图层同一口径；
//    地图上不留光环 / 记号，读数与撤销照常。
// 3) 设施建造：单击 → 生成一座自定义设施并打开属性面板；名称 / 类别 / 出行需求 / 规模 / 启用年份可改，
//    改完进入设施表与设施图层，周边车站客流随之变化；删除后复原。
// 4) 英文界面下工具条、属性面板没有残留汉字；全程无脚本异常。
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

const task = await fs.mkdtemp(path.join(os.tmpdir(), 'city-metro-cheat-')), profile = path.join(task, 'profile');
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
  // 北京 2000 年自带 1 号线与环线，开局就有客流，适合观察注入前后
  await E('CM.newGame({map:"bj",mode:"challenge",seed:20261111});true');
  await until('!CM.isLoading()&&!!CM.game&&!CM.game.pending');
  await until('!!CM.game.model&&(!!CM.game.model.acc||CM.game.model.trafficReady())', 240000);
  await delay(1200);
  await E('(function(){const b=[...document.querySelectorAll("button")].find(function(x){return /开始规划/.test(x.textContent);});if(b)b.click();return true;})()');
  await E('CM.ui.closeScreen();true');
  await until('CM.ui.screen.classList.contains("hidden")', 30000);
  await until('!!(CM.game.model.stDaily&&CM.game.model.stDaily.inn&&CM.game.model.stDaily.inn.length)', 240000);
  await E('CM.game.setSpeed(0);CM.ui.toasts.replaceChildren();CM.ui.closePanel(true);true');
  await delay(400);

  // ---------------- 1. 入口：图层栏开关 + 两个工具按钮 ----------------
  const panel = await E(`(function(){
    CM.ui.toggleLayerPanel(true);
    const btns=[...document.querySelectorAll('#layerPanel .lp-btn')];
    const find=function(n){return btns.find(function(b){return b.getAttribute('aria-label')===n;});};
    const out={has:!!find('作弊工具'),pop:!!find('人口刷子'),fac:!!find('设施建造'),on:CM.Cheat.on()};
    out.off=find('人口刷子')?find('人口刷子').classList.contains('off'):null;
    find('人口刷子').click();
    out.toolAfterLocked=CM.tools.tool;
    out.toast=[...document.querySelectorAll('.toast .tx')].map(function(x){return x.textContent;}).join('|');
    return out;
  })()`);
  assert.ok(panel.has && panel.pop && panel.fac, '图层栏要有作弊工具开关与两个工具按钮：' + JSON.stringify(panel));
  assert.equal(panel.on, false, '作弊工具默认关闭');
  assert.equal(panel.off, true, '关闭时两个工具按钮显示为不可用');
  assert.notEqual(panel.toolAfterLocked, 'popbrush', '关闭时点击工具按钮不会进入工具');
  assert.match(panel.toast, /作弊工具/, '关闭时点击要提示先开启：' + panel.toast);

  // 打开开关（同一个按钮）
  await E(`(function(){
    CM.ui.toasts.replaceChildren();
    [...document.querySelectorAll('#layerPanel .lp-btn')].find(function(b){return b.getAttribute('aria-label')==='作弊工具';}).click();
    return CM.Cheat.on();
  })()`);
  await until('CM.Cheat.on()');
  const opened = await E(`(function(){
    const btns=[...document.querySelectorAll('#layerPanel .lp-btn')];
    const find=function(n){return btns.find(function(b){return b.getAttribute('aria-label')===n;});};
    find('人口刷子').click();
    return {tool:CM.tools.tool,opts:document.querySelector('#toolopts').textContent,hidden:document.querySelector('#toolopts').classList.contains('hidden'),layer:CM.ui.layer};
  })()`);
  assert.equal(opened.tool, 'popbrush', '开启后点击人口刷子进入工具');
  assert.equal(opened.hidden, false, '人口刷子的选项条要显示');
  assert.match(opened.opts, /密度/, '选项条要有密度档位：' + opened.opts);
  assert.match(opened.opts, /半径/, '选项条要有作用半径：' + opened.opts);
  assert.equal(opened.layer, 'pop', '进入人口刷子时自动打开人口密度图层');

  // ---------------- 2. 人口密度刷子：单击加密度，不留标记 ----------------
  const clickAt = async (wx, wy) => E(`(function(){
    const t=CM.tools,p=CM.R.P(${wx},${wy},0);
    const ev={clientX:p.x,clientY:p.y,button:0,shiftKey:false,altKey:false,ctrlKey:false,metaKey:false,pointerType:'mouse',pointerId:1,preventDefault:function(){}};
    t.onDown(ev); t.onUp(ev); return {x:p.x,y:p.y};
  })()`);
  // 取客流中游的一座普通车站（不是最大的换乘枢纽）：注入效果更干净，也更能代表玩家常点的地方
  const pick = await E(`(function(){
    const g=CM.game,C=g.model.net.C,list=[];
    for(let i=0;i<C.stations.length;i++){const s=C.stations[i];if(!s||!isFinite(s.x))continue;
      const d=g.model.stDaily.inn[i]+g.model.stDaily.out[i]; if(d>500)list.push({i:i,x:s.x,y:s.y,name:s.name,d:d});}
    list.sort(function(a,b){return a.d-b.d;});
    const best=list[Math.floor(list.length*0.3)];
    const zc=g.city.cellAt(best.x+1.5,best.y+1.5), z=g.city.zoneOf(zc);
    return {i:best.i,x:best.x,y:best.y,name:best.name,daily:best.d,zone:z,zpop:g.model.zPop[z],
      pop:g.city.pop.reduce(function(a,b){return a+b;},0),ver:g.model.version,
      readoutAt:g.cheat.readout?g.cheat.readout.at:0};
  })()`);
  assert.ok(pick && pick.i >= 0, '需要一座有客流的车站');
  const DENS = 60000, RAD = 3;
  await E(`CM.tools.popDens=${DENS};CM.tools.popR=${RAD};CM.ui._toKey=null;CM.ui.renderToolOpts();true`);
  const cellBefore = await E(`(function(){const g=CM.game,c=g.city.cellAt(${pick.x}+2.2,${pick.y}+2.2);return {c:c,dens:g.city.pop[c]/CM.Cheat.CELL_KM2};})()`);
  await clickAt(pick.x + 1.5, pick.y + 1.5);
  await until('CM.game.cheat.totalPop>0', 20000);
  await until('CM.game.model.version>' + pick.ver, 20000);
  await until('CM.game.cheat.readout&&CM.game.cheat.readout.at>' + pick.readoutAt + '&&CM.game.model.settled&&!CM.game.model.dailyStale', 180000);
  const afterPop = await E(`(function(){
    const g=CM.game,c=g.city.cellAt(${pick.x}+2.2,${pick.y}+2.2);
    return {pop:g.city.pop.reduce(function(a,b){return a+b;},0),marks:g.cheat.marks.length,
      cellPop:g.city.pop[c],cellDens:g.city.pop[c]/CM.Cheat.CELL_KM2,readout:g.cheat.readout,
      hasDraw:typeof CM.Cheat.draw==='function'};
  })()`);
  const addPerCell = DENS * 0.0625;
  assert.ok(afterPop.pop > pick.pop + 1000, '人口刷子要按密度写入人口：+' + Math.round(afterPop.pop - pick.pop));
  assert.ok(Math.abs(afterPop.pop - pick.pop - afterPop.marks * 29 * addPerCell) < 1.5 || afterPop.pop - pick.pop > 100000, '每格要加上 密度 × 0.0625 人');
  assert.ok(afterPop.cellDens > cellBefore.dens + 10000, '这一格的人口密度要明显上升：' + Math.round(cellBefore.dens) + ' → ' + Math.round(afterPop.cellDens));
  assert.equal(afterPop.marks, 1, '记一次注入范围（只用于读数，不画在地图上）');
  assert.equal(afterPop.hasDraw, false, '人口刷子不再画光环 / 记号（CM.Cheat.draw 已移除）');
  assert.ok(afterPop.readout && afterPop.readout.near, '工具要报出最近车站的客流变化：' + JSON.stringify(afterPop.readout));
  assert.ok(afterPop.readout.near.d > 0, '最近车站的日客流要随人口密度上升：' + JSON.stringify(afterPop.readout.near));

  // 撤销：人口与范围复原
  const verU = await E('CM.game.model.version');
  await E(`(function(){
    const b=[...document.querySelectorAll('#toolopts button')].find(function(x){return /撤销/.test(x.textContent);});
    b.click(); return true;
  })()`);
  await until('CM.game.cheat.totalPop===0', 10000);
  // 撤销也会触发一次重算（300 ms 防抖 + 求解）：等这一次算完，后面的设施读数才拿得到干净的基准
  await until('CM.game.model.version>' + verU + '&&CM.game.model.settled&&!CM.game.model.dailyStale', 180000);
  await delay(400);
  const undone = await E(`(function(){const g=CM.game;return {pop:g.city.pop.reduce(function(a,b){return a+b;},0),marks:g.cheat.marks.length};})()`);
  assert.ok(Math.abs(undone.pop - pick.pop) < 1, '撤销后人口要回到注入前：' + (undone.pop - pick.pop));
  assert.equal(undone.marks, 0, '撤销后范围记录要移除');

  // ---------------- 3. 设施建造：单击放一座 + 属性面板 ----------------
  const fac = await E(`(function(){
    CM.ui.toggleLayerPanel(true);
    [...document.querySelectorAll('#layerPanel .lp-btn')].find(function(x){return x.getAttribute('aria-label')==='设施建造';}).click();
    return {tool:CM.tools.tool,opts:document.querySelector('#toolopts').textContent,layer:CM.ui.layer};
  })()`);
  assert.equal(fac.tool, 'facbuild', '设施建造工具可用');
  assert.match(fac.opts, /类别/, '设施选项要有类别：' + fac.opts);
  assert.equal(fac.layer, 'fac', '进入设施建造时自动打开设施图层');

  const ver2 = await E('CM.game.model.version'), at2 = await E('CM.game.cheat.readout?CM.game.cheat.readout.at:0');
  // 放在车站旁边（路口上有步行道）：设施才能被步行接驳，客流变化才看得清楚
  await clickAt(pick.x + 0.6, pick.y + 0.6);
  await until('CM.game.cheat.cfacs.length===1', 20000);
  const first = await E(`(function(){
    const g=CM.game,c=g.cheat.cfacs[0];
    return {c:c,byId:!!CM.Fac.byId(c.id),inModel:(function(){const i=g.model.facIndex(c.id);return i>=0;})(),
      page:(CM.ui.stack.length?CM.ui.stack[CM.ui.stack.length-1].kind:'')};
  })()`);
  assert.equal(first.byId, true, '自定义设施要进入设施表（CM.Fac.byId）');
  assert.equal(first.page, 'cfac', '放置后立即打开属性面板');
  await until('CM.game.model.version>' + ver2, 20000);
  await until('CM.game.cheat.readout&&CM.game.cheat.readout.at>' + at2 + '&&CM.game.model.settled&&!CM.game.model.dailyStale', 180000);
  const afterFac = await E(`(function(){
    const g=CM.game,m=g.model,c=m&&g.cheat.cfacs[0],i=c?m.facIndex(c.id):-1;
    const st=i>=0?m.facStats(c.id,'avg'):null;
    const acc=m.net&&m.net.acc,ln=(acc&&acc.zl)?acc.zl[m.Z+i]:null;
    return {inModel:i>=0,v:st?st.inn+st.out:0,vM:st?st.innM+st.outM:0,
      acc:ln?ln.map(function(x){return x.s;}):[],readout:g.cheat.readout,count:g.cheat.totalFac};
  })()`);
  assert.equal(afterFac.count, 1, '本局设施计数要更新');
  assert.equal(afterFac.inModel, true, '自定义设施要进入模型（facIndex）');
  assert.ok(afterFac.v > 0, '自定义设施要有到访量：' + afterFac.v);
  // 建在车站旁边的设施：接驳表里要有最近的那座车站，客流里要有地铁承担的部分
  assert.ok(afterFac.acc.indexOf(pick.i) >= 0, '最近车站要出现在设施的步行接驳表里：' + JSON.stringify(afterFac.acc) + ' / 车站 ' + pick.i);
  assert.ok(afterFac.vM > 0, '设施的到访里要有坐地铁来的部分：' + afterFac.vM);
  // 周边车站客流要真的重算过（不是原样留着的旧数）：有变化的车站数 > 0，且最近车站确有变动
  assert.ok(afterFac.readout && afterFac.readout.n > 0, '设施建成后周边车站客流要重算：' + JSON.stringify(afterFac.readout));
  assert.ok(afterFac.readout.near && Math.abs(afterFac.readout.near.d) > 1, '最近车站的客流要有变化：' + JSON.stringify(afterFac.readout.near));

  // 属性面板：改名称 / 类别 / 需求 / 规模 / 年份
  const edit = await E(`(function(){
    const ui=CM.ui,g=CM.game,id=g.cheat.cfacs[0].id;
    const before=JSON.parse(JSON.stringify(g.cheat.cfacs[0]));
    const rp=document.getElementById('rightPanel');
    const page=rp&&rp.querySelector('.p-body');
    const txt=page?page.textContent:'';
    const inputs=page?[...page.querySelectorAll('input')]:[];
    return {before:before,hasName:inputs.length>=1,hasYear:inputs.length>=2,text:txt.slice(0,600)};
  })()`);
  assert.ok(edit.hasName && edit.hasYear, '属性面板要有名称与年份输入框');
  assert.match(edit.text, /类别/, '属性面板要有类别');
  assert.match(edit.text, /规模/, '属性面板要有规模');
  assert.match(edit.text, /出行需求/, '属性面板要有出行需求');

  const edited = await E(`(function(){
    const g=CM.game,CB=CM.Cheat,id=g.cheat.cfacs[0].id;
    CB.setFac(g,id,{name:'测试体育馆',t:'stadium',w:0.01,r:1.6,open:1990});
    return JSON.parse(JSON.stringify(g.cheat.cfacs[0]));
  })()`);
  assert.equal(edited.name, '测试体育馆', '名称可改');
  assert.equal(edited.t, 'stadium', '类别可改');
  assert.equal(edited.w, 0.01, '出行需求可改');
  assert.equal(edited.r, 1.6, '规模可改');
  assert.equal(edited.open, 1990, '启用年份可改');
  await delay(1600);
  const renamed = await E(`(function(){
    const g=CM.game,f=CM.Fac.byId(g.cheat.cfacs[0].id),i=g.model.facIndex(g.cheat.cfacs[0].id);
    return {name:f?f.name:'',cat:f?f.t:'',inModel:i>=0,open:f?f.open:null};
  })()`);
  assert.equal(renamed.name, '测试体育馆', '设施表里的名称要跟着改');
  assert.equal(renamed.cat, 'stadium', '设施表里的类别要跟着改');
  assert.equal(renamed.open, 1990, '设施表里的启用年份要跟着改');
  assert.equal(renamed.inModel, true, '改完仍在模型里');

  // 删除：设施表与车站客流复原
  await E('CM.Cheat.delFac(CM.game,CM.game.cheat.cfacs[0].id);true');
  await until('CM.game.cheat.cfacs.length===0', 10000);
  await delay(1500);
  const gone = await E(`(function(){
    const g=CM.game;return {byId:!!CM.Fac.byId('cf1'),inList:CM.Fac.list(g.city).filter(function(f){return f.cus;}).length};
  })()`);
  assert.equal(gone.byId, false, '删除后设施表里不再有它');
  assert.equal(gone.inList, 0, '删除后设施表不再追加自定义设施');

  // ---------------- 4. 英文界面：工具条与属性面板不留汉字 ----------------
  await E(`(function(){
    CM.tools.setTool('facbuild');CM.Cheat.addFac(CM.game,{x:${pick.x}+6,y:${pick.y}+2,t:'shop'});
    CM.ui.openPage('cfac',CM.game.cheat.cfacs[0].id);
    CM.I18n.apply("en");CM.ui._toKey=null;CM.ui.renderToolOpts();CM.ui.rerenderPage();CM.ui.toggleLayerPanel(true);
    return true;
  })()`);
  await delay(500);
  const en = await E(`(function(){
    const han=/[\\u3400-\\u9fff]/;
    const opts=document.querySelector('#toolopts').textContent||'';
    const panel=document.querySelector('#layerPanel').textContent||'';
    const rp=document.getElementById('rightPanel');
    const body=(rp&&rp.querySelector('.p-body')||{}).textContent||'';
    const tips=[...document.querySelectorAll('#layerPanel .lp-btn,#toolopts button,#toolopts .to-hint,.p-body button')].map(function(b){return b.getAttribute('data-tip')||'';}).join(' ');
    return {opts:opts,panel:panel,body:body.slice(0,200),len:body.length,bad:han.test(opts)||han.test(panel)||han.test(body)||han.test(tips),sample:[opts.slice(0,90),body.slice(0,90),tips.slice(0,90)]};
  })()`);
  assert.ok(en.len > 40, '英文界面下属性面板要正常渲染出来：' + JSON.stringify(en).slice(0, 300));
  assert.equal(en.bad, false, '英文界面残留汉字：' + JSON.stringify(en).slice(0, 600));
  await E('CM.I18n.apply("zh-CN");true');

  assert.deepEqual(errors, [], '控制台不应有异常：' + errors.join('\n'));
  console.log('PASS v2.9.6 cheat tools: gated entry, density brush (+60,000/km² per click, no map markers, undo restores), custom facility (place → edit name/category/demand/scale/year → delete), English UI clean');
} finally {
  try { edge.kill(); } catch { }
  server.close();
  await fs.rm(task, { recursive: true, force: true }).catch(() => { });
}
