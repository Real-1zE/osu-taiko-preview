/* ==========================================================================
 * difficulty.js —— osu!taiko Star Rating 计算（浏览器端）
 *
 * 移植自 Python 实现（taiko_diffcalc/diffcalc.py + convert.py），
 * 与官方 osu.Game.Rulesets.Taiko 2026.730.0 在 81 个原生 taiko 难度上
 * 逐位一致（最大绝对差 0.000000000000）。
 *
 * 用法：
 *   import { calculateStarRating } from './difficulty.js';
 *   const r = calculateStarRating(beatmapText);
 *   console.log(r.starRating, r.rhythmDifficulty, ...);
 *
 * 输入：.osu 原始文本（parseOsu 之后的 beatmap 对象，或原始文本）
 * 输出：TaikoDifficultyAttributes + 各 skill 明细
 *
 * ★ 移植要点（与 Python 版相同的踩坑经验）：
 *   1. Math.pow(负数, 1.5) 在 C# 里是 NaN，在 JS 里也是 NaN —— 恰好一致，
 *      不要「修正」它，NaN 让该段落被静默丢弃是真实行为。
 *   2. RhythmEvaluator 用的是 HitObjectIntervalRatio（组间比值），
 *      不是 HitObjectInterval（绝对间隔）。用错不报错但恒返回 0。
 *   3. HitWindow 的 DifficultyRange 三参数必须用标定值，不能照抄 master 源码。
 *   4. 计算 mod 下的SR 时必须把 mod 后的 OD 写回，否则 hit window 仍用旧 OD。
 * ========================================================================== */

const E = Math.E;

/* ---------- DiffUtils ---------- */

/** C# Math.Pow(负数, 非整数) = NaN。JS 行为相同，无需特殊处理。 */
function mathPow(x, p) {
  return Math.pow(x, p);
}

/** DiffUtils.Logistic(x, midpointOffset, multiplier, maxValue) */
function logistic(x, midpointOffset, multiplier, maxValue = 1.0) {
  try {
    return maxValue / (1.0 + Math.exp(multiplier * (midpointOffset - x)));
  } catch (e) {
    return 0.0;
  }
}

/** DiffUtils.Logistic(exponent, maxValue) */
function logisticE(exponent, maxValue = 1.0) {
  try {
    return maxValue / (1.0 + Math.exp(exponent));
  } catch (e) {
    return 0.0;
  }
}

/** DiffUtils.Norm(p, values) —— p-范数 */
function norm(p, ...values) {
  let s = 0.0;
  for (const v of values) s += mathPow(v, p);
  return mathPow(s, 1.0 / p);
}

function bellCurve(x, mean, width, multiplier = 1.0) {
  return multiplier * Math.exp(E * (-((x - mean) ** 2 / width ** 2)));
}

function smoothstep(x, start, end) {
  if (start === end) return x < start ? 0 : 1;
  const t = Math.min(Math.max((x - start) / (end - start), 0.0), 1.0);
  return t * t * (3.0 - 2.0 * t);
}

