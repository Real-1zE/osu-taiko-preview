/* ==========================================================================
 * layout.js —— 预览图布局引擎（与 layout.py 逻辑一致）
 *
 * **核心模型（由工作区样例图 4665965-1.png 实测反推）**
 *
 * 样例图不是「音符贪心找空行」，而是**按时间窗口逐行排布**：
 *
 * * X 轴 = 时间，线性映射，像素/秒 pixelsPerSecond
 *   实测 x 间距 115px ↔ 时间间隔 273ms（一拍 @220BPM）→ 约 421 px/s
 * * **一行 = 一个固定的时间窗口**，窗口长度
 *   T = (maxWidth - 2*marginX) / pixelsPerSecond
 *   第一行排完 0~T，第二行排 T~2T，依次向下
 *   （即「一行一行，第一行排完排第二行」）
 * * 行内同一时刻若有多个音符（大饼等），用**子行**向下叠放，
 *   子行步长 = 音符直径（实测行内子行间距 30px）
 * * 因此行号随时间**单调递增**，先出现的键一定在上面；
 *   预览线 / BPM 线 / 小节线都只在自己所属的那一行内绘制，高度仅一行。
 * ========================================================================== */

/* 小节对齐模式：每行放多少个小节。样例图 Shakunetsu（250 BPM 恒定）约 4 个/行。
   须与 layout.py 的 MEASURES_PER_ROW 一致。
   注意：本常量必须声明在 DEFAULTS **之前** —— DEFAULTS.measuresPerRow 直接引用它，
   写在后面会触发 const 的暂时性死区（TDZ）报错。 */
export const MEASURES_PER_ROW = 4;

export const DEFAULTS = {
  /* 由样例图实测标定 */
  /* 由样例图 4665965-1.png 精确实测标定：
     音符白环直径 40px；条纹周期 160px = 2 行，条高 52px，以偶数行音符居中 */
  noteDiameter: 34,      // 音符外环直径（略缩小 10%，不顶满轨道）
  rowHeight: 80,         // 主行距
  subRowHeight: 34,      // 子行步长
  /* 每行都有一条轨道；轨道高 56px 容纳 40px 音符并上下各留 8px，
     行间只留 16px 短空隙（此前 period=2 会让奇数行落在空隙里） */
  stripePeriod: 1,       // 每行一条轨道
  stripeHeight: 50,      // 轨道高度
  marginX: 60,
  paddingTop: 40,
  paddingBottom: 40,
  maxWidth: 1920,        // 一行的宽度 = 单张图宽度
  headerHeight: 260,
  pixelsPerSecond: 421,  // 像素/秒；<=0 时按 targetRows 反推
  targetRows: 0,         // >0 时据此反推 pixelsPerSecond
  maxRowsPerPage: 0,     // >0 时纵向分页
  /* 小节对齐模式：让每行放整数个小节，小节线在各行对齐（节拍固定的谱）。
     仅在 pixelsPerSecond <= 0 时生效；显式指定密度时不覆盖。
     measuresPerRow <= 0 时回退到模块常量 MEASURES_PER_ROW。*/
  alignMeasures: true,
  measuresPerRow: MEASURES_PER_ROW,
  /* 密集行额外标签层的高度。<=0 时用模块常量 LABEL_LINE_H。
     紧凑模式下要跟着音符一起缩小，否则 14px 的标签层比音符还高。*/
  labelLineH: 0,
};

/* 自动密度的舒适区间（像素/秒，画布逻辑宽度下）。
   下限不能太高：基础密度（约 400）乘显示折算系数（窄容器 ~0.5）后
   会掉到 200 以下，全被夹到下限就失去了"按尺寸自适应"的意义。
   真正的下限作用是"别太疏"，取 240。*/
export const MIN_PPS = 240;
export const MAX_PPS = 560;

/* ---- 紧凑模式（浏览器小窗用）--------------------------------------- *
 * 小窗只有几百 px 宽，网页版那套 34px 音符 / 60px 边距会导致
 * 「一行连一个完整小节都放不满」。这里按可用宽度等比缩小几何量，
 * 并让每行小节数在 3~4 之间自适应。
 *
 * 关键量是**16分音符的横向间距**：
 *   一小节= meter 拍，每拍 4 个 16分=>  每行 16分数 = mpr × meter × 4
 *   间距 = usable / (mpr × meter × 4)          （与 BPM 无关）
 * 音符直径取间距的 ~0.85 倍：既能看清又不互相压盖。
 * ------------------------------------------------------------------ */

/** 每行放几个小节：宽度够就 4 个，窄了退到 3 个（再窄就 3 个封顶）。 */
export function fitMeasuresPerRow(usable) {
  if (usable >= 780) return 4;
  return 3;
}

