// PANDA FORTUNE 全链路静态扫描（只读）。输入 = git archive 出来的快照目录；输出 = audit-data.js
//   node analyze.mjs <snapshotDir> <outFile> <metaJson>
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const [SNAP, OUT, META] = process.argv.slice(2);
const meta = JSON.parse(META);
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const rel = (p) => path.relative(SNAP, p);
const read = (r) => readFileSync(path.join(SNAP, r), 'utf8');
const all = walk(path.join(SNAP, 'src')).map(rel).filter((f) => /\.(jsx?|mjs)$/.test(f) && !f.includes('__tests__'));
const jsx = all.filter((f) => f.endsWith('.jsx'));
const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;
const escRe = (s) => s.replace(/[/.-]/g, (c) => '\\' + c);
const hasPath = (text, p) => new RegExp(escRe(p) + '(?![A-Za-z0-9/_-])').test(text);

// ── 1. import 图 → 可达性 ───────────────────────────────────
function importsOf(file) {
  const src = read(file); const out = [];
  const re = /(?:import\s+(?:[^'"]*?from\s+)?|import\()\s*['"](\.{1,2}\/[^'"]+)['"]/g; let m;
  while ((m = re.exec(src))) {
    const before = src.slice(src.lastIndexOf('\n', m.index) + 1, m.index);
    if (/^\s*\/\//.test(before)) continue; // 注释掉的 import
    let t = path.normalize(path.join(path.dirname(file), m[1]));
    for (const c of [t, t + '.js', t + '.jsx', path.join(t, 'index.js')]) if (existsSync(path.join(SNAP, c)) && statSync(path.join(SNAP, c)).isFile()) { out.push(c); break; }
  }
  return out;
}
const reach = new Set(); const stack = ['src/main.jsx'];
while (stack.length) { const f = stack.pop(); if (reach.has(f)) continue; reach.add(f); for (const i of importsOf(f)) stack.push(i); }

// ── 2. 接口清单 ─────────────────────────────────────────────
const apis = [];
for (const f of walk(path.join(SNAP, 'api')).map(rel).filter((x) => x.endsWith('.js') && !x.includes('/_lib/'))) {
  const src = read(f); const p = '/' + f.replace(/\.js$/, '');
  const auth = /requirePaidEntitlement|verifyAuth\(/.test(src) ? (/requirePaidEntitlement/.test(src) ? '登录 + 付费' : '登录') : /verifyAuthOnly/.test(src) ? '登录' : '公开';
  const runtime = /runtime:\s*'edge'/.test(src) ? 'edge' : 'nodejs';
  const actions = [...src.matchAll(/action\s*===\s*'([a-z-]+)'/g)].map((m) => m[1]);
  const ai = /anthropic|claude-/i.test(src);
  apis.push({ id: p, path: p, host: 'Vercel', file: f, line: (src.split('\n').findIndex((l) => /export default/.test(l)) + 1) || 1, auth, runtime, actions: [...new Set(actions)], ai, callers: [] });
}
const crSrc = read('cloud-run/payment-api/src/server.mjs');
const crSeen = new Set();
for (const m of crSrc.matchAll(/['"](\/(?:v1\/)?[a-z][a-z/-]+)['"]/g)) {
  const p = m[1]; if (crSeen.has(p) || !/^\/(v1\/|health)/.test(p)) continue; crSeen.add(p);
  apis.push({ id: p, path: p, host: 'Cloud Run', file: 'cloud-run/payment-api/src/server.mjs', line: lineOf(crSrc, m.index), auth: /reconcile/.test(p) ? '管理者 secret' : /health/.test(p) ? '公开' : 'Firebase ID token', runtime: 'node', actions: [], ai: false, callers: [] });
}

// ── 3. 调用方：字面路径 + 通过 lib 函数 ──────────────────────
const fnToApi = {}; // 导出函数名 → 接口
for (const f of all.filter((x) => /src\/(lib|compat|logic)\//.test(x) && x.endsWith('.js'))) {
  const src = read(f);
  const exps = [...src.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)|export\s+const\s+([A-Za-z0-9_]+)\s*=/g)].map((m) => ({ name: m[1] || m[2], idx: m.index }));
  exps.forEach((e, i) => {
    const body = src.slice(e.idx, i + 1 < exps.length ? exps[i + 1].idx : src.length);
    for (const a of apis) if (hasPath(body, a.path)) (fnToApi[e.name] ||= new Set()).add(a.id);
  });
}
const libBodies = {};
for (const f of all.filter((x) => /src\/(lib|compat|logic|hooks)\//.test(x) && x.endsWith('.js'))) { const src = read(f); const exps = [...src.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)|export\s+const\s+([A-Za-z0-9_]+)\s*=/g)].map((m) => ({ name: m[1] || m[2], idx: m.index })); exps.forEach((e, i) => { libBodies[e.name] = src.slice(e.idx + 20, i + 1 < exps.length ? exps[i + 1].idx : src.length); }); }
for (let round = 0; round < 4; round++) for (const [name, body] of Object.entries(libBodies)) for (const [fn, set] of Object.entries(fnToApi)) if (fn !== name && new RegExp('\\b' + fn + '\\b').test(body)) for (const id of set) (fnToApi[name] ||= new Set()).add(id);
const isImportish = (l, fn) => /\bimport\b|\bfrom\s+['"]/.test(l) || new RegExp('^\\s*' + fn + '\\s*,?\\s*$').test(l);
for (const f of all) {
  const src = read(f); const lines = src.split('\n');
  lines.forEach((l, i) => {
    if (/^\s*(\/\/|\*)/.test(l)) return;
    for (const a of apis) {
      if (hasPath(l, a.path)) a.callers.push({ file: f, line: i + 1, via: '字面路径' });
    }
    for (const [fn, set] of Object.entries(fnToApi)) if (new RegExp(`\\b${fn}\\b`).test(l) && !isImportish(l, fn) && !new RegExp(`function\\s+${fn}|const\\s+${fn}\\s*=`).test(l)) for (const id of set) { const a = apis.find((x) => x.id === id); if (!a.callers.some((c) => c.file === f && c.line === i + 1)) a.callers.push({ file: f, line: i + 1, via: fn + '()' }); }
  });
}
for (const a of apis) {
  a.uiCallers = a.callers.filter((c) => reach.has(c.file) && (c.file.endsWith('.jsx') || /src\/compat\//.test(c.file)));
  a.libCallers = a.callers.filter((c) => !a.uiCallers.includes(c));
}

// ── 4. 操作点 ───────────────────────────────────────────────
const EFFECTS = [
  [/authedFetch|fetch\(/, '调接口'], [/updateDoc|setDoc|addDoc|deleteDoc|runTransaction/, '写 Firestore'],
  [/signInWith|createUserWith|signOut\(|sendPasswordResetEmail|sendEmailVerification|reauthenticate|updatePassword|updateEmail/, 'Firebase Auth'],
  [/navigate\(|window\.location|<Link/, '跳转'], [/setActiveTab|setOffset|setOpen|setShow|setIs[A-Z]|set[A-Z][A-Za-z]*\(/, '改界面状态'],
  [/localStorage|sessionStorage/, '本地存储'], [/navigator\.share|clipboard|download/, '分享/下载'],
];
function labelNear(lines, i) {
  const chunk = lines.slice(i, i + 9).join(' ');
  const cands = [/\bt\(\s*['"`]([^'"`]{1,40})['"`]/, /aria-label=["'{]+\s*(?:t\()?['"`]?([^'"`}]{1,40})/, /title=["']([^"']{1,40})["']/, />\s*([^<>{}\n]*[ぁ-んァ-ヶ一-龠A-Za-z][^<>{}\n]{0,38})\s*</];
  for (const re of cands) { const m = re.exec(chunk); if (m && m[1].trim() && !/^[=>)\s]+$/.test(m[1])) return m[1].trim().replace(/\s+/g, ' '); }
  return '';
}
function handlerOf(line) { const m = /on(?:Click|Submit|Change)=\{\s*(?:\(\s*[a-z]*\s*\)\s*=>\s*)?([^}]{1,80})/.exec(line); return m ? m[1].trim() : ''; }
function effectsOf(src, handler) {
  const name = (/^([A-Za-z_][A-Za-z0-9_]*)\b/.exec(handler) || [])[1];
  let body = handler;
  if (name && !/^set[A-Z]/.test(name)) { const m = new RegExp(`(?:const|function)\\s+${name}\\b[^\\n]*`).exec(src); if (m) body = src.slice(m.index, m.index + 2600); }
  const tags = EFFECTS.filter(([re]) => re.test(body)).map(([, t]) => t);
  const hit = apis.filter((a) => hasPath(body, a.path) || Object.entries(fnToApi).some(([fn, set]) => set.has(a.id) && new RegExp(`\\b${fn}\\b`).test(body))).map((a) => a.path);
  return { tags, apis: hit };
}
const layers = [];
for (const f of jsx) {
  const src = read(f); const lines = src.split('\n'); const ops = [];
  lines.forEach((l, i) => {
    if (/^\s*(\/\/|\*|\{\/\*)/.test(l)) return;
    for (const ev of ['onClick', 'onSubmit', 'onChange']) {
      if (!l.includes(ev + '=')) continue;
      const handler = handlerOf(l.slice(l.indexOf(ev + '=')));
      const { tags, apis: hit } = effectsOf(src, handler);
      ops.push({ line: i + 1, kind: ev === 'onClick' ? '按钮' : ev === 'onSubmit' ? '表单提交' : '输入', label: labelNear(lines, i), handler: handler.slice(0, 70), effects: tags, apis: hit });
    }
    const lk = /<Link\s+to=\{?["'`]([^"'`}]+)/.exec(l) || /<a\s[^>]*href=\{?["'`]([^"'`}]+)/.exec(l);
    if (lk) ops.push({ line: i + 1, kind: '链接', label: labelNear(lines, i) || lk[1], handler: '→ ' + lk[1], effects: ['跳转'], apis: [] });
  });
  layers.push({ file: f, reachable: reach.has(f), ops });
}
// vanilla 相性（src/compat/*.js）
for (const f of all.filter((x) => /src\/compat\/.*\.js$/.test(x))) {
  const src = read(f); const lines = src.split('\n'); const ops = [];
  lines.forEach((l, i) => {
    if (/^\s*(\/\/|\*)/.test(l)) return;
    const m = /onclick=\\?["']([^"'\\]{1,70})/.exec(l) || /addEventListener\(\s*['"](click|submit|change|input)['"]/.exec(l) || /\.onclick\s*=/.exec(l);
    if (!m) return;
    const h = m[1] && !/^(click|submit|change|input)$/.test(m[1]) ? m[1] : (m[0] || '').slice(0, 40);
    const near = lines.slice(i, i + 6).join(' ');
    const lab = (/>\s*([^<>'"+]*[ぁ-んァ-ヶ一-龠][^<>'"+]{0,30})\s*</.exec(near) || [])[1] || '';
    const hit = apis.filter((a) => lines.slice(i, i + 40).join('\n').includes(a.path)).map((a) => a.path);
    ops.push({ line: i + 1, kind: '按钮', label: lab.trim(), handler: h, effects: hit.length ? ['调接口'] : ['改界面状态'], apis: hit });
  });
  if (ops.length) layers.push({ file: f, reachable: reach.has(f), ops, vanilla: true });
}

// ── 5. 分组（按网页实际顺序）──────────────────────────────
const fr = read('src/pages/FortuneResult.jsx'); const frLines = fr.split('\n');
const tabStarts = [];
frLines.forEach((l, i) => { const m = /\{activeTab === "([a-z]+)" &&/.exec(l); if (m) tabStarts.push({ tab: m[1], line: i + 1 }); });
const TAB_JP = { meishiki: '基本命式', timeline: '運勢タイムライン', love: '恋愛運（詳細）', work: '仕事運（詳細）', money: '金運（詳細）', relation: '人間関係', compat: '相性占い', yume: 'ポポの夢解き', expert: '専門家に相談' };
function frTab(line) { let cur = null; for (const t of tabStarts) if (t.line <= line) cur = t.tab; return cur; }
const GROUPS = [
  { id: 'lp', title: 'LP（トップページ）「/」', test: (f) => f === 'src/pages/LandingPage.jsx' || (/components\/landing\//.test(f) && !/LandingHeader|HeaderUserMenu/.test(f)) },
  { id: 'lp-header', title: '　LP ヘッダー / ユーザーメニュー', test: (f) => /LandingHeader|HeaderUserMenu|LpMenuIcon/.test(f) },
  { id: 'auth', title: 'ログイン / 新規登録（モーダル）', test: (f) => /components\/auth\//.test(f) },
  { id: 'onboard', title: '　プロフィール入力・編集', test: (f) => /ProfileCompletionModal|EditModal/.test(f) },
  { id: 'shell', title: 'マイページ共通（ヘッダー / タブ / メニュー）', test: (f) => /MobileHeaderMenu|AccountDropdown|common\/TabBtn|MaintenanceScreen|ErrorBoundary/.test(f) },
  { id: 'meishiki', title: '基本命式タブ', test: (f) => /common\/(FlipCard|InfoBulb|TsuhenseiIcon)/.test(f) },
  { id: 'timeline', title: '運勢タイムラインタブ', test: (f) => /components\/blocks\//.test(f) },
  { id: 'detail', title: '　恋愛 / 仕事 / 金運 詳細', test: () => false },
  { id: 'compat', title: '相性占いタブ', test: (f) => /tabs\/CompatTab|components\/compat\/|src\/compat\//.test(f) },
  { id: 'yume', title: 'ポポの夢解きタブ', test: (f) => /tabs\/DreamTab|components\/dream\/|DreamDevPreview/.test(f) },
  { id: 'expert', title: '専門家に相談タブ', test: (f) => /tabs\/ExpertTab/.test(f) },
  { id: 'locked', title: '有料導線（ロック / アップグレード）', test: (f) => /components\/locked\/|PurchaseCompleteToast/.test(f) },
  { id: 'pay', title: '決済ページ（LIGHT / PREMIUM）', test: (f) => /PaymentPage/.test(f) },
  { id: 'account', title: '解約 / 退会 / ご意見', test: (f) => /CancelPlanModal|CancelFreeAccountModal|FeedbackModal/.test(f) },
  { id: 'legal', title: '法務ページ（privacy / terms / tokusho）', test: (f) => /PrivacyPage|TermsPage|TokushoPage|components\/legal\//.test(f) },
  { id: 'unwired', title: '未接続の画面部品', test: () => false },
  { id: 'other', title: 'その他', test: () => true },
];
const groups = GROUPS.map((g) => ({ id: g.id, title: g.title, layers: [] }));
const G = Object.fromEntries(groups.map((g) => [g.id, g]));
for (const L of layers) {
  if (!L.reachable && !L.vanilla) { G.unwired.layers.push(L); continue; }
  if (L.file === 'src/pages/FortuneResult.jsx') {
    const buckets = {};
    for (const op of L.ops) { const t = frTab(op.line); const gid = !t ? 'shell' : ['love', 'work', 'money'].includes(t) ? 'detail' : t === 'relation' ? 'meishiki' : (G[t] ? t : 'shell'); (buckets[gid] ||= []).push({ ...op, tab: t ? TAB_JP[t] : '共通' }); }
    for (const [gid, ops] of Object.entries(buckets)) G[gid].layers.push({ file: L.file, reachable: true, ops, part: true });
    continue;
  }
  const g = GROUPS.find((x) => x.test(L.file)); G[g.id].layers.push(L);
}
for (const g of groups) { g.opCount = g.layers.reduce((s, l) => s + l.ops.length, 0); g.layerCount = g.layers.length; }

// ── 6. 问题清单（静态可确认；zh + ja）──────────────────────
const issues = [];
const grepLine = (file, re) => { const ls = read(file).split('\n'); const i = ls.findIndex((l) => re.test(l)); return i < 0 ? null : i + 1; };
for (const a of apis) {
  if (/health/.test(a.path)) continue;
  if (/\/(premium-)?initial$/.test(a.path)) { a.dynamic = true; continue; }
  if (a.uiCallers.length) continue;
  const ext = /ranking-(daily|monthly)/.test(a.path); const admin = /reconcile/.test(a.path);
  const jsxLibs = [...new Set(a.libCallers.filter((c) => c.file.endsWith('.jsx')).map((c) => path.basename(c.file)))];
  const fns = a.libCallers.map((c) => c.via).filter((v, i, s) => s.indexOf(v) === i);
  let what, what_ja;
  if (ext) { what = '接口已实现且在线，但 PANDA 画面里没有任何调用——只给外部（动画工作流 / GrowthPilot）用。站内没有「今日ランキング」页面。'; what_ja = 'API は実装済みで稼働中だが、PANDA の画面からは一切呼ばれていない——外部（動画ワークフロー / GrowthPilot）専用。サイト内に「今日のランキング」ページはない。'; }
  else if (admin) { what = '接口已实现，但仓库里没有定时器配置（vercel.json 无 crons、无 Cloud Scheduler 定义）。不定时调用的话，解约到期后不会自动变回 Free。'; what_ja = 'API は実装済みだが、リポジトリに定時実行の設定がない（vercel.json に crons なし、Cloud Scheduler 定義なし）。定期的に呼ばれなければ、解約期限後に自動で Free に戻らない。'; }
  else if (jsxLibs.length) { what = `接口做好了，调用它的画面部件（${jsxLibs.join(', ')}）也做好了，但该部件在页面里的 import 被摘掉——画面上没有入口。`; what_ja = `API も、それを呼ぶ画面部品（${jsxLibs.join(', ')}）もできているが、その部品の import がページから外されている——画面に入口がない。`; }
  else if (a.libCallers.length) { what = `接口和前端函数都做好了（${fns.join(', ')}），但没有任何画面调用它。`; what_ja = `API もフロント関数（${fns.join(', ')}）もできているが、どの画面からも呼ばれていない。`; }
  else { what = '接口已实现，但 src/ 里没有任何地方调用——画面上没有入口。'; what_ja = 'API は実装済みだが、src/ 内に呼び出しが一つもない——画面に入口がない。'; }
  issues.push({ kind: ext ? 'ext' : 'no-ui', where: `${a.host} ${a.path}`, group: 'api', what, what_ja, source: { file: a.file, line: a.line } });
}
for (const L of G.unwired.layers.filter((x) => x.ops.length > 0 || /tabs\//.test(x.file))) issues.push({ kind: 'unwired', where: path.basename(L.file), group: 'unwired', what: `画面部品已制作（${L.ops.length} 个操作点），但从 main.jsx 出发的 import 链到不了它——页面上不显示。`, what_ja: `画面部品は作成済み（操作点 ${L.ops.length}）だが、main.jsx から辿る import 連鎖が届かない——ページに表示されない。`, source: { file: L.file, line: 1 } });
const curated = [
  ['src/pages/FortuneResult.jsx', /id: "expert".*COMING/, '基本タブ列 › 専門家に相談', '入口做了，但功能没启动：标签标着 COMING，点进去只有预告内容，没有任何可操作按钮（ExpertTab 操作点 0）。', 'expert', null, '入口はあるが機能は未稼働：タブに COMING と表示され、開いても予告文のみで操作できるボタンがない（ExpertTab の操作点 0）。'],
  ['src/components/blocks/TodayFortuneBlock.jsx', /const kiH = ki && \(calc\.kishin/, '運勢タイムライン › 4 枚のスコアカード短評', '喜神标志恒为 false：拿五行数组（木火土金水）去比当日天干（甲乙…），永远不命中。追い風系短评与「忌神重叠」长文案分支不会出现。', 'timeline', null, '喜神フラグが常に false：五行の配列（木火土金水）を当日の天干（甲乙…）と比較しており、絶対に一致しない。追い風系の短評と「忌神重なり」の長文分岐は出現しない。'],
  ['src/pages/FortuneResult.jsx', /genComment\(workScore, 'work'\)/, '仕事運（詳細）› 短評', '详情页调用 genComment 不传十神与标志，首页卡片传。同一天同一类别，两处短评可能不同。', 'detail', null, '詳細ページの genComment は十神とフラグを渡さず、トップのカードは渡す。同じ日・同じカテゴリでも 2 か所の短評が異なりうる。'],
  ['src/pages/FortuneResult.jsx', /genComment\(moneyScore, 'money'\)/, '金運（詳細）› 短評', '同上：不传十神，与首页卡片的短评可能不一致。', 'detail', null, '同上：十神を渡さないため、トップのカードの短評と一致しないことがある。'],
  ['src/logic/fortuneCalc.js', /const SHUO = \[new Date\(2026/, '運勢タイムライン › 六曜 / 開運日カレンダー', '六曜的朔日表只写了 2026 年。2027-01-01 起六曜与「大開運日」标记会算错（分数不受影响）。', 'timeline', null, '六曜の朔日表は 2026 年分しかない。2027-01-01 以降、六曜と「大開運日」の表示が誤る（スコアには影響しない）。'],
  ['src/engines/meishikiEngine.js', /\|\| daiunList\[0\]/, '基本命式 › 現在の大運', '年龄超出 8 步大运范围时回退到第 1 步（台账 BL-01）：高龄用户会显示幼年期的大运，并影响每日分数。', 'meishiki', null, '年齢が大運 8 本の範囲を超えると 1 本目に戻る（台帳 BL-01）：高齢ユーザーには幼少期の大運が表示され、日々のスコアにも影響する。'],
  ['api/_lib/auth.js', /export function hasPaidEntitlement|function hasPaidEntitlement/, 'AI 鑑定 / 付费判定', '付费判定不看 currentPeriodEnd（台账 FR-01）：若解约回调缺失，付费权限会一直有效。', 'api', 'AI 鑑定 / 有料判定', '有料判定が currentPeriodEnd を見ない（台帳 FR-01）：解約コールバックが欠けると有料権限が無期限に残る。'],
];
for (const [file, re, where, what, group, where_ja, what_ja] of curated) { const ln = existsSync(path.join(SNAP, file)) ? grepLine(file, re) : null; if (ln) issues.push({ kind: 'logic', where, what, group, where_ja: where_ja || where, what_ja, source: { file, line: ln } }); }
const placeholders = [
  ['src/components/AccountDropdown.jsx', /プレミアムプランは準備中なンダ/, 'アカウントメニュー › プレミアムへの導線（LIGHT 会員）', '按钮做了，但功能没启动：点了只弹「プレミアムプランは準備中」提示。', 'ui', 'ボタンはあるが機能は未稼働：押すと「プレミアムプランは準備中」と出るだけ。'],
  ['src/components/landing/PricingSection.jsx', /ctaJp: '近日公開'/, 'LP › 料金プラン › PREMIUM カード', '入口做了但封着：CTA 显示「近日公開」且 disabled。', 'ui', '入口はあるが封鎖中：CTA は「近日公開」表示で disabled。'],
  ['src/components/landing/LandingHeader.jsx', /lpx-mm-prem" disabled/, 'LP ハンバーガーメニュー › プレミアムプランを始める', '菜单项做了但 disabled（販売準備中）。', 'ui', 'メニュー項目はあるが disabled（販売準備中）。'],
  ['src/components/auth/SignupModal.jsx', /key: 'premium'.*disabled: true/, '新規登録 › プラン選択 › PREMIUM ★', '选项做了但 disabled，价格栏显示「準備中」。', 'ui', '選択肢はあるが disabled。価格欄は「準備中」表示。'],
  ['src/pages/PremiumPaymentPage.jsx', /const PREMIUM_SALES_OPEN = false/, '決済ページ /payment/premium', '整页被替换成「準備中」。但 Cloud Run 的 /v1/payments/jpayment/premium-initial 已实现——后端做了，前端封着。', 'pay', 'ページ全体が「準備中」表示に差し替え。ただし Cloud Run の /v1/payments/jpayment/premium-initial は実装済み——バックエンドはできていて、フロントが封鎖している。'],
  ['src/components/tabs/DreamTab.jsx', /単発購入は未実装/, 'ポポの夢解き › 単発購入ボタン', '按钮做了，但功能没启动：源码注明「Cloud Run 側の課金経路が要る」，点了只出準備中。', 'yume', 'ボタンはあるが機能は未稼働：ソースに「Cloud Run 側の課金経路が要る」と明記され、押しても準備中が出るだけ。'],
  ['src/components/compat/QrDetailPurchaseModal.jsx', /販売準備中のため押せない表示のみ/, '相性 › QR 詳細購入モーダル › PREMIUM 誘導', '按钮只显示、不可按（2026-07-30 封鎖）。', 'compat', 'ボタンは表示のみで押せない（2026-07-30 封鎖）。'],
];
for (const [file, re, where, what, group, what_ja] of placeholders) { const ln = grepLine(file, re); if (ln) issues.push({ kind: 'placeholder', where, what, group, where_ja: where, what_ja, source: { file, line: ln } }); }

const out = { meta, stats: { layers: layers.length, pages: jsx.filter((f) => /src\/pages\//.test(f)).length, ops: layers.reduce((s, l) => s + l.ops.length, 0), apis: apis.length, vercel: apis.filter((a) => a.host === 'Vercel').length, cloudrun: apis.filter((a) => a.host === 'Cloud Run').length, unreachable: G.unwired.layers.length }, groups, apis, issues, tabStarts };
writeFileSync(OUT, 'window.AUDIT_SCAN = ' + JSON.stringify(out) + ';\n');
console.log(JSON.stringify(out.stats), 'issues', issues.length);