function smootherstep(x, start, end) {
  if (start === end) return x < start ? 0 : 1;
  const t = Math.min(Math.max((x - start) / (end - start), 0.0), 1.0);
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

/** DiffUtils.ReverseLerp(x, start, end) */
function reverseLerp(x, start, end) {
  if (end === start) return 0.0;
  return Math.min(Math.max((x - start) / (end - start), 0.0), 1.0);
}

/* ---------- 判定窗口标定（2026.730.0 实测反解） ---------- */
/* 官方 WindowFor(Great) 实测：
 *   OD 0..10 → 49.5 46.5 43.5 40.5 37.5 34.5 31.5 28.5 25.5 22.5 19.5
 * 注意：master 源码写的是 (50,35,20)，与实际编译产物不一致，必须以实测为准。 */
const HIT_WINDOW_GREAT_RANGE = [50.0, 20.0, 0.0];
const HIT_WINDOW_OK_RANGE = [120.0, 50.0, 80.0];
const HIT_WINDOW_MISS_RANGE = [135.0, 70.0, 95.0];

/** IBeatmapDifficultyInfo.DifficultyRange —— average>0 时为两段线性 */
function difficultyRange(difficulty, drange) {
  const lo = drange[0], hi = drange[1], avg = drange[2];
  const t = Math.min(Math.max(difficulty, 0.0), 10.0);
  if (avg > 0) {
    if (t > 5) return avg + (hi - avg) * ((t - 5) / 5.0);
    return lo + (avg - lo) * (t / 5.0);
  }
  return lo + (hi - lo) * (t / 10.0);
}

/** TaikoHitWindows.WindowFor */
function taikoHitWindow(od, result = 'great') {
  if (result === 'great') return Math.floor(difficultyRange(od, HIT_WINDOW_GREAT_RANGE)) - 0.5;
  if (result === 'ok') return Math.floor(difficultyRange(od, HIT_WINDOW_OK_RANGE)) - 0.5;
  return Math.floor(difficultyRange(od, HIT_WINDOW_MISS_RANGE)) - 0.5;
}

/* ---------- 官方 master 源码里的原始 DifficultyRange 元组 ----------
 * TaikoHitWindows:
 *   GREAT_WINDOW_RANGE = new DifficultyRange(50, 35, 20)   → (Min=50, Mid=35, Max=20)
 *   OK_WINDOW_RANGE    = new DifficultyRange(120, 80, 50)  → (Min=120, Mid=80, Max=50)
 *   MISS_WINDOW_RANGE  = new DifficultyRange(135, 95, 70)  → (Min=135, Mid=95, Max=70)
 * 本项目 drange 约定为 [Min, Max, Mid]，故写作：
 * ★ 正向 difficultyRange 与实测 range 等价，但 InverseDifficultyRange 必须用官方元组
 *   —— Mid 位置不同会走错分支。 */
export const GREAT_WINDOW_RANGE_OFFICIAL = [50.0, 20.0, 35.0];
export const OK_WINDOW_RANGE_OFFICIAL = [120.0, 50.0, 80.0];
export const MISS_WINDOW_RANGE_OFFICIAL = [135.0, 70.0, 95.0];

/** IBeatmapDifficultyInfo.InverseDifficultyRange —— DifficultyRange 的反函数 */
export function inverseDifficultyRange(difficultyValue, drange) {
  const d0 = drange[0], d10 = drange[1], d5 = drange[2];
  const v = difficultyValue;
  /* C# Math.Sign：正数 1、负数 -1、零 0 */
  const s1 = v > d5 ? 1 : (v < d5 ? -1 : 0);
  const s2 = d10 > d5 ? 1 : (d10 < d5 ? -1 : 0);
  return s1 === s2
    ? (v - d5) / (d10 - d5) * 5 + 5
    : (v - d5) / (d5 - d0) * 5 + 5;
}

/** 显示 HP 的 mod 系数（ModEasy / ModHardRock 基类的 ApplyToDifficulty） */
export const HP_MOD_FACTORS = {
  None: 1.0, EZ: 0.5, HD: 1.0, HR: 1.4, DT: 1.0, NC: 1.0, HT: 1.0,
  FL: 1.0, CL: 1.0, NF: 1.0,
  'HD+DT': 1.0, 'HR+DT': 1.4, 'FL+HD': 1.0, 'CL+HD': 1.0,
  'EZ+HD': 0.5, 'CL+EZ+HD': 0.5, 'DT+HD+FL': 1.0,
};

/**
 * 取组合 mod 的 HP 系数：表里有就用表里的（保证与官方预置组合逐位一致），
 * 没有就把各个单 mod 的系数**连乘**。
 * HP 只有 EZ(0.5) / HR(1.4) 会改，其余都是 1.0，所以连乘等价于取非 1 的那个。
 */
export function hpFactorFor(modName) {
  const key = String(modName || 'None');
  if (HP_MOD_FACTORS[key] !== undefined) return HP_MOD_FACTORS[key];
  let f = 1.0;
  for (const p of key.split('+')) {
    const v = HP_MOD_FACTORS[p.trim()];
    if (v !== undefined) f *= v;
  }
  return f;
}

/**
 * TaikoRuleset.GetAdjustedDisplayDifficulty —— 勾选 mod 后实际显示的难度参数
 *
 * 官方实现（osu.Game.Rulesets.Taiko.TaikoRuleset.cs）：
 *   BeatmapDifficulty adjusted = base.GetAdjustedDisplayDifficulty(beatmapInfo, mods);
 *   double rate  = ModUtils.CalculateRateWithMods(mods);
 *   double great = IBeatmapDifficultyInfo.DifficultyRange(
 *                      adjusted.OverallDifficulty, TaikoHitWindows.GREAT_WINDOW_RANGE);
 *   great /= rate;
 *   adjusted.OverallDifficulty =
 *       (float)IBeatmapDifficultyInfo.InverseDifficultyRange(great, GREAT_WINDOW_RANGE);
 *
 * ★ base 版本只跑 IApplicableToDifficulty 的 ApplyToDifficulty，因此 **HP 会被 mod 改**：
 *     ModEasy     基类 → CS ×0.5、AR ×0.5、HP ×0.5
 *     ModHardRock 基类 → HP = min(HP × 1.4, 10)
 *   TaikoModEasy / TaikoModHardRock 再额外改 OD 与 SliderMultiplier。
 *
 * ── 两种「显示 OD」口径 ──────────────────────────────────────────
 * 1) displayOdLazer —— osu!lazer 官方口径。官方单测
 *    TaikoRateAdjustedDisplayDifficultyTest 断言：OD5+HT → 1.11、OD5+DT → 8.89。
 * 2) displayOd —— osu! stable 的「apparent OD」口径：great 窗口 < 20ms 时
 *    （即 OD 已到顶 10 且带速率 mod），用 80 - 6×displayOd = great 反解出 >10 的值。
 *    两套公式在 OD=10 处相交（taiko great(10)=20，80-6×10=20），因此只在 <20ms 时
 *    启用是自洽的延拓。校验：OD10+DT → great=13.333 → (80-13.333)/6 = 11.11 ✓
 *
 * @param {number} od 谱面原始 OverallDifficulty
 * @param {number} hp 谱面原始 DrainRate
 * @param {string} modName
 */
export function getAdjustedDisplayDifficulty(od, hp, modName = 'None') {
  const m = resolveMod(modName);
  const rate = m.rate;

  /* base.GetAdjustedDisplayDifficulty */
  const adjOd = Math.min(od * m.od, 10.0);
  const adjHp = Math.min(hp * hpFactorFor(modName), 10.0);

  /* 判定窗口：裸 DifficultyRange（未 floor），再除以 rate */
  const great = difficultyRange(adjOd, HIT_WINDOW_GREAT_RANGE) / rate;

  const displayOdLazer = inverseDifficultyRange(great, GREAT_WINDOW_RANGE_OFFICIAL);
  const displayOd = great < 20.0 ? (80.0 - great) / 6.0 : adjOd;

  return {
    od: adjOd,
    hp: adjHp,
    displayOd,
    displayOdLazer,
    rate,
    scrollSpeed: m.sm,
    greatWindow: great,
    /* 判定口径：TaikoHitWindows.WindowFor —— floor 之后再除 rate */
    greatWindowFloor: taikoHitWindow(adjOd, 'great') / rate,
    okWindow: taikoHitWindow(adjOd, 'ok') / rate,
    missWindow: taikoHitWindow(adjOd, 'miss') / rate,
  };
}

/* ---------- 物件类型 ---------- */

export const NOTE_KIND_DON = 0;   /* centre / 红 */
export const NOTE_KIND_KAT = 1;   /* rim / 蓝 */

/** 转换后的 taiko 物件 */
class Hit {
  constructor(startTime, type, duration = 0.0) {
    this.startTime = startTime;
    this.type = type;           /* 0=Don 1=Kat */
    this.duration = duration;
    this.isHit = true;
  }
}
class DrumRoll {
  constructor(startTime, duration = 0.0) {
    this.startTime = startTime;
    this.duration = duration;
    this.isHit = false;
    this.type = null;
  }
}
class Swell {
  constructor(startTime, duration = 0.0) {
    this.startTime = startTime;
    this.duration = duration;
    this.isHit = false;
    this.type = null;
  }
}

/* ---------- DifficultyHitObject ---------- */

class TaikoDifficultyHitObject {
  constructor(baseObject, lastObject, clockRate, objects, index, controlInfo, globalSliderVelocity) {
    this.baseObject = baseObject;
    this.lastObject = lastObject;
    this.index = index;
    this.allObjects = objects;

    this.clockRate = clockRate;
    this.deltaTime = (baseObject.startTime - lastObject.startTime) / clockRate;
    this.startTime = baseObject.startTime / clockRate;
    this.endTime = (baseObject.startTime + (baseObject.duration || 0.0)) / clockRate;

    /* HitWindows：DrumRoll/Swell 为 HitWindows.Empty → 0 */
    if (baseObject.isHit) {
      this.hitWindowGreat = 2.0 * taikoHitWindow(controlInfo.overallDifficulty, 'great') / clockRate;
    } else {
      this.hitWindowGreat = 0.0;
    }

    this.monoIndex = 0;
    this.noteIndex = 0;
    this.rhythmData = null;
    this.colourData = null;
    this.monoList = null;
    this.noteList = null;

    /* EffectiveBPM = BPM × sliderVelocity(global × ScrollSpeed × clockRate) */
    const normalisedStartTime = this.startTime * clockRate;
    const curBpm = controlInfo.timingAt(normalisedStartTime);
    const sv = globalSliderVelocity * controlInfo.effectAt(normalisedStartTime) * clockRate;
    this.effectiveBpm = curBpm * sv;
  }

  previous(skipCount = 0) {
    const i = this.index - (skipCount + 1);
    if (i >= 0 && i < this.allObjects.length) return this.allObjects[i];
    return null;
  }

  previousMono(backwardsIndex) {
    const lst = this.monoList;
    if (!lst) return null;
    const i = this.monoIndex - (backwardsIndex + 1);
    if (i >= 0 && i < lst.length) return lst[i];
    return null;
  }

  nextMono(forwardsIndex) {
    const lst = this.monoList;
    if (!lst) return null;
    const i = this.monoIndex + (forwardsIndex + 1);
    if (i >= 0 && i < lst.length) return lst[i];
    return null;
  }

  previousNote(backwardsIndex) {
    const lst = this.noteList;
    if (!lst) return null;
    const i = this.noteIndex - (backwardsIndex + 1);
    if (i >= 0 && i < lst.length) return lst[i];
    return null;
  }

  nextNote(forwardsIndex) {
    const lst = this.noteList;
    if (!lst) return null;
    const i = this.noteIndex + (forwardsIndex + 1);
    if (i >= 0 && i < lst.length) return lst[i];
    return null;
  }

  get interval() { return this.deltaTime; }
}

/* ---------- 颜色预处理数据结构 ---------- */

class MonoStreak {
  constructor() {
    this.hitObjects = [];
    this.parent = null;
    this.index = 0;
  }
  get first() { return this.hitObjects[0]; }
  get last() { return this.hitObjects[this.hitObjects.length - 1]; }
  get hitType() {
    const bo = this.hitObjects[0].baseObject;
    return bo.type === undefined ? null : bo.type;
  }
  get runLength() { return this.hitObjects.length; }
}

class AlternatingMonoPattern {
  constructor() {
    this.monoStreaks = [];
    this.parent = null;
    this.index = 0;
  }
  get first() { return this.monoStreaks[0].first; }
  isRepetitionOf(other) {
    return (this.hasIdenticalMonoLength(other)
      && other.monoStreaks.length === this.monoStreaks.length
      && other.monoStreaks[0].hitType === this.monoStreaks[0].hitType);
  }
  hasIdenticalMonoLength(other) {
    return other.monoStreaks[0].runLength === this.monoStreaks[0].runLength;
  }
}

class RepeatingHitPatterns {
  constructor(previous) {
    this.MAX_REPETITION_INTERVAL = 16;
    this.alternatingMonoPatterns = [];
    this.previous = previous;
    this.repetitionInterval = this.MAX_REPETITION_INTERVAL + 1;
  }
  get first() { return this.alternatingMonoPatterns[0].first; }
  _isRepetitionOf(other) {
    if (this.alternatingMonoPatterns.length !== other.alternatingMonoPatterns.length) return false;
    const n = Math.min(this.alternatingMonoPatterns.length, 2);
    for (let i = 0; i < n; i++) {
      if (!this.alternatingMonoPatterns[i].hasIdenticalMonoLength(other.alternatingMonoPatterns[i])) {
        return false;
      }
    }
    return true;
  }
  findRepetitionInterval() {
    if (!this.previous) {
      this.repetitionInterval = this.MAX_REPETITION_INTERVAL + 1;
      return;
    }
    let other = this.previous;
    let interval = 1;
    while (interval < this.MAX_REPETITION_INTERVAL) {
      if (this._isRepetitionOf(other)) {
        this.repetitionInterval = Math.min(interval, this.MAX_REPETITION_INTERVAL);
        return;
      }
      other = other.previous;
      if (!other) break;
      interval += 1;
    }
    this.repetitionInterval = this.MAX_REPETITION_INTERVAL + 1;
  }
}

class ColourData {
  constructor() {
    this.monoStreak = null;
    this.alternatingMonoPattern = null;
    this.repeatingHitPattern = null;
    this.previousColourChange = null;
    this.nextColourChange = null;
  }
}

/* ---------- 节奏预处理数据结构 ---------- */

const MARGIN_OF_ERROR = 5.0;

/**
 * C# `Math.Round(double)` —— **banker's rounding（ToEven）**
 *
 * ★ 关键：JS 的 Math.round 是「四舍五入到 +∞」（Math.round(58.5) === 59），
 *   而 C# Math.Round 默认 MidpointRounding.ToEven（Math.Round(58.5) === 58）。
 *   两者在 .5 处反向，会让 SameRhythmHitObjectGrouping 的 modalDelta 差 1ms，
 *   进而改变 hitObjectIntervalRatio —— rhythm 维度的 raw 值会偏差 5% 以上。
 *   Python 的 round() 恰好也是 ToEven，所以基准侧是对的，只有 JS 需要修。
 *
 * 参考：C# 规范「Floating-Point Arithmetic Methods」§Rounding 与
 *      IEEE 754 roundTiesToEven。
 */
function roundToEven(x) {
  const f = Math.floor(x);
  const diff = x - f;
  /* 差值极小说明 x 本就是整数，交给 Math.round 走快路径 */
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return (f % 2 === 0) ? f : f + 1;   /* .5 → 取偶 */
}

/** DeltaTimeNormaliser.Normalise */
function normaliseDeltaTimes(hitObjects) {
  const dts = Array.from(new Set(hitObjects.map(h => h.deltaTime))).sort((a, b) => a - b);
  const sets = [];
  let current = null;
  for (const v of dts) {
    if (current !== null && Math.abs(v - current[0]) <= MARGIN_OF_ERROR) {
      current.push(v);
      continue;
    }
    current = [v];
    sets.push(current);
  }
  const medianLookup = new Map();
  for (const s of sets) {
    s.sort((a, b) => a - b);
    const mid = s.length >> 1;
    const median = (s.length % 2 === 1) ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    for (const v of s) medianLookup.set(v, median);
  }
  const out = new Map();
  for (const h of hitObjects) out.set(h, medianLookup.get(h.deltaTime));
  return out;
}

function almostEquals(a, b, margin) {
  return Math.abs(a - b) <= margin;
}

/** IntervalGroupingUtils.GroupByInterval
 *
 * ★ 严格复刻 Python 的 _create_next_group 语义：
 *   分组条件不满足时 **立即 return**（不是 break 继续），
 *   且返回值携带「下一个未消费物件的索引 i」。
 */
function createNextGroup(objects, startIdx) {
  const n = objects.length;
  const grouped = [objects[startIdx]];
  let i = startIdx + 1;

  while (i < n - 1) {
    if (!almostEquals(objects[i].interval, objects[i + 1].interval, MARGIN_OF_ERROR)) {
      if (objects[i + 1].interval > objects[i].interval + MARGIN_OF_ERROR) {
        grouped.push(objects[i]);
        i += 1;
      }
      /* ★ C#/Python 都是 return —— 直接结束本组，不执行下面的收尾判断 */
      return { grouped, next: i };
    }
    grouped.push(objects[i]);
    i += 1;
  }

  if (n > 2 && i < n && almostEquals(objects[n - 1].interval, objects[n - 2].interval, MARGIN_OF_ERROR)) {
    grouped.push(objects[i]);
    i += 1;
  }
  return { grouped, next: i };
}

function groupByInterval(objects) {
  const n = objects.length;
  const groups = [];
  let i = 0;
  while (i < n) {
    const r = createNextGroup(objects, i);
    groups.push(r.grouped);
    /* ★ Python: i = groups[-1][1]，即 createNextGroup 返回的 next。
       若 next 未推进则强制 +1 防死循环（理论上不会发生）。 */
    i = (r.next > i) ? r.next : (i + 1);
  }
  return groups;
}

class SameRhythmHitObjectGrouping {
  constructor(previous, hitObjects) {
    this.hitObjects = hitObjects;
    this.previous = previous;
    this.startTime = hitObjects[0].startTime;

    const normMap = normaliseDeltaTimes(hitObjects);
    const normalised = hitObjects.slice(1).map(h => normMap.get(h));

    /* ★ 必须用 roundToEven（C# Math.Round 的 ToEven），不能用 Math.round */
    const modalDelta = normalised.length ? roundToEven(normalised[0]) : 0;

    this.hitObjectInterval = null;
    if (normalised.length) {
      if (previous && previous.hitObjectInterval !== null
        && Math.abs(modalDelta - previous.hitObjectInterval) <= MARGIN_OF_ERROR) {
        this.hitObjectInterval = previous.hitObjectInterval;
      } else {
        this.hitObjectInterval = modalDelta;
      }
    }

    if (previous && previous.hitObjectInterval !== null && this.hitObjectInterval !== null) {
      this.hitObjectIntervalRatio = this.hitObjectInterval / previous.hitObjectInterval;
    } else {
      this.hitObjectIntervalRatio = 1.0;
    }

    if (previous) {
      this.interval = Math.abs(this.startTime - previous.startTime) <= MARGIN_OF_ERROR
        ? 0.0 : this.startTime - previous.startTime;
    } else {
      this.interval = Infinity;
    }
  }

  get first() { return this.hitObjects[0]; }
  get duration() { return this.hitObjects[this.hitObjects.length - 1].startTime - this.hitObjects[0].startTime; }
}

class SamePatternsGroupedHitObjects {
  constructor(previous, groups) {
    this.groups = groups;
    this.previous = previous;
  }
  get groupInterval() {
    return this.groups.length > 1 ? this.groups[1].interval : this.groups[0].interval;
  }
  get intervalRatio() {
    if (!this.previous) return 1.0;
    const prevGi = this.previous.groupInterval;
    if (prevGi === null || prevGi === undefined || prevGi === 0) return 1.0;
    return this.groupInterval / prevGi;
  }
  get first() { return this.groups[0].first; }
  get allHitObjects() {
    const out = [];
    for (const g of this.groups) out.push(...g.hitObjects);
    return out;
  }
}

class RhythmData {
  constructor() {
    this.sameRhythmGroupedHitObjects = null;
    this.samePatternsGroupedHitObjects = null;
    this.ratio = 1.0;
  }
}

const COMMON_RATIOS = [1 / 1, 2 / 1, 1 / 2, 3 / 1, 1 / 3, 3 / 2, 2 / 3, 5 / 4, 4 / 5];

/* ==========================================================================
 * Evaluators
 * ========================================================================== */

/** RhythmEvaluator.ratioDifficulty */
function ratioDifficulty(ratio, terms = 8) {
  if (!Number.isFinite(ratio) || ratio === 0 || Math.abs(ratio) <= 2.2250738585072014e-308) {
    ratio = 0.0;
  }
  let difficulty = 0.0;
  for (let i = 1; i <= terms; i++) {
    difficulty += -1.0 * mathPow(Math.cos(i * Math.PI * ratio), 4);
  }
  difficulty += terms / (1.0 + ratio);
  difficulty += bellCurve(ratio, 1.0, 0.5);
  difficulty -= bellCurve(ratio, 1.0, 0.3);
  difficulty = Math.max(difficulty, 0.0);
  return difficulty / Math.sqrt(8.0);
}

function sameInterval(startGroup, intervalCount, threshold = 0.1) {
  const intervals = [];
  let current = startGroup;
  for (let i = 0; i < intervalCount; i++) {
    if (!current) break;
    intervals.push(current.hitObjectInterval);
    current = current.previous;
  }
  const valid = intervals.filter(x => x !== null && x !== undefined);
  if (valid.length < intervalCount) return 1.0;
  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      if (valid[i] === 0 || valid[j] === 0) continue;
      const ratio = valid[i] / valid[j];
      if (Math.abs(1.0 - ratio) <= threshold) return 0.80;
    }
  }
  return 1.0;
}

