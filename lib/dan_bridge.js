/**
 * dan_rank 段位/键型评估的**适配层**：把插件自己的 beatmap 对象
 * 转成 `lib/dan_rank.js` 需要的输入，并保证 beatLengthAt / svAt
 * 的语义与 Python 侧**逐位一致**。
 *
 * ★★ 为什么必须单独写一层，不能直接用 lib/osu_parser.js 的
 *   `beatMsAt` / `svAtDifficulty`：
 *
 *   1. `svAtDifficulty`（本仓库 SR 用的那套）让**红线重置 SV 为 1.0**，
 *      因为 osu! 官方 `DifficultyControlPoint` 就是这么定义的。
 *      而 dan_rank 用的 `effect_at` 走的是 `EffectControlPoint` 序列，
 *      红点产出的是 scroll_speed=1.0 的点，但**它只在 SV 真的变化时
 *      才产生**（`_dedupe_effect_points` 做了去重）。
 *      实测 GIMMICK OVERDOSE 有 376/423 个音符两套取值不同 ——
 *      直接用会让段位明显偏。
 *
 *   2. `beatMsAt` 在 t 早于首个 timing point 时返回硬编码的 500，
 *      而 Python 的 `timing_at` 返回**第一个点本身**。
 *      谱面开头有一段「前奏无谱」时两者不同。
 *
 *   这两点合起来会让段位与 Python 基线差好几个点，所以这里严格复刻
 *   `taiko_diffcalc/osu_parser.py` 的 `timing_at` / `effect_at`。
 */

import { evaluateDan } from './dan_rank.js';

/**
 * 复刻 Python 的 `_dedupe_effect_points`
 * （`taiko_diffcalc/osu_parser.py:93`）。
 *
 * ★★ 关键：比对基准是「**当前生效点**」，不是「相邻点」。
 *   官方 `ControlPointInfo.Add` 的逻辑是
 *     if (CheckAlreadyExisting(time, cp)) return false;
 *     CheckAlreadyExisting -> EffectPointAt(time) -> newPoint.IsRedundant(existing)
 *   而 `IsRedundant(existing)` 是
 *     existing is EffectControlPoint e && KiaiMode == e.KiaiMode
 *                                  && ScrollSpeed == e.ScrollSpeed
 *   注意 `EffectPointAt` 找的是**当前生效**（时间 <= t 的最后一个），
 *   所以「相邻」只是它的特例。
 *
 * 这与「相邻同值去重」在存在「回退」序列时会不一致，例如
 * 0.5 → 0.4 → 0.5：第三个 0.5 与第一个（非相邻）相同，
 * 按 IsRedundant 会被丢弃，但按「相邻比较」会保留。
 * 实测该逻辑差异会让段位偏 ~0.4 段。
 *
 * ★★ 两个容易写错的点（都实测踩过）：
 *
 *  1. **比对基准是「已输出列表的最后一个」，不是「相邻输入」。**
 *     例如 0.5 → 0.4 → 0.5：第三个 0.5 与第一个（非相邻）相同，
 *     按 IsRedundant 会被丢弃，按「相邻比较」会保留。
 *
 *  2. ★★ **第一条永远保留** —— 比对只在「已有输出点」时才做。
 *     Python 原文是 `if result:`（`taiko_diffcalc/osu_parser.py:116`），
 *     不是拿ScrollSpeed 的默认值 1.0 当初值。
 *     我第一版误写成 `let currentSv = 1.0`，结果把谱面开头的
 *     `1718@sv=1.0` 判成 redundant 丢掉 —— EffectControlPoint 少了
 *     第一个点，段位偏 0.25（Ni Kan Dao De Wo [Spinning]）。
 *
 * 官方用 `Precision.AlmostEquals`，这里用同量级容差 1e-9。
 *
 * @param {Array<{time:number, sv:number}>} raw 按时间升序的原始点
 * @returns {Array<{time:number, sv:number}>}
 */
function dedupeEffectPoints(raw) {
  const out = [];
  for (const p of raw) {
    /* ★ 只在已有输出点时才比较 —— 与 Python 的 `if result:` 一致。
     * 拿默认值 1.0 当初值会把「开头正好是sv=1.0」的那一行误丢。*/
    if (out.length) {
      const last = out[out.length - 1];
      if (Math.abs(last.sv - p.sv) < 1e-9) continue;   /* IsRedundant */
    }
    out.push(p);
  }
  return out;
}

