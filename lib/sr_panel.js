/* ==========================================================================
 * sr_panel.js —— 难度与 pp 信息面板的**纯计算 + 格式化**层
 *
 * 职责：把 difficulty.js / pp.js 的原始输出整理成可直接渲染的结构。
 *本文件**不含任何 DOM 操作** —— 渲染由 content.js 负责，
 * 这样后续整合时只需换渲染层，不用动计算逻辑。
 *
 * 用法：
 *   import { buildDifficultyReport } from './sr_panel.js';
 *   const rep = buildDifficultyReport(bm, { mod: 'None', acc: 0.98 });
 *   // rep.summary / rep.skills / rep.mods / rep.pp / rep.sections
 *
 * 与 Python 侧 taiko-sr-analysis 的对应关系：
 *   diffcalc.py  → lib/difficulty.js
 *   ppcalc.py    → lib/pp.js
 *   mod_analysis.py → 本文件的 formatMods()
 * ========================================================================== */

import {
  calculateStarRating, calculateDifficulty, convertBeatmap, applyMod,
  TAIKO_MODS, DIFFCALC_VERSION, rescale, getAdjustedDisplayDifficulty,
} from './difficulty.js';
import { calculatePp, greatWindow } from './pp.js';

/** 所有单 mod（按建议展示顺序） */
export const SINGLE_MODS = [
  'None', 'EZ', 'HT', 'HR', 'DT', 'NC',
  'HD', 'FL', 'CL', 'NF',
];

/** 常用组合 */
export const COMBO_MODS = [
  'HD+DT', 'HR+DT', 'FL+HD', 'CL+HD', 'EZ+HD', 'CL+EZ+HD', 'DT+HD+FL',
];

/** 可选的准确率预设（用于 pp 展示） */
export const ACC_PRESETS = [
  { label: 'SS', acc: 1.00 },
  { label: 'acc98', acc: 0.98 },
  { label: 'acc95', acc: 0.95 },
  { label: 'acc90', acc: 0.90 },
];

/* ---------------------------------------------------------------- 工具 */

function fmt(x, digits = 2) {
  if (x === null || x === undefined || Number.isNaN(x)) return '—';
  return x.toFixed(digits);
}

function pct(x, digits = 1) {
  if (x === null || x === undefined || Number.isNaN(x)) return '—';
  return (x * 100).toFixed(digits) + '%';
}

/** 秒 → m:ss */
function fmtDuration(ms) {
  if (!ms || ms < 0) return '—';
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m + ':' + String(s).padStart(2, '0');
}

/**
 * 把 great 比例拆成 great/ok/meh/miss 四档
 * taiko 的实际计分：great 是主要判定，ok/meh 是部分命中，miss 完全漏掉。
 * 这里按「非 great 部分里 70% 记 ok、30% 记 meh」的惯例拆分（与 Python 基准一致）。
 */
function splitHits(totalHits, acc, miss = 0) {
  const usable = Math.max(0, totalHits - miss);
  const great = Math.round(usable * acc);
  const rest = usable - great;
  const ok = Math.round(rest * 0.7);
  const meh = rest - ok;
  return { great, ok, meh, miss };
}

/* ------------------------------------------------------------ 报告构建 */

/**
 * 构建一份完整的难度 + pp 报告
 *
 * @param {object} bm osu_parser.js 的 parseOsu 返回值
 * @param {object} [opts]
 * @param {string} [opts.mod='None']       主展示的 mod
 * @param {number} [opts.acc=0.98]        pp 用的 great 比例
 * @param {number} [opts.miss=0]          pp 用的 miss 数
 * @param {boolean} [opts.withMods=false]  是否计算全部 mod 对比表
 * @returns {object|null}
 */
