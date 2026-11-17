// v3.9 UI 回归：既有线路改番号、自定义名称、改用「无番号」显示、同号拦截、
// 存档往返与新建线路弹窗里的「不使用番号」。用隔离 Chromium 跑真实界面，不读写玩家存档。
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

const task = await fs.mkdtemp(path.join(os.tmpdir(), 'city-metro-v39-')), profile = path.join(task, 'profile');
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
  await E('CM.Settings.set("autosave",false);CM.Settings.set("sound",false);CM.Settings.set("infLoan",false);true');
  await E('CM.ui.showMapSelect("bj");true');
  await until('!!document.querySelector(".map-mode.primary")');
  await E('document.querySelector(".map-mode.primary").click();true');
  await until('!CM.isLoading()&&!!CM.game&&!CM.game.pending', 180000);
  await until('!!(CM.game.model.stDaily&&CM.game.model.stDaily.inn&&CM.game.model.stDaily.inn.length&&!CM.game.model.dailyStale)', 240000);

  const ids = await E('Object.keys(CM.game.net.lines)');
  assert.ok(ids.length >= 2, '北京开局有两条既有线路');
  const lid = ids[0], other = ids[1];
  const otherNum = await E(`CM.game.net.lines[${JSON.stringify(other)}].num`);
  assert.equal(otherNum, 2, '另一条是 2 号线');

  await E('CM.ui.closeScreen();true');   // 关掉开局简报，避免遮住右侧详情面板
  await delay(300);
  await E(`(()=>{CM.ui._tab=CM.ui._tab||{};CM.ui._tab.line='build';CM.ui.openPage("line",${JSON.stringify(lid)},{root:true});return true})()`);
  await until('!!document.querySelector(".lnid-grid")');

  const before = await E(`(()=>{const L=CM.game.net.lines[${JSON.stringify(lid)}];return {num:L.num,name:L.name,title:document.querySelector(".p-title").textContent.trim(),tags:[...document.querySelectorAll(".p-body .tag")].map(t=>t.textContent.trim()),hasNum:!!document.querySelector(".lnid-num"),hasSwitch:!!document.querySelector(".lnid-nonum .switch")}})()`);
  assert.equal(before.num, 1, '开局第一条线是 1 号线');
  assert.equal(before.name, '1 号线');
  assert.equal(before.hasNum, true, '编辑分页有番号输入框');
  assert.equal(before.hasSwitch, true, '编辑分页有「不使用番号」开关');
  assert.ok(before.tags.indexOf('番号 1') >= 0, '页头标出当前番号：' + before.tags.join('/'));

  const setVal = async (sel, v) => E(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});el.value=${JSON.stringify(String(v))};el.dispatchEvent(new Event("input",{bubbles:true}));return true})()`);
  const apply = async () => { await E('document.querySelector(".lnid-foot .btn.primary").click();true'); await delay(300); };

  // ---------------- 1. 改番号：自动名称跟着变 ----------------
  await setVal('.lnid-num', 9);
  const preview = await E('document.querySelector(".lnid-prev").textContent.trim()');
  assert.equal(preview, '9 号线', '改号后预览显示新名称');
  await apply();
  const renum = await E(`(()=>{const g=CM.game,L=g.net.lines[${JSON.stringify(lid)}],r=(g.compiled.routes||[]).find(x=>x.lineId===${JSON.stringify(lid)});return {num:L.num,name:L.name,title:document.querySelector(".p-title").textContent.trim(),tags:[...document.querySelectorAll(".p-body .tag")].map(t=>t.textContent.trim()),label:r?r.label:null,used:CM.Metro.lineNoUsed(g.net).has(9),oldFree:!CM.Metro.lineNoUsed(g.net).has(1)}})()`);
  assert.equal(renum.num, 9, '番号已改为 9');
  assert.equal(renum.name, '9 号线', '自动名称随番号更新');
  assert.equal(renum.title, '9 号线', '页面标题同步');
  assert.ok(renum.tags.indexOf('番号 9') >= 0, '页头番号同步：' + renum.tags.join('/'));
  assert.equal(renum.label, '9 号线', '运营路线的显示名同步');
  assert.equal(renum.used, true);
  assert.equal(renum.oldFree, true, '旧番号 1 已释放');

  // ---------------- 2. 保留番号，改用自定义名称 ----------------
  await setVal('.lnid-num', 10);
  await setVal('.lnid-name', '机场快线');
  await apply();
  const named = await E(`(()=>{const g=CM.game,L=g.net.lines[${JSON.stringify(lid)}],r=(g.compiled.routes||[]).find(x=>x.lineId===${JSON.stringify(lid)});return {num:L.num,name:L.name,title:document.querySelector(".p-title").textContent.trim(),label:r?r.label:null}})()`);
  assert.equal(named.num, 10);
  assert.equal(named.name, '机场快线', '自定义名称生效');
  assert.equal(named.title, '机场快线', '页面标题使用自定义名称');
  assert.equal(named.label, '机场快线', '运营路线显示自定义名称');

  // 再改号，自定义名称不被覆盖
  await setVal('.lnid-num', 11);
  await setVal('.lnid-name', '机场快线');
  await apply();
  const kept = await E(`(()=>{const L=CM.game.net.lines[${JSON.stringify(lid)}];return {num:L.num,name:L.name}})()`);
  assert.equal(kept.num, 11);
  assert.equal(kept.name, '机场快线', '改号不覆盖自定义名称');

  // ---------------- 3. 不使用番号：只显示名称 ----------------
  await E('document.querySelector(".lnid-nonum .switch").click();true');
  const switchState = await E('(()=>{const s=document.querySelector(".lnid-nonum .switch");return {on:s.classList.contains("on"),checked:s.getAttribute("aria-checked"),disabled:document.querySelector(".lnid-num").disabled}})()');
  assert.equal(switchState.on, true, '开关可打开');
  assert.equal(switchState.checked, 'true');
  assert.equal(switchState.disabled, true, '不用番号时番号输入框禁用');
  await apply();
  const noNum = await E(`(()=>{const g=CM.game,L=g.net.lines[${JSON.stringify(lid)}];return {num:L.num,name:L.name,title:document.querySelector(".p-title").textContent.trim(),tags:[...document.querySelectorAll(".p-body .tag")].map(t=>t.textContent.trim()),used:CM.Metro.lineNoUsed(g.net).has(11),switchOn:document.querySelector(".lnid-nonum .switch").classList.contains("on")}})()`);
  assert.equal(noNum.num, null, '线路可以完全不使用番号');
  assert.equal(noNum.name, '机场快线');
  assert.equal(noNum.title, '机场快线');
  assert.ok(noNum.tags.indexOf('无番号') >= 0, '页头显示无番号：' + noNum.tags.join('/'));
  assert.equal(noNum.used, false, '原番号 11 已释放');
  assert.equal(noNum.switchOn, true, '重新渲染后开关仍是开启状态');
  await E('document.querySelector(".lnid-grid").scrollIntoView({block:"center"});true');
  await delay(250);
  await shot('v39-line-number');

  // ---------------- 4. 同号拦截：不留半改状态 ----------------
  await E('document.querySelector(".lnid-nonum .switch").click();true');
  await setVal('.lnid-num', 2);   // 已被另一条线占用
  await apply();
  const dup = await E(`(()=>{const L=CM.game.net.lines[${JSON.stringify(lid)}];return {num:L.num,name:L.name,msg:document.querySelector(".lnid-msg").textContent,bad:document.querySelector(".lnid-msg").classList.contains("bad")}})()`);
  assert.equal(dup.num, null, '同号被拒绝，番号仍是无番号');
  assert.equal(dup.name, '机场快线', '同号被拒绝，名称也不变');
  assert.equal(dup.bad, true, '错误提示标红');
  assert.match(dup.msg, /已被使用/, '错误提示说明番号被占用');

  // ---------------- 4.5 英文界面：区块与开关都有整句译文 ----------------
  await E('CM.Settings.set("language","en");CM.I18n.apply("en");true');
  await delay(350);
  // 显示名称本身是玩家数据（测试里是中文「机场快线」），只校验界面文案，不把它算成漏翻
  const enId = await E('(()=>{const g=document.querySelector(".lnid-grid");const sec=g?g.closest(".sec"):null;const copy=sec?[...sec.querySelectorAll(".lnid-f > span, .lnid-nonum > span, .lnid-msg, .note")].map(x=>x.textContent).join(" | "):"";const sw=document.querySelector(".lnid-nonum .switch");return {txt:copy,head:sec?sec.querySelector(".sec-h").textContent:"",han:/[\\u3400-\\u9fff]/.test(copy),sw:sw?sw.getAttribute("aria-label"):"",ph:document.querySelector(".lnid-num").placeholder}})()');
  assert.match(enId.head, /Number and name/, '英文界面显示番号与名称区块');
  assert.equal(enId.han, false, '英文区块不残留汉字：' + enId.txt);
  assert.match(enId.sw, /No line number/, '开关的英文提示：' + enId.sw);
  assert.equal(enId.ph, 'Optional', '番号输入框占位符有英文');
  await E('CM.Settings.set("language","zh-CN");CM.I18n.apply("zh-CN");true');
  await delay(250);

  // ---------------- 5. 新建线路弹窗：不使用番号 ----------------
  await E('window.__lnChoice=null;CM.ui.askLineNumber(CM.game.net,function(c){window.__lnChoice=c;});true');
  await until('!!document.querySelector(".lnp-nonum-in")');
  await E('(()=>{const c=document.querySelector(".lnp-nonum-in");c.checked=true;c.dispatchEvent(new Event("change",{bubbles:true}));const n=document.querySelector(".lnp-name");n.value="博物馆线";n.dispatchEvent(new Event("input",{bubbles:true}));return true})()');
  await delay(200);
  const dlg = await E('(()=>{const ok=document.querySelector(".lnp-actions .btn.primary");return {disabled:ok.disabled,cur:document.querySelector(".lnp-cur").textContent,msg:document.querySelector(".lnp-msg").textContent,numOff:document.querySelector(".lnp-num").disabled}})()');
  assert.equal(dlg.disabled, false, '填了名称后可以确认');
  assert.equal(dlg.numOff, true, '弹窗里勾选后番号输入框禁用');
  assert.match(dlg.cur, /无番号/, '弹窗预览标出无番号：' + dlg.cur);
  assert.match(dlg.msg, /不占用任何番号/, '弹窗说明不占用番号');
  await shot('v39-line-nonum-dialog');
  await E('document.querySelector(".lnp-actions .btn.primary").click();true');
  await delay(250);
  const choice = await E('window.__lnChoice');
  assert.ok(choice, '弹窗返回选择结果');
  assert.equal(choice.noNum, true, '结果标出不使用番号');
  assert.equal(choice.num, null, '不占用番号');
  assert.equal(choice.name, '博物馆线');
  const built = await E(`(()=>{const n=CM.Metro.empty();const id=CM.Metro.newLine(n,${JSON.stringify(choice.name)},{num:null,noNum:true,color:${JSON.stringify(choice.color)}});const L=n.lines[id];return {num:L.num,name:L.name,used:CM.Metro.lineNoUsed(n).size}})()`);
  assert.equal(built.num, null);
  assert.equal(built.name, '博物馆线');
  assert.equal(built.used, 0, '无番号线路不占用番号');

  // ---------------- 6. 存档往返：番号与名称原样保留 ----------------
  const saved = await E(`(()=>{const s=JSON.parse(JSON.stringify(CM.game.serialize()));const L=s.net.lines[${JSON.stringify(lid)}];return {num:L.num,name:L.name,other:s.net.lines[${JSON.stringify(other)}].num}})()`);
  assert.equal(saved.num, null, '存档中保留无番号状态');
  assert.equal(saved.name, '机场快线', '存档中保留自定义名称');
  assert.equal(saved.other, 2, '其它线路的番号不受影响');
  await E('window.__lnSave=CM.game.serialize();true');
  await E('(()=>{CM.game=CM.Game.restore(window.__lnSave);return true})()');
  const restored = await E(`(()=>{const L=CM.game.net.lines[${JSON.stringify(lid)}];return {num:L.num,name:L.name}})()`);
  assert.equal(restored.num, null, '读档后仍是无番号');
  assert.equal(restored.name, '机场快线', '读档后名称不变');

  if (errors.length) throw Error('页面运行时报错：\n' + errors.join('\n'));
  console.log('ALL PASS v3.9 UI：既有线路改号 / 自定义名称 / 无番号显示 / 同号拦截 / 新建无番号 / 存档往返');
} finally {
  try { ws && ws.close(); } catch { }
  try { edge.kill(); } catch { }
  server.close();
}
