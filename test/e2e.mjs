/**
 * 端到端验证：在 Node 里模拟插件环境跑「下载 -> 解析 -> 布局 -> 渲染」。
 *
 * 验证点：
 *   1. lib 三个模块能正常 import（相对导入在 chrome-extension:// 下同样成立）
 *   2. parseOsu -> computeLayout -> PreviewRenderer 全链路不抛异常
 *   3. renderPage 的 o.rows 参数生效（小窗要一次画完所有行）
 *   4. 输出画布尺寸合理（不是 0 / 不是天文数字）
 *   5. 构造出的谱面元数据正确（bpmAt / t0 / tEnd）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, '..', 'lib');

/* ---------- 最小 canvas 桩 ---------- */
function makeCtxStub(calls) {
  const grad = { addColorStop() {} };
  const handler = {
    get(target, prop) {
      if (prop in target) return target[prop];
      const fn = (...args) => { calls[prop] = (calls[prop] || 0) + 1; };
      switch (prop) {
        case 'measureText':
          return (s) => { calls.measureText = (calls.measureText || 0) + 1;
                          return { width: String(s).length * 7 }; };
        case 'createLinearGradient':
          return () => { calls.createLinearGradient = 1; return grad; };
        case 'getImageData':
          return () => ({ data: [] });
        case 'canvas':
          return { width: 1, height: 1 };
        /* ★ 记录 fillRect 的**参数**（不只是次数）。
         * 休息段条纹的灰底是 `fillRect(x0, y0, x1-x0, trackH)`，
         * 宽度为负 => 那一行的条纹实际没画出来。
         * 只数次数看不出这个差别，必须看 w。 */
        case 'fillRect':
          return (x, y, w, h) => {
            calls.fillRect = (calls.fillRect || 0) + 1;
            if (!calls.rects) calls.rects = [];
            calls.rects.push({ x, y, w, h, fill: target.fillStyle || '' });
          };
        default:
          return fn;
      }
    },
    set(target, prop, value) { target[prop] = value; return true; },
  };
  return new Proxy({}, handler);
}

function makeCanvasStub(w, h, calls) {
  return {
    width: w, height: h,
    style: {},
    getContext: () => makeCtxStub(calls),
    toDataURL: () => 'data:image/png;base64,',
  };
}

/* ---------- 主流程 ---------- */
/* Windows 下ESM import 必须用 file:// URL，绝对路径会报 ERR_UNSUPPORTED_ESM_URL_SCHEME */
const fileUrl = (p) => pathToFileURL(p).href;

const [parser, layout, renderer] = await Promise.all([
  import(fileUrl(path.join(LIB, 'osu_parser.js'))),
  import(fileUrl(path.join(LIB, 'layout.js'))),
  import(fileUrl(path.join(LIB, 'renderer.js'))),
]);

console.log('[1] 模块 import 成功');
console.log('    parseOsu=%s computeLayout=%s PreviewRenderer=%s',
  typeof parser.parseOsu, typeof layout.computeLayout, typeof renderer.PreviewRenderer);

/* 桩掉 DOM：renderer 用 document.createElement('canvas') */
globalThis.document = {
  createElement(tag) {
    if (tag !== 'canvas') return {};
    const calls = globalThis.__calls || (globalThis.__calls = {});
    return makeCanvasStub(300, 150, calls);
  },
};
globalThis.window = globalThis;

/* 找一张真实谱：谱面放在插件**上两级**的 osu2/ 下（与插件同级）。
   注意 HERE = <插件>/test/，所以要 ../.. 才到 osu2/。 */
const mapsRoot = path.join(HERE, '..', '..');

function walkOsu(dir, depth, out) {
  if (depth > 4 || out.length >= 8) return;
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const it of items) {
    const name = it.name;
    if (it.isDirectory()) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      walkOsu(path.join(dir, name), depth + 1, out);
    } else if (name.toLowerCase().endsWith('.osu')) {
      out.push(path.join(dir, name));
    }
  }
}