export function buildDifficultyReport(bm, opts = {}) {
  const mainMod = opts.mod || 'None';
  const acc = opts.acc === undefined ? 0.98 : opts.acc;
  const miss = opts.miss || 0;
  const withMods = !!opts.withMods;

  if (!bm || !bm.notes || bm.notes.length === 0) return null;

  /* 主 mod 的结果 */
  const main = calculateStarRating(bm, mainMod);
  if (!main) return null;

  /* 转换信息与物件统计 */
  const conv = convertBeatmap(bm);
  const isConvert = bm.mode !== 1;

  /* Hit 总数：用于 pp */
  const hitCount = conv.objects.filter(o => o.isHit).length;
  const totalHits = conv.objects.length;    /* C# 的 totalHits = great+ok+meh+miss，即全部物件 */

  /* 各 mod 下的 SR（用于 mod 对比表） */
  let mods = null;
  if (withMods) {
    mods = formatMods(bm, acc, miss);
  }

  /* 主 mod 的 pp */
  const hits = splitHits(totalHits, acc, miss);
  const mSpec = applyMod(conv.controlInfo, conv.sliderMultiplier, mainMod);
  const pp = calculatePp({
    sr: main.starRating,
    rhythmDifficulty: main.rhythmDifficulty,
    monoStaminaFactor: main.monoStaminaFactor,
    consistencyFactor: main.consistencyFactor,
    totalHits,
    od: mSpec.controlInfo.overallDifficulty,
    clockRate: mSpec.clockRate,
    great: hits.great, ok: hits.ok, meh: hits.meh, miss: hits.miss,
    hidden: mSpec.hidden, flashlight: mSpec.flashlight,
    classic: mSpec.classic, easy: mSpec.easy,
    isConvert,
  });

  /* 谱面基本信息 */
  const notes = bm.notes;
  const durationMs = notes.reduce((e, n) => Math.max(e, n.endTime || n.time), 0);

  /* mod 后的显示难度（GetAdjustedDisplayDifficulty） */
  const disp = main.display || getAdjustedDisplayDifficulty(
    bm.od === undefined ? 5 : bm.od, bm.hp === undefined ? 5 : bm.hp, mainMod);

  return {
    version: DIFFCALC_VERSION,
    meta: {
      title: bm.title || '(无标题)',
      artist: bm.artist || '(无作者)',
      difficulty: bm.version || '(无难度名)',
      creator: bm.creator || '',
      beatmapId: bm.beatmapId,
      beatmapSetId: bm.beatmapSetId,
      mode: bm.mode,
      modeName: MODE_NAMES[bm.mode] || ('Mode ' + bm.mode),
      isConvert,
      durationMs,
      duration: fmtDuration(durationMs),
      hp: bm.hp, od: bm.od, cs: bm.cs, ar: bm.ar,
      sliderMultiplier: bm.sliderMultiplier,
      sliderTickRate: bm.sliderTickRate,
    },

    /* ---- 勾选 mod 后实际显示/生效的难度参数（渲染直接用这一组） ---- */
    display: {
      mod: mainMod,
      od: disp.od,
      hp: disp.hp,
      displayOd: disp.displayOd,
      displayOdLazer: disp.displayOdLazer,
      rate: disp.rate,
      scrollSpeed: disp.scrollSpeed,
      greatWindow: disp.greatWindow,
      greatWindowFloor: disp.greatWindowFloor,
      okWindow: disp.okWindow,
      missWindow: disp.missWindow,
      /* 文本 */
      odText: fmt(disp.od, 2),
      hpText: fmt(disp.hp, 2),
      displayOdText: fmt(disp.displayOd, 2),
      greatWindowText: fmt(disp.greatWindow, 1),
      greatWindowFloorText: fmt(disp.greatWindowFloor, 1),
      okWindowText: fmt(disp.okWindow, 1),
      missWindowText: fmt(disp.missWindow, 1),
      /* OD 是否因速率 mod 而突破 10（渲染时需要特殊标注） */
      displayOdExceeds10: disp.displayOd > 10.0000001,
    },

    counts: {
      objects: conv.objects.length,
      hits: hitCount,
      drumrolls: conv.objects.filter(o => !o.isHit && o.constructor.name === 'DrumRoll').length,
      swells: conv.objects.filter(o => !o.isHit && o.constructor.name === 'Swell').length,
      notes: notes.length,
      don: notes.filter(n => n.kind === 'don').length,
      kat: notes.filter(n => n.kind === 'kat').length,
      big: notes.filter(n => n.kind === 'big').length,
    },

    /* 主 mod 的难度属性 */
    difficulty: {
      mod: mainMod,
      starRating: main.starRating,
      rhythmDifficulty: main.rhythmDifficulty,
      readingDifficulty: main.readingDifficulty,
      colourDifficulty: main.colourDifficulty,
      staminaDifficulty: main.staminaDifficulty,
      mechanicalDifficulty: main.mechanicalDifficulty,
      monoStaminaFactor: main.monoStaminaFactor,
      consistencyFactor: main.consistencyFactor,
      staminaTopStrains: main.staminaTopStrains,
      skills: main.skills,
    },

    /* 四 skill 的格式化明细（供 UI 直接渲染） */
    skills: formatSkillBreakdown(main, bm),

    /* mod 对比表 */
    mods,

    /* pp */
    pp: {
      mod: mainMod,
      acc,
      accLabel: ACC_PRESETS.find(a => Math.abs(a.acc - acc) < 1e-6)?.label || pct(acc),
      miss,
      hits,
      greatWindow: greatWindow(mSpec.controlInfo.overallDifficulty) / mSpec.clockRate,
      eur: pp.eur,
      difficultyPP: pp.difficulty,
      accuracyPP: pp.accuracy,
      totalPP: pp.total,
      /* 各准确率下的 pp 曲线 */
      curve: ACC_PRESETS.map(a => {
        const h = splitHits(totalHits, a.acc, miss);
        const r = calculatePp({
          sr: main.starRating,
          rhythmDifficulty: main.rhythmDifficulty,
          monoStaminaFactor: main.monoStaminaFactor,
          consistencyFactor: main.consistencyFactor,
          totalHits,
          od: mSpec.controlInfo.overallDifficulty,
          clockRate: mSpec.clockRate,
          great: h.great, ok: h.ok, meh: h.meh, miss: h.miss,
          hidden: mSpec.hidden, flashlight: mSpec.flashlight,
          classic: mSpec.classic, easy: mSpec.easy,
          isConvert,
        });
        return { label: a.label, acc: a.acc, eur: r.eur, totalPP: r.total };
      }),
    },

    /* 展示用的预格式化字符串 */
    text: {
      sr: fmt(main.starRating, 2),
      rhythm: fmt(main.rhythmDifficulty, 2),
      reading: fmt(main.readingDifficulty, 2),
      colour: fmt(main.colourDifficulty, 2),
      stamina: fmt(main.staminaDifficulty, 2),
      mechanical: fmt(main.mechanicalDifficulty, 2),
      cf: fmt(main.consistencyFactor, 3),
      msf: fmt(main.monoStaminaFactor, 4),
      totalPP: fmt(pp.total, 0),
      diffPP: fmt(pp.difficulty, 0),
      accPP: fmt(pp.accuracy, 0),
      eur: fmt(pp.eur, 1),
    },
  };
}

