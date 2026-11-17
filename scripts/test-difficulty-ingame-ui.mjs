// v3.6 UI 回归：设置 → 游戏 → 本局难度（8 项系数实时生效、初始资金锁定、档位切换、自由建造锁定、英文）。
// 用隔离的 Chromium 跑真实界面操作，不读写玩家存档。
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

const task = await fs.mkdtemp(path.join(os.tmpdir(), 'city-metro-diffingame-')), profile = path.join(task, 'profile');
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
  const shot = async name => { const r = await send('Page.captureScreenshot', { format: 'png' }); await fs.writeFile(path.join(root, 'shots', name + '.png'), Buffer.from(r.data, 'base64')); };
  const until = async (exp, ms = 120000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await E(exp)) return; await delay(150); } throw Error('Wait timeout: ' + exp + '\n' + errors.join('\n')); };
  // 设置卡片固定 620px 高、内容区滚动；截图时临时隐藏前面几组并展开，才能一屏拍全 8 行滑块。
  const prepDiffShot = () => E(`(()=>{
    const card=document.querySelector(".card.settings.tabbed"), body=document.querySelector(".card.settings .set-body");
    if(!card||!body) return false;
    const kids=[...body.children];
    const idx=kids.findIndex(x=>x.classList&&x.classList.contains("set-group")&&/(本局难度|Difficulty)/i.test(x.textContent));
    if(idx>0) for(const n of kids.slice(0,idx)) n.style.display="none";
    card.style.height="auto"; card.style.maxHeight="none";
    body.style.overflow="visible"; body.style.maxHeight="none"; body.scrollTop=0;
    return true;
  })()`);

  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/' });
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 980, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await until('!!window.CM?.ui&&!!document.querySelector(".start-menu")');
  await E('CM.Settings.set("autosave",false);CM.Settings.set("sound",false);true');
  await E('CM.newGame({map:"bj",mode:"challenge",difficulty:"normal",seed:20261115});true');
  await until('!CM.isLoading()&&!!CM.game&&!CM.game.pending');
  await E('CM.ui.closeScreen();CM.game.setSpeed(0);CM.ui.toasts.replaceChildren();true');

  // ---------------- 1. 面板结构：8 项系数，不含初始资金 ----------------
  await E('CM.ui.showSettings("game");true');
  await until('!!document.querySelector(".diff-range")');
  const shape = await E(`(()=>{
    const groups=[...document.querySelectorAll(".card.settings .set-group")].map(x=>x.textContent);
    const rows=[...document.querySelectorAll(".card.settings .diff-row")].map(r=>({name:r.querySelector(".set-t").textContent,desc:r.querySelector(".set-d")?.textContent||"",min:r.querySelector("input").min,max:r.querySelector("input").max,disabled:!!r.querySelector("input").disabled,val:r.querySelector("input").value}));
    const levels=[...document.querySelectorAll(".card.settings .set-diffctl .seg-ctl button")].map(b=>({t:b.textContent,on:b.classList.contains("on"),disabled:!!b.disabled}));
    return {groups,rows,levels,state:document.querySelector(".set-diffstate")?.textContent||"",note:document.querySelector(".card.settings .set-note")?.textContent||""};
  })()`);
  assert.ok(shape.groups.includes('本局难度'), '游戏页有「本局难度」分组');
  assert.equal(shape.rows.length, 8, '只有 8 项可调整系数');
  assert.equal(await E('CM.Difficulty.GAME_KEYS.length'), 8);
  const names = await E('CM.Difficulty.GAME_KEYS.map(k=>CM.Difficulty.META[k].name).join("|")');
  assert.equal(shape.rows.map(r => r.name).join('|'), names, '滑块顺序与 GAME_KEYS 一致');
  assert.ok(!shape.rows.some(r => /初始资金/.test(r.name)), '初始资金不出现在可调整列表里');
  assert.ok(shape.rows.every(r => +r.min === 0.1 && +r.max === 3), '滑块范围 0.1–3 倍');
  assert.ok(shape.rows.every(r => !r.disabled), '经营挑战中滑块可用');
  assert.ok(shape.rows.every(r => +r.val === 1), '一般难度默认全部 ×1.00');
  assert.equal(shape.levels.length, 4, '四个难度档位');
  assert.ok(shape.levels.some(l => l.t === '一般' && l.on), '当前档位高亮');
  assert.match(shape.state, /本局：.*一般/);
  assert.match(shape.note, /除初始资金外/);
  console.log('PASS 本局难度面板结构（8 项系数 / 4 档 / 初始资金排除）');

  // ---------------- 2. 拖动滑块：实时倍率 + 存档数据 + 初始资金锁定 ----------------
  const gi = names.split('|').indexOf('政府拨款');
  const before = await E(`(()=>{const e=CM.game.econ;return {grant:e.grantFor(CM.game.clock.y,CM.game.clock.m),funds:e.funds,fundsTune:e.tune.funds,level:e.difficulty,grantMul:CM.Difficulty.grantMul()}})()`);
  const setRange = async (idx, v) => E(`(()=>{const i=document.querySelectorAll(".card.settings .diff-range")[${idx}];i.value=${JSON.stringify(v)};i.dispatchEvent(new Event("input",{bubbles:true}));i.dispatchEvent(new Event("change",{bubbles:true}));return true})()`);
  await setRange(gi, '2');
  await delay(350);
  const after = await E(`(()=>{const e=CM.game.econ;return {grant:e.grantFor(CM.game.clock.y,CM.game.clock.m),funds:e.funds,fundsTune:e.tune.funds,level:e.difficulty,grantMul:CM.Difficulty.grantMul(),tuneGrant:e.tune.grant,savedGrant:e.serialize().tune.grant,state:document.querySelector(".set-diffstate").textContent,label:document.querySelectorAll(".card.settings .diff-row .set-val")[${gi}].textContent}})()`);
  assert.equal(after.tuneGrant, 2, '滑块写入本局 tune');
  assert.equal(after.grantMul, 2, '全局实时倍率立即生效');
  assert.ok(after.grant > before.grant * 1.5, '政府拨款按新倍率计算，而不是档位预设');
  assert.equal(after.savedGrant, 2, '写入本局存档数据');
  assert.equal(after.fundsTune, before.fundsTune, '初始资金系数保持不变');
  assert.equal(after.funds, before.funds, '已有资金不因调系数变化');
  assert.equal(after.level, before.level, '微调不改变档位');
  assert.match(after.state, /自定义/, '偏离预设后标记自定义');
  assert.match(after.label, /2\.00/, '滑块数值标签同步');
  assert.equal(await E('[...document.querySelectorAll(".card.settings .set-diffctl .seg-ctl button")].some(b=>b.classList.contains("on"))'), false, '自定义时不高亮任何档位');
  console.log('PASS 拖动系数：实时生效、写入存档、初始资金与档位锁定');

  // ---------------- 3. 恢复该档默认 ----------------
  await E('(()=>{const b=[...document.querySelectorAll(".card.settings button")].find(x=>x.textContent.trim()==="恢复该档默认");b.click();return true})()');
  await delay(350);
  const reset = await E(`(()=>{const e=CM.game.econ;return {grant:CM.Difficulty.grantMul(),fundsTune:e.tune.funds,level:e.difficulty,state:document.querySelector(".set-diffstate").textContent,val:document.querySelectorAll(".card.settings .diff-range")[${gi}].value}})()`);
  assert.equal(reset.grant, 1, '恢复为一般难度预设');
  assert.equal(reset.level, 'normal');
  assert.equal(reset.fundsTune, before.fundsTune, '恢复默认仍不动初始资金');
  assert.ok(!/自定义/.test(reset.state), '自定义标记消失');
  assert.equal(+reset.val, 1);
  console.log('PASS 恢复该档默认（只重置 8 项系数）');

  // ---------------- 4. 中途切换档位 ----------------
  await E('(()=>{const b=[...document.querySelectorAll(".card.settings .set-diffctl .seg-ctl button")].find(x=>x.textContent.trim()==="困难");b.click();return true})()');
  await delay(350);
  const hard = await E(`(()=>{const D=CM.Difficulty,e=CM.game.econ;return {level:e.difficulty,cur:D.get(),income:D.incomeMul(),grant:D.grantMul(),build:D.buildMul(),preset:D.presetOf("hard").grant,fundsTune:e.tune.funds,funds:e.funds,state:document.querySelector(".set-diffstate").textContent,vals:[...document.querySelectorAll(".card.settings .diff-range")].map(i=>+i.value)}})()`);
  assert.equal(hard.level, 'hard', '档位写入本局');
  assert.equal(hard.cur, 'hard', '全局档位同步');
  assert.equal(hard.income, 0.8, '困难档收入 -20% 立即生效');
  assert.equal(hard.grant, hard.preset, '系数回填困难档预设');
  assert.equal(hard.fundsTune, before.fundsTune, '切档位仍锁定初始资金');
  assert.equal(hard.funds, before.funds, '已有资金不变');
  assert.match(hard.state, /困难/);
  assert.ok(!/自定义/.test(hard.state));
  console.log('PASS 中途切换档位（系数回填 + 收入倍率 + 初始资金锁定）');

  // 截图：调一项系数到 ×2.00，直观展示「自定义 + 实时生效」，并展开面板拍全 8 行
  await setRange(gi, '2');
  await delay(250);
  assert.equal(await prepDiffShot(), true, '展开难度面板用于截图');
  await delay(250);
  await shot('v36-difficulty-ingame');
  await E('CM.ui.closeScreen();true');

  // ---------------- 5. 自由建造：面板置灰并说明原因 ----------------
  await E('CM.game.econ.mode="free";CM.ui.showSettings("game");true');
  await until('!!document.querySelector(".diff-locked")');
  const free = await E(`(()=>({locked:document.querySelectorAll(".card.settings .diff-row.diff-locked").length,disabled:[...document.querySelectorAll(".card.settings .diff-range")].filter(i=>i.disabled).length,levelDisabled:[...document.querySelectorAll(".card.settings .set-diffctl .seg-ctl button")].filter(b=>b.disabled).length,note:[...document.querySelectorAll(".card.settings .set-note")].map(x=>x.textContent).join(" ")}))()`);
  assert.equal(free.locked, 8, '8 行全部标记为锁定');
  assert.equal(free.disabled, 8, '滑块全部置灰');
  assert.equal(free.levelDisabled, 4, '档位按钮全部置灰');
  assert.match(free.note, /自由建造不限资金/, '说明为什么不能调');
  await E('CM.ui.closeScreen();CM.game.econ.mode="challenge";true');
  console.log('PASS 自由建造时难度面板置灰');

  // ---------------- 6. 英文界面不残留汉字 ----------------
  await E('CM.Settings.set("language","en");CM.ui.showSettings("game");true');
  await until('!!document.querySelector(".card.settings .diff-range")');
  const en = await E(`(()=>({txt:document.querySelector(".card.settings").innerText,groups:[...document.querySelectorAll(".card.settings .set-group")].map(x=>x.textContent),rows:[...document.querySelectorAll(".card.settings .diff-row .set-t")].map(x=>x.textContent)}))()`);
  const han = s => /[\u3400-\u9fff]/.test(s);
  assert.ok(!han(en.txt), '英文设置页残留汉字：' + (en.txt.match(/[\u3400-\u9fff]+/g) || []).join(' '));
  assert.ok(en.groups.some(g => /Difficult/i.test(g)), '分组标题已英译');
  assert.equal(en.rows.length, 8);
  assert.ok(en.rows.every(r => !han(r)), '8 项系数名称已英译');
  assert.equal(await prepDiffShot(), true, '展开英文难度面板用于截图');
  await delay(250);
  await shot('v36-difficulty-ingame-en');
  await E('CM.ui.closeScreen();CM.Settings.set("language","zh-CN");true');
  console.log('PASS 英文界面无汉字残留');

  assert.equal(errors.length, 0, 'Browser errors:\n' + errors.join('\n'));
  console.log('ALL PASS v3.6 设置内随时调整本局难度（界面）');
} finally {
  if (send) await Promise.race([send('Browser.close').catch(() => { }), delay(1500)]);
  if (ws) ws.close();
  edge.kill();
  server.closeAllConnections();
  await new Promise(r => server.close(r));
  await fs.rm(task, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
}
