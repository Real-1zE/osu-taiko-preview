/**
 * dan_rank —— osu!taiko 段位 / 键型算法（Python `dan_rank` 包的逐行 JS 移植）
 *
 * 移植自（C:\Users\Administrator\WorkBuddy\osu2\dan_rank\）：
 *   · features.py  (547 行) → Features
 *   · model.py     (326 行) → MonotoneCurve / durationGain / Model / gradeName
 *   · keytype.py   (383 行) → classify / label / evidence / _Slice
 *   · context.py   (138 行) → MarkovSurprise / intervalSymbol / buildSurpriseModels
 *   · evaluate.py  的 mod_speed + SpeedModBeatmap（仅这两个，见下方 evaluateDan）
 *
 * 不移植：loader.py（读 .osu，JS 侧已有 osu_parser.js）、evaluate.py 的 CLI、
 *         以及任何 explore_* / *_report / calibrate* / make_* 脚本。
 *
 * ------------------------------------------------------------------
 * 精度：端到端 |Δdan| ≤ 5.3e-15（14 张真谱 × 9 组 mod = 126 例，验收线 1e-9）
 * ------------------------------------------------------------------
 * 本文件与 Python 版**逐位一致**：浮点运算的顺序、Math.log / Math.exp /
 * Math.tanh 的调用位置全部照抄，不做任何「优化」（例如不把
 * `a * b + c * d` 重排、不把 /T 提前乘、循环不改成推导式）。
 *
 * 有三处 Python 内建语义必须显式模拟，写错了会差 1~2 ulp：
 *   1. round()    —— half-to-even（JS 的 Math.round 是 half-up）→ 见 pyRound
 *   2. int()      —— 向零截断（不是 floor）→ 见 pyInt
 *   3. sum()      —— **Python 3.12 起用 Neumaier 补偿求和**，不是朴素累加
 *                    → 见 pysum。这一条最隐蔽：features/model/keytype 里
 *                    有十几处 sum()，用 `for (x of a) s += x` 会有 1~2 ulp 偏差
 *                    并顺着前缀和放大。
 *
 * 标定数据全部来自 ./dan_calibration.js，**不在这里硬编码任何数值**。
 * 只有 model.py / features.py / context.py 里那些「算法常量」
 * （magic number、阈值、权重）按原样搬过来，并在注释里注明来源行号。
 *
 * ------------------------------------------------------------------
 * 残余精度 5.3e-15 的来源：V8 与 glibc 的 libm 实现差异（**非移植误差**）
 * ------------------------------------------------------------------
 * 已用 test/dan_libm_isolation.mjs 证明：把 cbits/tbits 钉成 Python 的值之后，
 * 前缀和、包络 z、env.top（含排序与并列顺序）、raw scalar、grade、keytype
 * **全部逐位相同（11/14 张谱零差异）**，只剩两个量在个别谱上差 1 ulp：
 *
 *   dan / evidence.dan  ← Model.dan 的 curve(math.log(scalar))   （model.py:220）
 *   evidence.speedrel   ← keytype.expected_speed 的 math.exp     （keytype.py:112）
 *
 * 实测分歧率：Math.log 2217/35014、Math.log2 444/35014、Math.exp 461/5000。
 * glibc 的 log 并非**正确舍入**（用 Decimal 60 位精度对比，4008 个采样里有 7 个
 * 与正确舍入值不同），所以在 JS 里重写一个「正确舍入的 log/exp」也仍然对不齐 ——
 * 只能整体照抄 glibc 的实现，代价与收益不成比例。
 *
 * 5.3e-15 比验收线 1e-9 宽 6 个数量级，也远小于段位显示精度（0.01）。
 * ══════════════════════════════════════════════════════════════════
 */

/* eslint-disable no-bitwise */
import {
  DAN_PARAMS,
  DAN_ANCHORS,
  KT_THRESHOLDS,
  KT_SPEED_BASELINE,
} from './dan_calibration.js';

// ====================================================================
// 0. Python 内建语义的精确模拟
// ====================================================================

/** 拆解 double：|x| = mant × 2^e，符号单独给出。 */
const _f64buf = new DataView(new ArrayBuffer(8));
function _decompose(x) {
  _f64buf.setFloat64(0, x);
  const hi = _f64buf.getUint32(0);
  const lo = _f64buf.getUint32(4);
  const sign = (hi >>> 31) ? -1n : 1n;
  const biased = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e;
  if (biased === 0) {
    e = -1074;                       // 次正规数：没有隐含的前导 1
  } else {
    mant |= (1n << 52n);
    e = biased - 1075;
  }
  return { sign, mant, e };
}

/**
 * Python `round()` 的精确语义。
 *
 * Python 的 round 有两套规则，移植时必须区分清楚，否则会在「.5 边界」上错：
 *   1. `round(x)`（ndigits 省略）→ half-to-even，**返回 int**。
 *      CPython floatobject.c：
 *          rounded = round(x);                       // C 的 round：half-away
 *          if (fabs(x - rounded) == 0.5)
 *              rounded = 2.0 * round(x / 2.0);       // 恰好 .5 时改成 half-even
 *      所以 round(2.5)=2、round(3.5)=4、round(0.5)=0、round(-2.5)=-2。
 *      ★ 与 JS 的 Math.round（half-up，round(2.5)=3、round(-2.5)=-2）**不同**。
 *   2. `round(x, n)` → 对 x 的精确二进制值做十进制 half-even 舍入到 n 位。
 *
 * 本实现不走 `Math.round(x * 10^n) / 10^n`（那会引入二次舍入，
 * 在 2.675 这类值上与 Python 不一致），而是用 BigInt 算出精确十进制商，
 * 再做 half-even。结果与 CPython 一致。
 */
export function pyRound(x, ndigits = 0) {
  if (!Number.isFinite(x)) return x;
  if (x === 0) return x;             // 0.0 / -0.0 直接返回，保留符号
  const { sign, mant, e } = _decompose(x);
  const n = BigInt(ndigits);
  const p = 10n ** n * mant;
  let num, den;
  if (e >= 0) { num = p << BigInt(e); den = 1n; } else { num = p; den = 1n << BigInt(-e); }
  let q = num / den;
  const r = num - q * den;
  const twice = r * 2n;
  // half-even：余数恰为一半时看 q 的奇偶
  if (twice > den || (twice === den && (q & 1n) === 1n)) q += 1n;
  const res = Number(q) / 10 ** ndigits;
  return sign < 0n ? -res : res;
}

/** Python `int(x)`：向零截断。对负数与 Math.floor 不同，故单列一个。 */
export function pyInt(x) {
  return x < 0 ? -Math.floor(-x) : Math.floor(x);
}

/**
 * Python `math` 模块的 bisect.bisect_left —— 在**升序**数组里找
 * 「第一个 >= x 的下标」（找不到返回 len）。等价于 C++ 的 lower_bound。
 * @param {number[]} arr 升序数组
 */
export function bisectLeft(arr, x) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * Python `sum()` 的精确语义 —— **Python 3.12 起 sum() 用 Neumaier 补偿求和**
 * （gh-100425），不再是简单的从左到右累加。
 *
 * 这不是可有可无的细节：features.py / model.py / keytype.py 里到处是
 * `sum(self.mono)`、`sum(vals[:k])`、`sum(f.sixth)`。用朴素的 `for (x of a) s += x`
 * 会与 Python 差 1~2 ulp（例如把 122 个 0.3/0.65 加起来，朴素得 2.4999999999999993e+1，
 * Python 得 2.5e+1），再经前缀和 / 窗口聚合放大到最终 dan。
 *
 * 算法（CPython bltinmodule.c 的 builtin_sum_impl，浮点分支）：
 *   对每个 x：
 *     t = f + x
 *     若 |f| >= |x|：c += (f - t) + x
 *     否则：      c += (x - t) + f        ← 减数较大的那个用 x
 *     f = t
 *   最后 f += c
 *
 * 另注：CPython 只在**全为 float** 时走这条补偿路径；
 * 一旦混入 int 就退回逐个 PyNumber_Add。我们这里所有调用点都是纯 float 数组
 * （或纯 int 计数），前者走补偿、后者 int 相加精确，都与下面实现一致。
 */
function pysum(arr) {
  const n = arr.length;
  if (n === 0) return 0;
  if (n === 1) return arr[0];
  let f = arr[0];
  let c = 0.0;
  for (let i = 1; i < n; i++) {
    const x = arr[i];
    const t = f + x;
    if (Math.abs(f) >= Math.abs(x)) c += (f - t) + x;
    else c += (x - t) + f;
    f = t;
  }
  return f + c;
}

// context.py:19  LOG2 = math.log(2.0)
const LOG2 = Math.log(2.0);

// ====================================================================
// 1. context.py —— 插值式马尔可夫上下文模型（惊讶度，bit）
// ====================================================================

// context.py:95-100
const _INTERVAL_REF = 100.0;        // ms，对数分桶基准
const _INTERVAL_RES = 6.0;          // 每倍频程 6 个桶 ≈ 12% 分辨率
const _INTERVAL_MAX_BUCKET = 30;    // 桶上限；更长的间隔统一归入 +1 的「长间隙」桶
const _GAP_MS = 400.0;              // 超过此值视为长间隙
const BV = _INTERVAL_MAX_BUCKET + 2;   // = 32，时间桶字母表大小（含长间隙桶）

/** context.py:103 interval_symbol —— 时间间隔 → 对数分桶符号 */
function intervalSymbol(dtMs) {
  if (dtMs === null || dtMs === undefined || dtMs <= 0) return _INTERVAL_MAX_BUCKET + 1;
  if (dtMs > _GAP_MS) return _INTERVAL_MAX_BUCKET + 1;
  // int(round(...))：Python 的 round 是 half-even，不能用 Math.round
  const b = pyRound(_INTERVAL_RES * Math.log(dtMs / _INTERVAL_REF) / LOG2);
  return Math.max(0, Math.min(_INTERVAL_MAX_BUCKET, b));
}

/**
 * context.py:22 MarkovSurprise
 * 对一条整数符号序列建模，输出每个位置的惊讶度（bit）。
 *
 * 原版用 collections.Counter / defaultdict；这里换成 Map，
 * 缺失键一律当 0 —— 与 defaultdict 的「读取不抛异常」语义一致。
 */
class MarkovSurprise {
  /**
   * @param {number[]} symbols
   * @param {number} order 上下文阶数
   * @param {number} gamma 计数平滑（先验强度）
   * @param {number|null} n_symbol_hint 字母表大小下界（V）
   */
  constructor(symbols, order = 4, gamma = 0.6, nSymbolHint = null) {
    this.seq = symbols.slice();
    this.order = order;
    this.gamma = gamma;
    const uniq = Array.from(new Set(this.seq)).sort((a, b) => a - b);
    this.alphabet = uniq;
    this.V = Math.max(uniq.length, nSymbolHint || 1);
    this._build();
  }

  // ------------------------------------------------------------ 计数
  _build() {
    const n = this.seq.length;
    this.n = n;
    // counts[k][ctx] = Map(sym -> 次数)；totals[k][ctx] = 观测数
    this.counts = [];
    this.totals = [];
    for (let k = 0; k <= this.order; k++) {
      this.counts.push(new Map());
      this.totals.push(new Map());
    }
    for (let i = 0; i < n; i++) {
      const s = this.seq[i];
      for (let k = 0; k <= this.order; k++) {
        if (i >= k) {
          const key = this.seq.slice(i - k, i).join(',');
          let inner = this.counts[k].get(key);
          if (inner === undefined) { inner = new Map(); this.counts[k].set(key, inner); }
          inner.set(s, (inner.get(s) || 0) + 1);
          this.totals[k].set(key, (this.totals[k].get(key) || 0) + 1);
        }
        // 前导位置（i < k）不计入计数 —— Python 里是 continue
      }
    }
    // 全局（k=0 的空上下文）
    const gc = new Map();
    for (const s of this.seq) gc.set(s, (gc.get(s) || 0) + 1);
    this.global_counts = gc;
    this.global_total = n;
  }

  // ------------------------------------------------------------ 概率
  /**
   * 层级回退后的概率
   * @param {number[]} ctx 上下文（从旧到新）
   * @param {number} sym 目标符号
   * @param {number} k 当前阶
   * @param {boolean} excludeSelf 是否留一
   */
  _pHier(ctx, sym, k, excludeSelf) {
    if (k === 0) {
      const cnt = (this.global_counts.get(sym) || 0) - (excludeSelf ? 1 : 0);
      const tot = this.global_total - (excludeSelf ? 1 : 0);
      return (cnt + this.gamma) / (tot + this.gamma * this.V);
    }

    if (k > ctx.length) return this._pHier(ctx, sym, ctx.length, excludeSelf);

    const key = ctx.slice(ctx.length - k).join(',');
    const inner = this.counts[k].get(key);
    const cnt = (inner ? (inner.get(sym) || 0) : 0) - (excludeSelf ? 1 : 0);
    const tot = (this.totals[k].get(key) || 0) - (excludeSelf ? 1 : 0);
    if (tot <= 0) return this._pHier(ctx, sym, k - 1, excludeSelf);
    const w = tot / (tot + this.gamma * this.V);
    const pEmp = (cnt + this.gamma) / (tot + this.gamma * this.V);
    const pUp = this._pHier(ctx, sym, k - 1, excludeSelf);
    return w * pEmp + (1.0 - w) * pUp;
  }

