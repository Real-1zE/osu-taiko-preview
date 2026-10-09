/**
 * 页面世界（MAIN world）里的路由监听桩。
 *
 * ## 为什么必须有这个文件
 *
 * Chrome 的 content script 跑在**隔离世界**（isolated world）：
 * 它有自己的 JS 运行时和 `window` 对象，与页面**共享 DOM 但不共享 JS**。
 * 所以在 content.js 里写
 *
 *     history.pushState = function () { ... }
 *
 * 改的是 **content script 自己那个** history，页面里的
 * vue-router / Nuxt 调用的仍然是**页面那个** history ——
 * 补丁完全不起作用。我在 content.js 的测试里看不出这一点，
 * 因为 Node 桩里content script 和「页面」是同一个 `globalThis`。
 *
 * 能穿过隔离边界的只有 **DOM**：事件、元素、属性。
 * 于是正确做法是：把下面这段用`<script>` 标签注入到**页面世界**，
 * 让它自己劫持 history，然后用 `CustomEvent` 把通知送回来
 * （DOM 事件可以跨世界传播）。
 *
 * ## 用法
 *
 *   1. content.js 往 document.documentElement 插一个 <script src=chrome.runtime.getURL(...)>
 *   2. 本文件在页面世界执行，劫持 pushState/replaceState/popstate/hashchange
 *   3. 每次路由变化派发 `osu-taiko:routechange` 事件（带 newURL）
 *   4. content.js 监听该事件 -> routeChanged()
 *
 * 注入的 <script> 用完即删，不留在 DOM 里。
 */

(function () {
  if (window.__osuTaikoRouteHooked) return;
  window.__osuTaikoRouteHooked = true;

  var EVENT = 'osu-taiko:routechange';

  function notify(reason) {
    /* 用 CustomEvent 而不是普通 Event：要带 detail（newURL）。
       事件挂在 document 上 —— DOM 事件可以跨隔离世界传播，
       content.js 那边 addEventListener 能收到。*/
    var detail = { url: location.href, reason: reason };
    var ev;
    try {
      ev = new CustomEvent(EVENT, { detail: detail });
    } catch (e) {
      /* 老浏览器没有 CustomEvent 构造器，退回 createEvent */
      ev = document.createEvent('CustomEvent');
      ev.initCustomEvent(EVENT, false, false, detail);
    }
    document.dispatchEvent(ev);
  }

  /* ---- 劫持 pushState / replaceState ---- */
  ['pushState', 'replaceState'].forEach(function (name) {
    var orig = history[name];
    if (typeof orig !== 'function') return;
    history[name] = function () {
      var ret = orig.apply(this, arguments);
      /* 用 setTimeout(0) 让 URL 先落定，再通知。
         pushState 是同步改location 的，但 Nuxt 可能在之后
         又replaceState 一次（补查询参数），延一帧更稳。*/
      setTimeout(function () { notify(name); }, 0);
      return ret;
    };
  });

  /* ---- popstate：浏览器前进/后退 ---- */
  window.addEventListener('popstate', function () { notify('popstate'); });

  /* ---- hashchange：#osu/1234 形式的难度切换 ----
     注意 pushState 改 hash **不会**触发 hashchange（HTML 规范如此），
     所以上面那个劫持仍然必要；这里覆盖的是用户手动改 hash 的情况。*/
  window.addEventListener('hashchange', function () { notify('hashchange'); });

  /* ---- 兜底：URL 没变但 DOM 大改（SPA 内部重渲染）——
     用 MutationObserver 盯着 documentElement，节流后派发。
     有些路由实现（rare）会绕过 history API 直接改 location，
     那样上面三个都收不到。*/
  var pending = 0;
  try {
    var mo = new MutationObserver(function () {
      if (pending) return;
      pending = setTimeout(function () {
        pending = 0;
        notify('dom');
      }, 300);
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) { /* 忽略 */ }
})();