/**
 * std(Mode 0) 转谱 —— 与 Python 参考实现（taiko_diffcalc/）对拍
 *
 * ⚠️ 已废弃：请改用 test/std_convert_official.mjs
 *
 * 废弃原因（不是「测试没过」，是**基准本身错了**）：
 *   Python 侧的 osu_parser 完全不解析 timing point 的**第 8 字段**
 *   （LegacyEffectFlags.Kiai），因此它算不出「kiai 转折点」，
 *   而官方 TaikoBeatmapConverter 会为每个 kiai 转折额外插一个
 *   ScrollSpeed = 1.0 的 EffectControlPoint。
 *   两者对同一张谱必然给出不同的 SV 序列（实测 6 张样本全部不符，
 *   readingDifficulty 最多偏 0.007）—— 这不是 JS 的问题。
 *   与其把一个已知有缺陷的复刻品当基准，不如直接对官方 C#。
 *
 *   保留本文件仅为记录「曾经用 Python 基准对拍过什么」。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const { parseOsu } = await import(pathToFileURL(join(ROOT, 'lib/osu_parser.js')));
const diff = await import(pathToFileURL(join(ROOT, 'lib/difficulty.js')));

const baselinePath = join(__dirname, 'python_std_baseline.json');
if (!existsSync(baselinePath)) {
  console.error('缺少 python_std_baseline.json，请先运行：');
  console.error('  python test/dump_python_std_baseline.py');
  process.exit(1);
}
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));

const zipDir = join(__dirname, 'std_zips');
if (!existsSync(zipDir)) {
  console.error(`找不到 std 样本目录: ${zipDir}`);
  process.exit(1);
}

/* ---------- 容差 ----------
 * 时间/时长：Python 用 int(distance / taikoVelocity * beatLength) 截断，
 *   JS 用 Math.trunc —— 语义相同，浮点末位可能差 1 ulp。
 * ★ 转换后的物件抽样实测 max|Δt| = max|Δdur| = 0（逐位一致），
 *   这里仍留 1e-6 ms 余量。
 * SR / skill：与原生 taiko 对拍（difficulty_parity.mjs）同一档 6e-3 ——
 *   偏差来源是 V8 Math.cos / Math.pow 与 CPython libm 在非整比值上的
 *   尾数差异，经数百物件累积后放大到 1e-8~1e-5 量级。
 *   ★ 这不是转换逻辑的问题：同一份代码在原生 taiko 上与官方 C#
 *   的偏差也是这个量级（见 test/sr_verify.mjs）。 */
const T_EPS = 1e-6;
const D_EPS = 6e-3;

let pass = 0, fail = 0;
const failures = [];
const MODS = ['None', 'EZ', 'HR', 'DT', 'HT', 'HR+DT', 'DT+HD+FL'];

function bad(msg) { failures.push(msg); fail++; }
function ok() { pass++; }

console.log('本测试已废弃 —— 见文件头说明。请运行：node test/std_convert_official.mjs');
process.exit(0);
console.log('='.repeat(96));
console.log('std(Mode 0) -> taiko 转换：JS vs Python 参考实现');
console.log('='.repeat(96));

