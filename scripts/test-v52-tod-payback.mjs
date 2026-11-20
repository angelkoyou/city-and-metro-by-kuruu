// v5.2 车站商业批量开发：「只开发 10 年回本站台」口径回归。
// 重点不是文案，而是这条判定真的按「增量投入 ÷ 年净收益增量 ≤ 10」筛选：
//   · 同样 net > 0 的一座站，10 年回不了本时新入口必须停在低等级（旧盈利口径会拉满）
//   · 已开发到 2 级的站，升 3 级回不了本就不许升
//   · 车站详情里「约 N 年回本」与筛选用的是同一口径
//   · 按钮 / 统计行 / 说明段 / 英文界面
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

const task = await fs.mkdtemp(path.join(os.tmpdir(), 'city-metro-payback-')), profile = path.join(task, 'profile');
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
  const until = async (exp, ms = 120000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await E(exp)) return; await delay(150); } throw Error('Wait timeout: ' + exp + '\n' + errors.join('\n')); };

  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/' });
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });

  await until('!!window.CM?.ui&&!!document.querySelector(".start-menu")');
  await E('CM.Settings.set("autosave",false);CM.Settings.set("sound",false);true');
  await E('CM.newGame({map:"bj",mode:"challenge",seed:20261111});true');
  await until('!CM.isLoading()&&!!CM.game&&!CM.game.pending');
  await until('!!(CM.game.model.stDaily&&CM.game.model.stDaily.inn&&CM.game.model.stDaily.inn.length&&!CM.game.model.dailyStale)', 180000);
  await E('CM.ui.closeScreen();CM.game.setSpeed(0);CM.ui.toasts.replaceChildren();true');
  await E('CM.ui.openTop("money");true');
  await until('!!document.querySelector(".fare-ed")', 60000);
  // 「车站商业（TOD）」是默认收起的折叠区块，body 惰性构建：先点开标题，批量开发才会进 DOM
  await E(`(()=>{const h=[...document.querySelectorAll(".sec-h")].find(x=>x.textContent.includes("车站商业"));if(h&&!h.closest(".sec").classList.contains("open"))h.click();return true})()`);
  await until('!!document.querySelector(".tod-batch")', 30000);

  // ---------------- PASS 1 入口文案：按钮、说明、统计行 ----------------
  const copy = await E(`(()=>{
    const btns=[...document.querySelectorAll(".tod-batch .btn")].map(x=>x.textContent);
    const ss=[...document.querySelectorAll(".tod-batch .tod-batch-s")].map(x=>x.textContent);
    return {btns:btns,desc:ss[0]||"",stat:ss[1]||"",statP:ss[2]||"",payback:CM.TOD.PAYBACK};
  })()`);
  assert.equal(copy.payback, 10, '回本年限是常量 10，写在一处（CM.TOD.PAYBACK）');
  assert.deepEqual(copy.btns, ['一键开发所有站台', '只开发 10 年回本站台'], '两个入口的名字：' + JSON.stringify(copy.btns));
  assert.match(copy.desc, /10 年内/, '说明段要写清 10 年回本：' + copy.desc);
  assert.match(copy.desc, /追加的投入/, '说明段要说清比的是这次追加的投入');
  assert.match(copy.statP, /10 年内回本 \d+ 座 · 预计投入 .+ · 开发后每月净收益/, '第二行统计要报回本座数、投入与净收益：' + copy.statP);
  console.log('PASS 入口文案与 10 年常量');

  // ---------------- 选一座普通站（cap = 3）做实验：其余站全部拉到满级，批量候选只剩它 ----------------
  const pick = await E(`(()=>{
    const g=CM.game,C=g.model.net.C,T=CM.TOD;
    for(const cs of C.stations){
      const st=g.net.stations[cs.id];if(!st)continue;
      const k=C.sIndex.get(cs.id);if(k===undefined)continue;
      const I=CM.ui.todInfo(cs.id);if(!I||I.flow<=0)continue;
      // 至少要能开发到第 3 级；第 4、5 级的门槛客流是第 3 级的 1.37 / 1.57 倍，
      // 第 3 级回不了本时它们也回不了本，所以不用把 cap 限死在第 3 级
      if(T.maxLv(st.size)<3)continue;
      return {id:cs.id,name:st.name,k:k,flow:I.flow,size:st.size};
    }
    return null;
  })()`);
  assert.ok(pick, '北京图里应有一座「可开发到第 3 级」的普通站');
  const id = pick.id, kk = pick.k;
  const solo = async () => {
    await E(`(()=>{
      const g=CM.game,T=CM.TOD;
      for(const s of Object.values(g.net.stations)) s.tod = s.id===${JSON.stringify(id)} ? 0 : T.maxLv(s.size);
      g.econ.funds=8e9;
      CM.ui.rerenderPage();
      return true;
    })()`);
    await until('!!document.querySelector(".tod-batch")');
  };
  // 二分：让第 3 级「10 年刚好回本」的日客流（pay 随客流递减）
  const f3of = async () => E(`(()=>{
    const g=CM.game,C=g.model.net.C,sd=g.model.stDaily,id=${JSON.stringify(id)},k=${kk};
    const p3=()=>{const I=CM.ui.todInfo(id);return I?I.pay(3):Infinity;};
    let lo=1,hi=2000000;
    for(let i=0;i<60;i++){const mid=(lo+hi)/2;sd.inn[k]=mid;sd.out[k]=0;sd.xfer[k]=0;if(p3()<=10)hi=mid;else lo=mid;}
    sd.inn[k]=hi;sd.out[k]=0;sd.xfer[k]=0;
    return {f:hi,p:p3()};
  })()`);
  const setFlow = async f => E(`(()=>{const sd=CM.game.model.stDaily;sd.inn[${kk}]=${f};sd.out[${kk}]=0;sd.xfer[${kk}]=0;CM.ui.rerenderPage();return true})()`);
  const lvOf = () => E(`(CM.game.net.stations[${JSON.stringify(id)}]||{}).tod||0`);
  const runProfit = async () => {
    await until('!!document.querySelector(".tod-batch")');
    await E('document.querySelectorAll(".tod-batch .btn")[1].click();true');
    await until('(()=>{const t=document.querySelector(".tod-prog-txt b");return !!t&&/^已完成/.test(t.textContent)})()', 180000);
  };

  // ---------------- PASS 2 10 年边界：净收益为正但回不了本的客流，不能拉满 ----------------
  await solo();
  const f3 = await f3of();
  assert.ok(f3.f > 1 && f3.p <= 10 && f3.p > 9, '二分出的临界客流应刚好落在 10 年：' + JSON.stringify(f3));

  // 1.2 倍临界客流：三级 10 年内回本 → 应开发到第 3 级
  await setFlow(f3.f * 1.2);
  const high = await E(`(()=>{const I=CM.ui.todInfo(${JSON.stringify(id)});return {pay3:I.pay(3),net3:I.net(3),pay2:I.pay(2)};})()`);
  assert.ok(high.pay3 <= 10, '高客流下第 3 级应在 10 年内回本：' + JSON.stringify(high));
  await runProfit();
  assert.equal(await lvOf(), 3, '10 年内能回本时应开发到第 3 级');

  // 0.5 倍临界客流：三级净收益仍为正，但回本要 20 年以上 → 只能停在第 1 级
  await solo();
  await setFlow(f3.f * 0.5);
  const low = await E(`(()=>{const I=CM.ui.todInfo(${JSON.stringify(id)});return {pay1:I.pay(1),pay2:I.pay(2),pay3:I.pay(3),net1:I.net(1),net3:I.net(3)};})()`);
  assert.ok(low.net3 > 0, '这个客流下第 3 级本身仍是盈利的（旧口径会把它拉满）：' + JSON.stringify(low));
  assert.ok(low.pay3 > 10, '但第 3 级回本超过 10 年：' + JSON.stringify(low));
  assert.ok(low.net1 > 0 && low.pay1 <= 10, '第 1 级既盈利又能 10 年内回本：' + JSON.stringify(low));
  await runProfit();
  const lowLv = await lvOf();
  assert.ok(lowLv < 3, '回不了本的等级不能被开发：期望低于 3，实际 ' + lowLv);
  assert.equal(lowLv, 1, '应停在 10 年内能回本的第 1 级');
  console.log('PASS 10 年回本边界（未开发站）');

  // ---------------- PASS 3 已开发站升级：升 3 级回不了本就不许升 ----------------
  await solo();
  const f3b = await E(`(()=>{
    const g=CM.game,C=g.model.net.C,sd=g.model.stDaily,id=${JSON.stringify(id)},k=${kk};
    g.net.stations[id].tod=2;                     // 先开发到 2 级，pay 改按「2 → 3」的增量算
    const p3=()=>{const I=CM.ui.todInfo(id);return I?I.pay(3):Infinity;};
    let lo=1,hi=2000000;
    for(let i=0;i<60;i++){const mid=(lo+hi)/2;sd.inn[k]=mid;sd.out[k]=0;sd.xfer[k]=0;if(p3()<=10)hi=mid;else lo=mid;}
    sd.inn[k]=hi;sd.out[k]=0;sd.xfer[k]=0;
    return {f:hi,p:p3(),lv:(g.net.stations[id]||{}).tod};
  })()`);
  assert.equal(f3b.lv, 2, '实验站此时已开发到第 2 级');
  assert.ok(f3b.p <= 10 && f3b.p > 9, '2 → 3 级的临界客流应落在 10 年：' + JSON.stringify(f3b));
  // 0.5 倍：2 → 3 回不了本，应原地不动
  await E(`(()=>{const sd=CM.game.model.stDaily;sd.inn[${kk}]=${f3b.f * 0.5};sd.out[${kk}]=0;sd.xfer[${kk}]=0;CM.game.net.stations[${JSON.stringify(id)}].tod=2;CM.ui.rerenderPage();return true})()`);
  const stay = await E(`(()=>{const I=CM.ui.todInfo(${JSON.stringify(id)});return {pay3:I.pay(3),net3:I.net(3),pay2:I.pay(2)};})()`);
  assert.ok(stay.pay3 > 10, '2 → 3 级回本超过 10 年：' + JSON.stringify(stay));
  await until('!!document.querySelector(".tod-batch")');
  const stayBtn = await E('(()=>{const b=document.querySelectorAll(".tod-batch .btn")[1];return {dis:b.disabled,tip:b.getAttribute("data-tip")||""}})()');
  if (stayBtn.dis) assert.match(stayBtn.tip, /没有 10 年内回本的站台/, '回不了本时按钮要说明原因：' + stayBtn.tip);
  else await runProfit();
  assert.equal(await lvOf(), 2, '回不了本的升级不能做，站台应停在第 2 级');
  // 1.2 倍：回本 → 应升到 3
  await E(`(()=>{const sd=CM.game.model.stDaily;sd.inn[${kk}]=${f3b.f * 1.2};sd.out[${kk}]=0;sd.xfer[${kk}]=0;CM.game.net.stations[${JSON.stringify(id)}].tod=2;CM.ui.rerenderPage();return true})()`);
  await runProfit();
  assert.equal(await lvOf(), 3, '10 年内回本时应允许升到第 3 级');
  console.log('PASS 10 年回本边界（已开发站升级）');

  // ---------------- PASS 4 详情页「约 N 年回本」与筛选同一口径 ----------------
  // 回到未开发状态再读详情：已开发的等级显示「经营中」，不会写回本年数
  await E(`(()=>{CM.game.net.stations[${JSON.stringify(id)}].tod=0;CM.ui.rerenderPage();return true})()`);
  await until('!!document.querySelector(".tod-batch")');
  const detail = await E(`(()=>{
    const id=${JSON.stringify(id)},I=CM.ui.todInfo(id);
    const d=document.createElement('div');d.style.position='fixed';d.style.left='-9999px';
    d.appendChild(CM.ui.todBody(id,null));document.body.appendChild(d);
    const rows=[...d.querySelectorAll(".tod-lv")].map(r=>r.textContent);
    d.remove();
    return {pay2:I.pay(2),pay3:I.pay(3),rows:rows};
  })()`);
  assert.ok(detail.rows.length >= 3, '至少要能列到第 3 级：' + detail.rows.length);
  const m3 = /约 ([\d.]+) 年回本/.exec(detail.rows[2]);
  assert.ok(m3, '第 3 级要写出回本年数：' + detail.rows[2]);
  const shown = parseFloat(m3[1]);
  const want = detail.pay3 < 10 ? +detail.pay3.toFixed(1) : +detail.pay3.toFixed(0);
  assert.ok(Math.abs(shown - want) <= 0.11, '详情页的年限要等于 todInfo.pay（' + want + '，实际 ' + shown + '）');
  console.log('PASS 详情页回本年数与批量同源');

  // ---------------- PASS 5 英文界面：按钮与说明都要整句翻译 ----------------
  await E('CM.Settings.set("language","en");true');
  await E('CM.ui.rerenderPage();true');
  await until(`(()=>{const b=document.querySelectorAll(".tod-batch .btn")[1];return !!b&&/pay back within 10 years/.test(b.textContent)})()`, 20000);
  const en = await E(`(()=>{
    const btns=[...document.querySelectorAll(".tod-batch .btn")].map(x=>x.textContent);
    const ss=[...document.querySelectorAll(".tod-batch .tod-batch-s")].map(x=>x.textContent);
    return {btns:btns,desc:ss[0]||"",stat:ss[1]||"",statP:ss[2]||""};
  })()`);
  assert.match(en.btns[1], /pay back within 10 years/i, '英文按钮：' + en.btns[1]);
  assert.match(en.desc, /ten years|10 years/i, '英文说明段要提到 10 年：' + en.desc);
  assert.ok(!/[\u3400-\u9fff]/.test(en.btns.join('') + en.desc + en.stat + en.statP), '英文界面不应残留汉字：' + JSON.stringify(en));
  console.log('PASS 英文界面');

  // ---------------- PASS 6 窄屏：按钮与统计行不能撑破卡片 ----------------
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 2, mobile: true });
  await E('CM.ui.rerenderPage();true');
  await delay(600);
  const narrow = await E(`(()=>{
    const b=document.querySelector(".tod-batch");if(!b)return null;
    const btn=[...document.querySelectorAll(".tod-batch .btn")];
    const box=b.getBoundingClientRect();
    return {over:b.scrollWidth-b.clientWidth,
      out:btn.map(x=>Math.round(x.getBoundingClientRect().right-box.right)),
      vw:innerWidth};
  })()`);
  assert.ok(narrow, '窄屏下批量区块仍要存在');
  assert.ok(narrow.over <= 1, '批量区块内部不能横向溢出：' + JSON.stringify(narrow));
  assert.ok(narrow.out.every(v => v <= 1), '按钮不能伸出卡片：' + JSON.stringify(narrow));
  console.log('PASS 窄屏布局');

  assert.equal(errors.length, 0, 'Browser errors:\n' + errors.join('\n'));
  console.log('ALL PASS v5.2 10 年回本站台');
} finally {
  if (send) await Promise.race([send('Browser.close').catch(() => { }), delay(1500)]);
  if (ws) ws.close();
  edge.kill();
  server.closeAllConnections();
  await new Promise(r => server.close(r));
  await fs.rm(task, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
}