const MODE_NAMES = {
  0: 'osu!（点击）', 1: 'osu!taiko', 2: 'osu!catch',
  3: 'osu!mania', 4: 'osu!mania（catch）', 5: 'osu!mania（pass）', 6: 'osu!mania',
};

/* ---------------------------------------------------- 四 skill 明细格式化 */

/**
 * 把四个 skill 的原始值整理成带占比的展示结构
 *
 * 提供三套口径：
 *  1. ratio    —— 加权值 / 四者之和（最朴素，仅作参考）
 *  2. energy   —— **p-norm 能量分解**，与官方合并公式同源，四项之和恒为 1
 *  3. looShare —— **leave-one-out 星数边际贡献**归一化，回答「少了它星数掉多少」
 *
 * energy 与 looShare 的差别正是 p=2/p=1.5 范数的非线性：
 * 范数会让大分量的相对权重被压低，所以两者排序可能不同。
 */
export function formatSkillBreakdown(result, bm) {
  const d = result;
  const sum = d.rhythmDifficulty + d.readingDifficulty
    + d.colourDifficulty + d.staminaDifficulty;

  const rows = [
    { key: 'stamina', name: '体力 Stamina', en: 'Stamina', color: '#e05a5a' },
    { key: 'colour', name: '颜色 Colour', en: 'Colour', color: '#5ad0e0' },
    { key: 'rhythm', name: '节奏 Rhythm', en: 'Rhythm', color: '#e0c05a' },
    { key: 'reading', name: '读谱 Reading', en: 'Reading', color: '#9a7ae0' },
  ];

  const values = {
    stamina: d.staminaDifficulty,
    colour: d.colourDifficulty,
    rhythm: d.rhythmDifficulty,
    reading: d.readingDifficulty,
  };
  const raws = {
    stamina: d.skills.staminaRaw,
    colour: d.skills.colourRaw,
    rhythm: d.skills.rhythmRaw,
    reading: d.skills.readingRaw,
  };

  /* ---- 贡献占比（可能为 null：调用方跳过了贡献计算） ---- */
  const sc = d.skills.skillContributions || null;
  const energy = sc ? sc.energy : null;
  const loo = sc ? sc.loo : null;
  const solo = sc ? sc.solo : null;
  const looSum = sc ? sc.looSum : 0;

  return {
    total: sum,
    hasContributions: !!sc,
    rows: rows.map(r => ({
      ...r,
      value: values[r.key],
      raw: raws[r.key],
      ratio: sum > 0 ? values[r.key] / sum : 0,
      ratioText: sum > 0 ? pct(values[r.key] / sum, 1) : '—',
      valueText: fmt(values[r.key], 3),
      rawText: fmt(raws[r.key], 2),
      /* 口径 2：p-norm 能量占比 */
      energy: energy ? energy[r.key] : null,
      energyText: energy ? pct(energy[r.key], 1) : '—',
      /* 口径 3：leave-one-out */
      loo: loo ? loo[r.key] : null,
      looText: loo ? fmt(loo[r.key], 3) : '—',
      looShare: loo && looSum > 0 ? loo[r.key] / looSum : null,
      looShareText: loo && looSum > 0 ? pct(loo[r.key] / looSum, 1) : '—',
      soloSr: solo ? solo[r.key] : null,
      soloSrText: solo ? fmt(solo[r.key], 2) : '—',
    })),
    /* 派生指标 */
    extras: [
      { name: '机械难度 Mechanical', value: d.mechanicalDifficulty, text: fmt(d.mechanicalDifficulty, 3) },
      { name: '一致性 Consistency', value: d.consistencyFactor, text: fmt(d.consistencyFactor, 4) },
      { name: '单色系数 MSF', value: d.monoStaminaFactor, text: fmt(d.monoStaminaFactor, 5) },
      { name: '体力峰值计数', value: d.staminaTopStrains, text: fmt(d.staminaTopStrains, 1) },
      { name: '图案乘数', value: d.skills.patternMultiplier, text: fmt(d.skills.patternMultiplier, 4) },
      { name: '长度加成', value: d.skills.strainLengthBonus, text: fmt(d.skills.strainLengthBonus, 4) },
    ],
    /* 贡献占比汇总（UI 可直接画堆叠条） */
    contributions: sc ? {
      energy,
      energyText: Object.fromEntries(SKILL_KEYS.map(k => [k, pct(energy[k], 1)])),
      loo,
      looSum,
      looSumText: fmt(looSum, 3),
      looShare: Object.fromEntries(SKILL_KEYS.map(k => [
        k, looSum > 0 ? loo[k] / looSum : 0])),
      looShareText: Object.fromEntries(SKILL_KEYS.map(k => [
        k, looSum > 0 ? pct(loo[k] / looSum, 1) : '—'])),
      solo,
      /* 四项 solo 星数之和 ≥ 完整星数（rescale 是对数函数 ⇒ 次可加） */
      soloSum: SKILL_KEYS.reduce((a, k) => a + solo[k], 0),
      note: 'energy 为 p-norm 能量占比（和恒为 1）；looShare 为屏蔽该 skill 后的星数损失占比。',
    } : null,
  };
}

