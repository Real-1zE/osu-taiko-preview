/**
 * 模块桥接：把 ES module 的导出挂到 window 上，供 content.js 使用。
 *
 * 为什么需要：content script 不是 ES module（manifest 里是普通 script 标签），
 * 直接 import/export 会报错。所以这里用 dynamic import 在运行时加载，
 * 再把导出对象挂到 window.OSU_TAIKO_*。
 *
 * 用 chrome.runtime.getURL 拿扩展内文件地址（需web_accessible_resources）。
 *
 * 模块清单：
 *   OSU_TAIKO_PARSE    .osu 解析（原有）
 *   OSU_TAIKO_LAYOUT   布局（原有）
 *   OSU_TAIKO_RENDERER  渲染（原有）
 *   OSU_TAIKO_DIFF     Star Rating 计算（新增）
 *   OSU_TAIKO_PP       PP 计算（新增）
 *   OSU_TAIKO_PANEL    难度信息面板的格式化层（新增）
 *   OSU_TAIKO_DAN      段位 / 键型评估（新增）
 *
 * ★ 段位模块是**两级**结构，和上面几级的单文件不同：
 *   OSU_TAIKO_DAN_RANK   —— 纯算法（dan_rank.js 的移植版）
 *   OSU_TAIKO_DAN        —— 适配层（dan_bridge.js，负责把插件的 beatmap
 *                          转成算法要的输入，并保证 SV/拍长语义与 Python 一致）
 *   content.js 只用 OSU_TAIKO_DAN，不要直接碰算法层 ——
 *   适配层的那套语义对齐是段位数值正确的前提。
 */
(async function () {
  'use strict';

  function url(path) {
    return chrome.runtime.getURL(path);
  }

  try {
    const [parser, layout, renderer, difficulty, pp, panel,
      danRank, danBridge] = await Promise.all([
      import(url('lib/osu_parser.js')),
      import(url('lib/layout.js')),
      import(url('lib/renderer.js')),
      import(url('lib/difficulty.js')),
      import(url('lib/pp.js')),
      import(url('lib/sr_panel.js')),
      import(url('lib/dan_rank.js')),
      import(url('lib/dan_bridge.js')),
    ]);

    window.OSU_TAIKO_PARSE = parser;
    window.OSU_TAIKO_LAYOUT = layout;
    window.OSU_TAIKO_RENDERER = renderer;
    window.OSU_TAIKO_DIFF = difficulty;
    window.OSU_TAIKO_PP = pp;
    window.OSU_TAIKO_PANEL = panel;
    window.OSU_TAIKO_DAN_RANK = danRank;
    window.OSU_TAIKO_DAN = danBridge;

    window.OSU_TAIKO_READY = true;
    document.dispatchEvent(new CustomEvent('osu-taiko-modules-ready'));
  } catch (e) {
    window.OSU_TAIKO_READY = false;
    window.OSU_TAIKO_ERROR = e && e.message ? e.message : String(e);
    document.dispatchEvent(new CustomEvent('osu-taiko-modules-ready'));
    console.error('[osu-taiko-preview] 模块加载失败', e);
  }
})();