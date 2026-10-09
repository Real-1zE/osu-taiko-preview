/* ==========================================================================
 * osu_parser.js —— .osu 谱面文件解析（浏览器端）
 * 与 Python 版 osu_parser.py 保持一致的规则。
 * ========================================================================== */

export const NOTE_DON = "don";
export const NOTE_KAT = "kat";
export const NOTE_BIG = "big";
export const NOTE_ROLL = "roll";
export const NOTE_SPINNER = "spinner";

const HIT_NORMAL = 1;
const HIT_WHISTLE = 2;
const HIT_FINISH = 4;
const HIT_CLAP = 8;

function safeInt(s, d = 0) {
  const v = parseInt(s, 10);
  return Number.isFinite(v) ? v : d;
}

function safeFloat(s, d = 0) {
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : d;
}

/* ================= 数据合理性上限（防止脏数据卡死）=================
 *
 * 背景：真实谱面里确实存在导出器 bug 产生的离谱数值。
 * 已实测的样本 —— 1419088 Camellia feat. Nanahira
 * - Bad Sweets, Bad Dreams [Too Bad, dont play]（bid 2923535）：
 *
 *     -569220001,-6E-87,4,1,0,5,1,0        ← 时间 -6.4万小时、拍长 6e-87
 *     -569220002, 272.177968100742,4,1,...← 同批物件
 *     -569220000,-6E-87,4,1,0,5,1,0
 *
 * `measureTimes()` 是 `while (t < segEnd) t += beatLength * meter` 的
 * 逐小节累进，拍长 6e-87 会让单段循环 **10^52 次** —— 不是「慢」，
 * 是永远跑不完，主线程被占死，整个浏览器跟着卡住
 * （用户反馈「插件遇到这个谱面就连带浏览器一块卡死」）。
 *
 * ★★ 两条阈值是**按语义分开**的，不能混用 ——
 *   合并设阈值时实测误伤了大量合法数据（见下面两处注释）。
 */

/** 时间戳绝对值上限：1 小时（ms）。超过即视为脏数据。 */
const MAX_TIME_MS = 3_600_000;

/**
 * 拍长**下限**，只对红线生效：`1e-6` ms（1e9 BPM）。
 *
 * ★ 这个阈值**故意定得极低**，因为「拍长过小」本身**不是**该丢数据的理由 ——
 *   短拍长的红线在真实谱面里很常见且无害：Otsukimi PARTY HARD 有 101 条
 *   `bl ∈ {0.25, 0.4, 0.063}`，INTERNET OVERDOSE 有 4 条 `bl=1E+15`，
 *   它们都只出现在**同一时刻**（距相邻红线 1~20ms），
 *   按绝对阈值丢掉会让 SR 从 7.22 掉到 6.90 / 4.90 掉到 4.70。
 *
 *   真正致命的不是「拍长数值小」，而是「这条红线在自己那一段里
 *   要循环 10^52 次」—— 那个问题由 `layout.measureTimes()` 的
 *   **循环预算**（BUDGET）解决，与解析层无关。
 *
 *   所以这里只挡**浮点下溢/溢出级别**的脏数据：
 *   实测Bad Sweets 的脏值是 `6e-87`，1e-6 远在它之上，
 *   而所有真实谱面的红线（含 bl=0.063）都远在 1e-6 之上。
 *   两边都有 6+ 个数量级的余量。
 */
const MIN_RED_BEAT_MS = 1e-6;

/**
 * 拍长**上限**，只对**红线**（beatLength > 0，即真正的拍长）生效。
 *
 * ★ 定这个上限时踩了两次：
 *   ① 先取 60ms（1000 BPM）-> 误丢 Bad Sweets 里 163 条 bl=272.178
 *      （22 BPM 慢速段，osu! 里完全合法）。
 *   ② 放到 1000ms 仍不够 -> 误丢 INTERNET OVERDOSE 的 427 条 bl=1472.39。
 *      那批虽然写在红线位置（导出器把 SV 误写成红线），但它是**真实存在的
 *      数据**，官方 C# 也照样读进去；丢掉它 SR 从 4.90 掉到 4.70。
 *
 *   结论：**「拍长偏大」从来不是脏数据特征**，慢速段和「导出器把 SV 误写成红线」
 *   都会产生大数值。真正致命的只有「过小」，所以上限取 1e6ms
 *   （16 分钟一小节）已极宽松，实际上只挡「拍长溢出成天文数字」。
 */
const MAX_RED_BEAT_MS = 1e6;

/**
 * 时间戳是否可信：有限，且绝对值在上限内。
 *
 * ★ **负时间是合法的**，不能丢！osu! 允许 timing point 落在 0ms 之前
 *   用来做音频淡入（AudioLeadIn），实测 paraoka - kyrie 的 6 张 std 谱
 *   都有 `-996,428.57` 这样的红线（-996ms ≈ lead-in 起点）。
 *   早期版本按 `t >= 0` 判定，把它们全丢了，SR 偏 0.02~0.3。
 *
 *   真正要挡的是 Bad Sweets 那种 -5.69e8 —— 靠**绝对值上限**区分，
 *   不靠符号。-996 与 -569220001 差 5 个数量级，阈值放在两者之间即可。
 */
function isPlausibleTime(t) {
  return Number.isFinite(t) && Math.abs(t) <= MAX_TIME_MS;
}

/**
 * 拍长是否可信。**红线与绿线用完全不同的判据** ——
 * 这不是风格问题，是踩过坑才分开的（见上面两个常量的注释）。
 *
 * @param {number} bl 原始 beatLength（红线为正、绿线为负或 0）
 * @returns {boolean}
 *
 * · 红线 bl > 0：必须是真正的拍长，校验 [1ms, 1e6ms] 双向区间。
 *   过小 -> measureTimes 死循环；过大 -> rowsUsed 算出天文数字。
 * · 绿线 bl < 0：数值是 -100/SV，**不校验上下限**。
 *   |bl| 极小（SV 极大）或极大（SV 接近 0）都是合法谱面会出现的值。
 * · bl == 0：合法（绿线且无 SV 变化），交给调用方分流。
 */
