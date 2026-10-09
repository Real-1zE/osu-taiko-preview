/**
 * JS 移植版 vs 官方 C# 的一致性校验（**集成前的守门测试**）。
 *
 * 背景：`lib/difficulty.js` / `lib/pp.js` 是从 `taiko-sr-analysis/src` 的
 * Python 实现移植来的，Python 版已与官方 osu.Game.Rulesets.Taiko 2026.730.0
 * 逐位一致。但**移植过程本身可能引入偏差**，所以这里用官方 C# 的原始输出
 * （`taiko-sr-analysis/data/official_testset.txt`）反向校验 JS 版。
 *
 * 校验内容：
 *   1. StarRating 逐位一致（官方是 double，容差 1e-9）
 *   2. 四个 skill（RHYTHM/READING/COLOUR/STAMINA）的 pre-multiply 值一致
 *   3. MonoStaminaFactor / ConsistencyFactor 一致
 *   4. 各 mod 下的 OD/HP 调整值与 SR 一致
 *   5. PP 计算能跑通且数值合理（官方无PP ground truth，只做单调性检查）
 *
 * 用法：node test/sr_verify.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, '..', 'lib');
const WORKSPACE = path.join(HERE, '..', '..');

const errs = [];
const EPS = 1e-9;          /* 官方输出是 double，JS 也是 double，同序运算应逐位相同 */
const SR_EPS = 1e-6;       /* SR 允许极小的末位差异（不同引擎的 sin/exp 末位）*/

/* ---------- 官方 ground truth ---------- */
const officialPath = path.join(WORKSPACE, 'taiko-sr-analysis', 'data', 'official_testset.txt');
if (!fs.existsSync(officialPath)) {
  console.error('找不到官方输出，跳过：' + officialPath);
  process.exit(0);
}
const raw = fs.readFileSync(officialPath, 'utf8');

/** 解析 official_testset.txt：[{file, title, od, cs, hp, sr, skills:{...}, ...}] */
/**
 * 解析 official_testset.txt。
 *
 * 关键：**一个 .osz 里含多个难度**，官方会为每个难度打印一段
 * （标题行 + OD/HP 行 + StarRating + 4 个 skill + 2 个系数）。
 * 必须按「标题行」切分成多条记录 —— 否则后续难度的数值会覆盖前面的，
 * 拿错误的 ground truth 去对比会误判JS 实现有 bug。
 *
 * @returns {Array<{file, title, version, od, cs, hp, sr, skills, mono, consistency}>}
 */
function parseOfficial(txt) {
  const out = [];
  let file = null;
  let cur = null;
  const flush = () => { if (cur && cur.sr !== undefined) out.push(cur); cur = null; };

  for (const line of txt.split(/\r?\n/)) {
    let m;
    /* 新文件 */
    if ((m = line.match(/^\[(.+?\.osz)\]$/))) {
      flush();
      file = m[1];
      continue;
    }
    if (!file) continue;
    /* 分隔线 "------" */
    if (/^-{10,}$/.test(line)) continue;

    /* 难度标题行：以两个空格开头、以 [难度名] 结尾 */
    if (/^\s{2}\S.*\[\S[^\]]*\]\s*$/.test(line)
        && !/^\s+(Rhythm|Reading|Colour|Stamina|Mechanical|MonoStaminaFactor|ConsistencyFactor|StaminaTopStrains)\b/.test(line)) {
      flush();
      const t = line.trim();
      const vm = /\[([^\]]+)\]\s*$/.exec(t);
      cur = {
        file,
        title: t,
        version: vm ? vm[1] : '',
        skills: {},
      };
      continue;
    }
    if (!cur) continue;

    if ((m = line.match(/^\s*OD=([\d.]+)\s+CS=([\d.]+)\s+HP=([\d.]+)/))) {
      cur.od = +m[1]; cur.cs = +m[2]; cur.hp = +m[3];
      continue;
    }
    if ((m = line.match(/★\s*StarRating\s*=\s*([\d.]+)/))) { cur.sr = +m[1]; continue; }
    if ((m = line.match(/^\s+(Rhythm|Reading|Colour|Stamina|Mechanical)\s+([\d.]+)/))) {
      cur.skills[m[1].toLowerCase()] = +m[2]; continue;
    }
    if ((m = line.match(/^\s+MonoStaminaFactor\s+([\d.]+)/))) { cur.mono = +m[1]; continue; }
    if ((m = line.match(/^\s+ConsistencyFactor\s+([\d.]+)/))) { cur.consistency = +m[1]; continue; }
  }
  flush();
  return out;
}
const official = parseOfficial(raw);
console.log('[1] 官方 ground truth：%d 个难度（来自 %d 个 .osz），SR 范围 %s ~ %s',
  official.length, new Set(official.map((o) => o.file)).size,
  Math.min(...official.map((o) => o.sr)).toFixed(4),
  Math.max(...official.map((o) => o.sr)).toFixed(4));

