/**
 * popup.js 的显示逻辑验证。
 *
 * 为什么单独写这个测试：popup 曾经**自己写了一遍 URL 正则**去判断
 * 「是不是谱面页」，与 content.js 的 onMapPage() 是两套判据。
 * 两处必然对不上，用户看到的就是「已加载：Trillium + SR 7.60★」
 * 与「非谱面页」并存的自相矛盾状态，还以为按钮坏了。
 *
 * 现在 popup 只负责显示，页面类型由 content.js 在 status 回执里回答。
 * 但**字段缺失**（页面跑的是旧版 content script）必须与
 * 「明确不是谱面页」区分开 —— 这是本测试的主要目标。
 *
 * 纯 Node，不需要浏览器。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const popupSrc = fs.readFileSync(path.join(HERE, '..', 'popup.js'), 'utf8');

/* ---------- 断言收集 ---------- */
const ok = [];
const errs = [];
const check = (cond, msg) => { if (cond) ok.push(msg); else errs.push(msg); };

/* ===================================================================== *
 * 把 popup.js 的「渲染决策」抽出来单独测
 *
 * 不直接跑 popup.js（它依赖 chrome.* 与 DOM），而是把
 * refreshStatus 里那段纯逻辑复刻成函数 —— 但**必须逐行对照 popup.js**，
 * 所以下面用正则从真实源码里抠出关键表达式做一致性校验。
 * ===================================================================== */

/**
 * popup 的显示决策（与 popup.js 中的实现保持一致）。
 * @param {object|null} resp content.js 的 status 回执
 * @returns {{page:string, btn:string, disabled:boolean, stale:boolean}}
 */
function popupView(resp) {
  const injected = !!(resp && !resp.error);
  const knowsMap = typeof resp.onMapPage === 'boolean';
  const onMap = knowsMap ? resp.onMapPage : !!resp.beatmapId;
  const stale = injected && typeof resp.proto !== 'number';

  let page;
  if (!injected) page = '未注入（请刷新页面）';
  else if (stale) page = onMap ? '谱面页（页面未刷新）' : '请刷新页面';
  else page = onMap ? '谱面页' : '非谱面页（不显示窗口）';

  let btn, disabled;
  if (!injected) { btn = '未注入插件脚本'; disabled = true; }
  else if (!onMap) { btn = '非谱面页，无法显示'; disabled = true; }
  else { btn = resp.visible ? '隐藏窗口' : '显示窗口'; disabled = false; }

  return { page, btn, disabled, stale };
}

/* ---------- 与真实 popup.js 的一致性 ---------- */
/* popup.js 里必须用 typeof 判断，不能写 `resp.onMapPage ?` 这种裸真值判断 ——
   后者会把 undefined 当成 false，正是用户截图里的 bug。*/
check(/typeof\s+resp\.onMapPage\s*===\s*'boolean'/.test(popupSrc),
  'popup.js 必须用 typeof 严格判断 onMapPage（不能裸用真值）');
check(/typeof\s+resp\.proto\s*!==\s*'number'/.test(popupSrc),
  'popup.js 必须用 proto 判断 content script 是否为旧版');
check(!/isMap\s*=\s*\/osu/.test(popupSrc),
  'popup.js 不应再自己写 URL 正则判断谱面页（已改为问 content.js）');

/* ===================================================================== *
 * 三种回执的显示结果
 * ===================================================================== */

console.log('[1] status 回执 -> popup 显示:');

/* (a) 新版 content script，在谱面页，窗口可见 */
{
  const r = popupView({
    proto: 2, onMapPage: true, visible: true, userClosed: false,
    beatmapId: '5891109', title: 'Trillium',
    sr: 7.6, srBase: 5.45, modLabel: '+DT,CL', maxPp: 7509,
  });
  console.log('    新版 + 谱面页 + 可见: page=%s | btn=%s | disabled=%s',
    r.page, r.btn, r.disabled);
  check(r.page === '谱面页', `(a) 应显示「谱面页」，实际「${r.page}」`);
  check(r.btn === '隐藏窗口', `(a) 窗口可见时按钮应为「隐藏窗口」，实际「${r.btn}」`);
  check(r.disabled === false, '(a) 谱面页时按钮不应禁用');
  check(r.stale === false, '(a) proto 存在 -> 不算旧版');
}

/* (b) ★ 旧版 content script（页面没刷新）—— 用户截图里的真实状态 */
{
  const r = popupView({
    /* 没有 proto、没有 onMapPage，但 beatmapId/sr 都在 */
    visible: true, beatmapId: '5891109', title: 'Trillium',
    sr: 7.6, srBase: 5.45, modLabel: '+DT,CL', maxPp: 7509,
  });
  console.log('    旧版 + 谱面页 + 可见: page=%s | btn=%s | disabled=%s',
    r.page, r.btn, r.disabled);
  check(r.page.indexOf('非谱面页') < 0,
    `(b) 旧版回执不该显示「非谱面页」，实际「${r.page}」—— `
    + '这就是用户截图里的矛盾状态');
  check(r.page.indexOf('未刷新') >= 0,
    `(b) 应提示页面未刷新，实际「${r.page}」`);
  check(r.disabled === false,
    '(b) 旧版 content script 的 toggle 功能是好的，'
    + '禁用按钮会把用户锁死在「点不动」的状态');
  check(r.btn === '隐藏窗口', `(b) 应仍能操作，实际「${r.btn}」`);
  check(r.stale === true, '(b) 缺 proto -> 应识别为旧版');
}

