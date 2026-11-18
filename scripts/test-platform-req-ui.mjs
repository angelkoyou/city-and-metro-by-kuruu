// v4.1 回归：站台规模下限改为「按当前时段正在运行的列车最大编组」动态计算，
// 界面把不达标的规模档位置灰禁用（而不是建站时弹提示）。
// 用隔离的 Chromium 跑真实界面，不读写玩家存档。
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

const task = await fs.mkdtemp(path.join(os.tmpdir(), 'city-metro-v41ui-')), profile = path.join(task, 'profile');
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
let ws, send;
try {
  let port;
  for (let i = 0; i < 100; i++) { try { port = Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; } catch { } await delay(100); }
  if (!port) throw Error('No debug port');
  const target = await httpJson('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent('http://127.0.0.1:' + server.address().port + '/'), 'PUT');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let seq = 0; const waiting = new Map(), errors = [];
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
  const shotsDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)), 'shots');
  const shot = async name => { const r = await send('Page.captureScreenshot', { format: 'png' }); await fs.mkdir(shotsDir, { recursive: true }); await fs.writeFile(path.join(shotsDir, name + '.png'), Buffer.from(r.data, 'base64')); };
  const until = async (exp, ms = 120000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await E(exp)) return; await delay(150); } throw Error('Wait timeout: ' + exp + '\n' + errors.join('\n')); };

  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/' });
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });

  await until('!!window.CM?.ui&&!!document.querySelector(".start-menu")');
  await E('CM.Settings.set("autosave",false);CM.Settings.set("sound",false);true');
  await E('CM.newGame({map:"bj",mode:"challenge",seed:20261111});true');
  await until('!CM.isLoading()&&!!CM.game&&!CM.game.pending');
  await E('CM.ui.closeScreen();CM.game.setSpeed(0);CM.ui.toasts.replaceChildren();true');

  // ---------------- 1. 数据层：下限 = 当前运行列车的最大编组 ----------------
  const base = await E(`(()=>{const g=CM.game,F=CM.Fleet,M=CM.Metro;
    const ls=Object.keys(g.net.lines);
    const pick=function(cars){for(const lid of ls){const c=F.runCars(g,lid);if(c===cars)return lid}return null};
    return {ls:ls, l4:pick(4), l6:pick(6), run:ls.map(lid=>[lid,F.runCars(g,lid)]), need4:M.formationSize(4), need6:M.formationSize(6), need8:M.formationSize(8)}})()`);
  assert.ok(base.l4, '北京开局有一条 4 节编组的线路');
  assert.ok(base.l6, '北京开局有一条 6 节编组的环线');
  assert.equal(base.need4, null, '4 节不设门槛');
  assert.equal(base.need6, 'M', '6 节要中型及以上');
  assert.equal(base.need8, 'L', '8 节要大型及以上');
  const lid4 = base.l4, lid6 = base.l6;
  console.log('PASS 数据层：4/6/8 节对应的规模门槛');

  // ---------------- 2. 线路站台升到大型后换 8 节车：下限抬到大型 ----------------
  // 说明：真实操作是先花建设费把沿线站台升到大型、确认建设，这里直接改正式线网与编译结果的
  // 站台档位，省掉一次完整的交通重算（与本目录其他 UI 测试的做法一致）。
  await E(`(()=>{const g=CM.game,lid=${JSON.stringify(lid4)},tp=CM.Metro.lineTopo(g.net,lid);
    for(const sid of tp.stations) if(g.net.stations[sid]) g.net.stations[sid].size='L';
    for(const r of g.model.net.C.routes) if(r.lineId===lid) r.cars=8;
    CM.Fleet.changed(g); g.econ.funds=5e10; return true})()`);
  await E(`(()=>{const g=CM.game;CM.Fleet.buy(g,${JSON.stringify(lid4)},null,"gen-a",8,1);return true})()`);
  const afterBuy = await E(`(()=>{const g=CM.game;return {cars:CM.Fleet.runCars(g,${JSON.stringify(lid4)}),req:CM.Fleet.reqCars(g,[${JSON.stringify(lid4)}])}})()`);
  assert.equal(afterBuy.cars, 8, '站台允许后，8 节列车正常上线');
  assert.equal(afterBuy.req, 8, '本线运行编组即下限');

  // 关键收益：站台够长但只跑 4 节时，不强制新站建大型（旧规则会按沿线站台卡成 8 节）
  const l4only = await E(`(()=>{const g=CM.game;const ls=Object.keys(g.net.lines).filter(function(x){return x!==${JSON.stringify(lid4)}});
    for(const lid of ls){const c=CM.Fleet.runCars(g,lid);if(c===4)return {lid:lid,cars:c}}return null})()`);
  if (l4only) assert.equal(await E(`CM.Fleet.reqCars(CM.game,[${JSON.stringify(l4only.lid)}])`), 4, '只跑 4 节的线路下限仍是 4');

  // ---------------- 3. 工具条：低于下限的规模置灰不可点 ----------------
  const openLineTool = async lid => {
    await E(`(()=>{const g=CM.game,T=CM.ui.tools;T.setTool('line');
      const tp=CM.Metro.lineTopo(g.net,${JSON.stringify(lid)});
      T.chain=tp.stations[tp.stations.length-1];T.lineChoice=${JSON.stringify(lid)};T.lineLock=true;
      CM.ui.renderToolOpts();return true})()`);
    await delay(200);
  };
  const sizeBtns = () => E(`(()=>{const g=[...document.querySelectorAll('#toolopts .to-grp')].find(function(x){const k=x.querySelector('.to-k');return k&&k.textContent.trim()==='新站'});
    if(!g)return null;return {...{sel:(CM.ui.tools.stationSize||'')},btns:[...g.querySelectorAll('.seg-ctl button')].map(function(b){return {t:b.textContent.trim(),dis:!!b.disabled,on:b.classList.contains('on')}})}})()`);

  await openLineTool(lid4);
  let st = await sizeBtns();
  assert.ok(st, '绘线工具条上有「新站」规模选择');
  assert.deepEqual(st.btns.map(b => b.dis), [true, true, false, false, false, false], '小型/中型置灰，大型及以上可选');
  assert.equal(st.sel, 'L', '当前选择自动抬到大型');
  assert.equal(st.btns[2].on, true, '大型处于选中态');
  assert.match(await E(`(()=>{const g=[...document.querySelectorAll('#toolopts .to-grp')].find(function(x){const k=x.querySelector('.to-k');return k&&k.textContent.trim()==='新站'});return g.querySelectorAll('.seg-ctl button')[0].getAttribute('data-tip')||''})()`), /至少要大型/, '置灰原因写在提示里');
  await shot('v41-platform-gate');

  // 6 节线路：只挡小型，当前选择不低于中型即可（沿用上一步的「大型」也合法）
  await openLineTool(lid6 === lid4 ? lid4 : lid6);
  st = await sizeBtns();
  assert.deepEqual(st.btns.map(b => b.dis), [true, false, false, false, false, false], '6 节线路只挡小型');
  assert.notEqual(st.sel, 'S', '6 节线路不会停在小型');

  // ---------------- 4. 车站详情：同一套下限，低于下限的档位灰掉 ----------------
  const sid = await E(`(()=>{const g=CM.game,tp=CM.Metro.lineTopo(g.net,${JSON.stringify(lid4)});return tp.stations[1]})()`);
  await E(`CM.ui.openObj('station',${JSON.stringify(sid)},'build');true`);
  await until('!!document.querySelector(".size-seg")', 20000);
  const cards = await E('(()=>[...document.querySelectorAll(".size-seg button")].map(b=>({t:b.textContent.trim(),dis:!!b.disabled})))()');
  assert.deepEqual(cards.map(b => b.dis), [true, true, false, false, false, false], '车站页同样挡掉小型与中型');
  const note = await E('(()=>{const n=document.querySelector(".size-min-note");return n?n.textContent:""})()');
  assert.match(note, /8 节编组/, '写明按当前运行的 8 节编组算');
  assert.match(note, /不能低于大型/);
  await shot('v41-station-min');

  // 英文界面：说明与置灰提示都要整句翻译，不能留中文碎片
  await E('CM.Settings.set("language","en");CM.I18n.apply("en");true');
  await delay(400);
  const enNote = await E('(()=>{const n=document.querySelector(".size-min-note");return n?n.textContent:""})()');
  assert.ok(enNote && !/[\u4e00-\u9fff]/.test(enNote), '英文界面下说明已整句翻译：' + enNote);
  assert.match(enNote, /8-car/, '英文说明保留编组数');
  const enTip = await E('(()=>{const b=document.querySelector(".size-seg button");return b?(b.getAttribute("data-tip")||""):""})()');
  assert.ok(enTip && !/[\u4e00-\u9fff]/.test(enTip), '英文界面下置灰提示已翻译：' + enTip);
  await E('CM.Settings.set("language","zh-CN");CM.I18n.apply("zh-CN");true');
  await delay(300);

  // ---------------- 5. 手动调度本时段 0 列 → 没有运行列车就没有下限 ----------------
  const zero = await E(`(()=>{const g=CM.game,lid=${JSON.stringify(lid4)};
    const rt=g.model.net.C.routes.find(function(r){return r.lineId===lid});
    const key=CM.Fleet.svcId(rt,rt.loop?0:0);
    g.fleet.ops[lid]={mode:'manual',n:{}};g.fleet.ops[lid].n[key]=[0,0,0,0];
    CM.Fleet.changed(g);
    return {cars:CM.Fleet.runCars(g,lid),period:CM.Fleet.periodOf(g)}})()`);
  assert.equal(zero.cars, null, '本时段停运时没有下限');
  await openLineTool(lid4);
  st = await sizeBtns();
  assert.deepEqual(st.btns.map(b => b.dis), [false, false, false, false, false, false], '停运后全部可选');
  console.log('PASS 停运（手动 0 列）时取消下限');

  // 恢复自动调度
  await E(`(()=>{const g=CM.game,lid=${JSON.stringify(lid4)};delete g.fleet.ops[lid];CM.Fleet.changed(g);return true})()`);
  assert.equal(await E(`CM.Fleet.runCars(CM.game,${JSON.stringify(lid4)})`), 8, '恢复自动调度后重新按 8 节算');

  // ---------------- 6. 卖掉 8 节车 → 下限回到 4 节，全部可选 ----------------
  await E(`(()=>{const g=CM.game,lid=${JSON.stringify(lid4)};
    const ids=g.fleet.trains.filter(function(t){return t.line===lid&&t.cars>4}).map(function(t){return t.id});
    CM.Fleet.sell(g,ids);return true})()`);
  assert.equal(await E(`CM.Fleet.runCars(CM.game,${JSON.stringify(lid4)})`), 4, '卖掉长编组列车后回到 4 节');
  await openLineTool(lid4);
  st = await sizeBtns();
  assert.deepEqual(st.btns.map(b => b.dis), [false, false, false, false, false, false], '4 节时不设下限，所有规模可选');

  // ---------------- 7. 门槛仍是兜底：硬塞小站台会被拦住 ----------------
  const gated = await E(`(()=>{const g=CM.game,lid=${JSON.stringify(lid4)};
    g.econ.funds=5e10;CM.Fleet.buy(g,lid,null,"gen-a",8,1);
    const T=CM.ui.tools;T.setTool('line');
    const tp=CM.Metro.lineTopo(g.net,lid);T.chain=tp.stations[tp.stations.length-1];T.lineChoice=lid;T.lineLock=true;
    const r=T.platformGate(g.draft?g.draft.net:g.net,lid,T.chain,null,{size:'S',type:'underground'});
    return r?{cars:r.cars,need:r.need,is160:!!r.is160}:null})()`);
  assert.ok(gated, '绕过界面直接建小站台仍会被门槛拦住');
  assert.equal(gated.need, 'L', '门槛要求大型');

  assert.equal(errors.length, 0, 'Browser errors:\n' + errors.join('\n'));
  console.log('ALL PASS v4.1 UI：动态下限 / 置灰禁用 / 停运取消 / 卖车回落 / 门槛兜底');
} finally {
  if (send) await Promise.race([send('Browser.close').catch(() => { }), delay(1500)]);
  if (ws) ws.close();
  edge.kill();
  server.closeAllConnections();
  await new Promise(r => server.close(r));
  await fs.rm(task, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
}