function isPlausibleBeatLength(bl) {
  if (!Number.isFinite(bl)) return false;
  if (bl === 0) return true;
  if (bl > 0) {
    return bl >= MIN_RED_BEAT_MS && bl <= MAX_RED_BEAT_MS;
  }
  return true;   /* 绿线：不设限 */
}

/* osu!v14 type 字段是「对象类型位掩码 + 新连击标记(bit0)」
 * 实际存储值: 1/5=circle, 2/6=slider, 3/12=spinner 等 */
/* type 字段位定义（依据 osu! 官方文档 / 工作区 时间点.txt）
 *   bit0(1)=圆圈 bit1(2)=滑条 bit2(4)=新Combo bit3(8)=转盘 bit7(128)=mania长按
 *
 * 历史 bug：曾用 `tf & 6`（=bit1|bit2）提取类型，会把「新Combo的圆圈」
 * type=5(bit0+bit2) 误判成滑条、type=1 也变成 0。必须逐位判断。*/
const OBJ_CIRCLE = 1, OBJ_SLIDER = 2, OBJ_COMBO = 4, OBJ_SPINNER = 8;

function parseType(tf) {
  /* ★★ 必须先按官方口径**归一化 newCombo 位**，再判类型 ——
   * 直接用位与判断会把 spinner+newCombo 误判成 slider。
   *
   * 官方 `LegacyHitObjectParser` 的做法（见 taiko_diffcalc/osu_parser.py:362）：
   *     if type_flag & 128:  base = 128          # mania hold
   *     else:               base = type_flag & 0xF
   *         base in (8, 12)  -> 8                # spinner / spinner+newCombo
   *         base in (1, 5)   -> 1                # circle / circle+newCombo
   *         base in (2, 6)   -> 2                # slider / slider+newCombo
   *
   * 为什么位与不行：`12 & OBJ_SLIDER(2) === 2` —— 「转盘 + 新 combo」
   * 会被判成滑条。而转盘在 taiko 里是**免打物件**（转盘/ Swell），
   * 滑条会变成**连打**（要打）—— 一误判就把免打物件算进了难度。
   *
   * 实测：Ni Kan Dao De Wo [Spinning] 有 1 个 type12 物件，
   * 误判成 slider 后段位从 13.48 偏到 13.73（0.25 段）。
   */
  if (tf & OBJ_HOLD) return OBJ_HOLD;
  /* & 0xF 而非 & 0x7：要把 newCombo 位(4) 保留下来做下面的归一化，
     但 spinner 位(8) 必须保留 —— 用 & 7 会把 type12 变成 4。*/
  const base = tf & 0xF;
  if (base === 8 || base === 12) return OBJ_SPINNER;
  if (base === 1 || base === 5) return OBJ_CIRCLE;
  if (base === 2 || base === 6) return OBJ_SLIDER;
  /* 兜底：老谱里出现过的非标准组合，至少按位猜一个 */
  if (tf & OBJ_SPINNER) return OBJ_SPINNER;
  if (tf & OBJ_SLIDER) return OBJ_SLIDER;
  return OBJ_CIRCLE;
}

/* osu!taiko 判定（依据 时间点.txt「osu!taiko」节）：
 *   滑条 -> 黄色连打| 转盘 -> 拨浪鼓
 *   圆圈 + Whistle(bit1)/Clap(bit3) -> 蓝饼
 *   圆圈 + Finish(bit2) -> 大饼；其余 -> 红饼
 * hitSound: bit0 Normal | bit1 Whistle | bit2 Finish | bit3 Clap */
function classify(objType, hitSound) {
  if (objType === OBJ_SPINNER) return NOTE_SPINNER;
  if (objType === OBJ_SLIDER) return NOTE_ROLL;
  if (hitSound & HIT_FINISH) return NOTE_BIG;
  if (hitSound & (HIT_WHISTLE | HIT_CLAP)) return NOTE_KAT;
  return NOTE_DON;
}

/* ---------- 非原生 taiko（std / catch / mania）转换所需的常量 ----------
 * 全部来自 osu.Game.Rulesets.Taiko.Beatmaps.TaikoBeatmapConverter.cs
 *
 * ★ C# 里这两个常量声明为 `const float`（不是 double）：
 *     public const float VELOCITY_MULTIPLIER = 1.4f;
 *     private const float osu_base_scoring_distance = 100;
 *   float32 无法精确表示 1.4，实际存的是 1.39999997615814208984375。
 *   差值只有 2.4e-8，但 `shouldConvertSliderToHits` 的分界判定
 *   恰好细到 1e-8 量级（见 precisionAdjustedBeatLength 的说明），
 *   所以这里必须用 Math.fround 复刻 float32，不能直接写 1.4。
 */
const VELOCITY_MULTIPLIER = Math.fround(1.4);
/** osu_base_scoring_distance */
const OSU_BASE_SCORING_DISTANCE = 100;
/** ScrollSpeed 的钳制范围（EffectControlPoint 的 BindableDouble 上下限） */
const SCROLL_SPEED_MIN = 0.01;
const SCROLL_SPEED_MAX = 10;
/** hit object type: mania 长按（BMS 转换产物） */
const OBJ_HOLD = 128;