/**
 * 按可用宽度算出一套紧凑几何量，覆盖到 cfg 上。
 *
 * @param {object} cfg 会被就地修改（Object.assign）
 * @param {number} width 画布逻辑宽度
 * @returns {object} cfg 便于链式使用
 */
export function applyCompact(cfg, width) {
  const marginX = width >= 1500 ? 48 : width >= 1000 ? 36 : 26;
  const usable = Math.max(120, width - marginX * 2);
  const mpr = fitMeasuresPerRow(usable);
  const meter = 4;                                  /* 绝大多数谱是 4/4 */
  const gap = usable / (mpr * meter * 4);          /* 16分音符间距 */
  /* 音符直径：取间距的 ~0.85 倍，既能看清又不互相压盖。
     下限 8px —— 再小就看不出是红饼还是蓝饼了；
     上限 34px，与网页版一致。*/
  const d = Math.max(8, Math.min(34, Math.round(gap * 0.85)));
  Object.assign(cfg, {
    maxWidth: width,
    marginX,
    measuresPerRow: mpr,
    noteDiameter: d,
    /* 行高/ 轨道高 / 子行步长全部跟着音符直径走，
       否则音符缩小后轨道仍是 50px，一行还是塞不下几个音。*/
    rowHeight: Math.max(26, Math.round(d * 2.1)),
    stripeHeight: Math.max(15, Math.round(d * 1.45)),
    subRowHeight: Math.max(8, Math.round(d * 0.62)),
    /* 标签层也要缩：12px 字体在紧凑几何里比音符还高 */
    labelLineH: Math.max(8, Math.round(d * 0.42)),
    paddingTop: 26,
    paddingBottom: 26,
  });
  return cfg;
}

/**
 * 拖入谱面时**自动挑选**像素密度。
 *
 * 目标只有一个：**让每行放整数个小节，各行小节线对齐**。
 *密度 = usable / (N × 主小节时长)。用户验收标准是「第1 行的小节号接第 2 行」，
 * 任何「为了视觉更松/更紧而折算密度」的做法都会破坏它——
 * 之前按显示宽度乘 shrink，把 469 拉成 240，每行 7.81 个小节，全盘失效。
 *
 * 所以这里**不做任何折算**，直接用对齐值。
 * 容器窄只是显示时被等比缩小，逻辑布局不受影响；
 * 想更松/更紧由用户拖滑块决定（手调优先）。
 *
 * @param {object} bm谱面
 * @param {object} cfg 布局配置
 * @param {number} preferRows 保留参数（未用，避免调用方改签名）
 * @param {number} displayWidth 保留参数（未用）
 */
export function autoPixelsPerSecond(bm, cfg, preferRows, displayWidth) {
  void preferRows; void displayWidth;
  /* 首选小节对齐值 */
  const aligned = alignPixelsPerSecond(bm, cfg);
  if (aligned > 0) return aligned;
  /* 退而求其次：按行数均分（至少保证不越界） */
  const tEnd = maxEnd(bm);
  if (tEnd > 0) {
    const durS = tEnd / 1000;
    const rows = Math.max(1, preferRows || Math.round(durS / 12));
    return Math.min(MAX_PPS, Math.max(MIN_PPS, usable_(cfg) / (durS / rows)));
  }
  return 421;
}

function usable_(cfg) { return cfg.maxWidth - cfg.marginX * 2; }

export function fitPixelsPerSecond(bm, cfg) {
  const durS = Math.max(maxEnd(bm), 1) / 1000;
  const usable = cfg.maxWidth - cfg.marginX * 2;
  return usable / (durS / Math.max(cfg.targetRows, 1));
}

/**
 * 反推「每行时间窗口」：让小节线在各行边界处对齐。
 *
 * 动机：节拍固定的谱（如 BPM 恒为 250），若每行窗口不是小节时长的
 * 整数倍，小节线就会在行内不断漂移，样例图里各行小节线是对齐的。
 *
 * 做法：**每行 = 固定数量的小节**（cfg.measuresPerRow），而不是"总行数 × 小节"。
 * 这样每行的小节数恒为整数，与整曲长度无关；行数由谱长自然决定。
 *
 * @returns {number|null} pxPerMs；无法判定时返回 null
 */
export function alignPixelsPerSecond(bm, cfg) {
  const measureMs = dominantMeasureMs(bm);
  if (!measureMs || measureMs <= 0) return null;
  const usable = cfg.maxWidth - cfg.marginX * 2;
  const perRow = (cfg.measuresPerRow > 0) ? cfg.measuresPerRow : MEASURES_PER_ROW;
  /* 注意单位：measureMs 是毫秒，要换成秒再除（否则差 1000 倍） */
  const rowSec = (measureMs * perRow) / 1000;
  return usable / rowSec;
}