function findMap() {
  const found = [];
  walkOsu(mapsRoot, 0, found);
  if (!found.length) return null;
  /*优先选有连打/转盘的谱（能覆盖更多绘制分支） */
  const scored = found.map((f) => {
    const t = fs.readFileSync(f, 'utf8');
    let score = 0;
    if (/(^|,)L\|/m.test(t)) score += 3;       // 连打
    if (/,(128|192),/m.test(t)) score += 2;     // 转盘/spinner
    if (/,B\|/m.test(t)) score += 3;            // 大连打
    if (t.length > 40000) score += 1;           // 复杂谱
    return { f, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].f;
}

const mapPath = findMap();
if (!mapPath) { console.error('找不到测试谱面'); process.exit(1); }
const text = fs.readFileSync(mapPath, 'utf8');
console.log('[2] 读取谱面 %s (%d 字节)', path.basename(mapPath).slice(0, 40), text.length);

/* 解析 */
const bm = parser.parseOsu(text);
console.log('[3] 解析 OK: notes=%d timingPoints=%d breaks=%d',
  bm.notes.length, bm.timingPoints.length, (bm.breaks || []).length);
console.log('    title=%s - %s [%s]', bm.artist, bm.title, bm.version);
console.log('    beatmapId=%s beatmapSetId=%s', bm.beatmapId, bm.beatmapSetId);

/* 布局：完全复刻 content.js 的 buildPreview（applyCompact + headerHeight） */
const WIDTH = 660;              /* 小窗内容宽度约 660px */
const STAGE_H = 300;            /* 视口高度 */
const cfg = layout.applyCompact(Object.assign({}, layout.DEFAULTS), WIDTH);
/* 高度必须问 renderer 要 —— 之前这里自己写 `260 × k`，与绘制端不一致，
   导致最后一条刻度条被裁掉。 */
cfg.headerHeight = renderer.headerHeightFor(WIDTH);
const aligned = layout.alignPixelsPerSecond(bm, cfg);
const pps = aligned > 0 ? aligned
  : Math.max(40, Math.min(900, (WIDTH - cfg.marginX * 2) / ((layout.maxEnd(bm) / 1000) / 14)));
cfg.pixelsPerSecond = pps;
console.log('[4] 紧凑配置: note直径=%d 轨道高=%d 行高=%d 边距=%d 每行小节=%d',
  cfg.noteDiameter, cfg.stripeHeight, cfg.rowHeight, cfg.marginX, cfg.measuresPerRow);
console.log('    密度: align=%s -> pps=%s（不夹取，保证小节对齐）',
  aligned ? aligned.toFixed(1) : 'null', pps.toFixed(1));

/* 每行16分音符数 = mpr × meter × 4，间距 = usable /该值 */
const usable = WIDTH - cfg.marginX * 2;
const sp16 = usable / (cfg.measuresPerRow * 4 * 4);
console.log('    每行 %d 小节 / %d 个16分音符，横向间距 %s px，音符 %d px（占 %s%%）',
  cfg.measuresPerRow, cfg.measuresPerRow * 16, sp16.toFixed(1),
  cfg.noteDiameter, ((cfg.noteDiameter / sp16) * 100).toFixed(0));

const lay = layout.computeLayout(bm, cfg);
console.log('    布局 OK: rows=%d height=%d bodyTop=%d t0=%d tEnd=%d',
  lay.rowsUsed, lay.height, lay.bodyTop, lay.t0, lay.tEnd);
console.log('    measureTimes=%d bpmMarks=%d denseRows=%s',
  lay.measureTimes.length, lay.bpmMarks.length, JSON.stringify(lay.denseRows));

/* 渲染（带信息栏） */
const calls = (globalThis.__calls = {});
const r = new renderer.PreviewRenderer(bm, lay, cfg, { loaded: false }, {
  header: true, bgImage: null, useSkin: false,
  showGrid: true, showMeasure: true, showSv: true,
});

/* ---------- 断言收集 ---------- */
const errs = [];

/* 信息栏高度必须与绘制端一致（layout.bodyTop = headerHeight + paddingTop）*/
{
  const want = renderer.headerHeightFor(WIDTH);
  if (cfg.headerHeight !== want) {
    errs.push(`headerHeight ${cfg.headerHeight} != renderer.headerHeightFor ${want}`);
  }
  if (lay.bodyTop !== cfg.headerHeight + cfg.paddingTop) {
    errs.push(`bodyTop ${lay.bodyTop} 应等于 headerHeight+paddingTop ${cfg.headerHeight + cfg.paddingTop}`);
  }
  /* 内容栏不能高到把谱面挤没（用户反馈「信息框太大」）*/
  const bodyRatio = lay.bodyTop / Math.max(1, lay.height);
  if (bodyRatio > 0.25) {
    errs.push(`信息栏占整图高度 ${(bodyRatio * 100).toFixed(0)}%，过高（应≤25%）`);
  }
  console.log('    信息栏高 %d（占整图 %s%%），bodyTop %d',
    cfg.headerHeight, (bodyRatio * 100).toFixed(0), lay.bodyTop);
}

/* 整首一次画成一张长canvas（content.js 的 render() 就是这么做的） */
const canvas = r.renderPage(0, { rows: [0, lay.rowsUsed] });
console.log('[5] 整首渲染 OK: canvas=%dx%d', canvas.width, canvas.height);
const totalCalls = Object.entries(calls)
  .filter(([k]) => k !== 'measureText' && k !== 'createLinearGradient')
  .reduce((s, [, v]) => s + v, 0);
console.log('    ctx 调用=%d fillText=%d measureText=%d',
  totalCalls, calls.fillText || 0, calls.measureText || 0);

/* 断言 */
if (canvas.width !== WIDTH) errs.push(`画布宽 ${canvas.width} != ${WIDTH}`);
if (!(canvas.height > 100)) errs.push('画布高异常: ' + canvas.height);
/* Chrome 单边上限约 32767px、面积约 2.68 亿 px */
const MAX_DIM = 32000;
const MAX_AREA = 260e6;
/* 音符不能挤成一坨：直径超过间距就完全重叠、读不出节奏 */
if (cfg.noteDiameter > sp16) {
  errs.push(`音符直径 ${cfg.noteDiameter} 超过 16分间距 ${sp16.toFixed(1)}，会糊成一片`);
}
/* 也不能太小到看不出是饼 */
if (cfg.noteDiameter < 11) errs.push(`音符直径 ${cfg.noteDiameter} 过小`);
/* 每行小节数必须在 3~4（用户要求 3-4 个完整小节）*/
if (cfg.measuresPerRow < 3 || cfg.measuresPerRow > 4) {
  errs.push(`每行小节数 ${cfg.measuresPerRow} 不在 3~4 范围内`);
}
if (canvas.height > MAX_DIM) {
  errs.push(`画布高 ${canvas.height} 超过浏览器单边上限 ~${MAX_DIM}，需退回分页`);
}
if (canvas.width * canvas.height > MAX_AREA) {
  errs.push(`画布面积 ${(canvas.width * canvas.height / 1e6).toFixed(1)}M 超过浏览器上限`);
}
if (!bm.notes.length) errs.push('没有音符');
if (!lay.rowsUsed) errs.push('行数为 0');
if (!calls.fillText) errs.push('没有绘制任何文字（小节号/SV/BPM）');
if (!calls.stroke && !calls.fillRect) errs.push('没有绘制任何图形');

/* ---------- 额外：平移所需的行偏移表（复刻 content.js 的 computeRowTops） ---------- */
const rowH = layout.rowHeightOf;
const rowTops = new Float64Array(lay.rowsUsed + 1);
{
  let y = lay.bodyTop || 0;
  for (let i = 0; i < lay.rowsUsed; i++) {
    rowTops[i] = y;
    y += rowH(cfg, lay.subsPerRow[i] || 1, lay.denseRows[i] || 0);
  }
  rowTops[lay.rowsUsed] = y;
}
/* rowTops 最后一个值应与画布内容高度一致（允许 paddingBottom 的误差） */
const rowSpan = rowTops[lay.rowsUsed] - (lay.bodyTop || 0);
console.log('[6] 行偏移表: bodyTop=%d 末行底=%d 画布高=%d',
  lay.bodyTop || 0, rowTops[lay.rowsUsed], canvas.height);
if (rowTops[0] !== (lay.bodyTop || 0)) {
  errs.push(`rowTops[0]=${rowTops[0]} 应等于 bodyTop=${lay.bodyTop || 0}`);
}
if (rowTops[lay.rowsUsed] > canvas.height + 1) {
  errs.push(`行偏移表末端 ${rowTops[lay.rowsUsed]} 超出画布高 ${canvas.height}`);
}
if (canvas.height - rowTops[lay.rowsUsed] > cfg.paddingBottom + 2) {
  errs.push(`画布底部留白 ${canvas.height - rowTops[lay.rowsUsed]} 远大于 paddingBottom=${cfg.paddingBottom}`);
}

/* 行偏移必须严格递增，否则 y -> 行的二分查找会失效 */
for (let i = 1; i <= lay.rowsUsed; i++) {
  if (!(rowTops[i] > rowTops[i - 1])) {
    errs.push(`rowTops 非递增：rowTops[${i}]=${rowTops[i]} <= rowTops[${i - 1}]=${rowTops[i - 1]}`);
    break;
  }
}

/* 模拟窗口内拖动：视口高STAGE_H，最大滚动 = 内容高 - 视口高 */
const scale = WIDTH / canvas.width;          /* CSS 100% 缩放比，此处应为 1 */
const dispH = canvas.height * scale;
const maxScroll = Math.max(0, dispH - STAGE_H);
console.log('    视口 %dx%d内容显示高=%d -> 最大滚动=%dpx（约 %d 屏）',
  WIDTH, STAGE_H, dispH.toFixed(0), maxScroll.toFixed(0),
  (maxScroll / STAGE_H).toFixed(1));
if (maxScroll <= 0) {
  console.log('    （这张谱一屏放得下，无需平移）');
} else {
  /* 抽查几个滚动位置，确认 y->行 的二分查找能落在合法区间 */
  for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
    const cy = (maxScroll * frac) / scale;
    let lo = 0, hi = lay.rowsUsed;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (rowTops[mid] <= cy) lo = mid; else hi = mid;
    }
    const row = Math.min(lay.rowsUsed - 1, lo);
    if (row < 0 || row >= lay.rowsUsed) {
      errs.push(`frac=${frac} 二分查找得到非法行号 ${row}`);
    }
    if (cy > rowTops[row] && row + 1 <= lay.rowsUsed && rowTops[row + 1] <= cy) {
      errs.push(`frac=${frac} 行定位错位：cy=${cy} 同时落在 row ${row} 与 ${row + 1} 之间`);
    }
  }
  console.log('    滚动定位抽查 OK');
}