/**
 * DifficultyControlPoint.SliderVelocity —— 官方转换器用的滑条速度。
 *
 * 复刻 LegacyBeatmapDecoder.handleTimingPoint + ControlPointInfo.Add：
 *   · **每一行** timing point 都尝试产出一个 DifficultyControlPoint，
 *     其 SliderVelocity = speedMultiplier = (beatLength<0 ? 100/-beatLength : 1.0)
 *   · 红点（beatLength>0）的 speedMultiplier 恒为 **1.0**
 *   · 查找用 DifficultyPointAt(t) = 最后一个 time <= t 的点
 *   · ★ ControlPointInfo.Add 会**去重**：新点若与「当前生效点」的
 *     GenerateTicks / SliderVelocity 完全相同，就直接丢弃。
 *     所以连续的同速绿线只有第一条会留下来 ——
 *     官方 DifficultyControlPoint 数（37）远少于 timing point 行数（135）。
 *
 * ★ 曾试过「kiai 绿线把 SV 重置为 1.0」，那是**错的**：
 *   官方 C# 对拍显示 kiai 绿线（71397/72254/…，kiai=1）拿到的
 *   SliderVelocity 是 1.35/1.75 等真实速度，不是 1.0。
 *   真正的差别只在**去重**上。
 *
 * ScrollSpeed 还要钳到[0.01, 10]（EffectControlPoint 的 BindableDouble 上下限）。
 */
function svAtDifficulty(bm, t) {
  const pts = bm.timingPoints;
  if (!pts || !pts.length) return 1.0;
  if (t < pts[0].time) return 1.0;
  let lo = 0, hi = pts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pts[mid].time <= t) lo = mid; else hi = mid - 1;
  }
  const tp = pts[lo];
  if (!tp.red) {
    const bl = Math.abs(tp.beatLength);
    if (bl > 0) return Math.min(Math.max(100.0 / bl, SCROLL_SPEED_MIN), SCROLL_SPEED_MAX);
  }
  return 1.0;
}

/**
 * LegacyRulesetExtensions.GetPrecisionAdjustedBeatLength（taiko/mania 分支）
 *   sliderVelocityAsBeatLength = -100 / sv
 *   bpmMultiplier = Math.Clamp((float)-sliderVelocityAsBeatLength, 10, 10000) / 100.0
 *
 * ★★ 必须复刻 C# 里的 `(float)` 强转，不是可有可无的细节。
 *
 * 背景：`shouldConvertSliderToHits` 的判定是
 *     distance / osuVelocity * 1000 < 2 * beatLength
 * 当滑条长度恰好落在「短滑条/连打」的分界上时，两边会算到**几乎相等**的值。
 * 实测（Bass Slut [Dereban's Lewd Extra] bid 2118440，t=80998 的滑条）：
 *     不做 float 强转：cond = 685.7142922537669  vs  2*beatLength = 685.714285714286
 *                       → 大 6.5e-6，判false → 我们出 DrumRoll
 *     做 float 强转：  cond = 685.7142857142858  vs  2*beatLength = 685.714285714286
 *                       → 小 2.3e-13，判 true → 官方出 3 个 Hit(Kat)
 * 分界上差 6.5e-6 就足以把「3 个 Kat」变成「1 个 DrumRoll」，
 * 颜色难度与星数随之全错（实测 SR 偏 0.04）。
 *
 * C# 源码：`(float)-sliderVelocityAsBeatLength` —— 先取负再**转 float** 再 Clamp。
 * Math.fround 就是 JS 的 float32 舍入。
 */
function precisionAdjustedBeatLength(sv, beatLength) {
  const asBeatLength = -100 / sv;
  const mult = asBeatLength < 0
    ? Math.min(Math.max(Math.fround(-asBeatLength), 10), 10000) / 100
    : 1;
  return beatLength * mult;
}

/**
 * 把一个 std/catch/mania 的 legacy 物件转成 taiko 音符（渲染口径）。
 *
 * 复刻 TaikoBeatmapConverter.ConvertHitObject + shouldConvertSliderToHits：
 *   circle  -> Hit（Centre / Rim由clap/whistle 决定；std **不会**产生大饼）
 *   slider  -> 短滑条拆成一串 Hit；其余 -> DrumRoll（Finish -> 强连打）
 *   spinner -> Swell；mania hold -> Swell
 *
 * @returns {Array} taiko 音符（kind: don/kat/roll/spinner）
 */
