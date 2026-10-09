# Star Rating / PP 模块集成说明

给 `taiko-preview-web`（浏览器扩展）新增的 osu!taiko 难度与 pp 计算能力。

## 一句话

新增 3 个 ES module + 1 个数据层，**不改动任何现有文件的行为**，
`bridge.js` 只是多挂了 3 个 `window.OSU_TAIKO_*` 全局。

## 新增文件

| 文件 | 行数 | 作用 |
|---|---|---|
| `lib/difficulty.js` | ~1080 | Star Rating 计算（4 个 skill + 预处理 + rescale + mod 表）|
| `lib/pp.js` | ~300 | PP 计算（EUR + 难度分 + 准确度分 + mod 乘数）|
| `lib/sr_panel.js` | ~470 | **纯数据层**：把上面的输出整理成可直接渲染的结构 |
| `test/dump_python_baseline.py` | ~140 | 导出 Python 基准值 |
| `test/difficulty_parity.mjs` | ~140 | JS ↔ Python 对拍 |
| `dev/build_demo_data.mjs` | ~55 | 为 demo 页生成数据 |
| `dev/sr_panel_demo.html` | ~250 | 开发用预览页（展示面板效果）|

**修改的文件只有 1个**：`bridge.js`（多挂3 个模块）。

## 数据流

```
.osu 文本
   ↓ osu_parser.js（已有）
beatmap 对象 bm
   ↓ difficulty.js convertBeatmap(bm)
taiko 物件列表 + controlInfo
   ↓ difficulty.js calculateStarRating(bm, mod)
TaikoDifficultyAttributes
   ↓ pp.js calculatePp({...})
{ difficultyPP, accuracyPP, totalPP, eur }
   ↓ sr_panel.js buildDifficultyReport(bm, opts)   ← 唯一你需要的入口
report对象（纯数据，无DOM）
   ↓ content.js（待整合）
UI
```

## 快速上手

```js
// bridge.js 已把模块挂到 window（不需要 import）
const bm = window.OSU_TAIKO_PARSE.parseOsu(osuText);

const report = window.OSU_TAIKO_PANEL.buildDifficultyReport(bm, {
  mod: 'None',      // 'None' | 'EZ' | 'HD' | 'HR' | 'DT' | 'NC' | 'HT' | 'FL' | 'CL' | 'NF' |组合
  acc: 0.98,         // great 比例，用于 pp
  miss: 0,           // miss 数，用于 pp
  withMods: true,    // 是否计算 17 种 mod 的对比表（较慢）
});

report.text.sr          // "11.20"      ← 星数
report.skills.rows      // 四 skill 明细 + 占比（见下）
report.pp.totalPP       // 1534.27      ← 总 pp
report.pp.curve         // 各准确率下的 pp 曲线
report.mods.rows        // 17 种 mod 的 SR / pp 对比
report.mods.speedInsight // 流速阈值洞察（HR 为什么涨星/不涨星）
```

## report 结构

```js
{
  version: 20260706,             // diffcalc 版本号

  meta: {
    title, artist, difficulty, creator,
    beatmapId, beatmapSetId,
    mode, modeName, isConvert,
    durationMs, duration,        // duration是 '3:52' 格式
    hp, od, cs, ar, sliderMultiplier, sliderTickRate,
  },

  counts: {
    objects,      // 转换后的物件总数
    hits,         // Hit 数（进 mono/note 索引的）
    drumrolls,    // DrumRoll 数
    swells,       // Swell 数
    notes, don, kat, big,     // 按 .osu 原始类型统计
  },

  difficulty: {
    mod, starRating,
    rhythmDifficulty, readingDifficulty, colourDifficulty, staminaDifficulty,
    mechanicalDifficulty,
    monoStaminaFactor, consistencyFactor, staminaTopStrains,
    skills: { /* 原始 raw 值、权重、patternMultiplier 等 */ },
  },

  skills: {
    total,                // 四维度之和
    rows: [               // 按占比降序，已排序好
      { key, name, en, color, value, raw, ratio, ratioText, valueText, rawText },
    ],
    extras: [ { name, value, text }, ... ],   // 机械难度/一致性/MSF/体力峰值/图案乘数/长度加成
  },

  mods: {                   // withMods: true 时才有
    acc, miss,
    rows: [{
      mod, starRating, srText,
      srDelta, srDeltaPct,   // 相对 None 的绝对/相对变化
      od, clockRate, greatWindow, eur,
      diffPP, accPP, totalPP, ppRatio,
      changesSr,             // 该 mod 是否改变了星数
    }],
    category: {             // mod 分类（见下）
      groups: [{ name, en, color, mods: [{ mod, desc }] }],
      zeroStarRatingMods: ['HD', 'FL', 'CL', 'NF'],
    },
    base: { sr, srText },
    speedInsight: {         // 流速阈值洞察
      effBpmMedian, effBpmP10, effBpmP90, effBpmText,
      optimalBase,// 560 / 1.867 ≈ 300
      zone,               // 'low' | 'sweet' | 'high'
      note,               // 中文说明
      hrGainPct, ezLossPct, hrGainText, ezLossText,
    },
  },

  pp: {
    mod, acc, accLabel, miss,
    hits: { great, ok, meh, miss },
    greatWindow,           // ms（已除 clockRate）
    eur,                   // 预估不稳定率，null 表示无法计算
    difficultyPP, accuracyPP, totalPP,
    curve: [{ label, acc, eur, totalPP }, ... ],  // SS/98/95/90
  },

  text: {                   // 全部预格式化好的字符串，UI 直接用
    sr, rhythm, reading, colour, stamina, mechanical,
    cf, msf, totalPP, diffPP, accPP, eur,
  },
}
```