/* ---------- 额外：样本谱的模式守卫 ---------- */
/* osu! 的 Mode：0=std 1=taiko 2=catch 3=mania。
   守卫只应放行 Mode 1；其余模式必须被拒绝，
   否则会把 std 的圆形点击圈误渲染成 taiko 预览（完全错误的结果）。 */
const zipRoot = path.join(HERE, 'test_zips');
if (fs.existsSync(zipRoot)) {
  const osuFiles = [];
  const walk2 = (d, depth) => {
    if (depth > 2) return;
    let items;
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (it.isDirectory()) walk2(path.join(d, it.name), depth + 1);
      else if (it.name.endsWith('.osu')) osuFiles.push(path.join(d, it.name));
    }
  };
  walk2(zipRoot, 0);

  const modes = new Map();
  for (const f of osuFiles) {
    const b = parser.parseOsu(fs.readFileSync(f, 'utf8'));
    modes.set(b.mode, (modes.get(b.mode) || 0) + 1);
    if (b.mode !== 1) {
      errs.push(`${path.basename(f)} 是 Mode ${b.mode}，非 taiko，应被守卫拒绝但未识别`);
    }
    /* 原生 taiko 绝不能走转换路径 —— 转换用的是另一套连打时长公式，
       静默走错分支的话读谱画面上的大连打会明显偏短。*/
    if (b.isConvert) {
      errs.push(`${path.basename(f)} 是 Mode 1，不该被标记 isConvert`);
    }
  }
  if (modes.size) {
    const desc = [...modes.entries()]
      .map(([m, n]) => `Mode${m}×${n}`).join(' ');
    console.log('[7] .osz 样本模式分布: %s（仅 Mode1=taiko 应被放行）', desc);
  }
}

