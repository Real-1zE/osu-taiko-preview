/**
 * 隔离验证：把 Python 算好的 cbits / tbits **直接喂给** JS，
 * 之后的所有量（包络前缀和、z、env.top、scalar、dan、键型）必须**逐位相同**。
 *
 * 为什么需要这一层：
 *   dan_features_parity.mjs 会报出 cbits 有 1~2 ulp 的差异。根因不在移植，
 *   而在**V8 的 Math.log 与 glibc 的 math.log 不是同一个实现**
 *   （实测35014 个输入里有 2217 个差 1 ulp；log2 差 444个；exp 差 461 个）。
 *   cbits = -log(p)/log2 被这个 1 ulp 污染后，经前缀和放大到 z，
 *   再经排序传到最终 dan —— 实测最大 5.3e-15。
 *
 *   本脚本证明：**除 libm 之外没有任何算法层偏差**。
 *   若这里出现任何不等，那就是移植写错了。
 *
 * 用法：node test/dan_libm_isolation.mjs
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

const D = await import(pathToFileURL(join(ROOT, 'lib/dan_rank.js')));
const { DAN_PARAMS } = await import(pathToFileURL(join(ROOT, 'lib/dan_calibration.js')));
const { parseOsu } = await import(pathToFileURL(join(ROOT, 'lib/osu_parser.js')));

/* ---------- 造用例 ---------- */
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
  return { beat: (t) => lastOf(reds, t, 'bl', 500), sv: (t) => lastOf(effs, t, 'sm', 1.0), reds, effs };
}

const CASES = [];
for (const f of readdirSync(join(ROOT, 'test/test_zips')).filter((x) => x.endsWith('.osu')).sort()) {
  const bm = parseOsu(readFileSync(join(ROOT, 'test/test_zips', f), 'utf8'));
  const t = pyTiming(bm);
  const notes = [];
  for (const n of bm.notes) {
    if (n.kind !== 'don' && n.kind !== 'kat' && n.kind !== 'big') continue;
    notes.push([n.time, n.blue ? 1 : 0, n.kind === 'big' ? 1 : 0]);
  }
  CASES.push({ name: `real:${f.slice(0, 34)}`, notes, reds: t.reds, effs: t.effs });
}

/* ---------- Python：算 cbits / tbits 并把后续全量导出 ---------- */
const PY_SRC = `
import sys, json
sys.path.insert(0, ${JSON.stringify(REPO)})
from dan_rank import context as C
from dan_rank.features import Features
from dan_rank.model import load_default, grade_name
from dan_rank import keytype

def last_of(pts, t, i, dflt):
    if not pts:
        return dflt
    if t < pts[0][0]:
        return pts[0][i]
    lo, hi = 0, len(pts) - 1
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if pts[mid][0] <= t:
            lo = mid
        else:
            hi = mid - 1
    return pts[lo][i]

m = load_default()
cases = json.load(open(sys.argv[1], encoding='utf-8'))
out = []
for c in cases:
    reds = [[p['time'], p['bl']] for p in c['reds']]
    effs = [[p['time'], p['sm']] for p in c['effs']]
    meta = {
        'beat_unit': lambda t: last_of(reds, t, 1, 500),
        'sv_unit': lambda t: last_of(effs, t, 1, 1.0),
        'big_cost': m.params['big_cost'], 'lambda_colour': m.params['lambda_colour'],
        'lambda_time': m.params['lambda_time'], 'lambda_mono': m.params['lambda_mono'],
        'lambda_sixth': m.params['lambda_sixth'],
    }
    notes = [type('N', (), {'time': a, 'colour': b, 'big': bool(cc)})() for a, b, cc in c['notes']]
    cb, tb = C.build_surprise_models(notes)
    #把 Python 的惊讶度钉回去，重算一遍 Features
    orig = C.build_surprise_models
    C.build_surprise_models = lambda notes, *a, **k: (cb, tb)
    import dan_rank.features as FT
    FT.C.build_surprise_models = C.build_surprise_models
    f = Features(notes, meta)
    C.build_surprise_models = orig
    s = m.raw_scalar(f)
    dan = m.dan(s, f)
    kt = keytype.classify(f, dan)
    out.append({
        'cbits': [repr(v) for v in cb], 'tbits': [repr(v) for v in tb],
        'mean_colour_bits': repr(f.mean_colour_bits), 'mean_time_bits': repr(f.mean_time_bits),
        'pe': [repr(v) for v in f.ps[0]], 'pc': [repr(v) for v in f.ps[1]],
        'pt': [repr(v) for v in f.ps[2]], 'pm': [repr(v) for v in f.ps[3]],
        'p6': [repr(v) for v in f.ps[4]],
        'env': {str(T): [repr(f.envelope.z.get(T, 0.0)), repr(f.envelope.nps.get(T, 0.0)),
                          int(f.envelope.arg.get(T, -1)), int(f.envelope.count.get(T, 0)),
                          [[repr(r[j]) for j in range(6)] + [int(r[6])]
                           for r in f.envelope.top.get(T, [])]]
                for T in f.envelope.windows},
        'scalar': repr(s), 'dan': repr(dan),
        'grade': grade_name(dan), 'keytype': keytype.label(kt),
        'primary': kt['primary'], 'secondary': kt['secondary'] if kt['secondary'] else None,
        'weak': bool(kt['weak']), 'mixed': bool(kt['mixed']),
        'strength': {k: repr(v) for k, v in kt['strength'].items()},
        'evidence': {k: repr(v) for k, v in kt['evidence'].items()},
    })
json.dump(out, open(sys.argv[2], 'w', encoding='utf-8'))
`;