  /** 返回每个位置的惊讶度列表（bit），长度 == seq.length */
  surprise(capBits = 6.0, excludeSelf = true) {
    const out = [];
    const seq = this.seq;
    for (let i = 0; i < seq.length; i++) {
      const ctx = seq.slice(Math.max(0, i - this.order), i);
      let p = this._pHier(ctx, seq[i], this.order, excludeSelf);
      p = Math.min(Math.max(p, 1e-9), 1.0);
      const b = -Math.log(p) / LOG2;
      out.push(Math.min(b, capBits));
    }
    return out;
  }
}

/**
 * context.py:113 build_surprise_models
 * 对一张谱面分别建模「颜色序列」与「节奏序列」。
 * 返回 [colourBits, timeBits]：每音符的惊讶度（bit），索引与 notes 对齐；
 * 第 0 个音符无前驱，取第一个元素的值（通常忽略）。
 */
function buildSurpriseModels(notes, orderColour = 4, orderTime = 3,
                             gamma = 0.6, capColour = 1.4, capTime = 3.2) {
  const colours = notes.map((n) => n.colour);
  const times = notes.map((n) => n.time);
  const dtSyms = times.map((t, i) => (i > 0 ? intervalSymbol(t - times[i - 1]) : 0));

  const mc = new MarkovSurprise(colours, orderColour, gamma, 2);
  const mt = new MarkovSurprise(dtSyms, orderTime, gamma, BV);

  const cb = mc.surprise(capColour);
  const tb = mt.surprise(capTime);
  if (cb.length) cb[0] = cb.length > 1 ? cb[1] : 0.0;
  if (tb.length) tb[0] = 0.0;
  return [cb, tb];
}

// ====================================================================
// 2. features.py —— 特征提取
// ====================================================================

/*
 * 上下文（features.py 顶部的模块 docstring 搬过来）：
 *
 *   核心观念：谱面的难度不是「总量」，而是**它在各个持续时间上要求的最高速率**。
 *   对窗口长度 T，取全谱最高的「维持 T 秒所需输出」Z(T)，得到一条
 *   单调递减的「速率—时长曲线」。这条曲线同时刻画：
 *       T 小 → 爆发力 / 反应
 *       T 大 → 体力 / 持续
 *
 *   抗撑星：只取各 T 的**最大值**，与「有多少个这样的窗口」无关，
 *           长图无法通过堆窗口把结果累加上去（现行算法的 Σ 0.9^k 正是膨胀源）。
 *   抗压星：短图的一次爆发在小的 T 上完整保留，不会被长时间窗平均掉。
 *
 *   速率之外还叠了三条结构负载流（每音符一条，与密度同量纲）：
 *     ym 换手负载：同色长串的**换手困难度**。
 *         完全同色的排列读起来容易，但手不能换，越长越容易连 miss。
 *         3~4 个短同色（ooxxooxx / ooooxxxo）是舒适的；
 *         oooooooox 这种长同色反而更难 —— 它与「可预测性」方向相反，
 *         所以不能靠颜色惊讶度表达（惊讶度在这里接近 0），必须单独建流。
 *     y6 复合负载：1/6 栅格的结构权重。
 *         只对「成串的」1/6 给满分；孤立的一个 1/6 四连（大串夹小）只给 0.3，
 *         避免拿一个收尾四连就把整张图抬上去。
 *         连续的 1/6 还要看排色：反复出现 ooxxooxx 型的按 0.7 系数降权。
 *     flow 流速：SV × BPM。只用于段位空间的一个小量修正，且正向封顶 ——
 *         段位考察的是手上的能力，不应该被超高流速无限放大；
 *         但流速确实会吃掉读谱时间，完全剔除也不对（见 model.FLOW_*）。
 */

// features.py:39-43
// 上限取 256s 而非 128s：段位马松的单个段落约 2 分钟，而
// 一般谱面动辄 4~6 分钟且全程维持 —— 只到 128s 的话，
// 「256BPM 大串撑满五分钟」这种纯体力图和「两分钟里有同样密度」的段落
// 会拿到完全一样的读数，体力维度等于没建模。
const WINDOWS = [0.25, 0.5, 1.0, 2.0, 4.0, 8.0, 16.0, 32.0, 64.0, 128.0, 256.0];
// 每个 T 保留多少个最优窗口（用于稳健分位数，避免单点噪声）
const KEEP_TOP = 400;

// features.py:46-58
const SIXTH = 1 / 6.0;
// 实测：真实谱面的同色连打长度中位数只有 1~2，≥5 的不足 1%。
// 所以「长同色」的门槛不能按字面取 8 —— 那样这项恒为 0，等于没建模。
// 取 3 起算：ooxxooxx（2 连）与 ooooxxxo（3~4 连）是舒适区，
// 5 连以上开始出现「手粘住」，10 连打满。
const MONO_FREE = 3;           // 同色连打 ≤3 个不算换手负担
const MONO_FULL = 10;          // 同色连打 ≥10 个换手负担打满
const SIXTH_ISO_GAPS = 3;      // 1/6 连续空隙 ≤3（即 ≤4 个音符）视为孤立四连
const SIXTH_RUN_GAPS = 6;      // 1/6 连续空隙 ≥6 视为成串
// 2026-10 第四轮：0.30→0.45（用户「复合别削到一无是处」）
const SIXTH_ISO_W = 0.45;   // 孤立 1/6 四连的权重
const SIXTH_OOXX_DISC = 0.70;  // 成串 1/6 中 ooxxooxx 型排色的降权幅度
const MONO_STREAM_DISC = 0.75; // 大串内部的同色连打不算卡手
const MONO_SIXTH_AMP = 0.60;   // 1/6 段内的同手连击额外加权
// features.py:69-73 孤立超短爆音(撑星)的密度折扣
// 2026-10 第四轮：0.60→0.80（同上，短爆音密度折扣过重）
const BURST_DISC = 0.80;   // 与 features.py 一致
const BURST_MAX_GAPS = 4;      // 连续 ≤1/6 拍短串(≤4 个空隙)视为撑星爆音
const BURST_EXT_GAPS = 6;      // 5-6 空隙(6-7音)爆发：仅单色段打折（features.py:71）
const BURST_GATE_FRAC = 0.35;  // sixth_frac 低于此值才启用爆音折扣（features.py:72，二次放宽）
// features.py:84 串内换色负载：长串门槛（≥8 音才算持续大串）
const STREAM_LONG_MIN = 8;

/** features.py:83 _percentile —— 分位（q 分位，取最近的下标） */
function _percentile(sortedVals, q) {
  if (!sortedVals.length) return 0.0;
  // Python: int(q * (len-1) + 0.5) —— 注意这里是 int() 截断，不是 round()
  const i = pyInt(q * (sortedVals.length - 1) + 0.5);
  return sortedVals[Math.max(0, Math.min(sortedVals.length - 1, i))];
}

/** features.py:61 Envelope —— 一条 Z(T) 曲线 */
class Envelope {
  constructor(windows) {
    this.windows = windows;
    this.z = new Map();
    this.nps = new Map();
    this.colourBits = new Map();
    this.timeBits = new Map();
    this.arg = new Map();
    this.top = new Map();     // T -> 降序的前 K 个窗口值
    this.count = new Map();   // T -> 窗口总数
    this.pcomp = new Map();   // T -> [p05, p15, p45, mean] 全窗口 Z 值难度分位（马拉松加权复合标量用）
  }

  value(T) {
    const v = this.z.get(T);
    return v === undefined ? 0.0 : v;
  }
}

/** 升序比较器（用于对齐 Python 的稳定排序；相等时返回 0） */
function cmpAsc(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }

/** 降序比较器：Python `sort(reverse=True)` / `sort(key=lambda v: -v[k])` */
function cmpDesc(a, b) { return a < b ? 1 : (a > b ? -1 : 0); }

/** features.py:555 _ooxxness —— 一段颜色序列里「ooxxooxx 型」所占的比例。
 *
 * 判据：按 4 个一组切块，块内形如 aabb / bbaa（两同步两同色交替）即计 1。
 * ooxx、xxoo 命中；ooox、oxxo、xoox 不命中。 */
function _ooxxness(seq) {
  if (seq.length < 4) return 0.0;
  let hit = 0;
  let tot = 0;
  for (let i = 0; i + 3 < seq.length; i += 4) {
    const a = seq[i]; const b = seq[i + 1]; const c = seq[i + 2]; const d = seq[i + 3];
    tot += 1;
    if (a === b && c === d && a !== c) hit += 1;
  }
  return tot ? hit / tot : 0.0;
}

/** features.py:807 _stream_repetition —— 长串颜色序列的「周期可预测性」∈[0,1]。
 *
 * 扫描周期 p∈[2, min(L//2, 8)]，取「位置 i 与 i-p 同色」的最高占比。
 * 1.0 = 完全周期循环（如 xooxooxoo，p=3）；越低越不可预测（I'm For You 类）。
 * 机械循环串（高换色但只是重复）应被识别并打折，真·非重复高换色串几乎不受影响。 */
/** features.py:_stream_repetition —— 长串颜色序列的「机械循环占比」∈[0,1]（第五轮重写）。
 *
 * 旧口径致命缺陷：二色序列下「位置 i 与 i-p 同色」的随机基线就是 0.5，取 max over p
 * 后靠噪声就能冲到 0.6~0.7 —— 量的不是「重复」而是「略高于随机的相关性」。
 * 实测 Apocalypse 一条 266 音、肉眼无循环的串被判 0.578，却据此打 20% 折扣。
 *
 * 新口径：单元 p∈[2,4]（最长 4 音）；逐位置判 seq[i]===seq[i-p]，必须**连续**匹配到
 * 「第 3 个周期开始」(run ≥ p+1) 才计；失配则 run 归零重新累计（破坏重复则重算）。
 */
function _streamRepetition(seq) {
  const L = seq.length;
  if (L < 6) return 0.0;
  let best = 0.0;
  for (let p = REP_UNIT_MIN; p <= REP_UNIT_MAX; p++) {
    if (L <= p) continue;
    let run = 0;   // 连续满足「与 p 个音之前同色」的位置数
    let disc = 0;
    for (let i = p; i < L; i++) {
      if (seq[i] === seq[i - p]) run += 1;
      else run = 0;                 // 破坏重复 → 重新计算
      if (run >= p + 1) disc += 1;  // 进入第 3 次重复才开始计折扣
    }
    const v = disc / (L - p);
    if (v > best) best = v;
  }
  return best;
}

/** sections.py:23 split_sections —— 按大间隙把音符序列切成段，返回 [[a,b), ...]。
 * 与 Python 实现逐位一致：间隙 ≥ minGap 为切分点；短碎片(<MIN_SECTION_LEN)并入上一段。 */
function splitSections(notes, minGap = MIN_SECTION_MS) {
  const n = notes.length;
  if (n === 0) return [];
  const cuts = [0];
  for (let i = 1; i < n; i++) {
    if (notes[i].time - notes[i - 1].time >= minGap) cuts.push(i);
  }
  cuts.push(n);
  const out = [];
  for (let k = 0; k < cuts.length - 1; k++) {
    const a = cuts[k];
    const b = cuts[k + 1];
    if (b - a >= MIN_SECTION_LEN) out.push([a, b]);
    else if (out.length) out[out.length - 1] = [out[out.length - 1][0], b];
  }
  return out;
}

/** features.py:547 cb_i —— 带越界保护的取值 */
function cbI(arr, i) { return i < arr.length ? arr[i] : 0.0; }
/** features.py:551 tb_i */
function tbI(arr, i) { return i < arr.length ? arr[i] : 0.0; }

/**
 * features.py:90 Features —— 一张谱面的全部中间量。
 *
 * 字段名与 Python 版一一对应（snake_case），keytype.py 直接读这些字段，
 * 所以**不要改名**。
 *
 * @param {{time:number, colour:number, big:boolean}[]} notes
 * @param {object} meta {beat_unit, sv_unit, fallback_bpm, big_cost,
 *                       lambda_colour, lambda_time, lambda_mono, lambda_sixth}
 */
export class Features {
  constructor(notes, meta = null) {
    this.meta = meta || {};
    this.notes = notes;
    this.n = notes.length;
    this._computeBasic();
    this._computeFlow();
    this._computeStructure();
    this._computeSurprise();
    this._computeEnvelope();
    this._computeKeytypeStats();
  }