/**
 * 从插件解析出的 timingPoints 构造两套查询函数。
 *
 * 插件的 `bm.timingPoints` 每项形如
 *   `{ time, beatLength, red, kiai, sv, meter }`
 * —— `red` 表示红线（beatLength > 0），绿线 beatLength < 0。
 *
 * ★ 注意插件解析器**把 kiai 归一化成了 boolean**，而 Python 侧
 *   `_dedupe_effect_points` 只按 scroll_speed 去重、不看 kiai，
 *   两者可以对齐（我们只需要 scroll_speed）。
 *
 * @param {object} bm  parseOsu 的结果
 * @returns {{beatLengthAt:Function, svAt:Function}}
 */
export function makeControlPointAccessors(bm) {
  /* ---- TimingControlPoint 序列：每一行 timing point 都是一个点 ---- */
  const tps = (bm && bm.timingPoints) || [];

  /* ---- EffectControlPoint 序列 ----
   *
   * ★★★ 完整规则（照 `taiko_diffcalc/osu_parser.py:168-185` 复刻，四条全都要）：
   *
   *   ① **每一行** timing point 都产出一个 EffectControlPoint，不只是绿线：
   *        sm = (100.0 / -beat_length)  if beat_length < 0   （绿线）
   *        sm = 1.0                                       （红线）
   *      我最初只取绿线 => 141 个点少了大半，段位偏2.01。
   *
   *   ② ScrollSpeed 钳制到 **[0.01, 10]**（官方 BindableDouble 的上下限）。
   *
   *   ③ 同 time 时**绿点胜出**：effects 按 time 稳定排序，
   *      同 time 的后者（绿线在后）覆盖前者（红线在前）。
   *      —— 上面循环是按 timing_points 的原始顺序遍历，
   *      而 .osu 里红线总在同 time 的绿线之前，所以排序后绿线在后。
   *
   *   ④ timing_points 侧：BeatLength 钳制到 **[6, 60000]**，
   *      且**只保留红线**（绿线不进 timing 序列）。
   *
   *  ★★ Events 段的 type 12（mania SV 事件）也会产点（osu_parser.py:322），
   *   原生 taiko 谱基本没有，本插件解析器已收集到 bm.scrollEvents，
   *   这里一并纳入（顺序上排在 timing 点之后，与 Python 的解析顺序一致）。
   */
  const tpsRaw = (bm && bm.timingPoints) || [];
  /* timing 序列：只留红线，且钳制拍长 */
  const timing = [];
  /* effect 原始点：每行 timing point 都产一个 */
  const rawEffects = [];
  for (const tp of tpsRaw) {
    const bl = tp.beatLength;
    if (bl > 0) {
      timing.push({ time: tp.time, beatLength: Math.min(Math.max(bl, 6.0), 60000.0) });
    }
    let sm = (bl < 0) ? (100.0 / -bl) : 1.0;
    sm = Math.min(Math.max(sm, 0.01), 10.0);
    rawEffects.push({ time: tp.time, sv: sm });
  }
  /* Events type 12（若存在）*/
  const evts = (bm && bm.scrollEvents) || [];
  for (const [time, sv] of evts) {
    rawEffects.push({ time, sv: Math.min(Math.max(sv, 0.01), 10.0) });
  }
  /* 稳定排序：同 time 时保持原顺序（红线在前、绿线在后 => 绿线胜出）*/
  const sortedTps = tpsRaw.map((tp, i) => ({ tp, i }))
    .sort((a, b) => (a.tp.time - b.tp.time) || (a.i - b.i))
    .map((x) => x.tp);
  /* 按同样规则重排 rawEffects */
  const effects = dedupeEffectPoints(
    rawEffects
      .map((p, i) => ({ p, i }))
      .sort((a, b) => (a.p.time - b.p.time) || (a.i - b.i))
      .map((x) => x.p)
  );
  timing.sort((a, b) => a.time - b.time);
  void sortedTps;   /* 只用于说明排序规则，实际顺序已在 rawEffects 里体现 */

  /** 二分：最后一个 time <= t 的点；t 早于首点时返回首点（与 Python 一致） */
  function lastAtOrBefore(list, t) {
    if (!list.length) return null;
    if (t < list[0].time) return list[0];
    let lo = 0, hi = list.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (list[mid].time <= t) lo = mid;
      else hi = mid - 1;
    }
    return list[lo];
  }

  /* Python: TimingControlPoint(0, 500) —— 无 timing point 时的缺省。
   * ★注意 timing 序列只含**红线**（已钳制拍长），绿线不参与。*/
  const beatLengthAt = timing.length
    ? (t) => lastAtOrBefore(timing, t).beatLength
    : () => 500;

  /* Python: EffectControlPoint(0) —— scroll_speed 默认 1.0 */
  const svAt = effects.length
    ? (t) => lastAtOrBefore(effects, t).sv
    : () => 1.0;

  return { beatLengthAt, svAt };
}

