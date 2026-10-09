/**
 * osu!taiko 谱面预览器 —— content script
 *
 * 在 osu! 谱面页面右下角注入一个可拖动 / 可缩放的小窗口：
 *   - 从 URL 提取 beatmap ID
 *   - 下载官方裸 .osu（https://osu.ppy.sh/osu/{bid}）
 *   - 解析 -> 布局 -> 渲染整首预览 canvas
 *   - 画布比窗口高，靠「窗口内拖动 / 滚轮 / 右侧缩略条」查看任意位置
 *
 * 设计要点：
 *   1. 样式全部放进 Shadow DOM，避免与官网 CSS 互相污染。
 *   2. osu! 官网是 SPA（Turbo/Nuxt），路由变化不重载页面，
 *      所以用 MutationObserver + URL轮询双重检测谱面切换。
 *   3. 谱面文本按 bid 缓存，避免来回切难度时重复下载。
 *   4. 不做播放：官网音频接口需要OAuth，匿名拿不到，
 *      无音频的「播放」没有意义，所以整条播放链路（播放线/进度条/
 *      本地音频）都去掉了，只保留静态预览 + 拖动查看。
 */

(function () {
  'use strict';

  var HOST_ID = 'osu-taiko-preview-host';

  /* 窗口默认尺寸（px）——刻意做得小，避免遮住官网内容。
   这两个值与下面 CSS .panel 的 width/height 保持一致。 */
  /* 默认尺寸。用户反馈「适当拉长窗口（上下高度拉长一点）」——
     420px 时标题栏 + 工具条就占掉 ~70px，视口只剩 350px，
     一屏能看到的行数偏少。抬到 520px 后视口约 450px。
     宽度的默认值不动（700 正好是信息栏七条刻度条排得开的下限附近）。*/
  var DEF_W = 700;
  var DEF_H = 520;
  var MIN_W = 420;
  var MIN_H = 240;
  var GAP = 16;          /* 贴边间距 */

  var state = {
    beatmapId: null,
    rawText: null,
    bm: null,
    lay: null,
    cfg: null,
    renderer: null,
    rowTops: null,       /* 每行顶边的像素偏移，长度 rowsUsed+1 */
    canvas: null,
    viewW: 0,            /* 生成画布时的窗口内容宽度 */
    viewY: 0,            /* 画布纵向滚动偏移（CSS px） */
    visible: true,
    collapsed: false,
    restoreH: '',         /* 折叠前的展开态高度，展开时还原 */
    /* 用户主动关掉窗口（✕ / popup 开关）。跨路由保持，
       否则「关掉→退到商店→点回谱面」窗口又弹出来，等于关不掉。*/
    userClosed: false,
    /* 非 taiko 谱的拦截记录：{bid, mode, name}。
       URL 的 hash 常常不带模式（/b/123、?beatmap=456），
       这时只能靠下载下来的 .osu 的 Mode 行确认 ——
       确认不是 taiko 就整窗隐藏，而不是在窗口里显示一句报错。*/
    modeBlocked: null,
    userCfg: {
      pixelsPerSecond: 0,   // <=0 表示自动
      showHeader: true,
      showMeasure: true,
      showSv: true,
      showGrid: true,
      showDan: true,        /* 段位/键型评估行（用户可关掉，状态持久化）*/
    },
    /* 段位/键型的显示内容 {grade, dan, keytype, kind}。
       null = 关掉（renderer 会把 danRowH 算成 0，预览图贴回信息栏下沿）。
       内容画在 canvas 上，夹在信息栏与预览图之间 —— 见 renderer._drawDanRow。*/
    danRow: null,
    /* ---- mod 选择 ----
       三个互斥组（rate:None/HT/DT、od:None/EZ/HR）用 radio，
       独立组（HD/FL/CL）用 checkbox。默认开启 CL（用户要求）。
       mods 是**有序数组**，因为「最多 PP」要按 acc 预设逐个算，
       顺序只影响显示，不影响数值。*/
    modRate: 'None',        /* None | HT | DT */
    modOd: 'None',          /* None | EZ | HR */
    modMisc: ['CL'],        /* HD / FL / CL 的任意子集 */
    /* mod 相关的计算结果（渲染时由 buildPreview 填充）*/
    srData: null,           /* {starRating, skills:{rows:[...]}, pp:{...}, display:{...}} */
  };

  /* ===================================================================== *
   * mod 选择
   * ===================================================================== */

  /** 把当前 mod 状态拼成传给难度计算器的 mod 名（如 "CL+HD"）。
   *  顺序固定（rate → od → misc），保证同一组 mod 永远得到同一个字符串，
   *  这样缓存与「是否需要重算」的判断才可靠。*/
  function currentModName() {
    var parts = [];
    if (state.modRate && state.modRate !== 'None') parts.push(state.modRate);
    if (state.modOd && state.modOd !== 'None') parts.push(state.modOd);
    var misc = (state.modMisc || []).slice().sort();
    for (var i = 0; i < misc.length; i++) parts.push(misc[i]);
    return parts.length ? parts.join('+') : 'None';
  }

  /** 界面上显示的缩写（用户要求）：
   *    一个 mod 都没选 -> "None"
   *    选了任意 mod  -> "+EZ,HD,DT,CL"（加号在最前，逗号分隔）
   *  顺序固定：**EZ/HR -> HD/FL -> HT/DT -> CL**。
   *  「固定顺序」很重要 —— 否则勾选顺序不同会得到不同字符串，
   *  用户会以为显示乱了。*/
  function currentModLabel() {
    var pool = [];
    if (state.modOd && state.modOd !== 'None') pool.push(state.modOd);   /* EZ / HR */
    var misc = state.modMisc || [];
    if (misc.indexOf('HD') >= 0) pool.push('HD');
    if (misc.indexOf('FL') >= 0) pool.push('FL');
    if (state.modRate && state.modRate !== 'None') pool.push(state.modRate); /* HT / DT */
    if (misc.indexOf('CL') >= 0) pool.push('CL');
    return pool.length ? '+' + pool.join(',') : 'None';
  }

  /** 当前 mod 是否会影响谱面参数（OD/HP/判定窗/流速）——
   *  这些变了必须重算 skill 占比；HD/FL 不影响，只改 PP。*/
  function modsAffectDifficulty(name) {
    return name !== 'None' && name !== 'HD' && name !== 'FL';
  }

  /**
   * 基准星数：同一个谱、**只保留 CL/HD/FL**（这三个不改难度参数）时的星数。
   *
   * 用来在星数后面追加变化值，如 `10.00 (+1.23)`。
   * 关键点：基准必须**排除 EZ/HR/HT/DT** —— 它们会改 OD、判定窗、流速，
   * 星数本来就会变，那种变化不是「相对这张谱的原始难度」而是「相对另一个难度」。
   *
   * TAIKO_MODS 里 CL 的 od/sm/rate 全是 1.0，所以带不带 CL 基准星数完全相同，
   * 这里保留 CL 是为了让用户看到的基准与「取消勾选」的结果一致。
   *
   * 复杂度：buildDifficultyReport 要跑整首多轮 O(n)，所以按谱面 ID 缓存 ——
   * 用户连续切 mod 时不会重复付出这个代价。
   *
   * ★★ 缓存键必须**同时带难度名**，不能只用 beatmapId。
   *   osu! 官网存在**同一BeatmapID 对应多个难度**的情况 ——
   *   实测 sid 703200 的 `Dan-i Dojo (Part.2)` 里，9th Dan 与 10th Dan
   *   的 BeatmapID 都是 1498109（谱面文件里就写着同一个 ID）。
   *
   *   只用 beatmapId 做键时，先算过的那张把结果留在缓存里，
   *   另一张直接命中它 —— 于是 10th Dan 的 5.4168 被当成 9th Dan 的
   *   「基准星数」，界面上就冒出 `-0.36` 的假变化值
   *   （用户反馈：勾 CL 与不勾 CL 都是 5.06★，却显示 (-0.36)）。
   *
   *   用 `beatmapId + version` 做键：version 是谱面文件里的难度名，
   *   同 ID 的不同难度天然分开。
   */
  var baseSrCache = Object.create(null);

  function baseStarRating(bm) {
    var misc = (state.modMisc || []).filter(function (m) {
      return m === 'CL' || m === 'HD' || m === 'FL';
    });
    var baseName = misc.length ? misc.slice().sort().join('+') : 'None';
    /* ★ 键里必须带难度名 —— 见上方注释（同 ID 多难度会互相污染）。*/
    var key = bm.beatmapId + '#' + (bm.version || '') + '#' + baseName;
    if (baseSrCache[key] !== undefined) return baseSrCache[key];
    var v = 0;
    try {
      v = window.OSU_TAIKO_PANEL.buildDifficultyReport(bm, { mod: baseName })
        .skills.total;
    } catch (e) {
      v = 0;
    }
    baseSrCache[key] = v;
    return v;
  }

  /* ===================================================================== *
   * 谱面 ID 提取
   * ===================================================================== */

  /**
   * 从 URL 里取 beatmapId。取不到返回 null。
   *
   * ★ 不要把域名写死在正则里：manifest 的 matches 同时覆盖
   *   osu.ppy.sh / osu.ppy.sb / osu.ri.mk，硬编码 `osu\.ppy\.sh` 会让
   *   镜像站（如 osu.ppy.sb/b/1234）判不出谱面页 -> 窗口不显示。
   *   这里只匹配**路径**，域名交给 manifest 管。
   *
   * 覆盖的形态（官网 SPA 会用好几种）：
   *   /b/1234
   *   /beatmaps/1234
   *   /beatmapsets/2623435#taiko/5891109   <- hash 里的难度
   *   /beatmapsets/2623435?beatmap=5891109 <- query 里的难度
   *   （/beatmapsets/2623435 单独出现时没有难度 id，返回 null）
   *
   * ★★ 私服（Bancho 系，如 osu.ppy.sb）多一种**32 位 hash**：
   *   /beatmapset/2529895?beatmap=07ab663b158da2284ad033e828a4f394&mode=taiko&ruleset=standard&rank=ppv2
   *
   *   hash 不是可逆的（不是 id 的 md5 —— 已实测验证），所以
   *   **拿它当 bid 去抓 .osu 是必然失败的**（/osu/<hash> 返回 404）。
   *   正确做法是从 sid + 页面自带的 `__NUXT_DATA__` 里查表，
   *   取出 `foreignId`（真正的数字 bid）。见 resolveSbBeatmapId()。
   *
   *   —— 但要注意：**直接进入页面**时 URL 里的 ?beatmap= 是数字 ID
   *   （实测 sid 2529895 首屏是 ?beatmap=5591346），
   *   **只有点了难度切换之后**才会变成 hash。
   */
  function extractBeatmapId() {
    var url = window.location.href;
    var m = url.match(/\/b\/(\d+)/);
    if (m) return m[1];
    m = url.match(/\/beatmaps\/(\d+)/);
    if (m) return m[1];
    /* SPA 切难度时用 hash：#osu/1234 / #taiko/1234 / #mania/ / #fruits/ */
    m = window.location.hash.match(/#(?:osu|taiko|mania|fruits)\/(\d+)/);
    if (m) return m[1];
    /* beatmapsets 页面的难度切换有时落在 ?beatmap= */
    var q = new URLSearchParams(window.location.search).get('beatmap');
    /* ★ 必须限定「**长度也合理**」，不能只看全是数字 ——
       私服的 hash 是 32 位十六进制，若那个 hash 恰好全是数字字符
       （如 00000000000000000000000000000000），`/^\d+$/` 会放行，
       于是把 32 位 hash 当成 bid 去下载 —— 实测会抓到
       `osu/00000000000000000000000000000000` 这种无效请求。
       osu! 的 beatmap id 目前都在 10 位以内（最大约 2.1e9），
       超过 10 位就不可能是真 id。*/
    if (q && /^\d{1,10}$/.test(q)) return q;
    return null;
  }

  /* ===================================================================== *
   * 私服（Bancho 系）适配：hash -> 数字 bid
   * ===================================================================== */

  /** 当前页面是不是私服（Bancho 系）。它们的路径形态与官网不同。 */
  function isPrivateServer() {
    return /\/beatmapset\/\d+/.test(window.location.pathname);
  }

  /** 从 URL 里取 beatmapset id（数字 sid）。私服与官网都是这个形态。 */
  function extractSetId() {
    var m = window.location.pathname.match(/\/beatmapset(?:s)?\/(\d+)/);
    return m ? m[1] : null;
  }

  /**
   * 把 URL 里的 `?beatmap=<32位hash>` 解析成真正的数字 bid。
   *
   * ★ 数据来源是**页面自带的** `<script id="__NUXT_DATA__">`
   *   （Bancho 前端 SSR 时把整组谱面塞进去了）。
   *   每个难度是一个扁平引用表里的对象：
   *     { version: <idx>, md5: <idx>, mode: <idx>, id: <idx>, foreignId: <idx>, ... }
   *   其中 `id` 指向 hash、`foreignId` 指向 osu! 的数字 bid。
   *
   * 实测 sid 2529895 的 payload 里 9 个难度全都有这两个字段：
   *   TATSUJIN    md5=07ab663b... foreignId=5591346 mode=taiko
   *   DAITATSUJIN md5=e5d149b6... foreignId=5591345 mode=taiko
   *   ...
   *
   * 为什么不走 API：私服**没有**可用的 .osu 下载端点
   * （实测 /osu/<x>、/api/v1/*、/d/<x> 全部 404），
   * 而 payload 是页面本来就要加载的，零额外请求。
   *
   * @returns {string|null} 数字 bid；查不到时返回 null
   */
  function resolveSbBeatmapId() {
    var raw = new URLSearchParams(window.location.search).get('beatmap');
    if (!raw) return null;
    /* 已经是数字 id（首屏常见）—— 直接用，不必查表。
       ★ 同样要限长度：纯数字组成的 32 位 hash（如全 0）不是 id。*/
    if (/^\d{1,10}$/.test(raw)) return raw;
    if (!/^[0-9a-f]{32}$/i.test(raw)) return null;

    /* Nuxt payload 是一个**扁平引用表**：顶层是数组，
       对象里的值是**数组下标**而不是值本身，需要二次解引用。*/
    var el = document.getElementById('__NUXT_DATA__');
    if (!el) return null;
    var table;
    try {
      table = JSON.parse(el.textContent || '[]');
    } catch (e) {
      return null;
    }
    if (!Array.isArray(table)) return null;
    /* Nuxt 的扁平引用表：对象里的值大多是**数组下标**。
     *
     * ★★ 但「下标」与「字面值」在类型上会撞车 —— 尤其是数字：
     *   实测 sid 2529895 的 payload 里
     *     { version: <idx>, md5: <idx>, id: <idx>, foreignId: <idx>, ... }
     *   每个下标指向的值里，foreignId 指向的是**字符串** '5591346'
     *   （注意是字符串，不是数字 —— 因为这站 id 很大，JS number 精度不够，
     *   服务端序列化成了 string）。
     *
     *   若写成「typeof v === 'number' 就当���标」，那么 foreignId=5591346
     *   这种**字面数字**会被误当成下标，跳到 table[5591346]（不存在），
     *   最后拿到 table[4] 之类的垃圾 —— 实测因此抓到了 bid=4。
     *
     * 正确判据：**只有当下标指向一个「类型与期望不同」的槽位时才替换**。
     * 具体做法：对字符串与对象直接取；对数字，先看槽位里装的是什么，
     * 是字符串/对象才替换，否则原样返回（说明它本身就是个值）。
     */
    var deref = function (v, wantType) {
      if (typeof v === 'number' && v >= 0 && v < table.length) {
        var t = table[v];
        /* md5 / foreignId 等字符串字段：槽位是字符串就替换。
           ★ 不指定 wantType 时**也要接受字符串槽位**——
             否则 foreignId=4 -> table[4]='5591346' 不会被取出来，
             原样返回下标 4，于是拿 4 当 bid 去抓谱面（实测踩过）。*/
        if (typeof t === 'string') return t;
        if (wantType === 'string') return v;   /* 槽位不是字符串 => 原值不是引用 */
        if (typeof t === 'number') return t;
        if (typeof t === 'object' && t !== null) return t;
      }
      return v;
    };
    for (var i = 0; i < table.length; i++) {
      var e = table[i];
      if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
      /* 必须同时有 md5 与 foreignId —— 那是「这是个谱面」的标志 */
      if (e.md5 === undefined || e.foreignId === undefined) continue;
      var md5 = deref(e.md5, 'string');
      if (typeof md5 !== 'string' || md5.toLowerCase() !== raw.toLowerCase()) continue;
      /* foreignId 既可能是字符串也可能是数字（取决于服务端怎么序列化），
         所以不指定 wantType —— 两种都按「原样或替换」处理。 */
      var fid = deref(e.foreignId);
      if (fid === null || fid === undefined || fid === '') continue;
      return String(fid);
    }
    return null;
  }

  /**
   * 取「可用来抓 .osu 的 bid」：数字优先，否则从私服 payload 查表。
   * @returns {string|null}
   */
  function effectiveBeatmapId() {
    return extractBeatmapId() || resolveSbBeatmapId();
  }

  /**
   * 从 URL 里取**玩法模式**。
   *
   * osu! 谱面页用hash 定位具体难度，形态是 `#<mode>/<bid>`：
   *   #osu/1234（点击） #taiko/1234（太鼓） #mania/1234 #fruits/1234（catch）
   * 例：`https://osu.ppy.sh/beatmapsets/2599592#mania/5810803` 是 mania 谱，
   * 本插件不渲染 mania，所以这种情况**整个窗口都不该出现**。
   *
   * ★ #osu/（std）是**允许**的：osu_parser 会按官方 TaikoBeatmapConverter
   *   把它转成 taiko 物件，窗口显示的是「转谱」视角。
   *   只有 #mania/ 与 #fruits/ 才拦。
   *
   * 返回 'osu' | 'taiko' | 'mania' | 'fruits'；URL 里没写模式时返回 null。
   * ★ null 不等于 taiko：`/b/1234`、`/beatmaps/1234`、`?beatmap=456`
   *   都不带模式信息，这时只能等 .osu 的 `Mode:` 行落地才能确认，
   *   由 hideByMode() 兜底（见 reload）。
   */
  function extractUrlMode() {
    var h = window.location.hash || '';
    var m = h.match(/^#\/?(osu|taiko|mania|fruits)\s*[\/-]/i);
    if (m) return m[1].toLowerCase();
    /* 容错：少数镜像站写成 #osu-1234 / #taiko_1234 */
    m = h.match(/^#\/?(osu|taiko|mania|fruits)(?:$|[-_])/i);
    if (m) return m[1].toLowerCase();
    /* ★ 私服（Bancho 系，如 osu.ppy.sb）把模式放在 **query** 里：
     *   /beatmapset/2529895?beatmap=5591346&mode=taiko&ruleset=standard&rank=ppv2
     *   /beatmapset/1923289?beatmap=3970329&mode=osu&ruleset=standard&rank=ppv2
     * 值有 `taiko` / `osu` 两种（还有 mania / fruits）。
     * 不读的话，std 谱（mode=osu）会因为「URL 里没模式」而落到
     * hideByMode 兜底 —— 那要等 .osu 下载完才知道，多一次无用请求。*/
    var qm = new URLSearchParams(window.location.search).get('mode');
    if (qm) {
      var v = qm.toLowerCase();
      /* Bancho 用 `fruits` 表示 catch，与官网 hash 一致；额外容错
         `catch` / `mode-mania` 之类的写法。*/
      if (v === 'catch') return 'fruits';
      if (v === 'osu' || v === 'taiko' || v === 'fruits' || v === 'mania') return v;
    }
    return null;
  }

  /** 本插件支持的 URL 模式（hash 明确写出时用这个判） */
  var URL_MODES_OK = { osu: true, taiko: true };

  /** Mode 编号 -> 展示名（[General] Mode: 0=std 1=taiko 2=catch 3=mania，4+ 是 mania 变体） */
  function modeName(mode) {
    var names = {
      0: 'osu!（点击）', 1: 'osu!taiko', 2: 'osu!catch', 3: 'osu!mania',
      4: 'osu!mania（catch）', 5: 'osu!mania（pass）', 6: 'osu!mania',
    };
    if (mode === 'osu' || mode === 'taiko' || mode === 'mania' || mode === 'fruits') {
      return names[{ osu: 0, taiko: 1, fruits: 2, mania: 3 }[mode]];
    }
    return names[mode] || ('Mode ' + mode);
  }

  /**
   * 当前 URL 是否是「本插件能渲染的谱面页」。
   *
   * manifest 的 matches 已放宽到整个站点（`https://osu.ppy.sh/*`）：
   * 官网是 SPA，从谱面页退到商店**不会重新加载文档**，
   * 脚本一直在跑，只是没有 bid 可用。所以显隐统一由这个函数决定，
   * 而不是靠"脚本有没有被注入"。
   *
   * ★ 追加「模式可渲染」这一条：用户要求 #mania/ 这类链接完全
   *   不显示窗口。把模式判断放进 onMapPage() 而不是只放在渲染里，
   *   是为了让显隐、popup 按钮、状态回执**共用同一个判据** ——
   *   否则会出现「窗口没显示但 popup 说已加载」的自相矛盾状态。
   */
  function onMapPage() {
    var bid = effectiveBeatmapId();
    if (!bid) return false;
    var um = extractUrlMode();
    /* hash 明确写了 mania / catch -> 不显示 */
    if (um && !URL_MODES_OK[um]) return false;
    /* hash 没写模式，但已经下载过的这张谱转换后不可渲染 -> 同样不显示。
       记住 bid 是为了：同一张谱反复切页面时不重复下载再判断。*/
    if (state.modeBlocked && state.modeBlocked.bid === bid) return false;
    return true;
  }

  /** 谱面标题（用于窗口标题，失败无所谓） */
  function pickTitle() {
    var el = document.querySelector('.beatmapset-header__details-text--title .beatmapset-header__details-text-link')
          || document.querySelector('.beatmapset-header__details-text--title')
          || document.querySelector('.beatmapset-header__details-text');
    return el ? el.textContent.replace(/\s*(不良内容|NSFW|聚光灯|Spotlight)\s*/gi, '').trim() : '';
  }

  /* ===================================================================== *
   * 下载谱面
   * ===================================================================== */

  var osuCache = Object.create(null);   // bid -> 谱面文本
  /* ★ 这里用 **URL 里的 bid** 做键，是安全的 ——
   * osu.ppy.sh/osu/<bid> 的 bid 由 URL 唯一确定，
   *哪怕 .osu 文件里的 BeatmapID 字段写错了（见 baseStarRating 的注释），
   * 也不会拿错谱面。
   * 别跟 baseSrCache 搞混：那个用 bm.beatmapId（文件里的值）做键，
   * 必须额外加 version 才安全。*/

  function fetchOsuText(bid) {
    if (osuCache[bid]) return Promise.resolve(osuCache[bid]);
    var urls = [
      'https://osu.ppy.sh/osu/' + bid,
      'https://catboy.best/osu/' + bid,
    ];
    var errors = [];
    function attempt(i) {
      if (i >= urls.length) {
        return Promise.reject(new Error('下载失败：' + errors.join(' | ')));
      }
      return fetch(urls[i])
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.text();
        })
        .catch(function (e) {
          errors.push(urls[i].replace(/^https:\/\//, '') + ': ' + e.message);
          return attempt(i + 1);
        });
    }
    return attempt(0).then(function (text) {
      osuCache[bid] = text;
      return text;
    });
  }

  /* ===================================================================== *
   * 谱面 -> 预览
   * ===================================================================== */

  /**
   * 构建预览（解析 → 布局 → renderer）。
   *
   * @param {string} text     .osu 全文
   * @param {string} title    取哪个难度的标题
   * @param {number} width    画布宽
   * @param {object} [pre]    已解析好的 bm。段位行需要在 buildPreview **之前**
   *                          算好（它决定 cfg.danRowH -> 画布高度），
   *                          而算段位又需要 bm —— 不复用的话同一份文本会被
   *                          parse两次（7000+ 音符的谱不便宜）。
   * @param {*} [urlBidArg]  URL 里的 beatmap id。画布信息栏优先显示它
   *                          而不是谱面文件自报的 `bm.beatmapId` ——
   *                          osu! 有「多难度共用同一 BeatmapID」的数据异常，
   *                          文件值可能与地址栏对不上。
   */
  function buildPreview(text, title, width, pre, urlBidArg) {
    var bm = pre || window.OSU_TAIKO_PARSE.parseOsu(text);
    if (!bm.notes.length) throw new Error('谱面里没有音符');

    /* 模式守卫：**只渲染能转成 taiko 的谱**。
     * osu! 的 [General] Mode 编号是
     *   0 = osu!(std) / 1 = osu!taiko / 2 = osu!catch / 3 = osu!mania
     *（4+ 是历史遗留的 mania 变体）。
     *
     * std（Mode 0）是**支持**的：osu_parser 会按官方
     * TaikoBeatmapConverter 把 circle/slider/spinner 转成 taiko 物件，
     * 所以窗口能正常显示（读的是「转谱」视角）。
     * catch / mania 的转换结果与真实 taiko 玩法差距太大（多押同轨、
     * 长按被压成 swell 等），一律不显示窗口。 */
    if (bm.mode !== undefined && bm.mode !== null && bm.mode !== 0 && bm.mode !== 1) {
      throw new Error(
        '这是 ' + modeName(bm.mode)
        + ' 谱面，本插件只渲染 osu!taiko（Mode 1）与其转换谱 osu!（Mode 0）。\n'
        + '可在谱面页右上角切换到 [Taiko] 或 [osu!] 难度后再试。');
    }

    var L = window.OSU_TAIKO_LAYOUT;
    /* 先按窗口宽度套用紧凑几何量：音符/轨道/行高/边距一起缩，
       否则窄窗口里一行连一个完整小节都放不满。*/
    var cfg = L.applyCompact(Object.assign({}, L.DEFAULTS), width);
    /* 标题栏高度必须问 renderer 要，不能自己再算一套 ——
       两处各算一套时缩放系数与下限不一致，内容会被裁掉。*/
    cfg.headerHeight = state.userCfg.showHeader
      ? window.OSU_TAIKO_RENDERER.headerHeightFor(width)
      : 0;
    /* 段位行的高度同理，也问 renderer 要（它和 headerLayout 共用同一个 k）。
       只在「开着 + 已经算出版位」时占高度；关着时传 0，
       renderer 的 bodyTop 会回落，预览图贴回信息栏下沿。*/
    cfg.danRowH = (state.userCfg.showDan !== false && state.danRow
        && state.danRow.kind === 'ok')
      ? window.OSU_TAIKO_RENDERER.danRowHeightFor(width)
      : 0;
    cfg.pixelsPerSecond = state.userCfg.pixelsPerSecond > 0
      ? state.userCfg.pixelsPerSecond
      : fitDensity(bm, cfg);

    var lay = L.computeLayout(bm, cfg);
    /* ---- Star Rating / skill 占比 / PP ----
     * 用 sr_panel.buildDifficultyReport，一次给全：
     *   skills.total（星数）/ skills.rows[i].ratio（四项占比）
     *   display（mod 后的 OD/HP/判定窗）/ pp.curve（各 acc 档的 PP）
     * 算法来自 taiko-sr-analysis，已与官方 osu.Game.Rulesets.Taiko 2026.730.0
     * 逐位一致（守门测试见 test/sr_verify.mjs）。
     * 计算较慢（整首多轮O(n)），但只���换谱面/mod 时跑一次。*/
    var srData = null;
    try {
      /* bridge.js 必须把sr_panel 挂到 OSU_TAIKO_PANEL。挂错名字的话下面会抛
         TypeError，而这里catch 掉只打一条 warn —— 表面上窗口照常显示，
         信息栏却永远退回旧刻度条，很难排查。所以缺模块时**直接报错**，
         让问题在控制台里一眼可见。*/
      if (!window.OSU_TAIKO_PANEL || !window.OSU_TAIKO_PANEL.buildDifficultyReport) {
        throw new Error('sr_panel模块未就绪（检查 bridge.js 的 window.OSU_TAIKO_PANEL 挂载）');
      }
      var modName = currentModName();
      var rep = window.OSU_TAIKO_PANEL.buildDifficultyReport(bm, { mod: modName });
      /* 最大 PP = 所有 acc 预设里最高的那个（官方「最大 PP」的定义）*/
      var maxPp = 0, maxPpLabel = '';
      var curve = (rep.pp && rep.pp.curve) || [];
      for (var ci = 0; ci < curve.length; ci++) {
        if (curve[ci].totalPP > maxPp) {
          maxPp = curve[ci].totalPP;
          maxPpLabel = curve[ci].label;
        }
      }
      srData = {
        mod: modName,
        modLabel: currentModLabel(),
        starRating: rep.skills.total,
        /* ★ 基准星数（同一个谱、不开任何速度/难度 mod，即EZ/HR/HT/DT 都为「无」）。
           用于在星数后面追加变化值，如 "10.00 (+1.23)"。
           只有 CL / HD / FL 这类「不改难度参数」的 mod 参与基准 ——
           它们本来就是同一个谱的两种演奏方式，星数自然相同。*/
        starRatingBase: baseStarRating(bm),
        rows: rep.skills.rows,
        display: rep.display,
        maxPp: maxPp,
        maxPpLabel: maxPpLabel,
      };
    } catch (e) {
      /* SR/PP 挂掉时**在信息栏里也留个痕迹**，而不是静默退回旧刻度条 ——
         这样一眼能看出「数据没算出来」而不是「渲染有问题」。*/
      console.error('[osu-taiko-preview] SR/PP 计算失败', e);
      srData = {
        mod: currentModName(),
        modLabel: currentModLabel(),
        error: String(e && e.message || e),
        starRating: 0, starRatingBase: 0, rows: [], display: null,
        maxPp: 0, maxPpLabel: '',
      };
    }

    /* 构造签名：(bm, layout, cfg, skin, opts)
       扩展里没有本地皮肤 -> 传空 skin，useSkin=false 走矢量绘制。 */
    var renderer = new window.OSU_TAIKO_RENDERER.PreviewRenderer(
      bm, lay, cfg,
      { loaded: false },
      {
        header: state.userCfg.showHeader,   /* 顶部信息栏（左：谱面信息 / 右：统计+刻度条） */
        useSkin: false,
        showGrid: state.userCfg.showGrid,
        showMeasure: state.userCfg.showMeasure,
        showSv: state.userCfg.showSv,
        /* SR / skill 占比 / PP，供信息栏绘制 */
      srData: srData,
        /* 段位/键型：画在信息栏与预览图之间。
           null 时 renderer 不占高度（danRowH = 0）。*/
        danRow: cfg.danRowH > 0 ? state.danRow : null,
danRowLabel: DAN_VERSION_LABEL,
        /* ★ URL 里的 bid。画布信息栏优先显示它而不是文件自报的
           `bm.beatmapId` —— osu! 侧有「多难度共用同一 BeatmapID」的数据异常
           （实测 sid 703200 的9th/10th Dan 都是 1498109），
           显示文件值会与地址栏对不上、复制出去找错谱面。
           见 _drawHeader 里那段注释。*/
        urlBid: urlBidArg,
      }
    );
    return { bm: bm, lay: lay, cfg: cfg, renderer: renderer,
             title: title, srData: srData };
  }

  /**
   * 选一个让小节线对齐的像素密度。
   *
   * 关键：**不夹取**。alignPixelsPerSecond 算出的值让每行恰好放整数个小节
   * （紧凑模式下 3~4 个，由可用宽度决定），任何上下限夹取都会破坏这个整数关系
   * —— 一旦夹住，每行就变成"3.7 个小节"，小节线在行内漂移。
   *
   * 只有在谱面测不出稳定小节（变速/异常 meter）时才退回按行数估算。
   *
   * @param {object} bm 谱面
   * @param {object} cfg 已套用紧凑几何量的配置
   */
  function fitDensity(bm, cfg) {
    var L = window.OSU_TAIKO_LAYOUT;
    var aligned = L.alignPixelsPerSecond(bm, cfg);
    if (aligned > 0) return aligned;         /* 小节对齐值，直接用 */

    /* 没有稳定小节时按行数估：目标 14 行左右，小窗拖几下就能看完。 */
    var tEnd = L.maxEnd(bm);
    if (tEnd <= 0) return 300;
    var usable = cfg.maxWidth - cfg.marginX * 2;
    var rows = Math.max(8, Math.round(tEnd / 1000 / 14));
    var v = usable / (tEnd / 1000 / rows);
    return Math.max(40, Math.min(900, v));
  }

  /* ===================================================================== *
   * UI：Shadow DOM 小窗
   * ===================================================================== */

  var ui = {};

  var CSS = [
    ':host{all:initial;}',
    '*{box-sizing:border-box;margin:0;padding:0;}',
    '.panel{',
    '  position:fixed; z-index:2147483000;',
    '  left:auto; top:auto; right:16px; bottom:16px;',
    '  width:700px; height:520px;',
    '  display:flex; flex-direction:column;',
    '  background:rgba(11,12,18,.94);',
    '  border:1px solid rgba(60,64,88,.85);',
    '  border-radius:10px;',
    '  box-shadow:0 6px 24px rgba(0,0,0,.5);',
    '  backdrop-filter:blur(10px);',
    '  font:12px/1.5 "Segoe UI","Microsoft YaHei",system-ui,sans-serif;',
    '  color:#e8eaf2;',
    '  overflow:hidden;',
    /* 折叠时**高度交给内容决定**（只剩标题栏一条），
       否则固定高度会留下一大片空黑框 —— 就跟没折叠一样。*/
    '  min-height:0;',
    '}',
    '.panel.collapsed{height:auto !important;}',
    '.panel.collapsed .body{display:none;}',
    '.bar{',
    '  display:flex; align-items:center; gap:8px;',
    '  padding:6px 6px 6px 9px;',
    '  background:rgba(255,255,255,.04);',
    '  border-bottom:1px solid rgba(255,255,255,.07);',
    '  cursor:grab; user-select:none; flex:none;',
    '}',
    '.panel.collapsed .bar{border-bottom:none;}',
    '.title{font-weight:700;font-size:13px;color:#ffd23f;',
    '  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:46%;}',
    '.sub{color:#9aa0b4;font-size:11px;white-space:nowrap;',
    '  overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0;}',
    '.spacer{flex:1;}',
    '.iconbtn{',
    '  width:24px;height:24px;border-radius:6px;border:1px solid rgba(255,255,255,.14);',
    '  background:rgba(255,255,255,.06);color:#e8eaf2;cursor:pointer;',
    '  font-size:12px;line-height:1;display:grid;place-items:center;padding:0;flex:none;',
    '}',
    '.iconbtn:hover{background:rgba(255,255,255,.16);}',
    '.iconbtn:disabled{opacity:.35;cursor:default;}',
    '.body{padding:8px 9px 9px;display:flex;flex-direction:column;gap:7px;flex:1;min-height:0;}',
    /* 段位/键型评估行**没有 HTML 元素** —— 它画在 canvas 上，
       位置在信息栏与预览图之间（见 renderer._drawDanRow）。
       这里只有它的显示开关（在 .tools 里，「轨道底」右侧）。*/

    /* ---- 画布视口：固定高度 + 拖动平移 ---- */
    '.stage{position:relative;overflow:hidden;background:#0a0b10;',
    '  border:1px solid rgba(255,255,255,.07);border-radius:6px;',
    '  flex:1;min-height:0;cursor:grab;}',
    '.stage.panning{cursor:grabbing;}',
    '.stage .wrap{position:absolute;left:0;top:0;right:0;will-change:transform;}',
    '.stage canvas{display:block;width:100%;height:auto;}',
    '.stage .ph{color:#7d8398;text-align:center;padding:26px 10px;font-size:12px;',
    '  position:absolute;inset:0;display:grid;place-items:center;}',
    '.stage .er{color:#ff6b6b;padding:12px;font-size:12px;word-break:break-word;',
    '  white-space:pre-line;line-height:1.7;position:absolute;inset:0;',
    '  display:grid;place-items:center;text-align:center;}',
    /* 右侧纵向缩略条 */
    '.vbar{position:absolute;right:0;top:0;bottom:0;width:11px;',
    '  background:rgba(255,255,255,.04);cursor:pointer;z-index:3;',
    '  border-left:1px solid rgba(255,255,255,.05);}',
    '.vthumb{position:absolute;left:2px;right:2px;border-radius:3px;',
    '  background:rgba(190,198,220,.35);min-height:14px;}',
    '.vthumb:hover{background:rgba(255,210,63,.65);}',
    /* 拖动提示 */
    '.tipdrag{position:absolute;left:6px;bottom:5px;z-index:2;pointer-events:none;',
    '  color:rgba(200,206,224,.5);font-size:10px;background:rgba(10,11,16,.6);',
    '  padding:1px 6px;border-radius:4px;}',
    /* 右下角缩放手柄 */
    '.grip{position:absolute;right:0;bottom:0;width:14px;height:14px;',
    '  cursor:nwse-resize;z-index:4;',
    '  background:linear-gradient(135deg,transparent 52%,rgba(160,168,192,.55) 52%);}',

    /* ---- 控制条 ---- */
    '.ctrl{display:flex;align-items:center;gap:6px;flex:none;}',
    '.pos{color:#9aa0b4;font-size:11px;font-variant-numeric:tabular-nums;',
    '  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.tools{display:flex;align-items:center;gap:10px;flex-wrap:wrap;flex:none;}',
    '.tools label{display:flex;align-items:center;gap:4px;color:#b8bdcd;font-size:11px;',
    '  cursor:pointer;user-select:none;}',
    '.tools input[type=number]{',
    '  width:54px;background:rgba(255,255,255,.07);color:#e8eaf2;',
    '  border:1px solid rgba(255,255,255,.14);border-radius:5px;',
    '  padding:1px 4px;font:inherit;font-size:11px;',
    '}',
    /* ---- mod 选择条 ---- */
    '.tools.mods{flex-wrap:wrap;gap:4px 10px;align-items:center;',
    '  border-top:1px solid rgba(255,255,255,.07);padding-top:6px;}',
    '.mlabel{color:#7d8398;font-size:11px;letter-spacing:.5px;}',
    '.mgroup{display:inline-flex;gap:6px;align-items:center;',
    '  padding:1px 6px;border-radius:5px;background:rgba(255,255,255,.05);}',
    '.mgroup label{display:inline-flex;align-items:center;gap:3px;',
    '  font-size:11px;cursor:pointer;user-select:none;color:#b8bdcd;}',
    '.mgroup input{width:12px;height:12px;margin:0;accent-color:#ffd23f;cursor:pointer;}',
    '.mgroup input:checked+*{color:#ffd23f;}',
    '.mgroup label:hover{color:#e8eaf2;}',
  ].join('\n');

  function buildUI(done) {
    if (document.getElementById(HOST_ID)) {
      if (done) done();
      return ui.host;
    }

    var host = document.createElement('div');
    host.id = HOST_ID;
    var root = host.attachShadow({ mode: 'open' });

    var style = document.createElement('style');
    style.textContent = CSS;

    var panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = [
      '<div class="bar">',
      '  <div class="title" id="t">osu!taiko 预览</div>',
      '  <div class="sub" id="s"></div>',
      '  <button class="iconbtn" id="fold" title="折叠/展开">▾</button>',
      '  <button class="iconbtn" id="close" title="隐藏窗口">✕</button>',
      '</div>',
      '<div class="body">',
      '  <div class="stage" id="stage">',
      '    <div class="wrap" id="wrap"></div>',
      '    <div class="vbar" id="vbar"><div class="vthumb" id="vthumb"></div></div>',
      '    <div class="grip" id="grip"></div>',
      '  </div>',
      '  <div class="ctrl">',
      '    <div class="pos" id="pos">—</div>',
      '    <div class="spacer"></div>',
      '    <button class="iconbtn" id="up" title="上滚半屏">▲</button>',
      '    <button class="iconbtn" id="down" title="下滚半屏">▼</button>',
      '    <button class="iconbtn" id="top" title="回到开头">⤒</button>',
      '  </div>',
      '  <div class="tools">',
      '    <label>密度 <input type="number" id="pps" min="40" max="1200" step="5" value="0"> px/s（0=自动）</label>',
      '    <label><input type="checkbox" id="cHeader" checked> 信息栏</label>',
      '    <label><input type="checkbox" id="cMeasure" checked> 小节线</label>',
      '    <label><input type="checkbox" id="cSv" checked> SV 线</label>',
      '    <label><input type="checkbox" id="cGrid" checked> 轨道底</label>',
      /* 段位/键型的显示开关放在「轨道底」右侧。
         ★ 位置是用户指定的，而且有硬理由：开关必须放在
           **永远不会随内容消失**的地方。初版把它和段位内容放在一起，
           取消勾选后连复选框一起消失，用户再也开不回来。*/
      '    <label title="显示/隐藏 段位/键型评估行"><input type="checkbox" id="cDan" checked> 段位/键型</label>',
      '  </div>',
      /* ---- mod 选择 ----
         两组互斥（流速 / 难度）用 radio，**每组都必须有「无」**——
         radio 一旦勾上就取消不掉，没有「无」就无法回到 NoMod（用户反馈）。
         独立 mod 用 checkbox。默认开启 CL。
         data-set 指明这个 radio 对应哪个状态字段（modRate / modOd）；
         data-mod="None" 表示「清空该组」。*/
      '  <div class="tools mods" id="modbar">',
      '    <span class="mlabel">mod</span>',
      '    <span class="mgroup" data-group="rate">',
      '      <label title="不改变流速"><input type="radio" name="otk-rate" data-set="modRate" data-mod="None" checked> 无</label>',
      '      <label title="半速（会让判定窗变宽、OD 显示值降低）"><input type="radio" name="otk-rate" data-set="modRate" data-mod="HT"> HT</label>',
      '      <label title="加速 / 夜曲（两者计算完全一致：rate 1.5）"><input type="radio" name="otk-rate" data-set="modRate" data-mod="DT"> DT/NC</label>',
      '    </span>',
      '    <span class="mgroup" data-group="od">',
      '      <label title="不改变难度参数"><input type="radio" name="otk-od" data-set="modOd" data-mod="None" checked> 无</label>',
      '      <label title="EZ 放宽判定 / OD 减半"><input type="radio" name="otk-od" data-set="modOd" data-mod="EZ"> EZ</label>',
      '      <label title="HR 收紧判定 / OD ×1.4"><input type="radio" name="otk-od" data-set="modOd" data-mod="HR"> HR</label>',
      '    </span>',
      '    <span class="mgroup" data-group="misc">',
      '      <label title="HD 高清"><input type="checkbox" data-mod="HD"> HD</label>',
      '      <label title="FL 全连（不影响星数）"><input type="checkbox" data-mod="FL"> FL</label>',
      '      <label title="CL CLASSIC 全连"><input type="checkbox" data-mod="CL" checked> CL</label>',
      '    </span>',
      '  </div>',
      '</div>',
    ].join('\n');

    root.appendChild(style);
    root.appendChild(panel);

    /* ★ 挂在 documentElement（<html>）而不是 document.body。
     *
     * Nuxt 切页时会**重建 body 的子树**（换 layout 时替换挂载点），
     * 挂在 body 上的节点会被一起丢掉 —— 这就是「退商店再进谱面页，
     * 窗口不出来、只能刷新」的真正原因（见 ensureHostMounted）。
     *
     * `<html>` 是 body 的**父节点**，Nuxt 只管 body 内部，
     * 挂到 html 上就躲开了它的清理范围。
     * （`all:initial` 的 :host 样式不依赖父元素，所以版式不受影响。）
     */
    var mountPoint = document.documentElement || document.body;
    mountPoint.appendChild(host);

    ui.host = host;
    ui.root = root;
    ui.panel = panel;
    ui.title = root.getElementById('t');
    ui.sub = root.getElementById('s');
    ui.stage = root.getElementById('stage');
    ui.wrap = root.getElementById('wrap');
    ui.pps = root.getElementById('pps');
    ui.fold = root.getElementById('fold');
    ui.close = root.getElementById('close');
    ui.pos = root.getElementById('pos');
    ui.vbar = root.getElementById('vbar');
    ui.vthumb = root.getElementById('vthumb');
    ui.grip = root.getElementById('grip');
    ui.up = root.getElementById('up');
    ui.down = root.getElementById('down');
    ui.top = root.getElementById('top');
    /* ★ 只有开关，没有内容行。
       段位/键型的内容画在 canvas 上（信息栏与预览图之间），
       见 renderer._drawDanRow；开关在 .tools 里「轨道底」右侧。*/
    ui.danToggle = root.getElementById('cDan');

    bindUI();
    /* 尺寸/偏好都在 storage 里，异步读回来后再决定何时首次渲染，
       否则会先用默认 700px 渲染一次、然后再按记忆尺寸重算。
       restoreWindow 里已把 restoreH 同步成记忆高度，最后再应用折叠态。*/
    loadPrefs(function () {
      restoreWindow(function () {
        if (state.collapsed) setCollapsed(true);
        if (done) done();
      });
    });
    return host;
  }

  /* ===================================================================== *
 * 段位 / 键型评估行
 * ===================================================================== *
 *
 * 数据来源：`lib/dan_bridge.js`（适配层）-> `lib/dan_rank.js`（算法）。
 * ★ 只用适配层，不要在 content.js 里直接碰算法层——
 *   适配层负责把 SV / 拍长语义对齐到 Python 侧，那是段位数值正确的前提
 *   （详见 dan_bridge.js 文件头的说明）。
 *
 * 版式（用户需求原文）：
 *   左：复选框（显示/隐藏，状态持久化）
 *   中：大号段位 + 小字括号段位数字 + 大号键型（键型为 '-' 时不显示）
 *   右：小字版本说明
 *
 * ★ 版本号只在这里定义。改动协议/字段时必须同步 bump，
 *   否则对方按旧契约实现会静默错位（字段名变了但段位仍能显示）。
 *   与 dan_rank 侧的 `dan_rank/evaluate.py` 文档字符串保持一致。
 */
  var DAN_VERSION_LABEL = '段位/键型评估v0.1';

  /** 当前 mod 字符串（与 sr_panel 用同一份，保证两边口径一致） */
  function currentModsString() {
    var out = [];
    if (state.modRate && state.modRate !== 'None') out.push(state.modRate);
    if (state.modOd && state.modOd !== 'None') out.push(state.modOd);
    for (var i = 0; i < (state.modMisc || []).length; i++) out.push(state.modMisc[i]);
    return out.join('');
  }

  /**
   * 段位行的空值 / 异常兜底。
   *
   * 三种状态，三种表现（不能都写成「—」，用户分不出是「算不出来」
   * 还是「还没算」）：
   *   pending —— 正在算 / 还没拿到谱面
   *   err    —— 谱面拿到了但算不出来（解析失败、模块没就绪…）
   *   正常   —— 显示段位
   *
   * @param {'pending'|'err'} kind
   * @param {string} [detail] 出错时的简短原因（不进 UI，只进 console）
   */
  function setDanRowPending(kind, detail) {
    if (state.userCfg.showDan === false) return;
    state.danRow = {
      grade: kind === 'err' ? '段位不可用' : '——',
      dan: 0, keytype: '', kind: kind,
    };
    if (detail) {
      console.warn('[osu-taiko-preview] 段位/键型评估不可用：', detail);
    }
  }

  /** 清空段位行（切换谱面时的中间态） */
  function clearDanRow() {
    setDanRowPending('pending');
  }

  /**
   * 计算并显示段位 / 键型。
   *
   * 结果写进 `state.danRow`，由 renderer 读走绘制；
   * 本函数**不碰 DOM**。
   *
   * @param {object} bm  parseOsu 的结果
   */
  function updateDanRow(bm) {
    /* 用户关掉了这一行就不用算 —— 省掉一次数值计算 */
    if (state.userCfg.showDan === false) { state.danRow = null; return; }
    if (!bm || !bm.notes || !bm.notes.length) {
      setDanRowPending('err', '谱面没有音符');
      return;
    }
    /* 模块没就绪（bridge.js还在加载 / 加载失败）*/
    if (!window.OSU_TAIKO_DAN || !window.OSU_TAIKO_DAN.evaluateBeatmap) {
      setDanRowPending('err',
        'dan_bridge 模块未就绪（检查 bridge.js 的 window.OSU_TAIKO_DAN 挂载）');
      return;
    }
    var res;
    try {
      res = window.OSU_TAIKO_DAN.evaluateBeatmap(bm, currentModsString());
    } catch (e) {
      /* 算法内部异常（如标定锚点缺失）不能拖垮整个预览窗口*/
      setDanRowPending('err', (e && e.message) || String(e));
      return;
    }
    /* ---- 结果校验 ---- */
    var dan = res && res.dan;
    var grade = res && res.grade;
    /* ★ 这里**不能**用 `dan <= 0` 判异常。
     * 段位可以是 0 甚至负数，而且那是**算法有意输出**的结果：
     *   model.py 的 `flow_bonus()` 下界是 `FLOW_FLOOR = -0.60`（段），
     *   而 `dan()` 是 `curve(...) + flow_bonus`，所以极简单的谱
     *   会落在 0 以下 —— 实测 [Feel This Melody] 最简难度 dan = -1.92。
     *   Python 的 `grade_name()` 对这种情况返回 `'<1'`。
     *
     * 我最初写成 `dan <= 0` 就当成异常，于是这类谱**整行不显示**
     * （用户反馈「过于简单的谱面似乎没有显示段位」）。
     *
     * 真正的异常只有两种：不是数字 / 不是有限数。段位是 0 或负数都照常显示。*/
    if (typeof dan !== 'number' || !isFinite(dan)
        || typeof grade !== 'string' || !grade) {
      setDanRowPending('err', '返回字段异常：dan=' + dan + ' grade=' + grade);
      return;
    }
    /* 键型：'-' 表示「段位 ≤6 不标定」，整段不显示（用户需求）*/
    var kt = res.keytype;
    state.danRow = {
      grade: grade,
      dan: dan,
      keytype: (typeof kt === 'string' && kt && kt !== '-') ? kt : '',
      kind: 'ok',
    };
  }

  function bindUI() {
    /* 折叠 */
    ui.fold.addEventListener('click', function () {
      setCollapsed(!state.collapsed);
      savePrefs();
    });

    /* 段位行的显示/隐藏开关（状态走 userCfg.showDan，持久化）。
         ★ 它在 .tools 里「轨道底」右侧 —— 一个**永远不会消失**的地方。
           关掉只影响画布上的那一行，不会把开关自己藏掉。*/
    if (ui.danToggle) {
      ui.danToggle.addEventListener('change', function () {
        state.userCfg.showDan = ui.danToggle.checked;
        savePrefs();
        if (!ui.danToggle.checked) {
          state.danRow = null;
        } else if (state.bm) {
          /* 从关变开：要重算（关着时updateDanRow 直接返回，没算过）*/
          updateDanRow(state.bm);
        }
        /* 画布高度变了（danRowH 0 <-> 有值），必须重建 renderer 并重画。
           reload() 会走 buildPreview() -> 新的 renderer，正好。*/
        if (state.rawText) reload();
      });
    }

    /* 关闭按钮：走 hide() 以便记下 userClosed
       （否则重新进谱面页时窗口会自己弹回来，等于关不掉）*/
    ui.close.addEventListener('click', function () {
      hide();
    });

    makeDraggable();
    makeResizable();
    makePannable();

    /* 滚动按钮 */
    ui.up.addEventListener('click', function () { scrollBy(-ui.stage.clientHeight * 0.5); });
    ui.down.addEventListener('click', function () { scrollBy(ui.stage.clientHeight * 0.5); });
    ui.top.addEventListener('click', function () { scrollTo(0); });

    /* 键盘：↑↓ 滚动，PageUp/Down翻屏 */
    document.addEventListener('keydown', function (e) {
      if (!state.visible || !state.lay) return;
      var tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      var step = ui.stage.clientHeight * 0.9;
      if (e.key === 'ArrowDown' || e.key === 'PageDown') { scrollBy(step); e.preventDefault(); }
      else if (e.key === 'ArrowUp' || e.key === 'PageUp') { scrollBy(-step); e.preventDefault(); }
      else if (e.key === 'Home') { scrollTo(0); e.preventDefault(); }
      else if (e.key === 'End') { scrollTo(maxScroll()); e.preventDefault(); }
    });

    /* 密度 */
    ui.pps.addEventListener('change', function () {
      var v = parseInt(ui.pps.value, 10);
      state.userCfg.pixelsPerSecond = isFinite(v) && v > 0 ? v : 0;
      savePrefs();
      if (state.rawText) reload();
    });

    bindCheck('cHeader', 'showHeader');
    bindCheck('cMeasure', 'showMeasure');
    bindCheck('cSv', 'showSv');
    bindCheck('cGrid', 'showGrid');
    bindMods();

    /* 窗口尺寸变化后要按新宽度重算布局（用户明确要求按实际尺寸渲染） */
    window.addEventListener('resize', function () {
      clampPanel();
      scheduleRefit();
    });
  }

  function bindCheck(id, key) {
    var el = ui.root.getElementById(id);
    el.addEventListener('change', function () {
      state.userCfg[key] = el.checked;
      savePrefs();
      if (state.rawText) reload();
    });
  }

  /**
   * mod 选择事件。
   *
   * 互斥组用 radio（同 name 自动互斥），独立 mod 用 checkbox。
   * **读状态靠 radio 上的 `data-set`**（modRate / modOd）而不是 data-mod ——
   * 两组都有一个 data-mod="None" 的「无」，靠 data-mod 分不出是哪个组。
   *
   * 任何改动都要重算 —— 因为 HT/DT/EZ/HR 会改变 OD/HP/判定窗/流速，
   * 进而改变 skill 占比与 Star Rating（不只是 PP 变了）。
   */
  function bindMods() {
    var bar = ui.root.getElementById('modbar');
    if (!bar) return;
    var inputs = bar.querySelectorAll('input[data-mod]');

    function onChange() {
      /* 从 DOM 反读全部状态，避免两处维护 */
      var nextRate = 'None', nextOd = 'None';
      var misc = [];
      for (var i = 0; i < inputs.length; i++) {
        var el = inputs[i];
        var m = el.getAttribute('data-mod');
        var set = el.getAttribute('data-set');
        if (set === 'modRate') {
          if (el.checked && m) nextRate = m;      /* 「无」= 保持 'None' */
        } else if (set === 'modOd') {
          if (el.checked && m) nextOd = m;
        } else if (el.checked && m) {
          misc.push(m);
        }
      }
      state.modRate = nextRate;
      state.modOd = nextOd;
      state.modMisc = misc.sort();
      savePrefs();
      /* 重算并重绘（SR / 占比 / PP 都会变） */
      if (state.rawText) reload();
    }

    for (var i = 0; i < inputs.length; i++) {
      inputs[i].addEventListener('change', onChange);
    }
  }

  /** 把 state 里的 mod 状态同步回 DOM（恢复偏好时用） */
  function syncModsToDom() {
    var bar = ui.root.getElementById('modbar');
    if (!bar) return;
    var inputs = bar.querySelectorAll('input[data-mod]');
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      var m = el.getAttribute('data-mod');
      var set = el.getAttribute('data-set');
      if (set === 'modRate') el.checked = (state.modRate || 'None') === m;
      else if (set === 'modOd') el.checked = (state.modOd || 'None') === m;
      else el.checked = (state.modMisc || []).indexOf(m) >= 0;
    }
  }

  /* ===================================================================== *
   * 窗口：折叠 / 拖动 / 缩放（都持久化）
   * ===================================================================== */

  /**
   * 折叠/展开。
   *
   * 三个坑：
   * 1) 默认尺寸写在 **CSS** 里（width:700px; height:520px），
   *    所以 `style.height` 初始是空串。若直接存 `style.height` 再还原，
   *    展开时会写回空串 -> 高度永久停在 auto -> 预览区被压成 0 高。
   *    因此必须用 `offsetHeight` 量出**真实高度**再存。
   * 2) 量高度必须在切 class **之前**。加了 `.collapsed` 之后再量，
   *    量到的是折叠后的标题栏高度（~34px），展开时就还原成 34px ——
   *    窗口看起来正常，其实预览区只剩一条缝。
   * 3) 展开后 `.stage` 刚从 display:none 恢复，尺寸要等一帧才准，
   *    立刻同步滚动条/缩略条会算错，所以延到下一帧再校准。
   */
  function setCollapsed(on) {
    var next = !!on;
    /* 关键：先量展开态的真实高度，再改class */
    if (next && !state.collapsed) state.restoreH = ui.panel.offsetHeight + 'px';
    state.collapsed = next;
    ui.panel.classList.toggle('collapsed', next);
    ui.fold.textContent = next ? '▸' : '▾';
    if (next) {
      ui.panel.style.height = 'auto';
    } else {
      /* 展开：还原成记忆里的展开态高度（没有就用默认）。
         写具体 px 而不是 auto，否则 .stage 的 flex:1 无处伸展。*/
      var h = parseFloat(state.restoreH);
      if (!isFinite(h) || h < MIN_H) h = DEF_H;
      ui.panel.style.height = h + 'px';
      /* 展开后视口尺寸要等一帧才准，届时重算滚动位置与缩略条 */
      requestAnimationFrame(function () { applyScroll(); });
    }
  }

  var WIN_KEY = 'osu-taiko-preview-window';

  function clampPanel() {
    /* ★★ 隐藏状态下 offsetWidth / offsetHeight 都是 0，
       这里必须**直接返回**，不能继续算。
       历史 bug（用户反馈「窗口突然变特别小」）：
       隐藏时 offsetWidth=0 -> w = max(MIN_W, min(0, …)) = MIN_W = 420，
       offsetHeight=0 -> h = MIN_H = 240，于是把 420×240 **写进 inline style**。
       之后 show() 只是把 display 置回 ''，尺寸已经是 420×240 了；
       再拖一下 moveWindow 还会把这个值存进 storage，永久生效。
       触发路径很日常：窗口在商店页/被 ✕ 关掉/mania 拦截时是隐藏的，
       此时浏览器窗口一次 resize 就触发下面的 listener。*/
    if (!ui.panel || !ui.panel.isConnected) return;
    var curW = ui.panel.offsetWidth, curH = ui.panel.offsetHeight;
    /* 0 = 当前没渲染（display:none 或刚被 SPA 摘出文档），无从夹取 */
    if (curW <= 0 || curH <= 0) return;

    var w = Math.max(MIN_W, Math.min(curW, window.innerWidth - GAP));
    /* 折叠时高度是 auto（由内容决定），不能拿它去夹取，否则会写回一个
       固定高度把折叠效果抵消掉。*/
    var h = state.collapsed ? curH
      : Math.max(MIN_H, Math.min(curH, window.innerHeight - GAP));
    if (w !== curW) ui.panel.style.width = w + 'px';
    if (!state.collapsed && h !== curH) ui.panel.style.height = h + 'px';
    var r = ui.panel.getBoundingClientRect();
    var x = Math.min(Math.max(-w + 120, r.left), window.innerWidth - 120);
    var y = Math.min(Math.max(0, r.top), window.innerHeight - 34);
    if (x !== r.left) ui.panel.style.left = x + 'px';
    if (y !== r.top) ui.panel.style.top = y + 'px';
  }

  /**
   * 恢复默认尺寸（标题栏双击触发）。
   *
   * 留着这个入口是因为「尺寸被写坏」这类问题一旦发生，
   * 用户不该只能靠刷新页面自救 —— 存进 storage 的坏值会跨会话生效。
   * 根因已修（见 clampPanel），但手动复位比排查历史脏数据更省事。
   */
  function resetPanelSize() {
    ui.panel.style.width = DEF_W + 'px';
    ui.panel.style.height = DEF_H + 'px';
    state.restoreH = DEF_H + 'px';
    clampPanel();
    saveWindow();
    scheduleRefit(true);
  }

  /** 把 fixed 的 bottom/right 定位换成 left/top，之后才能自由拖动 */
  function pinPanel() {
    var r = ui.panel.getBoundingClientRect();
    ui.panel.style.left = r.left + 'px';
    ui.panel.style.top = r.top + 'px';
    ui.panel.style.right = 'auto';
    ui.panel.style.bottom = 'auto';
  }

  function saveWindow() {
    try {
      var r = ui.panel.getBoundingClientRect();
      /* ★ 拒绝存明显无效的尺寸。
         隐藏状态下 getBoundingClientRect() 全是 0，若照存，
         下次会话 restoreWindow 会把窗口设成 0×0（再被夹到 MIN_W/MIN_H），
         表现为「窗口突然变特别小」且换标签页也好不了。
         MIN_W/MIN_H 是允许的合法下界，这里只挡 0 与明显不合理的小值。*/
      if (!(r.width >= MIN_W && r.height >= 1)) return;
      chrome.storage.local.set({ [WIN_KEY]: { x: r.left, y: r.top, w: r.width, h: r.height } });
    } catch (e) { /* storage 不可用时忽略 */ }
  }

  function makeDraggable() {
    var bar = ui.panel.querySelector('.bar');
    var pos = null;
    /* 标题栏双击 = 恢复默认尺寸。
       拖动是 mousedown/mousemove 体系，双击不会与之冲突；
       但要挡掉落在按钮上的双击（✕ / 折叠），否则会误触发。 */
    bar.addEventListener('dblclick', function (e) {
      if (e.target.tagName === 'BUTTON') return;
      resetPanelSize();
      e.preventDefault();
    });
    bar.addEventListener('mousedown', function (e) {
      if (e.target.tagName === 'BUTTON') return;
      pinPanel();
      var r = ui.panel.getBoundingClientRect();
      pos = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      bar.style.cursor = 'grabbing';
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
    function onMove(e) {
      if (!pos) return;
      var w = ui.panel.offsetWidth;
      var x = Math.min(Math.max(-w + 120, e.clientX - pos.dx), window.innerWidth - 120);
      var y = Math.min(Math.max(0, e.clientY - pos.dy), window.innerHeight - 34);
      ui.panel.style.left = x + 'px';
      ui.panel.style.top = y + 'px';
    }
    function onUp() {
      pos = null;
      bar.style.cursor = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      saveWindow();
    }
  }

  function makeResizable() {
    var st = null;
    ui.grip.addEventListener('mousedown', function (e) {
      /* 折叠状态下 grip 被 .body 隐藏了，理论上点不到；真点到了就先展开 */
      if (state.collapsed) setCollapsed(false);
      pinPanel();
      var r = ui.panel.getBoundingClientRect();
      st = { x: e.clientX, y: e.clientY, w: r.width, h: r.height };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      e.preventDefault(); e.stopPropagation();
    });
    function onMove(e) {
      if (!st) return;
      var w = Math.max(MIN_W, Math.min(st.w + (e.clientX - st.x), window.innerWidth - GAP));
      var h = Math.max(MIN_H, Math.min(st.h + (e.clientY - st.y), window.innerHeight - GAP));
      ui.panel.style.width = w + 'px';
      ui.panel.style.height = h + 'px';
      /* 展开态的高度变化要同步给 restoreH，
         这样「折叠 -> 展开」用的是最新高度而不是旧值 */
      state.restoreH = h + 'px';
      /* 高度变了立刻重画（不用等 mouseup），拖动过程就是实时预览 */
      scheduleRefit(true);
    }
    function onUp() {
      st = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      scheduleRefit();
      saveWindow();
    }
  }

  /* 宽度变了才需要重算布局；纯高度变化只需重绘滚动位置 */
  var refitTimer = 0;
  function scheduleRefit(immediate) {
    if (refitTimer) clearTimeout(refitTimer);
    refitTimer = setTimeout(function () {
      refitTimer = 0;
      refitNow();
    }, immediate ? 120 : 260);
  }
  function refitNow() {
    if (!state.lay) return;
    var w = contentWidth();
    if (Math.abs(w - state.viewW) < 12) { applyScroll(); return; }
    if (state.rawText) reload();
    else applyScroll();
  }

  /** 恢复窗口尺寸/位置。storage 是异步的，所以用回调通知调用方「可以渲染了」 */
  function restoreWindow(done) {
    function finish() {
      clampPanel();
      /* 记忆里的尺寸就是展开态该有的高度，restoreH 同步一份，
         这样「折叠 -> 展开」不会退回CSS 默认值。
         ★ 只在量得到真实高度时同步：窗口此刻可能还是隐藏的
         （buildUI 里restoreWindow 早于首次 show），
         那时 offsetHeight = 0，若照样存进 restoreH，
         「折叠 -> 展开」就会把高度还原成 0 -> 再被夹到 MIN_H，
         正是「窗口突然变特别小」的另一条路径。*/
      if (!state.collapsed && ui.panel.offsetHeight > 0) {
        state.restoreH = ui.panel.offsetHeight + 'px';
      }
      if (done) done();
    }
    try {
      chrome.storage.local.get(WIN_KEY, function (d) {
        var p = d && d[WIN_KEY];
        /* ★ 存档可能是历史 bug 写坏的（见 saveWindow 的注释）。
           只挡「明显不是用户拖出来的值」：0 / 负数 / 非有限数。
           正常值区间是 [MIN_W, 视口宽]，这里不设上界，
           因为用户可能 legitimately 存过一个 3000px 的宽窗口。*/
        var okW = p && typeof p.w === 'number' && isFinite(p.w) && p.w >= MIN_W;
        var okH = p && typeof p.h === 'number' && isFinite(p.h) && p.h >= MIN_H;
        if (p) {
          if (okW) ui.panel.style.width = p.w + 'px';
          if (okH) ui.panel.style.height = p.h + 'px';
          if (typeof p.x === 'number' && isFinite(p.x)) {
            ui.panel.style.left = p.x + 'px';
            ui.panel.style.right = 'auto';
          }
          if (typeof p.y === 'number' && isFinite(p.y)) {
            ui.panel.style.top = p.y + 'px';
            ui.panel.style.bottom = 'auto';
          }
        }
        finish();
      });
    } catch (e) { finish(); }
  }

  /* ===================================================================== *
   * 画布平移（拖动 / 滚轮 / 缩略条）
   * ===================================================================== */

  /** 画布可用宽度：stage 的内容盒宽度。
   *  注意 clientWidth 已经不含边框，只含 padding，所以不能再减border。*/
  function contentWidth() {
    var cs = getComputedStyle(ui.stage);
    var w = ui.stage.clientWidth
          - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0);
    return Math.max(240, Math.round(w));
  }

  /** 画布显示总高度（CSS px）。
   *  画布以 CSS width:100% 缩放到视口宽度，所以显示高度 =画布像素高 × 缩放比。 */
  function contentHeight() {
    if (!state.canvas) return 0;
    var scale = contentWidth() / state.canvas.width;
    return state.canvas.height * scale;
  }

  function maxScroll() {
    return Math.max(0, contentHeight() - ui.stage.clientHeight);
  }

  function scrollTo(y) {
    state.viewY = Math.min(Math.max(0, y), maxScroll());
    applyScroll();
  }

  function scrollBy(dy) {
    scrollTo(state.viewY + dy);
  }

  function applyScroll() {
    if (!state.canvas) return;
    ui.wrap.style.transform = 'translateY(' + (-state.viewY) + 'px)';
    updatePosLabel();
    updateThumb();
  }

  function updatePosLabel() {
    if (!state.lay || !state.canvas) { ui.pos.textContent = '—'; return; }
    var total = state.lay.rowsUsed;
    var a = rowAtY(state.viewY);
    var b = rowAtY(state.viewY + ui.stage.clientHeight);
    ui.pos.textContent = '第 ' + (a + 1) + '–' + b + ' 行 / 共 ' + total + ' 行'
      + (maxScroll() > 1 ? '　·　拖动画面查看' : '');
    ui.up.disabled = state.viewY <= 0.5;
    ui.down.disabled = state.viewY >= maxScroll() - 0.5;
  }

  function updateThumb() {
    var stageH = ui.stage.clientHeight;
    var total = contentHeight();
    var trackH = ui.vbar.clientHeight;
    if (!trackH) return;
    if (total <= stageH) {
      ui.vthumb.style.height = trackH + 'px';
      ui.vthumb.style.top = '0px';
      return;
    }
    var ratio = stageH / total;
    var h = Math.max(16, Math.round(trackH * ratio));
    var maxTop = trackH - h;
    var top = Math.round(maxTop * (state.viewY / (total - stageH)));
    ui.vthumb.style.height = h + 'px';
    ui.vthumb.style.top = top + 'px';
  }

  /** 画布 y 坐标 -> 行号 */
  function rowAtY(y) {
    if (!state.rowTops) return 0;
    var scale = contentWidth() / state.canvas.width;
    var cy = y / scale;
    var lo = 0, hi = state.rowTops.length - 1;
    while (lo < hi - 1) {
      var mid = (lo + hi) >> 1;
      if (state.rowTops[mid] <= cy) lo = mid; else hi = mid;
    }
    return Math.min(state.lay.rowsUsed - 1, lo);
  }

  function makePannable() {
    /* 1) 画面内拖动平移 */
    var st = null;
    ui.stage.addEventListener('mousedown', function (e) {
      if (e.target.closest('.vbar') || e.target.closest('.grip')) return;
      if (!state.canvas) return;
      st = { y: e.clientY, v: state.viewY, moved: false };
      ui.stage.classList.add('panning');
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
    function onMove(e) {
      if (!st) return;
      var dy = e.clientY - st.y;
      if (Math.abs(dy) > 2) st.moved = true;
      scrollTo(st.v - dy);
    }
    function onUp() {
      st = null;
      ui.stage.classList.remove('panning');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }

    /* 2) 滚轮 */
    ui.stage.addEventListener('wheel', function (e) {
      if (!state.canvas) return;
      var dy = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (!dy) return;
      scrollBy(dy);
      e.preventDefault();
    }, { passive: false });

    /* 3) 右侧缩略条：点哪跳哪 + 拖动
     *
     * 两个容易做错的地方：
     *  a) 坐标：clientY 是**视口**坐标，滚动条不在视口顶端（上面有标题栏、
     *     工具条、padding，实测约 70px），必须先减掉 rect.top，
     *     否则点上面 1/4 会跳到中间 —— 用户反馈的「点击位置错位」。
     *  b) 抓取偏移：点在**滑块本身**上时不能直接 jumpTo（会让滑块瞬移，
     *     手指/鼠标与滑块错位），应该记住抓取点相对滑块顶部的偏移，
     *     拖动时保持这个偏移。这是所有滚动条的标准行为。*/
    var vGrab = 0;            /* 抓取点相对滑块顶的偏移（px） */
    ui.vbar.addEventListener('mousedown', function (e) {
      if (!state.canvas) return;
      var rect = ui.vbar.getBoundingClientRect();
      var trackH = ui.vbar.clientHeight;
      var thumbH = ui.vthumb.offsetHeight || 16;
      var thumbTop = parseFloat(ui.vthumb.style.top) || 0;
      /* 点在滑块上-> 记录偏移；点在轨道空白处 -> 直接跳 */
      var onThumb = e.clientY >= rect.top + thumbTop
                 && e.clientY <= rect.top + thumbTop + thumbH;
      vGrab = onThumb ? (e.clientY - rect.top - thumbTop) : thumbH / 2;
      jumpTo(e.clientY, vGrab);
      window.addEventListener('mousemove', onVMove);
      window.addEventListener('mouseup', onVUp);
      e.preventDefault(); e.stopPropagation();
    });
    function onVMove(e) {
      jumpTo(e.clientY, vGrab);
    }
    function onVUp() {
      vGrab = 0;
      window.removeEventListener('mousemove', onVMove);
      window.removeEventListener('mouseup', onVUp);
    }
    /**
     * 跳到滚动条的某个纵向位置。
     * @param {number} clientY 鼠标的视口 Y
     * @param {number} grabOffset抓取点相对滑块顶的偏移（px）
     */
    function jumpTo(clientY, grabOffset) {
      var total = contentHeight();
      var trackH = ui.vbar.clientHeight;
      if (total <= ui.stage.clientHeight || !trackH) return;
      var rect = ui.vbar.getBoundingClientRect();
      /* 把鼠标位置换算成「滑块应该到的位置」，再减去抓取偏移，
         这样滑块不会在鼠标底下跑。*/
      var wantTop = (clientY - rect.top) - (grabOffset || 0);
      var thumbH = ui.vthumb.offsetHeight || 16;
      var maxTop = Math.max(1, trackH - thumbH);
      var top = Math.min(maxTop, Math.max(0, wantTop));
      var frac = top / maxTop;
      scrollTo(frac * (total - ui.stage.clientHeight));
    }
  }

  /* ===================================================================== *
   * 设置持久化
   * ===================================================================== */
  var PREF_KEY = 'osu-taiko-prefs';
  function savePrefs() {
    try {
      chrome.storage.local.set({ [PREF_KEY]: {
        collapsed: state.collapsed,
        /* 注意：**不存 userClosed**。
           隐藏只作用于当前页（见 syncVisibility 的说明），
           持久化它会让「退商店 -> 重进」永远弹不出来。 */
        userCfg: state.userCfg,
        modRate: state.modRate,
        modOd: state.modOd,
        modMisc: state.modMisc,
      } });
    } catch (e) { /* ignore */ }
  }
  function loadPrefs(done) {
    function finish() { if (done) done(); }
    try {
      chrome.storage.local.get(PREF_KEY, function (d) {
        var p = d && d[PREF_KEY];
        if (p && p.userCfg) Object.assign(state.userCfg, p.userCfg);
        /* userClosed 是**瞬时**标记，不从 storage 恢复 ——
           刷新页面后一律按「当前在谱面页就显示」处理。 */
        /* mod 偏好：缺省时用默认（None + CL） */
        if (p && typeof p.modRate === 'string') state.modRate = p.modRate;
        if (p && typeof p.modOd === 'string') state.modOd = p.modOd;
        if (p && Array.isArray(p.modMisc)) state.modMisc = p.modMisc.slice();
        if (p && p.collapsed) {
          /* 只记意图，真正量高度交给 buildUI 末尾的 restoreWindow ——
             此时 DOM 刚建好、还没应用记忆尺寸，量出来的值是 CSS 默认值。*/
          state.collapsed = true;
        }
        ui.pps.value = String(state.userCfg.pixelsPerSecond || 0);
        ui.root.getElementById('cHeader').checked = state.userCfg.showHeader;
        ui.root.getElementById('cMeasure').checked = state.userCfg.showMeasure;
        ui.root.getElementById('cSv').checked = state.userCfg.showSv;
        ui.root.getElementById('cGrid').checked = state.userCfg.showGrid;
        /* 段位行的显示状态也要还原（用户要求「刷新后保留选择」）。
           ★ 必须放在 restoreWindow 之前应用：那一行在 .body 里，
             显隐不影响尺寸计算，但保持顺序一致便于排查。 */
        ui.danToggle.checked = state.userCfg.showDan !== false;
        /* 关着时清掉缓存的结果，但**不调** applyDanRowVisible ——
           那时还没解析谱面，state.danRow 本来就是 null，
           而 showDan 的实际生效点是 reload() 里 cfg.danRowH 的计算。*/
        if (state.userCfg.showDan === false) state.danRow = null;
        syncModsToDom();
        finish();
      });
    } catch (e) { finish(); }
  }

  /* ===================================================================== *
   * 绘制
   *
   * 画法：整首一次画成一张长canvas，塞进固定高度的 .stage 视口里，
   * 靠 transform: translateY 平移查看。相比分页的好处：
   *   - 连续上下文，跨页的连打/转盘不会因为换canvas 而断
   *   - 拖动时不用重新渲染 canvas，天然跟手
   * 长canvas 的高度上限：Chrome 单边约 32767px、面积约 2.68 亿 px，
   * 860 宽的谱要 3 万行才会撞到，实际上不可能到。
   * ===================================================================== */

  function computeRowTops() {
    var lay = state.lay, cfg = state.cfg;
    var rowH = window.OSU_TAIKO_LAYOUT.rowHeightOf;
    var tops = new Float64Array(lay.rowsUsed + 1);
    /* 第0 行在画布上的y = lay.bodyTop（headerHeight + paddingTop），
       与 renderer.renderPage 里 `bodyTop = row0 === 0 ? this.bodyTop : 0` 对齐。*/
    var y = lay.bodyTop || 0;
    for (var i = 0; i < lay.rowsUsed; i++) {
      tops[i] = y;
      y += rowH(cfg, lay.subsPerRow[i] || 1, lay.denseRows[i] || 0);
    }
    tops[lay.rowsUsed] = y;
    return tops;
  }

  function render() {
    if (!state.lay || !state.renderer) return;

    var canvas = state.renderer.renderPage(0, { rows: [0, state.lay.rowsUsed] });
    if (!canvas) return;

    ui.wrap.innerHTML = '';
    ui.wrap.appendChild(canvas);
    state.canvas = canvas;
    state.rowTops = computeRowTops();
    state.viewW = canvas.width;
    ui.vbar.style.display = '';

    /* 保持视口在图内的相对位置（换页/改密度时不跳回顶部） */
    var oldMax = state._lastMax || 0;
    var frac = oldMax > 0 ? state.viewY / oldMax : 0;
    state.viewY = 0;
    applyScroll();
    if (frac > 0) scrollTo(frac * maxScroll());
    state._lastMax = maxScroll();

    updatePosLabel();
    updateThumb();
  }

  /** 提示/错误占位：只动 .wrap，不动 .vbar / .grip（它们是常驻元素） */
  function setStage(html, cls) {
    ui.wrap.innerHTML = '<div class="' + (cls || 'ph') + '">' + html + '</div>';
    ui.wrap.style.transform = '';
    ui.canvas = null;
    ui.rowTops = null;
    ui.vbar.style.display = 'none';
    ui.pos.textContent = '—';
  }

  /* ===================================================================== *
   * 加载流程
   * ===================================================================== */

  function reload() {
    /* ★ 用 effectiveBeatmapId()（= extractBeatmapId() || resolveSbBeatmapId()），
       不是 extractBeatmapId()。
       私服切难度后 URL 里是 32 位 hash，extractBeatmapId() 返回 null，
       这里若还用它就会走「不是谱面页」分支 —— hash URL 下窗口永远不出现。*/
    var bid = effectiveBeatmapId();
    if (!bid) {
      state.beatmapId = null;
      state.rawText = null;
      state.modeBlocked = null;
      setStage('在谱面页面（/b/123 或 /beatmapsets/123?beatmap=456）上生效', 'ph');
      ui.title.textContent = 'osu!taiko 预览';
      ui.sub.textContent = '';
      ui.pos.textContent = '—';
      return;
    }
    /* ★ hash 已经说明是不可渲染的模式（#mania/… / #fruits/…）：
       连下载都不必，直接隐藏。放在最前面可以避免每次切难度都白拉一次
       https://osu.ppy.sh/osu/{bid}。*/
    var urlMode = extractUrlMode();
    if (urlMode && !URL_MODES_OK[urlMode]) {
      state.beatmapId = bid;
      state.rawText = null;
      state.modeBlocked = { bid: bid, mode: urlMode, name: modeName(urlMode) };
      hideByMode();
      return;
    }
    state.beatmapId = bid;
    state.modeBlocked = null;
    setStage('正在读取谱面…', 'ph');
    ui.title.textContent = 'osu!taiko 预览';
    ui.sub.textContent = 'bid ' + bid;

    fetchOsuText(bid).then(function (text) {
      if (state.beatmapId !== bid) return;      // 期间切走了
      /* ★ URL 没带模式时（/b/123、?beatmap=456）判不出来，
         只能靠 .osu 里的 Mode 行确认。Mode 2/3+ 整窗隐藏，
         而不是弹一个「本插件只渲染 taiko」的报错窗。
         Mode 0（std）放行 —— osu_parser 会按官方转换器转成 taiko 物件。*/
      var mode = peekOsuMode(text);
      if (mode !== null && mode !== 0 && mode !== 1) {
        state.rawText = null;
        state.bm = null; state.lay = null; state.cfg = null;
        /* 谱面被判为不可渲染时也要把段位行清掉，
           否则会留着上一张谱的段位，看起来像这张谱的。*/
        clearDanRow();
        state.renderer = null; state.srData = null;
        state.modeBlocked = { bid: bid, mode: mode, name: modeName(mode) };
        hideByMode();
        return;
      }
      state.rawText = text;
      var w = contentWidth();

      /* 段位/键型：**必须在 buildPreview 之前**算完。
       * 原因是 cfg.danRowH 依赖 state.danRow（决定画布多高），
       * 而 cfg 是 buildPreview 内部构造的 —— 顺序反了的话，
       * 首帧会按「没有段位行」的高度画，段位算完后再重画一次，
       * 而且 danRowH 还是 0（renderer 已经建好了）。*/
      var bmForDan = window.OSU_TAIKO_PARSE.parseOsu(text);
      updateDanRow(bmForDan);

      var built = buildPreview(text, pickTitle(), w, bmForDan, bid);
      state.bm = built.bm;
      state.lay = built.lay;
      state.cfg = built.cfg;
      state.renderer = built.renderer;
      state.srData = built.srData || null;
      state._lastMax = 0;
      state.viewY = 0;

      var d = built.bm;
      var ms = built.lay;
      ui.title.textContent = built.title || (d.title || 'Unknown');
      var bits = [];
      bits.push('[' + (d.version || '') + ']');
      /* ★ bid 必须取**URL 里的**值（state.beatmapId），不是 .osu 里的
       *   `d.beatmapId`。
       *
       *   原因：osu! 侧存在「多个难度共用同一个 BeatmapID」的数据异常。
       *   实测 sid 703200 `Dan-i Dojo (Part.2)`：
       *     /osu/1563291 -> Version:9thDan，但文件里 BeatmapID:1498109
       *     /osu/1498109 -> Version:10th Dan，文件里也是 BeatmapID:1498109
       *   显示文件里的值会给出**误导性**的 bid —— 用户在地址栏看到的是
       *   1563291，标题栏却写 1498109，复制出去就找错了谱面。
       *   URL 是用户唯一能自己核对的那一份，所以它才是权威。
       *
       *   不一致时（文件里的值与 URL 不同）在末尾加一个标记，
       *   让「为什么两者不一样」可见，而不是悄悄显示另一个值。*/
      var urlBid = state.beatmapId;
      var fileBid = d.beatmapId;
      bits.push('bid ' + (urlBid || fileBid));
      if (d.beatmapSetId) bits.push('sid ' + d.beatmapSetId);
      /* 谱面文件自报的 ID 与 URL 不一致 —— 打个小标记，别让人以为插件抓错了谱。
         （内容仍按 URL 的那个 bid 取的，所以数据是对的。）*/
      var bidMismatch = urlBid && fileBid && String(urlBid) !== String(fileBid);
      if (bidMismatch) bits.push('(文件标 ' + fileBid + ')');
      /* 时长与 BPM 都要按 mod 的流速折算（DT/NC ÷1.5、HT ÷0.75；BPM 反向乘）。
         renderer._modRate() 是同一份口径 —— 标题栏与画布信息栏必须一致，
         否则开DT 时标题写 3:38、画布里却是 1.5 倍速的读谱。*/
      var rate = state.renderer._modRate();
      bits.push(fmtTime((ms.tEnd - ms.t0) / rate));
      /* BPM 必须与画布信息栏**同源**（renderer.bpmRange 的时长加权口径）。
         之前这里用 bpmAt(t0) ——「首个音符处的 BPM」，变速谱常常
         开头 120慢板、主体 200+，于是标题栏与画布里的 BPM 对不上。
         标题栏空间有限，只显示主 BPM（信息栏才显示完整范围）。
         rate != 1 时按用户要求四舍五入到整数。*/
      var br = state.renderer.bpmRange();
      if (br) {
        var br2 = rate === 1
          ? br
          : { min: Math.round(br.min * rate), max: Math.round(br.max * rate),
              main: Math.round(br.main * rate) };
        var bpmTxt = window.OSU_TAIKO_RENDERER.fmtBpmRange(br2, 'main');
        if (bpmTxt) bits.push(bpmTxt + ' BPM');
      }
      ui.sub.textContent = bits.join(' · ');

      render();

    }).catch(function (e) {
      if (state.beatmapId !== bid) return;
      setStage(escapeHtml(e.message), 'er');
    });
  }

  /**
   * 只读 .osu 文本里的 `Mode:` 行，不做完整解析。
   *
   * 为什么单独要一个：URL 形如 `/b/123`、`?beatmap=456` 时**没有任何模式
   * 信息**，只有把谱面拉下来才知道是 taiko 还是 std/mania。
   * 用正则取一行比跑一遍 parseOsu 便宜得多 —— 非 taiko 的场合
   * 后面整套解析/布局/渲染/SR 全都不用做。
   *
   * @returns {number|null} Mode 编号；取不到返回 null（当作「未知，放行」）
   */
  function peekOsuMode(text) {
    if (!text) return null;
    var m = text.match(/^\s*Mode\s*:\s*(\d+)\s*$/mi);
    if (!m) return null;
    var v = parseInt(m[1], 10);
    return isFinite(v) ? v : null;
  }

  /**
   * 非 taiko 谱：把窗口整个收掉。
   *
   * ★ 与 hideByRoute() 的区别：那只是「当前不在谱面页」，随时会回来；
   *   这里是在**谱面页**上，只是这张谱不是 taiko，窗口不该存在。
   *   依然不写 userClosed —— 同一页切到 taiko 难度时必须能自动弹出。
   */
  function hideByMode() {
    state.visible = false;
    state.userClosed = false;
    if (ui.host) ui.host.style.display = 'none';
  }

  /**
   * 当前「不显示窗口」是否是因为**这张谱不可渲染**（mania / catch）；是则返回模式名，否则 null。
   * popup 用它区分「非谱面页」和「这张谱是 mania/catch」两种灰态。
   */
  function modeBlockReason() {
    /* 情况一：hash 直接写了不可渲染的模式。
       这条**不依赖 state.modeBlocked** —— 因为 onMapPage() 为false 时
       reload() 根本不会被调用（也就没有下载、没有 modeBlocked 记录），
       只看 modeBlocked 会返回 null，popup 就只能显示笼统的「非谱面页」。*/
    var um = extractUrlMode();
    if (um && !URL_MODES_OK[um]) return modeName(um);
    /* 情况二：URL 没写模式，靠下载 .osu 的 Mode 行才判出来。*/
    var b = state.modeBlocked;
    if (!b) return null;
    /* 只认**当前这张谱**的拦截记录：bid 变了（切到别的难度）就作废。
       ★ 用 effectiveBeatmapId()：state.modeBlocked.bid 存的是
       effectiveBeatmapId() 的结果（可能是从 hash 查表来的数字 id），
       这里若用 extractBeatmapId()，私服 hash URL 下会算出 null != bid，
       于是「这个谱已被拦截」的记录失效，popup 会误报「非谱面页」。*/
    if (b.bid !== effectiveBeatmapId()) return null;
    return b.name || '非 osu!taiko 谱面';
  }

  function fmtTime(ms) {
    if (!isFinite(ms) || ms < 0) ms = 0;
    var s = Math.floor(ms / 1000);
    var m = Math.floor(s / 60);
    return m + ':' + String(s % 60).padStart(2, '0');
  }

  function escapeHtml(s) {
    var d = document.createElement('div');
    d.appendChild(document.createTextNode(s));
    return d.innerHTML;
  }

  /* ===================================================================== *
   * 启动 + SPA 路由监听
   *
   * 显示策略分两层：
   *   state.userClosed —— 用户点了 ✕ 或popup 关闭。**跨页面记忆**，
   *                      重新进谱面页也不自动弹出来（否则关不掉）。
   *   onMapPage()      —— 当前 URL 是否是谱面页。非谱面页自动隐藏，
   *                      重新进谱面页自动恢复 —— 这解决了
   *                      「退到商店窗口消失、再点进谱面窗口不回来，只能刷新」。
   * ===================================================================== */

  /**
 * 确保宿主元素还挂在文档里。
   *
   * ★ 这是「退到商店再重新点进谱面页，窗口不出来、必须刷新」的**真正根因**。
   *
   * osu! 是 Nuxt，SPA 路由切换时会**重建 body 的子树**
   * （Nuxt 换 layout 会替换挂载点）。而 buildUI() 只在启动时做一次
   * `document.body.appendChild(host)`，之后再不检查宿主是否还活着。
   * 于是：
   *   首次进谱面页 -> host 在body 里，显示 ✅
   *   退到商店    -> Nuxt 重建 body，host 被一起丢掉
   *   再进谱面页  -> show() 设display=''，但 host 已经不在文档里了，
   *                 页面上什么都不会出现
   *   刷新页面    -> buildUI 重新执行、重新 appendChild -> 好了
   *
   * 这个 bug 与 userClosed 无关，也与 pushState 劫持无关 ——
   * 就算前两者全对，宿主不在文档里也照样显示不出来。
   *
   * @returns {boolean} true 表示刚被重新挂载
   */
  function ensureHostMounted() {
    if (!ui.host) return false;
    /* isConnected 是标准属性：只要还在文档里就为 true。
       用它比 document.body.contains(ui.host) 更直接 —— 后者在
       host 恰好是 body 直接子元素时也没问题，但前者语义更明确。*/
    if (ui.host.isConnected) return false;
    /* 优先挂到 documentElement（<html>）—— 与 buildUI 里的选择一致，
       躲开 Nuxt 对 body 子树的重建。*/
    var parent = document.documentElement || document.body;
    if (!parent) return false;
    try {
      parent.appendChild(ui.host);
      return true;
    } catch (e) {
      /* 万一 documentElement 也不行，退回 body */
      try {
        if (document.body) { document.body.appendChild(ui.host); return true; }
      } catch (e2) { /* 忽略 */ }
      return false;
    }
  }

  function show() {
    /* ★ 先保证宿主在文档里，再谈显示 —— 顺序不能反。
       display='' 设在脱离文档的元素上不会有任何效果。*/
    ensureHostMounted();
    state.visible = true;
    ui.host.style.display = '';
    /* 隐藏期间浏览器窗口可能变窄/变矮，此时不夹取（clampPanel 会因
       量不到尺寸而返回），显示后要补一次，否则窗口可能超出视口。*/
    clampPanel();
    reload();
  }

  /** 纯隐藏（不写 userClosed，也不存 prefs）—— 供路由切换使用 */
  function hideByRoute() {
    if (!state.visible) return;
    state.visible = false;
    ui.host.style.display = 'none';
  }

  /** 手动隐藏（✕ 按钮 / popup「隐藏」）。**只压当前页**。*/
  function hide() {
    state.visible = false;
    state.userClosed = true;         /*瞬时标记，只给 popup 显示用 */
    ui.host.style.display = 'none';
  }

  /**
 * 按当前路由同步窗口显隐；返回是否显示了。
 *
 * ★ 语义：**任何隐藏都只作用于当前这一页**。
 *
 * 曾试过用持久化的 `userClosed` 表达「用户主动关掉」，但那和
 * 用户真正要的直接冲突 —— 他们两次反馈的都是同一个期望：
 *   「退到商店再重新点进谱面页，窗口应该自动弹出来」
 * 一旦`userClosed` 持久化，这条路径就永久堵死，而且连 popup 按钮
 * 都救不回来（要先意识到「再点一次」才行）。
 *
 * 所以现在：**隐藏 = 只压当前页，切谱/进出谱面页一律恢复**。
 * `userClosed` 只作为「本页被手动关过」的**瞬时**标记（不持久化），
 * 供 popup 显示用，不参与显隐决策。
 */
  function syncVisibility() {
    if (!onMapPage()) { hideByRoute(); return false; }
    /* ★ 两个条件都要触发 show()：
       1. !state.visible      —— 窗口当前是隐藏的
       2. !ui.host.isConnected —— 窗口「以为自己显示着」，但宿主已被
          SPA 移出文档（Nuxt 重建 body）。这种情况 state.visible 仍是
          true，只判第1 条的话 show() 永远不会被调用 -> 页面上什么都没有，
          而内部状态一切正常 —— 这正是「必须刷新页面」最难查的那种故障。*/
    if (!state.visible || !ui.host || !ui.host.isConnected) {
      show();
      return true;
    }
    return true;
  }

  /* ===================================================================== *
   * 把 page_route_hook.js 注入到页面世界
   *
   * 见 init() 里 1c) 的说明：content script 在隔离世界，
   * 自己劫持 history 没用，必须让页面世界里的代码来劫持。
   * ===================================================================== */

  function injectPageHook() {
    try {
      var url = chrome.runtime.getURL('page_route_hook.js');
      var s = document.createElement('script');
      s.src = url;
      /* 用完即删，不在 DOM 里留痕迹。onload 后删更稳（执行完才移除）。*/
      s.onload = function () { s.remove(); };
      s.onerror = function () { s.remove(); };
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {
      /* 注入失败（manifest 没把文件列进 web_accessible_resources 等）。
         不会致命 —— URL 轮询 + visibilitychange 仍然兜底，
         只是切换页面后可能延迟几秒。*/
      console.warn('[osu-taiko-preview] 路由钩子注入失败，'
        + '将退回轮询（切换页面后可能延迟数秒）', e);
    }
  }

  function init() {
    if (!document.body) return setTimeout(init, 100);
    /* 幂等：whenModulesReady 里有「兜底超时」分支，可能与正常路径重复调用 */
    if (state._inited) return;
    state._inited = true;
    buildUI(function () {
      /* 默认尺寸写在 CSS 里（700×520，右下角）；restoreWindow 里若有
         记忆值会覆盖它。必须在首次 reload 之前定好宽度，
         否则会按默认宽度渲染一次再重算。*/
      if (!onMapPage()) {
        /* 非谱面页：先建UI 但不显示。
           注意这里**不查 userClosed** —— 只要在谱面页就该显示，
           否则用户上次点过 ✕ 之后，刷新页面也永远看不到窗口。*/
        hideByRoute();
      } else {
        reload();
      }
    });

    /* 路由变化的统一处理：URL 轮询、页面世界钩子、hashchange 都调它。
     必须**幂等** —— 三个入口可能对同一次路由变化都触发一次。*/
    function routeChanged() {
      var wasBid = state.beatmapId;
      syncVisibility();
      /* 同上：必须能识别私服的 hash URL，否则切难度不会触发重载。*/
      var bid = effectiveBeatmapId();
      /* 谱面变了就重新加载。
         注意判据是「bid 变了」而不是「之前可见 & 现在可见」——
         从商店直接点进谱面页时 wasVisible=false（商店里是隐藏的），
         但新谱面**必须**加载出来，否则窗口会显示上一张谱或空白。*/
      if (state.visible && bid && bid !== wasBid) reload();
    }

    /* 1) URL变化：轮询兜底。
     *interval 用250ms 而不是 400ms —— Chrome 把后台标签页的定时器
       节流到「每分钟一次」，间隔调小只能改善前台体验；
       真正的解法是上面的页面世界钩子（pushState 即时通知）。*/
    var lastUrl = location.href;
    var lastHash = location.hash;
    setInterval(function () {
      /* ★ 同时自愈「宿主被移出文档」。
         Nuxt 重建 body 时可能**没有**伴随 URL 变化（比如它先清空
         body 再异步填新内容），这时上面三个入口都不会触发，
         窗口就成了「内部状态正常、但页面上什么都没有」——
         用户唯一能做的就是刷新。
         这里每拍检查一次 isConnected，掉了就重新挂载。*/
      if (ui.host && !ui.host.isConnected && onMapPage()) {
        ensureHostMounted();
        /* 重新挂载后要重画：shadow DOM 里的 canvas 内容还在，
           但尺寸可能因布局变化而不对，走一次 reload 最稳。*/
        if (state.visible) reload();
      }
      if (location.href === lastUrl && location.hash === lastHash) return;
      lastUrl = location.href;
      lastHash = location.hash;
      routeChanged();
    }, 250);

    /* 1a) ★ 标签页重新可见时立刻补判一次。
     * 后台标签页的定时器被节流到每分钟一次，而用户切回来的那一刻
     * URL 可能早就变了。`visibilitychange` 不受节流影响（是事件），
     * 在这里补判一次就能立刻恢复 —— 这是节流的正解。*/
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      lastUrl = location.href;
      lastHash = location.hash;
      routeChanged();
    });

    /* 1c) ★ 真正的路由监听：把 page_route_hook.js 注入到**页面世界**
     *
     * 踩过的坑：先前在content.js 里直接写
     *     history.pushState = function () { ... }
     * 以为劫持成功��实际上**完全无效** ——
     * Chrome 的 content script 跑在隔离世界（isolated world），
     * 它有自己的 window/history 对象，与页面共享 DOM 但**不共享 JS**。
     * 页面里的 vue-router 调的还是页面自己的 pushState。
     * 我的 Node 测试桩里content script 与「页面」是同一个 globalThis，
     * 所以测试一直是绿的，真实环境却从来没生效过。
     *
     * 正确做法：注入 <script> 让代码在**页面世界**执行，
     * 它劫持自己的 history，再用 CustomEvent 把通知送回来
     * （DOM 事件可以跨隔离世界传播）。
     *
     * 为什么必须有这一层：上面两个 setInterval 是**轮询**，
     * 而 Chrome 把后台标签页的定时器节流到「每分钟一次」。
     * 用户在另一个标签页点进谱面页时，路由早就变了而轮询还在睡。*/
    injectPageHook();

    /* 监听页面世界送来的路由事件 */
    document.addEventListener('osu-taiko:routechange', function () {
      /* 让 URL 轮询的缓存失效，强制下一拍重新判断（幂等）*/
      lastUrl = location.href;
      lastHash = location.hash;
      routeChanged();
    });

    /* 2) DOM 变化（SPA 切难度时 URL 可能不变，只变 hash 之外的 DOM）
        注意：官网是 Nuxt，body 子树变动非常频繁（动画、观察器自身…），
        必须做防抖 + 「bid 真的变了才重载」，否则会陷入
        reload -> 渲染 -> 改DOM -> 触发 observer 的死循环。 */
    var moPending = 0;
    var mo = new MutationObserver(function () {
      if (moPending) return;
      moPending = setTimeout(function () {
        moPending = 0;
        var bid = effectiveBeatmapId();
        if (bid !== state.beatmapId) syncVisibility();
      }, 350);
    });
    mo.observe(document.body, { childList: true, subtree: true });

    /* 3) 来自 popup 的消息 */
    try {
      chrome.runtime.onMessage.addListener(function (msg, _s, send) {
        if (!msg) return;
        if (msg.type === 'toggle') {
          /* 语义就是「反着来」：当前可见 -> 关掉；当前不可见 -> 打开。
             两种「不可见」要分开处理：
             · 只是当前不在谱面页 -> 真的没法显示，如实回报
             · 在谱面页但被隐藏了   -> 直接显示
             注意不能写成 `state.userClosed = state.visible` 再去读
             `state.userClosed` —— 那个值已被覆盖，「关掉 -> 再点」
             会永远走 hide 分支，怎么点都打不开。*/
          if (!onMapPage()) {
            /* 非谱面页 / 非 taiko 谱：无论点多少次都不会有窗口。如实回报，
               让 popup 把按钮置灰+ 给出原因，而不是让用户以为按钮坏了。*/
            send && send({
              visible: state.visible, onMapPage: false,
              userClosed: state.userClosed, hiddenByRoute: true,
              notTaiko: modeBlockReason(),
            });
            return;
          }
          if (state.visible && (!ui.host || ui.host.isConnected)) {
            /* 真正可见（且宿主在文档里）-> 关掉。
               注意必须加 isConnected 判断：如果宿主已被 SPA 移出文档，
               state.visible 仍是 true，但页面上其实什么都看不到 ——
               这时再点「隐藏」等于把已经看不见的东西又「关」一次，
               用户会觉得按钮完全没反应。应该当作「显示」处理。*/
            hide();
          } else {
            /* 隐藏着、或宿主已脱离文档 -> 清标记并显示
               （show() 里先ensureHostMounted 再 display=''）*/
            state.userClosed = false;
            show();
          }
          send && send({
            visible: state.visible,
            onMapPage: true,
            userClosed: state.userClosed,
            hiddenByRoute: false,
          });
        } else if (msg.type === 'refresh') {
          osuCache = Object.create(null);
          if (state.visible) reload();
        } else if (msg.type === 'reset') {
          /*清掉「用户关掉过」的标记并恢复默认显隐。
           * 供 popup 的「恢复默认」与自动化测试使用 ——
           * userClosed 会持久化到storage，光刷新路由是清不掉的。*/
          state.userClosed = false;
          savePrefs();
          osuCache = Object.create(null);
          syncVisibility();
          send && send({ visible: state.visible, onMapPage: onMapPage() });
        } else if (msg.type === 'status') {
          send && send({
            visible: state.visible,
            /* 宿主是否还在文档里。state.visible=true 但这个是false 时，
               窗口其实**看不见**（被 SPA 移出了 body）—— popup 必须
               据此显示「窗口已脱离页面」，否则用户点「隐藏」会以为没反应。*/
            mounted: !!(ui.host && ui.host.isConnected),
            /* 版本号：popup 靠它识别「页面里跑的是旧版content script」。
             * 扩展更新后已经打开的页面不会自动重新注入 content script，
             * 于是新 popup 读到旧回执（缺 onMapPage 等字段），
             * 就会出现「已加载/SR 都有值，上面却写非谱面页」的矛盾状态。
             * 有这个字段就能明确告诉用户「请刷新页面」，而不是让用户猜。*/
            proto: 16,
            /* popup 要显示「当前页面」状态并决定按钮是否可用。
             * 必须由这里回答 —— popup 自己写一遍 URL 正则必然与
             * onMapPage() 判不出一样的结果（用户反馈过按钮"不生效"，
             * 实际是 popup 显示「非谱面页」而窗口好好开着，自相矛盾）。*/
            onMapPage: onMapPage(),
            /* 非 taiko 时的原因描述（如「osu!mania」），popup 拿它把
               灰色的原因写清楚，而不是笼统说「非谱面页」。*/
            notTaiko: modeBlockReason(),
            userClosed: state.userClosed,
            beatmapId: state.beatmapId,
            title: ui.title.textContent, sub: ui.sub.textContent,
            /* 当前 mod 与 SR/PP —— popup 与测试都要读它。
             * 注意：**画布高度不能用来判断 mod 是否生效**，
             * 因为 HT/DT 只改流速(rate)、不改时间→x 的映射，
             * 所以行数与画布高度在换 mod 后是不变的。*/
            mod: currentModName(),
            modLabel: currentModLabel(),
            sr: state.srData ? state.srData.starRating : null,
            srBase: state.srData ? state.srData.starRatingBase : null,
            maxPp: state.srData ? state.srData.maxPp : null,
          });
        }
      });
    } catch (e) { /* 非扩展环境（如直接 file:// 打开）忽略 */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', whenModulesReady);
  } else {
    whenModulesReady();
  }

  /**
   * 等 bridge.js 把三个模块挂到 window 上再启动。
   *
   * bridge.js 用 dynamic import 异步加载模块，而本脚本是同步执行的，
   * 若不等就会撞上「window.OSU_TAIKO_PARSE 尚未定义」。
   */
  function whenModulesReady() {
    /* bridge 已就绪（可能事件在本次监听前就派发过了） */
    if (window.OSU_TAIKO_READY === true) { init(); return; }
    if (window.OSU_TAIKO_READY === false) {
      return failInit(window.OSU_TAIKO_ERROR || '模块加载失败');
    }
    /* 还没就绪 -> 等事件。once:true 保证只处理一次，
       避免兜底定时器与事件同时触发导致 init 跑两遍（init 另有幂等保护）。 */
    document.addEventListener('osu-taiko-modules-ready', function () {
      if (window.OSU_TAIKO_READY === true) init();
      else failInit(window.OSU_TAIKO_ERROR || '模块加载失败');
    }, { once: true });

    /* 兜底：8 秒仍未就绪才判失败（模块走 dynamic import，
       冷启动时可能要几百毫秒；这里给足余量）。 */
    setTimeout(function () {
      if (window.OSU_TAIKO_READY === true) init();
      else if (window.OSU_TAIKO_READY === undefined) {
        failInit('模块加载超时');
      }
      /* READY===false 说明已明确失败，事件里已处理过，这里不动 */
    }, 8000);
  }

  function failInit(msg) {
    console.error('[osu-taiko-preview]', msg);
    if (!document.body) return;
    /* 窗口本身要能出来，用户才能看到错误提示并手动关闭 */
    buildUI(function () { setStage('初始化失败：' + escapeHtml(msg), 'er'); });
  }
})();