function convertObjectToTaikoNotes(o, bm) {
  const out = [];
  if (o.objType === OBJ_CIRCLE) {
    /* Hit.getRimSamples：含 clap 或 whistle -> Rim(Kat) */
    out.push(mkHit(o.time, isRimSound(o.hitSound)));
    return out;
  }
  if (o.objType === OBJ_SPINNER || o.objType === OBJ_HOLD) {
    out.push({
      time: o.time, kind: NOTE_SPINNER, endTime: Math.max(o.time, o.endTime || o.time),
      length: 0, isBig: false, blue: false, x: 0, row: 0,
    });
    return out;
  }
  if (o.objType !== OBJ_SLIDER) {
    out.push(mkHit(o.time, false));
    return out;
  }

  /* ---- slider ----
   * 逐行对应 shouldConvertSliderToHits（TaikoBeatmapConverter.cs）。
   * ★ 凡是 C# 里有 float 语义的地方都要Math.fround ——
   *   `distance` 与 `beatLength` 在C# 里都是 double，但参与运算的
   *   VELOCITY_MULTIPLIER / SliderMultiplier 是 float，且判定式
   *   `distance / osuVelocity * 1000 < 2 * beatLength` 只差 1e-8，
   *   少任何一次 fround 都会在分界上翻面（见 precisionAdjustedBeatLength）。*/
  const spans = Math.max(1, o.spans || 1);
  /* C#: double distance = path.ExpectedDistance.Value;
   *     distance *= VELOCITY_MULTIPLIER;   // float 提升为 double
   *     distance *= spans;*/
  let distance = (o.length > 0 ? o.length : 0) * VELOCITY_MULTIPLIER;
  distance *= spans;
  const timingPoint = beatMsAt(bm, o.time);          /* TimingControlPoint.BeatLength */
  const sv = svAtDifficulty(bm, o.time);              /* DifficultyControlPoint.SliderVelocity */
  let beatLength = precisionAdjustedBeatLength(sv, timingPoint);

  /* C#:
   *   double sliderScoringPointDistance =
   *       osu_base_scoring_distance * (SliderMultiplier * VELOCITY_MULTIPLIER) / SliderTickRate;
   *   double taikoVelocity = sliderScoringPointDistance * SliderTickRate;
   *
   * ★ 这里**刻意不对 SliderMultiplier / 中间乘积做 fround**。
   *   C# 里 `SliderMultiplier * VELOCITY_MULTIPLIER` 两个 float 相乘
   *   确实得到 float，但随后与 float 的 osu_base_scoring_distance 相乘、
   *   再赋给 double 变量时，编译器会把这个 float 提升为 double ——
   *   也就是说真正参与后续计算的是「float 乘积的精确 double 表示」。
   *   JS 里只要写 `100 * (sm * VELOCITY_MULTIPLIER)`，sm 用文件里的
   *   double 原值，就是同一个数（实测 4 个分界样本逐位吻合）。
   *   多套一层 fround 反而会让 cond 偏 2e-5，把 DrumRoll 翻成 HITS。*/
  const sm = bm.sliderMultiplier || 1.4;
  const tickRate = bm.sliderTickRate || 1;
  const sliderScoringPointDistance =
    OSU_BASE_SCORING_DISTANCE * (sm * VELOCITY_MULTIPLIER) / tickRate;
  const taikoVelocity = sliderScoringPointDistance * tickRate;
  const taikoDuration = taikoVelocity !== 0
    ? Math.trunc(distance / taikoVelocity * beatLength)
    : 0;

  /* C#: double osuVelocity = taikoVelocity * (1000f / beatLength);
   * `1000f` 只是字面量类型标注；表达式里另两个操作数都是 double，
   * 所以除法在 double 下完成。不要给这里加 fround（见上方说明）。*/
  const osuVelocity = taikoVelocity * (1000 / beatLength);
  /* osu-stable 只在 beatmapVersion < 8 时用speed-adjusted 拍长算 osu 速度 */
  if ((bm.beatmapVersion || 14) >= 8) beatLength = timingPoint;
  const tickSpacing = Math.min(beatLength / tickRate, taikoDuration / spans);
  const convertToHits = tickSpacing > 0
    && (osuVelocity !== 0 ? distance / osuVelocity * 1000 < 2 * beatLength : false);

  if (convertToHits) {
    /* 节点音效：默认整条滑条同一个 hitSound，edgeSounds（第 9 字段）逐节点覆盖 */
    const nodes = spans + 1;
    const edge = o.edgeSounds || [];
    let i = 0;
    for (let t = o.time; t <= o.time + taikoDuration + tickSpacing / 8; t += tickSpacing) {
      const nodeSound = (i < edge.length && isFinite(edge[i])) ? edge[i] : o.hitSound;
      out.push(mkHit(t, isRimSound(nodeSound)));
      i++;
      if (i >= nodes) i = 0;
      if (tickSpacing === 0) break;
      /* 兜底：正常 tickSpacing 下循环次数有限，但仍防一手极端谱面 */
      if (out.length > 20000) break;
    }
    return out;
  }

  out.push({
    time: o.time, kind: NOTE_ROLL, endTime: o.time + taikoDuration,
    length: o.length || 0,
    isBig: !!(o.hitSound & HIT_FINISH),   /* DrumRoll.IsStrong */
    blue: false, x: 0, row: 0,
  });
  return out;
}

function isRimSound(hitSound) {
  return !!(hitSound & (HIT_WHISTLE | HIT_CLAP));
}

function mkHit(time, isKat) {
  return {
    time, kind: isKat ? NOTE_KAT : NOTE_DON, endTime: time,
    length: 0, isBig: false, blue: isKat, x: 0, row: 0,
  };
}

/**
 * 非原生taiko 的**滚动速度（ScrollSpeed）控制点**（= 转换后的 EffectControlPoint 序列）。
 *
 * 复刻 TaikoBeatmapConverter.ConvertBeatmap 的 `OnlineID == 0` 后处理
 * 「Post processing step to transform standard slider velocity changes into
 *  scroll speed changes」，逐条对应：
 *
 *   double lastScrollSpeed = 1;
 *   foreach (HitObject hitObject in original.HitObjects)
 *   {
 *       if (hitObject is not IHasSliderVelocity) continue;      // ① 只有滑条
 *       double nextScrollSpeed = hasSliderVelocity.SliderVelocityMultiplier;
 *       var cur = converted.ControlPointInfo.EffectPointAt(hitObject.StartTime);
 *       if (!Precision.AlmostEquals(lastScrollSpeed, nextScrollSpeed, …))
 *       {
 *           converted.ControlPointInfo.Add(hitObject.StartTime, new EffectControlPoint {
 *               KiaiMode = cur.KiaiMode, ScrollSpeed = lastScrollSpeed = nextScrollSpeed });
 *       }
 *   }
 *
 * ★★ 三个必须踩准的点（都是实测踩出来的）：
 *
 * 1. **插点位置是「滑条的起始时间」，不是 timing point 的时间。**
 *    官方 27 个控制点里 23 个落在滑条上；剩下 4 个（82368/93340/126254/137225）
 *    是 **kiai 绿线**—— 见下条。
 *
 * 2. **kiai 转折点也会产生控制点，且ScrollSpeed 沿用「当前生效值」。**
 *    `EffectControlPoint.IsRedundant` 比较 ScrollSpeed **和** KiaiMode，
 *    所以 kiai 从 false 翻成 true（或反向）那一刻，即使 ScrollSpeed
 *    一个字节都没变，这个新点也**不冗余**，会被Add 进去。
 *    实测 [Dereban's Lewd Extra] bid 2118440：
 *      官方序列 = … 41226@1.0, 71397@1.0, 71398@1.35, 80997@1.0, …
 *      71397 是 kiai 绿线（前面无滑条），此处 SV 沿用 1.0；
 *      紧接着 71398 的滑条带来 1.35，才插第二个点。
 *    漏掉这一轮会让 6 个控制点缺失，SR 偏 0.0005~0.013。
 *    这条 kiai 来自 timing point 第 **8** 字段（LegacyEffectFlags.Kiai），
 *    不是第 5 个字段 —— 见 parseOsu 里的说明。
 *
 * 3. **SliderVelocity = DifficultyPointAt(滑条时间).SliderVelocity**，
 *    取的是「最后一条 timing point 行（红或绿都算，红给 1.0）」的值。
 *    所以红点会把 SV 重置为 1.0。
 *
 * 渲染与难度计算都必须用这一份，否则读谱与 SR 都会错。
 *
 * @param {object} bm      parseOsu 的结果
 * @param {Array}  objects rawObjects（按时间排序）
 * @returns {Array<[number, number]>} [[时间, scrollSpeed], ...]，按时间升序
 */
