'use strict';
// 列车采购与运营（v2.5）：玩家按车型与编组购买整列列车，分配给线路的各个运营交路（支线单独、环线分两个方向），
// 每个时段（早高峰、平峰、晚高峰、夜间）投入的列车数决定发车频率。智能调度只调度已有列车，不够时低运力运行并提示购买；
// 手动模式由玩家设定每个时段投入几列。新线与延长按最低服务水平随线配车（计入建设费）；列车可调往其他线路，出售按残值回收。
// 车型按城市与年代开放：各城市有代表性的真实车型（参数为游戏化的近似值），另有各城市通用的虚构车型
(function (CM) {
  const U = CM.U, CFG = CM.CFG, h = U.h;
  const F = CM.Fleet = {};
  const PN = ['早高峰', '平峰', '晚高峰', '夜间'];
  F.PERIODS = PN;
  // ---------------- 车型 ----------------
  // cap：每节定员（人）；price：每节价格（万元，1990 年价格、按本城造价水平折算，购买时再乘当年造价指数）；
  // ops：车厢公里运营成本系数（同一年代常见的车型约 1.0，新车型更省）；life：设计寿命（年，超龄后运营成本 ×1.25）；max：最长编组；kmh：最高速度（只作说明）；
  // look：外观（年代式样、车身、色带、车顶、窗；'line' 表示用线路色）；maps：只在这些城市出售（空为通用车型）
  const LOOK = {
    wood: { era: 'early', body: '#5a2e24', band: 'line', roof: '#3a3634', win: '#f4d9a2' },
    green: { era: 'early', body: '#355e3b', band: '#9b2335', roof: '#2e3033', win: '#f4d9a2' },
    classicLine: { era: 'classic', body: 'line', band: '#efe6cc', roof: '#4d5257', win: '#fff3d6' },
    steel: { era: 'modern', body: '#c4ccd4', band: 'line', roof: '#9aa3ad', win: '#ffffff' },
    white: { era: 'modern', body: '#eef0ee', band: 'line', roof: '#b8c0c8', win: '#ffffff' },
    paint: { era: 'current', body: 'line', band: '#26303b', roof: 'line', win: '#ffffff' },
    whiteNew: { era: 'current', body: '#f2f4f6', band: 'line', roof: '#d5dbe2', win: '#ffffff' },
    future: { era: 'future', body: '#f1f4f7', band: 'line', roof: '#e3e8ee', win: '#d8f2ff' },
  };
  const M = function (o) { return Object.assign({ maps: null, max: 8, life: 30, kmh: 80 }, o, { look: Object.assign({}, LOOK[o.look] || LOOK.steel, o.lookX || {}) }); };
  const MODELS = F.MODELS = [
    // 通用车型（虚构）：各城市都能买，按年代更替。
    // v5.0：t 是主力车型等级，一款一级（T1 最早、T6 最新），与上市年份顺序严格一致。
    M({ id: 'gen-early', t: 1, name: '早期木质电动车', short: '木质车', from: 1900, to: 1938, cap: 170, price: 110, ops: 1.05, life: 35, max: 6, kmh: 50, look: 'wood', desc: '木质车身、通风顶，车厢小、运营费用高' }),
    M({ id: 'gen-classic', t: 2, name: '战后钢制通勤车', short: '钢制车', from: 1936, to: 1974, cap: 220, price: 170, ops: 1.03, life: 32, max: 6, kmh: 70, look: 'classicLine', desc: '全钢车身、整车涂装' }),
    M({ id: 'gen-steel', t: 3, name: '不锈钢 B 型车', short: 'B 型车', from: 1968, to: 2015, cap: 250, price: 300, ops: 1, kmh: 80, look: 'steel', desc: '车宽 2.8 m 的标准地铁车' }),
    M({ id: 'gen-a', t: 4, name: '大运量 A 型车', short: 'A 型车', from: 1985, to: 9999, cap: 310, price: 420, ops: 0.96, kmh: 80, look: 'white', desc: '车宽 3 m、每节 5 对车门的大运量车' }),
    M({ id: 'gen-eco', t: 5, name: '节能变频车', short: '节能车', from: 2008, to: 9999, cap: 320, price: 460, ops: 0.85, kmh: 100, look: 'paint', desc: '永磁电机与再生制动，运营费用低' }),
    M({ id: 'gen-auto', t: 6, name: '全自动无人驾驶车', short: '无人驾驶车', from: 2025, to: 9999, cap: 320, price: 540, ops: 0.75, kmh: 120, look: 'future', desc: '无人驾驶、贯通客室，运营费用最低' }),
    // v3.0：D 型无人列车。固定 8 节编组、每节 500 人；运营成本为基准的 0.75 倍；最高 160 km/h，
    // 只能在 160 轨道上运行（only160）；2005 年起开放——160 轨道的开放年份也由它决定。
    M({ id: 'gen-d160', name: 'D 型无人列车', short: 'D 型车', from: 2005, to: 9999, cap: 500, price: 620, ops: 0.75, life: 35,
      max: 8, kmh: 160, look: 'future', lookX: { win: '#dff7ff' }, only160: true, fixedCars: 8,
      desc: '固定 8 节编组、每节 500 人的全自动无人列车，只能在 160 km/h 高速轨道上运行；运营成本为基准的 0.75 倍' }),
    // 广州
    M({ id: 'gz-a1', maps: ['gz'], name: '广州地铁 A1 型（西门子）', short: 'A1 型', from: 1995, to: 2004, cap: 310, price: 560, ops: 0.97, max: 6, look: 'white', desc: '1 号线引进车，白色车身配线路色带' }),
    M({ id: 'gz-l4', maps: ['gz'], name: '广州地铁直线电机 L4 型', short: 'L4 型', from: 2005, to: 2016, cap: 240, price: 420, ops: 0.93, max: 6, kmh: 90, look: 'paint', desc: '4、5 号线直线电机车，爬坡与过弯能力强' }),
    M({ id: 'gz-a8', maps: ['gz'], name: '广州地铁 A 型（国产 8 节）', short: '国产 A 型', from: 2010, to: 9999, cap: 310, price: 400, ops: 0.88, look: 'whiteNew', desc: '国产化 A 型车，可编 8 节' }),
    // 杭州
    M({ id: 'hz-b1', maps: ['hz'], name: '杭州地铁 B 型（1 号线）', short: '1 号线 B 型', from: 2010, to: 9999, cap: 250, price: 380, ops: 0.92, max: 6, look: 'whiteNew', desc: '杭州首批地铁车' }),
    M({ id: 'hz-a', maps: ['hz'], name: '杭州地铁 A 型', short: '杭州 A 型', from: 2017, to: 9999, cap: 310, price: 420, ops: 0.86, look: 'paint', desc: '后期线路的大运量车' }),
    // 武汉
    M({ id: 'wh-b1', maps: ['wh'], name: '武汉轨道交通 1 号线 B 型', short: '1 号线 B 型', from: 2003, to: 2014, cap: 250, price: 360, ops: 0.98, max: 6, look: 'steel', desc: '高架轻轨线的首批车辆' }),
    M({ id: 'wh-a', maps: ['wh'], name: '武汉地铁 A 型', short: '武汉 A 型', from: 2012, to: 9999, cap: 310, price: 410, ops: 0.88, look: 'whiteNew', desc: '大运量线路车型' }),
    // 香港
    M({ id: 'hk-m', maps: ['hk'], name: '港铁 M-Train（都城嘉慕）', short: 'M-Train', from: 1977, to: 1995, cap: 330, price: 520, ops: 1, life: 40, look: 'steel', lookX: { band: '#c8102e' }, desc: '修正早期系统的不锈钢车，红色色带' }),
    M({ id: 'hk-k', maps: ['hk'], name: '港铁 K-Stock（现代 Rotem）', short: 'K-Stock', from: 2001, to: 2012, cap: 330, price: 560, ops: 0.93, look: 'whiteNew', desc: '将军澳线与东涌线的新车' }),
    M({ id: 'hk-q', maps: ['hk'], name: '港铁 Q-Train（中车长客）', short: 'Q-Train', from: 2020, to: 9999, cap: 330, price: 520, ops: 0.84, look: 'paint', desc: '更新换代的新列车' }),
    // 台北
    M({ id: 'tp-c301', maps: ['tp'], name: '台北捷运 C301 型（川崎重工）', short: 'C301', from: 1994, to: 2004, cap: 290, price: 560, ops: 0.98, max: 6, look: 'steel', lookX: { band: '#1a5aa6' }, desc: '高运量系统首批车辆' }),
    M({ id: 'tp-c371', maps: ['tp'], name: '台北捷运 C371 型', short: 'C371', from: 2004, to: 2013, cap: 290, price: 520, ops: 0.92, max: 6, look: 'whiteNew', desc: '新庄线、芦洲线等的车辆' }),
    M({ id: 'tp-c381', maps: ['tp'], name: '台北捷运 C381 型', short: 'C381', from: 2012, to: 9999, cap: 290, price: 500, ops: 0.86, max: 6, look: 'paint', desc: '信义线、松山线的新车' }),
    // 巴黎
    M({ id: 'pa-m1', maps: ['pa'], name: '巴黎地铁 M1 木质车', short: 'M1', from: 1900, to: 1910, cap: 160, price: 100, ops: 1.05, life: 30, max: 6, kmh: 40, look: 'wood', desc: '1900 年开通时的木质车厢' }),
    M({ id: 'pa-st', maps: ['pa'], name: '巴黎地铁 Sprague-Thomson', short: 'Sprague', from: 1908, to: 1937, cap: 180, price: 120, ops: 1, life: 50, max: 6, kmh: 70, look: 'green', desc: '全钢车身，墨绿涂装，服役半个多世纪' }),
    M({ id: 'pa-mp59', maps: ['pa'], name: '巴黎地铁 MP 59（胶轮）', short: 'MP 59', from: 1956, to: 1966, cap: 210, price: 220, ops: 0.98, max: 6, look: 'classicLine', lookX: { body: '#2c5aa0', band: '#e9e5d6' }, desc: '胶轮车，加速快、噪声小' }),
    M({ id: 'pa-mf67', maps: ['pa'], name: '巴黎地铁 MF 67', short: 'MF 67', from: 1967, to: 1978, cap: 220, price: 220, ops: 0.97, max: 6, look: 'classicLine', lookX: { body: '#3c6fb4', band: '#f0eee6' }, desc: '钢轮车的大规模更新' }),
    M({ id: 'pa-mf77', maps: ['pa'], name: '巴黎地铁 MF 77', short: 'MF 77', from: 1978, to: 1990, cap: 230, price: 260, ops: 0.95, max: 6, look: 'white', desc: '白色车身，7、8、13 号线' }),
    M({ id: 'pa-mp89', maps: ['pa'], name: '巴黎地铁 MP 89（胶轮）', short: 'MP 89', from: 1995, to: 2007, cap: 230, price: 320, ops: 0.9, max: 6, look: 'whiteNew', desc: '贯通客室的胶轮车，14 号线无人驾驶' }),
    M({ id: 'pa-mf01', maps: ['pa'], name: '巴黎地铁 MF 01', short: 'MF 01', from: 2008, to: 2018, cap: 240, price: 340, ops: 0.86, max: 6, look: 'whiteNew', desc: '钢轮线路的新一代车' }),
    M({ id: 'pa-mp14', maps: ['pa'], name: '巴黎地铁 MP 14', short: 'MP 14', from: 2019, to: 9999, cap: 240, price: 380, ops: 0.78, max: 8, look: 'future', desc: '全自动运行的胶轮车' }),
    // 上海
    M({ id: 'sh-ac01', maps: ['sh'], name: '上海地铁 AC01 型（德国制造）', short: 'AC01', from: 1993, to: 1999, cap: 310, price: 600, ops: 0.98, look: 'white', lookX: { band: '#d52b1e' }, desc: '1 号线首批引进车' }),
    M({ id: 'sh-a', maps: ['sh'], name: '上海地铁 A 型（国产化）', short: '上海 A 型', from: 2003, to: 9999, cap: 310, price: 420, ops: 0.9, look: 'whiteNew', desc: '国产化后的大运量车' }),
    M({ id: 'sh-16', maps: ['sh'], name: '上海地铁 16 号线快车型', short: '16 号线快车', from: 2013, to: 9999, cap: 300, price: 480, ops: 0.9, kmh: 120, look: 'paint', desc: '最高 120 km/h 的郊区快线车' }),
    // 北京
    M({ id: 'bj-dk', maps: ['bj'], name: '北京地铁 DK 系列（长春客车厂）', short: 'DK 系列', from: 1969, to: 2000, cap: 240, price: 200, ops: 1, max: 6, look: 'classicLine', desc: '1 号线、环线的早期国产车' }),
    M({ id: 'bj-sfm04', maps: ['bj'], name: '北京地铁 SFM04 型', short: 'SFM04', from: 2002, to: 2008, cap: 250, price: 340, ops: 0.96, max: 6, look: 'steel', desc: '13 号线、八通线的不锈钢车' }),
    M({ id: 'bj-b', maps: ['bj'], name: '北京地铁 B 型（4 号线等）', short: '北京 B 型', from: 2008, to: 9999, cap: 250, price: 360, ops: 0.9, look: 'whiteNew', desc: '奥运前后新线的车型' }),
    M({ id: 'bj-a', maps: ['bj'], name: '北京地铁 A 型（6 号线、14 号线）', short: '北京 A 型', from: 2012, to: 9999, cap: 310, price: 420, ops: 0.88, look: 'paint', desc: '大运量干线车' }),
    // 东京
    M({ id: 'tk-1000', maps: ['tk'], name: '东京地下铁道 1000 形', short: '1000 形', from: 1927, to: 1938, cap: 170, price: 120, ops: 1, life: 40, max: 6, kmh: 50, look: 'classicLine', lookX: { era: 'early', body: '#f2b100', band: '#3a3634' }, desc: '银座线开通时的黄色车' }),
    M({ id: 'tk-300', maps: ['tk'], name: '营团 300 形（丸之内线）', short: '300 形', from: 1953, to: 1962, cap: 210, price: 200, ops: 1, max: 6, look: 'classicLine', lookX: { body: '#d13a33', band: '#f2f0e6' }, desc: '红色车身配白带' }),
    M({ id: 'tk-2000', maps: ['tk'], name: '营团 2000 形（银座线）', short: '2000 形', from: 1958, to: 1968, cap: 200, price: 190, ops: 1, max: 6, look: 'classicLine', lookX: { body: '#f5b301', band: '#5a4a2c' }, desc: '银座线的黄色车' }),
    M({ id: 'tk-5000', maps: ['tk'], name: '营团 5000 系（不锈钢）', short: '5000 系', from: 1964, to: 1981, cap: 250, price: 260, ops: 0.97, look: 'steel', desc: '东西线等的不锈钢车' }),
    M({ id: 'tk-01', maps: ['tk'], name: '营团 01 系', short: '01 系', from: 1983, to: 1997, cap: 220, price: 300, ops: 0.94, max: 6, look: 'steel', desc: '银座线的新一代车' }),
    M({ id: 'tk-05', maps: ['tk'], name: '营团 05 系', short: '05 系', from: 1988, to: 2004, cap: 250, price: 320, ops: 0.92, look: 'steel', desc: '东西线的铝合金车' }),
    M({ id: 'tk-10000', maps: ['tk'], name: '东京地铁 10000 系', short: '10000 系', from: 2006, to: 2016, cap: 250, price: 380, ops: 0.88, look: 'whiteNew', desc: '有乐町线、副都心线' }),
    M({ id: 'tk-n1000', maps: ['tk'], name: '东京地铁 1000 系（复古涂装）', short: '新 1000 系', from: 2012, to: 2017, cap: 220, price: 360, ops: 0.86, max: 6, look: 'paint', lookX: { body: '#f2b100', band: '#3a3634' }, desc: '银座线的复古黄色新车' }),
    M({ id: 'tk-13000', maps: ['tk'], name: '东京地铁 13000 系', short: '13000 系', from: 2016, to: 9999, cap: 250, price: 400, ops: 0.84, look: 'paint', desc: '日比谷线的新车' }),
  ];
  // 始终保留原文，交给共享翻译层显示，切换语言后可恢复且不改存档。
  F.nameOf = function (m) { return m.name; };
  F.shortOf = function (m) { return m.short; };
  F.descOf = function (m) { return m.desc; };
  const BY = new Map(MODELS.map(function (m) { return [m.id, m]; }));
  F.model = function (id) { return BY.get(id) || BY.get('gen-a'); };

  // ---------------- v3.7 车型科技树 ----------------
  // 单主干（通用车型按世代）+ 9 条城市支线 + 160 支线。节点只按年份点亮，运行时计算、不写存档。
  F.TRUNK = ['gen-early', 'gen-classic', 'gen-steel', 'gen-a', 'gen-eco', 'gen-auto'];
  F.CITY_BRANCH = {
    gz: ['gz-a1', 'gz-l4', 'gz-a8'],
    sh: ['sh-ac01', 'sh-a', 'sh-16'],
    bj: ['bj-dk', 'bj-sfm04', 'bj-b', 'bj-a'],
    hz: ['hz-b1', 'hz-a'],
    wh: ['wh-b1', 'wh-a'],
    hk: ['hk-m', 'hk-k', 'hk-q'],
    tp: ['tp-c301', 'tp-c371', 'tp-c381'],
    pa: ['pa-m1', 'pa-st', 'pa-mp59', 'pa-mf67', 'pa-mf77', 'pa-mp89', 'pa-mf01', 'pa-mp14'],
    tk: ['tk-1000', 'tk-300', 'tk-2000', 'tk-5000', 'tk-01', 'tk-05', 'tk-10000', 'tk-n1000', 'tk-13000'],
  };
  F.CITY_ORDER = ['gz', 'sh', 'bj', 'hz', 'wh', 'hk', 'tp', 'pa', 'tk'];
  F.BRANCH_160 = ['gen-d160'];
  // ---------------- v5.0 车型分级：主力 T1–T6，城市特色同尺定级 ----------------
  // 主力车型（主干）一款一级：T1 木质车 → T6 全自动无人驾驶车，等级与上市年份严格对应。
  // 城市特色车型用同一把尺子评定：按每节定员、运营成本与最高时速折算综合性能（0–2 分），
  // 落到综合性能最接近的主力档位——同一等级的城市特色车与主力车性能相当，可以直接横向比较。
  // D 型车是独立的 160 支线，不参与 T 级，等级显示为 D。
  F.TIER_N = 6;
  // 权重：定员 1.0（320 人/节满分）、运营成本 0.5（1.05 → 0.75 满分）、最高时速 0.5（120 km/h 满分）
  const tierScore = function (m) {
    const cap = Math.max(0, Math.min(1, (m.cap || 0) / 320));
    const ops = Math.max(0, Math.min(1, (1.05 - (m.ops == null ? 1.05 : m.ops)) / 0.30));
    const kmh = Math.max(0, Math.min(1, (m.kmh || 0) / 120));
    return cap + 0.5 * ops + 0.5 * kmh;
  };
  F.tierScore = tierScore;
  // 档位分界取相邻两款主力车型综合性能的中点：主力车型调整参数后，城市特色车的定级自动跟随同一标尺。
  const TIER_CUT = [];
  for (let i = 1; i < F.TRUNK.length; i++) TIER_CUT.push((tierScore(BY.get(F.TRUNK[i - 1])) + tierScore(BY.get(F.TRUNK[i]))) / 2);
  const tierCache = new WeakMap();
  F.tierOf = function (m) {
    if (!m || m.only160) return 0;             // D 型车独立，不参与 T 级
    if (m.t) return m.t;                       // 主力车型直接读写入的等级
    let t = tierCache.get(m);
    if (t) return t;
    const s = tierScore(m);
    t = 1;
    for (const c of TIER_CUT) if (s >= c) t++;
    tierCache.set(m, t);
    return t;
  };
  F.tierLabel = function (m) { return !m ? '—' : (m.only160 ? 'D' : 'T' + F.tierOf(m)); };
  F.tierKind = function (m) { return !m ? '' : (m.only160 ? 'd' : (F.isCity(m) ? 'city' : 'trunk')); };
  // 展示用短标签：主力 T4 / 城市 T3 / D 型专用（模板 {v0} 交给翻译层）
  F.tierChip = function (m) {
    if (!m) return '';
    if (m.only160) return 'D 型专用';
    return F.tierLabel(m) + ' ' + (F.isCity(m) ? '城市' : '主力');
  };
  // ---------------- v4.4 车型归属与统一选用规则 ----------------
  // 科技树分三层：主干（主力 T1–T6）、160 支线（D 型）、城市支线（城市特色车型）。
  // 自动选用——新线随线配车、购车弹窗的默认选中、科技树升级目标、自动配置买车——只认主力与 D 型车；
  // 城市特色车型只能由玩家在购车弹窗里手动购买、手动调入，任何自动流程都不得代为添加或购买。
  // 所有判断都走这里，避免各功能各写一套规则。
  F.isCity = function (m) { return !!(m && m.maps && m.maps.length > 0); };
  F.isTrunk = function (m) { return !!m && F.TRUNK.indexOf(m.id) >= 0; };
  F.is160Model = function (m) { return !!m && !!m.only160; };
  // 玩家买过的车型（随存档保存）：城市特色车型的「已购置」状态由它判断。
  // 旧存档没有这个字段时，F.ensure 按现有列车补记；主干与 160 支线不受购置限制。
  F.markOwned = function (g, id) {
    const fl = g && g.fleet; if (!fl || !id) return;
    if (!Array.isArray(fl.owned)) fl.owned = [];
    if (fl.owned.indexOf(id) < 0) fl.owned.push(id);
  };
  F.ownsModel = function (g, m) {
    const id = typeof m === 'string' ? m : (m && m.id);
    if (!id) return false;
    const mdl = BY.get(id);
    if (mdl && (F.isTrunk(mdl) || F.is160Model(mdl))) return true;
    const fl = g && g.fleet; if (!fl) return false;
    if (Array.isArray(fl.owned) && fl.owned.indexOf(id) >= 0) return true;
    return !!(fl.trains && fl.trains.some(function (t) { return t.model === id; }));
  };
  // 自动选用的车型：只取主干；160 轨道取 160 支线的 D 型车。
  // 返回 null 表示当年主干科技树还没有能跑这条线的车型（例如 120 km/h 只有城市特色车型能跑），
  // 这时不自动配车、也不自动买车，交给玩家手动选购。
  F.trunkModel = function (mapId, y, need) {
    need = need || 0;
    if (need >= 160) { const d = BY.get(F.dModelId); return d && y >= d.from && y <= d.to && (!d.maps || d.maps.indexOf(mapId) >= 0) ? d : null; }
    const all = F.TRUNK.map(function (id) { return BY.get(id); }).filter(function (m) {
      return m && y >= m.from && y <= m.to && (!m.maps || m.maps.indexOf(mapId) >= 0);
    });
    const fast = all.filter(function (m) { return m.kmh >= need; });
    fast.sort(function (a, b) { return (b.from - a.from) || (b.cap - a.cap); });
    return fast[0] || null;
  };
  // 系统能否自动「启用 / 选中 / 参与自动配置」这个车型：
  //   v5.0：只认主力 T 级车型与 D 型车。城市特色车型一律不参与任何自动流程，
  //   即使玩家已经买过（g.fleet.owned 或车队里有）也只能手动调入。
  //   购车弹窗是「购置」入口，不受此限制，但默认选中永远落在主力车型上。
  F.canAutoPick = function (g, m) {
    if (!m) return false;
    return F.isTrunk(m) || F.is160Model(m);
  };
  F.isCityTrain = function (t) { return F.isCity(F.model(t.model)); };
  // v5.0：旧款主力车型与城市特色车型都可以补差价升级为当前主力车型（160 轨道为 D 型车）。
  // 城市特色车型不再走「只能同车型扩编」的旧规则；升级沿用 techQuote / upgradeTech 的残值抵扣口径。
  // 所有升级过滤都调这一个函数，避免各功能各写一套。
  F.canTechUpgrade = function (t) { return !!t; };
  // 地图 → 城市支线：经典广州图与教程图没有城市专属车型，归到各自的主线城市（只影响科技树的展示）
  F.cityOfMap = function (mapId) {
    if (mapId === 'gz1990') return 'gz';
    if (mapId === 'tutorial') return null;
    return F.CITY_BRANCH[mapId] ? mapId : null;
  };
  // 运行时节点序号：先按上市年，再按「支线/160 支线」区分同年车型；只用于显示顺序与升级比较，不写存档
  F.rank = function (m) {
    if (!m) return 0;
    if (m.only160) return 900000 + m.from;
    if (m.maps && m.maps.length) {
      const b = F.CITY_BRANCH[m.maps[0]] || [], i = b.indexOf(m.id);
      return 500000 + (i < 0 ? 0 : i) * 1000 + (m.from % 1000);
    }
    const t = F.TRUNK.indexOf(m.id);
    return 100000 + (t < 0 ? 0 : t) * 1000 + (m.from % 1000);
  };
  // 科技树节点（按年份点亮）。lit：已到开放年；sale：当年在售；retired：已停售；active：本城当前最新
  F.treeNodes = function (mapId, y, city) {
    const mk = function (id, kind) {
      const m = BY.get(id); if (!m) return null;
      const own = !m.maps || m.maps.indexOf(mapId) >= 0;
      return { id: m.id, m: m, kind: kind, from: m.from, lit: y >= m.from, sale: y >= m.from && y <= m.to && own,
        retired: y > m.to, own: own, active: false, rank: F.rank(m),
        tier: F.tierOf(m), tierLabel: F.tierLabel(m), tierKind: F.tierKind(m) };
    };
    const trunk = F.TRUNK.map(function (id) { return mk(id, 'trunk'); }).filter(Boolean);
    const key = city || F.cityOfMap(mapId);
    const branch = key ? (F.CITY_BRANCH[key] || []).map(function (id) { return mk(id, 'city'); }).filter(Boolean) : [];
    const d160 = F.BRANCH_160.map(function (id) { return mk(id, '160'); }).filter(Boolean);
    return { city: key, trunk: trunk, branch: branch, d160: d160 };
  };
  // 本线科技树升级的目标车型（v5.0）：只取主力（160 轨道取 160 支线的 D 型车），
  // 城市特色车型本身不是升级目标——它们会被升级成当前主力车型。
  // 返回 null 表示当年主力没有能跑这条线的车型。
  F.latestModel = function (g, lid) {
    const y = g && g.clock ? g.clock.y : CFG.START.y;
    const kmh = lid && g.net.lines[lid] ? CM.Metro.lineKmh(g.net.lines[lid]) : 80;
    return F.trunkModel(g.mapId, y, kmh);
  };
  F.cityLabel = function (id) {
    const mp = CM.MAPS && CM.MAPS[id];
    return (mp && (mp.data && mp.data.city || mp.name)) || id;
  };
  // 本城当年可以买的车型（本城真实车型在前）
  F.available = function (mapId, y) {
    return MODELS.filter(function (m) { return y >= m.from && y <= m.to && (!m.maps || m.maps.indexOf(mapId) >= 0); }).sort(function (a, b) { return (a.maps ? 0 : 1) - (b.maps ? 0 : 1) || b.from - a.from; });
  };
  // 本城以后才开放的车型（按开放年份，同年本城车型在前）：购车界面与车队总览提前展示
  F.upcoming = function (mapId, y) {
    return MODELS.filter(function (m) { return m.from > y && (!m.maps || m.maps.indexOf(mapId) >= 0); }).sort(function (a, b) { return a.from - b.from || (a.maps ? 0 : 1) - (b.maps ? 0 : 1); });
  };
  // v3.1：160 专用车型（D 型无人列车）只能跑 160 轨道——只有这条线路是 160 时才出现在购车列表里；
  // 车辆段（买来先闲置）要等全网有了 160 线路才卖，免得买回来没处跑
  F.has160 = function (g) {
    const lines = (g && g.net && g.net.lines) || {};
    for (const k in lines) if (CM.Metro.lineKmh(lines[k]) >= 160) return true;
    return false;
  };
  // v4.6 统一准入：某车型能否在这条轨道上线（只判轨道类型，不判谁更快）。
  // 160 高速轨道仍按 v3.0 只给 D 型专用列车；普通轨道不再按「车型比线路慢」拦人，
  // 慢车买回来照样上线，只是整条交路按 min(轨道限速, 车型限速) 降速运行。
  F.lineFit = function (m, kmh) {
    if (!m) return false;
    if (m.only160) return kmh >= 160;
    return kmh < 160;
  };
  F.fitModel = function (g, lid, m) {
    const kmh = lid ? CM.Metro.lineKmh(g.net.lines[lid]) : 0;
    if (!lid) return !m.only160 || F.has160(g);   // 车辆段：全网有 160 线路才卖 D 型车
    return F.lineFit(m, kmh);
  };
  // v3.3：全自动无人驾驶车（gen-auto）上市后进入「无人驾驶时代」——除 160 专用的 D 型无人列车外，
  // 其余车型一律停售，玩家只能买全自动无人驾驶车。车型是否可买只看上市年份与该城市是否有售。
  F.autoModelId = 'gen-auto';
  F.autoOn = function (mapId, y) {
    const m = BY.get(F.autoModelId);
    return !!m && y >= m.from && y <= m.to && (!m.maps || m.maps.indexOf(mapId) >= 0);
  };
  F.autoUnlocked = function (g) { return !!g && F.autoOn(g.mapId, g.clock.y); };
  F.autoOnly = function (m) { return !!m && (m.id === F.autoModelId || !!m.only160); };
  // 某条线路（lid 为空时：车辆段）在当年能买、以及以后才开放的车型。
  // defaultModel：购车弹窗默认选中的车型——只取主干（160 线路取 D 型车），绝不默认城市特色车型。
  F.buyList = function (g, lid) {
    const ok = function (m) { return F.fitModel(g, lid, m); };
    let list = F.available(g.mapId, g.clock.y).filter(ok), soon = F.upcoming(g.mapId, g.clock.y).filter(ok);
    const forced = F.autoUnlocked(g);
    // 无人驾驶时代：只保留全自动无人驾驶车与 D 型无人列车，其余车型（含「即将开放」）不再出现
    if (forced) { list = list.filter(F.autoOnly); soon = soon.filter(F.autoOnly); }
    // 默认选中与「随线配车 / 自动配置」共用同一个 F.recommend（只取主干；160 线路取 D 型车）
    const need = lid && g.net.lines[lid] ? CM.Metro.lineKmh(g.net.lines[lid]) : 0;
    const pick = F.recommend(g.mapId, g.clock.y, need);
    const def = (pick && list.indexOf(pick) >= 0 ? pick : null) || list.filter(function (m) { return !F.isCity(m); })[0] || list[0] || null;
    return { list: list, soon: soon, forced: forced, defaultModel: def };
  };
  // 推荐车型（随线配车、智能分配补车用）：只从主干里选（160 线路取 D 型车）。
  // 城市特色车型只能由玩家手动选购，绝不作为新线默认车型；need 高于主干现有车型时返回 null。
  // need：线路运行速度超过 80 km/h 时，车型的最高速度不能低于它（v2.5）；160 专用车只在 160 线路上推荐
  F.recommend = function (mapId, y, need) { return F.trunkModel(mapId, y, need); };
  // 线路运行速度能否选用：80 km/h 及以下不限车型；更高的速度要当年买得到足够快的车型，否则给出最早开放的年份
  F.speedOpen = function (mapId, y, kmh) {
    if (kmh <= 80 || F.available(mapId, y).some(function (m) { return m.kmh >= kmh; })) return { ok: true };
    const later = F.upcoming(mapId, y).filter(function (m) { return m.kmh >= kmh; });
    return { ok: false, year: later.length ? later[0].from : null };
  };
  // 列车能否在这条路线上运行：只检查编组是否放得下与 160 专用车的轨道限制。
  // v4.6：轨道速度高于车型限速时列车照常上线，实际运行速度取 min(轨道限速, 车型限速)（见 F.routeCapKmh / M.applyTiming）；
  // 「不够快」不再拦人，只作为线路运营页的信息提示。
  const tooSlow = function (t, rt) { return !F.lineFit(F.model(t.model), rt.kmh); };
  // 车型是否比线路设计速度慢（只用于提示，不影响能否上线）
  F.slowerThanLine = function (g, lid, m) {
    const kmh = lid ? CM.Metro.lineKmh(g.net.lines[lid]) : 0;
    return kmh > 80 && m.kmh < kmh;
  };
  // 某年代的车型：只用于开局既有线路与旧存档的「历史车队」（不是新建线路的默认车型）。
  // 这里保留本城真实车型（含城市特色车型），因为它们是被玩家接管的历史资产，不参与自动选用规则。
  // v3.3：无人驾驶时代统一用全自动无人驾驶车（与购买列表一致）
  F.eraModel = function (mapId, y) {
    if (F.autoOn(mapId, y)) return BY.get(F.autoModelId);
    const a = F.available(mapId, y).filter(function (m) { return !m.only160; }); if (a.length) return a[0];
    const own = MODELS.filter(function (m) { return (!m.maps || m.maps.indexOf(mapId) >= 0) && m.from <= y; }).sort(function (a, b) { return b.from - a.from; });
    return own[0] || BY.get('gen-early');
  };
  // 价格：每节价格 × 节数 × 本城造价水平 × 当年造价指数
  const scale = function () { return (CFG.cost.station.underground.M || 25000) / 25000; };
  // 购置列车属于建设支出，但难度减免只覆盖「轨道与站台」，车辆不在其中
  // v3.0：列车购买费也受难度系数影响（0.1–3 倍）
  F.price = function (g, m, cars, y) { return m.price * cars * scale() * g.econ.costIndex(y || g.clock.y) * (CM.Difficulty ? CM.Difficulty.trainMul(g.econ.difficulty) : 1); };
  const ageY = function (g, t) { return Math.max(0, (g.ym() - (t.bought || g.ym())) / 12); };
  F.age = ageY;
  // 残值：买价的 75% 起，按设计寿命直线折旧，最低 8%（买了马上卖也要损失约四分之一）
  F.residual = function (g, t) { const m = F.model(t.model); return (t.cost || 0) * Math.max(0.08, 0.75 * (1 - ageY(g, t) / m.life)); };
  F.opsF = function (g, t) { const m = F.model(t.model); return m.ops * (ageY(g, t) > m.life ? 1.25 : 1); };
  F.capOf = function (t) { return F.model(t.model).cap * t.cars; };

  // ---------------- 交路（线路的运营方向）与车队计划 ----------------
  // 普通线路与支线：每条路线一个全程交路（以终点站标识）；环线：顺行 cw、逆行 ccw 两个交路；玩家加开的交路以 v 开头（环线另带方向）
  F.svcId = function (rt, d) { if (rt.svc) return rt.loop ? rt.svc + (d ? ':ccw' : ':cw') : rt.svc; return rt.loop ? (d ? 'ccw' : 'cw') : rt.stIds[rt.stIds.length - 1]; };
  F.svcName = function (rt, d) { return rt.loop ? rt.label + (d ? '（逆行）' : '（顺行）') : rt.label; };
  const routesOfLine = function (C) { const m = new Map(); C.routes.forEach(function (rt, r) { let a = m.get(rt.lineId); if (!a) m.set(rt.lineId, a = []); a.push(r); }); return m; };
  // 列车所在的交路：环线按方向；其他按终点站，终点改了（延长）就找经过原终点的路线，再找不到视为失去交路，退回车辆段
  const placeOf = function (C, rs, t) {
    const r0 = C.routes[rs[0]];
    // 加开的交路：交路已取消时列车回到本线的全程交路
    if (t.svc && /^v\d/.test(t.svc)) {
      const key = t.svc.split(':')[0];
      for (const r of rs) if (C.routes[r].svc === key) return { r: r, d: t.svc.slice(-3) === 'ccw' ? 1 : 0 };
      return { r: rs[0], d: 0 };
    }
    if (r0.loop) return { r: rs[0], d: t.svc === 'ccw' ? 1 : 0 };
    if (t.svc) {
      for (const r of rs) { const s = C.routes[r].stIds; if (!C.routes[r].svc && s[s.length - 1] === t.svc) return { r: r, d: 0 }; }
      for (const r of rs) if (!C.routes[r].svc && C.routes[r].stIds.indexOf(t.svc) >= 0) return { r: r, d: 0 };
      // v4.8：终点站被停用后折返点前移到上一个可停靠站——原来以该站为终点的列车自动归到这条全程交路，
      // 不会因为站名从路线站点表里消失就被退回车辆段。
      for (const r of rs) { const rt = C.routes[r]; if (!rt.svc && rt.closedEnds && rt.closedEnds.indexOf(t.svc) >= 0) return { r: r, d: 0 }; }
      return null;
    }
    return { r: rs[0], d: 0 };
  };
  // 最低服务水平所需的列车（早高峰）：按周转时间
  F.floorNeed = function (rt) { return Math.max(1, Math.ceil(CM.Model.serviceFloor(rt, 0) * rt.cycleSec / 3600 - 1e-6)); };
  // v4.6：编译路线的实际运行速度上限 = min(轨道设计速度, 本路线配属列车里最慢车型的限速)。
  // 慢车可以上线，但列车永远不能超过自己车型的限速；降速通过 M.timing 重算区间用时与周转。
  F.routeCapKmh = function (rt, fp) {
    let cap = rt.kmh;
    if (fp) for (let d = 0; d < 2; d++) for (const u of fp.units[d]) if (u.m && u.m.kmh > 0 && u.m.kmh < cap) cap = u.m.kmh;
    return cap;
  };
  // 时刻表变了以后，最短路图里每条乘车区间边的旅行时间要跟着变（buildMetro 建图时用的是当时的区间用时）
  F.syncRideTimes = function (net) {
    if (!net || !net.rideEdge || !net.eT0 || !net.C) return;
    const dw = CM.CFG.metro.dwell / 60;
    for (let r = 0; r < net.C.routes.length; r++) {
      const rt = net.C.routes[r], re = net.rideEdge[r]; if (!re) continue;
      for (let k = 0; k * 2 + 1 < re.length && k < rt.legSec.length; k++) {
        const t = rt.legSec[k] / 60 + dw;
        net.eT0[re[2 * k]] = t; net.eT0[re[2 * k + 1]] = t;
      }
    }
  };
  const cache = new WeakMap();
  // 线网 net 各路线的车队计划：avail 各方向可用列车数，cap / cars / opsF 平均定员、编组与成本系数，units 各方向的列车（画面用），
  // manual 手动模式各方向各时段投入数，blocked 编组超过站台长度、不能上线的列车数。草案线网（预测）按随线配车补足最低需要
  F.plan = function (g, net) {
    const fl = g.fleet; if (!fl || !net || !net.C) return null;
    const hit = cache.get(net); if (hit && hit.ver === fl.ver && hit.ym === g.ym()) return hit.plan;
    const C = net.C, draft = C.net !== g.net, byLine = routesOfLine(C), y = g.clock.y;
    const plan = C.routes.map(function (rt) { return { avail: [0, 0], units: [[], []], cap: rt.cap, cars: rt.cars, opsF: rt.opsK || 1, manual: null, blocked: 0, slow: 0, runKmh: rt.kmh, floor: 0 }; });
    for (const t of fl.trains) {
      if (!t.line) continue; const rs = byLine.get(t.line); if (!rs) continue;
      const pos = placeOf(C, rs, t); if (!pos) continue;
      const rt = C.routes[pos.r], fp = plan[pos.r];
      if (t.cars > rt.cars) { fp.blocked++; continue; }
      const m = F.model(t.model);
      if (!F.lineFit(m, rt.kmh)) { fp.blocked++; continue; }        // 160 轨道专属 / D 型车不能跑普通线
      if (rt.kmh > 80 && m.kmh < rt.kmh) fp.slow++;                 // v4.6：慢车照常上线，只是按车型限速降速运行
      fp.units[pos.d].push({ id: t.id, m: m, cars: t.cars, cap: F.capOf(t), ops: F.opsF(g, t) });
    }
    // v4.6：先按配属车型统一复核每条路线的实际速度上限与时刻表，再算投入列车与最低需要
    C.routes.forEach(function (rt, r) {
      const cap = F.routeCapKmh(rt, plan[r]);
      plan[r].runKmh = cap;
      CM.Metro.applyTiming(rt, cap);
    });
    // 草案线网（C-only）没有 rideEdge，正式线网可能由另一个 F.plan 入口抢先改过时刻表；
    // 这里无条件按当前 legSec 复核，保证最短路图里的区间旅行时间与实际运行速度始终一致
    F.syncRideTimes(net);
    C.routes.forEach(function (rt, r) { plan[r].floor = F.floorNeed(rt); });
    C.routes.forEach(function (rt, r) {
      const fp = plan[r], nd = rt.loop ? 2 : 1;
      let n = 0, cap = 0, cars = 0, ops = 0;
      for (let d = 0; d < nd; d++) {
        fp.units[d].sort(function (a, b) { return b.cap - a.cap; });
        fp.avail[d] = fp.units[d].length;
        for (const u of fp.units[d]) { n++; cap += u.cap; cars += u.cars; ops += u.ops; }
      }
      if (nd === 1) { fp.avail[1] = fp.avail[0]; fp.units[1] = fp.units[0]; }
      if (draft && !rt.svc) {   // 预测：随线配车会把全程交路的列车补到最低需要（只按主干车型）；加开的交路由玩家配车
        const m = F.recommend(g.mapId, y, rt.kmh);
        if (m) {
          const c = Math.min(rt.cars, m.max);
          for (let d = 0; d < nd; d++) { const add = Math.max(0, fp.floor - fp.avail[d]); fp.avail[d] += add; n += add; cap += add * m.cap * c; cars += add * c; ops += add * m.ops; }
          if (nd === 1) fp.avail[1] = fp.avail[0];
        }
      }
      if (n) { fp.cap = cap / n; fp.cars = cars / n; fp.opsF = ops / n * (rt.opsK || 1); }
      const o = fl.ops[rt.lineId];
      if (o && o.mode === 'manual') {
        fp.manual = [0, 1].map(function (d) { const s = o.n && o.n[F.svcId(rt, rt.loop ? d : 0)]; return [0, 1, 2, 3].map(function (p) { return s && s[p] != null ? Math.min(s[p], fp.avail[d]) : fp.avail[d]; }); });
      }
    });
    cache.set(net, { ver: fl.ver, ym: g.ym(), plan: plan });
    return plan;
  };
  // 车队变化：版本加一、模拟立即按新的列车数重算频率与费用、界面刷新
  const changed = function (g) { g.fleet.ver++; g.model.applyFleet(); g.touch(); g.emit('fleet'); };
  F.changed = changed;
  const newTrain = function (g, mdl, cars, cost, line, svc, bought) {
    const fl = g.fleet, t = { id: 'T' + (fl.seq++), model: mdl.id, cars: cars, bought: bought == null ? g.ym() : bought, cost: Math.round(cost), line: line || null, svc: svc || null };
    fl.trains.push(t); F.markOwned(g, mdl.id); return t;
  };

  // ---------------- 建立车队（新局开局的既有线路、旧存档） ----------------
  // 按当前各时段实际发车所需的列车再留一成备用（至少 1 列），车型取线路开通年代的车型，视为已有资产（不扣钱）
  F.ensure = function (g) {
    if (!g || g.preview) return;
    const bootstrap = !g.fleet;
    if (bootstrap) {
      g.fleet = { v: 1, ver: 1, seq: 1, trains: [], ops: {}, note: {}, autoAlloc: false, autoConfig: false, owned: [] };
      const net = g.model.net, C = net && net.C, res = g.model.results || g.model.ctxs;
      if (C) C.routes.forEach(function (rt, r) {
        const built = (CM.Agents && CM.Agents.lineBuiltYear(g.net, rt.lineId)) || CFG.START.y, by = Math.max(built, g.clock.y - 25), m0 = g.net.lines[rt.lineId] && g.net.lines[rt.lineId].model0, mdl = (m0 && MODELS.find(function (x) { return x.id === m0; })) || F.eraModel(g.mapId, by), cars = Math.min(rt.cars, mdl.max);
        for (let d = 0; d < (rt.loop ? 2 : 1); d++) {
          let f = 0; for (const dt of ['wd', 'we']) for (const P of res[dt].per) if (P && P.freq && P.freq.length === C.routes.length) f = Math.max(f, P.freqDir && P.freqDir.length === 2 * C.routes.length ? P.freqDir[2 * r + d] : P.freq[r]);
          const need = Math.max(F.floorNeed(rt), Math.ceil(f * rt.cycleSec / 3600 - 1e-6)), n = need + Math.max(1, Math.round(need * 0.1));
          for (let i = 0; i < n; i++) newTrain(g, mdl, cars, F.price(g, mdl, cars, by), rt.lineId, F.svcId(rt, d), U.ymIndex(by, 1));
        }
      });
    }
    const beforeSync = g.fleet.ver;
    // v4.4：旧存档没有 owned 字段——按现有列车补记，城市特色车型的「已购置」状态不会丢
    if (!Array.isArray(g.fleet.owned)) g.fleet.owned = [];
    for (const t of g.fleet.trains) F.markOwned(g, t.model);
    if (g.fleet.autoConfig == null) g.fleet.autoConfig = false;
    if (g.fleet.autoAlloc == null) g.fleet.autoAlloc = false;
    F.sync(g);
    g.model.fleetSource = function (net) { return F.plan(g, net); };
    if (bootstrap || g.fleet.ver !== beforeSync) g.model.applyFleet();
  };
  // 拆除线路后车队整理：线路已不存在的列车回到车辆段
  F.sync = function (g) {
    const fl = g.fleet; if (!fl) return 0; let n = 0, remapped = false;
    const C = g.compiled, byLine = routesOfLine(C);
    for (const t of fl.trains) {
      if (!t.line) continue;
      const rs = byLine.get(t.line), pos = rs && placeOf(C, rs, t);
      if (!g.net.lines[t.line] || !pos) { t.line = null; t.svc = null; n++; continue; }
      const svc = F.svcId(C.routes[pos.r], pos.d);
      if (svc !== t.svc) {
        const o = fl.ops[t.line];
        if (o && o.n && o.n[t.svc] && !o.n[svc]) o.n[svc] = o.n[t.svc].slice();
        t.svc = svc; remapped = true;
      }
    }
    for (const lid in fl.ops) if (!g.net.lines[lid]) delete fl.ops[lid];
    if (n || remapped) fl.ver++;
    if (n) g.logEvent({ tag: '运营', title: n + ' 列列车回到车辆段', desc: '线路调整后没有归属的列车停入车辆段，可以调往其他线路或出售。' });
    return n;
  };

  // ---------------- 随线配车（草案） ----------------
  // 新线与延长后，各交路的列车补到早高峰最低服务水平所需：先用车辆段闲置（及因拆除、贯通而空出）的列车，不够再按推荐车型购买，费用计入建设
  F.draftExtra = function (g, ev) {
    const fl = g.fleet; if (!fl || !g.draft || !ev) return;
    const C = g.draftCompiled(); if (!C) return;
    const byLine = routesOfLine(C), y = g.clock.y, have = C.routes.map(function () { return [0, 0]; });
    const idle = [], onSvc = new Set();   // onSvc：有列车跑在加开交路上的线路，全程交路可以不配车
    for (const t of fl.trains) {
      const rs = t.line && byLine.get(t.line);
      if (!rs) { idle.push(t); continue; }
      const pos = placeOf(C, rs, t); if (!pos) { idle.push(t); continue; }
      const rt = C.routes[pos.r];
      if (t.cars <= rt.cars && !tooSlow(t, rt)) { have[pos.r][pos.d]++; if (rt.svc) onSvc.add(t.line); }
    }
    const adds = []; let total = 0;
    C.routes.forEach(function (rt, r) {
      if (rt.svc || onSvc.has(rt.lineId)) return;   // 随线配车只补全程交路
      const mdl = F.recommend(g.mapId, y, rt.kmh);
      if (!mdl) return;   // v4.4：主干没有能跑这条速度的车型时不随线配车，由玩家手动选购车型
      for (let d = 0; d < (rt.loop ? 2 : 1); d++) {
        let short = F.floorNeed(rt) - have[r][d]; if (short <= 0) continue;
        const use = [];
        for (let i = idle.length - 1; i >= 0 && short > 0; i--) if (idle[i].cars <= rt.cars && !tooSlow(idle[i], rt)) { use.push(idle[i].id); idle.splice(i, 1); short--; }
        const cars = Math.min(rt.cars, mdl.max), cost = short > 0 ? F.price(g, mdl, cars, y) * short : 0;
        adds.push({ line: rt.lineId, svc: F.svcId(rt, d), name: F.svcName(rt, d), use: use, buy: short, model: mdl.id, cars: cars, cost: cost });
        total += cost;
      }
    });
    ev.fleetAdd = adds;
    for (const a of adds) {
      if (a.cost > 0.5) { ev.items.push({ kind: 'construction', label: '随线配属列车 · ' + a.name + '：' + a.buy + ' 列（' + F.model(a.model).short + ' ' + a.cars + ' 节）', amount: a.cost, ref: a.line }); }
      if (a.use.length) ev.notes = (ev.notes || []).concat(['调用闲置列车 ' + a.use.length + ' 列给 ' + a.name]);
    }
    ev.total += total; ev.byKind.construction += total;
  };
  F.applyAdd = function (g, adds) {
    if (!g.fleet || !adds) return;
    for (const a of adds) {
      for (const id of a.use) { const t = g.fleet.trains.find(function (x) { return x.id === id; }); if (t) { t.line = a.line; t.svc = a.svc; } }
      const m = F.model(a.model), each = a.buy > 0 ? a.cost / a.buy : 0;
      for (let i = 0; i < a.buy; i++) newTrain(g, m, a.cars, each, a.line, a.svc);
    }
  };

  // ---------------- 玩家操作 ----------------
  F.buy = function (g, lid, svc, modelId, cars, n) {
    const m = F.model(modelId), y = g.clock.y;
    // v3.3：无人驾驶时代只卖全自动无人驾驶车（D 型无人列车是 160 专用，仍可买）
    if (F.autoUnlocked(g) && !F.autoOnly(m)) return { error: '全自动无人驾驶车已上市，' + F.nameOf(m) + ' 已停售' };
    if (y < m.from || y > m.to || (m.maps && m.maps.indexOf(g.mapId) < 0)) return { error: F.nameOf(m) + ' 现在买不到' };
    if (m.fixedCars && cars !== m.fixedCars) return { error: F.shortOf(m) + ' 是固定 ' + m.fixedCars + ' 节编组' };
    if (cars > m.max) return { error: F.shortOf(m) + ' 最长 ' + m.max + ' 节' };
    const cost = F.price(g, m, cars, y) * n;
    if (!g.econ.isFree() && !g.econ.canAffordBuild(cost)) return { error: '资金不足：需要 ' + U.fmtMoney(cost) };
    g.econ.spendBuild({ construction: cost }, '购置列车：' + m.short + ' ' + cars + ' 节 × ' + n + ' 列', { y: y, m: g.clock.m, d: g.clock.d }, true);
    for (let i = 0; i < n; i++) newTrain(g, m, cars, cost / n, lid, svc);
    g.logEvent({ tag: '运营', title: '购置列车：' + m.short + ' × ' + n, desc: (lid && g.net.lines[lid] ? '配属 ' + g.net.lines[lid].name + '，' : '停入车辆段，') + cars + ' 节编组，共 ' + U.fmtMoney(cost) + '。' });
    changed(g); return { ok: true, cost: cost };
  };
  // ---------------- v3.3 无人驾驶升级 ----------------
  // 一条线路上除全自动无人驾驶车与 D 型无人列车以外的列车（可补差价改装）。
  // 160 轨道只认 D 型车，那条线由下面的 D 型升级处理，不再走无人驾驶车这条通道
  F.staleAuto = function (g, lid) {
    if (!F.autoUnlocked(g) || !g.fleet) return [];
    if (g.net.lines[lid] && CM.Metro.lineKmh(g.net.lines[lid]) >= 160) return [];
    return g.fleet.trains.filter(function (t) {
      const m = BY.get(t.model);
      return t.line === lid && t.model !== F.autoModelId && !(m && m.only160) && F.canTechUpgrade(t);
    });
  };
  // 改装报价：按当年列车价格补差价（新车型价 − 原车型价，负数按 0 计），编组节数不变
  F.autoQuote = function (g, list) {
    const auto = BY.get(F.autoModelId), y = g.clock.y;
    let cost = 0, cars = 0, n = 0;
    for (const t of list) {
      const old = BY.get(t.model) || F.model(t.model);
      cost += Math.max(0, F.price(g, auto, t.cars, y) - F.price(g, old, t.cars, y));
      cars += t.cars; n++;
    }
    return { n: n, cars: cars, cost: cost };
  };
  // 一键把整条线路的其余车型改装为全自动无人驾驶车：补差价、编组不变、车龄不变（车体还是那些车）
  F.upgradeAuto = function (g, lid) {
    const list = F.staleAuto(g, lid);
    if (!list.length) return { error: '这条线路没有需要升级的列车' };
    const auto = BY.get(F.autoModelId), y = g.clock.y, q = F.autoQuote(g, list), name = g.net.lines[lid] ? g.net.lines[lid].name : '线路';
    if (!g.econ.isFree() && !g.econ.canAffordBuild(q.cost)) return { error: '资金不足：需要 ' + U.fmtMoney(q.cost) };
    if (q.cost > 0) g.econ.spendBuild({ construction: q.cost }, '列车升级：' + name + ' → ' + auto.short + ' ' + q.n + ' 列', { y: y, m: g.clock.m, d: g.clock.d }, true);
    for (const t of list) {
      const old = BY.get(t.model) || F.model(t.model);
      t.cost = (t.cost || 0) + Math.max(0, F.price(g, auto, t.cars, y) - F.price(g, old, t.cars, y));
      t.model = auto.id;
    }
    g.logEvent({ tag: '运营', title: '列车升级：' + auto.short + ' × ' + q.n, desc: name + ' 的 ' + q.n + ' 列车改装为全自动无人驾驶车（编组不变，共 ' + q.cars + ' 节），补差价 ' + U.fmtMoney(q.cost) + '。' });
    changed(g); return { ok: true, n: q.n, cars: q.cars, cost: q.cost };
  };
  // ---------------- v3.4 160 轨道：非 D 型车补差价升级 ----------------
  // 一条 160 轨道上除 D 型无人列车以外的列车。D 型是固定 8 节编组，改装后按 8 节计
  F.dModelId = 'gen-d160';
  F.staleD = function (g, lid) {
    if (!g.fleet || !g.net.lines[lid] || CM.Metro.lineKmh(g.net.lines[lid]) < 160) return [];
    if (!BY.get(F.dModelId)) return [];
    return g.fleet.trains.filter(function (t) { return t.line === lid && t.model !== F.dModelId && F.canTechUpgrade(t); });
  };
  // 改装报价：按当年价格补差价（D 型 8 节 − 原车型原编组，负数按 0 计）
  F.dQuote = function (g, list) {
    const d = BY.get(F.dModelId), y = g.clock.y, dc = d.fixedCars || 8;
    let cost = 0, cars = 0, oldCars = 0, n = 0;
    for (const t of list) {
      const old = BY.get(t.model) || F.model(t.model);
      cost += Math.max(0, F.price(g, d, dc, y) - F.price(g, old, t.cars, y));
      cars += dc; oldCars += t.cars; n++;
    }
    return { n: n, cars: cars, oldCars: oldCars, cost: cost, carsEach: dc };
  };
  // 一键把整条 160 轨道的其余车型改装为 D 型无人列车：补差价、车龄不变；编组统一为 D 型的固定 8 节
  F.upgradeD = function (g, lid) {
    const list = F.staleD(g, lid);
    if (!list.length) return { error: '这条 160 轨道没有需要升级的列车' };
    const d = BY.get(F.dModelId), y = g.clock.y, q = F.dQuote(g, list), name = g.net.lines[lid] ? g.net.lines[lid].name : '线路';
    if (!g.econ.isFree() && !g.econ.canAffordBuild(q.cost)) return { error: '资金不足：需要 ' + U.fmtMoney(q.cost) };
    if (q.cost > 0) g.econ.spendBuild({ construction: q.cost }, '列车升级：' + name + ' → ' + d.short + ' ' + q.n + ' 列', { y: y, m: g.clock.m, d: g.clock.d }, true);
    for (const t of list) {
      const old = BY.get(t.model) || F.model(t.model);
      t.cost = (t.cost || 0) + Math.max(0, F.price(g, d, q.carsEach, y) - F.price(g, old, t.cars, y));
      t.model = d.id; t.cars = q.carsEach;
    }
    g.logEvent({ tag: '运营', title: '列车升级：' + d.short + ' × ' + q.n, desc: name + ' 的 ' + q.n + ' 列车改装为 D 型无人列车（固定 ' + q.carsEach + ' 节，共 ' + q.cars + ' 节），补差价 ' + U.fmtMoney(q.cost) + '。' });
    changed(g); return { ok: true, n: q.n, cars: q.cars, cost: q.cost };
  };
  // ---------------- v3.5 同车型扩编：小编组列车补差价加挂车厢 ----------------
  // 线路能跑的最长编组取运营编译结果（与「编组超过站台长度、不能上线」判定同源），
  // 尚未编译时按实时站厅规模兜底；目标是「线路上限」与「该车型上限」的较小值，车型与车龄都不变。
  F.lineCars = function (g, lid) {
    const C = g.model && g.model.net && g.model.net.C;
    let cars = 0;
    if (C && C.routes) for (const rt of C.routes) if (rt.lineId === lid) { const c = rt.cars || 8; cars = cars ? Math.min(cars, c) : c; }
    if (!cars && g.net && CM.Metro.formationCars) cars = CM.Metro.formationCars(g.net, lid);
    return cars || 0;
  };
  F.carsTarget = function (g, lid, t) {
    const m = F.model(t.model);
    if (m.fixedCars) return t.cars;                   // 固定编组车型（如 D 型无人列车）不能加挂
    return Math.min(F.lineCars(g, lid), m.max || 8);
  };
  // ---------------- v4.1：站台规模的动态下限 ----------------
  // 一条线路上的新站台至少要建多大，只看「当前时段实际投入」的列车，不再读线路静态编组或沿线站台：
  //   · 手动调度把本时段设成 0 列、开出的交路没有配属车辆 → 视为停运，返回 null（不设下限）；
  //   · 编组超过沿线站台、或速度不够的列车不在 fp.units 里（与「不能上线」判定同源），不参与统计；
  //   · 同一时段投入多列时取其中最大的编组——调度随时可能派出最长的那一列。
  const periodOf = function (g) {
    const m = g.model, mm = (g.clock && g.clock.minute) || 0;
    return m && m.hourPeriod ? m.hourPeriod[Math.floor(mm / 60) % 24] : 0;
  };
  F.periodOf = periodOf;
  F.runCars = function (g, lid) {
    if (!g || !g.fleet || !lid) return null;
    const net = g.model && g.model.net; if (!net || !net.C) return null;
    const plan = F.plan(g, net); if (!plan) return null;
    const C = net.C, p = periodOf(g);
    let best = 0;
    C.routes.forEach(function (rt, r) {
      if (rt.lineId !== lid) return;
      const fp = plan[r]; if (!fp) return;
      const nd = rt.loop ? 2 : 1;
      for (let d = 0; d < nd; d++) {
        const units = fp.units[d] || [];
        if (!units.length) continue;
        // 本时段投入的列车数：手动模式取设定值（不超过配属数），自动模式按配属数并受时段最低服务水平约束
        const set = fp.manual && fp.manual[d] ? fp.manual[d][p] : null;
        const n = Math.min(set == null ? fp.avail[d] : set, fp.avail[d]);
        if (!(n > 0)) continue;
        for (const u of units) if (u.cars > best) best = u.cars;
      }
    });
    return best || null;
  };
  // 多条线路一起看：取最大需求。站台规模是车站级属性（一个 size 对所有经过的线路生效），
  // 所以只要有一条线在跑长编组，这座车站的下限就按那条线来。
  F.reqCars = function (g, lids) {
    let cars = 0;
    for (const lid of (lids || [])) { const c = F.runCars(g, lid); if (c && c > cars) cars = c; }
    return cars || null;
  };
  // 本线可扩编的列车：160 轨道只认 D 型车，那条线由 D 型升级处理，不在这里重复出现
  F.staleCars = function (g, lid) {
    if (!g.fleet || !g.net.lines[lid] || CM.Metro.lineKmh(g.net.lines[lid]) >= 160) return [];
    if (!(F.lineCars(g, lid) > 0)) return [];
    return g.fleet.trains.filter(function (t) { return t.line === lid && F.carsTarget(g, lid, t) > t.cars; });
  };
  // 报价：按当年同车型价格补差价（目标编组价 − 原编组价，负数按 0 计）
  F.carsQuote = function (g, list, lid) {
    const y = g.clock.y, kinds = [];
    let cost = 0, added = 0, cars = 0, n = 0, from = Infinity, to = 0;
    for (const t of list) {
      const m = F.model(t.model), tg = F.carsTarget(g, lid, t);
      cost += Math.max(0, F.price(g, m, tg, y) - F.price(g, m, t.cars, y));
      added += tg - t.cars; cars += tg; n++;
      from = Math.min(from, t.cars); to = Math.max(to, tg);
      const s = F.shortOf(m); if (kinds.indexOf(s) < 0) kinds.push(s);
    }
    return { n: n, added: added, cars: cars, cost: cost, from: n ? from : 0, to: to, kinds: kinds };
  };
  // 一键把本线的小编组列车扩编到能跑的最长编组：不换车型、不改车龄，只加挂车厢并累加车体成本
  F.upgradeCars = function (g, lid) {
    const list = F.staleCars(g, lid);
    if (!list.length) return { error: '这条线路没有可以扩编的列车' };
    const q = F.carsQuote(g, list, lid), y = g.clock.y, name = g.net.lines[lid] ? g.net.lines[lid].name : '线路';
    if (!g.econ.isFree() && !g.econ.canAffordBuild(q.cost)) return { error: '资金不足：需要 ' + U.fmtMoney(q.cost) };
    if (q.cost > 0) g.econ.spendBuild({ construction: q.cost }, '列车扩编：' + name + ' + ' + q.added + ' 节', { y: y, m: g.clock.m, d: g.clock.d }, true);
    for (const t of list) {
      const m = F.model(t.model), tg = F.carsTarget(g, lid, t);
      t.cost = (t.cost || 0) + Math.max(0, F.price(g, m, tg, y) - F.price(g, m, t.cars, y));
      t.cars = tg;
    }
    g.logEvent({ tag: '运营', title: '列车扩编：' + name + ' × ' + q.n, desc: name + ' 的 ' + q.n + ' 列车在原车型上加挂车厢（增加 ' + q.added + ' 节，扩编后共 ' + q.cars + ' 节），车龄不变，补差价 ' + U.fmtMoney(q.cost) + '。' });
    changed(g); return { ok: true, n: q.n, added: q.added, cars: q.cars, cost: q.cost };
  };
  // ---------------- v3.7 科技树升级：所有城市一键升级到当前最新车型 + 线路允许的最大编组 ----------------
  // 目标：本城当年最新且能跑本线的主力车型；编组取「线路可跑上限」与「该车型上限」的较小值，
  // 固定编组车型（D 型）按固定节数。160 线路由 D 型接管，无人驾驶时代由全自动车接管。
  // v5.0：待升级范围含旧款主力车型与城市特色车型——它们一并升级到当前主力车型。
  F.techTarget = function (g, lid) {
    const m = F.latestModel(g, lid);
    if (!m) return null;
    const cars = m.fixedCars ? m.fixedCars : Math.max(1, Math.min(F.lineCars(g, lid) || m.max || 8, m.max || 8));
    return { m: m, cars: cars };
  };
  // 需要升级的列车：车型不是最新，或车型已是最新但编组小于目标（同车型扩编）。
  // 当前编组已经大于目标时跳过（例如城市支线的新车最长 6 节，不能把 8 节车降编）。
  F.staleTech = function (g, lid) {
    const tg = F.techTarget(g, lid);
    if (!g.fleet || !g.net.lines[lid] || !tg) return [];
    return g.fleet.trains.filter(function (t) {
      if (t.line !== lid || !F.canTechUpgrade(t)) return false;
      if (t.model !== tg.m.id) return t.cars <= tg.cars;
      return t.cars < tg.cars;
    });
  };
  // 报价：换车型时按「新车当年价 − 旧车残值（原购价 × 成新率）」补差价；同车型扩编只补编组差价、车龄不变。
  // 残值口径与出售一致：买价的 75% 起按寿命直线折旧，最低 8%。
  F.techQuote = function (g, list, lid) {
    const tg = F.techTarget(g, lid), y = g.clock.y, kinds = [];
    let cost = 0, credit = 0, cars = 0, n = 0, from = Infinity, to = 0, reset = 0, expand = 0;
    if (!tg) return { n: 0, cars: 0, cost: 0, credit: 0, target: null, targetCars: 0, kinds: kinds, from: 0, to: 0, reset: 0, expand: 0 };
    for (const t of list) {
      if (!F.canTechUpgrade(t)) continue;
      const np = F.price(g, tg.m, tg.cars, y);
      if (t.model === tg.m.id) {
        cost += Math.max(0, np - F.price(g, tg.m, t.cars, y)); expand++;
      } else {
        const cr = F.residual(g, t);
        credit += cr; cost += Math.max(0, np - cr); reset++;
      }
      cars += tg.cars; n++; from = Math.min(from, t.cars); to = Math.max(to, tg.cars);
      const s = F.shortOf(F.model(t.model)); if (kinds.indexOf(s) < 0) kinds.push(s);
    }
    return { n: n, cars: cars, cost: cost, credit: credit, target: tg.m, targetCars: tg.cars, kinds: kinds, from: n ? from : 0, to: to, reset: reset, expand: expand };
  };
  // 一键升级：换车型的列车按新车价入账、车龄重置为当月；同车型只加挂车厢，车龄不变。
  F.upgradeTech = function (g, lid) {
    const list = F.staleTech(g, lid);
    if (!list.length) return { error: '这条线路的列车已经是最新车型与最长编组' };
    const q = F.techQuote(g, list, lid), y = g.clock.y, name = g.net.lines[lid] ? g.net.lines[lid].name : '线路';
    if (!q.target) return { error: '当前没有能跑这条线路的车型' };
    if (!g.econ.isSandbox() && !g.econ.canAffordBuild(q.cost)) return { error: '资金不足：需要 ' + U.fmtMoney(q.cost) };
    if (q.cost > 0) g.econ.spendBuild({ construction: q.cost }, '列车升级：' + name + ' → ' + q.target.short + ' ' + q.n + ' 列（' + q.targetCars + ' 节）', { y: y, m: g.clock.m, d: g.clock.d }, true);
    for (const t of list) {
      if (!F.canTechUpgrade(t)) continue;
      const np = F.price(g, q.target, q.targetCars, y);
      if (t.model === q.target.id) { t.cost = (t.cost || 0) + Math.max(0, np - F.price(g, q.target, t.cars, y)); t.cars = q.targetCars; }
      else { t.cost = Math.round(np); t.model = q.target.id; t.cars = q.targetCars; t.bought = g.ym(); }
    }
    g.logEvent({ tag: '运营', title: '列车升级：' + q.target.short + ' × ' + q.n, desc: name + ' 的 ' + q.n + ' 列旧车升级到 ' + F.nameOf(q.target) + '（' + q.targetCars + ' 节编组）：扣除旧车残值 ' + U.fmtMoney(q.credit) + '（按成新率折算），补差价 ' + U.fmtMoney(q.cost) + (q.reset ? '；' + q.reset + ' 列换了车型，车龄重置' : '') + (q.expand ? '；' + q.expand + ' 列同车型扩编，车龄不变' : '') + '。' });
    changed(g); return { ok: true, n: q.n, cars: q.cars, cost: q.cost, credit: q.credit, model: q.target.id, targetCars: q.targetCars };
  };
  F.sell = function (g, ids) {
    let v = 0, n = 0;
    g.fleet.trains = g.fleet.trains.filter(function (t) { if (ids.indexOf(t.id) < 0) return true; v += F.residual(g, t); n++; return false; });
    if (!n) return { error: '没有可出售的列车' };
    if (!g.econ.isFree()) { const got = g.econ.income('fleetSale', v); g.econ.log('fleetSale', got, 'gen', '出售旧列车 ' + n + ' 列（按残值）', { y: g.clock.y, m: g.clock.m, d: g.clock.d }); }
    g.logEvent({ tag: '运营', title: '出售列车 ' + n + ' 列', desc: '按残值回收 ' + U.fmtMoney(v) + '。' });
    changed(g); return { ok: true, value: v, n: n };
  };
  F.move = function (g, ids, lid, svc) {
    let n = 0;
    for (const t of g.fleet.trains) if (ids.indexOf(t.id) >= 0) { t.line = lid || null; t.svc = lid ? svc : null; n++; }
    if (n) changed(g); return n;
  };
  // 车辆段智能分配（v2.6.1 玩家反馈）：闲置列车一列一列分给高峰缺口比例最大的交路，只分站台放得下、速度够的车，优先运力大的车；
  // 手动调度的线路由玩家自己安排，不参与。只返回方案，不改动车队。
  // v5.0：只分配主力 T 级车型与 D 型车；城市特色车型留在车辆段，由玩家手动调入。
  F.allocPlan = function (g) {
    const needs = [], idle = g.fleet.trains.filter(function (t) { return !t.line && F.canAutoPick(g, F.model(t.model)); }).sort(function (a, b) { return F.capOf(b) - F.capOf(a); }), total = idle.length;
    for (const lid of CM.Metro.sortIds(Object.keys(g.net.lines))) {
      const o = g.fleet.ops[lid]; if (o && o.mode === 'manual') continue;
      for (const s of F.lineInfo(g, lid) || []) if (s.short > 0) needs.push({ lid: lid, svc: s.id, name: s.name, rt: s.rt, avail: s.avail, need: s.peakNeed, short: s.short, maxCars: s.maxCars, ids: [], stuck: false });
    }
    // v4.6：闲置慢车也能被智能分配上线（按车型限速降速运行），仍只调已购置且可自动选用的车型
    const fit = function (t, x) { const m = F.model(t.model); return t.cars <= x.maxCars && F.lineFit(m, x.rt.kmh) && F.canAutoPick(g, m); };
    for (;;) {
      let best = null, bs = 0;
      for (const x of needs) { if (x.short <= 0 || x.stuck) continue; const v = x.short / Math.max(1, x.need) + x.short * 1e-3; if (v > bs) { bs = v; best = x; } }
      if (!best) break;
      const i = idle.findIndex(function (t) { return fit(t, best); });
      if (i < 0) { best.stuck = true; continue; }
      best.ids.push(idle[i].id); idle.splice(i, 1); best.short--;
    }
    return { needs: needs, moved: total - idle.length, left: idle.length, unmet: needs.reduce(function (a, x) { return a + x.short; }, 0) };
  };
  F.applyAlloc = function (g, plan) {
    const by = new Map(); for (const x of plan.needs) for (const id of x.ids) by.set(id, x);
    if (!by.size) return 0;
    for (const t of g.fleet.trains) { const x = by.get(t.id); if (x) { t.line = x.lid; t.svc = x.svc; } }
    g.logEvent({ tag: '运营', title: '车辆段分配列车 ' + by.size + ' 列', desc: plan.needs.filter(function (x) { return x.ids.length; }).map(function (x) { return x.name + ' +' + x.ids.length; }).join('、') + '。' });
    changed(g); return by.size;
  };
  // 分配后还差的列车：按推荐车型配齐（编组取站台允许的最长）
  F.fillCost = function (g, plan) {
    const y = g.clock.y, rows = []; let cost = 0;
    for (const x of plan.needs) {
      if (x.short <= 0) continue;
      const m = F.recommend(g.mapId, y, x.rt.kmh); if (!m) continue;   // v4.4：主干没有能跑这条线的车型时不补车，交给玩家手动选购
      const cars = Math.min(x.maxCars, m.max), c = F.price(g, m, cars, y) * x.short;
      rows.push({ x: x, m: m, cars: cars, n: x.short, cost: c }); cost += c;
    }
    return { rows: rows, cost: cost };
  };
  F.setMode = function (g, lid, mode) {
    const o = g.fleet.ops[lid] || (g.fleet.ops[lid] = { mode: 'auto', n: {} });
    o.mode = mode === 'manual' ? 'manual' : 'auto';
    changed(g);
  };
  F.setManual = function (g, lid, svc, p, n) {
    const o = g.fleet.ops[lid] || (g.fleet.ops[lid] = { mode: 'manual', n: {} });
    o.n = o.n || {}; const a = o.n[svc] || (o.n[svc] = [null, null, null, null]); a[p] = Math.max(0, Math.round(n));
    changed(g);
  };

  // ---------------- 运行交路（v2.5 玩家反馈：快慢车、区间车） ----------------
  // 只改运营组织：不收费、立即生效，同时写入正式线网与草案。新交路没有列车，由玩家购买或调入后开行；取消的交路列车回到全程交路
  const applyServices = function (g, lid, list, seq) {
    CM.ui.setLineLook(lid, { svcs: list.length ? list : undefined, svcSeq: seq });
    g.refreshOperations();
  };
  F.MAX_SERVICES = 6;
  F.saveService = function (g, lid, sv) {
    if (g.jumping || g.pending) return { error: '正在结算，请稍候' };
    const L = g.net.lines[lid]; if (!L) return { error: '线路不存在' };
    const list = (L.svcs || []).slice(); let seq = L.svcSeq || 0;
    if (sv.id) { const k = list.findIndex(function (x) { return x.id === sv.id; }); if (k < 0) return { error: '交路不存在' }; list[k] = sv; }
    else { if (list.length >= F.MAX_SERVICES) return { error: '每条线路最多加开 ' + F.MAX_SERVICES + ' 个交路' }; sv.id = 'v' + (++seq); list.push(sv); }
    applyServices(g, lid, list, seq);
    g.logEvent({ tag: '运营', title: L.name + ' 调整运行交路', desc: '「' + sv.name + '」已生效：配属列车后开行。' });
    return { ok: true, id: sv.id };
  };
  F.removeService = function (g, lid, id) {
    if (g.jumping || g.pending) return { error: '正在结算，请稍候' };
    const L = g.net.lines[lid]; if (!L) return { error: '线路不存在' };
    const o = g.fleet && g.fleet.ops[lid];
    if (o && o.n) for (const k of Object.keys(o.n)) if (k.split(':')[0] === id) delete o.n[k];
    applyServices(g, lid, (L.svcs || []).filter(function (x) { return x.id !== id; }), L.svcSeq || 0);
    return { ok: true };
  };

  // ---------------- 线路运营概况（界面与提示共用） ----------------
  // 各交路：可用列车、编组超长、各时段（工作日）实际投入与所需列车、发车间隔、运力与最大断面客流
  F.lineInfo = function (g, lid) {
    const net = g.model.net; if (!net) return null;
    const C = net.C, plan = F.plan(g, net), res = g.model.resultsFor('wd'), out = [];
    C.routes.forEach(function (rt, r) {
      if (rt.lineId !== lid) return;
      const fp = plan && plan[r], re = net.rideEdge[r];
      for (let d = 0; d < (rt.loop ? 2 : 1); d++) {
        const per = [0, 1, 2, 3].map(function (p) {
          const P = res && res.per[p]; if (!P || !P.freq || P.freq.length !== net.R) return null;
          const f = P.freqDir && P.freqDir.length === 2 * net.R ? P.freqDir[2 * r + d] : P.freq[r], need = P.needDir && P.needDir.length === 2 * net.R ? P.needDir[2 * r + d] : f;
          let mx = 0; for (let q = 0; q < re.length; q++) if ((!rt.loop || (q & 1) === d) && P.load[re[q]] > mx) mx = P.load[re[q]];
          const cap = fp ? fp.cap : rt.cap;
          return { f: f, need: need, run: Math.max(0, Math.ceil(f * rt.cycleSec / 3600 - 0.05)), needN: Math.max(0, Math.ceil(need * rt.cycleSec / 3600 - 0.05)), capH: f * cap, load: mx, lf: f > 0 ? mx / (f * cap) : (mx > 0 ? 9 : 0) };
        });
        const units = fp ? fp.units[d] : [];
        let peakNeed = 0; for (const x of per) if (x) peakNeed = Math.max(peakNeed, x.needN);
        out.push({ r: r, d: d, rt: rt, id: F.svcId(rt, d), name: F.svcName(rt, d), avail: fp ? fp.avail[d] : 0, blocked: fp ? (rt.loop ? (d ? 0 : fp.blocked) : fp.blocked) : 0, units: units, per: per, cycleMin: rt.cycleSec / 60, maxCars: rt.cars, floor: F.floorNeed(rt), peakNeed: peakNeed, short: rt.svc && !(fp && fp.avail[d]) ? 0 : Math.max(0, peakNeed - (fp ? fp.avail[d] : 0)), svc: rt.svc || null, skipped: rt.skipped || 0, stops: (rt.nStops != null ? rt.nStops : rt.stIds.length), slow: fp ? (rt.loop && d ? 0 : fp.slow) : 0, runKmh: rt.runKmh || rt.kmh });
      }
    });
    // 全程交路可以不配车：本线有列车跑在加开的交路上时不算缺车（每条线路至少有一个交路在运行即可）
    if (out.some(function (x) { return x.svc && x.avail > 0; })) for (const x of out) if (!x.svc && !x.avail) { x.short = 0; x.peakNeed = 0; }
    return out;
  };
  // 线路上的列车（按交路）与车辆段闲置列车
  F.trainsOf = function (g, lid, svc) { return g.fleet.trains.filter(function (t) { return t.line === lid && (svc == null || t.svc === svc); }); };
  // v4.6：每条交路独立的日上车人次（周平均）。数据直接来自各编译路线的 routeBoard，环线按该时段
  // 实际发车频率把 routeBoardDir 拆到顺行/逆行，因此所有交路相加严格等于线路总客流。
  F.serviceRiders = function (g, lid) {
    const m = g && g.model, net = m && m.net, sd = m && !m.dailyStale ? m.stDaily : null, out = new Map();
    if (!net || !sd || !sd.routeBoard) return out;
    const C = net.C;
    for (let r = 0; r < C.routes.length; r++) {
      const rt = C.routes[r]; if (rt.lineId !== lid) continue;
      if (rt.loop && sd.routeBoardDir) {
        out.set(r + ':0', sd.routeBoardDir[2 * r] || 0);
        out.set(r + ':1', sd.routeBoardDir[2 * r + 1] || 0);
      } else out.set(r + ':0', sd.routeBoard[r] || 0);
    }
    return out;
  };
  F.lineRiders = function (g, lid) {
    let s = 0; for (const v of F.serviceRiders(g, lid).values()) s += v;
    return s;
  };

  // ---------------- 每月：运力不足与超龄提示 ----------------
  // ---------------- v3.7 自动配置列车（总开关） ----------------
  // 每月初：线路 / 交路的高峰需要大于配属时，先从车辆段调该线路的「当前主流车型」且编组放得下的空闲车；
  // 仍不够则在资金足够时自动购买同型车；资金不足则本月不买，并发一次提示（每月最多一次）。
  F.autoConfigRun = function (g) {
    const fl = g.fleet; if (!fl || !fl.autoConfig || !g.model.trafficReady()) return { moved: 0, bought: 0, short: 0 };
    const note = fl.note || (fl.note = {}), ym = g.ym();
    let moved = 0, bought = 0, short = 0, needCost = 0, needN = 0;
    const plans = [];
    for (const lid of CM.Metro.sortIds(Object.keys(g.net.lines))) {
      const tg = F.techTarget(g, lid); if (!tg) continue;
      const info = F.lineInfo(g, lid) || [];
      let lineMoved = 0;
      for (const s of info) {
        const need = Math.max(s.peakNeed || 0, s.floor || 0);
        let gap = need - (s.avail || 0); if (gap <= 0) continue;
        const cars = Math.min(tg.cars, s.maxCars || tg.cars);
        // 车辆段里同型号、编组不超过本交路上限的空闲车。
        // v5.0：只调主力 T 级车型与 D 型车——城市特色车型必须由玩家手动调入，自动配置不得代为添加。
        const idle = fl.trains.filter(function (t) {
          const m = F.model(t.model);
          return !t.line && F.canAutoPick(g, m) && t.model === tg.m.id && t.cars <= (s.maxCars || 8) && (s.rt.kmh <= 80 || m.kmh >= s.rt.kmh);
        });
        for (let i = 0; i < idle.length && gap > 0; i++) { idle[i].line = lid; idle[i].svc = s.id; gap--; moved++; lineMoved++; }
        if (gap > 0) {
          const cost = F.price(g, tg.m, cars, g.clock.y) * gap;
          plans.push({ lid: lid, svc: s.id, name: s.name, model: tg.m, cars: cars, n: gap, cost: cost });
          needCost += cost; needN += gap; short += gap;
        }
      }
      if (lineMoved) F.changed(g);
    }
    // 只有资金足够才整车买齐；不足时一列也不买，避免每月把资金掏空
    const total = plans.reduce(function (a, p) { return a + p.cost; }, 0);
    if (plans.length && g.econ.canAffordBuild(total)) {
      for (const p of plans) { const r = F.buy(g, p.lid, p.svc, p.model.id, p.cars, p.n); if (r.error) { short += p.n; continue; } bought += p.n; }
    } else if (plans.length) {
      short = needN;
      // 每月初提示一次（note 只留两个定值键，不会随月份无限增长）；日志每半年一条，避免刷屏
      if (!(note.autoCfgYm >= ym)) {
        note.autoCfgYm = ym;
        g.emit('toast', { kind: 'bad', fleet: null,
          text: '自动配置列车：资金不足，还缺 {a} 列（约 {b}）'.replace('{a}', needN).replace('{b}', U.fmtMoney(total)) });
        if (!(note.autoCfgLog > ym)) {
          note.autoCfgLog = ym + 6;
          g.logEvent({ tag: '运营', title: '自动配置列车：资金不足',
            desc: '还缺 {a} 列车，自动购买约需 {b}，本月没有购买。'.replace('{a}', needN).replace('{b}', U.fmtMoney(total)) });
        }
      }
    }
    return { moved: moved, bought: bought, short: short };
  };
  F.monthly = function (g) {
    const fl = g.fleet; if (!fl || !g.model.trafficReady()) return;
    const ym = g.ym(), note = fl.note || (fl.note = {});
    if (fl.autoAlloc) { const p = F.allocPlan(g); if (p.moved) F.applyAlloc(g, p); }
    if (fl.autoConfig) F.autoConfigRun(g);
    for (const lid in g.net.lines) {
      const o = fl.ops[lid]; if (o && o.mode === 'manual') continue;
      const info = F.lineInfo(g, lid); if (!info) continue;
      let short = 0; for (const s of info) short += s.short;
      if (short > 0 && !(note['short:' + lid] > ym)) {
        note['short:' + lid] = ym + 6;
        const L = g.net.lines[lid];
        g.logEvent({ tag: '运营', title: L.name + ' 高峰运力不足', desc: '智能调度已用上全部配属列车，高峰还差约 ' + short + ' 列，车厢会更拥挤、候车更久。可以购买列车，或从客流较少的线路调车。' });
        g.emit('toast', { kind: 'warn', text: L.name + ' 高峰运力不足：还差约 ' + short + ' 列车', fleet: lid });
      }
    }
    if (g.clock.m === 1) {
      const old = fl.trains.filter(function (t) { return ageY(g, t) > F.model(t.model).life; }).length;
      if (old && !(note.old > ym)) { note.old = ym + 12; g.logEvent({ tag: '运营', title: old + ' 列列车超过设计寿命', desc: '超龄列车的运营与维护费用 ×1.25。可以出售旧车（按残值），换购新车型。' }); }
      const y = g.clock.y, fresh = MODELS.filter(function (m) { return m.from === y && (!m.maps || m.maps.indexOf(g.mapId) >= 0); });
      if (fresh.length && !(note.newY >= y)) {
        note.newY = y;
        g.logEvent({ tag: '运营', title: '新车型开放：' + fresh.map(function (m) { return m.name; }).join('、'), desc: '可以在线路的「列车运营」分页购买。车队页列出以后开放的车型。' });
        g.emit('toast', { kind: 'info', text: '新车型开放：' + fresh.map(function (m) { return m.short; }).join('、'), models: true });
      }
    }
  };

  // ---------------- 车型侧视图（购车界面） ----------------
  F.sideSVG = function (m, line, w) {
    const L = m.look, pick = function (c) { return c === 'line' ? line : c; }, body = pick(L.body), band = pick(L.band), roof = pick(L.roof), W = w || 168, H = 40;
    const ends = { early: 'square', classic: 'round', modern: 'square', current: 'round', future: 'pointed' }[L.era] || 'round';
    const car = function (x, first) {
      const cw = 74, r = ends === 'round' ? 7 : 3;
      let s = '<rect x="' + x + '" y="9" width="' + cw + '" height="22" rx="' + r + '" fill="' + body + '" stroke="#1f2731" stroke-width="0.8"/>';
      s += '<rect x="' + (x + 1) + '" y="7" width="' + (cw - 2) + '" height="3.5" rx="1.5" fill="' + roof + '"/>';
      if (L.era === 'early') s += '<rect x="' + (x + 12) + '" y="4.5" width="' + (cw - 24) + '" height="3" rx="1" fill="' + roof + '"/>';
      s += '<rect x="' + (x + 2) + '" y="' + (L.era === 'current' ? 13 : 22) + '" width="' + (cw - 4) + '" height="' + (L.era === 'current' ? 8 : 3) + '" fill="' + band + '" opacity="' + (L.era === 'future' ? 0.9 : 1) + '"/>';
      for (let i = 0; i < 4; i++) s += '<rect x="' + (x + 6 + i * 17) + '" y="13" width="10" height="6" rx="1" fill="#2b3a4a" opacity="0.85"/>';
      for (const fx of [0.3, 0.7]) s += '<rect x="' + (x + cw * fx - 3) + '" y="13" width="6" height="16" fill="none" stroke="#1f2731" stroke-width="0.5" opacity="0.6"/>';
      s += '<rect x="' + (x + 8) + '" y="31" width="14" height="3" rx="1" fill="#39424d"/><rect x="' + (x + cw - 22) + '" y="31" width="14" height="3" rx="1" fill="#39424d"/>';
      if (first && ends === 'pointed') s += '<path d="M' + (x + cw) + ' 9 Q' + (x + cw + 10) + ' 14 ' + (x + cw + 8) + ' 31 L' + (x + cw) + ' 31 Z" fill="' + body + '" stroke="#1f2731" stroke-width="0.8"/>';
      if (first) s += '<rect x="' + (x + cw - 5) + '" y="12" width="4" height="7" rx="1" fill="#2b3a4a"/>';
      return s;
    };
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" aria-hidden="true"><line x1="0" y1="35.5" x2="' + W + '" y2="35.5" stroke="#9aa5b2" stroke-width="1"/>' + car(4, false) + car(82, true) + '</svg>';
  };

  // ================= 界面 =================
  const UI = CM.UI, ic = CM.icon, AX = CM.Accessibility;
  const groupTrains = function (g, list) {
    const m = new Map();
    for (const t of list.slice().sort(function (a, b) { return ageY(g, b) - ageY(g, a); })) { const k = t.model + '|' + t.cars; let a = m.get(k); if (!a) m.set(k, a = { m: F.model(t.model), cars: t.cars, ids: [], old: 0, value: 0 }); a.ids.push(t.id); a.value += F.residual(g, t); if (ageY(g, t) > a.m.life) a.old++; }
    return Array.from(m.values()).sort(function (a, b) { return b.ids.length - a.ids.length; });
  };
  const lineColor = function (g, lid) { const L = g.net.lines[lid]; return L ? AX.line(L) : '#2f6fa8'; };
  // v4.9：车型最高时速徽标。列车运营页的配属列车、车队总览的车型列、出售/调入面板与购车卡片统一用它，
  // 保证「每个运行车型的展示项」都能一眼看到车型限速（线路设计速度更高时整条交路按这个速度运行）。
  // compact 版只写「80 km/h」，用于窄表格；完整版带闪电图标与「最高」前缀。
  const speedChip = function (m, compact) {
    return h('span', { class: 'fo-kmh' + (compact ? ' xs' : ''), 'data-speed': m.kmh, 'data-tip': '车型最高时速 {v0} km/h'.replace('{v0}', m.kmh) },
      compact ? null : ic('bolt', 11),
      h('b', null, compact ? (m.kmh + ' km/h') : '最高 {v0} km/h'.replace('{v0}', m.kmh)));
  };
  // 车型摘要行（配属列车 / 出售 / 调入共用）：左图 + 名称与最高时速 + 定员与超龄标签 + 右侧操作。
  // 三处列表共用同一结构，避免字号、间距、配色各自漂移。
  const trainRow = function (x, color, acts, opts) {
    opts = opts || {};
    const meta = [h('span', { class: 'tag' }, '每列定员 {v0} 人'.replace('{v0}', U.fmtInt(x.m.cap * x.cars))),
      x.old ? h('span', { class: 'tag warn' }, '{v0} 列超龄'.replace('{v0}', x.old)) : null];
    if (opts.meta) for (const n of opts.meta) meta.push(n);
    return h('div', { class: 'fo-unit' + (opts.cls ? ' ' + opts.cls : ''), 'data-model': x.m.id },
      h('span', { class: 'fo-pic', html: F.sideSVG(x.m, color, 72) }),
      h('div', { class: 'fo-unit-h' }, h('b', null, F.shortOf(x.m) + ' · ' + x.cars + ' 节 × ' + x.ids.length), speedChip(x.m)),
      h('div', { class: 'fo-unit-meta' }, meta),
      opts.note || null,
      h('div', { class: 'fo-unit-acts' }, acts));
  };
  // 线路详情「列车运营」分页
  const sfx = function (n) { if (CM.Sound) CM.Sound.play(n); };
  UI.prototype.lineOpsTab = function (el, lid) {
    const g = this.g(), self = this, fl = g.fleet, o = fl.ops[lid] || { mode: 'auto' }, manual = o.mode === 'manual', info = F.lineInfo(g, lid) || [];
    const done = function () { self.markUnsaved(); self.scheduleAutosave(); self.rerenderPage(); };
    el.appendChild(h('div', { class: 'fo-mode' },
      h('div', { class: 'seg-ctl sm' }, [['auto', '智能调度'], ['manual', '手动设定']].map(function (x) { return h('button', { class: (manual ? 'manual' : 'auto') === x[0] ? 'on' : '', 'data-silent': '1', onclick: function () { if ((manual ? 'manual' : 'auto') !== x[0]) { sfx('toggle'); F.setMode(g, lid, x[0]); done(); } } }, x[1]); })),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn sm ghost', onclick: function () { if (self.opsApp) self.opsApp.go('fleet'); else self.openPage('fleet', null, { root: true }); } }, ic('train', 14), '车队总览')));
    el.appendChild(h('div', { class: 'note' }, manual ? '手动：每个时段投入几列由你设定（不超过配属列车）。多投入发车更密、运营费用更高；投入太少车厢拥挤、候车变长。' : '智能调度：在配属列车范围内按客流与最低服务水平安排各时段投入的列车；列车不够时低运力运行，车厢拥挤、候车变长。'));
    el.appendChild(this.lineSpeedBlock(lid));
    // v3.7：科技树升级入口——任何年份、任何城市都可把本线旧车一键升级到当前最新主力车型，
    // 并升到线路允许的最大编组；换车型扣旧车残值（按成新率折算）并重置车龄，同车型扩编只补编组差价。
    // v5.0：旧款主力车型与城市特色车型都在这条通道里升级；城市特色车型升级后不再保留原车型。
    {
      const tl = F.staleTech(g, lid);
      if (tl.length) {
        const q = F.techQuote(g, tl, lid), short = !g.econ.isSandbox() && !g.econ.canAffordBuild(q.cost);
        const kinds = q.kinds.join(CM.I18n && CM.I18n.get() === 'en' ? ', ' : '、');
        const same = q.reset === 0;
        const cityN = tl.filter(F.isCityTrain).length;
        // 目标带上 T 等级：玩家一眼能看出升级到的是哪一档主力车型
        const tname = F.tierLabel(q.target) + ' ' + F.nameOf(q.target);
        // 文案统一用 {x} 模板 + replace，便于整句翻译（拼接的句子无法命中词条）
        const title = (same ? '本线可扩编到 {a} · {b} 节' : '可升级到 {a} · {b} 节').replace('{a}', tname).replace('{b}', q.targetCars);
        const desc = (same
          ? '本线 {a} 列车（{b}，最短 {c} 节）：保持原车型与车龄，补差价加挂到 {d} 节。'
          : '本线 {a} 列车（{b}，最短 {c} 节）：换车型并升到 {d} 节，旧车按残值抵扣 {e}（按成新率折算），补差价 {f}，升级后车龄重置。'
        ).replace('{a}', q.n).replace('{b}', kinds).replace('{c}', q.from).replace('{d}', q.targetCars)
          .replace('{e}', U.fmtMoney(q.credit)).replace('{f}', U.fmtMoney(q.cost));
        const more = !same && q.expand ? '其中 {a} 列同车型只扩编，车龄不变。'.replace('{a}', q.expand) : null;
        const cityNote = !same && cityN ? '其中 {a} 列城市特色车按残值抵扣后换为主力车型，原车型不再保留。'.replace('{a}', cityN) : null;
        const confirmText = (same
          ? '本线 {a} 列车（共 {b} 节）将升级到 {c} · {d} 节：保持原车型，补差价扩编，车龄不变。'
          : '本线 {a} 列车（共 {b} 节）将升级到 {c} · {d} 节：旧车按残值抵扣 {e}，补差价 {f}，升级后车龄重置。'
        ).replace('{a}', q.n).replace('{b}', q.cars).replace('{c}', tname).replace('{d}', q.targetCars)
          .replace('{e}', U.fmtMoney(q.credit)).replace('{f}', U.fmtMoney(q.cost));
        el.appendChild(h('div', { class: 'fo-auto up-auto up-tech' + (same ? ' up-cars' : '') },
          h('span', { class: 'grow' }, h('b', null, title),
            h('small', null, desc),
            more ? h('small', null, more) : null,
            cityNote ? h('small', null, cityNote) : null,
            short ? h('small', { class: 'bad' }, '资金不足：需要 ' + U.fmtMoney(q.cost)) : null),
          h('button', { class: 'btn sm primary', disabled: short ? true : null, 'data-tip': short ? '资金不足：需要 ' + U.fmtMoney(q.cost) : '按当年车价补差价，整线一次升级到最新主力车型与最大编组', onclick: function () {
            self.confirm('升级本线列车？', confirmText, '补差价升级', function () {
              const r = F.upgradeTech(g, lid);
              if (r.error) { self.toast(r.error, 'bad'); return; }
              sfx('trainBuy'); self.toast('已升级 {a} 列到 {b} · {c} 节，补差价 {d}'.replace('{a}', r.n).replace('{b}', F.shortOf(q.target)).replace('{c}', r.targetCars).replace('{d}', U.fmtMoney(r.cost)), 'good');
              done();
            }, false, 'train');
          } }, '补差价升级')));
      }
    }
    if (!info.length) { el.appendChild(h('div', { class: 'note' }, '线路运营后在这里安排列车。')); return; }
    // 运行交路：全程站站停之外可以加开快车、区间车，各交路分别配车，也分别统计客流量
    const kindOf = function (s) { return !s.svc ? '全程站站停' : (s.rt.stIds.length ? (s.skipped ? '停靠 ' + s.stops + ' 站 · 通过 ' + s.skipped + ' 站' : '区间 · ' + s.stops + ' 站') : ''); };
    const allStops = info.filter(function (s) { return !s.svc; });
    const svcRiders = F.serviceRiders(g, lid), dailyOk = !!(g.model.stDaily && !g.model.dailyStale);
    el.appendChild(h('div', { class: 'fl-h fo-svc-head' }, h('span', { class: 'grow' }, '运行交路 ', h('span', { class: 'tiny muted' }, (info.filter(function (s) { return s.svc; }).length ? info.length + ' 个' : '默认全程站站停'))),
      dailyOk ? h('span', { class: 'tiny', 'data-tip': '各交路客流量相加等于本线日客运量' }, '本线日客流 {n} 人次（各交路合计）'.replace('{n}', U.fmtPeople(F.lineRiders(g, lid)))) : null,
      h('button', { class: 'btn sm', 'data-tip': '加开快车（跳站）或区间车（只跑一段）。只改运营组织，不收费', onclick: function () { self.showServiceEditor(lid); } }, ic('plus', 14), '新增交路')));
    const peakByBase = new Map();
    for (const s of info) { const x = s.per[0]; if (x && (s.d === 0)) { const b = s.rt.baseId != null ? s.rt.baseId : s.rt.id; peakByBase.set(b, (peakByBase.get(b) || 0) + x.f); } }
    peakByBase.forEach(function (f) { if (f > CFG.metro.fMax + 0.5) el.appendChild(self.callout('warn', 'warn', '同一条轨道上早高峰合计约 ' + U.fmtNum(f, 1) + ' 列/时，超过上限 ' + CFG.metro.fMax + ' 列/时：减少投入的列车或加长编组。')); });
    let avail = 0, short = 0, blocked = 0; for (const s of info) { avail += s.avail; short += s.short; blocked += s.blocked; }
    const all = F.trainsOf(g, lid), grp = groupTrains(g, all);
    el.appendChild(h('div', { class: 'fo-sum' },
      h('div', null, h('small', null, '配属列车'), h('b', null, all.length + ' 列')),
      h('div', null, h('small', null, '高峰需要'), h('b', { class: short ? 'bad' : '' }, info.reduce(function (s, x) { return s + x.peakNeed; }, 0) + ' 列')),
      h('div', null, h('small', null, '车型'), h('b', null, grp.length ? grp.map(function (x) { return F.shortOf(x.m); }).filter(function (v, i, a) { return a.indexOf(v) === i; }).join('、') : '—'))));
    if (short && !manual) el.appendChild(this.callout('warn', 'warn', h('span', null, '高峰运力不足：还差约 ' + short + ' 列。智能调度只调度已有列车，可以购买列车，或从客流较少的线路调车。')));
    if (blocked) el.appendChild(this.callout('bad', 'warn', '{v0} 列列车不能上线：编组超过本线站台长度，或车型与本线轨道类型不匹配。升级沿线车站，或调往其他线路、出售。'.replace('{v0}', blocked)));
    const slowN = info.reduce(function (a, x) { return a + (x.slow || 0); }, 0);
    const caps = info.map(function (x) { return x.runKmh || (x.rt && x.rt.runKmh) || 0; }).filter(function (v) { return v > 0; });
    const runKmh = caps.length ? Math.min.apply(null, caps) : 0;
    if (slowN) el.appendChild(this.callout('info', 'info', '{v0} 列列车的车型限速低于本线轨道速度，可以上线，但整条交路按较慢的车型限速降速运行（当前实际 {v1} km/h）：换用更快的车型可恢复设计速度。'.replace('{v0}', slowN).replace('{v1}', runKmh)));
    else if (runKmh && CM.Metro.lineKmh(g.net.lines[lid]) > runKmh) el.appendChild(this.callout('info', 'info', '受配属车型限制，本线实际运行速度 {v0} km/h，低于轨道设计速度。'.replace('{v0}', runKmh)));
    // 配属列车：按车型与编组分组，可调回车辆段或出售
    const pl = F.plan(g, g.model.net) || [], onRoute = new Set();
    const unitRow = function (x, warn) {
      const out = function (k) { sfx('trainMove'); F.move(g, x.ids.slice(-k), null, null); self.toast('已调回车辆段 ' + k + ' 列', 'info'); done(); };
      return trainRow(x, lineColor(g, lid), [
        h('button', { class: 'btn sm ghost', 'data-tip': '调回车辆段（之后可配给其他线路）', onclick: function () { if (x.ids.length === 1) out(1); else self.showTrainQty({ title: '调回车辆段 · ' + F.shortOf(x.m), icon: 'train', model: x.m, cars: x.cars, max: x.ids.length, btn: '调出', note: function (k) { return k + ' 列调回车辆段，之后可配给其他线路。'; }, apply: out }); } }, '调出'),
        h('button', { class: 'btn sm ghost', 'data-tip': '按残值出售，每列约 ' + U.fmtMoney(x.value / x.ids.length), onclick: function () { self.showTrainSell(x, done); } }, '出售')
      ], { note: warn ? h('small', { class: 'bad fo-unit-note' }, warn) : null });
    };
    for (const s of info) {
      const card = h('div', { class: 'fo-svc' });
      card.appendChild(h('div', { class: 'fo-svc-kind' }, h('span', { class: 'tiny muted grow' }, kindOf(s)),
        s.svc ? h('button', { class: 'btn sm ghost', onclick: function () { self.showServiceEditor(lid, s.svc); } }, ic('pencil', 13), '编辑') : null,
        s.svc && (s.d === 0 || !s.rt.loop) ? h('button', { class: 'btn sm ghost', 'data-tip': '取消这个交路，列车回到全程交路', onclick: function () { const r = F.removeService(g, lid, s.svc); if (r.error) self.toast(r.error, 'bad'); else { sfx('serviceDel'); self.toast('已取消交路，列车回到全程交路', 'info'); done(); } } }, ic('close', 13), '取消') : null));
      // v4.6：交路名单独占一行，指标标签另起一行；否则窄侧栏里名称会被标签挤成一字一行的竖排
      card.appendChild(h('div', { class: 'fo-svc-h' }, h('span', { class: 'swatch', style: { background: lineColor(g, lid) } }), h('b', { class: 'grow' }, s.name)));
      card.appendChild(h('div', { class: 'fo-svc-meta' },
        dailyOk ? h('span', { class: 'tag' }, '日客流 {n} 人次'.replace('{n}', U.fmtPeople(svcRiders.get(s.r + ':' + s.d) || 0))) : null,
        h('span', { class: 'tag' }, '周转 ' + Math.round(s.cycleMin) + ' 分钟'), h('span', { class: 'tag' }, '最长 ' + s.maxCars + ' 节')));
      const ids = new Set((pl[s.r] ? pl[s.r].units[s.d] : []).map(function (u) { return u.id; })); ids.forEach(function (id) { onRoute.add(id); });
      const gs = groupTrains(g, all.filter(function (t) { return ids.has(t.id); }));
      const units = h('div', { class: 'fo-units' });
      if (!gs.length) units.appendChild(h('div', { class: 'note' }, '这个交路还没有列车。'));
      for (const x of gs) units.appendChild(unitRow(x));
      card.appendChild(units);
      // 分时段（工作日）：投入列车、发车间隔、运力与最大断面客流
      const tbl = h('table', { class: 'tbl fo-tbl' }, h('tr', null, h('th', null, '时段'), h('th', null, '投入'), h('th', null, '间隔'), h('th', null, '运力/时'), h('th', null, '满载')));
      s.per.forEach(function (x, p) {
        if (!x) return;
        let cell;
        if (manual) {
          const cur = o.n && o.n[s.id] && o.n[s.id][p] != null ? Math.min(o.n[s.id][p], s.avail) : s.avail;
          const set = function (v) { F.setManual(g, lid, s.id, p, U.clamp(v, 0, s.avail)); done(); };
          cell = h('span', { class: 'fo-step' }, h('button', { class: 'iconbtn', disabled: cur <= 0 ? true : null, 'aria-label': '减少', onclick: function () { set(cur - 1); } }, ic('minus', 14)), h('b', null, String(cur)), h('button', { class: 'iconbtn', disabled: cur >= s.avail ? true : null, 'aria-label': '增加', onclick: function () { set(cur + 1); } }, ic('plus', 14)));
        } else cell = h('span', null, h('b', null, String(Math.min(x.run, s.avail))), x.needN > s.avail ? h('small', { class: 'bad' }, ' / 需 ' + x.needN) : null);   // 只有配属列车不够时才标出还需要几列
        tbl.appendChild(h('tr', null, h('td', null, PN[p]), h('td', null, cell), h('td', null, x.f > 0.05 ? U.fmtNum(60 / x.f, 1) + ' 分' : '停运'), h('td', null, U.fmtInt(x.capH)), h('td', { class: x.lf > 1 ? 'bad' : '' }, x.f > 0.05 ? U.fmtPct(x.lf, 0) : '—')));
      });
      card.appendChild(h('div', { class: 'tbl-wrap' }, tbl));
      card.appendChild(h('div', { class: 'row', style: { gap: '6px', marginTop: '8px', flexWrap: 'wrap' } },
        h('button', { class: 'btn sm primary', onclick: function () { self.showTrainShop(lid, s.id, s.name, s.maxCars); } }, ic('plus', 14), '购买列车'),
        h('button', { class: 'btn sm', onclick: function () { self.showTrainTransfer(lid, s.id, s.name, s.maxCars); } }, ic('route', 14), '调入列车'),
        h('span', { class: 'grow tiny muted' }, '配属 ' + s.avail + ' 列 · 最低服务需要 ' + s.floor + ' 列')));
      el.appendChild(card);
    }
    // 编组超过站台长度、或车型与轨道类型不匹配的列车不能上线（车型慢只降速，仍可上线）
    const off = groupTrains(g, all.filter(function (t) { return !onRoute.has(t.id); }));
    if (off.length) {
      const lkmh = CM.Metro.lineKmh(g.net.lines[lid]);
      el.appendChild(h('div', { class: 'fl-h' }, '不能上线的列车'));
      for (const x of off) el.appendChild(unitRow(x, !F.lineFit(x.m, lkmh) ? (x.m.only160 ? '160 专用列车，只能在 160 轨道上线' : '普通列车不能上 160 高速轨道') : '编组超过本线站台长度，调往其他线路或出售'));
    }
    el.appendChild(this.sec('fo-rule', '列车运营说明', '', function () {
      return h('div', { class: 'note' }, h('ul', { class: 'tk-tips' },
        h('li', null, '发车频率由投入的列车数决定：间隔 ≈ 周转时间 ÷ 投入列车数，最小 2 分钟；支线单独配车，环线两个方向分别配车。'),
        h('li', null, '买车按车型与编组整列购买，编组不能超过沿线最小车站的站台长度；车型按城市与年代开放。'),
        h('li', null, '运营按车厢公里计费，老车型与超龄列车更费钱；出售按残值回收（买价的 75% 起逐年折旧，最低 8%）。'),
        h('li', null, '新线与延长按最低服务水平随线配车，费用计入建设；车辆段有闲置列车时先用闲置列车。'),
        h('li', null, '运行速度：速度越低，允许的转弯半径越小（40 km/h 约 100 m，120 km/h 约 600 m）；轨道设计速度高于车型限速时列车仍可上线，但整条交路按较慢的车型限速降速运行，周转变长、需要的列车更多。'),
        h('li', null, '运行交路：快车跳过的车站不停车，节省时间但服务变少；区间车集中运力在客流大的一段。各交路分别配车，同一条轨道合计最多 ' + CFG.metro.fMax + ' 列/时，游戏不模拟越行。')));
    }, false, 'info'));
  };
  // 线路运行速度（v2.5 玩家反馈）：进入草案，确认后生效；改了速度的线路全线复核转弯半径，提速按全线长度计改造费
  UI.prototype.lineSpeedBlock = function (lid) {
    const g = this.g(), self = this, MM = CM.Metro, net = g.draft ? g.draft.net : g.net, L = net.lines[lid], cur = MM.lineKmh(L), y = g.clock.y;
    let tight = Infinity; for (const s of MM.lineSegs(net, lid)) { const v = MM.segGeom(net, s, g.city).minRadiusM; if (isFinite(v)) tight = Math.min(tight, v); }
    // v3.0 / v3.4：160 轨道只允许大型及以上站台；先找出不满足的站，选中 160 时禁用并说明
    const S160 = CFG.metro.std160 || { sizeMin: ['L', 'XL'] };
    const minSz = (S160.sizeMin && S160.sizeMin[0]) || 'L', minI = (CFG.metro.sizes || ['S', 'M', 'L', 'XL']).indexOf(minSz);
    const smallPlat = (function () {
      const out = [], tp = MM.lineTopo(net, lid), sizes = CFG.metro.sizes || ['S', 'M', 'L', 'XL'];
      for (const sid of (tp && tp.stations) || []) { const st = net.stations[sid]; if (st && sizes.indexOf(st.size) >= 0 && sizes.indexOf(st.size) < minI) out.push(st.name); }
      return out;
    })();
    const ctl = h('div', { class: 'seg-ctl sm' }, CFG.metro.speedGrades.map(function (x) {
      const open = F.speedOpen(g.mapId, y, x.kmh), over = isFinite(tight) && tight < x.minR, on = cur === x.kmh;
      const plat = x.kmh >= 160 && smallPlat.length > 0;
      const tip = x.kmh + ' km/h：最小转弯半径 ' + x.minR + ' m，运营成本 ×' + x.ops.toFixed(2) + (x.track ? '，轨道造价附加 ' + Math.round(x.track * 100) + '%' : '') + (x.kmh >= 160 ? '；160 轨道只允许大型及以上站台，且需要 D 型无人列车' : '') + (plat ? '；本线有 ' + smallPlat.length + ' 座车站的站台不足大型，例如「' + smallPlat[0] + '」' : '') + (open.ok ? '' : '；需要最高速度不低于 ' + x.kmh + ' km/h 的车型' + (open.year ? '（' + open.year + ' 年起开放）' : '')) + (over ? '；本线最急处约 ' + Math.round(tight) + ' m，要先放缓弯道' : '');
      // 站台不足时不禁用按钮：要能点一下弹出错误提示，同时 g.edit 完全不执行（阻止建造）
      return h('button', { class: (on ? 'on' : '') + (plat ? ' locked' : ''), disabled: on || !open.ok ? true : null, 'data-tip': tip, 'data-silent': '1', onclick: function () {
        if (on) return;
        if (plat) { self.toast('160 轨道只允许大型及以上站台：请先把「' + smallPlat[0] + '」等 ' + smallPlat.length + ' 座车站升级为大型', 'bad'); return; }
        const r = g.edit(function (n) { const l = n.lines[lid]; if (!l) return { error: '线路不存在' }; if (x.kmh === 80) delete l.speed; else l.speed = x.kmh; });
        if (r.error) self.toast(r.error, 'bad'); else {
          sfx(x.kmh > cur ? 'speedUp' : 'speedDown');
          const nd = x.kmh >= 160 && g.fleet ? g.fleet.trains.filter(function (t) { return t.line === lid && t.model !== F.dModelId; }).length : 0;
          self.toast((L.name || '') + ' 运行速度改为 ' + x.kmh + ' km/h，确认建设后生效' + (nd ? '；本线有 ' + nd + ' 列非 D 型车，建设完成后可在本页补差价升级' : ''), 'info');
          self.rerenderPage();
        }
      } }, String(x.kmh));
    }));
    const G = MM.speedGrade(L);
    const box = h('div', { class: 'fo-speed' }, h('div', { class: 'fo-speed-h' }, h('b', { class: 'grow' }, '运行速度'), ctl, h('span', { class: 'tiny muted' }, 'km/h')),
      h('div', { class: 'tiny muted' }, '最小转弯半径 ' + G.minR + ' m' + (isFinite(tight) ? ' · 本线最急处约 ' + Math.round(tight) + ' m' : '') + ' · 运营成本 ×' + G.ops.toFixed(2)));
    // v3.4：160 轨道不再按线路单独定价，票价统一在「财政与经济 → 票价管理」里设置
    return box;
  };
  // 新增或编辑运行交路：选类型、区间与停靠站，预览用时后保存
  UI.prototype.showServiceEditor = function (lid, id) {
    const g = this.g(), self = this, MM = CM.Metro, C = g.compiled, net = g.net, L = net.lines[lid], tp = C.topo.get(lid);
    // v4.8：交路编辑以「完整基准路线」（C.bases）为坐标系，站序与 svcStops/patternRoute 的索引一致；
    // 停用站与预留站由下面的 stationOpen 过滤掉，不进入起讫站下拉与停靠站 chip。
    const bases = (C.bases && C.bases[lid]) || C.routes.filter(function (r) { return r.lineId === lid && !r.svc; });
    if (!L || !tp || !bases.length) { this.toast('线路运营后才能设置交路', 'bad'); return; }
    const old = id ? (L.svcs || []).find(function (x) { return x.id === id; }) : null, loop = tp.topo === 'loop', box = h('div');
    // v4.6：站点停靠选择只列「正在运营」的站——预留站与已关闭运营的站不设站台，既不显示也不能被选为起讫站
    const stationOpen = function (sid) { return MM.stationOpen(net.stations[sid]); };
    // 换乘站悬停提示：C.stationLines 是编译期已按 stationOpen 过滤的「实际可换乘线路」；
    // 预留站接入多线时用 stationTracks 标为「未来换乘站」，升级前不提供换乘。
    const xferLines = function (sid) {
      const k = C.sIndex.get(sid); if (k == null || !C.stationLines[k]) return [];
      return Array.from(C.stationLines[k]).filter(function (x) { return x !== lid && net.lines[x]; })
        .map(function (x) { return { id: x, name: net.lines[x].name, color: AX.line(net.lines[x]) }; });
    };
    const xfer = function (sid) { return xferLines(sid).length > 0; };
    const futureXfer = function (sid) {
      const k = C.sIndex.get(sid); return k != null && C.stationTracks[k] && C.stationTracks[k].size > 1 && !xfer(sid);
    };
    let ri = 0, ia = 0, ib = bases[0].stIds.length - 1, skip = new Set(), kind = 'express', named = false, name = '大站快车';
    if (old) {
      const plan = MM.svcStops(tp, old); name = old.name; named = true; skip = new Set(old.skip || []);
      if (plan) { ri = plan.ri; if (!loop) { ia = plan.ia; ib = plan.ib; } }
      kind = skip.size ? 'express' : 'short';
    }
    const base = function () { return bases[ri]; }, nameOf = function (sid) { return net.stations[sid].name; };
    const openIdx = function () { const a = []; base().stIds.forEach(function (sid, i) { if (stationOpen(sid)) a.push(i); }); return a; };
    // 起讫站若正好落在预留站/停用站上，改成最近一座运营中的站，保证两端必须停靠的前提仍然成立
    const fixEnds = function () {
      const st = base().stIds, o = openIdx(); if (!o.length) return;
      if (loop) return;
      if (!stationOpen(st[ia])) ia = o[0];
      const later = o.filter(function (i) { return i > ia; });
      if (!stationOpen(st[ib]) || ib <= ia) ib = later.length ? later[later.length - 1] : o[o.length - 1];
    };
    fixEnds();
    const autoName = function () { if (!named) name = kind === 'express' ? '大站快车' : '区间车（' + nameOf(base().stIds[ia]) + '—' + nameOf(base().stIds[ib]) + '）'; };
    const preset = function (mode) {
      skip = new Set(); const st = base().stIds, lo = loop ? 0 : ia, hi = loop ? st.length - 1 : ib;
      for (let i = lo; i <= hi; i++) {
        const sid = st[i];
        if (!stationOpen(sid)) { skip.add(sid); continue; }   // 预留站 / 停用站一律通过不停
        if (loop ? i === 0 : (i === ia || i === ib)) continue;
        if (mode === 'alt' ? (i - ia) % 2 === 1 && !xfer(sid) : (mode === 'xfer' ? !xfer(sid) : false)) skip.add(sid);
      }
    };
    if (!old) {
      if (loop) preset('alt'); else { ib = bases[0].stIds.length - 1; fixEnds(); preset('alt'); }
      autoName();
    }
    const svOf = function () {
      const st = base().stIds, last = st.length - 1, sk = [];
      for (let i = loop ? 0 : ia + 1; i < (loop ? st.length : ib); i++) if (skip.has(st[i])) sk.push(st[i]);
      const sv = { id: old ? old.id : null, name: name.trim() || '加开交路', skip: sk };
      if (!loop) { if (ia > 0) sv.from = st[ia]; if (ib < last) sv.to = st[ib]; }
      if (bases.length > 1) sv.via = st[last];
      return sv;
    };
    const draw = function () {
      box.replaceChildren();
      const st = base().stIds, sv = svOf(), plan = MM.svcStops(tp, Object.assign({}, sv)), trial = plan ? MM.patternRoute(C, L, bases[plan.ri], sv, plan) : null;
      box.appendChild(h('div', { class: 'fo-sv-row' }, h('small', null, '类型'),
        h('div', { class: 'seg-ctl sm' }, [['express', '快车（跳站）'], ['short', '区间车']].filter(function (o) { return !loop || o[0] === 'express'; }).map(function (o) {
          return h('button', { class: kind === o[0] ? 'on' : '', 'data-silent': '1', onclick: function () {
            kind = o[0];
            if (kind === 'short') { const n = st.length, o = openIdx(), a = Math.floor(n * 0.2), b = Math.max(a + 1, Math.ceil(n * 0.8) - 1); ia = o.filter(function (i) { return i >= a; })[0]; ib = o.filter(function (i) { return i <= b; }).pop(); if (ia == null || ib == null || ib <= ia) { ia = o[0]; ib = o[o.length - 1]; } skip = new Set(); }
            else { ia = 0; ib = st.length - 1; fixEnds(); preset('alt'); }
            autoName(); draw();
          } }, o[1]);
        }))));
      const nameIn = h('input', { type: 'text', value: name, maxlength: 16, 'aria-label': '交路名称', placeholder: '交路名称' });
      nameIn.addEventListener('input', function () { name = nameIn.value; named = true; });
      box.appendChild(h('div', { class: 'fo-sv-row' }, h('small', null, '名称'), nameIn));
      if (bases.length > 1) {
        const sel = h('select', { 'aria-label': '支线方向' });
        bases.forEach(function (r, i) { sel.appendChild(h('option', { value: String(i), selected: i === ri ? 'selected' : null }, r.label)); });
        sel.addEventListener('change', function () { ri = +sel.value; ia = 0; ib = bases[ri].stIds.length - 1; fixEnds(); skip = new Set(); autoName(); draw(); });
        box.appendChild(h('div', { class: 'fo-sv-row' }, h('small', null, '方向'), sel));
      }
      if (!loop) {
        const pick = function (label, cur, lo, hi, set) {
          const sel = h('select', { 'aria-label': label });
          for (let i = lo; i <= hi; i++) if (stationOpen(st[i])) sel.appendChild(h('option', { value: String(i), selected: i === cur ? 'selected' : null }, nameOf(st[i])));
          sel.addEventListener('change', function () { set(+sel.value); autoName(); draw(); });
          return h('div', { class: 'fo-sv-row' }, h('small', null, label), sel);
        };
        box.appendChild(pick('起点站', ia, 0, ib - 1, function (v) { ia = v; }));
        box.appendChild(pick('终点站', ib, ia + 1, st.length - 1, function (v) { ib = v; }));
      }
      // 停靠站：只列正在运营的站（预留站与停用站不设站台，自动通过不停，也不出现在选择项里）；两端必须停靠
      const lo = loop ? 0 : ia, hi = loop ? st.length - 1 : ib, chips = h('div', { class: 'fo-sv-stops' });
      const firstOpen = (openIdx()[0] != null ? openIdx()[0] : 0);
      const skipOpen = function () { let n = 0; for (const s of skip) if (stationOpen(s)) n++; return n; };
      const xferInfo = h('div', { class: 'fo-sv-xfer tiny muted' }, '悬停换乘站可查看该站可换乘的线路。');
      const showXfer = function (sid) {
        const lines = sid ? xferLines(sid) : [];
        xferInfo.replaceChildren();
        if (lines.length) {
          xferInfo.appendChild(h('span', null, '本站可换乘：'));
          for (const l of lines) xferInfo.appendChild(h('span', { class: 'tag', style: { background: l.color + '22', color: l.color }, 'data-no-i18n': '1' }, '● ' + l.name));
        } else if (sid && futureXfer(sid)) xferInfo.appendChild(h('span', null, '预留换乘 · 补建为正式站后启用换乘'));
        else xferInfo.appendChild(h('span', null, '悬停换乘站可查看该站可换乘的线路。'));
        if (CM.I18n) CM.I18n.localize(xferInfo);
      };
      chips.addEventListener('mouseleave', function () { showXfer(null); });
      for (let i = lo; i <= hi; i++) {
        const sid = st[i];
        if (!stationOpen(sid)) continue;
        const fixed = loop ? i === firstOpen : (i === ia || i === ib), stop = fixed || !skip.has(sid);
        const lines = xferLines(sid), isX = lines.length > 0, fut = futureXfer(sid);
        chips.appendChild(h('button', {
          class: 'fo-sv-stop' + (stop ? ' on' : '') + (isX ? ' xfer' : '') + (fut ? ' future' : ''),
          disabled: fixed ? true : null, 'aria-pressed': stop ? 'true' : 'false',
          'data-station': sid, 'data-xfer': lines.map(function (l) { return l.id; }).join(','),
          'data-tip': isX ? '悬停查看本站可换乘的线路' : (fut ? '预留换乘 · 补建为正式站后启用换乘' : (fixed ? '起讫站必须停靠' : (stop ? '点击改为通过不停' : '点击改为停靠'))),
          'data-silent': '1',
          onmouseenter: function () { showXfer(sid); },
          onclick: function () {
            if (skip.has(sid)) skip.delete(sid); else skip.add(sid);
            kind = skipOpen() ? 'express' : (ia > 0 || ib < st.length - 1 ? 'short' : kind); draw();
          }
        }, nameOf(sid)));
      }
      box.appendChild(h('div', { class: 'fo-sv-row top' }, h('small', null, '停靠站'), h('div', { class: 'grow' }, chips, xferInfo,
        h('div', { class: 'row', style: { gap: '6px', marginTop: '6px', flexWrap: 'wrap' } },
          h('button', { class: 'btn sm ghost', onclick: function () { preset('all'); kind = ia > 0 || ib < st.length - 1 ? 'short' : kind; draw(); } }, '全部停靠'),
          h('button', { class: 'btn sm ghost', onclick: function () { preset('alt'); kind = 'express'; autoName(); draw(); } }, '隔站停靠'),
          h('button', { class: 'btn sm ghost', onclick: function () { preset('xfer'); kind = 'express'; autoName(); draw(); } }, '只停换乘站')))));
      // 预览：单程用时、周转与开行所需列车
      const same = !sv.skip.length && !sv.from && !sv.to;
      if (trial) {
        const b = bases[plan.ri], a0 = loop ? 0 : plan.ia, a1 = loop ? b.legSec.length : plan.ib, dw = CFG.metro.dwell;
        let localSec = 0; for (let i = a0; i < a1; i++) localSec += b.legSec[i]; localSec += dw * Math.max(0, a1 - a0 - (loop ? 0 : 1));
        const expSec = trial.runSec + dw * Math.max(0, trial.stIds.length - (loop ? 0 : 2));
        box.appendChild(h('div', { class: 'fo-sum' },
          h('div', null, h('small', null, '停靠'), h('b', null, (trial.nStops != null ? trial.nStops : trial.stIds.length) + ' 站'), trial.skipped ? h('small', { class: 'muted' }, '通过 ' + trial.skipped + ' 站') : null),
          h('div', null, h('small', null, '单程'), h('b', null, U.fmtNum(expSec / 60, 1) + ' 分钟'), h('small', { class: 'muted' }, '站站停 ' + U.fmtNum(localSec / 60, 1) + ' 分钟')),
          h('div', null, h('small', null, '周转'), h('b', null, Math.round(trial.cycleSec / 60) + ' 分钟'), h('small', { class: 'muted' }, '每小时 6 列约需 ' + Math.ceil(6 * trial.cycleSec / 3600) + ' 列')),
          h('div', null, h('small', null, '编组上限'), h('b', null, trial.cars + ' 节'))));
      }
      if (same) box.appendChild(h('div', { class: 'callout warn' }, '这样设置与全程站站停相同：请缩短区间或选择要通过的车站。'));
      box.appendChild(h('div', { class: 'modal-actions' },
        h('button', { class: 'btn', onclick: function () { self.closeScreen(); self.rerenderPage(); } }, '取消'),
        h('button', { class: 'btn primary', disabled: same || !trial ? true : null, onclick: function () {
          const r = F.saveService(g, lid, svOf());
          if (r.error) { self.toast(r.error, 'bad'); return; }
          sfx('service');
          self.toast(old ? '已更新交路' : '已加开交路：购买或调入列车后开行', 'good');
          self.closeScreen(); self.markUnsaved(); self.scheduleAutosave(); self.rerenderPage();
        } }, ic('check', 14), old ? '保存' : '加开')));
      if (CM.I18n) CM.I18n.localize(box);
    };
    draw();
    this.openScreen(h('div', { class: 'card wide' }, this.cardHead('route', 'b-blue', (old ? '编辑交路 · ' : '新增交路 · ') + L.name), h('div', { class: 'note' }, '只改运营组织，不收费、立即生效；交路在配属列车后开行。'), box), function () { self.closeScreen(); self.rerenderPage(); });
  };
  // 数量输入（v2.6.1 玩家反馈）：可以直接输入数字，也可以点加减；onChange 收到 1…max 的整数
  const qtyInput = function (val, max, onChange) {
    const inp = h('input', { class: 'fo-qty', type: 'number', min: 1, max: max, step: 1, 'aria-label': '数量' });
    inp.value = val;
    const set = function (v, typing) { const k = U.clamp(Math.round(+v) || 1, 1, max); if (!typing) inp.value = k; onChange(k); return k; };
    inp.addEventListener('input', function () { if (inp.value !== '') set(inp.value, true); });
    inp.addEventListener('blur', function () { set(inp.value || 1); });
    const el = h('span', { class: 'fo-step' },
      h('button', { class: 'iconbtn', 'aria-label': '减少', onclick: function () { set((+inp.value || 1) - 1); } }, ic('minus', 14)), inp,
      h('button', { class: 'iconbtn', 'aria-label': '增加', onclick: function () { set((+inp.value || 0) + 1); } }, ic('plus', 14)));
    return { el: el, set: set, inp: inp };
  };
  // 数量对话框：一次调出或出售多列
  UI.prototype.showTrainQty = function (o) {
    const self = this, noteEl = h('div', { class: 'note' });
    let n = 1;
    const upd = function () { noteEl.textContent = o.note(n); if (CM.I18n) CM.I18n.localize(noteEl); };
    const q = qtyInput(1, o.max, function (k) { n = k; upd(); });
    upd();
    this.openScreen(h('div', { class: 'card' }, this.cardHead(o.icon, 'b-blue', o.title),
      o.model ? h('div', { class: 'fo-qty-spec' }, speedChip(o.model), h('span', { class: 'tag' }, '每列定员 {v0} 人'.replace('{v0}', U.fmtInt(o.model.cap * (o.cars || 8))))) : null,
      h('div', { class: 'fo-qty-row' }, h('small', null, '数量'), q.el, h('span', { class: 'tiny muted' }, '共 ' + o.max + ' 列'), h('button', { class: 'btn sm ghost', onclick: function () { q.set(o.max); } }, '全部')),
      noteEl,
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn', onclick: function () { self.closeScreen(); } }, '取消'), h('button', { class: 'btn primary', onclick: function () { self.closeScreen(); o.apply(n); } }, ic('check', 14), o.btn))), function () { self.closeScreen(); });
    q.inp.focus(); q.inp.select();
  };
  // 出售一组列车：先卖最旧的，按残值回收
  UI.prototype.showTrainSell = function (x, done) {
    const g = this.g(), self = this;
    const worth = function (k) { const pick = x.ids.slice(0, k); let v = 0; for (const t of g.fleet.trains) if (pick.indexOf(t.id) >= 0) v += F.residual(g, t); return v; };
    this.showTrainQty({ title: '出售列车 · ' + F.shortOf(x.m) + ' ' + x.cars + ' 节', icon: 'train', model: x.m, cars: x.cars, max: x.ids.length, btn: '出售', note: function (k) { return '先卖最旧的 ' + k + ' 列，按残值回收约 ' + U.fmtMoney(worth(k)) + '。'; },
      apply: function (k) { const r = F.sell(g, x.ids.slice(0, k)); if (r.ok) { sfx('trainSell'); self.toast('已出售 ' + r.n + ' 列，回收 ' + U.fmtMoney(r.value), 'good'); } done(); } });
  };
  // 车辆段智能分配：先看方案再确认；分配后还差的可以一次买够
  UI.prototype.showFleetAlloc = function () {
    const g = this.g(), self = this, plan = F.allocPlan(g), fill = F.fillCost(g, plan), box = h('div');
    const finish = function () { self.closeScreen(); self.markUnsaved(); self.scheduleAutosave(); self.rerenderPage(); };
    if (!plan.needs.length) box.appendChild(h('div', { class: 'note' }, h('span', null, '各线高峰运力都够，不需要调车。'), plan.left ? h('span', null, '车辆段的 ' + plan.left + ' 列继续闲置。') : null));
    else {
      const t = h('table', { class: 'tbl' }, h('tr', null, h('th', null, '交路'), h('th', null, '配属'), h('th', null, '高峰需要'), h('th', null, '调入'), h('th', null, '还差')));
      for (const x of plan.needs) t.appendChild(h('tr', null, h('td', null, h('span', { class: 'swatch', style: { background: lineColor(g, x.lid), marginRight: '6px' } }), x.name), h('td', null, String(x.avail)), h('td', null, String(x.need)), h('td', { class: x.ids.length ? 'good' : '' }, x.ids.length ? '+' + x.ids.length : '—'), h('td', { class: x.short ? 'bad' : '' }, String(x.short))));
      box.appendChild(h('div', { class: 'tbl-wrap' }, t));
      box.appendChild(h('div', { class: 'note' }, h('span', null, plan.left ? '车辆段可分配 ' + plan.moved + ' 列，剩 ' + plan.left + ' 列。' : '车辆段可分配 ' + plan.moved + ' 列。'), h('span', null, plan.unmet ? '分配后还差 ' + plan.unmet + ' 列。' : '分配后高峰运力够用。'), plan.left && plan.unmet ? h('span', null, '剩下的列车编组超过站台长度、车型与轨道不匹配，或是只能手动调派的城市特色车型。') : null));
    }
    box.appendChild(h('div', { class: 'modal-actions' },
      h('button', { class: 'btn', onclick: function () { self.closeScreen(); } }, plan.needs.length ? '取消' : '完成'),
      fill.rows.length ? h('button', { class: 'btn', disabled: g.econ.canAffordBuild(fill.cost) ? null : true, 'data-tip': g.econ.canAffordBuild(fill.cost) ? '缺的列车按推荐车型购买并配属' : '资金不足：需要 ' + U.fmtMoney(fill.cost), onclick: function () {
        F.applyAlloc(g, plan);
        for (const r of fill.rows) { const res = F.buy(g, r.x.lid, r.x.svc, r.m.id, r.cars, r.n); if (res.error) { self.toast(res.error, 'bad'); break; } }
        sfx('trainBuy'); self.toast('已分配并买够缺口，约 ' + U.fmtMoney(fill.cost), 'good'); finish();
      } }, '分配并买够缺口（约 ' + U.fmtMoney(fill.cost) + '）') : null,
      plan.moved ? h('button', { class: 'btn primary', onclick: function () { const k = F.applyAlloc(g, plan); sfx('trainMove'); self.toast('已分配 ' + k + ' 列到缺车的线路', 'good'); finish(); } }, ic('check', 14), '按此分配') : null));
    if (CM.I18n) CM.I18n.localize(box);
    this.openScreen(h('div', { class: 'card wide' }, this.cardHead('train', 'b-blue', '智能分配列车'), h('div', { class: 'note' }, '把车辆段的主力车型与 D 型车分给高峰缺口最大的线路，手动调度的线路不参与。城市特色车型不会被自动分配，需要手动调入。'), box), function () { self.closeScreen(); });
  };
  // 购买列车（lid 为空时买入车辆段）
  UI.prototype.showTrainShop = function (lid, svc, svcName, maxCars) {
    const g = this.g(), self = this, y = g.clock.y;
    // v3.1：车型按轨道类型过滤——160 专用车型（D 型无人列车）只在 160 线路上出现；车辆段要等全网有 160 线路才卖
    const shop = F.buyList(g, lid), list = shop.list, soon = shop.soon, col = lineColor(g, lid);
    // 站台长度兜底：没有交路或老存档缺字段时按 8 节算，绝不把 NaN 传进购买流程
    maxCars = Math.max(1, Math.min(8, Math.floor(+maxCars) || 8));
    // v4.4：默认选中的必须是主干 / 160 支线车型，绝不自动选中城市特色车型
    let sel = shop.defaultModel || list[0], cars = Math.min(maxCars, sel ? sel.max : 6), n = 1;
    const gap = function () { if (!lid) return F.allocPlan(g).unmet; const s = (F.lineInfo(g, lid) || []).find(function (x) { return x.id === svc; }); return s ? s.short : 0; };
    const box = h('div');
    // 车型卡片：未开放的车型变灰、不能选，标出开放年份
    const card = function (m, lock) {
      // v5.0：主力车型标 T1–T6（一款一级），城市特色车型同尺定级，D 型车独立标 D
      const kids = [h('span', { class: 'fo-pic', html: F.sideSVG(m, col, 168) }),
        h('span', { class: 'fo-name' }, h('b', null, F.nameOf(m)), h('span', { class: 'fo-tier ' + F.tierKind(m) }, F.tierChip(m))),
        lock ? h('span', { class: 'fo-lock' }, ic('lock', 12), h('span', null, m.from + ' 年开放'), h('span', null, '还有 ' + (m.from - y) + ' 年'))
          : h('span', { class: 'tiny muted' }, (m.maps ? '本市车型' : '通用车型') + ' · ' + m.from + (m.to < 9999 ? '–' + m.to : ' 年起')),
        // v5.0：城市特色车型只能手动购买与调派，任何自动流程都不会代买或代为调入
        !lock && m.maps ? h('span', { class: 'tiny muted' }, '城市特色车型：只能手动购买与调派，不参与自动配置') : null,
        // v4.9：参数拆成标签 + 最高时速徽标，比一行长文本更好扫读
        h('span', { class: 'fo-model-spec' },
          h('span', { class: 'tag' }, '每节 ' + m.cap + ' 人'),
          speedChip(m),
          h('span', { class: 'tag' }, '运营成本 ×' + m.ops.toFixed(2))),
        h('span', { class: 'tiny muted' }, F.descOf(m))];
      if (lock) return h('div', { class: 'fo-model locked' }, kids);
      return h('button', { class: 'fo-model' + (m === sel ? ' on' : ''), onclick: function () { sel = m; cars = m.fixedCars ? Math.min(maxCars, m.fixedCars) : Math.min(maxCars, m.max, Math.max(cars, 4)); draw(); } }, kids);
    };
    const draw = function () {
      box.replaceChildren();
      if (shop.forced) box.appendChild(h('div', { class: 'callout info' }, '全自动无人驾驶车已上市：除 160 轨道专用的 D 型无人列车外，其余车型已停售。'));
      const grid = h('div', { class: 'fo-shop' });
      for (const m of list) grid.appendChild(card(m, false));
      if (soon.length) {
        grid.appendChild(h('div', { class: 'fo-shop-h' }, ic('lock', 13), '即将开放的车型（' + soon.length + '）'));
        for (const m of soon) grid.appendChild(card(m, true));
      }
      box.appendChild(grid);
      if (!sel) { box.appendChild(h('div', { class: 'note' }, '这一年没有可以购买的车型。')); return; }
      // v3.0：固定编组车型（D 型车固定 8 节）只有一个选项
      const opts = (sel.fixedCars ? [sel.fixedCars] : [4, 6, 8]).filter(function (c) { return c <= Math.min(maxCars, sel.max); });
      if (opts.indexOf(cars) < 0) cars = opts[opts.length - 1] || 4;
      const each = F.price(g, sel, cars, y), totEl = h('b', null, U.fmtMoney(each * n));
      // 买得起的最多列数（资金不限时不提示）
      let afford = 999;
      if (!g.econ.isFree()) { afford = 0; while (afford < 999 && g.econ.canAffordBuild(each * (afford + 1))) afford++; }
      const q = qtyInput(n, 999, function (k) { n = k; totEl.textContent = U.fmtMoney(each * n); totEl.classList.toggle('bad', n > afford); if (CM.I18n) CM.I18n.localize(totEl); });
      totEl.classList.toggle('bad', n > afford);
      const need = gap();
      box.appendChild(h('div', { class: 'fo-buy' },
        h('div', null, h('small', null, '编组'), h('div', { class: 'seg-ctl sm' }, opts.map(function (c) { return h('button', { class: c === cars ? 'on' : '', 'data-silent': '1', onclick: function () { cars = c; draw(); } }, c + ' 节'); }))),
        h('div', null, h('small', null, '数量（列）'), q.el, h('div', { class: 'fo-presets' },
          h('button', { class: 'btn xs ghost', onclick: function () { q.set(n + 5); } }, '+5'), h('button', { class: 'btn xs ghost', onclick: function () { q.set(n + 10); } }, '+10'),
          need > 0 ? h('button', { class: 'btn xs ghost', 'data-tip': lid ? '这个交路高峰还差的列车数' : '全网分配完闲置列车后还差的列车数', onclick: function () { q.set(need); } }, '补足缺口 ' + need) : null,
          afford < 999 && afford > 0 ? h('button', { class: 'btn xs ghost', onclick: function () { q.set(afford); } }, '最多 ' + afford) : null)),
        h('div', null, h('small', null, '每列'), h('b', null, U.fmtMoney(each)), h('small', { class: 'muted' }, '定员 ' + U.fmtInt(sel.cap * cars) + ' 人')),
        h('div', null, h('small', null, '合计'), totEl)));
      if (!opts.length) box.appendChild(h('div', { class: 'callout warn' }, '本线站台最长 ' + maxCars + ' 节，' + F.shortOf(sel) + ' 没有合适的编组。'));
      box.appendChild(h('div', { class: 'modal-actions' },
        h('button', { class: 'btn', onclick: function () { self.closeScreen(); } }, '取消'),
        h('button', { class: 'btn primary', disabled: !opts.length ? true : null, onclick: function () {
          const r = F.buy(g, lid, svc, sel.id, cars, n);
          if (r.error) { self.toast(r.error, 'bad'); return; }
          sfx('trainBuy');
          self.toast('已购买 ' + F.shortOf(sel) + ' ' + cars + ' 节 × ' + n + ' 列，' + (lid ? '配属 ' + svcName : '停入车辆段'), 'good');
          self.closeScreen(); self.markUnsaved(); self.scheduleAutosave(); self.rerenderPage();
          if (!lid && F.allocPlan(g).moved) self.showFleetAlloc();   // 买入车辆段后直接看分配方案
        } }, ic('check', 14), '购买')));
      if (CM.I18n) CM.I18n.localize(box);
    };
    draw();
    this.openScreen(h('div', { class: 'card wide' }, this.cardHead('train', 'b-blue', lid ? '购买列车 · ' + svcName : '购买列车 · 车辆段'), h('div', { class: 'note' }, lid ? '本线站台最长 ' + maxCars + ' 节（受沿线最小车站限制）。买到的整列列车直接配属这个交路；车型按城市与年代开放。' : '买入后停在车辆段，可以按客流智能分配到缺车的线路。编组超过站台长度的列车不能上线，先看线路允许的编组；车型按城市与年代开放。'), box), function () { self.closeScreen(); });
  };
  // 调入列车：车辆段与其他线路的列车（按线路、车型与编组分组）
  UI.prototype.showTrainTransfer = function (lid, svc, svcName, maxCars) {
    const g = this.g(), self = this, box = h('div');
    const draw = function () {
      box.replaceChildren();
      const src = new Map();
      for (const t of g.fleet.trains) { if (t.line === lid && t.svc === svc) continue; const k = (t.line || '') + '|' + (t.line ? t.svc : ''); let a = src.get(k); if (!a) src.set(k, a = { line: t.line, svc: t.line ? t.svc : null, list: [] }); a.list.push(t); }
      const keys = Array.from(src.keys()).sort(function (a, b) { return (a[0] === '|' ? -1 : 0) - (b[0] === '|' ? -1 : 0); });
      if (!keys.length) box.appendChild(h('div', { class: 'note' }, '没有其他列车可以调入。'));
      for (const k of keys) {
        const s = src.get(k), L = s.line && g.net.lines[s.line];
        let use = '';
        if (L) { const inf = F.lineInfo(g, s.line) || [], av = inf.reduce(function (a, x) { return a + x.avail; }, 0), nd = inf.reduce(function (a, x) { return a + x.peakNeed; }, 0); use = '高峰需要 ' + nd + ' / 配属 ' + av + (av > nd ? '，约 ' + (av - nd) + ' 列富余' : ''); }
        const svcLabel = L && s.svc ? (F.lineInfo(g, s.line) || []).filter(function (x) { return x.id === s.svc; }).map(function (x) { return x.name; })[0] : null;
        box.appendChild(h('div', { class: 'fl-h' }, svcLabel || (L ? L.name : '车辆段（闲置）'), use ? h('span', { class: 'tiny muted', style: { marginLeft: '8px' } }, use) : null));
        const lineKmh = CM.Metro.lineKmh(g.net.lines[lid]);
        for (const x of groupTrains(g, s.list)) {
          const m = x.m, tooLong = x.cars > maxCars, badTrack = !F.lineFit(m, lineKmh), slow = lineKmh > 80 && m.kmh < lineKmh, ok = !tooLong && !badTrack;
          box.appendChild(trainRow(x, lineColor(g, lid), [
            h('button', { class: 'btn sm', disabled: ok ? null : true, onclick: function () { sfx('trainMove'); F.move(g, [x.ids[x.ids.length - 1]], lid, svc); draw(); self.markUnsaved(); } }, '调入 1 列'),
            x.ids.length > 1 ? h('button', { class: 'btn sm ghost', disabled: ok ? null : true, onclick: function () { sfx('trainMove'); F.move(g, x.ids.slice(), lid, svc); draw(); self.markUnsaved(); } }, '全部') : null
          ], {
            cls: ok ? '' : 'off',
            note: !ok ? h('small', { class: 'bad fo-unit-note' }, tooLong ? '编组超过本线站台长度（最长 ' + maxCars + ' 节）' : (m.only160 ? '160 专用列车，只能在 160 轨道上线' : '普通列车不能上 160 高速轨道'))
              : (slow ? h('small', { class: 'muted fo-unit-note' }, '车型限速 {v0} km/h，上线后按车型限速降速运行'.replace('{v0}', m.kmh)) : null)
          }));
        }
      }
      box.appendChild(h('div', { class: 'modal-actions' }, h('button', { class: 'btn primary', onclick: function () { self.closeScreen(); self.scheduleAutosave(); self.rerenderPage(); } }, '完成')));
      if (CM.I18n) CM.I18n.localize(box);
    };
    draw();
    this.openScreen(h('div', { class: 'card wide' }, this.cardHead('route', 'b-blue', '调入列车 · ' + svcName), h('div', { class: 'note' }, '把车辆段的闲置列车或其他线路富余的列车调到这个交路，立即生效、不收费。'), box), function () { self.closeScreen(); self.rerenderPage(); });
  };
  // 车队总览
  UI.prototype.page_fleet = function () {
    const g = this.g(), self = this, fl = g.fleet; if (!fl) return null;
    const y = g.clock.y;   // 本页多处按当年判断在售 / 开放，统一在顶部声明
    const el = h('div'), old = fl.trains.filter(function (t) { return ageY(g, t) > F.model(t.model).life; }).length;
    let value = 0; for (const t of fl.trains) value += F.residual(g, t);
    const depot = fl.trains.filter(function (t) { return !t.line; });
    el.appendChild(h('div', { class: 'fo-sum' },
      h('div', null, h('small', null, '列车'), h('b', null, fl.trains.length + ' 列')),
      h('div', null, h('small', null, '车辆段闲置'), h('b', null, depot.length + ' 列')),
      h('div', null, h('small', null, '残值合计'), h('b', null, U.fmtMoney(value))),
      h('div', null, h('small', null, '超龄'), h('b', { class: old ? 'bad' : '' }, old + ' 列'))));
    const refresh = function () { self.markUnsaved(); self.scheduleAutosave(); self.rerenderPage(); };
    // v4.0：列车管理改为「按线路集中展示」——每条线路一组，组内直接按交路列成一张表：
    // 交路 / 车型 × 数量 / 配属/需要 / 操作（买入、卖出）。原来拆成「线路汇总」与「交路配属」
    // 两张表，同一条线路要上下对照；现在同一线路的信息都在同一位置，买入卖出仍按交路生效。
    const openLine = function (lid) { if (self.opsApp) self.opsApp.go('lines', lid); else self.openObj('line', lid, 'ops'); };
    // 交路名：全程交路统一叫「全程站站停」，加开的交路只显示服务名（不再重复线路名）
    const svcTitle = function (L, s) {
      if (!s.svc) return '全程站站停';
      const sv = (L.svcs || []).filter(function (v) { return v.id === s.rt.svc; })[0];
      return sv ? sv.name : String(s.name).split(' · ').pop();
    };
    const svcSub = function (s) {
      if (!s.svc) return s.rt.loop ? (s.d ? '逆行' : '顺行') : '';
      if (!s.rt.stIds.length) return '';
      return s.skipped ? '停靠 ' + s.stops + ' 站 · 通过 ' + s.skipped + ' 站' : '区间 · ' + s.stops + ' 站';
    };
    // 车型 × 数量：每个车型单独一行，右侧跟最高时速徽标（窄列里也能看清是哪一款车、能跑多快）；
    // 末行补编组与超龄，避免信息挤压在名称里
    const kindsCell = function (list) {
      if (!list.length) return h('td', { class: 'tiny muted' }, '—');
      const gs = groupTrains(g, list), cars = [];
      for (const x of gs) if (cars.indexOf(x.cars) < 0) cars.push(x.cars);
      const oldN = gs.reduce(function (a, x) { return a + x.old; }, 0);
      return h('td', { class: 'tiny' },
        h('div', { class: 'fo-kindlist' }, gs.map(function (x) {
          return h('span', { class: 'fo-kind', 'data-model': x.m.id }, h('span', { class: 'fo-kind-n' }, F.shortOf(x.m) + ' ×' + x.ids.length), speedChip(x.m, true));
        })),
        h('small', { class: 'muted' }, cars.join('/') + ' 节' + (oldN ? ' · 超龄 ' + oldN : '')));
    };
    // 卖出某个交路（或某条线路）的列车：沿用原来的残值出售弹窗，按车型与编组分组
    const sellGroup = function (lid, title, list) {
      const box = h('div');
      if (!list.length) box.appendChild(h('div', { class: 'note' }, '这里没有配属列车。'));
      for (const x of groupTrains(g, list)) box.appendChild(trainRow(x, lineColor(g, lid), [
        h('button', { class: 'btn sm ghost', onclick: function () { self.showTrainSell(x, function () { self.closeScreen(); refresh(); }); } }, '出售')
      ], { meta: [h('span', { class: 'tag' }, '残值约 {v0}'.replace('{v0}', U.fmtMoney(x.value)))] }));
      box.appendChild(h('div', { class: 'modal-actions' }, h('button', { class: 'btn primary', onclick: function () { self.closeScreen(); refresh(); } }, '完成')));
      if (CM.I18n) CM.I18n.localize(box);
      self.openScreen(h('div', { class: 'card wide' }, self.cardHead('train', 'b-blue', '出售列车 · ' + title), h('div', { class: 'note' }, '出售按残值回收（买价的 75% 起逐年折旧，最低 8%）；超龄列车的运营与维护费用 ×1.25。'), box), function () { self.closeScreen(); refresh(); });
    };
    // 操作列：买入（按这个交路下单）/ 卖出（只卖这个交路的车）
    const actsCell = function (lid, L, name, list, buy) {
      return h('td', { class: 'fo-acts' },
        buy ? h('button', { class: 'btn xs ghost', 'data-silent': '1', 'data-tip': '为「' + name + '」买车，新车直接配属到这个交路', onclick: function (e) { e.stopPropagation(); self.showTrainShop(lid, buy.svc, L.name + ' · ' + name, buy.maxCars); } }, '买入') : null,
        h('button', { class: 'btn xs ghost', 'data-silent': '1', disabled: list.length ? null : true, onclick: function (e) { e.stopPropagation(); sellGroup(lid, L.name + ' · ' + name, list); } }, '卖出'));
    };
    for (const lid of M_sort(Object.keys(g.net.lines))) {
      const L = g.net.lines[lid], o = fl.ops[lid], inf = F.lineInfo(g, lid) || [];
      const riders = F.serviceRiders(g, lid), dailyOk = !!(g.model.stDaily && !g.model.dailyStale);
      const lineTrains = fl.trains.filter(function (t) { return t.line === lid; });
      const byId = new Map(); for (const t of lineTrains) byId.set(t.id, t);
      const av = inf.reduce(function (a, x) { return a + x.avail; }, 0), nd = inf.reduce(function (a, x) { return a + x.peakNeed; }, 0);
      // v3.1：站台允许的编组取各交路的上限（lineInfo 的字段是 maxCars）；没有交路时按 8 节兜底，
      // 不能对 undefined 取最大值——那会得到 NaN，购车界面就会报「本线站台最长 NaN 节」
      const caps = inf.map(function (x) { return x.maxCars; }).filter(function (v) { return isFinite(v) && v > 0; });
      const maxCars = caps.length ? Math.max.apply(null, caps) : 8;
      const oldN = lineTrains.filter(function (t) { return ageY(g, t) > F.model(t.model).life; }).length;
      el.appendChild(h('div', { class: 'fl-h fleet-grp clickable', onclick: function () { openLine(lid); } },
        h('span', { class: 'swatch', style: { background: AX.line(L) } }),
        h('b', null, L.name),
        o && o.mode === 'manual' ? h('span', { class: 'tag' }, '手动调度') : null,
        h('span', { class: 'grow' }),
        dailyOk ? h('span', { class: 'tiny muted', 'data-tip': '各交路客流量相加等于本线日客运量' }, '日客流 {n} 人次'.replace('{n}', U.fmtPeople(F.lineRiders(g, lid)))) : null,
        oldN ? h('span', { class: 'tiny bad' }, '超龄 ' + oldN) : null,
        h('span', { class: 'tiny ' + (inf.length && nd > av ? 'bad' : 'muted'), 'data-tip': inf.length ? '本线配属列车 / 高峰需要（按各时段最大值）' : '本线列车数（还没有可运行的交路）' },
          inf.length ? av + ' / ' + nd + ' 列' : lineTrains.length + ' 列')));
      const tbl = h('table', { class: 'tbl fleet-line-tbl' }, h('tr', null,
        h('th', null, '交路'), h('th', null, '车型 × 数量'), h('th', null, '配属/需要'), h('th', null, '操作')));
      const seen = new Set();
      for (const s of inf) {
        const mine = s.units.map(function (u) { return byId.get(u.id); }).filter(Boolean);
        for (const t of mine) seen.add(t.id);
        const nm = svcTitle(L, s), sub = svcSub(s);
        tbl.appendChild(h('tr', null,
          h('td', null, h('b', null, nm), sub ? h('small', { class: 'muted' }, sub) : null,
            dailyOk ? h('small', { class: 'muted' }, '日客流 {n} 人次'.replace('{n}', U.fmtPeople(riders.get(s.r + ':' + s.d) || 0))) : null),
          kindsCell(mine),
          h('td', null, h('b', { class: s.short > 0 ? 'bad' : '' }, s.avail + ' / ' + s.peakNeed),
            s.short > 0 ? h('small', { class: 'bad' }, '缺 ' + s.short + ' 列') : (s.floor ? h('small', { class: 'muted' }, '最低 ' + s.floor + ' 列') : null)),
          actsCell(lid, L, nm, mine, { svc: s.id, maxCars: Math.max(1, Math.min(8, s.maxCars || maxCars)) })));
      }
      // 只有编组超过站台长度、或车型与轨道类型不匹配时才会剩下（车型慢只降速，仍可上线）
      const rest = inf.length ? lineTrains.filter(function (t) { return !seen.has(t.id); }) : [];
      if (rest.length) tbl.appendChild(h('tr', { class: 'rest' },
        h('td', null, h('b', null, '未上线'), h('small', { class: 'muted' }, '编组超过站台或轨道类型不匹配')),
        kindsCell(rest),
        h('td', null, h('b', { class: 'muted' }, '—')),
        actsCell(lid, L, '未上线列车', rest, null)));
      // 还没有可运行交路的线路：也让本线列车与买/卖操作留在同一处，不必再翻到线路页
      if (!inf.length) tbl.appendChild(h('tr', null,
        h('td', null, h('b', null, '全程站站停'), h('small', { class: 'muted' }, '线路尚未接入运营')),
        kindsCell(lineTrains),
        h('td', null, h('b', { class: 'muted' }, '—')),
        actsCell(lid, L, '全程站站停', lineTrains, { svc: null, maxCars: maxCars })));
      el.appendChild(h('div', { class: 'tbl-wrap' }, tbl));
    }
    el.appendChild(h('div', { class: 'note', style: { marginTop: '6px' } }, '「配属/需要」按高峰时段最大值；买入与卖出都只作用于这一行交路。'));
    // v3.0：一键筛选所有超龄列车，可直接按残值出售；v3.1：再加「一键卖出全部超龄列车」（二次确认）
    if (old) {
      // 一键卖出：按当前车龄重新挑一次，卖出前把列数、残值与「会不会让交路缺车」说清楚
      const sellAllOld = function () {
        const list = fl.trains.filter(function (t) { return ageY(g, t) > F.model(t.model).life; });
        if (!list.length) { self.toast('没有超龄列车了', 'info'); return; }
        let value = 0, onLine = 0;
        for (const t of list) { value += F.residual(g, t); if (t.line) onLine++; }
        const ids = list.map(function (t) { return t.id; });
        const text = onLine
          ? '共 ' + list.length + ' 列，车龄超过设计寿命，按残值可回收约 ' + U.fmtMoney(value) + '；其中 ' + onLine + ' 列仍在运营，卖出后相关交路会缺车。'
          : '共 ' + list.length + ' 列，车龄超过设计寿命，按残值可回收约 ' + U.fmtMoney(value) + '。';
        self.confirm('卖出全部超龄列车？', text, '全部卖出', function () {
          const r = F.sell(g, ids);
          if (r.error) { self.toast(r.error, 'bad'); return; }
          sfx('trainSell');
          self.toast('已出售 ' + r.n + ' 列，回收 ' + U.fmtMoney(r.value), 'good');
          self._fleetOld = false;
          refresh();
        }, true, 'trash');
      };
      el.appendChild(h('div', { class: 'row', style: { gap: '6px', marginTop: '8px', flexWrap: 'wrap' } },
        h('button', { class: 'btn sm ghost', 'data-silent': '1', onclick: function () { self._fleetOld = !self._fleetOld; self.rerenderPage(); } },
          ic('clock', 14), (self._fleetOld ? '收起' : '筛选') + '超龄列车（' + old + ' 列）'),
        h('button', { class: 'btn sm ghost danger', 'data-silent': '1', 'data-tip': '按残值一次卖出所有超过设计寿命的列车，卖出前会再次确认', onclick: sellAllOld },
          ic('trash', 14), '一键卖出超龄列车')));
      if (self._fleetOld) {
        const box = h('div', { class: 'fo-units', style: { marginTop: '6px' } });
        for (const t of fl.trains) {
          const m = F.model(t.model), age = ageY(g, t); if (age <= m.life) continue;
          const L = t.line && g.net.lines[t.line];
          box.appendChild(h('div', { class: 'fo-unit' },
            h('span', { class: 'fo-pic', html: F.sideSVG(m, t.line ? lineColor(g, t.line) : '#2f6fa8', 84) }),
            h('div', { class: 'grow' }, h('b', null, F.shortOf(m) + ' · ' + t.cars + ' 节' + (L ? ' · ' + L.name : ' · 车辆段')),
              h('small', { class: 'bad' }, '车龄 ' + Math.round(age) + ' 年，超过设计寿命 ' + m.life + ' 年 · 运营费用 ×1.25 · 残值约 ' + U.fmtMoney(F.residual(g, t)))),
            h('button', { class: 'btn sm ghost', onclick: function () { self.showTrainSell({ m: m, cars: t.cars, ids: [t.id], value: F.residual(g, t), old: 1 }, refresh); } }, '出售')));
        }
        el.appendChild(box);
      }
    }
    el.appendChild(h('div', { class: 'fl-h fo-svc-head', style: { marginTop: '10px' } }, h('span', { class: 'grow' }, '车辆段'),
      h('button', { class: 'btn sm', onclick: function () { self.showTrainShop(null, null, '车辆段', 8); } }, ic('plus', 14), '购买入库'),
      h('button', { class: 'btn sm primary', onclick: function () { self.showFleetAlloc(); } }, ic('train', 14), '智能分配')));
    const auto = !!fl.autoAlloc;
    el.appendChild(h('div', { class: 'fo-auto' }, h('span', { class: 'grow' }, h('b', null, '每月自动分配闲置列车'), h('small', null, '每月初把车辆段的列车分给缺车的线路，不会自动买车')),
      h('button', { class: 'switch' + (auto ? ' on' : ''), role: 'switch', 'aria-checked': auto ? 'true' : 'false', 'aria-label': '每月自动分配闲置列车', onclick: function () { fl.autoAlloc = !fl.autoAlloc; sfx('toggle'); self.markUnsaved(); self.rerenderPage(); } }, h('i'))));
    // v3.7：自动配置列车总开关——缺车时调车辆段的主力空闲车，没有就自动买；资金不足每月提示
    // v5.0：只调主力 T 级车型（160 轨道为 D 型车）；城市特色车型不会被自动调派或购买
    const autc = !!fl.autoConfig;
    el.appendChild(h('div', { class: 'fo-auto' }, h('span', { class: 'grow' }, h('b', null, '自动配置列车'), h('small', null, '线路或交路缺车时，只调主力 T 级车型（160 轨道为 D 型车）的空闲车；没有就自动购买同型主力车；资金不足时每月初提示。城市特色车型不会被自动调派或购买，只能手动购买与调入。')),
      h('button', { class: 'switch' + (autc ? ' on' : ''), role: 'switch', 'aria-checked': autc ? 'true' : 'false', 'aria-label': '自动配置列车', onclick: function () { fl.autoConfig = !fl.autoConfig; sfx('toggle'); self.markUnsaved(); self.rerenderPage(); } }, h('i'))));
    if (!depot.length) el.appendChild(h('div', { class: 'note' }, '没有闲置列车。线路调整后没有归属的列车、从线路调回的列车和买入车辆段的列车停在这里。'));
    for (const x of groupTrains(g, depot)) el.appendChild(h('div', { class: 'fo-unit' },
      h('span', { class: 'fo-pic', html: F.sideSVG(x.m, '#2f6fa8', 84) }),
      h('div', { class: 'grow' }, h('b', null, F.shortOf(x.m) + ' · ' + x.cars + ' 节 × ' + x.ids.length), h('small', null, '残值约 ' + U.fmtMoney(x.value) + (x.old ? ' · ' + x.old + ' 列超龄' : ''))),
      h('button', { class: 'btn sm ghost', onclick: function () { self.showTrainSell(x, refresh); } }, '出售')));
    el.appendChild(h('div', { class: 'note', style: { marginTop: '8px' } }, '在线路的「列车运营」分页也可以调入车辆段的列车，或为单个交路买车。'));
    // v3.7：车型科技树（单主干 + 9 条城市支线 + 160 支线），节点按年份自动点亮。
    // 行的归属按当前地图判断（own），显示的是选中的那条城市支线，便于横向对照各城车型。
    {
      const city = self._treeCity || F.cityOfMap(g.mapId) || 'gz';
      const nodes = F.treeNodes(g.mapId, y, city);
      // 每行最靠后的已开放且本图可买的节点，标注为该行的「当前主力 / 本城最新」
      const lastOf = function (list) { let L = null; for (const n of list) if (n.lit && n.own) L = n; return L; };
      const nodeEl = function (n, cur) {
        const now = !!cur && n.id === cur.id;
        const st = !n.lit ? ('还有 ' + (n.from - y) + ' 年')
          : !n.own ? ('仅' + F.cityLabel(city))
            : n.sale ? (now ? cur.tag : '在售')
              : n.retired ? '已停用' : '';
        // v5.0：等级标签——主力 T1–T6 一款一级；城市特色车型按性能折算到同一标尺；D 型车独立
        const tierTip = n.kind === '160' ? 'D 型车：160 km/h 专用，独立于 T 级'
          : n.kind === 'trunk' ? '主力车型 T{v0}（一款一级）'.replace('{v0}', n.tier)
            : '城市特色车型：按定员、运营成本与最高时速折算为 T{v0}'.replace('{v0}', n.tier);
        return h('div', { class: 'tt-node' + (n.lit ? ' lit' : '') + (n.sale ? ' sale' : '') + (now ? ' on' : '') + (n.kind === '160' ? ' d160' : ''),
          'data-tip': F.nameOf(n.m) + ' · ' + tierTip + ' · ' + n.from + (n.m.to < 9999 ? '–' + n.m.to : ' 年起') + ' · ' + n.m.cap + ' 人/节 · 最高 ' + n.m.kmh + ' km/h' },
          h('span', { class: 'tt-head' }, h('i', { class: 'tt-dot' }), h('span', { class: 'tt-tier ' + n.tierKind }, n.tierLabel)),
          h('b', null, F.shortOf(n.m)), h('small', null, n.m.from + (n.m.to < 9999 ? '–' + n.m.to : '')), st ? h('small', { class: 'tt-st' }, st) : null);
      };
      const row = function (label, list, tag) {
        if (!list.length) return null;
        const cur = { id: (lastOf(list) || {}).id, tag: tag };
        return h('div', { class: 'tt-row' }, h('span', { class: 'tt-lb' }, label), h('div', { class: 'tt-track' }, list.map(function (n) { return nodeEl(n, cur); })));
      };
      const box = h('div', { class: 'tt' },
        row('主力', nodes.trunk, '当前主力'),
        h('div', { class: 'tt-city' }, h('span', { class: 'tt-lb' }, '城市支线'),
          h('div', { class: 'seg-ctl sm tt-cities' }, F.CITY_ORDER.map(function (id) {
            return h('button', { class: id === city ? 'on' : '', 'data-silent': '1', onclick: function () { self._treeCity = id; self.rerenderPage(); } }, F.cityLabel(id));
          }))),
        row('支线', nodes.branch, '本城最新'),
        row('160', nodes.d160, '160 专用'));
      el.appendChild(h('div', { class: 'fl-h', style: { marginTop: '12px' } }, '车型科技树', h('span', { class: 'tiny muted', style: { marginLeft: '8px' } }, '主力 T1–T6 一款一级 · 城市特色同尺定级 · D 型车独立；节点按年份自动点亮')));
      el.appendChild(h('div', { class: 'mc-card mc-pad tt-wrap' }, box,
        h('div', { class: 'note', style: { marginTop: '6px' } }, 'T1–T6 是主力车型的等级，每个等级只有一款主力车型；城市特色车型按定员、运营成本与最高时速折算到同一等级，同一等级的性能与主力车相当，可以直接横向比较。D 型车是独立的 160 km/h 支线，不参与 T 级。升级目标只取主力车型。')));
    }
    // 车型一览：当年在售与以后开放的车型
    const ml = h('div', { class: 'fo-units' }), forced = F.autoUnlocked(g);
    for (const m of F.available(g.mapId, y).concat(F.upcoming(g.mapId, y))) {
      const on = m.from <= y, sale = on && (!forced || F.autoOnly(m));
      ml.appendChild(h('div', { class: 'fo-unit' + (sale ? '' : ' locked') },
        h('span', { class: 'fo-pic', html: F.sideSVG(m, '#2f6fa8', 60) }),
        h('div', { class: 'grow' }, h('div', { class: 'fo-name' }, h('b', null, F.nameOf(m)), h('span', { class: 'fo-tier ' + F.tierKind(m) }, F.tierChip(m))),
          h('small', null, '每节 ' + m.cap + ' 人 · 运营成本 ×' + m.ops.toFixed(2))),
        sale ? h('small', { class: 'good fo-st' }, '在售') : (on ? h('small', { class: 'muted fo-st' }, '已停售') : h('span', { class: 'fo-lock fo-st' }, ic('lock', 12), m.from + ' 年开放'))));
    }
    el.appendChild(h('div', { class: 'fl-h', style: { marginTop: '12px' } }, '车型一览'));
    el.appendChild(ml);
    el.appendChild(h('div', { class: 'note' }, '车型按城市与年代开放：开放当年 1 月会发出通知，已停产的车型不再列出。'));
    return { title: '车队', el: el };
  };
  const M_sort = function (ids) { return CM.Metro.sortIds(ids); };
})(window.CM);
