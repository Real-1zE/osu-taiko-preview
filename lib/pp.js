/* ==========================================================================
 * pp.js —— osu!taiko PP（Performance Points）计算
 *
 * 移植自 Python 实现（taiko_diffcalc/ppcalc.py），
 * 对应官方 TaikoPerformanceCalculator.cs（2026.730.0）。
 *
 * 用法：
 *   import { calculatePp } from './pp.js';
 *   const r = calculatePp({
 *     sr, rhythmDifficulty, monoStaminaFactor, consistencyFactor,
 *     totalHits, od, clockRate,
 *     great, ok, meh, miss,
 *     hidden, flashlight, classic, easy,
 *   });
 *
 * ★ PP 的核心是单一统计量 EUR（Estimated Unstable Rate）：
 *   以 99% 置信度反推玩家命中偏差的统计上界，而非直接误差度量。
 * ========================================================================== */

const SQRT2 = 1.4142135623730950;
const Z99 = 2.32634787404;   /* 正态分布 99% 单尾临界值 */

/* ---------- DiffUtils 子集 ---------- */

function logistic(x, midpointOffset, multiplier, maxValue = 1.0) {
  try {
    return maxValue / (1.0 + Math.exp(multiplier * (midpointOffset - x)));
  } catch (e) {
    return 0.0;
  }
}

function reverseLerp(x, start, end) {
  if (end === start) return 0.0;
  return Math.min(Math.max((x - start) / (end - start), 0.0), 1.0);
}

/** 数值近似的 erf（Abramowitz-Stegun 7.1.26），与 Python 版同式 */
function erf(x) {
  if (x === 0) return 0.0;
  if (!Number.isFinite(x)) return x > 0 ? 1.0 : -1.0;
  const ax = Math.abs(x);
  const t = 1.0 / (1.0 + 0.3275911 * ax);
  const tau = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741
    + t * (-1.453152027 + t * 1.061405429))));
  const e = 1.0 - tau * Math.exp(-ax * ax);
  return x >= 0 ? e : -e;
}

/** erf 的逆（Newton 迭代），与 Python 版同式 */
function erfInv(x) {
  if (x <= -1) return -Infinity;
  if (x >= 1) return Infinity;
  if (x === 0) return 0.0;
  const a = 0.147;
  const sgn = x >= 0 ? 1 : -1;
  const ax = Math.abs(x);
  const ln = Math.log(1 - ax * ax);
  const t1 = 2 / (Math.PI * a) + ln / 2;
  const t2 = ln / a;
  const base = Math.sqrt(t1 * t1 - t2) - t1;
  const c = ax >= 0.85 ? ((ax - 0.85) / 0.293) ** 8 : 0.0;
  return sgn * (Math.sqrt(base) + c);
}

/** TaikoHitWindows.WindowFor(Great) —— 与 difficulty.js 共用同一标定 */
const HIT_WINDOW_GREAT_RANGE = [50.0, 20.0, 0.0];

function difficultyRange(difficulty, drange) {
  const lo = drange[0], hi = drange[1], avg = drange[2];
  const t = Math.min(Math.max(difficulty, 0.0), 10.0);
  if (avg > 0) {
    if (t > 5) return avg + (hi - avg) * ((t - 5) / 5.0);
    return lo + (avg - lo) * (t / 5.0);
  }
  return lo + (hi - lo) * (t / 10.0);
}

/** GREAT 判定窗口（ms） */
export function greatWindow(od) {
  return Math.floor(difficultyRange(od, HIT_WINDOW_GREAT_RANGE)) - 0.5;
}

/**
 * computeDeviationUpperBound —— 以 99% 置信度反推偏差上界
 * @param {number} n 总音符数
 * @param {number} p great 比例
 * @param {number} greatWin GREAT 窗口（已除以 clockRate）
 */
export function computeDeviationUpperBound(n, p, greatWin) {
  const pLower = (n * p + Z99 * Z99 / 2) / (n + Z99 * Z99)
    - Z99 / (n + Z99 * Z99) * Math.sqrt(n * p * (1 - p) + Z99 * Z99 / 4);
  return greatWin / (SQRT2 * erfInv(pLower));
}

/* ---------- PP 主公式 ---------- */

