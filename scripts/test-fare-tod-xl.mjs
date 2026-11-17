// 票价手输框（整数约束、错误提示、阻止提交）与「一键开发所有站台」的回归测试。
// 先跑纯逻辑（U.checkNum 的解析与错误分类），再用隔离的 Chromium 跑真实界面操作。
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

const task = await fs.mkdtemp(path.join(os.tmpdir(), 'city-metro-faretod-')), profile = path.join(task, 'profile');
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

  const setInput = async (idx, val) => E(`(()=>{const i=document.querySelectorAll(".fare-ed .fare-num")[${idx}];i.focus();i.value=${JSON.stringify(val)};i.dispatchEvent(new Event("input",{bubbles:true}));return true})()`);
  const errAt = idx => E(`(()=>{const r=document.querySelectorAll(".fare-ed .fare-row")[${idx}];const e=r.querySelector(".fare-err");return {on:e.classList.contains("on"),msg:e.textContent,txt:r.querySelector(".fare-num").value,inv:r.querySelector(".fare-num").getAttribute("aria-invalid")}})()`);
  const applyState = () => E('(()=>{const b=[...document.querySelectorAll(".fare-ed .row button")].find(x=>x.textContent.includes("应用新票价"));return {disabled:b.disabled,tip:b.getAttribute("data-tip")||""}})()');

  // 5 行：起步价 / 起步里程 / 每段里程 / 每段加价 / 封顶，且都是可输入的文本框
  const shape = await E('(()=>{const rows=[...document.querySelectorAll(".fare-ed .fare-row")].filter(r=>!r.closest("[hidden]"));return rows.map(r=>({k:r.querySelector(".fare-k").textContent,tag:r.querySelector(".fare-num").tagName,type:r.querySelector(".fare-num").type,mode:r.querySelector(".fare-num").getAttribute("inputmode")}))})()');
  assert.deepEqual(shape.map(s => s.k), ['起步价', '起步里程', '每段里程', '每段加价', '封顶']);
  assert.ok(shape.every(s => s.tag === 'INPUT' && s.type === 'text'), '每一行都有可手输的文本框');
  assert.equal(shape[1].mode, 'numeric', '里程字段是数字键盘');
  assert.equal(shape[0].mode, 'decimal', '票价字段允许一位小数');

  // 非数字
  await setInput(1, 'abc');
  let st = await errAt(1), ap = await applyState();
  assert.equal(st.on, true); assert.match(st.msg, /只能输入数字/); assert.equal(st.inv, 'true');
  assert.equal(ap.disabled, true, '非法输入时不能提交');

  // 小数：里程只收整数
  await setInput(1, '6.5');
  st = await errAt(1); assert.match(st.msg, /只能输入整数/);
  await setInput(0, '2.55');
  st = await errAt(0); assert.match(st.msg, /最多保留 1 位小数/);

  // 负数
  await setInput(1, '-4');
  st = await errAt(1); assert.match(st.msg, /不能是负数/);

  // 空值
  await setInput(1, '');
  st = await errAt(1); assert.match(st.msg, /不能为空/);

  // 超范围
  await setInput(1, '99');
  st = await errAt(1); assert.match(st.msg, /需在 1 – 20 km 之间/);

  // 还原：清掉错误提示，输入框回到当前票价
  await E('(()=>{const b=[...document.querySelectorAll(".fare-ed .row button")].find(x=>x.textContent==="还原");b.click();return true})()');
  await delay(200);
  const resetState = await E('(()=>{const r=document.querySelectorAll(".fare-ed .fare-row")[1];return {on:r.querySelector(".fare-err").classList.contains("on"),val:r.querySelector(".fare-num").value,cur:CM.game.econ.fare.km0,inv:r.querySelector(".fare-num").getAttribute("aria-invalid")}})()');
  assert.equal(resetState.on, false, '还原后错误提示消失');
  assert.equal(+resetState.val, resetState.cur, '还原后输入框回到当前票价');
  assert.equal(resetState.inv, null);

  // 输入合法值后错误消失、可以提交；滑块跟着同步
  await setInput(0, '2.5');
  await setInput(1, '10');
  st = await errAt(1); ap = await applyState();
  assert.equal(st.on, false, '改正后错误提示消失');
  assert.equal(ap.disabled, false);
  const sliderSync = await E('(()=>{const s=document.querySelectorAll(".fare-ed .fare-row")[1].querySelector("input[type=range]");return s.value})()');
  assert.equal(sliderSync, '10', '手输后滑块同步');
  await E('(()=>{const b=[...document.querySelectorAll(".fare-ed .row button")].find(x=>x.textContent.includes("应用新票价"));b.click();return true})()');
  await delay(300);
  const applied = await E('({km0:CM.game.econ.fare.km0,flat:CM.game.econ.fare.flat,mode:CM.game.econ.fare.mode})');
  assert.equal(applied.mode, 'dist');
  assert.equal(applied.km0, 10, '合法输入可以应用');
  assert.equal(applied.flat, 2.5);

  // 手动输入非法值后直接点提交：被拦住，票价不变
  await setInput(1, '3.5');
  await E('(()=>{const b=[...document.querySelectorAll(".fare-ed .row button")].find(x=>x.textContent.includes("应用新票价"));b.click();return true})()');
  await delay(200);
  assert.equal(await E('CM.game.econ.fare.km0'), 10, '非法输入不会改变票价');
  await setInput(1, '12');
  await delay(100);
  console.log('PASS 票价手输与校验');

  // ---------------- 一键开发所有站台 ----------------
  // v3.5：TOD 第 5 级要巨型及以上、第 4 级要超大型及以上。这里把北京这批站台统一升为巨型（商业投入 ×3.4，同步补足资金），
  // 保持「一键开发所有站台 → 第 5 级」的既有口径；小站分级停在第 3 / 4 级的门槛由 test-v33 与车站详情覆盖
  await E('CM.game.econ.funds=4e10;Object.values(CM.game.net.stations).forEach(s=>s.size="XXL");CM.ui.rerenderPage();true');
  // 面板已在「资金」页时再点同一入口是收起，所以先关再开，让 TOD 折叠区块以展开状态重建
  await E('CM.ui.open["fi-tod"]=true;CM.ui.closePanel(true);CM.ui.openTop("money");true');
  await until('!!document.querySelector(".tod-batch")');
  const batch0 = await E(`(()=>{
    const sec=[...document.querySelectorAll(".sec")].find(s=>(s.querySelector(".sec-h")||{}).textContent?.includes("车站商业（TOD）"));
    const body=document.querySelector(".tod-batch").parentElement;
    const btn=document.querySelector(".tod-batch .btn");
    const stat=document.querySelector(".tod-batch .tod-batch-stat").textContent;
    const note=document.querySelector(".tod-batch .tod-batch-s:not(.tod-batch-stat)")?.textContent||"";
    const stations=Object.values(CM.game.net.stations);
    return {btn:btn.textContent,disabled:btn.disabled,stat:stat,note:note,sum:sec.querySelector(".sec-h .sum").textContent,
      total:stations.length,top:stations.filter(s=>s.tod===CM.TOD.LEVELS.length-1).length}
  })()`);
  assert.equal(batch0.btn, '一键开发所有站台');
  assert.match(batch0.stat, /待开发 \d+ 座 · 预计投入/);
  assert.match(batch0.note, /整批一次扣费.*进度.*跳过.*失败/, '界面要说明进度反馈与异常处理');

  // 资金不足：整批不开发（按钮置灰并在提示里说明缺多少）
  const funds0 = await E('CM.game.econ.funds');
  await E('CM.game.econ.funds=0;CM.ui.rerenderPage();true');
  await until('!!document.querySelector(".tod-batch .btn")');
  const poor = await E(`(()=>{const b=document.querySelector(".tod-batch .btn");return {disabled:b.disabled,tip:b.getAttribute("data-tip")||""}})()`);
  assert.equal(poor.disabled, true, '资金不足时按钮不可用');
  assert.match(poor.tip, /资金不足：需要/);
  await E('CM.game.econ.funds=' + JSON.stringify(funds0) + ';CM.ui.rerenderPage();true');
  await until('!!document.querySelector(".tod-batch .btn")');

  // 正式执行：一次扣费，随后逐站推进到全部最高级
  const before = await E('({funds:CM.game.econ.funds})');
  await E('document.querySelector(".tod-batch .btn").click();true');
  const mid = await E('(()=>{const t=document.querySelector(".tod-prog");return t&&!t.hidden?t.textContent:""})()');
  await until('(()=>{const t=document.querySelector(".tod-prog-txt b");return !!t&&/^已完成/.test(t.textContent)})()', 120000);
  const after = await E(`(()=>{
    const stations=Object.values(CM.game.net.stations);
    const sec=[...document.querySelectorAll(".sec")].find(s=>(s.querySelector(".sec-h")||{}).textContent?.includes("车站商业（TOD）"));
    return {funds:CM.game.econ.funds,txt:document.querySelector(".tod-prog-txt").textContent,
      stat:document.querySelector(".tod-batch .tod-batch-stat").textContent,sum:sec.querySelector(".sec-h .sum").textContent,
      lvAll:stations.every(s=>s.tod===CM.TOD.LEVELS.length-1),n:stations.length,
      log:CM.game.events.length?CM.game.events[CM.game.events.length-1].title:"",
      rowBtns:[...document.querySelectorAll(".tod-row")].map(r=>({t:(r.querySelector(".btn")||{}).textContent||"",d:!!(r.querySelector(".btn")||{}).disabled,
        info:((r.querySelector("small")||{}).textContent)||""})),
      toast:[...document.querySelectorAll(".toast")].map(t=>t.textContent).join("|")};
  })()`);
  assert.ok(after.lvAll, '全部站台都应开发到最高等级');
  assert.match(after.txt, /^已完成 \d+ \/ \d+ 座/, '结束时显示完成进度');
  assert.match(after.stat, /都已开发到最高等级/);
  assert.match(after.sum, /站 · 每月净[收亏]/, '折叠标题刷新为最新净收益');
  assert.match(after.log, /一键开发所有站台/);
  assert.ok(after.rowBtns.some(b => b.t === '已满级' && b.d), '列表里已到最高等级的站台改为「已满级」并置灰');
  assert.ok(!after.rowBtns.some(b => b.t === '开发' || b.t === '升级'), '不会还留着可点的开发 / 升级按钮：' + JSON.stringify(after.rowBtns));
  assert.ok(after.rowBtns.some(b => /TOD 枢纽开发/.test(b.info)), '列表信息更新为新的开发等级');
  const spent = before.funds - after.funds;
  assert.ok(spent > 0, '整批要扣费一次：' + spent);
  assert.ok(after.funds >= 0);
  assert.ok(mid === '' || /正在开发|已完成/.test(mid), '执行过程中给出进度反馈');

  // 二次点击：没有待开发站台时按钮不可用，不会再扣钱
  assert.equal(await E('document.querySelector(".tod-batch .btn").disabled'), true, '全部开发完成后按钮置灰');
  assert.equal(await E('CM.game.econ.funds'), after.funds, '不会重复扣费');

  // ---------------- 只开发盈利站台（v2.9.3；v2.9.4 逐站选可盈利等级） ----------------
  // 复位成「全部未开发 + 资金充足」，把客流最小的一座站台的客流清零：收入归零、维护成本照旧，
  // 开发到任何等级都亏钱，用它验证筛选是真的在按净收益过滤，而不是换个名字又全开发一遍。
  await E('CM.game.econ.funds=8e9;Object.values(CM.game.net.stations).forEach(s=>s.tod=0);CM.ui.rerenderPage();true');
  await until('!!document.querySelector(".tod-batch")');
  const starved = await E(`(()=>{
    const g=CM.game,C=g.model.net.C,sd=g.model.stDaily;let best=null;
    for(const cs of C.stations){const st=g.net.stations[cs.id];if(!st)continue;const k=C.sIndex.get(cs.id);const f=sd.inn[k]+sd.out[k]+sd.xfer[k];if(!best||f<best.f)best={id:cs.id,k,f};}
    if(!best)return null;
    sd.inn[best.k]=0;sd.out[best.k]=0;sd.xfer[best.k]=0;CM.ui.rerenderPage();
    return {id:best.id,name:g.net.stations[best.id].name};
  })()`);
  await until('!!document.querySelector(".tod-batch")');
  // 期望：每座站台都做到「自己还能赚钱的最高等级」，一级都不赚的一座都不动
  const plan = await E(`(()=>{
    const g=CM.game,top=CM.TOD.LEVELS.length-1;
    const best=id=>{const I=CM.ui.todInfo(id);if(!I)return 0;for(let l=top;l>=1;l--)if(I.net(l)>0)return l;return 0;};
    const cand=Object.values(g.net.stations).filter(s=>{const I=CM.ui.todInfo(s.id);return I&&(s.tod||0)<top;});
    const exp=cand.filter(s=>best(s.id)>0).map(s=>({id:s.id,lv:best(s.id)}));
    const none=cand.filter(s=>best(s.id)===0).map(s=>s.id);
    const btns=[...document.querySelectorAll(".tod-batch .btn")];
    return {exp:exp,none:none,btns:btns.map(x=>x.textContent),
      stat2:document.querySelectorAll(".tod-batch .tod-batch-stat")[1].textContent};
  })()`);
  assert.equal(plan.btns.length, 2, '批量开发里应有两个入口：' + JSON.stringify(plan.btns));
  assert.equal(plan.btns[1], '只开发盈利站台');
  assert.ok(plan.exp.length >= 1, '场景里应有能开发到盈利等级的站台');
  assert.ok(plan.none.indexOf(starved.id) >= 0, '被抽走客流的站台任何等级都亏，应被排除：' + starved.name);
  assert.match(plan.stat2, /开发后仍盈利 \d+ 座 · 预计投入 .+ · 开发后每月净收益/, '要报出盈利站台数、投入与每月净收益');
  assert.ok(plan.stat2.indexOf('开发后仍盈利 ' + plan.exp.length + ' 座') === 0, '报出的座数要等于逐站可盈利的站台数：' + plan.stat2);

  const fundsP = await E('CM.game.econ.funds');
  await E('document.querySelectorAll(".tod-batch .btn")[1].click();true');
  await until('(()=>{const t=document.querySelector(".tod-prog-txt b");return !!t&&/^已完成/.test(t.textContent)})()', 180000);
  const resP = await E(`(()=>{
    const g=CM.game;
    const lv=id=>((g.net.stations[id]||{}).tod||0);
    const net=id=>{const I=CM.ui.todInfo(id);return I?I.net(lv(id)):0;};
    const exp=${JSON.stringify(plan.exp)};
    return {funds:g.econ.funds,got:exp.map(e=>lv(e.id)),want:exp.map(e=>e.lv),net:exp.map(e=>net(e.id)),
      none:${JSON.stringify(plan.none)}.map(lv),
      log:(g.events||[]).slice(-1)[0]?g.events[g.events.length-1].title:"",
      toast:[...document.querySelectorAll(".toast")].map(t=>t.textContent).join("|"),
      txt:document.querySelector(".tod-prog-txt").textContent};
  })()`);
  assert.equal(resP.got.join(','), resP.want.join(','), '每座站台都开发到它能盈利的最高等级：期望 ' + JSON.stringify(resP.want) + '，实际 ' + JSON.stringify(resP.got));
  assert.ok(resP.net.every(v => v > 0), '开发后的站台都处于盈利状态：' + JSON.stringify(resP.net));
  assert.ok(resP.none.every(v => v === 0), '任何等级都不盈利的站台一座都不应被动过：' + JSON.stringify(resP.none));
  assert.match(resP.log, /只开发盈利站台/, '日志标题要与入口一致');
  assert.match(resP.toast, /只开发盈利站台/, '提示要说明是盈利口径');
  assert.match(resP.txt, /^已完成 \d+ \/ \d+ 座/);
  assert.ok(fundsP - resP.funds > 0, '只开发盈利站台同样整批扣费一次');

  // 逐站定级的关键场景：某站「第 2 级能赚、第 3 级就亏」，旧逻辑会把它拉满成亏损，新逻辑应停在 2 级
  await E('CM.game.econ.funds=8e9;Object.values(CM.game.net.stations).forEach(s=>s.tod=0);CM.ui.rerenderPage();true');
  await until('!!document.querySelector(".tod-batch")');
  const tuned = await E(`(()=>{
    const g=CM.game,C=g.model.net.C,sd=g.model.stDaily,T=CM.TOD,top=T.LEVELS.length-1;
    const net=(I,l,f)=>T.stationDaily(l,f,I.hub,g.clock.y,g)*30.4-T.stationCost(l,g.clock.y,I.s.size,I.hub)*30.4;
    for(const cs of C.stations){
      const st=g.net.stations[cs.id];if(!st)continue;
      const k=C.sIndex.get(cs.id),I=CM.ui.todInfo(cs.id);if(!I||k===undefined)continue;
      if(I.flow<=0)continue;
      // 二分出第 3 级刚好打平的客流，取其 80%：三级转为亏损、二级仍在赚钱
      let lo=1,hi=200000;
      for(let it=0;it<40;it++){const mid=(lo+hi)/2;if(net(I,top,mid)>0)hi=mid;else lo=mid;}
      const f=hi*0.8;
      if(net(I,1,f)<=0||net(I,2,f)<=0||net(I,top,f)>0)continue;
      sd.inn[k]=f;sd.out[k]=0;sd.xfer[k]=0;CM.ui.rerenderPage();
      return {id:cs.id,name:st.name,f:Math.round(f),net2:net(I,2,f),net3:net(I,top,f)};
    }
    return null;
  })()`);
  assert.ok(tuned, '应能造出「第 2 级盈利、第 3 级亏损」的站台');
  assert.ok(tuned.net2 > 0 && tuned.net3 <= 0, '造出的站台应二级盈利、三级亏损：' + JSON.stringify(tuned));
  await until('!!document.querySelector(".tod-batch")');
  const cappedPlan = await E('document.querySelectorAll(".tod-batch .tod-batch-stat")[1].textContent');
  assert.match(cappedPlan, /第 2 级：\d+ 座/, '统计行要报出目标等级分布：' + cappedPlan);
  await E('document.querySelectorAll(".tod-batch .btn")[1].click();true');
  await until('(()=>{const t=document.querySelector(".tod-prog-txt b");return !!t&&/^已完成/.test(t.textContent)})()', 180000);
  const capped = await E(`(()=>{
    const g=CM.game,id=${JSON.stringify(tuned.id)},lv=(g.net.stations[id]||{}).tod||0,I=CM.ui.todInfo(id);
    return {lv:lv,net:I?I.net(lv):0};
  })()`);
  assert.equal(capped.lv, 2, '只开发到仍能盈利的第 2 级，不会被拉满成亏损：' + tuned.name);
  assert.ok(capped.net > 0, '停在第 2 级时仍是盈利状态');

  // 全部站台开发后都亏：按钮置灰、写清原因；即使强行触发也不会扣钱
  await E(`(()=>{const g=CM.game,C=g.model.net.C,sd=g.model.stDaily;
    for(const cs of C.stations){const st=g.net.stations[cs.id];if(!st)continue;const k=C.sIndex.get(cs.id);sd.inn[k]=0;sd.out[k]=0;sd.xfer[k]=0;}
    Object.values(g.net.stations).forEach(s=>s.tod=0);CM.ui.rerenderPage();return true})()`);
  await until('!!document.querySelector(".tod-batch")');
  const dead = await E(`(()=>{const b=[...document.querySelectorAll(".tod-batch .btn")][1];
    return {dis:b.disabled,tip:b.getAttribute("data-tip")||"",stat2:document.querySelectorAll(".tod-batch .tod-batch-stat")[1].textContent}})()`);
  assert.equal(dead.dis, true, '没有开发后盈利的站台时按钮应置灰');
  assert.match(dead.tip, /没有开发后仍盈利的站台/, '置灰时要说明原因');
  assert.match(dead.stat2, /没有开发后仍盈利的站台/, '统计行要写清为什么不给开发');
  const fundsD = await E('CM.game.econ.funds');
  await E('(()=>{const b=[...document.querySelectorAll(".tod-batch .btn")][1];b.disabled=false;b.click();return true})()');
  await delay(400);
  assert.equal(await E('CM.game.econ.funds'), fundsD, '没有候选时不扣费');
  console.log('PASS 只开发盈利站台');
  assert.equal(errors.length, 0, 'Browser errors:\n' + errors.join('\n'));
  console.log('PASS 一键开发所有站台');
} finally {
  if (send) await Promise.race([send('Browser.close').catch(() => { }), delay(1500)]);
  if (ws) ws.close();
  edge.kill();
  server.closeAllConnections();
  await new Promise(r => server.close(r));
  await fs.rm(task, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
}
