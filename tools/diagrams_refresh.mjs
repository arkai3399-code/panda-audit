// 图规格的数字与源码行号跟着最新数据走（由 sync_job.sh 调用，之后再交给 archify 出图）
//   node diagrams_refresh.mjs <site 目录> <Panda-Fortune2 克隆> <main 的 commit>
// 只改：操作点 / 接口 / 页面 / 层 等计数，overview 的 repository.revision 与 sources 行号。
// 图里的说明文字是人工写的，不自动改；以 index.html 的清单为准。
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import vm from 'node:vm';

const [SITE, REPO, MAIN] = process.argv.slice(2);
const ctx = { window: {} }; vm.runInNewContext(readFileSync(path.join(SITE, 'audit-data.js'), 'utf8'), ctx);
const A = ctx.window.AUDIT; const P = A.systems.find((s) => s.id === 'panda'); const I = A.systems.find((s) => s.id === 'internal');
const git = (a) => { try { return execSync(`git -C "${REPO}" ${a}`, { maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] }).toString(); } catch { return null; } };
const load = (f) => JSON.parse(readFileSync(path.join(SITE, f), 'utf8'));
const save = (f, s) => writeFileSync(path.join(SITE, f), JSON.stringify(s, null, 2) + '\n');

const ops = (sys, ids) => sys.groups.filter((g) => ids.includes(g.id)).reduce((n, g) => n + g.opCount, 0);
const layers = (sys, ids) => sys.groups.filter((g) => ids.includes(g.id)).reduce((n, g) => n + g.layers.length, 0);
const host = (h) => P.apis.filter((a) => a.host === h).length;
const noEntry = P.apis.filter((a) => a.host === 'Vercel' && !a.uiCallers.length && !/health/.test(a.path) && !a.dynamic).length;
const N = {
  lpOps: ops(P, ['lp', 'lp-header']), lpParts: layers(P, ['lp', 'lp-header']), authOps: ops(P, ['auth']),
  myOps: ops(P, ['shell', 'meishiki', 'timeline', 'detail', 'compat', 'yume', 'expert']),
  vercel: host('Vercel'), cloudrun: host('Cloud Run'), noEntry,
  pages: P.stats.pages, layers: P.stats.layers, all: P.stats.ops, cron: P.crons.inRepo,
  intPromo: ops(I, ['promo']),
};

// 「旧数字 → 新数字」按位置替换：只替换紧挨着单位的那个数
const setNum = (str, re, v) => (str == null ? str : str.replace(re, (m, a, b) => `${a}${v}${b}`));
const comp = (s, id) => (s.components || s.nodes).find((c) => c.id === id);

for (const [f, ja] of [['overview.architecture.json', false], ['overview_ja.architecture.json', true]]) {
  const s = load(f);
  const lp = comp(s, 'lp'), au = comp(s, 'authui'), my = comp(s, 'mypage'), ve = comp(s, 'vercel'), cr = comp(s, 'cloudrun');
  if (ja) {
    lp.sublabel = setNum(setNum(lp.sublabel, /(部品 )\d+()/, N.lpParts), /(操作点 )\d+()/, N.lpOps);
    au.sublabel = setNum(au.sublabel, /(操作点 )\d+()/, N.authOps);
    my.sublabel = setNum(my.sublabel, /(操作点 )\d+()/, N.myOps);
    ve.sublabel = setNum(ve.sublabel, /(API )\d+()/, N.vercel); ve.tag = `▶ ${N.noEntry} 本に画面入口なし`;
    cr.sublabel = setNum(cr.sublabel, /(API )\d+()/, N.cloudrun);
    const it = s.cards[2].items; it[0] = `ページ ${N.pages} · 層 ${N.layers} · 操作点 ${N.all}`; it[1] = `Vercel API ${N.vercel} · Cloud Run API ${N.cloudrun} · 定時 ${N.cron}`;
  } else {
    lp.sublabel = setNum(setNum(lp.sublabel, /()\d+( 部件)/, N.lpParts), /()\d+( 操作点)/, N.lpOps);
    au.sublabel = setNum(au.sublabel, /()\d+( 操作点)/, N.authOps);
    my.sublabel = setNum(my.sublabel, /()\d+( 操作点)/, N.myOps);
    ve.sublabel = setNum(ve.sublabel, /()\d+( 接口)/, N.vercel); ve.tag = `▶ ${N.noEntry} 个没有画面入口`;
    cr.sublabel = setNum(cr.sublabel, /()\d+( 接口)/, N.cloudrun);
    const it = s.cards[2].items; it[0] = `${N.pages} 页面 · ${N.layers} 层 · ${N.all} 操作点`; it[1] = `Vercel ${N.vercel} 接口 · Cloud Run ${N.cloudrun} 接口 · 定时 ${N.cron}`;
  }
  if (!N.noEntry && ve.tag) delete ve.tag;
  // 源码行号：按旧 revision 那一行的文字，在新 commit 里找最近的同一行；找不到就指到文件开头
  const OLD = s.meta.repository.revision;
  if (OLD !== MAIN) {
    const fileCache = {}; const rd = (c, p) => (fileCache[c + p] ??= git(`show ${c}:${p}`));
    const fix = (src) => {
      if (!src || !src.path) return;
      const nw = rd(MAIN, src.path); if (nw == null) { src.line = 1; return; }
      if (!src.line || src.line === 1) return;
      const old = rd(OLD, src.path); const want = old ? (old.split('\n')[src.line - 1] || '').trim() : '';
      if (!want) { src.line = 1; return; }
      const lines = nw.split('\n'); let best = -1;
      lines.forEach((l, i) => { if (l.trim() === want && (best < 0 || Math.abs(i + 1 - src.line) < Math.abs(best + 1 - src.line))) best = i; });
      src.line = best < 0 ? 1 : best + 1;
    };
    const walk = (o) => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === 'object') { if (Array.isArray(o.sources)) o.sources.forEach(fix); for (const k in o) if (k !== 'sources') walk(o[k]); } };
    walk(s);
    s.meta.repository.revision = MAIN;
  }
  save(f, s);
}

for (const [f, ja] of [['internal.dataflow.json', false], ['internal_ja.dataflow.json', true]]) {
  const s = load(f); const ui = comp(s, 'ui');
  ui.tag = ja ? setNum(ui.tag, /(操作点 )\d+()/, N.intPromo) : setNum(ui.tag, /()\d+( 操作点)/, N.intPromo);
  save(f, s);
}
console.log('diagrams refreshed', JSON.stringify(N));
