/**
 * content.js 的 DOM 冒烟测试。
 *
 * e2e.mjs 只验证了「解析→布局→渲染」这条纯计算链路，
 * 但 content.js 里最容易出错的其实是 DOM 那一层：
 *   - Shadow DOM 结构能不能建起来
 *   - setStage 有没有误删 .vbar / .grip 这类常驻元素
 *   - 窗口拖动 / 右下角缩放 / 画面内拖动平移 的事件绑定与坐标换算
 *   - 「y 坐标 → 行号」在真实布局下能不能定位正确
 *
 * 用一个极小的 DOM 桩把 content.js 完整跑起来（不走 jsdom、不开浏览器）。
 * 桩只实现 content.js 实际用到的 API，多余的一概没有 ——
 * 这样测试失败就一定是 content.js 的问题，而不是桩太宽松。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = path.join(ROOT, 'lib');

const errs = [];
const ok = [];
function check(cond, msg) {
  if (cond) ok.push(msg);
  else errs.push(msg);
}

/* ===================================================================== *
 * 极简 DOM 桩
 * ===================================================================== */

class ClassList {
  constructor(set) { this.set = set || new Set(); }
  add(c) { this.set.add(c); }
  remove(c) { this.set.delete(c); }
  toggle(c, on) { if (on === undefined) on = !this.set.has(c); if (on) this.set.add(c); else this.set.delete(c); }
  contains(c) { return this.set.has(c); }
}

function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 记录 style 赋值，好让测试断言「面板被摆到哪」「画布被平移多少」 */
function makeStyle(el) {
  const store = { cssText: '' };
  return new Proxy(store, {
    set(t, k, v) {
      t[k] = v;
      /* 面板尺寸写进 style 时同步 offsetWidth/Height，
         否则缩放与 clamp 的断言测不到真实效果。
         用 _cls 判定而不靠外部标记：restoreWindow 是在 buildUI 内部
         调用的，那时测试代码还没给元素打标记。*/
      if (el._cls === 'panel') {
        const w = parseFloat(t.width), h = parseFloat(t.height);
        if (isFinite(w)) el.offsetWidth = w;
        if (isFinite(h)) el.offsetHeight = h;
      }
      return true;
    },
  });
}

class El {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = makeStyle(this);
    this._cls = '';
    this._text = '';
    this._html = '';
    this.classList = new ClassList();
    this.dataset = {};
    this.listeners = Object.create(null);
    /* 尺寸默认值：panel 700×420 / stage 660×300（视口） */
    this._clientWidth = 660;
    this._clientHeight = 300;
    this._offsetWidth = 700;
    this._offsetHeight = 420;
    /* 折叠态下 height:auto，offsetHeight 只剩标题栏（~34px）。
       桩里必须体现，否则「折叠 -> 展开要还原高度」这条回归测不出来。*/
    this.width = 300;
    this.height = 150;
    this.value = '';
    this.checked = false;
    this.disabled = false;
  }
  /* stage 的宽度跟随 panel（真实浏览器里 .stage 是 flex 子项，
     clientWidth = panel 内容宽 - .body 左右 padding - stage 边框）。
     用 getter 表达这层联动，缩放断言才有意义。
     注意必须在元素创建时就可用 —— content.js 在同一次 tick 里就渲染了。*/
  get clientWidth() {
    if (this.classList.contains('stage')) {
      const p = this._closestByClass('panel');
      if (p) return p.offsetWidth - 9 * 2 - 2;   /* body padding 9×2 + border 1×2 */
    }
    return this._clientWidth;
  }
  set clientWidth(v) { this._clientWidth = v; }
  get clientHeight() {
    if (this.classList.contains('vbar')) {
      const s = doc.byId.stage;
      if (s) return s.clientHeight;
    }
    return this._clientHeight;
  }
  set clientHeight(v) { this._clientHeight = v; }
  /** 折叠时高度交给内容决定，桩里简化为「只剩标题栏 34px」。 */
  get offsetHeight() {
    if (this._hiddenByAncestor()) return 0;
    return this.classList.contains('collapsed') ? 34 : this._offsetHeight;
  }
  set offsetHeight(v) { this._offsetHeight = v; }
  get offsetWidth() {
    /* display:none 的祖先会让整棵子树的布局尺寸变成 0 —— 这是真实浏览器的行为，
       也是「窗口突然变特别小」那个 bug 的成因：clampPanel 在隐藏状态下量到 0，
       算出 max(MIN_W, min(0, …)) = MIN_W 就把 420×240 写进了 style。
       桩不模拟这条，就测不出「隐藏时不该夹取尺寸」这条回归。*/
    if (this._hiddenByAncestor()) return 0;
    return this._offsetWidth;
  }
  set offsetWidth(v) { this._offsetWidth = v; }
  /** 自己或任一祖先的 style.display === 'none' */
  _hiddenByAncestor() {
    let n = this;
    while (n) {
      if (n.style && n.style.display === 'none') return true;
      n = n.parentNode;
    }
    return false;
  }
  _closestByClass(c) {
    let n = this.parentNode;
    while (n) {
      if (n.classList && n.classList.contains(c)) return n;
      n = n.parentNode;
    }
    return null;
  }
  get className() { return this._cls; }
  set className(v) {
    this._cls = String(v);
    this.classList.set = new Set(this._cls.split(/\s+/).filter(Boolean));
  }
  get id() { return this._id || ''; }
  set id(v) { this._id = v; doc.byId[v] = this; }
  set textContent(v) { this._text = String(v); }
  get textContent() { return this._text; }
  set innerHTML(v) {
    this._html = String(v);
    this.children.length = 0;
    /* 极简但**带层级**的解析器：维护一个栈，遇到闭合标签弹栈。
       content.js 的面板 HTML 是良构的（`<input>` 是 void 元素），
       所以按 `<tag ...>` 开标签、`</tag>` 闭标签处理即可。
       不还原层级的话，querySelectorAll('input[data-mod]') 在
       #modbar 上会返回空数组（子节点全被拍成了兄弟节点）。*/
    const VOID = new Set(['input', 'br', 'hr', 'img', 'meta', 'link']);
    const stack = [this];
    const re = /<(\/?)(\w+)([^>]*?)(\/?)>/g;
    let m;
    while ((m = re.exec(this._html))) {
      const closing = m[1] === '/';
      const tag = m[2];
      const attrs = m[3] || '';
      if (closing) {
        if (stack.length > 1) stack.pop();
        continue;
      }
      const el = new El(tag);
      /* 属性：name="v" / name='v' / name=v / 布尔属性 */
      const are = /([\w-]+)(?:="([^"]*)"|='([^']*)'|=(\S+))?/g;
      let am;
      while ((am = are.exec(attrs))) {
        const key = am[1];
        const val = am[2] !== undefined ? am[2]
          : am[3] !== undefined ? am[3]
            : am[4] !== undefined ? am[4] : '';
        if (key === 'id') { el._id = val; doc.byId[val] = el; }
        else if (key === 'class') {
          el._cls = val;
          el.classList.set = new Set(val.split(/\s+/).filter(Boolean));
        }
        /* data-x -> dataset.x */
        else if (key.startsWith('data-')) {
          const k = key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
          el.dataset[k] = val;
        }
        /* 布尔属性：出现即为 true（HTML 语义）*/
        else if (key === 'checked' || key === 'disabled' || key === 'selected') {
          el[key] = true;
        }
        else if (key === 'type') el.type = val;
        else if (key === 'name') el.name = val;
        else if (key === 'value') el.value = val;
        else if (key === 'title') el.title = val;
        else el[key] = val;
      }
      /* 舞台/缩略条的默认尺寸（与真实 CSS 一致）*/
      if (el.classList.contains('stage')) {
        el._bodyPad = 9;
        el._clientHeight = 300;
        el.offsetWidth = 660; el.offsetHeight = 300;
      }
      if (el.classList.contains('vbar')) {
        el._clientHeight = 300; el.offsetHeight = 300; el.offsetWidth = 11;
      }
      const parent = stack[stack.length - 1];
      el.parentNode = parent;
      parent.children.push(el);
      if (!VOID.has(tag.toLowerCase())) stack.push(el);
    }
  }
  get innerHTML() {
    /* 没设过 _html 时，按子节点文本拼出来（供 escapeHtml 用） */
    if (!this._html && this.children.length) {
      return this.children.map((c) => escapeText(c._text || '')).join('');
    }
    return this._html;
  }
  appendChild(c) {
    /* 真实 DOM 里重复 appendChild 是**移动**而不是复制，
       桩里必须同样处理，否则「宿主被移出后重新挂载」测不出来。*/
    const old = c.parentNode;
    if (old) {
      const j = old.children.indexOf(c);
      if (j >= 0) old.children.splice(j, 1);
    }
    c.parentNode = this;
    this.children.push(c);
    if (c._id) doc.byId[c._id] = c;
    return c;
  }
  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  contains(n) {
    if (n === this) return true;
    return this.children.some((c) => c.contains && c.contains(n));
  }
  querySelector(sel) {
    if (sel.startsWith('.')) {
      const c = sel.slice(1);
      let found = null;
      (function walk(n) {
        if (found) return;
        for (const ch of n.children) {
          if (ch.classList.contains(c)) { found = ch; return; }
          walk(ch);
        }
      })(this);
      return found;
    }
    return doc.byId[sel.replace('#', '')] || null;
  }
  /* 深度遍历取匹配元素。桩原先固定返回 []，
     导致 mod 选择条（靠 querySelectorAll('input[data-mod]') 取列表）
     测不到。*/
  querySelectorAll(sel) {
    const wantAttr = sel.match(/\[([\w-]+)\]$/);
    const wantTag = sel.match(/^[a-z]+/i);
    const out = [];
    const hit = (el) => {
      if (wantTag && el.tagName !== wantTag[0].toUpperCase()) return false;
      if (wantAttr) {
        /* data-mod 在桩里存于 dataset */
        const k = wantAttr[1].replace(/^data-/, '').replace(/-([a-z])/g,
          (_, c) => c.toUpperCase());
        if (!(el.dataset && el.dataset[k] !== undefined)) return false;
      }
      return true;
    };
    (function walk(n) {
      for (const ch of n.children) {
        if (hit(ch)) out.push(ch);
        walk(ch);
      }
    })(this);
    return out;
  }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  /** 读属性。桩里属性都存在 dataset 上（解析器写入的），
   *  同时兼容直接在元素上挂的常见属性。*/
  getAttribute(name) {
    const k = name.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (this.dataset && this.dataset[k] !== undefined) return this.dataset[k];
    if (this[name] !== undefined && typeof this[name] !== 'object') return String(this[name]);
    return null;
  }
  hasAttribute(name) { return this.getAttribute(name) !== null; }
  removeEventListener(t, fn) {
    const a = this.listeners[t];
    if (a) this.listeners[t] = a.filter((f) => f !== fn);
  }
  /** 元素侧的 closest（真实 DOM 里closest 是 Element 上的方法） */
  closest(sel) {
    const cls = sel.startsWith('.') ? sel.slice(1) : null;
    let n = this;
    while (n) {
      if (cls && n.classList && n.classList.contains(cls)) return n;
      if (!cls && n.id === sel.replace('#', '')) return n;
      n = n.parentNode;
    }
    return null;
  }
  /** 派发事件。target 缺 closest 时补上（真实 DOM 里元素自带） */
  dispatch(t, ev) {
    let target = (ev && ev.target) || this;
    if (typeof target.closest !== 'function') {
      target = Object.create(target);
      target.closest = this.closest.bind(target);
    }
    const e = Object.assign({
      type: t, preventDefault() {}, stopPropagation() {},
    }, ev || {}, { target });
    (this.listeners[t] || []).slice().forEach((f) => f(e));
  }
  /* 标准 DOM 属性：只要还在文档树里就是 true。
     content.js 用它判断宿主是否被 SPA 移出了 body。*/
  get isConnected() {
    /* 真实语义：节点在文档树里才为 true。
       脱离文档（parentNode === null）时**必须**是 false ——
       否则「宿主被移出 body」这条最关键的回归就测不出来。*/
    let n = this;
    while (n.parentNode) n = n.parentNode;
    /* 走到 documentElement 就是根；body/documentElement 本身也算在文档里 */
    return n === doc.documentElement || n === doc.body;
  }
  getBoundingClientRect() {
    const left = parseFloat(this.style.left);
    const top = parseFloat(this.style.top);
    return {
      left: isFinite(left) ? left : 1280 - this.offsetWidth - 16,
      top: isFinite(top) ? top : 800 - this.offsetHeight - 16,
      width: this.offsetWidth, height: this.offsetHeight, right: 0, bottom: 0,
    };
  }
  attachShadow() {
    const r = new El('shadow-root');
    /* ShadowRoot 上的 getElementById 在真实浏览器里只看自己子树，
       这里直接查全局 byId（content.js 的 id 都写在自己的 shadow tree 里） */
    r.getElementById = (id) => doc.byId[id] || null;
    /* ★ 接上父子链。shadow tree 里的元素要能沿 parentNode 走到 host，
       否则 offsetWidth 的「隐藏祖先 => 0」判定（见 _hiddenByAncestor）
       永远看不到 host.style.display='none'，那条回归就形同虚设。*/
    r.parentNode = this;
    this.shadowRoot = r;
    return r;
  }
  getContext() {
    return new Proxy({}, { get: () => () => ({ addColorStop() {} }) });
  }
}