const SKILL_KEYS = ['rhythm', 'reading', 'colour', 'stamina'];

/* ------------------------------------------------------------ mod 对比表 */

/**
 * 计算全部 mod 的 SR + pp，用于「mod 影响」面板
 * @param {object} bm parseOsu 结果
 * @param {number} acc great 比例
 * @param {number} miss miss 数
 * @returns {object}
 */
export function formatMods(bm, acc = 0.98, miss = 0) {
  const conv = convertBeatmap(bm);
  const totalHits = conv.objects.length;
  const isConvert = bm.mode !== 1;
  const base = calculateStarRating(bm, 'None');

  const all = [...SINGLE_MODS, ...COMBO_MODS];
  const rows = [];
  const category = categorizeMods();

  for (const mod of all) {
    /* mod 表只要 SR/pp，不需要贡献占比（省 5 倍耗时） */
    const r = calculateStarRating(bm, mod, { withContributions: false });
    if (!r) continue;
    const mSpec = applyMod(conv.controlInfo, conv.sliderMultiplier, mod);
    const disp = r.display || getAdjustedDisplayDifficulty(
      bm.od === undefined ? 5 : bm.od, bm.hp === undefined ? 5 : bm.hp, mod);
    const hits = splitHits(totalHits, acc, miss);
    const pp = calculatePp({
      sr: r.starRating,
      rhythmDifficulty: r.rhythmDifficulty,
      monoStaminaFactor: r.monoStaminaFactor,
      consistencyFactor: r.consistencyFactor,
      totalHits,
      od: mSpec.controlInfo.overallDifficulty,
      clockRate: mSpec.clockRate,
      great: hits.great, ok: hits.ok, meh: hits.meh, miss: hits.miss,
      hidden: mSpec.hidden, flashlight: mSpec.flashlight,
      classic: mSpec.classic, easy: mSpec.easy,
      isConvert,
    });
    rows.push({
      mod,
      starRating: r.starRating,
      srText: fmt(r.starRating, 2),
      srDelta: base ? r.starRating - base.starRating : 0,
      srDeltaPct: base ? (r.starRating / base.starRating - 1) : 0,
      /* ---- 渲染用：勾选后实际显示/生效的难度参数 ---- */
      od: mSpec.controlInfo.overallDifficulty,
      hp: disp.hp,
      displayOd: disp.displayOd,
      displayOdLazer: disp.displayOdLazer,
      displayOdExceeds10: disp.displayOd > 10.0000001,
      scrollSpeed: disp.scrollSpeed,
      greatWindow: disp.greatWindow,
      greatWindowFloor: disp.greatWindowFloor,
      okWindow: disp.okWindow,
      missWindow: disp.missWindow,
      clockRate: mSpec.clockRate,
      /* 文本 */
      odText: fmt(mSpec.controlInfo.overallDifficulty, 2),
      hpText: fmt(disp.hp, 2),
      displayOdText: fmt(disp.displayOd, 2),
      greatWindowText: fmt(disp.greatWindow, 1),
      /* ---- pp ---- */
      eur: pp.eur,
      diffPP: pp.difficulty,
      accPP: pp.accuracy,
      totalPP: pp.total,
      ppRatio: base ? pp.total / totalPPOf(base) : 0,
      changesSr: Math.abs(r.starRating - (base ? base.starRating : 0)) > 1e-9,
    });
  }

  /* totalPPOf 需要在 base 上重算一次 —— base 只有 SR，没有 pp */
  function totalPPOf(baseResult) {
    const hits0 = splitHits(totalHits, acc, miss);
    const m0 = applyMod(conv.controlInfo, conv.sliderMultiplier, 'None');
    const p = calculatePp({
      sr: baseResult.starRating,
      rhythmDifficulty: baseResult.rhythmDifficulty,
      monoStaminaFactor: baseResult.monoStaminaFactor,
      consistencyFactor: baseResult.consistencyFactor,
      totalHits,
      od: m0.controlInfo.overallDifficulty,
      clockRate: m0.clockRate,
      great: hits0.great, ok: hits0.ok, meh: hits0.meh, miss: hits0.miss,
      hidden: m0.hidden, flashlight: m0.flashlight,
      classic: m0.classic, easy: m0.easy,
      isConvert,
    });
    return p.total;
  }

  /* 派生统计：按流速分组（对应论文 2.7 节的发现） */
  const effBpmStats = effectiveBpmStats(bm);
  const hrRow = rows.find(r => r.mod === 'HR');
  const ezRow = rows.find(r => r.mod === 'EZ');
  const dtRow = rows.find(r => r.mod === 'DT');

  return {
    acc, miss,
    rows,
    category,
    base: base ? { sr: base.starRating, srText: fmt(base.starRating, 2) } : null,
    speedInsight: effBpmStats && base ? buildSpeedInsight(effBpmStats, base, hrRow, ezRow) : null,
    /* 显示难度随 mod 的变化 —— 渲染时用来更新 OD/HP 显示 */
    displayInsight: buildDisplayInsight(rows),
  };
}