function repeatedIntervalPenalty(group, hitWindow, threshold = 0.1) {
  const longIntervalPenalty = sameInterval(group, 3, threshold);
  const shortIntervalPenalty = group.hitObjects.length >= 6 ? 1.0 : sameInterval(group, 4, threshold);
  const durationPenalty = hitWindow > 0
    ? Math.max(1.0 - group.duration * 2 / hitWindow, 0.5) : 0.5;
  return Math.min(longIntervalPenalty, shortIntervalPenalty) * durationPenalty;
}

function longGapPenalty(previous) {
  if (!previous) return 1.0;
  const gapInterval = previous.first.deltaTime;
  const rhythmInterval = previous.hitObjectInterval !== null && previous.hitObjectInterval !== undefined
    ? previous.hitObjectInterval : gapInterval;
  const rhythmLength = previous.hitObjects.length;
  const gapRatio = gapInterval / Math.max(rhythmInterval, 1.0);
  const gapFactor = logistic(gapRatio, 1.75, 20.0);
  const lengthFactor = reverseLerp(rhythmLength, 8, 2);
  return 1.0 - 0.75 * gapFactor * lengthFactor;
}

function evaluateSameRhythm(group, hitWindow) {
  /* ★ C# 用 HitObjectIntervalRatio（组间比值），不是 HitObjectInterval */
  let intervalDifficulty = ratioDifficulty(group.hitObjectIntervalRatio);
  const previousInterval = group.previous ? group.previous.hitObjectInterval : null;

  intervalDifficulty *= repeatedIntervalPenalty(group, hitWindow);

  if (previousInterval !== null && previousInterval !== undefined && group.hitObjects.length > 1) {
    const expected = previousInterval * group.hitObjects.length;
    const durationDifference = group.duration - expected;
    if (durationDifference > 0) {
      const arg = hitWindow > 0 ? durationDifference / hitWindow : 0.0;
      intervalDifficulty *= logistic(arg, 0.35, 2, 1.0);
    }
  }

  const dArg = hitWindow > 0 ? group.duration / hitWindow : 0.0;
  intervalDifficulty *= logistic(dArg, 0.3, 2, 1.0);

  return mathPow(intervalDifficulty, 0.75);
}