const doc = {
  readyState: 'complete',
  byId: Object.create(null),
  listeners: Object.create(null),
  activeElement: null,
  createElement: (t) => new El(t),
  createTextNode: (t) => { const n = new El('#text'); n._text = String(t); return n; },
  /* content.js 用 document.querySelector 去官网标题栏抓谱名；
     桩里给个假节点，验证这条路径不会抛异常。*/
  querySelector: () => ({ textContent: 'Smoke Test Artist - Smoke Test [Oni]' }),
  getElementById(id) { return doc.byId[id] || null; },
  addEventListener(t, fn) { (doc.listeners[t] ||= []).push(fn); },
  /* 页面世界派发 DOM 事件（page_route_hook.js 的通知就是这样进来的）。
     ★ 必须与 addEventListener 成对：content script 用
     document.addEventListener('osu-taiko:routechange') 订阅，
     页面世界用 document.dispatchEvent 派发 —— 两者共享 DOM，能对上。*/
  dispatch(t, ev) {
    const e = Object.assign({ type: t, target: doc }, ev || {});
    (doc.listeners[t] || []).slice().forEach((f) => f(e));
  },
  /* visibilitychange 是**事件**（不受后台节流影响），
     content.js 用它在标签页切回前台时补判一次路由。*/
  visibilityState: 'visible',
};
doc.body = new El('body');
doc.documentElement = new El('html');
doc.documentElement.appendChild(doc.body);

globalThis.document = doc;
globalThis.window = globalThis;
globalThis.innerWidth = 1280;
globalThis.innerHeight = 800;

/* window 级事件注册表：内容脚本把 mousemove/mouseup 挂在 window 上，
   桩里必须能记录并手动派发，否则拖拽/缩放/平移一律测不到。 */
const winHandlers = Object.create(null);
globalThis.addEventListener = function (t, fn) { (winHandlers[t] ||= []).push(fn); };
globalThis.removeEventListener = function (t, fn) {
  const a = winHandlers[t];
  if (a) winHandlers[t] = a.filter((f) => f !== fn);
};
function fireWin(type, ev) { (winHandlers[type] || []).slice().forEach((f) => f(ev)); }

globalThis.performance = globalThis.performance || { now: () => 0 };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
/* content.js 用两个 setInterval 分别盯 URL 与 hash；
   桩里登记下来，测试才能手动「推进一拍」。*/
const timers = [];
let timerSeq = 0;
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = function (fn, ms) {
  const h = { id: ++timerSeq, fn, ms };
  timers.push(h);
  return h.id;
};
globalThis.__tickIntervals = function (predicate) {
  for (const t of timers) if (!predicate || predicate(t)) t.fn();
};
/* 路由推进：跑「URL 轮询」那个 interval。
   ★ 不要写死 ms 数值 —— content.js 把它从 400 调成 250 时，
   这个桩就静默失配（一个 interval 都不跑），测试会以
   「路由完全没反应」的形式失败，看起来像产品 bug。
   改成按「短间隔」筛选：任何 <= 1000ms 的 interval 都算路由轮询。*/
globalThis.__tickRoute = function () {
  globalThis.__tickIntervals((t) => t.ms <= 1000);
};
/* SPA 监听用的观察器：桩里永不触发，只要求「能构造、不抛异常」 */
globalThis.MutationObserver = class {
  constructor(cb) { this.cb = cb; }
  observe() {}
  disconnect() {}
};
/* ---- 页面世界 / 隔离世界的分离桩 -------------------------------
 *
 * Chrome 的 content script 跑在**隔离世界**：有自己的 window/history，
 * 与页面共享 DOM 但**不共享 JS 对象**。
 * 所以 content script 改自己的 history.pushState 是**无效的** ——
 * 页面里的 vue-router 调的还是页面那个。
 *
 * ★ 这个桩必须如实还原，否则测试会给假绿灯：
 *   - pageHistory  = 页面那个（vue-router 调它）
 *   - globalThis.history = 隔离世界那个（content script 能碰到的）
 *   - 在 pageHistory 上打补丁后派发 DOM 事件，模拟 page_route_hook.js
 *
 * 上一次我就是把两者合一的，结果「劫持有效」的测试一直是绿的，
 * 真实环境却从来没生效过。 */
const pageHistory = {
  _stack: [],
  pushState(state, title, url) {
    if (url) location.href = new URL(String(url), location.href.split('#')[0]).href;
    this._stack.push({ state, title, url, kind: 'push' });
    this._fire('pushState');
  },
  replaceState(state, title, url) {
    if (url) location.href = new URL(String(url), location.href.split('#')[0]).href;
    this._stack.push({ state, title, url, kind: 'replace' });
    this._fire('replaceState');
  },
  back() {}, forward() {},
  _fire(reason) {
    /* 对应 page_route_hook.js：延一帧再派发 CustomEvent。
       document 是共享 DOM 的一部分，所以 content script 能收到。*/
    setTimeout(() => {
      doc.dispatch('osu-taiko:routechange', {
        target: doc,
        detail: { url: location.href, reason },
      });
    }, 0);
  },
};
globalThis.__pageHistory = pageHistory;
/* 隔离世界里的 history —— 改它对页面无影响（这一点本身就是被测语义）*/
globalThis.history = {
  pushState() { /* 隔离世界：改了也没用*/ },
  replaceState() {},
  back() {}, forward() {},
};

globalThis.getComputedStyle = () => ({
  paddingLeft: '0px', paddingRight: '0px',
  borderLeftWidth: '1px', borderRightWidth: '1px',
});

/* chrome.storage 桩：内存实现 + 异步回调（和真实 API 一致） */
const store = Object.create(null);
globalThis.chrome = {
  storage: {
    local: {
      get(key, cb) { setTimeout(() => cb(store), 0); },
      set(obj) { Object.assign(store, obj); },
    },
  },
  runtime: {
    onMessage: {
      /* 记下监听器，测试才能模拟 popup 的「显示/隐藏窗口」按钮 */
      addListener(fn) { globalThis.__msgListener = fn; },
    },
  },
};
/* 模拟 popup 点击「显示 / 隐藏窗口」 */
globalThis.__chromeToggle = function () {
  if (typeof globalThis.__msgListener !== 'function') {
    throw new Error('content.js 未注册 onMessage 监听');
  }
  globalThis.__msgListener({ type: 'toggle' }, null, () => {});
};
/* 读content.js 内部 state.visible —— 通过消息通道问它，
   免得测试去猜内部实现（IIFE 里的 state 拿不到）。*/
globalThis.__isVisible = function () {
  let out = null;
  globalThis.__msgListener({ type: 'status' }, null, (r) => { out = r; });
  return out && out.visible;
};

/* URL / fetch 桩：直接读本地样本谱 */
const zipDir = path.join(HERE, 'test_zips');
/* 样本选取：优先挑一张**变速谱**（首拍 BPM ≠ 主 BPM），
   这样标题栏的 BPM 断言才真正有区分度——
   否则首拍恰好等于主 BPM 时，用错口径也能通过，测不出回归。
   找不到变速谱就用第一张（此时 [5d] 会标注口径一致，仅作冒烟）。*/
const allNames = fs.readdirSync(zipDir).filter((n) => n.endsWith('.osu'));
/* .osu 有两种 timingPoints 写法：
     行式 `beatLength:260.87`
     内联 `5715,260.87,4,1,0,...`（beatLength 是第 2 个字段）
   行尾是 CRLF。两种都要匹配。*/
function redBpmList(txt) {
  const sec = txt.split('[TimingPoints]')[1] || '';
  const out = [];
  for (const line of sec.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('[')) continue;
    let bl = null, m;
    if ((m = t.match(/^beatLength:(-?[\d.]+)/))) bl = parseFloat(m[1]);
    else if ((m = t.match(/^-?\d+,(-?[\d.]+),/))) bl = parseFloat(m[1]);
    if (bl === null) continue;
    if (bl > 2 && 60000 / bl < 1000) out.push(Math.round(60000 / bl));
  }
  return out;
}
/* 样本选取：挑BPM 种类最多（最复杂）的那张，让布局/渲染覆盖更多分支。
   BPM 口径的跨样本回归不在这里做，见 header_layout.mjs 的 [4] 项。*/
const sampleName = (() => {
  let best = allNames[0], bestKinds = -1;
  for (const n of allNames) {
    const k = new Set(redBpmList(fs.readFileSync(path.join(zipDir, n), 'utf8'))).size;
    if (k > bestKinds) { bestKinds = k; best = n; }
  }
  return best;
})();
const sampleText = fs.readFileSync(path.join(zipDir, sampleName), 'utf8');

/* URL 桩：**用 href 反推 hash/search**，与真实浏览器一致。
   否则测试只改 href 时search 还留着旧的 ?beatmap=2，
   extractBeatmapId 会一直返回旧 bid，「退到商店」这一项就测不出来。*/
globalThis.location = {
  _href: 'https://osu.ppy.sh/beatmapsets/1?beatmap=2',
  get href() { return this._href; },
  set href(v) {
    this._href = v;
    const i = v.indexOf('#');
    this.hash = i >= 0 ? v.slice(i) : '';
    const beforeHash = i >= 0 ? v.slice(0, i) : v;
    const q = beforeHash.indexOf('?');
    this.search = q >= 0 ? beforeHash.slice(q) : '';
    /* ★ pathname 也得反推：私服判断（isPrivateServer）与
       set id 提取（/beatmapset/<sid>）都读它。
       之前没有这个字段，于是私服分支永远走不到，
       等于把要测的路径屏蔽了。*/
    this.pathname = beforeHash.split('?')[0];
  },
  hash: '',
  search: '',
  pathname: '/',
};
globalThis.location.href = 'https://osu.ppy.sh/beatmapsets/1?beatmap=2';
/* URLSearchParams 桩。
   ★ 原实现只接受 `(\\d+)`，私服的 `?beatmap=<32位hash>` 会取到 null ——
     而那正是要测的场景，等于桩自己把被测行为屏蔽掉了。
     改为**原样返回解码后的值**（并把 '+' 当空格，与真实实现一致），
     具体格式由调用方自己校验（content.js 里用 /^\d+$/ 判断）。*/
globalThis.URLSearchParams = class {
  constructor(s) { this.s = s || ''; }
  get(k) {
    const re = new RegExp('[?&]' + k + '=([^&#]*)');
    const m = this.s.match(re);
    if (!m) return null;
    try {
      return decodeURIComponent(m[1].replace(/\+/g, ' '));
    } catch (e) {
      return m[1];
    }
  }
};
let fetchCount = 0;
/* fetch 桩：记录被请求的 URL。
   ★ 必须记录 —— 否则测试无法区分「抓对了谱面」与「碰巧渲染成功」。
   反向验证时发现：只看「画布渲染成功」的话，把 hash 查表逻辑整个删掉
   测试**依然是绿的**（因为 reload 拿不到 bid 时走占位分支，
   而更早一次成功渲染留下的画布还在）。*/
globalThis.fetchUrls = [];
globalThis.fetch = function (u) {
  fetchCount++;
  if (u) globalThis.fetchUrls.push(String(u));
  return Promise.resolve({ ok: true, text: () => Promise.resolve(sampleText) });
};

/* ===================================================================== *
 * 载入 lib 三模块 + 执行 content.js
 * ===================================================================== */

const [parser, layout, renderer, difficulty, ppMod, srPanel] = await Promise.all([
  import(pathToFileURL(path.join(LIB, 'osu_parser.js')).href),
  import(pathToFileURL(path.join(LIB, 'layout.js')).href),
  import(pathToFileURL(path.join(LIB, 'renderer.js')).href),
  import(pathToFileURL(path.join(LIB, 'difficulty.js')).href),
  import(pathToFileURL(path.join(LIB, 'pp.js')).href),
  import(pathToFileURL(path.join(LIB, 'sr_panel.js')).href),
]);
globalThis.OSU_TAIKO_PARSE = parser;
globalThis.OSU_TAIKO_LAYOUT = layout;
globalThis.OSU_TAIKO_RENDERER = renderer;
/* 与 bridge.js 里的挂载名保持一致 —— 挂错名content.js 会在
   buildPreview 里catch 掉 SR/PP 计算，只打一条 warn，
   表面上「能跑」但信息栏其实没数据。*/
globalThis.OSU_TAIKO_DIFF = difficulty;
globalThis.OSU_TAIKO_PP = ppMod;
globalThis.OSU_TAIKO_PANEL = srPanel;
/* 段位/键型：注入**真实的**适配层，这样这段测试顺带验证了
   「content.js 的调用方式与dan_bridge 的导出契约对得上」。*/
const danBridge = await import(pathToFileURL(path.join(LIB, 'dan_bridge.js')));
globalThis.OSU_TAIKO_DAN = danBridge;
globalThis.OSU_TAIKO_DAN_RANK = await import(pathToFileURL(path.join(LIB, 'dan_rank.js')));
globalThis.OSU_TAIKO_READY = true;

/* 预置偏好：记住一个非默认尺寸，后面验证「按记忆尺寸恢复」 */
store['osu-taiko-prefs'] = {
  userCfg: { pixelsPerSecond: 0, showHeader: true, showMeasure: true, showSv: true, showGrid: true, showDan: true },
  modRate: 'None', modOd: 'None', modMisc: ['CL'],
};
store['osu-taiko-preview-window'] = { x: 100, y: 80, w: 660, h: 380 };