  // ------------------------------------------------------------ 基础
  _computeBasic() {
    const notes = this.notes;
    const n = this.n;
    if (n < 2) {
      this.times = notes.map((x) => x.time);
      this.dts = [];
      this.duration = 0.0;
      this.npsGlobal = 0.0;
      this.bigFraction = 0.0;
      this.switchFraction = 0.0;
      this.nSections = 1;
      this.noteConc = 1.0;
      this.timeConc = 1.0;
      this.conc = 1.0;
      return;
    }
    const times = notes.map((x) => x.time);
    this.times = times;
    const dts = [];
    for (let i = 1; i < n; i++) dts.push(times[i] - times[i - 1]);
    this.dts = dts;
    const span = Math.max(times[n - 1] - times[0], 1e-6);
    this.duration = span;
    this.npsGlobal = (n - 1) / (span / 1000.0);

    let bigCount = 0;
    for (const x of notes) if (x.big) bigCount += 1;
    this.bigFraction = bigCount / n;
    let sw = 0;
    for (let i = 1; i < n; i++) if (notes[i].colour !== notes[i - 1].colour) sw += 1;
    this.switchFraction = sw / (n - 1);
    // 段落数（大间隙切分）+ 集中度，用于第二维「持续强度」门控
    // （features.py:_compute_basic）。
    //
    // 原来只看段数 nsec（nsec>=3 → 归零），把一类谱面错杀了：长曲只要被开头/中间的
    // 短碎片切出 3 段就完全拿不到 speed_bonus2，哪怕它 95% 的时间是连续的
    // （实测 Sanzu [EXTRA STAGE]：408s 里休息仅 24s，主体是 219s + 136s 两大段，
    // 却因 nsec=4 被判成「多段马松」而丢掉 1.28 段，9.51 星只拿到 Beta）。
    //
    // 改用集中度（用户指引：以物件数为主、时间为辅）——两个维度都取
    // 「最大段占全曲的比例」，物件数权重 0.7、时间权重 0.3：
    //   马松 4 段各 ~25%（各考一种键型）  conc ≈ 0.27~0.38 → 归零
    //   主体连续的长曲                    conc ≈ 0.6+      → 满额
    //   单键型持续图（整段连续）          conc = 1.0       → 满额
    const gapThr = CONC_GAP_MS;
    let ns = 1;
    const bnds = [0];
    for (let i = 1; i < n; i++) {
      if (times[i] - times[i - 1] >= gapThr) {
        ns += 1;
        bnds.push(i);
      }
    }
    bnds.push(n);
    this.nSections = ns;
    let bn = 0.0;
    let bt = 0.0;
    for (let k = 0; k + 1 < bnds.length; k++) {
      const a = bnds[k];
      const b = bnds[k + 1];
      if (b - a > bn) bn = b - a;
      const sd = b > a ? (times[b - 1] - times[a]) / 1000.0 : 0.0;
      if (sd > bt) bt = sd;
    }
    this.noteConc = n ? bn / n : 1.0;
    this.timeConc = span > 0 ? bt / (span / 1000.0) : 1.0;
    this.conc = CONC_W_NOTE * this.noteConc + CONC_W_TIME * this.timeConc;
    return;
  }

  // ------------------------------------------------------------ 流速
  /**
   * features.py:130 _compute_flow
   * flow = SV × BPM（等效 BPM）。
   *
   * 屏幕上音符的推进速度正比于 SV×BPM，它决定「读谱时间」：
   * flow 翻倍 ⇒ 同样的音符提前量只有一半。
   * 150BPM/SV1 与 75BPM/SV2 读起来是一样的，所以必须用乘积而不是单看 BPM。
   */
  _computeFlow() {
    const n = this.n;
    const unit = this.meta.beat_unit;
    const svu = this.meta.sv_unit;
    this.flow = new Array(n).fill(0.0);
    this.bpmOf = new Array(n).fill(0.0);
    this.flowMedian = 0.0;
    this.flowP90 = 0.0;
    this.bpmRange = [0.0, 0.0];
    this.bpmMain = 0.0;
    this.bpmMedian = 0.0;
    this.bpmP90 = 0.0;
    if (n === 0) return;
    const flows = [];
    const bpms = [];
    for (let i = 0; i < n; i++) {
      const nt = this.notes[i];
      let bpm = 0.0;
      if (unit) {
        try {
          const bl = unit(nt.time);
          if (bl && bl > 0) bpm = 60000.0 / bl;
        } catch (e) { bpm = 0.0; }
      }
      let sv = 1.0;
      if (svu) {
        try {
          const v = svu(nt.time);
          if (v && v > 0) sv = v;
        } catch (e) { sv = 1.0; }
      }
      if (!bpm) bpm = this.meta.fallback_bpm !== undefined ? this.meta.fallback_bpm : 120.0;
      this.bpmOf[i] = bpm;
      const f = sv * bpm;
      this.flow[i] = f;
      flows.push(f);
      bpms.push(bpm);
    }
    if (flows.length) {
      const fs = flows.slice().sort(cmpAsc);
      this.flowMedian = _percentile(fs, 0.50);
      this.flowP90 = _percentile(fs, 0.90);
    }
    if (bpms.length) {
      const bs = bpms.slice().sort(cmpAsc);
      // 「主要 BPM」：按音符数取 5%~95% 分位，甩掉少数几拍的变速/尾奏
      const lo = _percentile(bs, 0.05);
      const hi = _percentile(bs, 0.95);
      this.bpmRange = [lo, hi];
      this.bpmMain = _percentile(bs, 0.50);
      // 纯 BPM 流速（SV=1）：难度一律按 BPM 计，不受变速(SV)摆幅影响
      // （flow_bonus / raw_scalar 速度折标量都用它）。对齐 features.py:_compute_flow。
      this.bpmMedian = _percentile(bs, 0.50);
      this.bpmP90 = _percentile(bs, 0.90);
    }
    // 有效 BPM（用户口径，2026-10 修正）：取「主难度段落」（最密连打段）的音符间隔 dt_dense，
    // 按「4 音 = 1 拍」分组：eff_bpm = 15000 / dt_dense（= 60000 / (4·dt_dense)）。
    // 取 dt 分布低分位(p10) 作为主难度段落的典型间隔——落在最密墙段，
    // 不会被休止/过渡段拉高的全局中位稀释。与基 BPM / SV 无关（只依赖音符时刻）。
    this.effBpmMedian = this.bpmMain;   // 兜底：无 dts 时与 bpm 中位一致
    this.effBpmP90 = this.bpmMain;
    const dts = this.dts;
    if (dts && dts.length) {
      const ds = dts.filter((d) => d >= 8.0 && d <= 4000.0).slice().sort(cmpAsc);
      if (ds.length) {
        let dtDense = _percentile(ds, 0.10);
        if (dtDense <= 0) dtDense = _percentile(ds, 0.50);
        this.effBpmMedian = 15000.0 / dtDense;
        this.effBpmP90 = 15000.0 / Math.max(_percentile(ds, 0.90), 1e-6);
      }
    }
    return;
  }

  // ------------------------------------------------------------ 结构负载
  /** features.py:186 _compute_structure —— 换手负载 ym 与 1/6 复合负载 y6（每音符一条） */
  _computeStructure() {
    const n = this.n;
    this.mono = new Array(n).fill(0.0);
    this.sixth = new Array(n).fill(0.0);
    this.densityW = new Array(n).fill(1.0);   // 每音符的密度权重（撑星爆音打折）
    if (n < 2) {
      this.monoLoad = 0.0;
      this.sixthFrac = 0.0;
      this.sixthSustainedFrac = 0.0;
      this.sixthIsoFrac = 0.0;
      this.sixthOoxxness = 0.0;
      this.runLenOf = new Array(n).fill(1);
      return;
    }

    // ---- 同色连打 ----
    const runLen = new Array(n).fill(1);
    let cur = 1;
    for (let i = 1; i < n; i++) {
      if (this.notes[i].colour === this.notes[i - 1].colour) {
        cur += 1;
      } else {
        for (let k = i - cur; k < i; k++) runLen[k] = cur;
        cur = 1;
      }
    }
    for (let k = n - cur; k < n; k++) runLen[k] = cur;
    this.runLenOf = runLen;
    for (let i = 0; i < n; i++) {
      const L = runLen[i];
      if (L > MONO_FREE) this.mono[i] = Math.min(1.0, (L - MONO_FREE) / (MONO_FULL - MONO_FREE));
    }
    this.monoLoad = pysum(this.mono) / n;

    // ---- 等间隔长串掩码（用于把「大串里的同色连打」剔出去）----
    this.inStream = new Array(n).fill(0.0);
    if (this.dts.length) {
      const tol = 0.15;
      let run = 2;
      for (let i = 2; i < this.dts.length; i++) {
        if (Math.abs(this.dts[i] - this.dts[i - 1]) <= tol * this.dts[i - 1]) {
          run += 1;
        } else {
          if (run >= 16) {
            for (let k = i - run; k <= i; k++) {
              if (k >= 0 && k < n) this.inStream[k] = 1.0;
            }
          }
          run = 2;
        }
      }
      if (run >= 16) {
        for (let k = this.dts.length - run; k <= this.dts.length; k++) {
          if (k >= 0 && k < n) this.inStream[k] = 1.0;
        }
      }
    }

    // ---- 串延续长度（按串长给串内换色负载加权用）----
    // 短 2-3 音串不撑持续强度，长持续大串的换色才吃力（读谱要反复重建节奏）。
    this.streamRunLen = new Array(n).fill(0);
    let sri = 0;
    while (sri < n) {
      if (this.inStream[sri]) {
        let srj = sri;
        while (srj < n && this.inStream[srj]) srj += 1;
        const L = srj - sri;
        for (let k = sri; k < srj; k++) this.streamRunLen[k] = L;
        sri = srj;
      } else {
        sri += 1;
      }
    }
    // ---- 串内换色负载（只统计等间隔大串内部的换色事件，供聚合 stream_load 用）----
    this.ssw = new Array(n).fill(0.0);
    for (let i = 1; i < n; i++) {
      if (this.inStream[i] && this.notes[i].colour !== this.notes[i - 1].colour) {
        this.ssw[i] = 1.0;
      }
    }
    // ---- 串内等效 BPM 与重复度（2026-10 用户本轮）----
    // 重复度 = 长串颜色序列的「周期可预测性」：扫描周期 2~8，取最高自匹配率。
    // 高换色 + 高重复（如 PEPPY FIX TAIKO 的 xooxooxoo 循环）只是机械循环，
    // 不应按「高换色真复合」膨胀；高换色 + 低重复（I'm For You）才是真难。
    // 重复度只度量「长串」(≥8 音)，且只打折 ssw / density_w，不碰真实的密度与换色信息。
    this.streamRep = new Array(n).fill(0.0);
    this.streamBpm = 0.0;
    if (this.inStream && this.dts.length) {
      const sdts = [];
      for (let k = 1; k < n; k++) {
        if (this.inStream[k] && this.inStream[k - 1]) sdts.push(this.dts[k - 1]);
      }
      if (sdts.length) {
        sdts.sort(cmpAsc);
        this.streamBpm = 15000.0 / Math.max(_percentile(sdts, 0.50), 1e-6);
      }
      let i = 1;
      while (i < n) {
        if (!this.inStream[i]) { i += 1; continue; }
        let j = i;
        while (j < n && this.inStream[j]) j += 1;
        const L = j - i;
        if (L >= 8) {
          const seq = [];
          for (let k = i; k < j; k++) seq.push(this.notes[k].colour);
          const rep = _streamRepetition(seq);
          for (let k = i; k < j; k++) this.streamRep[k] = rep;
        }
        i = j;
      }
      // 串内重复度折扣（先打 ssw；density_w 在 _modulateMono 末尾统一打）：
      // 机械循环串的换色负载应打折，避免被当成「高换色真复合」。
      for (let k = 0; k < n; k++) {
        const r = this.streamRep[k];
        if (r > 0) this.ssw[k] *= (1.0 - REP_DISC * r);
      }
    }
    this._computeStreamLoad();

    // ---- 1/6 栅格 ----
    const unit = this.meta.beat_unit;
    this.sixthFrac = 0.0;
    this.sixthSustainedFrac = 0.0;
    this.sixthIsoFrac = 0.0;
    this.sixthOoxxness = 0.0;
    if (!unit) { this._modulateMono(); return; }
    const tol = SIXTH * 0.18 + 0.004;
    const is6 = new Array(this.dts.length).fill(false);
    for (let i = 0; i < this.dts.length; i++) {
      const t = this.times[i + 1];
      let bl;
      try { bl = unit(t); } catch (e) { continue; }
      if (!bl || bl <= 0) continue;
      is6[i] = Math.abs(this.dts[i] / bl - SIXTH) <= tol;
    }
    // 连续 1/6 空隙分组
    let n6 = 0;
    for (const x of is6) if (x) n6 += 1;
    if (n6 === 0) { this._modulateMono(); return; }
    this.sixthFrac = n6 / this.dts.length;
    // ---- 孤立撑星爆音：连续 ≤1/6 拍的短串打折（features.py:321-354）----
    // 复用 is6：成串 1/6（run 长）是复合谱面的真实持续难度，不动；
    // 只打折扣「短串」(≤BURST_MAX_GAPS 个 1/6 空隙) —— 典型即 (xxx) 三连 1/6。
    // 门控（二次放宽）：1/6 不是主体栅格（sixth_frac<0.35）时才打折。
    // 扩展 6-7 音单色爆发（Doki-Doki 的 oooooo[x] 型）：仅当近乎单色时打折，
    // 混色爆发（I'm For You 的 xxoxxoo 型）是真实复合排色，不动。
    const sixthFracLocal = this.dts.length ? n6 / this.dts.length : 0.0;
    if (sixthFracLocal < BURST_GATE_FRAC) {
      const bma = is6.length;
      let bi = 0;
      while (bi < bma) {
        if (!is6[bi]) { bi += 1; continue; }
        let bj = bi;
        while (bj < bma && is6[bj]) bj += 1;
        const Lg = bj - bi;
        if (Lg <= BURST_MAX_GAPS) {
          for (let k = bi + 1; k < Math.min(bj + 2, n); k++) this.densityW[k] *= BURST_DISC;
        } else if (Lg <= BURST_EXT_GAPS) {
          const cnt = {};
          for (let k = bi; k < Math.min(bj + 1, n); k++) {
            const c = this.notes[k].colour;
            cnt[c] = (cnt[c] || 0) + 1;
          }
          if (Math.max(...Object.values(cnt)) >= (bj + 1 - bi) - 1) {
            for (let k = bi + 1; k < Math.min(bj + 2, n); k++) this.densityW[k] *= BURST_DISC;
          }
        }
        bi = bj;
      }
    }
    let i = 0;
    let totOoxx = 0;
    let totNotes = 0;
    let susNotes = 0;
    let isoNotes = 0;
    const m = is6.length;
    while (i < m) {
      if (!is6[i]) { i += 1; continue; }
      let j = i;
      while (j < m && is6[j]) j += 1;
      const Lg = j - i;               // 空隙数；音符数 = Lg + 1
      const a = i;
      const b = j + 1;                // 涉及音符 [a, b)
      const seq = [];
      for (let k = a; k < b; k++) seq.push(this.notes[k].colour);
      let w;
      if (Lg <= SIXTH_ISO_GAPS) {
        w = SIXTH_ISO_W;
        isoNotes += (b - a);
      } else {
        const ooxx = _ooxxness(seq);
        w = 1.0 - SIXTH_OOXX_DISC * ooxx;
        totOoxx += ooxx * (b - a);
        susNotes += (b - a);
      }
      for (let k = a; k < b; k++) this.sixth[k] = Math.max(this.sixth[k], w);
      totNotes += (b - a);
      i = j;
    }
    if (totNotes) {
      this.sixthSustainedFrac = susNotes / n;
      this.sixthIsoFrac = isoNotes / n;
      this.sixthOoxxness = totOoxx / Math.max(susNotes, 1);
    }
    this._modulateMono();
    return;
  }