/**
 * 汇总「勾选 mod 后显示难度怎么变」
 * —— HP 变化（HR ×1.4 / EZ ×0.5）与显示 OD 突破 10 的情况（DT/NC + 高 OD）
 */
function buildDisplayInsight(rows) {
  const base = rows.find(r => r.mod === 'None');
  if (!base) return null;
  const changed = rows.filter(r => r.mod !== 'None' && (
    Math.abs(r.hp - base.hp) > 1e-9 || Math.abs(r.displayOd - base.displayOd) > 1e-9));
  const over10 = rows.filter(r => r.displayOdExceeds10);
  return {
    baseHp: base.hp,
    baseDisplayOd: base.displayOd,
    /* 改 HP 的 mod */
    hpMods: rows.filter(r => Math.abs(r.hp - base.hp) > 1e-9)
      .map(r => ({ mod: r.mod, hp: r.hp, hpText: r.hpText, factor: r.hp / base.hp })),
    /* 改显示 OD 的 mod（速率类） */
    odMods: rows.filter(r => Math.abs(r.displayOd - base.displayOd) > 1e-9)
      .map(r => ({
        mod: r.mod, displayOd: r.displayOd, displayOdText: r.displayOdText,
        greatWindow: r.greatWindow, greatWindowText: r.greatWindowText,
      })),
    /* 显示 OD > 10 的组合（渲染需特殊标注，例如 OD10+DT → 11.11） */
    over10: over10.map(r => ({
      mod: r.mod, displayOd: r.displayOd, displayOdText: r.displayOdText,
      greatWindowText: r.greatWindowText,
    })),
    changedCount: changed.length,
    note: over10.length
      ? `有 ${over10.length} 个组合的显示 OD 超过 10（判定窗口被速率 mod 压到 20ms 以下）。`
      : '所有组合的显示 OD 都在 0~10 区间内。',
  };
}

