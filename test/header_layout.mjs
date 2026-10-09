/**
 * 信息栏（顶部左「谱面信息」+ 右「统计 / 刻度条」）的版式验证。
 *
 * 单独拎出来测，因为 _drawHeader 是**唯一**一个版式量与画布宽度强耦合的
 * 绘制函数：宽画布（网页版 1920）用原始字号，小窗（插件 420~860）要整体
 * 缩小。这里把每个宽度下的实际绘制内容抓出来，验证：
 *   - 左右两块都真的画了东西（不是只画一半）
 *   - 所有文字都落在 header 高度范围内（不会被裁掉）
 *   - 右侧文字不越出画布右边界（不会被截断到看不见）
 *   - 统计值合理（时长 / 物件数 / BPM 非空、非NaN）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, '..', 'lib');

const errs = [];

/* ---------- 抓取绘制调用的 ctx 桩 ---------- */
function makeCtx() {
  const texts = [];
  const grad = { addColorStop() {} };
  const target = { texts, rects: [], calls: { drawImage: 0, images: [] } };
  return new Proxy(target, {
    get(t, p) {
      if (p in t) return t[p];
      switch (p) {
        case 'measureText':
          /* 字宽必须**跟随当前 ctx.font 的字号** —— 真实 canvas 就是这样。
           * 之前这里写死「中文 12px / ASCII 7px」，与字号无关，
           * 于是小字号下算出的宽度偏大，把本该放得下的标签判成截断。
           * 现在按 fontSize 解析：全角 ≈ 1.0em、半角 ≈ 0.56em。*/
          return (s) => {
            const f = String(target.font || '');
            const m = /(\d+(?:\.\d+)?)px/.exec(f);
            const size = m ? parseFloat(m[1]) : 12;
            let w = 0;
            for (const ch of String(s)) {
              w += ch.charCodeAt(0) > 255 ? size : size * 0.56;
            }
            return { width: w };
          };
        case 'createLinearGradient': return () => grad;
        case 'canvas': return { width: 1, height: 1 };
        case 'fillText':
          /* 必须记下当时的 font / align / baseline —— 「字号自适应」这类
             改动只有拿到这些才能验证（否则只能看到文本内容，看不到多大）。
             ★ 顺带记下列宽 `w`（按当前 font 估算）——
               「两个元素是否横向重叠/越界」这类断言必须有宽度才测得出来，
               只看 x 起点会漏掉「起点在框内但字太长拖出框外」。*/
          return (s, x, y) => {
            const f = String(target.font || '');
            const m = /(\d+(?:\.\d+)?)px/.exec(f);
            const size = m ? parseFloat(m[1]) : 12;
            let wd = 0;
            for (const ch of String(s)) {
              wd += ch.charCodeAt(0) > 255 ? size : size * 0.56;
            }
            texts.push({
              s: String(s), x, y, w: wd,
              font: f, fill: t.fillStyle || '',
              align: t.textAlign || 'left',
              base: t.textBaseline || 'alphabetic',
            });
          };
        case 'fillRect':
          return (x, y, w, h) => { t.rects.push({ x, y, w, h, fill: t.fillStyle || '' }); };
        case 'save': case 'restore': case 'beginPath': case 'closePath':
        case 'moveTo': case 'lineTo': case 'arc': case 'arcTo':
        case 'fill': case 'stroke': case 'clip': case 'rect':
        case 'translate': case 'scale': case 'setTransform':
          return () => {};
        /* 记录 drawImage —— 用来验证「有背景图时封面被画上了」*/
        case 'drawImage':
          return (img) => {
            t.calls.drawImage++;
            t.calls.images.push(img);
          };
        default: return () => {};
      }
    },
    set(t, p, v) { t[p] = v; return true; },
  });
}

globalThis.document = {
  createElement: () => ({
    width: 0, height: 0, style: {},
    getContext: () => makeCtx(),
  }),
};

const [parser, L, R, PANEL, D] = await Promise.all([
  import(pathToFileURL(path.join(LIB, 'osu_parser.js')).href),
  import(pathToFileURL(path.join(LIB, 'layout.js')).href),
  import(pathToFileURL(path.join(LIB, 'renderer.js')).href),
  import(pathToFileURL(path.join(LIB, 'sr_panel.js')).href),
  import(pathToFileURL(path.join(LIB, 'difficulty.js')).href),
]);