function buildConvertedScrollPoints(bm, objects) {
  const tps = bm.timingPoints || [];

  /* 「最后一条 timing point 行（<= t）」的 SliderVelocity。 */
  const stateAt = (t) => {
    if (!tps.length || t < tps[0].time) return { kiai: false, sv: 1.0 };
    let lo = 0, hi = tps.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (tps[mid].time <= t) lo = mid; else hi = mid - 1;
    }
    const tp = tps[lo];
    let sv = 1.0;
    if (!tp.red && Math.abs(tp.beatLength) > 0) {
      sv = Math.min(Math.max(100.0 / Math.abs(tp.beatLength), SCROLL_SPEED_MIN), SCROLL_SPEED_MAX);
    }
    return { kiai: !!tp.kiai, sv };
  };

  /* ---- 官方转换后的 EffectControlPoint 序列 ----
   *
   * 两轮合并，按时间排序：
   *  ① **滑条 SV 变化点**：遍历物件，只有滑条携带 SliderVelocityMultiplier；
   *     值与 lastScrollSpeed 不同才在**该滑条起始时间**插点。
   *     C# 原文：`if (hitObject is not IHasSliderVelocity) continue;`
   *  ② **kiai 转折点**：kiai 布尔翻转处插一个 ScrollSpeed = 1.0 的点
   *     （1.0 是 EffectControlPoint 的默认值 —— decoder 为 kiai 绿线
   *     产出的那个点没有赋 ScrollSpeed）。
   *
   * ★★ 两条硬约束（都是与官方 C# 逐点对拍出来的，少一条就偏 0.005~0.029）：
   *
   *  a) `lastScrollSpeed` 只被 ① 更新；② 不碰它。
   *     C# 那句 `ScrollSpeed = lastScrollSpeed = nextScrollSpeed`
   *     只出现在滑条分支里。早期实现让 kiai 点顺手把状态置成 1.0，
   *     它**后面**的滑条全被误判成「SV 变了」而多插点。
   *
   *  b) ② 只在「kiai 转折时刻**没有滑条**」时才插点。
   *     若该处恰好有滑条，官方只给滑条那一个值
   *     （[Intense Ecstasy] 的 71397/80997/115283/124883 都属这类）。
   *     反过来，[Dereban's Lewd Extra] 的 71397(kiai) 与 71398(滑条)
   *     只差 1ms 却**各插一个** —— 因为它们不是同一时刻。
   */
  const pts = [];
  let lastScrollSpeed = 1.0;

  /* 滑条时刻集合：用来判定 kiai 转折是否「同时也是滑条」 */
  const sliderTimes = new Set();
  for (const o of objects) {
    if (o.objType === OBJ_SLIDER) sliderTimes.add(o.time);
  }

  /* ① 物件循环 */
  for (const o of objects) {
    if (o.objType !== OBJ_SLIDER) continue;
    const sv = stateAt(o.time).sv;
    if (Math.abs(sv - lastScrollSpeed) > 1e-9) {
      lastScrollSpeed = sv;
      pts.push([o.time, sv]);
    }
  }

  /* ② kiai 转折点（跳过同时也是滑条的时刻） */
  let prevKiai = false;
  for (let i = 0; i < tps.length; i++) {
    const k = !!tps[i].kiai;
    if (k !== prevKiai) {
      if (!sliderTimes.has(tps[i].time)) pts.push([tps[i].time, 1.0]);
      prevKiai = k;
    }
  }

  pts.sort((a, b) => a[0] - b[0]);
  return pts;
}

/** 该音符应显示为蓝色吗？（大饼同样适用：hitSound=4 红，6/12 带 Kat 位为蓝） */
function isBlueNote(kind, hitSound) {
  if (kind === NOTE_KAT) return true;
  if (kind === NOTE_BIG) return !!(hitSound & (HIT_WHISTLE | HIT_CLAP));
  return false;
}

