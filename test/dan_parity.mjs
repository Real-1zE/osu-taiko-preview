/**
 * 段位 / 键型对拍：JS (lib/dan_rank.js) vs Python (dan_rank 包)
 *
 * 用法：
 *   node test/dan_parity.mjs            # 跑全部谱 × 全部 mod
 *   node test/dan_parity.mjs -v         # 附带打印 JS 侧全部中间量
 *
 * 验证：
 *   1) notes 三元组完全一致（time / colour / big 逐条相同）
 *   2) raw scalar  |diff| < 1e-9
 *   3) dan（未四舍五入）|diff| < 1e-9   ← 硬指标
 *   4) grade / keytype 字符串完全相同
 *   5) 出口字段（notes / duration_ms / nps / dense / speed_mult）完全相同
 *
 * ★ 关于 beatLengthAt / svAt
 *   本脚本**不**直接用 osu_parser 的 beatMsAt / svAt，因为它们的语义与
 *   Python 侧 taiko_diffcalc/osu_parser.py 的 timing_at / effect_at 不同：
 *     · beatMsAt  未做 BeatLength 的 [6, 60000] 钳制，且 t < 首个红点时返回 500，
 *       而 Python 返回**第一个红点**的拍长；
 *     · svAt      完全忽略红线，而 Python 的 EffectControlPoint 是
 *       「每一行 timing point 都产出一个点」，**红线会把 SV 重置回 1.0**。
 *   这里按 Python 的 control point 构建规则重新实现一遍（见 timingAt/effectAt），
 *   这样比对的才是「算法 parity」而不是「parser parity」。
 *   若改用 osu_parser 的版本，差异见文末 NOTES。
 */
import { readFileSync, readdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const REPO = join(ROOT, '..');

const PY = 'C:/Users/Administrator/.workbuddy/binaries/python/versions/3.13.12/python.exe';

const { parseOsu } = await import(pathToFileURL(join(ROOT, 'lib/osu_parser.js')));
const dan = await import(pathToFileURL(join(ROOT, 'lib/dan_rank.js')));

const VERBOSE = process.argv.includes('-v');
const MODS = ['', 'DT', 'NC', 'HT', 'HDHR', 'HDDT', 'HRHT', 'FL', 'EZHT'];

/* ==================================================================
 * Python 侧：dump 全精度基准
 * ================================================================== */
const PY_SRC = `
import sys, json, os
sys.path.insert(0, ${JSON.stringify(REPO)})
from dan_rank.evaluate import mod_speed, SpeedModBeatmap, _model
from dan_rank.loader import load_osu
from dan_rank import keytype
from dan_rank.model import grade_name

files = json.load(open(sys.argv[1], encoding='utf-8'))
mods_list = json.load(open(sys.argv[2], encoding='utf-8'))
out = []
for path in files:
    bm = load_osu(path)
    for mods in mods_list:
        mult = mod_speed(mods)
        b = SpeedModBeatmap(bm, mult) if mult != 1.0 else bm
        m = _model()
        s, d, f = m.score(b)
        kt = keytype.classify(f, d)
        d5, d15, d30 = f.density_percentiles(bin_ms=1000.0)
        out.append({
            'file': os.path.basename(path), 'mods': mods,
            'notes': [[n.time, n.colour, int(bool(n.big))] for n in b.notes],
            'scalar': repr(s), 'dan': repr(d),
            'grade': grade_name(d),
            'keytype': keytype.label(kt),
            'keytype_primary': kt['primary'],
            'keytype_secondary': kt['secondary'] if kt['secondary'] else None,
            'weak': bool(kt['weak']), 'mixed': bool(kt['mixed']), 'skip': bool(kt['skip']),
            'speed_mult': mult,
            'notes_count': len(b.notes),
            'duration_ms': int(round(f.duration)),
            'nps': round(f.nps_global, 2),
            'dense': [round(x, 1) for x in (d5, d15, d30)],
        })
json.dump(out, open(sys.argv[3], 'w', encoding='utf-8'))
`;

const pyScript = join(tmpdir(), '_dan_parity_dump.py');
const fList = join(tmpdir(), '_dan_parity_files.json');
const mList = join(tmpdir(), '_dan_parity_mods.json');
const outJson = join(tmpdir(), '_dan_parity_out.json');

const zipDir = join(ROOT, 'test', 'test_zips');
const files = readdirSync(zipDir).filter((f) => f.endsWith('.osu')).sort()
  .map((f) => join(zipDir, f));

if (!existsSync(PY)) {
  console.error(`找不到 Python 解释器：${PY}`);
  process.exit(1);
}

writeFileSync(pyScript, PY_SRC, 'utf8');
writeFileSync(fList, JSON.stringify(files), 'utf8');
writeFileSync(mList, JSON.stringify(MODS), 'utf8');
execFileSync(PY, [pyScript, fList, mList, outJson], { stdio: ['ignore', 'inherit', 'inherit'] });
const base = JSON.parse(readFileSync(outJson, 'utf8'));
for (const p of [pyScript, fList, mList, outJson]) { try { unlinkSync(p); } catch { /* noop */ } }

/* ==================================================================
 * JS 侧：按 Python 的 control point 规则构造 beatLengthAt / svAt
 * ================================================================== */

/** Python build_control_points：只保留红点，BeatLength 钳制到 [6, 60000] */
function redTimingPoints(bm) {
  const pts = [];
  for (const tp of bm.timingPoints) {
    if (tp.beatLength > 0) {
      pts.push({ time: tp.time, bl: Math.min(Math.max(tp.beatLength, 6.0), 60000.0) });
    }
  }
  pts.sort((a, b) => a.time - b.time);
  return pts;
}

/** Python OsuFile.timing_at(t)：最后一个 time <= t 的红点；t 更早则返回第一个 */
function timingAt(pts, t) {
  if (!pts.length) return 500;
  if (t < pts[0].time) return pts[0].bl;
  let lo = 0;
  let hi = pts.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (pts[mid].time <= t) lo = mid; else hi = mid - 1;
  }
  return pts[lo].bl;
}

