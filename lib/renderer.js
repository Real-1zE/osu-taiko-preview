/* ==========================================================================
 * renderer.js —— 预览图渲染器（Canvas 2D），与 renderer.py 逻辑一致
 *
 * 绘制顺序（关键）：
 *   1. 行带背景（每行高度随子行数伸展）
 *   2. 白色小节线（只画在所属行内）
 *   3. BPM 红线 / SV 绿线（只画在所属行内，高度仅一行）
 *   4. 音符（覆盖在线之上）
 * ========================================================================== */

import {
  NOTE_DON, NOTE_KAT, NOTE_BIG, NOTE_ROLL, NOTE_SPINNER,
  lengthMs, playableMs,
} from "./osu_parser.js";
import { rowHeightOf as layoutRowHeightOf, trackHeightOf, LABEL_LINE_H }
  from "./layout.js";

export const COLORS = {
  bgTop: "#161924",
  rowA: "#262127",
  rowB: "#1c191e",
  rowLine: "#3a323a",
  don: "#d32623",
  kat: "#809fc4",
  text: "#c8c8cd",
  textDim: "#8c8c94",
  sv: "#b0d050",
  beat: "#e6e6eb",
  accent: "#ff4060",
};

/**
 * 格式化流速(SV)数值。
 *  - 去掉尾随0：1.50 -> 1.5，1.00 -> 1
 *  - 不足 1 省略前导 0：0.95 -> ".95"
 *  - short=true 进一步省略整数位：1.04 -> ".04"（连续段中间项用）
 */
export function fmtSv(v, short = false) {
  /* 固定两位小数：1.00 / .95 / 1.09 / .05
     不足 1 省前导 0；short=true 时再省整数位（连续段中间项）*/
  let t = Math.abs(v).toFixed(2);
  const intPart = t.slice(0, t.indexOf("."));
  const frac = t.slice(t.indexOf(".") + 1);
  let out;
  if (short) out = "." + frac;
  else if (intPart === "0") out = "." + frac;
  else out = intPart + "." + frac;
  return (v < 0 ? "-" : "") + out;
}

const BIG_NOTE_SCALE = 1.5;   // 大饼相对普通音符的放大倍数
/* 圆润字体栈：Comic Sans 系列，用于 BPM / SV / 小节编号等小字标注 */
const ROUND_FONT = '"Comic Sans MS", "Comic Sans", "Chalkboard SE", "Segoe UI", sans-serif';

/** 标签槽位的水平步进（px）。
 *  必须 >= 数字宽度（约 20px），否则槽位形同虚设 —— 两个相同值挤在
 *  x=70 / x=73 时，3px 的偏移完全拉不开，数字会叠成一个模糊长串。
 *  高层用 step*(1+layer) 让纵向堆叠同时水平错开。 */
const SLOT_DX = 22;

/* 刻度条标签列宽的**默认值**（右对齐到此列右缘）。
   四条刻度条的标签列与条形都用固定宽度，这样 OD/HP/全曲密度/最密30%
   四行上下对齐成整齐一列。实际宽度由 _drawHeader 按右栏宽度反推后传进来
   （小窗要按比例缩），这里只作为「直接调用 _drawMeterBar」时的兜底。 */
const LABEL_COL_W = 96;

/* 标签列右缘到「条形起点」的留白。_drawMeterBar（HP/OD）与
   _drawRatioBar（skill/SR）**共用**这一个值 ——
   之前两个函数一个用 `x + colW`、一个用 `x + labW - 4`，
   差这4px 就是用户看到的「HP/OD 与下面几条没对齐」。*/
const LABEL_PAD = 4;

/* 判定「这个 BPM 真的存在过」所需的最小覆盖时长（ms）。
   1 秒是安全阈值：真正的 tempo 变化至少持续一个小节。*/
const BPM_MIN_HOLD_MS = 1000;

/* 可信 BPM 上限。超过这个值的红线是制谱者用来标记 gimmick 位置的
   「超高 BPM 标记」，不是真实 tempo。
   依据：layout.js 的EXTREME_BEAT_LENGTH=2 只滤掉 beatLength<=2（即 BPM>=30000），
   但实测还有大量 beatLength≈6.3（BPM≈9487）的标记成片出现 ——
   `t+pazolite - Otsukimi PARTY HARD` 里9487 BPM 累计生效 9.3 秒（占3.8%），
   光靠时长过滤滤不掉；但 9487 BPM 对太鼓谱毫无意义（一拍 6ms），
   按可信度截断后主 BPM 才正确落在 180。
   取 1000：覆盖了真实可用范围（太鼓谱通常 60~400），
   又能把beatLength < 60ms 的异常标记全部排除。*/
const BPM_MAX_CREDIBLE = 1000;

/* ==========================================================================
 * 信息栏矢量图标（皮肤里只有音符贴图，没有时钟/测速仪等小图标）
 * ========================================================================== */

/** 时钟：外圈 + 两根指针 + 顶部小帽 */
function icClock(ctx, x, y, s) {
  const cx = x + s / 2, cy = y + s / 2, r = s * 0.40;
  ctx.save();
  ctx.strokeStyle = "#ffd23f";
  ctx.lineWidth = Math.max(1.6, s * 0.09);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();          /* 指针 */
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx, cy - r * 0.58);
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + r * 0.46, cy + r * 0.20);
  ctx.stroke();
  ctx.fillStyle = "#ffd23f"; /* 顶部提手 */
  roundRect(ctx, cx - r * 0.34, cy - r - s * 0.13, r * 0.68, s * 0.12, s * 0.05);
  ctx.fill();
  ctx.restore();
}

/** 测速仪：BPM 表盘 */
function icGauge(ctx, x, y, s) {
  const cx = x + s / 2, cy = y + s * 0.62, r = s * 0.38;
  ctx.save();
  ctx.strokeStyle = "#ffd23f";
  ctx.lineWidth = Math.max(1.6, s * 0.09);
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI * 0.92, Math.PI * 2.08);   /* 开口朝下 */
  ctx.stroke();
  ctx.beginPath();                                       /* 指针 */
  const a = Math.PI * 1.62;
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(a) * r * 0.66, cy + Math.sin(a) * r * 0.66);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(1.2, s * 0.06), 0, Math.PI * 2);
  ctx.fillStyle = "#ffd23f";
  ctx.fill();
  ctx.restore();
}