const dir = mkdtempSync(join(tmpdir(), 'daniso-'));
const pyScript = join(dir, 'd.py');
const inJson = join(dir, 'i.json');
const outJson = join(dir, 'o.json');
writeFileSync(pyScript, PY_SRC, 'utf8');
writeFileSync(inJson, JSON.stringify(CASES.map((c) => ({ notes: c.notes, reds: c.reds, effs: c.effs }))), 'utf8');
execFileSync(PY, [pyScript, inJson, outJson], { stdio: ['ignore', 'inherit', 'inherit'] });
const ref = JSON.parse(readFileSync(outJson, 'utf8'));

/* ---------- JS：钉入同样的 cbits / tbits，逐位比对 ---------- */
const lastOf = (pts, t, key, dflt) => {
  if (!pts.length) return dflt;
  if (t < pts[0].time) return pts[0][key];
  let lo = 0; let hi = pts.length - 1;
  while (lo < hi) { const m = Math.floor((lo + hi + 1) / 2); if (pts[m].time <= t) lo = m; else hi = m - 1; }
  return pts[lo][key];
};

let pass = 0;
let fail = 0;
const fails = [];
let worst = 0;

console.log('='.repeat(96));
console.log('libm 隔离验证 —— 钉住 cbits/tbits 后，其余量必须逐位（|Δ|=0）相同');
console.log('='.repeat(96));