/**
 * mod 分类（对应论文 2.5.1 节）
 * 注意缩写：NF = No Fail（不是 Nightcore），NC = Nightcore。
 */
export function categorizeMods() {
  return {
    groups: [
      {
        name: '速率调整',
        en: 'Rate Adjust',
        color: '#e05a5a',
        mods: [
          { mod: 'DT', desc: '1.5× 提速。与 NC 完全等价，差异仅在音高。' },
          { mod: 'NC', desc: 'Nightcore，1.5× 提速且保持音高。与 DT 数值等价。' },
          { mod: 'HT', desc: '0.75× 减速。唯一降低星数的速率 mod。' },
        ],
      },
      {
        name: '难度调整',
        en: 'Difficulty Adjust',
        color: '#e0a05a',
        mods: [
          { mod: 'EZ', desc: 'OD ×0.5、SM ×0.8。判定窗口放宽，星数略降。' },
          { mod: 'HR', desc: 'OD ×1.4（上限 10）、SM ×1.4×4/3。星数提升主要来自流速。' },
        ],
      },
      {
        name: '容错',
        en: 'Fail Override',
        color: '#8ab4e0',
        mods: [
          { mod: 'NF', desc: 'No Fail。不会失败 —— 对星数与 pp 零影响。' },
        ],
      },
      {
        name: '纯附加',
        en: 'Pure Bonus',
        color: '#5ad07a',
        mods: [
          { mod: 'HD', desc: '隐藏。星数零影响；单 HD 仅 +2% 难度分，CL+HD 才给满 +10%。' },
          { mod: 'FL', desc: '闪光灯。星数零影响；按单色程度给 0~5% 难度分。' },
        ],
      },
      {
        name: '转换',
        en: 'Conversion',
        color: '#c07ad0',
        mods: [
          { mod: 'CL', desc: 'Classic。自身零加成，但解除 HD 的读谱惩罚。' },
        ],
      },
    ],
    /* 所有零 SR 影响的 mod —— UI 可据此提示用户 */
    zeroStarRatingMods: ['HD', 'FL', 'CL', 'NF'],
  };
}

/* ------------------------------------------------- 流速洞察（论文 2.7 节） */

/**
 * 统计谱面的 EffectiveBPM 分布
 * @returns {{median:number, p10:number, p90:number, mean:number, max:number}}
 */
export function effectiveBpmStats(bm) {
  if (!bm || !bm.notes) return null;
  const eff = [];
  const gsv = bm.sliderMultiplier || 1.4;
  for (const n of bm.notes) {
    if (n.kind === 'roll' || n.kind === 'spinner') continue;
    const bpm = bpmAt(bm, n.time);
    const sv = svForDifficulty(bm, n.time);
    eff.push(bpm * sv * gsv * 1.4);
  }
  if (eff.length === 0) return null;
  eff.sort((a, b) => a - b);
  return {
    median: eff[eff.length >> 1],
    p10: eff[Math.floor(eff.length * 0.10)],
    p90: eff[Math.floor(eff.length * 0.90)],
    mean: eff.reduce((a, b) => a + b, 0) / eff.length,
    max: eff[eff.length - 1],
  };
}

