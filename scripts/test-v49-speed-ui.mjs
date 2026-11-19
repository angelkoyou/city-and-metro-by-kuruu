// v4.9 UI 回归：每个运行车型的展示项都要显示最高时速，并验证窄屏下的排版与英文文案。
// 覆盖：列车运营页的配属列车行、车队总览的车型列、购车卡片的参数行、调出/出售弹窗的车型提示。
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

const task = await fs.mkdtemp(path.join(os.tmpdir(), 'city-metro-st49-')), profile = path.join(task, 'profile');
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

  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/' });
  await until('!!window.CM?.ui&&!!document.querySelector(".start-menu")');
  await E('CM.Settings.set("autosave",false);CM.Settings.set("sound",false);true');
  await E('CM.newGame({map:"gz",mode:"free",seed:20261119});true');
  await until('!CM.isLoading()&&!!CM.game&&!CM.game.pending', 180000);
  await delay(600);
  await E(`(function(){const b=[...document.querySelectorAll('button')].find(x=>/开始规划/.test(x.textContent));if(b)b.click();return true;})()`);
  await delay(300);

  // 一条五站线路，够长才有意义
  const lid = await E(`(function(){
    var g=CM.game,M=CM.Metro,c=g.city,base=null;
    for(var dy=-14;dy<=14&&!base;dy++)for(var dx=-14;dx<=14&&!base;dx++){
      var cy=Math.round(c.H/2)+dy,cx=Math.round(c.W/2)+dx;
      var pts=[-8,-4,0,4,8].map(function(k){return [cx+k,cy]});
      if(pts.every(function(p){return M.checkSite(c,p[0],p[1],'underground').ok}))base=pts;
    }
    if(!base)return null;
    var l=M.newLine(g.net);
    var s=base.map(function(p){return M.addStation(g.net,p[0],p[1],{size:'M',type:'underground'},c)});
    for(var k=1;k<s.length;k++)M.addSegment(g.net,l,s[k-1],s[k],[],'underground');
    g.net.lines[l].name='11 号线';
    g.refreshOperations();
    return l;
  })()`);
  assert.ok(lid, '前提：能构造一条五站线路');
  await delay(400);

  // 买两种不同限速的车型；当年只有一种时也要能看到最高时速
  const bought = await E(`(function(){
    var g=CM.game,F=CM.Fleet,lid=${J(lid)};g.econ.funds=2e9;
    var list=F.buyList(g,lid).list.slice().sort(function(x,y){return y.kmh-x.kmh});
    if(!list.length)return {ok:false};
    var a=list[0],b=list[list.length-1];
    var ca=a.fixedCars||Math.min(4,a.max),cb=b.fixedCars||Math.min(4,b.max);
    var r1=F.buy(g,lid,null,a.id,ca,2);
    var r2=(a.id===b.id)?{ok:true}:F.buy(g,lid,null,b.id,cb,2);
    F.sync(g);
    return {ok:!!(r1.ok&&r2.ok),a:a.id,ak:a.kmh,b:b.id,bk:b.kmh,n:list.length,e1:r1.error||null,e2:r2.error||null};
  })()`);
  assert.ok(bought.ok, '能买到列车：' + J(bought));
  assert.ok(bought.n >= 1, '当年至少有一种可用车型');
  await delay(500);

  // 页面内测量工具：避免在 CDP 表达式里堆嵌套花括号
  await E(`window.__kmhRows=function(){
    var F=CM.Fleet,out=[];
    for(var u of document.querySelectorAll('.fo-unit')){
      var chip=u.querySelector('.fo-kmh'),name=u.querySelector('.fo-unit-h b');
      var cs=chip?getComputedStyle(chip):null,cr=chip?chip.getBoundingClientRect():null,ur=u.getBoundingClientRect();
      var acts=u.querySelector('.fo-unit-acts');
      out.push({model:u.getAttribute('data-model'),name:name?name.textContent.trim():'',chip:chip?chip.textContent.trim():null,
        speed:chip?+chip.getAttribute('data-speed'):null,modelKmh:F.model(u.getAttribute('data-model')).kmh,
        w:cr?Math.round(cr.width):0,h:cr?Math.round(cr.height):0,weight:cs?+cs.fontWeight:0,
        bg:cs?cs.backgroundColor:null,
        rowSW:u.scrollWidth,rowCW:u.clientWidth,
        actsRight:Math.round((acts||u).getBoundingClientRect().right),rowRight:Math.round(ur.right)});
    }
    return out;
  };
  window.__kmhKinds=function(){
    var F=CM.Fleet,out=[];
    for(var k of document.querySelectorAll('.fo-kind')){
      var c=k.querySelector('.fo-kmh'),n=k.querySelector('.fo-kind-n');
      out.push({model:k.getAttribute('data-model'),name:n?n.textContent.trim():'',chip:c?c.textContent.trim():null,
        speed:c?+c.getAttribute('data-speed'):null,modelKmh:F.model(k.getAttribute('data-model')).kmh,
        sw:k.scrollWidth,cw:k.clientWidth});
    }
    return out;
  };
  window.__kmhCards=function(){
    var out=[];
    for(var c of document.querySelectorAll('.fo-model')){
      var b=c.querySelector('b'),chip=c.querySelector('.fo-kmh'),spec=c.querySelector('.fo-model-spec');
      out.push({name:b?b.textContent.trim():'',chip:chip?chip.textContent.trim():null,spec:spec?spec.textContent.trim():''});
    }
    return out;
  };true`);

  await E(`CM.ui.openObj('line',${J(lid)},'ops');true`);
  await until('!!document.querySelector(".fo-unit .fo-kmh")');
  await delay(400);

  // 1. 每行配属列车都有最高时速徽标，数值与车型数据一致
  const rows = await E('window.__kmhRows()');
  assert.ok(rows.length >= 1, '运营页有配属列车行：' + J(rows));
  for (const r of rows) {
    assert.ok(r.chip, '每个车型展示项都显示最高时速：' + J(r));
    assert.match(r.chip, /^最高 \d+ km\/h$/, '徽标文案是「最高 N km/h」：' + r.chip);
    assert.equal(r.speed, r.modelKmh, '徽标数值等于车型最高时速：' + J(r));
    assert.ok(r.w >= 46 && r.h >= 14, '徽标有足够尺寸，醒目可见：' + J(r));
    assert.ok(r.weight >= 700, '徽标数字加粗：' + J(r));
    assert.notEqual(r.bg, 'rgba(0, 0, 0, 0)', '徽标有底色，不与正文混在一起：' + J(r));
    assert.ok(r.rowSW <= r.rowCW + 1, '列车行在 420px 下不横向溢出：' + J(r));
    assert.ok(r.actsRight <= r.rowRight + 1, '操作按钮在卡片内：' + J(r));
  }
  console.log('PASS 1 列车运营页每个车型行都显示最高时速（' + rows.length + ' 行）');

  await E(`(function(){var e=document.querySelector('.fo-unit');if(e)e.scrollIntoView({block:'center'});return true;})()`);
  await delay(250);
  const clip = await E(`(function(){var r=document.querySelector('.fo-unit').getBoundingClientRect();var x=Math.max(0,Math.round(r.x-8)),y=Math.max(0,Math.round(r.y-8));return {x:x,y:y,width:Math.max(60,Math.min(Math.round(r.width+16),420-x)),height:Math.max(40,Math.min(Math.round(r.height+16),900-y)),scale:1};})()`);
  await shot('v49-ops-speed', clip);

  // 2. 调出 / 出售弹窗（数量弹窗）也带车型限速
  await E(`(function(){var b=[...document.querySelectorAll('.fo-unit button')].find(function(x){return x.textContent.trim()==='调出'});if(b&&!b.disabled)b.click();return true;})()`);
  await delay(500);
  const qty = await E(`(function(){var s=document.querySelector('.fo-qty-spec');return s?{txt:s.textContent.trim(),has:!!s.querySelector('.fo-kmh')}:null;})()`);
  if (qty) {
    assert.ok(qty.has, '调出/出售弹窗显示最高时速');
    assert.match(qty.txt, /最高 \d+ km\/h/, '弹窗徽标文案正确：' + qty.txt);
    await shot('v49-qty-speed');
    console.log('PASS 2 调出 / 出售弹窗带最高时速');
  } else console.log('SKIP 2 没有数量弹窗（单列直接调出）');

  // 3. 车队总览：每个车型一行，右侧带最高时速
  await E('CM.ui.closeScreen();CM.ui.openPage("fleet",null,{root:true});true');
  await until('!!document.querySelector(".fo-kind")');
  await delay(400);
  const kinds = await E('window.__kmhKinds()');
  assert.ok(kinds.length >= 1, '车队总览有车型行');
  for (const k of kinds) {
    assert.ok(k.chip, '车队总览每个车型都显示最高时速：' + J(k));
    assert.equal(k.speed, k.modelKmh, '车队总览徽标数值正确：' + J(k));
    assert.ok(k.sw <= k.cw + 1, '车型行不溢出单元格：' + J(k));
  }
  await E(`(function(){var e=document.querySelector('.fleet-grp');if(e)e.scrollIntoView({block:'start'});return true;})()`);
  await delay(250);
  const fleetClip = await E(`(function(){var r=document.querySelector('.fleet-grp');var t=r&&r.nextElementSibling;var box=(t&&t.classList.contains('tbl-wrap')?t:r);if(!box)return null;var b=box.getBoundingClientRect(),y=Math.max(0,Math.round(b.y-26));return {x:Math.max(0,Math.round(b.x-6)),y:y,width:Math.max(60,Math.min(Math.round(b.width+12),420)),height:Math.max(40,Math.min(Math.round(b.height+40),900-y)),scale:1};})()`);
  if (fleetClip) await shot('v49-fleet-speed', fleetClip);
  console.log('PASS 3 车队总览每个车型都标出最高时速（' + kinds.length + ' 项）');

  // 4. 购车卡片：参数拆成标签，最高时速用同款徽标
  await E(`CM.ui.closeScreen();CM.ui.showTrainShop(${J(lid)},null,'11 号线',8);true`);
  await until('!!document.querySelector(".fo-model")');
  await delay(300);
  const cards = await E('window.__kmhCards()');
  assert.ok(cards.length >= 1, '购车面板有车型卡片');
  for (const c of cards) {
    assert.ok(c.chip && /km\/h/.test(c.chip), '购车卡片显示最高时速：' + J(c));
    assert.match(c.spec, /每节 \d+ 人/, '购车卡片保留每节定员：' + J(c));
  }
  await shot('v49-shop-speed');
  console.log('PASS 4 购车卡片显示最高时速（' + cards.length + ' 款）');

  // 5. 360px 窄屏：徽标仍完整可见，行不溢出
  await E('CM.ui.closeScreen();true');
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 820, deviceScaleFactor: 1, mobile: true });
  await delay(300);
  await E(`CM.ui.openObj('line',${J(lid)},'ops');true`);
  await until('!!document.querySelector(".fo-unit .fo-kmh")');
  await delay(500);
  const narrow = await E('window.__kmhRows()');
  for (const n of narrow) {
    assert.ok(n.rowSW <= n.rowCW + 1, '360px 下列车行不横向溢出：' + J(n));
    assert.ok(n.actsRight <= n.rowRight + 1, '360px 下操作按钮仍在卡片内：' + J(n));
    assert.ok(n.w >= 40, '360px 下徽标仍可读：' + J(n));
  }
  await E(`(function(){var e=document.querySelector('.fo-unit');if(e)e.scrollIntoView({block:'center'});return true;})()`);
  await delay(200);
  const nclip = await E(`(function(){var r=document.querySelector('.fo-unit').getBoundingClientRect();var x=Math.max(0,Math.round(r.x-8)),y=Math.max(0,Math.round(r.y-8));return {x:x,y:y,width:Math.max(60,Math.min(Math.round(r.width+16),360-x)),height:Math.max(40,Math.min(Math.round(r.height+16),820-y)),scale:1};})()`);
  await shot('v49-ops-narrow', nclip);
  console.log('PASS 5 360px 窄屏下最高时速完整可见、无横向溢出');

  // 6. 英文界面：徽标整句翻译，没有残留汉字
  await E('CM.Settings.set("language","en");true');
  await delay(700);
  await E(`CM.ui.openObj('line',${J(lid)},'ops');true`);
  await until('!!document.querySelector(".fo-unit .fo-kmh")');
  await delay(400);
  const en = await E(`(function(){var u=document.querySelector('.fo-unit'),c=u.querySelector('.fo-kmh');return {chip:c.textContent.trim(),row:u.innerText.replace(/\\s+/g,' ').trim()};})()`);
  assert.match(en.chip, /^Max \d+ km\/h$/, '英文徽标整句翻译：' + en.chip);
  assert.ok(!/[\u3400-\u9fff]/.test(en.row), '英文列车行没有残留汉字：' + en.row);
  console.log('PASS 6 英文界面徽标为 Max N km/h，无汉字残留');

  assert.deepEqual(errors, [], '不应有 JS 异常：' + errors.join('\n'));
  console.log('ALL PASS v4.9 车型最高时速展示与页面排版');
} finally {
  try { ws && ws.close(); } catch { }
  try { edge.kill(); } catch { }
  try { server.close(); } catch { }
  try { await fs.rm(task, { recursive: true, force: true }); } catch { }
}
