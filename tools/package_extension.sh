#!/usr/bin/env bash
# 打包插件为可分发的 zip（Chrome/Edge「加载已解压的扩展程序」用）。
#
# 为什么需要这个脚本：
#   * `taiko-preview-web/` 里混着 **开发文件**（dev/ test/ docs/ README.md），
#     它们占 6.8MB 但**运行时一个都不用**。直接压缩整个目录会给对方
#     发一堆无关文件（还包含 100+ 张真实谱面样本）。
#   * 手工挑文件容易漏 —— manifest.json 里的 content_scripts /
#     web_accessible_resources 引用了哪些文件，得按规则算，不能靠记忆。
#
# 打包规则（与 manifest.json 对应，改 manifest 时这里也要跟着改）：
#   manifest.json      必需
#   bridge.js          content_scripts 注入
#   content.js         content_scripts 注入
#   page_route_hook.js web_accessible_resources
#   popup.html/popup.js action.default_popup
#   icons/             manifest.icons + action.default_icon
#   lib/*.js           web_accessible_resources（bridge.js 动态 import）
#
# 用法：
#   bash tools/package_extension.sh              # 输出 dist/taiko-preview-web-<版本>.zip
#   bash tools/package_extension.sh --with-dev   # 连开发文件一起打包（给自己用）
#
# 验证打包结果（可选，但建议跑）：
#   unzip -l dist/*.zip | head -40

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

WITH_DEV=0
[ "${1:-}" = "--with-dev" ] && WITH_DEV=1

# ---- 版本号从 manifest.json 取（唯一来源，不硬编码）----
VERSION="$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' manifest.json \
  | head -1 | sed 's/.*"\([^"]*\)"/\1/')"
[ -n "$VERSION" ] || { echo "❌ 无法从 manifest.json 读到版本号"; exit 1; }

OUT_DIR="$HERE/dist"
OUT_ZIP="$OUT_DIR/taiko-preview-web-$VERSION.zip"
rm -f "$OUT_ZIP"
mkdir -p "$OUT_DIR"

# ---- 必须存在的运行时文件（缺任何一个都该报错，而不是静默少打）----
RUNTIME_FILES=(
  manifest.json
  bridge.js
  content.js
  page_route_hook.js
  popup.html
  popup.js
)

MISSING=0
for f in "${RUNTIME_FILES[@]}"; do
  if [ ! -f "$f" ]; then
    echo "❌ 缺少运行时文件：$f"
    MISSING=1
  fi
done
for f in lib/osu_parser.js lib/layout.js lib/renderer.js \
         lib/difficulty.js lib/pp.js lib/sr_panel.js \
         lib/dan_rank.js lib/dan_calibration.js lib/dan_bridge.js; do
  if [ ! -f "$f" ]; then
    echo "❌ 缺少 lib 模块：$f"
    MISSING=1
  fi
done
[ -d icons ] || { echo "❌ 缺少 icons/"; MISSING=1; }
[ "$MISSING" = 0 ] || exit 1

# ---- 打包 ----
# -r 递归、-X 不带绝对路径。lib/ 用通配（manifest 里的 web_accessible_resources
# 就是 "lib/*.js"，所以 lib 下**全部** js 都得在包里，不能只挑引用的那几个）。
#
# ★ 用 Python 的 zipfile 而不是 shell 的 `zip` 命令：
#   Git Bash / MSYS 里通常**没有** zip（实测 command not found），
#   而 Python 是这个项目本来就有的依赖（生成标定就要用它）。
if command -v zip >/dev/null 2>&1; then
  zip -r -q -X "$OUT_ZIP" \
    "${RUNTIME_FILES[@]}" \
    lib/ \
    icons/ \
    $([ "$WITH_DEV" = 1 ] && echo "dev/ test/ docs/ README.md")
else
  echo "（未找到 zip 命令，改用 Python zipfile）"
  PY="${PYTHON:-C:/Users/Administrator/.workbuddy/binaries/python/versions/3.13.12/python.exe}"
  command -v python >/dev/null 2>&1 && PY=python
  "$PY" - "$OUT_ZIP" "$WITH_DEV" "${RUNTIME_FILES[@]}" <<'PYEOF'
import os, sys, zipfile
out, with_dev = sys.argv[1], sys.argv[2] == '1'
files = sys.argv[3:]
# 目录项（递归加入，保留空目录也没关系）
dirs = ['lib', 'icons'] + (['dev', 'test', 'docs'] if with_dev else [])
if with_dev:
    files.append('README.md')
seen = set()
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for name in files:
        if name in seen or not os.path.isfile(name):
            continue
        seen.add(name)
        z.write(name, name)
    for d in dirs:
        if not os.path.isdir(d):
            continue
        for root, _dirs, names in os.walk(d):
            for n in sorted(names):
                full = os.path.join(root, n)
                arc = full.replace('\\', '/')
                if arc not in seen:
                    seen.add(arc)
                    z.write(full, arc)
print('  打包 %d 个文件' % len(seen))
PYEOF
fi

SIZE="$(du -h "$OUT_ZIP" | cut -f1)"
echo "✅ 已打包：$OUT_ZIP（$SIZE）"
echo
echo "对方怎么装："
echo "  1. 解压这个 zip 到一个**不会被清理**的目录（比如 工具/taiko-preview-web）"
echo "  2. Chrome/Edge 地址栏打开 chrome://extensions（或 edge://extensions）"
echo "  3. 右上角打开「开发者模式」"
echo "  4. 点「加载已解压的扩展程序」，选刚才那个目录"
echo "  5. 打开 osu! 任意谱面页，窗口会自动出现"
echo
echo "更新时：把新 zip 解压覆盖旧目录，然后在扩展管理页点刷新图标即可。"