/**
 * 生成「流速阈值」提示 —— 对应论文 2.7 节的核心发现：
 * HR 的星数增益取决于基线流速是否跨越 Reading 的 S 型过渡区。
 */
function buildSpeedInsight(stats, base, hrRow, ezRow) {
  /* 理论最优基线：560 / 1.867 ≈ 300 */
  const OPTIMAL = 560 / (1.4 * 4 / 3);
  const m = stats.median;
  let zone, note;
  if (m < 350) {
    zone = 'low';
    note = '基线流速偏低，HR 后仍难以跨过读谱阈值 → 星数几乎不涨。';
  } else if (m < 620) {
    zone = 'sweet';
    note = '基线流速在增益峰值区间（约 450~600）→ HR 的星数涨幅最大。';
  } else {
    zone = 'high';
    note = '基线流速已过读谱饱和区 → HR 的星数涨幅有限（并非越快涨越多）。';
  }
  return {
    effBpmMedian: m,
    effBpmP10: stats.p10,
    effBpmP90: stats.p90,
    effBpmText: fmt(m, 0),
    optimalBase: OPTIMAL,
    zone,
    note,
    hrGainPct: hrRow ? hrRow.srDeltaPct * 100 : 0,
    ezLossPct: ezRow ? ezRow.srDeltaPct * 100 : 0,
    hrGainText: hrRow ? (hrRow.srDeltaPct >= 0 ? '+' : '') + (hrRow.srDeltaPct * 100).toFixed(2) + '%' : '—',
    ezLossText: ezRow ? (ezRow.srDeltaPct * 100).toFixed(2) + '%' : '—',
  };
}

/* 内部：BPM 查询（与 difficulty.js 相同语义） */
function bpmAt(bm, t) {
  let bl = 500;
  for (const tp of bm.timingPoints) {
    if (tp.time > t) break;
    if (tp.red && tp.beatLength > 0) bl = tp.beatLength;
  }
  return bl > 0 ? 60000 / bl : 0;
}

/* 内部：SV 查询 —— 红点重置为 1.0（与 difficulty.js 的 svAtLocal 相同） */
function svForDifficulty(bm, t) {
  /* 非原生 taiko：控制点来自转换器后处理（滑条位置），不是 timing point 绿线*/
  if (bm.scrollPoints && bm.scrollPoints.length) {
    const sp = bm.scrollPoints;
    if (t < sp[0][0]) return 1.0;
    let lo = 0, hi = sp.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (sp[mid][0] <= t) lo = mid; else hi = mid - 1;
    }
    return sp[lo][1];
  }
  const pts = bm.timingPoints;
  if (!pts || pts.length === 0) return 1.0;
  if (t < pts[0].time) return 1.0;
  let lo = 0, hi = pts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pts[mid].time <= t) lo = mid; else hi = mid - 1;
  }
  const tp = pts[lo];
  if (tp.red) return 1.0;
  const bl = Math.abs(tp.beatLength);
  return bl > 0 ? 100.0 / bl : 1.0;
}

/* ------------------------------------------------------------ 快捷 API */

/**
 * 一行摘要（适合放在窗口标题栏或 tooltip）
 * @example summarize(bm) // => "11.20★ | 体力 4.85 颜色 1.83 节奏 3.35 读谱 1.16"
 */
export function summarize(bm, mod = 'None') {
  const r = calculateStarRating(bm, mod);
  if (!r) return '（无法计算：非 taiko 谱或音符为空）';
  return `${fmt(r.starRating, 2)}★ | `
    + `体力 ${fmt(r.staminaDifficulty, 2)} `
    + `颜色 ${fmt(r.colourDifficulty, 2)} `
    + `节奏 ${fmt(r.rhythmDifficulty, 2)} `
    + `读谱 ${fmt(r.readingDifficulty, 2)}`;
}

/** 只取星数 */
export function starRatingOf(bm, mod = 'None') {
  const r = calculateStarRating(bm, mod);
  return r ? r.starRating : null;
}

/** 全部可用 mod 名 */
export function availableMods() {
  return [...SINGLE_MODS, ...COMBO_MODS];
}

export default {
  buildDifficultyReport,
  formatSkillBreakdown,
  formatMods,
  categorizeMods,
  effectiveBpmStats,
  getAdjustedDisplayDifficulty,
  summarize,
  starRatingOf,
  availableMods,
  SINGLE_MODS,
  COMBO_MODS,
  ACC_PRESETS,
};