/**
 * 计算 PP
 *
 * @param {object} p
 * @param {number} p.sr                   Star Rating
 * @param {number} p.rhythmDifficulty    Rhythm 维度值（来自 difficulty.js）
 * @param {number} p.monoStaminaFactor
 * @param {number} p.consistencyFactor
 * @param {number} p.totalHits           总音符数（great+ok+meh+miss）
 * @param {number} p.od                  mod 后的 OD
 * @param {number} p.clockRate
 * @param {number} p.great
 * @param {number} p.ok
 * @param {number} p.meh
 * @param {number} p.miss
 * @param {boolean} [p.hidden]           HD
 * @param {boolean} [p.flashlight]       FL
 * @param {boolean} [p.classic]          CL
 * @param {boolean} [p.easy]             EZ
 * @param {boolean} [p.isConvert]        转换谱
 * @returns {{difficulty:number, accuracy:number, total:number, eur:(number|null)}}
 */
export function calculatePp(p) {
  const {
    sr, rhythmDifficulty, monoStaminaFactor, consistencyFactor,
    od, clockRate = 1.0, great, ok, meh,
    hidden = false, flashlight = false, classic = false, easy = false,
    isConvert = false,
  } = p;

  let miss = Math.max(0, p.miss || 0);
  const total = great + ok + meh + miss;
  if (total === 0) return { difficulty: 0, accuracy: 0, total: 0, eur: null };

  const gwin = greatWindow(od) / clockRate;

  /* ---- EUR ---- */
  const eur = (great === 0 || gwin <= 0) ? null
    : computeDeviationUpperBound(total, great / total, gwin) * 10;

  const tdh = total * consistencyFactor;

  let difficultyValue = 0.0;
  let accuracyValue = 0.0;

  if (eur !== null) {
    difficultyValue = computeDifficultyValue({
      eur, sr, rhythmDifficulty, monoStaminaFactor, tdh,
      missCount: miss, gwin, totalHits: total,
      hidden, flashlight, isConvert, classic, easy,
    }) * 1.08;
    accuracyValue = computeAccuracyValue({
      eur, sr, tdh, totalHits: total, hidden, isConvert, flashlight,
    }) * 1.1;
  }

  return {
    difficulty: difficultyValue,
    accuracy: accuracyValue,
    total: difficultyValue + accuracyValue,
    eur,
  };
}

function computeDifficultyValue(v) {
  const { eur, sr, rhythmDifficulty, monoStaminaFactor, tdh,
    missCount, gwin, totalHits, hidden, flashlight, isConvert, classic, easy } = v;

  if (tdh === 0) return 0.0;

  /* ★ 这两个参考值依赖 totalHits（C# 内部用 n = totalHits），不是常数 */
  const rhythmExpectedEur = computeDeviationUpperBound(totalHits, 1.0, gwin) * 10;
  const rhythmMaxEur = computeDeviationUpperBound(totalHits, 0.8, gwin) * 10;

  const rhythmFactor = reverseLerp(rhythmDifficulty / sr, 0.15, 0.4);

  const rhythmPenalty = 1.0 - logistic(
    eur,
    (rhythmExpectedEur + rhythmMaxEur) / 2,
    10 / (rhythmMaxEur - rhythmExpectedEur),
    0.25 * rhythmFactor ** 3,
  );

  let base = 5 * Math.max(1.0, sr * rhythmPenalty / 0.110) - 4.0;
  let value = Math.min(Math.pow(base, 3) / 69052.51, Math.pow(base, 2.25) / 1250.0);

  /* 10 星以上额外加成 */
  value *= 1 + 0.10 * Math.max(0.0, sr - 10);

  /* 长度加成（用 ConsistencyFactor 修正过的总难度） */
  const lengthBonus = 1 + 0.25 * tdh / (tdh + 4000);
  value *= lengthBonus;

  /* miss 惩罚：底数随 tdh 上升 ⇒ 短图每次 miss 的相对损失更大 */
  const missPenalty = 0.97 + 0.03 * tdh / (tdh + 1500);
  value *= Math.pow(missPenalty, missCount);

  if (hidden) {
    let hiddenBonus = isConvert ? 0.025 : 0.1;
    /* HD+FL 不计入读谱惩罚 */
    if (!flashlight) {
      /* 非 classic：playfield 可拉宽 → 读谱变易 */
      if (!classic) hiddenBonus *= 0.2;
      /* classic easy+HD：音符消失更晚 → 读谱变易 */
      if (easy && classic) hiddenBonus *= 0.5;
    }
    value *= 1 + hiddenBonus;
  }

  if (flashlight) {
    value *= Math.max(1, 1.050 - Math.min(monoStaminaFactor / 50, 1) * lengthBonus);
  }

  /* 单色高速图的准确度惩罚（Erf 的指数） */
  const monoAccExponent = 2 + monoStaminaFactor;
  const monoAccShift = 500 - 100 * (monoStaminaFactor * 3);
  return value * Math.pow(erf(monoAccShift / (SQRT2 * eur)), monoAccExponent);
}