  /** features.py:299 _modulate_mono —— 换手负载按上下文调制。
   *
   * 同手连击会不会卡手，取决于它出现在哪里：
   *   * 在等间隔大串里 —— 不卡。串是「滚」过去的，同色连打正是好打的地方。
   *     实测也印证：撑星图大量使用「1/4 大串 + 同色连打」，
   *     若不给折扣，反而会把这类图抬上去。
   *   * 在 1/6 段里 —— 很卡。1/6 卡手的本质就是同手连击
   *     （oo(oox) 卡右手、oo(xxo) 卡左手），这里要加权。 */
  _modulateMono() {
    const n = this.n;
    for (let i = 0; i < n; i++) {
      if (this.mono[i] <= 0) continue;
      let f = 1.0;
      if (this.inStream[i]) f *= (1.0 - MONO_STREAM_DISC);
      if (this.sixth[i] > 0) f *= (1.0 + MONO_SIXTH_AMP * Math.min(1.0, this.sixth[i]));
      this.mono[i] *= f;
    }
    this.monoLoad = pysum(this.mono) / n;
    // ---- 串重复度对密度的折扣（覆盖所有 return 路径的最后一步）----
    // 机械循环串（xoo 重复）用「少一键的 xxooxxoo」撑高密度，应打折，
    // 否则 PEPPY FIX TAIKO / L full ver 这类图被高估到 >Delta+。
    const rep = this.streamRep;
    if (rep) {
      for (let i = 0; i < this.n; i++) {
        const r = rep[i];
        if (r > 0) this.densityW[i] *= (1.0 - REP_DISC * r);
      }
    }
    return;
  }

  // ------------------------------------------------------------ 串读谱负载
  /** features.py:415 _compute_stream_load —— 聚合串负载 = 长串覆盖率 × 串内换色频率(次/秒)。
   *
   * 长串覆盖率：串长 ≥ STREAM_LONG_MIN 的音符占比（短串不算持续强度）。
   * 换色频率：串内换色事件 ÷ 串内时长（随 BPM 自然缩放）。 */
  _computeStreamLoad() {
    const n = this.n;
    // 聚合字段一律先初始化：下面有三条提前 return 路径（音符数不足 / 无长串 /
    // 串内时长为 0），若不预设，这些字段会缺失（Python 侧同样处理，见
    // features.py:_compute_stream_load）。
    this.streamLoad = 0.0;
    this.streamRatio = 0.0;
    this.meanStreamLen = 0.0;
    this.streamSwPerSec = 0.0;
    this.meanStreamRepetition = 0.0;
    if (n < 2) return;
    let longNotes = 0;
    for (let i = 0; i < n; i++) if (this.streamRunLen[i] >= STREAM_LONG_MIN) longNotes += 1;
    const longFrac = longNotes / n;
    if (longFrac <= 0.0) return;
    let swEvents = 0;
    for (let i = 0; i < n; i++) swEvents += this.ssw[i];
    let dur = 0.0;
    for (let i = 1; i < n; i++) {
      if (this.inStream[i]) dur += this.dts[i - 1] / 1000.0;
    }
    if (dur <= 0.0) return;
    this.streamLoad = longFrac * (swEvents / dur);
    // ---- 串强度重写的聚合特征（2026-10 用户本轮，对齐 features.py:536-541）----
    this.streamRatio = longFrac;                    // 主因素2：整曲串占比
    const lens = [];
    for (let i = 0; i < n; i++) if (this.streamRunLen[i] >= STREAM_LONG_MIN) lens.push(this.streamRunLen[i]);
    this.meanStreamLen = lens.length ? pysum(lens) / lens.length : 0.0;  // 主因素1：单条串长
    this.streamSwPerSec = swEvents / dur;           // 次因素：串内换色频率
    const reps = [];
    for (let i = 0; i < n; i++) if (this.streamRep[i] > 0) reps.push(this.streamRep[i]);
    this.meanStreamRepetition = reps.length ? pysum(reps) / reps.length : 0.0;
    return;
  }

  // ------------------------------------------------------------ 惊讶度
  _computeSurprise() {
    if (this.n < 2) {
      this.cbits = new Array(this.n).fill(0.0);
      this.tbits = new Array(this.n).fill(0.0);
      this.meanColourBits = 0.0;
      this.meanTimeBits = 0.0;
      return;
    }
    const [cb, tb] = buildSurpriseModels(this.notes);
    this.cbits = cb;
    this.tbits = tb;
    this.meanColourBits = pysum(cb.slice(1)) / Math.max(this.n - 1, 1);
    this.meanTimeBits = pysum(tb.slice(1)) / Math.max(this.n - 1, 1);
    return;
  }

  // ------------------------------------------------------------ 包络
  _computeEnvelope() {
    const lamC = this.meta.lambda_colour !== undefined ? this.meta.lambda_colour : 0.0;
    const lamT = this.meta.lambda_time !== undefined ? this.meta.lambda_time : 0.0;
    const lamM = this.meta.lambda_mono !== undefined ? this.meta.lambda_mono : 0.0;
    const lam6 = this.meta.lambda_sixth !== undefined ? this.meta.lambda_sixth : 0.0;
    const bc = this.meta.big_cost !== undefined ? this.meta.big_cost : 0.0;
    const env = new Envelope(WINDOWS);
    const n = this.n;
    if (n < 2) { this.envelope = env; this.ps = null; return; }
    // 前缀和
    const pe = new Array(n + 1).fill(0.0);
    const pc = new Array(n + 1).fill(0.0);
    const pt = new Array(n + 1).fill(0.0);
    const pm = new Array(n + 1).fill(0.0);
    const p6 = new Array(n + 1).fill(0.0);
    for (let i = 0; i < n; i++) {
      const note = this.notes[i];
      pe[i + 1] = pe[i] + this.densityW[i] * (1.0 + bc * (note.big ? 1 : 0));
      pc[i + 1] = pc[i] + cbI(this.cbits, i);
      pt[i + 1] = pt[i] + tbI(this.tbits, i);
      pm[i + 1] = pm[i] + this.mono[i];
      p6[i + 1] = p6[i] + this.sixth[i];
    }
    this.ps = [pe, pc, pt, pm, p6];

    const times = this.times;
    const endTime = times[n - 1];
    const keep = KEEP_TOP;
    for (const T of WINDOWS) {
      const vals = [];
      let bestZ = -1.0; let bestX = 0.0; let bestC = 0.0; let bestT = 0.0; let bestI = -1;
      const ms = T * 1000.0;
      for (let i = 0; i < n; i++) {
        const t0 = times[i];
        if (t0 + ms > endTime + 1e-9) break;
        const j = bisectLeft(times, t0 + ms);     // [i, j)
        if (j <= i) continue;
        const x = (pe[j] - pe[i]) / T;
        const yc = (pc[j] - pc[i]) / T;
        const yt = (pt[j] - pt[i]) / T;
        const ym = (pm[j] - pm[i]) / T;
        const y6 = (p6[j] - p6[i]) / T;
        const z = (x + lamC * yc + lamT * yt + lamM * ym + lam6 * y6);
        vals.push([z, x, yc, yt, ym, y6, i]);
        if (z > bestZ) { bestZ = z; bestX = x; bestC = yc; bestT = yt; bestI = i; }
      }
      // Python: vals.sort(key=lambda v: -v[0]) —— 稳定降序
      vals.sort((a, b) => cmpDesc(a[0], b[0]));
      env.top.set(T, vals.length > keep ? vals.slice(0, keep) : vals);
      env.count.set(T, vals.length);
      env.z.set(T, Math.max(bestZ, 0.0));
      env.nps.set(T, bestX);
      env.colourBits.set(T, bestC);
      env.timeBits.set(T, bestT);
      env.arg.set(T, bestI);
      // 难度分位（用于马拉松加权复合标量，对齐 features.py:_compute_envelope）：
      // 全窗口 Z 值的分位。5%最难=p95、15%最难=p85、45%最难=p55、全曲=均值。
      const zs = vals.map((rec) => rec[0]).slice().sort(cmpAsc);
      const cnt = zs.length;
      let p05 = 0.0, p15 = 0.0, p45 = 0.0, mean = 0.0;
      if (cnt) {
        p05 = _percentile(zs, 0.95);
        p15 = _percentile(zs, 0.85);
        p45 = _percentile(zs, 0.55);
        mean = pysum(zs) / cnt;
      }
      env.pcomp.set(T, [p05, p15, p45, mean]);
    }
    this.envelope = env;
    return undefined;
  }

  // ------------------------------------------------------------ 密度剖面
  /** features.py:398 density_profile —— 把全曲切成 binMs 的小段，返回 [各段音符数降序, 段数] */
  densityProfile(binMs = 1000.0) {
    if (this.n < 2) return [[0], 0];
    const t0 = this.times[0];
    // Python: int((times[-1] - t0) // bin_ms) —— // 是 floor
    const nb = pyInt(Math.floor((this.times[this.n - 1] - t0) / binMs));
    if (nb < 1) return [[this.n], 1];
    const bins = new Array(nb).fill(0);
    for (const t of this.times) {
      const k = pyInt((t - t0) / binMs);
      if (k >= 0 && k < nb) bins[k] += 1;
    }
    bins.sort(cmpDesc);
    return [bins, nb];
  }

  /** features.py:413 density_percentiles —— (5%, 15%, 30%) 最密段的平均密度 NPS */
  densityPercentiles(binMs = 1000.0) {
    const [bins, nb] = this.densityProfile(binMs);
    if (nb === 0) return [0.0, 0.0, 0.0];
    const scale = 1000.0 / binMs;
    const out = [];
    for (const q of [0.05, 0.15, 0.30]) {
      let k = Math.max(1, pyRound(q * nb));
      k = Math.min(k, nb);
      out.push(pysum(bins.slice(0, k)) / k * scale);
    }
    return out;
  }

  /** features.py:426 dense_rate —— 最快 q 比例音符的平均速率（notes/s）。
   *
   * 注意：平均会掺进 1/8 爆发，把复合图的速度算高了。
   * 判「高速」要用 grid_rate 而不是这个。 */
  denseRate(q = 0.15) {
    const d = this.dts.slice().sort(cmpAsc);
    if (!d.length) return 0.0;
    const k = Math.max(1, pyInt(d.length * q));
    let s = 0;
    for (let x = 0; x < k; x++) s += 1000.0 / d[x];
    return s / k;
  }

