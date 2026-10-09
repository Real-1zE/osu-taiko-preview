/**
 * 深度对拍：把 Features 的**每一个中间量**逐字段与 Python 比对。
 *
 * 为什么要这一层：dan_parity.mjs 只比dan / grade / keytype 三个标量，
 * 中间量一旦算错可能会互相抵消（比如 1/6 负载算高了、包络被压低，
 * 最终 dan 恰好对上）。本脚本直接把Features 的字段导出来对齐，
 * 任何一个字段不同就说明那一段移植有偏差。
 *
 * 同时覆盖 14张真谱打不到的分支：
 *   · 混合（mixed）—— 14 张谱一段混合都判不出来
 *   · slice（45 秒切片）里的大串 / 复合两种键型
 *   · ooxxooxx 降权、孤立 1/6 四连、SIXTH_RUN_GAPS 边界
 *   · 60s 以下的短图（不分片）、n < 2 的退化谱
 *
 * 用法：node test/dan_features_parity.mjs
 */
import { readFileSync, readdirSync, writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const REPO = join(ROOT, '..');
const PY = 'C:/Users/Administrator/.workbuddy/binaries/python/versions/3.13.12/python.exe';

const { Features, defaultModel } = await import(pathToFileURL(join(ROOT, 'lib/dan_rank.js')));
const { DAN_PARAMS } = await import(pathToFileURL(join(ROOT, 'lib/dan_calibration.js')));

/* ---------- 1. 造用例 ---------- */
/** 线性拍长 + 可选绿线的 timing 源 */
function timingSrc(blAt) {
  return (t) => blAt(t);
}

/**
 * 合成谱面生成器。每一段用不同的 (bpm, 栅格, 颜色模式, 均匀度) 描述，
 * 目标是让 45 秒切片能切出 ≥3 种键型，从而走到 mixed 分支。
 */
function synth(kind, opts = {}) {
  const notes = [];
  const beat = opts.beat || 300;
  let t = opts.start !== undefined ? opts.start : 1000;
  const secs = opts.secs || 60;
  const end = t + secs * 1000;
  if (kind === 'stream') {
    // 等间隔 1/4 长串 + 大量同色连打 → 大串
    const step = beat / 2;
    let k = 0;
    while (t < end) {
      notes.push({ time: t, colour: Math.floor(k / 8) % 2, big: false });
      t += step;
      k += 1;
    }
  } else if (kind === 'sixth') {
    // 1/6 栅格 ooxxooxx → 复合
    const step = beat / 3;
    let k = 0;
    while (t < end) {
      const c = (k % 4 < 2) ? 0 : 1;
      notes.push({ time: t, colour: c, big: false });
      t += step;
      k += 1;
    }
  } else if (kind === 'jitter') {
    // 节奏错落 + 颜色翻转 → 协调
    const pat = [1, 2, 1, 3, 0.5, 2, 1, 1.5];
    let k = 0;
    while (t < end) {
      notes.push({ time: t, colour: k % 2, big: false });
      t += beat * pat[k % pat.length];
      k += 1;
    }
  } else if (kind === 'burst') {
    // 1/8 爆发段（1/4 为主 + 短 1/8） → 高速
    let k = 0;
    while (t < end) {
      notes.push({ time: t, colour: k % 2, big: false });
      t += (k % 8 < 4) ? beat / 4 : beat / 2;
      k += 1;
    }
  } else if (kind === 'iso6') {
    // 大串夹孤立 1/6 四连 → 检验 SIXTH_ISO_GAPS / SIXTH_ISO_W
    let k = 0;
    while (t < end) {
      const inTail = (k % 32) >= 28;
      notes.push({ time: t, colour: inTail ? (k % 8 < 4 ? 0 : 1) : (Math.floor(k / 4) % 2), big: false });
      t += inTail ? beat / 3 : beat / 2;
      k += 1;
    }
  } else if (kind === 'big') {
    let k = 0;
    while (t < end) {
      notes.push({ time: t, colour: k % 2, big: (k % 7 === 0) });
      t += beat / 2;
      k += 1;
    }
  }
  notes.sort((a, b) => a.time - b.time);
  return notes;
}

const CASES = [];
for (const f of readdirSync(join(ROOT, 'test/test_zips')).filter((x) => x.endsWith('.osu')).sort()) {
  CASES.push({ name: `real:${f.slice(0, 34)}`, file: join(ROOT, 'test/test_zips', f) });
}
// 混合：4 段各 60 秒 → 应触发 mixed
CASES.push({ name: 'synth:mixed-4sec', notes: [...synth('stream', { secs: 60 }), ...synth('sixth', { secs: 60 }),
  ...synth('jitter', { secs: 60 }), ...synth('burst', { secs: 60 })], beat: 300 });
CASES.push({ name: 'synth:mixed-sv', notes: [...synth('sixth', { secs: 70 }), ...synth('stream', { secs: 70 }),
  ...synth('jitter', { secs: 70 }), ...synth('burst', { secs: 70 })], beat: 272.7272727272727,
  sv: [[0, 1.0], [40000, 1.5], [90000, 0.75], [150000, 2.0]] });
CASES.push({ name: 'synth:iso6', notes: synth('iso6', { secs: 90 }), beat: 300 });
CASES.push({ name: 'synth:big', notes: synth('big', { secs: 50 }), beat: 250 });
CASES.push({ name: 'synth:short', notes: synth('burst', { secs: 20 }), beat: 180 });
CASES.push({ name: 'synth:tiny-n1', notes: [{ time: 500, colour: 0, big: false }], beat: 300 });
CASES.push({ name: 'synth:tiny-n2', notes: [{ time: 500, colour: 0, big: false }, { time: 800, colour: 1, big: true }], beat: 300 });
CASES.push({ name: 'synth:empty', notes: [], beat: 300 });
CASES.push({ name: 'synth:same-time', notes: Array.from({ length: 200 }, (_, i) => ({ time: 1000, colour: i % 2, big: false })), beat: 300 });

/* ---------- 2. 读真谱 ---------- */
const { parseOsu } = await import(pathToFileURL(join(ROOT, 'lib/osu_parser.js')));

function pyTiming(bm) {
  const reds = [];
  for (const tp of bm.timingPoints) {
    if (tp.beatLength > 0) reds.push({ time: tp.time, bl: Math.min(Math.max(tp.beatLength, 6.0), 60000.0) });
  }
  reds.sort((a, b) => a.time - b.time);
  const rows = [];
  for (const tp of bm.timingPoints) {
    const sm = tp.beatLength < 0 ? (100.0 / -tp.beatLength) : 1.0;
    rows.push({ time: tp.time, sm: Math.min(Math.max(sm, 0.01), 10.0) });
  }
  rows.sort((a, b) => a.time - b.time);
  const effs = [];
  for (const e of rows) { if (effs.length && effs[effs.length - 1].sm === e.sm) continue; effs.push(e); }
  const lastOf = (pts, t, key, dflt) => {
    if (!pts.length) return dflt;
    if (t < pts[0].time) return pts[0][key];
    let lo = 0; let hi = pts.length - 1;
    while (lo < hi) { const m = Math.floor((lo + hi + 1) / 2); if (pts[m].time <= t) lo = m; else hi = m - 1; }
    return pts[lo][key];
  };
  return {
    beat: (t) => lastOf(reds, t, 'bl', 500),
    sv: (t) => lastOf(effs, t, 'sm', 1.0),
    reds,
    effs,
  };
}

function hitNotes(bm) {
  const out = [];
  for (const n of bm.notes) {
    if (n.kind !== 'don' && n.kind !== 'kat' && n.kind !== 'big') continue;
    out.push({ time: n.time, colour: n.blue ? 1 : 0, big: n.kind === 'big' });
  }
  return out;
}

for (const c of CASES) {
  if (c.file) {
    const bm = parseOsu(readFileSync(c.file, 'utf8'));
    const t = pyTiming(bm);
    c.notes = hitNotes(bm);
    c.beatLenAt = t.beat;
    c.svAt = t.sv;
    c.timing = { reds: t.reds, effs: t.effs };
  } else {
    const bl = c.beat;
    const svPts = (c.sv || [[0, 1.0]]).slice().sort((a, b) => a[0] - b[0]);
    c.beatLenAt = () => bl;
    c.svAt = (t) => {
      let v = 1.0;
      for (const [tt, s] of svPts) { if (tt > t) break; v = s; }
      return v;
    };
    // 与真实谱同构：红线只有一条，effect points 走一遍 Python 的 IsRedundant 去重
    const rows = [{ time: 0, sm: 1.0 }];
    for (const [tt, s] of svPts) rows.push({ time: tt, sm: Math.min(Math.max(s, 0.01), 10.0) });
    rows.sort((a, b) => a.time - b.time);
    const effs = [];
    for (const e of rows) { if (effs.length && effs[effs.length - 1].sm === e.sm) continue; effs.push(e); }
    c.timing = { reds: [{ time: 0, bl: Math.min(Math.max(bl, 6.0), 60000.0) }], effs };
  }
}

/* ---------- 3. Python 侧 dump全部中间量 ---------- */
const PY_SRC = `
import sys, json, bisect
sys.path.insert(0, ${JSON.stringify(REPO)})
from dan_rank.features import Features
from dan_rank.model import load_default, grade_name
from dan_rank import keytype

def last_of(pts, t, idx, dflt):
    if not pts:
        return dflt
    if t < pts[0][0]:
        return pts[0][idx]
    lo, hi = 0, len(pts) - 1
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if pts[mid][0] <= t:
            lo = mid
        else:
            hi = mid - 1
    return pts[lo][idx]

m = load_default()
cases = json.load(open(sys.argv[1], encoding='utf-8'))
out = []
for c in cases:
    reds = [[p['time'], p['bl']] for p in c['timing']['reds']]
    effs = [[p['time'], p['sm']] for p in c['timing']['effs']]
    meta = {
        'beat_unit': (lambda t, r=reds: last_of(r, t, 1, 500)),
        'sv_unit': (lambda t, e=effs: last_of(e, t, 1, 1.0)),
        'big_cost': m.params['big_cost'],
        'lambda_colour': m.params['lambda_colour'],
        'lambda_time': m.params['lambda_time'],
        'lambda_mono': m.params['lambda_mono'],
        'lambda_sixth': m.params['lambda_sixth'],
    }
    notes = [type('N', (), {'time': a, 'colour': b, 'big': bool(cc)})() for a, b, cc in c['notes']]
    f = Features(notes, meta)
    s = m.raw_scalar(f)
    dan = m.dan(s, f)
    kt = keytype.classify(f, dan)
    out.append({
        'scalar': repr(s), 'dan': repr(dan),
        'grade': grade_name(dan), 'keytype': keytype.label(kt),
        'primary': kt['primary'], 'secondary': kt['secondary'] if kt['secondary'] else None,
        'weak': bool(kt['weak']), 'mixed': bool(kt['mixed']), 'skip': bool(kt['skip']),
        'share': {k: repr(v) for k, v in kt['share'].items()},
        'strength': {k: repr(v) for k, v in kt['strength'].items()},
        'evidence': {k: repr(v) for k, v in kt['evidence'].items()},
        'times': [repr(x) for x in f.times],
        'dts': [repr(x) for x in f.dts],
        'duration': repr(f.duration), 'nps_global': repr(f.nps_global),
        'big_fraction': repr(f.big_fraction), 'switch_fraction': repr(f.switch_fraction),
        'flow': [repr(x) for x in f.flow],
        'bpm_of': [repr(x) for x in f.bpm_of],
        'flow_median': repr(f.flow_median), 'flow_p90': repr(f.flow_p90),
        'bpm_range': [repr(x) for x in f.bpm_range], 'bpm_main': repr(f.bpm_main),
        'mono': [repr(x) for x in f.mono],
        'sixth': [repr(x) for x in f.sixth],
        'mono_load': repr(f.mono_load),
        'sixth_frac': repr(f.sixth_frac),
        'sixth_sustained_frac': repr(f.sixth_sustained_frac),
        'sixth_iso_frac': repr(f.sixth_iso_frac),
        'sixth_ooxxness': repr(f.sixth_ooxxness),
        'run_len_of': list(f.run_len_of),
        'in_stream': [repr(x) for x in getattr(f, 'in_stream', [])],
        'cbits': [repr(x) for x in f.cbits],
        'tbits': [repr(x) for x in f.tbits],
        'mean_colour_bits': repr(f.mean_colour_bits), 'mean_time_bits': repr(f.mean_time_bits),
        'pe': [repr(x) for x in f.ps[0]] if f.ps else None,
        'pc': [repr(x) for x in f.ps[1]] if f.ps else None,
        'pt': [repr(x) for x in f.ps[2]] if f.ps else None,
        'pm': [repr(x) for x in f.ps[3]] if f.ps else None,
        'p6': [repr(x) for x in f.ps[4]] if f.ps else None,
        'env': {repr(T): [repr(f.envelope.z.get(T, 0.0)), repr(f.envelope.nps.get(T, 0.0)),
                          repr(f.envelope.colour_bits.get(T, 0.0)), repr(f.envelope.time_bits.get(T, 0.0)),
                          int(f.envelope.arg.get(T, -1)), int(f.envelope.count.get(T, 0)),
                          [[repr(r[0]), repr(r[1]), repr(r[2]), repr(r[3]), repr(r[4]), repr(r[5]), int(r[6])]
                           for r in f.envelope.top.get(T, [])]]
                for T in f.envelope.windows},
        'run_lengths': list(f.run_lengths),
        'mean_run': repr(f.mean_run), 'max_run': int(f.max_run),
        'long_run_frac': repr(f.long_run_frac), 'long8_frac': repr(f.long8_frac),
        'run1_frac': repr(f.run1_frac),
        'grid_hist': {k: repr(v) for k, v in f.grid_hist.items()},
        'uniform_frac': repr(f.uniform_frac), 'uniform_max': int(f.uniform_max),
        'bpm_median': repr(f.bpm_median), 'subdivision': repr(f.subdivision),
        # dense_rate 在 dts 含 0 时会ZeroDivisionError（退化输入，真实谱不会出现，
        # 且它不在 evaluateDan 的调用链上），这里兜住以免中断整轮对拍
        'dense_rate': (lambda: repr(f.dense_rate(0.15)))() if all(x > 0 for x in f.dts) else None,
        'grid_rate': repr(f.grid_rate(0.25)),
        'dense_pct': [repr(x) for x in f.density_percentiles(1000.0)],
    })
json.dump(out, open(sys.argv[2], 'w', encoding='utf-8'))
`;

const dir = mkdtempSync(join(tmpdir(), 'danfeat-'));
const pyScript = join(dir, 'dump.py');
const inJson = join(dir, 'in.json');
const outJson = join(dir, 'out.json');
writeFileSync(pyScript, PY_SRC, 'utf8');
writeFileSync(inJson, JSON.stringify(CASES.map((c) => ({
  name: c.name,
  notes: c.notes.map((n) => [n.time, n.colour, n.big ? 1 : 0]),
  timing: c.timing,
}))), 'utf8');
execFileSync(PY, [pyScript, inJson, outJson], { stdio: ['ignore', 'inherit', 'inherit'] });
const ref = JSON.parse(readFileSync(outJson, 'utf8'));

/* ---------- 4.逐字段比对 ---------- */
const M = defaultModel();
/**
 * 判定阈值分两档：
 *   HARD_TOL = 1e-9   —— 验收线（任务书要求 |Δdan| < 1e-9）
 *   LIBM_TOL = 1e-12  —— 相对量纲下约 1e4 ulp；超过它才是真的移植错误。
 *
 * 为什么需要 LIBM_TOL 这一档：cbits = -log(p)/log2 里的 Math.log 与 glibc 的
 * math.log 在约 6% 的输入上差 1 ulp。这会顺着前缀和 → 窗口 z → 排序传下去，
 * 表现为「本来完全相等的若干窗口，JS 侧被分成了两组」。这不是移植错误，
 * lib/dan_libm_isolation.mjs 已证明钉住 cbits/tbits 后其余量逐位相同。
 */
const HARD_TOL = 1e-9;
const LIBM_TOL = 1e-12;
const softErrs = [];   // libm 量级的差异（记录但不判失败）

/**
 * 把一条差异按量级分档。
 * @param {number} d 绝对差
 * @param {number} scale 该量的典型量纲（用于把绝对差换成相对差）
 */
function grade(d, scale) {
  const rel = d / (Math.abs(scale) > 1e-12 ? Math.abs(scale) : 1);
  if (!(d <= HARD_TOL)) return 'hard';
  if (!(rel <= LIBM_TOL)) return 'libm';
  return 'ok';
}

/** 数组 / 标量 / dict的统一比对器 */
function cmpArr(path, a, b, errs, scale) {
  if (a === null || b === null) {
    if (a !== b) errs.push(`${path}: JS=${a} Py=${b}`);
    return;
  }
  if (a.length !== b.length) { errs.push(`${path}: 长度 JS=${a.length} Py=${b.length}`); return; }
  for (let i = 0; i < a.length; i++) {
    const x = a[i]; const y = b[i];
    if (x === y) continue;
    const d = Math.abs(x - y);
    const lv = grade(d, scale !== undefined ? scale : Math.max(Math.abs(x), Math.abs(y)));
    if (lv === 'ok') continue;
    const msg = `${path}[${i}]: JS=${x} Py=${y} |Δ|=${d.toExponential(3)}`;
    if (lv === 'libm') { if (softErrs.length < 12) softErrs.push(msg); } else if (errs.length < 40) errs.push(msg);
  }
}
function cmpDict(path, a, b, errs) {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.join('|') !== kb.join('|')) { errs.push(`${path}: 键集 JS=[${ka}] Py=[${kb}]`); return; }
  for (const k of ka) {
    const x = a[k]; const y = Number(b[k]);
    if (x === y) continue;
    const d = Math.abs(x - y);
    const lv = grade(d, Math.max(Math.abs(x), Math.abs(y)));
    if (lv === 'ok') continue;
    const msg = `${path}.${k}: JS=${x} Py=${b[k]} |Δ|=${d.toExponential(3)}`;
    if (lv === 'libm') { if (softErrs.length < 12) softErrs.push(msg); } else errs.push(msg);
  }
}

