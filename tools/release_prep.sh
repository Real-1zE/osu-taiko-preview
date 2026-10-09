#!/usr/bin/env bash
# =============================================================
# 发布准备：生成一个干净的、可直接发到 GitHub Release 的目录
# =============================================================
#
# 为什么需要这个脚本：
#   仓库里 `taiko-preview-web/` 混着**开发文件**（dev/ test/ docs/ README.md），
#   它们占 6.8MB 但运行时一个都不用，而且 test/ 里有 100+ 张真实谱面样本
#   ——那是本地语料，不该公开。
#
#   同时它要处理发布必需、但仓库里目前没有的东西：
#     · LICENSE（开源协议，GitHub 没这个就没法标注授权）
#     · 用户版 README（仓库里那份是给开发者的）
#     · .gitignore（避免误提交 node_modules / dist /测试语料）
#     · 版本一致性校验（manifest 的版本号 vs CHANGELOG）
#
# 用法：
#   bash tools/release_prep.sh# 生成 release/ 目录（会先清空）
#   bash tools/release_prep.sh --check              # 只校验，不生成
#
# 产物结构（= 用户拿到就能用的全部内容）：
#   release/
#     osu-taiko-preview/← 插件本体（= 加载已解压的扩展程序选这个目录）
#     README.md              ← 给用户看的
#     CHANGELOG.md
#     LICENSE
#     .gitignore
#     RELEASE_NOTES.md       ← 贴到 GitHub Release 的正文

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

OUT="$HERE/release"
PLUGIN_NAME="osu-taiko-preview"
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

# ---------------------------------------------------------- 校验
# 在生成之前就把问题挑出来，别等传到 GitHub 才发现。
fail=0
say()  { printf '  %s\n' "$1"; }
ok()   { printf '  ✅ %s\n' "$1"; }
bad()  { printf '  ❌ %s\n' "$1"; fail=1; }

echo "发布前检查："

VERSION="$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' manifest.json \
  | head -1 | sed 's/.*"\([^"]*\)"/\1/')"
[ -n "$VERSION" ] && ok "版本号 $VERSION（manifest.json）" \
  || bad "读不到 manifest.json 的版本号"

# manifest 里没写 homepage_url / license —— Chrome Web Store 与 GitHub 都需要
for f in manifest.json bridge.js content.js page_route_hook.js popup.html popup.js; do
  [ -f "$f" ] || bad "缺少运行时文件 $f"
done
for f in lib/osu_parser.js lib/layout.js lib/renderer.js lib/difficulty.js \
         lib/pp.js lib/sr_panel.js lib/dan_rank.js lib/dan_calibration.js \
         lib/dan_bridge.js; do
  [ -f "$f" ] || bad "缺少 lib 模块 $f"
done
[ -d icons ] && ok "图标目录" || bad "缺少 icons/"

# 「零依赖」是发布时最该承诺的事，验一下别混进外部资源
if grep -rn 'src="http\|href="http\|@import\|cdn\.' \
     manifest.json popup.html content.js bridge.js popup.js lib/*.js 2>/dev/null \
     | grep -v 'osu.ppy\|catboy.best\|www.w3.org'; then
  bad "发现外部资源引用（CDN / 远程脚本）—— 这会破坏「零依赖离线可用」的承诺"
else
  ok "无外部资源引用（离线可用）"
fi

# web_accessible_resources 要覆盖 lib 下所有 js，否则 bridge 动态 import 会失败
if ! grep -q '"lib/\*\.js"' manifest.json; then
  bad 'manifest 的 web_accessible_resources 未覆盖 lib/*.js'
else
  ok "web_accessible_resources 覆盖 lib/*.js"
fi

[ "$fail" = 1 ] && { echo; echo "检查未通过，先修上面标红的问题。"; exit 1; }
echo

if [ "$CHECK_ONLY" = 1 ]; then
  echo "（--check 模式，只校验不生成）"
  exit 0
fi

# ---------------------------------------------------------- 生成
echo "生成发布目录："
rm -rf "$OUT"
mkdir -p "$OUT/$PLUGIN_NAME"

# 只拷运行时文件。lib/ 整目录打（manifest 的 web_accessible_resources 是 lib/*.js）。
cp manifest.json bridge.js content.js page_route_hook.js popup.html popup.js \
   "$OUT/$PLUGIN_NAME/"
cp -r lib icons "$OUT/$PLUGIN_NAME/"

# 校验产物：列进去的文件都要是 manifest 引用得着的
N_FILES=$(find "$OUT/$PLUGIN_NAME" -type f | wc -l)
SIZE=$(du -sh "$OUT/$PLUGIN_NAME" | cut -f1)
say "$PLUGIN_NAME/ —— $N_FILES 个文件，$SIZE"

# ---------------------------------------------------------- 附加文件
cp LICENSE "$OUT/LICENSE" 2>/dev/null \
  && say "LICENSE" || bad "缺少 LICENSE 文件"
cp CHANGELOG.md "$OUT/CHANGELOG.md" 2>/dev/null \
  && say "CHANGELOG.md" || say "（无 CHANGELOG.md，跳过）"
cp README-user.md "$OUT/README.md" 2>/dev/null \
  && say "README.md（用户版，来自 README-user.md）" \
  || bad "缺少 README-user.md（用户版说明）"

# ★ README-user.md 里的截图用**相对路径** docs/screenshots/xxx.png。
#   这个 README 会被挪到 $OUT/ 根下，所以截图必须一起搬过去，
#   否则发布出去是裂图 —— 而且这种错只在GitHub 上才看得出来。
if [ -d docs/screenshots ]; then
  mkdir -p "$OUT/docs"
  cp -r docs/screenshots "$OUT/docs/"
  say "docs/screenshots/（README 引用的截图，$(
       find docs/screenshots -type f | wc -l) 张）"
fi
cp .gitignore "$OUT/.gitignore" 2>/dev/null \
  && say ".gitignore" || bad "缺少 .gitignore"

# ---- 校验：README 引用的图片都得在 ----
missing_img=0
for img in $(grep -o '](docs/screenshots/[^)]*)' "$OUT/README.md" 2>/dev/null \
             | sed 's/^](//; s/)$//'); do
  [ -f "$OUT/$img" ] || { bad "README 引用了 $img 但发布目录里没有（会裂图）"; missing_img=1; }
done
[ "$missing_img" = 0 ] && ok "README 引用的截图齐全"

# 把版本号写进 CHANGELOG 的「未发布」标题，避免忘了同步
echo
echo "下一步："
echo "  1. 打开 $OUT/ 检查一遍"
echo "  2. 打 zip 给别人："
echo "       cd '$OUT' && zip -r osu-taiko-preview-$VERSION.zip '$PLUGIN_NAME' README.md LICENSE"
echo "     （或用 bash tools/package_extension.sh 只打插件本体）"
echo "  3. 建仓库并上传（见 README-user.md 的「发布到 GitHub」一节）"