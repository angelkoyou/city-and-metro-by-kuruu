// v3.5 UI 回归：160 统一票价页签、TOD 第 5 级巨型门槛、同车型小编组补差价扩编。
// 用隔离的 Chromium 跑真实界面操作，不读写玩家存档。
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)), process.argv.includes('--dist') ? 'dist' : '');

// ---------------- 1. 数值校验：整数、小数、负数、空值与范围 ----------------
{
  const memory = new Map();
  const c = {
    console, performance, atob, btoa, TextEncoder, TextDecoder, setTimeout, clearTimeout,
    navigator: { hardwareConcurrency: 4, deviceMemory: 4 },
    matchMedia: () => ({ matches: false }),
    localStorage: { getItem: k => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, String(v)), removeItem: k => memory.delete(k) },
  };
  c.window = c;
  vm.createContext(c);
  const load = async src => vm.runInContext(await fs.readFile(path.join(root, src), 'utf8'), c, { filename: src });
  for (const [, src] of (await fs.readFile(path.join(root, 'index.html'), 'utf8')).matchAll(/<script src="([^"]+)"/g)) {
    await load(src);
    if (src === 'js/save.js') break;
  }
  const U = c.CM.U;
  assert.equal(typeof U.checkNum, 'function', 'U.checkNum 必须存在');
  const km = v => U.checkNum(v, { dp: 0, min: 1, max: 20 });
  const fare = v => U.checkNum(v, { dp: 1, min: 0, max: 10 });

  assert.equal(km('6').ok, true);
  assert.equal(km('6').value, 6, '整数原样通过');
  assert.equal(km(' 12 ').value, 12, '首尾空格不影响');
  assert.equal(km('2.5').code, 'decimal', '里程不接受小数');
  assert.equal(km('2.0').value, 2, '写成 2.0 仍算整数');
  assert.equal(km('-3').code, 'negative', '负数单独提示');
  assert.equal(km('abc').code, 'nan');
  assert.equal(km('1e3').code, 'nan', '科学计数法不接受');
  assert.equal(km('0').code, 'range');
  assert.equal(km('21').code, 'range');
  assert.equal(km('').code, 'empty');
  assert.equal(km('   ').code, 'empty');

  assert.equal(fare('2.5').value, 2.5, '票价保留一位小数');
  assert.equal(fare('2.55').code, 'decimal', '超出最小步长的小数要拦住');
  assert.equal(fare('10').value, 10);
  assert.equal(fare('10.1').code, 'range');
  assert.equal(fare('-1').code, 'negative');
  assert.equal(fare('').code, 'empty');
  console.log('PASS U.checkNum 数值校验');
}

// ---------------- 2. 真实浏览器：票价输入框 + 一键开发全部站台 ----------------
const candidates = [process.env.CM_BROWSER, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].filter(Boolean);
let browser;
for (const p of candidates) { try { await fs.access(p); browser = p; break; } catch { } }
if (!browser) throw Error('No Chromium browser found. Set CM_BROWSER to its executable path.');