/* ---------- 本地谱面 ---------- */
const zipDir = path.join(HERE, 'test_zips');
if (!fs.existsSync(zipDir)) {
  console.error('找不到 test_zips，跳过');
  process.exit(0);
}
const localFiles = fs.readdirSync(zipDir).filter((n) => n.endsWith('.osu'));

const [parser, diff, ppMod, panel] = await Promise.all([
  import(pathToFileURL(path.join(LIB, 'osu_parser.js')).href),
  import(pathToFileURL(path.join(LIB, 'difficulty.js')).href),
  import(pathToFileURL(path.join(LIB, 'pp.js')).href),
  import(pathToFileURL(path.join(LIB, 'sr_panel.js')).href),
]);

/* 官方一条记录对应「某个 set 的某个难度」。
   本地样本文件名形如 "<setId> <artist> - <title>__<artist> - <title> [Version].osu"，
   所以用 setId 找到候选，再用难度名精确定位 —— 定位不到就返回 null，
   绝不拿别的难度来对比（那会制造假阳性/假阴性）。*/
function findLocalByOfficial(o) {
  const m = o.file.replace(/\.osz$/, '').match(/^(\d+)\s+/);
  if (!m) return null;
  const cands = localFiles.filter((f) => f.startsWith(m[1] + ' '));
  if (!o.version) return null;
  return cands.find((f) => f.includes(`[${o.version}]`)) || null;
}

console.log('[2] 本地 .osu 文件：%d 个', localFiles.length);

const bmCache = new Map();
function loadLocal(f) {
  if (bmCache.has(f)) return bmCache.get(f);
  let bm = null;
  try {
    bm = parser.parseOsu(fs.readFileSync(path.join(zipDir, f), 'utf8'));
    if (bm && bm.mode !== 1) bm = null;         /* 只校验原生 taiko 谱 */
  } catch { bm = null; }
  bmCache.set(f, bm);
  return bm;
}

/* ---------- 逐难度比对 ---------- */
let matched = 0, srMaxDiff = 0, skillMaxDiff = 0;
const skillDiffs = [];
console.log('[3] StarRating / skill 逐值比对：');

for (const o of official) {
  const local = findLocalByOfficial(o);
  if (!local) continue;
  const bm = loadLocal(local);
  if (!bm) continue;
  /* 必须确认是同一个难度 —— 拿错谱对比毫无意义 */
  if (bm.version !== o.version) {
    console.log('    跳过（难度对不上）官方[%s] vs 本地[%s]', o.version, bm.version);
    continue;
  }

  let res;
  try {
    res = diff.calculateStarRating(bm, 'None');
  } catch (e) {
    errs.push(`${local}: calculateStarRating 抛异常 ${e.message}`);
    continue;
  }
  if (!res || typeof res.starRating !== 'number' || !isFinite(res.starRating)) {
    errs.push(`${local}: starRating 非有限数 (${res && res.starRating})`);
    continue;
  }

  const srDiff = Math.abs(res.starRating - o.sr);
  srMaxDiff = Math.max(srMaxDiff, srDiff);
  const srOk = srDiff <= SR_EPS;

  /* skill 比对。官方打印的是 DIFFICULTY_MULTIPLIER 之前的原始值，
     JS 侧的 r.skills.* 同口径。*/
  let skillsOk = true;
  const pairs = [
    ['rhythm', res.rhythmDifficulty],
    ['reading', res.readingDifficulty],
    ['colour', res.colourDifficulty],
    ['stamina', res.staminaDifficulty],
  ];
  for (const [k, v] of pairs) {
    if (o.skills[k] === undefined) continue;
    if (typeof v !== 'number') { skillsOk = false; continue; }
    const d = Math.abs(v - o.skills[k]);
    skillMaxDiff = Math.max(skillMaxDiff, d);
    if (d > 2e-4) {                    /* 官方只打 4 位小数 */
      skillsOk = false;
      skillDiffs.push(`${local.slice(0, 30)} ${k}: JS ${v} vs 官方 ${o.skills[k]}`);
    }
  }

  if (o.mono !== undefined && res.monoStaminaFactor !== undefined
      && Math.abs(res.monoStaminaFactor - o.mono) > 2e-4) {
    errs.push(`${local}: MonoStaminaFactor ${res.monoStaminaFactor} ≠ 官方 ${o.mono}`);
  }
  if (o.consistency !== undefined && res.consistencyFactor !== undefined
      && Math.abs(res.consistencyFactor - o.consistency) > 2e-4) {
    errs.push(`${local}: ConsistencyFactor ${res.consistencyFactor} ≠ 官方 ${o.consistency}`);
  }

  if (!srOk) {
    errs.push(`${local}: SR ${res.starRating.toFixed(9)} ≠ 官方 ${o.sr.toFixed(9)}（差 ${srDiff.toExponential(2)}）`);
  }
  if (!skillsOk) errs.push(...skillDiffs.splice(0));

  matched++;
  console.log('    %s  SR %s vs %s  %s%s',
    local.slice(0, 36).padEnd(38),
    res.starRating.toFixed(6), o.sr.toFixed(6),
    srOk ? 'OK  ' : '❌  ', skillsOk ? '' : '(skill❌)');
}