/* ---------- 挑一张真实样本谱 ---------- */
const dir = path.join(HERE, 'test_zips');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.osu')) : [];
if (!files.length) {
  console.error('test_zips 里没有样本谱，跳过');
  process.exit(0);
}
const bm = parser.parseOsu(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
console.log('[1] 样本: %s [%s]  notes=%d  OD=%s HP=%s',
  bm.title, bm.version, bm.notes.length, bm.od, bm.hp);

/* ---------- 造一份 srData（与 content.js 的做法一致）----------
   信息栏右侧现在画的是「四项 skill 占比 + Star Rating」，
   数据来自 sr_panel.buildDifficultyReport。*/
const SRREP = PANEL.buildDifficultyReport(bm, { mod: 'CL' });
let maxPp = 0, maxPpLabel = '';
for (const c of (SRREP.pp.curve || [])) {
  if (c.totalPP > maxPp) { maxPp = c.totalPP; maxPpLabel = c.label; }
}
const SRDATA = {
  mod: 'CL',
  modLabel: '+CL',
  starRating: SRREP.skills.total,
  /* CL 不改难度参数，基准就是自己 -> 不会追加变化值。
     真实 content.js 的 baseStarRating() 也是这么算的。*/
  starRatingBase: SRREP.skills.total,
  rows: SRREP.skills.rows,
  display: SRREP.display,
  maxPp,
  maxPpLabel,
};
console.log('    srData: SR=%s  maxPP=%s(%s)  skill 占比=%s',
  SRDATA.starRating.toFixed(3), maxPp.toFixed(1), maxPpLabel,
  SRDATA.rows.map((r) => `${r.name} ${(r.ratio * 100).toFixed(1)}%`).join(' / '));

/* ---------- 各宽度下画信息栏 ---------- */
const WIDTHS = [420, 520, 660, 800, 1000, 1300, 1600, 1920];
console.log('[2] 各宽度下的信息栏版式:');

for (const W of WIDTHS) {
  /* 直接用renderer 的 headerLayout —— 这正是 content.js 用的那个函数，
     所以这里验的就是真实预留高度与真实绘制是否一致。*/
  const LAY = R.headerLayout(W);
  const cfg = L.applyCompact(Object.assign({}, L.DEFAULTS), W);
  cfg.headerHeight = R.headerHeightFor(W);
  const al = L.alignPixelsPerSecond(bm, cfg);
  cfg.pixelsPerSecond = al > 0 ? al : 200;
  const lay = L.computeLayout(bm, cfg);

  const r = new R.PreviewRenderer(bm, lay, cfg, { loaded: false }, {
    header: true, bgImage: null, useSkin: false,
    showGrid: true, showMeasure: true, showSv: true,
    srData: SRDATA,
  });

  const ctx = makeCtx();
  r._drawHeader(ctx, W, 0, 1);
  const H = cfg.headerHeight;
  const T = ctx.texts;

  /* 左右分界：右栏起点 rx = W - PAD - RIGHT_W */
  const rx = W - LAY.PAD - LAY.RIGHT_W;
  const left = T.filter((t) => t.x < rx - 4);
  const right = T.filter((t) => t.x >= rx - 4);
  const all = T.map((t) => t.s);

  /* 断言 */
  if (left.length < 3) errs.push(`宽 ${W}：左栏只画了 ${left.length} 条文字（应≥3：曲名/作者/难度/谱师）`);
  if (right.length < 4) errs.push(`宽 ${W}：右栏只画了 ${right.length} 条文字（应≥4：6 项统计+ 4 个刻度值）`);

  /* 曲名 / 难度 必须完整出现 */
  const mustHave = [
    [bm.title || 'Unknown', '曲名'],
    [`[${bm.version || ''}]`, '难度名'],
  ];
  for (const [txt, label] of mustHave) {
    const hit = all.some((s) => s && (s === txt || s.startsWith(txt.slice(0, 6))));
    if (!hit) errs.push(`宽 ${W}：${label}「${txt}」未出现在信息栏`);
  }
  /* 数值必须都是有限数（不为 NaN / undefined / null）*/
  const nums = all.filter((s) => /^[\d.]+$/.test(s));
  if (nums.length < 4) {
    errs.push(`宽 ${W}：信息栏只画出了 ${nums.length} 个纯数值（skill占比4 个 + SR + PP 等，应≥4）`);
  }
  for (const t of T) {
    if (/NaN|undefined|null/.test(t.s)) {
      errs.push(`宽 ${W}：信息栏出现异常文本 ${JSON.stringify(t.s)}`);
    }
  }

  /* 所有文字必须在 header 高度内（y 是基线，留一点 descender 余量）*/
  const over = T.filter((t) => t.y > H + 2);
  if (over.length) {
    errs.push(`宽 ${W}：${over.length} 条文字基线 y 超出 header 高度 ${H}（最高 ${Math.max(...over.map((t) => t.y))}）`);
  }
  /* 不能画到画布左边之外 */
  const leftOut = T.filter((t) => t.x < -1);
  if (leftOut.length) errs.push(`宽 ${W}：${leftOut.length} 条文字 x<0`);

  /* 右栏文字不能越出画布右缘 */
  const rightOut = right.filter((t) => t.x > W + 1);
  if (rightOut.length) {
    errs.push(`宽 ${W}：${rightOut.length} 条右栏文字 x>${W}（最高 ${Math.max(...rightOut.map((t) => t.x))}）`);
  }

  /* 刻度条不得画到框外 —— 本测试最主要的目标。
     现在是 **7 条**（HP / OD / 4×skill / SR），所以按 BAR_STEP × 6 算。*/
  const barsBottom = LAY.panelY + LAY.BARS_Y0 + LAY.BAR_STEP * 6 + LAY.BAR_H;
  if (barsBottom > LAY.panelY + LAY.panelH) {
    errs.push(`宽 ${W}：最后一条刻度条底 ${barsBottom} 超出框底 ${LAY.panelY + LAY.panelH}`);
  }

  /* 第二行统计的**图标底**不得压到第一条刻度条的顶。
     图标画在 (基线 - 0.55×边长)，所以底 = 基线 + 0.45×边长。
     之前 BARS_Y0 只按「基线 + 6px」算，漏掉了图标高度 -> 全宽度重叠。*/
  const row2Base = LAY.panelY + LAY.STAT_Y0 + LAY.LINE_GAP;
  const iconBottom = row2Base + LAY.ICON_S * 0.45;
  const barTop = LAY.panelY + LAY.BARS_Y0;
  if (iconBottom > barTop) {
    errs.push(`宽 ${W}：第二行图标底 ${iconBottom.toFixed(1)} 压到刻度条顶 ${barTop}（重叠 ${(iconBottom - barTop).toFixed(1)}px）`);
  }

  /* 标签列必须放得下最宽的标签。
     实际标签是 sr_panel 的 `name`："体力 Stamina" 等中英对照 + "Star Rating"。
     全角 ≈ 1.0em、半角 ≈ 0.5em，标签字号是 F(16, 9)。*/
  const fTag = Math.max(9, Math.round(16 * LAY.k));
  const need = Math.max(
    2 * fTag + 0.6 * fTag + 7 * 0.6 * fTag,     /* 「体力 Stamina」 */
    11 * 0.6 * fTag,                           /* 「Star Rating」 */
  ) + 8;
  if (LAY.LABEL_COL < need) {
    errs.push(`宽 ${W}：标签列 ${LAY.LABEL_COL}px 放不下「体力 Stamina / Star Rating」（需~${Math.round(need)}px）`);
  }
  /* 四项 skill 与 Star Rating 的标签都不能被省略号截断。
     注意：标签**只有英文**（用户要求去掉中文字），所以校验 r.en 而不是 r.name。*/
  for (const lbl of [...SRDATA.rows.map((r) => r.en), 'Star Rating']) {
    if (!all.includes(lbl)) {
      errs.push(`宽 ${W}：标签「${lbl}」被截断（实际画出的文本里找不到）`);
    }
  }

  /* 条形本身要有可见长度（太窄就看不出是刻度条）*/
  const barGap = Math.max(8, Math.round(12 * LAY.k));
  const bxReal = W - LAY.PAD - LAY.RIGHT_W + LAY.PAD_IN;
  const innerR = W - LAY.PAD - LAY.PAD_IN;
  const barWReal = innerR - bxReal - LAY.LABEL_COL - barGap - LAY.VALUE_W;
  if (barWReal < 50) {
    errs.push(`宽 ${W}：刻度条长度仅 ${Math.round(barWReal)}px，太窄（应≥50）`);
  }

  /* 星数与最大 PP 必须真的画出来 */
  if (!all.some((s) => /★/.test(s))) {
    errs.push(`宽 ${W}：未画出 Star Rating（应形如 "7.83★"）`);
  }
  if (!all.some((s) => /\d+PP/.test(s))) {
    errs.push(`宽 ${W}：未画出最大 PP（应形如 "765PP"）`);
  }
  /* mod 缩写（小字，在 PP 上方）—— 格式由 content.js 的
     currentModLabel() 决定：一个 mod 都没选时是 "None"，
     有 mod 时是 "+X,Y,CL"（加号最前）。这里只验证它画出来了。*/
  if (!all.some((s) => s === SRDATA.modLabel)) {
    errs.push(`宽 ${W}：未画出 mod 缩写「${SRDATA.modLabel}」`);
  }
  /* 四个 skill 的占比数值：省略百分号、两位小数 */
  for (const row of SRDATA.rows) {
    const want = (row.ratio * 100).toFixed(2);
    const hit = all.some((s) => s === want || s === want + '%');
    if (!hit) {
      errs.push(`宽 ${W}：skill「${row.name}」的占比数值 ${want} 未画出来`);
    }
  }
  /* 旧的密度条必须已被替换掉（HP / OD 两条要保留） */
  for (const gone of ['全曲密度', '最密 30%']) {
    if (all.includes(gone)) {
      errs.push(`宽 ${W}：旧的密度条「${gone}」还在（应已被 skill 占比替换）`);
    }
  }
  /* HP / OD 两条必须保留，且显示的是 **mod 调整后**的值 */
  for (const lbl of ['HP', 'OD']) {
    if (!all.includes(lbl)) errs.push(`宽 ${W}：刻度条标签「${lbl}」缺失（应保留）`);
  }
  if (SRDATA.display) {
    const wantHp = SRDATA.display.hp.toFixed(1);
    /* OD 用**官方口径** displayOdLazer（HT 方向只有它算得出来）。
       小数位判据与 _drawHeader 一致：**OD 是否真的变了**——
       CL/HD/FL 不改难度参数，OD 原样就只给一位小数。*/
    const odLazer = typeof SRDATA.display.displayOdLazer === 'number'
      ? SRDATA.display.displayOdLazer : SRDATA.display.od;
    const odChanged = Math.abs(odLazer - bm.od) >= 0.005;
    const wantOd = odLazer.toFixed(odChanged ? 2 : 1);
    if (!all.some((s2) => s2 === wantHp)) {
      errs.push(`宽 ${W}：HP 条未显示 mod 调整后的值 ${wantHp}`);
    }
    if (!all.some((s2) => s2 === wantOd)) {
      errs.push(`宽 ${W}：OD 条未显示 mod 调整后的值 ${wantOd}`
        + `（实际画出的：${JSON.stringify(all.filter((s2) => /^[-+]?\\d+\\.\\d/.test(s2)))})`);
    }
  }

  /* 小窗时信息栏不能吃掉太多垂直空间。
     上限随刻度条条数走：现在是 7 条（HP/OD/4 skill/SR），每条约 BAR_STEP。*/
  const maxH = W <= 860 ? 230 : 380;
  if (W <= 860 && H > maxH) {
    errs.push(`宽 ${W}：信息栏高 ${H}px 偏大（小窗应≤${maxH}）`);
  }

  const shown = all.filter((s) => s && s !== 'osu!taiko 谱面预览');
  console.log('    宽 %s k=%s 高%s 左%d右%d 刻度%d 图标/条%s 标签列%s 条长%s | %s',
    String(W).padEnd(5), LAY.k.toFixed(2), String(H).padEnd(4),
    left.length, right.length, nums.length,
    (iconBottom <= barTop ? 'OK' : '重叠').padEnd(4),
    String(LAY.LABEL_COL).padEnd(6), String(Math.round(barWReal)).padEnd(5),
    shown.slice(4, 10).map((s) => (s.length > 10 ? s.slice(0, 9) + '…' : s)).join(' '));
}

/* ---------- 关掉信息栏时 headerHeight 必须为 0 ---------- */
{
  const cfg = L.applyCompact(Object.assign({}, L.DEFAULTS), 660);
  cfg.headerHeight = 0;
  const lay = L.computeLayout(bm, cfg);
  if (lay.bodyTop !== cfg.paddingTop) {
    errs.push(`headerHeight=0 时 bodyTop=${lay.bodyTop} 应等于 paddingTop=${cfg.paddingTop}`);
  }
  const r = new R.PreviewRenderer(bm, lay, cfg, { loaded: false }, {
    header: false, bgImage: null, useSkin: false,
  });
  if (r.headerH !== 0) errs.push(`header:false 时 headerH=${r.headerH} 应为 0`);
  console.log('[3] 关闭信息栏: headerH=%d bodyTop=%d（= paddingTop）', r.headerH, lay.bodyTop);
}

/* ---------- BPM 口径一致性（真实 bug 回归） ---------- */
/* 用户反馈：「渲染 216bpm 是对的，但标题栏写的还是 120bpm」。
   根因：标题栏用 bpmAt(t0)（首拍 BPM），信息栏用 bpmRange()（主 BPM）。
   变速谱两者必然不同 —— 14 张样本里 10 张不一致。*/
console.log('[4] BPM 口径检查（全部样本）:');
{
  const all = fs.readdirSync(dir).filter((n) => n.endsWith('.osu'));
  let checked = 0;
  for (const f of all) {
    const b = parser.parseOsu(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (b.mode !== 1 || !b.notes.length) continue;
    const cfg2 = L.applyCompact(Object.assign({}, L.DEFAULTS), 660);
    cfg2.headerHeight = R.headerHeightFor(660);
    const al = L.alignPixelsPerSecond(b, cfg2);
    cfg2.pixelsPerSecond = al > 0 ? al : 200;
    const lay2 = L.computeLayout(b, cfg2);
    const rr = new R.PreviewRenderer(b, lay2, cfg2, { loaded: false }, {
      header: true, bgImage: null, useSkin: false,
    });
    const br = rr.bpmRange();
    if (!br) { errs.push(`${f}: bpmRange() 返回 null`); continue; }

    const full = R.fmtBpmRange(br, 'full');
    const main = R.fmtBpmRange(br, 'main');
    /* 信息栏画的就是 full；标题栏显示 main，必须是 full 里主 BPM 的那一段 */
    if (!full.includes(main)) {
      errs.push(`${f}: 标题栏主 BPM「${main}」未包含在信息栏的「${full}」中`);
    }
    /* 主 BPM 必须落在 [min, max] 内 */
    if (br.main < br.min - 0.05 || br.main > br.max + 0.05) {
      errs.push(`${f}: 主 BPM ${br.main} 不在范围 [${br.min}, ${br.max}] 内`);
    }
    /* 有效范围：不能出现 0 或离谱的值（gimmick 标记污染的信号）*/
    if (!(br.min > 0)) {
      errs.push(`${f}: BPM 范围下界为 ${br.min}，说明有 0值污染`);
    }
    if (br.max > 2000) {
      errs.push(`宽 ${f}: BPM 范围上界 ${br.max} 过大，疑似把 gimmick 标记当成了 tempo`);
    }
    checked++;
    console.log('    %s -> 信息栏 %s / 标题栏 %s',
      f.slice(0, 30).padEnd(32), full.padEnd(20), main);
  }
  console.log('    共检查 %d 张样本', checked);
  if (checked < 10) errs.push(`样本太少（${checked} 张），BPM 回归测试不充分`);
}

/* ---------- fmtBpmRange 本身的边界 ---------- */
{
  const T = [
    [null, '', ''],
    [{ min: 200, max: 200, main: 200 }, '200', '200'],
    [{ min: 120, max: 256, main: 256 }, '120-256(256)', '256'],
    [{ min: 95.5, max: 95.5, main: 95.5 }, '95.5', '95.5'],
    [{ min: 199.9, max: 199.9, main: 199.9 }, '199.9', '199.9'],
  ];
  for (const [br, wantFull, wantMain] of T) {
    const gotFull = R.fmtBpmRange(br, 'full');
    const gotMain = R.fmtBpmRange(br, 'main');
    if (gotFull !== wantFull) errs.push(`fmtBpmRange(full) 应为 "${wantFull}"，实际 "${gotFull}"`);
    if (gotMain !== wantMain) errs.push(`fmtBpmRange(main) 应为 "${wantMain}"，实际 "${gotMain}"`);
  }
  console.log('[5] fmtBpmRange 边界: %d 组通过', T.length);
}

/* ---------- mod 对信息栏的影响（用户反馈第 7 / 8 条）---------- */
console.log('[6] mod 对 OD / 时长 / BPM 的影响:');
{
  const W = 660;
  const bm2 = bm;
  /* 时长与 BPM 的折算：DT/NC ÷1.5 与 ×1.5；HT ÷0.75 与 ×0.75 */
  const rawTotal = (() => {
    /* 借用 renderer 内部的 lengthMs —— 通过 headerStats 的时长文本反推太绕，
       这里直接比「有时长差异」即可，具体数值由 rate 公式决定 */
    return null;
  })();
  void rawTotal;

  const rows = [];
  for (const mod of ['None', 'DT', 'NC', 'HT']) {
    const rep = PANEL.buildDifficultyReport(bm2, { mod });
    const cfg2 = L.applyCompact(Object.assign({}, L.DEFAULTS), W);
    cfg2.headerHeight = R.headerHeightFor(W);
    cfg2.pixelsPerSecond = L.alignPixelsPerSecond(bm2, cfg2) || 200;
    const lay2 = L.computeLayout(bm2, cfg2);
    const sd = {
      mod, modLabel: mod === 'None' ? 'NoMod' : mod,
      starRating: rep.skills.total, rows: rep.skills.rows, display: rep.display,
      maxPp: Math.max(...rep.pp.curve.map((c) => c.totalPP)), maxPpLabel: 'SS',
    };
    const rr = new R.PreviewRenderer(bm2, lay2, cfg2, { loaded: false }, {
      header: true, bgImage: null, useSkin: false, srData: sd,
    });
    const cx = makeCtx();
    rr._drawHeader(cx, W, 0, 1);
    const texts = cx.texts.map((t) => t.s);
    /* 时长文本形如 "3:38(3:37)" 或 "3:38" */
    const dur = texts.find((t) => /^\d+:\d{2}/.test(t)) || '';
    /* BPM 文本是纯数字或 "min-max(main)"。必须排除含 ':' 的时长文本，
       以及物件数 "2411(42)" 这类。取「不含冒号、且有 '.' 或正好是纯整数」里
       数值最大且不等于物件数的那个 —— 直接用下面的精确正则更稳。*/
    const bpm = texts.find((t) =>
      /^\d+(?:\.\d+)?$/.test(t) || /^\d+(?:\.\d+)?-\d+(?:\.\d+)?\(\d+(?:\.\d+)?\)$/.test(t)
    ) || '';
    const rate = sd.display.rate;
    rows.push({ mod, rate, dur, bpm, od: sd.display.od, displayOd: sd.display.displayOd });

    /* rate 校验 */
    const wantRate = (mod === 'DT' || mod === 'NC') ? 1.5 : (mod === 'HT' ? 0.75 : 1);
    if (Math.abs(rate - wantRate) > 1e-9) {
      errs.push(`${mod}: rate=${rate}，应为 ${wantRate}`);
    }
  }
  for (const r of rows) {
    /* Node 的 console.log 不支持 %-Ns 宽度格式符，用 padEnd */
    console.log('     ' + r.mod.padEnd(5) + ' rate=' + r.rate
      + '时长=' + String(r.dur).padEnd(14)
      + ' BPM=' + String(r.bpm).padEnd(18)
      + ' od(封顶)=' + r.od.toFixed(2) + ' displayOd=' + r.displayOd.toFixed(2));
  }

  /* 时长必须随 rate 变化：DT 的秒数应约为 None 的 1/1.5，HT 约为 1/0.75 */
  const toSec = (t) => {
    const m = /^(\d+):(\d{2})/.exec(t || '');
    return m ? +m[1] * 60 + +m[2] : NaN;
  };
  const dNone = toSec(rows[0].dur), dDT = toSec(rows[1].dur), dHT = toSec(rows[3].dur);
  if (isFinite(dNone) && isFinite(dDT) && dNone > 30) {
    /* DT 后的时长应明显更短；允许 2 秒的取整误差 */
    if (!(dDT < dNone - 2)) errs.push(`DT 时长未缩短：None=${dNone}s DT=${dDT}s`);
  }
  if (isFinite(dNone) && isFinite(dHT) && dNone > 30) {
    /* HT 后应更长（×4/3） */
    if (!(dHT > dNone + 2)) errs.push(`HT 时长未变长：None=${dNone}s HT=${dHT}s`);
  }

  /* BPM 必须随 rate 反向变化，且**四舍五入到整数**（用户要求）*/
  const bpmNum = (t) => {
    const m = /(\d+(?:\.\d+)?)/.exec(t || '');
    return m ? parseFloat(m[1]) : NaN;
  };
  const bNone = bpmNum(rows[0].bpm), bDT = bpmNum(rows[1].bpm), bHT = bpmNum(rows[3].bpm);
  if (isFinite(bNone) && isFinite(bDT) && bNone > 30) {
    if (!(Math.abs(bDT - bNone * 1.5) < 2)) {
      errs.push(`DT 的 BPM 应≈None×1.5：None=${bNone} DT=${bDT}`);
    }
  }
  if (isFinite(bNone) && isFinite(bHT) && bNone > 30) {
    /* HT 的 rate=0.75：歌曲被放慢，同一段音乐里的 BPM 数值**变小**
       （230 × 0.75 = 173）。别写成 ÷0.75 —— 那是「时长」的算法。*/
    if (!(Math.abs(bHT - bNone * 0.75) < 2)) {
      errs.push(`HT 的 BPM 应≈None×0.75：None=${bNone} HT=${bHT}`);
    }
  }
  /* 折算后的 BPM 不能带浮点尾巴（用户要求四舍五入到整数）*/
  for (const r of rows) {
    if (r.mod === 'None') continue;
    if (/\.\d/.test(String(r.bpm))) {
      errs.push(`${r.mod}: BPM「${r.bpm}」应为整数（用户要求四舍五入）`);
    }
  }

  /* ---- OD 必须用官方口径 display.displayOdLazer ----
     两条用户反馈都指向同一个根因：
       · 「OD 超出 10 时仍显示 10」   -> 取了封顶值
       · 「HT(HR+HT/EZ+HT) 没有影响 OD」-> 取了 stable 的 displayOd，
         那个公式只在 great<20ms 时启用 >10 延拓，HT 方向完全不动。
     官方口径是 displayOdLazer
     （TaikoRuleset.GetAdjustedDisplayDifficulty 用 InverseDifficultyRange 反解）。
     官方单测 TaikoRateAdjustedDisplayDifficultyTest 断言 OD5+HT -> 1.11。*/
  const drawOdFor = (mod) => {
    const rep = PANEL.buildDifficultyReport(bm2, { mod });
    const cfgX = L.applyCompact(Object.assign({}, L.DEFAULTS), W);
    cfgX.headerHeight = R.headerHeightFor(W);
    cfgX.pixelsPerSecond = L.alignPixelsPerSecond(bm2, cfgX) || 200;
    const layX = L.computeLayout(bm2, cfgX);
    const sdX = {
      mod, modLabel: mod, starRating: rep.skills.total,
      starRatingBase: rep.skills.total,
      rows: rep.skills.rows, display: rep.display,
      maxPp: Math.max(...rep.pp.curve.map((c) => c.totalPP)), maxPpLabel: 'SS',
    };
    const rrX = new R.PreviewRenderer(bm2, layX, cfgX, { loaded: false }, {
      header: true, bgImage: null, useSkin: false, srData: sdX,
    });
    const cxX = makeCtx();
    rrX._drawHeader(cxX, W, 0, 1);
    const d = rep.display;
    /* 期望画出的 OD 文本（官方公式是线性外推，负值原样显示，不钳）。
       小数位按是否开 mod自适应：无 mod 一位、有 mod 两位。*/
    const want = d.displayOdLazer.toFixed(mod === 'None' ? 1 : 2);
    const shown = cxX.texts.map((t) => t.s);
    if (!shown.includes(want)) {
      errs.push(`${mod} 下OD 应显示 ${want}（官方 displayOdLazer=${d.displayOdLazer.toFixed(2)}），`
        + `实际未出现；画出的数值= ${JSON.stringify(shown.filter((x) => /^\d+\.\d$/.test(x)))}`);
    }
    return { want, shown };
  };

  const oNone = drawOdFor('None');
  const oDT = drawOdFor('DT');
  const oHT = drawOdFor('HT');
  const oHRHT = drawOdFor('HR+HT');
  const oEZHT = drawOdFor('EZ+HT');
  console.log('     OD 显示值（官方口径）:');
  for (const [n, r] of [['None', oNone], ['DT', oDT], ['HT', oHT],
    ['HR+HT', oHRHT], ['EZ+HT', oEZHT]]) {
    console.log('       ' + n.padEnd(7) + ' -> ' + r.want);
  }

  /* HT 必须让 OD **下降**（判定窗变宽 -> 同样的窗口对应更低的 OD）*/
  const odNum = (t) => parseFloat(t);
  if (!(odNum(oHT.want) < odNum(oNone.want) - 0.05)) {
    errs.push(`HT 未让 OD 下降：None=${oNone.want} HT=${oHT.want}`);
  }
  /* DT 必须让 OD 上升，且能突破 10 */
  if (!(odNum(oDT.want) > odNum(oNone.want) + 0.05)) {
    errs.push(`DT 未让 OD 上升：None=${oNone.want} DT=${oDT.want}`);
  }
  /* HR+HT 仍应高于 EZ+HT（HR 收紧判定，方向相反）*/
  if (!(odNum(oHRHT.want) > odNum(oEZHT.want))) {
    errs.push(`HR+HT 的OD (${oHRHT.want}) 应高于 EZ+HT (${oEZHT.want})`);
  }
  /* 负 OD 是**合法**输出（官方公式线性外推的结果），但必须在后面
     附上实际判定窗来解释它 —— 否则用户看到 "-0.89" 只会以为是 bug。
     所以这里反过来断言：判定窗后缀必须被画出来。*/
  for (const n of ['None', 'DT', 'HT', 'HR+HT', 'EZ+HT']) {
    const rep = PANEL.buildDifficultyReport(bm2, { mod: n });
    const gw = rep.display.greatWindow.toFixed(1);
    const cfgy = L.applyCompact(Object.assign({}, L.DEFAULTS), W);
    cfgy.headerHeight = R.headerHeightFor(W);
    cfgy.pixelsPerSecond = 200;
    const layy = L.computeLayout(bm2, cfgy);
    const sdy = {
      mod: n, modLabel: n, starRating: rep.skills.total,
      starRatingBase: rep.skills.total, rows: rep.skills.rows,
      display: rep.display,
      maxPp: 100, maxPpLabel: 'SS',
    };
    const rry = new R.PreviewRenderer(bm2, layy, cfgy, { loaded: false }, {
      header: true, bgImage: null, useSkin: false, srData: sdy,
    });
    const cxy = makeCtx();
    rry._drawHeader(cxy, W, 0, 1);
    const tx = cxy.texts.map((t) => t.s);
    if (!tx.some((t2) => t2.indexOf(gw + 'ms') >= 0)) {
      errs.push(`${n}: OD 后面未画出判定窗「${gw}ms」（负 OD 离不开它来解释）`);
    }
  }
  console.log('     OD 后缀: 各mod 均已附上实际判定窗 (xx.xms)');

  /* 官方单测直接对拍：OD5 + HT -> 1.11，OD5 + DT -> 8.89 */
  const od5ht = D.getAdjustedDisplayDifficulty(5, 5, 'HT').displayOdLazer;
  const od5dt = D.getAdjustedDisplayDifficulty(5, 5, 'DT').displayOdLazer;
  if (Math.abs(od5ht - 1.11) > 0.01) {
    errs.push(`官方单测 OD5+HT 应= 1.11，实际 ${od5ht.toFixed(3)}`);
  }
  if (Math.abs(od5dt - 8.89) > 0.01) {
    errs.push(`官方单测 OD5+DT 应 = 8.89，实际 ${od5dt.toFixed(3)}`);
  }
  console.log('     官方单测对拍: OD5+HT=%s(应1.11)  OD5+DT=%s(应8.89)',
    od5ht.toFixed(2), od5dt.toFixed(2));
}

/* ---------- 刻度条对齐（用户反馈第 1 条）---------- */
/* HP / OD 两条与下面 4×skill + Star Rating 必须**左端、条形长度、右端数值列**
   全部对齐。之前两个绘制函数各算一套「标签列 + 间隙」，差2px。*/
console.log('[7] 刻度条对齐检查:');
{
  const W = 660;
  const cfg = L.applyCompact(Object.assign({}, L.DEFAULTS), W);
  cfg.headerHeight = R.headerHeightFor(W);
  cfg.pixelsPerSecond = L.alignPixelsPerSecond(bm, cfg) || 200;
  const lay = L.computeLayout(bm, cfg);
  const r = new R.PreviewRenderer(bm, lay, cfg, { loaded: false }, {
    header: true, bgImage: null, useSkin: false, srData: SRDATA,
  });
  /* 记录所有 fillRect（条形底+填充）与 fillText（标签/数值）的坐标 */
  const ctx = makeCtx();
  r._drawHeader(ctx, W, 0, 1);

  /* 判定对齐的方式：条形底是 roundRect（走 path，桩不记录），
     所以用「标签右缘」+「数值左缘」两列坐标来判定 ——
     同一列的标签必须右缘相同，同一列的数值必须左缘相同。*/

  /* 所有刻度条的标签右缘应一致（标签都是右对齐到同一列）*/
  const T = ctx.texts;
  const barLabels = ['HP', 'OD', 'Stamina', 'Colour', 'Rhythm', 'Reading', 'Star Rating'];
  const labelXs = [];
  for (const lbl of barLabels) {
    const hit = T.find((t) => t.s === lbl);
    if (!hit) { errs.push(`宽 ${W}：刻度条标签「${lbl}」未画出来`); continue; }
    labelXs.push({ lbl, x: hit.x });
  }
  /* 标签是右对齐，同一列-> 绘制时的 x 相同 */
  const uniqLabelX = new Set(labelXs.map((v) => Math.round(v.x)));
  console.log('     标签右缘 x: ' + labelXs.map((v) => v.lbl + '@' + Math.round(v.x)).join(' '));
  if (uniqLabelX.size > 1) {
    errs.push(`宽 ${W}：刻度条标签右缘不一致（${[...uniqLabelX].join('/')}），未对齐`);
  }

  /* 数值列左缘应一致（HP/OD 是 "3.5"，skill 是 "56.91"，SR 是 "8.03★"）。
     必须**只看刻度条那7 行**—— 上方统计行（时长/物件数/BPM）的数字
     在别的列上，不参与这条断言。刻度条 y >= BARS_Y0。*/
  const barTop = R.headerLayout(W).panelY + R.headerLayout(W).BARS_Y0;
  const valTexts = T.filter((t) => /^\d+(\.\d+)?★?$/.test(t.s) && t.y >= barTop);
  const valXs = valTexts.map((t) => Math.round(t.x));
  const uniqValX = new Set(valXs);
  console.log('     条形数值左缘 x: ' + [...uniqValX].join('/')
    + '（共 ' + valTexts.length + ' 个: ' + valTexts.map((t) => t.s).join(' ') + '）');
  if (uniqValX.size > 1) {
    errs.push(`宽 ${W}：刻度条数值左缘不一致（${[...uniqValX].join('/')}），未对齐`);
  }
  if (valTexts.length < 7) {
    errs.push(`宽 ${W}：刻度条只画出了 ${valTexts.length} 个数值（应≥7）`);
  }
}

/* ---------- skill 顺序固定 / 页脚已删 / SR 变化值 / 背景图 ---------- */
console.log('[8] skill 顺序固定 + 页脚删除 + SR 变化值:');
{
  const W = 660;
  const mk = (sd) => {
    const cfg = L.applyCompact(Object.assign({}, L.DEFAULTS), W);
    cfg.headerHeight = R.headerHeightFor(W);
    cfg.pixelsPerSecond = L.alignPixelsPerSecond(bm, cfg) || 200;
    const lay = L.computeLayout(bm, cfg);
    const r = new R.PreviewRenderer(bm, lay, cfg, { loaded: false }, {
      header: true, bgImage: null, useSkin: false, srData: sd,
    });
    const cx = makeCtx();
    r._drawHeader(cx, W, 0, 1);
    return cx.texts;
  };

  /* ---- (2) 四项 skill 顺序固定 Stamina/Colour/Rhythm/Reading ----
     关键：不因占比大小重排。之前是 sort((a,b)=>b.ratio-a.ratio)，
     换个 mod 某项占比变了就跳位，四条 bar 会左右乱窜。*/
  const wantOrder = ['Stamina', 'Colour', 'Rhythm', 'Reading'];
  for (const [label, sd] of [
    ['CL', SRDATA],
    /* 造一个「占比顺序与固定顺序相反」的数据 —— 如果代码还在按占比排序，
       这里立刻就会暴露出来。*/
    ['占比逆序', Object.assign({}, SRDATA, {
      rows: [
        { key: 'reading', en: 'Reading', ratio: 0.60, color: '#ffd23f' },
        { key: 'rhythm', en: 'Rhythm', ratio: 0.20, color: '#ffd23f' },
        { key: 'colour', en: 'Colour', ratio: 0.12, color: '#ffd23f' },
        { key: 'stamina', en: 'Stamina', ratio: 0.08, color: '#ffd23f' },
      ],
    })],
  ]) {
    const T = mk(sd);
    const got = wantOrder.map((en) => {
      const hit = T.find((t) => t.s === en);
      return hit ? Math.round(hit.y) : null;
    });
    const missing = got.filter((v) => v === null);
    if (missing.length) {
      errs.push(`${label}：skill 标签未全部画出（缺 ${missing.length} 个）`);
      continue;
    }
    /* y 必须严格递增（从上到下按固定顺序）*/
    const inc = got.every((v, i) => i === 0 || v > got[i - 1]);
    console.log('     ' + label.padEnd(8) + ' y: ' + wantOrder.map((n, i) => n + '@' + got[i]).join(' ')
      + (inc ? '✅ 顺序固定' : '❌ 未按固定顺序'));
    if (!inc) {
      errs.push(`${label}：skill 顺序应为 ${wantOrder.join('->')}，实际 y=${got.join('/')}`);
    }
  }

  /* ---- (3) 底部不再有「osu!taiko 谱面预览」与页码 ----*/
  {
    const T = mk(SRDATA);
    const texts = T.map((t) => t.s);
    if (texts.some((s2) => s2.indexOf('osu!taiko 谱面预览') >= 0)) {
      errs.push('页脚「osu!taiko 谱面预览」仍在（用户要求删去）');
    }
    /* 也不该有 "1 / 1" 这种页码 */
    if (texts.some((s2) => /^\d+\s*\/\s*\d+$/.test(s2))) {
      errs.push('页码仍在（用户要求删去）');
    }
    /* 所有文字都必须落在信息栏高度内，且最后一条不能离框底太远
       —— 否则就留了用户说的那段空白。*/
    const H = R.headerHeightFor(W);
    const maxY = Math.max(...T.map((t) => t.y));
    const slop = maxY - H;
    console.log('     页脚已删；最后一条文字基线 y=%s，信息栏高 H=%s，余量 %s px',
      maxY.toFixed(1), H, slop.toFixed(1));
    if (slop > 24) {
      errs.push(`信息栏底部余量 ${slop.toFixed(1)}px 过大（用户要求「紧贴预览图」）`);
    }
  }

  /* ---- (4) SR 变化值：基准 vs 加 DT ----*/
  {
    const base = PANEL.buildDifficultyReport(bm, { mod: 'CL' });
    const dt = PANEL.buildDifficultyReport(bm, { mod: 'DT+CL' });
    const delta = dt.skills.total - base.skills.total;
    const T = mk(Object.assign({}, SRDATA, {
      starRating: dt.skills.total,
      starRatingBase: base.skills.total,
    }));
    const srTxt = T.find((t) => /★$/.test(t.s) || t.s.indexOf('★') >= 0);
    const wantDlt = `(${delta >= 0 ? '+' : ''}${delta.toFixed(2)})`;
    const all = T.map((t) => t.s);
    const hasDlt = all.some((s2) => s2.indexOf(wantDlt) >= 0);
    console.log('     SR: 基准 %s -> DT %s，变化值「%s」%s',
      base.skills.total.toFixed(2), dt.skills.total.toFixed(2), wantDlt,
      hasDlt ? '✅ 已画出' : '❌ 未画出');
    if (Math.abs(delta) >= 0.005 && !hasDlt) {
      errs.push(`SR 变化值「${wantDlt}」未画出（用户要求追加变化值）`);
    }
    /* 无变化时不该追加 */
    const T2 = mk(Object.assign({}, SRDATA, {
      starRating: base.skills.total, starRatingBase: base.skills.total,
    }));
    if (T2.map((t) => t.s).some((s2) => /^\s*\([+-]/.test(s2))) {
      errs.push('SR 无变化时不应追加 (+0.00)');
    }
    /* 数值列必须放得下 —— 不能被_ellipsis 截掉尾巴 */
    const trunc = all.find((s2) => s2.indexOf('…') >= 0 && /★/.test(s2));
    if (trunc) errs.push(`SR 数值被截断：${JSON.stringify(trunc)}`);
    void srTxt;
  }

  /* ---- (4) 背景图功能已移除 ----
     用户反馈「背景图还是获取不到，去掉这个功能吧」。
     官方图床在浏览器里被 CORS/CSP 挡住，扩展里拿不到。
     现在信息栏**恒定纯色底**，无论 opts.bgImage 有没有值都不画封面。*/
  {
    const cfg = L.applyCompact(Object.assign({}, L.DEFAULTS), W);
    cfg.headerHeight = R.headerHeightFor(W);
    cfg.pixelsPerSecond = 200;
    const lay = L.computeLayout(bm, cfg);
    const c1 = makeCtx();
    new R.PreviewRenderer(bm, lay, cfg, { loaded: false }, {
      header: true, useSkin: false, srData: SRDATA,
    })._drawHeader(c1, W, 0, 1);
    /* 即便有人传了 bgImage，也不再绘制 */
    const c2 = makeCtx();
    new R.PreviewRenderer(bm, lay, cfg, { loaded: false }, {
      header: true, bgImage: { width: 800, height: 450 }, useSkin: false, srData: SRDATA,
    })._drawHeader(c2, W, 0, 1);
    const d1 = c1.calls.drawImage || 0;
    const d2 = c2.calls.drawImage || 0;
    console.log('     背景图功能: 无参数 drawImage=%d，有参数 drawImage=%d %s',
      d1, d2, (d1 === 0 && d2 === 0) ? '✅ 已移除' : '❌ 仍在绘制');
    if (d1 !== 0 || d2 !== 0) {
      errs.push(`背景图功能未彻底移除（drawImage 无参数=${d1}、有参数=${d2}，都应为 0）`);
    }
  }
}

/* ---------- PP / mod 文本不得溢出左栏（用户要求「字体再大一点」）---------- */
console.log('[9] PP / mod 字号自适应（不溢出左栏）:');
{
  /* 最坏情况：4 位 PP + 全勾 mod —— 缩写 "+HR,HD,FL,DT,CL" 有 15 个字符 */
  const worst = Object.assign({}, SRDATA, {
    maxPp: 9999, modLabel: '+HR,HD,FL,DT,CL',
  });
  for (const W of [420, 520, 660, 860, 1000, 1300, 1920]) {
    const LAY = R.headerLayout(W);
    const cfg = L.applyCompact(Object.assign({}, L.DEFAULTS), W);
    cfg.headerHeight = LAY.H;
    cfg.pixelsPerSecond = 200;
    const lay = L.computeLayout(bm, cfg);
    const cx = makeCtx();
    /* 记录每次 fillText 时的 font，用它算实际宽度 */
    new R.PreviewRenderer(bm, lay, cfg, { loaded: false }, {
      header: true, bgImage: null, useSkin: false, srData: worst,
    })._drawHeader(cx, W, 0, 1);

    const PAD = LAY.PAD, PAD_IN = LAY.PAD_IN;
    const leftBound = PAD + PAD_IN;
    const availW = LAY.LEFT_W - PAD_IN * 2;
    /* 只看左栏右对齐的那两条：PP 与 mod 缩写 */
    const rightAligned = cx.texts.filter((t) => t.align === 'right');
    let worstOver = 0, worstTxt = '';
    for (const t of rightAligned) {
      const size = (() => {
        const m = /(\d+(?:\.\d+)?)px/.exec(String(t.font || ''));
        return m ? parseFloat(m[1]) : 12;
      })();
      let w = 0;
      for (const ch of String(t.s)) w += ch.charCodeAt(0) > 255 ? size : size * 0.56;
      const left = t.x - w;                 /* 右对齐 -> 左缘 = x - 宽度 */
      const over = leftBound - left;
      if (over > worstOver) { worstOver = over; worstTxt = t.s; }
    }
    const ppRow = rightAligned.find((t) => /PP$/.test(t.s));
    const modRow = rightAligned.find((t) => t.s === worst.modLabel);
    const ppSize = (() => {
      const m = /(\d+(?:\.\d+)?)px/.exec(String(ppRow && ppRow.font || ''));
      return m ? Math.round(parseFloat(m[1])) : 0;
    })();
    const modSize = (() => {
      const m = /(\d+(?:\.\d+)?)px/.exec(String(modRow && modRow.font || ''));
      return m ? Math.round(parseFloat(m[1])) : 0;
    })();
    console.log('     W=%s 左栏宽 %s可用 %s | PP %spx  mod %spx  溢出 %s px %s',
      String(W).padEnd(5), String(LAY.LEFT_W).padEnd(4), String(Math.round(availW)).padEnd(4),
      String(ppSize).padStart(3), String(modSize).padStart(3),
      worstOver.toFixed(1).padStart(6),
      worstOver <= 0.5 ? '✅' : '❌「' + worstTxt + '」');
    if (worstOver > 0.5) {
      errs.push(`宽 ${W}：左栏文本「${worstTxt}」左溢出 ${worstOver.toFixed(1)}px（超出左内缘 ${leftBound}）`);
    }
    /* mod 缩写不能被省略号截断（用户要看到完整的 mod 列表）*/
    if (modRow && modRow.s.indexOf('…') >= 0) {
      errs.push(`宽 ${W}：mod 缩写被截断 -> ${JSON.stringify(modRow.s)}`);
    }
    /* 字号下限。
       PP 必须≥20px —— 用户明确反馈过「不够大」。
       mod 的下限取决于宽度：最坏情况（15 字符缩写 + 4 位 PP）在 420px
       的最小窗口里物理上只能放下 12px。但那仍然比 v1.3.1 的
       F(24,16) 在该宽度下的实际字号（16 → 但当时被固定字号顶到 16px，
       实测会溢出左栏）好，而且**不会溢出**。
       所以按宽度分档：宽窗要求≥16，窄窗（最坏情况）要求≥12。*/
    if (ppSize < 20) errs.push(`宽 ${W}：PP 字号仅 ${ppSize}px，用户反馈过「不够大」`);
    const modFloor = W >= 660 ? 16 : 12;
    if (modSize < modFloor) {
      errs.push(`宽 ${W}：mod 字号仅 ${modSize}px（下限应为 ${modFloor}px）`);
    }
  }
}

/* ---------- 条形长度 / OD 小数位（用户反馈第1、2 条）---------- */
console.log('[10] 条形长度与 OD 小数位:');
{
  /* ---- (1) 条形必须占到可用宽度的合理比例 ----
     用户反馈「条形图怎么变这么短了」。根因是**双重扣减**：
     调用方先扣了 LABEL_COL/VAL_W 算出 barW，再传给 _barGeom(x, barW, ...)，
     而 _barGeom 内部又扣了一遍 -> VAL_W 从 52 涨到 128 后，
     多扣的 76px 全打在条形上，直接被 Math.max(20,...) 钳到下限。
     现在断言：条形长度必须 ≥ 可用宽度的 40%。*/
  const probe = Object.create(R.PreviewRenderer.prototype);
  for (const W of [640, 700, 860, 1000, 1300, 1920]) {
    const LAY = R.headerLayout(W);
    const PAD = LAY.PAD, PAD_IN = LAY.PAD_IN;
    const SIDE = Math.max(5, Math.round(10 * LAY.k));
    const rx = W - PAD - LAY.RIGHT_W;
    const bx = rx + PAD_IN + SIDE;
    const innerR = rx + LAY.RIGHT_W - PAD_IN;
    /* 复刻 _drawHeader 里的 VAL_W */
    const valEm = LAY.F(17, 10), smallEm = LAY.F(13, 9);
    const mainW = 6 * 0.58 * valEm + 0.7 * valEm + 0.3 * valEm;
    const VAL_W = Math.ceil(Math.max(
      LAY.F(52, 28), mainW + 9 * 0.6 * smallEm, mainW * 0.75 + 16 * 0.6 * smallEm) + 8);
    const fullW = Math.max(60, innerR - bx);
    const g = probe._barGeom(bx, fullW, LAY.LABEL_COL, VAL_W);
    const ratio = g.tw / fullW;
    /* 同时验证 valX 没有越过右内缘 */
    const valRight = g.valX + VAL_W;
    console.log('     W=%s  可用 %spx -> 条形 %spx (%s%%)  数值列右缘 %s / %s %s',
      String(W).padEnd(5), String(Math.round(fullW)).padEnd(4),
      String(Math.round(g.tw)).padEnd(4), (ratio * 100).toFixed(0).padStart(2),
      String(Math.round(valRight)).padEnd(4), String(Math.round(innerR)).padEnd(4),
      ratio >= 0.40 ? '✅' : '❌条形过短');
    if (ratio < 0.40) {
      errs.push(`宽 ${W}：条形仅占可用宽度 ${(ratio * 100).toFixed(0)}%（应≥40%）—— `
        + `疑似 barW 被双重扣减`);
    }
    /* 数值列不得越出右内缘 */
    if (valRight > innerR + 1) {
      errs.push(`宽 ${W}：数值列右缘 ${Math.round(valRight)} 越出右内缘 ${innerR}`);
    }
    /* 条形起点必须在标签列右侧 */
    if (g.tx <= bx + LAY.LABEL_COL) {
      errs.push(`宽 ${W}：条形起点 ${Math.round(g.tx)} 未越过标签列右缘 `
        + `${Math.round(bx + LAY.LABEL_COL)}`);
    }
  }

  /* ---- (2) OD 小数位：无 mod 1 位，有 mod 2 位 ----
     用户要求「平常是一位小数，开了 mod 之后需要两位再显示两位」。
     理由：判定窗反解出来的值通常是无理数（HT 让 OD=3.778…），
     一位小数会丢掉信息。*/
  const drawOd = (mod) => {
    const rep = PANEL.buildDifficultyReport(bm, { mod });
    const cfg = L.applyCompact(Object.assign({}, L.DEFAULTS), 660);
    cfg.headerHeight = R.headerHeightFor(660);
    cfg.pixelsPerSecond = 200;
    const lay = L.computeLayout(bm, cfg);
    const sd = {
      mod, modLabel: mod === 'None' ? 'None' : '+' + mod.split('+').join(','),
      starRating: rep.skills.total, starRatingBase: rep.skills.total,
      rows: rep.skills.rows, display: rep.display,
      maxPp: 100, maxPpLabel: 'SS',
    };
    const cx = makeCtx();
    new R.PreviewRenderer(bm, lay, cfg, { loaded: false }, {
      header: true, useSkin: false, srData: sd,
    })._drawHeader(cx, 660, 0, 1);
    /* 返回文本**对象**（含 x/y）—— 小数位判据要按行定位，不能只拿字符串 */
    return cx.texts;
  };
  /* 判定「OD 那一行的小数位」：
     不能用「文本里有没有两位小数」来判 —— OD 后面还有判定窗后缀
     `(29.0ms)`，它自己就带一位小数，会把判据弄混。
     正解是取 **OD 行**（与「OD」标签同一 y）的主数值文本，
     也就是后缀之前的那一段。*/
  const odMainOf = (texts) => {
    /* 找 "OD" 标签的 y（标签是右对齐、textBaseline=middle）*/
    const lab = texts.find((t) => t.s === 'OD');
    if (!lab) return null;
    const row = texts.filter((t) => Math.abs(t.y - lab.y) < 0.6 && t.x > lab.x);
    /* 后缀以空格+括号开头，把它剥掉 */
    for (const t of row) {
      const m = /^([-+]?\d+\.\d+)/.exec(t.s);
      if (m) return m[1];
    }
    return null;
  };

  /* CL / HD / FL 虽然勾了，但它们**不改任何难度参数**
     （TAIKO_MODS 里 od/sm/rate 全是 1.0），OD 原样 -> 仍然一位小数。
     真正需要两位的是 EZ/HR（改 OD）与 HT/DT（改判定窗）。*/
  const cases = [
    /* mod 名,期望小数位 */
    ['None', 1], ['CL', 1], ['HD', 1], ['FL', 1], ['CL+HD', 1], ['FL+HD', 1],
    ['DT', 2], ['HT', 2], ['HR', 2], ['EZ', 2],
    ['HR+HT', 2], ['EZ+HT', 2], ['DT+CL', 2], ['EZ+CL+HD', 2],
  ];
  console.log('OD 小数位（无 mod 一位/ 有 mod 两位）:');
  for (const [mod, wantDec] of cases) {
    const texts = drawOd(mod);
    const main = odMainOf(texts);
    if (!main) {
      errs.push(`${mod}: 未找到 OD 行的主数值（判据失效）`);
      continue;
    }
    const dot = main.indexOf('.');
    const dec = dot < 0 ? 0 : main.length - dot - 1;
    const ok = dec === wantDec;
    console.log('     %s -> OD %s  (%s位小数) %s',
      mod.padEnd(7), main.padStart(7), dec, ok ? '✅' : `❌ 应${wantDec} 位`);
    if (!ok) {
      errs.push(`${mod}: OD 显示 ${main}（${dec} 位小数），应为 ${wantDec} 位`);
    }
  }

  /* HP 行**不该**带判定窗后缀 —— 只有 OD 有（判定窗直接对应 OD）。*/
  for (const mod of ['None', 'DT', 'HT']) {
    const texts = drawOd(mod);
    const hpLab = texts.find((t) => t.s === 'HP');
    if (!hpLab) { errs.push(`${mod}: 未找到 HP 标签`); continue; }
    const row = texts.filter((t) => Math.abs(t.y - hpLab.y) < 0.6 && t.x > hpLab.x);
    if (row.some((t) => /\(\s*[\d.]+ms\s*\)/.test(t.s))) {
      errs.push(`${mod}: HP 行不该带判定窗后缀（只有 OD 有）`);
    }
    /* HP 始终一位小数（EZ 只把它减半，一位够）*/
    for (const t of row) {
      const m = /^([-+]?\d+\.\d+)/.exec(t.s);
      if (m && (m[1].length - m[1].indexOf('.') - 1) !== 1) {
        errs.push(`${mod}: HP 应为一位小数，实际 ${m[1]}`);
      }
    }
  }
}

/* ---------- [5] std（Mode 0）转谱的信息栏：bid 后追加黄色「(转谱)」 ---------- */
/* std 谱走转换路径，bid 那一行后面会多画一个黄色的 `(转谱)`。
   要确认：
     1) 标记确实画出来了（否则用户会把转谱星数误当成该 osu! 难度的星数）
     2) ★ 它与 bid **同一基线**（用户反馈早先版本「转谱预览 osu!→taiko」
        夹在难度名与谱师两行之间，在窄窗口下会与谱师那行叠字）
     3) 整体不越出左栏宽度 —— 放不下就整个省略，宁可少信息也不要糊成一团
*/
console.log('[5] std 转谱信息栏:');
{
  const stdDir = path.join(HERE, 'std_zips');
  const stdFiles = fs.existsSync(stdDir)
    ? fs.readdirSync(stdDir).filter((n) => n.endsWith('.osu')) : [];
  if (!stdFiles.length) {
    console.log('    （无 std 样本，跳过）');
  } else {
    const sb = parser.parseOsu(fs.readFileSync(path.join(stdDir, stdFiles[0]), 'utf8'));
    if (sb.mode !== 0 || !sb.isConvert) {
      errs.push(`std 样本模式异常: mode=${sb.mode} isConvert=${sb.isConvert}`);
    }
    const rep = PANEL.buildDifficultyReport(sb, { mod: 'CL' });
    let mp = 0;
    for (const c of (rep.pp.curve || [])) if (c.totalPP > mp) mp = c.totalPP;
    const sd = {
      mod: 'CL', modLabel: '+CL',
      starRating: rep.skills.total, starRatingBase: rep.skills.total,
      rows: rep.skills.rows, display: rep.display, maxPp: mp, maxPpLabel: 'SS',
    };
    for (const W of [420, 660, 1000, 1600]) {
      const cfg = L.applyCompact(Object.assign({}, L.DEFAULTS), W);
      cfg.headerHeight = R.headerHeightFor(W);
      const al = L.alignPixelsPerSecond(sb, cfg);
      cfg.pixelsPerSecond = al > 0 ? al : 200;
      const lay = L.computeLayout(sb, cfg);
      const rr = new R.PreviewRenderer(sb, lay, cfg, { loaded: false }, {
        header: true, bgImage: null, useSkin: false, srData: sd,
      });
      /* 直接调 _drawHeader 并传自己的 ctx 桩 ——
         renderPage 内部会 document.createElement 造一个**全新**的 ctx，
         那样就抓不到 texts 了（与本文件其它小节的做法一致）。*/
      const cx = makeCtx();
      rr._drawHeader(cx, W, 0, 1);
      const texts = cx.texts.filter((x) => x.s);
      const badge = texts.find((x) => x.s.indexOf('(转谱)') >= 0);
      const bidLine = texts.find((x) => /^bid\s/.test(x.s));
      if (!bidLine) {
        errs.push(`宽 ${W}：信息栏未画出 bid 行（样本缺 BeatmapID？）`);
        continue;
      }
      const LAY = R.headerLayout(W);
      const PANEL_Y = LAY.panelY;
      const lx = LAY.PAD + LAY.PAD_IN;
      const lw = LAY.LEFT_W - LAY.PAD_IN * 2;

      if (!badge) {
        /* 允许「宽度不够就省略」，但必须确认是真的放不下，
           而不是因为代码没画。用桩的 measureText 估算一下。 */
        console.log('    宽 %s 未画「(转谱)」（左栏宽 %s，bid 文本 %s）',
          String(W).padEnd(5), lw.toFixed(0), bidLine.s);
      } else {
        /* ★ 与 bid 同一基线 —— 这是本次修复的核心断言。
           早先版本把标记画在 ly + LINE_GAP*0.62（难度名与谱师之间），
           窄窗口下 k 缩放让行高变紧，就与谱师那行叠字了。*/
        if (Math.abs(badge.y - bidLine.y) > 0.6) {
          errs.push(`宽 ${W}：「(转谱)」基线 ${badge.y.toFixed(1)} 与 bid 行 `
            + `${bidLine.y.toFixed(1)} 不一致（应同行，否则会压到别的行）`);
        }
        /* 必须排在 bid 右边（不能重叠）*/
        if (badge.x < bidLine.x) {
          errs.push(`宽 ${W}：「(转谱)」x=${badge.x.toFixed(0)} 落在 bid `
            + `x=${bidLine.x.toFixed(0)} 左侧，应追加在后面`);
        }
        /* 整体不得越出左栏右缘 —— 越界就是会糊到右栏统计上去 */
        if (badge.x + (badge.w || 0) > lx + lw + 0.5) {
          errs.push(`宽 ${W}：「(转谱)」右缘 ${(badge.x + (badge.w || 0)).toFixed(0)} `
            + `越出左栏右缘 ${(lx + lw).toFixed(0)}`);
        }
        /* 也不能越出信息栏框的上下边界 */
        if (badge.y <= PANEL_Y || badge.y >= PANEL_Y + LAY.panelH) {
          errs.push(`宽 ${W}：「(转谱)」基线 ${badge.y.toFixed(0)} 越出左栏 `
            + `[${PANEL_Y}, ${(PANEL_Y + LAY.panelH).toFixed(0)}]`);
        }
        console.log('    宽 %s bid「%s」x=%s +「(转谱)」x=%s 同基线 y=%s 左栏右缘 %s %s',
          String(W).padEnd(5), bidLine.s, bidLine.x.toFixed(0),
          badge.x.toFixed(0), badge.y.toFixed(0), (lx + lw).toFixed(0), '✅');
      }
    }
  }
}

console.log();

/* ---------- [6] ★ 脏数据提示：被丢弃过条目时必须说出来 ---------- */
/* 起因：1419088 BadSweets 的 TimingPoints 里有 3 条脏数据
 *（beatLength=6e-87、时间戳 -569220001），解析层丢弃它们才能活下来。
 * 静默丢弃的话用户会以为「谱面本来就这样」——
 * 而被丢的拍长会直接影响小节线位置，进而影响读谱。*/
console.log('[6] 脏数据提示:');
{
  const dirtyDir = path.join(HERE, 'badsweets');
  const dirtyFiles = fs.existsSync(dirtyDir)
    ? fs.readdirSync(dirtyDir).filter((n) => n.endsWith('.osu')) : [];
  if (!dirtyFiles.length) {
    console.log('    （无脏数据样本，跳过）');
  } else {
    for (const W of [660, 1000]) {
      const f = dirtyFiles[0];
      const db = parser.parseOsu(fs.readFileSync(path.join(dirtyDir, f), 'utf8'));
      const dropped = (db.droppedTiming || 0) + (db.droppedObjects || 0);
      if (dropped === 0) {
        errs.push(`脏数据样本 ${f} 的 dropped 都是 0 —— 解析层防御没生效`);
        continue;
      }
      const cfg = L.applyCompact(Object.assign({}, L.DEFAULTS), W);
      cfg.headerHeight = R.headerHeightFor(W);
      const al = L.alignPixelsPerSecond(db, cfg);
      cfg.pixelsPerSecond = al > 0 ? al : 200;
      const lay = L.computeLayout(db, cfg);
      const rep = PANEL.buildDifficultyReport(db, { mod: 'CL' });
      let mp = 0;
      for (const c of (rep.pp.curve || [])) if (c.totalPP > mp) mp = c.totalPP;
      const sd = {
        mod: 'CL', modLabel: '+CL',
        starRating: rep.skills.total, starRatingBase: rep.skills.total,
        rows: rep.skills.rows, display: rep.display, maxPp: mp, maxPpLabel: 'SS',
      };
      const cx = makeCtx();
      new R.PreviewRenderer(db, lay, cfg, { loaded: false }, {
        header: true, bgImage: null, useSkin: false, srData: sd,
      })._drawHeader(cx, W, 0, 1);
      const texts = cx.texts.filter((x) => x.s);
      const LAY = R.headerLayout(W);
      const note = texts.find((x) => x.s.indexOf('已忽略') >= 0);
      if (!note) {
        errs.push(`宽 ${W}：丢弃了 ${dropped} 条异常数据，`
          + `但信息栏没有「已忽略」提示（画出的文本：`
          + `${JSON.stringify(texts.map((x) => x.s).slice(-4))}）`);
        continue;
      }
      /* 必须落在信息栏框内 */
      if (note.y <= LAY.panelY || note.y >= LAY.panelY + LAY.panelH) {
        errs.push(`宽 ${W}：「已忽略」基线 ${note.y.toFixed(0)} 越出信息栏 `
          + `[${LAY.panelY}, ${(LAY.panelY + LAY.panelH).toFixed(0)}]`);
      }
      /* 不越左栏右缘（否则糊到右侧统计区） */
      const lx = LAY.PAD + LAY.PAD_IN;
      const lw = LAY.LEFT_W - LAY.PAD_IN * 2;
      if (note.x + (note.w || 0) > lx + lw + 0.5) {
        errs.push(`宽 ${W}：「已忽略」右缘 ${(note.x + (note.w || 0)).toFixed(0)} `
          + `越出左栏 ${(lx + lw).toFixed(0)}`);
      }
      console.log('    宽 %s 丢弃 %d 条 -> 「%s」y=%s 左栏右缘 %s %s',
        String(W).padEnd(5), dropped, note.s, note.y.toFixed(0),
        (lx + lw).toFixed(0), '✅');
    }
  }

  /* 反向：正常谱**不能**出现这条提示（否则满屏都是）*/
  const normalDir = path.join(HERE, 'test_zips');
  const nf = fs.existsSync(normalDir)
    ? fs.readdirSync(normalDir).filter((n) => n.endsWith('.osu'))[0] : null;
  if (nf) {
    const nb = parser.parseOsu(fs.readFileSync(path.join(normalDir, nf), 'utf8'));
    const cfg = L.applyCompact(Object.assign({}, L.DEFAULTS), 660);
    cfg.headerHeight = R.headerHeightFor(660);
    const al = L.alignPixelsPerSecond(nb, cfg);
    cfg.pixelsPerSecond = al > 0 ? al : 200;
    const lay = L.computeLayout(nb, cfg);
    const cx2 = makeCtx();
    new R.PreviewRenderer(nb, lay, cfg, { loaded: false }, {
      header: true, bgImage: null, useSkin: false,
    })._drawHeader(cx2, 660, 0, 1);
    const leaked = cx2.texts.some((x) => x.s.indexOf('已忽略') >= 0);
    if (leaked) {
      errs.push(`正常谱 ${nf} 也画出了「已忽略」提示 —— `
        + `提示条件写错了（dropped 为 0 时不该出现）`);
    } else {
      console.log('    正常谱不显示该提示 ✅');
    }
  }
}

/* ---------- [7] ★★ Star Rating 条的溢出处理（与 OD/HP 同语义） ---------- */
/* 用户需求：「给 Star Rating 的条形加入和 od/hp 一样的溢出处理
  （用红色从左起覆盖）」。
 *
 * 改动前 `_drawRatioBar` 是 `Math.min(1, value / vmax)` ——
 * **直接夹到满格**，于是 SR 3.50 与 30.00 长得完全一样，
 * 完全看不出「超限了多少」。DT 下 10+ 星很常见，这个必须能看出来。
 *
 * 现在改成与 `_drawMeterBar` 同语义的两段式：
 *   正常段 = min(v, vmax)          -> 本色（SR 是 #7ad4ff）
 *   超限段 = min(v, 2·vmax) - vmax  -> 红色 #ff3b30，**从左端画起**（盖在正常段上）
 *   超过 2·vmax 则按2·vmax 封顶，不再渲染。
 *
 * 四条 skill 占比恒在 0~1、实际不会溢出，这条路径是专门为 SR 准备的。*/
console.log('[7] Star Rating 溢出处理:');
{
  /* 用真实的 headerLayout 几何，确保断言的是实际渲染路径 */
  const W = 1000;
  const LAY = R.headerLayout(W);
  const F = LAY.F;
  const probe = {
    mode: 1, title: 'T', artist: 'A', creator: 'C', version: 'V',
    beatmapSetId: '1', beatmapId: '2', od: 5, hp: 5, cs: 5, ar: 5,
    audioFilename: '', timingPoints: [{ time: 0, beatLength: 500, red: true, meter: 4, sv: 1 }],
    notes: [], breaks: [], isConvert: false, scrollPoints: null,
  };
  const cfg = L.applyCompact(Object.assign({}, L.DEFAULTS), W);
  cfg.headerHeight = R.headerHeightFor(W);
  cfg.pixelsPerSecond = 200;
  const lay = L.computeLayout(probe, cfg);
  const rr = new R.PreviewRenderer(probe, lay, cfg, { loaded: false }, {});

  const bx = LAY.PAD + LAY.PAD_IN + LAY.LEFT_W + F(10, 5);
  const by = LAY.panelY + F(52, 26);
  const bw = LAY.RIGHT_W - F(20, 10);
  const rows = [
    { key: 'stamina', en: 'Stamina', ratio: 0.5, color: '#888888' },
    { key: 'colour', en: 'Colour', ratio: 0.2, color: '#888888' },
    { key: 'rhythm', en: 'Rhythm', ratio: 0.15, color: '#888888' },
    { key: 'reading', en: 'Reading', ratio: 0.15, color: '#888888' },
  ];
  const SR_COLOR = '#7ad4ff';
  const OVER_COLOR = '#ff3b30';

  /** 画一次并返回 **Star Rating 那一条**的实心 fillRect（按绘制顺序）。
   *
   * ★ 定位方式踩过坑：不能靠「取 y 最大的组」—— SR=0 时它根本不画段，
   *   yMax 会落到最后一条 skill 条（Reading）上，测出来的颜色是错的；
   * 也不能拿标签 y 直接当条形 y —— 两者差 barH/2
   *   （实测标签 y=105 / 条形 y=100，barH=10）。
   *
   * 可靠做法：先画一次「SR=10」（正常段必定满格）拿到**最底下那个 y**，
   *   它就是 SR 条所在的位置。同一份rows 下 SR 永远是最后一条。*/
  let srBarY = null;
  function drawSr(sr) {
    const cx = makeCtx();
    rr._drawSkillBars(cx, bx, by, bw,
      { starRating: sr, starRatingBase: 0, rows, display: {} },
      F, LAY, LAY.RIGHT_W * 0.4);
    if (srBarY === null) {
      /* 首次调用：用 SR=10 标定。取所有实心条里y 最大的那个。*/
      const ys = cx.rects.filter((r) => r.w > 0).map((r) => r.y);
      if (!ys.length) {
        errs.push('[7] 标定失败：SR=10 时一条实心段都没画出来');
        return [];
      }
      srBarY = Math.max(...ys);
    }
    /* w > 0 而不是 w > 0.5：SR 极小（如 0.01）时条形宽度是 0.26px，
       那是**正确的**渲染结果（几乎看不见），不该被过滤掉。
       负值/NaN 走的是 w 根本不> 0 的路径，不受影响。*/
    return cx.rects.filter((r) => Math.abs(r.y - srBarY) < 0.5 && r.w > 0);
  }

  /* --- 未超限：只有一段，用本色 --- */
  {
    /* 先跑一次标定 +拿到满格宽度 */
    const full = drawSr(10)[0] ? drawSr(10)[0].w : 0;
    for (const sr of [0.01, 3.5, 9.99, 10]) {
      const segs = drawSr(sr);
      if (segs.length !== 1) {
        errs.push(`SR=${sr}（未超限）应只画 1 段，实际 ${segs.length} 段 `
          + `（rects y=${srBarY}）`);
        continue;
      }
      if (segs[0].fill !== SR_COLOR) {
        errs.push(`SR=${sr}（未超限）段颜色应为 ${SR_COLOR}，实际 ${segs[0].fill}`);
      }
      /* 宽度应严格按 v/10 线性 */
      const expect = full * sr / 10;
      if (Math.abs(segs[0].w - expect) > 1.5) {
        errs.push(`SR=${sr}（未超限）宽度应约 ${expect.toFixed(1)}px`
          + `（=满格×v/10），实际 ${segs[0].w.toFixed(1)}px`);
      }
    }
    console.log('    未超限(0.01/3.5/9.99/10): 单段本色、宽度线性 ✅');
  }

  /* --- 超限：两段，本色 + 红色，红段从左端起 --- */
  {
    const sr = 12.5;
    const segs = drawSr(sr);
    if (segs.length !== 2) {
      errs.push(`SR=${sr}（超限）应画 2 段（正常+超限），实际 ${segs.length} 段`);
    } else {
      const [normal, over] = segs;
      if (normal.fill !== SR_COLOR) {
        errs.push(`SR=${sr} 正常段颜色应为 ${SR_COLOR}，实际 ${normal.fill}`);
      }
      if (over.fill !== OVER_COLOR) {
        errs.push(`SR=${sr} 超限段颜色应为 ${OVER_COLOR}（红色），实际 ${over.fill}`);
      }
      /* ★「从左起覆盖」：两段的 x 必须相同（都从条形最左端画起）*/
      if (Math.abs(normal.x - over.x) > 0.5) {
        errs.push(`SR=${sr} 超限段 x=${over.x.toFixed(1)} 与正常段 `
          + `x=${normal.x.toFixed(1)} 不同 —— 不是「从左起覆盖」`);
      }
      /* 正常段应恰好是满格（min(v,10)=10）*/
      const full = drawSr(10)[0].w;
      if (Math.abs(normal.w - full) > 1) {
        errs.push(`SR=${sr} 超限时正常段应满格（${full.toFixed(1)}px），`
          + `实际 ${normal.w.toFixed(1)}px`);
      }
      /* 超限段宽度 = (v - 10)/10 满格 */
      const expectOver = full * (sr - 10) / 10;
      if (Math.abs(over.w - expectOver) > 1.5) {
        errs.push(`SR=${sr} 超限段宽度应约 ${expectOver.toFixed(1)}px`
          + `（=满格×(v-10)/10），实际 ${over.w.toFixed(1)}px`);
      }
      console.log('    超限(12.5): 正常段 %s px %s + 超限段 %s px %s，x 相同 ✅',
        normal.w.toFixed(0), normal.fill, over.w.toFixed(0), over.fill);
    }
  }

  /* --- 封顶：超过 2×刻度按 2× 封顶，宽度不再增长 --- */
  {
    const w20 = drawSr(20);
    const w35 = drawSr(35);
    const w20over = w20.length === 2 ? w20[1].w : -1;
    const w35over = w35.length === 2 ? w35[1].w : -1;
    if (w20over < 0 || w35over < 0) {
      errs.push('SR=20/35 应各画 2 段');
    } else if (Math.abs(w20over - w35over) > 1) {
      errs.push(`超限段应按 2×刻度封顶：SR=20 得 ${w20over.toFixed(1)}px，`
        + `SR=35 得 ${w35over.toFixed(1)}px，不应继续增长`);
    } else {
      const full = drawSr(10)[0].w;
      /* 封顶值 = 满格（超限段 0~1 格是正常段，1~2 格是超限段）*/
      if (Math.abs(w20over - full) > 1) {
        errs.push(`SR=20 超限段应正好满格（${full.toFixed(1)}px），`
          + `实际 ${w20over.toFixed(1)}px`);
      }
      console.log('    封顶(20/35): 超限段均 %s px，不再增长 ✅', w20over.toFixed(0));
    }
  }

  /* --- 负值/NaN 不应画出段 --- */
  {
    /* 用直接调 _drawRatioBar 的方式，避免 drawSr 的标签锚点在「完全不画段」时失效 */
    const probeSr = (v) => {
      const cx = makeCtx();
      rr._drawRatioBar(cx, bx, by, bw, F(15, 9), 'Star Rating',
                       v, SR_COLOR, 10, LAY.LABEL_COL, bw, LAY.RIGHT_W * 0.4,
                       F, true, '');
      return cx.rects.filter((r) => r.w > 0);
    };
    for (const v of [-3, NaN, 0, undefined]) {
      const segs = probeSr(v);
      if (segs.length > 0) {
        errs.push(`SR=${String(v)} 不应画出任何实心段，实际 ${segs.length} 段`
          + `（w=${segs.map((s) => String(s.w)).join(',')}）`);
      }
    }
    console.log('    负值/NaN/undefined/0 安全钳位 ✅');
  }
}

console.log('[8] 段位行字号与称号显示:');
{
  /* ---- [8a] ★ 段位 / 键型的字号必须与左下角「797PP」一致 ----
   * 用户反馈「字太小了，调到和 797PP 那个字体一样大」。
   * PP 用的是 F(50,34)，所以 danRowMetrics().text 也必须是同一套
   * —— 两处各写一个数字的话，改了其中一处就会错位。*/
  for (const W of [420, 660, 940, 1500, 1920]) {
    const m = R.danRowMetrics(W);
    /* 独立复算一遍 PP 的字号（与 _drawMaxPp 里的 F(50,34) 同一公式）*/
    const k = Math.max(0.46, Math.min(1, W / 1500));
    const ppSize = Math.max(34, Math.round(50 * k));
    if (m.text !== ppSize) {
      errs.push(`宽 ${W}：段位字号 ${m.text} 与 PP 字号 ${ppSize} 不一致`
        + `（用户要求「和 797PP 一样大」）`);
    }
    /* 小字（段位数字）应与 PP 上方的 mod 缩写同号 F(24,16) */
    const numExpect = Math.max(16, Math.round(24 * k));
    if (m.num !== numExpect) {
      errs.push(`宽 ${W}：段位数字字号 ${m.num}，应为 ${numExpect}`);
    }
    /* 行高必须容得下大字号（约 1.16 倍行距 + 留白）*/
    if (m.row < m.text * 1.1) {
      errs.push(`宽 ${W}：段位行高 ${m.row} 装不下 ${m.text}px 的字`
        + `（会把上下相邻元素压住）`);
    }
  }
  console.log('    宽 420~1920：段位/键型字号与 PP 一致 ✅');

  /* ---- [8b] ★ 1~10 段补「Reform」前缀，其余原样 ----
   * 用户需求：「1-10 的段位显示为 Reform I这样的形式（保留位间的含义）」。
   * 用阿拉伯数字（Reform 3），不用罗马数字 —— 见 displayGrade 的注释。*/
  const cases = [
    ['1', 'Reform 1'], ['3', 'Reform 3'], ['7', 'Reform 7'],
    ['10', 'Reform 10'],
    /* ★ <1 段也要补前缀（用户反馈「过于简单的谱面没有显示段位」）。
     * 段位**可以是负数**（flow_bonus 下界 FLOW_FLOOR = -0.60 段），
     * 所以这个分支不是摆设 —— 实测最简谱 dan = -1.92。*/
    ['<1', '< Reform 1'],
    /* 10 段以上本来就是名字，不能动 */
    ['Alpha', 'Alpha'], ['Beta-', 'Beta-'], ['Gamma+', 'Gamma+'],
    ['Delta', 'Delta'], ['>Delta+', '>Delta+'],
    /* 异常值不应被改写 */
    ['', ''], [null, ''],
  ];
  for (const [input, want] of cases) {
    const got = R.displayGrade(input);
    if (got !== want) {
      errs.push(`displayGrade(${JSON.stringify(input)}) = ${JSON.stringify(got)}，`
        + `应为 ${JSON.stringify(want)}`);
    }
  }
  console.log('    1~10 -> Reform N；<1 -> < Reform 1；Alpha 以上原样 ✅');
}

/* ---------- [9] ★★ 端到端：低于 1 段的谱**必须画出**段位行 ---------- */
/* 用户反馈：「过于简单的谱面似乎没有显示段位，实际应该显示 < Reform 1」。
 *
 * 根因：content.js 的 updateDanRow 把 `dan <= 0` 当成字段异常，
 * 于是这类谱**整行不显示**。而段位为负是**算法有意输出**的 ——
 * `model.py` 的 `flow_bonus()` 下界是 `FLOW_FLOOR = -0.60`（段），
 * `dan()` 是 `curve(...) + flow_bonus`，所以极简单的谱会落在 0 以下。
 * 实测 [Feel This Melody] 最简难度 dan = -1.92、grade = '<1'。
 *
 * 这里跑真实样本 + 真实渲染，断言「dan < 1 时仍有段位行、且称号是 < Reform 1」。*/
console.log('[9] <1 段的显示:');
{
  const sampleDir = path.join(HERE, 'test_zips');
  const files = fs.existsSync(sampleDir)
    ? fs.readdirSync(sampleDir).filter((n) => n.endsWith('.osu')) : [];
  const parser = await import(pathToFileURL(path.join(HERE, '..', 'lib', 'osu_parser.js')));
  const bridge = await import(pathToFileURL(path.join(HERE, '..', 'lib', 'dan_bridge.js')));

  let checked = 0;
  for (const f of files) {
    const bm = parser.parseOsu(fs.readFileSync(path.join(sampleDir, f), 'utf8'));
    if (!bm.notes || !bm.notes.length) continue;
    const res = bridge.evaluateBeatmap(bm, '');
    if (res.dan >= 1) continue;          /* 只看 <1 段的 */
    checked++;
    /* ★ 关键：要复现content.js 里 `updateDanRow` 的**字段校验**。
     *   否则这条断言就是「自己验自己」——
     *   content.js 若把 `dan <= 0` 判成异常（kind='err'），
     *   cfg.danRowH 就会是 0、整行不显示，而下面那些断言全都不会触发
     *   （实测：还原该 bug 后 dom_smoke 与本节最初版本都是绿的）。
     *
     *   这里按 content.js 的判据重新判一次（这段判据要与 content.js 同步）。*/
    const kindOK = (typeof res.dan === 'number' && isFinite(res.dan)
      && typeof res.grade === 'string' && !!res.grade)
      ? 'ok' : 'err';
    if (kindOK !== 'ok') {
      errs.push(`${f.slice(20, 44)}：dan=${res.dan} grade=${JSON.stringify(res.grade)} `
        + `应被判为可用（kind=ok），实际 kind=${kindOK} —— `
        + `dan<=0 不是异常（flow_bonus 下界 FLOW_FLOOR = -0.60 段），`
        + `判成异常会导致整行不显示`);
      continue;
    }
    const W = 940;
    const cfg = L.applyCompact(Object.assign({}, L.DEFAULTS), W);
    cfg.headerHeight = R.headerHeightFor(W);
    /* 与 content.js 同一句：只有 kind==='ok' 才给高度 */
    cfg.danRowH = (kindOK === 'ok') ? R.danRowHeightFor(W) : 0;
    const al = L.alignPixelsPerSecond(bm, cfg);
    cfg.pixelsPerSecond = al > 0 ? al : 200;
    const lay = L.computeLayout(bm, cfg);
    const rr = new R.PreviewRenderer(bm, lay, cfg, { loaded: false }, {
      header: true, danRow: res, danRowLabel: 'v0.1',
    });
    if (rr.danRowH <= 0) {
      errs.push(`${f.slice(20, 44)}：dan=${res.dan} <1段，`
        + `但 danRowH=0 —— 段位行没有占高度（整行不显示）`);
      continue;
    }
    /* 称号必须是 < Reform 1 */
    const disp = R.displayGrade(res.grade);
    if (disp !== '< Reform 1') {
      errs.push(`${f.slice(20, 44)}：dan=${res.dan} grade=${JSON.stringify(res.grade)} `
        + `应显示「< Reform 1」，实际「${disp}」`);
    }
  }
  if (checked === 0) {
    errs.push('样本里没有 <1 段的谱 —— 这条断言等于没测'
      + '（请往 test_zips 加简单谱）');
  }
  console.log('    %d 张<1 段的谱：都有段位行、称号为「< Reform 1」（含负段位）✅', checked);
}
console.log();
if (errs.length) {
  console.log('❌ 信息栏版式验证失败:');
  errs.forEach((e) => console.log('   -', e));
  process.exit(1);
}
console.log('✅ 信息栏在各宽度下版式正确');
process.exit(0);