  /** features.py:438 grid_rate —— 「这图跑起来多快」——取间隔分布 q 分位对应的速率（notes/s）。
   *
   * 不用 BPM、也不用最快若干音符的平均，理由是用户给的等价关系：
   *     复合排列 170BPM（1/6 栅格）  ≈  高速 285BPM（1/4 栅格）
   * 前者 170×6/60 = 17.0 nps，后者 285×4/60 = 19.0 nps —— 同一量级。
   * 看 BPM 会得出完全相反的结论；取最快 15% 的平均又会被 1/8 爆发带偏
   * （I'm For You 会算成 23 nps，而它真正的 1/6 段只有 17.4）。
   * 取间隔分布的分位刚好落在「密集段所用的那一档栅格」上。 */
  gridRate(q = 0.25) {
    const d = this.dts.slice().sort(cmpAsc);
    if (!d.length) return 0.0;
    return 1000.0 / Math.max(_percentile(d, q), 1e-6);
  }

  // ------------------------------------------------------------ 键型统计
  /** features.py:454 _compute_keytype_stats */
  _computeKeytypeStats() {
    const notes = this.notes;
    const n = this.n;
    this.runLengths = [];
    if (n >= 2) {
      let cur = 1;
      for (let i = 1; i < n; i++) {
        if (notes[i].colour === notes[i - 1].colour) {
          cur += 1;
        } else {
          this.runLengths.push(cur);
          cur = 1;
        }
      }
      this.runLengths.push(cur);
    }
    const rl = this.runLengths;
    if (rl.length) {
      this.meanRun = pysum(rl) / rl.length;
      // Math.max(...rl) 在超长数组上会爆栈，改成循环（结果相同）
      let mx = rl[0];
      let c4 = 0; let c8 = 0; let c1 = 0;
      for (const x of rl) {
        if (x > mx) mx = x;
        if (x >= 4) c4 += 1;
        if (x >= 8) c8 += 1;
        if (x === 1) c1 += 1;
      }
      this.maxRun = mx;
      this.longRunFrac = c4 / rl.length;
      this.long8Frac = c8 / rl.length;
      this.run1Frac = c1 / rl.length;
    } else {
      this.meanRun = 0.0;
      this.maxRun = 0.0;
      this.longRunFrac = 0.0;
      this.long8Frac = 0.0;
      this.run1Frac = 0.0;
    }

    // 相对节拍的时间比例 → 判定所用栅格
    const unit = this.meta.beat_unit;
    this.gridHist = {};
    if (unit && this.dts.length) {
      const hist = {};
      for (let i = 0; i < this.dts.length; i++) {
        const t = this.times[i + 1];
        let bl;
        try { bl = unit(t); } catch (e) { continue; }
        if (!bl || bl <= 0) continue;
        const r = this.dts[i] / bl;
        let key = null;
        // 判定顺序即 Python 元组的迭代顺序 —— 第一个命中即 break，顺序不能改
        for (const [frac, name] of GRID_TABLE) {
          if (Math.abs(r - frac) <= frac * 0.14 + 0.008) { key = name; break; }
        }
        key = key || 'other';
        hist[key] = (hist[key] || 0) + 1;
      }
      let tot = pysum(Object.values(hist)) || 1;
      const out = {};
      for (const k of Object.keys(hist)) out[k] = hist[k] / tot;
      this.gridHist = out;
    }

    // ---- 等间隔长串 ----
    this.uniformFrac = 0.0;
    this.uniformMax = 0;
    if (this.dts.length) {
      const tol = 0.15;
      let cur = 2;
      let best = 2;
      let totalLong = 0;
      for (let i = 2; i < this.dts.length; i++) {
        const a = this.dts[i - 1];
        const b = this.dts[i];
        if (Math.abs(b - a) <= tol * a) {
          cur += 1;
        } else {
          if (cur >= 16) totalLong += cur;
          best = Math.max(best, cur);
          cur = 2;
        }
      }
      if (cur >= 16) totalLong += cur;
      best = Math.max(best, cur);
      this.uniformMax = best;
      this.uniformFrac = totalLong / Math.max(this.dts.length, 1);
    }

    // ---- BPM 与细分度 ----
    this.bpmMedian = this.bpmMain;
    this.subdivision = 0.0;
    if (unit && this.dts.length) {
      const subs = [];
      for (let i = 0; i < this.dts.length; i++) {
        const t = this.times[i + 1];
        let bl;
        try { bl = unit(t); } catch (e) { continue; }
        if (!bl || bl <= 0 || this.dts[i] <= 0) continue;
        subs.push(bl / this.dts[i]);
      }
      if (subs.length) {
        subs.sort(cmpAsc);
        this.subdivision = subs[pyInt(subs.length / 2)];
      }
    }
    return;
  }
}

// features.py:493-495 栅格判定表（Features._compute_keytype_stats 用，顺序敏感）
const GRID_TABLE = [
  [0.125, '1/8'], [1 / 6.0, '1/6'], [0.25, '1/4'],
  [1 / 3.0, '1/3'], [0.5, '1/2'], [1.0, '1/1'],
  [0.75, '3/4'], [1.5, '1.5'], [2.0, '2/1'],
];

// ====================================================================
// 3. model.py —— 包络 → 标量 → 段位
// ====================================================================

/*
 * model.py 顶部的 docstring（重要，标定取法的理由都在这里）：
 *
 *   标定点的取法（重要）
 *   --------------------
 *   锚点不是「整张段位马松」，而是**马松里的单个段落**。
 *   一张 Dan ~ REFORM 马松由 4 段拼成、各考一种键型；
 *   而一般谱面往往只有 1~2 种键型、强度却更高。
 *   拿整张马松当锚点会把「4 段连打 + 8 分钟体力」这份广度算进 N 段的门槛里，
 *   于是单键型高强度的短图被系统性压低 —— 这是旧版 8 段附近估不准的根源。
 *   改成段落粒度后，一个段落 ≈ 一首 2 分钟的曲子，与一般谱面量级一致。
 *
 *   刻度压缩
 *   --------
 *   相邻段位若客观标量几乎重合（如 3→4 只差 0.5%、10→11 只差 0.8%），
 *   说明这个尺子分辨不出它们。此时仍然让它们占据整整 1.0 的间距，
 *   只会把测量噪声放大成「跳段」。因此按 tanh 压缩后再归一化到 1~14：
 *   分得开的相邻段位间距被拉大，分不开的被压近。
 */

// model.py:73-78  流速修正常量（速度主权重已折进标量，这里只留很小的残留加成）
// 权重刻意压低，避免与标量内的速度项重复计价。
const FLOW_REF = 200.0;        // 参考流速（等效 BPM = SV × BPM）；与 model.py 保持一致
const FLOW_K = 0.30;           // 残留流速加星（段）
const FLOW_SOFT = 0.85;        // tanh 软化尺度（越小越快饱和）
const FLOW_VAR_K = 0.15;       // 流速起伏的额外代价
const FLOW_CAP = 1.00;         // 正向封顶（段）
const FLOW_FLOOR = -0.30;      // 负向下限（段）

// model.py:80-85 速度折标量（将等效 BPM 折进标量本身）
// 有效标量 = 包络标量 × (flow_p90 / SPEED_REF) ** speed_exp，
// 慢图压低、快图抬高，与「同样密度下更快更难」一致，且能真正把 DELTA 顶到 GAMMA 之上。
const SPEED_REF = 200.0;        // 参考等效 BPM
const SPEED_FLOOR_MULT = 0.45;  // 慢图最多压到 0.45×
const SPEED_CAP_MULT = 2.50;    // 快图最多抬到 2.5×

// model.py:130-150 持续串强度（加法段位修正，与 flow/stream 同机制）—— 2026-10 重写（用户本轮）
// 三因素（均单调增）：
//   主因素1 = 串 BPM(串内等效 BPM) × 单条串长(L≥16 才放大)
//   主因素2 = 整曲串占比（long_frac）
//   次因素   = 串内换色频率(次/秒)
// 因全单调，DIVINE 在 bpm / 串占比 / 难度加权上必 < Ni Kan Dao（用户本轮断言）。
const STREAM_BPM_REF = 200.0;  // 串 BPM 参考线：高于此才计主因素1
const STREAM_BPM_K = 1.15;     // 串 BPM 每翻倍(超出 REF) 的加星
const STREAM_LEN_REF = 16.0;   // 单条串长参考：高于此才放大主因素1
const STREAM_LEN_K = 0.40;     // 单条串长放大系数（封顶 STREAM_LEN_CAP）
const STREAM_LEN_CAP = 1.70;
// 2026-10 第四轮：1.30→1.60（串占比＝持续输出，加强）
const STREAM_RATIO_K = 1.60;   // 整曲串占比满额增益（段）
const STREAM_RATIO_SOFT = 0.30; // tanh 软化：占比 0.30 处 ≈ 中点
// 2026-10 第四轮：0.85→1.20（串内换手率加强）
const STREAM_SW_K = 1.20;      // 串内换色频率满额增益
const STREAM_SW_SOFT = 2.80;
const STREAM_W1 = 0.50;        // 主因素1 权重
const STREAM_W2 = 0.35;        // 主因素2 权重
const STREAM_W3 = 0.20;        // 次因素 权重
const STREAM_CAP = 2.20;       // 正向上限（段）
const STREAM_FLOOR = -0.60;    // 负向下限（段）

// model.py:152-157 难度分位复合权重（马拉松加权标量）：5%/15%/45% 最难窗口 + 全曲均值
const PCT_W05 = 0.32;          // 5% 最难
const PCT_W15 = 0.28;          // 15% 最难
const PCT_W45 = 0.22;          // 45% 最难
const PCT_W100 = 0.18;         // 全曲均值（硬段主导，但不丢整体）

// features.py:91 REP_DISC —— 串内重复度（机械循环 xoo 等）折扣比例
const REP_DISC = 0.90;      // 2026-10 第五轮：0.35→0.90（度量重写后门槛更严、下手更狠）
const REP_UNIT_MIN = 2;     // 重复单元最短音数（p=1 全同色由 MONO_STREAM_DISC 处理）
const REP_UNIT_MAX = 4;     // 重复单元最长音数（用户：「最大四个为一组单元」）

// model.py:31 / sections.py —— 段落均值标量
const MIN_SEC_NOTES = 300;     // 段落均值标量：只纳入 ≥ 此音符数的段落
const MIN_SECTION_MS = 3000.0; // 段间空白 ≥ 此值视为切分点（sections.MIN_SECTION_MS）
const MIN_SECTION_LEN = 8;     // 太短碎片并入上一段（sections.MIN_SECTION_LEN）

// features.py:CONC_* —— 集中度（「休息段 / 多段结构」的度量）
// 用户指引：以物件数为主、时间为辅 —— 两个维度都取「最大段占全曲的比例」。
// 不用「休息时长占比」是因为实测段位马松的休息也只有 3~6%（4 首歌几乎连着打），
// 该指标分不开马松与「主体连续的长曲」；集中度可以（0.27~0.38 vs 0.6+）。
const CONC_W_NOTE = 0.7;   // 物件数维度权重（主）
const CONC_W_TIME = 0.3;   // 时间维度权重（辅）
const CONC_GAP_MS = 3000.0; // 切段间隙阈值（与 MIN_SECTION_MS 一致）

// model.py:107 SPEED2_GATE_SECTIONS + SPEED2_* —— 第二维高速加成与集中度门控
const SPEED2_REF = 200.0;
const SPEED2_K = 2.20;         // 每翻倍有效 BPM 额外加星（段）
const SPEED2_CAP = 2.50;       // 正向封顶（段）
const SPEED2_GATE_SECTIONS = 3; // 仅供 _nsecGate 兜底使用
const CONC_ZERO = 0.42;        // conc ≤ 此值 → 归零（马松实测最大 0.381，余量 0.039）
const CONC_FULL = 0.62;        // conc ≥ 此值 → 满额

// model.py:105-107 判定区间（OD）难度加成
// OD 高于 OD_REF 且含非常规快栅格(1/8,1/6,1/4,1/3) 时给加法段位修正。
const OD_REF = 7.0;            // OD 参考线
const OD_K = 0.30;             // 每超出 1 点 OD、满非常规栅格时的加星
const OD_CAP = 1.50;           // OD 加成封顶（段）

// model.py:116 段位数值外推（完全不设上限）
// 标定锚点只覆盖到 dan 14（Delta 顶端）。超出最高锚点用「温和斜率」外推：
// 额外段位 = DAN_EXTRA_SLOPE × (log 标量 − log 最高锚点标量)。
// 因 x 已是 log(标量)，extra 只随「标量翻倍次数」线性增长，即便极端难谱也只缓慢上升，
// 不会 runaway；用户要求：极端难谱应能给到对应的高段位，故不夹任何硬上限。
const DAN_EXTRA_SLOPE = 2.0;   // 超出最高锚点后的外推斜率（段 / log(标量)），远小于 PCHIP 末端斜率

