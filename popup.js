/**
 * popup：显示当前标签页状态，并给窗口的显示/隐藏、重新加载下指令。
 *
 * 状态查询走 chrome.tabs.sendMessage -> content.js 的 'status' 分支。
 * 若content script 没注入（用户没打开过谱面页），提示先打开谱面页。
 */

function activeTab(cb) {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    cb(tabs && tabs[0]);
  });
}

function sendToTab(tab, msg) {
  return new Promise(function (resolve) {
    if (!tab || !tab.id) { resolve({ error: '没有活动标签页' }); return; }
    try {
      chrome.tabs.sendMessage(tab.id, msg, function (resp) {
        if (chrome.runtime.lastError) {
          resolve({ error: '当前页面未注入插件脚本' });
        } else {
          resolve(resp || {});
        }
      });
    } catch (e) {
      resolve({ error: e.message });
    }
  });
}

function refreshStatus() {
  activeTab(async function (tab) {
    var dot = document.getElementById('dot');
    var page = document.getElementById('page');
    var mapRow = document.getElementById('mapRow');
    var mapVal = document.getElementById('map');
    var toggleBtn = document.getElementById('toggle');

    if (!tab || !tab.url) {
      dot.className = 'dot';
      page.textContent = '未知';
      return;
    }

    var resp = await sendToTab(tab, { type: 'status' });

    /* ★ 页面类型**问 content script**，不要在这里自己写一遍 URL 正则。
       两处各判一次必然对不上（用户反馈过按钮"不生效"）。

       ★★ 但必须处理「字段缺失」：`onMapPage` 是 v1.4.2 才加进status 回执的。
       扩展更新后**已经打开的页面**跑的还是旧 content script，
       回执里没有这个字段 -> undefined。若直接当 false 用，
       就会出现用户截图里那种自相矛盾的状态：
         「已加载：Trillium」+「SR 7.60★」都有值（明明是谱面页、已注入），
         上面却写「非谱面页」、按钮还是灰的。
       所以用 `typeof === 'boolean'` 严格区分「false」与「不知道」，
       不知道时按 beatmapId 兜底，并提示刷新页面。*/
    var injected = resp && !resp.error;
    /* `proto` 是 content script 的协议版本（v1.4.2 引入 = 2）。
     * 扩展更新后**已经打开的页面**仍跑旧版 content script，
     * 回执里既没有 proto 也没有 onMapPage。必须把这两种「不知道」
     * 与「明确不是谱面页」区分开，否则会出现用户截图里的矛盾状态：
     * 「已加载：Trillium」+「SR 7.60★」都有值（明明是谱面页、已注入），
     * 上面却写「非谱面页」、按钮还是灰的 —— 看着就像按钮坏了。*/
    var knowsMap = typeof resp.onMapPage === 'boolean';
    /* 兜底：有 bid 就一定是谱面页（哪怕跑的是旧版 content script）*/
    var onMap = knowsMap ? resp.onMapPage : !!resp.beatmapId;
    var stale = injected && typeof resp.proto !== 'number';
    /* 非 taiko 谱（#mania/… / Mode!=1）：content script 会整窗隐藏，
       这里要给出**具体**原因，而不是笼统的「非谱面页」。*/
    var notTaiko = (resp && typeof resp.notTaiko === 'string') ? resp.notTaiko : '';

    if (!injected) {
      dot.className = 'dot';
      page.textContent = '未注入（请刷新页面）';
    } else if (stale) {
      dot.className = 'dot on';
      page.textContent = onMap ? '谱面页（页面未刷新）' : '请刷新页面';
    } else if (notTaiko) {
      dot.className = 'dot';
      page.textContent = notTaiko + ' 谱面（不显示窗口）';
    } else {
      dot.className = 'dot on';
      page.textContent = onMap ? '谱面页' : '非谱面页（不显示窗口）';
    }

    if (injected && resp.beatmapId) {
      mapRow.style.display = 'flex';
      mapVal.textContent = resp.title || ('bid ' + resp.beatmapId);
      mapVal.title = resp.sub || '';
    } else {
      mapRow.style.display = 'none';
    }

    /* SR / 最大 PP —— 与窗口信息栏同一份数据（同一个 mod 状态）*/
    var srRow = document.getElementById('srRow');
    var srMod = document.getElementById('srMod');
    var srVal = document.getElementById('srVal');
    if (injected && typeof resp.sr === 'number') {
      srRow.style.display = 'flex';
      srMod.textContent = resp.modLabel || 'None';
      /* 星数变化值：与信息栏同一口径（基准 = 只留 CL/HD/FL 的星数）*/
      var srTxt = resp.sr.toFixed(2);
      if (typeof resp.srBase === 'number' && resp.srBase > 0) {
        var d = resp.sr - resp.srBase;
        if (Math.abs(d) >= 0.005) {
          srTxt += ' (' + (d >= 0 ? '+' : '') + d.toFixed(2) + ')';
        }
      }
      srVal.textContent = srTxt + '★ · 最大 ' + Math.round(resp.maxPp) + 'PP';
    } else {
      srRow.style.display = 'none';
    }

    /* 按钮文案跟随实际状态。**只有在明确知道不是谱面页时才置灰** ——
       不知道（旧版 content script）时必须保持可用，否则用户被自己的
       旧页面锁死在「按钮点不动」的状态里。*/
    var toggleBtn = document.getElementById('toggle');
    var refreshBtn = document.getElementById('refresh');
    if (!injected) {
      toggleBtn.disabled = true;
      toggleBtn.textContent = '未注入插件脚本';
      toggleBtn.title = '请刷新页面后再试';
      refreshBtn.disabled = true;
    } else if (!onMap) {
      toggleBtn.disabled = true;
      toggleBtn.textContent = notTaiko
        ? ('当前是' + notTaiko + ' 谱面')
        : '非谱面页，无法显示';
      toggleBtn.title = notTaiko
        ? '本插件只渲染 osu!taiko（Mode 1）与其转换谱 osu!（Mode 0）'
        : '请打开谱面页';
      refreshBtn.disabled = true;
    } else {
      toggleBtn.disabled = false;
      /* mounted === false 表示宿主已被 SPA 移出 body，
         此时无论 visible 是什么，页面上都看不到窗口 -> 显示「修复窗口」。*/
      var reallyVisible = resp.visible && resp.mounted !== false;
      toggleBtn.textContent = reallyVisible ? '隐藏窗口'
        : (resp.mounted === false ? '重新挂载窗口' : '显示窗口');
      /* 页面没刷新时给个提示，但**不禁用** —— 旧版 content script 的
         toggle 功能是好的，禁用只会把用户锁死在「点不动」的状态里。*/
      toggleBtn.title = stale ? '页面未刷新：功能可用，但部分判断可能不准' : '';
      refreshBtn.disabled = false;
    }
  });
}