/**
 * 主小节时长（ms）：取谱面中**出现次数最多**的小节时长。
 *
 * 不能用平均值 —— 变速谱的平均值往往不对应任何实际小节；
 * 众数才代表「主要节拍」。极端 BPM 标记（beatLength<=2，对应
 * 30000+ BPM）必须排除，否则会把结果带偏（见 EXTREME_BEAT_LENGTH）。
 *
 * @returns {number|null} 小节时长（ms），无有效红线时返回 null
 */
export function dominantMeasureMs(bm) {
  let origin = 0, beatLen = 0;
  const counts = new Map();
  for (const tp of bm.timingPoints) {
    if (!tp.red || !(tp.beatLength > 0)) continue;
    /* 跳过极端 BPM 标记（它们时长极短，会污染统计） */
    if (tp.beatLength <= EXTREME_BEAT_LENGTH) continue;
    if (!beatLen) { origin = tp.time; beatLen = tp.beatLength; }
    const meter = tp.meter > 0 ? tp.meter : 4;
    const key = Math.round(tp.beatLength * meter * 100) / 100;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  if (!counts.size) return null;
  let best = null, bestN = -1;
  for (const [k, n] of counts) {
    if (n > bestN || (n === bestN && best !== null && k > best)) {
      best = k; bestN = n;
    }
  }
  void origin;
  return best;
}

export function maxEnd(bm) {
  let end = 0;
  for (const n of bm.notes) {
    const e = (n.kind === "roll" || n.kind === "spinner") ? n.endTime : n.time;
    if (e > end) end = e;
  }
  return end;
}

/* ---------- 辅助：变化点 ---------- */

/**
 * 极端 BPM 标记的 beatLength 阈值。
 *
 * osu! 谱面里 beatLength 极小（通常 1.0 / 2.0，对应 60000 / 30000 BPM）
 * 的红线不是正常 tempo，而是一种「无限/极高 BPM」标记，常用于制谱者标记
 * 特殊位置（切拍、 gimmick 切换）。
 *
 * 判别不能只看 beatLength 大小，还要看**孤立性**：这种标记前后往往 1~2ms
 * 就恢复正常 beatLength。若把这类点当普通红线，一行内会出现上百条红线，
 * BPM 数字必然叠字糊成一片。
 *
 * 实测：Feryquitous - Ai C [Illumination] 有 508 条这样的标记
 * （bl=2.0 共 449 条、bl=1.0 共 59 条），占全部 2928 条红线的 17%。
 */
export const EXTREME_BEAT_LENGTH = 2.0;

/** 是否为「极端 BPM 标记」：beatLength 极小且前后孤立 */
function isExtremeBpmMark(tp, prevTp, nextTp) {
  if (!(tp.beatLength > 0) || tp.beatLength > EXTREME_BEAT_LENGTH) return false;
  const lo = EXTREME_BEAT_LENGTH;
  /* 前后邻点都存在且 beatLength 明显更大 -> 孤立标记 */
  const prevNormal = prevTp && prevTp.beatLength > lo;
  const nextNormal = nextTp && nextTp.beatLength > lo;
  return prevNormal && nextNormal;
}

/**
 * 收集红线 tempo 变化。
 *  - 跳过孤立的极端 BPM 标记（bl<=2 前后孤立），它们不代表真实 tempo
 *  - 仍保留在 BPM 区间统计之外，需要原始信息时用 timingPoints
 *  - 剩余点按 BPM 变化去重
 */
export function bpmChanges(bm) {
  const reds = bm.timingPoints.filter(tp => tp.red && tp.beatLength > 0);
  const out = [];
  let cur = null;
  for (let i = 0; i < reds.length; i++) {
    const tp = reds[i];
    if (isExtremeBpmMark(tp, reds[i - 1], reds[i + 1])) continue;
    const bpm = 60000 / tp.beatLength;
    if (cur === null || Math.abs(bpm - cur) > 1e-6) { out.push([tp.time, bpm]); cur = bpm; }
  }
  return out;
}

/** 统计被跳过的极端 BPM 标记数量（供 UI 提示用） */
export function extremeBpmCount(bm) {
  const reds = bm.timingPoints.filter(tp => tp.red && tp.beatLength > 0);
  let n = 0;
  for (let i = 0; i < reds.length; i++) {
    if (isExtremeBpmMark(reds[i], reds[i - 1], reds[i + 1])) n++;
  }
  return n;
}

export function svChanges(bm) {
  /* ★ 非原生 taiko（std/catch/mania）：ScrollSpeed 来自转换器的后处理
     ——「滑条速度变化 -> scroll speed 变化」，落点在**滑条起始时间**，
     而不是 timing point 的绿线位置（见 osu_parser.buildConvertedScrollPoints）。
     用错的话读谱画面上的 SV 标记会与实际滚动速度完全对不上。*/
  if (bm.scrollPoints && bm.scrollPoints.length) {
    return bm.scrollPoints.map((p) => [p[0], p[1]]);
  }
  const out = [];
  let cur = null;
  for (const tp of bm.timingPoints) {
    if (tp.red) continue;
    const sv = tp.sv;          /* 解析时已存为100/|beatLength| */
    if (sv <= 0) continue;
    if (cur === null || Math.abs(sv - cur) > 1e-9) { out.push([tp.time, sv]); cur = sv; }
  }
  return out;
}

/**
 * 小节线列表：[[时间ms, 小节序号]]，小节序号从 1 开始。
 * 每 `meter` 拍一小节（taiko 通常为 4）。
 *
 * **历史 bug**：曾写成 `t = cur + step * beatLen`，而 cur 每轮又被更新为 t，
 * 于是 step*beatLen 被反复叠加，小节线间隔越来越长
 * （0 / 2.7s / 9.8s / 21s ...），391 秒只画出 14 条。
 *
 * 正确：维护一个**只前进不累加乘积**的游标，每次 cur += beatLen。
 */
/** 第一条红线的拍长（毫秒/拍），作为「停顿」阈值的基准 */
function redBeatLength(bm) {
  const r = bm.timingPoints.find(tp => tp.red && tp.beatLength > 0);
  return r ? r.beatLength : 500;
}

export function measureTimes(bm, limitMs, startMs = 0, rebase = false) {
  /* 规则：每条红线本身是新拍长下的第一拍，
     从红线时刻起按 `meter` 拍一小节；两条红线之间沿用后一条红线的拍长。
     （历史 bug：不按红线分段会导致 BPM 变化后小节线逐段偏移，
       Frost Walker 在 t=150527 处偏差达 1161ms）*/
  const reds = bm.timingPoints
    .filter(tp => tp.red && tp.beatLength > 0)
    .sort((a, b) => a.time - b.time);
  if (!reds.length) return [];

  /* ★★★ 循环预算 —— 防「一条极小拍长的红线独占一整段」导致死循环。
   *
   * 起因：1419088 Camellia - Bad Sweets, Bad Dreams [Too Bad, dont play]
   *（bid 2923535）里有3 条脏红线，其中一条 beatLength = 6e-87（浮点下溢）。
   * 下面这个 `while (t < segEnd) t += beatLen * meter` 在那种拍长下
   * 要循环 **10^52 次** —— 不是「慢」，是永远跑不完，
   * 主线程被占死，整个浏览器跟着卡住。
   *
   * ★★ 为什么**不能**靠「拍长绝对值」来判断该不该丢：
   *   短拍长的红线在真实谱面里非常常见，而且是**无害**的：
   *     · Otsukimi PARTY HARD 有 101 条 bl ∈ {0.25, 0.4, 0.063} 的红线，
   *       但它们只出现在**同一时刻**（距相邻红线 1~20ms），
   *       `while` 只跑 1~50 次就退出 —— 一条谱面里可能有上百条这种红线，
   *       按绝对阈值会把它们全丢掉，SR 从 7.22 掉到 6.90。
   *   · INTERNET OVERDOSE 的 `bl=1E+15` 同理，只与相邻红线挨着几毫秒。
   *
   *   真正致命的**只有一个条件**：这条红线在自己那一整段里
   *   要循环「多到没有意义」。所以判据是**本段的预计循环次数**，
   *   而不是拍长的绝对值：
   *
   *     预计次数 = (segEnd - tp.time) / (beatLen * meter)
   *
   *   超过 BUDGET（本谱整首小节数的 8 倍，下限 10000）就跳过本段，
   *   仍然把红线起点那一拍记下来 —— 那一拍是真实存在的。
   *   保留数据 + 限制循环，比「丢弃合法数据」正确得多。
   */
  const BUDGET = Math.max(10000, reds.length * 8);

  const out = [];
  let measureNo = 0;
  let baseNo = null;/* rebase 基准 */
  for (let ri = 0; ri < reds.length; ri++) {
    const tp = reds[ri];
    const beatLen = tp.beatLength;
    const meter = Math.max(1, tp.meter | 0 || 4);
    let t = tp.time;                    /* 游标从红线时刻起算 */
    const segEnd = (ri + 1 < reds.length) ? reds[ri + 1].time : limitMs;

    /* 本段预计要循环多少次（用于预算判断，不实际执行）*/
    const stepMs = beatLen * meter;
    const segSpan = segEnd - tp.time;
    if (!(stepMs > 0) || segSpan / stepMs > BUDGET) {
      /* 步长为 0 或循环次数失控：只记红线那一拍，跳过整段。*/
      if (t >= startMs && t <= limitMs) {
        if (rebase) {
          if (baseNo === null) baseNo = measureNo;
          out.push([Math.round(t), measureNo - baseNo + 1]);
        } else {
          out.push([Math.round(t), measureNo + 1]);
        }
      }
      measureNo++;
      continue;
    }

    while (t < segEnd - 1e-6) {
      if (t >= startMs && t <= limitMs) {
        if (rebase) {
          if (baseNo === null) baseNo = measureNo;
          out.push([Math.round(t), measureNo - baseNo + 1]);
        } else {
          out.push([Math.round(t), measureNo + 1]);
        }
      }
      measureNo++;
      t += stepMs;                     /* 直接跳到下一小节 */
    }
  }
  return out;
}

/**
 * 过滤「左右相邻的 SV 变化点之间没有任何物件」的绿线。
 * 连续渐变 SV 谱面（Frost Walker 有 2000+ 条）里大部分区间空无一物，
 * 画出来只是噪声。
 */
export function filterUsefulSV(marks, bm, t0, tEnd) {
  if (!marks.length) return [];
  const times = bm.notes.map(n => n.time).sort((a, b) => a - b);
  const bounds = [t0, ...marks.map(m => m[0]), tEnd];
  const out = [];
  for (let i = 0; i < marks.length; i++) {
    const lo = bounds[i], hi = bounds[i + 1];
    /* 二分找区间内第一个 > lo 的音符 */
    let a = 0, b = times.length;
    while (a < b) { const m = (a + b) >> 1; if (times[m] <= lo) a = m + 1; else b = m; }
    if (a < times.length && times[a] < hi) out.push(marks[i]);
  }
  return out;
}

/**
 * 时间线：每隔 stepMs 一条（默认 30 秒），标签形如 "0:30" / "1:00"。
 * 以预览起点对齐（t0 本身不画线，从下一个整刻度开始）。
 */
/**
 * 把 SV 变化点按「物件是否连续」分组，标记每条是否需要显示完整数值。
 *
 * 规则：
 *  - 相邻物件间隔 >= gapMs（建议取一拍；实测 Frost Walker 连续段内
 *    间隔 45~136ms，真停顿 >= 273ms = 整一拍）处断开，各自成段
 *  - 每段首尾保留完整数值；段内中间项若整数位与首尾一致则省略（.04）
 */
export function groupSvMarks(marks, bm, gapMs) {
  if (!marks.length) return [];
  const n = marks.length;

  /* 判据是**绿线之间的 dt**：实测连续段内 68ms，间隔处 >= 204ms */
  const segStart = new Array(n).fill(true);
  for (let i = 0; i < n - 1; i++) {
    segStart[i + 1] = (marks[i + 1][0] - marks[i][0]) < gapMs;
  }

  const out = [];
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && segStart[j + 1]) j++;
    if (i === j) {
      out.push([marks[i][0], marks[i][1], true]);
    } else {
      const headInt = Math.trunc(marks[i][1]);
      const tailInt = Math.trunc(marks[j][1]);
      for (let k = i; k <= j; k++) {
        if (k === i || k === j) out.push([marks[k][0], marks[k][1], true]);
        else {
          const same = Math.trunc(marks[k][1]) === headInt &&
                        Math.trunc(marks[k][1]) === tailInt;
          out.push([marks[k][0], marks[k][1], !same]);
        }
      }
    }
    i = j + 1;
  }
  return out;
}