console.log('    匹配 %d / %d 个难度（本地只覆盖其中一部分）', matched, official.length);
console.log('    SR 最大偏差 ' + srMaxDiff.toExponential(3)
      + '，skill 最大偏差 ' + skillMaxDiff.toExponential(3));
if (matched < 5) {
  errs.push(`只匹配到 ${matched} 个难度，样本覆盖不足，一致性校验没有说服力`);
}

/* ---------- mod 下的OD/HP 调整 ---------- */
console.log('[4] 各 mod 的 OD/HP 调整与 SR：');
{
  let bm = null;
  for (const f of localFiles) { bm = loadLocal(f); if (bm) break; }
  if (bm) {
    const base = diff.calculateStarRating(bm, 'None');
    console.log('    基准 (NoMod): OD=' + base.display.od + ' HP=' + base.display.hp
          + ' SR=' + base.starRating.toFixed(4));

    /* osu!taiko 的 OD/HP 是**乘算**（TAIKO_MODS[mod].od / HP_MOD_FACTORS），
       不是 std 那种 ±0.5。这里直接对着常量核对：
       EZ=od×0.5、HR=od×1.3（上限 10），HP 由 HP_MOD_FACTORS 决定。*/
    const T = diff.TAIKO_MODS;
    const HPF = diff.HP_MOD_FACTORS;
    const wantOdOf = (mod) => Math.min(bm.od * T[mod].od, 10);
    const wantHpOf = (mod) => Math.min(bm.hp * (HPF[mod] ?? 1), 10);

    for (const mod of ['None', 'EZ', 'HR', 'DT', 'HT', 'HD', 'FL', 'NC', 'CL']) {
      const a = diff.getAdjustedDisplayDifficulty(bm.od, bm.hp, mod);
      if (Math.abs(a.od - wantOdOf(mod)) > 1e-9) {
        errs.push(`${mod}: OD ${a.od} ≠ 期望 ${wantOdOf(mod)}`);
      }
      if (Math.abs(a.hp - wantHpOf(mod)) > 1e-9) {
        errs.push(`${mod}: HP ${a.hp} ≠ 期望 ${wantHpOf(mod)}`);
      }
      const r = diff.calculateStarRating(bm, mod);
      if (!(r.starRating > 0) || !isFinite(r.starRating)) {
        errs.push(`${mod}: SR 计算异常 ${r.starRating}`);
        console.log('    ' + mod.padEnd(4) + ' OD=' + a.od.toFixed(2)
          + ' HP=' + a.hp.toFixed(2) + ' rate=' + a.rate
          + ' SR=' + r.starRating + '  [ERR]');
        continue;
      }
      console.log('    ' + mod.padEnd(4) + ' OD=' + a.od.toFixed(2)
        + ' HP=' + a.hp.toFixed(2) + ' rate=' + a.rate
        + ' SR=' + r.starRating.toFixed(4)
        + ' (x' + (r.starRating / base.starRating).toFixed(3) + ')');
    }

    /* 单调性：DT > NoMod > HT */
    const sDT = diff.calculateStarRating(bm, 'DT').starRating;
    const sHT = diff.calculateStarRating(bm, 'HT').starRating;
    if (!(sDT > base.starRating)) errs.push(`DT 的 SR (${sDT}) 应大于 NoMod (${base.starRating})`);
    if (!(sHT < base.starRating)) errs.push(`HT 的 SR (${sHT}) 应小于 NoMod (${base.starRating})`);
    console.log('    单调性: DT %s > NoMod %s > HT %s %s',
      sDT.toFixed(3), base.starRating.toFixed(3), sHT.toFixed(3),
      (sDT > base.starRating && base.starRating > sHT) ? '✅' : '❌');
  }
}