/* (c) 真的不是谱面页 */
{
  const r = popupView({ proto: 2, onMapPage: false, visible: false, beatmapId: null });
  console.log('    新版 + 非谱面页:page=' + r.page + ' | btn=' + r.btn
    + ' | disabled=' + r.disabled);
  check(r.page === '非谱面页（不显示窗口）', `(c) 应显示「非谱面页」，实际「${r.page}」`);
  check(r.disabled === true, '(c) 非谱面页时按钮应禁用');
}

/* (d) 完全没注入 */
{
  const r = popupView({ error: '当前页面未注入插件脚本' });
  console.log('    未注入:            page=' + r.page + ' | btn=' + r.btn
    + ' | disabled=' + r.disabled);
  check(r.page === '未注入（请刷新页面）', `(d) 应显示「未注入」，实际「${r.page}」`);
  check(r.disabled === true, '(d) 未注入时按钮应禁用');
}

/* (e) 旧版 + 确实没有 bid（真非谱面页）—— 不能误判成谱面页 */
{
  const r = popupView({ visible: false });
  check(r.page === '请刷新页面',
  `(e) 旧版且无 bid 应提示刷新，实际「${r.page}」`);
  check(r.disabled === true, '(e) 旧版且无 bid 时按钮应禁用（确实不能显示）');
}

/* ===================================================================== *
 * URL 提取：域名不能写死
 *
 * manifest 的 matches 覆盖 osu.ppy.sh / osu.ppy.sb / osu.ri.mk，
 * 而原来的 extractBeatmapId 把 `osu\.ppy\.sh` 硬编码进正则 ——
 * 镜像站的 /b/1234 会被判成「不是谱面页」，窗口根本不显示。
 * ===================================================================== */

console.log('\n[2] extractBeatmapId 覆盖各种 URL 形态:');

/* 直接跑真实的 content.js 里的那份实现（用 vm 抽出来） */
const extractSrc = (() => {
  const m = popupSrc; // 只是个占位，真正的是 content.js
  void m;
  const src = fs.readFileSync(path.join(HERE, '..', 'content.js'), 'utf8');
  const i = src.indexOf('function extractBeatmapId()');
  if (i < 0) return null;
  /* 从函数声明开始，按花括号配平取完整函数体 */
  let depth = 0, started = false, end = i;
  for (let j = src.indexOf('{', i); j < src.length; j++) {
    if (src[j] === '{') { depth++; started = true; }
    else if (src[j] === '}') {
      depth--;
      if (started && depth === 0) { end = j + 1; break; }
    }
  }
  return src.slice(i, end);
})();
check(!!extractSrc, '应能在 content.js 里找到 extractBeatmapId');
/* eslint-disable no-new-func */
const extract = extractSrc
  ? new Function('window', 'URLSearchParams', extractSrc + '; return extractBeatmapId();')
  : null;

const CASES = [
  /* [url,期望 bid 或 null, 说明] */
  ['https://osu.ppy.sh/b/1234', '1234', '短链接 /b/'],
  ['https://osu.ppy.sb/b/1234', '1234', '★镜像站短链接（原来会失效）'],
  ['https://osu.ri.mk/b/1234', '1234', '★镜像站短链接（原来会失效）'],
  ['https://osu.ppy.sh/beatmaps/1234', '1234', '长链接 /beatmaps/'],
  ['https://osu.ppy.sh/beatmapsets/2623435#taiko/5891109', '5891109', 'hash 带 taiko 前缀'],
  ['https://osu.ppy.sh/beatmapsets/2623435#osu/5891109', '5891109', 'hash 带 osu 前缀'],
  ['https://osu.ppy.sh/beatmapsets/1?beatmap=555', '555', 'query里的难度'],
  ['https://osu.ppy.sh/beatmap', null, '商店页-> 不是谱面页'],
  ['https://osu.ppy.sh/home', null, '首页 -> 不是谱面页'],
  ['https://osu.ppy.sh/beatmapsets/2623435', null, '只有 setId 没难度 -> 不是谱面页'],
];

for (const [url, want, why] of CASES) {
  const u = new URL(url);
  /* 模拟 window.location */
  const win = { location: { href: u.href, hash: u.hash, search: u.search } };
  const got = extract(win, URLSearchParams);
  const good = got === want;
  console.log('    ' + url.replace('https://', '').padEnd(50)
    + ' -> ' + String(got).padEnd(9) + (good ? '✅' : `❌ 应为 ${want}`));
  check(good, `extractBeatmapId("${url}") = ${got}，应为 ${want}（${why}）`);
}

console.log();
console.log(`通过断言 ${ok.length} 条`);
if (errs.length) {
  console.log('❌ popup 验证失败:');
  errs.forEach((e) => console.log('   -', e));
  process.exit(1);
}
console.log('✅ popup.js 显示逻辑验证通过');
process.exit(0);