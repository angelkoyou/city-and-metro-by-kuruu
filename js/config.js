'use strict';
// 全局参数。PRD 中标注"待确认"的数值在此给出可调整的默认值（DEFAULT），评审确认后只需修改本文件。
(function (CM) {
  // 开局难度（v3.0）：四档预设 + 9 项可微调系数，每项 0.1–3 倍。旧存档没有 tune 字段时按档位预设。
  // 系数含义：
  //   funds    初始资金          grant   政府拨款           build   轨道与站台建设费
  //   demolish 拆迁补偿          ops     运营费用（车辆 + 车站）  train  列车购买费
  //   task     任务奖励          finance 融资额度           interest 融资利息
  // income 仍是「所有收入倍率」，只由困难档使用（保持 v2.5 的旧行为）。所有倍率只在经营挑战生效，自由建造资金不限。
  const DIFF = CM.Difficulty = {
    // v3.8：无限贷款从难度档解耦为独立开关（Economy#infLoan），难度档只剩四档经营 + 自由建造
    order: ['hard', 'normal', 'easy', 'beginner', 'free'],
    tiers: ['hard', 'normal', 'easy', 'beginner'],   // 可在设置里随时切换的经营档位（自由建造只在新开局选择）
    KEYS: ['funds', 'grant', 'build', 'demolish', 'ops', 'train', 'task', 'finance', 'interest'],
    META: {
      funds: { name: '初始资金', lo: 0.1, hi: 3, step: 0.05 },
      grant: { name: '政府拨款', lo: 0.1, hi: 3, step: 0.05 },
      build: { name: '轨道与站台建设费', lo: 0.1, hi: 3, step: 0.05 },
      demolish: { name: '拆迁补偿', lo: 0.1, hi: 3, step: 0.05 },
      ops: { name: '运营费用', lo: 0.1, hi: 3, step: 0.05 },
      train: { name: '列车购买费', lo: 0.1, hi: 3, step: 0.05 },
      task: { name: '任务奖励', lo: 0.1, hi: 3, step: 0.05 },
      finance: { name: '融资额度', lo: 0.1, hi: 3, step: 0.05 },
      interest: { name: '融资利息', lo: 0.1, hi: 3, step: 0.05 },
    },
    // 四档预设：切换档位时 9 个滑块回填为该档默认值，之后可继续微调（微调后档位显示「自定义」）
    // 预设刻意与 v2.5 的四档保持一致（困难只改收入、初始资金与融资额度；简单只加拨款；入门再加造价 -30% 与融资 +50%），
    // 其余新系数保持 1，需要的玩家再用滑块调整，这样旧存档读进来不会突然变贵或变便宜。
    levels: {
      hard: {
        name: '困难', income: 0.8,
        tune: { funds: 0.8, grant: 1, build: 1, demolish: 1, ops: 1, train: 1, task: 1, finance: 0.8, interest: 1 },
        desc: '所有收入 -20%；初始资金 -20%，融资额度 -20%',
      },
      normal: {
        name: '一般', income: 1,
        tune: { funds: 1, grant: 1, build: 1, demolish: 1, ops: 1, train: 1, task: 1, finance: 1, interest: 1 },
        desc: '标准收支，不改动任何数值',
      },
      easy: {
        name: '简单', income: 1,
        tune: { funds: 1, grant: 1.2, build: 1, demolish: 1, ops: 1, train: 1, task: 1, finance: 1, interest: 1 },
        desc: '政府补助 +20%，其余与一般相同',
      },
      beginner: {
        name: '入门', income: 1,
        tune: { funds: 1, grant: 1.3, build: 0.7, demolish: 1, ops: 1, train: 1, task: 1, finance: 1.5, interest: 1 },
        desc: '政府补助 +30%，轨道与站台成本 -30%，融资额度 +50%',
      },
      free: {
        name: '自由建造', income: 1, sandbox: 'free',
        tune: { funds: 1, grant: 1, build: 1, demolish: 1, ops: 1, train: 1, task: 1, finance: 1, interest: 1 },
        desc: '资金不限，没有失败条件；可选择起始年份与解锁全图',
      },
    },
    current: 'normal',
    tune: null,   // 当前生效的 9 项系数（null → 用档位预设）；读档与微调时写入
    normalize: function (id) { return Object.prototype.hasOwnProperty.call(DIFF.levels, id) ? id : 'normal'; },
    // 沙盒档位：仅 free = 资金不限（无限贷款是经济层开关，不再是档位）
    sandboxOf: function (id) { const L = DIFF.of(id == null ? DIFF.current : id); return L && L.sandbox ? L.sandbox : null; },
    isSandbox: function (id) { return !!DIFF.sandboxOf(id); },
    clamp: function (v) { return Math.min(3, Math.max(0.1, Math.round(Number(v) * 100) / 100)); },
    presetOf: function (id) {
      const L = DIFF.of(id), out = {};
      for (const k of DIFF.KEYS) out[k] = (L.tune && L.tune[k] != null) ? L.tune[k] : 1;
      return out;
    },
    // 切换档位：current 变化，同时把 9 项系数回填为该档预设（允许随后 setTune 微调）
    set: function (id) { DIFF.current = DIFF.normalize(id); DIFF.tune = DIFF.presetOf(DIFF.current); return DIFF.current; },
    // 读档 / 微调：直接写入一组系数；与某个预设完全一致时 current 跟到该档
    adopt: function (tune) { DIFF.tune = DIFF.normTune(tune); const m = DIFF.match(); if (m) DIFF.current = m; return DIFF.tune; },
    normTune: function (tune) {
      const out = {}, src = tune && typeof tune === 'object' ? tune : DIFF.presetOf(DIFF.current);
      for (const k of DIFF.KEYS) out[k] = (src[k] == null || !isFinite(src[k])) ? 1 : DIFF.clamp(src[k]);
      return out;
    },
    setTune: function (key, v) { if (DIFF.KEYS.indexOf(key) < 0) return null; DIFF.tune = DIFF.normTune(DIFF.tune); DIFF.tune[key] = DIFF.clamp(v); const m = DIFF.match(); if (m) DIFF.current = m; return DIFF.tune[key]; },
    get: function () { return DIFF.normalize(DIFF.current); },
    of: function (id) { return DIFF.levels[DIFF.normalize(id)]; },
    // 某档位 / 当前系数是否与预设一致；一致返回档位 id，否则 null（界面显示「自定义」）
    match: function (tune) {
      const t = DIFF.normTune(tune || DIFF.tune);
      // 自由建造的系数与「一般」完全相同，不能参与匹配，否则会被误判成一般档
      for (const id of DIFF.tiers) { const p = DIFF.presetOf(id); let same = true; for (const k of DIFF.KEYS) if (Math.abs(p[k] - t[k]) > 1e-9) { same = false; break; } if (same) return id; }
      return null;
    },
    isCustom: function () { return !DIFF.match(); },
    // 单项系数（未设置时为 1）
    // id 非空时通常是在查「另一个档位的预设」（文案、存档对比用）；但若 id 就是本局当前档位，
    // 必须回到实时 tune —— 玩家在设置里微调过系数后，经济/造价/车队等处才不会仍按预设计算。
    f: function (key, id) {
      if (id != null) {
        if (id === DIFF.current && DIFF.tune) return DIFF.f(key);
        const L = DIFF.of(id); return (L.tune && L.tune[key] != null) ? L.tune[key] : 1;
      }
      const t = DIFF.tune || DIFF.presetOf(DIFF.current);
      return (t[key] == null || !isFinite(t[key])) ? 1 : t[key];
    },
    tuneOf: function () { return DIFF.normTune(DIFF.tune); },
    // —— 各系统的倍率入口（旧方法名保留，语义改为「系数」） ——
    incomeMul: function (id) { return DIFF.of(id == null ? DIFF.current : id).income; },
    fundsMul: function (id) { return DIFF.f('funds', id); },
    grantMul: function (id) { return DIFF.f('grant', id); },
    buildMul: function (id) { return DIFF.f('build', id); },
    trackMul: function (id) { return DIFF.f('build', id); },   // 旧名：轨道与站台建设费倍率
    demolishMul: function (id) { return DIFF.f('demolish', id); },
    opsMul: function (id) { return DIFF.f('ops', id); },
    trainMul: function (id) { return DIFF.f('train', id); },
    taskMul: function (id) { return DIFF.f('task', id); },
    financeMul: function (id) { return DIFF.f('finance', id); },
    interestMul: function (id) { return DIFF.f('interest', id); },
    // 界面文案：统一用「档位名 + 百分比」；系数为 1 时返回空串，调用方自行决定是否显示
    pct: function (v) { const p = Math.round((v - 1) * 100); return (p > 0 ? '+' : '') + p + '%'; },
    grantLabel: function (id) { const v = DIFF.grantMul(id); return DIFF.of(id == null ? DIFF.current : id).name + '难度 拨款' + DIFF.pct(v); },
    costCutLabel: function (id) { const v = DIFF.buildMul(id); return DIFF.of(id == null ? DIFF.current : id).name + '难度 建设费' + DIFF.pct(v); },
    financeLabel: function (id) { return DIFF.of(id == null ? DIFF.current : id).name + '难度 融资额度' + DIFF.pct(DIFF.financeMul(id)); },
    interestLabel: function (id) { return DIFF.of(id == null ? DIFF.current : id).name + '难度 融资利息' + DIFF.pct(DIFF.interestMul(id)); },
    summary: function (id) {
      const t = DIFF.tuneOf(), out = [];
      for (const k of DIFF.KEYS) if (Math.abs(t[k] - 1) > 1e-9) out.push(DIFF.META[k].name + ' ×' + t[k].toFixed(2));
      return out;
    },
  };
  if (!DIFF.tune) DIFF.tune = DIFF.presetOf('normal');

  // v3.6：设置里可随时调整**本局**难度。初始资金只在开局确定，其余 8 项随时可改。
  DIFF.GAME_KEYS = DIFF.KEYS.filter(function (k) { return k !== 'funds'; });
  // 只改系数、不动档位（adopt 会因 match 改 current，进而改变收入倍率）。传部分补丁即可。
  DIFF.tuneGame = function (patch) {
    const t = DIFF.tuneOf();
    if (patch && typeof patch === 'object') for (const k of DIFF.KEYS) if (patch[k] != null) t[k] = DIFF.clamp(patch[k]);
    DIFF.tune = DIFF.normTune(t);
    return DIFF.tune;
  };
  // 本局的 8 项系数是否偏离该档预设（初始资金不参与比较）
  DIFF.gameCustom = function (level) {
    const p = DIFF.presetOf(DIFF.normalize(level || DIFF.current));
    for (const k of DIFF.GAME_KEYS) if (Math.abs(p[k] - DIFF.f(k)) > 1e-9) return true;
    return false;
  };
  // v3.6：开局 / 读档载入「指定档位 + 一组系数」。不能用 adopt：它的 match() 会在
  // 系数恰好等于另一档预设时把 current 改过去，令本局档位（收入倍率）与存档记录不符。
  DIFF.loadGame = function (level, tune) {
    const id = DIFF.normalize(level), base = DIFF.presetOf(id);
    if (tune && typeof tune === 'object') for (const k of DIFF.KEYS) if (tune[k] != null && isFinite(tune[k])) base[k] = DIFF.clamp(tune[k]);
    DIFF.current = id;
    DIFF.tune = DIFF.normTune(base);
    return DIFF.tune;
  };

  CM.CFG = {
    // 对外版本号：与 js/news.js 最新一条公告的「主.次」版本一致（verify-game 会校验）。
    // 规则修订号保持不变：存档结构与迁移路径没有变化，不必强制旧档备份。
    GAME_VERSION: '5.0',
    TRAFFIC_MODEL: 4,      // 轻量交通更新；与显示版本独立，确保 v3 存档仍触发安全迁移
    RULES_REVISION: 7,     // 存档升级门槛；版本号独立维护，改动不涉及存档结构时不要抬此值（会强制旧档备份）
    SAVE_FORMAT: 'city-metro-save',
    SAVE_VERSION: 2,
    SAVE_MIN_VERSION: 2,   // 1.1 起地图改为真实地理，旧版存档的城市数据与之不兼容

    // 地图：每格 250 m，168×144 格 ≈ 42 km × 36 km（v2.7 广佛同城，向西扩展 48 格）；交通小区 4×4 格（1 km²）
    W: 168, H: 144, CELL_M: 250, ZONE: 4,
    START: { y: 1990, m: 1, d: 1, minute: 6 * 60 },
    // 货币与价格基年（各地图在 maps.js 中替换）：内部金额单位为「万 + 本城货币」，票价为本城货币
    money: { code: 'CNY', unit: '元', wan: '万元', yi: '亿元', sym: '¥' },
    econBase: 1990,

    time: {
      secPerHour: 2.5,          // 1× 速度下，现实秒/游戏小时（一天 60 秒）
      speeds: [1, 3, 8, 24],    // 加速档位；24× 极速档约 13 分钟一个游戏年（含月结）
      visualPerSec: 24,         // 1× 下动态对象的"视觉时间"（游戏秒/现实秒），列车车辆按此运动
      visualMaxSpeed: 8,        // 列车、车辆与行人最多按 8× 表现：极速档只加快时钟，画面保持可看清
      nightFast: 4,             // 地铁停运的 00:00–06:00 时钟按所选速度的 4 倍掠过（设置「游戏」可关闭）
      peaks: [[420, 540], [1020, 1140]],   // 工作日早晚高峰（分钟）：开启「高峰慢放」时按 1× 运行
    },

    // 一天的出行时段（模型分时段计算）
    periods: [
      { key: 'AM', name: '早高峰', hours: [7, 8] },
      { key: 'MD', name: '日间平峰', hours: [6, 9, 10, 11, 12, 13, 14, 15, 16] },
      { key: 'PM', name: '晚高峰', hours: [17, 18] },
      { key: 'EV', name: '夜间', hours: [19, 20, 21, 22, 23, 0, 1, 2, 3, 4, 5] },
    ],
    // 小时出行分布（估算，归一化后使用）：工作日 / 周末（画面上车流、客流随时刻的变化）
    hourProfile: [0.3, 0.2, 0.1, 0.1, 0.2, 0.6, 2.5, 8.5, 9.5, 6.0, 5.0, 5.2, 5.0, 4.8, 4.9, 5.0, 5.6, 8.0, 9.0, 6.0, 4.2, 3.2, 2.0, 1.0],
    hourProfileWe: [0.4, 0.3, 0.15, 0.1, 0.15, 0.3, 0.9, 2.6, 4.4, 5.8, 6.6, 6.8, 6.6, 6.4, 6.5, 6.5, 6.4, 6.4, 6.0, 5.2, 4.2, 3.2, 2.2, 1.2],
    // 出行目的（v1.9 起）：hw 通勤、sc 上学、sh 购物与生活服务（含商务）、md 医疗、lz 旅游休闲、hb 交通枢纽接驳。
    // 工作日通勤出行率与非工作出行总量沿用 choice.workerRate / choice.hoRate；非工作出行按 choice.purposeShare 分为上学、购物、医疗、休闲。
    // 以下比例与倍数均为估算（参考城市居民出行调查的一般量级），不是某座城市的统计数据。
    trips: {
      keys: ['hw', 'sc', 'sh', 'md', 'lz', 'hb'],
      name: { hw: '通勤', sc: '上学', sh: '购物', md: '医疗', lz: '旅游休闲', hb: '枢纽接驳' },
      color: { hw: '#3468d6', sc: '#8e5bd6', sh: '#e8642c', md: '#d63a5a', lz: '#1aa266', hb: '#0f8fa8' },
      // 周末出行量相对工作日的倍数（双休日制度下）；周六仍上班、上课的年代按 workWeek 提高通勤与上学（见 sim.js weekendMult）
      weekend: { hw: 0.32, sc: 0.04, sh: 1.55, md: 0.55, lz: 2.1, hb: 1.12 },
      // 重要设施吸引比例的放大系数与各目的设施合计上限（v2.1 第二轮：设施出行需求偏少）
      facBoost: 1.25, facCap: 0.55,
      weekWeights: { wd: 5 / 7, we: 2 / 7 },   // 周平均：5 个工作日 + 2 个周末日
      // 各时段占该目的出行的比例 [AM, MD, PM, EV]：o 去程（家→目的地；枢纽为城市→车站/机场），r 返程
      split: {
        wd: {
          hw: { o: [0.70, 0.22, 0.03, 0.05], r: [0.02, 0.18, 0.62, 0.18] },
          sc: { o: [0.80, 0.17, 0.01, 0.02], r: [0.01, 0.45, 0.42, 0.12] },
          sh: { o: [0.05, 0.55, 0.15, 0.25], r: [0.02, 0.45, 0.20, 0.33] },
          md: { o: [0.25, 0.68, 0.04, 0.03], r: [0.04, 0.80, 0.10, 0.06] },
          lz: { o: [0.04, 0.50, 0.14, 0.32], r: [0.01, 0.36, 0.18, 0.45] },
          hb: { o: [0.16, 0.50, 0.12, 0.22], r: [0.12, 0.48, 0.14, 0.26] },
        },
        we: {
          hw: { o: [0.45, 0.38, 0.05, 0.12], r: [0.02, 0.30, 0.45, 0.23] },
          sc: { o: [0.80, 0.17, 0.01, 0.02], r: [0.01, 0.45, 0.42, 0.12] },
          sh: { o: [0.02, 0.68, 0.10, 0.20], r: [0.01, 0.50, 0.17, 0.32] },
          md: { o: [0.15, 0.78, 0.04, 0.03], r: [0.03, 0.82, 0.10, 0.05] },
          lz: { o: [0.03, 0.62, 0.10, 0.25], r: [0.01, 0.40, 0.17, 0.42] },
          hb: { o: [0.16, 0.50, 0.12, 0.22], r: [0.12, 0.48, 0.14, 0.26] },
        },
      },
      // 距离衰减：上学、购物、医疗、休闲相对 distDecayHO，枢纽接驳相对 distDecayHW
      decay: { sc: 0.55, sh: 1, md: 1.2, lz: 1.5, hub: 1.6 },
      // 地铁改善可达性带来的新增出行（只用于购物与休闲）：每节省 1 分钟广义出行时间增加 perMin，单个起讫点上限 cap；
      // 通勤、上学、医疗与枢纽接驳不产生新增出行（机场与铁路旅客量由外部给定）
      induced: { perMin: 0.006, cap: { sh: 0.10, lz: 0.15 } },
    },

    // 工作周制度（按地图替换）：sat 为周六仍需上班的比例，school 为周六仍需上课的比例（0–1）。
    // 中国内地：1994 年 3 月起隔周双休、1995 年 5 月起全面双休（史实）；比例为估算
    workWeek: { sat: [[1990, 1], [1994.1, 1], [1994.2, 0.5], [1995.3, 0.5], [1995.4, 0]], school: [[1990, 1], [1995.3, 1], [1995.4, 0]] },

    walk: {
      mPerMin: 75,              // 步行速度
      maxAccessM: 1125,         // 进出站最大步行距离（15 分钟）DEFAULT
      transferMaxM: 500,        // 站外换乘最大步行距离 DEFAULT
      cellExtraM: 60,           // 街道到建筑的平均附加距离
    },

    metro: {
      vmax: { underground: 22, surface: 19, elevated: 22 },  // m/s
      accel: 0.9, dwell: 30, turnaround: 150,
      latAccel: 0.8,            // 弯道横向加速度上限 → 弯道限速
      carCap: 310,              // 每节车厢定员
      // v3.3：新增巨型 / 枢纽型两档。站厅容量继续放大，但站台长度仍受 8 节编组限制（编组上限同为 8 节）
      carsBySize: { S: 4, M: 6, L: 8, XL: 8, XXL: 8, HUB: 8 }, // 列车编组受沿线最小站台限制；超大型及以上容量更高但编组上限同为 8 节
      fMin: [8, 6, 8, 4],       // 各时段最低发车频率（列/小时）DEFAULT
      fMax: 30,                 // 最小间隔 2 分钟
      targetLF: 0.85,
      // 车站每小时进出站+换乘能力 DEFAULT。v3.3：巨型 16 万、枢纽型 40 万（多线换乘 + 铁路 / 机场接驳）
      stationCap: { S: 15000, M: 35000, L: 70000, XL: 120000, XXL: 160000, HUB: 400000 },
      sizes: ['S', 'M', 'L', 'XL', 'XXL', 'HUB'],   // 规模顺序（升级 / 卡片 / 排序共用，避免各处写死档数）
      minSpacingM: 100,         // 独立车站最小间距；站外换乘仍按实际步行路径上限判断
      // 线形约束（参考城市轨道交通设计规范的量级，DEFAULT）
      minRadiusM: 250,          // 正线最小曲线半径：低于此值不允许
      warnRadiusM: 400,         // 低于此值需限速通过
      speedGrades: [
        { kmh: 40, minR: 100, warnR: 150, ops: 0.85, track: 0 },
        { kmh: 60, minR: 150, warnR: 250, ops: 0.92, track: 0 },
        { kmh: 80, minR: 250, warnR: 400, ops: 1, track: 0 },
        { kmh: 100, minR: 400, warnR: 650, ops: 1.12, track: 0.15 },
        { kmh: 120, minR: 600, warnR: 1000, ops: 1.25, track: 0.3 },
        // v3.0：160 km/h 高速轨道。最小转弯半径 1000 m，运营成本为基准（80 km/h）的 1.5 倍，
        // 造价附加 50%；只能用于站台规模 L / XL 的车站，且只有 D 型无人列车能跑（车型最高速度 160 km/h）。
        // 开放年份由车型决定：D 型车 2005 年上市，F.speedOpen 会自动把 160 报为「2005 年开放」。
        { kmh: 160, minR: 1000, warnR: 1400, ops: 1.5, track: 0.5 },
      ],
      // 160 轨道（v3.0）：线路级标记与默认票价（相对开局票价）；满意度只与「相对开局票价的倍数」挂钩
      std160: { key: '160', name: '160 轨道', unlock: 2005, sizeMin: ['L', 'XL', 'XXL', 'HUB'], fareX: 2, satFreeX: 1.5 },
      maxTurnAtStationDeg: 60,  // 车站前后线路方向最大偏转（站台为直线段）
      maxTurnArcDeg: 120,       // 圆弧线形（v2.6.1）的上限：弯道都在站台之外，能否通过由半径决定
      platformHalfM: 70,        // 站台直线段半长
      maxGrade: 0.03,           // 最大坡度（地下/地面/高架转换坡道）
      levelM: { underground: -15, surface: 0, elevated: 12 }, // 轨面高程（米）
      levelFactor: 0.6,         // 天地换乘：同站增设另一层站台按该建设方式车站造价的 60% 计（共用站厅与出入口）DEFAULT
      levelXferMin: 1.5,        // 天地换乘：进出非主站台层多走的垂直通道时间（分钟，上下车各计一次）DEFAULT
      sizeName: { S: '小型', M: '中型', L: '大型', XL: '超大型', XXL: '巨型', HUB: '枢纽型' },
      typeName: { underground: '地下', surface: '地面', elevated: '高架' },
      height: { underground: -0.11, surface: 0.0, elevated: 0.075 }, // 视觉高度（格）
    },

    // 建设成本（万元，1990 年价格，按年上涨）DEFAULT
    cost: {
      trackPerKm: { underground: 30000, surface: 6000, elevated: 12000 },
      riverPerKm: { underground: 22000, surface: 16000, elevated: 16000 }, // 越江隧道 / 跨江桥梁 附加
      hillPerKm: 12000,         // 山体隧道附加
      envTrack: 0.35, envStation: 0.5, // 景区轨道 / 车站的环境保护附加费
      protectedPerKm: 6000,     // 保护建筑下方隧道加固附加
      // 跨越地面铁路（每处）：按本城单价折算的等效长度（km）。地下线下穿需加固与监测，高架线需上跨铁路的大跨度桥
      railCrossKm: { underground: 0.25, elevated: 0.35 },
      // XL 造价按各档 L/M 的比值等比外推（地下 1.6 → 64000，高架 1.54 → 31000，地面 1.5 → 18000）
      // v3.3：巨型 / 枢纽型沿用同一比值继续外推（地下 ×1.6、高架 ×1.55、地面 ×1.5），不另立口径
      station: {
        underground: { S: 15000, M: 25000, L: 40000, XL: 64000, XXL: 102400, HUB: 163800 },
        elevated: { S: 8000, M: 13000, L: 20000, XL: 31000, XXL: 48050, HUB: 74500 },
        surface: { S: 5000, M: 8000, L: 12000, XL: 18000, XXL: 27000, HUB: 40500 },
      },
      upgradeFactor: 1.2,
      // 预留站（v2.8.2）：只征地、不建站体，建筑费与维护费按正式站的这一比例计；
      // 拆迁补偿、环保与古建保护费仍按正式站标准收，升级时补足差价即可
      reservedRatio: 0.2,
      demolishPerCell: 30000,   // 拆迁一个完全开发街区的费用（按开发强度折算）
      demolishFactor: {
        track: { underground: 0, surface: 0.7, elevated: 0.18 },
        station: { underground: 0.25, surface: 0.8, elevated: 0.6 },
      },
      freeMoveM: 250,           // 车站移动不超过此距离免费 DEFAULT
      freeLengthM: 300,         // 线形调整导致增长不超过此值免费 DEFAULT
      relocationFactor: 0.5,    // 大范围搬迁按新站造价比例收费
      inflation: 0.035,
    },

    ops: {
      carKmCost: 0.0009,        // 万元/车厢公里（≈9 元）
      stationDaily: { S: 1.5, M: 2.6, L: 4.5, XL: 7.8, XXL: 13.5, HUB: 23.4 }, // 万元/天；XL 及以后按相邻档 1.733 的比值等比外推
      serviceHours: 18,
      inflation: 0.04,
    },

    // 开局票价（元/次，换乘不另收费）：统一票价，或按里程计费时的起步价；滑块范围与步长 DEFAULT
    fareDefault: { mode: 'flat', flat: 2 },
    // 按里程计费的默认参数（新开局）：起步价含 km0 公里，之后每 step 公里加价 inc（起步价的倍数），封顶 cap（起步价的倍数）
    fareDist: { km0: 6, step: 6, inc: 0.5, cap: 2.5 },
    // scale：滑块上限与步长随物价放大（v2.6.1 起各图都有，否则票价跟不上物价）
    fareRange: { min: 0, max: 10, step: 0.1, scale: true },

    choice: {
      theta: 0.065,             // Logit 灵敏度（1/分钟）
      // 票价敏感度（v2.6.1，见 Model.fareMinutes）：票价与「物价参考票价」之比每翻一倍约多 fareSens × 0.69 分钟；超过参考票价后再加 fareOver × ln²，越贵越难接受
      fareSens: 10.8, fareOver: 25,
      walkW: 1.6, waitW: 1.5,
      transferPen: 4, outTransferPen: 6,
      carAccess: 4,             // 停车与取车附加分钟
      // 以下为估算曲线：[年份, 值]
      vot: [[1990, 2.5], [1995, 5], [2000, 9], [2005, 14], [2010, 22], [2015, 32], [2020, 42], [2030, 58], [2050, 80]], // 元/小时
      carCostPerKm: [[1990, 0.40], [2000, 0.60], [2010, 0.85], [2020, 1.0], [2050, 1.2]],
      parking: [[1990, 0.5], [2000, 2], [2010, 6], [2020, 9], [2050, 12]],
      occupancy: [[1990, 3.4], [1995, 2.8], [2000, 2.3], [2005, 1.9], [2010, 1.6], [2020, 1.45], [2050, 1.4]],
      hoRate: [[1990, 0.16], [2000, 0.26], [2010, 0.38], [2020, 0.45], [2050, 0.5]],
      workerRate: [[1990, 0.36], [2000, 0.40], [2010, 0.43], [2050, 0.45]],
      distDecayHW: [[1990, 4.5], [2000, 6], [2010, 8], [2030, 9.5]], // km
      distDecayHO: [[1990, 2.8], [2010, 4], [2030, 5]],
      // 非工作出行中上学、医疗、休闲所占比例（其余为购物与生活服务）：少子化使上学比例下降，老龄化使就医比例上升（估算）
      purposeShare: {
        sc: [[1990, 0.30], [2000, 0.26], [2010, 0.21], [2020, 0.19], [2050, 0.16]],
        md: [[1990, 0.06], [2010, 0.07], [2030, 0.09], [2050, 0.10]],
        lz: [[1990, 0.24], [2010, 0.33], [2030, 0.36], [2050, 0.37]],
      },
    },

    road: {
      // 等级：1 支路 2 次干道 3 主干道 4 快速路
      cap: [0, 0, 1700, 3200, 5600],  // 单向小时通行能力（车/小时）
      speed: [0, 15, 28, 38, 65],     // 自由流速度 km/h
      bprA: 0.15, bprB: 4,
      // 系统道路改造（拓宽、信号优化、立交）带来的通行能力增长系数（估算）
      capGrowth: [[1990, 1.0], [1995, 1.25], [2000, 1.6], [2005, 2.0], [2010, 2.4], [2020, 2.9], [2040, 3.3]],
    },

    economy: {
      startFunds: 300000,       // 经营挑战初始资金 30 亿元 DEFAULT
      grantBase: [[1990, 15000], [2000, 32000], [2010, 70000], [2020, 110000], [2050, 180000]], // 万元/月
      debtLimit: -200000,       // 负债下限（随通胀调整）DEFAULT
      // 债券融资（仅经营挑战）：3 年期年利率按发行年份插值并在发行时固定，6 年期另加 term6；
      // 年度发行额度与总债务上限 = 当年基础月拨款 × 月数（随城市与年代变化）。城投债利率 = 地方债 + spread
      bonds: {
        local: { rate: [[1990, 0.085], [1996, 0.075], [2000, 0.045], [2008, 0.04], [2015, 0.035], [2020, 0.032], [2050, 0.03]], quotaMonths: 6, capMonths: 30 },
        ct: { spread: 0.02, quotaMonths: 4, capMonths: 18 },
        term6: 0.004,
      },
      negMonthsLimit: 24,       // 连续负余额月数上限 DEFAULT
      satFail: 25, satFailMonths: 12,
      startSat: 60,
      failGrantFactor: 0.85, failGrantMonths: 12, failSat: -6,
      failDynGrantFactor: 0.92, failDynMonths: 6, failDynSat: -3,   // 动态任务未完成（v2.3 平衡）：较历史任务轻
      grantModFloor: 0.7,   // 多项任务未完成叠加时拨款系数的下限（v2.3 由 0.6 提高）
    },

    growth: {
      // v2.1 地图扩大后包含番禺市桥、钟村、南村与白云嘉禾、均禾一带（估算：1990 年约增加 45 万人，2020 年约增加 140 万人）
      popCurve: [[1990, 3.28e6], [1995, 3.9e6], [2000, 4.85e6], [2005, 5.95e6], [2010, 7.3e6], [2015, 8.2e6], [2020, 9.1e6], [2030, 10.0e6], [2045, 10.8e6], [2070, 11.4e6], [2300, 11.9e6]],
      histEnd: 2020,            // 此后为模拟增长
      jobsRatio: [[1990, 0.50], [2000, 0.53], [2010, 0.56], [2030, 0.58]],
      metroBoostMax: 0.06,
    },

    // 地铁对城市的反作用（v2.3 玩家反馈，各地图通用，不随地图替换）
    // habit 出行习惯：车站开通后，周边居民的出行习惯在约 years 年内逐步转向地铁——对地铁的偏好最多相当于 asc 分钟；
    // 留下的非地铁出行里最多 carLite 改为步行、公交接驳等，不再开车上路。两端都在成熟车站周边时取满值，一端时取一半；
    // 随每月的交通求解一起更新，不额外计算
    habit: { years: 4, asc: 8, carLite: 0.15 },
    // metroLed 地铁带动发展：每座运营车站对半径 radius 格内产生吸引，强度 = base + 每多一条线 xfer + 客流（flowFull 人次/日取满）flow
    // + 车站商业开发 tod[等级]，开通后约 years 年形成。线网成熟度按地铁覆盖比例（cov0 起、cov1 满）：成熟度越高，车站吸引的权重
    // 越大（wMin → 1），历史阶段预设的片区增长权重越弱（flatten），车站周边可容纳的人口 / 岗位也提高（capR / capJ）。只重新分配增长，不改变全城总量
    // v3.3：第 4、5 级 TOD 的带动权重继续按既有比例上调（片区综合体、枢纽上盖的吸引范围更大）
    metroLed: { radius: 4, years: 4, base: 0.3, xfer: 0.5, flow: 0.6, flowFull: 60000, tod: [0, 0.15, 0.4, 0.8, 1.25, 1.9], cov0: 0.08, cov1: 0.45, wMin: 0.25, res: 1.0, jobs: 1.8, flatten: 0.6, capR: 0.35, capJ: 0.9 },
    // fixedManual：固定手动存档位数量（另有 1 个自动存档专用位）；maxManual 仅供旧版动态槽兼容使用
    saves: { prefix: 'cm1.', fixedManual: 3, maxManual: 12 },
    // 动态对象上限（代表性展示）：汽车、车站行人、街道行人、列车上下车乘客（每帧）；声音：列车声部与同时播放的环境短音
    perf: { solverInputMs: 1.5, solverBudgetMs: 5, solverBudgetMaxMs: 10, frameTargetMs: 13, jumpSliceMs: 10, jumpRenderMs: 250, chunkBudgetMs: 6, sharpBudgetMs: 8, movingBudgetMs: 3, prefetchMs: 2, warmBudgetMs: 10, cacheMaxPx: 24e6, maxCars: 320, maxPeds: 180, maxWalkers: 120, maxRiders: 120, trainVoices: 3, maxOneShots: 6 },
  };
})(window.CM);