export function minuteMarks(t0, tEnd, stepMs = 30000) {
  const out = [];
  if (!(stepMs > 0)) return out;
  for (let k = (Math.floor(t0 / stepMs) + 1); ; k++) {
    const t = k * stepMs;
    if (t >= tEnd) break;
    if (t > t0) {
      const totalSec = Math.floor(t / 1000);
      out.push([t, Math.floor(totalSec / 60) + ":" +
                   String(totalSec % 60).padStart(2, "0")]);
    }
  }
  return out;
}

/* ==========================================================================
 * 行高与标签堆叠
 *
 * 背景：压力测试谱面（Feryquitous - Ai C）存在一行 80+ 条红线的情况，
 * 单层标签横向摊不开，必然叠字。做法是给这类行**加高**，让标签能纵向堆叠。
 *
 * 关键：行高公式必须与 renderer / app 的 rowHeightOf 完全一致，
 * 否则竖线位置、轨道位置、播放线位置会全部错位。
 * ========================================================================== */

/** 标签行高（px）：12px 字体 + 2px 上下留白 */
export const LABEL_LINE_H = 14;

/* 100px 窗口内容纳的标签数。

   关键：所需层数**不能按标签总数算，必须按局部密度算**。
   槽位避让的水平偏移是 `slot * SLOT_DX`（见 renderer.js，当前22px ≈ 一个数字宽），
   一层的水平错开能力有限；而决定需要多少层的是「最密集的那 100px 内
   挤了多少个」（实测 row 2 有 10 个挤在 100px 内，跨度仅 70px），
   而不是这一行总共多少个。按总数算会严重低估层数。 */