/** RhythmEvaluator.EvaluateDifficultyOf */
function rhythmEvaluate(ho) {
  if (!ho.baseObject.isHit) return 0.0;

  const rd = ho.rhythmData;
  let sameRhythm = 0.0, samePattern = 0.0;
  let intervalPenalty = 1.0, gapPenalty = 1.0;
  const hitWindow = ho.hitWindowGreat;

  const g = rd.sameRhythmGroupedHitObjects;
  if (g && g.first === ho) {
    sameRhythm += 10.0 * evaluateSameRhythm(g, hitWindow);
    intervalPenalty = repeatedIntervalPenalty(g, hitWindow);
    gapPenalty = longGapPenalty(g.previous);
  }

  const sp = rd.samePatternsGroupedHitObjects;
  if (sp && sp.first === ho) {
    samePattern += 1.15 * ratioDifficulty(sp.intervalRatio);
  }

  return Math.max(sameRhythm, samePattern) * intervalPenalty * gapPenalty;
}

/** ColourEvaluator.consistentRatioPenalty
 *
 * 严格复刻 C# 控制流：previousHitObject 在循环中**从不更新**，
 * 只在开头取一次 current.Previous(1)。因此第二次迭代时
 * current === previousHitObject，比值恒为 1，必然命中阈值并 break。
 */
function consistentRatioPenalty(ho, threshold = 0.01, maxObjectsToCheck = 64) {
  let consistentRatioCount = 0;
  let totalRatioCount = 0.0;
  const recentRatios = [];

  let current = ho;
  const previousHitObject = current.previous(1);

  for (let k = 0; k < maxObjectsToCheck; k++) {
    if (current.index <= 1 || !previousHitObject) break;
    const currentRatio = current.rhythmData.ratio;
    const previousRatio = previousHitObject.rhythmData.ratio;
    recentRatios.push(currentRatio);
    if (Math.abs(1.0 - currentRatio / previousRatio) <= threshold) {
      consistentRatioCount += 1;
      totalRatioCount += currentRatio;
      break;
    }
    current = previousHitObject;
  }

  if (consistentRatioCount > 0) {
    return 1.0 - totalRatioCount / (consistentRatioCount + 1) * 0.80;
  }
  if (recentRatios.length <= 1) return 1.0;
  const avg = recentRatios.reduce((a, b) => a + b, 0) / recentRatios.length;
  const maxRatioDeviation = Math.max(...recentRatios.map(r => Math.abs(r - avg)));
  return 0.7 + 0.3 * smootherstep(maxRatioDeviation, 0.0, 1.0);
}

function evalMonoStreak(ms) {
  return logisticE(E * ms.index - 2 * E) * evalAlternating(ms.parent) * 0.5;
}
function evalAlternating(amp) {
  return logisticE(E * amp.index - 2 * E) * evalRepeating(amp.parent);
}
function evalRepeating(rhp) {
  return 2.0 * (1.0 - logisticE(E * rhp.repetitionInterval - 2 * E));
}

/** ColourEvaluator.EvaluateDifficultyOf
 *  注意：这是唯一**没有** `if (BaseObject is not Hit) return 0` 的 evaluator。 */
function colourEvaluate(ho) {
  const cd = ho.colourData;
  let difficulty = 0.0;
  if (cd.monoStreak && cd.monoStreak.first === ho) difficulty += evalMonoStreak(cd.monoStreak);
  if (cd.alternatingMonoPattern && cd.alternatingMonoPattern.first === ho) difficulty += evalAlternating(cd.alternatingMonoPattern);
  if (cd.repeatingHitPattern && cd.repeatingHitPattern.first === ho) difficulty += evalRepeating(cd.repeatingHitPattern);
  return difficulty * consistentRatioPenalty(ho);
}

/** ReadingEvaluator.EvaluateDifficultyOf */
function readingEvaluate(ho) {
  const highMin = 480.0, highMax = 640.0;
  const midMin = 360.0, midMax = 480.0;
  const highCenter = (highMax + highMin) / 2;
  const highRange = highMax - highMin;
  const midCenter = (midMax + midMin) / 2;
  const midRange = midMax - midMin;

  const effectiveBpm = Math.max(1.0, ho.effectiveBpm);

  const midVelocityDifficulty = 0.5 * logistic(effectiveBpm, midCenter, 1.0 / (midRange / 10));

  const expectedDeltaTime = 21000.0 / effectiveBpm;
  const objectDensity = expectedDeltaTime / Math.max(1.0, ho.deltaTime);
  const densityPenalty = logistic(objectDensity, 0.925, 15.0);

  const highVelocityDifficulty = (1.0 - 0.33 * densityPenalty)
    * logistic(effectiveBpm,
      highCenter + 8 * densityPenalty,
      (1.0 + 0.5 * densityPenalty) / (highRange / 10));

  return midVelocityDifficulty + highVelocityDifficulty;
}

function speedBonus(interval) {
  return 20.0 / Math.max(interval, 1.0);
}

/** StaminaEvaluator.availableFingersFor */
function availableFingersFor(ho) {
  const cd = ho.colourData;
  const prevCc = cd.previousColourChange;
  const nextCc = cd.nextColourChange;
  if (prevCc && ho.startTime - prevCc.startTime < 300) return 2;
  if (nextCc && nextCc.startTime - ho.startTime < 300) return 2;
  return 8;
}

/** StaminaEvaluator.EvaluateDifficultyOf */
function staminaEvaluate(ho) {
  if (!ho.baseObject.isHit) return 0.0;
  const taikoPrevious = ho.previous(1);
  const fingers = availableFingersFor(ho);
  const previousMono = ho.previousMono(fingers - 1);

  let objectStrain = 0.5;
  if (!taikoPrevious) return objectStrain;
  if (previousMono) {
    objectStrain += speedBonus(ho.startTime - previousMono.startTime)
      + 0.5 * speedBonus(ho.startTime - taikoPrevious.startTime);
  }
  return objectStrain;
}

/* ==========================================================================
 * Skills
 * ========================================================================== */

class StrainSkill {
  constructor() {
    this.DECAY_WEIGHT = 0.9;
    this.SECTION_LENGTH = 400;
    this.currentStrain = 0.0;
    this.currentSectionPeak = 0.0;
    this.currentSectionEnd = 0.0;
    this.strainPeaks = [];
    this.objectDifficulties = [];
    this.started = false;
  }

  process(current) {
    if (current.index === 0) {
      this.currentSectionEnd = Math.ceil(current.startTime / this.SECTION_LENGTH) * this.SECTION_LENGTH;
      this.started = true;
    }
    while (current.startTime > this.currentSectionEnd) {
      this.strainPeaks.push(this.currentSectionPeak);
      this.currentSectionPeak = this.calculateInitialStrain(this.currentSectionEnd, current);
      this.currentSectionEnd += this.SECTION_LENGTH;
    }
    const strain = this.strainValueAt(current);
    this.currentSectionPeak = Math.max(strain, this.currentSectionPeak);
    this.objectDifficulties.push(strain);
    return strain;
  }

  getCurrentStrainPeaks() {
    return this.strainPeaks.concat([this.currentSectionPeak]);
  }

  difficultyValue() {
    let difficulty = 0.0;
    let weight = 1.0;
    const peaks = this.getCurrentStrainPeaks().filter(p => p > 0).sort((a, b) => b - a);
    for (const strain of peaks) {
      difficulty += strain * weight;
      weight *= this.DECAY_WEIGHT;
    }
    return difficulty;
  }

  countTopWeightedStrains(difficultyValue) {
    if (this.objectDifficulties.length === 0) return 0.0;
    const consistentTopStrain = difficultyValue * (1 - this.DECAY_WEIGHT);
    if (consistentTopStrain === 0) return this.objectDifficulties.length;
    let s = 0.0;
    for (const v of this.objectDifficulties) s += logistic(v / consistentTopStrain, 0.88, 10.0, 1.1);
    return s;
  }

  calculateInitialStrain(time, current) { throw new Error('abstract'); }
  strainValueAt(current) { throw new Error('abstract'); }
}

class StrainDecaySkill extends StrainSkill {
  constructor(skillMultiplier, strainDecayBase) {
    super();
    this.skillMultiplier = skillMultiplier;
    this.strainDecayBase = strainDecayBase;
  }
  strainDecay(ms) {
    return mathPow(this.strainDecayBase, ms / 1000.0);
  }
  calculateInitialStrain(time, current) {
    const prev = current.previous(0);
    return this.currentStrain * this.strainDecay(time - prev.startTime);
  }
  strainValueAt(current) {
    this.currentStrain *= this.strainDecay(current.deltaTime);
    this.currentStrain += this.strainValueOf(current) * this.skillMultiplier;
    return this.currentStrain;
  }
  strainValueOf(current) { throw new Error('abstract'); }
}

