// v5.0 UI 回归：车型分级 T1–T6、自动配置只补主力、城市特色车的购买与升级提示。
// 覆盖：车队页科技树等级徽标、车型一览徽标、购车卡片的等级与门禁说明、窄屏排版与英文文案。
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

const task = await fs.mkdtemp(path.join(os.tmpdir(), 'city-metro-v50-')), profile = path.join(task, 'profile');
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
  await E('CM.newGame({map:"gz",mode:"free",seed:20261119,startYear:2012});true');
  await until('!CM.isLoading()&&!!CM.game&&!CM.game.pending', 180000);
  await delay(600);
  await E(`(function(){const b=[...document.querySelectorAll('button')].find(x=>/开始规划/.test(x.textContent));if(b)b.click();return true;})()`);
  await delay(300);

  // 造一条五站线路，才有运营页与购车入口
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

  // ---------------- 1. 车队页：科技树等级徽标 ----------------
  await E('CM.ui.closeScreen();CM.ui.openPage("fleet",null,{root:true});true');
  await until('!!document.querySelector(".tt-row")');
  await delay(400);
  const tree = await E(`(function(){
    var rows=[...document.querySelectorAll('.tt-row')],out=[];
    for(var r of rows){out.push([...r.querySelectorAll('.tt-tier')].map(function(x){return {t:x.textContent.trim(),k:x.className}}));}
    var note=document.querySelector('.tt-wrap .note');
    var labels=rows.map(function(r){return r.querySelector('.tt-lb').textContent.trim()});
    return {labels:labels,tiers:out,note:note?note.textContent:''};
  })()`);
  assert.deepEqual(tree.labels, ['主力', '支线', '160'], '科技树三行：主力 / 城市支线 / 160');
  assert.deepEqual(tree.tiers[0].map(x => x.t), ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'], '主力一行 T1–T6 一款一级');
  assert.ok(tree.tiers[0].every(x => /trunk/.test(x.k)), '主力节点徽标用主力样式');
  assert.ok(tree.tiers[1].length >= 1 && tree.tiers[1].every(x => /^T[1-6]$/.test(x.t) && /city/.test(x.k)), '城市支线节点也有 T 级：' + J(tree.tiers[1]));
  assert.deepEqual(tree.tiers[2].map(x => x.t), ['D'], '160 支线标 D，不参与 T 级');
  assert.ok(tree.tiers[2].every(x => / d\b/.test(x.k)), 'D 徽标用独立样式');
  assert.match(tree.note, /T1–T6/, '说明写明 T1–T6 分级');
  assert.match(tree.note, /D 型车是独立的 160/, '说明写明 D 型车独立');
  // 车型一览：主力 / 城市 / D 型三种徽标都要出现
  const list = await E(`(function(){
    var out=[];for(var u of document.querySelectorAll('.fo-units .fo-unit')){var c=u.querySelector('.fo-tier');if(c)out.push({t:c.textContent.trim(),k:c.className});}
    return out;
  })()`);
  assert.ok(list.length >= 3, '车型一览有等级徽标：' + J(list));
  assert.ok(list.some(x => /主力$/.test(x.t)), '有主力车型徽标：' + J(list));
  assert.ok(list.some(x => /城市$/.test(x.t)), '有城市特色车型徽标：' + J(list));
  assert.ok(list.some(x => /^D 型专用$/.test(x.t)), '有 D 型专用徽标：' + J(list));
  await E(`(function(){var e=document.querySelector('.tt-wrap');if(e)e.scrollIntoView({block:'start'});return true;})()`);
  await delay(250);
  const tclip = await E(`(function(){var r=document.querySelector('.tt-wrap').getBoundingClientRect();var y=Math.max(0,Math.round(r.y-8));return {x:Math.max(0,Math.round(r.x-6)),y:y,width:Math.max(60,Math.min(Math.round(r.width+12),420)),height:Math.max(40,Math.min(Math.round(r.height+16),900-y)),scale:1};})()`);
  await shot('v50-fleet-tiers', tclip);
  console.log('PASS 1 科技树与车型一览的 T1–T6 / D 徽标');

  // ---------------- 2. 自动配置只补主力 ----------------
  const auto = await E(`(function(){var b=[...document.querySelectorAll('.fo-auto')].find(function(x){return /自动配置列车/.test(x.textContent)});return b?{txt:b.textContent.replace(/\\s+/g,' ')}:null})()`);
  assert.ok(auto, '有自动配置列车开关');
  assert.match(auto.txt, /只调主力 T 级车型/, '自动配置说明只补主力车型');
  assert.match(auto.txt, /城市特色车型不会被自动调派或购买/, '说明写明城市特色车不参与自动配置');
  const api = await E(`(function(){var F=CM.Fleet,g=CM.game;
    var city=F.available(g.mapId,g.clock.y).find(function(m){return F.isCity(m)});
    return {city:city.id,label:F.tierLabel(city),cityPick:F.canAutoPick(g,city),trunkPick:F.canAutoPick(g,F.model('gen-eco')),
      d:F.tierLabel(F.model('gen-d160')),trunkT:F.tierLabel(F.model('gen-eco'))};})()`);
  assert.equal(api.cityPick, false, '城市特色车型不能被自动选用：' + J(api));
  assert.equal(api.trunkPick, true, '主力车型可自动选用');
  assert.match(api.label, /^T[1-6]$/, '城市车型等级是 T 级：' + api.label);
  assert.match(api.trunkT, /^T[1-6]$/, '主力车型等级是 T 级');
  assert.equal(api.d, 'D', 'D 型车等级为 D');
  console.log('PASS 2 自动配置只补主力车型，城市特色车门禁生效');

  // ---------------- 3. 购车卡片：等级 + 门禁说明 ----------------
  await E(`CM.ui.closeScreen();CM.ui.showTrainShop(${J(lid)},null,'11 号线',8);true`);
  await until('!!document.querySelector(".fo-model")');
  await delay(400);
  const cards = await E(`(function(){
    var out=[];for(var c of document.querySelectorAll('.fo-model')){
      var n=c.querySelector('.fo-name'),t=c.querySelector('.fo-tier'),b=c.querySelector('b');
      out.push({name:b?b.textContent.trim():'',tier:t?t.textContent.trim():null,kind:t?t.className:null,on:c.classList.contains('on'),
        hint:[...c.querySelectorAll('.tiny')].map(function(x){return x.textContent.trim()}).join(' ')});
    }
    return out;
  })()`);
  assert.ok(cards.length >= 3, '购车面板有车型卡片：' + J(cards));
  assert.ok(cards.every(c => c.tier), '每张卡片都有等级徽标：' + J(cards));
  const def = cards.find(c => c.on);
  assert.ok(def, '有默认选中的车型');
  assert.match(def.tier, /^T\d 主力$/, '默认选中的是主力车型：' + def.tier);
  const cityCard = cards.find(c => /城市$/.test(c.tier || ''));
  assert.ok(cityCard, '城市特色车型卡片带「城市」徽标：' + J(cards));
  assert.match(cityCard.hint, /只能手动购买与调派/, '城市特色车卡片写明只能手动购买与调派：' + cityCard.hint);
  const dCard = cards.find(c => /^D 型专用$/.test(c.tier || ''));
  if (dCard) assert.ok(!/城市$/.test(dCard.tier), 'D 型车不标城市');
  await shot('v50-shop-tiers');
  console.log('PASS 3 购车卡片标出等级，城市特色车写明只能手动购买与调派');

  // ---------------- 4. 360px 窄屏不溢出 ----------------
  await E('CM.ui.closeScreen();true');
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 820, deviceScaleFactor: 1, mobile: true });
  await delay(300);
  await E('CM.ui.openPage("fleet",null,{root:true});true');
  await until('!!document.querySelector(".tt-row")');
  await delay(400);
  const narrow = await E(`(function(){
    var doc=document.documentElement,tiers=[...document.querySelectorAll('.fo-units .fo-tier')];
    var bad=tiers.filter(function(x){var r=x.getBoundingClientRect();return !r.width||r.right>360.5});
    var tree=[...document.querySelectorAll('.tt-tier')];
    return {sw:doc.scrollWidth,iw:innerWidth,n:tiers.length,tree:tree.length,bad:bad.map(function(x){return x.textContent.trim()})};
  })()`);
  assert.ok(narrow.n >= 3, '窄屏下车型一览徽标仍渲染：' + J(narrow));
  assert.ok(narrow.tree >= 9, '窄屏下科技树徽标仍渲染：' + J(narrow));
  assert.ok(narrow.sw <= narrow.iw + 1, '360px 下页面不横向滚动：' + J(narrow));
  assert.deepEqual(narrow.bad, [], '车型一览徽标没有被挤出视口：' + J(narrow));
  await E(`(function(){var e=document.querySelector('.tt-wrap');if(e)e.scrollIntoView({block:'start'});return true;})()`);
  await delay(220);
  const nclip = await E(`(function(){var r=document.querySelector('.tt-wrap').getBoundingClientRect();var y=Math.max(0,Math.round(r.y-6));return {x:0,y:y,width:360,height:Math.max(40,Math.min(Math.round(r.height+14),820-y)),scale:1};})()`);
  await shot('v50-tree-narrow', nclip);
  console.log('PASS 4 360px 窄屏下等级徽标完整可见，页面无横向滚动');

  // ---------------- 5. 英文界面 ----------------
  await E('CM.Settings.set("language","en");true');
  await delay(700);
  await E(`CM.ui.closeScreen();CM.ui.showTrainShop(${J(lid)},null,'11 号线',8);true`);
  await until('!!document.querySelector(".fo-model")');
  await delay(500);
  const en = await E(`(function(){
    var out=[];for(var c of document.querySelectorAll('.fo-model')){var t=c.querySelector('.fo-tier');if(t)out.push(t.textContent.trim());}
    var card=[...document.querySelectorAll('.fo-model')].find(function(c){return /city/i.test(c.textContent)});
    return {tiers:out,card:card?card.textContent.replace(/\\s+/g,' '):''};
  })()`);
  assert.ok(en.tiers.every(t => /^T[1-6] (mainline|city)$|^D-type only$/.test(t)), '英文等级徽标整句翻译：' + J(en.tiers));
  assert.ok(en.tiers.some(t => /mainline$/.test(t)), '英文主力徽标包含 mainline：' + J(en.tiers));
  assert.ok(en.tiers.some(t => /city$/.test(t)), '英文城市徽标包含 city：' + J(en.tiers));
  assert.ok(!/[\u3400-\u9fff]/.test(en.card), '英文卡片没有残留汉字：' + en.card);
  console.log('PASS 5 英文界面等级徽标为 Tn mainline / Tn city，无汉字残留');

  assert.deepEqual(errors, [], '不应有 JS 异常：' + errors.join('\n'));
  console.log('ALL PASS v5.0 车型分级 / 自动配置门禁 / 城市特色车升级入口');
} finally {
  try { ws && ws.close(); } catch { }
  try { edge.kill(); } catch { }
  try { server.close(); } catch { }
  try { await fs.rm(task, { recursive: true, force: true }); } catch { }
}
