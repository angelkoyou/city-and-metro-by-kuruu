// 任务「怎么做」的回归测试。
// 1) 纯逻辑（在真实浏览器里跑）：数据里出现过的每一种任务类型与分项类型都必须有专门的步骤生成器；
//    用本局真实的网络、车站与设施构造各类型任务，生成的步骤不能崩，每组至少 2 步，每步都要说清「做什么」，
//    并且绝大多数步骤要给出「在哪里做」——这正是这次改造要解决的问题。
// 2) 界面：任务卡的「怎么做」打开的是按任务生成的步骤页（不是笼统的新手指南），步骤可点、能真的切到建站工具，
//    返回后回到任务列表。
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

const task = await fs.mkdtemp(path.join(os.tmpdir(), 'city-metro-howto-')), profile = path.join(task, 'profile');
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
  await delay(1500);
  // 关掉开局简报卡（它盖在右侧面板上），再继续验证界面
  await E(`(function(){const b=[...document.querySelectorAll('button')].find(x=>/开始规划/.test(x.textContent));if(b)b.click();return true;})()`);
  await delay(800);

  // ---------------- 1. 纯逻辑：每种类型都要有专门步骤 ----------------
  const report = await E(`(function(){
    const g=CM.game, out={missing:[],fail:[],thin:[],noWhere:[],noOrder:[],count:0,totalSteps:0,whereSteps:0};
    const c=g.compiled, m=g.model;
    // 本局可能还没有车站（广州大图开局没有既有线网）：缺什么就用地理上合理的兜底坐标，保证各类型都能跑到
    const st=c.stations[0]||{id:'tstA',name:'测试甲站',x:m.zCx?m.zCx[0]:60,y:m.zCy?m.zCy[0]:60,size:'M',type:'underground'};
    const st2=c.stations[1]||{id:'tstB',name:'测试乙站',x:(st.x||60)+6,y:(st.y||60)+2,size:'S',type:'underground'};
    const lid=Object.keys(g.net.lines)[0]||'test-line';
    const fac=(CM.Fac&&CM.Fac.list)?CM.Fac.list(g.city)[0]:null;
    const reg=g.city.regions[0]?g.city.regions[0].id:null;
    const anchors=[{name:'测试甲站',x:st.x,y:st.y,r:3},{name:'测试乙站',x:st2.x,y:st2.y,r:3}];
    const types=['combo','connect','budgetConnect','coverage','zoneCov','zoneCong','stationCrowd','ridership','facShare','recovery',
      'lineCrowd','lineCars','fiscal','lineEff','regionCov','xferHub',
      'direct','loop','hub','cross','typeKm','spacing','lineSpeed','lineTrain','noStation','coTrack','share','lineRiders','lineLoad',
      'netLoad','regionShare','regionCommute','xferShare','budget','lineCost','todNet','regionPull'];
    const base={ id:'x', kind:'dyn', status:'active', title:'测试任务', desc:'', anchors:anchors, target:0.5, gain:0.05, drop:2,
      zone:0, line:lid, station:st.id, fac:fac?fac.id:null, regions:reg?[reg]:[], areaName:'测试片区',
      minKm:30, minRadials:3, lines:2, seg:['elevated'], max:1200, min:800, kmh:60, perKm:5000,
      place:'测试甲站', x:st.x, y:st.y, r:3, budget:1000000, spent0:0, stations:2, net:10000, sustain:3,
      metric:'carShare', start:0.5, deadline:[2100,1], issuedAt:[2000,1], months:24, reward:1000 };
    for(const ty of types){
      if(!CM.HowTo.has(ty)){ out.missing.push(ty); continue; }
      if(ty==='combo') continue;   // 复合任务在下面单独验证（按分项分组）
      out.count++;
      let r=null;
      try{ r=CM.HowTo.task(Object.assign({},base,{type:ty,id:'x-'+ty}),g); }
      catch(e){ out.fail.push(ty+': '+e.message); continue; }
      if(!r||!r.sections||!r.sections.length){ out.fail.push(ty+': 没有分组'); continue; }
      let steps=0;
      for(const s of r.sections){
        if(!s.order) out.noOrder.push(ty);
        if(!s.steps||s.steps.length<2) out.thin.push(ty+': '+s.steps.length+' 步');
        for(const stp of s.steps){
          steps++;
          if(typeof stp.what!=='string'||!stp.what.trim()) out.fail.push(ty+': 有步骤没有「做什么」');
          if(stp.where) out.whereSteps++; else out.noWhere.push(ty);
        }
      }
      out.totalSteps+=steps;
      if(steps<2) out.thin.push(ty+': 共 '+steps+' 步');
    }
    // 复合任务：分项各自分组
    const combo=CM.HowTo.task(Object.assign({},base,{type:'combo',id:'x-combo',parts:[
      {kind:'net',type:'direct',core:true,anchors:anchors},
      {kind:'ops',type:'regionCommute',regions:reg?[reg]:[],areaName:'测试片区',target:26},
      {kind:'fin',type:'budget',budget:500000,spent0:0}]}),g);
    out.comboSections=combo.sections.length;
    out.comboCore=combo.sections.filter(s=>s.core).length;
    // 分项没带地点时要用任务的锚点兜底：步骤里得真的说出是哪几处
    out.comboNames=/测试甲站/.test(JSON.stringify(combo.sections[0].steps));
    out.comboLabels=combo.sections.map(s=>s.label);
    return out;
  })()`);
  assert.deepEqual(report.missing, [], '这些类型没有专门的步骤：' + report.missing.join(' '));
  assert.deepEqual(report.fail, [], '生成步骤时报错：' + report.fail.join('；'));
  assert.deepEqual(report.thin, [], '步骤太少：' + report.thin.join('；'));
  assert.equal(report.comboSections, 3, '复合任务应按 3 个分项各给一组步骤');
  assert.equal(report.comboCore, 1, '复合任务里应恰好有一项标为主体');
  assert.equal(report.comboNames, true, '复合任务的步骤要说出具体的锚点，实际：' + JSON.stringify(report.comboLabels));
  const whereRatio = report.whereSteps / Math.max(1, report.totalSteps);
  assert.ok(whereRatio > 0.75, '给出「在哪里做」的步骤只占 ' + Math.round(whereRatio * 100) + '%，太低');
  assert.deepEqual(report.noOrder.slice(0, 3), [], '缺少「按什么顺序」提示：' + report.noOrder.join(' '));
  console.log('PASS 全部 ' + report.count + ' 类任务都有针对性步骤（共 ' + report.totalSteps + ' 步，' +
    Math.round(whereRatio * 100) + '% 写明位置，复合任务 ' + report.comboSections + ' 组）');

  // ---------------- 2. 界面：点「怎么做」打开的必须是这一条任务的步骤 ----------------
  // 直接打开任务页（openTop 在面板已显示同一页时会收起，不适合测试）
  await E('CM.ui.taskTab="active";CM.ui.openPage("tasks","active",{root:true});true');
  // 必须等任务页真的打开（面板不能再处于关闭状态，否则点按钮会落到空栈上）
  await until('CM.ui.stack.length&&CM.ui.stack[CM.ui.stack.length-1].kind==="tasks"&&!CM.ui.right.classList.contains("closed")');
  await delay(400);
  await until('!!document.querySelector(".tk-card, .tk-row")');
  const hasReal = await E('!!document.querySelector(".tk-card .btn")');
  if (!hasReal) {
    // 开局没有进行中的任务时临时挂一条，只为验证界面路径
    await E(`(function(){const g=CM.game,m=g.model;g.tasks.active.push({id:'ui-how',kind:'dyn',status:'active',type:'connect',title:'界面测试：连通两处',
      desc:'',anchors:[{name:'测试甲站',x:m.zCx[0],y:m.zCy[0],r:3},{name:'测试乙站',x:m.zCx[1],y:m.zCy[1],r:3}],
      months:12,deadline:[g.clock.y+1,g.clock.m],issuedAt:[g.clock.y,g.clock.m],reward:1000});CM.ui.rerenderPage();return true;})()`);
    await delay(600);
  }
  const clicked = await E(`(function(){
    const cards=[...document.querySelectorAll('.tk-card,.tk-row')];
    for(const c of cards){
      const b=[...c.querySelectorAll('button')].find(x=>x.textContent.trim()==='怎么做');
      if(b){ b.click(); return b.closest('.tk-card,.tk-row').querySelector('.tk-title,.grow b')?.textContent||'任务'; }
    }
    return null;
  })()`);
  assert.ok(clicked, '任务卡上应有「怎么做」按钮');
  await until('CM.ui.stack.length&&CM.ui.stack[CM.ui.stack.length-1].kind==="how"');
  await delay(500);
  console.log('stack before/after:', await E('CM.ui.stack.map(function(s){return s.kind+":"+s.id;}).join(" > ")'));
  const ui = await E(`(function(){
    const el=document.querySelector('.how-page');
    const steps=[...document.querySelectorAll('.how-step')];
    return {
      isGuide: !!document.querySelector('.guide-page'),
      title: document.querySelector('#rightPanel .p-title,#rightPanel .r-title,h2')?.textContent||'',
      steps: steps.length,
      withWhere: steps.filter(s=>s.querySelector('.how-where')).length,
      withActs: steps.filter(s=>s.querySelector('.how-acts button')).length,
      firstText: steps[0]?steps[0].textContent.trim().slice(0,80):'',
      secs: document.querySelectorAll('.how-sec').length,
      goal: document.querySelector('.how-goal')?.textContent||'',
      stack: CM.ui.stack.map(s=>s.kind),
      task: CM.ui.stack[CM.ui.stack.length-1].id
    };
  })()`);
  assert.equal(ui.isGuide, false, '「怎么做」不能再跳到新手指南');
  assert.ok(ui.secs >= 1, '至少一组步骤');
  assert.ok(ui.steps >= 3, '步骤应有 3 步以上，实际 ' + ui.steps);
  assert.ok(ui.withWhere >= ui.steps - 1, '绝大多数步骤要写明在哪里操作');
  assert.ok(ui.withActs >= 1, '步骤要带可以直接点的入口');
  assert.ok(/目标：/.test(ui.goal), '页头要写明这条任务的目标');
  assert.ok(ui.stack.length >= 2 && ui.stack[ui.stack.length - 2] === 'tasks', '从任务页进来应能返回上级，实际 ' + ui.stack.join('>'));

  // 点「切到「建站」」应真的切换工具
  const switched = await E(`(function(){
    const b=[...document.querySelectorAll('.how-acts button')].find(x=>/建站|绘线/.test(x.textContent));
    if(!b) return 'no-button';
    b.click();
    return CM.ui.tools.tool;
  })()`);
  assert.ok(switched === 'station' || switched === 'line', '步骤按钮应切到对应工具，实际 ' + switched);

  const shot = path.join(os.tmpdir(), 'cm-howto-1280.png');
  await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }).then(r => fs.writeFile(shot, Buffer.from(r.data, 'base64')));

  // ---------------- 3. 英文界面：步骤要整句英文，不能是逐词替换出来的中英混排 ----------------
  await E('CM.I18n.apply("en");CM.ui.rerenderPage();true');
  await delay(700);
  const enSteps = await E(`(function(){const a=[...document.querySelectorAll('.how-step .how-what')].map(x=>x.textContent.trim());return {n:a.length,han:a.filter(t=>/[\\u3400-\\u9fff]/.test(t)).slice(0,2),first:a[0]||''};})()`);
  assert.ok(enSteps.n >= 3, '英文界面下也应有步骤');
  assert.deepEqual(enSteps.han, [], '英文界面下的步骤出现了汉字：' + enSteps.han.join(' / '));
  assert.ok(/[a-z]/i.test(enSteps.first), '英文步骤应是英文，实际：' + enSteps.first.slice(0, 80));
  const enShot = path.join(os.tmpdir(), 'cm-howto-en-1280.png');
  await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }).then(r => fs.writeFile(enShot, Buffer.from(r.data, 'base64')));
  await E('CM.I18n.apply("zh-CN");CM.ui.rerenderPage();true');
  await delay(400);
  console.log('PASS 英文界面步骤为整句英文（' + enSteps.n + ' 步）· ' + enShot);

  await E('CM.ui.back();true');
  await delay(400);
  assert.equal(await E('CM.ui.stack[CM.ui.stack.length-1].kind'), 'tasks', '返回应回到任务列表');
  console.log('PASS 任务卡的「怎么做」按任务生成步骤（' + ui.steps + ' 步，' + ui.withWhere + ' 步写明位置，' + ui.withActs + ' 步可点）');
  console.log('shot ' + shot);
  assert.deepEqual(errors, [], '浏览器报错：' + errors.join('\n'));
  ws.close();
} finally {
  edge.kill();
  server.close();
  await fs.rm(task, { recursive: true, force: true }).catch(() => { });
}