const DENSITY_CAP_PER_100PX = 3;

/**
 * 按**实际 x 坐标**的局部密度计算所需层数（正确做法）。
 * @param {number[]} xs 该行标签的 x 坐标（已排序或乱序均可）
 * @returns {number} 需额外堆叠的层数（0 = 只有贴线的基础层）
 */
export function labelLayersForXs(xs) {
  if (!xs || xs.length <= 8) return 0;
  const sorted = xs.slice().sort((a, b) => a - b);
  let worst = 1;
  let lo = 0;
  for (let hi = 0; hi < sorted.length; hi++) {
    /* 窗口右端固定在sorted[hi]，向左扩张到 100px 宽 */
    while (sorted[hi] - sorted[lo] > 100) lo++;
    const n = hi - lo + 1;
    if (n > worst) worst = n;
  }
  const layers = Math.ceil(worst / DENSITY_CAP_PER_100PX) - 1;
  return layers <= 0 ? 0 : Math.min(12, layers);
}

/**
 * 统一行高公式。
 *
 * 必须为**音符自身直径**留出空间：subRow 对称分布后，最上/最下层音符的
 * 中心各外移 (lanes-1)/2 × subRowHeight，其边缘还会再溢出 noteDiameter/2。
 * 所以最低行高 = (lanes-1)×subRowHeight + noteDiameter + 上下留白。
 *
 * 历史 bug：原公式 `lanes×subRowHeight + 2` **漏了直径这一项** ——
 * 2 层子行时音符纵向跨度实际 102px，却只分到 70px，于是上下层音符的
 * 边缘越过行界、与邻行糊在一起（行界限消失）。
 *
 * @param {Object} cfg 布局配置
 * @param {number} subCount 该行子行数
 * @param {number} layers  该行需额外堆叠的层数（标签）
 */