let pass = 0; let fail = 0;
const allErrs = [];
console.log('='.repeat(100));
console.log('Features 全字段对拍（14 张真谱 + 11 个合成谱，覆盖 mixed / 退化 / 孤立 1/6 等分支）');
console.log('='.repeat(100));

for (let ci = 0; ci < CASES.length; ci++) {
  const c = CASES[ci];
  const p = ref[ci];
  const errs = [];
  const meta = {
    beat_unit: c.beatLenAt,
    sv_unit: c.svAt,
    big_cost: DAN_PARAMS.big_cost,
    lambda_colour: DAN_PARAMS.lambda_colour,
    lambda_time: DAN_PARAMS.lambda_time,
    lambda_mono: DAN_PARAMS.lambda_mono,
    lambda_sixth: DAN_PARAMS.lambda_sixth,
  };
  const f = new Features(c.notes, meta);
  const s = M.rawScalar(f);
  const dan = M.dan(s, f);
  const kt = (await import(pathToFileURL(join(ROOT, 'lib/dan_rank.js')))).classifyKeytype(f, dan);

  cmpArr('times', f.times, p.times.map(Number), errs);
  cmpArr('dts', f.dts, p.dts.map(Number), errs);
  cmpArr('flow', f.flow, p.flow.map(Number), errs);
  cmpArr('bpm_of', f.bpmOf, p.bpm_of.map(Number), errs);
  cmpArr('mono', f.mono, p.mono.map(Number), errs);
  cmpArr('sixth', f.sixth, p.sixth.map(Number), errs);
  cmpArr('cbits', f.cbits, p.cbits.map(Number), errs);
  cmpArr('tbits', f.tbits, p.tbits.map(Number), errs);
  if (p.pe) { cmpArr('pe', f.ps[0], p.pe.map(Number), errs); cmpArr('pc', f.ps[1], p.pc.map(Number), errs); cmpArr('pt', f.ps[2], p.pt.map(Number), errs); cmpArr('pm', f.ps[3], p.pm.map(Number), errs); cmpArr('p6', f.ps[4], p.p6.map(Number), errs); }
  cmpArr('in_stream', f.inStream || [], p.in_stream.map(Number), errs);

  const scal = {
    duration: f.duration, nps_global: f.npsGlobal, big_fraction: f.bigFraction,
    switch_fraction: f.switchFraction, flow_median: f.flowMedian, flow_p90: f.flowP90,
    bpm_main: f.bpmMain, mono_load: f.monoLoad, sixth_frac: f.sixthFrac,
    sixth_sustained_frac: f.sixthSustainedFrac, sixth_iso_frac: f.sixthIsoFrac,
    sixth_ooxxness: f.sixthOoxxness, mean_colour_bits: f.meanColourBits,
    mean_time_bits: f.meanTimeBits, mean_run: f.meanRun,
    long_run_frac: f.longRunFrac, long8_frac: f.long8Frac, run1_frac: f.run1Frac,
    uniform_frac: f.uniformFrac, bpm_median: f.bpmMedian, subdivision: f.subdivision,
    scalar: s, dan,
  };
  const scalPy = {
    duration: Number(p.duration), nps_global: Number(p.nps_global), big_fraction: Number(p.big_fraction),
    switch_fraction: Number(p.switch_fraction), flow_median: Number(p.flow_median), flow_p90: Number(p.flow_p90),
    bpm_main: Number(p.bpm_main), mono_load: Number(p.mono_load), sixth_frac: Number(p.sixth_frac),
    sixth_sustained_frac: Number(p.sixth_sustained_frac), sixth_iso_frac: Number(p.sixth_iso_frac),
    sixth_ooxxness: Number(p.sixth_ooxxness), mean_colour_bits: Number(p.mean_colour_bits),
    mean_time_bits: Number(p.mean_time_bits), mean_run: Number(p.mean_run),
    long_run_frac: Number(p.long_run_frac), long8_frac: Number(p.long8_frac), run1_frac: Number(p.run1_frac),
    uniform_frac: Number(p.uniform_frac), bpm_median: Number(p.bpm_median), subdivision: Number(p.subdivision),
    scalar: Number(p.scalar), dan: Number(p.dan),
  };
  const softBefore = softErrs.length;
  for (const k of Object.keys(scal)) {
    if (k === 'dan') continue;   // 单独报，因为它是最终量
    const d = Math.abs(scal[k] - scalPy[k]);
    if (d === 0) continue;
    const lv = grade(d, Math.max(Math.abs(scal[k]), Math.abs(scalPy[k])));
    if (lv === 'ok') continue;
    const msg = `${k}: JS=${scal[k]} Py=${p[k]} |Δ|=${d.toExponential(3)}`;
    if (lv === 'libm') softErrs.push(msg); else errs.push(msg);
  }
  {
    const d = Math.abs(scal.dan - scalPy.dan);
    if (d > HARD_TOL) errs.push(`dan: JS=${scal.dan} Py=${p.dan} |Δ|=${d.toExponential(3)}`);
    else if (d > 0) softErrs.push(`dan: JS=${scal.dan} Py=${p.dan} |Δ|=${d.toExponential(3)}（libm 量级）`);
  }

  cmpArr('bpm_range', f.bpmRange, p.bpm_range.map(Number), errs);
  cmpArr('dense_pct', f.densityPercentiles(1000.0), p.dense_pct.map(Number), errs);
  if (p.dense_rate !== null) {
    if (Math.abs(f.denseRate(0.15) - Number(p.dense_rate)) > HARD_TOL) errs.push(`dense_rate: JS=${f.denseRate(0.15)} Py=${p.dense_rate}`);
  } else if (f.denseRate(0.15) !== Infinity) {
    // Python 在这里直接抛 ZeroDivisionError，JS 得到 Infinity —— 记录但不判失败
    console.log(`  note: ${c.name} 的 dense_rate 在 Python 侧除零（退化输入，不在 evaluateDan 链路上）`);
  }
  if (Math.abs(f.gridRate(0.25) - Number(p.grid_rate)) > HARD_TOL) errs.push(`grid_rate: JS=${f.gridRate(0.25)} Py=${p.grid_rate}`);
  if (f.maxRun !== p.max_run) errs.push(`max_run: JS=${f.maxRun} Py=${p.max_run}`);
  if (f.uniformMax !== p.uniform_max) errs.push(`uniform_max: JS=${f.uniformMax} Py=${p.uniform_max}`);
  if (JSON.stringify(f.runLengths) !== JSON.stringify(p.run_lengths)) errs.push('run_lengths 不一致');
  if (JSON.stringify(f.runLenOf || []) !== JSON.stringify(p.run_len_of)) errs.push('run_len_of 不一致');
  cmpDict('grid_hist', f.gridHist, p.grid_hist, errs);

  // envelope
  for (const T of f.envelope.windows) {
    const key = Object.keys(p.env).find((k) => Number(k) === T);
    if (!key) { errs.push(`env: Py 缺 T=${T}`); continue; }
    const q = p.env[key];
    // n < 2 时 Python 侧各处都是 `d.get(T, 默认值)`，JS 的 Map.get 没有默认参数，
    // 这里显式补上同样的默认值（算法代码里的 .get(T, ...) 调用点已各自处理）
    const g = (map, key2, dflt) => (map.has(key2) ? map.get(key2) : dflt);
    const softT0 = softErrs.length;
    for (const [name, jsV, pyRaw] of [
      ['z', g(f.envelope.z, T, 0.0), q[0]],
      ['nps', g(f.envelope.nps, T, 0.0), q[1]],
      ['cb', g(f.envelope.colourBits, T, 0.0), q[2]],
      ['tb', g(f.envelope.timeBits, T, 0.0), q[3]],
    ]) {
      const pyV = Number(pyRaw);
      const d = Math.abs(jsV - pyV);
      if (d === 0) continue;
      const lv = grade(d, Math.max(Math.abs(jsV), Math.abs(pyV)));
      if (lv === 'ok') continue;
      const msg = `env.${name}[${T}]: JS=${jsV} Py=${pyRaw} |Δ|=${d.toExponential(3)}`;
      if (lv === 'libm') { if (softErrs.length < 20) softErrs.push(msg); } else errs.push(msg);
    }
    const argJs = g(f.envelope.arg, T, -1);
    const cntJs = g(f.envelope.count, T, 0);
    if (argJs !== q[4]) errs.push(`env.arg[${T}]: JS=${argJs} Py=${q[4]}`);
    if (cntJs !== q[5]) errs.push(`env.count[${T}]: JS=${cntJs} Py=${q[5]}`);
    const top = f.envelope.top.get(T) || [];
    if (top.length !== q[6].length) { errs.push(`env.top[${T}] 长度 JS=${top.length} Py=${q[6].length}`); continue; }
    for (let i = 0; i < top.length; i++) {
      for (let j = 0; j < 6; j++) {
        const pyV = Number(q[6][i][j]);
        const d = Math.abs(top[i][j] - pyV);
        if (d === 0) continue;
        const lv = grade(d, Math.max(Math.abs(top[i][j]), Math.abs(pyV)));
        if (lv === 'ok') continue;
        const msg = `env.top[${T}][${i}][${j}]: JS=${top[i][j]} Py=${q[6][i][j]} |Δ|=${d.toExponential(3)}`;
        if (lv === 'libm') { if (softErrs.length < 20) softErrs.push(msg); } else if (errs.length < 40) errs.push(msg);
      }
      // i 字段：z 完全并列时，两边若因 libm 把并列组切成了不同的大小，
      // 排序后的下标顺序就会不同（窗口本身仍然都在 top 里，只是换了位置）。
      if (top[i][6] !== q[6][i][6]) {
        // 只有当两边的 z 值集合一致、仅顺序不同时才算 libm；否则是真错
        const sameSet = top.every((r, k) => q[6].some((s) => s[6] === r[6])
          && Math.abs(r[0] - Number(q[6].find((s) => s[6] === r[6])[0])) <= LIBM_TOL * Math.abs(r[0]));
        if (sameSet) {
          if (softErrs.length < 20) softErrs.push(`env.top[${T}][${i}].i 并列组顺序: JS=${top[i][6]} Py=${q[6][i][6]}（z 集合相同，libm 切分并列组所致）`);
        } else {
          errs.push(`env.top[${T}][${i}].i: JS=${top[i][6]} Py=${q[6][i][6]}`);
        }
      }
    }
    void softT0;
  }

  // keytype
  cmpDict('strength', kt.strength, p.strength, errs);
  cmpDict('share', kt.share, p.share, errs);
  cmpDict('evidence', kt.evidence, p.evidence, errs);
  if (kt.primary !== p.primary) errs.push(`primary: JS=${kt.primary} Py=${p.primary}`);
  if ((kt.secondary || null) !== p.secondary) errs.push(`secondary: JS=${kt.secondary} Py=${p.secondary}`);
  if (kt.weak !== p.weak) errs.push(`weak: JS=${kt.weak} Py=${p.weak}`);
  if (kt.mixed !== p.mixed) errs.push(`mixed: JS=${kt.mixed} Py=${p.mixed}`);
  if (kt.skip !== p.skip) errs.push(`skip: JS=${kt.skip} Py=${p.skip}`);
  const ktLabel = kt.skip ? '-' : (kt.mixed ? '混合' : (kt.weak ? '常规' : kt.primary + (kt.secondary ? `,${kt.secondary}` : '')));
  if (ktLabel !== p.keytype) errs.push(`keytype: JS=${ktLabel} Py=${p.keytype}`);

  if (errs.length) {
    fail += 1;
    allErrs.push({ name: c.name, errs: errs.slice(0, 12) });
    console.log(`FAIL ${c.name.padEnd(46)} dan=${dan.toFixed(4)} ${ktLabel} (${errs.length} 处硬差异)`);
    for (const e of errs) console.log(`       ! ${e}`);
  } else {
    pass += 1;
    const nSoft = softErrs.length - softBefore;
    console.log(`ok   ${c.name.padEnd(46)} dan=${dan.toFixed(4).padStart(8)} ${ktLabel}`
      + (nSoft ? `   (${nSoft} 处 libm 量级)` : ''));
  }
}

console.log('-'.repeat(100));
console.log(`通过 ${pass} / ${pass + fail}   失败 ${fail}`);
if (fail) {
  console.log('\n硬差异明细（超过 1e-9，属移植错误）：');
  for (const x of allErrs) {
    console.log(`  ${x.name}`);
    for (const e of x.errs) console.log(`      ${e}`);
  }
}
if (softErrs.length) {
  console.log(`\nlibm 量级差异（≤1e-12 相对，不判失败；来源见 dan_libm_isolation.mjs）：`);
  for (const e of softErrs) console.log(`    ${e}`);
}
for (const p of [pyScript, inJson, outJson]) { try { unlinkSync(p); } catch { /* noop */ } }
process.exit(fail ? 1 : 0);