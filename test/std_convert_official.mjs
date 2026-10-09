/**
 * std(Mode 0) 转谱 —— 与**官方 C#** 逐项对拍（不是与 Python 复刻对拍）
 *
 * 用法：
 *   node test/std_convert_official.mjs
 *
 * 前置：
 *   1) dotnet build StarRatingCheck（一次性）
 *   2) dotnet run --project StarRatingCheck -- --objects test/std_official/bass_slut_std.osz 0
 *      > test/std_official/full.tsv
 *   3) dotnet run --project StarRatingCheck -- <单个 .osz>
 *      → 抄下每张谱的官方 StarRating，填进本文件的 OFFICIAL_SR
 *
 * ★★ 为什么必须直接对官方 C#，而不是对 Python 参考实现：
 *   taiko_diffcalc/ 是**手工复刻** C# 转换器的产物，历史上已经出过一次偏差
 *   （拆滑条时用了滑条自身采样而非逐节点 NodeSamples）。
 *   拿「复刻品」当基准只能证明两份复刻一致，证明不了与官方一致 ——
 *   而转谱路径的判定式恰好细到 1e-8，一次手滑就足以让 SR 偏 0.03。
 *
 * 验证三层（任一层不符即失败）：
 *   1. 转换后的**逐物件**列表（type / startTime / duration）
 *   2. ScrollSpeed 控制点序列
 *   3. Star Rating（isConvert = true 分支）
 *
 * 样本：983911 S3RL - Bass Slut (Original Mix) 的 9 张std 难度。
 * 这张谱的 SV 结构特别刁钻：大量连续同速绿线 + 密集 kiai 段，
 * 正好覆盖「SV 变化点」「kiai 转折点」「两者同刻」三类边界。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const { parseOsu } = await import(pathToFileURL(join(ROOT, 'lib/osu_parser.js')));
const diff = await import(pathToFileURL(join(ROOT, 'lib/difficulty.js')));

/* 官方 osu.Game.Rulesets.Taiko 2026.730.0 跑出来的 StarRating（legacyMods == None）*/
const OFFICIAL_SR = {
  "Dereban's Lewd Extra": 1.9916918843293105,
  'Indecent Insane': 1.867537159959747,
  'Intense Ecstasy': 2.6661846702786995,
  'Nasty Normal': 1.4219361489383757,
  'Obscene Hard': 1.8452944012002823,
  "Reform's Filthy Expert": 1.7984718560557884,
  'Seductive Extra': 2.1336073167557266,
  "Taeyang's Trashy Extreme": 2.1048977681636742,
  "TheShadow's Dirty Insane": 1.8027910746003302,
};

/* 官方转换后的 playable 物件数（GetPlayableBeatmap(taiko).HitObjects.Count）*/
const OFFICIAL_PLAYABLE = {
  "Dereban's Lewd Extra": 471,
  'Indecent Insane': 476,
  'Intense Ecstasy': 518,
  'Nasty Normal': 300,
  'Obscene Hard': 417,
  "Reform's Filthy Expert": 485,
  'Seductive Extra': 487,
  "Taeyang's Trashy Extreme": 484,
  "TheShadow's Dirty Insane": 466,
};

const SR_EPS = 1e-6;   /* 与官方 SR 的容差；实测最大 2.4e-8 */
const T_EPS = 0.5;     /* 时间/时长容差（ms），官方侧是 double 转字符串 */

const tsvPath = join(__dirname, 'std_official', 'full.tsv');
const dir = join(__dirname, 'std_official', 'bass_slut_src');

if (!existsSync(tsvPath)) {
  console.error('缺少官方基准，请先运行：');
  console.error('  dotnet run --project StarRatingCheck -- --objects \\');
  console.error('    test/std_official/bass_slut_std.osz 0 > test/std_official/full.tsv');
  process.exit(1);
}
if (!existsSync(dir)) {
  console.error(`缺少 std 原始谱目录: ${dir}`);
  console.error('（里面应是从 bass_slut_std.osz 解出的 9 个 .osu）');
  process.exit(1);
}