export function rowHeightOf(cfg, subCount, layers = 0) {
  return Math.max(cfg.rowHeight, trackHeightOf(cfg, subCount))
       + layers * (cfg.labelLineH > 0 ? cfg.labelLineH : LABEL_LINE_H);
}

/**
 * 一行内容所需的**轨道高度**（行高的下界，不含标签层）。
 *
 * 与 rowHeightOf 分离，因为「条纹高度」要用同一个值 ——
 * 之前条纹写死 stripeHeight(50px)，多层子行时音符画到条纹外、
 * 与邻行糊在一起。条纹与行高必须同源，否则改一处漏一处。
 *
 * @param {Object} cfg 布局配置
 * @param {number} subCount 该行子行数
 */
export function trackHeightOf(cfg, subCount) {
  const span = Math.max(1, subCount);
  return (span - 1) * cfg.subRowHeight + cfg.noteDiameter + 10;
}

/* ==========================================================================
 * 主布局
 * ========================================================================== */
export function computeLayout(bm, cfg) {
  const notes = bm.notes;
  const bodyTop = cfg.headerHeight + cfg.paddingTop;

  if (!notes.length) {
    return {
      notes: [], totalWidth: cfg.maxWidth, height: bodyTop + 120, rowsUsed: 0,
      pages: [[0, 1]], pixelsPerSecond: 0, pxPerMs: 0, rowDurationMs: 0,
      t0: 0, tEnd: 0, bodyTop, marginX: cfg.marginX,
      rowHeight: cfg.rowHeight, subRowHeight: cfg.subRowHeight,
      subsPerRow: {}, rowY: {}, denseRows: {},
      measureTimes: [], bpmMarks: [], svMarks: [],
      svMarksFull: [], minuteMarks: [],
      rowAt: () => 0, xInRow: () => 0, xToTime: () => 0, timeToX: () => 0,
    };
  }

  /* 像素/秒的选择顺序：
     1. cfg.pixelsPerSecond > 0 —— 用户/调用方显式指定（尊重它）
     2. 小节对齐模式（BPM 恒定的谱）—— 让每行放整数个小节，小节线不错位
     3. 兜底：按 targetRows 均分整曲
   只在未指定时才自动选，避免覆盖用户意图。*/
  let pps = cfg.pixelsPerSecond;
  if (!(pps > 0)) {
    pps = (cfg.alignMeasures ? alignPixelsPerSecond(bm, cfg) : 0)
          || fitPixelsPerSecond(bm, cfg);
  }
  const pxPerMs = pps / 1000;
  let t0 = Math.min(...notes.map(n => n.time));
  const tEnd = maxEnd(bm);
  const usable = cfg.maxWidth - cfg.marginX * 2;
  let rowDurMs = (usable / pps) * 1000;

  /* ---- 起点对齐小节网格（关键）----
     t0 通常**不在小节边界上**（实测 Shakunetsu t0=461ms，落在小节中间）。
     此时即使每行窗口 = 整数个小节，行首/行尾的小节编号也会在
     7/8 之间跳动（如 1,9,17,24...），达不到「各行小节线对齐」的效果。

     解法：把 t0 向下取整到最近的小节边界。各行小节线就完全对齐
     （用户要的效果：第 1 行的最后一个接第 2 行的第一个）。
     只在 alignMeasures 开启时生效，且回退量不超过 1 个小节。 */
  if (cfg.alignMeasures) {
    const mMs = dominantMeasureMs(bm);
    if (mMs > 0) {
      const snapped = Math.floor(t0 / mMs) * mMs;
      t0 = Math.max(snapped, t0 - mMs);
    }
  }

  /* ---- 分配主行 + 子行 ---- */
  let maxRow = 0;
  notes.forEach((n) => {
    const tt = Math.max(0, n.time - t0);
    const row = Math.floor(tt / rowDurMs);
    if (row > maxRow) maxRow = row;
    n.row = row;
    n.x = cfg.marginX + (tt - row * rowDurMs) * pxPerMs;
  });
  const rowsUsed = maxRow + 1;

  /* 子行：只处理**真正的同帧音符**（time 相同），即音游里的「同押」。
   *
   * 语义：同帧多押在 osu!taiko 里必须**上下错开**才能看清有几个。
   * notes 已按 time 升序，所以时间早的先挑子行-> subRow 小的在上方
   * （渲染时 y = center + (subRow - (lanes-1)/2) * h，对称分布）。
   *
   * **不要**按像素间距分层：音高密谱里相邻音符 dx 常常 < 直径，
   * 若按 x 分层会把整行音符摊成十几层，行高暴涨、溢出到邻行。
   * 那是「视觉重叠」，不是「同押」，两者语义完全不同。
   * 视觉重叠由 noteDiameter 与 lineHeight 的比例来控制，不靠分层。*/
  const subIndex = new Map();   /* key = row*1e7 + time -> 当前用到第几层 */
  for (const n of notes) {
    const key = n.row * 1e7 + n.time;
    const lane = subIndex.get(key) || 0;
    subIndex.set(key, lane + 1);
    n.subRow = lane;
  }

  /* 每行子行数（同帧数的最大值） */
  const subsPerRow = {};
  for (const [key, cnt] of subIndex) {
    const row = Math.floor(key / 1e7);
    if (cnt > (subsPerRow[row] || 0)) subsPerRow[row] = cnt;
  }

  const rowAtEarly = (t) => Math.floor(Math.max(0, t - t0) / rowDurMs);
  const xInRowEarly = (t) => {
    const tt = Math.max(0, t - t0);
    const row = Math.floor(tt / rowDurMs);
    return cfg.marginX + (tt - row * rowDurMs) * pxPerMs;
  };

  /* ---- 变化点（先算，用于判定哪些行需要加高以堆叠标签） ---- */
  const bpmMarks = bpmChanges(bm);
  const svMarksFull = groupSvMarks(
    filterUsefulSV(svChanges(bm), bm, t0, tEnd), bm, 150);

  /* 密集行：按**局部密度**决定额外高度，让数字能纵向堆叠而不是叠在一起。
       注意：BPM 侧还会在渲染时**按值聚合**（一行 82 条红线往往只有
       3 个 distinct 值，重复标注毫无信息量），所以这里以 SV 为主，
       BPM 只在 distinct 值很多时才需要加高。*/
  const svXs = {};
  for (const m of svMarksFull) {
    const r = rowAtEarly(m[0]);
    (svXs[r] || (svXs[r] = [])).push(xInRowEarly(m[0]));
  }
  const bpmXs = {};
  for (const [t] of bpmMarks) {
    const r = rowAtEarly(t);
    (bpmXs[r] || (bpmXs[r] = [])).push(xInRowEarly(t));
  }
  const distinctPer = {};
  for (const item of bpmMarks) {
    const r = rowAtEarly(item[0]);
    if (!distinctPer[r]) distinctPer[r] = new Set();
    distinctPer[r].add(item[1].toFixed(1));
  }
  const denseRows = {};
  for (const r of new Set([...Object.keys(bpmXs), ...Object.keys(svXs)])) {
    /* BPM：distinct 值 <=6 时靠聚合就够（数字只标第一次），无需加高。
       >6 说明值本身很多，聚合救不了，必须靠层避让。 */
    const bpmLayers = (distinctPer[r] && distinctPer[r].size <= 6)
      ? 0 : labelLayersForXs(bpmXs[r]);
    const layers = Math.max(bpmLayers, labelLayersForXs(svXs[r]));
    if (layers > 0) denseRows[r] = layers;
  }

  /* 行 y 坐标（行高随子行数 / 标签层数伸展） */
  const rowY = {};
  let y = bodyTop;
  for (let r = 0; r < rowsUsed; r++) {
    rowY[r] = y;
    y += rowHeightOf(cfg, subsPerRow[r] || 1, denseRows[r] || 0);
  }

  /* 纵向分页 */
  let pages;
  if (cfg.maxRowsPerPage > 0 && rowsUsed > cfg.maxRowsPerPage) {
    pages = [];
    for (let r = 0; r < rowsUsed; r += cfg.maxRowsPerPage) {
      pages.push([r, Math.min(r + cfg.maxRowsPerPage, rowsUsed)]);
    }
  } else {
    pages = [[0, rowsUsed]];
  }

  /* 页高 */
  let height = 0;
  for (const [r0, r1] of pages) {
    let h = cfg.paddingBottom;
    for (let r = r0; r < r1; r++) {
      h += rowHeightOf(cfg, subsPerRow[r] || 1, denseRows[r] || 0);
    }
    if (r0 === 0) h += bodyTop;
    if (h > height) height = h;
  }

  const rowAt = (t) => Math.floor(Math.max(0, t - t0) / rowDurMs);
  /* 行号可显式传入（rowArg）。
   * 默认自己从 t 反推 —— 那样「t 正好落在行边界」时会算出下一行，
   * 与调用方手里那个由 rowAt(t) 得到的行号差1，x 会跳回 marginX。
   * 凡是「行号来自别处」（循环变量、跨行区间的边界裁剪）都必须显式传，
   * 否则同一段时间在两处会算出两个不同的 x。详见 renderer 的
   * _drawBreakStripes —— 那个 bug 让休息段跨行时中间行条纹整个消失。*/
  const xInRow = (t, rowArg) => {
    const tt = Math.max(0, t - t0);
    const row = rowArg === undefined ? Math.floor(tt / rowDurMs) : rowArg;
    return cfg.marginX + (tt - row * rowDurMs) * pxPerMs;
  };

  /* 小节线**不做layout 阶段抽稀**。
   小节线画在音符**下层**，压再多也不影响物件读谱，
   所以竖线全部保留（保留节奏感，也让分母完整）；
   数字过密的问题交给渲染期按字宽避让解决（见 renderer 的 mnoRight）。

   背景：某些比赛谱把 meter 设成 727/999，一小节近 10 分钟，
   measure_times 会膨胀到 8000+ 条 —— 但那是**竖线**，不是数字，
   全画出来反而有助于看清切分节奏。 */
const measureTimesList = measureTimes(bm, tEnd, t0, true);

  return {
    notes, totalWidth: cfg.maxWidth, height, rowsUsed, pages,
    pixelsPerSecond: pps, pxPerMs, rowDurationMs: rowDurMs,
    t0, tEnd, bodyTop, marginX: cfg.marginX,
    rowHeight: cfg.rowHeight, subRowHeight: cfg.subRowHeight,
    subsPerRow, rowY,
    /* 密集行 -> 需额外堆叠的标签层数（行高已含，见 rowHeightOf） */
    denseRows,
    measureTimes: measureTimesList,
    bpmMarks,
    svMarksFull,
    minuteMarks: minuteMarks(t0, tEnd, 30000),
    rowAt, xInRow,
    /* 画布内x + 行号 -> 相对 t0 的时间偏移(ms)。
     * 与 xInRow 严格互逆：xInRow(t0 + xToTime(x, row)) === x
     * （注意：不要在这里加 t0，否则会与 startMedia 的语义冲突）*/
    xToTime: (x, row = 0) => Math.round((x - cfg.marginX) / pxPerMs) + Math.round(row * rowDurMs),
    timeToX: (tRel, row = 0) => cfg.marginX + (tRel - row * rowDurMs) * pxPerMs,
  };
}