/** 解析 .osu 文本，返回 beatmap 对象 */
export function parseOsu(text) {
  const bm = {
    mode: 0,
    beatmapVersion: 14,
    audioFilename: "",
    audioLeadIn: 0,
    previewTime: -1,
    title: "", artist: "", version: "", creator: "",
    beatmapId: "", beatmapSetId: "",
    hp: 5, od: 5, cs: 5, ar: 5,
    sliderMultiplier: 1.4, sliderTickRate: 1,
    timingPoints: [],
    notes: [],
    breaks: [],              /* 休息段 [[startMs, endMs], ...] */
    /* Events 段的 type 12（scroll speed 事件）[[timeMs, sv], ...]。
     * 与 timingPoints 里的绿线不同，这是作者直接写的倍率，
     * 段位/键型评估要用它（见 dan_bridge.js 的 svAt）。*/
    scrollEvents: [],
    /* 因数值不可信而被丢弃的条目数（脏数据防御，见 isPlausibleTime）。
     * 正常谱面这两个数都是 0；非 0 说明该谱导出器有 bug，
     * 可以据此在信息栏上给个提示，而不是静默地少画东西。*/
    droppedTiming: 0,
    droppedObjects: 0,
    /* 非原生 taiko（std/catch/mania）转换产物*/
    isConvert: false,
    scrollPoints: null,      /* [[time, sv], ...] 转换后的 ScrollSpeed 控制点 */
  };

  const lines = text.split(/\r?\n/);
  let section = "";
  /* legacy 原始物件（未按 taiko 语义分类）。Mode 1 走 taiko 原生路径，
     其它模式走 TaikoBeatmapConverter 转换 —— 两者都需要这份原始数据。*/
  const rawObjects = [];

  for (let raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("//")) continue;

    /* "osu file format v14" —— slider 时长计算要区分 v8 前后 */
    {
      const m = line.match(/^osu file format v(\d+)/i);
      if (m) { bm.beatmapVersion = safeInt(m[1], 14); continue; }
    }

    if (line.startsWith("[") && line.endsWith("]")) {
      section = line.slice(1, -1).trim();
      continue;
    }

    /* TimingPoints / HitObjects 行内含 ':' (hitSample)，必须按逗号解析 */
    if (section === "TimingPoints") {
      const p = line.split(",");
      if (p.length < 2) continue;
      const t = safeInt(p[0]);
      const bl = safeFloat(p[1]);
      /* ★ kiai 标记在**第 8 个字段**（索引 7），不是索引 4。
       *
       * 字段布局（LegacyBeatmapDecoder.handleTimingPoint）：
       *   0=time 1=beatLength 2=meter 3=timeSignature
       *   4=sampleSet 5=sampleIndex 6=timelineScroll 7=KiaiFlags(effectFlags)
       *
       * 历史上这里写成 `safeInt(p[4])` —— 那是 sampleSet，
       * 于是几乎所有谱的 kiai 都被读成了「sampleSet>0」恒真或恒假，
       * 完全错位。实测Bass Slut [Nasty Normal]：真正的 kiai 点是
       * 71397/82368/115283/126254（红线的 kiai 段），
       * 错读后一条都识别不出来。
       *
       * kiai 影响两处：
       *   1. DifficultyHitObject.KiaiTime（Stamina 技能的节奏对齐）
       *   2. 转谱谱面的 EffectControlPoint（官方会为 kiai 转折点插控制点）
       * 读错会让 SR 偏 0.03 量级。*/
      const kiai = safeInt(p[7], 0) > 0;
      /* ★★ 数据合理性校验 —— 缺了这条会让整个插件**卡死浏览器**。
       *
       * 真实脏数据样本：1419088 Camellia feat. Nanahira - Bad Sweets, Bad Dreams
       * [Too Bad, dont play]（bid 2923535）的TimingPoints 里有这么一行：
       *
       *     -569220001,-6E-87,4,1,0,5,1,0
       *
       * 时间戳 -569220001（-6.4 万小时）与 beatLength 6e-87（浮点下溢，
       * 本应是 -100 / -75 之类）都是导出器 bug 的产物。
       *
       * 为什么致命：`measureTimes()` 按`while (t < segEnd) t += beatLength*meter`
       * 逐小节累进，beatLength = 6e-87 时单段要循环 **10^52 次** ——
       * 不是「慢」，是**永远跑不完**，主线程被彻底占死，
       * 连标签页切换都卡住（用户反馈「插件遇到这个谱面就连带浏览器一块卡死」）。
       *
* 判据（阈值定义见文件上方 isPlausibleTime / isPlausibleBeatLength）：
 *   · 时间戳**绝对值**超过 1 小时 -> 丢弃。注意负时间是合法的
 *     （音频淡入，实测有 -996ms 的红线），不能按符号丢。
 *   · 拍长绝对值 < 1ms -> 丢弃（这才是致命的：measureTimes 会死循环）。
 *     上限只对红线生效；绿线的 -100/SV 不设上限。
 *
 * ★ 阈值必须按语义分开设。曾因图省事把红绿线合并成一个区间：
 *   ① 上限设 60ms -> Bad Sweets 里 163 条 bl=272.178（22BPM 慢速段）
 *      被误丢，droppedTiming 虚高到 757；
 *   ② 上限对绿线也生效 -> INTERNET OVERDOSE 的 431 条 bl=-1472.39
 *      （SV≈0.068，合法）被丢，SR 从 4.90掉到 4.70；
 *   ③ 时间按 `t >= 0` 判定 -> paraoka - kyrie 6 张 std 谱里
 *      `-996,428.57` 的红线（音频淡入）被丢，SR 偏 0.02~0.3。
 *   三条都是 sr_verify / difficulty_parity 报出来的，不是靠读代码想出来的。
 */
      if (!isPlausibleTime(t) || !isPlausibleBeatLength(bl)) {
        bm.droppedTiming++;
        continue;
      }
      if (bl > 0) {
        /* 非继承时间点（红线）：beat_length 即拍长，决定 BPM */
        bm.timingPoints.push({ time: t, beatLength: bl, meter: safeInt(p[2], 4),
        kiai, sv: 1, speed: 1, red: true });
      } else {
        /* 继承时间点（绿线）：beat_length 为负，SV = 100 / |beatLength| */
        const sv = bl !== 0 ? 100.0 / Math.abs(bl) : 1.0;
        /* 绿线也能带 kiai（老谱用绿线开/关 kiai 段）*/
        bm.timingPoints.push({ time: t, beatLength: bl, sv, speed: 1, kiai, red: false });
      }
      continue;
    }

    if (section === "Events") {
      /* 休息段（Break）语法：Break,开始时间,结束时间
         第二行也可用 2 代替 Break。事件行第一个字段可能是
         `Break` 或 `2`，需按字符串判断（不能按数字，事件类型有 1/2/3等）。*/
      const p = line.split(",");
      if (p.length >= 3 && (p[0].trim() === "Break" || p[0].trim() === "2")) {
        const s = safeInt(p[1], -1), e = safeInt(p[2], -1);
        if (s >= 0 && e > s) bm.breaks.push([s, e]);
      }
      /* ★★ type 12 = scroll speed（mania 谱的 SV 事件）。
       *
       * 之前完全没解析，导致段位/键型评估的 SV 序列全是错的 ——
       * 实测 GIMMICK OVERDOSE 有 141 个这种事件，不解析会让段位偏 2 段
       * （13.46 -> 13.85，grade 从 Gamma+ 跳到 Delta）。
       *
       * 语法：12,<时间ms>,<倍率>
       * 语义与 TimingPoints 里的绿线（beatLength < 0，sv = 100/|bl|）**不同**：
       *   · 绿线的 sv 是**推导值**，这里的事件是**谱面作者直接写的倍率**；
       *   · 两者都进EffectControlPoint 序列（见 dan_bridge 的 svAt）。
       *
       * 只在需要时收集（段位评估），避免给不用的场景增加解析开销 ——
       * 不，仍然无条件收集：一次线性扫描的开销可以忽略，
       * 而「用到时才发现没解析」是更难查的问题。*/
      else if (p.length >= 3 && p[0].trim() === "12") {
        const t = safeInt(p[1], -1);
        const sv = safeFloat(p[2], 1.0);
        if (t >= 0 && isFinite(sv) && sv > 0) {
          bm.scrollEvents.push([t, sv]);
        }
      }
      continue;
    }

    if (section === "HitObjects") {
      const p = line.split(",");
      if (p.length < 4) continue;
      const t = safeInt(p[2]);
      /* ★ 同样的脏数据防线（见isPlausibleTime 处的说明）。
       * 那张卡死谱的 3 个物件时间也是 -569220xxx，
       * 虽然负时间本身不会让 measureTimes 死循环，
       * 但会让 `t0 = Math.min(...)` 变成负数 -> 行号分配全盘错位。*/
      if (!isPlausibleTime(t)) { bm.droppedObjects++; continue; }
      const typeField = safeInt(p[3]);
      const objType = parseType(typeField);
      const hitSound = p.length > 4 ? safeInt(p[4]) : 0;
      /* edgeSounds（第 9 字段）：滑条各节点独立的 hitSound，
         拆成 Hit 时按节点取色要用。空则整条沿用滑条自己的 hitSound。*/
      let edgeSounds = null;
      if (objType === OBJ_SLIDER && p.length > 8 && p[8].trim()) {
        edgeSounds = p[8].split("|").map((v) => safeInt(v, -1));
      }
      const o = {
        time: t, objType, hitSound,
        rawType: typeField,
        length: 0, spans: 1, endTime: t,
        edgeSounds,
      };
      if (objType === OBJ_SPINNER || typeField === OBJ_HOLD) {
        if (p.length > 5) o.endTime = safeInt(p[5], t);
      } else if (objType === OBJ_SLIDER) {
        o.length = p.length > 7 ? safeFloat(p[7]) : 0;
        o.spans = p.length > 6 ? Math.max(1, safeInt(p[6], 1)) : 1;
      }
      rawObjects.push(o);
      continue;
    }

    const ci = line.indexOf(":");
    if (ci < 0) continue;
    const key = line.slice(0, ci).trim();
    const value = line.slice(ci + 1).trim();

    if (section === "General") {
      if (key === "AudioFilename") bm.audioFilename = value;
      else if (key === "Mode") bm.mode = safeInt(value);
      else if (key === "AudioLeadIn") bm.audioLeadIn = safeInt(value);
      else if (key === "PreviewTime") bm.previewTime = safeInt(value, -1);
    } else if (section === "Metadata") {
      if (key === "Title") bm.title = value;
      else if (key === "Artist") bm.artist = value;
      else if (key === "Version") bm.version = value;
      else if (key === "Creator") bm.creator = value;
      else if (key === "BeatmapID") bm.beatmapId = value;
      else if (key === "BeatmapSetID") bm.beatmapSetId = value;
    } else if (section === "Difficulty") {
      if (key === "HPDrainRate") bm.hp = safeFloat(value, 5);
      else if (key === "OverallDifficulty") bm.od = safeFloat(value, 5);
      else if (key === "CircleSize") bm.cs = safeFloat(value, 5);
      else if (key === "ApproachRate") bm.ar = safeFloat(value, 5);
      else if (key === "SliderMultiplier") bm.sliderMultiplier = safeFloat(value, 1.4);
      else if (key === "SliderTickRate") bm.sliderTickRate = safeInt(value, 1);
    }
  }

  bm.timingPoints.sort((a, b) => a.time - b.time);
  /* 物件按时间排序（解码器末尾的 OrderBy(StartTime)，稳定排序）。
     转换路径要求「按时间顺序遍历滑条」来建 scroll speed 控制点。*/
  rawObjects.sort((a, b) => a.time - b.time);
  bm.rawObjects = rawObjects;

  if (bm.mode === 1) {
    /* ---- 原生 taiko：直接按 taiko 语义分类 ---- */
    for (const o of rawObjects) {
      const kind = classify(o.objType, o.hitSound);
      let end = o.time;
      if (kind === NOTE_SPINNER) {
        end = o.endTime;
      } else if (kind === NOTE_ROLL) {
        /* 连打（滑条 / taiko drum roll）
           时长 = (length × slides) / (SliderMultiplier × 100 × SV) × beatLength

           三个容易错的点（都实际踩过）：
           1) **slides 是分段数**（第 7 字段），length 是**每段**长度，
              总像素 = length × slides。漏掉 slides 会短 N 倍。
              Frost Walker: length=140, slides=10 -> 总 1400 像素。
           2) **要除以 SV**（继承时间点速度倍率）。taiko 里 SV 决定
              连打「滚过多快」，是真实生效的（与时间轴缩放无关）。
           3) beatLength 取该时刻生效的红线拍长。

           验算（Frost Walker 第一个连打，用户在游戏中实测 35026→35708）：
             length=140 slides=10 sm=1.4 SV=4.0 beatLength=272.7273
             = (140×10)/(1.4×100×4) × 272.7273 = **682 ms** ✓ */
        const beatLen = beatMsAt(bm, o.time);
        const sv = Math.max(svAt(bm, o.time), 1e-6);
        const beats = (o.length * o.spans)
                    / Math.max(bm.sliderMultiplier * 100 * sv, 1e-9);
        end = o.length > 0
          ? o.time + Math.round(beats * beatLen)
          : o.time + Math.round(beatLen);
      }
      /* osu!taiko: type 6 = 大滑条 */
      bm.notes.push({
        time: o.time, kind,
        endTime: end,
        length: o.length,          /* 连打的视觉长度（osu! 像素） */
        isBig: isBigTaikoObject(o),
        blue: isBlueNote(kind, o.hitSound),
        x: 0, row: 0,
      });
    }
  } else {
    /* ---- 非原生 taiko：走官方 TaikoBeatmapConverter 转换 ----
       std 的物件语义与 taiko 完全不同（circle/slider/spinner），
       直接按 taiko 规则分类会得到一份**完全错误**的预览。
       这里转成 taiko 物件后再交给 layout / renderer / difficulty。*/
    bm.isConvert = true;
    for (const o of rawObjects) {
      const notes = convertObjectToTaikoNotes(o, bm);
      for (const n of notes) bm.notes.push(n);
    }
    /* std 的 ScrollSpeed 来自「滑条速度变化」的后处理，不是 timing point 上的 SV */
    bm.scrollPoints = buildConvertedScrollPoints(bm, rawObjects);
  }

  bm.notes.sort((a, b) => a.time - b.time || 0);
  return bm;
}