class RhythmSkill extends StrainDecaySkill {
  constructor() { super(1.0, 0.4); }
  strainValueOf(current) {
    let difficulty = rhythmEvaluate(current);
    const staminaDifficulty = staminaEvaluate(current) - 0.5;
    difficulty *= logistic(staminaDifficulty, 1.0 / 15.0, 50.0);
    return difficulty;
  }
}

class ReadingSkill extends StrainDecaySkill {
  constructor() { super(1.0, 0.4); this.localStrain = 0.0; }
  strainValueOf(current) {
    if (!current.baseObject.isHit) return 0.0;
    const cd = current.colourData;
    let idx = 0;
    if (cd.monoStreak) {
      for (let i = 0; i < cd.monoStreak.hitObjects.length; i++) {
        if (cd.monoStreak.hitObjects[i] === current) { idx = i; break; }
      }
    }
    this.localStrain *= logistic(idx, 4.0, -1.0 / 25.0, 0.5) + 0.5;
    this.localStrain *= this.strainDecayBase;
    this.localStrain += readingEvaluate(current) * this.skillMultiplier;
    return this.localStrain;
  }
}

class ColourSkill extends StrainDecaySkill {
  constructor() { super(0.12, 0.8); }
  strainValueOf(current) { return colourEvaluate(current); }
}

class StaminaSkill extends StrainSkill {
  constructor(singleColourStamina, isConvert) {
    super();
    this.singleColourStamina = singleColourStamina;
    this.isConvert = isConvert;
    this.localStrain = 0.0;
    this.SKILL_MULTIPLIER = 1.1;
    this.STRAIN_DECAY_BASE = 0.4;
  }
  strainDecay(ms) { return mathPow(this.STRAIN_DECAY_BASE, ms / 1000.0); }
  calculateInitialStrain(time, current) {
    if (this.singleColourStamina) return 0.0;
    const prev = current.previous(0);
    return this.localStrain * this.strainDecay(time - prev.startTime);
  }
  strainValueAt(current) {
    this.localStrain *= this.strainDecay(current.deltaTime);
    let staminaDifficulty = staminaEvaluate(current) * this.SKILL_MULTIPLIER;
    const cd = current.colourData;
    let idx = 0;
    if (cd.monoStreak) {
      for (let i = 0; i < cd.monoStreak.hitObjects.length; i++) {
        if (cd.monoStreak.hitObjects[i] === current) { idx = i; break; }
      }
    }
    const monoLengthBonus = this.isConvert ? 1.0 : 1.0 + 0.5 * reverseLerp(idx, 5, 20);
    if (!this.singleColourStamina) staminaDifficulty *= monoLengthBonus;
    this.localStrain += staminaDifficulty;
    if (this.singleColourStamina) {
      return logisticE(-(idx - 10) / 2.0, this.localStrain);
    }
    return this.localStrain;
  }
}

/* ==========================================================================
 * 预处理
 * ========================================================================== */

function encodeMonoStreak(data) {
  const monoStreaks = [];
  let current = null;
  for (const taiko of data) {
    const previous = taiko.previousNote(0);
    if (!current || !previous || taiko.baseObject.type !== previous.baseObject.type) {
      current = new MonoStreak();
      monoStreaks.push(current);
    }
    current.hitObjects.push(taiko);
  }
  return monoStreaks;
}

function encodeAlternating(data) {
  const monoPatterns = [];
  let current = null;
  for (let i = 0; i < data.length; i++) {
    if (!current || data[i].runLength !== data[i - 1].runLength) {
      current = new AlternatingMonoPattern();
      monoPatterns.push(current);
    }
    current.monoStreaks.push(data[i]);
  }
  return monoPatterns;
}

function encodeRepeatingPatterns(data) {
  const hitPatterns = [];
  const n = data.length;
  let i = 0;
  while (i < n) {
    const current = new RepeatingHitPatterns(hitPatterns.length ? hitPatterns[hitPatterns.length - 1] : null);
    let isCoupled = i < n - 2 && data[i].isRepetitionOf(data[i + 2]);
    if (!isCoupled) {
      current.alternatingMonoPatterns.push(data[i]);
      i += 1;
    } else {
      while (isCoupled) {
        current.alternatingMonoPatterns.push(data[i]);
        i += 1;
        isCoupled = i < n - 2 && data[i].isRepetitionOf(data[i + 2]);
      }
      current.alternatingMonoPatterns.push(data[i]);
      current.alternatingMonoPatterns.push(data[i + 1]);
      i += 2;
    }
    hitPatterns.push(current);
  }
  for (const hp of hitPatterns) hp.findRepetitionInterval();
  return hitPatterns;
}

/** TaikoColourDifficultyPreprocessor.ProcessAndAssign */
function processColour(difficultyObjects) {
  const monoStreaks = encodeMonoStreak(difficultyObjects);
  const alternating = encodeAlternating(monoStreaks);
  const hitPatterns = encodeRepeatingPatterns(alternating);

  for (const repeating of hitPatterns) {
    for (let i = 0; i < repeating.alternatingMonoPatterns.length; i++) {
      const monoPattern = repeating.alternatingMonoPatterns[i];
      monoPattern.parent = repeating;
      monoPattern.index = i;
      for (let j = 0; j < monoPattern.monoStreaks.length; j++) {
        const monoStreak = monoPattern.monoStreaks[j];
        monoStreak.parent = monoPattern;
        monoStreak.index = j;
        for (const ho of monoStreak.hitObjects) {
          ho.colourData.repeatingHitPattern = repeating;
          ho.colourData.alternatingMonoPattern = monoPattern;
          ho.colourData.monoStreak = monoStreak;
        }
      }
    }
  }

  for (const ho of difficultyObjects) {
    const cd = ho.colourData;
    if (cd.monoStreak) {
      cd.previousColourChange = cd.monoStreak.first.previousNote(0);
      cd.nextColourChange = cd.monoStreak.last.nextNote(0);
    }
  }
}

function createSameRhythmGroups(hitObjects) {
  const groups = [];
  for (const grouped of groupByInterval(hitObjects)) {
    groups.push(new SameRhythmHitObjectGrouping(groups.length ? groups[groups.length - 1] : null, grouped));
  }
  return groups;
}

function createSamePatternGroups(rhythmGroups) {
  const groups = [];
  for (const grouped of groupByInterval(rhythmGroups)) {
    groups.push(new SamePatternsGroupedHitObjects(groups.length ? groups[groups.length - 1] : null, grouped));
  }
  return groups;
}

/** TaikoRhythmDifficultyPreprocessor.ProcessAndAssign */
function processRhythm(noteObjects) {
  const rhythmGroups = createSameRhythmGroups(noteObjects);
  for (const g of rhythmGroups) {
    for (const ho of g.hitObjects) ho.rhythmData.sameRhythmGroupedHitObjects = g;
  }
  const patternGroups = createSamePatternGroups(rhythmGroups);
  for (const g of patternGroups) {
    for (const ho of g.allHitObjects) ho.rhythmData.samePatternsGroupedHitObjects = g;
  }
}

function assignRhythmRatio(ho) {
  const previous = ho.previous(0);
  if (!previous) { ho.rhythmData.ratio = 1.0; return; }
  if (previous.deltaTime === 0) { ho.rhythmData.ratio = 1.0; return; }
  const actual = ho.deltaTime / previous.deltaTime;
  let best = COMMON_RATIOS[0], bestDiff = Math.abs(COMMON_RATIOS[0] - actual);
  for (const r of COMMON_RATIOS) {
    const d = Math.abs(r - actual);
    if (d < bestDiff) { bestDiff = d; best = r; }
  }
  ho.rhythmData.ratio = best;
}

/* ==========================================================================
 * Mod 定义（严格按 ppy/osu 2026.730.0 源码）
 * ========================================================================== */

export const TAIKO_MODS = {
  None: { od: 1.0, sm: 1.0, rate: 1.0, hidden: false, flashlight: false, classic: false, easy: false },
  EZ: { od: 0.5, sm: 0.8, rate: 1.0, hidden: false, flashlight: false, classic: false, easy: true },
  HD: { od: 1.0, sm: 1.0, rate: 1.0, hidden: true, flashlight: false, classic: false, easy: false },
  HR: { od: 1.4, sm: 1.4 * 4 / 3, rate: 1.0, hidden: false, flashlight: false, classic: false, easy: false },
  DT: { od: 1.0, sm: 1.0, rate: 1.5, hidden: false, flashlight: false, classic: false, easy: false },
  /* ★ Nightcore 的缩写是 NC；NF 是 No Fail（对 SR/PP 零影响） */
  NC: { od: 1.0, sm: 1.0, rate: 1.5, hidden: false, flashlight: false, classic: false, easy: false },
  HT: { od: 1.0, sm: 1.0, rate: 0.75, hidden: false, flashlight: false, classic: false, easy: false },
  FL: { od: 1.0, sm: 1.0, rate: 1.0, hidden: false, flashlight: true, classic: false, easy: false },
  CL: { od: 1.0, sm: 1.0, rate: 1.0, hidden: false, flashlight: false, classic: true, easy: false },
  NF: { od: 1.0, sm: 1.0, rate: 1.0, hidden: false, flashlight: false, classic: false, easy: false },
  'HD+DT': { od: 1.0, sm: 1.0, rate: 1.5, hidden: true, flashlight: false, classic: false, easy: false },
  'HR+DT': { od: 1.4, sm: 1.4 * 4 / 3, rate: 1.5, hidden: false, flashlight: false, classic: false, easy: false },
  'FL+HD': { od: 1.0, sm: 1.0, rate: 1.0, hidden: true, flashlight: true, classic: false, easy: false },
  'CL+HD': { od: 1.0, sm: 1.0, rate: 1.0, hidden: true, flashlight: false, classic: true, easy: false },
  'EZ+HD': { od: 0.5, sm: 0.8, rate: 1.0, hidden: true, flashlight: false, classic: false, easy: true },
  'CL+EZ+HD': { od: 0.5, sm: 0.8, rate: 1.0, hidden: true, flashlight: false, classic: true, easy: true },
  'DT+HD+FL': { od: 1.0, sm: 1.0, rate: 1.5, hidden: true, flashlight: true, classic: false, easy: false },
};

