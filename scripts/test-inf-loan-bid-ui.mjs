// v4.3 回归：无限贷款下的投标保证金（界面）。
// 合同页在无限贷款下注明「可透支支付」，「按此投标」按钮不被置灰；点击后投标成立。
// 关掉开关后同一按钮仍可点，但会弹出「一般资金不足以支付履约保证金」而不产生投标。
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

const task = await fs.mkdtemp(path.join(os.tmpdir(), 'city-metro-v43ui-')), profile = path.join(task, 'profile');
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
  await E('CM.newGame({map:"gz",mode:"challenge",seed:20261118});true');
  await until('!CM.isLoading()&&!!CM.game&&!CM.game.pending');
  await E('CM.ui.closeScreen();CM.game.setSpeed(0);CM.ui.toasts.replaceChildren();true');

  // 注入两个招标（新线 PPP 与铁路＋物业）与负余额 + 无限贷款
  const setup = await E(`(()=>{
    const g=CM.game;
    g.econ.setInfLoan(true); g.econ.funds=-500000;
    const mk=(id,type,est)=>CM.Corp.terms({id,type,title:'Tender '+id,est,buildM:36,expires:g.ym()+6,bid:null,forecast:0,desc:'Test tender for the infinite-loan regression.',
      anchors:[{name:'Test anchor',x:73.26,y:93.87,r:2}],area:{x:73.26,y:93.87,r:2}});
    g.corp={v:1,since:g.ym(),rating:60,done:0,tenders:[mk('T-ui','line',200000),mk('T-ui2','tod',200000)],contracts:[],closed:[],seq:9,next:g.ym()+9999,cool:{},ym:g.ym()};
    return {funds:g.econ.funds,inf:g.econ.isInfinite(),tenders:g.corp.tenders.length};
  })()`);
  assert.equal(setup.inf, true, '无限贷款应已开启');
  assert.equal(setup.tenders, 2, '应注入两个招标');

  // 打开任务页 → 合同标签
  await E('CM.ui.openTop("tasks");true');
  await until('!!document.querySelector(".tk-page")');
  const tabbed = await E('(()=>{const b=[...document.querySelectorAll(".ptabs button")].find(x=>/合同/.test(x.textContent));if(!b)return false;b.click();return true})()');
  assert.equal(tabbed, true, '任务页应有「合同」标签');
  await until('document.querySelectorAll(".pp-tender").length===2');

  // ---------------- 1. 无限贷款：说明可见、按钮可点、点击后投标成立 ----------------
  const view = await E(`(()=>{
    const cards=[...document.querySelectorAll(".pp-tender")];
    const first=cards[0];
    const btns=[...first.querySelectorAll("button")].filter(b=>b.textContent.trim()==="按此投标");
    const g=CM.game;
    return {cards:cards.length,opts:first.querySelectorAll(".pp-opt").length,
      note:/无限贷款：可透支支付/.test(first.textContent),
      bond:/保证金/.test(first.textContent),
      btns:btns.length,disabled:btns.map(b=>!!b.disabled),
      short:g.econ.funds<0, gated:g.econ.canAfford(1)};
  })()`);
  assert.equal(view.cards, 2, '应显示两个招标卡片');
  assert.equal(view.opts, 3, '每个招标应有 3 档方案');
  assert.equal(view.bond, true, '方案应写明保证金');
  assert.equal(view.note, true, '无限贷款下应注明「可透支支付」');
  assert.equal(view.short, true, '测试前提是负余额');
  assert.equal(view.btns, 3, '每个方案都应有「按此投标」按钮');
  assert.deepEqual(view.disabled, [false, false, false], '无限贷款下按钮不得置灰');
  await shot('v43-inf-loan-bid');

  await E(`(()=>{const c=document.querySelector(".pp-tender");const b=[...c.querySelectorAll("button")].find(x=>x.textContent.trim()==="按此投标");b.click();return true})()`);
  await delay(600);
  const bidOk = await E(`(()=>{const g=CM.game,t=g.corp.tenders[0];return {bid:!!t.bid,opt:t.bid&&t.bid.opt,toast:CM.ui.toasts.textContent,screen:!!document.querySelector(".pp-tender[href]")||document.querySelectorAll(".pp-tender").length,txt:document.querySelectorAll(".pp-tender")[0].textContent}})()`);
  assert.equal(bidOk.bid, true, '无限贷款下点击「按此投标」应成立：' + JSON.stringify(bidOk));
  assert.match(String(bidOk.toast), /已投标/, '应提示已投标：' + bidOk.toast);
  assert.match(bidOk.txt, /已投标 · 下月初公布/, '卡片应显示已投标状态');

  // ---------------- 2. 关掉无限贷款：按钮仍可点，但弹出余额不足、投标不成立 ----------------
  await E(`(()=>{const g=CM.game;g.econ.setInfLoan(false);g.econ.funds=-100;g.touch();CM.ui.rerenderPage();return true})()`);
  await delay(400);
  const normal = await E(`(()=>{const cards=[...document.querySelectorAll(".pp-tender")];const c=cards[1];const btns=[...c.querySelectorAll("button")].filter(b=>b.textContent.trim()==="按此投标");return {note:/无限贷款：可透支支付/.test(c.textContent),disabled:btns.map(b=>!!b.disabled)}})()`);
  assert.equal(normal.note, false, '普通模式不应再显示「可透支支付」');
  assert.deepEqual(normal.disabled, [false, false, false], '普通模式按钮也不置灰（点击后才提示）');

  await E('CM.ui.toasts.replaceChildren();true');
  await E(`(()=>{const c=[...document.querySelectorAll(".pp-tender")][1];const b=[...c.querySelectorAll("button")].find(x=>x.textContent.trim()==="按此投标");b.click();return true})()`);
  await delay(500);
  const blocked = await E(`(()=>{const g=CM.game,t=g.corp.tenders[1];return {bid:!!t.bid,toast:CM.ui.toasts.textContent}})()`);
  assert.equal(blocked.bid, false, '普通模式余额不足时不应产生投标');
  assert.match(String(blocked.toast), /一般资金不足以支付履约保证金/, '普通模式应提示余额不足：' + blocked.toast);

  // ---------------- 3. 英文界面：说明整句译完，不漏汉字 ----------------
  await E('CM.I18n.apply("en");true');
  await delay(400);
  const en = await E(`(()=>{const g=CM.game;g.econ.setInfLoan(true);g.econ.funds=-500000;g.touch();CM.ui.rerenderPage();return true})()`);
  await delay(500);
  const enView = await E(`(()=>{const c=[...document.querySelectorAll(".pp-tender")][1];const m=String(c.textContent).match(/Infinite loan[^\\n]*/);return {line:m?m[0]:"",han:/[\\u3400-\\u9fff]/.test((m?m[0]:""))}})()`);
  assert.ok(enView.line.length > 20, '英文界面应显示无限贷款的说明：' + JSON.stringify(enView));
  assert.equal(enView.han, false, '说明译文不得残留汉字：' + enView.line);
  await shot('v43-inf-loan-bid-en');

  await E('CM.I18n.apply("zh-CN");true');
  assert.deepEqual(errors, [], '不应有 JS 异常：' + errors.join('\n'));
  console.log('PASS 无限贷款：合同页注明可透支、按钮可点、投标成立（负余额）');
  console.log('PASS 普通模式：不显示可透支、点击后提示「一般资金不足以支付履约保证金」且投标不成立');
  console.log('PASS 英文界面：Infinite loan 说明整句译完，无汉字');
  console.log('ALL PASS v4.3 UI 无限贷款下的投标保证金');
} finally {
  try { ws && ws.close(); } catch { }
  try { edge.kill(); } catch { }
  try { server.close(); } catch { }
  try { await fs.rm(task, { recursive: true, force: true }); } catch { }
}
