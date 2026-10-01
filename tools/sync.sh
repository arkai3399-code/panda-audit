#!/bin/bash
# 只读重扫三个系统并更新 audit-data.js（不碰仓库工作区、不提交）
#   用法: tools/sync.sh <Panda-Fortune2 仓库路径> <解压后的 panda-growthpilot-core 目录>
# 自动重算: ① 本体（origin/main）与 ② 社内ツール（origin/internal-tools 独有文件）的操作点 / 接口 / 没入口 / 没接上。
# 需人工复核: build.mjs 里登记的条目（逻辑类问题、待核验、三者衔接、③ 的问题）——行号按 24b595f / c15ce5f 写的。
# 四张 archify 图（overview / internal / growthpilot / links）不会自动重画。
set -euo pipefail
REPO="${1:?仓库路径}"; GP="${2:?对接包目录}"; HERE="$(cd "$(dirname "$0")" && pwd)"; T="$(mktemp -d)"
mkdir -p "$T/main" "$T/int"
git -C "$REPO" archive origin/main src api cloud-run/payment-api/src vercel.json firebase.json firestore.rules index.html package.json | tar -x -C "$T/main"
git -C "$REPO" archive origin/internal-tools src scripts docs/internal vercel.json package.json | tar -x -C "$T/int"
ONLY=$(comm -23 <(git -C "$REPO" ls-tree -r --name-only origin/internal-tools -- src | sort) <(git -C "$REPO" ls-tree -r --name-only origin/main -- src | sort) | grep -v "__tests__\|\.bak$" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.stringify(s.trim().split('\n'))))")
node "$HERE/analyze.mjs" "$T/main" "$T/scan.js" '{}' | head -1
node "$HERE/analyze_internal.mjs" "$T/int" "$T/scan_internal.js" "$ONLY" | head -1
node "$HERE/build.mjs" "$T/scan.js" "$T/scan_internal.js" "$GP" "$HERE/../audit-data.js" "$REPO"
rm -rf "$T"