/** model.py:71 _pchip_slopes —— Fritsch–Carlson 单调三次插值的斜率 */
function _pchipSlopes(xs, ys) {
  const n = xs.length;
  const h = [];
  for (let i = 0; i < n - 1; i++) h.push(xs[i + 1] - xs[i]);
  const delta = [];
  for (let i = 0; i < n - 1; i++) delta.push((ys[i + 1] - ys[i]) / h[i]);
  const m = new Array(n).fill(0.0);
  m[0] = delta[0];
  // Python 的 delta[-1] 是**最后一个元素**（delta 长度只有 n-1），
  // 写成 delta[n-1] 在 JS 里会越界成 undefined —— 整条曲线直接变 NaN。
  m[n - 1] = delta[delta.length - 1];
  for (let i = 1; i < n - 1; i++) {
    if (delta[i - 1] * delta[i] <= 0) {
      m[i] = 0.0;
    } else {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      m[i] = (w1 + w2) / (w1 / delta[i - 1] + w2 / delta[i]);
    }
  }
  for (let i = 0; i < n - 1; i++) {
    if (delta[i] === 0) {
      m[i] = 0.0;
      m[i + 1] = 0.0;
    } else {
      const a = m[i] / delta[i];
      const b = m[i + 1] / delta[i];
      const s = a * a + b * b;
      if (s > 9) {
        const t = 3.0 / Math.sqrt(s);
        m[i] = t * a * delta[i];
        m[i + 1] = t * b * delta[i];
      }
    }
  }
  return [m, h, delta];
}

/** model.py:100 _pchip_eval */
function _pchipEval(xs, ys, m, h, x) {
  const n = xs.length;
  if (x <= xs[0]) return ys[0] + m[0] * (x - xs[0]);            // 左端线性外推（下方由 dan() 夹到 >=0）
  // 右端：温和斜率外推，完全不设硬上限（极端难谱给对应高段位）。
  if (x >= xs[n - 1]) {
    // 右端：温和斜率外推，完全不设硬上限（极端难谱给对应高段位）。
    // 因 x 已是 log(标量)，extra 只随「标量翻倍次数」线性增长，不会 runaway。
    const overflow = x - xs[n - 1];
    const extra = DAN_EXTRA_SLOPE * overflow;
    return ys[n - 1] + extra;
  }
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (xs[mid] <= x) lo = mid; else hi = mid;
  }
  const i = lo;
  const t = (x - xs[i]) / h[i];
  const t2 = t * t;
  const t3 = t * t * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return (h00 * ys[i] + h10 * h[i] * m[i] + h01 * ys[i + 1]
          + h11 * h[i] * m[i + 1]);
}

/** model.py:124 MonotoneCurve */
class MonotoneCurve {
  constructor(xs, ys) {
    // Python: sorted(zip(xs, ys)) —— 先按 x 再按 y 排；锚点里有重复的 x，必须二级排序
    const pair = xs.map((x, i) => [x, ys[i]]).sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
    this.xs = pair.map((p) => p[0]);
    this.ys = pair.map((p) => p[1]);
    const [m, h, delta] = _pchipSlopes(this.xs, this.ys);
    this.m = m; this.h = h; this.delta = delta;
  }

  eval(x) {
    return _pchipEval(this.xs, this.ys, this.m, this.h, x);
  }
}

/** model.py:136 duration_gain —— 速率—时长权衡 */
function durationGain(T, form, kappa, tau, T0) {
  // 注意：不再把 T<T0 夹到 1.0。
  // 0.25 秒里塞 7 个音符只是一次甩手；同样速率撑满 1 秒才是真功夫。
  // 夹住 T0 会让「瞬时爆发」和「持续一秒」等价，
  // 于是爆发型的段位段落压过 Ni Kan Dao 这种平铺到底的大串 —— 与实测手感相反。
  if (form === 'log') return Math.max(0.35, 1.0 + kappa * Math.log2(T / T0));
  if (form === 'power') return (T / T0) ** kappa;
  if (form === 'hyper') return (1.0 + tau / T0) / (1.0 + tau / T);
  return 1.0;
}

/** model.py:_conc_gate —— 持续强度加成的集中度门控系数 ∈ [0, 1]。
 * 看的是「难度是否集中在同一段」，而不是「被切成了几段」：
 *   - 4 键型马松（各考一种键型、各段 ~25%）→ 0，其高速只存在于某一小段；
 *   - 主体连续的长曲 / 单键型持续图 → 1，整段都在持续输出。 */
function _concGate(feats) {
  const c = feats.conc;
  if (c === undefined || c === null) {
    return _nsecGate(feats.nSections || 1);   // 兜底：老对象无 conc 字段
  }
  if (c <= CONC_ZERO) return 0.0;
  if (c >= CONC_FULL) return 1.0;
  return (c - CONC_ZERO) / (CONC_FULL - CONC_ZERO);
}

/** model.py:_nsec_gate ——（旧）段数门控：nsec=1→1.0，nsec=2→0.5，nsec≥阈值→0。
 * 仅供兜底与对照实验；主路径已改用 _concGate。 */
function _nsecGate(nsec) {
  if (nsec <= 1) return 1.0;
  if (nsec >= SPEED2_GATE_SECTIONS) return 0.0;
  return (SPEED2_GATE_SECTIONS - nsec) / (SPEED2_GATE_SECTIONS - 1);
}

/** model.py:150 Model */
export class Model {
  constructor(anchors = null, params = null) {
    // 标定参数来自 dan_calibration.js 的 DAN_PARAMS（即 calibration.json 的 params）
    this.params = Object.assign({}, DAN_PARAMS, params || {});
    this.anchors = anchors || [];           // [[danValue, scalar], ...]
    this.projected = null;
    this.residuals = null;
    this.curve = null;
    if (this.anchors.length) this._buildCurve();
  }

  _buildCurve() {
    const xs = this.anchors.map((p) => Math.log(p[1]));
    const ys = this.anchors.map((p) => Number(p[0]));
    this.curve = new MonotoneCurve(xs, ys);
  }

  /** model.py:300 window_level_pct —— 单个窗口长度 T 的难度：
   * 5%/15%/45% 最难窗口 + 全曲均值的加权复合（取代旧版「取最好 take 个窗口均值」）。 */
  windowLevel(env, T) {
    const p = env.pcomp.get(T);
    if (!p) return 0.0;
    const p05 = p[0], p15 = p[1], p45 = p[2], mean = p[3];
    return (PCT_W05 * p05 + PCT_W15 * p15 + PCT_W45 * p45 + PCT_W100 * mean);
  }

  /** model.py:314 contributions —— 每个窗口长度贡献的 [T, v, g, v*g] */
  contributions(feats) {
    const out = [];
    for (const T of WINDOWS) {
      if (!feats.envelope.pcomp.has(T)) continue;
      const v = this.windowLevel(feats.envelope, T);
      if (v > 0) {
        const g = durationGain(T, this.params.duration_form, this.params.kappa, 1.0, this.params.t0);
        out.push([T, v, g, v * g]);
      }
    }
    return out;
  }

  /** model.py:326 raw_scalar —— 段位标量（多段曲用各段标量均值，单段曲退化为整曲标量） */
  rawScalar(feats) {
    const ns = feats.nSections || 1;
    if (ns > 1 && feats.notes && feats.notes.length) {
      const secs = splitSections(feats.notes, MIN_SECTION_MS);
      const vals = [];
      for (const [a, b] of secs) {
        if (b - a < MIN_SEC_NOTES) continue;
        const sub = new Features(feats.notes.slice(a, b), feats.meta);
        vals.push(this._rawScalarSingle(sub));
      }
      if (vals.length) return pysum(vals) / vals.length;
    }
    return this._rawScalarSingle(feats);
  }

  /** model.py:348 _raw_scalar_single —— 定长取 topk 个「折算后贡献」做均值，再折入速度 */
  _rawScalarSingle(feats) {
    const k = this.params.topk;
    const contribs = this.contributions(feats);
    if (!contribs.length) return 0.0;
    const vals = contribs.map((c) => c[3]).sort(cmpDesc);
    const kk = Math.max(1, Math.min(k, vals.length));
    let raw = pysum(vals.slice(0, kk)) / kk;
    // ---- 速度折标量（BPM / 等效流速）：把有效 BPM 折进标量本身 ----
    // 用「有效 BPM」eff_bpm_median：按用户口径在「主难度段落」取音符间隔、
    // 以「4 音 = 1 拍」分组（eff_bpm = 15000 / dt_dense），而非基 BPM。
    // 基 BPM 看不到 1/8/1/6 细分排列，会把高速 1/8 墙误判成慢谱；
    // 用主难度段落的真实间隔算 eff_bpm 后速度项正确抬升。与 SV 无关。
    let fp = feats.effBpmMedian || 0.0;
    if (!fp) fp = feats.bpmP90 || 0.0;
    if (!fp) fp = feats.bpmMedian || 0.0;
    if (fp > 0) {
      const exp = this.params.speed_exp || 0.0;
      if (exp) {
        let mult = Math.pow(fp / SPEED_REF, exp);
        mult = Math.max(SPEED_FLOOR_MULT, Math.min(SPEED_CAP_MULT, mult));
        raw *= mult;
      }
    }
    return raw;
  }

  // ------------------------------------------------------------ 流速
  /** model.py:377 flow_bonus —— 流速造成的段位修正（段，不是标量）—— 有上限、会饱和。
   * 一律取纯 BPM（SV=1），不受艺术化变速(SV)摆幅影响。 */
  flowBonus(feats) {
    const f = feats.bpmMedian !== undefined ? feats.bpmMedian : 0.0;
    if (f <= 0) return 0.0;
    // Python: getattr(feats,'bpm_p90',f) or f —— 0.0 是 falsy，会退回 f
    let p90 = feats.bpmP90 !== undefined ? feats.bpmP90 : f;
    if (!p90) p90 = f;
    // base = 0.5*median + 0.5*p90（与 model.py:388 一致）
    const base = 0.5 * f + 0.5 * p90;
    const lvl = FLOW_K * Math.tanh(Math.log2(base / FLOW_REF) / FLOW_SOFT);
    // 起伏：p90/median 越大说明流速一直在变，读谱要反复重建节奏
    const varr = FLOW_VAR_K * Math.min(1.0, Math.max(0.0, Math.log2(p90 / f) / 1.0));
    return Math.max(FLOW_FLOOR, Math.min(FLOW_CAP, lvl + varr));
  }

  /** model.py:394 stream_bonus —— 持续串强度的段位修正（段）—— 三因素（均单调增）：
   * 主因素1=串BPM×单条串长(L≥16才放大)；主因素2=整曲串占比；次因素=串内换色频率(次/秒)。
   * 因全单调，DIVINE 在 bpm/串占比/难度加权上必 < Ni Kan Dao（用户本轮断言）。 */
  streamBonus(feats) {
    const sbpm = feats.streamBpm || 0.0;
    const slen = feats.meanStreamLen || 0.0;
    const ratio = feats.streamRatio || 0.0;
    const sw = feats.streamSwPerSec || 0.0;
    // 主因素1：串 BPM（log 缩放，高于 REF 才计）
    let f1 = 0.0;
    if (sbpm > STREAM_BPM_REF) {
      f1 = STREAM_BPM_K * Math.log(sbpm / STREAM_BPM_REF);
      if (slen > STREAM_LEN_REF) {
        f1 *= Math.min(STREAM_LEN_CAP, 1.0 + STREAM_LEN_K * Math.log(slen / STREAM_LEN_REF));
      }
    }
    // 主因素2：整曲串占比
    const f2 = STREAM_RATIO_K * Math.tanh(ratio / STREAM_RATIO_SOFT);
    // 次因素：串内换色频率
    const f3 = STREAM_SW_K * Math.tanh(sw / STREAM_SW_SOFT);
    const raw = STREAM_W1 * f1 + STREAM_W2 * f2 + STREAM_W3 * f3;
    return Math.max(STREAM_FLOOR, Math.min(STREAM_CAP, raw));
  }

  /** model.py:303 od_bonus —— 判定区间（OD）造成的段位修正（段），与 flow/stream 同机制（加法修正）。
   *
   * OD 高于 OD_REF 且含非常规快栅格(1/8,1/6,1/4,1/3) 时给加法段位修正：
   *   od_bonus = OD_K · max(0, od − OD_REF) · fast_frac
   * fast_frac = 这些快栅格在全曲间隔里的占比（慢栅格在很高 OD 下也容易读，不计入）。
   * OD ≤ OD_REF 或没有快栅格时不加 —— 不惩罚低 OD 谱，也不动慢图。 */
  odBonus(feats, od = null) {
    if (od === null || od === undefined || od <= OD_REF) return 0.0;
    const gh = feats.gridHist || {};
    const fast = (gh['1/8'] || 0.0) + (gh['1/6'] || 0.0)
      + (gh['1/4'] || 0.0) + (gh['1/3'] || 0.0);
    if (fast <= 0) return 0.0;
    const raw = OD_K * (od - OD_REF) * fast;
    return Math.min(OD_CAP, raw);
  }