/* 切换窗口显隐。
   ★ 不再「发完就 window.close()」 —— 用户反馈「并不能生效」，
   很大原因是**按了按钮 popup 就消失**，看不到结果，
   于是以为没生效（其实可能已经切了）。
   现在：发消息 -> 等回执 -> 按回执刷新状态与按钮文案，
   留在页面上让用户确认。1.5 秒后自动收起。*/
document.getElementById('toggle').addEventListener('click', function () {
  var btn = this;
  activeTab(async function (tab) {
    btn.disabled = true;
    var resp = await sendToTab(tab, { type: 'toggle' });
    if (resp && resp.error) {
      btn.textContent = '切换失败：' + resp.error;
      btn.disabled = false;
      return;
    }
    /* 旧版 content script 只回 {visible}，不回 onMapPage/hiddenByRoute。
       这里只在**明确**带上 hiddenByRoute 时才提示「非谱面页」，
       字段缺失一律按「已切换」处理。 */
    var why = (resp && resp.hiddenByRoute) ? '（当前不是谱面页）' : '';
    btn.textContent = (resp && resp.visible ? '已显示' : '已隐藏') + why;
    /* 重新拉一次状态，按钮文案与页面指示都跟着变*/
    await refreshStatus();
    btn.disabled = false;
    setTimeout(function () {
      if (!document.body) return;
      window.close();
    }, 1500);
  });
});

document.getElementById('refresh').addEventListener('click', function () {
  var btn = this;
  activeTab(async function (tab) {
    btn.disabled = true;
    btn.textContent = '重新读取中…';
    await sendToTab(tab, { type: 'refresh' });
    await refreshStatus();
    btn.textContent = '已重新读取';
    btn.disabled = false;
    setTimeout(function () {
      if (document.body) window.close();
    }, 1200);
  });
});

refreshStatus();