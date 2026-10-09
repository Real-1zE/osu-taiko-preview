#!/usr/bin/env bash
# 把 README-user.md 同步成根目录的 README.md（GitHub 主页展示的那份）。
#
# ★ 为什么要这个脚本：
#   GitHub 主页**只能**显示仓库根目录的 README.md（文件名固定、不可替换）。
#   而本项目需要两份：
#     README-user.md —— 面向使用者（唯一手写来源）
#     README-dev.md  —— 面向开发者（讲架构 / 测试 / 对拍精度）
#
#   如果根目录的 README.md 也手写，两份必然脱节 ——
#   改了一份忘了另一份，GitHub 上展示的就过期了。
#   所以：手写一份，另一份由本脚本生成。
#
#   同步方向永远是「README-user.md → README.md」，**绝不反向**，
#   避免用户向的文案被开发内容覆盖。
#
# 用法：
#   bash tools/sync_readme.sh# 同步（内容相同则什么都不做）
#   bash tools/sync_readme.sh --check# 只检查是否已同步（CI 用，不改文件）
#
# 加进提交前流程：改完文案先跑一次，否则会提交到过期的 README。

set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SRC="README-user.md"
DST="README.md"

[ -f "$SRC" ] || { echo "❌ 缺少 $SRC（唯一手写来源）"; exit 1; }

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

if cmp -s "$SRC" "$DST"; then
  echo "✅ $DST 已与 $SRC 一致（GitHub 主页会展示用户版）"
  exit 0
fi

if [ "$CHECK_ONLY" = 1 ]; then
  echo "❌ $DST 与 $SRC 不一致 —— GitHub 主页展示的是过期内容"
  echo "   修复：bash tools/sync_readme.sh"
  exit 1
fi

cp "$SRC" "$DST"
echo "✅ 已从 $SRC 同步到 $DST（GitHub 主页将展示用户版）"
echo "   提醒：改动文案请改 $SRC，不要直接改 $DST"