## mod 分类（论文 2.5.1 节，官方 C# 已验证）

| 类别 | Mod | 改 SR | 改判定窗口 | 机制 |
|---|---|---|---|---|
| **速率调整** | DT | 是 | 是 | 1.5× 提速 |
| | **NC** | 是 | 是 | 同 DT（**NF 不是 Nightcore**）|
| | HT | 是 | 是 | 0.75× 减速，唯一降 SR 的速率 mod |
| **难度调整** | EZ | 是 | 是 | OD ×0.5、SM ×0.8 |
| | HR | 是 | 是 | OD ×1.4(cap 10)、SM ×1.4×4/3 |
| **容错** | **NF** | **否** | 否 | No Fail，pp 零影响 |
| **纯附加** | HD | **否** | 否 | 单 HD 只给 +2% 难度分 |
| | FL | **否** | 否 | 按单色程度给 0~5% |
| **转换** | CL | **否** | 否 | 自身零加成，**解除 HD 的读谱惩罚**（CL+HD 给满 +10%）|

`TAIKO_MODS` 已导出，可用 `applyMod(controlInfo, sliderMultiplier, modName)` 手动取。

## 一致性验证

```bash
# 1. 导出 Python 基准
python test/dump_python_baseline.py# → test/python_baseline.json

# 2. 对拍
node test/difficulty_parity.mjs        # → 168/168 SR + 10/10 PP 通过
```

当前状态：

```
SR：168/168 通过（14 个难度 × 12 个 mod）
PP：10/10 通过
中位偏差 0，14 个难度里 6 个精确到小数点后 10 位
最大偏差 5.1e-3（Xavy's Extended Oni，5001 音符）
```

**偏差根因**（已定位，非算法差异）：
V8 的 `Math.cos` 与 CPython 的 libm 在**非整比值**（2/3、5/4、4/5）上实现不同，
`ratioDifficulty` 的 8 项cos⁴ 累加带入 ~1e-16 相对误差，
经数千个物件的 strain 累积后放大。**偏差与谱面规模成正比**。
同一份 JS 在任何浏览器上结果完全一致。

要彻底消除需移植 V8 的 fdlibm 实现，不建议。

## 开发预览页

```bash
node dev/build_demo_data.mjs      # 生成 dev/beatmaps.json
python -m http.server 8080# 需http 服务，file:// 下 fetch 被阻止
# 打开 http://localhost:8080/dev/sr_panel_demo.html
```

页面支持切换 mod / 准确率 / miss 数，实时重算全部难度。
**这个页面的卡片结构可以直接搬进 content.js** —— `sr_panel.js` 已把
数据与 DOM 完全解耦，页面里的 `card()` 函数就是纯模板。

## 整合建议（下一轮）

1. **先跑对拍**确认当前代码在你的 Node 版本下也一致（不同 V8 版本的
   `Math.cos` 可能有差异，但都在 1e-15 量级）。
2. 在 `content.js` 的 `buildPreview()` 里，`parseOsu` 之后调用
   `window.OSU_TAIKO_PANEL.buildDifficultyReport(bm, {...})`，
   把结果挂到 `state.diffReport`。
3. 渲染层可以：
   - 塞进现有的 `renderer.js` 信息栏（扩展现有两行三列统计）
   - 或在面板工具条加一个「难度」开关，做成可折叠的侧栏
4. `withMods: true` 较慢（每张谱 17 次完整计算），
   建议只在用户点开 mod 面板时才算。
5. 非 taiko 谱（`bm.mode !== 1`）`buildDifficultyReport` 返回 `null`，
   与现有的 Mode 守卫逻辑一致。

## 已知边界