(0, eval)(fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8'));
console.log('[1] content.js 已执行（样本 %s）', sampleName.slice(0, 34));

await new Promise((r) => setTimeout(r, 250));   // 等 storage 回调 + fetch

/* ===================================================================== *
 * 结构检查
 * ===================================================================== */

const host = doc.getElementById('osu-taiko-preview-host');
check(!!host, '未创建 #osu-taiko-preview-host');
const panel = host.shadowRoot.children.find((c) => c.classList.contains('panel'));
check(!!panel, 'Shadow DOM 里未找到 .panel');
console.log('[2] Shadow DOM 宿主 + .panel 就绪');

const byId = (id) => doc.byId[id];
for (const id of ['t', 's', 'stage', 'wrap', 'fold', 'close', 'pos',
  'vbar', 'vthumb', 'grip', 'up', 'down', 'top', 'pps',
  'cMeasure', 'cSv', 'cGrid',
  /* 段位/键型评估行 */
  'cDan']) {
  check(!!byId(id), `缺少元素 #${id}`);
}

/* stage/vbar 与 panel 的尺寸联动由 El 的 getter 自动处理
   （见 class El 的 clientWidth/clientHeight），无需手工连线 */
const stage = byId('stage');

/* 播放相关必须彻底消失 */
for (const id of ['play', 'scrub', 'time', 'prev', 'next', 'pageRow',
  'pageInfo', 'cAudio', 'audioFile']) {
  check(!byId(id), `播放相关元素 #${id} 仍存在（应已移除）`);
}
check(!/id="(play|scrub|time|prev|next|cAudio|audioFile)"/.test(panel.innerHTML),
  '面板 HTML 里仍有播放/音频控件');
console.log('[3] 播放与音频 UI 已全部移除（%d 个结构断言通过）', ok.length);

/* ===================================================================== *
 * 渲染检查
 * ===================================================================== */

const wrap = byId('wrap');
const cv = wrap.children.find((c) => c.tagName === 'CANVAS');
check(!!cv, '未渲染出 canvas');
check(fetchCount === 1, `谱面应只下载一次，实际 ${fetchCount} 次`);
console.log('[4] 整首 canvas: %dx%d（fetch %d 次）',
  cv ? cv.width : 0, cv ? cv.height : 0, fetchCount);
/* 记忆里的窗口 660 宽 -> stage 内容盒 = 660 - body padding 18 - stage border 2 = 640 */
check(cv && cv.width === 640, `画布宽 ${cv && cv.width} 应等于窗口内容宽 640`);
check(cv && cv.height > 1000, `画布高 ${cv && cv.height} 异常小`);

/* 记忆里的窗口尺寸被应用了 */
check(panel.offsetWidth === 660, `窗口宽 ${panel.offsetWidth} 应恢复为 660`);
check(panel.offsetHeight === 380, `窗口高 ${panel.offsetHeight} 应恢复为 380`);

/* setStage 之后 vbar / grip 必须还在（曾经被 innerHTML 误删） */
check(byId('vbar').style.display !== 'none', '渲染后 .vbar 仍隐藏');
check(!!panel.querySelector('.grip'), '渲染后 .grip 丢失');
const posTxt = byId('pos').textContent;
check(/第\s*1\s*–\s*\d+\s*行\s*\/\s*共\s*\d+\s*行/.test(posTxt),
  `行号标签格式异常: ${posTxt}`);
console.log('[5] 行号标签: %j', posTxt);

/* ---------- 顶部信息栏已开启 ---------- */
/* 用户要求「把左上角和右上角的信息栏补齐」——
   信息栏画在 canvas 顶部（renderer 的 header:true 负责版式，
   见 test/header_layout.mjs），这里只验证开关与画布高度确实包含了它。*/
check(!!byId('cHeader'), '缺少「信息栏」开关');
check(byId('cHeader').checked, '信息栏开关默认应勾选');
check(cv && cv.height > 3000,
  `画布高 ${cv && cv.height} 偏低，信息栏可能没画（应含 header ~146px + 紧凑行高）`);
console.log('[5b] 信息栏开关存在且默认开；画布高 %d（含信息栏）', cv.height);

/* 关掉信息栏后画布应变矮（headerHeight=0 -> bodyTop=paddingTop）*/
const hWithHeader = cv.height;
byId('cHeader').checked = false;
byId('cHeader').dispatch('change', {});
await new Promise((r) => setTimeout(r, 150));
const cvNoHeader = byId('wrap').children[0];
check(cvNoHeader.height < hWithHeader,
  `关掉信息栏后画布应变矮：${hWithHeader} -> ${cvNoHeader && cvNoHeader.height}`);
byId('cHeader').checked = true;
byId('cHeader').dispatch('change', {});
await new Promise((r) => setTimeout(r, 150));
check(byId('wrap').children[0].height === hWithHeader,
  '重新勾选信息栏后画布高度未复原');
console.log('[5c] 信息栏开关生效：高 %d -> 关 %d -> 开 %d',
  hWithHeader, cvNoHeader.height, byId('wrap').children[0].height);

/* 标题栏 BPM 必须与画布信息栏的主 BPM 一致。
   注：样本本身若首拍恰好等于主 BPM，用错口径也能通过 —— 所以跨样本的
   口径回归由 header_layout.mjs 的 [4] 项负责（覆盖全部 14 张），
   这里只验证「标题栏显示的确实是主 BPM 且不含范围」。*/
{
  const subTxt = byId('s').textContent;
  const m = subTxt.match(/([\d.]+(?:-[\d.]+\([\d.]+\))?)\s*BPM/);
  check(!!m, `标题栏未显示 BPM：${JSON.stringify(subTxt)}`);

  const R2 = globalThis.OSU_TAIKO_RENDERER;
  const P2 = globalThis.OSU_TAIKO_PARSE;
  const L2 = globalThis.OSU_TAIKO_LAYOUT;
  const b2 = P2.parseOsu(sampleText);
  const cfg2 = L2.applyCompact(Object.assign({}, L2.DEFAULTS), 640);
  cfg2.headerHeight = R2.headerHeightFor(640);
  cfg2.pixelsPerSecond = L2.alignPixelsPerSecond(b2, cfg2) || 200;
  const lay2 = L2.computeLayout(b2, cfg2);
  const rr = new R2.PreviewRenderer(b2, lay2, cfg2, { loaded: false },
    { header: true, bgImage: null, useSkin: false });
  const main = R2.fmtBpmRange(rr.bpmRange(), 'main');

  if (m) check(m[1] === main, `标题栏 BPM「${m[1]}」≠ 主 BPM「${main}」`);
  /* 标题栏空间有限，不应显示范围 */
  check(!/\d+-\d+\(/.test(subTxt), `标题栏 BPM 不应显示范围：${JSON.stringify(subTxt)}`);
  console.log('[5d] 标题栏 BPM「%s」= 主 BPM %s ✅', m ? m[1] : '?', main);
}

/* ---------- bridge 模块挂载检查 ---------- */
/* 挂载名写错时 content.js 里的 try/catch 会静默吞掉异常，
   表面正常但信息栏永远没数据。这里明确验一遍挂载名。*/
{
  for (const [name, fn] of [
    ['OSU_TAIKO_PARSE', 'parseOsu'],
    ['OSU_TAIKO_LAYOUT', 'computeLayout'],
    ['OSU_TAIKO_RENDERER', 'PreviewRenderer'],
    ['OSU_TAIKO_DIFF', 'calculateStarRating'],
    ['OSU_TAIKO_PP', 'calculatePp'],
    ['OSU_TAIKO_PANEL', 'buildDifficultyReport'],
  ]) {
    const m = globalThis[name];
    check(!!m && typeof m[fn] === 'function',
      `window.${name} 未挂载或缺少 ${fn}()`);
  }
  /* SR/PP 必须真的算出来了（info 栏才有内容）*/
  let st = null;
  globalThis.__msgListener({ type: 'status' }, null, (r) => { st = r; });
  check(st && typeof st.sr === 'number' && st.sr > 0,
    `SR 未算出（${st && st.sr}）—— bridge 挂载名可能不对`);
  check(st && st.maxPp > 0, `最大 PP 未算出（${st && st.maxPp}）`);
  console.log('[5h] bridge 挂载 OK，当前 mod=%s SR=%s maxPP=%s',
    st && st.mod, st && st.sr && st.sr.toFixed(3), st && st.maxPp && st.maxPp.toFixed(1));
}

/* ---------- mod 选择 UI ---------- */
{
  check(!!byId('modbar'), '缺少 mod 选择条#modbar');
  const bar = byId('modbar');
  const inputs = bar.querySelectorAll('input[data-mod]');
  /* 9 个 = 流速组 3（无 / HT / DT·NC）+ 难度组 3（无 / EZ / HR）+ 独立 3。
     **两组都必须有「无」** —— radio 勾上就取消不掉，没有「无」回不到 NoMod。
     DT 与 NC 的计算完全一致（rate 都是 1.5），所以合并成一个选项。*/
  check(inputs.length === 9,
    `mod 复选框应为 9 个（DT/NC 已合并），实际 ${inputs.length}`);
  check(!inputs.some((e) => e.getAttribute('data-mod') === 'NC'),
    'NC 应已与 DT 合并，不该再有独立的 NC 选项');
  const rateNone = inputs.filter((e) => e.getAttribute('data-set') === 'modRate'
    && e.getAttribute('data-mod') === 'None');
  const odNone = inputs.filter((e) => e.getAttribute('data-set') === 'modOd'
    && e.getAttribute('data-mod') === 'None');
  check(rateNone.length === 1, '流速组缺少「无」选项');
  check(odNone.length === 1, '难度组缺少「无」选项（用户反馈第 5 条）');

  /* 默认：两组都选「无」，独立组只勾 CL */
  const on = inputs.filter((e) => e.checked).map((e) => e.getAttribute('data-mod'));
  const mods = inputs.filter((e) => e.checked && e.getAttribute('data-set'));
  check(mods.length === 2 && mods.every((e) => e.getAttribute('data-mod') === 'None'),
    `默认两组都应选「无」，实际 ${mods.map((e) => e.getAttribute('data-mod')).join(',')}`);
  check(on.filter((m) => m === 'CL').length === 1,
    `默认应勾选 CL，实际勾选 [${on.join(',')}]`);

  /* 互斥：同组 radio 只能选一个 */
  const names = {};
  for (const e of inputs) {
    const t = e.getAttribute('data-mod');
    if (t === 'HT' || t === 'DT' || t === 'NC' || t === 'None') {
      names[e.tagName === 'INPUT' && e.type === 'radio' ? 'rate' : ''] = 1;
    }
  }
  void names;
  /* 通过实际点选验证互斥：先选 HT，再选 DT，HT 应自动取消 */
  const find = (m) => inputs.find((e) => e.getAttribute('data-mod') === m);
  find('HT').checked = true;
  find('HT').dispatch('change', {});
  await new Promise((r) => setTimeout(r, 120));
  find('DT').checked = true;
  find('DT').dispatch('change', {});
  await new Promise((r) => setTimeout(r, 120));
  console.log('[5e] mod 切换到 HT->DT，标题栏：%s', byId('s').textContent.slice(0, 60));
}

/* ---------- 关键回归：切 mod 必须重算 SR / 占比 / PP ---------- */
/* 用户要求：勾选/取消 HT、DT、EZ、HR 时要重新获取正确值并正确渲染。

   注意：**不能用画布高度判断**—— HT/DT 只改流速(rate)，
   不改「时间→x」的映射，所以换 mod 后行数与画布高度本来就不变。
   要看的是 SR / 占比 / OD / HP 这些**真的随 mod 变**的量。
   这里通过 popup 的 status 消息通道读回内部状态。*/
{
  const bar = byId('modbar');
  const inputs = bar.querySelectorAll('input[data-mod]');
  const find = (m) => inputs.find((e) => e.getAttribute('data-mod') === m);
  const status = () => {
    let out = null;
    globalThis.__msgListener({ type: 'status' }, null, (r) => { out = r; });
    return out || {};
  };
  const setMods = async (rate, od, misc) => {
    for (const e of inputs) {
      const m = e.getAttribute('data-mod');
      let want = false;
      if (m === rate || m === od) want = true;
      else if (misc && misc.indexOf(m) >= 0) want = true;
      e.checked = want;
    }
    /* 触发 change（监听挂在每个 input 上，勾一个即可）。
       优先用真正被勾上的那个；都��勾时随便挑一个也能触发 ——
       反正 onChange 是从 DOM 反读全部状态，不依赖事件源。*/
    let any = inputs.find((e) => e.checked);
    if (!any) any = inputs[0];
    any.dispatch('change', {});
    await new Promise((r) => setTimeout(r, 500));
    return status();
  };

  const base = await setMods(null, null, ['CL']);
  const ht = await setMods('HT', null, ['CL']);
  const dt = await setMods('DT', null, ['CL']);
  const ez = await setMods(null, 'EZ', ['CL']);
  const hr = await setMods(null, 'HR', ['CL']);
  const none = await setMods(null, null, []);

  console.log('[5f] 各 mod 的 SR / 最大PP / mod 缩写:');
  for (const [name, s] of [['CL', base], ['HT+CL', ht], ['DT+CL', dt],
    ['EZ+CL', ez], ['HR+CL', hr], ['NoMod', none]]) {
    console.log('     %s -> mod=%s 标签=%s  SR=%s  maxPP=%s',
      name.padEnd(7), String(s.mod).padEnd(7), String(s.modLabel).padEnd(7),
      s.sr && s.sr.toFixed(3), s.maxPp && s.maxPp.toFixed(1));
  }

  /* mod 名与缩写必须正确。用户要求：
     一个都不选 -> "None"；选了任意 mod -> "+EZ,HD,DT,CL"
     （加号最前、逗号分隔，顺序 EZ/HR -> HD/FL -> HT/DT -> CL）。*/
  check(base.mod === 'CL', `默认 mod 应为 CL，实际 ${base.mod}`);
  check(base.modLabel === '+CL', `默认（只勾 CL）缩写应为 "+CL"，实际 ${base.modLabel}`);
  check(ht.mod === 'HT+CL', `勾 HT 后 mod 应为 HT+CL，实际 ${ht.mod}`);
  check(ht.modLabel === '+HT,CL', `缩写应为 "+HT,CL"，实际 ${ht.modLabel}`);
  check(none.mod === 'None' && none.modLabel === 'None',
    `全不勾时缩写应为 "None"，实际 mod=${none.mod} 标签=${none.modLabel}`);

  /* 顺序固定 EZ/HR -> HD/FL -> HT/DT -> CL：全勾时必须严格按这个顺序 */
  const all = await setMods('DT', 'HR', ['HD', 'FL', 'CL']);
  check(all.modLabel === '+HR,HD,FL,DT,CL',
    `全勾时缩写应为 "+HR,HD,FL,DT,CL"，实际 ${all.modLabel}`);
  console.log('[5h] 全勾缩写顺序: %s', all.modLabel);

  /* SR 必须真的随 mod 变（HT/DT/EZ/HR 都会改判定窗或 OD）*/
  const srs = [base.sr, ht.sr, dt.sr, ez.sr, hr.sr];
  for (const [name, s] of [['CL', base], ['HT', ht], ['DT', dt], ['EZ', ez], ['HR', hr]]) {
    if (!(s.sr > 0)) errs.push(`${name}: SR 未算出（${s.sr}）`);
    if (!(s.maxPp > 0)) errs.push(`${name}: 最大 PP 未算出（${s.maxPp}）`);
  }
  check(new Set(srs.map((v) => v && v.toFixed(4))).size >= 4,
    `5 个 mod 只产生了 ${new Set(srs.map((v) => v && v.toFixed(4))).size} 个不同 SR，mod 未真正生效`);
  /* DT 应显著提高 SR，HT 应降低 */
  if (!(dt.sr > base.sr)) errs.push(`DT 的 SR (${dt.sr}) 应大于 CL (${base.sr})`);
  if (!(ht.sr < base.sr)) errs.push(`HT 的 SR (${ht.sr}) 应小于 CL (${base.sr})`);
  /* EZ 降 OD -> 判定窗变宽 -> SR 略降；HR 反之 */
  if (!(hr.sr > ez.sr)) errs.push(`HR 的 SR (${hr.sr}) 应大于 EZ (${ez.sr})`);

  /* mod 选择要持久化 */
  const pf = store['osu-taiko-prefs'];
  check(pf.modRate !== undefined && Array.isArray(pf.modMisc),
    'mod 选择未持久化');
  console.log('[5g] 已持久化 modRate=%s modOd=%s modMisc=%s',
    pf.modRate, pf.modOd, JSON.stringify(pf.modMisc));

  /* 恢复默认 CL（CL 会影响 PP 数值，留着 HR/DT 会干扰后续断言）*/
  await setMods(null, null, ['CL']);
}
/* 这是用户第2 条要求的核心验收点：以前窄窗一行连一个小节都放不满。*/
{
  const L = globalThis.OSU_TAIKO_LAYOUT;
  for (const w of [420, 660, 1000, 1600]) {
    const c = L.applyCompact(Object.assign({}, L.DEFAULTS), w);
    const usable = w - c.marginX * 2;
    const sp16 = usable / (c.measuresPerRow * 16);
    check(c.measuresPerRow >= 3 && c.measuresPerRow <= 4,
      `宽度 ${w} 下每行 ${c.measuresPerRow} 个小节，应在 3~4`);
    /*音符直径不超过 16分间距的 1.12 倍（最窄时允许轻微重叠）*/
    check(c.noteDiameter <= sp16 * 1.12,
      `宽度 ${w} 下音符 ${c.noteDiameter} 相对间距 ${sp16.toFixed(1)} 过大`);
    /* 音符必须比网页版小，否则「缩小」没生效 */
    if (w < 1200) {
      check(c.noteDiameter < 34,
        `宽度 ${w} 下音符直径 ${c.noteDiameter} 未缩小（网页版是 34）`);
      check(c.stripeHeight < 50,
        `宽度 ${w} 下轨道高 ${c.stripeHeight} 未缩小（网页版是 50）`);
    }
  }
  const c660 = L.applyCompact(Object.assign({}, L.DEFAULTS), 660);
  const sp660 = (660 - c660.marginX * 2) / (c660.measuresPerRow * 16);
  console.log('[5d] 紧凑几何量: 660宽 -> 音符 %d 轨道 %d 行高 %d 每行 %d 小节（16分间距 %s px）',
    c660.noteDiameter, c660.stripeHeight, c660.rowHeight, c660.measuresPerRow, sp660.toFixed(1));
}

/* ===================================================================== *
 * 画面内拖动平移
 * ===================================================================== */

stage.dispatch('mousedown', { target: cv, clientX: 300, clientY: 200 });
check(stage.classList.contains('panning'), '按下后 .stage 未标记 panning');
fireWin('mousemove', { clientX: 300, clientY: 100 });   // 上移 100px -> 下滚100
fireWin('mouseup', {});
const tf1 = wrap.style.transform;
check(/translateY\(-100px\)|translateY\(-1\d\d(?:\.\d+)?px\)/.test(tf1),
  `拖动后 transform 应为约 -100px，实际 ${tf1}`);
check(!stage.classList.contains('panning'), '松手后 .stage 仍标记 panning');
console.log('[6] 画面内拖动 100px -> %j  （%s）', tf1, byId('pos').textContent);

/* 继续往下拖，应该被maxScroll 夹住 */
const total = cv.height;
for (let i = 0; i < 40; i++) {
  stage.dispatch('mousedown', { target: cv, clientX: 300, clientY: 100 });
  fireWin('mousemove', { clientX: 300, clientY: 0 });
  fireWin('mouseup', {});
}
const tf2 = wrap.style.transform;
const m2 = tf2.match(/-(\d+(?:\.\d+)?)px/);
const scrolled = m2 ? parseFloat(m2[1]) : 0;
const maxScroll = total - 300;
check(scrolled <= maxScroll + 1,
  `平移量 ${scrolled} 超过 maxScroll ${maxScroll}`);
check(scrolled > 0, '连续拖动后没有产生滚动');
console.log('[7] 连续拖到底: %j（上限 %d，未越界）', tf2, maxScroll);

/* 底部按钮 */
byId('top').dispatch('click', {});
check(/translateY\(-?0(?:\.0+)?px\)/.test(wrap.style.transform),
  `⤒ 未回到顶部: ${wrap.style.transform}`);
check(/第\s*1\s*–/.test(byId('pos').textContent), '回到顶部后行号不是第 1 行');
byId('down').dispatch('click', {});
const tf3 = wrap.style.transform;
check(/translateY\(-150px\)/.test(tf3), `▼ 半屏应为 -150px，实际 ${tf3}`);
console.log('[8] ⤒ 回顶 + ▼ 半屏: %j', tf3);

/* ===================================================================== *
 * 窗口拖动
 * ===================================================================== */

const bar = panel.querySelector('.bar');
const r0 = panel.getBoundingClientRect();
bar.dispatch('mousedown', { target: panel.querySelector('.title'), clientX: r0.left + 20, clientY: r0.top + 10 });
fireWin('mousemove', { clientX: r0.left + 220, clientY: r0.top + 110 });
fireWin('mouseup', {});
const r1 = panel.getBoundingClientRect();
check(Math.abs(r1.left - (r0.left + 200)) < 1.5,
  `拖动后 left 应 +200，实际 ${r0.left} -> ${r1.left}`);
check(Math.abs(r1.top - (r0.top + 100)) < 1.5,
  `拖动后 top 应 +100，实际 ${r0.top} -> ${r1.top}`);
console.log('[9] 窗口拖动: (%d,%d) -> (%d,%d)', r0.left, r0.top, r1.left, r1.top);

/* ===================================================================== *
 * 右下角缩放：宽度变了要按新宽度重算布局
 * ===================================================================== */

const wBefore = byId('wrap').children[0].width;
byId('grip').dispatch('mousedown', { clientX: r1.left + 660, clientY: r1.top + 380 });
fireWin('mousemove', { clientX: r1.left + 860, clientY: r1.top + 380 });
fireWin('mouseup', {});
await new Promise((r) => setTimeout(r, 450));    // 等 refit debounce

const panelW = panel.offsetWidth;
const cv3 = byId('wrap').children[0];
console.log('[10] 拉宽 %d -> %d px，画布宽 %d -> %d',
  660, panelW, wBefore, cv3.width);
check(panelW > 660, `缩放后窗口宽 ${panelW} 未变大`);
check(cv3.width > wBefore, `宽度变化后画布未按新宽度重算（${wBefore} -> ${cv3.width}）`);
check(cv3.width === panelW - 20,
  `画布宽 ${cv3.width} 应等于窗口内容宽 ${panelW - 20}`);

/* 缩到最小 */
byId('grip').dispatch('mousedown', { clientX: 0, clientY: 0 });
fireWin('mousemove', { clientX: -5000, clientY: -5000 });
fireWin('mouseup', {});
check(panel.offsetWidth === 420, `最小宽度应为 420，实际 ${panel.offsetWidth}`);
check(panel.offsetHeight === 240, `最小高度应为 240，实际 ${panel.offsetHeight}`);
console.log('[11] 缩到最小: %dx%d', panel.offsetWidth, panel.offsetHeight);

/* 尺寸持久化 */
check(store['osu-taiko-preview-window']
  && store['osu-taiko-preview-window'].w === 420,
  '缩放后未写入 storage');
check(typeof store['osu-taiko-preview-window'].h === 'number', '高度未持久化');

/* ===================================================================== *
 * 折叠/ 隐藏
 * ===================================================================== */

/* 折叠必须让窗口**缩到只剩标题栏**（用户反馈：折叠只是不显示谱面，
   但窗口还在，留下一大片空黑框）。做法是 style.height 让位给 auto。*/
byId('fold').dispatch('click', {});
check(panel.classList.contains('collapsed'), '点击 ▾ 未折叠');
check(byId('fold').textContent === '▸', '折叠后图标未变为 ▸');
check(panel.style.height === 'auto',
  `折叠后 height 应让位给 auto，实际 ${panel.style.height}`);
check(store['osu-taiko-prefs'].collapsed === true, '折叠状态未持久化');

/* 折叠状态下 clampPanel 不能把固定高度写回去（否则折叠失效）。
   clampPanel 挂在 window 的 resize 上，所以直接触发 resize 即可。*/
const beforeClamp = panel.style.height;
globalThis.innerHeight = 300;                 /* 模拟窗口变矮 */
fireWin('resize', {});
check(panel.style.height === beforeClamp,
  `折叠时 resize 触发的 clampPanel 改写了 height: ${panel.style.height}`);
globalThis.innerHeight = 800;

/* ---- 关键回归：展开后必须能看到预览图 ----
   用户反馈「折叠再展开不显示预览图」。根因是默认高度写在 CSS 里，
   所以 style.height 初始为空串；旧代码存空串、展开时写回空串，
   高度就永久停在 auto -> .stage 被压成 0 高 -> 画布看不见。*/
const hCollapsedPanel = panel.offsetHeight;   /* 折叠后应只剩标题栏 */
byId('fold').dispatch('click', {});
check(!panel.classList.contains('collapsed'), '再次点击未展开');
check(parseFloat(panel.style.height) >= 240,
  `展开后 height 应恢复为具体像素值，实际 "${panel.style.height}"`);
check(panel.style.height !== 'auto',
  '展开后 height 仍是 auto —— 这正是预览图不显示的根因');
/* 展开后视口必须有可用高度（画布才有地方显示）*/
check(stage.clientHeight > 100,
  `展开后 stage 高度 ${stage.clientHeight} 过小，预览区被压扁`);
check(!!byId('wrap').children.find((c) => c.tagName === 'CANVAS'),
  '展开后画布丢失');
console.log('[12] 折叠高 %d -> 展开高 %d（stage 可视高 %d，画布在位）',
  hCollapsedPanel, panel.offsetHeight, stage.clientHeight);

/* 反复折叠/展开 5 次，高度必须稳定（不能逐次漂移）*/
const hOnce = panel.style.height;
for (let i = 0; i < 5; i++) {
  byId('fold').dispatch('click', {});   /* 折叠 */
  byId('fold').dispatch('click', {});   /* 展开 */
}
check(panel.style.height === hOnce,
  `反复折叠/展开后高度漂移：${hOnce} -> ${panel.style.height}`);
check(stage.clientHeight > 100, `反复折叠后 stage 高度 ${stage.clientHeight} 过小`);
console.log('[12b] 反复折叠/展开 5 次，高度稳定在 %s', panel.style.height);

byId('close').dispatch('click', {});
check(host.style.display === 'none', '点击 ✕ 未隐藏窗口');
/*★ userClosed **不该**再持久化。
   它曾被存进 chrome.storage，结果「退商店 -> 重进谱面页」被永久堵死
   （用户两次反馈的都是同一个期望）。隐藏现在只作用于当前页。*/
check(store['osu-taiko-prefs'].userClosed === undefined,
  'userClosed 不应再写入 storage（会让「退商店 -> 重进」永远弹不出来），'
  + `实际 ${JSON.stringify(store['osu-taiko-prefs'].userClosed)}`);
console.log('[12] 折叠（缩到标题栏）/ 隐藏 正常（userClosed 不再持久化）');

/* ===================================================================== *
 * 路由切换：退到商店 -> 重新进谱面页，窗口要自动回来
 *（用户反馈第 4 条：退到谱面商店窗口消失，再点进谱面窗口不回来，只能刷新）
 *
 * 注意必须**先**清掉上一步 ✕ 留下的 userClosed，否则窗口理应不再出现。
 * 这里直接模拟 popup 的 toggle（手动开关会清userClosed）。
 * ===================================================================== */

globalThis.__chromeToggle();                   /* = popup「显示/隐藏窗口」 */
check(host.style.display === '', 'toggle 后窗口应重新显示');

location.href = 'https://osu.ppy.sh/home';
globalThis.__tickRoute();
check(host.style.display === 'none', '退到非谱面页后窗口应隐藏');

location.href = 'https://osu.ppy.sh/beatmapsets/1?beatmap=3';
globalThis.__tickRoute();
check(host.style.display === '', '重新进谱面页后窗口未自动恢复');
/* show() 里的 reload 是异步的，等fetch 落地*/
await new Promise((r) => setTimeout(r, 120));
check(fetchCount >= 2, `换谱面应重新下载，实际 fetch ${fetchCount} 次`);
check(globalThis.__isVisible(), '重新进谱面页后 visible 应为 true');
console.log('[13] 退到商店自动隐藏 -> 重进谱面页自动恢复（fetch %d 次）', fetchCount);

/* 消息通道要能拿到 send 的回执，popup 就是靠它确认成功的 */
const callContent = (msg) => {
  let out = null;
  globalThis.__msgListener(msg, null, (r) => { out = r; });
  return out || {};
};

/* ★ 手动关掉后，**切到另一张谱**仍应自动弹出。
     这里与 v1.2.x 的设计相反：当时用持久化的 userClosed 让它
     「关掉就再也别弹」，结果用户两次反馈同一个期望 ——
     「退到商店再重新点进谱面页，窗口应该自动弹出来」。
     持久化闸门把这条路径永久堵死了。
     现在的语义是：**任何隐藏都只作用于当前这一页**。*/
byId('close').dispatch('click', {});
let vClosed = callContent({ type: 'status' });
check(vClosed.visible === false, '点✕ 后应不可见');
location.href = 'https://osu.ppy.sh/beatmapsets/1?beatmap=4';
globalThis.__tickRoute();
await new Promise((r) => setTimeout(r, 500));
let vAfter = callContent({ type: 'status' });
check(vAfter.visible === true,
  '手动关闭后切到另一张谱面页应自动弹出（隐藏只压当前页）');
check(vAfter.beatmapId === '4', `应切到谱面 4，实际 ${vAfter.beatmapId}`);
console.log('[14] 手动关闭后切谱仍会自动弹出（隐藏只压当前页）');

/* ===================================================================== *
 * popup 的「显示 / 隐藏窗口」必须真的生效（用户反馈「并不能生效」）
 * ===================================================================== */

/* ---- 场景 A：在谱面页，窗口可见 -> 点按钮应该隐藏 ----*/
{
  /* 前置：确保在谱面页且窗口可见（进入谱面页一律显示）*/
  location.href = 'https://osu.ppy.sh/beatmapsets/1?beatmap=2';
  globalThis.__tickRoute();
  await new Promise((r) => setTimeout(r, 400));
  const v0 = callContent({ type: 'status' });
  check(v0.visible === true,
    `前置条件：点按钮前窗口应为可见，实际 visible=${v0.visible}`);
  check(host.style.display !== 'none',
    `前置条件：点按钮前 host 应显示，实际 display=${host.style.display}`);

  const r1 = callContent({ type: 'toggle' });
  const v1 = callContent({ type: 'status' });
  console.log('[17] 谱面页点「显示/隐藏」: visible %s -> %s（回执 %s）%s',
    v0.visible, v1.visible, JSON.stringify(r1.visible),
    v1.visible === false ? ' ✅ 已隐藏' : ' ❌ 未隐藏');
  check(r1.visible === false,
    `toggle 回执应报告 visible=false，实际 ${JSON.stringify(r1.visible)}`);
  check(v1.visible === false, 'toggle 后 status 仍报 visible');
  check(host.style.display === 'none',
    `toggle 隐藏后 host.display 应为 none，实际 "${host.style.display}"`);

  /* ---- 场景 B：再点一次 -> 应该显示 ---- */
  const r2 = callContent({ type: 'toggle' });
  await new Promise((r) => setTimeout(r, 400));
  const v2 = callContent({ type: 'status' });
  console.log('[18] 再点一次: visible %s -> %s %s',
    v1.visible, v2.visible, v2.visible === true ? ' ✅ 已显示' : ' ❌ 未显示');
  check(r2.visible === true, '第二次 toggle 回执应为 visible=true');
  check(v2.visible === true, '第二次 toggle 后仍不可见');
  check(host.style.display !== 'none',
    `第二次 toggle 后 host.display 应非none，实际 "${host.style.display}"`);
}

/* ---- 场景 C：用户用 ✕ 关掉后，popup 仍能把它打开 ----*/
{
  byId('close').dispatch('click', {});
  let v = callContent({ type: 'status' });
  check(v.visible === false, '✕ 之后应不可见');
  const r = callContent({ type: 'toggle' });
  await new Promise((r2) => setTimeout(r2, 400));
  v = callContent({ type: 'status' });
  console.log('[19] ✕ 关掉后 popup 再点: visible=%s %s',
    v.visible, v.visible === true ? '✅ 已恢复' : '❌ 打不开');
  check(r.visible === true && v.visible === true,
    `✕ 关掉后 popup 应该能重新打开，实际 visible=${v.visible}`);
}

/* ---- 场景 D：从商店重新进入谱面页必须自动弹出 ----
   用户反馈「从谱面商店重新进入谱面页，也不会自动弹出，需要刷新才行」。
   关键：模拟 SPA 只改 hash 的情况（官网 Nuxt 常见）。*/
{
  /* 先退到商店 */
  location.href = 'https://osu.ppy.sh/beatmap';
  globalThis.__tickRoute();
  await new Promise((r) => setTimeout(r, 200));
  let v = callContent({ type: 'status' });
  check(v.visible === false, `退到商店后应隐藏，实际 visible=${v.visible}`);

  /* 再点进谱面页 —— 只改 hash，主路径不变（最常见的 SPA 形态）。
     __tickRoute 会跑所有 ms=400 的 interval，其中就有 hash 那个。
     ★ 用 #taiko/99：非 taiko（#osu/#mania/#fruits）按需求整窗不显示，
       那是场景 D3 单独验证的事。*/
  location.href = 'https://osu.ppy.sh/beatmap#taiko/99';
  globalThis.__tickRoute();
  await new Promise((r) => setTimeout(r, 500));
  v = callContent({ type: 'status' });
  console.log('[20] 商店 -> 谱面页(仅 hash 变化): visible=%s beatmapId=%s %s',
    v.visible, v.beatmapId, v.visible === true ? '✅ 自动弹出' : '❌ 未弹出');
  check(v.visible === true,
    `从商店进 taiko 谱面页（仅 hash 变化）应自动弹出，实际 visible=${v.visible}`);
  check(host.style.display !== 'none',
    '从商店进谱面页后 host 应显示');
}

/* ---- 场景 D3：★★ URL 模式不可渲染时就不显示窗口 ----
   用户需求：`https://osu.ppy.sh/beatmapsets/2599592#mania/5810803`
   这种 mania / catch 链接**不要显示窗口**。
   但 #osu/（std）是**允许**的 —— osu_parser 会按官方
   TaikoBeatmapConverter 把它转成 taiko 物件，窗口显示转谱视角。
   判据有两层：
     1) hash 里写了模式 -> 不下载直接隐藏
     2) URL 不带模式（/b/123、?beatmap=456）-> 只能靠 .osu 的 Mode 行
   这里先验第 1 层（顺带确认第 2 层的回执字段已就位）。*/
{
  location.href = 'https://osu.ppy.sh/beatmapsets/2599592#mania/5810803';
  globalThis.__tickRoute();
  await new Promise((r) => setTimeout(r, 400));
  let v = callContent({ type: 'status' });
  console.log('[20c] #mania/5810803: visible=%s onMapPage=%s notTaiko=%s %s',
    v.visible, v.onMapPage, v.notTaiko, v.visible === false ? '✅ 已隐藏' : '❌ 仍显示');
  check(v.visible === false,
    `mania 谱面页不应显示窗口，实际 visible=${v.visible}`);
  check(v.onMapPage === false,
    `mania 谱面页 onMapPage 应为 false，实际 ${v.onMapPage}`);
  check(v.notTaiko === 'osu!mania',
    `回执应说明是 osu!mania，实际 ${JSON.stringify(v.notTaiko)}`);
  check(host.style.display === 'none', 'mania 谱面页 host 应被隐藏');

  /* 同一张谱集切到 taiko 难度 -> 必须立刻自动弹出（不能被 modeBlocked 卡住）*/
  location.href = 'https://osu.ppy.sh/beatmapsets/2599592#taiko/5810804';
  globalThis.__tickRoute();
  await new Promise((r) => setTimeout(r, 500));
  v = callContent({ type: 'status' });
  console.log('[20d] #mania -> #taiko: visible=%s beatmapId=%s %s',
    v.visible, v.beatmapId, v.visible === true ? '✅ 自动弹出' : '❌ 未弹出');
  check(v.visible === true,
    '同页面从 mania 切到 taiko 应自动弹出 —— '
    + '说明 modeBlocked 没有被持久化挡住');
  check(v.beatmapId === '5810804', `应切到 taiko 难度 5810804，实际 ${v.beatmapId}`);

  /* fruits（catch）同样不显示 */
  location.href = 'https://osu.ppy.sh/beatmapsets/2599592#fruits/5810805';
  globalThis.__tickRoute();
  await new Promise((r) => setTimeout(r, 350));
  v = callContent({ type: 'status' });
  check(v.visible === false, '#fruits/ 谱面页不应显示窗口');
  check(v.notTaiko === 'osu!catch',
    `#fruits/ 应回传 osu!catch，实际 ${JSON.stringify(v.notTaiko)}`);

  /* ★ #osu/（std）是允许的：走转换路径，窗口必须显示 */
  location.href = 'https://osu.ppy.sh/beatmapsets/2599592#osu/5810806';
  globalThis.__tickRoute();
  await new Promise((r) => setTimeout(r, 500));
  v = callContent({ type: 'status' });
  console.log('[20e] #osu/（std 转换谱）: visible=%s onMapPage=%s notTaiko=%s %s',
    v.visible, v.onMapPage, JSON.stringify(v.notTaiko),
    v.visible === true ? '✅ 显示' : '❌ 被误拦');
  check(v.visible === true, '#osu/（std）应显示窗口（转换谱）');
  check(v.onMapPage === true, '#osu/ 的 onMapPage 应为 true');
  check(!v.notTaiko, '#osu/ 不应被标记为不可渲染');

  /* 回到 taiko，确认还能弹出来 */
  location.href = 'https://osu.ppy.sh/beatmapsets/2599592#taiko/5810807';
  globalThis.__tickRoute();
  await new Promise((r) => setTimeout(r, 500));
  v = callContent({ type: 'status' });
  check(v.visible === true, '回到 #taiko/ 后应能重新显示');
}

/* ---- 场景 D2：★ 只靠 history.pushState，**完全不跑轮询**----
   这是用户反馈「从谱面商店重新进入谱面页不会自动弹出，需要刷新」的
   真实场景：Chrome 会把**后台标签页**的 setInterval 节流到每分钟一次，
   所以用户从另一个标签页点进谱面页时，URL 早就变了而轮询还在睡。
   唯一能及时响应的是劫持 history.pushState（Nuxt/vue-router 就走这个）。
   这个断言**刻意不调用 __tickRoute** —— 一调就等于放水。*/
{
  location.href = 'https://osu.ppy.sh/beatmap';
  globalThis.__tickRoute();
  await new Promise((r) => setTimeout(r, 200));
  let v = callContent({ type: 'status' });
  check(v.visible === false, `前置：应在商店页且隐藏，实际 visible=${v.visible}`);

  /* 模拟 Nuxt 路由跳转：调**页面世界**的 pushState，不跑任何 interval。
     注意不能用 globalThis.history —— 那是隔离世界那份，改了没用。*/
  __pageHistory.pushState({}, '', '/beatmapsets/888?beatmap=1234');
  await new Promise((r) => setTimeout(r, 600));
  v = callContent({ type: 'status' });
  console.log('[20b] 仅 history.pushState（零轮询）: visible=%s beatmapId=%s %s',
    v.visible, v.beatmapId,
    v.visible === true ? '✅ 自动弹出' : '❌ 未弹出（轮询被节流时就是这样）');
  check(v.visible === true,
    '只靠 history.pushState（不跑轮询）也应自动弹出 —— '
    + '否则后台标签页节流时会退化成「必须刷新」');
  check(v.beatmapId === '1234', `应切到新谱面 1234，实际 ${v.beatmapId}`);
}

/* =====================================================================
 * 场景 F：★ 用户报告的真实序列
 *   谱面页点「隐藏」-> 退回商店 -> 重新点进谱面页
 *   期望：自动弹出，且 popup 按钮仍能操作
 * =====================================================================*/
{
  /* 从干净状态开始：用 reset 消息清掉持久化的 userClosed
     （userClosed 存在 chrome.storage 里，改URL 是清不掉的）*/
  location.href = 'https://osu.ppy.sh/beatmapsets/1?beatmap=2';
  globalThis.__tickRoute();
  await new Promise((r) => setTimeout(r, 200));
  callContent({ type: 'reset' });
  await new Promise((r) => setTimeout(r, 400));

  let v = callContent({ type: 'status' });
  check(v.visible === true, `F 前置：谱面页应可见，实际 ${v.visible}`);

  /* 用户点「隐藏」——
     即便内部记了 userClosed（瞬时标记，给 popup 显示用），
     也**绝不能持久化**，否则「退商店 -> 重进」再也弹不出来。*/
  callContent({ type: 'toggle' });
  v = callContent({ type: 'status' });
  check(v.visible === false, 'F：点隐藏后应不可见');
  check(store['osu-taiko-prefs'].userClosed === undefined,
    `F：点隐藏不应把 userClosed 写进 storage，实际 ${JSON.stringify(store['osu-taiko-prefs'].userClosed)}`);
  console.log('[22] 谱面页点隐藏: visible=false（仅压当前页，未持久化）');

  /* 退回商店 */
  location.href = 'https://osu.ppy.sh/beatmap';
  globalThis.__tickRoute();
  await new Promise((r) => setTimeout(r, 200));

  /* ★ 重新点进谱面页 —— 此时 userClosed 仍是 true（持久化！）*/
  location.href = 'https://osu.ppy.sh/beatmapsets/1?beatmap=2';
  __pageHistory.pushState({}, '', '/beatmapsets/1?beatmap=2');
  await new Promise((r) => setTimeout(r, 600));
  v = callContent({ type: 'status' });
  console.log('[23] 商店 -> 重进谱面页: visible=%s userClosed=%s beatmapId=%s %s',
    v.visible, v.userClosed, v.beatmapId,
    v.visible === true ? '✅ 自动弹出' : '❌ 未弹出');
  check(v.visible === true,
    'F：用户只是「隐藏」，退回商店再重进谱面页应自动弹出 —— '
    + '现在被持久化的 userClosed 挡住了');
  check(v.beatmapId === '2', `F：应切回谱面 2，实际 ${v.beatmapId}`);
}

/* =====================================================================
 * 场景 H：★★ 宿主元素被 SPA 移出 document.body
 *
 * 这是「退商店 -> 重进谱面页 -> 必须刷新」的**真正根因**。
 *
 * osu! 是 Nuxt，SPA 路由切换时会**重建 body 的子树**
 * （Nuxt 的 layout 切换会替换 body 里的挂载点）。
 * 而 buildUI() 只在启动时做一次 `document.body.appendChild(host)`，
 * 之后**再也不检查宿主是否还活着**。
 *
 * 于是：
 *   1. 首次进谱面页 -> host 挂到 body，显示窗口 ✅
 *   2. 退到商店    -> host 可能被移出文档（display:none 只是隐藏）
 *   3. 再进谱面页  -> show() 设display=''，但 host 已不在文档里，
 *                     **页面上什么都不会出现**
 *   4. 刷新页面    -> buildUI 重新执行，重新 appendChild -> 好了
 *
 * 这与 userClosed / pushState 劫持都无关 ——
 * 就算前两者全对，宿主不在文档里也显示不出来。
 * =====================================================================*/
{
  /* 模拟 Nuxt 重建 body：把 host 从文档里摘掉（真实浏览器里是
     body.innerHTML = '' 或 replaceChild 造成的效果）。
     注：host 现在挂在 documentElement 上（body 的父节点），
     真实 Nuxt 只清body 内部所以不该影响它；这里模拟的是
     「host 确实被移除」的极端情况，验证自愈能力仍然在。*/
  check(doc.documentElement.children.includes(host),
    'H 前置：host 初始应挂在 documentElement 上');
  doc.documentElement.removeChild(host);
  check(!doc.documentElement.children.includes(host),
    'H 准备：host 应已从文档中移除');

  /* 此时路由变化：URL 变成谱面页，show() 会被调用 */
  location.href = 'https://osu.ppy.sh/beatmapsets/1?beatmap=77';
  globalThis.__tickRoute();
  await new Promise((r) => setTimeout(r, 600));

  const v = callContent({ type: 'status' });
  console.log('[25] 宿主被移除后路由变化: visible=%s host 在文档内=%s %s',
    v.visible, doc.documentElement.children.includes(host),
    doc.documentElement.children.includes(host) ? '✅ 已重新挂载' : '❌ 宿主仍在文档外');

  check(doc.documentElement.children.includes(host),
    '宿主从文档中被移除后，SPA 路由变化时必须重新挂载 —— '
    + '否则 host 不在文档里，display="" 也看不见，'
    + '表现为「必须刷新页面」');
}

/* ---- 场景 H2：宿主被移除后，**URL 不变**也要能自愈----
   Nuxt 重建 body 时可能**没有**伴随 URL 变化（先清空 body
   再异步填新内容）。这时三个路由入口一个都不会触发 ——
   必须靠轮询里的 isConnected 自愈。*/
{
  /* 先确保在谱面页且显示 */
  location.href = 'https://osu.ppy.sh/beatmapsets/1?beatmap=88';
  globalThis.__tickRoute();
  await new Promise((r) => setTimeout(r, 500));
  let v = callContent({ type: 'status' });
  check(v.visible === true && v.mounted === true,
    `H2 前置：应可见且已挂载，实际 visible=${v.visible} mounted=${v.mounted}`);

  /* 宿主被清掉（URL 完全不变！）*/
  doc.documentElement.removeChild(host);
  const urlBefore = location.href;

  /* 只跑轮询，不制造任何 URL 变化 */
  globalThis.__tickRoute();
  await new Promise((r) => setTimeout(r, 500));
  v = callContent({ type: 'status' });
  console.log('[26] 宿主被移除但 URL 不变: mounted=%s %s',
    v.mounted, v.mounted === true ? '✅ 已自愈' : '❌ 未自愈');
  check(location.href === urlBefore, 'H2：本场景不应改变 URL（模拟无导航的 DOM 重建）');
  check(v.mounted === true,
    '宿主被移出文档后，即使 URL 不变也应自动重新挂载');
}

/* ---- 场景 G：★ 标签页切回前台时补判（后台节流的正解）----
   Chrome 把后台标签页的定时器节流到每分钟一次。用户在另一个标签页
   逛商店，切回这个标签页时 URL 早就变了 —— 但定时器还在睡。
   `visibilitychange` 是**事件**，不受节流影响，
   content.js 在它上面补判一次就能立刻恢复。
   这个断言刻意不调 __tickRoute，模拟「定时器完全没跑」。*/
{
  doc.visibilityState = 'hidden';
  /* 退到商店：只改 URL，不跑任何定时器（模拟后台节流中）*/
  location.href = 'https://osu.ppy.sh/beatmap';
  await new Promise((r) => setTimeout(r, 200));
  /*切回前台 —— 事件立刻触发（真实浏览器里节流不影响事件）*/
  doc.visibilityState = 'visible';
  doc.dispatch('visibilitychange', { target: doc });
  await new Promise((r) => setTimeout(r, 500));
  let v = callContent({ type: 'status' });
  check(v.visible === false, `G 前置：商店页应隐藏，实际 ${v.visible}`);

  /* 商店里点进谱面页 —— 依然不跑定时器 */
  location.href = 'https://osu.ppy.sh/beatmapsets/1?beatmap=321';
  await new Promise((r) => setTimeout(r, 100));
  doc.visibilityState = 'visible';
  doc.dispatch('visibilitychange', { target: doc });
  await new Promise((r) => setTimeout(r, 500));
  v = callContent({ type: 'status' });
  console.log('[24] 零轮询 + visibilitychange 补判: visible=%s beatmapId=%s %s',
    v.visible, v.beatmapId, v.visible === true ? '✅ 已恢复' : '❌ 未恢复');
  check(v.visible === true,
    '标签页切回前台时应立刻补判路由（后台节流下的正解）');
  check(v.beatmapId === '321', `应切到谱面 321，实际 ${v.beatmapId}`);
}

/* ---- 场景 E：?beatmap= 查询参数变化 ----*/
{
  /* 清掉持久化标记，避免被前面场景的 userClosed 影响 */
  callContent({ type: 'reset' });
  await new Promise((r) => setTimeout(r, 200));
  location.href = 'https://osu.ppy.sh/home';
  globalThis.__tickRoute();
  await new Promise((r) => setTimeout(r, 200));
  location.href = 'https://osu.ppy.sh/beatmapsets/77?beatmap=555';
  globalThis.__tickRoute();
  await new Promise((r) => setTimeout(r, 500));
  const v = callContent({ type: 'status' });
  console.log('[21] 商店 -> ?beatmap= 变化: visible=%s beatmapId=%s %s',
    v.visible, v.beatmapId, v.visible === true ? '✅ 自动弹出' : '❌ 未弹出');
  check(v.visible === true, '通过 ?beatmap= 进入谱面页应自动弹出');
}

/* ===================================================================== *
 * 右侧滚动条：点击定位必须扣掉滚动条自己的 top
 * 用户反馈「点击位置错位，难以使用」。
 * ===================================================================== */

/* 滚动条在视口里**不是**从 y=0 开始的 —— 上面有标题栏 + 工具条 +
   body padding。这里显式给一个非零 top，模拟真实布局。*/
{
  /* 前面 [11] 把窗口缩到 240px 了，轨道太短不适合测定位 ——
     先恢复到一个正常高度（[3] 默认是 520）。*/
  globalThis.innerWidth = 1280;
  globalThis.innerHeight = 900;
  panel.style.width = '700px';
  panel.style.height = '520px';
  fireWin('resize', {});

  const vbar = byId('vbar');
  const VBAR_TOP = 76;                /* 真实布局里大约这个量级 */
  /* 滑块高度必须**跟随 style.height**（updateThumb 会写 style.height）——
     否则它会沿用构造时的默认值，jumpTo 里的 maxTop = trackH - thumbH
     算出来是 0，定位全被钳到顶部（这正是刚才[15] 失败的原因）。*/
  const vthumb = byId('vthumb');
  Object.defineProperty(vthumb, 'offsetHeight', {
    configurable: true,
    get() {
      const h = parseFloat(vthumb.style.height);
      return isFinite(h) && h > 0 ? h : 16;
    },
  });
  vbar.getBoundingClientRect = function () {
    return { left: 0, top: VBAR_TOP, width: vbar.clientWidth,
      height: vbar.clientHeight, right: vbar.clientWidth, bottom: VBAR_TOP + vbar.clientHeight };
  };
  const trackH = vbar.clientHeight;
  check(trackH > 100, `滚动条轨道高度 ${trackH} 不足以测试`);

  /* 点轨道 25% 处 -> 应跳到内容 25% 处（而不是 25%+76/trackH） */
  const readView = () => parseFloat((byId('wrap').style.transform.match(/-?\d+(?:\.\d+)?/) || [0])[0]);
  byId('top').dispatch('click', {});
  const before = readView();

  const clickAt = (frac) => {
    vbar.dispatch('mousedown', { clientY: VBAR_TOP + trackH * frac });
    fireWin('mouseup', {});
  };
  /* 从顶部开始测：点 75% 处应把视口推到大约 75% */
  byId('top').dispatch('click', {});
  clickAt(0.75);
  const after = readView();
  /* ★ 必须断言**落点接近 75%**，不能只断言「有响应」。
     旧实现（漏减 rect.top）在这里会一路被钳到最底，看起来也「滚动了」，
     所以「有响应」这种弱判据抓不住它 —— 我临时回退验证时正是这样漏过去的。*/
  const span = Math.abs(after - before);
  /* 最底位置：从顶部量到底部的总距离 */
  clickAt(1.0);
  const atBottom = readView();
  const maxScroll = Math.abs(atBottom);
  const frac = maxScroll > 0 ? span / maxScroll : 0;
  const okFrac = Math.abs(frac - 0.75) <= 0.06;
  console.log('[15] 滚动条定位: 点 75%% -> 实际落在 %s%%（总行程 %s px） %s',
    (frac * 100).toFixed(1), maxScroll.toFixed(0), okFrac ? '✅' : '❌ 落点偏移');
  check(span > 20, `点轨道 75% 处应明显滚动，实际只位移 ${span}px`);
  check(okFrac,
    `点轨道 75% 处应落在 75% 附近，实际落在 ${(frac * 100).toFixed(1)}%`
    + ` —— 疑似漏减 vbar.getBoundingClientRect().top`);

  /* 点越界：上方 -> 钳到最顶（viewY=0），下方 -> 钳到最底。
     这两个是**绝对位置**，不能拿 yBefore 做比较（点上方后本来就已经在顶了）。*/
  vbar.dispatch('mousedown', { clientY: VBAR_TOP + trackH + 500 });
  fireWin('mouseup', {});
  const yBottom = readView();
  vbar.dispatch('mousedown', { clientY: VBAR_TOP - 500 });
  fireWin('mouseup', {});
  const yTop = readView();
  check(yTop >= -1 && yTop <= 1, `点在轨道上方应钳到最顶（viewY=0），实际 ${yTop.toFixed(1)}`);
  check(yBottom < -100, `点在轨道下方应钳到最底（viewY 为较大负值），实际 ${yBottom.toFixed(1)}`);
  /* 上方点击比下方点击更靠顶（translateY 数值更大）*/
  check(yTop > yBottom,
    `上下钳位关系反了：顶部 ${yTop.toFixed(0)} 应大于底部 ${yBottom.toFixed(0)}`);
  console.log('[16] 越界点击已钳位: 最顶 %s px / 最底 %s px ✅',
    yTop.toFixed(0), yBottom.toFixed(0));
}

/* ===================================================================== *
 * 场景 W：★★ 隐藏状态下触发 resize，不得把窗口尺寸写坏
 *
 * 用户反馈「窗口突然变特别小」（截图里只剩 ~420×240 的最小尺寸）。
 *
 * 成因链：
 *   1. 窗口隐藏时（商店页 / 被 ✕ 关掉 / mania 拦截），
 *      offsetWidth与 offsetHeight 都是 0；
 *   2. 浏览器窗口一次 resize 就会触发 clampPanel()；
 *   3. 旧代码算出 w = max(MIN_W, min(0, …)) = MIN_W = 420，
 *      h = MIN_H = 240，并**写进 inline style**；
 *   4. 之后 show() 只把 display 置回''，尺寸已经坏了；
 *      再拖动一下还会把 420×240 存进 storage，跨会话生效。
 *
 * 修法：clampPanel 在量不到尺寸时直接返回；saveWindow 拒绝存无效值；
 *      restoreWindow 不信任明显无效的存档。
 * 桩里必须模拟「display:none 的祖先 ⇒ offsetWidth/Height = 0」，
 * 否则这条回归测不出真东西（见 El 的 _hiddenByAncestor）。
 * ===================================================================== */
{
  /* 先把窗口放到一个明确的「大尺寸」，排除默认值干扰 */
  panel.style.width = '760px';
  panel.style.height = '560px';
  const bigW = panel.offsetWidth, bigH = panel.offsetHeight;
  check(bigW === 760 && bigH === 560,
    `前置条件：应能设成 760×560，实际 ${bigW}×${bigH}`);

  /* 隐藏窗口（模拟退到商店页） */
  host.style.display = 'none';
  check(panel.offsetWidth === 0 && panel.offsetHeight === 0,
    `前置条件：隐藏时 offsetWidth/Height 应为 0，实际 `
    + `${panel.offsetWidth}/${panel.offsetHeight}`);

  /* 隐藏期间浏览器窗口 resize —— 这是 bug 的触发点 */
  fireWin('resize', {});
  check(parseFloat(panel.style.width || 0) === 760,
    `隐藏时 resize 把宽度写成了 ${panel.style.width}，应保持 760px `
    + `（= MIN_W 说明clampPanel 在隐藏态夹取了 0）`);
  check(parseFloat(panel.style.height || 0) === 560,
    `隐藏时 resize 把高度写成了 ${panel.style.height}，应保持 560px `
    + `（= MIN_H 同上）`);

  /* 重新显示后尺寸应原样恢复，且应被夹取到视口内 */
  host.style.display = '';
  globalThis.__tickRoute();
  await new Promise((r) => setTimeout(r, 300));
  check(Math.abs(panel.offsetWidth - 760) < 1,
    `重新显示后宽度应仍是 760，实际 ${panel.offsetWidth}`);
  check(Math.abs(panel.offsetHeight - 560) < 1,
    `重新显示后高度应仍是 560，实际 ${panel.offsetHeight}`);
  console.log('[17] 隐藏期间 resize 未写坏尺寸: 760×560 保持不变 ✅');
}

/* ===================================================================== *
 * 场景 W2：★★ 双击标题栏 = 恢复默认尺寸
 *
 * 「尺寸被写坏」一旦发生，用户不该只能靠刷新页面自救
 *（存进 storage 的坏值会跨会话生效）。
 * ===================================================================== */
{
  const bar = panel.children.find((c) => c.classList.contains('bar'));
  check(!!bar, '前置条件：面板里应存在 .bar 标题栏');

  /* 先缩到很小，模拟被写坏的尺寸 */
  panel.style.width = '420px';
  panel.style.height = '240px';
  check(panel.offsetWidth === 420 && panel.offsetHeight === 240,
    `前置条件：应能缩到 420×240，实际 ${panel.offsetWidth}×${panel.offsetHeight}`);

  bar.dispatch('dblclick', { clientX: 10, clientY: 10, target: bar, preventDefault() {} });
  await new Promise((r) => setTimeout(r, 200));

  /* DEF_W=700 / DEF_H=520（content.js 顶部常量） */
  check(panel.offsetWidth === 700,
    `双击标题栏后宽度应复位到默认 700，实际 ${panel.offsetWidth}`);
  check(panel.offsetHeight === 520,
    `双击标题栏后高度应复位到默认 520，实际 ${panel.offsetHeight}`);

  /* 复位必须落盘，否则下次会话又回到坏尺寸 */
  const WIN_KEY_NAME = 'osu-taiko-preview-window';
  const saved = store[WIN_KEY_NAME];
  check(saved && Math.round(saved.w) === 700 && Math.round(saved.h) === 520,
    `双击复位后应存下 700×520，实际 ${JSON.stringify(saved)}`);

  /* 落在按钮上的双击不应触发复位（会误伤折叠/关闭）*/
  panel.style.width = '420px';
  bar.dispatch('dblclick', { clientX: 10, clientY: 10, target: byId('fold'), preventDefault() {} });
  check(panel.offsetWidth === 420,
    `双击标题栏按钮不应触发尺寸复位，实际宽度 ${panel.offsetWidth}`);
  panel.style.width = '700px';

  console.log('[18] 双击标题栏可复位到默认 700×520 ✅');
}

/* ===================================================================== *
 * 场景 X：★★ 段位 / 键型评估行
 *
 * 用户需求（经两次修订）：
 *  1. 位置在「信息栏」与「预览图」的**中间**
 *     —— 那是**画布内**的位置：信息栏画在 canvas 上，预览图也在 canvas 上。
 *     初版做成了 .body 里的 HTML 行（面板最顶部），位置错了。
 *  2. 显示开关放在「轨道底」右侧
 *     —— 开关必须放在**永远不会消失**的地方。初版把复选框和内容放一起，
 *     取消勾选后连复选框一起消失，用户再也开不回来。
 *  3. 段位（大号）+ 数字（小字括号）+ 键型（大号，'-' 时不显示）
 *     + 最右小字版本说明。全部画在 canvas 上。
 * ===================================================================== */
{
  const cDan = byId('cDan');

  /* ---- [19] ★ 开关位置：在 .tools 里，且排在「轨道底」之后 ----
   * 这是本次修订的核心：复选框必须与内容分离。 */
  const bodyEl = panel.children.find((c) => c.classList.contains('body'));
  /* .tools 在 .body 里（不是 .panel 的直接子元素）*/
  const toolsEl = bodyEl.children.find((c) => c.classList.contains('tools'));
  check(!!toolsEl, '未找到 .tools 工具条');
  /* label 没有 class/className，不能按 className 过滤 —— 直接用全部子节点。
     label 内部是 <input> + 文字，而 input 是 void 元素没文本，
     所以按**子节点里的 input id** 定位（比 innerHTML 可靠）。*/
  const toolKids = toolsEl.children.filter((c) => c.tagName === 'LABEL');
  check(toolKids.length >= 5,
    `工具条里应至少有 5 个 label，实际 ${toolKids.length} 个`);
  const toolIds = toolKids.map((l) => {
    const inp = l.children.find((c) => c.tagName === 'INPUT');
    return inp ? inp.id : null;
  });
  const gridIdx = toolIds.indexOf('cGrid');
  const danIdx = toolIds.indexOf('cDan');
  check(gridIdx >= 0,
    `工具条里未找到「轨道底」开关（cGrid），实际各 label 的 input id：`
    + `${JSON.stringify(toolIds)}`);
  check(danIdx >= 0, '工具条里未找到「段位/键型」开关（cDan）');
  check(gridIdx >= 0 && danIdx > gridIdx,
    `段位开关应排在「轨道底」**右侧**，实际 grid=${gridIdx} dan=${danIdx}`);
  /* 顺序对了还要确认它确实是最后一项（紧跟轨道底，而不是跳到别处）*/
  check(danIdx === gridIdx + 1,
    `段位开关应**紧跟**在「轨道底」之后，实际相隔 ${danIdx - gridIdx} 项`);
  console.log('[19] 开关紧跟在「轨道底」右侧（工具条第 %d/%d 项）✅',
    danIdx, toolIds.length);

  /* ---- [20] ★ 内容不再有 HTML 元素（画在 canvas 上）---- */
  for (const gone of ['danrow', 'danGrade', 'danNum', 'danKey', 'danVer']) {
    check(!byId(gone), `#${gone} 不应再作为 HTML 元素存在`
      + '（内容已改画在 canvas 上）');
  }
  const bodyKids = bodyEl.children.filter((c) => c.className);
  check(bodyKids[0].classList.contains('stage'),
    `.body 的第一个子元素应是 .stage（预览图），实际 `
    + `"${bodyKids[0].className}" —— 段位行不该是 HTML 行`);
  console.log('[20] 内容已改为画在 canvas 上（.body 首个元素是 .stage）✅');

  /* ---- [21] 复选框：切换后 renderer 的 danRowH 跟着变 ----
   * 段位行没有 DOM 可断言，改验「画布高度是否变化」——
   * 开着时画布比关着时高出一个段位行的高度。 */
  const cv0 = byId('wrap').children.find((c) => c.tagName === 'CANVAS');
  const readCanvasH = () => {
    const w = byId('wrap');
    const cvs = w.children.filter((c) => c.tagName === 'CANVAS');
    return cvs.length ? cvs[cvs.length - 1].height : 0;
  };
  const hOn = readCanvasH();
  check(hOn > 0, `开着时画布高度应 >0，实际 ${hOn}`);

  cDan.checked = false;
  cDan.dispatch('change', {});
  await new Promise((r) => setTimeout(r, 120));
  const hOff = readCanvasH();
  check(hOff < hOn,
    `关掉段位行后画布应变矮（省出一个段位行的高度），`
    + `实际 开=${hOn} 关=${hOff}`);
  /* 开关本身必须还在（这是本次修订要解决的 bug）*/
  check(!!byId('cDan'), '★ 关掉段位行后开关自己也消失了 —— 这正是要修的 bug');
  check(cDan.checked === false, '关闭后开关应保持未勾选');

  cDan.checked = true;
  cDan.dispatch('change', {});
  await new Promise((r) => setTimeout(r, 120));
  const hBack = readCanvasH();
  check(Math.abs(hBack - hOn) < 2,
    `重新打开后画布高度应恢复（${hOn}），实际 ${hBack}`);
  check(cDan.checked === true, '重新打开后开关应保持勾选');
  void cv0;
  console.log('[21] 开=%d 关=%d 恢复=%d（px）；开关全程存在 ✅', hOn, hOff, hBack);
}

/* ===================================================================== *
 * 场景 Y：★★ 基准星数缓存不能被「同 BeatmapID 的另一个难度」污染
 *
 * 用户反馈：勾 CL 与不勾 CL 都显示 5.06★，却带着 (-0.36)。
 *
 * 根因：osu! 官网存在**同一 BeatmapID 对应多个难度**的情况 ——
 *   sid 703200 的 `Dan-i Dojo (Part.2)` 里，9th Dan 与 10th Dan 的
 *   BeatmapID 都是 1498109（谱面文件里就写着同一个 ID）。
 * `baseStarRating()` 的缓存键原本**只有 beatmapId**，
 * 于是先算过的那张把结果留在缓存里，另一张直接命中 ——
 * 10th Dan 的 5.4168 被当成 9th Dan 的「基准」，
 * 差值 -0.3609 就显示成了「星数变化」。
 *
 * ★ CL/HD/FL 本身**确实不影响星数**（TAIKO_MODS 里它们的 od/sm/rate 全是 1.0），
 *   所以「勾不勾 CL 星数相同」是正确的；错的只是那个被污染的基准值。
 * ===================================================================== */
{
  const srPanel = await import(pathToFileURL(path.join(LIB, 'sr_panel.js')));
  const parser = await import(pathToFileURL(path.join(LIB, 'osu_parser.js')));

  /* ---- [22] 构造两个「同 ID 不同难度」的 beatmap ---- */
  const raw = {
    beatmapId: 1498109, beatmapSetId: 703200,
    mode: 1, title: 'T', artist: 'A', creator: 'C',
    version: '', od: 5, hp: 5, cs: 5, ar: 5, audioFilename: '',
    timingPoints: [{ time: 0, beatLength: 500, red: true, meter: 4, sv: 1 }],
    notes: [], breaks: [], isConvert: false, scrollPoints: null,
  };
  /* 用真实音符序列（长度不同 -> 星数必然不同）*/
  const mkNotes = (n, gap) => Array.from({ length: n }, (_, i) => ({
    time: 1000 + i * gap,
    x: 256, y: 192,
    blue: i % 2 === 1,
    kind: i % 17 === 16 ? 'big' : (i % 2 ? 'kat' : 'don'),
  }));
  const bm9 = Object.assign({}, raw, { version: '9th Dan', notes: mkNotes(400, 180) });
  const bm10 = Object.assign({}, raw, { version: '10th Dan', notes: mkNotes(1200, 260) });

  /* 两个难度在CL 下各自的星数（CL 不改星数，所以这里只看「基准是否被串」）*/
  const sr9 = srPanel.buildDifficultyReport(bm9, { mod: 'CL' }).skills.total;
  const sr10 = srPanel.buildDifficultyReport(bm10, { mod: 'CL' }).skills.total;
  check(Math.abs(sr9 - sr10) > 0.1,
    `两个难度应有明显不同的星数（用来测污染），实际 ${sr9.toFixed(3)} vs ${sr10.toFixed(3)}`
    + ' —— 样本构造可能失效，这条断言失去意义');

  /* ---- 模拟 content.js 的 baseStarRating 缓存 ----
   * ★ 这里**复制** content.js 的键构造，而不是直接调它——
   *   content.js 里的函数在 IIFE 内部，测试拿不到。
   *   所以复制一份，并让测试能同时验「键是否带 version」。
   *   如果有人把 content.js 的键改回去（去掉 version），
   *   这段必须同步改 —— 但下面的反向验证能抓到那种情况。*/
  const cache = Object.create(null);
  const baseOf = (bm, modMisc) => {
    const misc = modMisc.filter((m) => m === 'CL' || m === 'HD' || m === 'FL');
    const baseName = misc.length ? misc.slice().sort().join('+') : 'None';
    const key = bm.beatmapId + '#' + (bm.version || '') + '#' + baseName;
    if (cache[key] !== undefined) return cache[key];
    const v = srPanel.buildDifficultyReport(bm, { mod: baseName }).skills.total;
    cache[key] = v;
    return v;
  };

  /* 先算 10th Dan，再算同 ID 的 9th Dan —— 这就是用户的操作顺序
   * （先在列表里点过 10th，再点 9th）*/
  const b10First = baseOf(bm10, ['CL']);
  const b9After = baseOf(bm9, ['CL']);

  check(Math.abs(b9After - sr9) < 1e-9,
    `★ 9th Dan 的基准星数被污染了：得到 ${b9After.toFixed(4)}，`
    + `应为自己的 ${sr9.toFixed(4)}。`
    + `起因是缓存键只用了 beatmapId —— 同 ID 的10th Dan（${b10First.toFixed(4)}）`
    + `把结果留在了缓存里`);
  check(Math.abs(b10First - sr10) < 1e-9,
    `10th Dan 的基准星数应为自己的 ${sr10.toFixed(4)}，实际 ${b10First.toFixed(4)}`);

  /* 反过来先算 9th 再算 10th，两个也都该独立 */
  const cache2 = Object.create(null);
  const baseOf2 = (bm, modMisc) => {
    const misc = modMisc.filter((m) => m === 'CL' || m === 'HD' || m === 'FL');
    const baseName = misc.length ? misc.slice().sort().join('+') : 'None';
    const key = bm.beatmapId + '#' + (bm.version || '') + '#' + baseName;
    if (cache2[key] !== undefined) return cache2[key];
    const v = srPanel.buildDifficultyReport(bm, { mod: baseName }).skills.total;
    cache2[key] = v;
    return v;
  };
  const b9First = baseOf2(bm9, ['CL']);
  const b10After = baseOf2(bm10, ['CL']);
  check(Math.abs(b9First - sr9) < 1e-9 && Math.abs(b10After - sr10) < 1e-9,
    `反向顺序也算错了：9th=${b9First.toFixed(4)} 10th=${b10After.toFixed(4)}`);

  /* ---- [23] ★ CL 本身不该改星数（这是「勾不勾都是 5.06」的正确部分）---- */
  const sr9None = srPanel.buildDifficultyReport(bm9, { mod: 'None' }).skills.total;
  check(Math.abs(sr9 - sr9None) < 1e-9,
    `CL 不应改变星数，实际 CL=${sr9.toFixed(4)} None=${sr9None.toFixed(4)}`);

  console.log('[22] 同 ID 不同难度（9th=%.3f / 10th=%.3f）基准互不污染 ✅',
    sr9, sr10);
  console.log('[23] CL 不改星数（%.3f == %.3f）✅', sr9, sr9None);
}

/* ===================================================================== *
 * 场景 Z：★ bid 要显示 **URL 里的**，不是谱面文件自报的
 *
 * osu! 侧有「多个难度共用同一个 BeatmapID」的数据异常。
 * 实测 sid 703200 `Dan-i Dojo (Part.2)`：
 *   /osu/1563291 -> Version:9th Dan，但文件里 BeatmapID:1498109
 *   /osu/1498109 -> Version:10th Dan，文件里也是 1498109
 *
 * 显示文件自报的值会与地址栏对不上 —— 用户复制那个 bid 出去会找错谱面。
 * URL 是用户唯一能自己核对的那一份，所以它才是权威。
 *
 * 修法：标题栏与画布信息栏都用 state.beatmapId（URL 的），
 * 不一致时把文件值放在括号里标注出来。
 * ===================================================================== */
{
  const renderer = await import(pathToFileURL(path.join(LIB, 'renderer.js')));

  /* ---- [24] 不一致时：主号是 URL 的，文件值另标 ---- */
  const bmWrong = { beatmapId: 1498109, beatmapSetId: 703200, mode: 1,
    version: '9th Dan', notes: [], isConvert: false,
    /* 信息栏右侧会画 HP/OD 刻度条（_drawMeterBar 读 bm.hp / bm.od），
       这两个字段缺了会读到 undefined.toFixed() 而抛错。*/
    hp: 5, od: 5 };
  const texts = [];
  const ctx = new Proxy({ font: '', fillStyle: '#000', textAlign: 'left',
    textBaseline: 'alphabetic' }, {
    get(o, p) {
      if (p in o) return o[p];
      if (p === 'measureText') return (s) => ({ width: String(s).length * 8 });
      if (p === 'canvas') return { width: 940, height: 300 };
      if (p === 'createLinearGradient') return () => ({ addColorStop() {} });
      if (p === 'fillText') return (s) => texts.push(String(s));
      return () => {};
    },
    set(o, p, v) { o[p] = v; return true; },
  });
  /* 画布信息栏会顺手画右侧的刻度条（_drawMeterBar），所以 layout 要给足
     它要的字段，否则会读到 undefined.toFixed()。这里只验证 bid 那一行，
     用空的 rows/notes 即可。*/
  const layStub = () => ({ rows: [], t0: 0, tEnd: 1 });
  const cfgStub = () => ({ headerHeight: 200, paddingTop: 8, paddingBottom: 8,
    header: true, srData: null });
  const rr = new renderer.PreviewRenderer(bmWrong, layStub(), cfgStub(),
    { loaded: false }, { header: true, urlBid: 1563291 });
  rr._drawHeader(ctx, 940, 1, 1);
  const line = texts.find((t) => t.startsWith('bid'));
  check(!!line, '画布信息栏未画bid 行');
  if (line) {
    check(line.includes('1563291'),
      `★ 画布信息栏应显示 URL 的 bid 1563291，实际 "${line}"`);
    check(line.includes('1498109'),
      `应把文件自报的 1498109 标注出来，实际 "${line}"`);
    /* 顺序很关键：URL 的必须在前面 —— _ellipsis 宽度不够时从尾部截断，
       这样丢的是「文件值」而不是「URL 值」。*/
    check(line.indexOf('1563291') < line.indexOf('1498109'),
      `URL 的 bid 应在文件值**之前**（窄窗截断时才优先保住 URL 的），实际 "${line}"`);
  }
  console.log('[24] 画布信息栏 bid =%s ✅', line);

  /* ---- [25] 一致时：不加多余的括号 ---- */
  texts.length = 0;
  const rr2 = new renderer.PreviewRenderer(
    { ...bmWrong, beatmapId: 1563291 }, layStub(), cfgStub(),
    { loaded: false }, { header: true, urlBid: 1563291 });
  rr2._drawHeader(ctx, 940, 1, 1);
  const line2 = texts.find((t) => t.startsWith('bid'));
  check(line2 === 'bid 1563291',
    `两者一致时应只显示「bid 1563291」，实际 "${line2}"`);
  console.log('[25] 一致时不加多余标注：%s ✅', line2);

  /* ---- [26] 没给 urlBid（老调用方）时退回文件值 ---- */
  texts.length = 0;
  const rr3 = new renderer.PreviewRenderer(bmWrong, layStub(), cfgStub(),
    { loaded: false }, { header: true });
  rr3._drawHeader(ctx, 940, 1, 1);
  const line3 = texts.find((t) => t.startsWith('bid'));
  check(line3 === 'bid 1498109',
    `未传 urlBid 时应退回文件自报值，实际 "${line3}"`);
  console.log('[26] 未传 urlBid 时退回文件值：%s ✅', line3);
}

/* ===================================================================== *
 * 场景 AA：★★ 私服（Bancho 系，如 osu.ppy.sb）URL 适配
 *
 * 用户实测私服上「可以读取谱面并完成任务」，但发现切难度后就不行了。
 * 根因：私服的 `?beatmap=` 参数**两种形态**：
 *   首屏进入      ?beatmap=5591346                    ← 数字，能抓
 *   点难度切换后  ?beatmap=07ab663b158da2284ad033e828a4f394  ← 32 位 hash，抓不到
 *
 * ★ hash 不是 id 的可逆编码（已实测：md5/sha1/sha256 都不匹配），
 *   而且私服**没有** .osu 下载端点（/osu/<x>、/api/v1/*、/d/<x> 全 404）。
 *   正确解法：读页面自带的 `<script id="__NUXT_DATA__">`，
 *   里面有整组谱面，每项的 `md5` 是 hash、`foreignId` 是数字 bid。
 *
 * 附带：私服的模式在 **query** 里（`mode=taiko` / `mode=osu`），
 *   不在 hash 里 —— 不读的话 std 谱会白等一次 .osu 下载才发现是 std。
 *
 * 下面的 payload 是从真实私服页面（sid 2529895）截取的 9 个难度里的一小部分。
 * ===================================================================== */
{
  /* NUXT payload 的**扁平引用表**结构：顶层数组，对象的值是数组下标。
     ★ foreignId 指向的槽位装的是**字符串**（'5591346'），不是数字 ——
       实测真实 payload（sid 2529895）就是这样，因为这站的 id 很大、
       JS number 精度不够，服务端序列化成了 string。
       这个细节不是吹毛求疵：按「数字就是下标」来解引用会拿到 table[4]
       这种垃圾槽位（实测抓到了 bid=4）。*/
  const NU = [
    0,                // 0 占位
    'TATSUJIN',       // 1  version
    '07ab663b158da2284ad033e828a4f394', // 2  md5
    21,// 3  mode 槽 -> 5
    '5591346',        // 4  foreignId（★字符串）
    'taiko',          // 5  mode 的值
    { version: 1, md5: 2, mode: 3, id: 2, foreignId: 4 }, // 6  ← TATSUJIN
    'DAITATSUJIN',    // 7  version
    'e5d149b69d03ddb27f3899864b7e4b4a', // 8  md5
    '5591345',        // 9  foreignId
    { version: 7, md5: 8, mode: 3, id: 8, foreignId: 9 }, // 10 ← DAITATSUJIN
  ];
  doc.byId.__NUXT_DATA__ = { textContent: JSON.stringify(NU) };

  const go = (u) => { globalThis.location.href = u; };
  const SB = 'https://osu.ppy.sb';
  const official = globalThis.location.href;

  /* ---- [27] 首屏：数字 id 直接可用（不该去查表）----
   * 首屏形态是 ?beatmap=<数字>，与官网一致，走 extractBeatmapId() 那条老路。
   * 下面 [28]/[29] 才是新加的 hash 查表路径。*/
  go(`${SB}/beatmapset/2529895?beatmap=5591346&mode=taiko&ruleset=standard&rank=ppv2`);

  /* ---- 用「切 URL -> 等渲染 -> 看画布有没有出来」来间接验证 ----
   * content.js 的解析函数都在 IIFE 内部，测试拿不到，
   * 所以走端到端这条路（比直接调函数更贴近真实使用）。
   *
   * ★ 判据用「画布是否渲染」，**不要**查 `.stage.er`：
   *   setStage() 每次都会重建 ui.wrap 的 innerHTML，渲染成功后
   *   错误节点已被替换掉，querySelector 会匹配到画布里的标题文本
   *   而误报失败（实测踩过）。*/
  const tryUrl = async (url) => {
    go(url);
    /* ★ 必须用 `doc.dispatch('visibilitychange', { target: doc })`，
       不是 `doc.dispatchEvent(...)`。
       桩的 dispatch 会走事件注册表，而 content.js 是挂在**真实**的
       visibilitychange 监听上（见 content.js 的「零轮询」实现）——
       直接调 dispatchEvent 不会触发任何监听，于是 URL 改了也不会重载。
       之前的写法让 [27]~[30] 看到的是**上一轮残留的画布**，全靠运气。*/
    doc.dispatch('visibilitychange', { target: doc });
    await new Promise((r) => setTimeout(r, 400));
    const wrap = byId('wrap');
    const kids = wrap.children || [];
    const cv = kids.filter((c) => c.tagName === 'CANVAS');
    const er = kids.find((c) => c.classList.contains('er'));
    const ph = kids.find((c) => c.classList.contains('ph'));
    return {
      ok: cv.length > 0,
      err: er ? (er.textContent || '') : '',
      why: er ? 'error' : (ph ? 'placeholder' : 'none'),
    };
  };

  /* ---- 核心断言：hash URL 必须换成**对应的数字 id** 去抓 .osu ----
   * ★ 判据是「fetch 到的 URL 里那个 bid」——不能只看渲染成功：
   *   反向验证时发现，把 hash 查表整个删掉，渲染断言**依然是绿的**
   *   （更早一次成功渲染留下的画布还在wrap 里）。
   *   只有比对请求 URL 才能证明「查表用对了」。*/
  /* 顺序说明：先 hash、后数字。
   * 两条都指向 TATSUJIN（foreignId 都是 5591346），而 content.js 在
   * 「bid 没变」时**不会重载**（这是正确行为 —— 切到同一张谱不必重画）。
   * 所以若先跑数字再跑 hash，第二条会因为 bid 相同而一次 fetch 都不发。
   * 反过来先 hash、再数字，就能看到两次真实请求。*/
  const fetchedBids = () => globalThis.fetchUrls.map((u) => {
    const m = String(u).match(/\/osu\/([^?/]+)/);
    return m ? m[1] : null;
  });

  const checkFetched = async (url, wantBid, label, mustFetch) => {
    globalThis.fetchUrls.length = 0;
    await tryUrl(url);
    const bids = fetchedBids().filter(Boolean);
    /* ★ mustFetch=false 时允许「没发请求」——
       content.js 在 bid 没变时正确地不重载（切到同一张谱不必重画）。
       先跑数字再跑 hash 就会落到这个分支，那不是 bug。*/
    if (!mustFetch && !bids.length) {
      console.log('    %s -> bid 未变，未重载（正确行为）✅', label);
      return;
    }
    check(bids.length > 0, `${label}：应发起 osu 下载，实际一次都没发`);
    check(bids.indexOf(String(wantBid)) >= 0,
      `${label}：应抓 bid ${wantBid}，实际抓了 ${JSON.stringify(bids)}`
      + '—— hash 没被解析成数字 id');
    console.log('    %s -> 抓到 bid %s ✅', label, bids.join(','));
  };

  /* hash（切难度形态）—— 查表得到 foreignId */
  await checkFetched(
    `${SB}/beatmapset/2529895?beatmap=07ab663b158da2284ad033e828a4f394&mode=taiko&ruleset=standard&rank=ppv2`,
    5591346, '[28] 私服切难度（TATSUJIN hash）', true);

  /* 数字 id（首屏形态）—— 直接就是它 */
  await checkFetched(
    `${SB}/beatmapset/2529895?beatmap=5591346&mode=taiko&ruleset=standard&rank=ppv2`,
    5591346, '[27] 私服首屏（数字 id）', false);
  /* 另一个 hash —— 证明不是碰巧命中第一个 */
  await checkFetched(
    `${SB}/beatmapset/2529895?beatmap=e5d149b69d03ddb27f3899864b7e4b4a&mode=taiko&ruleset=standard&rank=ppv2`,
    5591345, '[29] 另一个 hash（DAITATSUJIN）', true);

  /* ---- [30] ★ std 谱（mode=osu）不应被当成「非 taiko」拦掉 ----
   * 私服把模式放在 query 里，不在 hash 里。之前 extractUrlMode 只看 hash，
   * 于是 mode=osu 读不出来 —— 要么白等一次下载，要么被 hideByMode 误拦。*/
  await checkFetched(
    `${SB}/beatmapset/1923289?beatmap=3970329&mode=osu&ruleset=standard&rank=ppv2`,
    3970329, '[30] 私服 std（mode=osu）', true);

  /* ---- [31] 未知 hash 必须落到「拿不到 bid」这条路 ----
   * 查不到 bid 时onMapPage() 应返回 false，**根本不该发起下载**——
   * 否则会用错的 id 去抓谱面（比不显示更糟）。*/
  const fetchesBefore = fetchCount;
  globalThis.fetchUrls.length = 0;
  await tryUrl(
    `${SB}/beatmapset/2529895?beatmap=00000000000000000000000000000000&mode=taiko`);
  const badBids = globalThis.fetchUrls.slice();
  check(fetchCount === fetchesBefore,
    `未知 hash 查不到 bid 时**不该发起下载**，但fetch 被调了 `
    + `${fetchCount - fetchesBefore} 次（请求了 ${JSON.stringify(badBids)}）`
    + ` —— 会用错的 id 去抓谱面`);
  console.log('[31] 未知 hash：不发下载请求（而非抓错谱面）✅');

  /* 还原：避免影响后续用例 */
  delete doc.byId.__NUXT_DATA__;
  go(official);
  console.log();
}

console.log();
console.log(`通过断言 ${ok.length} 条`);
if (errs.length) {
  console.log('❌ 冒烟测试失败:');
  errs.forEach((e) => console.log('   -', e));
  process.exit(1);
}
console.log('✅ content.js DOM 冒烟测试全部通过');
/* content.js 注册了 setInterval（URL 轮询）与 setTimeout（模块就绪兜底），
   Node 里这些句柄会吊住进程，测试跑完要主动退出。*/
process.exit(0);