/** 饼（Don/Kat）：外圈 + 内芯 */
function icDon(ctx, x, y, s, color) {
  const cx = x + s / 2, cy = y + s / 2;
  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(cx, cy, s * 0.44, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, s * 0.31, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** 连打：黄色头饼 + 绿色虚线 + 黄色尾饼 */
function icRoll(ctx, x, y, s) {
  const cy = y + s / 2, r = s * 0.24;
  ctx.save();
  ctx.strokeStyle = "#57b64a";
  ctx.lineWidth = Math.max(1.8, s * 0.10);
  ctx.setLineDash([s * 0.14, s * 0.10]);
  ctx.beginPath();
  ctx.moveTo(x + r + 2, cy);
  ctx.lineTo(x + s - r - 2, cy);
  ctx.stroke();
  ctx.setLineDash([]);
  for (const bx of [x + r, x + s - r]) {
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(bx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#f0b32e";
    ctx.beginPath();
    ctx.arc(bx, cy, r * 0.62, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** 转盘：带缺口的圆环 */
function icSpinner(ctx, x, y, s) {
  const cx = x + s / 2, cy = y + s / 2, r = s * 0.38;
  ctx.save();
  ctx.strokeStyle = "#ffd23f";
  ctx.lineWidth = Math.max(1.8, s * 0.11);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0.42, Math.PI * 1.95);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.36, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/** 画竖向虚线（Canvas line 无虚线，需逐段绘制） */
function dashedVLine(ctx, x, y0, h, color, width, dash = 5, gap = 4) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  for (let y = y0; y < y0 + h; y += dash + gap) {
    ctx.moveTo(x, y);
    ctx.lineTo(x, Math.min(y + dash, y0 + h));
  }
  ctx.stroke();
}

/**
 * 加载皮肤贴图。
 *
 * 扩展环境下没有本地 taiko skin/ 目录，改为**注入式**：
 * 由外部（popup/options）提供 Image 对象；没提供就返回空skin，
 * 渲染器会退回矢量绘制（`opts.useSkin` 为false 时本来就不用贴图）。
 *
 * @param {Object} [srcs]形如 { hit, hitOverlay, big, ... } 的Image 对象集合
 */
export async function loadSkin(srcs) {
  const skin = Object.assign({}, srcs || {});
  skin.loaded = !!(skin.hit || skin.big);
  return skin;
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  if (ctx.roundRect) { ctx.roundRect(x, y, w, h, rr); return; }
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/* ==========================================================================
 * 顶部信息栏版式（**唯一真相来源**）
 *
 * 为什么单独抽出来：信息栏高度既被绘制代码用（决定每样东西画在哪），
 * 又被 content.js 用（决定画布预留多少顶部空间）。两处各算一套必然对不上 ——
 * 之前就是这样：绘制按比例缩放算出需要 ~190px，而 content.js 按
 * `260 × k` 只留 120px，结果最后一条刻度条被裁掉。
 * 所以必须由这一个函数算出来，两边都调它。
 * ========================================================================== */

/**
 * 把 bpmRange() 的结果格式化成显示文本。
 *
 * **画布信息栏与窗口标题栏必须用同一个函数**，否则同一张谱会在两处
 * 显示不同的 BPM。变速谱尤其明显：很多谱开头是 120 BPM（慢板引入），
 * 主体是 200+ BPM —— 标题栏若显示「首拍 BPM」就会与画布里的主 BPM 对不上。
 *
 * @param {{min:number,max:number,main:number}|null} br bpmRange() 的结果
 * @param {"full"|"main"} [mode="full"]
 *   - `"full"`（信息栏用）：单值时 `200`；有变速时 `120-256(256)`
 *   - `"main"`（标题栏用）：只要主 BPM，标题栏空间有限
 * @returns {string} 空串表示无有效 BPM
 */
export function fmtBpmRange(br, mode = "full") {
  if (!br) return "";
  /* 保留一位小数：这些谱的 BPM 常带 .5（95.5 / 199.9），
     取整会显示成 96 / 200，与实际值不符。
     **但 mod 折算后必须取整**（用户要求「四舍五入到整数」）：
     230×1.5=345 没问题，但 95.5×1.5=143.25 这种会出现浮点尾巴。
     折算由调用方负责（它知道自己有没有折算），这里只负责格式。*/
  const fmt = (v) => Math.abs(v - Math.round(v)) > 0.05
    ? v.toFixed(1) : String(Math.round(v));
  if (mode === "main") return fmt(br.main);
  return Math.abs(br.min - br.max) < 0.05
    ? fmt(br.main)
    : `${fmt(br.min)}-${fmt(br.max)}(${fmt(br.main)})`;
}

/**
 * 给定画布宽度，算出信息栏的全部版式量与总高度。
 *
 * 缩放系数 k = clamp(W / 1500, 0.46, 1)：
 *   宽画布（网页版 1920）k=1，与原版式完全一致；
 *   插件小窗（420~860）k≈0.46~0.57，各项等比缩小并有下限。
 *
 * @param {number} W 画布逻辑宽度
 * @returns {object} 版式量（含 H = 信息栏总高度）
 */
export function headerLayout(W, opts) {
  /* opts 可选：绝大多数调用方只关心信息栏本身（danRowH = 0）。
     默认值必须是 {}，否则 `opts.danRow` 会抛 TypeError。*/
  const opts_ = opts || {};
  const k = Math.max(0.46, Math.min(1, W / 1500));
  /* 按 k 缩放，但不低于 floor —— 小窗里不能缩成看不清的蚂蚁字 */
  const F = (px, floor) => Math.max(floor, Math.round(px * k));

  const PAD = F(24, 8);
  const PAD_IN = F(18, 7);
  const avail = W - PAD * 2;
  const panelY = F(20, 7);

  const LINE_GAP = F(34, 16);                 /* 统计两行 / 左栏文字的行距 */
  const ICON_S = F(28, 14);                   /* 统计项图标边长 */
  const ICON_DX = Math.round(ICON_S * 1.14);
  const BAR_H = F(16, 9);                     /* 刻度条厚度 */
  const BAR_STEP = F(32, 16);                 /* 刻度条行距 */
  const VALUE_W = Math.round(F(44, 22));

  /* 右栏宽度分配。
     右栏现在要放 **7 条**（HP / OD / 4×skill 占比 / Star Rating），
     标签也从「全曲密度」变成了「体力 Stamina」「Star Rating」这类中英对照，
     所以比 v1.2.2 宽不少：比例 0.56 -> 0.68、下限也抬高。
     左侧信息用 _fitText 自适应字号、能缩，让宽度给右栏是划算的。*/
  /* 标签列宽度由「最宽标签」反推。
     实际标签（sr_panel 的 `name`）：
       "体力 Stamina" / "颜色 Colour" / "节奏 Rhythm" / "读谱 Reading"
       "Star Rating"
     标签字号 F(16,9)。全角 ≈ 1.0em、半角 ≈ 0.6em（实测比 0.5 略宽，
     "m"/"g"/"S" 这类字母尤其宽），于是
       「体力 Stamina」≈ 2 + 0.6 + 7×0.6 = 6.8em
       「Star Rating」  ≈ 11×0.6        = 6.6em
     取 7.0em 留呼吸空间。这个值要够大，否则 _ellipsis 会截成「体力 Stami…」。*/
  const emTag = Math.max(9, Math.round(16 * k));
  const widestTagEm = Math.max(
    2 + 0.6 + 7 * 0.6,        /* 体力 Stamina */
    11 * 0.6,                 /* Star Rating */
  );
  const LABEL_COL = Math.ceil(Math.max(F(118, 56), widestTagEm * emTag + 8));
  const RIGHT_W = Math.max(Math.round(430 * k),
    Math.min(Math.round(920 * k), Math.round(avail * 0.68)));
  const LEFT_W = avail - RIGHT_W;

  /* 右栏内部纵向节奏（**图标高度必须计入**，否则第二行图标会压到刻度条上）：
     统计第1 行基线 STAT_Y0
     -> +LINE_GAP 统计第 2 行基线，其图标底 = 基线 + 0.45×ICON_S
     -> 再留 GAP 才是第 1 条刻度条的顶 */
  const STAT_Y0 = F(34, 16);
  const row2Base = STAT_Y0 + LINE_GAP;
  const row2IconBottom = row2Base + ICON_S * 0.45;
  const BARS_Y0 = Math.ceil(row2IconBottom + F(10, 5));

  /* 框高：由内容反推，保证最后一条刻度条不会被裁。
     刻度条行数：有 SR 数据时是 7 条（HP / OD / 4×skill / Star Rating），
     无 SR 数据时是 4 条。按 7 条算，多算的高度只是留白，不会裁切。

     左栏现在有两块**右下角对齐**的内容要放：
       - 最大 PP（大字 F(50,34)）+ 上方的 mod 缩写（F(24,16)）
       -谱师下面的 sid / bid 两行
     PP 的基线在框底，mod 的基线还要往上抬 ppSize×0.82，两者叠起来
     需要 (ppSize + ppSize×0.82) 的高度 —— 这比原来的 4 行文字高得多，
     小窗时它才是leftNeed 的主导项，所以必须显式计入。*/
  const PP_SIZE = Math.max(34, Math.round(50 * k));
  const ppBlockH = PP_SIZE + PP_SIZE * 0.82 + F(6, 3);
  const leftNeed = Math.max(
    PAD_IN + F(26, 12) + LINE_GAP * 3 + F(26, 15) * 2 + PAD_IN,   /* 文字 + sid/bid 两行 */
    ppBlockH + PAD_IN,                                            /* 右下角 PP 块 */
  );
  const rightNeed = BARS_Y0 + BAR_STEP * 6 + BAR_H + PAD_IN;
  const panelH = Math.max(leftNeed, rightNeed);

  /* ---- 段位/键型评估行的高度 ----
   * 它**不在** headerLayout 里：header 的 H 只算信息栏本身，
   * 而段位行是画在信息栏**之后**、预览图**之前**的一条独立带
   * （renderer 里 bodyTop = headerH + danRowH + paddingTop）。
   *
   * 为什么画在画布内而不是 HTML 里单独一行（初版做法）：
   *   - 用户要求「位置在信息栏和预览图的中间」—— 那是**画布内**的位置，
   *     信息栏本身是画在 canvas 上的，预览图也是。做成 HTML 行的话
   *     它会跑到整个面板最顶部（在标题栏之下、信息栏之上），位置就错了。
   *   - 画在canvas 内还能跟随画布平移（.vbar 滚动时一起动），
   *     不会出现「信息栏滚走了、段位行还钉在顶上」的割裂感。*/
  const danRowH = opts_.danRow ? danRowHeightFor(W) : 0;

  /* 总高 = 上留白 + 框高 + 段位行 + 下留白。
     用户要求「信息栏紧贴预览图、中间不要空白」，所以：
     - 不再画底部那行「osu!taiko 谱面预览 / 页码」（它下面那段就是空白）
     - 下留白只留一个很小的 BOTTOM_PAD，让框不至于贴死画布边缘*/
  const BOTTOM_PAD = F(4, 2);
  const H = panelY + panelH + danRowH + BOTTOM_PAD;

  return {
    k, F, H, PAD, PAD_IN, avail, panelY, panelH,
    RIGHT_W, LEFT_W, LINE_GAP, MIN_FONT: k < 1 ? 10 : 12,
    ICON_S, ICON_DX, STAT_Y0, BARS_Y0, BAR_H, BAR_STEP,
    LABEL_COL, VALUE_W, danRowH,
  };
}

/**
 * 段位/键型评估行的高度（含它上下各留的呼吸空间）。
 *
 * ★ 与 headerLayout 共用同一个缩放系数 k = max(0.46, min(1, W/1500))，
 *   否则「画出来的位置」和「预留的高度」会不一致（内容被裁 / 多出空白）。
 *   这里自己算一遍 k 而不从 headerLayout 拿，是为了让本函数能被
 *   content.js 单独调用（它需要的是「这个宽度下该留多高」）。
 *
 * ★ 字号口径：**与左下角的「797PP」一致**（用户要求）。
 *   PP 用的是 F(50,34) + 宽度自适应 fit()，这里照抄同一套：
 *     段位 F(50,34)（与 PP 同号）
 *     键型 F(50,34)（同号，用户要求「一样大」）
 *     数字 F(24,16)（与 PP 上方的 mod 缩写同号）
 *   段位行因此会明显变高 —— 这是对的，它本来就该和主信息同级。
 *
 * @param {number} W 画布宽
 * @returns {{text:number, num:number, row:number}}
 *   text= 大字号（段位/键型）  num= 小字号（段位数字）  row= 整行高
 */
/**
 * 把 1~10 段的称号补上「Reform」前缀。
 *
 * Python 侧 `grade_name()` 对 1~10 段只返回裸数字（"1" ~ "10"），
 * 因为它服务于 xlsx 报表那种「数字 + 数字」的场景。
 * 但窗口里只有一行大字，光一个 "7" 看不出是什么 —— 而锚点谱
 * （Dan ~ REFORM ~ 第1~10 届）本来就是按 **Reform** 命名的，
 * 所以这里补上前缀，与 1st~10th 对上。
 *
 * ★ 用**阿拉伯数字**（"Reform 3"），不用罗马数字（用户要求）。
 *   罗马数字在 34px 大字号下更占宽，且与 10 段以上的
 *   Alpha/Beta/Gamma/Delta 字母体系混在一起时辨识度反而更差。
 *
 * ★ `<1`（低于 1 段）也补前缀 -> `< Reform 1`。
 *   Python 的 `grade_name()` 对 v < 1.0 返回 `'<1'`，
 *   而段位**可以是负数**（`flow_bonus` 下界 FLOW_FLOOR = -0.60 段，
 *   极简单的谱实测 dan = -1.92），所以这个分支不是摆设。
 *
 * ★ 只在插件的**显示层**做这个映射，**不改** `dan_rank` 的
 *   `grade_name()`：改了会让 dan_bridge_parity 的对拍基准失配，
 *   而且那属于算法模块的职责，不该由插件单方面改。
 *
 * 10 段及以上（Alpha/Beta/...）原样返回 —— 它们本来就有名字。
 *
 * @param {string} grade  Python 侧返回的 grade
 * @returns {string} 显示用的称号
 */
export function displayGrade(grade) {
  const g = String(grade == null ? '' : grade).trim();
  /* 低于 1 段：Python 给 '<1'，显示成 '< Reform 1' */
  if (g === '<1') return '< Reform 1';
  /* 只处理纯数字 1~10（含 "10"）。非数字（Alpha 等）直接返回。*/
  if (/^(10|[1-9])$/.test(g)) return `Reform ${g}`;
  return g;
}

export function danRowMetrics(W) {
  const k = Math.max(0.46, Math.min(1, (W || 1500) / 1500));
  const F = (px, floor) => Math.max(floor, Math.round(px * k));
  const text = F(50, 34);          /* 与 797PP 同字号 */
  const num = F(24, 16);           /* 与 PP 上方的 mod 缩写同字号 */
  /* 行高：大字号行高 + 上下留白 + 1px 分隔线 */
  const row = Math.round(text * 1.16 + F(8, 4) + 1);
  return { text, num, row };
}

/** 只要这一行的高度（content.js 预留顶部空间用） */
export function danRowHeightFor(W) {
  return danRowMetrics(W).row;
}

/** 只要信息栏总高度（content.js 预留顶部空间用） */
export function headerHeightFor(W) {
  return headerLayout(W).H;
}

export class PreviewRenderer {
  constructor(bm, layout, cfg, skin, opts = {}) {
    this.bm = bm;
    this.layout = layout;
    this.cfg = cfg;
    this.skin = skin || {};
    this.opts = Object.assign({
      header: true, bgImage: null,
      showSv: true, showGrid: true, showMeasure: true,
      noteScale: 1.0, useSkin: true,
      /* Star Rating / skill 占比 / PP（由 content.js 算好传进来）。
         为 null 时信息栏右侧退回「HP/OD/密度」那套旧刻度条。*/
      srData: null,
      /* 段位/键型评估：{grade, dan, keytype, text} 或 null。
         null / enable:false 时**不占高度**（danRowH = 0），
         预览图会贴回信息栏下沿。 */
      danRow: null,
      danRowLabel: '段位/键型评估v0.1',
    }, opts);

    this.headerH = this.opts.header ? cfg.headerHeight : 0;
    /* 段位行的高度由 content.js 算好传进来（cfg.danRowH）。
       必须在 headerH 之后、paddingTop 之前累加 —— 它是夹在
       「信息栏」与「预览图」之间的独立一条。*/
    this.danRowH = (this.opts.danRow && cfg.danRowH > 0) ? cfg.danRowH : 0;
    this.bodyTop = this.headerH + this.danRowH + cfg.paddingTop;

    /* 小标注字号跟着音符直径走：紧凑模式下音符只有 14px，
       固定 12px 的 BPM/SV/小节号会比音符还大喧宾夺主。
       以网页版的 34px 音符为基准（此时正好还原 12/11px）。*/
    const kNote = Math.max(0.62, Math.min(1, (cfg.noteDiameter || 34) / 34));
    this.fontLabel = Math.max(8, Math.round(12 * kNote));
    this.fontSmall = Math.max(7, Math.round(11 * kNote));
    this.slotDx = Math.max(9, Math.round(SLOT_DX * kNote));
  }

  /** 密度指标：平均 + 最密 30%（20 桶取连续 6 桶） */
  computeDensity() {
    const notes = this.bm.notes.filter(n => n.kind !== NOTE_ROLL && n.kind !== NOTE_SPINNER);
    if (!notes.length) return { avg: 0, peak: 0 };
    const durMs = Math.max(lengthMs(this.bm), 1);
    const avg = notes.length / (durMs / 1000);

    const BUCKETS = 20, WIN = 6;
    const bucketMs = durMs / BUCKETS;
    const counts = new Array(BUCKETS).fill(0);
    for (const n of notes) {
      const i = Math.floor(n.time / bucketMs);
      if (i >= 0 && i < BUCKETS) counts[i]++;
    }
    let best = 0, s0 = 0;
    for (let i = 0; i < WIN; i++) s0 += counts[i];
    best = s0;
    for (let i = 1; i <= BUCKETS - WIN; i++) {
      s0 += counts[i + WIN - 1] - counts[i - 1];
      if (s0 > best) best = s0;
    }
    const winS = (bucketMs * WIN) / 1000;
    return { avg, peak: winS > 0 ? best / winS : 0 };
  }

  /** 物件计数：红饼(红大饼)，蓝饼(蓝大饼)，滑条(大滑条)，转盘 */
  countObjects() {
    let red = 0, redBig = 0, blue = 0, blueBig = 0, roll = 0, rollBig = 0, spinner = 0;
    for (const n of this.bm.notes) {
      if (n.kind === NOTE_ROLL) { roll++; if (n.isBig) rollBig++; }
      else if (n.kind === NOTE_SPINNER) spinner++;
      else if (n.blue) { blue++; if (n.kind === NOTE_BIG) blueBig++; }
      else { red++; if (n.kind === NOTE_BIG) redBig++; }
    }
    return `红饼 ${red}(${redBig})，蓝饼 ${blue}(${blueBig})，滑条 ${roll}(${rollBig})，转盘 ${spinner}`;
  }

  /**
 * 当前 mod 的**流速倍率**：DT/NC = 1.5、HT = 0.75、其余 1。
 *
 * 时长与 BPM 都要按它折算（见 _headerStats）—— 用户要求：
 *   DT/NC：时长 ÷1.5、BPM ×1.5
 *   HT   ：时长 ÷0.75、BPM ×0.75
 *
 * 优先用 difficulty.getAdjustedDisplayDifficulty 返回的 rate
 * （那是官方口径，含 mod 组合），拿不到时退回按 mod 名判断。
 */
_modRate() {
  const S2 = this.opts.srData;
  if (S2 && S2.display && typeof S2.display.rate === 'number' && S2.display.rate > 0) {
    return S2.display.rate;
  }
  const name = (S2 && S2.mod) || 'None';
  const parts = String(name).split('+');
  let rate = 1;
  for (const p of parts) {
    if (p === 'DT' || p === 'NC') rate = 1.5;
    else if (p === 'HT') rate = 0.75;
  }
  return rate;
}

  /**
   * BPM 范围与主 BPM。
   *
   * 主 BPM **按覆盖时长加权**，不是按「出现次数取众数」。
   * 原因：制谱者会在 gimmick 段落插入大量短红线（beatLength 很小 → BPM 很高），
   * 这些标记**次数多但每次只持续几十毫秒**。按次数统计时它们会占据众数，
   * 把主 BPM 算成几千 —— 实测 `t+pazolite - Otsukimi PARTY HARD`：
   * 9487 BPM 出现 352 次、真实主 BPM 180 只出现 293 次，按众数会显示 9487。
   * 按时长加权后每个 BPM 的权重 = 「该 BPM 生效的总毫秒数」，
   * 主 BPM 才是「听起来是什么速度」。
   *
   * min/max 也只统计**有实质覆盖**的 BPM：持续时间不足 BPM_MIN_HOLD_MS 的
   * 段落不参与，否则范围会被一堆瞬时标记拉成 0 ~ 60000。
   *
   * @returns {{min:number, max:number, main:number}|null}
   */
  bpmRange() {
    const marks = this.layout.bpmMarks || [];
    if (marks.length < 1) return null;
    const t0 = this.layout.t0 || 0;
    const tEnd = this.layout.tEnd || t0;

    /* 每个 BPM 值的累计覆盖时长 */
    const hold = new Map();
    for (let i = 0; i < marks.length; i++) {
      const [t, b] = marks[i];
      /* 排除无效值、超高 BPM 的 gimmick 标记、30000+ 的极端标记 */
      if (!(b > 0 && b <= BPM_MAX_CREDIBLE)) continue;
      /* 本次变点生效到下一个变点（或谱末）*/
      const next = i + 1 < marks.length ? marks[i + 1][0] : tEnd;
      const dur = Math.max(0, next - t);
      /* 开头到第一个变点的那一段也算在第一个 BPM 上 */
      const key = Math.round(b * 10) / 10;         /* 归一化，合并近似值 */
      hold.set(key, (hold.get(key) || 0) + (i === 0 ? Math.max(0, t - t0) : 0) + dur);
    }
    if (!hold.size) return null;

    /* 主 BPM = 覆盖时长最长的那个 */
    let main = null, bestMs = -1;
    for (const [b, ms] of hold) {
      if (ms > bestMs) { bestMs = ms; main = b; }
    }
    /* min/max 只看「持续足够久」的 BPM，避免被瞬时 gimmick 标记污染 */
    let min = Infinity, max = -Infinity;
    for (const [b, ms] of hold) {
      if (ms < BPM_MIN_HOLD_MS) continue;
      if (b < min) min = b;
      if (b > max) max = b;
    }
    if (min === Infinity) { min = main; max = main; }
    /* 主 BPM 始终纳入范围（哪怕它本身很短，谱很短时也该显示）*/
    if (main < min) min = main;
    if (main > max) max = main;
    return { min, max, main };
  }

  /* ======================================================================
   * 渲染一页（纵向按行分页）
   * ==================================================================== */
  renderPage(pageIndex = 0, opts = {}) {
    const cfg = this.cfg, lay = this.layout;
    const o = Object.assign({}, this.opts, opts);
    const pages = lay.pages;
    if (!pages.length) return document.createElement("canvas");
    const pi = Math.max(0, Math.min(pageIndex, pages.length - 1));
    /* o.rows：显式指定要画的行区间 [row0, row1)（右开）。
       浏览器插件里整个窗口当一页画，用它绕过 lay.pages 的分页。 */
    const range = Array.isArray(o.rows) && o.rows.length === 2
      ? o.rows
      : pages[pi];
    const row0 = range[0], row1 = range[1];

    const W = lay.totalWidth;
    const rows = [];
    for (let r = row0; r < row1; r++) rows.push(r);
    /* 与 layout.js 的 rowHeightOf 保持一致：
       行高 = max(rowHeight, trackHeightOf(cfg, 子行数)) + 密集行额外标签层。
       公式必须三处一致（layout / renderer / app.rowHeightOf），
       否则竖线、轨道、播放线会错位。*/
    const heights = {};
    for (const r of rows) {
      heights[r] = layoutRowHeightOf(cfg, lay.subsPerRow[r] || 1, lay.denseRows[r] || 0);
    }
    /* 竖线只画在轨道范围内（居中于行），否则会与相邻行重叠 */
    const trackH = cfg.stripeHeight;
    const bodyTop = row0 === 0 ? this.bodyTop : 0;
    let H = bodyTop + cfg.paddingBottom;
    for (const r of rows) H += heights[r];

    const canvas = document.createElement("canvas");
    /* 超采样导出：`scale > 1` 时画布物理尺寸放大 N 倍，
       再用 ctx.scale 整体放大 —— 绘图代码一个字都不用改。
       用于导出高分辨率图（默认 1x 导出在 4K 屏/打印下会糊）。*/
    const ss = Math.max(1, Math.min(4, Math.round(o.scale || 1)));
    canvas.width = Math.round(W * ss);
    canvas.height = Math.ceil(H * ss);
    const ctx = canvas.getContext("2d");
    if (ss > 1) ctx.scale(ss, ss);
    /* 供后续代码使用的逻辑尺寸（避免误用 canvas.width） */
    const viewW = W, viewH = Math.ceil(H);

    /* 本页各行 y 偏移 */
    const yOff = {};
    let yc = bodyTop;
    for (const r of rows) { yOff[r] = yc; yc += heights[r]; }

    /* ---- 行带背景 ---- */
    ctx.fillStyle = COLORS.bgTop;
    ctx.fillRect(0, 0, W, viewH);
    if (o.showGrid) {
      /* 背景条纹（与 renderer.py 一致）：
         条纹周期 = 2 个物件行 = 160px，深色条高 52px，
         **以偶数行音符为中心居中包裹**，奇数行落在过渡空隙。
         横向只覆盖该行音符的实际范围。 */
      const per = Math.max(1, cfg.stripePeriod);
      /* 条纹高度与行高**同源**（layout.trackHeightOf）。
         之前条纹写死 stripeHeight，多层子行时音符会画到条纹外、
         与邻行糊在一起 —— 改行高公式时必须同步改这里，故抽成共享函数。*/
      const rowBandH = (r) =>
        Math.max(cfg.stripeHeight,
                 trackHeightOf(cfg, lay.subsPerRow[r] || 1));
      /* 该行是否「有内容」：有音符**或**被长物件（连打/转盘）跨过。
         只查音符会漏掉长物件的续行—— 转盘横跨两行时，第二行没有任何
         音符，却仍然需要轨道背景（绿线要画在轨道上）。
         历史 bug：转盘跨行的第二行轨道消失。 */
      const rowHasContent = this._computeRowContent(lay, rows);
      for (const r of rows) {
        if (r % per !== 0) continue;
        const cy = yOff[r] + heights[r] / 2;
        const sh = Math.min(rowBandH(r), heights[r]);
        const sy0 = cy - sh / 2, sy1 = cy + sh / 2;
        if (sy0 < 0) continue;
        if (!rowHasContent.has(r)) continue;
        /* 横向统一铺满整页宽度，保证所有轨道左端/右端对齐 */
        const x0 = 0, x1 = W;
        ctx.fillStyle = (Math.floor(r / per) % 2 === 0) ? COLORS.rowA : COLORS.rowB;
        ctx.fillRect(x0, sy0, x1 - x0, sh);
        ctx.strokeStyle = COLORS.rowLine;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x0, sy0 + 0.5); ctx.lineTo(x1, sy0 + 0.5);
        ctx.moveTo(x0, sy1 + 0.5); ctx.lineTo(x1, sy1 + 0.5);
        ctx.stroke();
      }
    }

    /* ---- 休息段：灰色斜条纹覆盖轨道 ---- */
    this._drawBreakStripes(ctx, lay, rows, yOff, heights, trackH);

    /* ---- 标题栏 ---- */
    if (this.headerH > 0 && pi === 0) {
      this._drawHeader(ctx, W, pi, pages.length);
      ctx.strokeStyle = "#463e48";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, bodyTop - 1);
      ctx.lineTo(W, bodyTop - 1);
      ctx.stroke();
    }

    /* ---- 段位/键型评估行 ----
     * 画在信息栏之后、预览图之前（bodyTop 已经把它算进去了）。
     * 只在第 0 页画：它是整曲的属性，跟着画布滚没有意义。*/
    if (pi === 0 && this.danRowH > 0) {
      this._drawDanRow(ctx, W, this.headerH);
    }

    /* ---- 整分钟蓝色时间线 ---- */
    this._drawMinuteLines(ctx, lay, rows, yOff, heights, trackH);

    /* ---- 竖线：只画在各自所属行内 ---- */
    if (o.showMeasure) this._drawMeasureLines(ctx, lay, rows, yOff, heights, trackH);
    if (o.showSv) {
      this._drawChangeLines(ctx, lay, rows, yOff, heights, trackH, "bpm");
      this._drawChangeLines(ctx, lay, rows, yOff, heights, trackH, "sv");
      /* 同一位置既有绿线又有红线 -> 标「红线」+ 上下两个数字 */
      this._drawCoincidentMarks(ctx, lay, rows, yOff, heights, trackH);
    }

    /* ---- 音符 ---- */
    ctx.textAlign = "center";

    /* **Z 序（绘制顺序）**：先出现的音符要盖在后出现的之上。
     *
     * 用户需求（示例：3 红饼 + 1 蓝饼，记作 1,2,3,4，1 最先出现）：
     *   1 的层次盖在 2 上面，2 盖在 3，依次类推。
     * Canvas 遵循「后画的在上面」，所以必须**按时间倒序**遍历：
     * 时间早的最后画 -> 位于最上层。
     *
     * 历史 bug：原先按时间升序遍历（parseOsu 已 sort），
     * 于是最后出现的 4 在最上层、盖住了 3，与音游读谱习惯相反。
     *
     * 倒序只影响同像素位置的层叠关系，不影响 x 定位。*/
    for (let i = lay.notes.length - 1; i >= 0; i--) {
      const n = lay.notes[i];
      const r = n.row;
      if (r < row0 || r >= row1) continue;
      const lx = n.x;
      /* 子行**以整行为中心对称分布**。
         注意：不能写成 `+subRow*h`（从行中心往下堆）——
         那样多层子行时音符会向下溢出，与下一行的音符糊在一起
         （行界限消失，正是用户截图里看到的现象）。
         对称分布保证任意层数都落在本行范围内，且视觉居中。*/
      const subN = lay.subsPerRow[r] || 1;
      const cy = yOff[r] + heights[r] / 2
               + (n.subRow - (subN - 1) / 2) * cfg.subRowHeight;

      if (n.kind === NOTE_ROLL) { this._drawLong(ctx, n, lay, rows, yOff, heights, o, "roll"); continue; }
      if (n.kind === NOTE_SPINNER) { this._drawLong(ctx, n, lay, rows, yOff, heights, o, "spinner"); continue; }

      this._drawNote(ctx, n, lx, cy, cfg.noteDiameter / 2, o);
    }
    ctx.textAlign = "left";

    /* 把本页的行几何挂到 canvas 上。
     * 渲染过程中的 y 偏移只在 renderPage 内部算得出（yOff/heights），
     * 而测试与导出功能都需要知道「第 r 行画在哪个 y 带」——
     * 让它们去重算一遍的话，行高公式一改就会和实际绘制对不上。
     * 挂在 canvas 上而不是 return 对象上，是为了不改变既有返回类型
     * （content.js 与 app.js 都当它是 HTMLCanvasElement 用）。*/
    canvas.rowTops = Object.assign({}, yOff);
    canvas.rowHeights = Object.assign({}, heights);
    canvas.trackH = trackH;

    return canvas;
  }

  /**
   * 计算本页各行是否「有内容」：有音符，被长物件（连打/转盘）跨过，
   * **或被休息段覆盖**。
   *
   * 为什么需要：轨道背景原先只判 `lay.notes.some(n => n.row === r)`，
   * 转盘横跨两行时，第二行没有任何音符（长物件本身只归属起始行），
   * 于是轨道背景被跳过 —— 表现为「绿线有、轨道没了」。
   *
   * ★★ 休息段必须也算「有内容」，这是用户截图里的第二个问题：
   *   Break 段内部**本来就没有音符**（那正是休息的含义），
   *   所以横跨两行的休息段，中间那行既没音符也没长物件，
   *   轨道背景被跳过 -> 「条纹跨两行时中间一行连轨道一起消失」，
   *   看起来像条纹画在了虚空里。
   *   修法就是让休息段覆盖到的行也算有内容。
   *
   * @returns {Set<number>} 有内容的行号集合
   */
  _computeRowContent(lay, rows) {
    const out = new Set();
    const inPage = new Set(rows);
    for (const n of lay.notes) {
      if (inPage.has(n.row)) out.add(n.row);
      /* 长物件可能跨到本页的其他行 */
      if (n.kind === NOTE_ROLL || n.kind === NOTE_SPINNER) {
        const last = lay.rowAt(n.endTime > n.time ? n.endTime - 1 : n.time);
        for (let r = n.row; r <= last; r++) {
          if (inPage.has(r)) out.add(r);
        }
      }
    }
    /* 休息段覆盖的行：段内无音符，但轨道背景要留着（条纹画在轨道上）。
       行的取法必须与 _drawBreakStripes 完全一致：
         起点行 = rowAt(段与可视区的交集起点)
         终点行 = rowAt(交集终点 - 1)   ← 减1 是为了「结束正好在行首」时
                                          不把下一行也算进来。*/
    for (const [bs, be] of (this.bm.breaks || [])) {
      const t0 = Math.max(bs, lay.t0), t1 = Math.min(be, lay.tEnd);
      if (t1 <= t0) continue;
      const r0 = lay.rowAt(t0);
      const r1 = lay.rowAt(Math.max(t0, t1 - 1));
      for (let r = r0; r <= r1; r++) {
        if (inPage.has(r)) out.add(r);
      }
    }
    return out;
  }

  /**
   * 休息段（Break）在轨道上画**灰色斜条纹**背景。
   *
   * 休息段语法：`Break,开始时间,结束时间`（第二行也可用 2 代替），
   * 由 osu_parser 解析进 bm.breaks。段内通常没有音符，用条纹明确
   * 标示「这里不读谱」，避免误以为漏画了。
   *
   * 条纹画在轨道**内**（track 高度），不溢出到行间距里。
   */
  _drawBreakStripes(ctx, lay, rows, yOff, heights, trackH) {
    const breaks = this.bm.breaks;
    if (!breaks || !breaks.length) return;
    const rowSet = new Set(rows);
    const PITCH = 14;          /* 条纹间距 */
    const stripe = 7;           /* 条纹线宽 */
    ctx.save();
    for (const [bs, be] of breaks) {
      const t0 = Math.max(bs, lay.t0), t1 = Math.min(be, lay.tEnd);
      if (t1 <= t0) continue;
      const r0 = lay.rowAt(t0);
      const r1 = lay.rowAt(Math.max(t0, t1 - 1));
      for (let r = r0; r <= r1; r++) {
        if (!rowSet.has(r) || !yOff.hasOwnProperty(r)) continue;
        const rowEndT = lay.t0 + (r + 1) * lay.rowDurationMs;
        const s = Math.max(t0, lay.t0 + r * lay.rowDurationMs);
        const e = Math.min(t1, rowEndT);
        if (e <= s) continue;
        /* ★★ 必须把行号显式传给 xInRow，**不能**依赖它自己反推。
         *
         * `xInRow(t)` 内部做`floor((t - t0) / rowDurMs)` 自己算行号，
         * 而这里的 r 是循环变量。两者的行号在「时间正好落在行边界」时会差1：
         *   `e = rowEndT`（= 下一行行首）时，xInRow(e) 算出的是**下一行**的
         *   行内偏移 ≈ marginX，于是 x1 < x0，宽度变成负数。
         * 后果是 `if (x1 - x0 < 0.5) continue` 把整行跳过 ——
         * 休息段跨多行时，「夹在中间的那一行条纹不显示」。
         *
         * 实测（Dereban's Lewd Extra，窗口宽700 → 25 行，行长 4114ms）：
         *   休息段 93540~103741ms 跨行 14~17，其中行 15/16 的
         *   x0 = 674、x1 = 26 —— 完全反了，两行条纹整个消失。
         * 行 17 恰好「结束时间不在边界上」所以侥幸画对了，
         * 于是表现为「两端有条纹、中间空着」，很像「这里本来没有休息段」。
         *
         * 传r 进去就与 lay.rowAt 解耦，边界情况一律正确。
         * （其余 xInRow 调用点都是「先 rowAt(t) 再 xInRow(t)」配对使用，
         *   不存在这个错位，所以只需要改这一处。）
         */
        const x0 = lay.xInRow(s, r), x1 = lay.xInRow(e, r);
        if (x1 <= x0) continue;
        const y0 = yOff[r] + (heights[r] - trackH) / 2;
        /* 半透明灰底 */
        ctx.fillStyle = "rgba(120,120,128,0.22)";
        ctx.fillRect(x0, y0, x1 - x0, trackH);
        /* 45° 斜条纹（裁剪到该段内） */
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, y0, x1 - x0, trackH);
        ctx.clip();
        ctx.strokeStyle = "rgba(190,190,200,0.34)";
        ctx.lineWidth = stripe;
        ctx.beginPath();
        /* 斜线满足 (x - y) 为 PITCH 整数倍，遍历整个覆盖范围 */
        const startX = x0 - trackH, endX = x1 + trackH;
        for (let sx = Math.floor(startX / PITCH) * PITCH;
             sx <= endX; sx += PITCH) {
          ctx.moveTo(sx, y0 + trackH);
          ctx.lineTo(sx + trackH, y0);
        }
        ctx.stroke();
        ctx.restore();
        /* 段边界线 */
        ctx.strokeStyle = "rgba(210,210,220,0.45)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(x0) + 0.5, y0);
        ctx.lineTo(Math.round(x0) + 0.5, y0 + trackH);
        ctx.moveTo(Math.round(x1) + 0.5, y0);
        ctx.lineTo(Math.round(x1) + 0.5, y0 + trackH);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /**
   * 段位 / 键型评估行（画在信息栏与预览图之间）。
   *
   * 版式（用户需求）：
   *   左侧  大号段位（黄色）+ 小字括号段位数字 + 大号键型（青色）
   *         字号与左下角的「797PP」**一样大**（`danRowMetrics().text`）
   *         键型为 `-` 时**整段不显示**（段位 ≤6 属正常情况）
   *   最右  小字版本说明
   *
   * ★ 显示/隐藏开关**不在这里** —— 它在下面的工具条里
   *   （HTML 的 `.tools`，紧跟「轨道底」右侧）。
   *   初版把复选框和内容放在一起，结果取消勾选后连复选框一起消失，
   *   用户再也开不回来（用户反馈）。开关必须放在**永远不会消失**的地方。
   *
   * @param {number} y0 该行的顶边（= 信息栏高度）
   */
  _drawDanRow(ctx, W, y0) {
    const d = this.opts.danRow || {};
    const h = this.danRowH;
    const L = headerLayout(W);
    const F = L.F;
    const mid = y0 + h / 2;
    const M = danRowMetrics(W);
    /* 大字号的基线要往上抬一点才视觉居中：
       textBaseline='middle' 对大字号是按字高一半对齐，
       而 PP 那行是按「基线 + descender」对齐的，两者观感差几 px。*/
    const baseline = mid + M.text * 0.06;

    ctx.save();
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";

    /* ---- 段位（大号，黄）—— 字号与 797PP 一致 ---- */
    let x = F(10, 5);
    const bigFont = `${M.text}px "Segoe UI", "Microsoft YaHei", sans-serif`;
    ctx.font = `700 ${bigFont}`;
    const grade = d.grade;
    /* 1~10 段补「Reform」前缀（Python 侧只给裸数字，见 displayGrade）*/
    const gradeRaw = (typeof grade === 'string' && grade) ? grade : '——';
    const gradeTxt = displayGrade(gradeRaw);
    const isBad = !grade || grade === 'err' || grade === 'pending';
    if (isBad) {
      /* 不可用时用灰色 + 常规字重，避免与真实段位混淆 */
      ctx.fillStyle = "#8a90a2";
      ctx.font = `600 ${bigFont}`;
    } else {
      ctx.fillStyle = "#ffd23f";
    }
    /* ★ 宽度自适应，与 _drawMaxPp 的 fit() 同一套逻辑 ——
       否则「>Delta+」这种长称号 + 大字号会撞到键型。*/
    const gradeMax = W * 0.42;
    ctx.fillText(this._ellipsis(ctx, gradeTxt, gradeMax), x, baseline);
    x += ctx.measureText(this._ellipsis(ctx, gradeTxt, gradeMax)).width;

    /* ---- 段位数字（小字，白灰）---- */
    /* ★ 只判断「是不是可显示的数字」，**不判断正负**——
       段位可以是负数（`flow_bonus` 下界 FLOW_FLOOR = -0.60 段，
       实测最简谱 dan = -1.92），那种情况照样要显示 (-1.92)。*/
    if (typeof d.dan === 'number' && isFinite(d.dan)) {
      const numTxt = `(${d.dan.toFixed(2)})`;
      ctx.font = `500 ${M.num}px "Segoe UI", "Microsoft YaHei", sans-serif`;
      ctx.fillStyle = "#c9ccd6";
      /* 数字与段位之间留一点空隙（大字号的视觉重心偏左，
         不留空会看着「粘」在一起）*/
      x += F(14, 8);
      ctx.fillText(numTxt, x, baseline);
      x += ctx.measureText(numTxt).width;
    }

    /* ---- 键型（大号，青）—— '-' 或空则整段跳过 ----
     * ★ 键型与段位数字之间**留一段空隙**（用户要求）。
     *   数字是 24px 小字、键型是 50px 大字，紧挨着会因视觉重心差
     *   看着像糊在一起。留 F(22,14) —— 约半个大字号的高度，
     *   不足以让两者看起来是两件东西，也不会浪费横向空间。*/
    const kt = d.keytype;
    if (typeof kt === 'string' && kt && kt !== '-') {
      ctx.font = `700 ${bigFont}`;
      ctx.fillStyle = "#7ad4ff";
      /* 剩余宽度里留给键型，超了截断 —— 绝不能压到右侧的版本说明 */
      const verW = F(96, 60);
      const ktMax = Math.max(20, W - x - verW);
      ctx.fillText(this._ellipsis(ctx, kt, ktMax), x + F(22, 14), baseline);
    }

    /* ---- 版本说明（最右小字，低对比）---- */
    const ver = this.opts.danRowLabel || '';
    if (ver) {
      ctx.font = `500 ${F(11, 7)}px "Segoe UI", "Microsoft YaHei", sans-serif`;
      ctx.fillStyle = "rgba(190,198,220,0.42)";
      ctx.textAlign = "right";
      ctx.fillText(this._ellipsis(ctx, ver, W * 0.4), W - F(10, 5), mid);
    }

    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.restore();
  }

  /**
   * 顶部信息栏：左侧谱面信息 + 右侧统计条。
   *
   * 左侧五行（第一行字号更大，其余四行同号）：
   *   1 曲名  2 歌曲作者  3 [难度名]（黄色）  4 谱师  5 sid / bid（右下角）
   * 右侧：上方两行三列「图标 + 数字」（时长 / 红饼 / 蓝饼 / BPM / 连打 / 转盘），
   *      下方四条刻度条（OD / HP / 全曲密度 / 最密 30%）。
   *      刻度条总长 10 格；超出部分用红色从左侧覆盖（10~20）；超过 20 不再渲染。
   *
   * **宽度自适应**：浏览器插件的小窗只有几百 px 宽，全部版式量都乘一个
   * 缩放系数 k（宽画布 k=1，观感与网页版完全一致）；
   * 字号有下限，避免小窗里缩成不可读的蚂蚁字。
   */
  _drawHeader(ctx, W, pageIndex, totalPages) {
    const bm = this.bm;
    /* 版式全部来自headerLayout —— 与 content.js 预留高度用的是同一份，
       所以「画的东西」和「留的空间」永远一致，不会再出现裁切。*/
    const L = headerLayout(W);
    const H = this.headerH;
    const F = L.F;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.clip();

    /* 面板底色 */
    const PANEL_BG = "rgba(16,18,26,0.78)";

    const PAD = L.PAD, PAD_IN = L.PAD_IN;
    const panelY = L.panelY, panelH = L.panelH;
    const LEFT_W = L.LEFT_W, RIGHT_W = L.RIGHT_W;
    const LINE_GAP = L.LINE_GAP;

    /* ---------- 左：谱面信息 ---------- */
    roundRect(ctx, PAD, panelY, LEFT_W, panelH, F(16, 8));
    /* 有封面图时面板底色更透，让背景透出来；无图时保持原来的实色 */
    ctx.fillStyle = PANEL_BG;
    ctx.fill();

    /* 文字块从框的**左上角**开始：内边距 PAD_IN，基线从 pad+字号 起算。
       四行（曲名 / 作者 / 难度 / 谱师）用**统一行距** LINE_GAP，
       下面再另起两行放 sid / bid（用户要求：一行sid、一行 bid）。*/
    const lx = PAD + PAD_IN;
    const lw = Math.max(40, LEFT_W - PAD_IN * 2);
    let ly = panelY + PAD_IN + F(26, 13);          /* 第一行基线 */

    /* 1. 曲名（大字号） */
    ctx.fillStyle = "#ffffff";
    this._fitText(ctx, bm.title || "Unknown", lx, ly, lw, F(34, 15), "700", L.MIN_FONT);

    /* 2. 歌曲作者（不写"歌曲作者"字样） */
    ly += LINE_GAP;
    ctx.fillStyle = "#e8e8f0";
    this._fitText(ctx, bm.artist || "Unknown", lx, ly, lw, F(20, 11), "600", L.MIN_FONT);

    /* 3. 难度名：黄色中括号 */
    ly += LINE_GAP;
    ctx.fillStyle = "#ffd23f";
    this._fitText(ctx, `[${bm.version || ""}]`, lx, ly, lw, F(20, 11), "700", L.MIN_FONT);

    /* 4. 谱师 */
    ly += LINE_GAP;
    ctx.fillStyle = "#c9ccd6";
    this._fitText(ctx, bm.creator || "-", lx, ly, lw, F(20, 11), "500", L.MIN_FONT);

    /* 5. sid / bid —— 谱师下面**另起两行**，一行一个（用户要求）。
       行距用 ID_GAP（比 LINE_GAP 略小，视觉上更紧凑）。*/
    const sid = bm.beatmapSetId ? Number(bm.beatmapSetId) : null;
    const bid = bm.beatmapId ? Number(bm.beatmapId) : null;
    const ID_GAP = F(26, 15);
    ctx.font = `500 ${F(18, 10)}px "Segoe UI", "Microsoft YaHei", sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#9aa0ae";
    if (sid !== null && !Number.isNaN(sid)) {
      ly += ID_GAP;
      ctx.fillText(this._ellipsis(ctx, `sid ${sid}`, lw), lx, ly);
    }
    if (bid !== null && !Number.isNaN(bid)) {
      ly += ID_GAP;
      /* ★ 优先显示 **URL 里的 bid**（opts.urlBid），不是谱面文件自报的
       *   `bm.beatmapId`。
       *
       *   osu! 侧存在「多个难度共用同一个 BeatmapID」的数据异常 ——
       *   实测 sid 703200 `Dan-i Dojo (Part.2)`：
       *     /osu/1563291 -> 9thDan，但文件里 BeatmapID:1498109
       *     /osu/1498109 -> 10th Dan，文件里也是1498109
       *   显示文件自报的值会与地址栏对不上，用户复制出去就找错谱面。
       *
       *   两者不一致时画 `bid <url> (<file>)` —— 让「为什么不一样」可见，
       *   而不是悄悄显示另一个值（这正是用户反馈的那个现象）。*/
      const urlBid = this.opts.urlBid;
      const showUrl = urlBid !== null && urlBid !== undefined
        && String(urlBid) !== '';
      const mismatch = showUrl && Number(urlBid) !== bid;
      const bidMain = showUrl ? Number(urlBid) : bid;
      const bidText = mismatch
        ? `bid ${bidMain} (${bid})`
        : `bid ${bidMain}`;
      const bidX = lx;
      /* ★ 宽度不够时**优先保住 URL 的 bid**：文件自报的那个可以丢。
         `_ellipsis` 从尾部截断，所以把文件值放在末尾正好是「先丢它」。*/
      ctx.fillText(this._ellipsis(ctx, bidText, lw), bidX, ly);
      /* 3b. ★ 转换谱标记：std（Mode 0）谱面显示的是「转成 taiko 之后」的视角，
         与页面右上角那个 [Difficulty] 自己的星数**不是一回事**。
         不标注的话用户会以为窗口里的星数就是这个 osu! 难度的星数。

         ★ 画在 **bid 后面同行**，不另起一行。
           早先版本在「难度名」与「谱师」两行之间画了一行
           `转谱预览 osu!→taiko`，偏移 0.62 行、字号 3/4 ——
           看着像卡在行间空隙里，实际在窄窗口（k 缩放后行高变紧）时
           仍会与谱师那行叠字（用户截图实测）。
           同行追加不可能叠：基线完全相同，只需保证不超左栏宽度。
           宽度不够就整个省略标记，宁可少信息也不要糊成一团。*/
      if (bm.isConvert && bm.mode === 0) {
        const tag = " (转谱)";
        const tagW = ctx.measureText(tag).width;
        /* 标签与bid 之间留一个空格宽度，避免 "(转谱)" 粘在数字上 */
        if (bidX + ctx.measureText(bidText).width + tagW <= lx + lw) {
          ctx.fillStyle = "#ffd23f";
          ctx.fillText(tag, bidX + ctx.measureText(bidText).width + F(6, 3), ly);
          ctx.fillStyle = "#9aa0ae";
        }
      }
    }

    /* 3c. ★ 脏数据提示：解析层丢弃过不可信条目时，必须说出来。
     *
     * 不说的话用户会以为「谱面本来就这样」—— 而实际上被丢的东西
     * 可能影响读谱（拍长错一个小节线就整体偏移）。
     * 画在 bid 下面一行，橙色小字，颜色与「转谱」标记区分开。
     * 正常谱面 droppedTiming/droppedObjects 都是 0，这一行不会出现。*/
    const dropped = (bm.droppedTiming || 0) + (bm.droppedObjects || 0);
    if (dropped > 0) {
      ly += ID_GAP;
      ctx.fillStyle = "#ff9a3c";
      this._fitText(ctx, `已忽略 ${dropped} 条异常数据`, lx, ly, lw,
        F(17, 9), "600", L.MIN_FONT - 1);
    }

    /* 6. 最大 PP + mod 缩写 —— 右下角（mod 缩写小字画在 PP 上方）*/
    this._drawMaxPp(ctx, PAD + LEFT_W - PAD_IN, panelY + panelH - PAD_IN,
                    F, lw);

    /* ---------- 右：统计 ---------- */
    /* 右栏整体右移、右端靠住可用宽度的边（用户要求「向右靠住」）——
       原来的 RIGHT_W 按比例算，右缘会留一段空白。现在把右栏**右对齐**，
       并给 PAD_IN 之外再加一点外边距，让内容贴近画布右边。*/
    const SIDE_GAP = F(10, 5);
    const rx = W - PAD - RIGHT_W;
    roundRect(ctx, rx, panelY, RIGHT_W, panelH, F(16, 8));
    /* 有封面图时面板底色更透，让背景透出来；无图时保持原来的实色 */
    ctx.fillStyle = PANEL_BG;
    ctx.fill();

    /* 上方：固定两行三列，不再依赖自动换行（自动换行会导致每次刷新列位不同）。
       第 1 行：时长 / 红饼 / 蓝饼
       第 2 行：BPM  / 连打 / 转盘
       列宽按**扣除 SIDE_GAP 后**的宽度均分，整块内容右对齐到框的右内缘，
       这样刻度条的右端与最后一列数字的右端都能贴住右边（用户要求「向右靠住」）。*/
    const S = this._headerStats();
    const innerL = rx + PAD_IN + SIDE_GAP;
    const innerR = rx + RIGHT_W - PAD_IN;
    const colW = (innerR - innerL) / 3;
    for (let ri = 0; ri < 2; ri++) {
      for (let ci = 0; ci < 3; ci++) {
        const st = S[ri * 3 + ci];
        if (!st) continue;
        const sx = innerL + ci * colW;
        const sy = panelY + L.STAT_Y0 + ri * LINE_GAP;
        st.icon(ctx, sx, sy - L.ICON_S * 0.55, L.ICON_S);
        ctx.fillStyle = "#ffd23f";
        ctx.font = `700 ${F(19, 11)}px "Segoe UI", "Microsoft YaHei", sans-serif`;
        ctx.textAlign = "left";
        ctx.textBaseline = "alphabetic";
        /* 文本过长时按可用宽度截断，避免压到下一列 */
        ctx.fillText(this._ellipsis(ctx, st.text, colW - L.ICON_DX - F(8, 4)), sx + L.ICON_DX, sy);
      }
    }

    /* 下方：刻度条。
       用户要求：**去掉「全曲密度」「最密30%」两条**，
       改为「四项 skill 占比 + Star Rating」；
       **HP / OD 两条保留**（它们是谱面参数，随 mod 变化，值得单独看）。
       所以有 srData 时是 7 条：HP / OD / 4×skill / Star Rating。
       条形数量多-> 右栏要更宽（见 headerLayout 的 RIGHT_W）。
     skill 占比与 SR 随 mod 变化（HT/DT/EZ/HR 会改 OD/判定窗/流速），
     所以勾选 mod 时由 content.js 重新计算后重绘。*/
    const S2 = this.opts.srData;
    const den = this.computeDensity();
    /* ---- OD / HP 用哪个值 ----
       sr_panel.display 里有两个 OD，差别在于**能不能反映 HT**：
       · display.displayOd —— osu!stable 的「apparent OD」延拓口径。
         只在判定窗 < 20ms（即 OD 已到顶 10 且带 DT）时才启用 >10 的延拓，
         **HT 完全不生效**（rate 0.75 把判定窗变宽，公式直接返回封顶值）。
       · display.displayOdLazer —— **osu! 官方口径**
         （reference-csharp/More/osu.Game.Rulesets.Taiko_TaikoRuleset.cs:310
          用 InverseDifficultyRange 从判定窗反解）。
         官方单测 TaikoRateAdjustedDisplayDifficultyTest 断言：
             OD5 + HT → 1.11   （HT 让判定窗变宽 -> OD 显示值下降）
             OD5 + DT → 8.89
         HT 方向的 OD 变化只有这个口径算得出来。
       用户反馈的「HT(HR+HT / EZ+HT) 没有对 OD 产生影响」正是取错口径。*/
    const disp = (S2 && S2.display) || null;
    /* ★ 不做非负钳制**：官方公式是线性外推，判定窗足够宽时会算出负数
       （例：EZ+HT -> great 60.7ms 超出 range 上限 50ms -> -0.89）。
       既然是官方口径就原样显示，用户看到能明白「这个组合的判定窗宽到
       已经超出 OD 滑条范围」，比悄悄改成 0 更有信息量。
       为了让这个负数可解释，OD 后面用小字补上实际判定窗。*/
    const odShown = disp
      ? (typeof disp.displayOdLazer === 'number' ? disp.displayOdLazer : disp.od)
      : bm.od;
    const hpShown = disp ? (typeof disp.hp === 'number' ? disp.hp : bm.hp) : bm.hp;
    /* OD 后面的小字：实际 great 判定窗（ms）。有了它，OD 变成负数/
       突破 10 都能解释清楚 —— 那是判定窗变宽/变窄的直接结果。*/
    const odSuffix = disp && typeof disp.greatWindow === 'number'
      ? ` (${disp.greatWindow.toFixed(1)}ms)` : '';
    const bx = rx + PAD_IN + SIDE_GAP;
    /* 数值列宽：HP/OD 与 skill/SR **必须一致**，否则右端数值会错位。
       最坏情况有两个，都必须放得下：
       a) Star Rating 行：`10.00★ (+12.34)`
          —— 主数值 6 半角 + ★ + 空格 + 括号 + 变化值（变化值用小一号字）
       b) OD 行：`-0.89 (66.7ms)` —— 负 OD + 判定窗（同样小一号字）
       按这两种里更宽的那个算。没有变化值/后缀时这段会空着，
       只是条形短一点，不影响可读性。*/
    const valEm = F(17, 10);
    const smallEm = F(13, 9);
    /* (a) "100.00" + "★" + " " */
    const mainW = 6 * 0.58 * valEm + 0.7 * valEm + 0.3 * valEm;
    /* " (+12.34)" —— 9 个半角 @小字号 */
    const dltW = 9 * 0.6 * smallEm;
    /* (b) " (-0.89)" 8 半角 + " (66.7ms)" 8 半角 —— 同样@小字号 */
    const odW = 16 * 0.6 * smallEm;
    const VAL_W = Math.ceil(Math.max(F(52, 28), mainW + dltW, mainW * 0.75 + odW) + 8);
    /* ★ 注意：这里传的是「整块可用宽度」，**不能**先扣掉 LABEL_COL/VAL_W。
       _barGeom(x, fullW, labW, valW) 内部会自己扣 —— 之前调用方先扣了一遍、
       _barGeom 又扣一遍，**双重扣减**把条形压到了 20px 的下限
       （用户反馈「条形图怎么变这么短了」）。VAL_W 从 52 涨到 128 之后
       多扣的 76px 全部打在条形上，所以问题正好在这次改动后暴露。*/
    const fullW = Math.max(60, innerR - bx);
    let by = panelY + L.BARS_Y0;
    /* 前两条固定是 HP / OD —— 即使用户没开信息栏数据也显示，
       这两个值是谱面自带的、跟 SR/PP 计算无关。

       OD 小数位**按是否真的改了 OD 自适应**（用户要求：「od 平常是一位小数，
       如果开了 mod 之后需要有两位再显示两位」）。
       注意判据不能是「有没有勾 mod」—— CL/HD/FL 虽然勾了，
       但它们**不改任何难度参数**（TAIKO_MODS 里 od/sm/rate 全是 1.0），
       OD 原样，多给一位小数只是噪音。真正需要两位的是
       EZ/HR（改 OD）、HT/DT（改判定窗 -> OD 显示值变）。
       所以判据是 `odShown !== bm.od`，用容差 0.005 吸收浮点误差。*/
    const odChanged = Math.abs(odShown - bm.od) >= 0.005;
    const decFor = (base) => (odChanged ? Math.max(base, 2) : base);
    const bars = [
      { label: "HP", v: hpShown, color: "#ffffff", over: "#ff3b30", dec: 1, suffix: '' },
      /* OD 后面补实际判定窗 —— 官方公式是线性外推，可能算出负数或 >10，
         有了判定窗这些值就能被解释成「这个组合的判定窗有多宽」。*/
      { label: "OD", v: odShown, color: "#ffffff", over: "#ff3b30",
        dec: decFor(1), suffix: odSuffix },
    ];
    for (const b of bars) {
      this._drawMeterBar(ctx, bx, by, fullW, L.BAR_H, b.label, b.v,
                         b.color, b.over, b.dec, L.LABEL_COL, F(18, 10), F(20, 11),
                         VAL_W, b.suffix);
      by += L.BAR_STEP;
    }

    if (S2 && S2.rows && S2.rows.length) {
      this._drawSkillBars(ctx, bx, by, fullW, S2, F, L, VAL_W);
    } else {
      /* 没有 SR 数据（极少见）：退回密度两条，保持信息量 */
      const more = [
        { label: "全曲密度", v: den.avg, color: "#ffffff", over: "#ff3b30", dec: 2 },
        { label: "最密 30%", v: den.peak, color: "#ffd23f", over: "#ff3b30", dec: 2 },
      ];
      for (const b of more) {
        this._drawMeterBar(ctx, bx, by, fullW, L.BAR_H, b.label, b.v,
                           b.color, b.over, b.dec, L.LABEL_COL, F(18, 10), F(20, 11),
                           VAL_W);
        by += L.BAR_STEP;
      }
    }

    ctx.restore();
    /* 注意：这里**故意不画**底部那行「osu!taiko 谱面预览 / N / M」——
       用户反馈「信息栏和预览图中间有文字和一块空白」，删掉文字后那段留白
       也一起去掉了（headerLayout 的 H 也同步减掉了这段高度）。*/
  }

  /**
   * 右下角「最大 PP + mod 缩写」。
   *
   * mod 缩写的格式（用户要求）：
   *   一个 mod 都没选  -> `None`
   *   选了任意 mod    -> `+EZ,HD,DT,CL`（加号最前，逗号分隔）
   * 顺序固定 EZ/HR -> HD/FL -> HT/DT -> CL，由 content.js 的
   * currentModLabel() 负责，这里只管画。
   *
   * @param {number} rightX 右对齐的基准 x
   * @param {number} baseY PP 文字的基线 y
   */
  _drawMaxPp(ctx, rightX, baseY, F, availW) {
    const S2 = this.opts.srData;
    if (!S2 || !(S2.maxPp > 0)) return;
    const label = S2.modLabel || 'None';
    const ppTxt = `${Math.round(S2.maxPp)}PP`;
    /* 字号必须**按实际文本自适应**，否则窄窗口会溢出左栏：
       用户要求「PP 与 mod 的字体再大一点」，但直接用F(50,34)/F(24,16) 时
       最坏情况（4 位 PP + 全勾 mod"+HR,HD,FL,DT,CL"）在 420px 窗口下
       会超出左栏 111px 可用宽度 —— 变成左边被画布裁掉。
       所以：先按理想字号算，宽度不够就等比缩小到刚好放得下。*/
    const W = availW > 0 ? availW : 9999;
    /* 半角字符宽 ≈ 0.6em（实测比 0.5 略宽，"P"/"M" 这类尤其宽） */
    const fit = (size, txt) => size * Math.min(1, W / Math.max(1, txt.length * 0.6 * size));
    let ppSize = fit(F(50, 34), ppTxt);
    let modSize = fit(F(24, 16), label);
    /* 极端窄栏时的下限（再小就读不出来了，宁可截断） */
    ppSize = Math.max(14, ppSize);
    modSize = Math.max(10, modSize);

    /* 两行间距跟着字号走：mod 基线 = PP 基线 - (ppSize × 0.82) */
    const modBase = baseY - ppSize * 0.82;

    /* mod 缩写（小字，在 PP 上方）*/
    ctx.fillStyle = "#b4bcd0";
    ctx.font = `700 ${modSize}px "Segoe UI", "Microsoft YaHei", sans-serif`;
    ctx.textAlign = "right";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(this._ellipsis(ctx, label, W), rightX, modBase);

    /* 最大 PP（大字）*/
    ctx.fillStyle = "#ffffff";
    ctx.font = `700 ${ppSize}px "Segoe UI", "Microsoft YaHei", sans-serif`;
    ctx.fillText(this._ellipsis(ctx, ppTxt, W), rightX, baseY);
    ctx.textAlign = "left";
  }

  /**
   * 四项 skill 占比 + Star Rating 的条形。
   *
   * 刻度按用户要求**逐项不同**（没有单一刻度能同时兼顾体力与其它三项）：
   *   体力 Stamina  右端 65%（它常年占40~60%，用 70% 会顶格看不出差别）
   *   其余三项       右端 45%
   *   Star Rating    右端 10
   * 标签只留英文（用户要求去掉中文字）。
   *
   * 与 HP / OD 两条**共用同一组 x坐标与宽度**（都传 bx / fullW），
   * 所以条形左端、条形长度、右端数值列都严格对齐。
   *
   * ★ 溢出：`_drawRatioBar` 的两段式渲染与 `_drawMeterBar` 同语义
   *   （正常段用本色、超限段红色从左起覆盖、上限 2×刻度后封顶）。
   *   四条 skill 占比恒在 0~1 之间、实际不会溢出；
   *   **Star Rating 会溢出**（DT 下 10+ 星很常见），这条就是为它准备的。
   */
  _drawSkillBars(ctx, x, y, w, S2, F, L, valColW) {
    /* 顺序**固定**为 Stamina / Colour / Rhythm / Reading（用户要求）。
     * 之前是按占比从大到小排序 —— 后果是「换个 mod、某项占比变了，
     * 那一行就跳到别的位置」，四条 bar 在视觉上会左右乱窜，很难对比。
     * 固定顺序后，改 mod 只会让**长度**变，位置不动。*/
    const ORDER = ['stamina', 'colour', 'rhythm', 'reading'];
    const byKey = Object.create(null);
    for (const r of (S2.rows || [])) byKey[r.key] = r;
    const sorted = ORDER
      .map((k) => byKey[k])
      .filter(Boolean);
    /* sr_panel 若将来新增 skill，兜底补在后面（不至于整条消失）*/
    if (sorted.length < (S2.rows || []).length) {
      for (const r of (S2.rows || [])) {
        if (ORDER.indexOf(r.key) < 0) sorted.push(r);
      }
    }
    const SR_MAX = 10;
    /* 逐项刻度：体力 65%，其余 45% */
    const RATIO_MAX_STAMINA = 0.65;
    const RATIO_MAX_OTHER = 0.45;
    const barH = F(15, 9);
    const step = F(31, 16);
    /* 标签列用 headerLayout 算好的 LABEL_COL —— 它是按「最宽标签」反推的，
       这里若自己另算一份就会比版式预留的窄，标签被 _ellipsis 截断。*/
    const labW = L.LABEL_COL;
    /* 数值列由调用方传入（与 HP/OD 共用同��个，保证右端对齐）*/
    const valW = valColW > 0 ? valColW : Math.ceil(Math.max(F(52, 28), 6 * 0.58 * F(17, 10) + 6));

    let by = y;
    for (const r of sorted) {
      const isStamina = r.key === 'stamina';
      const vmax = isStamina ? RATIO_MAX_STAMINA : RATIO_MAX_OTHER;
      /* 标签只留英文（`en`），去掉中文 */
      const label = r.en || r.key || '?';
      this._drawRatioBar(ctx, x, by, w, barH, label,
                         r.ratio || 0, r.color || '#ffd23f', vmax,
                         labW, w, valW, F);
      by += step;
    }
    /* Star Rating 单独一条，刻度 0~10。
     * ★ 若当前 mod 让星数与基准不同，在后面追加变化值，如 `10.00 (+1.23)`。
     *   基准 = 只保留 CL/HD/FL（content.js 的 baseStarRating）。
     *   差值在 0.005 以内视为「没变」（CL/HD/FL 理论上不改星数，
     *   但浮点误差可能带来 1e-15 的差异）。
     *
     * ★ 溢出：星数可以超过 10（DT 下的高星谱很常见，10+ 也不罕见），
     *   走_drawRatioBar 的超限段渲染 —— 红色**从左端覆盖**，
     *   语义与 HP/OD 完全一致（10 格正常段 + 10 格超限段）。
     *   不传 overColor，沿用默认的 #ff3b30。*/
    let deltaTxt = '';
    const base = S2.starRatingBase;
    if (typeof base === 'number' && base > 0) {
      const d = (S2.starRating || 0) - base;
      if (Math.abs(d) >= 0.005) {
        deltaTxt = ` (${d >= 0 ? '+' : ''}${d.toFixed(2)})`;
      }
    }
    this._drawRatioBar(ctx, x, by, w, barH, 'Star Rating',
                       S2.starRating || 0, '#7ad4ff', SR_MAX,
                       labW, w, valW, F, /* 带★ 后缀 */ true, deltaTxt);
  }

  /**
   * 刻度条的统一版式几何（**HP/OD 与 skill/SR 共用**）。
   *
   * 之前 `_drawMeterBar` 与 `_drawRatioBar` 各自算「标签列宽 + 间隙」，
   * 两套公式差2px，导致用户看到的「HP/OD 与 skill 条没对齐」。
   * 现在抽成一个函数返回 {tx, tw, valX}，两个绘制函数都用它，
   * 对齐就是**结构性保证**，而不是靠两处数字凑巧相等。
   *
   * @param {number} x 左边界
   * @param {number} w 可用总宽
   * @param {number} labW 标签列宽
   * @param {number} valW 数值列宽
   * @returns {{tx:number, tw:number, valX:number}}
   */
  _barGeom(x, w, labW, valW) {
    const gapTx = 8;                /* 标签列与条形之间的间隙 */
    const gapVal = 6;               /* 条形与数值之间的间隙 */
    const tx = x + labW + gapTx;
    const tw = Math.max(20, w - labW - valW - gapTx - gapVal);
    return { tx, tw, valX: tx + tw + gapVal };
  }

  /**
   * 一条占比/数值条：标签 + 条形 + 数值。
   * 数值默认写成「12.34」（省略百分号），star 模式再加「★」+ 变化值。
   *
   * @param {string} [suffix] 追加在数值后面的小字（如 " (+1.23)"），
   *   用**更小的字号与更暗的颜色**画 —— 它是补充信息，不该和主数值抢眼。
   */
  _drawRatioBar(ctx, x, y, barW, barH, label, value, color, vmax,
                 labW, fullW, valW, F, isStar = false, suffix = '',
                 overColor = null) {
    /* ★ 溢出处理与 HP/OD 完全一致：正常段用 color，超限段用红色**从左起覆盖**。
     *
     * 之前这里是 `Math.min(1, value / vmax)` —— 直接夹到满格，
     * 于是 Star Rating 超过 10（DT 下的高星谱很常见）就顶格，
     * 3.50 和 30.00 长得一模一样，完全看不出「超了多少」。
     * 参照 _drawMeterBar 的 CAP 语义改成两段：
     *   正常段 = min(v, vmax)      -> color
     *   超限段 = min(v - vmax, vmax) -> overColor（默认红）
     * 两段都从**最左端**画起，所以超限部分会盖在正常段上（正是用户要的「从左起覆盖」）。
     * 上限再翻一倍（2 × vmax）后不再渲染，避免极端值把条形画到界外。*/
    const CAP = 2;
    const v = Math.max(0, Math.min(vmax * CAP, value || 0));

    ctx.textBaseline = "middle";

    /* 标签（右对齐到标签列右缘）*/
    ctx.font = `${F(16, 9)}px "Segoe UI", "Microsoft YaHei", sans-serif`;
    ctx.fillStyle = "#d6d8e0";
    ctx.textAlign = "right";
    ctx.fillText(this._ellipsis(ctx, String(label), labW - 6), x + labW - LABEL_PAD, y + barH / 2);

    /* 版式与 HP/OD 共用，保证左右严格对齐 */
    const g = this._barGeom(x, fullW, labW, valW);
    roundRect(ctx, g.tx, y, g.tw, barH, Math.min(3, barH / 3));
    ctx.fillStyle = "rgba(255,255,255,0.10)";
    ctx.fill();

    /* 正常段（0 ~ min(v, vmax)）*/
    const normalW = g.tw * Math.min(v, vmax) / vmax;
    if (normalW > 0) {
      ctx.fillStyle = color;
      ctx.fillRect(g.tx, y, normalW, barH);
    }
    /* 超限段（min(v, 2·vmax) - vmax），从左端覆盖在正常段之上 */
    const overV = Math.max(0, v - vmax);
    if (overV > 0) {
      ctx.fillStyle = overColor || "#ff3b30";
      ctx.fillRect(g.tx, y, g.tw * overV / vmax, barH);
    }

    /* 数值：省略百分号、两位小数 */
    ctx.fillStyle = "#ffffff";
    ctx.font = `700 ${F(17, 10)}px "Segoe UI", "Microsoft YaHei", sans-serif`;
    ctx.textAlign = "left";
    const txt = isStar
      ? `${(value || 0).toFixed(2)}★`
      : (value * 100).toFixed(2);
    /* 变化值可能很长（" (+12.34)"），所以主数值不截断，
       整个「数值 + 变化值」共用 valW，超了才截。*/
    ctx.fillText(this._ellipsis(ctx, txt, valW - 4), g.valX, y + barH / 2);
    if (suffix) {
      const adv = ctx.measureText(txt).width;
      /* 小一号、暗一档：它是「相对基准的变化」而非星数本身 */
      ctx.font = `600 ${F(13, 9)}px "Segoe UI", "Microsoft YaHei", sans-serif`;
      ctx.fillStyle = suffix.indexOf('-') >= 0 ? "#ff8a80" : "#8ce99a";
      ctx.fillText(this._ellipsis(ctx, suffix, Math.max(8, valW - 4 - adv)),
        g.valX + adv, y + barH / 2);
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    void barW;
  }

  /**
   * 刻度条：总长 10 格。
   *   值<=10：整条用 color（白 / 黄）
   *   值 >10：红色从**最左端**起向右覆盖（宽度 = min(v,10)/10），
   *           右端剩余部分留空 —— 「超限」一眼看得出超了多少。
   *   值 >20：按 20 封顶，不再渲染。
   *
   * 版式：四条刻度条的**标签右对齐、条形等宽、数值左对齐**，
   * 保证四条上下对齐成整齐的一列（视觉上像表格）。
   * @param {number} dec 数值小数位数
   * @param {number} labelColW 标签列宽（<=0 时用模块常量，小窗按比例缩）
   * @param {number} fontLab 标签字号（px）
   * @param {number} fontVal 数值字号（px）
   * @param {number} valColW 数值列宽（与 skill/SR 条共用，保证右端对齐）
   * @param {string} [suffix] 数值后面的小字补充说明（如 " (34.5ms)"）
   */
  _drawMeterBar(ctx, x, y, w, h, label, value, color, over, dec = 1,
                labelColW = 0, fontLab = 18, fontVal = 20, valColW = 0,
                suffix = '') {
    ctx.textBaseline = "middle";
    const colW = labelColW > 0 ? labelColW : LABEL_COL_W;
    const vcolW = valColW > 0 ? valColW : 50;

    /* 标签**右对齐**到固定基线，各条标签的右边缘一致。
       锚点用 x + colW - LABEL_PAD（与 _drawRatioBar 完全相同）——
       之前这里写的是 x + colW，两处差 LABEL_PAD 个像素，
       用户看到的正是「HP/OD 与下面几条没对齐」。*/
    ctx.font = `${fontLab}px "Segoe UI", "Microsoft YaHei", sans-serif`;
    const labX = x + colW - LABEL_PAD;
    ctx.fillStyle = "#d6d8e0";
    ctx.textAlign = "right";
    /* 标签本身也可能超出列宽（小窗里"全曲密度"四个字更宽）*/
    ctx.fillText(this._ellipsis(ctx, label, colW - 4), labX, y + h / 2);

    /* 条形：与 skill/SR 条**共用同一份版式几何**，保证左右严格对齐 */
    const g = this._barGeom(x, w, colW, vcolW);
    roundRect(ctx, g.tx, y, g.tw, h, Math.min(3, h / 3));
    ctx.fillStyle = "rgba(255,255,255,0.10)";
    ctx.fill();

    const CAP = 20;                        /* 超过 20 不再渲染 */
    const v = Math.max(0, Math.min(CAP, value || 0));
    /* 未超限部分（0~min(v,10)）用底色；超限部分用红色**从左端覆盖** */
    const normalW = g.tw * Math.min(v, 10) / 10;
    if (normalW > 0) {
      ctx.fillStyle = color;
      ctx.fillRect(g.tx, y, normalW, h);
    }
    const overV = Math.max(0, v - 10);
    if (overV > 0) {
      ctx.fillStyle = over || "#ff3b30";
      ctx.fillRect(g.tx, y, g.tw * overV / 10, h);
    }

    /* 数值：**左对齐**，位置与 skill/SR 条的数值列一致 */
    ctx.fillStyle = "#ffffff";
    ctx.font = `700 ${fontVal}px "Segoe UI", "Microsoft YaHei", sans-serif`;
    ctx.textAlign = "left";
    const main = value.toFixed(dec);
    ctx.fillText(this._ellipsis(ctx, main, vcolW - 4), g.valX, y + h / 2);
    /* 后缀（小字与主数值同色 —— 它是同一个量的补充说明，不是「变化量」，
       所以不能像 Star Rating 的 (+1.23) 那样染成绿/红）*/
    if (suffix) {
      const adv = ctx.measureText(main).width;
      ctx.font = `500 ${Math.round(fontVal * 0.72)}px "Segoe UI", "Microsoft YaHei", sans-serif`;
      ctx.fillStyle = "#aab0c0";
      ctx.fillText(this._ellipsis(ctx, suffix, Math.max(8, vcolW - 4 - adv)),
        g.valX + adv, y + h / 2);
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
  }

  /**
   * 右上角统计条目。**顺序固定**为：
   *   [0] 时长  [1] 红饼  [2] 蓝饼
   *   [3] BPM   [4] 连打  [5] 转盘
   * 这样两行各三项恒定对齐，不随内容长短漂移。
   */
  _headerStats() {
    const bm = this.bm;
    const out = new Array(6).fill(null);
    /* ---- mod 速率：DT/NC = 1.5，HT = 0.75，其余 1 ----
     * 时长与 BPM 都按它折算（用户要求）：
     *   DT/NC：时长 ÷1.5、BPM ×1.5
     *   HT   ：时长 ÷0.75、BPM ×0.75（即 ×4/3）
     * 没有这个折算的话，开DT 时标题栏还显示 3:38、画布里却按 1.5 倍速读谱，
     * 数值会自相矛盾。*/
    const rate = this._modRate();
    /* [0] 时长：显示「总时长(有效时长)」
       有效时长 = 首个物件到歌曲结束、扣除休息段后的时长。
       两者都按 rate 折算。*/
    const totalSec = lengthMs(bm) / 1000 / rate;
    const playSec = playableMs(bm) / 1000 / rate;
    const fmt = (sec) => {
      const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
      return `${m}:${String(s).padStart(2, "0")}`;
    };
    out[0] = { icon: icClock,
      text: fmt(totalSec) === fmt(playSec)
        ? fmt(totalSec)
        : `${fmt(totalSec)}(${fmt(playSec)})` };

    /* [1] 红饼(红大饼) / [2] 蓝饼(蓝大饼) */
    let red = 0, redBig = 0, blue = 0, blueBig = 0, roll = 0, spinner = 0;
    for (const n of bm.notes) {
      if (n.kind === NOTE_ROLL) roll++;
      else if (n.kind === NOTE_SPINNER) spinner++;
      else if (n.blue) { blue++; if (n.kind === NOTE_BIG) blueBig++; }
      else { red++; if (n.kind === NOTE_BIG) redBig++; }
    }
    out[1] = {
      icon: (ctx, x, y, s) => icDon(ctx, x, y, s, "#e8484a"),
      text: `${red}(${redBig})`,
    };
    out[2] = {
      icon: (ctx, x, y, s) => icDon(ctx, x, y, s, "#4aa8e8"),
      text: `${blue}(${blueBig})`,
    };

    /* [3] BPM：范围(主 BPM)，按 rate 折算。
       保留一位小数——这些谱的 BPM 常带 .5（95.5 / 199.9），
       取整会显示成 96 / 200，与实际值不符。 */
    const br = this.bpmRange();
    if (br) {
      /* 只在 rate != 1 时乘，且**四舍五入到整数**（用户要求）。
         不取整会出现 230×1.5=345 之外的 172.5 这种半整数尾巴。*/
      const scaled = rate === 1
        ? br
        : { min: Math.round(br.min * rate), max: Math.round(br.max * rate),
            main: Math.round(br.main * rate) };
      out[3] = { icon: icGauge, text: fmtBpmRange(scaled) };
    }

    /* [4] 连打：头 + 绿虚线 + 尾；[5] 转盘 */
    out[4] = { icon: (ctx, x, y, s) => icRoll(ctx, x, y, s), text: `${roll}` };
    out[5] = { icon: (ctx, x, y, s) => icSpinner(ctx, x, y, s), text: `${spinner}` };
    return out;
  }

/** 按最大宽度截断文本并加省略号 */
  _ellipsis(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1);
    return t + "…";
  }

  /**
   * 按最大宽度自适应字号地绘制一行文本。
   * @param {string} weight 字重（'700' | '600' | '500'）
   * @param {number} minSize 允许缩到的最小字号（小窗需要更小的下限）
   */
  _fitText(ctx, text, x, y, maxW, baseSize, weight = "700", minSize = 12) {
    let size = baseSize;
    ctx.font = `${weight} ${size}px "Segoe UI", "Microsoft YaHei", sans-serif`;
    let t = text;
    while (ctx.measureText(t).width > maxW && size > minSize) {
      size -= 1;
      ctx.font = `${weight} ${size}px "Segoe UI", "Microsoft YaHei", sans-serif`;
    }
    if (ctx.measureText(t).width > maxW) {
      while (t.length > 1 && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1);
      t += "…";
    }
    ctx.fillText(t, x, y);
  }

  /** 整分钟蓝色时间线（1:00 / 2:00 ...），标签在轨道内侧底部 */
  _drawMinuteLines(ctx, lay, rows, yOff, heights, trackH) {
    const marks = lay.minuteMarks || [];
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.font = `${this.fontLabel}px ${ROUND_FONT}`;
    for (const [t, label] of marks) {
      const r = lay.rowAt(t);
      if (!yOff.hasOwnProperty(r)) continue;
      const x = Math.round(lay.xInRow(t)) + 0.5;
      if (x < 0 || x > lay.totalWidth) continue;
      const y0 = yOff[r] + (heights[r] - trackH) / 2, hh = trackH;
      ctx.strokeStyle = "#5a96f0";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y0 + hh);
      ctx.stroke();
      ctx.fillStyle = "#82b4fa";
      ctx.textAlign = "center";
      ctx.fillText(label, x, y0 + hh);
      ctx.textAlign = "left";
    }
  }

  /** 白色小节线 + 小节序号：只画在所属行内 */
  _drawMeasureLines(ctx, lay, rows, yOff, heights, trackH) {
    /* 与红线（BPM 变化）重合的位置只画红线，不画小节线与序号 */
    const bpmPos = new Set();
    for (const [t] of lay.bpmMarks) {
      bpmPos.add(lay.rowAt(t) + ":" + Math.round(lay.xInRow(t)));
    }
    const yOf = (r) => yOff[r] + (heights[r] - trackH) / 2;

    ctx.strokeStyle = "#ebebf0";
    ctx.lineWidth = 1;
    ctx.beginPath();
    /* 预计算「行首孤立编号」：该小节线是本行第一条、且不是预览起点的小节。
       必须预计算 —— 小节线可能有 8000+ 条，逐次扫全表会拖垮渲染。 */
    const orphanRows = this._computeOrphanRows(lay);
    for (const [t] of lay.measureTimes) {
      const r = lay.rowAt(t);
      if (!yOff.hasOwnProperty(r)) continue;
      const xi = Math.round(lay.xInRow(t));
      const x = xi + 0.5;
      if (x < 0 || x > lay.totalWidth) continue;
      /*复用上面已算好的整数 x —— 原代码在这里第二次调用 xInRow，
         8325 条小节线时白白多算一遍（比赛谱可达 8000+ 条）。*/
      if (bpmPos.has(r + ":" + xi)) continue;
      const y = yOf(r);
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + trackH);
    }
    ctx.stroke();
    /* 小节序号：居中对齐在小节线正上方。
       **竖线全部保留**（画在音符下层，压多少都不影响读谱），
       只有数字按**实际字宽**避让 —— 超密集时放不下的直接跳过，
       宁可少标，也不能叠字。

       注意：该循环要遍历全部小节线（比赛谱可达 8000+ 条），
       因此行首孤立编号的判断必须预计算，不能在循环内反复扫全表。*/
    ctx.fillStyle = "#d7d7e1";
    ctx.font = `${this.fontLabel}px ${ROUND_FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#96969e";
    /* 每行已绘数字的右边界，用于避让（各行独立，故按行取） */
    const mnoRight = {};
    for (const [t, mno] of lay.measureTimes) {
      const r = lay.rowAt(t);
      if (!yOff.hasOwnProperty(r)) continue;
      const x = Math.round(lay.xInRow(t));
      if (x < 0 || x > lay.totalWidth) continue;
      if (bpmPos.has(r + ":" + x)) continue;
      /* 行首非整小节的孤立编号不画（该行从上一小节中间开始，数字无参照意义） */
      if (orphanRows.has(r + ":" + t)) continue;
      const label = String(mno);
      const w = label.length * 7;
      /* 与本行已绘数字相交则跳过 */
      if (mnoRight[r] !== undefined && x - w / 2 < mnoRight[r] + 4) continue;
      mnoRight[r] = x + w / 2;
      /* 线的正上方：底部基线对齐轨道上沿，水平居中于线 */
      ctx.textBaseline = "bottom";
      ctx.fillText(label, x, yOf(r));
      ctx.textBaseline = "alphabetic";
    }
    ctx.textAlign = "left";
  }

  /**
   * 判断某个小节线是否属于「行首孤立编号」——即该小节线是本行第一条小节线，
   * 且它并非小节 1（预览起点）。这类数字紧贴行首左侧，看起来像悬空残留。
   */
  /**
   * 批量计算「行首孤立编号」，返回 Set<"row:time">。
   *
   * 孤立编号 = 该小节线是**本行第一条**、且**不是预览起点的小节**、
   * 且紧贴左边距。这类数字悬在行首没有参照意义，看起来像残留。
   *
   * 必须批量算：比赛谱的小节线可达 8000+ 条，逐条扫全表是 O(n²)。
   */
  _computeOrphanRows(lay) {
    const out = new Set();
    const mt = lay.measureTimes;
    if (!mt.length) return out;
    const firstT = mt[0][0];              /* 预览起点的小节，必须显示 */
    /* 一次遍历收集每行最小 time */
    const rowMin = new Map();
    for (const [t] of mt) {
      const r = lay.rowAt(t);
      const cur = rowMin.get(r);
      if (cur === undefined || t < cur) rowMin.set(r, t);
    }
    for (const [r, t] of rowMin) {
      if (t === firstT) continue;
      if (lay.xInRow(t) < lay.marginX + 12) out.add(r + ":" + t);
    }
    return out;
  }

  /**

  /**
   * BPM 红线 / SV 绿线：只画在所属行内，高度仅一行。
   *   红线 = 实线，数字在线**上方**
   *   绿线 = 虚线，数字在线**下方**
   * 数字用圆润小字体，多标签自动避让。
   */
  _drawChangeLines(ctx, lay, rows, yOff, heights, trackH, kind) {
    const isBpm = (kind === "bpm");
    const marks = isBpm ? lay.bpmMarks : (lay.svMarksFull || lay.svMarks || []);
    const stroke = isBpm ? "#e83a44" : "#40804e";
    const textC = isBpm ? "#ff606a" : "#76be8a";
    const lineW = isBpm ? 2 : 1;

    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.font = `${this.fontLabel}px ${ROUND_FONT}`;

    /* 槽位数**按每行实际标记数自适应**。
       稀疏行 5~6 槽足够；密集行（如 Feryquitous - Ai C 一行 80+ 条红线）
       需要更多槽位才能把数字摊开，否则只能靠"放不下就不画"，
       导致关键信息缺失。 */
    const perRow = {};
    for (const it of marks) {
      const rr = lay.rowAt(it[0]);
      perRow[rr] = (perRow[rr] || 0) + 1;
    }
    const slotRight = {};
    /* 槽位刻意保持很少（3~4 个）。
       槽位只是让**同一簇内相邻的几个**标签水平错开；
       给多了会让 slot 一路涨到上限、判定"放得下"，标签就永远留在
       layer 0，纵向堆叠形同虚设（实测 82 个标签全挤在一层）。
       簇内错开交给槽位，簇与簇之间交给**层**。*/
    const slotsFor = (r) => {
      const n = perRow[r] || 0;
      return n <= 8 ? 3 : 4;
    };

    /* 密集行**按值聚合**（关键）。
       压力测试谱面里一行可能有 80+ 条红线，但 distinct 值往往只有 2~3 个
       （实测row 2：82 条红线中 95.5 出现 41 次、199.9 出现 40 次、191 一次）。
       逐条标注同样的数字既叠字又毫无信息量。

       做法：竖线全部照画（保留节奏感），但**数字只在该值首次出现时标注**，
       后续相同值跳过。若整行的distinct 值仍过多（>6），退化为按层避让。*/
    const distinctCnt = {};
    for (const item of marks) {
      const rr = lay.rowAt(item[0]);
      if (!distinctCnt[rr]) distinctCnt[rr] = new Set();
      distinctCnt[rr].add(String(item[1].toFixed ? item[1].toFixed(1) : item[1]));
    }
    /* 该行distinct 值数量：>6 说明值太多，按值聚合不划算，改用层避让 */
    const tooManyVals = {};
    /* 绘制过程中记录「本行已标注过的值」 */
    const seenValInRow = {};
    for (const rr of Object.keys(distinctCnt)) {
      tooManyVals[rr] = distinctCnt[rr].size > 6;
      seenValInRow[rr] = new Set();
    }

    for (const item of marks) {
      const t = item[0], val = item[1];
      const r = lay.rowAt(t);
      if (!yOff.hasOwnProperty(r)) continue;
      const x = Math.round(lay.xInRow(t)) + 0.5;
      if (x < -20 || x > lay.totalWidth + 20) continue;
      const y0 = yOff[r] + (heights[r] - trackH) / 2, hh = trackH;

      let txt, y, side, sideIdx;
      /* SV 项为 (t, val, 是否完整)，BPM 项为 (t, val) */
      const full = item.length > 2 ? item[2] : true;
      if (isBpm) {
        sideIdx = 0;
        ctx.strokeStyle = stroke;
        ctx.lineWidth = lineW;
        ctx.beginPath();
        ctx.moveTo(x, y0);
        ctx.lineTo(x, y0 + hh);
        ctx.stroke();
        txt = Math.abs(val - Math.round(val)) < 0.5 ? val.toFixed(0) : val.toFixed(1);
        y = y0; side = "up";
      } else {
        sideIdx = 1;
        dashedVLine(ctx, x, y0, hh, stroke, lineW);
        /* 段内中间项省略整数位（段首段尾已给出完整数值） */
        txt = fmtSv(val, !full);
        y = y0 + hh; side = "dn";
      }

      /* 按值聚合：密集行里同一数值只标注一次，后续重复值跳过数字
         （竖线仍全部照画，保留节奏感）。
         值太多（distinct > 6）时不聚合，退回层避让。

         注意：值要**放置成功后才记录**。若在避让前就标记 seen，
         遇到两个相同值挤在一起时（实测 x=70 与 x=73），
         后者会因"已见过"被直接跳过，恰好漏掉唯一能拉开间距的那个。*/
      const valKey = String(val.toFixed ? val.toFixed(1) : val);
      const aggregate = !tooManyVals[r];
      if (aggregate && seenValInRow[r].has(valKey)) continue;

      /* 标签避让：**二维**（层 + 槽位）。
         layer 0 是紧贴线的一层（y 严格贴线，保持原有观感）；
         放不下时向上/向下退到下一层，每层抬高 LABEL_LINE_H。
         密集行已在 layout 阶段加高（denseRows），这里最多退到
         denseRows[r] 层，不会侵占相邻行。

         所有层都放不下时**只画线、不画数字** —— 宁可少标也不能叠字。*/
      const w = ctx.measureText(txt).width;
      const SLOTS = slotsFor(r);
      const maxLayers = (lay.denseRows[r] || 0) + 1;
      /* key 用 side*100000 + layer*1000 + slot，避免各维度互相撞车 */
      const keyBase = r * 10000000 + sideIdx * 100000;
      let placed = false;
      for (let layer = 0; layer < maxLayers && !placed; layer++) {
        const layerBase = keyBase + layer * 1000;
        /* 高层水平偏移更大，彻底错开同簇标签。
           步进须 >= 数字宽度（约 20px），否则两个相同值挤在
           x=70 / x=73 时仍会叠成一个模糊长串。 */
        const step = this.slotDx * (1 + layer);
        let slot = 0;
        while (slot < SLOTS - 1 && slotRight[layerBase + slot] !== undefined
               && x + slot * step - w / 2 < slotRight[layerBase + slot] + 5) slot++;
        const key = layerBase + slot;
        /* 判定用**实际绘制位置** x + slot*step，而不是原始 x。
           槽位已满（走到最后一个槽位仍冲突）-> 换到下一层。 */
        if (slotRight[key] !== undefined
            && x + slot * step - w / 2 < slotRight[key] + 5) continue;
        const dx = slot * step;
        /* layer>0 时垂直退让：BPM 向上抬，SV 向下压 */
        const dy = layer * LABEL_LINE_H * (side === "up" ? -1 : 1);
        ctx.fillStyle = textC;
        ctx.textAlign = "center";
        /* up用 bottom 基线（数字在线上方），dn 用 top 基线（数字在线下方） */
        ctx.textBaseline = (side === "up") ? "bottom" : "top";
        ctx.fillText(txt, x + dx, y + dy);
        ctx.textBaseline = "top";
        ctx.textAlign = "left";
        slotRight[key] = x + dx + w / 2;
        placed = true;
        /* 放置成功后才记录该值已标注（顺序很重要，见上方注释） */
        if (aggregate) seenValInRow[r].add(valKey);
      }
      /* placed=false -> 所有层都占满，保留竖线、跳过数字。
         此时不记录 valKey，后续相同值仍有机会在其他位置画出。*/
    }
  }

  /**
   * 同一位置既有绿线又有红线的合并标注：
   * 画红实线 + 标「红线」+ 上下两个数字（上 BPM / 下 SV）。
   */
  _drawCoincidentMarks(ctx, lay, rows, yOff, heights, trackH) {
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const bpmMap = new Map();
    for (const [t, v] of lay.bpmMarks) {
      const r = lay.rowAt(t);
      if (yOff.hasOwnProperty(r)) bpmMap.set(r + ":" + Math.round(lay.xInRow(t)), v);
    }
    ctx.font = `${this.fontSmall}px ${ROUND_FONT}`;
    for (const item of (lay.svMarksFull || lay.svMarks || [])) {
      const t = item[0], sv = item[1];
      const r = lay.rowAt(t);
      if (!yOff.hasOwnProperty(r)) continue;
      const x = Math.round(lay.xInRow(t));
      const bpm = bpmMap.get(r + ":" + x);
      if (bpm === undefined) continue;
      const y0 = yOff[r] + (heights[r] - trackH) / 2, hh = trackH;
      ctx.strokeStyle = "#e83a44";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, y0);
      ctx.lineTo(x + 0.5, y0 + hh);
      ctx.stroke();
      /* 只画 SV（下）。BPM（上）已由 _drawChangeLines 的红线分支画过，
         这里再画一次会形成重影/加粗，所以必须跳过。 */
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillStyle = "#76be8a";
      ctx.fillText(fmtSv(sv), x, y0 + hh);
      ctx.textAlign = "left";
    }
  }

  /**
   * 绘制连打（drum roll）。
   * 依据 osu! wiki 与工作区样例图：
   *   主体用 taiko-roll-middle.png 横向拉伸（该贴图是窄条，天然可拉伸）
   *   结尾用 taiko-roll-end.png 箭头收尾
   *   头尾用米色大/小饼连接（大连打用大饼）
   */
  /**
   * 绘制连打/转盘，**一行画不完就在下一行继续**。
   * 把 [time, endTime] 按行的时间窗口切片，每段落在它所属的行内。
   */
  _drawLong(ctx, n, lay, rows, yOff, heights, opts, kind) {
    /* 连打宽度用 length 字段（osu! 像素的视觉长度），不是时间轴宽度。
       依据工作区样例图实测：Frost Walker 连打 length=140，
       样例图里持续线 211px = 140 x 1.5，两端各一个 31px 圆饼，合计 272px。
       endTime 只用于确定时间跨度（延续到哪一行），不参与宽度计算。*/
    const rowMs = lay.rowDurationMs;
    const row0 = rows[0], row1 = rows[rows.length - 1] + 1;
    const tPageEnd = lay.t0 + row1 * rowMs;
    const end = Math.min(n.endTime, tPageEnd);
    const cfg = this.cfg;

    /* 连打宽度改用**时间轴比例**，与音符定位一致。
       历史 bug：用 osu! 的 length 字段 × 1.5 当视觉宽度
       （依据是 Frost Walker 的样例实测 211px = 140×1.5）。
       但样例图里连打是**跟着时间轴走**的 —— 一行有多根连打时，
       用 length 定位会与它们前后的音符错位（样例图 SEISHUNNO_HACKING
       对照可见：连打起点应对齐它上方的音符）。
       length 只用于判断「太短装不下头尾饼」时退化。*/
    const visW = (kind === "roll")
      ? Math.max(cfg.noteDiameter * 2, (n.endTime - n.time) * lay.pxPerMs)
      : Math.max(cfg.noteDiameter, (n.endTime - n.time) * lay.pxPerMs);
    /* 转盘总时长在时间轴上对应的宽度（跨行时每段都按它切分） */
    const timeW = (n.endTime - n.time) * lay.pxPerMs;

    /* 连打饼半径**整条统一**，在 _drawLong 里算一次后传给每段。
     *
     * 历史 bug：半径原由 _drawRollSeg 按**每段自己的 segW** 计算
     * （r = max(3, min(noteD/2, segW/4))）。跨行时续行段往往很短
     * （尾段只占十几像素），r 就跟着变小 —— 表现为「进入下一行后
     * 连打突然变细」，前后粗细不一致。
     *
     * 正确做法：半径只取决于**整条连打的总宽**，各段共用同一个 r。
     */
    const bunR = (kind === "roll")
      ? Math.max(3, Math.min(cfg.noteDiameter / 2, timeW / 4))
      : 0;

    const rowSet = new Set(rows);
    let t = n.time, first = true;
    /* 兜底迭代上限：每个长物件最多跨「本页行数 +1」段。
       即使出现未预料的零推进，也不会卡死浏览器主线程。 */
    let guard = rows.length + 1;
    while (t < end && guard-- > 0) {
      const r = lay.rowAt(t);
      if (!rowSet.has(r)) { t = lay.t0 + (r + 1) * rowMs; continue; }
      const rowEndT = lay.t0 + (r + 1) * rowMs;
      const segEnd = Math.min(end, rowEndT);
      const xa = lay.xInRow(t);
      /* 段宽：连打与转盘都按**时间轴比例** = (segEnd - t) * pxPerMs。
         历史 bug（转盘）：首段用 visW（总宽），后续段用 xInRow 差值。
         跨行时首段画完 visW 后 t 仍停在首行内，视觉上绿线在行首
         就「断掉」，轨道背景也跟着不对。统一按时间切分后每段严丝合缝。*/
      const segW = Math.max(0, (segEnd - t) * lay.pxPerMs);
      if (segW > 1) {
        /* 连打/转盘画在**行中心**：它们是横贯全行的长条，不占子行。
           音符子行对称分布后中间层正好落在行中心，单子行时完全重合。*/
        const cy = yOff[r] + heights[r] / 2;
        /* isLast：该段是否**紧接连打真正结束点**（segEnd 已到 end）。
           跨行时中间的行只是「续接」，不该在那里画尾饼——
           尾饼只属于真正的结束位置（用户要求）。*/
        const isLast = segEnd >= end;
        if (kind === "roll") this._drawRollSeg(ctx, xa, segW, cy, opts, first, isLast, bunR);
        else this._drawSpinnerSeg(ctx, xa, segW, cy, opts, first);
      }
      first = false;
      /* 段宽现在严格等于 (segEnd - t) * pxPerMs，所以推进直接到 segEnd。
         早先连打用 `t + segW/pxPerMs` 推进，segW 为 0 时 t 原地不动
         造成死循环（网页端表现为「一直转圈、不出图」，
         Feryquitous - Ai C 的 5 个跨行连打必现）。 */
      t = segEnd;
    }
  }

  /**
   * 连打（drum roll）—— **实心头尾 + 中间暗橙持续线**。
   * 头尾饼宽 = 普通音符的 80%（且不超过总宽 35%），装不下时退化为单饼。
   */
  _drawRollSeg(ctx, lx, totalW, cy, opts, first, isLast, fixedR) {
    /* 黄色头尾圆饼（带与红/蓝饼同款的白框）+ 暗黄->红水平渐变。
       first = 首段（画头饼）；isLast = 该段紧接真正结束点（画尾饼）。
       跨行时中间段两者皆非 -> 只有渐变带，无饼。*/
    const cfg = this.cfg;
    /* 饼半径由 _drawLong 按**整条连打总宽**算好后传入（fixedR），
       各段共用同一个值 —— 否则跨行时续行段会因为自身太短而变细。
       这里的兜底只针对 fixedR 缺失的极端情况。*/
    const r = fixedR > 0
      ? fixedR
      : Math.max(3, Math.min(cfg.noteDiameter / 2, totalW / 4));
    const bunD = r * 2;
    const y0 = cy - r, y1 = cy + r;
    const bunCol = "rgb(250,206,58)";
    const ringCol = "#ffffff";
    const edgeCol = "rgb(255,238,168)";
    const cFrom = [196, 140, 46];   /* 左端压暗的深琥珀 */
    const cTo = [222, 58, 44];      /* 右端红 */
    const ringW = Math.max(1, r * 0.20);   /* 与普通音符白环同款 */

    /* 极短（< 2px）-> 连线本身都画不出来，用一个小圆点表示 */
    if (totalW < 4) {
      ctx.fillStyle = bunCol;
      ctx.beginPath();
      ctx.arc(lx + totalW / 2, cy, Math.max(1.5, totalW / 2), 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    /* 中间水平渐变：**接到两饼的圆心**（不是内缘）——
       渐变带压在饼下面，由饼覆盖外侧半圆，这样看起来是「饼在线端点」而非
       「线从饼里伸出」，衔接自然。用户反馈过两者没接上。*/
    const bx0 = lx, bx1 = lx + totalW;
    const bw = bx1 - bx0;
    if (bw >= 1) {
      const g = ctx.createLinearGradient(bx0, 0, bx1, 0);
      g.addColorStop(0, `rgb(${cFrom[0]},${cFrom[1]},${cFrom[2]})`);
      g.addColorStop(1, `rgb(${cTo[0]},${cTo[1]},${cTo[2]})`);
      ctx.fillStyle = g;
      ctx.fillRect(bx0, y0, bw, bunD);
      /* 上下亮描边 */
      ctx.fillStyle = edgeCol;
      const e = Math.max(1, r * 0.26);
      ctx.fillRect(bx0, y0, bw, e);
      ctx.fillRect(bx0, y1 - e, bw, e);
    }

    /* 两端正圆黄饼 + 同款白框。
       **中心对齐在端点上**：头饼圆心 = lx（起点），尾饼圆心 = lx+totalW（终点）。
       早先实现用的是 lx+r / lx+totalW-r —— 向内缩了半个半径，
       视觉上像是头尾各偏出/缩进一点，与「饼压在音符起止位置」的直觉不符。

       **尾饼只在真正结束点画**：跨行时中间段（first=false, isLast=false）
       只有渐变带、没有饼；上一行末尾也不该出现尾饼。*/
    const circles = [];
    if (first) circles.push(lx);
    if (isLast) circles.push(lx + totalW);
    for (const bx of circles) {
      ctx.fillStyle = ringCol;
      ctx.beginPath();
      ctx.arc(bx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = bunCol;
      ctx.beginPath();
      ctx.arc(bx, cy, r - ringW, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /**
   * 拨浪鼓（转盘）—— **空心白环头（无尾饼） + 绿色虚线**。
   * 外框与红/蓝大饼的白环同色。
   */
  _drawSpinnerSeg(ctx, lx, totalW, cy, opts, first) {
    /* 空心白环头（无尾饼）+ 绿色虚线。
       白环构造与 _drawNote 的红/蓝大饼**完全一致**：
       外半径 = 普通音符半径 x BIG_NOTE_SCALE，环宽 = 外半径 x 0.20。*/
    const cfg = this.cfg;

    let lineX0 = lx;
    if (first) {
      const ringR = cfg.noteDiameter * 0.5 * BIG_NOTE_SCALE;
      const S = Math.max(4, Math.round(ringR * 2));
      /* 超采样时白环也按比例建，避免被ctx.scale 放大后边缘发虚 */
      const ss = Math.max(1, Math.min(4, Math.round(opts.scale || 1)));
      const tmp = document.createElement("canvas");
      tmp.width = tmp.height = S * ss;
      const t = tmp.getContext("2d");
      t.fillStyle = "#ffffff";
      t.beginPath();
      t.arc(S * ss / 2, S * ss / 2, S * ss / 2, 0, Math.PI * 2);
      t.fill();
      /* 挖空中心 -> 环宽 = 外半径 x 0.42（大饼为 0.20，这里略细） */
      t.globalCompositeOperation = "destination-out";
      t.beginPath();
      t.arc(S * ss / 2, S * ss / 2, S * ss * 0.42, 0, Math.PI * 2);
      t.fill();
      /* 头部外框**正中间对齐**于起点 */
      ctx.drawImage(tmp, lx - ringR, cy - ringR, S, S);
      lineX0 = lx + ringR;
    }

    /* 绿色虚线持续线 */
    const h = Math.max(4, cfg.noteDiameter * 0.34);
    ctx.strokeStyle = "rgb(150,178,110)";
    ctx.lineWidth = Math.max(2, Math.round(h * 0.34));
    ctx.beginPath();
    const x1 = lx + totalW;
    const dash = 6, gap = 5;
    for (let x = lineX0; x < x1; x += dash + gap) {
      ctx.moveTo(x, cy);
      ctx.lineTo(Math.min(x + dash, x1), cy);
    }
    ctx.stroke();
  }

  /** 单个音符；大饼 = 同色放大 1.5 倍 */
  _drawNote(ctx, n, cx, cy, r, opts) {
    const skin = this.skin;
    const rr = n.kind === NOTE_BIG ? r * BIG_NOTE_SCALE : r;
    const color = (n.kind === NOTE_KAT || n.blue) ? COLORS.kat : COLORS.don;

    const useSkin = opts.useSkin && this.opts.useSkin && skin.loaded && skin.hit;
    if (useSkin) {
      /* 超采样时临时贴图也要按比例建，否则绘制时被ctx.scale 放大而模糊。
         opts.scale 由 renderPage 注入（默认 1）。 */
      const ss = Math.max(1, Math.min(4, Math.round(opts.scale || 1)));
      const S = Math.max(1, Math.round(rr * 2));
      const tmp = document.createElement("canvas");
      tmp.width = tmp.height = S * ss;
      const tctx = tmp.getContext("2d");
      /* 先按物理尺寸铺满，绘制时再缩回逻辑尺寸 */
      const drawS = S * ss;
      tctx.drawImage(skin.hit, 0, 0, drawS, drawS);
      tctx.globalCompositeOperation = "source-atop";
      tctx.globalAlpha = 0.88;
      tctx.fillStyle = color;
      tctx.fillRect(0, 0, drawS, drawS);
      tctx.globalAlpha = 1;
      tctx.globalCompositeOperation = "source-over";
      if (skin.hitOverlay) tctx.drawImage(skin.hitOverlay, 0, 0, drawS, drawS);
      ctx.drawImage(tmp, cx - rr, cy - rr, S, S);
      return;
    }

    ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff"; ctx.fill();
    ctx.beginPath(); ctx.arc(cx, cy, rr * 0.80, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
  }
}