/* ---------- 额外：全部样本都能整首渲染且不撞上限 ---------- */
if (fs.existsSync(zipRoot)) {
  let checked = 0, worstH = 0, worstName = '';
  let worstRows = 0, rowsName = '';
  let minGap = Infinity, gapName = '';
  for (const f of fs.readdirSync(zipRoot).filter((n) => n.endsWith('.osu'))) {
    const b = parser.parseOsu(fs.readFileSync(path.join(zipRoot, f), 'utf8'));
    if (b.mode !== 1 || !b.notes.length) continue;
    const w = 660;
    const c2 = layout.applyCompact(Object.assign({}, layout.DEFAULTS), w);
    c2.headerHeight = renderer.headerHeightFor(w);
    const al = layout.alignPixelsPerSecond(b, c2);
    c2.pixelsPerSecond = al > 0 ? al
      : Math.max(40, Math.min(900, (w - c2.marginX * 2) / ((layout.maxEnd(b) / 1000) / 14)));
    const l2 = layout.computeLayout(b, c2);
    const cv = new renderer.PreviewRenderer(b, l2, c2, { loaded: false }, {
      header: true, bgImage: null, useSkin: false,
      showGrid: true, showMeasure: true, showSv: true,
    }).renderPage(0, { rows: [0, l2.rowsUsed] });
    checked++;
    if (cv.height > worstH) { worstH = cv.height; worstName = f; }
    if (l2.rowsUsed > worstRows) { worstRows = l2.rowsUsed; rowsName = f; }
    const us = w - c2.marginX * 2;
    const gap = us / (c2.measuresPerRow * 16);
    if (gap < minGap) { minGap = gap; gapName = f; }
    if (cv.height > MAX_DIM) {
      errs.push(`${f} 整首画布高 ${cv.height} 超单边上限`);
    }
    if (cv.width * cv.height > MAX_AREA) {
      errs.push(`${f} 整首画布面积超上限`);
    }
    /* 音符直径不得超过 16 分间距（否则音符互相压盖、读不出节奏）*/
    if (c2.noteDiameter > gap) {
      errs.push(`${f} 音符直径 ${c2.noteDiameter} > 16分间距 ${gap.toFixed(1)}`);
    }
    /* 每行必须放得下 3 个以上完整小节 */
    if (c2.measuresPerRow < 3) errs.push(`${f} 每行仅 ${c2.measuresPerRow} 个小节`);

    /* ---- [8a] ★★ 休息段覆盖的行必须有轨道背景 ----
     * 用户反馈：「休息段的条纹跨两行的时候，中间一行直接连轨道消失了」。
     *
     * 成因：轨道背景由 _computeRowContent 决定「哪些行算有内容」，
     * 而它原先只看音符 + 长物件。**休息段内部本来就没有音符**
     *（那正是休息的含义），于是横跨多行的休息段里，
     * 那些整段都在休息里的行既没音符也没长物件 -> 轨道被跳过，
     * 只剩_drawBreakStripes 画出的斜条纹浮在空白背景上。
     *
     * 判据必须与 _drawBreakStripes 的行取法完全一致：
     *   起点行 = rowAt(段 ∩ 可视区 的起点)
     *   终点行 = rowAt(终点 - 1)   ← 减 1，避免「结束正好在行首」时多算一行
     */
    if (b.breaks && b.breaks.length) {
      const ren = new renderer.PreviewRenderer(b, l2, c2, { loaded: false }, {
        header: true, bgImage: null, useSkin: false, showGrid: true,
      });
      for (const [bs, be] of b.breaks) {
        const t0 = Math.max(bs, l2.t0), t1 = Math.min(be, l2.tEnd);
        if (t1 <= t0) continue;
        const r0 = l2.rowAt(t0);
        const r1 = l2.rowAt(Math.max(t0, t1 - 1));
        const rows = [];
        for (let i = r0; i <= r1; i++) rows.push(i);
        const has = ren._computeRowContent(l2, rows);
        const missing = rows.filter((r) => !has.has(r));
        if (missing.length) {
          errs.push(`${f} 休息段 ${bs}~${be}ms 跨 ${rows.length} 行，`
            + `第 ${missing.join('/')} 行「有条纹但没轨道」`);
        }
        /* ---- [8b] ★★ 每一条被覆盖的行都必须真的画出正宽度条纹 ----
         *
         * 上一条只查「轨道背景有没有画」，那是上一轮的修复。
         * 这一条查「条纹本身」—— 用户反馈「中间一行休息段的条纹还是没显示」，
         * 而那一行**有轨道**（所以上一条断言是绿的），条纹却是空的。
         *
         * 成因：`xInRow(t)` 内部自己`floor((t-t0)/rowDurMs)` 反推行号，
         * 而 _drawBreakStripes 的行号是**循环变量 r**。
         * `e = rowEndT`（正好是下一行行首）时两者差 1：
         *   xInRow(e) 用「下一行」算行内偏移 ≈ marginX
         *   -> x1 ≈ 26，而 x0 可能是 674 -> 宽度为负 -> 整行被跳过。
         *
         * 实测（Dereban's Lewd Extra，700px 宽 -> 25 行、行长 4114ms）：
         *   休息段 93540~103741ms 跨行 14~17，
         *   行 15/16 的 x0=674、x1=26 完全反了 -> 两行条纹全消失。
         * 表现为「两端有条纹、中间空着」，很像「那段本来没有休息」。
         *
         * ★★ 判据必须读**真实绘制记录**（ctx 的 fillRect），
         *   不能在这里重算一遍算法 —— 那等于自己验自己，
         *   renderer 改回错误实现时测试仍是绿的（实测踩过）。
         */
        /* 重画一遍并抓 fillRect。用独立的 calls 对象，避免与外层共用。 */
        const rcalls = {};
        const oldCreate = globalThis.document.createElement;
        globalThis.document.createElement = (tag) => {
          if (tag !== 'canvas') return {};
          return makeCanvasStub(300, 150, rcalls);
        };
        let pageCv;
        try {
          pageCv = new renderer.PreviewRenderer(b, l2, c2, { loaded: false }, {
            header: false, bgImage: null, useSkin: false,
            showGrid: true, showMeasure: false, showSv: false,
          }).renderPage(0, { rows: [r0, r1 + 1] });
        } finally {
          globalThis.document.createElement = oldCreate;
        }
        if (!pageCv) {
          errs.push(`${f} 休息段 ${bs}~${be}ms 所在页渲染返回空`);
          continue;
        }
        /* 条纹灰底的颜色标记（与 _drawBreakStripes 里的 fillStyle 一致） */
        const STRIPE_FILL = 'rgba(120,120,128,0.22)';
        /* canvas 上挂了 rowTops —— 渲染时算出的真实行 y 偏移。
           绝不能自己用 rowHeightOf 重算：行高公式一改就会和实际绘制错位，
           那样测试就成了「自己验自己」。*/
        const yTopIn = new Map(Object.entries(pageCv.rowTops || {})
          .map(([k, v]) => [Number(k), v]));
        const heightsIn = pageCv.rowHeights || {};
        const trackHIn = pageCv.trackH || 1;
        const stripeRects = (rcalls.rects || []).filter((q) => q.fill === STRIPE_FILL);
        for (const r of rows) {
          if (!yTopIn.has(r)) {
            errs.push(`${f} 休息段 ${bs}~${be}ms 第 ${r} 行不在渲染页内`
              + `（renderPage 只画了 ${JSON.stringify([...yTopIn.keys()])}）`);
            continue;
          }
          /* 该行条纹带的 y 范围：与 renderer 一致（行高居中）*/
          const top = yTopIn.get(r) + ((heightsIn[r] || 0) - trackHIn) / 2;
          const bot = top + trackHIn;
          const inRow = stripeRects.filter((q) => q.y + 0.5 >= top && q.y <= bot);
          const good = inRow.filter((q) => q.w > 0.5);
          if (!good.length) {
            errs.push(`${f} 休息段 ${bs}~${be}ms 第 ${r} 行`
              + `**没有画出正宽度的条纹**（该 y 带内找到 ${inRow.length} 个条纹矩形，`
              + `宽度 >0 的 ${good.length} 个；`
              + `实际 w=${inRow.map((q) => q.w.toFixed(0)).join(',') || '无'}）`);
          } else {
            /* 整段落在这一行内时，条纹必须铺满整行宽度 */
            const rs = l2.t0 + r * l2.rowDurationMs;
            const re = l2.t0 + (r + 1) * l2.rowDurationMs;
            const fullRow = Math.max(bs, l2.t0) <= rs && Math.min(be, l2.tEnd) >= re;
            if (fullRow) {
              const rowW = l2.rowDurationMs * l2.pxPerMs;
              const widest = Math.max(...good.map((q) => q.w));
              if (widest < rowW * 0.98) {
                errs.push(`${f} 休息段 ${bs}~${be}ms 第 ${r} 行完全被覆盖，`
                  + `条纹最宽只到 ${widest.toFixed(0)}/${rowW.toFixed(0)}px`
                  + `（应铺满整行）`);
              }
            }
          }
        }
      }
    }
  }
  console.log('[8] 全样本整首渲染: %d 张，最高画布 %dpx（%s）',
    checked, worstH, worstName.slice(0, 30));
  console.log('    最多行数 %d（%s）　最窄 16分间距 %s px（%s）',
    worstRows, rowsName.slice(0, 30), minGap.toFixed(1), gapName.slice(0, 30));
}