/** 原生 taiko 的大连打判定：type 字段的「新Combo」位与「滑条」位同时置位（type 6） */
function isBigTaikoObject(o) {
  return (o.rawType & 6) === 6;
}

/** 某时刻的一拍长度(ms) */
export function beatMsAt(bm, t) {
  let bl = 500;
  for (const tp of bm.timingPoints) {
    if (tp.time > t) break;
    if (tp.red && tp.beatLength > 0) bl = tp.beatLength;
  }
  return bl;
}

/** 某时刻生效的 BPM */
export function bpmAt(bm, t) {
  let bl = 500;
  for (const tp of bm.timingPoints) {
    if (tp.time > t) break;
    if (tp.red && tp.beatLength > 0) bl = tp.beatLength;
  }
  return bl > 0 ? 60000 / bl : 0;
}

/** 某时刻的滚动速度倍率（SV），继承上一条非零值 */
/**
 * 给定时刻的滚动速度（SV）倍率。
 * 依据 时间点.txt：绿线（继承时间点）的 beatLength 为负值，
 * 去掉符号后被 100 整除即为SV 倍率 => SV = 100 / |beatLength|。
 * 例：-1000 -> 0.1x，-50 -> 2.0x。红线不改变 SV。
 */
/** 给定时刻是否处于 Kiai（踩点）区间。沿用红线的「继承」语义。 */
export function kiaiAt(bm, t) {
  let val = false;
  for (const tp of bm.timingPoints) {
    if (tp.time > t) break;
    if (tp.red) val = !!tp.kiai;
  }
  return val;
}