/**
 * Python build_control_points 的 effects 部分：
 *   每一行 timing point 都产出一个 EffectControlPoint
 *   sm = (beatLength < 0 ? 100/-beatLength : 1.0)，钳制到 [0.01, 10]
 *   按 time 稳定排序 → 相邻同 ScrollSpeed 的点被丢弃（IsRedundant）
 *   ★ 因此**红线会把 SV 重置为 1.0**
 */
function effectPoints(bm) {
  const rows = [];
  for (const tp of bm.timingPoints) {
    const sm = tp.beatLength < 0 ? (100.0 / -tp.beatLength) : 1.0;
    rows.push({ time: tp.time, sm: Math.min(Math.max(sm, 0.01), 10.0) });
  }
  rows.sort((a, b) => a.time - b.time);          // 稳定排序，与 Python 一致
  const res = [];
  for (const ep of rows) {
    if (res.length && res[res.length - 1].sm === ep.sm) continue;
    res.push(ep);
  }
  return res;
}

/** Python OsuFile.effect_at(t) */
function effectAt(pts, t) {
  if (!pts.length) return 1.0;
  if (t < pts[0].time) return pts[0].sm;
  let lo = 0;
  let hi = pts.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (pts[mid].time <= t) lo = mid; else hi = mid - 1;
  }
  return pts[lo].sm;
}

/* ==================================================================
 * 跑 JS
 * ================================================================== */
console.log('='.repeat(104));
console.log('dan_rank.js  vs  dan_rank (Python) —— 段位 / 键型对拍');
console.log('='.repeat(104));
console.log(`谱数 ${files.length} × mod ${MODS.length} = ${base.length} 个用例`);
console.log('-'.repeat(104));

let pass = 0;
let fail = 0;
let worstScalar = 0;
let worstDan = 0;
let worstCase = '';
const failures = [];

const shortName = (f) => {
  const m = /\[([^\]]*)\]\.osu$/.exec(f);
  const id = /^(\d+)/.exec(f);
  return `${id ? id[1] : '?'} [${m ? m[1] : '?'}]`;
};