/* ---------- 额外：[8b] std（Mode 0）转谱样本全链路渲染 ---------- */
/* std 谱走的是 osu_parser 的转换分支（官方 TaikoBeatmapConverter），
   与原生 taiko 完全不同的代码路径：短滑条会被拆成 Hit、
   连打时长公式不同、SV 控制点来自「滑条速度变化」后处理。
   数值一致性由 std_convert_parity.mjs 对拍 Python 负责，
   这里只验证「转换产物能不能正常布局 + 渲染整首」。*/
const stdRoot = path.join(HERE, 'std_zips');
if (fs.existsSync(stdRoot)) {
  const panel = await import(pathToFileURL(path.join(LIB, 'sr_panel.js')));
  let checked = 0, worstH = 0, worstName = '';
  for (const f of fs.readdirSync(stdRoot).filter((n) => n.endsWith('.osu'))) {
    const b = parser.parseOsu(fs.readFileSync(path.join(stdRoot, f), 'utf8'));
    if (b.mode !== 0) { errs.push(`std 样本 ${f} 的 Mode 应为 0，实际 ${b.mode}`); continue; }
    if (b.isConvert !== true) errs.push(`std 样本 ${f} 未标记 isConvert`);
    if (!b.notes.length) { errs.push(`std 样本 ${f} 转换后没有音符`); continue; }
    /* 转换后不能残留 taiko 原生的大饼 —— std 没有这个概念 */
    if (b.notes.some((n) => n.kind === 'big')) {
      errs.push(`std 样本 ${f} 转换后仍有大饼（big），std 不该产生`);
    }
    /* 短滑条拆点 -> 单曲必然出现多个 Don/Kat；
       若一条 Hit 都没有，说明 circle 分支整个没跑。*/
    if (!b.notes.some((n) => n.kind === 'don' || n.kind === 'kat')) {
      errs.push(`std 样本 ${f} 转换后没有任何 Hit`);
    }

    const w = 660;
    const c2 = layout.applyCompact(Object.assign({}, layout.DEFAULTS), w);
    c2.headerHeight = renderer.headerHeightFor(w);
    const al = layout.alignPixelsPerSecond(b, c2);
    c2.pixelsPerSecond = al > 0 ? al
      : Math.max(40, Math.min(900, (w - c2.marginX * 2) / ((layout.maxEnd(b) / 1000) / 14)));
    const l2 = layout.computeLayout(b, c2);
    const cv = new renderer.PreviewRenderer(b, l2, c2, { loaded: false }, {
      header: true, bgImage: null, useSkin: false,
      showGrid: true, showMeasure: true, showSv: true,
    }).renderPage(0, { rows: [0, l2.rowsUsed] });
    checked++;
    if (cv.height > worstH) { worstH = cv.height; worstName = f; }
    if (cv.height > MAX_DIM) errs.push(`${f}（std）整首画布高 ${cv.height} 超单边上限`);
    if (cv.width * cv.height > MAX_AREA) errs.push(`${f}（std）整首画布面积超上限`);

    /* SR/PP 必须能算出来，且四项 skill 占比之和为 1 */
    const rep = panel.buildDifficultyReport(b, { mod: 'CL' });
    if (!rep) { errs.push(`${f}（std）buildDifficultyReport 返回 null`); continue; }
    const sum = rep.skills.rows.reduce((a, r) => a + r.ratio, 0);
    if (Math.abs(sum - 1) > 1e-9) {
      errs.push(`${f}（std）skill 占比之和 = ${sum}，应为 1`);
    }
    if (!(rep.skills.total > 0)) errs.push(`${f}（std）SR = ${rep.skills.total}，应 > 0`);
    if (rep.meta.isConvert !== true) errs.push(`${f}（std）meta.isConvert 应为 true`);

    console.log('    [std] %s -> 音符 %d（连打 %d 转盘 %d） 行 %d 画布 %dpx  SR %s  SV标记 %d',
      f.replace(/^.*\[|\]\.osu$/g, '').slice(0, 16).padEnd(16),
      b.notes.length, b.notes.filter((n) => n.kind === 'roll').length,
      b.notes.filter((n) => n.kind === 'spinner').length,
      l2.rowsUsed, cv.height, rep.skills.total.toFixed(2), l2.svMarksFull.length);
  }
  console.log('[8b] std(Mode 0) 转谱样本全链路渲染: %d 张，最高画布 %dpx（%s）',
    checked, worstH, worstName.slice(0, 30));
}