  /** model.py:443 speed_bonus2 —— 第二维：有效 BPM（主难度段真实间隔算的 1/8 等效速度）加成（段）。
   * 与 flow_bonus 同机制（加法、在锚点里扣回、不进标量、不改变 S 排序）。 */
  speedBonus2(feats) {
    const eff = feats.effBpmMedian || 0.0;
    if (eff <= 0) return 0.0;
    const x = Math.log(eff / SPEED2_REF);
    if (x <= 0) return 0.0;
    let raw = SPEED2_K * x;
    // 集中度门控：看难度是否集中在同一段，而不是被切成了几段。
    // 4 键型马松（各段 ~25%）归零；主体连续的长曲与单键型持续图满额。
    const gate = _concGate(feats);
    return Math.min(SPEED2_CAP, raw * gate);
  }

  /** model.py:465 dan —— 标量 → 段位（叠加流速 / 串强度 / 高速加成 / OD 加法修正；无硬上限） */
  dan(scalarValue, feats = null, od = null) {
    if (scalarValue <= 0) return 0.0;
    if (!this.anchors.length) throw new Error('未载入标定锚点');
    let v = this.curve.eval(Math.log(scalarValue));
    if (feats !== null && feats !== undefined) {
      v += this.flowBonus(feats);
      v += this.streamBonus(feats);
      v += this.speedBonus2(feats);
      if (od !== null && od !== undefined) v += this.odBonus(feats, od);
    }
    return Math.max(0.0, v);
  }

  /** model.py:225 features_of —— 造一份 Features */
  featuresOf(notes, beatUnit = null, svUnit = null) {
    const meta = {
      beat_unit: beatUnit,
      sv_unit: svUnit,
      big_cost: this.params.big_cost,
      lambda_colour: this.params.lambda_colour,
      lambda_time: this.params.lambda_time,
      lambda_mono: this.params.lambda_mono,
      lambda_sixth: this.params.lambda_sixth,
    };
    return new Features(notes, meta);
  }

  /** model.py:348 score —— 返回 [rawScalar, dan, features]（od 为 OverallDifficulty，透传至 dan） */
  score(notes, beatUnit = null, svUnit = null, od = null) {
    let bu = beatUnit;
    if (typeof bu !== 'function') bu = null;
    let su = svUnit;
    if (typeof su !== 'function') su = null;
    const feats = this.featuresOf(notes, bu, su);
    const s = this.rawScalar(feats);
    return [s, this.dan(s, feats, od), feats];
  }
}

// ---------------------------------------------------------------- 段位名
/** model.py:253 grade_name —— 段位数值 → 显示称号。
 *
 * - 1 段 ~ 10 段：只显示整数，不带「段」字（如 10.4 → "10"）。
 * - Alpha 及以上：按 [a,b) 区间内「左 20% 为 X-、中 60% 为 X、右 20% 为 X+」做分度。
 * - Delta 及以上统一为 Delta- / Delta / Delta+ / >Delta+ 四级：
 *   Delta 段 [13.5,15.0) 内部用 ± 分度，v≥15.0 一律记为 >Delta+。 */
export function gradeName(v) {
  if (v < 1.0) return '<1';
  if (v < 10.5) {
    // Python: str(int(round(v))) —— round 是 half-to-even
    return String(pyRound(v));
  }
  const bands = [
    ['Alpha', 10.5, 11.5],
    ['Beta', 11.5, 12.5],
    ['Gamma', 12.5, 13.5],
    ['Delta', 13.5, 15.0],
  ];
  for (const [name, a, b] of bands) {
    if (v < b) return _gradePm(name, v, a, b);
  }
  return '>Delta+';
}

/** model.py:278 _grade_pm */
function _gradePm(name, v, a, b) {
  const w = b - a;
  if (v < a + 0.2 * w) return `${name}-`;
  if (v < a + 0.8 * w) return name;
  return `${name}+`;
}

// ====================================================================
// 4. keytype.py —— 键型判断
// ====================================================================

/*
 * keytype.py 顶部的 docstring：
 *
 *   键型判断：把一张谱面归入「大串 / 高速 / 协调 / 复合」中的主次类型，
 *   或判定为「混合」。
 *
 *   四类不是互斥的分箱，而是四条并行的证据链：
 *       大串 ── 等间隔长串占比高、同色连打多、密度起伏小
 *       高速 ── 实际推进速度**高于同段位的常规键型**
 *       协调 ── 颜色/节奏惊讶度高、等间隔串少（排列反常）
 *       复合 ── 1/4 与 1/6（乃至 1/8）两类栅格同时在列、成串的 1/6 多
 *
 *   两条被实测逼出来的修正
 *   ----------------------
 *   1) 「高速」必须是**相对量**。
 *      旧版用绝对 BPM 打分，结果段位越高 BPM 越高，顶端整张表被判成高速 ——
 *      这没有信息量：14 段的图当然快。
 *      现在的做法是先在语料库上拟合「这个段位的常规速度」expected_speed(dan)，
 *      再看这张图比它快多少。于是「复合排列 170BPM」与「高速 285BPM」
 *      这两个速度需求相当的谱面会被同等对待（两者的最密 15% 速率都在 17~19 nps）。
 *
 *   2) 「1/6 复合」要看结构，不能只看占比。
 *      * 孤立的一个 1/6 四连（大串夹小）只给 0.30 权重 —— 拿一个收尾四连
 *        把整张图抬成复合是不合理的。
 *      * 成串的 1/6 还要看排色：反复出现 ooxxooxx 型的按 0.70 系数降权。
 *      * 于是 I'm For You（1/6 占 33%、排色卡手）明显高于
 *        Kick To The Sky（1/6 占 8%、且多为孤立四连）。
 *
 *   混合
 *   ----
 *   一首歌在不同段落分别考察多种键型时（如 Atomic Disassembler 五分多钟里
 *   换了大量排列）判为「混合」。判据是按 45 秒切片逐片归类，
 *   若有 ≥3 种键型各自覆盖 ≥20% 的切片，即为混合。
 */

// keytype.py:42 NAMES
const KT_NAMES = ['大串', '高速', '协调', '复合'];

// keytype.py:46-68 类型 -> ((证据名, 权重, 是否反向), ...)
// 阈值 [lo, hi] 由 make_keytype_thresholds.py 在语料库上按分位标定，
// 运行时从 dan_calibration.js 的 KT_THRESHOLDS 注入。
// ★ 用数组而不是对象：Python 的 dict 迭代顺序 = 插入顺序，
//   而 raw_scores 的累加顺序与 cands 的排序结果都依赖它。
const KT_SPEC = [
  ['大串', [
    ['uniform', 0.42, false],   // 属于等间隔长串（≥16 连）的音符占比
    ['run3', 0.28, false],      // 长度 ≥3 的同色连打占比（换手负担）
    ['burst', 0.30, true],      // 密度起伏小 ⇒ 才叫「串」
  ]],
  ['高速', [
    ['speedrel', 0.55, false],  // 实际速度 / 同段位常规速度
    ['sustain', 0.25, false],   // 8 秒持续有效速率
    ['subdiv', 0.20, false],    // 每拍音符数
  ]],
  ['协调', [
    ['tbits', 0.35, false],     // 节奏惊讶度
    ['cbits', 0.30, false],     // 颜色惊讶度
    ['uniform', 0.20, true],    // 等间隔串少 ⇒ 排列反常
    ['burst', 0.15, false],
  ]],
  ['复合', [
    ['sixthawk', 0.38, false],  // 成串 1/6 的结构负载（已含 ooxx 降权）
    ['gridmix', 0.32, false],   // 1/4 与 1/6·1/8 共同存在且均衡
    ['burst', 0.30, false],     // 爆发比大
  ]],
];

// keytype.py:72-83 兜底阈值（keytype_thresholds.json 存在时以它为准）
const KT_FALLBACK_THRESHOLDS = {
  uniform: [0.10, 0.40],
  burst: [1.15, 1.75],
  run3: [0.10, 0.30],
  speedrel: [1.00, 1.35],
  sustain: [6.0, 14.0],
  subdiv: [2.0, 4.0],
  cbits: [0.70, 0.95],
  tbits: [0.90, 1.80],
  gridmix: [0.15, 0.50],
  sixthawk: [0.03, 0.20],
};

// keytype.py:88 —— load_thresholds() 把标定值写进 THRESHOLDS
const THRESHOLDS = Object.assign({}, KT_FALLBACK_THRESHOLDS, KT_THRESHOLDS || {});

// keytype.py:86 / load_thresholds() 语料库基线：log(最密15%速率) = a + b·段位
const SPEED_BASELINE = Object.assign({ a: 1.60, b: 0.070 }, KT_SPEED_BASELINE || {});

/** keytype.py:110 expected_speed —— 同段位谱面的常规推进速度（notes/s，取最密 15% 的平均速率） */
function expectedSpeed(dan) {
  return Math.exp(SPEED_BASELINE.a + SPEED_BASELINE.b * Math.max(dan, 0.0));
}

/** keytype.py:115 _lo_hi */
function _loHi(key) {
  const v = THRESHOLDS[key];
  if (v) return v;
  const fb = KT_FALLBACK_THRESHOLDS[key];
  return fb || [0.0, 1.0];
}

/** keytype.py:119 member —— 隶属函数：低于 lo 记 0 分，高于 hi 记 1 分 */
function member(x, lo, hi, invert = false) {
  let v;
  if (hi === lo) v = x >= hi ? 1.0 : 0.0;
  else v = (x - lo) / (hi - lo);
  v = v < 0 ? 0.0 : (v > 1 ? 1.0 : v);
  return invert ? 1.0 - v : v;
}

/** keytype.py:128 evidence —— 从 Features 抽出各条原始证据 */
function evidence(f, dan = null) {
  const env = f.envelope;
  const susNps = env.nps.get(8.0);
  const sus = susNps === undefined ? 0.0 : susNps;
  const pkNps = env.nps.get(0.5);
  const pk = pkNps === undefined ? 0.0 : pkNps;
  const burst = (sus > 0) ? (pk / sus) : 1.0;
  const g = f.gridHist || {};
  const a = g['1/4'] || 0.0;
  const fine = (g['1/6'] || 0.0) + (g['1/8'] || 0.0);
  const total = a + fine;
  const balance = (total > 1e-6) ? (Math.min(a, fine) * 2.0 / total) : 0.0;
  const gridmix = total * (0.45 + 0.55 * balance);

  const rl = f.runLengths && f.runLengths.length ? f.runLengths : [];
  const run3 = rl.length ? (rl.filter((x) => x >= 3).length / rl.length) : 0.0;

  const speed = f.gridRate(0.25);
  let speedrel = 1.0;
  if (dan !== null && dan !== undefined) {
    const exp = expectedSpeed(dan);
    speedrel = (exp > 1e-6) ? (speed / exp) : 1.0;
  }

  const sixthArr = f.sixth;
  const sixthPerNote = (sixthArr && sixthArr.length && f.n)
    ? (pysum(sixthArr) / f.n) : 0.0;

  const gh = f.gridHist || {};
  return {
    uniform: f.uniformFrac,
    burst,
    run3,
    sustain: sus,
    subdiv: f.subdivision,
    cbits: f.meanColourBits,
    tbits: f.meanTimeBits,
    gridmix,
    sixthawk: sixthPerNote,
    speed,
    speedrel,
    dan: (dan === undefined ? null : dan),
    // ---- 1/6 复合相关 ----
    sixth_frac: f.sixthFrac !== undefined ? f.sixthFrac : 0.0,
    sixth_sustained_frac: f.sixthSustainedFrac !== undefined ? f.sixthSustainedFrac : 0.0,
    g14: gh['1/4'] || 0.0,
    g16: gh['1/6'] || 0.0,
  };
}

/** keytype.py:175 raw_scores —— 四类原始分数 [0,1] */
function rawScores(f, dan = null) {
  const ev = evidence(f, dan);
  const out = {};
  for (const [name, spec] of KT_SPEC) {
    let total = 0.0;
    for (const [key, w, inv] of spec) {
      const [lo, hi] = _loHi(key);
      total += w * member(ev[key], lo, hi, inv);
    }
    out[name] = total;
  }
  return out;
}

// keytype.py:189 CHUNK_SEC = 45.0
const CHUNK_SEC = 45.0;

/**
 * keytype.py:220 _Slice —— 轻量 Features 替身：只带键型判定需要的字段。
 * 注意它直接**复用整谱的 envelope**（Python 原样如此，不是 bug 移植错误）。
 */