const task = await fs.mkdtemp(path.join(os.tmpdir(), 'city-metro-v35ui-')), profile = path.join(task, 'profile');
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
// Node 的 fetch 会拒绝部分「不安全端口」，调试接口一律走 http.request
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
  const shot = async name => { const r = await send('Page.captureScreenshot', { format: 'png' }); await fs.writeFile(path.join(root, 'shots', name + '.png'), Buffer.from(r.data, 'base64')); };
  const until = async (exp, ms = 120000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await E(exp)) return; await delay(150); } throw Error('Wait timeout: ' + exp + '\n' + errors.join('\n')); };

  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/' });
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });

  await until('!!window.CM?.ui&&!!document.querySelector(".start-menu")');
  await E('CM.Settings.set("autosave",false);CM.Settings.set("sound",false);true');
  // 北京开局自带 1 号线与环线，TOD 面板一打开就有大量已接入运营的站台
  await E('CM.newGame({map:"bj",mode:"challenge",seed:20261111});true');
  await until('!CM.isLoading()&&!!CM.game&&!CM.game.pending');
  await until('!!(CM.game.model.stDaily&&CM.game.model.stDaily.inn&&CM.game.model.stDaily.inn.length&&!CM.game.model.dailyStale)', 180000);
  await E('CM.ui.closeScreen();CM.game.setSpeed(0);CM.ui.toasts.replaceChildren();true');
  await E('CM.ui.openTop("money");true');
  await until('!!document.querySelector(".fare-ed")');

  // ---------------- 1. 160 速度轨道统一票价页签 ----------------
  const tabState = () => E('(()=>{const b=[...document.querySelectorAll(".fare-tabs button")];return b.map(x=>({t:x.textContent,on:x.classList.contains("on"),disabled:!!x.disabled,tip:x.getAttribute("data-tip")||""}))})()');
  let tabs = await tabState();
  assert.equal(tabs.length, 2, '票价管理有两个页签');
  assert.match(tabs[0].t, /常规票价/); assert.match(tabs[1].t, /160 速度轨道统一票价/);
  assert.equal(tabs[0].on, true, '默认显示常规票价');
  assert.equal(tabs[1].disabled, true, '开局没有 160 轨道时统一票价页签置灰');
  assert.match(tabs[1].tip, /还没有 160/, '置灰原因写在提示里');
  const stdRows = await E('(()=>[...document.querySelectorAll(".fare-ed .fare-row")].filter(r=>!r.closest("[hidden]")).map(r=>r.querySelector(".fare-k").textContent))()');
  assert.deepEqual(stdRows, ['起步价', '起步里程', '每段里程', '每段加价', '封顶'], '常规票价编辑器字段');

  // 给一条线设成 160 km/h：页签解锁。只改线网数据，不进入草案
  const lid = await E('(()=>{const k=Object.keys(CM.game.net.lines)[0];CM.game.net.lines[k].speed=160;return k})()');
  await E('CM.ui.rerenderPage();true');
  await until('!!document.querySelector(".fare-tabs")');
  tabs = await tabState();
  assert.equal(tabs[1].disabled, false, '存在 160 轨道后页签可用');
  await E('(()=>{[...document.querySelectorAll(".fare-tabs button")][1].click();return true})()');
  await until('!!document.querySelector(".fare-note160")');
  tabs = await tabState();
  assert.equal(tabs[1].on, true, '切到 160 统一票价');
  assert.equal(tabs[0].on, false);
  const rows160 = await E('(()=>[...document.querySelectorAll(".fare-ed .fare-row")].filter(r=>!r.closest("[hidden]")).map(r=>r.querySelector(".fare-k").textContent))()');
  assert.deepEqual(rows160, stdRows, '统一票价的选项与正常票价管理完全一致');
  assert.equal(await E('!!document.querySelector(".fare-ed .switch")'), true, '统一票价也有随物价自动调价开关');
  assert.equal(await E('!!document.querySelector(".fare-ed .fare-mode")'), true, '计费方式切换可用');
  await shot('v35-fare160-tab');
  console.log('PASS 160 统一票价页签与编辑器');

  // 改 160 起步价并应用：只影响 fare160，常规票价与 model 同步
  const fareBefore = await E('JSON.stringify(CM.game.econ.fare)');
  const f160Before = await E('CM.game.econ.fare160.flat');
  const setInput = async (idx, val) => E(`(()=>{const i=document.querySelectorAll(".fare-ed .fare-num")[${idx}];i.focus();i.value=${JSON.stringify(val)};i.dispatchEvent(new Event("input",{bubbles:true}));return true})()`);
  const newFlat = Math.round((f160Before + 1) * 10) / 10;
  await setInput(0, String(newFlat));
  await E('(()=>{const b=[...document.querySelectorAll(".fare-ed .row button")].find(x=>x.textContent.includes("应用新票价"));b.click();return true})()');
  await delay(250);
  assert.equal(await E('CM.game.econ.fare160.flat'), newFlat, '160 统一票价已应用');
  assert.equal(await E('CM.game.model.fare160.flat'), newFlat, '仿真模型同步新票价');
  assert.equal(await E('JSON.stringify(CM.game.econ.fare)'), fareBefore, '常规票价不受影响');
  await E('(()=>{[...document.querySelectorAll(".fare-tabs button")][0].click();return true})()');
  await until('!document.querySelector(".fare-note160")');
  assert.equal(await E('CM.game.econ.fare.flat'), JSON.parse(fareBefore).flat, '切回常规票价仍显示常规数值');
  // 还原线速度，避免影响后面的编组升级断言
  await E(`(()=>{delete CM.game.net.lines[${JSON.stringify(lid)}].speed;return true})()`);
  console.log('PASS 160 统一票价独立生效');

  // ---------------- 2. TOD 第 5 级只有巨型及以上 ----------------
  const stId = await E('(()=>{const C=CM.game.model.net.C,sd=CM.game.model.stDaily;for(const [id,k] of C.sIndex)if(C.serviced[k]&&sd&&sd.inn[k]>0)return id;return Object.keys(CM.game.net.stations)[0]})()');
  const todState = async size => {
    await E(`(()=>{CM.game.net.stations[${JSON.stringify(stId)}].size=${JSON.stringify(size)};CM.ui._tab=CM.ui._tab||{};CM.ui._tab.station="info";CM.ui.open["st-tod"]=true;CM.ui.closePanel(true);CM.ui.openPage("station",${JSON.stringify(stId)},{root:true});return true})()`);
    await until('!!document.querySelector(".tod-levels .tod-lv")');
    await E('(()=>{const e=document.querySelector(".tod-levels");if(e)e.scrollIntoView({block:"start"});return true})()');
    await delay(250);
    return E('(()=>{const rows=[...document.querySelectorAll(".tod-levels .tod-lv")];return rows.map((r,i)=>({lv:i+1,lock:r.classList.contains("lock"),txt:r.innerText,btn:r.querySelector("button")?r.querySelector("button").disabled:true}))})()');
  };
  let lv = await todState('M');
  await shot('v35-tod-gate-m');
  assert.equal(lv.length, 5, '列出五级开发');
  assert.equal(lv[3].lock, true); assert.equal(lv[4].lock, true, '中型站第 4、5 级都锁定');
  assert.match(lv[3].txt, /需超大型及以上车站/, '第 4 级要求超大型');
  assert.match(lv[4].txt, /需巨型及以上车站/, '第 5 级要求巨型');
  lv = await todState('XL');
  await shot('v35-tod-gate-xl');
  assert.equal(lv[3].lock, false, '超大型站可开发第 4 级');
  assert.equal(lv[4].lock, true, '超大型站仍不能开发第 5 级');
  assert.match(lv[4].txt, /需巨型及以上车站/);
  lv = await todState('XXL');
  await shot('v35-tod-gate-xxl');
  assert.equal(lv[3].lock, false); assert.equal(lv[4].lock, false, '巨型站第 4、5 级都解锁');
  assert.doesNotMatch(lv[4].txt, /需巨型及以上车站/, '巨型站不再显示规模门槛');
  assert.equal(lv[4].btn, true, '未开发到上一级时仍按逐级开发置灰（与规模无关）');
  console.log('PASS TOD 第 5 级巨型门槛（界面）');

  // ---------------- 3. 同车型小编组补差价扩编 ----------------
  // v3.7 起「换车型」与「同车型扩编」合并成同一条升级条，只有整线都是同车型时才带 up-cars 标记
  // （走「本线可扩编到 …」文案）。北京 1990 开局 1 号线自带 8 列 DK 系列年代车，所以先把它们
  // 调回车辆段，让本线只剩下面买的同车型小编组车，才落到扩编分支。
  const moved = await E(`(()=>{CM.game.econ.funds=5e10;delete CM.game.net.lines[${JSON.stringify(lid)}].speed;
    // 模拟站台全部升级为大型后的编译结果：本线可跑 8 节编组
    for(const sid in CM.game.net.stations)CM.game.net.stations[sid].size='L';
    for(const r of CM.game.model.net.C.routes)if(r.lineId===${JSON.stringify(lid)})r.cars=8;
    const ids=CM.game.fleet.trains.filter(t=>t.line===${JSON.stringify(lid)}).map(t=>t.id);
    CM.Fleet.move(CM.game,ids,null,null);
    CM.ui.closePanel(true);return ids.length})()`);
  assert.ok(moved > 0, '开局本线的年代车已调回车辆段：' + moved);
  assert.equal(await E(`CM.Fleet.lineCars(CM.game,${JSON.stringify(lid)})`), 8, '本线可跑 8 节编组');
  const buy = await E(`(()=>{const r=CM.Fleet.buy(CM.game,${JSON.stringify(lid)},null,"gen-a",4,2);return JSON.stringify(r)})()`);
  assert.equal(JSON.parse(buy).ok, true, '先买两列 4 节车');
  await E(`(()=>{CM.ui._tab=CM.ui._tab||{};CM.ui._tab.line="ops";CM.ui.openPage("line",${JSON.stringify(lid)},{root:true});return true})()`);
  await until('!!document.querySelector(".up-cars")', 60000);
  const up = await E('(()=>{const b=document.querySelector(".up-cars");return {txt:b.innerText,btn:b.querySelector("button").textContent,disabled:b.querySelector("button").disabled}})()');
  assert.match(up.txt, /本线可扩编到/, '整线同车型时走扩编分支');
  assert.match(up.txt, /· 8 节/, '升级条写明本线可跑的最长编组');
  assert.match(up.txt, /保持原车型与车龄/, '说明不换车型不改车龄');
  assert.match(up.btn, /补差价升级/); assert.equal(up.disabled, false);
  await shot('v35-cars-upgrade');
  const before = await E(`(()=>{const t=CM.game.fleet.trains.filter(x=>x.line===${JSON.stringify(lid)}&&x.model==="gen-a"&&x.cars===4);return {n:t.length,bought:t[0].bought,model:t[0].model,cost:t[0].cost}})()`);
  await E('(()=>{document.querySelector(".up-cars button").click();return true})()');
  await delay(350);
  // 确认框的主按钮同样是「补差价升级」（升级条上那个也同名，从弹窗里取）
  await until('!!document.querySelector(".modal-actions")', 10000);
  assert.equal(await E('(()=>{const b=[...document.querySelectorAll(".modal-actions button")].find(x=>/补差价升级/.test(x.textContent));return !!b})()'), true, '弹出二次确认框');
  await E('(()=>{const b=[...document.querySelectorAll(".modal-actions button")].find(x=>/补差价升级/.test(x.textContent));b.click();return true})()');
  await delay(500);
  const after = await E(`(()=>{const t=CM.game.fleet.trains.filter(x=>x.line===${JSON.stringify(lid)}&&x.model==="gen-a");return {n:t.length,cars:t.map(x=>x.cars),bought:t[0].bought,cost:t[0].cost}})()`);
  assert.equal(after.cars.filter(c => c === 8).length, before.n, '小编组列车扩编到 8 节');
  assert.equal(after.bought, before.bought, '车龄不变');
  assert.ok(after.cost > before.cost, '补差价累加到车体成本');
  assert.equal(await E('!!document.querySelector(".up-cars")'), false, '全部扩编后升级条消失');
  console.log('PASS 同车型小编组补差价扩编（界面）');
  assert.equal(errors.length, 0, 'Browser errors:/n' + errors.join('\n'));
} finally {
  if (send) await Promise.race([send('Browser.close').catch(() => { }), delay(1500)]);
  if (ws) ws.close();
  edge.kill();
  server.closeAllConnections();
  await new Promise(r => server.close(r));
  await fs.rm(task, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
}
