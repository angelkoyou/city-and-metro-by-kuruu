// v3.7 UI 回归：5 档难度 + 无限贷款独立开关（可透支建设）、车型科技树与一键升级条、
// 自动配置列车开关、交路配属表、线路颜色代码输入。用隔离 Chromium 跑真实界面，不读写玩家存档。
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

const task = await fs.mkdtemp(path.join(os.tmpdir(), 'city-metro-v37-')), profile = path.join(task, 'profile');
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

  // ---------------- 1. 开局界面：5 档难度 + 无限贷款独立开关 ----------------
  await until('!!window.CM?.ui&&!!document.querySelector(".start-menu")');
  await E('CM.Settings.set("autosave",false);CM.Settings.set("sound",false);CM.Settings.set("infLoan",false);true');
  // 开局界面：先打开地图选择，右侧详情卡才带难度档位
  await E('CM.ui.showMapSelect("bj");true');
  await until('!!document.querySelector(".ms2-diffseg")');
  const tiers = await E('[...document.querySelectorAll(".ms2-diffb")].map(b=>b.textContent.trim())');
  assert.deepEqual(tiers, ['困难', '一般', '简单', '入门', '自由建造'], '难度档只剩四档经营 + 自由建造');
  // 无限贷款是独立开关，默认关闭，说明只解除透支上限
  const infUi = await E('(()=>{const s=document.querySelector(".ms2-inf [aria-label=\\"无限贷款\\"]");const d=document.querySelector(".ms2-inf .ms2-infd");return s?{on:s.getAttribute("aria-checked"),tip:s.getAttribute("data-tip"),desc:d?d.textContent:""}:null})()');
  assert.ok(infUi, '开局界面有无限贷款独立开关');
  assert.equal(infUi.on, 'false', '开关默认关闭');
  assert.match(infUi.tip, /资金不足或为负/, '开关说明写明只解除透支上限');
  assert.match(infUi.desc, /其他规则不变/, '说明写明不改该难度的其他规则');
  // 自由建造：不显示、也不提供该开关
  await E('[...document.querySelectorAll(".ms2-diffb")].find(b=>b.textContent.trim()==="自由建造").click();true');
  const freeHide = await E('(()=>{const r=document.querySelector(".ms2-inf");return {hidden:r.classList.contains("hidden"),disp:getComputedStyle(r).display}})()');
  assert.ok(freeHide.hidden && freeHide.disp === 'none', '自由建造不显示无限贷款开关');
  // 选回一般并打开开关：主按钮仍是经营挑战，说明里标注已开启
  await E('[...document.querySelectorAll(".ms2-diffb")].find(b=>b.textContent.trim()==="一般").click();true');
  await E('document.querySelector(".ms2-inf [aria-label=\\"无限贷款\\"]").click();true');
  await until('!!document.querySelector(".map-mode.primary")');
  const infBtn = await E('(()=>{const s=document.querySelector(".ms2-inf [aria-label=\\"无限贷款\\"]");const b=document.querySelector(".map-mode.primary");return {on:s.getAttribute("aria-checked"),persist:CM.Settings.get("infLoan"),t:b.querySelector("b").textContent.trim(),chip:getComputedStyle(b.querySelector(".badge"),"::after").content,infOn:b.classList.contains("inf-on"),tip:b.getAttribute("data-tip")||"",free:[...document.querySelectorAll(".map-mode.free-toggle")].map(x=>x.style.display)}})()');
  assert.equal(infBtn.on, 'true', '开关可打开');
  assert.equal(infBtn.persist, true, '开关状态写进设置');
  assert.match(infBtn.t, /^经营挑战/, '主按钮仍是经营挑战（无限贷款不是模式）');
  assert.equal(infBtn.infOn, true, '主按钮带无限贷款标记');
  assert.match(infBtn.chip, /贷/, '图标角标显示「贷」');
  assert.match(infBtn.tip, /无限贷款/, '按钮提示说明已开启无限贷款');
  assert.ok(infBtn.free.every(d => d === 'none'), '经营挑战不给自由建造的起始年份选项');
  await shot('v37-start-tiers');

  // ---------------- 2. 以「一般 + 无限贷款」开局 ----------------
  await E('document.querySelector(".map-mode.primary").click();true');
  await until('!CM.isLoading()&&!!CM.game&&!CM.game.pending', 180000);
  await until('!!(CM.game.model.stDaily&&CM.game.model.stDaily.inn&&CM.game.model.stDaily.inn.length&&!CM.game.model.dailyStale)', 240000);
  const st = await E('(()=>{const e=CM.game.econ;return {inf:e.isInfinite(),free:e.isFree(),diff:e.difficulty,mode:e.mode,name:CM.game.name,bond:e.canBorrow(),fail:!!e.checkFailure(CM.game.clock.y)}})()');
  assert.equal(st.inf, true, '开关在局内生效');
  assert.equal(st.free, false);
  assert.equal(st.diff, 'normal', '档位仍是一般，不被开关改写');
  assert.match(st.name, /无限贷款/, '存档名标出无限贷款');
  assert.equal(st.bond, true, '无限贷款仍可发债');
  assert.equal(st.fail, false, '资金为负也不会因缺钱失败');
  // 资金为负仍然可以建设
  const neg = await E('(()=>{const e=CM.game.econ;e.funds=-80000;const ok=e.canAffordBuild(50000);return {ok,funds:e.funds,spent:e.spendBuild({construction:20000},"测试建设"),after:e.funds}})()');
  assert.equal(neg.ok, true, '资金为负时 canAffordBuild 仍为真');
  assert.ok(neg.after < neg.funds, '支出照常记账（可以透支）');
  // HUD 显示真实金额（不是 ∞），并挂上「贷」角标
  const hud = await E('(()=>{const p=CM.ui.pills&&CM.ui.pills.money;return p?{v:p.v.textContent.trim(),inf:p.el.classList.contains("inf-loan"),tip:p.el.getAttribute("data-tip")}:null})()');
  if (hud) { assert.ok(hud.v.indexOf('∞') < 0, 'HUD 显示真实资金而不是 ∞：' + hud.v); assert.equal(hud.inf, true, '资金胶囊挂上无限贷款标记'); assert.match(hud.tip, /无限贷款/); }
  // 财政页：融资页签仍在，并说明已开启无限贷款
  await E('CM.ui.openPage("finance",null,{root:true});true');
  await until('!!document.querySelector(".fin-page")');
  const finTabs = await E('[...document.querySelectorAll(".fin-page .ptabs button")].map(b=>b.textContent.trim())');
  assert.ok(finTabs.length >= 2, '财政页有页签：' + finTabs.join('/'));
  assert.ok(finTabs.some(t => t.indexOf('融资') >= 0), '无限贷款不改融资规则，页签仍在：' + finTabs.join('/'));
  const finNote = await E('(()=>{const els=[...document.querySelectorAll(".fin-page .note, .fin-page .callout")];return els.map(e=>e.textContent).join(" | ")})()');
  assert.match(finNote, /无限贷款/, '财政页说明当前已开启无限贷款');
  // 设置页：开关状态正确显示，可关掉并恢复原有贷款限制
  await E('CM.ui.closeScreen();CM.ui.showSettings("game");true');
  await until('!!document.querySelector(".set-row")');
  const setInf = await E('(()=>{const s=[...document.querySelectorAll("[aria-label=\\"无限贷款\\"]")].find(b=>b.closest(".set-row"));if(!s)return null;const r=s.closest(".set-row");return {on:s.getAttribute("aria-checked"),txt:r?r.textContent:""}})()');
  assert.ok(setInf, '设置页有无限贷款开关');
  assert.equal(setInf.on, 'true', '设置页显示为已开启');
  assert.match(setInf.txt, /恢复原有贷款限制/, '设置页说明关闭后的效果');
  // 滚到「本局难度」再截图
  await E('(()=>{const r=[...document.querySelectorAll("[aria-label=\\"无限贷款\\"]")].find(b=>b.closest(".set-row"));if(r&&r.closest(".set-row").scrollIntoView)r.closest(".set-row").scrollIntoView({block:"center"});return true})()');
  await delay(260);
  await shot('v38-settings-inf');
  const offState = await E('(()=>{const s=[...document.querySelectorAll("[aria-label=\\"无限贷款\\"]")].find(b=>b.closest(".set-row"));s.click();const e=CM.game.econ;return {inf:e.isInfinite(),afford:e.canAffordBuild(1e12),diff:e.difficulty}})()');
  assert.equal(offState.inf, false, '关掉开关后不再无限贷款');
  assert.equal(offState.afford, false, '关掉后恢复原有贷款限制');
  assert.equal(offState.diff, 'normal', '开关不影响难度档位');
  // 后面的用例在负资金下验证建设不受限，把开关重新打开
  await E('(()=>{CM.game.econ.setInfLoan(true);return CM.game.econ.isInfinite()})()');

  // ---------------- 3. 车队页：科技树 + 自动配置开关 + 交路配属表 ----------------
  await E('CM.ui.closeScreen();true');   // 关掉开局简报，免得盖住车队页
  await E('CM.ui.openPage("fleet",null,{root:true});true');
  await until('!!document.querySelector(".tt")');
  const tree = await E('(()=>{const rows=[...document.querySelectorAll(".tt-row")];const nodes=[...document.querySelectorAll(".tt-node")];return {rows:rows.length,nodes:nodes.length,lit:nodes.filter(n=>n.classList.contains("lit")).length,cities:[...document.querySelectorAll(".tt-cities button")].length,labels:rows.map(r=>r.querySelector(".tt-lb").textContent.trim())}})()');
  assert.ok(tree.rows >= 3, '科技树至少三行（主干 / 支线 / 160）：' + tree.rows);
  assert.ok(tree.nodes >= 8, '节点数量够多：' + tree.nodes);
  assert.ok(tree.lit >= 3, '按年份点亮了一部分节点：' + tree.lit);
  assert.equal(tree.cities, 9, '9 个城市支线切换按钮');
  assert.deepEqual(tree.labels.slice(0, 1), ['主干']);
  const switches = await E('[...document.querySelectorAll(".fo-auto .switch")].map(b=>b.getAttribute("aria-label"))');
  assert.ok(switches.indexOf('自动配置列车') >= 0, '有「自动配置列车」总开关：' + switches.join('/'));
  assert.ok(switches.indexOf('每月自动分配闲置列车') >= 0, '保留月度自动分配开关');
  const fleetTbl = await E(`(()=>{const grps=[...document.querySelectorAll(".fleet-grp")],tbs=[...document.querySelectorAll(".fleet-line-tbl")];
    if(!grps.length||!tbs.length)return null;
    const th=[...tbs[0].querySelectorAll("th")].map(x=>x.textContent.trim());
    const rows=tbs[0].querySelectorAll("tr").length-1;
    const acts=[...tbs[0].querySelectorAll("tr")].slice(1).map(tr=>[...tr.querySelectorAll("td:nth-child(4) button")].map(b=>b.textContent.trim()));
    const svc=tbs[0].querySelector("tr:nth-child(2) td b");
    return {grps:grps.length,tables:tbs.length,th:th,rows:rows,acts:acts,svc:svc?svc.textContent.trim():""}})()`);
  assert.ok(fleetTbl, '列车管理改为按线路分组展示');
  assert.ok(fleetTbl.grps >= 1 && fleetTbl.tables === fleetTbl.grps, '每条线路一个分组、组内一张交路表：' + fleetTbl.grps);
  assert.deepEqual(fleetTbl.th, ['交路', '车型 × 数量', '配属/需要', '操作'], '组内表的列与需求一致');
  assert.ok(fleetTbl.rows >= 1, '至少一条交路：' + fleetTbl.rows);
  assert.equal(fleetTbl.svc, '全程站站停', '交路列只写交路，不再重复线路名');
  assert.ok(fleetTbl.acts.every(a => a.indexOf('卖出') >= 0), '每一行都有卖出');
  assert.ok(fleetTbl.acts.some(a => a.indexOf('买入') >= 0), '交路行可以买入');
  await shot('v37-fleet-tree');
  // 组内「买入」直达该交路的购车弹窗（默认配属这个交路），关掉后不影响页面
  await E('(()=>{const b=[...document.querySelectorAll(".fleet-line-tbl td:nth-child(4) button")].find(x=>x.textContent.trim()==="买入");b.click();return true})()');
  await until('!!document.querySelector(".fo-shop")');
  assert.match(await E('(()=>document.querySelector(".card.wide .card-head h2").textContent)()'), /购买列车 · .+ · 全程站站停/, '买入弹窗写明线路与交路');
  await E('(()=>{const b=[...document.querySelectorAll(".modal-actions button")].find(x=>x.textContent.trim()==="取消");b.click();return true})()');
  await until('document.getElementById("screen").classList.contains("hidden")', 10000);
  await delay(200);
  // 英文界面：表头与操作按钮都要译出（车型名等游戏数据不在此列）
  await E('CM.I18n.apply("en");true');
  await delay(450);
  const enTh = await E('[...document.querySelectorAll(".fleet-line-tbl th")].slice(0,4).map(x=>x.textContent.trim())');
  assert.deepEqual(enTh, ['Service', 'Model × count', 'Assigned / needed', 'Actions'], '组内表头有英文：' + enTh.join('/'));
  const enBtns = await E('[...document.querySelectorAll(".fleet-line-tbl td:nth-child(4) button")].slice(0,2).map(b=>b.textContent.trim())');
  assert.deepEqual(enBtns, ['Buy', 'Sell'], '买入卖出有英文：' + enBtns.join('/'));
  await E('CM.I18n.apply("zh-CN");true');
  await delay(350);

  // 打开自动配置开关
  await E('[...document.querySelectorAll(".fo-auto .switch")].find(b=>b.getAttribute("aria-label")==="自动配置列车").click();true');
  await until('CM.game.fleet.autoConfig===true');
  assert.equal(await E('CM.game.fleet.autoConfig'), true, '开关能打开并写进存档数据');

  // ---------------- 4. 线路页：科技树升级条 + 颜色代码 ----------------
  const lid = await E('Object.keys(CM.game.net.lines)[0]');
  // 塞一列小编组旧车，保证出现「一键升级 / 可扩编」入口
  await E(`(()=>{const g=CM.game,k=${JSON.stringify(lid)};g.fleet.trains.push({id:'T99',model:'gen-a',cars:4,bought:g.ym(),cost:100,line:k,svc:null});g.fleet.ver++;g.model.applyFleet();return true})()`);
  await E(`CM.ui.openPage("line",${JSON.stringify(lid)}, {root:true});true`);
  // 升级条在「列车运营」分页
  await until('!!document.querySelector(".ptabs")');
  const toOps = await E('(()=>{const b=[...document.querySelectorAll(".ptabs button")].find(x=>/列车运营/.test(x.textContent));if(b){b.click();return true}return false})()');
  assert.equal(toOps, true, '线路页有「列车运营」分页');
  await until('!!document.querySelector(".up-tech")');
  const upBar = await E('(()=>{const b=document.querySelector(".up-tech");return {t:b.querySelector("b").textContent,d:b.textContent,btn:b.querySelector("button").textContent.trim(),dis:!!b.querySelector("button").disabled}})()');
  assert.match(upBar.t, /升级|扩编/, '升级条标题写明升级或扩编：' + upBar.t);
  assert.equal(upBar.btn, '补差价升级');
  assert.equal(upBar.dis, false, '沙盒档不会因资金不足置灰');
  await shot('v37-line-upgrade');
  const beforeStale = await E(`(CM.Fleet.staleTech(CM.game,${JSON.stringify(lid)})||[]).map(x=>x.id)`);
  assert.ok(beforeStale.length > 0, '升级条出现时确实有待升级的列车');
  await E('document.querySelector(".up-tech button").click();true');
  await until('!!document.querySelector(".modal-actions")');
  const okBtn = await E('(()=>{const b=[...document.querySelectorAll(".modal-actions button")].find(x=>/补差价升级/.test(x.textContent));if(b){b.click();return true}return false})()');
  assert.equal(okBtn, true, '确认弹窗里有「补差价升级」按钮');
  await delay(600);
  const after = await E(`(()=>{const g=CM.game,k=${JSON.stringify(lid)};
    const tg=CM.Fleet.techTarget(g,k);
    const onLine=g.fleet.trains.filter(t=>t.line===k);
    return {target:tg?{id:tg.m.id,cars:tg.cars}:null,lineCars:CM.Fleet.lineCars(g,k),
      models:[...new Set(onLine.map(t=>t.model))],cars:onLine.map(t=>t.cars),n:onLine.length,
      stale:(CM.Fleet.staleTech(g,k)||[]).map(x=>x.id),
      toasts:[...document.querySelectorAll(".toast")].map(x=>x.textContent.trim())}})()`);
  assert.equal(after.stale.length, 0, '升级后本线没有待升级列车（车型与编组都到顶）：' + after.stale.join(','));
  assert.ok(after.cars.every(c => c >= after.target.cars), '每列编组都不小于目标：' + JSON.stringify(after.cars));
  assert.ok(after.models.every(m => m === after.target.id), '车型统一到本城最新：' + after.models.join('/'));
  assert.ok(after.toasts.some(t => /已升级/.test(t)), '弹出升级结果提示');

  // 颜色代码输入：切到「编辑」分页并展开「线路颜色」，输入 #F3D03E 后线路颜色立即变化
  const backInfo = await E('(()=>{const b=[...document.querySelectorAll(".ptabs button")].find(x=>/编辑/.test(x.textContent));if(b){b.click();return true}return false})()');
  assert.equal(backInfo, true, '线路页有「编辑」分页');
  await until('!!document.querySelector(".sec-h")');
  await delay(300);
  // 折叠区块按需构建内容：把全部区块展开，确保「线路颜色」的正文已生成
  await E('(()=>{document.querySelectorAll(".sec-h").forEach(function(b){var s=b.closest(".sec");if(s&&!s.classList.contains("open"))b.click();});return true})()');
  const secs = await E('[...document.querySelectorAll(".sec-h")].map(b=>b.textContent.trim())');
  assert.ok(secs.some(t => /线路颜色/.test(t)), '有「线路颜色」区块：' + secs.join(' / '));
  await until('!!document.querySelector(".lc-hex")');
  const c0 = await E(`CM.game.net.lines[${JSON.stringify(lid)}].color`);
  await E(`(()=>{const i=document.querySelector(".lc-hex");i.value="#F3D03E";i.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));return true})()`);
  await until(`String(CM.game.net.lines[${JSON.stringify(lid)}].color).toLowerCase()==="#f3d03e"`);
  const c1 = await E(`CM.game.net.lines[${JSON.stringify(lid)}].color`);
  assert.equal(String(c1).toLowerCase(), '#f3d03e', '颜色代码写入线路：' + c0 + ' → ' + c1);
  // 三位缩写也能识别；非法值加 .bad 提示且不写入
  await E('(()=>{const i=document.querySelector(".lc-hex");i.value="#0af";i.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));return true})()');
  await until(`String(CM.game.net.lines[${JSON.stringify(lid)}].color).toLowerCase()==="#00aaff"`);
  const bad = await E('(()=>{const i=document.querySelector(".lc-hex");const c0=CM.game.net.lines[Object.keys(CM.game.net.lines)[0]].color;i.value="zzz";i.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));return {bad:i.classList.contains("bad"),same:String(CM.game.net.lines[Object.keys(CM.game.net.lines)[0]].color)===String(c0)}})()');
  assert.equal(bad.bad, true, '非法颜色代码标红');
  assert.equal(bad.same, true, '非法值不写入线路颜色');
  await shot('v37-line-color');

  // ---------------- 5. 作弊设施读档后仍在 ----------------
  // 复现旧 bug：新建一局 ver 从 1 起，若另一份存档的 ver 也恰好是 1，只按 ver 做键的缓存会命中旧表、
  // 把自定义设施漏掉。现在缓存键带上设施内容签名，必须重新建表。
  const facId = await E('(()=>{const g=CM.game,st=g.compiled.stations[0];const r=CM.Cheat.addFac(g,{t:"shop",x:st.x,y:st.y,r:1,name:"读档测试设施"});const c=g.cheat.cfacs[g.cheat.cfacs.length-1];return c?c.id:null})()');
  assert.ok(facId, '作弊设施已添加');
  await until(`!!CM.Fac.byId(${JSON.stringify(facId)})`);
  const cached = await E(`(()=>{const g=CM.game;g.cheat.ver=1;             // 模拟「另一份存档也是 ver 1」
    const list=CM.Fac.list(g.city);return {n:list.filter(x=>x.cus).length,byId:!!CM.Fac.byId(${JSON.stringify(facId)}),sig:CM.Cheat.sig().indexOf(${JSON.stringify(facId)})===0}})()`);
  assert.equal(cached.sig, true, '内容签名带上设施 id');
  assert.equal(cached.byId, true, 'ver 相同但内容不同时缓存仍要失效（设施不会消失）');
  assert.ok(cached.n >= 1, '设施表里还有自定义设施（' + cached.n + '）');
  // 完整存档往返：读档并清缓存后仍然存在
  await E('window.__v37=CM.game.serialize();true');
  await E('(()=>{const s=window.__v37;CM.game=null;const g=CM.Game.restore(s);CM.game=g;if(CM.Fac&&CM.Fac.clearCache)CM.Fac.clearCache();return true})()');
  await until(`!!CM.Fac.byId(${JSON.stringify(facId)})`, 30000);
  const afterRestore = await E(`(()=>{const f=CM.Fac.byId(${JSON.stringify(facId)});const l=CM.Fac.list(CM.game.city).filter(x=>x.cus).map(x=>x.id);return {byId:!!f,cus:l}})()`);
  assert.equal(afterRestore.byId, true, '读档后 Cheat.byId 仍能找到该设施');
  assert.ok(afterRestore.cus.indexOf(facId) >= 0, '读档后设施表里仍有该设施：' + afterRestore.cus.join(','));

  if (errors.length) throw Error('页面运行时报错：\n' + errors.join('\n'));
  console.log('ALL PASS v3.7 UI：5 档难度 + 无限贷款独立开关 / 透支建设 / 科技树与一键升级 / 自动配置开关 / 线路颜色代码 / 设施读档');
} finally {
  try { ws && ws.close(); } catch { }
  try { edge.kill(); } catch { }
  server.close();
}
