// v5.3 UI 回归：线路示意图里的地铁导航。
// 覆盖：导航开关与空状态、下拉与点图选站、结果字段（耗时 / 换乘 / 票价 / 经过站点 / 换乘站）、
//       三种策略页签与「方案相同」提示、示意图压暗与高亮、导出 PNG 不带高亮、360px 窄屏、英文界面。
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

const task = await fs.mkdtemp(path.join(os.tmpdir(), 'city-metro-v53-')), profile = path.join(task, 'profile');
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
const J = JSON.stringify;
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
  const mouse = async p => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  };

  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/' });
  await until('!!window.CM?.ui&&!!document.querySelector(".start-menu")');
  await E('CM.Settings.set("autosave",false);CM.Settings.set("sound",false);true');
  await E('CM.newGame({map:"gz",mode:"free",seed:20261120,startYear:2012});true');
  await until('!CM.isLoading()&&!!CM.game&&!CM.game.pending', 180000);
  await delay(600);
  await E(`(function(){const b=[...document.querySelectorAll('button')].find(x=>/开始规划/.test(x.textContent));if(b)b.click();return true;})()`);
  await delay(300);

  // ---------------- 前提：两条线在中间站换乘（A-B-C-D 换 D-E-F），另有一条无关线路 ----------------
  const built = await E(`(function(){
    var g=CM.game,M=CM.Metro,c=g.city,out=null;
    for(var dy=-16;dy<=16&&!out;dy+=2){
      var cy=Math.round(c.H/2)+dy;
      for(var dx=-16;dx<=12&&!out;dx+=2){
        var cx=Math.round(c.W/2)+dx;
        var pts=[0,1,2,3,4,5].map(function(k){return [cx+k*4,cy]});
        var far=[[cx+4,cy+6],[cx+8,cy+6],[cx+12,cy+6]];
        if(!pts.concat(far).every(function(p){return M.checkSite(c,p[0],p[1],'underground').ok}))continue;
        var ids=pts.map(function(p){return M.addStation(g.net,p[0],p[1],{size:'M',type:'underground'},c)});
        var side=far.map(function(p){return M.addStation(g.net,p[0],p[1],{size:'M',type:'underground'},c)});
        if(ids.concat(side).some(function(x){return !x}))continue;
        var l1=M.newLine(g.net),l2=M.newLine(g.net),l3=M.newLine(g.net),k;
        for(k=1;k<=3;k++)M.addSegment(g.net,l1,ids[k-1],ids[k],[],'underground');
        for(k=4;k<=5;k++)M.addSegment(g.net,l2,ids[k-1],ids[k],[],'underground');
        M.addSegment(g.net,l3,side[0],side[1],[],'underground');M.addSegment(g.net,l3,side[1],side[2],[],'underground');
        g.net.lines[l1].name='31 号线';g.net.lines[l2].name='32 号线';g.net.lines[l3].name='33 号线';
        out={ids:ids,side:side,l1:l1,l2:l2,l3:l3};
      }
    }
    if(out)g.refreshOperations();
    return out;
  })()`);
  assert.ok(built && built.ids, '前提：能构造两条相接的线路与一条无关线路');
  const A = built.ids[0], F = built.ids[5];
  await delay(400);

  // ---------------- 1. 入口与空状态 ----------------
  await E('CM.ui.openNetMap();true');
  await until('!!document.querySelector(".nm-canvas .nm-svg")');
  await delay(400);
  const btn = await E(`(function(){var b=document.querySelector('.nm-navbtn');return b?{txt:b.textContent.trim(),dis:!!b.disabled,tip:b.getAttribute('data-tip')}:null})()`);
  assert.ok(btn, '示意图顶部有导航按钮');
  assert.equal(btn.txt, '导航', '未打开时按钮写「导航」');
  assert.equal(btn.dis, false, '地理线网下导航按钮可用');
  assert.match(btn.tip, /地铁导航/, '按钮提示写明地铁导航');
  await E(`document.querySelector('.nm-navbtn').click();true`);
  await until('!!document.querySelector(".nm-nav")');
  await delay(300);
  const empty = await E(`(function(){var n=document.querySelector('.nm-nav');
    return {title:n.querySelector('.nm-nav-title').textContent.trim(),hint:n.querySelector('.nm-nav-hint').textContent.trim(),
      tiny:[...n.querySelectorAll('.nm-nav-out .tiny')].map(x=>x.textContent.trim()),
      sels:n.querySelectorAll('.nm-nav-sel').length,opts:n.querySelectorAll('.nm-nav-sel option').length,
      tabs:[...n.querySelectorAll('.nm-nav-tabs button')].map(b=>b.textContent.trim())};})()`);
  assert.match(empty.title, /地铁导航/, '面板标题是地铁导航');
  assert.equal(empty.hint, '选择起点与终点站，查看三种乘车方案。', '空状态说明');
  assert.ok(empty.tiny.some(t => /点击图中的车站/.test(t)), '提示可以点图选站：' + J(empty.tiny));
  assert.equal(empty.sels, 2, '起点与终点两个下拉');
  const nSt = await E('CM.Nav.stations(CM.game).length');
  assert.equal(empty.opts, 2 * nSt + 2, '两个下拉各有「选择车站」+ 全部运营站');
  assert.deepEqual(empty.tabs, ['时间最短', '换乘最少', '车费最便宜'], '三种路线策略');
  assert.ok(!(await E('!!document.querySelector(".nm-svg.nav-on")')), '还没选站时不高亮');
  await shot('v53-nav-empty');
  console.log('PASS 1 导航入口、空状态与三种策略页签');

  // ---------------- 2. 下拉选站：结果字段 ----------------
  await E(`(function(){var s=document.querySelectorAll('.nm-nav-sel');
    s[0].value=${J(A)};s[0].dispatchEvent(new Event('change'));
    s[1].value=${J(F)};s[1].dispatchEvent(new Event('change'));return true;})()`);
  await delay(400);
  const res = await E(`(function(){
    var sum=document.querySelector('.nm-nav-sum');
    return {
      mins:sum?sum.querySelector('.nm-nav-big b').textContent.trim():null,
      kv:[...sum.querySelectorAll('.nm-nav-kv span')].map(x=>x.textContent.trim()),
      badges:sum.querySelectorAll('.nm-nav-badge').length,
      break:[...document.querySelectorAll('.nm-nav-break')].map(x=>x.textContent.trim())[0],
      legs:[...document.querySelectorAll('.nm-nav-leg')].map(function(l){return {
        line:l.querySelector('.nm-nav-legh b').textContent.trim(),
        dir:l.querySelector('.nm-nav-legh .tiny').textContent.trim(),
        stops:l.querySelector('.nm-nav-stops').textContent.trim(),
        nStops:l.querySelectorAll('.nm-nav-stops b').length,
        meta:l.querySelector('.nm-nav-legm').textContent.trim()};}),
      xf:[...document.querySelectorAll('.nm-nav-xf')].map(function(x){return {txt:x.textContent.replace(/\\s+/g,' ').trim(),
        badge:x.querySelector('.nm-nav-badge')?x.querySelector('.nm-nav-badge').textContent.trim():'',
        name:x.querySelector('b')?x.querySelector('b').textContent.trim():''};}),
      end:document.querySelector('.nm-nav-end')?document.querySelector('.nm-nav-end').textContent.trim():'',
      note:document.querySelector('.nm-nav-note')?document.querySelector('.nm-nav-note').textContent.trim():''
    };
  })()`);
  assert.ok(Number(res.mins) >= 1, '总耗时是分钟数：' + res.mins);
  assert.equal(res.kv.length, 3, '摘要三行：换乘 / 票价 / 里程');
  assert.match(res.kv[0], /^换乘 1 次$/, '换乘次数：' + res.kv[0]);
  assert.match(res.kv[1], /^票价 ¥/, '票价：' + res.kv[1]);
  assert.match(res.kv[2], /km$/, '乘距：' + res.kv[2]);
  assert.equal(res.badges, 2, '线路徽标按乘坐顺序排列');
  assert.match(res.break, /^乘车 \d+ 分钟 · 候车 \d+ 分钟 · 换乘步行 \d+ 分钟$/, '耗时构成：' + res.break);
  assert.equal(res.legs.length, 2, '两段乘车');
  assert.deepEqual(res.legs.map(l => l.line), ['31 号线', '32 号线'], '按顺序走两条线');
  assert.ok(res.legs.every(l => /^往 .+ 方向$/.test(l.dir)), '每段写明方向：' + J(res.legs.map(l => l.dir)));
  assert.ok(res.legs[0].stops.split('→').length === 4, '第一段经过 4 座站：' + res.legs[0].stops);
  assert.ok(res.legs[0].meta.startsWith('3 站 · 乘车 '), '第一段 3 个区间：' + res.legs[0].meta);
  assert.equal(res.xf.length, 1, '一个换乘站');
  assert.match(res.xf[0].txt, /^在 .+ 换乘/, '换乘行写在哪个站换乘：' + res.xf[0].txt);
  assert.equal(res.xf[0].badge, '32', '换乘行标出换乘线路：' + J(res.xf));
  assert.equal(res.xf[0].name, '', '「32 号线」这类自动名不重复写：' + J(res.xf[0]));
  assert.match(res.xf[0].txt, /站内步行 4 分钟/, '站内换乘按步行 4 分钟计：' + res.xf[0].txt);
  assert.match(res.end, /^到达 /, '写明终点');
  assert.match(res.note, /候车取发车间隔的一半/, '脚注说明估算口径');
  await shot('v53-nav-result');
  console.log('PASS 2 结果展示：推荐路线 / 经过站点 / 换乘站 / 耗时 / 换乘次数 / 票价 / 里程');

  // ---------------- 3. 示意图高亮 ----------------
  const hl = await E(`(function(){var s=document.querySelector('.nm-svg');
    var rest=[...s.querySelectorAll('.nm-lines > g[data-segment]:not(.nav-hl)')];
    var dim=rest.length?Number(getComputedStyle(rest[0]).opacity):1;
    return {on:s.classList.contains('nav-on'),hl:s.querySelectorAll('.nm-lines > g.nav-hl').length,
      dots:s.querySelectorAll('.nm-dots > .nav-st').length,labels:s.querySelectorAll('.nm-labels text.nav-st').length,
      x:s.querySelectorAll('.nav-x').length,segs:s.querySelectorAll('.nm-lines > g[data-segment]').length,
      dim:dim,rest:rest.length,
      badgeOn:s.querySelectorAll('.nm-badges g.nav-hl').length,badgeAll:s.querySelectorAll('.nm-badges g').length};})()`);
  assert.equal(hl.on, true, '高亮时整张图进入导航模式');
  assert.equal(hl.hl, 5, '五个区间全部高亮：' + J(hl));
  assert.equal(hl.segs, 7, '无关线路仍然画在图上（只是压暗）：' + J(hl));
  assert.equal(hl.rest, 2, '两个区间不在方案里');
  assert.ok(hl.dim < 0.3, '不在方案里的区间被压暗：' + hl.dim);
  assert.equal(hl.dots, 6, '两段的 6 座车站高亮');
  assert.ok(hl.labels >= 1, '站名跟着高亮');
  assert.ok(hl.x >= 1, '换乘站单独标记');
  assert.ok(hl.badgeOn >= 2 && hl.badgeOn < hl.badgeAll, '用到的线路端点徽标保持清晰，无关线路跟着压暗：' + J(hl));
  await shot('v53-nav-highlight');
  console.log('PASS 3 示意图高亮线路与站点，换乘站单独标记');

  // ---------------- 4. 三种策略页签 ----------------
  const tab1 = await E(`(function(){return [...document.querySelectorAll('.nm-nav-tabs button')].map(function(b){return {k:b.dataset.strat,on:b.classList.contains('on'),p:b.getAttribute('aria-pressed')}})})()`);
  assert.deepEqual(tab1.map(t => t.on), [true, false, false], '默认时间最短');
  assert.equal(tab1[0].p, 'true', '页签带 aria-pressed');
  await E(`document.querySelector('.nm-nav-tabs [data-strat="xfer"]').click();true`);
  await delay(300);
  const xf2 = await E(`(function(){var b=document.querySelector('.nm-nav-tabs [data-strat="xfer"]'),same=document.querySelector('.nm-nav-same');
    return {on:b.classList.contains('on'),p:b.getAttribute('aria-pressed'),same:same?same.textContent.trim():'',
      hl:document.querySelectorAll('.nm-lines > g.nav-hl').length,sum:!!document.querySelector('.nm-nav-sum')};})()`);
  assert.equal(xf2.on, true, '切到换乘最少'); assert.equal(xf2.p, 'true');
  assert.equal(xf2.sum, true, '切换后仍有结果');
  assert.equal(xf2.hl, 5, '高亮随策略重算');
  assert.match(xf2.same, /^与「.*时间最短.*」相同$/, '方案相同时给出说明：' + xf2.same);
  await E(`document.querySelector('.nm-nav-tabs [data-strat="fare"]').click();true`);
  await delay(300);
  const fr2 = await E(`(function(){var b=document.querySelector('.nm-nav-tabs [data-strat="fare"]'),same=document.querySelector('.nm-nav-same');
    return {on:b.classList.contains('on'),same:same?same.textContent.trim():'',kv:[...document.querySelectorAll('.nm-nav-kv span')].map(x=>x.textContent.trim())};})()`);
  assert.equal(fr2.on, true, '切到车费最便宜');
  assert.match(fr2.same, /换乘最少/, '最便宜与换乘最少的方案相同：' + fr2.same);
  assert.match(fr2.kv[1], /^票价 /, '最便宜也给出票价');
  // 换回时间最短，后面几步沿用
  await E(`document.querySelector('.nm-nav-tabs [data-strat="time"]').click();true`);
  await delay(250);
  console.log('PASS 4 三种策略可切换，方案相同时有说明');

  // ---------------- 5. 点图选起点与终点 ----------------
  await E(`(function(){var s=document.querySelectorAll('.nm-nav-sel');
    s[0].value='';s[0].dispatchEvent(new Event('change'));
    s[1].value='';s[1].dispatchEvent(new Event('change'));return true;})()`);
  await delay(300);
  assert.ok(await E('!!document.querySelector(".nm-nav-hint")'), '清空后回到空状态');
  const pts = await E(`(function(){
    function c(sel){var e=document.querySelector(sel);if(!e)return null;var r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}}
    return {a:c('.nm-dots [data-st="${A}"]'),b:c('.nm-dots [data-st="${F}"]')};})()`);
  assert.ok(pts.a && pts.b, '车站圆点在图上可见');
  await mouse(pts.a);
  await delay(250);
  const after1 = await E(`(function(){var s=document.querySelectorAll('.nm-nav-sel');return {a:s[0].value,b:s[1].value,hint:!!document.querySelector('.nm-nav-hint')}})()`);
  assert.equal(after1.a, A, '第一次点站设为起点');
  assert.equal(after1.b, '', '终点还没选');
  assert.equal(after1.hint, true, '只选起点时仍是空状态');
  await mouse(pts.b);
  await delay(400);
  const after2 = await E(`(function(){var s=document.querySelectorAll('.nm-nav-sel');return {a:s[0].value,b:s[1].value,
    legs:document.querySelectorAll('.nm-nav-leg').length,hl:document.querySelectorAll('.nm-lines > g.nav-hl').length}})()`);
  assert.equal(after2.a, A, '起点保持');
  assert.equal(after2.b, F, '第二次点站设为终点');
  assert.equal(after2.legs, 2, '点图选站后同样给出方案');
  assert.equal(after2.hl, 5, '点图选站后同样高亮');
  // 两端都选好后再点一次＝重新选起点
  await mouse(pts.a);
  await delay(300);
  const after3 = await E(`(function(){var s=document.querySelectorAll('.nm-nav-sel');return {a:s[0].value,b:s[1].value}})()`);
  assert.equal(after3.a, A, '再点一次从新起点开始');
  assert.equal(after3.b, '', '终点被清空，等待第二次点选');
  await mouse(pts.b);
  await delay(350);
  console.log('PASS 5 点图选起点与终点，再点一次重新开始');

  // ---------------- 6. 导出 PNG 不带导航高亮 ----------------
  const before = await E('document.querySelectorAll(".nm-svg .nav-hl").length');
  await E(`document.querySelector('.nm-export').click();true`);
  await until('!!document.querySelector(".toast.t-good,.toast.t-bad")', 90000);
  const toast = await E(`(function(){var t=document.querySelector('.toast.t-bad')||document.querySelector('.toast.t-good');return {k:t.className,tx:t.querySelector('.tx').textContent.trim(),exp:!!document.querySelector('.nm-export').disabled}})()`);
  assert.ok(!/t-bad/.test(toast.k), '导航打开时也能导出：' + J(toast));
  assert.match(toast.tx, /已导出/, '导出成功的提示：' + toast.tx);
  const after = await E(`(function(){return {hl:document.querySelectorAll('.nm-svg .nav-hl').length,on:!!document.querySelector('.nm-svg.nav-on')}})()`);
  assert.equal(after.hl, before, '导出不改动屏幕上的高亮');
  assert.equal(after.on, true, '导出后导航仍在');
  console.log('PASS 6 导出 PNG 与导航高亮互不影响');

  // ---------------- 7. 360px 窄屏 ----------------
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 820, deviceScaleFactor: 1, mobile: true });
  await delay(400);
  await E('CM.NetMap.refresh(true);true');
  await until('!!document.querySelector(".nm-nav")');
  await delay(500);
  const nar = await E(`(function(){
    var nav=document.querySelector('.nm-nav').getBoundingClientRect(),body=document.querySelector('.nm-body'),win=document.querySelector('.nm-win');
    var sels=[...document.querySelectorAll('.nm-nav-sel')].map(function(x){return x.getBoundingClientRect()});
    var legs=document.querySelectorAll('.nm-nav-leg').length;
    var head=document.querySelector('.nm-win .stats-head');
    return {left:nav.left,right:nav.right,w:nav.width,dir:getComputedStyle(body).flexDirection,
      bad:sels.filter(function(r){return r.right>360.5||r.width<50}).length,legs:legs,
      headH:head.getBoundingClientRect().height,
      modeWrap:[...document.querySelectorAll('.nm-mode button')].filter(function(b){return b.scrollWidth>b.clientWidth+1||b.scrollHeight>b.clientHeight+1}).length,
      navW:document.querySelector('.nm-navbtn').getBoundingClientRect().width,
      over:win.scrollWidth-win.clientWidth,doc:document.documentElement.scrollWidth};})()`);
  assert.ok(nar.left >= -0.5 && nar.right <= 360.5, '导航面板不超出窄屏：' + J(nar));
  assert.equal(nar.dir, 'column', '窄屏下地图与导航上下排列');
  assert.equal(nar.bad, 0, '两个下拉都放得下');
  assert.ok(nar.over <= 1, '示意图窗口不横向溢出：' + nar.over);
  assert.ok(nar.headH <= 150, '窄屏头部不超过两行按钮：' + J(nar));
  assert.equal(nar.modeWrap, 0, '布局切换按钮不换行：' + J(nar));
  assert.ok(nar.navW >= 30, '导航按钮在窄屏仍然可点：' + nar.navW);
  assert.equal(nar.legs, 2, '窄屏同样有结果');
  await shot('v53-nav-narrow');
  console.log('PASS 7 360px 窄屏排版正常');

  // ---------------- 8. 英文界面 ----------------
  await send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 900, deviceScaleFactor: 1, mobile: false });
  await E(`CM.I18n.apply('en');true`);
  await E('CM.NetMap.refresh(true);true');
  await until('!!document.querySelector(".nm-nav")');
  await delay(500);
  const en = await E(`(function(){
    var n=document.querySelector('.nm-nav'),HAN=/[\\u4e00-\\u9fa5]/;
    var chrome=[n.querySelector('.nm-nav-title'),n.querySelector('.nm-nav-tabs'),n.querySelector('.nm-nav-kv'),n.querySelector('.nm-nav-note')];
    var xf=n.querySelector('.nm-nav-xf'),same=n.querySelector('.nm-nav-same');
    return {title:n.querySelector('.nm-nav-title').textContent.trim(),
      tabs:[...n.querySelectorAll('.nm-nav-tabs button')].map(function(b){return b.textContent.trim()}),
      labels:[...n.querySelectorAll('.nm-nav-f > span')].map(function(x){return x.textContent.trim()}),
      kv:[...n.querySelectorAll('.nm-nav-kv span')].map(function(x){return x.textContent.trim()}),
      xf:xf?xf.textContent.replace(/\\s+/g,' ').trim():'',same:same?same.textContent.trim():'',
      bad:chrome.filter(function(x){return x&&HAN.test(x.textContent)}).map(function(x){return x.textContent.replace(/\\s+/g,' ').trim()}),
      legs:document.querySelectorAll('.nm-nav-leg').length};})()`);
  assert.match(en.title, /Metro directions/, '英文标题：' + en.title);
  assert.deepEqual(en.tabs, ['Fastest', 'Fewest transfers', 'Cheapest fare'], '英文策略名');
  assert.deepEqual(en.labels, ['From', 'To'], '英文起终点标签：' + J(en.labels));
  assert.deepEqual(en.bad, [], '英文界面没有残留汉字：' + J(en.bad));
  assert.equal(en.kv[0], '1 transfer', '换乘一次用单数：' + J(en.kv));
  assert.match(en.xf, /min walk inside the station/, '站内换乘步行的整句译文：' + en.xf);
  assert.match(en.same, /^Same as /, '方案相同的说明也是整句：' + en.same);
  assert.equal(en.legs, 2, '英文界面同样给出方案');
  await shot('v53-nav-en');
  console.log('PASS 8 英文界面整句翻译');

  assert.deepEqual(errors, [], '控制台不应有报错：' + errors.join('\n'));
  console.log('ALL PASS v5.3 地铁导航 UI（8 组）');
} finally {
  try { ws?.close(); } catch { }
  try { edge.kill(); } catch { }
  try { server.close(); } catch { }
  await delay(200);
  try { await fs.rm(task, { recursive: true, force: true }); } catch { }
}