- **转换谱**（Mode 0/2/3）的 `shouldConvertSliderToHits` 路径未复刻
  `NodeSamples` 逐节点取样，偏差 0.18~0.35 星。
  原生 taiko 谱（Mode 1）不受影响。扩展本身只渲染 Mode 1，所以碰不到。
- 大饼（Finish）里**同时带 clap/whistle** 的那些必须判为 Kat，
  `convertBeatmap` 已处理（`n.kind === 'big' && n.blue`）。
  实测 Thule 有 57 个大饼，其中 31 个带 Kat 位 —— 全当 Don 会让
  monoStreak 划分偏移。
- **SV 查询与渲染用的不同**：`osu_parser.svAt()` 是渲染版（红线不改变 SV），
  `difficulty.js` 内部的是难度版（**红线把 SV 重置为 1.0**）。
  实测 Otsukimi（2770 个 timing point）用错会让 reading_raw 从 161 偏到 230。

---

# 附录：显示难度与 skill 贡献占比

## 1. 显示难度（GetAdjustedDisplayDifficulty）

勾选 mod 时，**OD / HP / 判定窗口都会变**，渲染层必须用这一组值而不是谱面原值。

### 官方实现

`osu.Game.Rulesets.Taiko.TaikoRuleset.GetAdjustedDisplayDifficulty`：

```csharp
BeatmapDifficulty adjusted = base.GetAdjustedDisplayDifficulty(beatmapInfo, mods);
double rate  = ModUtils.CalculateRateWithMods(mods);
double great = IBeatmapDifficultyInfo.DifficultyRange(
                   adjusted.OverallDifficulty, TaikoHitWindows.GREAT_WINDOW_RANGE);
great /= rate;
adjusted.OverallDifficulty =
    (float)IBeatmapDifficultyInfo.InverseDifficultyRange(great, GREAT_WINDOW_RANGE);
```

`base` 版本只跑 `IApplicableToDifficulty` 的 `ApplyToDifficulty`，因此 **HP 会被 mod 改**：

| mod | HP | OD | SliderMultiplier |
|---|---|---|---|
| EZ | ×0.5 | ×0.5 | ×0.8 |
| HR | **min(×1.4, 10)** | min(×1.4, 10) | ×1.4×4/3 |
| DT / NC / HT | 不变 | 不变 | 不变 |
| HD / FL / CL / NF | 不变 | 不变 | 不变 |

> HR 的 HP 有 **10 上限**（`ModHardRock.ApplyToDifficulty`），原始 HP 7.5 时 HR 后是 10 而不是 10.5。

### 两种「显示 OD」口径

本项目同时输出两个值：

- **`displayOd`** —— osu! **stable** 的 apparent OD 口径（本项目采用）。
  great 判定窗口 < 20ms 时（即 OD 已到顶 10 且带速率 mod），
  用 `80 - 6 × displayOd = great` 反解出 >10 的值。
  两套公式在 OD=10 处相交（taiko `great(10)=20`，`80-6×10=20`），
  所以只在 <20ms 时启用是自洽的延拓。
  校验：`OD10 + DT` → great=13.333 → `displayOd = (80-13.333)/6 = 11.11`。

- **`displayOdLazer`** —— osu! **lazer** 官方口径，用 `InverseDifficultyRange`。
  官方单测 `TaikoRateAdjustedDisplayDifficultyTest` 断言：
  `OD5+HT → 1.11`、`OD5+DT → 8.89`、`rate=1` 时 OD 不变。**已全部复现。**

> ★ taiko 分支里 great 用的是**未取 floor** 的裸 `DifficultyRange`，
> 而 `TaikoHitWindows.WindowFor` 额外做了 `Math.Floor(x) - 0.5`。
> 官方注释说明了原因：floor 必须发生在 rate 换算**之前**，否则结果不准确。
> 所以 `greatWindow`（显示口径）与 `greatWindowFloor`（判定口径）**不可混用**。

### ★ `InverseDifficultyRange` 的元组陷阱

```csharp
GREAT_WINDOW_RANGE = new DifficultyRange(50, 35, 20)   // Min=50, Mid=35, Max=20
```

本项目为正向计算标定的是 `(50, 20, 0)`（`Mid=0`，走单段线性）。
两者**正向函数等价**（都是 `50 - 3×OD`），但 `Mid` 位置不同会让
`InverseDifficultyRange` **走错分支**，反解结果差好几个 OD。
所以反解必须用官方元组 `GREAT_WINDOW_RANGE_OFFICIAL = [50, 20, 35]`。

### API

