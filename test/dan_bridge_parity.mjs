/**
 * 适配层对拍：`lib/dan_bridge.js` + 插件自己的 `osu_parser`
 * 端到端跑一遍，与 Python 基线（`dan_rank.evaluate.evaluate_text`）
 * 逐谱比较 dan / grade / keytype。
 *
 * ★ 与 `dan_parity.mjs` 的区别（两层都要有，失效模式不同）：
 *   `dan_parity.mjs`     —— 验**算法移植**（dan_rank.js vs Python），
 *                          notes 与 beatLengthAt/svAt 按 Python 规则手写。
 *   本文件                —— 验**适配层**（dan_bridge + osu_parser vs Python），
 *                          走插件真实的解析结果。
 *   算法对、但适配层语义错（比如 svAt 用了官方 DifficultyControlPoint
 *   的口径而不是 taiko_diffcalc 的 EffectControlPoint）时，
 *   只有本测试能抓到。
 *
 * ★ 基线要先用 `python test/dan_bridge_py_baseline.py` 生成。
 *   不这么做就跳过（而不是误报通过）—— 静默跳过的守门测试等于没有。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, '..', 'lib');

const parser = await import(pathToFileURL(path.join(LIB, 'osu_parser.js')));
const bridge = await import(pathToFileURL(path.join(LIB, 'dan_bridge.js')));

const MODS = ['', 'DT', 'HT', 'EZ', 'HR', 'CL', 'HDDT', 'HRHT', 'FL'];
const DAN_EPS = 1e-6;

const baselinePath = path.join(HERE, 'dan_bridge_baseline.json');
const zipRoot = path.join(HERE, 'test_zips');
if (!fs.existsSync(zipRoot)) {
  console.log('（无 test_zips 样本，跳过）');
  process.exit(0);
}
if (!fs.existsSync(baselinePath)) {
  console.log('⚠️ 缺 Python 基线，已跳过。');
  console.log('   请先运行：python test/dan_bridge_py_baseline.py');
  process.exit(0);
}
const pyAll = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const files = Object.keys(pyAll);

console.log('='.repeat(80));
console.log('dan_bridge.js（适配层 + 插件解析器）vs dan_rank (Python 基线)');
console.log('='.repeat(80));
console.log('样本 %d 张 × mod %d 个 = %d 例',
  files.length, MODS.length, files.length * MODS.length);
console.log('-'.repeat(80));

let pass = 0, fail = 0;
const bads = [];
/* 契约类问题（字段多/少、dense 形状不对）与数值不一致分开记，
   免得数值全绿时把契约问题混在明细里看不到。*/
const contractErrs = [];
let maxDanDiff = 0, maxDanAt = '';

for (const f of files) {
  const bm = parser.parseOsu(fs.readFileSync(path.join(zipRoot, f), 'utf8'));
  const pyPer = pyAll[f] || {};
  for (const m of MODS) {
    const py = pyPer[m];
    if (!py) continue;
    const mine = bridge.evaluateBeatmap(bm, m);
    const dDan = Math.abs(mine.dan - py.dan);
    if (dDan > maxDanDiff) { maxDanDiff = dDan; maxDanAt = `${f} [${m}]`; }
    const dGrade = mine.grade !== py.grade;
    const dKt = mine.keytype !== py.keytype;
    if (dDan <= DAN_EPS && !dGrade && !dKt) {
      pass++;
    } else {
      fail++;
      bads.push(`${f} mods="${m}"：dan ${mine.dan} vs ${py.dan}`
        + `（差 ${dDan.toExponential(2)}）`
        + (dGrade ? ` grade ${JSON.stringify(mine.grade)} vs ${JSON.stringify(py.grade)}` : '')
        + (dKt ? ` keytype ${JSON.stringify(mine.keytype)} vs ${JSON.stringify(py.keytype)}` : ''));
    }
  }
}

if (bads.length) {
  console.log('\n失败明细（前 12 条）:');
  bads.slice(0, 12).forEach((b) => console.log('  ❌ ' + b));
}

/* ---------- 字段契约：evaluateBeatmap 的返回必须**恰好**是约定的字段 ---------- */
/* 对方（dan_rank 维护方）留言明确列了字段契约：
 *   dan / grade / keytype / dense[p5,p15,p30] / notes / duration_ms /
 *   nps / mods / speed_mult（+ 元信息四件套 artist/title/version/creator）
 *
 * 这里用「精确相等」而不是「包含」——
 * `evaluateDan` 会返回 `_scalar`/`_dan`/`_features`/`_keytype` 四个
 * 下划线前缀的内部量（给对拍测试用）。它们**不该**从适配层漏出去：
 *   · 按契约遍历的对接代码会困惑；
 *   · `_features` 是整个 Features 对象，JSON 序列化体积暴涨。
 * 所以适配层必须剥掉。 */
const CONTRACT = [
  'artist', 'title', 'version', 'creator',
  'mods', 'speed_mult', 'dan', 'grade', 'keytype',
  'notes', 'duration_ms', 'nps', 'dense',
];
{
  const f0 = files[0];
  const bm0 = parser.parseOsu(fs.readFileSync(path.join(zipRoot, f0), 'utf8'));
  const got = bridge.evaluateBeatmap(bm0, 'DT');
  const gotKeys = Object.keys(got).sort();
  const wantKeys = [...CONTRACT].sort();
  const extra = gotKeys.filter((k) => !wantKeys.includes(k));
  const missing = wantKeys.filter((k) => !gotKeys.includes(k));
  if (extra.length) {
    contractErrs.push(`evaluateBeatmap 多返回了字段：${extra.join(', ')}`
      + ' —— 契约外的内部量（下划线前缀那些）不该漏出去');
  }
  if (missing.length) {
    contractErrs.push(`evaluateBeatmap 缺少契约字段：${missing.join(', ')}`);
  }
  /* dense 必须是 3 元素数组 */
  if (!Array.isArray(got.dense) || got.dense.length !== 3) {
    contractErrs.push(`dense 必须是 3 元素数组 [p5,p15,p30]，实际 ${JSON.stringify(got.dense)}`);
  }
  /* keytype 为 '-' 时不能是空串 —— 那是「段位 ≤6 不标定」的约定值，
     对方明确要求「不要当错误」，所以原样透传 */
  console.log('字段契约: 恰好 %d 个%s%s',
    gotKeys.length,
    extra.length ? `，多出 ${extra.join(',')}` : '',
    missing.length ? `，缺少 ${missing.join(',')}` : '');
}

console.log('-'.repeat(80));
console.log('通过 %d / %d', pass, pass + fail);
console.log('dan 最大偏差 %s%s',
  maxDanDiff.toExponential(3),
  maxDanDiff > DAN_EPS ? `  @ ${maxDanAt}` : '');
if (contractErrs.length) {
  console.log('\n❌ 字段契约不符:');
  contractErrs.forEach((e) => console.log('   -', e));
}
console.log('='.repeat(80));

if (fail || contractErrs.length) process.exit(1);
console.log('✅ 适配层与 Python 基线一致（阈值 %s），字段契约相符',
  DAN_EPS.toExponential(0));
process.exit(0);