for (const [key, base] of Object.entries(baseline)) {
  const filename = key.split('::')[0];
  const fpath = join(zipDir, filename);
  if (!existsSync(fpath)) {
    console.log(`跳过（文件不存在）: ${filename}`);
    continue;
  }
  const bm = parseOsu(readFileSync(fpath, 'utf8'));

  console.log(`\n[${base.version}]  ${filename}`);
  console.log(`  mode=${bm.mode} isConvert=${bm.isConvert} `
    + `beatmapVersion=${bm.beatmapVersion} notes=${bm.notes.length}`);

  /* ---- 0. 守卫：必须走转换路径 ---- */
  if (bm.mode !== 0) bad(`${filename}: Mode 应为 0，实际 ${bm.mode}`);
  else ok();
  if (bm.isConvert !== true) bad(`${filename}: isConvert 应为 true`);
  else ok();

  /* ---- 1. 物件构成 ---- */
  let hits = 0, rolls = 0, swells = 0;
  for (const n of bm.notes) {
    if (n.kind === 'don' || n.kind === 'kat' || n.kind === 'big') hits++;
    else if (n.kind === 'roll') rolls++;
    else if (n.kind === 'spinner') swells++;
  }
  console.log(`  物件: JS Hit=${hits} Roll=${rolls} Swell=${swells}`
    + `  |  Python Hit=${base.kinds.Hit} Roll=${base.kinds.DrumRoll} Swell=${base.kinds.Swell}`);
  if (hits !== base.kinds.Hit) bad(`${filename}: Hit 数 JS=${hits} Py=${base.kinds.Hit}`);
  else ok();
  if (rolls !== base.kinds.DrumRoll) bad(`${filename}: DrumRoll 数 JS=${rolls} Py=${base.kinds.DrumRoll}`);
  else ok();
  if (swells !== base.kinds.Swell) bad(`${filename}: Swell 数 JS=${swells} Py=${base.kinds.Swell}`);
  else ok();
  if (bm.notes.length !== base.total) {
    bad(`${filename}: 总物件数 JS=${bm.notes.length} Py=${base.total}`);
  } else ok();

  /* ---- 2. 逐物件抽样 ---- */
  const n = Math.min(base.sample.length, bm.notes.length);
  let worstT = 0, worstDur = 0, typeMismatch = 0, firstBad = null;
  for (let i = 0; i < n; i++) {
    const b = base.sample[i];
    const j = bm.notes[i];
    const dt = Math.abs(j.time - b.t);
    const dd = Math.abs((j.endTime - j.time) - b.dur);
    if (dt > worstT) worstT = dt;
    if (dd > worstDur) worstDur = dd;
    /* Python: type 0=Don 1=Kat（Hit 才有）；DrumRoll/Swell 为 null */
    const jsType = (j.kind === 'don') ? 0
      : (j.kind === 'kat' || (j.kind === 'big' && j.blue)) ? 1 : null;
    if (jsType !== b.type) {
      typeMismatch++;
      if (!firstBad) {
        firstBad = `#${i} JS(${j.kind},blue=${j.blue}) vs Py(type=${b.type}) `
          + `t=${j.time}/${b.t}`;
      }
    }
  }
  console.log(`  抽样前 ${n} 个物件: max|Δt|=${worstT.toExponential(2)}ms `
    + `max|Δdur|=${worstDur.toExponential(2)}ms 颜色不符=${typeMismatch}`);
  if (worstT > T_EPS) bad(`${filename}: 物件时间偏差 ${worstT} > ${T_EPS}`);
  else ok();
  if (worstDur > T_EPS) bad(`${filename}: 物件时长偏差 ${worstDur} > ${T_EPS}`);
  else ok();
  if (typeMismatch) bad(`${filename}: ${typeMismatch} 个物件 Don/Kat 判定不符，${firstBad}`);
  else ok();

  /* ---- 3. ScrollSpeed 控制点 ---- */
  const jsScroll = bm.scrollPoints || [];
  console.log(`  ScrollSpeed 控制点: JS=${jsScroll.length} Py=${base.scroll.length}`);
  if (jsScroll.length !== base.scroll.length) {
    bad(`${filename}: SV 控制点数 JS=${jsScroll.length} Py=${base.scroll.length}`);
  } else {
    let svBad = 0;
    for (let i = 0; i < base.scroll.length; i++) {
      if (Math.abs(jsScroll[i][0] - base.scroll[i][0]) > T_EPS
        || Math.abs(jsScroll[i][1] - base.scroll[i][1]) > 1e-9) svBad++;
    }
    if (svBad) bad(`${filename}: ${svBad} 个 SV 控制点不符`);
    else ok();
  }

  /* ---- 4. Star Rating（isConvert = true 分支）---- */
  console.log('  ' + 'mod'.padEnd(10) + 'JS SR'.padStart(14)
    + 'Py SR'.padStart(16) + 'diff'.padStart(12));
  for (const modName of MODS) {
    const b = base.mods?.[modName];
    if (!b) continue;
    const r = diff.calculateStarRating(bm, modName);
    if (!r) { bad(`${filename}/${modName}: JS 返回 null`); continue; }
    const d = Math.abs(r.starRating - b.sr);
    console.log('  ' + modName.padEnd(10)
      + r.starRating.toFixed(9).padStart(14)
      + b.sr.toFixed(9).padStart(16)
      + d.toExponential(2).padStart(12));
    if (d > D_EPS) bad(`${filename}/${modName}: SR 偏差 ${d}`);
    else ok();

    /* 四项 skill 难度与两个因子也一起对拍 —— 它们共用 isConvert 分支，
       只对 SR 的话，isConvert 传错（比如漏传给 combineOne）可能查不出来。*/
    for (const [field, pyField] of [
      ['rhythmDifficulty', 'rhythm'], ['readingDifficulty', 'reading'],
      ['colourDifficulty', 'colour'], ['staminaDifficulty', 'stamina'],
      ['monoStaminaFactor', 'msf'], ['consistencyFactor', 'cf'],
    ]) {
      const pd = Math.abs(r[field] - b[pyField]);
      if (pd > D_EPS) bad(`${filename}/${modName}: ${field} 偏差 ${pd}`);
      else ok();
    }
  }
}

console.log('\n' + '='.repeat(96));
if (fail) {
  console.log(`❌ std 转换对拍失败：${fail} 项不符（通过 ${pass} 项）`);
  for (const f of failures.slice(0, 40)) console.log('   - ' + f);
  if (failures.length > 40) console.log(`   ... 另有 ${failures.length - 40} 项`);
  process.exit(1);
}
console.log(`✅ std -> taiko 转换与 Python 参考实现一致（${pass} 项断言通过）`);
