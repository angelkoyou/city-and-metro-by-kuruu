// v3.7 UI 回归：D 型无人列车每节定员 500 人（购车面板中英文显示 + 整列运力）。
// 真实 Chromium，隔离 profile，不读写玩家存档。
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

const task = await fs.mkdtemp(path.join(os.tmpdir(), 'city-metro-d160-')), profile = path.join(task, 'profile');
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
  await E('CM.newGame({map:"bj",mode:"challenge",seed:20261115});true');
  await until('!CM.isLoading()&&!!CM.game&&!CM.game.pending');
  await E('CM.ui.closeScreen();CM.game.setSpeed(0);CM.ui.toasts.replaceChildren();true');

  // 数据层：每节 500 人，固定 8 节 → 整列 4000 人
  const cap = await E('(()=>{const F=CM.Fleet,m=F.model("gen-d160");return {cap:m.cap,cars:m.fixedCars,one:F.capOf({model:"gen-d160",cars:8}),desc:m.desc}})()');
  assert.equal(cap.cap, 500, 'D 型无人列车每节定员 500 人');
  assert.equal(cap.cars, 8, '仍为固定 8 节编组');
  assert.equal(cap.one, 4000, '整列运力 4000 人');
  assert.match(cap.desc, /每节 500 人/);
  console.log('PASS D 型车定员 500 人 / 整列 4000 人（数据层）');

  // 让一条线成为 160 轨道并把年份调到 D 型车已开放的 2006 年，打开购车面板
  const openShop = async () => {
    await E(`(()=>{const k=Object.keys(CM.game.net.lines)[0],L=CM.game.net.lines[k];L.speed=160;CM.game.clock.y=2006;CM.ui.closeScreen();CM.ui.showTrainShop(k,null,L.name||"车辆段",8);return k})()`);
    await until('!!document.querySelector(".fo-shop .fo-model")');
  };
  await openShop();
  let zh = await E('(()=>{const c=[...document.querySelectorAll(".fo-shop .fo-model")].find(x=>/D 型无人列车/.test(x.textContent));return c?c.innerText:null})()');
  assert.ok(zh, '160 线路购车列表出现 D 型无人列车');
  assert.match(zh, /每节 500 人/, '中文购车卡片显示每节 500 人');
  assert.match(zh, /每节 500 人的全自动无人列车/, '车型说明同步为 500 人');
  assert.ok(!/350/.test(zh), '购车卡片不再残留 350 人');
  await shot('v37-d160-cap');
  console.log('PASS 中文购车面板显示每节 500 人');

  // 英文：动态模板「每节 {v0} 人」与整句 desc 都要跟上
  await E('CM.Settings.set("language","en");true');
  await openShop();
  const en = await E('(()=>{const c=[...document.querySelectorAll(".fo-shop .fo-model")].find(x=>/Type D automated train/.test(x.textContent));return c?c.innerText:null})()');
  assert.ok(en, '英文购车列表出现 Type D automated train');
  const han = s => /[\u3400-\u9fff]/.test(s);
  assert.ok(!han(en), '英文购车卡片残留汉字：' + (en.match(/[\u3400-\u9fff]+/g) || []).join(' '));
  assert.match(en, /500 per car/, '英文模板显示 500 per car');
  assert.match(en, /500 riders per car/, '英文车型说明显示 500 riders per car');
  assert.ok(!/350/.test(en), '英文购车卡片不再残留 350');
  // 只校验 D 型车相关文案：开局自带线路名是存档数据，不带词条也不影响本结论
  const missing = await E('CM.I18n.missing()');
  assert.ok(!missing.some(s => /每节|D 型|无人列车|定员|500/.test(s)), 'D 型车相关英文词条无缺失：' + JSON.stringify(missing));
  await shot('v37-d160-cap-en');
  await E('CM.Settings.set("language","zh-CN");CM.ui.closeScreen();true');
  console.log('PASS 英文购车面板显示 500 per car / 500 riders per car');

  assert.equal(errors.length, 0, 'Browser errors:\n' + errors.join('\n'));
  console.log('ALL PASS v3.7 D 型无人列车每节 500 人');
} finally {
  if (send) await Promise.race([send('Browser.close').catch(() => { }), delay(1500)]);
  if (ws) ws.close();
  edge.kill();
  server.closeAllConnections();
  await new Promise(r => server.close(r));
  await fs.rm(task, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
}
