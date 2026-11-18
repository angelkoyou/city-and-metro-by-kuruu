// v3.8 UI 回归：更新公告按版本累积、最新版展开、旧记录保留、英文整页无汉字。
// 用隔离 Chromium 跑真实界面，不读写玩家存档。
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

const task = await fs.mkdtemp(path.join(os.tmpdir(), 'city-metro-news-')), profile = path.join(task, 'profile');
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
  const shot = async name => { const r = await send('Page.captureScreenshot', { format: 'png' }); await fs.mkdir(path.join(root, 'shots'), { recursive: true }); await fs.writeFile(path.join(root, 'shots', name + '.png'), Buffer.from(r.data, 'base64')); };
  const until = async (exp, ms = 120000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await E(exp)) return; await delay(150); } throw Error('Wait timeout: ' + exp + '\n' + errors.join('\n')); };

  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/' });
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 980, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });

  await until('!!window.CM?.ui&&!!document.querySelector(".start-menu")');
  await E('CM.Settings.set("autosave",false);CM.Settings.set("sound",false);true');
  // 从右上角的公告按钮真实进入
  await E('document.querySelector(".corner-btn[aria-label=\\"更新公告\\"]").click();true');
  await until('!!document.querySelector(".card.news")');

  const info = await E('(()=>{const card=document.querySelector(".card.news");const vs=[...card.querySelectorAll(".news-v")].map(v=>v.textContent.trim());const secs=[...card.querySelectorAll(".news-list .sec")];return {vs,n:CM.NEWS.length,title:card.querySelector("h2").textContent.trim(),sub:card.querySelector(".card-head .tiny").textContent.trim(),lead:(card.querySelector(".news-lead")||{}).textContent||"",items:card.querySelectorAll(".news-b li").length,firstItems:secs[0]?secs[0].querySelectorAll("li").length:0,firstOpen:secs[0]?secs[0].classList.contains("open"):false,lastItems:secs.length?secs[secs.length-1].querySelectorAll("li").length:0,lastText:secs.length?secs[secs.length-1].textContent:""}})()');
  assert.equal(info.n, 23, '公告应保留 23 个版本');
  assert.equal(info.vs.length, 23, '界面应列出全部版本：' + info.vs.join(','));
  assert.equal(info.vs[0], 'V4.2', '最新版本在最上面');
  assert.equal(info.vs[info.vs.length - 1], 'V2.0', '最早的 2.0 公告仍在最后');
  assert.deepEqual(info.vs, ['V4.2', 'V4.1', 'V4.0', 'V3.9', 'V3.8', 'V3.7', 'V3.6', 'V3.5', 'V3.4', 'V3.3', 'V3.2', 'V3.1', 'V3.0', 'V2.9', 'V2.8', 'V2.7', 'V2.6', 'V2.5', 'V2.4', 'V2.3', 'V2.2', 'V2.1', 'V2.0'], '版本必须严格倒序');
  assert.match(info.title, /更新公告/);
  assert.match(info.sub, /当前版本 V4\.2/, '页头显示当前版本：' + info.sub);
  assert.match(info.lead, /历史公告全部保留/, '页头说明历史公告保留');
  assert.equal(info.items, 6, '默认只构建最新版（其余按需展开）：' + info.items);
  assert.equal(info.firstItems, 6, '最新版 6 条');
  assert.equal(info.firstOpen, true, '最新版默认展开');
  assert.equal(info.lastItems, 0, '历史版本默认折叠且尚未构建');
  assert.match(info.lastText, /建起你的城市地铁网/, '2.0 标题原样保留');

  // 展开最旧一版，确认历史内容可读
  await E('(()=>{const s=[...document.querySelectorAll(".news-list .sec")].pop();s.querySelector(".sec-h").click();return true})()');
  await delay(450);
  const opened = await E('(()=>{const s=[...document.querySelectorAll(".news-list .sec")].pop();const b=s.querySelector(".sec-b");return {open:s.classList.contains("open"),h:b?b.getBoundingClientRect().height:0,items:s.querySelectorAll("li").length,text:s.textContent}})()');
  assert.equal(opened.open, true, '点击后可展开历史版本');
  assert.equal(opened.items, 6, '展开后 2.0 仍是 6 条：' + opened.items);
  assert.ok(opened.h > 40, '历史版本展开后应有内容高度：' + opened.h);
  assert.match(opened.text, /广州、杭州、香港、东京、台北和青湾教程/, '2.0 正文原样保留');

  await shot('v42-news-zh');

  // 英文界面：整页不得残留汉字
  await E('CM.I18n.apply("en");true');
  await delay(300);
  const en = await E('(()=>{const c=document.querySelector(".card.news");return {han:/[\\u3400-\\u9fff]/.test(c.textContent),head:c.querySelector("h2").textContent.trim(),first:c.querySelector(".news-b li").textContent.slice(0,60)}})()');
  assert.equal(en.han, false, '英文公告页不得残留汉字');
  assert.match(en.head, /What's New/);
  assert.ok(en.first.length > 20, '英文正文应有内容');
  await shot('v42-news-en');

  await E('CM.I18n.apply("zh-CN");true');
  await E('CM.ui.closeScreen();true');
  assert.deepEqual(errors, [], '不应有 JS 异常：' + errors.join('\n'));
  console.log('ALL PASS v4.2 UI 更新公告：23 个版本 / 最新展开 / 历史可展开 / 英文整页无汉字');
} finally {
  try { ws && ws.close(); } catch { }
  try { edge.kill(); } catch { }
  await new Promise(r => server.close(r));
  await fs.rm(task, { recursive: true, force: true }).catch(() => { });
}