for (const b of base) {
  const text = readFileSync(join(zipDir, b.file), 'utf8');
  const bm = parseOsu(text);
  const reds = redTimingPoints(bm);
  const effs = effectPoints(bm);

  const notes = [];
  for (const n of bm.notes) {
    if (n.kind !== 'don' && n.kind !== 'kat' && n.kind !== 'big') continue;
    notes.push({ time: n.time, colour: n.blue ? 1 : 0, big: n.kind === 'big' });
  }

  const r = dan.evaluateDan({
    notes,
    beatLengthAt: (t) => timingAt(reds, t),
    svAt: (t) => effectAt(effs, t),
    od: (bm && typeof bm.od === 'number') ? bm.od : null,
    mods: b.mods,
  });

  const errs = [];

  // 1) notes 逐条一致（Python 侧的 b.notes 已被 SpeedModBeatmap 除以倍率，
  //    所以这里把 JS 的原始 time 也除以同一倍率去比）
  if (notes.length !== b.notes_count) {
    errs.push(`notes 条数 JS=${notes.length} Py=${b.notes_count}`);
  } else {
    for (let i = 0; i < notes.length; i++) {
      const p = b.notes[i];
      const t = notes[i].time / b.speed_mult;
      if (t !== p[0] || notes[i].colour !== p[1] || (notes[i].big ? 1 : 0) !== p[2]) {
        errs.push(`notes[${i}] JS=${JSON.stringify([t, notes[i].colour, notes[i].big ? 1 : 0])}`
                  + ` Py=${JSON.stringify(p)}`);
        break;
      }
    }
  }

  // 2) / 3) 精度
  const dS = Math.abs(r._scalar - Number(b.scalar));
  const dD = Math.abs(r._dan - Number(b.dan));
  if (dS > worstScalar) worstScalar = dS;
  if (dD > worstDan || dD === worstDan) { if (dD >= worstDan) { worstDan = dD; worstCase = `${shortName(b.file)} ${b.mods || '(none)'}`; } }
  if (dS > 1e-9) errs.push(`scalar |diff|=${dS.toExponential(3)}`);
  if (dD > 1e-9) errs.push(`dan |diff|=${dD.toExponential(3)} (JS=${r._dan} Py=${Number(b.dan)})`);

  // 4) 键型
  if (r.grade !== b.grade) errs.push(`grade JS="${r.grade}" Py="${b.grade}"`);
  if (r.keytype !== b.keytype) {
    errs.push(`keytype JS="${r.keytype}" Py="${b.keytype}"`
      + ` (primary ${r._keytype.primary}/${r._keytype.secondary} vs ${b.keytype_primary}/${b.keytype_secondary}`
      + ` weak ${r._keytype.weak}/${b.weak} mixed ${r._keytype.mixed}/${b.mixed})`);
  }
  if (r.speed_mult !== b.speed_mult) errs.push(`speed_mult JS=${r.speed_mult} Py=${b.speed_mult}`);

  // 5) 出口字段
  if (r.notes !== b.notes_count) errs.push(`out.notes JS=${r.notes} Py=${b.notes_count}`);
  if (r.duration_ms !== b.duration_ms) errs.push(`duration_ms JS=${r.duration_ms} Py=${b.duration_ms}`);
  if (r.nps !== b.nps) errs.push(`nps JS=${r.nps} Py=${b.nps}`);
  for (let k = 0; k < 3; k++) {
    if (r.dense[k] !== b.dense[k]) errs.push(`dense[${k}] JS=${r.dense[k]} Py=${b.dense[k]}`);
  }

  if (errs.length) {
    fail += 1;
    failures.push({ name: shortName(b.file), mods: b.mods || '(none)', errs });
  } else {
    pass += 1;
  }

  if (VERBOSE || errs.length) {
    const tag = errs.length ? 'FAIL' : 'ok  ';
    console.log(
      `${tag} ${shortName(b.file).padEnd(34)} ${(b.mods || '(none)').padEnd(8)}`
      + ` dan=${r.dan.toFixed(2).padStart(6)} Py=${Number(b.dan).toFixed(2).padStart(6)}`
      + ` |Δdan|=${dD.toExponential(1).padStart(9)}`
      + `  ${r.grade.padEnd(8)} ${r.keytype}`,
    );
    for (const e of errs) console.log(`       ! ${e}`);
  }
}

console.log('-'.repeat(104));
console.log(`通过 ${pass} / ${pass + fail}   失败 ${fail}`);
console.log(`scalar 最大偏差 ${worstScalar.toExponential(3)}`);
console.log(`dan    最大偏差 ${worstDan.toExponential(3)}   @ ${worstCase}`);
if (fail) {
  console.log('\n失败明细：');
  for (const f of failures) {
    console.log(`  ${f.name}  ${f.mods}`);
    for (const e of f.errs) console.log(`      ${e}`);
  }
}

/* ==================================================================
 * NOTES：osu_parser 自带的 beatMsAt / svAt 与 Python 语义的差异
 * ================================================================== */
if (VERBOSE) {
  const { beatMsAt, svAt } = await import(pathToFileURL(join(ROOT, 'lib/osu_parser.js')));
  console.log('\n' + '='.repeat(104));
  console.log('附：osu_parser 的 beatMsAt / svAt 与 Python timing_at / effect_at 的差���（仅说明，不影响上面的结论）');
  console.log('-'.repeat(104));
  for (const f of files.slice(0, 5)) {
    const text = readFileSync(f, 'utf8');
    const bm = parseOsu(text);
    const reds = redTimingPoints(bm);
    const effs = effectPoints(bm);
    let beatDiff = 0;
    let svDiff = 0;
    for (const n of bm.notes) {
      if (n.kind !== 'don' && n.kind !== 'kat' && n.kind !== 'big') continue;
      if (beatMsAt(bm, n.time) !== timingAt(reds, n.time)) beatDiff += 1;
      if (svAt(bm, n.time) !== effectAt(effs, n.time)) svDiff += 1;
    }
    console.log(`${shortName(f.split(/[\\/]/).pop()).padEnd(34)} 拍长不同 ${String(beatDiff).padStart(5)} 个音符`
      + `   SV 不同 ${String(svDiff).padStart(5)} 个音符`
      + `   (droppedTiming=${bm.droppedTiming} droppedObjects=${bm.droppedObjects})`);
  }
}

process.exit(fail ? 1 : 0);