class Slice {
  constructor(f, a, b) {
    this.n = b - a;
    this.times = f.times.slice(a, b);
    const dts = [];
    for (let i = 0; i < this.n - 1; i++) dts.push(this.times[i + 1] - this.times[i]);
    this.dts = dts;
    this.duration = Math.max(this.times[this.times.length - 1] - this.times[0], 1.0);
    this.envelope = f.envelope;
    this.gridHist = {};
    this.uniformFrac = 0.0;
    this.runLengths = [];
    this.meanColourBits = f.meanColourBits;
    this.meanTimeBits = f.meanTimeBits;
    this.subdivision = f.subdivision;
    this.sixth = f.sixth.slice(a, b);
    const notes = f.notes.slice(a, b);
    let cur = 1;
    for (let i = 1; i < notes.length; i++) {
      if (notes[i].colour === notes[i - 1].colour) {
        cur += 1;
      } else {
        this.runLengths.push(cur);
        cur = 1;
      }
    }
    this.runLengths.push(cur);
    // 等间隔长串
    if (dts.length >= 3) {
      const tol = 0.15;
      let run = 2;
      let totalLong = 0;
      for (let i = 2; i < dts.length; i++) {
        if (Math.abs(dts[i] - dts[i - 1]) <= tol * dts[i - 1]) {
          run += 1;
        } else {
          if (run >= 16) totalLong += run;
          run = 2;
        }
      }
      if (run >= 16) totalLong += run;
      this.uniformFrac = totalLong / dts.length;
    }
    // 栅格
    const unit = f._unit;
    if (unit) {
      const c = {};
      for (let i = 0; i < dts.length; i++) {
        let bl;
        try { bl = unit(this.times[i + 1]); } catch (e) { continue; }
        if (!bl || bl <= 0) continue;
        const r = dts[i] / bl;
        let key = null;
        // ★ keytype.py:275 的判定表比 Features 少三项（无 3/4、1.5、2/1），顺序敏感
        for (const [frac, nm] of SLICE_GRID_TABLE) {
          if (Math.abs(r - frac) <= frac * 0.14 + 0.008) { key = nm; break; }
        }
        key = key || 'other';
        c[key] = (c[key] || 0) + 1;
      }
      const tot = pysum(Object.values(c)) || 1;
      const out = {};
      for (const k of Object.keys(c)) out[k] = c[k] / tot;
      this.gridHist = out;
    }
  }

  /** keytype.py:284 Slice.grid_rate —— 注意与 Features.grid_rate 不同（用的是平均口径） */
  gridRate(q = 0.25) {
    const d = this.dts.slice().sort(cmpAsc);
    if (!d.length) return 0.0;
    const k = Math.max(1, pyInt(d.length * q));
    let s = 0;
    for (let x = 0; x < k; x++) s += 1000.0 / d[x];
    return s / k;
  }
}

// keytype.py:275-276  Slice 的栅格判定表
const SLICE_GRID_TABLE = [
  [0.125, '1/8'], [1 / 6.0, '1/6'], [0.25, '1/4'],
  [1 / 3.0, '1/3'], [0.5, '1/2'], [1.0, '1/1'],
];

/** keytype.py:292 _slice_features */
function _sliceFeatures(f, a, b) {
  if ((f._unit === undefined || f._unit === null) && f.meta) {
    f._unit = f.meta.beat_unit !== undefined ? f.meta.beat_unit : null;
  }
  return new Slice(f, a, b);
}

/** keytype.py:192 _chunk_types —— 按 45 秒切片，给每片一个键型；返回 [[类型, 音符占比], ...] */
function _chunkTypes(f) {
  const n = f.n;
  if (n < 40 || f.duration < CHUNK_SEC * 2000) return [];
  const t0 = f.times[0];
  const nb = pyInt(f.duration / (CHUNK_SEC * 1000.0));
  if (nb < 3) return [];
  const edges = [0];
  for (let k = 1; k <= nb; k++) {
    const tgt = t0 + k * CHUNK_SEC * 1000.0;
    edges.push(bisectLeft(f.times, tgt));
  }
  const out = [];
  for (let k = 0; k < nb; k++) {
    const a = edges[k];
    const b = edges[k + 1];
    if (b - a < 25) continue;
    const sub = _sliceFeatures(f, a, b);
    const sc = rawScores(sub);
    // Python max(items, key=...) 返回**第一个**最大值（并列时按插入顺序）
    let topName = null;
    let topVal = -Infinity;
    for (const nm of KT_NAMES) {
      const v = sc[nm];
      if (v > topVal) { topVal = v; topName = nm; }
    }
    if (topVal < 0.22) continue;
    out.push([topName, (b - a) / n]);
  }
  return out;
}

/** keytype.py:298 _grade_int —— 显示用整数段位：<10.5 段时取四舍五入整数；
 *  Alpha+ 一律视为高阶（永不跳过键型）。 */
function _gradeInt(dan) {
  if (dan === null || dan === undefined) return 99;
  if (dan < 10.5) return pyInt(Math.floor(dan + 0.5));
  return 99;
}

/**
 * keytype.py:307 classify —— 把 Features 归入四类键型之一（可带次要类型 / 混合标记）。
 * @param {Features} f
 * @param {number|null} dan 段位（用于 speedrel 相对量与低段位跳过）
 */
export function classifyKeytype(f, dan = null) {
  // 段位 6 及以下（显示整数 ≤6）难度过简单，难以分化键型 → 不标定
  if (dan !== null && dan !== undefined && _gradeInt(dan) <= 6) {
    return {
      primary: '-', secondary: null, weak: false,
      mixed: false, share: {}, scores: {}, strength: {},
      detail: {}, evidence: evidence(f, dan), skip: true,
    };
  }

  const ev = evidence(f, dan);
  const sixthFrac = ev.sixth_frac;
  const sixthSus = ev.sixth_sustained_frac;

  // ---- 大串：持续等间隔长串（从头到尾的 1/4），少 1/6 ----
  const u = member(ev.uniform, 0.06, 0.38);
  const r3 = member(ev.run3, 0.10, 0.30);
  let sStream = u * (0.55 + 0.45 * r3);
  sStream *= (1.0 - 0.5 * member(sixthFrac, 0.06, 0.18));   // 太多 1/6 就不是纯大串
  sStream = Math.min(1.0, sStream);

  // ---- 高速：相对同段位更快，且 1/4 / 1/8 为主、少 1/6 ----
  const sp = member(ev.speedrel, 1.00, 1.22);
  const sSpeed = sp * (1.0 - member(sixthFrac, 0.05, 0.15));

  // ---- 协调：颜色切换 + 节奏错落（读谱型），而非细分混排 ----
  const cb = member(ev.cbits, 0.80, 0.95);
  const tb = member(ev.tbits, 0.90, 1.80);
  let sCoord = cb * tb;
  sCoord *= (1.0 - member(ev.gridmix, 0.40, 0.70));       // 1/4+1/6 明显混杂时应判复合

  // ---- 复合：1/4 与 1/6 明显混杂（小复合=零星 1/6；大复合=更大程度混杂）----
  let sComp = member(sixthFrac, 0.02, 0.14);
  if (ev.g14 < 0.30) sComp *= 0.3;                        // 没有 1/4 主导则不算复合
  const compKind = (ev.gridmix >= 0.45 || sixthSus >= 0.02) ? '大复合' : '小复合';

  const cands = [['大串', sStream], ['高速', sSpeed], ['协调', sCoord], [compKind, sComp]];
  // Python: cands.sort(key=lambda x: -x[1]) —— 稳定降序，并列时保持插入顺序
  cands.sort((a, b) => cmpDesc(a[1], b[1]));
  const pName = cands[0][0];
  const p = cands[0][1];
  const sName = cands.length > 1 ? cands[1][0] : null;
  const s = cands.length > 1 ? cands[1][1] : 0.0;

  // ---- 混合：跨段落多键型 ----
  const chunks = _chunkTypes(f);
  let mixed = false;
  let share = {};
  if (chunks.length) {
    for (const [t, w] of chunks) share[t] = (share[t] || 0) + w;
    const tot = pysum(Object.values(share)) || 1.0;
    const norm = {};
    for (const k of Object.keys(share)) norm[k] = share[k] / tot;
    share = norm;
    const strong = Object.keys(share).filter((k) => share[k] >= 0.20);
    mixed = strong.length >= 3;
  }

  const weak = p < 0.25;
  let secondary = null;
  if (sName && s >= 0.6 * p && s >= 0.18) secondary = sName;

  const strength = {};
  for (const [nm, v] of cands) strength[nm] = v;

  return {
    primary: pName, secondary, weak,
    mixed, share,
    scores: {}, strength, detail: {}, evidence: ev, skip: false,
  };
}

/** keytype.py:369 label —— 键型结果 → 显示字符串 */
export function labelKeytype(res) {
  if (res.skip) return '-';
  if (res.mixed) return '混合';
  if (res.weak) return '常规';
  const p = res.primary;
  const s = res.secondary;
  return p + (s ? `,${s}` : '');
}

// ====================================================================
// 5. evaluate.py（仅 mod 处理部分）—— mod 倍速 + 主入口
// ====================================================================

// evaluate.py:42  HT = Half Time = 0.75×速度；DT / NC = Double Time = 1.5×速度
const MOD_SPEED = { HT: 0.75, DT: 1.5, NC: 1.5 };

/** evaluate.py:45 mod_speed —— mods 字符串 → 速度倍率（1.0 表示无倍速 mod） */
export function modSpeed(mods) {
  if (!mods) return 1.0;
  const m = String(mods).toUpperCase();
  if (m.includes('DT') || m.includes('NC')) return MOD_SPEED.DT;   // DT / NC 优先（同为加速）
  if (m.includes('HT')) return MOD_SPEED.HT;
  return 1.0;
}

/** 供 evaluateDan 内部与测试使用：默认模型（锚点 + 参数来自 dan_calibration.js） */
export function defaultModel() {
  return new Model(DAN_ANCHORS.map((p) => [p[0], p[1]]));
}

/**
 * evaluate.py:107 evaluate_beatmap —— 主入口。
 *
 * mod 处理移植自 evaluate.py 的 SpeedModBeatmap（evaluate.py:58-93），
 * 关键不变性：
 *   * 同时缩放「音符时间」与「节拍长度」→ 间隔相对节拍的比例不变，
 *     因此 1/4、1/6 栅格判定、换色、同手连打等**键型特征全部不变**；
 *   * 绝对时间密度按倍速线性变化 → NPS / 包络密度变化 → **段位随之升降**。
 *   这正是物理直觉：加速让同一套 pattern 更难打，但 pattern 本身没变。
 *
 * @param {object} o
 * @param {{time:number,colour:number,big:boolean}[]} o.notes  已排序的 Hit 音符
 * @param {((t:number)=>number)|null} [o.beatLengthAt] 该时刻拍长(ms)；缺省 = 无节拍信息
 * @param {((t:number)=>number)|null} [o.svAt]           该时刻 scroll speed；缺省 = 无绿线
 * @param {string} [o.mods]  如 '' / 'DT' / 'HDHR'
 */
export function evaluateDan(o) {
  const opts = o || {};
  const srcNotes = opts.notes || [];
  const srcBeat = typeof opts.beatLengthAt === 'function' ? opts.beatLengthAt : null;
  const srcSv = typeof opts.svAt === 'function' ? opts.svAt : null;
  const mods = opts.mods || '';

  const mult = modSpeed(mods);

  // ---- SpeedModBeatmap 等价物 ----
  let notes = srcNotes;
  let beatLengthAt = srcBeat;
  let svAt = srcSv;
  if (mult !== 1.0) {
    notes = srcNotes.map((t) => ({ time: t.time / mult, colour: t.colour, big: t.big }));
    if (srcBeat) {
      // 查询时刻 t（已缩放）对应原曲位置 t*m，其 beat_length 也需除以 m
      beatLengthAt = (t) => srcBeat(t * mult) / mult;
    }
    // SV 是相对节拍的比率，不受时间缩放影响
    if (srcSv) svAt = (t) => srcSv(t * mult);
  }

  const model = defaultModel();
  const [scalar, dan, f] = model.score(notes, beatLengthAt, svAt, opts.od);
  const kt = classifyKeytype(f, dan);
  const d5 = f.densityPercentiles(1000.0);

  return {
    // 本实现不解析 .osu —— 元信息一律空串（调用方若已解析可自行覆盖）
    artist: opts.artist || '',
    title: opts.title || '',
    version: opts.version || '',
    creator: opts.creator || '',
    mods: String(mods).toUpperCase(),
    speed_mult: mult,
    dan: pyRound(dan, 2),
    grade: gradeName(dan),
    keytype: labelKeytype(kt),
    notes: notes.length,
    duration_ms: pyInt(pyRound(f.duration)),
    nps: pyRound(f.npsGlobal, 2),
    dense: [pyRound(d5[0], 1), pyRound(d5[1], 1), pyRound(d5[2], 1)],
    // 未四舍五入的原始值，供对拍测试与精度排查使用
    _scalar: scalar,
    _dan: dan,
    _features: f,
    _keytype: kt,
  };
}

/** evaluateDan 的轻量包装：同 Python Features(notes, meta)，便于单测 */
export function computeFeatures(notes, meta) {
  return new Features(notes, meta);
}