/**
 * 把插件的 `bm.notes`（已解析的音符数组）转成 dan_rank 的
 * `(time, colour, big)` 三元组。
 *
 * ★ 过滤规则与 Python `loader.py` 完全一致：
 *   · 只保留 **Hit**（Don / Kat / 大音符）
 *   · 转盘（spinner）与 连打（drumroll）是「免打物件」，**不计入难度**
 *
 * 颜色映射：Python 取 `int(o.type)`，0 = Don/中心，1 = Kat/外缘。
 * 插件侧对应 `note.blue === true` -> Kat(1)，否则 Don(0)。
 * ★ 大音符也分颜色：`note.kind === 'big'` 时颜色仍看 `blue`。
 *
 * @param {object} bm  parseOsu 的结果
 * @returns {Array<{time:number, colour:number, big:boolean}>}
 */
export function toDanNotes(bm) {
  const notes = (bm && bm.notes) || [];
  const out = [];
  for (const n of notes) {
    /* 免打物件：连打 / 转盘 */
    if (n.kind === 'roll' || n.kind === 'spinner') continue;
    out.push({
      time: n.time,
      colour: n.blue ? 1 : 0,
      big: n.kind === 'big',
    });
  }
  /* parseOsu 已按 time 升序；再排一次以防转谱路径的顺序差异 */
  out.sort((a, b) => a.time - b.time);
  return out;
}

/**
 * 对已解析的 beatmap 计算段位与键型。**本插件的主入口，
 * 也是对外的字段契约（见对接文档）。**
 *
 * ★ 这里**剥离** `evaluateDan` 的下划线前缀内部字段
 *   （`_scalar` / `_dan` / `_features` / `_keytype`）。
 *   那些是给对拍测试与精度排查用的，不属于契约——
 *   对方留言里列的字段是 `dan / grade / keytype / dense / notes /
 *   duration_ms / nps / mods / speed_mult`（+ 元信息四件套），
 *   多余字段会让「按契约遍历」的对接代码困惑，
 *   而且 `_features` 是整个 Features 对象（含几十个字段），
 *   留着还会让postMessage / JSON 序列化体积暴涨。
 *
 *   需要那些内部量做排查时，直接 import `lib/dan_rank.js` 的
 *   `evaluateDan`（对拍测试就是这么做的）。
 *
 * @param {object} bm   parseOsu 的结果
 * @param {string} mods mod 字符串，如 ''/ 'DT' / 'HDHR'
 * @returns {object} 见对接文档的字段契约
 */
export function evaluateBeatmap(bm, mods) {
  const { beatLengthAt, svAt } = makeControlPointAccessors(bm);
  const res = evaluateDan({
    notes: toDanNotes(bm),
    beatLengthAt,
    svAt,
    od: (bm && typeof bm.od === 'number') ? bm.od : null,
    mods: mods || '',
  });
  /* 只透传契约内的字段（顺序与对接文档一致，便于人读）*/
  return {
    artist: res.artist,
    title: res.title,
    version: res.version,
    creator: res.creator,
    mods: res.mods,
    speed_mult: res.speed_mult,
    dan: res.dan,
    grade: res.grade,
    keytype: res.keytype,
    notes: res.notes,
    duration_ms: res.duration_ms,
    nps: res.nps,
    dense: res.dense,
  };
}

/**
 * 直接吃 .osu 文本（对齐 Python 的 `evaluate_text`）。
 * 用于 CLI / 测试 / 将来做「离线批量评估」。
 *
 * @param {string} osuText .osu 全文
 * @param {object} parseOsu 已注入的解析器（避免循环 import）
 * @param {string} mods    mod 字符串
 */
export function evaluateText(osuText, parseOsu, mods) {
  const bm = parseOsu(osuText);
  return evaluateBeatmap(bm, mods);
}