function computeAccuracyValue(v) {
  const { eur, sr, tdh, totalHits, hidden, isConvert, flashlight } = v;
  if (eur <= 0) return 0.0;

  let value = 470 * Math.pow(0.9885, eur);
  value *= 1 + Math.pow(50 / eur, 2) * Math.pow(sr, 2.8) / 600;

  if (hidden && !isConvert) value *= 1.075;

  value *= 1 + 0.3 * tdh / (tdh + 4000);

  /* HDFL 的记忆长度加成 */
  if (flashlight && hidden && !isConvert) {
    const memoryLengthBonus = Math.min(1.15, Math.pow(totalHits / 1500.0, 0.3));
    value *= Math.max(1.0, 1.05 * memoryLengthBonus);
  }

  return value;
}

/* ==========================================================================
 * 便捷入口：从难度属性 + 成绩统计直接算 PP
 * ========================================================================== */

/**
 * @param {object} diffResult calculateStarRating() 的返回值
 * @param {object} stats { great, ok, meh, miss, acc } acc 可选（如 0.98）
 * @param {string} modName mod 名
 * @returns {object|null}
 */
export function ppFromDifficulty(diffResult, stats, modName = 'None') {
  if (!diffResult) return null;
  const mods = getModSpec(modName);

  const great = stats.great !== undefined ? stats.great : 0;
  const ok = stats.ok !== undefined ? stats.ok : 0;
  const meh = stats.meh !== undefined ? stats.meh : 0;
  const miss = stats.miss !== undefined ? stats.miss : 0;
  const totalHits = great + ok + meh + miss;
  if (totalHits === 0) return null;

  const od = diffResult.od !== undefined
    ? diffResult.od
    : (diffResult.controlInfo ? diffResult.controlInfo.overallDifficulty : 5);

  return calculatePp({
    sr: diffResult.starRating,
    rhythmDifficulty: diffResult.rhythmDifficulty,
    monoStaminaFactor: diffResult.monoStaminaFactor,
    consistencyFactor: diffResult.consistencyFactor,
    totalHits,
    od,
    clockRate: mods.rate,
    great, ok, meh, miss,
    hidden: mods.hidden,
    flashlight: mods.flashlight,
    classic: mods.classic,
    easy: mods.easy,
    isConvert: !!diffResult.isConvert,
  });
}

/** 与 difficulty.js 的 TAIKO_MODS 保持一致的轻量副本（避免循环 import） */
function getModSpec(modName) {
  const TABLE = {
    None: { rate: 1.0, hidden: false, flashlight: false, classic: false, easy: false },
    EZ: { rate: 1.0, hidden: false, flashlight: false, classic: false, easy: true },
    HD: { rate: 1.0, hidden: true, flashlight: false, classic: false, easy: false },
    HR: { rate: 1.0, hidden: false, flashlight: false, classic: false, easy: false },
    DT: { rate: 1.5, hidden: false, flashlight: false, classic: false, easy: false },
    NC: { rate: 1.5, hidden: false, flashlight: false, classic: false, easy: false },
    HT: { rate: 0.75, hidden: false, flashlight: false, classic: false, easy: false },
    FL: { rate: 1.0, hidden: false, flashlight: true, classic: false, easy: false },
    CL: { rate: 1.0, hidden: false, flashlight: false, classic: true, easy: false },
    NF: { rate: 1.0, hidden: false, flashlight: false, classic: false, easy: false },
    'HD+DT': { rate: 1.5, hidden: true, flashlight: false, classic: false, easy: false },
    'HR+DT': { rate: 1.5, hidden: false, flashlight: false, classic: false, easy: false },
    'FL+HD': { rate: 1.0, hidden: true, flashlight: true, classic: false, easy: false },
    'CL+HD': { rate: 1.0, hidden: true, flashlight: false, classic: true, easy: false },
    'EZ+HD': { rate: 1.0, hidden: true, flashlight: false, classic: false, easy: true },
    'CL+EZ+HD': { rate: 1.0, hidden: true, flashlight: false, classic: true, easy: true },
    'DT+HD+FL': { rate: 1.5, hidden: true, flashlight: true, classic: false, easy: false },
  };
  return TABLE[modName] || TABLE.None;
}

export default {
  calculatePp,
  ppFromDifficulty,
  computeDeviationUpperBound,
  greatWindow,
};