/**
 * 把 "+" 连接的 mod 名**组合**成一个效果对象。
 *
 * 为什么需要：上面的TAIKO_MODS 只列了官方预置的几个组合
 * （HD+DT / CL+EZ+HD 等），而插件界面允许自由勾选 ——
 * "HT+CL"、"EZ+FL"、"DT+CL+HD" 这些组合表里根本没有，
 * 直接查表会抛「未知 mod」，导致切 mod 后整块 SR/PP 算不出来。
 *
 * 各 mod 的效果是**独立可乘**的，所以组合规则很直接：
 *   od  = 连乘（EZ 0.5 / HR 1.4）
 *   sm  = 连乘（EZ 0.8 / HR 1.4×4/3）
 *   rate= 取流速类 mod 的值（HT 0.75 / DT 1.5 / NC 1.5）；
 *         界面已保证 HT/DT/NC 三者互斥，所以最多只有一个非 1
 *   hidden / flashlight / classic / easy = 逻辑或
 *
 * 单个 mod 与预置组合都走这里，行为与原来查表完全一致
 * （已在 test/sr_verify.mjs 里与官方 C# 逐位对过）。
 *
 * @param {string} modName "None" 或 "A+B+C"
 * @returns {object} 与 TAIKO_MODS 条目同构的对象
 */
export function resolveMod(modName) {
  const key = String(modName || 'None');
  if (TAIKO_MODS[key]) return TAIKO_MODS[key];
  if (key === 'None') return TAIKO_MODS.None;
  const parts = key.split('+').map((s) => s.trim()).filter(Boolean);
  const mods = parts.map((p) => TAIKO_MODS[p]);
  for (let i = 0; i < mods.length; i++) {
    if (!mods[i]) throw new Error('未知 mod: ' + parts[i] + '（组合 "' + key + '"）');
  }
  const out = {
    od: 1.0, sm: 1.0, rate: 1.0,
    hidden: false, flashlight: false, classic: false, easy: false,
  };
  for (const m of mods) {
    out.od *= m.od;
    out.sm *= m.sm;
    /* 流速类互斥（界面保证），多个时以最后一个为准，
       与官方「HT 与 DT 不可共存」的行为一致 */
    if (m.rate !== 1.0) out.rate = m.rate;
    out.hidden = out.hidden || m.hidden;
    out.flashlight = out.flashlight || m.flashlight;
    out.classic = out.classic || m.classic;
    out.easy = out.easy || m.easy;
  }
  /* OD 上限 10 由调用方（applyMod）统一处理 */
  return out;
}

/** 应用 mod → { controlInfo, sliderMultiplier, clockRate, hidden, flashlight, classic, easy } */
export function applyMod(controlInfo, globalSliderVelocity, modName) {
  const m = resolveMod(modName);
  const ci = Object.assign({}, controlInfo);
  /* ★ 必须写回 controlInfo，否则 hit window 仍用原 OD */
  ci.overallDifficulty = Math.min(controlInfo.overallDifficulty * m.od, 10.0);
  return {
    controlInfo: ci,
    sliderMultiplier: globalSliderVelocity * m.sm,
    clockRate: m.rate,
    hidden: m.hidden, flashlight: m.flashlight, classic: m.classic, easy: m.easy,
  };
}

/* ==========================================================================
 * 主计算
 * ========================================================================== */

const DIFFICULTY_MULTIPLIER = 0.084375;
export const RHYTHM_SKILL_MULTIPLIER = 0.770 * DIFFICULTY_MULTIPLIER;
export const READING_SKILL_MULTIPLIER = 0.100 * DIFFICULTY_MULTIPLIER;
export const COLOUR_SKILL_MULTIPLIER = 0.375 * DIFFICULTY_MULTIPLIER;
export const STAMINA_SKILL_MULTIPLIER = 0.445 * DIFFICULTY_MULTIPLIER;

export const DIFFCALC_VERSION = 20260706;

export function rescale(sr) {
  if (sr < 0) return sr;
  return 10.43 * Math.log(sr / 8.0 + 1.0);
}

function combineOne(r, rd, c, s, patternMultiplier, strainLengthBonus, isRelax, isConvert, mask) {
  if (mask) {
    r *= mask[0]; rd *= mask[1]; c *= mask[2]; s *= mask[3];
  }
  const rhythmPeak = r * RHYTHM_SKILL_MULTIPLIER * patternMultiplier;
  const readingPeak = rd * READING_SKILL_MULTIPLIER;
  const colourPeak = isRelax ? 0.0 : c * COLOUR_SKILL_MULTIPLIER;
  let staminaPeak = s * STAMINA_SKILL_MULTIPLIER * strainLengthBonus;
  staminaPeak /= (isConvert || isRelax) ? 1.5 : 1.0;
  /* ★ Math.pow(负数, 1.5) 在 C# 与 JS 里都是 NaN，
       NaN 与 0 比较为 false ⇒ 该段落被静默丢弃。这是真实行为，不要改。 */
  return norm(2, norm(1.5, colourPeak, staminaPeak), rhythmPeak, readingPeak);
}

function combinePeaksFromLists(rVals, rdVals, cVals, sVals, patternMultiplier, strainLengthBonus, isRelax, isConvert, mask) {
  const n = Math.min(cVals.length, rVals.length, rdVals.length, sVals.length);
  const combined = [];
  for (let i = 0; i < n; i++) {
    const peak = combineOne(rVals[i], rdVals[i], cVals[i], sVals[i],
      patternMultiplier, strainLengthBonus, isRelax, isConvert, mask);
    if (peak > 0) combined.push(peak);
  }
  return combined;
}

function combinePeaks(rhythm, reading, colour, stamina, patternMultiplier, strainLengthBonus, isRelax, isConvert, mask) {
  return combinePeaksFromLists(
    rhythm.getCurrentStrainPeaks(), reading.getCurrentStrainPeaks(),
    colour.getCurrentStrainPeaks(), stamina.getCurrentStrainPeaks(),
    patternMultiplier, strainLengthBonus, isRelax, isConvert, mask);
}

/** 生成 (rhythm, reading, colour, stamina) 的 0/1 开关；exclude 置 0，only 只留一项 */
function buildMask(exclude, only) {
  if (!exclude && !only) return null;
  const names = ['rhythm', 'reading', 'colour', 'stamina'];
  return names.map(n => (exclude ? (n === exclude ? 0 : 1) : (n === only ? 1 : 0)));
}

function combinedDifficultyValue(rhythm, reading, colour, stamina, patternMultiplier, strainLengthBonus, isRelax, isConvert, exclude, only) {
  const mask = buildMask(exclude, only);
  const peaks = combinePeaks(rhythm, reading, colour, stamina, patternMultiplier, strainLengthBonus, isRelax, isConvert, mask);
  if (peaks.length === 0) return { difficulty: 0.0, consistencyFactor: 0.0 };

  let difficulty = 0.0;
  let weight = 1.0;
  const sorted = peaks.slice().sort((a, b) => b - a);
  for (const strain of sorted) {
    difficulty += strain * weight;
    weight *= 0.9;
  }

  const objPeaks = combinePeaksFromLists(
    rhythm.objectDifficulties, reading.objectDifficulties,
    colour.objectDifficulties, stamina.objectDifficulties,
    patternMultiplier, strainLengthBonus, isRelax, isConvert, mask);

  if (objPeaks.length === 0) return { difficulty, consistencyFactor: 0.0 };

  const take = 1 + Math.floor(objPeaks.length / 20);
  const objSorted = objPeaks.slice().sort((a, b) => b - a);
  let topAvg = 0.0;
  for (let i = 0; i < take; i++) topAvg += objSorted[i];
  topAvg /= take;
  const consistencyFactor = topAvg !== 0
    ? objPeaks.reduce((a, b) => a + b, 0) / (topAvg * objPeaks.length) : 0.0;

  return { difficulty, consistencyFactor };
}