export function svAt(bm, t) {
  let sv = 1.0;
  for (const tp of bm.timingPoints) {
    if (tp.time > t) break;
    if (!tp.red) {
      const bl = Math.abs(tp.beatLength);
      if (bl > 0) sv = 100.0 / bl;
    }
  }
  return sv;
}

/** 谱面总时长(ms) */
export function lengthMs(bm) {
  if (!bm.notes.length) return 0;
  let end = 0;
  for (const n of bm.notes) {
    const e = (n.kind === NOTE_ROLL || n.kind === NOTE_SPINNER) ? n.endTime : n.time;
    if (e > end) end = e;
  }
  return end;
}

/**
 * 有效时长（ playable time ）：从**首个物件**到歌曲结束、扣除休息段的总时长。
 *
 * 区间取 [首个物件时间, lengthMs(bm)]（lengthMs 已是最后一个物件的结束时间），
 * 逐个扣掉与该区间相交的 Break 时段（部分重叠按实际重叠算）。
 *
 * 用于信息栏「时长(有效时长)」显示 —— 例如 SEISHUNNO_HACKING 总长 7:24，
 * 其中有约 5.8s 是休息段，有效时长要把它扣掉。
 */
export function playableMs(bm) {
  if (!bm.notes.length) return 0;
  const t0 = Math.min(...bm.notes.map(n => n.time));
  const t1 = lengthMs(bm);
  let total = t1 - t0;
  for (const [s, e] of (bm.breaks || [])) {
    /* 只扣与 [t0, t1] 相交的部分 */
    const os = Math.max(s, t0), oe = Math.min(e, t1);
    if (oe > os) total -= (oe - os);
  }
  return Math.max(0, total);
}

/** 判断某个时刻是否落在休息段内 */
export function inBreak(bm, t) {
  for (const [s, e] of (bm.breaks || [])) {
    if (t >= s && t < e) return true;
  }
  return false;
}

/** 统计 (don, kat, big) */
export function colorCounts(bm) {
  let don = 0, kat = 0, big = 0;
  for (const n of bm.notes) {
    if (n.kind === NOTE_DON) don++;
    else if (n.kind === NOTE_KAT) kat++;
    else if (n.kind === NOTE_BIG) big++;
  }
  return { don, kat, big };
}