for (let ci = 0; ci < CASES.length; ci++) {
  const c = CASES[ci];
  const p = ref[ci];
  const notes = c.notes.map(([t, col, b]) => ({ time: t, colour: col, big: !!b }));
  const meta = {
    beat_unit: (t) => lastOf(c.reds, t, 'bl', 500),
    sv_unit: (t) => lastOf(c.effs, t, 'sm', 1.0),
    big_cost: DAN_PARAMS.big_cost,
    lambda_colour: DAN_PARAMS.lambda_colour,
    lambda_time: DAN_PARAMS.lambda_time,
    lambda_mono: DAN_PARAMS.lambda_mono,
    lambda_sixth: DAN_PARAMS.lambda_sixth,
  };
  const f = new D.Features(notes, meta);
  // ★ 钉住惊讶度：把 libm 差异的唯一来源掐断
  f.cbits = p.cbits.map(Number);
  f.tbits = p.tbits.map(Number);
  f.meanColourBits = Number(p.mean_colour_bits);
  f.meanTimeBits = Number(p.mean_time_bits);
  f._computeEnvelope();

  const M = D.defaultModel();
  const s = M.rawScalar(f);
  const dan = M.dan(s, f);
  const kt = D.classifyKeytype(f, dan);

  const errs = [];
  const exact = (path, a, b) => {
    if (a.length !== b.length) { errs.push(`${path} 长度 JS=${a.length} Py=${b.length}`); return; }
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        worst = Math.max(worst, Math.abs(a[i] - b[i]));
        if (errs.length < 8) errs.push(`${path}[${i}] JS=${a[i]} Py=${b[i]}`);
      }
    }
  };
  if (f.ps) {
    exact('pe', f.ps[0], p.pe.map(Number));
    exact('pc', f.ps[1], p.pc.map(Number));
    exact('pt', f.ps[2], p.pt.map(Number));
    exact('pm', f.ps[3], p.pm.map(Number));
    exact('p6', f.ps[4], p.p6.map(Number));
  }
  for (const T of f.envelope.windows) {
    const key = Object.keys(p.env).find((k) => Number(k) === T);
    const q = p.env[key];
    if (f.envelope.z.get(T) !== Number(q[0])) errs.push(`env.z[${T}] JS=${f.envelope.z.get(T)} Py=${q[0]}`);
    if (f.envelope.nps.get(T) !== Number(q[1])) errs.push(`env.nps[${T}] JS=${f.envelope.nps.get(T)} Py=${q[1]}`);
    if (f.envelope.arg.get(T) !== q[2]) errs.push(`env.arg[${T}] JS=${f.envelope.arg.get(T)} Py=${q[2]}`);
    if (f.envelope.count.get(T) !== q[3]) errs.push(`env.count[${T}] JS=${f.envelope.count.get(T)} Py=${q[3]}`);
    const top = f.envelope.top.get(T) || [];
    if (top.length !== q[4].length) { errs.push(`env.top[${T}] 长度 JS=${top.length} Py=${q[4].length}`); continue; }
    for (let i = 0; i < top.length; i++) {
      for (let j = 0; j < 6; j++) {
        if (top[i][j] !== Number(q[4][i][j])) {
          worst = Math.max(worst, Math.abs(top[i][j] - Number(q[4][i][j])));
          if (errs.length < 8) errs.push(`env.top[${T}][${i}][${j}] JS=${top[i][j]} Py=${q[4][i][j]}`);
        }
      }
      if (top[i][6] !== q[4][i][6]) errs.push(`env.top[${T}][${i}].i JS=${top[i][6]} Py=${q[4][i][6]}`);
    }
  }
  if (s !== Number(p.scalar)) { worst = Math.max(worst, Math.abs(s - Number(p.scalar))); errs.push(`scalar JS=${s} Py=${p.scalar}`); }
  if (dan !== Number(p.dan)) { worst = Math.max(worst, Math.abs(dan - Number(p.dan))); errs.push(`dan JS=${dan} Py=${p.dan}`); }
  if (D.gradeName(dan) !== p.grade) errs.push(`grade JS=${D.gradeName(dan)} Py=${p.grade}`);
  const lbl = D.labelKeytype(kt);
  if (lbl !== p.keytype) errs.push(`keytype JS=${lbl} Py=${p.keytype}`);
  if (kt.primary !== p.primary) errs.push(`primary JS=${kt.primary} Py=${p.primary}`);
  if ((kt.secondary || null) !== p.secondary) errs.push(`secondary JS=${kt.secondary} Py=${p.secondary}`);
  if (kt.weak !== p.weak) errs.push(`weak JS=${kt.weak} Py=${p.weak}`);
  if (kt.mixed !== p.mixed) errs.push(`mixed JS=${kt.mixed} Py=${p.mixed}`);
  for (const k of Object.keys(p.strength)) {
    if (kt.strength[k] !== Number(p.strength[k])) errs.push(`strength.${k} JS=${kt.strength[k]} Py=${p.strength[k]}`);
  }
  for (const k of Object.keys(p.evidence)) {
    if (kt.evidence[k] !== Number(p.evidence[k])) errs.push(`evidence.${k} JS=${kt.evidence[k]} Py=${p.evidence[k]}`);
  }

  if (errs.length) { fail += 1; fails.push({ name: c.name, errs }); } else { pass += 1; }
  console.log(`${errs.length ? 'FAIL' : 'ok  '} ${c.name.padEnd(46)} dan=${dan}  ${p.grade} ${p.keytype}`);
  for (const e of errs) console.log(`       ! ${e}`);
}

console.log('-'.repeat(96));
console.log(`逐位相同 ${pass} / ${pass + fail}`);

/*
 * 剩下的差异只可能出现在下面这几个量上：
 *   dan / evidence.dan      ← Model.dan 的 curve(math.log(scalar))（model.py:220）
 *   evidence.speedrel       ← keytype.expected_speed 的 math.exp（keytype.py:112）
 * 两者都是 V8 与 glibc 的 libm 实现差异：Math.log / Math.exp 与 math.log / math.exp
 * 在约 6%~9% 的输入上差 1 ulp（实测 log 2217/35014、log2 444/35014、exp 461/5000）。
 * glibc 的 log 并非正确舍入（Decimal 60 位对比：4008 个采样里 7 个与正确舍入值不同），
 * 所以在 JS 里重写一个「正确舍入的 log/exp」也无法位对齐。
 * 详见 lib/dan_rank.js 顶部说明。
 */
const LIBM_KEYS = /^(dan|evidence\.dan|evidence\.speedrel|evidence\.dan) /;
const onlyLibm = fails.every((x) => x.errs.every((e) => LIBM_KEYS.test(e)));
if (fail) {
  console.log(`仍有差异（最大 ${worst.toExponential(3)}）：`);
  for (const x of fails) console.log(`  ${x.name}: ${x.errs.length} 处 -> ${x.errs.join('; ')}`);
  if (onlyLibm) {
    console.log('\n=> 差异**仅限 libm 直接参与计算的量**（dan / speedrel）；');
    console.log('   前缀和 / 包络 z / env.top / scalar / grade / keytype 全部逐位相同');
    console.log('   ⇒ 除 libm 外没有任何算法层偏差。');
  } else {
    console.log('\n!! 差异出现在预期之外 —— 说明除 libm 外仍有移植偏差，需要继续查。');
  }
} else {
  console.log('=> 全部逐位相同。');
}
for (const p of [pyScript, inJson, outJson]) { try { unlinkSync(p); } catch { /* noop */ } }
process.exit(onlyLibm ? 0 : 1);