/* ==========================================================================
 * 四 skill 贡献占比
 *
 * 官方合并公式：Norm(2, Norm(1.5, colourPeak, staminaPeak), rhythmPeak, readingPeak)
 * 之后按降序加权求和（weight 从 1.0 每档 ×0.9）。
 *
 * ── 口径 A：p-norm 能量分解（energyShare）────────────────────────
 * p-范数 (Σ|xᵢ|^p)^(1/p) 的「能量」Σ|xᵢ|^p 可按项严格拆分：
 *     外层 p=2  ： E = inner² + rhythm² + reading²
 *     内层 p=1.5： inner^1.5 = colour^1.5 + stamina^1.5
 * 每项占比 = 其 p 次幂 / 总和，**四项之和恒为 1**。与官方公式完全一致，非近似。
 *
 * ── 口径 B：leave-one-out（星数边际贡献）────────────────────────
 * 把某 skill 的 peak 置 0 重算星数，差值即其边际贡献。
 * rescale 是对数函数 ⇒ 四项之和 ≥ 总星数（次可加），归一化后才是可比占比。
 * ========================================================================== */

/** 单段 peak 的 p-norm 能量分解 */
function energyShares(r, rd, c, s, patternMultiplier, strainLengthBonus, isRelax, isConvert) {
  const rhythmPeak = r * RHYTHM_SKILL_MULTIPLIER * patternMultiplier;
  const readingPeak = rd * READING_SKILL_MULTIPLIER;
  const colourPeak = isRelax ? 0.0 : c * COLOUR_SKILL_MULTIPLIER;
  let staminaPeak = s * STAMINA_SKILL_MULTIPLIER * strainLengthBonus;
  staminaPeak /= (isConvert || isRelax) ? 1.5 : 1.0;

  const eColour = mathPow(colourPeak, 1.5);
  const eStamina = mathPow(staminaPeak, 1.5);
  const innerEnergy = eColour + eStamina;
  const inner = innerEnergy > 0 ? mathPow(innerEnergy, 1.0 / 1.5) : 0.0;

  const eInner = inner * inner;
  const eRhythm = rhythmPeak * rhythmPeak;
  const eReading = readingPeak * readingPeak;
  const total = eInner + eRhythm + eReading;

  if (!(total > 0) || Number.isNaN(total)) return null;

  const innerShare = eInner / total;
  let sColour = 0, sStamina = 0;
  if (innerEnergy > 0 && !Number.isNaN(innerEnergy)) {
    sColour = eColour / innerEnergy;
    sStamina = eStamina / innerEnergy;
  }

  return {
    rhythm: eRhythm / total,
    reading: eReading / total,
    colour: innerShare * sColour,
    stamina: innerShare * sStamina,
  };
}

const SKILL_KEYS = ['rhythm', 'reading', 'colour', 'stamina'];

function skillContributions(rhythm, reading, colour, stamina, patternMultiplier, strainLengthBonus, isRelax, isConvert) {
  const zero = () => ({ rhythm: 0, reading: 0, colour: 0, stamina: 0 });

  /* ---------- 口径 A：能量分解（按 0.9 衰减权重累加） ---------- */
  const rP = rhythm.getCurrentStrainPeaks();
  const rdP = reading.getCurrentStrainPeaks();
  const cP = colour.getCurrentStrainPeaks();
  const sP = stamina.getCurrentStrainPeaks();
  const n = Math.min(cP.length, rP.length, rdP.length, sP.length);

  const entries = [];
  for (let i = 0; i < n; i++) {
    const sh = energyShares(rP[i], rdP[i], cP[i], sP[i], patternMultiplier, strainLengthBonus, isRelax, isConvert);
    const peak = combineOne(rP[i], rdP[i], cP[i], sP[i], patternMultiplier, strainLengthBonus, isRelax, isConvert, null);
    if (peak > 0) entries.push([peak, sh]);   /* 过滤条件与 combinePeaks 一致 */
  }

  let energy = zero();
  if (entries.length) {
    const acc = zero();
    let weight = 1.0;
    entries.sort((a, b) => b[0] - a[0]);
    for (const [, sh] of entries) {
      if (sh) for (const k of SKILL_KEYS) acc[k] += sh[k] * weight;
      weight *= 0.9;
    }
    const total = SKILL_KEYS.reduce((s, k) => s + acc[k], 0);
    if (total > 0) energy = Object.fromEntries(SKILL_KEYS.map(k => [k, acc[k] / total]));
  }

  /* ---------- 口径 B：leave-one-out ---------- */
  const loo = zero();
  const solo = zero();
  const baseCr = combinedDifficultyValue(rhythm, reading, colour, stamina, patternMultiplier, strainLengthBonus, isRelax, isConvert).difficulty;
  const baseSr = baseCr > 0 ? rescale(baseCr * 1.4) : 0.0;

  for (const key of SKILL_KEYS) {
    const cr = combinedDifficultyValue(rhythm, reading, colour, stamina, patternMultiplier, strainLengthBonus, isRelax, isConvert, key, null).difficulty;
    loo[key] = baseSr - (cr > 0 ? rescale(cr * 1.4) : 0.0);

    const cr1 = combinedDifficultyValue(rhythm, reading, colour, stamina, patternMultiplier, strainLengthBonus, isRelax, isConvert, null, key).difficulty;
    solo[key] = cr1 > 0 ? rescale(cr1 * 1.4) : 0.0;
  }

  return {
    energy,
    loo,
    looSum: SKILL_KEYS.reduce((s, k) => s + loo[k], 0),
    solo,
  };
}


/**
 * 计算 Star Rating
 *
 * @param {Array} playableObjects 已转换的 taiko 物件（按 startTime 排序）
 * @param {object} controlInfo { timingAt(t), effectAt(t), overallDifficulty }
 * @param {number} globalSliderVelocity 谱面 SliderMultiplier
 * @param {number} clockRate
 * @param {boolean} isRelax
 * @param {boolean} isConvert  非原生 taiko 谱（Mode != 1）
 * @returns {object} TaikoDifficultyAttributes + skills 明细
 */
export function calculateDifficulty(playableObjects, controlInfo, globalSliderVelocity,
  clockRate = 1.0, isRelax = false, isConvert = false, withContributions = true) {

  const difficultyObjects = [];
  const centreObjects = [];
  const rimObjects = [];
  const noteObjects = [];

  /* ★ 从 i=2 开始 —— C# 的 CreateDifficultyHitObjects 就是这样 */
  for (let i = 2; i < playableObjects.length; i++) {
    const base = playableObjects[i];
    const last = playableObjects[i - 1];
    const ho = new TaikoDifficultyHitObject(base, last, clockRate, difficultyObjects,
      difficultyObjects.length, controlInfo, globalSliderVelocity);
    ho.rhythmData = new RhythmData();
    ho.colourData = new ColourData();

    if (base.isHit) {
      if (base.type === NOTE_KIND_DON) {
        ho.monoIndex = centreObjects.length;
        centreObjects.push(ho);
        ho.monoList = centreObjects;
      } else {
        ho.monoIndex = rimObjects.length;
        rimObjects.push(ho);
        ho.monoList = rimObjects;
      }
      ho.noteIndex = noteObjects.length;
      noteObjects.push(ho);
      ho.noteList = noteObjects;
    } else {
      ho.monoList = null;
      ho.noteList = noteObjects;
    }
    difficultyObjects.push(ho);
  }

  if (difficultyObjects.length === 0) {
    return {
      starRating: 0.0, rhythmDifficulty: 0.0, readingDifficulty: 0.0,
      colourDifficulty: 0.0, staminaDifficulty: 0.0, mechanicalDifficulty: 0.0,
      monoStaminaFactor: 1.0, consistencyFactor: 0.0, staminaTopStrains: 0.0,
      skills: {},
    };
  }

  for (const ho of difficultyObjects) assignRhythmRatio(ho);
  processColour(difficultyObjects);
  processRhythm(noteObjects);

  const rhythm = new RhythmSkill();
  const reading = new ReadingSkill();
  const colour = new ColourSkill();
  const stamina = new StaminaSkill(false, isConvert);
  const singleColourStamina = new StaminaSkill(true, isConvert);
  const skills = [rhythm, reading, colour, stamina, singleColourStamina];

  for (const ho of difficultyObjects) {
    for (const s of skills) s.process(ho);
  }

  const staminaDifficultyValue = stamina.difficultyValue();

  const rhythmSkill = rhythm.difficultyValue() * RHYTHM_SKILL_MULTIPLIER;
  const readingSkill = reading.difficultyValue() * READING_SKILL_MULTIPLIER;
  const colourSkill = colour.difficultyValue() * COLOUR_SKILL_MULTIPLIER;
  const staminaSkill = staminaDifficultyValue * STAMINA_SKILL_MULTIPLIER;
  const monoStaminaSkill = singleColourStamina.difficultyValue() * STAMINA_SKILL_MULTIPLIER;
  const monoStaminaFactor = staminaSkill === 0 ? 1.0 : mathPow(monoStaminaSkill / staminaSkill, 5);

  const staminaDifficultStrains = stamina.countTopWeightedStrains(staminaDifficultyValue);
  const patternMultiplier = mathPow(staminaSkill * colourSkill, 0.10);
  const strainLengthBonus = 1.0 + 0.15 * reverseLerp(staminaDifficultStrains, 1000, 1555);

  const { difficulty: combinedRating, consistencyFactor } = combinedDifficultyValue(
    rhythm, reading, colour, stamina, patternMultiplier, strainLengthBonus, isRelax, isConvert);

  const starRating = rescale(combinedRating * 1.4);

  const denom = rhythmSkill + readingSkill + colourSkill + staminaSkill;
  const skillRating = denom !== 0 ? starRating / denom : 0.0;

  const rhythmDiff = rhythmSkill * skillRating;
  const readingDiff = readingSkill * skillRating;
  const colourDiff = colourSkill * skillRating;
  const staminaDiff = staminaSkill * skillRating;

  return {
    starRating,
    rhythmDifficulty: rhythmDiff,
    readingDifficulty: readingDiff,
    colourDifficulty: colourDiff,
    staminaDifficulty: staminaDiff,
    mechanicalDifficulty: colourDiff + staminaDiff,
    monoStaminaFactor,
    consistencyFactor,
    staminaTopStrains: staminaDifficultStrains,
    skills: {
      rhythmRaw: rhythm.difficultyValue(),
      readingRaw: reading.difficultyValue(),
      colourRaw: colour.difficultyValue(),
      staminaRaw: stamina.difficultyValue(),
      monoStaminaRaw: singleColourStamina.difficultyValue(),
      rhythmWeighted: rhythmSkill,
      readingWeighted: readingSkill,
      colourWeighted: colourSkill,
      staminaWeighted: staminaSkill,
      monoStaminaWeighted: monoStaminaSkill,
      patternMultiplier,
      strainLengthBonus,
      combinedRating,
      /* 贡献占比需要额外 9 次合并重算（4×leave-one-out + 4×solo + 1×基准），
         约为纯 SR 计算的 5 倍耗时。mod 对比表可传 withContributions=false 跳过。 */
      skillContributions: withContributions
        ? skillContributions(rhythm, reading, colour, stamina,
          patternMultiplier, strainLengthBonus, isRelax, isConvert)
        : null,
    },
  };
}

