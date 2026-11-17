// 任务卡里「指向片区」的字段必须有可点的定位按钮（玩家反馈：只写「番禺居民」，不知道指哪一片）。
// 1) 数据覆盖：本城所有任务（时代目标、历史任务、动态任务、城市难题）里，凡是带 regions/areaName 的
//    字段（复合任务的分项、单项任务的目标行）都能生成按钮，且按钮能真的在地图上高亮并框住对应区域。
// 2) 界面：复合任务的分项行与单项 RegionCov 任务的目标行都出现同样样式的按钮，点击不打开新页面，
//    只把地图飞到片区；多区域任务一次框住全部区域。
// 3) 英文界面下按钮文字与提示不能残留汉字。
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

const task = await fs.mkdtemp(path.join(os.tmpdir(), 'city-metro-areas-')), profile = path.join(task, 'profile');
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

  // ---------------- 1. 数据：所有「指向片区」的字段都能生成定位按钮 ----------------
  const audit = await E(`(function(){
    const g=CM.game, out={fields:0,noBtn:[],noRegion:[],names:[],tasks:0,badArea:[],badRegion:[],planParts:0};
    const all=[];
    for(const e of (CM.DATA.eras||[])) for(const t of e.goals||[]) all.push(t);
    for(const t of (CM.DATA.histTasks||[])) all.push(t);
    for(const t of (CM.DATA.dynTasks||[])) all.push(t);
    for(const t of (CM.DATA.scenarios||[])) all.push(t);
    const seen=new Set();
    for(const h of all){
      const t=CM.Tasks.withPlan(g,h);
      if(seen.has(t.id)||!t) continue; seen.add(t.id);
      let has=false;
      if(t.regions&&t.regions.length){
        out.fields++; has=true;
        if(!CM.ui.taskAreaBtn(t.regions,t.areaName)) out.noBtn.push(t.id+': '+t.areaName);
        if(!t.regions.some(function(id){return g.city.regions.some(function(r){return r.id===id;});})) out.noRegion.push(t.id+': '+(t.regions||[]).join(','));
      }
      for(const p of (t.parts||[])){
        if(!p.regions||!p.regions.length) continue;
        out.fields++; has=true;
        if(!CM.ui.taskAreaBtn(p.regions,p.areaName)) out.noBtn.push(t.id+'/'+p.type+': '+p.areaName);
        if(!p.regions.some(function(id){return g.city.regions.some(function(r){return r.id===id&&!!r.bbox;});})) out.noRegion.push(t.id+'/'+p.type+': '+(p.regions||[]).join(','));
        out.names.push(p.areaName+' → '+p.regions.join('+'));
      }
      if(has) out.tasks++;
    }
    // 跨城市静态体检：所有任务方案里的片区 id 都要在本地图存在；写了 areaName 就不能缺 regions
    for(const mid in CM.TaskPlans){
      const P=CM.TaskPlans[mid], m=CM.MAPS[mid]; if(!m){out.badArea.push(mid+' 没有地图数据');continue;}
      const ids=new Set((m.data.regions||[]).map(function(r){return r.id;}));
      for(const tid in P) for(const p of (P[tid].parts||[])){
        out.planParts++;
        if(p.areaName&&(!p.regions||!p.regions.length)) out.badArea.push(mid+'/'+tid+'/'+p.type+' 有片区名却没有 regions');
        else for(const id of p.regions||[]) if(!ids.has(id)) out.badRegion.push(mid+'/'+tid+'/'+id);
      }
    }
    for(const mid in CM.MAPS){
      const m=CM.MAPS[mid], a=[];
      for(const e of (m.data.eras||[])) for(const t of e.goals||[]) a.push(t);
      for(const t of (m.data.histTasks||[])) a.push(t);
      for(const t of (m.data.dynTasks||[])) a.push(t);
      for(const t of (m.data.scenarios||[])) a.push(t);
      for(const t of a) if(t.areaName&&!(t.regions||[]).length) out.badArea.push(mid+'/'+t.id+' 写了「'+t.areaName+'」却没有 regions');
    }
    // 多区域任务要一次框住全部：直接验证 locateAreas 的高亮结构
    const two=(g.city.regions.filter(function(r){return !!r.bbox;}).slice(0,2)).map(function(r){return r.id;});
    const ok=CM.ui.locateAreas(two,'测试两片');
    const hl=CM.R.hl;
    out.multi={ok:ok,kind:hl&&hl.kind,n:hl&&hl.items?hl.items.length:0};
    return out;
  })()`);
  assert.equal(audit.noBtn.length, 0, '这些片区字段没有生成按钮：' + audit.noBtn.join('；'));
  assert.equal(audit.noRegion.length, 0, '这些片区 id 在地图上找不到：' + audit.noRegion.join('；'));
  assert.deepEqual(audit.badArea, [], '这些任务写了片区名却没有 regions（无法定位）：' + audit.badArea.join('；'));
  assert.deepEqual(audit.badRegion, [], '任务方案引用了本地图不存在的片区：' + audit.badRegion.join('；'));
  assert.ok(audit.fields >= 3, '本城带片区的任务字段应有 3 处以上，实际 ' + audit.fields);
  assert.ok(audit.planParts >= 20, '跨城任务方案应检查 20 个以上分项，实际 ' + audit.planParts);
  assert.deepEqual(audit.multi, { ok: true, kind: 'multi', n: 2 }, '两个片区应一次全部高亮并框住，实际 ' + JSON.stringify(audit.multi));
  console.log('PASS 本城 ' + audit.tasks + ' 条任务、' + audit.fields + ' 个片区字段都生成了定位按钮；跨城 ' + audit.planParts + ' 个方案分项片区 id 全部有效');

  // ---------------- 2. 界面：复合任务的分项与单项任务的目标行 ----------------
  // 用图里的真实任务「番禺北上通勤」（gz-g4）：复合任务，运营结果分项就是「番禺居民平均通勤」
  await E(`(function(){
    const g=CM.game;
    const h=(CM.DATA.eras||[]).flatMap(function(e){return e.goals||[];}).find(function(x){return x.id==='gz-g4';});
    const t=CM.Tasks.withPlan(g,h);
    t.kind='hist'; t.status='active'; t.progress=null;
    t.deadline=[g.clock.y+2,g.clock.m]; t.issuedAt=[g.clock.y,g.clock.m];
    CM.Tasks.prepare(t,g);
    g.tasks.active.push(t);
    CM.ui.taskTab='active'; CM.ui.openPage('tasks','active',{root:true});
    return true;
  })()`);
  await until('CM.ui.stack.length&&CM.ui.stack[CM.ui.stack.length-1].kind==="tasks"');
  await delay(600);
  const card = await E(`(function(){
    const cards=[...document.querySelectorAll('.tk-card')];
    const c=cards.find(function(x){return /番禺北上通勤/.test(x.textContent);});
    if(!c) return {found:false};
    const ops=[...c.querySelectorAll('.tk-part.ops')].find(function(x){return /番禺/.test(x.textContent);});
    const btn=ops&&ops.querySelector('.tk-area');
    return {found:true, hasPart:!!ops, text:ops?ops.querySelector('.tk-px').textContent.trim():'',
      btn:!!btn, label:btn?btn.textContent.trim():'', tip:btn?btn.getAttribute('data-tip'):'',
      style:btn?getComputedStyle(btn).borderTopStyle:'', radius:btn?getComputedStyle(btn).borderTopLeftRadius:'',
      partCount:c.querySelectorAll('.tk-part').length, areaCount:c.querySelectorAll('.tk-area').length};
  })()`);
  assert.equal(card.found, true, '任务卡没有渲染出「番禺北上通勤」');
  assert.equal(card.hasPart, true, '任务卡没有「运营结果」分项');
  assert.ok(/番禺/.test(card.text), '分项目标应写明「番禺居民平均通勤」，实际：' + card.text);
  assert.equal(card.btn, true, '「番禺居民」字段旁应有可点的定位按钮');
  assert.ok(/番禺/.test(card.label), '按钮应写明片区名，实际：' + card.label);
  assert.ok(/番禺/.test(card.tip || ''), '悬停提示应说明会定位到哪一片，实际：' + card.tip);
  assert.equal(card.style, 'dashed', '按钮样式应与站点锚点一致（虚线胶囊）');
  assert.equal(card.radius, '999px', '按钮应是胶囊形状，实际圆角 ' + card.radius);

  // 点击：任务页不跳走，地图高亮该片区并飞过去
  const before = await E(`(function(){
    const c=[...document.querySelectorAll('.tk-card')].find(function(x){return /番禺北上通勤/.test(x.textContent);});
    const b=c.querySelector('.tk-part.ops .tk-area');
    CM.ui._t0={stack:CM.ui.stack.length,zoom:CM.R.cam.zoom,c:[CM.R.cam.x,CM.R.cam.y]};
    b.click();
    return {stack:CM.ui.stack.length, st0:CM.ui._t0.stack};
  })()`);
  await delay(900);
  const clicked = await E(`(function(){
    const hl=CM.R.hl, rg=hl&&hl.kind==='region'?CM.game.city.regions[hl.region]:null, t0=CM.ui._t0;
    return {stack:CM.ui.stack.length, st0:t0.stack, kind:hl&&hl.kind, region:rg&&rg.name, label:hl&&hl.label,
      zoomChanged:Math.abs(CM.R.cam.zoom-t0.zoom)>1e-6||Math.abs(CM.R.cam.x-t0.c[0])>1e-6||Math.abs(CM.R.cam.y-t0.c[1])>1e-6};
  })()`);
  assert.equal(before.stack, before.st0, '点定位按钮不应打开新页面或改变栈');
  assert.equal(clicked.kind, 'region', '点击后应高亮区域，实际 ' + clicked.kind);
  assert.ok(/番禺/.test(clicked.region || ''), '高亮的应是番禺一带，实际 ' + clicked.region);
  assert.equal(clicked.label, '番禺', '高亮标签应用任务自己的片区名「番禺」，实际 ' + clicked.label);
  assert.equal(clicked.zoomChanged, true, '点击后地图应飞到该片区');

  // 单项 RegionCov：目标行也要有同样的按钮（用本城真实的「番禺」覆盖任务临时挂上）
  await E(`(function(){
    const g=CM.game;
    g.tasks.active.push({id:'ui-regioncov',kind:'dyn',status:'active',type:'regionCov',regions:['panyu_n'],areaName:'番禺',
      target:0.1,months:24,deadline:[g.clock.y+2,g.clock.m],issuedAt:[g.clock.y,g.clock.m],reward:1000,
      title:'界面测试：番禺覆盖',desc:'测试用'});
    CM.ui.rerenderPage(); return true;
  })()`);
  await delay(600);
  const goal = await E(`(function(){
    const c=[...document.querySelectorAll('.tk-card')].find(function(x){return /界面测试：番禺覆盖/.test(x.textContent);});
    if(!c) return {found:false};
    const goal=c.querySelector('.tk-goal'), btn=goal&&goal.querySelector('.tk-area');
    return {found:true,goal:!!goal,btn:!!btn,label:btn?btn.textContent.trim():'',
      hasRegion:!!(CM.R.hl&&CM.R.hl.kind==='region')};
  })()`);
  assert.equal(goal.found, true, '单项片区任务没有渲染');
  assert.equal(goal.btn, true, '单项片区任务的目标行也应有定位按钮');
  assert.ok(/番禺/.test(goal.label), '单项任务按钮应写明片区名，实际 ' + goal.label);

  // 可选挑战卡片（城市难题）也要有：说明文字里的片区名旁边同样能点
  await E(`(function(){
    const g=CM.game;
    g.tasks.offers=g.tasks.offers||[];
    g.tasks.offers.push({id:'ui-offer',kind:'opt',type:'regionCov',regions:['haizhu_n'],areaName:'海珠',target:0.3,
      title:'界面测试：海珠覆盖',desc:'海珠的居民需要地铁。',tips:[],months:24,expiresYM:g.ym()+3,reward:1000});
    CM.ui.rerenderPage(); return true;
  })()`);
  await delay(600);
  const offer = await E(`(function(){
    const c=[...document.querySelectorAll('.tk-offer')].find(function(x){return /界面测试：海珠覆盖/.test(x.textContent);});
    if(!c) return {found:false};
    const btn=c.querySelector('.tk-desc .tk-area');
    if(btn) btn.click();
    const hl=CM.R.hl, rg=hl&&hl.kind==='region'?CM.game.city.regions[hl.region]:null;
    return {found:true,btn:!!btn,label:btn?btn.textContent.trim():'',region:rg&&rg.name};
  })()`);
  assert.equal(offer.found, true, '可选挑战卡片没有渲染');
  assert.equal(offer.btn, true, '可选挑战的说明文字旁也应有片区定位按钮');
  assert.ok(/海珠/.test(offer.label), '挑战按钮应写明片区名，实际 ' + offer.label);
  assert.ok(/海珠/.test(offer.region || ''), '点击挑战上的按钮应定位到海珠，实际 ' + offer.region);

  // 按钮不能把任务卡撑出横向滚动（片区名很长时用省略号）
  const over = await E(`[...document.querySelectorAll('.tk-card,.tk-offer')].filter(function(c){return c.scrollWidth>c.clientWidth+1;}).map(function(c){var t=c.querySelector('.tk-title,.grow b');return t?t.textContent:'?';})`);
  assert.deepEqual(over, [], '任务卡被片区按钮撑出横向溢出：' + over.join('；'));

  const shot = path.join(os.tmpdir(), 'cm-task-area-1280.png');
  await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }).then(r => fs.writeFile(shot, Buffer.from(r.data, 'base64')));

  // ---------------- 3. 英文界面 ----------------
  await E('CM.I18n.apply("en");CM.ui.rerenderPage();true');
  await delay(700);
  const en = await E(`(function(){
    const out=[];
    for(const b of document.querySelectorAll('.tk-area')){
      out.push({text:b.textContent.trim(), tip:b.getAttribute('data-tip')||'', aria:b.getAttribute('aria-label')||''});
    }
    return {n:out.length, bad:out.filter(function(x){return /[\\u3400-\\u9fff]/.test(x.text+' '+x.tip+' '+x.aria);}).slice(0,4),
      panyu:out.some(function(x){return /Panyu/i.test(x.text);}), first:out[0]||null};
  })()`);
  assert.ok(en.n >= 2, '英文界面下应仍有定位按钮，实际 ' + en.n);
  assert.deepEqual(en.bad, [], '英文界面下按钮仍有汉字：' + JSON.stringify(en.bad));
  assert.equal(en.panyu, true, '英文按钮应写出片区名 Panyu，实际 ' + JSON.stringify(en.first));
  const enShot = path.join(os.tmpdir(), 'cm-task-area-en-1280.png');
  await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }).then(r => fs.writeFile(enShot, Buffer.from(r.data, 'base64')));
  await E('CM.I18n.apply("zh-CN");CM.ui.rerenderPage();true');
  await delay(400);

  console.log('PASS 复合任务分项与单项任务目标行都有同一款定位按钮（可点、飞向片区、不跳页）');
  console.log('PASS 英文界面按钮为 Panyu / Show on map（无汉字）');
  console.log('shot ' + shot);
  console.log('shot ' + enShot);
  assert.deepEqual(errors, [], '浏览器报错：' + errors.join('\n'));
  ws.close();
} finally {
  edge.kill();
  server.close();
  await fs.rm(task, { recursive: true, force: true }).catch(() => { });
}
