// v5.5 UI 回归：科技树里的 T7 超级列车与 160 支线的 D 型超级列车。
// 覆盖：科技树 7 个主力节点与 2 个 D 型节点、车型一览的 T7 / D 徽标、购车卡片的图例与线路色带、
//       普通线只卖 T7 不卖 D 型、160 线只卖 D 型超级列车、英文界面。
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

const task = await fs.mkdtemp(path.join(os.tmpdir(), 'city-metro-v55-')), profile = path.join(task, 'profile');
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
const J = JSON.stringify, HAN = /[\u4e00-\u9fa5]/;
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
  await send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/' });
  await until('!!window.CM?.ui&&!!document.querySelector(".start-menu")');
  await E('CM.Settings.set("autosave",false);CM.Settings.set("sound",false);true');
  await E('CM.newGame({map:"gz",mode:"free",seed:20261120,startYear:2026});true');
  await until('!CM.isLoading()&&!!CM.game&&!CM.game.pending', 180000);
  await delay(600);
  await E(`(function(){const b=[...document.querySelectorAll('button')].find(x=>/开始规划/.test(x.textContent));if(b)b.click();return true;})()`);
  await delay(300);

  // ---------------- 前提：一条普通线路 + 一条 160 线路 ----------------
  const built = await E(`(function(){
    var g=CM.game,M=CM.Metro,c=g.city;
    g.clock.y=2030;                       // 两款超级列车都已解锁
    var out={};
    var base=null;
    for(var dy=-18;dy<=18&&!base;dy+=2){
      var cy=Math.round(c.H/2)+dy,cx=Math.round(c.W/2)-8;
      var pts=[0,4,8,12,16].map(function(k){return [cx+k,cy]});
      if(pts.every(function(p){return M.checkSite(c,p[0],p[1],'underground').ok}))base=pts;
    }
    if(!base)return null;
    var l1=M.newLine(g.net);
    var s1=base.map(function(p){return M.addStation(g.net,p[0],p[1],{size:'M',type:'underground'},c)});
    for(var k=1;k<s1.length;k++)M.addSegment(g.net,l1,s1[k-1],s1[k],[],'underground');
    g.net.lines[l1].name='41 号线';
    // 160 线路：站台必须大型及以上，另起一行避免与 41 号线重叠
    var base2=null;
    for(var dy2=8;dy2<=26&&!base2;dy2+=2){
      var cy2=Math.round(c.H/2)+dy2,cx2=Math.round(c.W/2)-8;
      var pts2=[0,4,8,12].map(function(k){return [cx2+k,cy2]});
      if(pts2.every(function(p){return M.checkSite(c,p[0],p[1],'underground').ok}))base2=pts2;
    }
    if(!base2)return null;
    var l2=M.newLine(g.net);
    var s2=base2.map(function(p){return M.addStation(g.net,p[0],p[1],{size:'L',type:'underground'},c)});
    for(var k2=1;k2<s2.length;k2++)M.addSegment(g.net,l2,s2[k2-1],s2[k2],[],'underground');
    g.net.lines[l2].name='42 号线'; g.net.lines[l2].speed=160;
    g.refreshOperations();
    out={l1:l1,l2:l2,c1:CM.Accessibility.line(g.net.lines[l1]),c2:CM.Accessibility.line(g.net.lines[l2])};
    return out;
  })()`);
  assert.ok(built && built.l1 && built.l2, '前提：能构造普通线路与 160 线路');
  await delay(600);

  // ---------------- 1. 科技树：主力 T1–T7、160 支线两款 D 型车 ----------------
  await E('CM.ui.closeScreen();CM.ui.openPage("fleet",null,{root:true});true');
  await until('!!document.querySelector(".tt-row")');
  await delay(400);
  const tree = await E(`(function(){
    var rows=[...document.querySelectorAll('.tt-row')],out=[];
    for(var r of rows){
      out.push({lb:r.querySelector('.tt-lb').textContent.trim(),
        nodes:[...r.querySelectorAll('.tt-node')].map(function(n){
          return {tier:n.querySelector('.tt-tier').textContent.trim(),k:n.querySelector('.tt-tier').className,
            name:n.querySelector('b').textContent.trim(), cls:n.className};})});
    }
    var note=document.querySelector('.tt-wrap .note');
    return {rows:out,note:note?note.textContent.replace(/\\s+/g,''):''};
  })()`);
  assert.deepEqual(tree.rows.map(r => r.lb), ['主力', '支线', '160'], '科技树三行');
  const trunk = tree.rows[0].nodes;
  assert.deepEqual(trunk.map(n => n.tier), ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'], '主力一行 T1–T7');
  assert.equal(trunk[6].name, '超级车', '第 7 级是超级列车');
  assert.match(trunk[6].cls, /\blit\b/, '2030 年 T7 已点亮');
  assert.ok(trunk.every(n => /trunk/.test(n.k)), '主力节点用主力徽标');
  const d160 = tree.rows[2].nodes;
  assert.deepEqual(d160.map(n => n.tier), ['D', 'D'], '160 支线两款 D 型车都标 D');
  assert.deepEqual(d160.map(n => n.name), ['D 型车', 'D 型超级车'], 'D 型车 → D 型超级车');
  assert.ok(d160.every(n => /\bd160\b/.test(n.cls)), '160 节点用独立样式');
  assert.ok(d160.every(n => /\blit\b/.test(n.cls)), '2030 年两款 D 型车都已点亮');
  assert.match(tree.note, /T1–T7/, '说明写明 T1–T7');
  assert.match(tree.note, /D型超级列车/, '说明提到 D 型超级列车');
  await E(`(function(){var e=document.querySelector('.tt-wrap');if(e)e.scrollIntoView({block:'start'});return true;})()`);
  await delay(250);
  await shot('v55-tech-tree');
  console.log('PASS 1 科技树主力 T1–T7、160 支线两款 D 型车');

  // ---------------- 2. 车型一览：T7 / D 徽标与图例 ----------------
  const list = await E(`(function(){
    var out=[];
    for(var u of document.querySelectorAll('.fo-units .fo-unit')){
      var c=u.querySelector('.fo-tier'), pic=u.querySelector('.fo-pic svg'), b=u.querySelector('.fo-name b');
      if(c)out.push({t:c.textContent.trim(),k:c.className,name:b?b.textContent.trim():'',svg:pic?pic.outerHTML:''});
    }
    return out;
  })()`);
  const t7row = list.find(x => x.name === '超级列车');
  const dsrow = list.find(x => x.name === 'D 型超级列车');
  assert.ok(t7row, '车型一览列出超级列车：' + J(list.map(x => x.name)));
  assert.equal(t7row.t, 'T7 主力');
  assert.match(t7row.k, /trunk/);
  assert.ok(dsrow, '车型一览列出 D 型超级列车');
  assert.equal(dsrow.t, 'D 型专用');
  assert.match(dsrow.k, /\bd\b/);
  assert.ok(/<svg/.test(t7row.svg) && /<svg/.test(dsrow.svg), '两款车都有图例');
  assert.ok(t7row.svg !== dsrow.svg, '两款车的图例是不同式样');
  console.log('PASS 2 车型一览的 T7 主力 / D 型专用徽标与独立图例');

  // ---------------- 3. 购车卡片：图例色带取所属线路的颜色 ----------------
  await E('CM.ui.showTrainShop("' + built.l1 + '",null,"41 号线 · 全程站站停",8);true');
  await until('!!document.querySelector(".fo-shop")');
  await delay(300);
  const shop1 = await E(`(function(){
    var out=[];
    for(var c of document.querySelectorAll('.fo-model')){
      var b=c.querySelector('.fo-name b'), pic=c.querySelector('.fo-pic svg');
      out.push({name:b?b.textContent.trim():'',tier:c.querySelector('.fo-tier')?c.querySelector('.fo-tier').textContent.trim():'',
        on:c.classList.contains('on'),svg:pic?pic.outerHTML:''});
    }
    return {cards:out,color:CM.Accessibility.line(CM.game.net.lines['${built.l1}'])};
  })()`);
  const c7 = shop1.cards.find(x => x.name === '超级列车');
  assert.ok(c7, '普通线路的购车列表里有超级列车：' + J(shop1.cards.map(x => x.name)));
  assert.equal(c7.on, true, '2030 年起默认选中 T7');
  assert.ok(shop1.cards.every(x => x.name !== 'D 型超级列车' && x.name !== 'D 型车'), '普通线路买不到 D 型车');
  assert.ok(c7.svg.indexOf(shop1.color) >= 0, 'T7 图例的色带用的是 41 号线的颜色 ' + shop1.color);
  assert.ok(shop1.cards.find(x => x.name === '全自动无人驾驶车').svg.indexOf(shop1.color) >= 0, '同列表里的其他车型也用线路色带');
  await shot('v55-shop-t7');
  await E('CM.ui.closeScreen();true');
  await delay(300);

  await E('CM.ui.showTrainShop("' + built.l2 + '",null,"42 号线 · 全程站站停",8);true');
  await until('!!document.querySelector(".fo-shop")');
  await delay(300);
  const shop2 = await E(`(function(){
    var out=[];
    for(var c of document.querySelectorAll('.fo-model')){
      var b=c.querySelector('.fo-name b'), pic=c.querySelector('.fo-pic svg');
      out.push({name:b?b.textContent.trim():'',tier:c.querySelector('.fo-tier')?c.querySelector('.fo-tier').textContent.trim():'',
        on:c.classList.contains('on'),svg:pic?pic.outerHTML:''});
    }
    return {cards:out,color:CM.Accessibility.line(CM.game.net.lines['${built.l2}'])};
  })()`);
  const cd = shop2.cards.find(x => x.name === 'D 型超级列车');
  assert.ok(cd, '160 线路的购车列表里有 D 型超级列车：' + J(shop2.cards.map(x => x.name)));
  assert.equal(cd.on, true, '2030 年起 160 线路默认选中 D 型超级列车');
  assert.ok(shop2.cards.every(x => x.name !== '超级列车'), '160 线路买不到普通轨道的 T7');
  assert.ok(cd.svg.indexOf(shop2.color) >= 0, 'D 型超级列车的图例色带用的是 42 号线的颜色 ' + shop2.color);
  const dOld = shop2.cards.find(x => x.name === 'D 型无人列车');
  assert.ok(dOld && dOld.tier === 'D 型专用', '旧 D 型车仍在列表里');
  await shot('v55-shop-ds');
  await E('CM.ui.closeScreen();true');
  console.log('PASS 3 购车卡片：普通线默认 T7、160 线默认 D 型超级列车，图例色带随线路颜色');

  // ---------------- 4. 地图渲染使用新外观 ----------------
  const era = await E(`(function(){var A=CM.Agents.ERA_TRAIN;
    return {sup:A.super&&{band:A.super.band,ends:A.super.ends,w:A.super.w},ds:A.superD&&{band:A.superD.band,ends:A.superD.ends,w:A.superD.w},
      look:CM.Fleet.model('gen-super').look.era,lookD:CM.Fleet.model('gen-d160-super').look.era};})()`);
  assert.ok(era.sup && era.sup.band === 'line', '地图外观表里有 T7，色带取线路色：' + J(era));
  assert.ok(era.ds && era.ds.band === 'line', '地图外观表里有 D 型超级列车');
  assert.ok(era.ds.w > era.sup.w, '双层车比单体车更宽');
  assert.equal(era.look, 'super'); assert.equal(era.lookD, 'superD');
  console.log('PASS 4 地图上的列车外观与新图例对应');

  // ---------------- 5. 英文界面 ----------------
  await E('CM.ui.openPage("fleet",null,{root:true});true');
  await until('!!document.querySelector(".tt-row")');
  await E('CM.I18n.apply("en");CM.ui.rerenderPage();true');
  await delay(600);
  await until('!!document.querySelector(".tt-row")');
  const en = await E(`(function(){
    var rows=[...document.querySelectorAll('.tt-row')];
    var trunk=rows[0]?[...rows[0].querySelectorAll('.tt-node')].map(function(n){return n.querySelector('b').textContent.trim()}):[];
    var d=rows[2]?[...rows[2].querySelectorAll('.tt-node')].map(function(n){return n.querySelector('b').textContent.trim()}):[];
    var bad=[...document.querySelectorAll('.tt-node, .tt-tier, .tt-lb, .fo-tier')].map(function(n){return n.textContent.trim()}).filter(function(s){return /[\\u4e00-\\u9fa5]/.test(s)});
    var note=document.querySelector('.tt-wrap .note');
    return {trunk:trunk,d:d,bad:bad,note:note?note.textContent.trim():''};
  })()`);
  assert.equal(en.trunk[6], 'Super Train', 'T7 的英文名：' + J(en.trunk));
  assert.equal(en.d[1], 'D-type Super Train', 'D 型超级列车的英文名：' + J(en.d));
  assert.deepEqual(en.bad, [], '科技树没有残留汉字：' + J(en.bad));
  assert.ok(!HAN.test(en.note), '科技树说明整句译成英文');
  assert.match(en.note, /T1–T7/);
  await shot('v55-tech-tree-en');
  console.log('PASS 5 英文界面：Super Train / D-type Super Train，科技树无残留汉字');

  assert.deepEqual(errors, [], '运行期间没有异常');
  console.log('ALL PASS v5.5 UI：T7 超级列车 / D 型超级列车 / 图例色带');
} finally {
  try { ws && ws.close(); } catch { }
  try { edge.kill(); } catch { }
  try { server.close(); } catch { }
  await fs.rm(task, { recursive: true, force: true }).catch(() => { });
}