/* ==========================================================================
 * 从 parseOsu 的 beatmap 对象转换并计算（便捷入口）
 * ========================================================================== */

const VELOCITY_MULTIPLIER = 1.4;
const SWELL_HIT_MULTIPLIER = 1.65;

/** LegacyRulesetExtensions.GetPrecisionAdjustedBeatLength */
function getPrecisionAdjustedBeatLength(sliderVelocityMultiplier, beatLength) {
  const sliderVelocityAsBeatLength = -100.0 / sliderVelocityMultiplier;
  if (sliderVelocityAsBeatLength < 0) {
    const bpmMultiplier = Math.min(Math.max(-sliderVelocityAsBeatLength, 10.0), 10000.0) / 100.0;
    return beatLength * bpmMultiplier;
  }
  return beatLength * 1.0;
}

/** TaikoBeatmapConverter.RequiredSwellHitsPerSecond */
function requiredSwellHitsPerSecond(overallDifficulty) {
  const lo = 3.0, hi = 7.5;
  const val = lo + (hi - lo) * Math.min(Math.max(overallDifficulty / 10.0, 0.0), 1.0);
  return val * SWELL_HIT_MULTIPLIER;
}

/**
 * 把 parseOsu 的 beatmap 转成 taiko 物件列表
 * @param {object} bm osu_parser.js 的 parseOsu 返回值
 * @returns {{objects: Array, controlInfo: object, sliderMultiplier: number, maxCombo: number}}
 */
export function convertBeatmap(bm) {
  const gsv = bm.sliderMultiplier || 1.4;
  const controlInfo = {
    overallDifficulty: bm.od === undefined ? 5 : bm.od,
    timingAt: (t) => bpmAtLocal(bm, t),
    effectAt: (t) => svAtLocal(bm, t),
  };

  const objects = [];
  let maxCombo = 0;

  for (const n of bm.notes) {
    if (n.kind === 'don' || n.kind === 'kat' || n.kind === 'big') {
      /* ★ 颜色判定必须与 Python 的 is_rim 一致：**含 clap 或 whistle → Kat**
         大饼（Finish, bit2）本身不是 Kat，但大饼可同时带 whistle/clap
         （hitSound = 6/12），那些**必须**判为 Kat。
         实测 Thule：57 个大饼里 31 个带 Kat 位、26 个纯红，
         全部当 Don 会让 monoStreak 划分偏移（monoIdx 上限 16 vs 官方的 9）。*/
      const isKat = (n.kind === 'kat') || (n.kind === 'big' && n.blue);
      objects.push(new Hit(n.time, isKat ? NOTE_KIND_KAT : NOTE_KIND_DON, 0));
      maxCombo += 1;
    } else if (n.kind === 'roll') {
      /* slider → DrumRoll（原生 taiko 谱不拆 tick） */
      objects.push(new DrumRoll(n.time, n.endTime - n.time));
      maxCombo += 1;
    } else if (n.kind === 'spinner') {
      const hps = requiredSwellHitsPerSecond(controlInfo.overallDifficulty);
      void hps;
      objects.push(new Swell(n.time, n.endTime - n.time));
    }
  }

  /* C# 的 playable 列表按 StartTime 排序 */
  objects.sort((a, b) => a.startTime - b.startTime);
  return { objects, controlInfo, sliderMultiplier: gsv, maxCombo };
}

/* 内部的 BPM / SV 查询
 *
 * ★ SV 语义（与 Python 的 convert._sv_at / osu! 的 EffectControlPoint 一致）：
 *   **每个 timing point 行都产出一个 ScrollSpeed 值**：
 *     -绿点（beatLength < 0）→ SV = 100 / |beatLength|
 *     - 红点（beatLength > 0）→ SV = 1.0   ← 红点会把 SV **重置为 1.0**
 *   然后按时间取「最后一条 time <= t」的值。
 *
 *   osu_parser.js 的 svAt() 是**渲染用**的（红线不改变 SV，符合视觉直觉），
 *   难度计算必须用这里的版本。两者语义不同，不要混用。
 *   实测 Otsukimi（2770 个 timing point、大量 SV）：
 *   用渲染版SV 会让reading_raw 从 161.02 偏到 230.48（SR +0.02）。
 */
function svAtLocal(bm, t) {
  /* ★ 非原生 taiko：ScrollSpeed 控制点由转换器后处理生成
     （落点在滑条起始时间，不是 timing point 绿线位置）。*/
  if (bm.scrollPoints && bm.scrollPoints.length) {
    const pts = bm.scrollPoints;
    if (t < pts[0][0]) return 1.0;
    let lo = 0, hi = pts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (pts[mid][0] <= t) lo = mid; else hi = mid - 1;
    }
    return pts[lo][1];
  }
  const pts = bm.timingPoints;
  if (!pts || pts.length === 0) return 1.0;
  if (t < pts[0].time) return 1.0;

  /* 二分查找最后一个 time <= t 的点 */
  let lo = 0, hi = pts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pts[mid].time <= t) lo = mid;
    else hi = mid - 1;
  }
  const tp = pts[lo];
  if (tp.red) return 1.0;                       /* 红点 → ScrollSpeed = 1.0 */
  const bl = Math.abs(tp.beatLength);
  return bl > 0 ? 100.0 / bl : 1.0;
}

function bpmAtLocal(bm, t) {
  let bl = 500;
  for (const tp of bm.timingPoints) {
    if (tp.time > t) break;
    if (tp.red && tp.beatLength > 0) bl = tp.beatLength;
  }
  return bl > 0 ? 60000 / bl : 0;
}

/**
 * 便捷入口：直接从 parseOsu 的 beatmap 计算 Star Rating
 * @param {object} bm osu_parser.js 的 parseOsu 返回值
 * @param {string} modName mod 名（默认 None）
 * @returns {object|null}
 */
export function calculateStarRating(bm, modName = 'None', opts = {}) {
  if (!bm || !bm.notes || bm.notes.length === 0) return null;
  const { objects, controlInfo, sliderMultiplier } = convertBeatmap(bm);
  const isConvert = (bm.mode !== 1);
  const m = applyMod(controlInfo, sliderMultiplier, modName);
  const r = calculateDifficulty(objects, m.controlInfo, m.sliderMultiplier,
    m.clockRate, false, isConvert, opts.withContributions !== false);
  r.mod = modName;
  r.isConvert = isConvert;
  /* 勾选 mod 后实际显示的难度参数（渲染用） */
  r.display = getAdjustedDisplayDifficulty(bm.od === undefined ? 5 : bm.od,
    bm.hp === undefined ? 5 : bm.hp, modName);
  return r;
}

export default {
  calculateStarRating,
  calculateDifficulty,
  convertBeatmap,
  applyMod,
  resolveMod,
  hpFactorFor,
  rescale,
  getAdjustedDisplayDifficulty,
  inverseDifficultyRange,
  TAIKO_MODS,
  HP_MOD_FACTORS,
  DIFFCALC_VERSION,
};