/* ===================================================================== *
 * [8c] ★★★ 脏数据防御：两 条互为反向的回归
 *
 * 起因：1419088Camellia feat. Nanahira - Bad Sweets, Bad Dreams
 * （bid 2923535）一打开，**插件连带整个浏览器卡死**（标签页都切不动）。
 *
 * 根因：TimingPoints 里有 3 条导出器 bug 产生的脏数据
 *     -569220001,-6E-87,4,1,0,5,1,0
 * 时间戳 -569220001（-6.4万小时）、beatLength 6e-87（浮点下溢）。
 * `measureTimes()` 是 `while (t < segEnd) t += beatLength * meter`
 * 的逐小节累进，拍长 6e-87 时单段要循环 **10^52 次** —— 不是「慢」，
 * 是永远跑不完，主线程被彻底占死。
 *
 * 这两条断言必须**同时存在**，缺一条就守不住：
 *
 *   [8c-1] 脏谱必须能算完（防「死循环」复发）
 *           —— 直接跑真实代码路径并计时。
 *   [8c-2] 正常谱必须零丢弃（防「阈值收得太紧误伤」）
 *           —— 本轮光是调阈值就踩了四个坑，全是这条暴露的：
 *             ① 拍长上限 60ms-> 误丢 163 条 22BPM 慢速段
 *             ② 上限对绿线生效 -> 误丢 431 条 bl=-1472.39（SV≈0.068）
 *             ③ 时间按 t>=0 判定 -> 误丢音频淡入用的 -996ms 负时间红线
 *             ④ 下限对绿线生效 -> 误丢 102 条 |bl|<1 的高 SV 绿线
 *           只加[8c-1] 的话，阈值一味收紧也能「修好卡死」，
 *           代价是把几百条合法数据悄悄丢掉、SR 偏 0.2~0.5。
 * ===================================================================== */
{
  /* ---- [8c-1] 脏谱：布局必须在有限时间内完成 ---- */
  const dirtyDir = path.join(HERE, 'badsweets');
  const BUDGET_MS = 5000;
  if (!fs.existsSync(dirtyDir)) {
    console.log('[8c] 脏数据样本目录不存在，跳过卡死回归');
  } else {
    for (const f of fs.readdirSync(dirtyDir).filter((n) => n.endsWith('.osu'))) {
      const t0 = Date.now();
      const b = parser.parseOsu(fs.readFileSync(path.join(dirtyDir, f), 'utf8'));
      const w = 660;
      const c = layout.applyCompact(Object.assign({}, layout.DEFAULTS), w);
      c.headerHeight = renderer.headerHeightFor(w);
      const al = layout.alignPixelsPerSecond(b, c);
      c.pixelsPerSecond = al > 0 ? al : 200;
      const l2 = layout.computeLayout(b, c);
      const ms = Date.now() - t0;
      const name = f.replace(/^.*\[|\]\.osu$/g, '').slice(0, 22);

      /* 这张谱的脏数据必须**真的被丢掉了** —— 如果阈值形同虚设，
         下面那个耗时断言会因为跑太久而超时，等于测不出问题。*/
      if (b.droppedTiming === 0 && b.droppedObjects === 0) {
        errs.push(`${name}：含beattLength=6e-87 的脏数据，`
          + `但 droppedTiming/droppedObjects 都是 0 —— 防御没生效`);
      }
      /* 真正的回归点：耗时。修复前这一行永远不返回。*/
      if (ms > BUDGET_MS) {
        errs.push(`${name}：解析+布局耗时 ${ms}ms，超过 ${BUDGET_MS}ms `
          + `预算 —— measureTimes 很可能又进入死循环`);
      }
      /* 丢弃之后谱面必须仍然是「可用」的：有音符、行数正常、小节线有限 */
      if (!b.notes.length) { errs.push(`${name}：丢弃脏数据后没有音符了`); continue; }
      if (l2.rowsUsed <= 0 || !isFinite(l2.rowsUsed) || l2.rowsUsed > 5000) {
        errs.push(`${name}：rowsUsed = ${l2.rowsUsed}，不合理`);
      }
      if (l2.measureTimes.length > 20000) {
        errs.push(`${name}：小节线 ${l2.measureTimes.length} 条，明显失控`);
      }
      console.log('    [脏谱] %s -> 丢弃 timing %d/物件 %d  行 %d  小节线 %d  耗时 %dms ✅',
        name.padEnd(22), b.droppedTiming, b.droppedObjects,
        l2.rowsUsed, l2.measureTimes.length, ms);
    }
  }

  /* ---- [8c-2] 正常谱：必须零丢弃 ----
     样本范围要覆盖三类，因为本轮四个坑各自命中其中一类：
       test_zips（原生 taiko）-> 坑①②
       std_zips（std 转谱）   -> 坑③④
       Bass Slut（工作区）    -> 曾被坑② 波及（427 条 bl=1472.39）*/
  const cleanDirs = [
    path.join(HERE, 'test_zips'),
    path.join(HERE, 'std_zips'),
    path.join(HERE, '..', '..', '983911 S3RL - Bass Slut (Original Mix)'),
  ];
  let cleanCount = 0;
  /* 已知该丢弃的脏数据（白名单）。
   * 「零丢弃」是目标，但样本里确实存在**真·脏数据**，
   * 它们被丢弃是正确行为，不能算误伤。
   *
   * 目前已知的一条：INTERNET OVERDOSE 的`bl=1E+15` ×4
   *（t = 203235/ 206179 / 209124 / 212568）。
   * 判定它是占位值而非真实拍长：同一时刻前后有正常红线覆盖
   *     203234, 368.098159509202,4,1,...   ← 真拍长
   *     203235, 1E+15,4,1,0,60,1,8         ← 占位值
   *     203236, 368.098159509202,4,1,...   ← 真拍长
   * 1E15ms ≈ 31700 年一小节，任何谱面都不可能有这种拍长。
   */
  const ALLOWED_DROPS = {
    'GIMMICK OVERDOSE': 4,
  };
  for (const d of cleanDirs) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d).filter((n) => n.endsWith('.osu'))) {
      const b = parser.parseOsu(fs.readFileSync(path.join(d, f), 'utf8'));
      cleanCount++;
      const diffName = f.replace(/^.*\[|\]\.osu$/g, '').slice(0, 20);
      const allowed = ALLOWED_DROPS[diffName] ?? 0;
      const dropped = b.droppedTiming + b.droppedObjects;
      if (dropped === 0) continue;
      if (dropped <= allowed) {
        /* 已知脏数据，如实记一笔，不算失败 */
        console.log('    %s/%s: 丢弃 %d 条（已知脏数据，白名单 %d）✅',
          path.basename(d), diffName, dropped, allowed);
        continue;
      }
      errs.push(`${path.basename(d)}/${diffName}：`
        + `正常谱被丢弃 ${dropped} 条（白名单只允许 ${allowed}）`
        + `—— 阈值收得太紧，会让 SR 偏 0.2~0.5`
        + `（本轮四个坑都是这么引入的）`);
    }
  }
  console.log('[8c-2] 正常谱丢弃检查: %d 张，只有已知脏数据被丢 ✅', cleanCount);

  /* ---- [8c-3] 直接打measureTimes 的循环预算（绕过解析层）----
   *
   * 为什么必须单独测：解析层已经把脏数据丢掉了，
   * 所以 [8c-1] 那条端到端断言**测不到预算本身** ——
   * 把预算改成Infinity 跑一遍，[8c-1] 依然是绿的（实测）。
   * 也就是说预算一旦被误删，端到端测试察觉不到。
   *
   * 这里直接构造「一条 6e-87 的红线独占一整段」的最坏输入，
   * 与 Bad Sweets 的故障形态同构，断言它能快速返回且仍保留那一拍。
   */
  {
    const worst = {
      timingPoints: [
        { time: 0, beatLength: 500, red: true, meter: 4 },
        { time: 5000, beatLength: 500, red: true, meter: 4 },
        /* 脏点：拍长 6e-87 却独占 5001~15000 整段 -> 没有预算就是 10^52 次循环 */
        { time: 5001, beatLength: 6e-87, red: true, meter: 4 },
      ],
    };
    const t0 = Date.now();
    let mt;
    try {
      mt = layout.measureTimes(worst, 15000, 0, true);
    } catch (e) {
      errs.push(`measureTimes 在极端脏数据下抛异常: ${e.message}`);
      mt = null;
    }
    const ms = Date.now() - t0;
    if (mt) {
      if (ms > 1000) {
        errs.push(`measureTimes 在 6e-87 拍长下耗时 ${ms}ms `
          + `（修复前是永不返回）—— 循环预算没生效`);
      }
      /* 预算的作用是「跳过失控的那一段」，但脏点所在的那一拍本身
         是真实存在的（小节号要接上），不能连它一起丢。*/
      const hasDirtyBeat = mt.some(([t]) => t === 5001);
      if (!hasDirtyBeat) {
        errs.push('measureTimes 跳过失控段时把「脏点所在的那一拍」也丢了'
          + ' —— 小节编号会断，应保留起点那一拍');
      }
      console.log('    [预算] 6e-87 独占整段 -> 返回 %d 条小节线，耗时 %dms，'
        + '保留起点那一拍=%s ✅',
        mt.length, ms, hasDirtyBeat ? '是' : '否');
    }
  }
}

