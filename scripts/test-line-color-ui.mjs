// v4.2 回归：线路颜色可以直接填色号。
// 浏览器自带的取色面板只有 R/G/B，玩家拿到的色值（#F3D03E、rgb(110,91,168)）必须能在页面上直接输入。
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

const task = await fs.mkdtemp(path.join(os.tmpdir(), 'city-metro-v42ui-')), profile = path.join(task, 'profile');
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

  // ---------------- 1. 解析器：色号的多种写法 ----------------
  const parse = await E(`(()=>{const p=CM.UI.prototype.parseColorCode;
    return {
      hex: p('#F3D03E'), plain: p('F3D03E'), short: p('#f30'), alpha: p('#12345678'), rgba: p('#12345678'),
      rgb: p('rgb(110,91,168)'), rgbSpace: p('rgb(110 91 168)'), triple: p('110,91,168'),
      rgbaFn: p('rgba(255,0,0,0.5)'), full: p('＃Ｆ３Ｄ０３Ｅ'),
      bad: p('zzz'), over: p('rgb(300,0,0)'), empty: p(''), hashOnly: p('#'),
    }})()`);
  assert.equal(parse.hex, '#f3d03e', '#RRGGBB 原样识别');
  assert.equal(parse.plain, '#f3d03e', '不带 # 也识别');
  assert.equal(parse.short, '#ff3300', '#RGB 缩写展开');
  assert.equal(parse.alpha, '#123456', '#RRGGBBAA 取前六位');
  assert.equal(parse.rgb, '#6e5ba8', 'rgb() 写法');
  assert.equal(parse.rgbSpace, '#6e5ba8', '空格分隔的 rgb() 写法');
  assert.equal(parse.triple, '#6e5ba8', '直接三个数（取色面板里的 R/G/B）');
  assert.equal(parse.rgbaFn, '#ff0000', 'rgba() 取 RGB 部分');
  assert.equal(parse.full, '#f3d03e', '中文输入法的全角字符');
  for (const [k, v] of [['bad', parse.bad], ['over', parse.over], ['empty', parse.empty], ['hashOnly', parse.hashOnly]]) assert.equal(v, null, '无效写法返回 null：' + k);
  console.log('PASS 色号解析：#RRGGBB / #RGB / #RRGGBBAA / rgb() / 三个数 / 全角');

  // ---------------- 2. 线路详情：色号输入框就位，且不止十六进制 ----------------
  const lid = await E('Object.keys(CM.game.net.lines)[0]');
  const LID = JSON.stringify(lid);
  await E(`(()=>{CM.ui._tab=CM.ui._tab||{};CM.ui._tab.line='build';CM.ui.openPage('line',${LID},{root:true});return true})()`);
  await until('!!document.querySelector(".lc-hex")');
  const ui0 = await E('(()=>{const i=document.querySelector(".lc-hex");const r=i.getBoundingClientRect();return {ph:i.placeholder,w:Math.round(r.width),h:Math.round(r.height),tip:i.getAttribute("data-tip"),max:i.getAttribute("maxlength")}})()');
  assert.equal(ui0.ph, '#F3D03E', '占位符给出色号示例');
  assert.ok(ui0.w >= 90 && ui0.h >= 24, '输入框看得见也点得到：' + ui0.w + '×' + ui0.h);
  assert.match(ui0.tip, /色号/, '提示写明可以直接填色号');
  assert.ok(Number(ui0.max) >= 15, '长度够放 rgb(110,91,168)：' + ui0.max);

  // 打满 6 位立即生效（不按回车）
  const live = await E(`(()=>{const i=document.querySelector(".lc-hex");i.focus();i.value='#12ab34';
    i.dispatchEvent(new Event('input',{bubbles:true}));
    const box=i.closest('.lc-cur-box')||document, pv=box.querySelector('.lc-preview');
    return {n:document.querySelectorAll('.lc-hex').length,color:CM.game.net.lines[${LID}].color, cls:i.className, bg:pv.style.background, picker:box.querySelector('.lc-picker').value}})()`);
  assert.equal(live.color, '#12ab34', '打满 6 位立即改色，不必回车');
  assert.doesNotMatch(live.cls, /bad/, '合法色号不标红');
  assert.match(live.bg, /rgba?\(18, 171, 52/, '色块预览同步：' + live.bg + '（页面里的色号输入框 ' + live.n + ' 个）');
  assert.equal(live.picker, '#12ab34', '取色器也同步到同一个色号');

  // 回车同样生效，并把写法规范化
  const enter = await E(`(()=>{const i=document.querySelector(".lc-hex");i.focus();i.value='#ABC';
    i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
    return {color:CM.game.net.lines[${LID}].color, val:document.querySelector(".lc-hex").value}})()`);
  assert.equal(enter.color, '#aabbcc', '#RGB 缩写可用于改色');
  assert.equal(enter.val, '#aabbcc', '回车后规范成 #rrggbb');

  // 不带 # 的六位
  const noHash = await E(`(()=>{const i=document.querySelector(".lc-hex");i.focus();i.value='445566';
    i.dispatchEvent(new Event('input',{bubbles:true}));
    return CM.game.net.lines[${LID}].color})()`);
  assert.equal(noHash, '#445566', '不带 # 的六位也生效');

  // rgb()：玩家从设计稿抄来的写法
  const rgb = await E(`(()=>{const i=document.querySelector(".lc-hex");i.focus();i.value='rgb(110,91,168)';
    i.dispatchEvent(new Event('input',{bubbles:true}));
    return {color:CM.game.net.lines[${LID}].color, picker:document.querySelector(".lc-picker").value}})()`);
  assert.equal(rgb.color, '#6e5ba8', 'rgb(110,91,168) 可以上色');
  assert.equal(rgb.picker, '#6e5ba8', '取色器同步到同一个颜色');

  // 三个数字直接填
  const triple = await E(`(()=>{const i=document.querySelector(".lc-hex");i.value='0,98,155';
    i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
    return CM.game.net.lines[${LID}].color})()`);
  assert.equal(triple, '#00629b', '直接填三个数也生效');

  // 全角（中文输入法）
  const full = await E(`(()=>{const i=document.querySelector(".lc-hex");i.value='＃Ｆ３Ｄ０３Ｅ';
    i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
    return CM.game.net.lines[${LID}].color})()`);
  assert.equal(full, '#f3d03e', '全角色号也能识别');

  // 格式不对：不改色、标红、写明写法
  const bad = await E(`(()=>{const i=document.querySelector(".lc-hex");i.value='不是颜色';
    i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
    const n=document.querySelector('.lc-hex-note');
    return {color:CM.game.net.lines[${LID}].color, cls:i.className, note:n?n.className:'', txt:n?n.textContent:'', shown:n?getComputedStyle(n).display!=='none':false}})()`);
  assert.equal(bad.color, '#f3d03e', '无效色号不改动线路颜色');
  assert.match(bad.cls, /bad/, '无效色号标红');
  assert.match(bad.note, /on/, '下方显示写法说明');
  assert.equal(bad.shown, true, '说明文字真的可见');
  assert.match(bad.txt, /#F3D03E/, '说明里给出正确示例：' + bad.txt);
  await shot('v42-color-code');

  // ---------------- 3. 绘线工具条里的同一个控件 ----------------
  const tb = await E(`(()=>{const T=CM.ui.tools,n=CM.game.net;const lid=${LID};
    const st=Object.values(n.stations).find(s=>s.lines&&s.lines.indexOf(lid)>=0)||Object.values(n.stations)[0];
    T.tool='line';T.lineChoice=lid;T.chain=st&&st.id;CM.ui.renderToolOpts();
    const i=document.querySelector('.to-color .lc-hex');if(!i)return {ok:false};
    i.focus();i.value='#7b1fa2';i.dispatchEvent(new Event('input',{bubbles:true}));
    return {ok:true,color:CM.game.net.lines[lid].color,lab:i.getAttribute('aria-label')}})()`);
  assert.equal(tb.ok, true, '绘线工具条上也有色号输入');
  assert.equal(tb.color, '#7b1fa2', '工具条里填色号也能改整条线');
  assert.match(String(tb.lab), /色号/, '工具条输入框的可读标签写明色号');

  // ---------------- 4. 右键配色气泡 ----------------
  await E('CM.ui.closePanel&&CM.ui.closePanel(true);CM.ui.tools.tool="select";CM.ui.renderToolOpts();true');
  const quick = await E(`(()=>{const lid=${LID};CM.Quick.popColor(lid,document.body);
    const i=document.querySelector('.qpop-hex');if(!i)return {ok:false};
    i.focus();i.value='#00a0e9';i.dispatchEvent(new Event('input',{bubbles:true}));
    return {ok:true,color:CM.game.net.lines[lid].color,val:i.value,on:document.querySelectorAll('.qpop-colors .lc-sw.on').length}})()`);
  assert.equal(quick.ok, true, '右键配色气泡里也有色号输入');
  assert.equal(quick.color, '#00a0e9', '气泡里填色号立即改色');
  assert.equal(quick.val, '#00a0e9', '输入框保留并规范化色号');
  assert.equal(quick.on, 0, '自定义色号不残留旧的色块选中');

  // ---------------- 5. 英文界面 ----------------
  await E('CM.Settings.set("language","en");CM.I18n.apply("en");true');
  await E(`(()=>{CM.ui._tab=CM.ui._tab||{};CM.ui._tab.line='build';CM.ui.openPage('line',${LID},{root:true});return true})()`);
  await until('!!document.querySelector(".lc-hex")');
  const en = await E(`(()=>{const i=document.querySelector(".lc-hex");
    const lab=[...document.querySelectorAll('.lc-hexlab')].map(x=>x.textContent.trim());
    const sect=[...document.querySelectorAll('.sec-h')].map(x=>x.textContent.trim());
    const cn=[];const walk=document.createTreeWalker(document.querySelector('.lc-cur-box'),NodeFilter.SHOW_TEXT);
    for(let n;(n=walk.nextNode());)if(/[\\u4e00-\\u9fa5]/.test(n.nodeValue))cn.push(n.nodeValue.trim());
    return {lab:lab, sect:sect.filter(x=>/Line|Number/.test(x)), cn:cn, tip:i.getAttribute('data-tip')}})()`);
  assert.ok(en.lab.some(x => /Color code/.test(x)), '色号标签翻成 Color code：' + en.lab.join(','));
  assert.equal(en.cn.length, 0, '配色控件里没有残留汉字：' + en.cn.join(' / '));
  assert.doesNotMatch(String(en.tip), /[\u4e00-\u9fa5]/, '提示也是英文：' + en.tip);
  await shot('v42-color-code-en');
  await E('CM.Settings.set("language","zh-CN");CM.I18n.apply("zh-CN");true');

  if (errors.length) console.log('页面错误：', errors.slice(0, 4));
  console.log('ALL PASS v4.2 线路颜色：色号直接输入 / 打满即生效 / rgb() / 全角 / 无效提示 / 工具条与气泡同步 / 英文');
} finally {
  try { ws && ws.close(); } catch { }
  server.close(); edge.kill();
}
process.exit(0);