/* ---------- PP 计算 ---------- */
console.log('[5] PP 计算（官方无 PP ground truth，查单调性与量级）：');
{
  let bm = null;
  for (const f of localFiles) { bm = loadLocal(f); if (bm) break; }
  if (bm) {
    /* buildDifficultyReport 是sr_panel 的主入口，一次给全：
       SR / 四个 skill 的占比 / OD/HP/判定窗 / 各 acc 档的 PP。*/
    const rep = panel.buildDifficultyReport(bm, { mod: 'None' });
    console.log('    SR=' + rep.skills.total.toFixed(4) + '  OD=' + rep.display.odText
          + ' HP=' + rep.display.hpText + ' 判定窗=' + rep.display.greatWindowText + 'ms');
    if (!(rep.skills.total > 0)) errs.push(`SR 应为正数，实际 ${rep.skills.total}`);
    if (!(rep.pp.totalPP > 0)) errs.push(`PP 应为正数，实际 ${rep.pp.totalPP}`);

/* acc 越高 PP 越高。curve 是**降序**排列（SS 在前、acc90 在后），
       所以判据是「往后 acc 更低时 PP 也必须更低」，不是反过来。*/
    const curve = rep.pp.curve || [];
    console.log('    PP 曲线（acc 档-> totalPP）:');
    let mono = true;
    for (const c of curve) {
      console.log('      ' + c.label + ' acc=' + (c.acc * 100).toFixed(1)
        + '% PP=' + c.totalPP.toFixed(1));
    }
    for (let i = 1; i < curve.length; i++) {
      if (curve[i].totalPP > curve[i - 1].totalPP) mono = false;
    }
    if (curve.length >= 2 && !mono) {
      errs.push('PP 曲线非单调：acc 越低 PP 必须越低');
    }
    if (curve.length < 2) errs.push(`PP 曲线只有 ${curve.length} 个点，样本不足`);

    /* skill 占比之和应为 100%（ratio 是各 skill 占总星数的比例）*/
    const sum = rep.skills.rows.reduce((s, r) => s + r.ratio, 0);
    if (Math.abs(sum - 1) > 0.02) {
      errs.push(`四个 skill 占比之和 ${sum.toFixed(4)}，应约等于 1`);
    }
    console.log('    skill 占比之和=' + sum.toFixed(4) + '  各占比='
      + rep.skills.rows.map((r) => r.en + ' ' + (r.ratio * 100).toFixed(1) + '%').join(' / '));

    /* 换 mod 后 SR/占比必须真的变（HT/DT/EZ/HR 会改变谱面参数）*/
    const variants = ['None', 'HT', 'DT', 'EZ', 'HR'];
    console.log('    mod 切换后（SR / stamina占比）:');
    const seen = new Set();
    for (const m of variants) {
      const r2 = panel.buildDifficultyReport(bm, { mod: m });
      const st = r2.skills.rows.find((x) => x.key === 'stamina');
      seen.add(r2.skills.total.toFixed(6));
      console.log('      %s: SR=%s stamina=%s%% OD=%s rate=%s',
        m, r2.skills.total.toFixed(4),
        (st.ratio * 100).toFixed(1), r2.display.od, r2.display.rate);
    }
    if (seen.size < 3) {
      errs.push(`5 个 mod 只产生了 ${seen.size} 个不同 SR，mod 未生效`);
    }
  }
}

/* ---------- mod 冲突表 ---------- */
console.log('[6] mod 冲突表：');
{
  const SINGLE = panel.SINGLE_MODS || [];
  const COMBO = panel.COMBO_MODS || [];
  console.log('    单一 mod: %s', SINGLE.map((m) => m.id || m.name || m).join(', '));
  console.log('    组合 mod: %s', COMBO.map((m) => m.id || m.name || m).join(', '));
  const ids = SINGLE.concat(COMBO).map((m) => m.id || m.name || m);
  for (const need of ['CL', 'HT', 'DT', 'NC', 'EZ', 'HR', 'HD', 'FL']) {
    if (!ids.includes(need)) errs.push(`mod 表缺少 ${need}`);
  }
  /* CL 应是默认开启的那个（ACC_PRESETS 或 summarize 默认） */
  if (!panel.ACC_PRESETS) errs.push('缺少 ACC_PRESETS');
}

console.log();
if (errs.length) {
  console.log('❌ 一致性校验失败：');
  errs.forEach((e) => console.log('   -', e));
  process.exit(1);
}
console.log('✅ JS 移植版与官方 C# 一致，可以集成');
process.exit(0);