/* ---------- 额外：不同窗口宽度下紧凑几何量都合理 ---------- */
/* 允许音符最多比16分间距宽 12%：窗口最窄（420px）又要每行 3 个小节时，
   物理上放不下 —— 8px 音符配 7.7px 间距必然轻微重叠。
   轻微重叠在太鼓预览里是正常观感（真游戏里的 stream 也照样叠），
   关键是别糊成一片，所以阈值给到 1.12 而不是 1.0。*/
const OVERLAP_TOLERANCE = 1.12;
{
  const probe = parser.parseOsu(text);
  console.log('[9] 紧凑几何量随宽度变化:');
  for (const w of [420, 520, 660, 800, 1000, 1300, 1600, 1920]) {
    const c = layout.applyCompact(Object.assign({}, layout.DEFAULTS), w);
    const us = w - c.marginX * 2;
    const gap = us / (c.measuresPerRow * 16);
    const ratio = c.noteDiameter / gap;
    const al = layout.alignPixelsPerSecond(probe, c);
    const okNote = ratio <= OVERLAP_TOLERANCE;
    console.log('    宽 %s -> 边距 %s 音符 %s 轨道 %s 行高 %s 每行 %s 小节 间距 %s px 音符/间距 %s %s',
      w, c.marginX, c.noteDiameter, c.stripeHeight, c.rowHeight,
      c.measuresPerRow, gap.toFixed(1), ratio.toFixed(2),
      okNote ? '' : '← 音符过大!');
    if (!okNote) {
      errs.push(`宽度 ${w} 下音符直径 ${c.noteDiameter} /间距 ${gap.toFixed(1)} = ${ratio.toFixed(2)}，超过 ${OVERLAP_TOLERANCE}`);
    }
    if (c.measuresPerRow < 3 || c.measuresPerRow > 4) {
      errs.push(`宽度 ${w} 下每行 ${c.measuresPerRow} 个小节，超出 3~4`);
    }
    /* 密度必须为正且能放得下整首 */
    if (!(al > 0)) errs.push(`宽度 ${w} 下 alignPixelsPerSecond 返回 ${al}`);
  }
}

console.log();
if (errs.length) {
  console.log('❌ 验证失败:');
  errs.forEach((e) => console.log('   -', e));
  process.exit(1);
}
console.log('✅ 全部通过：插件核心链路（解析→布局→渲染）可用');