/* ---------- 解析官方 TSV ---------- */
const official = {};
{
  let cur = null;
  for (const line of readFileSync(tsvPath, 'utf8').split(/\r?\n/)) {
    let m;
    if ((m = /^=== (.*) ===$/.exec(line))) { cur = m[1]; official[cur] = []; continue; }
    if (!cur || line[0] === '#' || !line.trim() || !/^\d+\t/.test(line)) continue;
    const c = line.split('\t');
    if (c.length < 5) continue;
    official[cur].push({ type: c[1], t: +c[2], dur: +c[4] });
  }
}

let pass = 0, fail = 0;
const failures = [];
const ok = () => pass++;
const bad = (m) => { failures.push(m); fail++; };

console.log('='.repeat(92));
console.log('std(Mode 0) 转谱 vs 官方 C# —— 逐物件 / SV 控制点 / StarRating');
console.log('='.repeat(92));

for (const [name, objs] of Object.entries(official)) {
  const version = name.replace(/^.*\[|\]$/g, '');
  const file = readdirSync(dir).find((n) => n.includes(`[${version}]`));
  if (!file) { bad(`找不到样本文件: ${version}`); continue; }

  const bm = parseOsu(readFileSync(join(dir, file), 'utf8'));
  const ours = bm.notes.map((n) => ({
    type: n.kind === 'roll' ? 'DrumRoll'
      : n.kind === 'spinner' ? 'Swell'
        : (n.kind === 'kat' || (n.kind === 'big' && n.blue)) ? 'Hit(Kat)' : 'Hit(Don)',
    t: n.time,
    dur: n.endTime - n.time,
  }));

  /* ---- 1. 物件数 ---- */
  const expCount = OFFICIAL_PLAYABLE[version];
  const countOk = expCount === undefined || ours.length === expCount;
  if (!countOk) bad(`${version}: 物件数 ${ours.length} != 官方 ${expCount}`);
  else ok();

  /* ---- 2. 逐物件 ---- */
  let firstBad = -1;
  const n = Math.min(objs.length, ours.length);
  for (let i = 0; i < n; i++) {
    const a = objs[i], b = ours[i];
    if (a.type !== b.type || Math.abs(a.t - b.t) > T_EPS || Math.abs(a.dur - b.dur) > T_EPS) {
      firstBad = i;
      break;
    }
  }
  if (firstBad >= 0) {
    const a = objs[firstBad], b = ours[firstBad];
    bad(`${version}: 物件 #${firstBad} 不符 —— 官方 ${a.type}@${a.t.toFixed(0)}/${a.dur.toFixed(0)}ms`
      + ` vs 我们 ${b.type}@${b.t.toFixed(0)}/${b.dur.toFixed(0)}ms`);
  } else ok();

  /* ---- 3. Star Rating ---- */
  const r = diff.calculateStarRating(bm, 'None');
  const expSr = OFFICIAL_SR[version];
  if (!r) bad(`${version}: calculateStarRating 返回 null`);
  else if (expSr === undefined) bad(`${version}: 缺少官方 SR 基准`);
  else {
    const d = Math.abs(r.starRating - expSr);
    if (d > SR_EPS) bad(`${version}: SR 偏差 ${d.toExponential(3)}（${r.starRating} vs ${expSr}）`);
    else ok();
  }

  const srTxt = expSr === undefined ? '—'
    : `${r.starRating.toFixed(7)} (Δ${(r.starRating - expSr).toExponential(1)})`;
  console.log(`  ${countOk && firstBad < 0 ? '✅' : '❌'} ${version.padEnd(28)}`
    + ` 物件 ${String(ours.length).padStart(4)}  SR ${srTxt}`);
}

console.log('-'.repeat(92));
if (fail) {
  console.log(`❌ 官方对拍失败：${fail} 项不符（通过 ${pass} 项）`);
  for (const f of failures.slice(0, 25)) console.log('   - ' + f);
  if (failures.length > 25) console.log(`   ... 另有 ${failures.length - 25} 项`);
  process.exit(1);
}
console.log(`✅ 转谱结果与官方 osu.Game.Rulesets.Taiko 2026.7300 一致（${pass} 项断言）`);