```js
import { getAdjustedDisplayDifficulty } from './difficulty.js';

const d = getAdjustedDisplayDifficulty(bm.od, bm.hp, 'HR+DT');
// {
//   od: 9.8,                // mod 后的真实 OD
//   hp: 4.9,                // mod 后的真实 HP
//   displayOd: 11.04,       // 显示 OD（stable 口径）
//   displayOdLazer: 12.09,  // 显示 OD（lazer 口径）
//   rate: 1.5,
//   scrollSpeed: 1.8667,
//   greatWindow: 13.73,        // 显示口径（裸 range / rate）
//   greatWindowFloor: 13.0,    // 判定口径（floor 后 / rate）
//   okWindow: 33.67, missWindow: 47.0,
// }
```

`calculateStarRating()` 已自动把结果挂到 `r.display`，
`buildDifficultyReport()` 则整理成 `report.display`（含预格式化文本与
`displayOdExceeds10` 标志，UI 需据此特殊标注 >10 的显示值）。

`formatMods()` 的每行也带上了 `od / hp / displayOd / displayOdExceeds10 /
scrollSpeed / greatWindow{Text}`，`report.mods.displayInsight` 汇总了
「哪些 mod 改了 HP」「哪些组合显示 OD 超过 10」。

## 2. 四 skill 贡献占比

官方合并公式：

```
combined = Norm(2, Norm(1.5, colourPeak, staminaPeak), rhythmPeak, readingPeak)
StarRating = 10.43 × ln(combined × 1.4 / 8 + 1)
```

### 口径 A：`energy` —— p-norm 能量占比（推荐）

p-范数 `(Σ|xᵢ|^p)^(1/p)` 的「能量」`Σ|xᵢ|^p` 可按项**严格拆分**：

```
外层 p=2  ： E = inner² + rhythm² + reading²
内层 p=1.5： inner^1.5 = colour^1.5 + stamina^1.5
```

每项占比 = 其 p 次幂 / 总和，**四项之和恒为 1**。
这与官方公式完全同源，不是近似。

### 口径 B：`loo` / `looShare` —— leave-one-out 星数贡献

屏蔽某 skill（peak 置 0）后重算星数，差值即其**边际贡献**。
`solo` 则是只保留单个 skill 时的星数。

因 `rescale` 是对数函数，四项 `loo` 之和 **≥ 完整星数**（次可加性），
`looSum` 会小于 `starRating`（例：Thule 无 mod 时 `looSum=4.25` vs `SR=11.20`）。
所以 `looShare` 才是可比的「占比」。

### 为什么两个口径排序会不同

p=2/p=1.5 范数的非线性会**压低大分量的相对权重**。
例：Thule 无 mod 时 stamina 占 energy 49.3%、占 looShare 54.9%。

### API

```js
const rep = buildDifficultyReport(bm, { mod: 'HR+DT' });

rep.skills.contributions.energyText;
// { rhythm: '7.8%', reading: '18.7%', colour: '11.9%', stamina: '61.6%' }
rep.skills.contributions.looShareText;
// { rhythm: '5.4%', reading: '14.5%', colour: '11.4%', stamina: '68.8%' }
rep.skills.contributions.solo;
// { rhythm: 5.53, reading: 6.27, colour: 4.45, stamina: 9.37 }

rep.skills.rows[i].energy / .energyText / .loo / .looText / .looShare / .soloSr;
```

### 性能

贡献占比需要额外 9 次合并重算（4×leave-one-out + 4×solo + 1×基准），
约为纯 SR 计算的 **5 倍**耗时（4601 音符约 75ms）。
`calculateStarRating(bm, mod, { withContributions: false })` 可跳过，
`formatMods()` 默认已关闭，只有主展示的 mod 才计算。

## 3. ★ 已修复：JS 的 Math.round 与 C# 不一致

`SameRhythmHitObjectGrouping` 的 `modalDelta` 用了 `Math.round`，
但 **C# `Math.Round` 与 Python `round()` 都是 ToEven（银行家舍入）**：

```
Math.round(58.5) === 59    // JS：四舍五入到 +∞
Math.Round(58.5) === 58    // C#：ToEven
```

`.5` 处反向 → `modalDelta` 差 1ms → `hitObjectIntervalRatio` 偏 1.7%，
经 `ratioDifficulty` 放大后 **`rhythmRaw` 偏差 5%+**（22.75 vs 23.95）。

由于 rhythm 在合并范数里权重较低，最终 SR 只偏 0.005~0.14 星，
**此前一直被误判为「Math.cos 的 libm 尾数差异」**。
修复后 JS 与 Python 的 SR 最大偏差从 **5.1e-3 降到 2.45e-8**。

`difficulty.js` 已加 `roundToEven()`。注意 `layout.js` / `renderer.js` 里的
`Math.round` 只用于像素与布局，**不要改**。
