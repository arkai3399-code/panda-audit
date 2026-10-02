#!/bin/bash
# PANDA 全链路排查图 — 自动同步任务（launchd 每 5 分钟跑一次）
# 只读：在独立克隆里 fetch Panda-Fortune2，不碰任何人的工作区；结果推到 arkai3399-code/panda-audit（GitHub Pages）。
# 手动强制：FORCE=1 bash sync_job.sh
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
H="$HOME/Library/Application Support/panda-audit"; REPO="$H/repo"; SITE="$H/site"; TOOLS="$SITE/tools"
ARCHIFY="$HOME/.claude/skills/archify"; LOG="$H/logs/sync.log"; STATE="$H/state"; DESK="/Users/kin/Desktop/PANDA_全链路排查图"
mkdir -p "$H/logs"; exec >>"$LOG" 2>&1
mkdir "$H/lock" 2>/dev/null || { echo "$(date '+%F %T') skip: running"; exit 0; }
trap 'rmdir "$H/lock"' EXIT
now() { date '+%F %T'; }
git -C "$REPO" fetch -q origin main internal-tools || { echo "$(now) fetch failed"; exit 1; }
git -C "$SITE" pull -q --rebase origin main || echo "$(now) site pull failed (continue)"
MAIN=$(git -C "$REPO" rev-parse origin/main); INT=$(git -C "$REPO" rev-parse origin/internal-tools)
TOOLSUM=$(cat "$TOOLS"/*.mjs "$SITE"/index.html | shasum | cut -c1-12)
KEY="$MAIN $INT $TOOLSUM"; LAST=$(cat "$STATE" 2>/dev/null || true)
write_status() { node -e "
const fs=require('fs');const p=process.argv[1];let o={};try{o=JSON.parse(fs.readFileSync(p+'.json','utf8'))}catch{}
o.checkedAt=new Date().toISOString();o.main=process.argv[2];o.int=process.argv[3];o.intervalMin=5;if(process.argv[4]==='changed'){o.changedAt=o.checkedAt;o.diagrams=process.argv[5];}
fs.writeFileSync(p+'.json',JSON.stringify(o));fs.writeFileSync(p+'.js','window.AUDIT_STATUS='+JSON.stringify(o)+';\n');" "$SITE/status" "$MAIN" "$INT" "$@"; }
if [ "$KEY" = "$LAST" ] && [ "${FORCE:-0}" != 1 ]; then
  # 无变化：每 60 分钟推一次心跳，让页面能显示「最后检查时间」
  AGE=$(( $(date +%s) - $(stat -f %m "$SITE/status.json" 2>/dev/null || echo 0) ))
  if [ "$AGE" -ge 3600 ]; then write_status; git -C "$SITE" add status.js status.json && git -C "$SITE" commit -q -m "heartbeat $(now)" && git -C "$SITE" push -q origin main && echo "$(now) heartbeat"; fi
  exit 0
fi
echo "$(now) change detected main=${MAIN:0:7} int=${INT:0:7}"
T=$(mktemp -d); mkdir -p "$T/main" "$T/int"
git -C "$REPO" archive "$MAIN" src api cloud-run/payment-api/src vercel.json firebase.json firestore.rules index.html package.json | tar -x -C "$T/main"
git -C "$REPO" archive "$INT" src scripts docs/internal vercel.json package.json | tar -x -C "$T/int"
ONLY=$(comm -23 <(git -C "$REPO" ls-tree -r --name-only "$INT" -- src | sort) <(git -C "$REPO" ls-tree -r --name-only "$MAIN" -- src | sort) | grep -v "__tests__\|\.bak$" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.stringify(s.trim().split('\n'))))")
node "$TOOLS/analyze.mjs" "$T/main" "$T/scan.js" '{}' | head -1 &&
node "$TOOLS/analyze_internal.mjs" "$T/int" "$T/scan_internal.js" "$ONLY" | head -1 &&
node "$TOOLS/build.mjs" "$T/scan.js" "$T/scan_internal.js" "$SITE/gp" "$SITE/audit-data.js" "$REPO" || { echo "$(now) build failed"; rm -rf "$T"; exit 1; }
# 图：数字和标记跟着数据重算，再用 archify 重新出图（失败则保留上一版图）
git -C "$REPO" checkout -q --detach "$MAIN"
DIAG=ok
node "$TOOLS/diagrams_refresh.mjs" "$SITE" "$REPO" "$MAIN" || DIAG=refresh-failed
if [ -d "$ARCHIFY" ] && [ "$DIAG" = ok ]; then
  for spec in overview.architecture overview_ja.architecture internal.dataflow internal_ja.dataflow growthpilot.dataflow growthpilot_ja.dataflow links.architecture links_ja.architecture; do
    type=${spec##*.}; html="${spec%%.*}.html"; extra=(); [[ $spec == overview* ]] && extra=(--repo-root "$REPO")
    (cd "$ARCHIFY" && node bin/archify.mjs deliver "$type" "$SITE/$spec.json" "$SITE/$html" --quality showcase ${extra[@]+"${extra[@]}"} --json >/dev/null 2>&1) || { DIAG="failed:$html"; echo "$(now) diagram failed: $html"; }
  done
else [ -d "$ARCHIFY" ] || DIAG=archify-missing; fi
rm -rf "$T"
write_status changed "$DIAG"
git -C "$SITE" add -A && git -C "$SITE" commit -q -m "sync: main@${MAIN:0:7} internal-tools@${INT:0:7} ($DIAG)" && git -C "$SITE" push -q origin main && echo "$(now) pushed ($DIAG)" || echo "$(now) nothing to push / push failed"
echo "$KEY" > "$STATE"
rsync -a --delete --exclude .git --exclude evidence "$SITE/" "$DESK/" 2>/dev/null || true
