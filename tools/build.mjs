// 三个系统分开：① PANDA 本体（main）② 社内ツール（internal-tools）③ GrowthPilot 自动化平台（对接包）＋ 系统间衔接
// 所有人工文本带 zh + ja（字段 x / x_ja）。viewer 按语言取。
//   node build.mjs <scan.js> <scan_internal.js> <gpPkgDir> <outFile> <repo>
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
const [SCAN, SCAN_INT, GP, OUT, REPO] = process.argv.slice(2);
const load = (f, key) => new Function('window', readFileSync(f, 'utf8') + `; return window.${key};`)({});
const scan = load(SCAN, 'AUDIT_SCAN'), scanInt = load(SCAN_INT, 'AUDIT_SCAN_INTERNAL');
const git = (a) => execSync(`git -C "${REPO}" ${a}`, { maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
const rev = (r, fb) => { try { return git(`rev-parse ${r}`); } catch { return fb; } };
const MAIN = rev('origin/main', '24b595fc15299f71343c8cdc1d9a467015420675'), INT = rev('origin/internal-tools', 'c15ce5f63c5a1b7a97a429b449a962fe4b634558');
const BASELINE = process.env.BASELINE || 'd5588c4', INT_BASE = process.env.INT_BASELINE || '89a2aa2';
const appV = (c) => { try { return /APP_VERSION\s*=\s*'([^']+)'/.exec(git(`show ${c}:src/data/appVersion.js`))[1]; } catch { return '?'; } };
const head = (c) => { const [h, d, s] = git(`log -1 --format=%h%x09%cI%x09%s ${c}`).split('\t'); return { commitShort: h, date: d, subject: s }; };
const _cache = {};
const showFile = (c, f) => { const k = c + ':' + f; if (!(k in _cache)) { try { _cache[k] = git(`show ${c}:${f}`); } catch { _cache[k] = null; } } return _cache[k]; };
const anchor = (c, file, at) => { if (typeof at === 'number') return { line: at, stale: showFile(c, file) == null }; const src = showFile(c, file); if (src == null) return { line: 1, stale: true }; const i = src.split('\n').findIndex((l) => at.test(l)); return i < 0 ? { line: 1, stale: true } : { line: i + 1, stale: false }; };
const M = (file, at) => ({ base: 'github', commit: MAIN, branch: 'main', file, ...anchor(MAIN, file, at) });
const I = (file, at) => ({ base: 'github', commit: INT, branch: 'internal-tools', file, ...anchor(INT, file, at) });
const existsIn = (c, f) => showFile(c, f) != null;
const grepTree = (c, dir, re) => { try { return git(`grep -l -E "${re}" ${c} -- ${dir}`).split('\n').filter(Boolean).map((x) => x.replace(c + ':', '')); } catch { return []; } };
const G = (file, line) => ({ base: 'pkg', pkg: 'panda-growthpilot-core.zip', file, line });
const log = (range, scoringRe) => git(`log --format=%h%x09%ad%x09%s --date=short ${range}`).split('\n').filter(Boolean).map((l) => {
  const [hash, date, subject] = l.split('\t'); const names = git(`show --stat --format= ${hash}`).split('\n').slice(0, -1).map((x) => x.split('|')[0].trim());
  const t = (re) => names.some((n) => re.test(n));
  return { hash, date, subject, files: names.length, scoring: t(scoringRe), area: [t(/^api\//) && '接口', t(/cloud-run\//) && '决済API', t(/src\/(engines|logic)\//) && '计算逻辑', t(/src\/(pages|components|compat|lib)\//) && '画面', t(/src\/data\/|^data\//) && '文案/辞典', t(/__tests__/) && '测试', t(/^docs\//) && '文档', t(/^scripts\//) && '构建'].filter(Boolean) };
});
// [kind, group, where, where_ja, what, what_ja, source]
const LEVEL = {
  '評分核（calcDayPillarDailyScore / scoreDailyCore）': 'bug', '投稿文 › リンク': 'bug', '「なぜ今日なのか」理由文': 'note', '「今日の一手」': 'note', '図鑑 / カード › 持ち味文': 'note',
  '60 角色名 / slug / 図鑑 /c': 'ready', 'DayPillarCharacterCard.jsx': 'ready', '入口ガード › 開放モード': 'note', '审批 / 投稿记录': 'todo', '部署方式': 'note',
  '审批（文案 → 图片 两段）': 'todo', '定时发布（Instagram / X 早中晚）': 'todo', '发布前闸门': 'todo', '卡片分数口径未定': 'note', '文案层沿用社内ツール的固定句': 'note',
  '140 字投稿文（caption140）': 'note', '个人分': 'todo', 'Instagram 早中晚 3 篇 × 5 页': 'todo', '六曜': 'bug',
};
// 代码变了、问题可能已经不在了 → stale（标「可能已解决，需复核」，不自动删）
const RESOLVED = {
  '投稿文 › リンク': () => existsIn(MAIN, 'src/pages/DayPillarCharacterPage.jsx'),
  '60 角色名 / slug / 図鑑 /c': () => existsIn(MAIN, 'src/data/dayPillarCharacters.js'),
  'DayPillarCharacterCard.jsx': () => grepTree(INT, 'src', "^import .*DayPillarCharacterCard").length > 0 || grepTree(MAIN, 'src', "^import .*DayPillarCharacterCard").length > 0,
  '評分核（calcDayPillarDailyScore / scoreDailyCore）': () => /scoreDailyCore/.test(showFile(MAIN, 'src/logic/fortuneCalc.js') || ''),
};
const ISS = (rows) => rows.map(([kind, group, where, where_ja, what, what_ja, source]) => ({ kind, group, where, where_ja, what, what_ja, level: LEVEL[where] || 'note', source: source || null, stale: !!(source && source.stale) || !!(RESOLVED[where] && RESOLVED[where]()) }));
// [item, item_ja, why, why_ja, who, who_ja, source]
const V = (rows) => rows.map(([item, item_ja, why, why_ja, who, who_ja, source]) => ({ item, item_ja, why, why_ja, who, who_ja, source: source || null, stale: !!(source && source.stale) }));

// ═══ ① PANDA 本体 ═══
const st = scan.stats;
const panda = {
  id: 'panda', name: 'PANDA 本体（网页）', name_ja: 'PANDA 本体（Web サイト）', short: '① 本体', short_ja: '① 本体', accent: '#7dd3fc',
  where: 'www.panda-fortune.jp · Vercel（SPA + /api/*）· Cloud Run（決済）· Firebase', where_ja: 'www.panda-fortune.jp · Vercel（SPA + /api/*）· Cloud Run（決済）· Firebase',
  sync: { ...head(MAIN), commit: MAIN, branch: 'main', version: appV(MAIN), source: 'origin/main（git ls-remote 确认与远端一致）', source_ja: 'origin/main（git ls-remote でリモートと一致を確認）' },
  scope: '只含本番网页自身：页面、按钮、接口、Firestore。不含社内ツール，不含自动化平台。', scope_ja: '本番サイト自身のみ：ページ・ボタン・API・Firestore。社内ツールと自動化プラットフォームは含まない。',
  stats: st, groups: scan.groups, apis: scan.apis, srcBase: 'github', commit: MAIN,
  scale: `${st.layers} 层（${st.pages} 页面 + ${st.layers - st.pages} 弹窗/面板/部件）· ${st.ops} 个操作点 · Vercel ${st.vercel} 接口 + Cloud Run ${st.cloudrun} 接口 · 仓库内定时任务 0`,
  scale_ja: `${st.layers} 層（${st.pages} ページ + ${st.layers - st.pages} モーダル/パネル/部品）· 操作点 ${st.ops} · Vercel API ${st.vercel} + Cloud Run API ${st.cloudrun} · リポジトリ内の定時タスク 0`,
  crons: { inRepo: 0, note: 'vercel.json 无 crons；仓库内无 Cloud Scheduler / GitHub Actions 定时定义。', note_ja: 'vercel.json に crons なし。リポジトリ内に Cloud Scheduler / GitHub Actions の定時定義もない。', needed: [{ what: 'reconcile-cancellations（解约到期 → 自动变回 Free）', what_ja: 'reconcile-cancellations（解約期限後 → 自動で Free に戻す）', source: M('cloud-run/payment-api/src/server.mjs', /reconcile-cancellations/) }] },
  issues: scan.issues.map((i) => ({ ...i, where_ja: i.where_ja || i.where, source: i.source ? M(i.source.file, i.source.line) : null })),
  verify: V([
    ['本番实际部署的 commit', '本番に実際にデプロイされている commit', '构建产物不含 commit；无 Vercel 后台权限。间接证据：线上包 v1.1.6，计算代码与 main@24b595f 实测 0 差异（09-18）。', 'ビルド成果物に commit が含まれず、Vercel 管理画面の権限もない。間接証拠：本番バンドル v1.1.6、計算コードは main@24b595f と実測 0 差異（09-18）。', 'Vercel 管理员', 'Vercel 管理者'],
    ['已登录个人页面显示值 = 源码计算结果', 'ログイン済みマイページの表示値 = ソースの計算結果', '未用真实账户验证；新建测试账户会写入生产库。', '実アカウントで未検証。テストアカウントの新規作成は本番 DB への書き込みになる。', '持测试账户的人', 'テストアカウント保持者', M('src/components/blocks/TodayFortuneBlock.jsx', /const d = new Date\(\);/)],
    ['/v1/payments/jpayment/initial 是否真的被前端走到', '/v1/payments/jpayment/initial がフロントから実際に呼ばれるか', '前端不写死地址，用 prepare 返回的 endpoint 动态提交；静态分析确认不了。', 'フロントはアドレスを固定せず、prepare が返す endpoint に動的に送信するため静的解析では確認できない。', '跑一次测试环境決済', 'テスト環境で決済を 1 回実行', M('src/lib/jpaymentPaymentClient.js', /export async function postJPaymentInitialCharge/)],
    ['/v1/payments/jpayment/premium-initial 有无可达路径', '/v1/payments/jpayment/premium-initial に到達経路があるか', '后端已实现，前端 PREMIUM_SALES_OPEN=false 整页封着。直接构造请求是否会扣款需核验。', 'バックエンドは実装済み、フロントは PREMIUM_SALES_OPEN=false でページごと封鎖。リクエストを直接組み立てた場合に課金されるかは要確認。', '決済担当', '決済担当', M('cloud-run/payment-api/src/server.mjs', /premium-initial/)],
    ['实课金开关 JPAYMENT_INITIAL_PAYMENT_ENABLED 的线上值', '実課金スイッチ JPAYMENT_INITIAL_PAYMENT_ENABLED の本番値', '环境变量不在仓库内（按规定也不读取）。', '環境変数はリポジトリにない（規定により読まない）。', 'Cloud Run 管理员', 'Cloud Run 管理者', M('cloud-run/payment-api/src/server.mjs', /JPAYMENT_INITIAL_PAYMENT_ENABLED/)],
    ['解约到期自动变回 Free 的定时器是否存在', '解約期限後に自動で Free に戻す定時実行が存在するか', '接口已实现；仓库内无定时定义，可能配在云端控制台。', 'API は実装済み。リポジトリ内に定時定義はなく、クラウド側コンソールで設定されている可能性。', 'GCP 管理员', 'GCP 管理者', M('cloud-run/payment-api/src/server.mjs', /reconcile-cancellations/)],
    ['J-Payment 继续课金通知（webhook）接收端点', 'J-Payment 継続課金通知（webhook）の受信エンドポイント', 'server.mjs 注释提到 webhook，但路由表里没有对应路径。', 'server.mjs のコメントに webhook の記述はあるが、ルート表に対応パスがない。', '決済担当', '決済担当', M('cloud-run/payment-api/src/server.mjs', /webhook/i)],
    ['Vercel KV 不可用时 AI 接口的行为', 'Vercel KV が使えないときの AI API の挙動', '限流在 KV 不通时返回 503（源码核对）；线上是否配置 KV 未核实。', 'レート制限は KV 不通時に 503 を返す（ソース確認）。本番で KV が設定済みかは未確認。', 'Vercel 管理员', 'Vercel 管理者', M('api/_lib/rateLimit.js', /503|KV/)],
    ['相性スクリプト 未定義変数 _ptNameShort（台账 BUG-01）', '相性スクリプトの未定義変数 _ptNameShort（台帳 BUG-01）', '静态可见引用；是否真的抛错取决于运行分支，需在页面上复现。', '静的には参照が見える。実際に例外になるかは実行分岐次第で、画面での再現が必要。', 'QA', 'QA', M('src/compat/compatScript.js', /_ptNameShort/)],
    ['旧账户 birthData.longitude = 135 的历史值（台账 QR-02）', '旧アカウントの birthData.longitude = 135 という履歴値（台帳 QR-02）', '不读数据库，无法确认受影响账户数。会改变 23 点换日与日柱。', 'データベースを読まないため影響アカウント数は不明。23 時切替と日柱が変わりうる。', '有 Firestore 读权限的人', 'Firestore 読み取り権限のある人', M('src/lib/fortuneInput.js', /source: 'default'/)],
    ['海外地名经度来源 Nominatim 是否稳定', '海外地名の経度ソース Nominatim が安定しているか', '注册/编辑时浏览器直连第三方；失败时经度落到 135。', '登録/編集時にブラウザが第三者サービスへ直接接続。失敗時は経度が 135 に落ちる。', 'QA', 'QA', M('src/lib/geocodePlace.js', /NOMINATIM_SEARCH_URL =/)],
    ['设备时区不在日本时「今日」的日期', '端末のタイムゾーンが日本以外のときの「今日」', '页面用设备本地日期（台账 BUG-03）。', 'ページは端末のローカル日付を使う（台帳 BUG-03）。', 'QA', 'QA', M('src/components/blocks/TodayFortuneBlock.jsx', /const d = new Date\(\);/)],
    ['ranking-monthly 的含义', 'ranking-monthly の意味', '实现是「取该月 15 日的日运」，不是月运专用逻辑。', '実装は「その月の 15 日の日運を取る」であり、月運専用ロジックではない。', '产品', 'プロダクト', M('src/logic/dayPillarRanking.js', /month - 1, 15/)],
    ['0 操作点的未引用部件是否可删（GokyoBar / PandaIcon / MailIllustration / RouteNoIndex）', '操作点 0 の未参照部品を削除してよいか（GokyoBar / PandaIcon / MailIllustration / RouteNoIndex）', '从 main.jsx 不可达；可能是历史遗留。', 'main.jsx から到達不能。過去の残骸の可能性。', '前端担当', 'フロント担当', M('src/components/common/GokyoBar.jsx', 1)],
  ]),
  changes: log(`${BASELINE}..${MAIN}`, /src\/(engines\/meishikiEngine|logic\/fortuneCalc|logic\/dayPillar|data\/genmeiText)/), changesNote: `基准 ${BASELINE}（v1.1.6 引入）→ main`, changesNote_ja: `基準 ${BASELINE}（v1.1.6 導入）→ main`,
  diagram: { file: 'overview.html', lead: 'PANDA 本体的从头到尾总览。只画本体自身；社内ツール和自动化平台不在这张图里。', lead_ja: 'PANDA 本体の全体像。本体のみを描き、社内ツールと自動化プラットフォームは含まない。' },
};

// ═══ ② 社内ツール ═══
const si = scanInt.stats;
const internal = {
  id: 'internal', name: '公司内部ツール（宣伝カード / 図鑑）', name_ja: '社内ツール（宣伝カード / 図鑑）', short: '② 社内ツール', short_ja: '② 社内ツール', accent: '#fbbf24',
  where: 'panda-fortune-internal.pages.dev · Cloudflare Pages · VITE_APP_MODE=internal · wrangler 手动上传', where_ja: 'panda-fortune-internal.pages.dev · Cloudflare Pages · VITE_APP_MODE=internal · wrangler 手動アップロード',
  sync: { ...head(INT), commit: INT, branch: 'internal-tools', version: appV(INT), source: 'origin/internal-tools（未合并进 main）', source_ja: 'origin/internal-tools（main 未マージ）' },
  scope: `只含 internal-tools 分支「独有」的 ${si.layers} 个文件（该分支其余部分是旧版本体的副本，不重复列）。`, scope_ja: `internal-tools ブランチ「固有」の ${si.layers} ファイルのみ（同ブランチの残りは旧版本体のコピーのため重複掲載しない）。`,
  stats: { ...si, apis: 0 }, groups: scanInt.groups, apis: [], srcBase: 'github', commit: INT,
  apisNote: '社内ツール没有自己的接口。只用 Firebase Auth 登录，并读取 Firestore 的 config/internalStaff（许可邮箱名单）。评分、选角、文案、绘图全部在浏览器内完成。', apisNote_ja: '社内ツールに独自の API はない。Firebase Auth でログインし、Firestore の config/internalStaff（許可メール一覧）を読むだけ。採点・選定・文案・描画はすべてブラウザ内で完結。',
  scale: `${si.layers} 个独有文件（${si.pages} 页面）· ${si.ops} 个操作点 · 自有接口 0 · 定时任务 0（全部人手操作）`, scale_ja: `固有ファイル ${si.layers}（${si.pages} ページ）· 操作点 ${si.ops} · 独自 API 0 · 定時タスク 0（すべて手作業）`,
  crons: { inRepo: 0, note: '没有定时。每天由人打开页面 → 选日期 → 下载 PNG / 复制投稿文 → 人手发到 SNS。', note_ja: '定時実行なし。毎日人がページを開く → 日付を選ぶ → PNG をダウンロード / 投稿文をコピー → 手で SNS に投稿。', needed: [] },
  issues: ISS([
    ['mismatch', 'logic', '評分核（calcDayPillarDailyScore / scoreDailyCore）', '採点コア（calcDayPillarDailyScore / scoreDailyCore）', '08-17 把卡片评分统一到「会员画面同核」，但本体在 08-18/19 又给个人评分加了十二運・特殊星并改了喜忌神配点。两边互相没合并——文档里「与会员画面同核」现在不成立。', '08-17 にカードの採点を「会員画面と同じ核」に統一したが、本体は 08-18/19 に個人採点へ十二運・特殊星を追加し喜忌神の配点も変更。双方が未マージ——ドキュメントの「会員画面と同核」は現在成り立たない。', I('src/logic/fortuneCalc.js', /export function scoreDailyCore/)],
    ['broken-link', 'promo', '投稿文 › リンク', '投稿文 › リンク', '投稿文固定带 https://www.panda-fortune.jp/c/<slug>，但 /c 图鉴页只存在于本分支。实测本番线上包无此页面，读者点了会跳回首页。', '投稿文に https://www.panda-fortune.jp/c/<slug> が固定で付くが、/c 図鑑ページはこのブランチにしか存在しない。本番の実測でページなし、読者が押すとトップに戻される。', I('src/logic/promoPick.js', /panda-fortune\.jp\/c\//)],
    ['logic', 'promo', '「なぜ今日なのか」理由文', '「なぜ今日なのか」理由文', '只说 1 个因子（支合＞六冲＞自刑＞十神）。有利与不利同时存在的日子不会综合说明。', '因子を 1 つしか語らない（支合＞六冲＞自刑＞十神）。有利と不利が同時にある日は総合的に説明されない。', I('src/logic/promoPick.js', /function detectReason/)],
    ['logic', 'promo', '「今日の一手」', '「今日の一手」', '按类别固定 1 句，与日期、日柱、当日因子无关——每天同类别都是同一句。', 'カテゴリごとに固定 1 文で、日付・日柱・当日の因子と無関係——同じカテゴリなら毎日同じ文。', I('src/logic/promoPick.js', /^const CATEGORY_ADVICE/)],
    ['content', 'zukan', '図鑑 / カード › 持ち味文', '図鑑 / カード › 持ち味文', '天干 10 句 × 地支 12 句机械拼接；逐角色手写覆盖表 DAY_PILLAR_OVERRIDES 为空（0 / 60）。', '天干 10 文 × 地支 12 文の機械的な組み合わせ。キャラ別の書き下ろし上書き表 DAY_PILLAR_OVERRIDES は空（0 / 60）。', I('src/data/dayPillarPageTexts.js', /DAY_PILLAR_OVERRIDES = \{\}/)],
    ['unwired', 'zukan', '60 角色名 / slug / 図鑑 /c', '60 キャラ名 / slug / 図鑑 /c', '只存在于本分支，没有进本番。本体个人页面只显示图片，不显示角色名。', 'このブランチにしか存在せず、本番に入っていない。本体のマイページは画像のみ表示でキャラ名は出ない。', I('src/data/dayPillarCharacters.js', /export const DAY_PILLAR_CHARACTERS/)],
    ['unwired', 'share', 'DayPillarCharacterCard.jsx', 'DayPillarCharacterCard.jsx', '部件已制作，但本分支内也没有任何页面 import 它（07-30 起因角色图制作中而摘下）。', '部品は作成済みだが、このブランチ内でもどのページからも import されていない（07-30 にキャラ画像制作中のため取り下げ）。', I('src/components/blocks/DayPillarCharacterCard.jsx', 1)],
    ['logic', 'gate', '入口ガード › 開放モード', '入口ガード › 開放モード', '以 VITE_INTERNAL_OPEN_ACCESS=1 构建时，不看登录也不看许可名单直接放行：知道 URL 即可使用。且 Gate 是浏览器内判定，文档自述「技術的な防壁ではない」。', 'VITE_INTERNAL_OPEN_ACCESS=1 でビルドすると、ログインも許可一覧も見ずに通す：URL を知っていれば誰でも使える。さらに Gate はブラウザ内判定で、ドキュメント自身が「技術的な防壁ではない」と明記。', I('src/components/internal/InternalGate.jsx', /if \(OPEN_ACCESS\) return children/)],
    ['missing', 'promo', '审批 / 投稿记录', '承認 / 投稿記録', '文档列为「フェーズ2（未着手）」：没有下书き・确认済み・投稿済み 状态，没有「谁做了哪天」的记录，也没有防止同一角色连续上卡的机制。', 'ドキュメントで「フェーズ2（未着手）」：下書き・確認済み・投稿済みの状態がなく、「誰がどの日を作ったか」の記録も、同じキャラが連続で載るのを防ぐ仕組みもない。', I('docs/internal/promo-card-tool.md', /フェーズ2/)],
    ['logic', 'gate', '部署方式', 'デプロイ方式', '用 wrangler 直接上传构建产物（ダイレクトアップロード）。push 到分支不会自动更新线上——线上是哪一版只能靠记忆或后台确认。', 'wrangler で成果物を直接アップロード（ダイレクトアップロード）。ブランチへの push では本番が更新されない——本番がどの版かは記憶か管理画面でしか分からない。', I('docs/internal/deploy-and-access.md', /ダイレクトアップロード/)],
  ]),
  verify: V([
    ['线上 panda-fortune-internal.pages.dev 部署的 commit', 'panda-fortune-internal.pages.dev にデプロイされている commit', '手动上传，构建产物不含 commit。09-15 下载线上包：版本 v1.0.3，含 09-04 的界面改版与 08-18 的评分核。', '手動アップロードのため成果物に commit が含まれない。09-15 に本番バンドルを取得：版 v1.0.3、09-04 の画面改版と 08-18 の採点コアを含む。', 'Cloudflare Pages 管理员', 'Cloudflare Pages 管理者'],
    ['開放モード是否仍开启', '開放モードが今も有効か', '09-03 起以 VITE_INTERNAL_OPEN_ACCESS=1 构建；是否已关回登录制需看最近一次构建命令。', '09-03 から VITE_INTERNAL_OPEN_ACCESS=1 でビルド。ログイン制に戻したかは直近のビルドコマンド次第。', '执行上传的人', 'アップロードを実行した人', I('src/components/internal/InternalGate.jsx', /if \(OPEN_ACCESS\) return children/)],
    ['Firestore config/internalStaff 名单是否存在、内容是否最新', 'Firestore config/internalStaff の一覧が存在し最新か', '不读数据库。', 'データベースは読まない。', '有 Firestore 读权限的人', 'Firestore 読み取り権限のある人', I('src/components/internal/InternalGate.jsx', /internalStaff'/)],
    ['firestore.rules 是否已部署 config/internalStaff 的 read 许可', 'firestore.rules の config/internalStaff read 許可がデプロイ済みか', '规则文件在仓库里，是否已发布到线上未核实。', 'ルールファイルはリポジトリにあるが、本番へ発行済みかは未確認。', 'Firebase 管理员', 'Firebase 管理者'],
  ]),
  changes: log(`${INT_BASE}..${INT}`, /src\/logic\/(fortuneCalc|promoPick)/), changesNote: `基准 ${INT_BASE}（08-17 合并 main 之后）→ internal-tools`, changesNote_ja: `基準 ${INT_BASE}（08-17 の main 取り込み後）→ internal-tools`,
  diagram: { file: 'internal.html', lead: '社内ツール自身的链路：人手操作 → 浏览器内选角 / 组文案 / 绘图 → 下载。红虚线 = 有问题，紫虚线 = 未实现。', lead_ja: '社内ツール自身の流れ：手作業 → ブラウザ内で選定 / 文案 / 描画 → ダウンロード。赤の破線 = 問題あり、紫の破線 = 未実装。' },
};

// ═══ ③ GrowthPilot 自动化平台 ═══
const cli = readFileSync(path.join(GP, 'growthpilot/cli.mjs'), 'utf8').split('\n');
const CMD = {
  context: ['当日干支 / 流年 / 节 / 六曜', '当日の干支 / 流年 / 節 / 六曜'], board: ['60 日柱盘面（两套群体分 + 明细）', '60 日柱の盤面（集団スコア 2 系統 + 内訳）'], rankings: ['排行（rankingApi 或 promoCard）', 'ランキング（rankingApi または promoCard）'],
  promo: ['宣传卡素材（社内ツール同款评分，本地计算）', '宣伝カード素材（社内ツールと同じ採点・ローカル計算）'], character: ['单个角色资料', '1 キャラの資料'], birthdays: ['生日反查（日柱 + 年份）', '誕生日の逆引き（日柱 + 年）'],
  personal: ['个人日运（需完整出生资料）', '個人の日運（完全な出生資料が必要）'], birthpillar: ['个人日柱与 23 点换日判定', '個人の日柱と 23 時切替の判定'], 'live-check': ['线上 240 个分数 vs 本地复刻（不一致退出码 3）', 'オンラインの 240 スコア vs ローカル複製（不一致なら終了コード 3）'],
  'live-board': ['线上盘面 + 依据', 'オンライン盤面 + 根拠'], 'live-promo': ['线上 No.1 的单张卡素材', 'オンライン No.1 のカード素材 1 枚分'], 'live-all': ['一天 4 类别 → 1 个 JSON（平台读这个）', '1 日 4 カテゴリ → 1 つの JSON（プラットフォームが読む）'],
};
const cmdOps = cli.map((l, i) => { const m = /case '([a-z-]+)':/.exec(l); if (!m) return null; const live = /^live-/.test(m[1]); return { line: i + 1, kind: '命令', label: `cli.mjs ${m[1]}`, handler: (CMD[m[1]] || ['', ''])[0], handler_ja: (CMD[m[1]] || ['', ''])[1], effects: [live ? '调线上 API' : '本地计算'], apis: live ? ['/api/fortune/ranking-daily'] : [] }; }).filter(Boolean);
const gpGroups = [
  { id: 'live', title: '线上接入（本番公开 API）', title_ja: 'オンライン接続（本番公開 API）', layers: [{ file: 'growthpilot/cli.mjs', ops: cmdOps.filter((o) => /live-/.test(o.label)) }] },
  { id: 'local', title: '本地计算命令', title_ja: 'ローカル計算コマンド', layers: [{ file: 'growthpilot/cli.mjs', ops: cmdOps.filter((o) => !/live-/.test(o.label)) }] },
  { id: 'render', title: '卡片渲染（PNG）', title_ja: 'カード描画（PNG）', layers: [{ file: 'render/render-cards.mjs', ops: [{ line: 1, kind: '命令', label: 'render-cards.mjs <live-all.json>', handler: '无头 Chromium 执行社内ツール同一份 promoCard.js', handler_ja: 'ヘッドレス Chromium で社内ツールと同じ promoCard.js を実行', effects: ['绘制卡片'], apis: [] }] }] },
  { id: 'schedule', title: '每日定时（Mac mini launchd）', title_ja: '日次定時（Mac mini launchd）', layers: [{ file: 'SETUP_MAC_MINI.md', ops: [{ line: 103, kind: '定时', label: '06:00 JST  live-check && live-all', handler: 'live-check 失败则不生成当天 JSON（有意停发）', handler_ja: 'live-check 失敗時は当日の JSON を生成しない（意図的な停止）', effects: ['调线上 API'], apis: ['/api/fortune/ranking-daily'] }] }] },
  { id: 'approve', title: '审批（文案 → 图片）', title_ja: '承認（文案 → 画像）', layers: [] }, { id: 'publish', title: '定时发布（Instagram / X）', title_ja: '定時投稿（Instagram / X）', layers: [] },
].map((g) => ({ ...g, opCount: g.layers.reduce((s, l) => s + l.ops.length, 0), layerCount: g.layers.length }));
const gpOps = gpGroups.reduce((s, g) => s + g.opCount, 0);
const gp = {
  id: 'gp', name: '自动化系统平台（GrowthPilot）', name_ja: '自動化プラットフォーム（GrowthPilot）', short: '③ 自动化平台', short_ja: '③ 自動化', accent: '#a78bfa',
  where: 'Mac mini 本地 · Node 20+ · 对接包 panda-growthpilot-core.zip（不在 PANDA 仓库内）', where_ja: 'Mac mini ローカル · Node 20+ · 連携パッケージ panda-growthpilot-core.zip（PANDA リポジトリ外）',
  sync: { commitShort: 'v1.1.0', subject: 'panda-growthpilot-core.zip（09-15 追加 live 接入 / PNG 渲染 / Mac mini 手册）', subject_ja: 'panda-growthpilot-core.zip（09-15 に live 接続 / PNG 描画 / Mac mini 手順を追加）', date: '2026-09-15T18:56:00+09:00', version: '个人日运对接包 09-18 另附', version_ja: '個人日運 連携資料は 09-18 に別添', source: '~/Desktop/panda-growthpilot-core.zip', source_ja: '~/Desktop/panda-growthpilot-core.zip', commit: null, branch: null },
  scope: '只含后期制作的自动化平台侧：对接包的命令、每日任务、渲染，以及尚未实现的审批与发布。不含 PANDA 本体和社内ツール的内部问题。', scope_ja: '後から作った自動化側のみ：連携パッケージのコマンド、日次タスク、描画、未実装の承認と投稿。PANDA 本体と社内ツール内部の問題は含まない。',
  stats: { layers: 4, pages: 0, ops: gpOps, apis: 1 }, groups: gpGroups, srcBase: 'pkg', commit: null,
  apis: [{ id: 'ranking-daily', path: '/api/fortune/ranking-daily', host: 'PANDA 本体（外部依赖）', file: 'growthpilot/live.mjs', line: 24, auth: '公开', runtime: 'edge', actions: [], ai: false, dynamic: false, uiCallers: [{ file: 'growthpilot/live.mjs', line: 31 }], libCallers: [], external: true }],
  apisNote: '平台自己不提供接口。唯一的线上依赖是 PANDA 本体的公开排名 API（只有群体分）。', apisNote_ja: 'プラットフォーム自身は API を持たない。唯一のオンライン依存は PANDA 本体の公開ランキング API（集団スコアのみ）。',
  scale: '对接包 12 个命令 + 渲染 1 + 每日定时 1 · 线上依赖 1 个接口 · 审批 0 · 发布 0', scale_ja: '連携パッケージ 12 コマンド + 描画 1 + 日次定時 1 · オンライン依存 API 1 · 承認 0 · 投稿 0',
  crons: { inRepo: 1, note: '对接包提供了 launchd plist（每天 06:00 JST）。是否已在 Mac mini 上安装并运行未核实。', note_ja: '連携パッケージに launchd plist（毎日 06:00 JST）を同梱。Mac mini でインストール・稼働しているかは未確認。', needed: [{ what: 'jp.panda-fortune.growthpilot.daily（live-check && live-all）', what_ja: 'jp.panda-fortune.growthpilot.daily（live-check && live-all）', source: G('SETUP_MAC_MINI.md', 103) }] },
  issues: ISS([
    ['missing', 'approve', '审批（文案 → 图片 两段）', '承認（文案 → 画像の 2 段階）', '未实现：没有审批队列、状态、记录。现在 JSON / PNG 生成后没有任何下游。', '未実装：承認キュー・状態・記録がない。現状 JSON / PNG を生成した後の下流が何もない。', null],
    ['missing', 'publish', '定时发布（Instagram / X 早中晚）', '定時投稿（Instagram / X 朝昼晩）', '未实现：无 n8n、无 SNS 登录与发布接口、无已发布台账。', '未実装：n8n なし、SNS ログインと投稿 API なし、投稿済み台帳なし。', null],
    ['missing', 'approve', '发布前闸门', '投稿前ゲート', '未实现（建议新增）：parity.ok + online-check + 合规 7 条 + 「23時以降は翌日の日柱」注记检查，任何一项不过就不送审。', '未実装（新設を提案）：parity.ok + online-check + コンプライアンス 7 条 + 「23時以降は翌日の日柱」注記チェック。1 つでも不合格なら承認に回さない。', G('growthpilot/live.mjs', 72)],
    ['mismatch', 'live', '卡片分数口径未定', 'カードのスコア基準が未決定', 'live-* 命令用本体公开排名的分数；promo 命令用社内ツール的分数。两套同日 No.1 在 60 天里一致 0 天。平台需选定 1 套并固定标注。', 'live-* コマンドは本体の公開ランキングのスコア、promo コマンドは社内ツールのスコアを使う。2 系統の同日 No.1 は 60 日間で一致 0 日。プラットフォームは 1 系統を選び、注記を固定する必要がある。', G('growthpilot/live.mjs', 149)],
    ['logic', 'live', '文案层沿用社内ツール的固定句', '文案層が社内ツールの固定文をそのまま使用', '公开排名口径里起作用的三合 / 桃花 / 干合没有对应句子，会退到十神那句（输出里 reasonTextCoverage 会提示）。', '公開ランキング基準で効いている三合 / 桃花 / 干合には対応する文がなく、十神の文に落ちる（出力の reasonTextCoverage が警告）。', G('growthpilot/live.mjs', 138)],
    ['content', 'live', '140 字投稿文（caption140）', '140 字投稿文（caption140）', '是对接包新拼的提案，未经业务审批；240/240 条里性格段落都会被裁掉。', '連携パッケージが新たに組んだ提案で、業務側の承認を経ていない。240/240 件で性格段落が切り落とされる。', G('growthpilot/lib/caption140.mjs', 10)],
    ['missing', 'local', '个人分', '個人スコア', 'personal 命令能算，但平台没有用户出生资料来源；PANDA 也没有个人评分接口。现在平台只能出群体分，不能写「あなたは◯点」。', 'personal コマンドは計算できるが、プラットフォームにユーザーの出生資料の入手経路がなく、PANDA にも個人採点 API がない。現状出せるのは集団スコアのみで、「あなたは◯点」とは書けない。', G('growthpilot/index.mjs', 157)],
    ['content', 'publish', 'Instagram 早中晚 3 篇 × 5 页', 'Instagram 朝昼晩 3 本 × 5 ページ', '只有素材对应表；60 日柱的「同事 / 家庭」文案为空，恋爱只有 1 句。', '素材対応表しかない。60 日柱の「同僚 / 家族」文案は空、恋愛は 1 文のみ。', G('data/instagram-skeleton.md', 1)],
    ['logic', 'local', '六曜', '六曜', '只内置 2026 年；2027-01-01 起 context.rokuyo 为 null。', '2026 年分のみ内蔵。2027-01-01 以降 context.rokuyo は null。', G('growthpilot/index.mjs', 64)],
  ]),
  verify: V([
    ['Mac mini 上每日任务是否已安装并在跑', 'Mac mini で日次タスクがインストール済みで稼働しているか', '安装在另一台机器上；看 ~/growthpilot/logs/ 与 out/ 是否每天有新文件。', '別のマシンにインストールされる。~/growthpilot/logs/ と out/ に毎日新しいファイルがあるかを見る。', 'Mac mini 使用者', 'Mac mini 利用者', G('SETUP_MAC_MINI.md', 103)],
    ['Mac mini 上的包是否为 09-15 18:56 之后的版本', 'Mac mini 上のパッケージが 09-15 18:56 以降の版か', '更早的 zip 没有 live.mjs。', 'それ以前の zip には live.mjs がない。', 'Mac mini 使用者', 'Mac mini 利用者'],
    ['提前生成未来日期的个人内容时 asOf 是否 = 运势日期', '未来日付の個人コンテンツを先に生成する際 asOf = 運勢日付になっているか', '本体按「打开页面那一刻」取当前大运；09-18 实测同一人可差 5 分。', '本体は「ページを開いた瞬間」で現在の大運を取る。09-18 の実測で同一人物が 5 点ずれた。', 'GrowthPilot 开发', 'GrowthPilot 開発', G('growthpilot/index.mjs', 157)],
    ['PNG 渲染时字体是否在线加载成功', 'PNG 描画時にフォントがオンラインで読み込めているか', 'Shippori Mincho / Noto Sans JP 来自 Google Fonts；断网时字形不同。', 'Shippori Mincho / Noto Sans JP は Google Fonts から取得。オフラインだと字形が変わる。', 'Mac mini 使用者', 'Mac mini 利用者', G('render/render.html', 1)],
  ]),
  changes: [
    { hash: '09-18', date: '2026-09-18', subject: '另附「PANDA_个人日运对接资料.zip」：个人评分原样源码 + 线上包 0 差异实测', subject_ja: '「PANDA_个人日运对接资料.zip」を別添：個人採点のソース原本 + 本番バンドルとの 0 差異実測', files: 103, area: ['对接包'], scoring: false },
    { hash: 'v1.1.0', date: '2026-09-15', subject: '追加 growthpilot/live.mjs（线上接入 + parity）、render/（PNG）、SETUP_MAC_MINI.md（launchd）', subject_ja: 'growthpilot/live.mjs（オンライン接続 + parity）、render/（PNG）、SETUP_MAC_MINI.md（launchd）を追加', files: 5, area: ['对接包'], scoring: false },
    { hash: 'v1.0.0', date: '2026-09-15', subject: '初版：两套群体评分 + 明细、60 角色资料、文案表、生日反查、60 天测试结果', subject_ja: '初版：集団採点 2 系統 + 内訳、60 キャラ資料、文案表、誕生日逆引き、60 日分のテスト結果', files: 174, area: ['对接包'], scoring: false },
  ], changesNote: '对接包不在 git 里，按交付记录列出', changesNote_ja: '連携パッケージは git 管理外のため納品記録で列挙',
  diagram: { file: 'growthpilot.html', lead: '自动化平台自身的链路：每日定时 → 线上取分 → JSON → PNG →（闸门）→ 审批 → 发布。紫虚线 = 未实现。', lead_ja: '自動化プラットフォーム自身の流れ：日次定時 → オンラインでスコア取得 → JSON → PNG →（ゲート）→ 承認 → 投稿。紫の破線 = 未実装。' },
};

// ═══ 系统间衔接 ═══
const LK = (rows) => rows.map(([from, to, status, what, what_ja, evidence, evidence_ja, source]) => ({ from, to, status, level: status === 'bad' ? 'bug' : status === 'gap' ? 'todo' : 'ok', what, what_ja, evidence, evidence_ja, source: source || null, stale: !!(source && source.stale) }));
const links = {
  lead: '三个系统各自独立部署。这里只列它们之间的连接点——哪条接上了、哪条对不上、哪条还没有。', lead_ja: '3 つのシステムはそれぞれ独立してデプロイされている。ここではシステム間の接続点だけを列挙する——どれが繋がり、どれが一致せず、どれがまだ無いか。',
  diagram: { file: 'links.html' },
  items: LK([
    ['① 本体', '③ 自动化平台', 'ok', '公开排名 API /api/fortune/ranking-daily → live-all', '公開ランキング API /api/fortune/ranking-daily → live-all', '09-15 实测：线上 240 个分数与对接包本地复刻一致。', '09-15 実測：本番の 240 スコアが連携パッケージのローカル複製と一致。', M('api/fortune/ranking-daily.js', /export default/)],
    ['① 本体', '③ 自动化平台', 'ok', '个人评分源码原样导出', '個人採点ソースの原本エクスポート', '09-18 实测：线上部署代码 vs 导出源码，命盘 304 / 日运 1,520 / 短评 6,080，0 差异。', '09-18 実測：本番デプロイコード vs エクスポート元コード、命式 304 / 日運 1,520 / 短評 6,080 で 0 差異。', M('src/logic/fortuneCalc.js', /export function calcDailyScore/)],
    ['① 本体', '③ 自动化平台', 'gap', '用户出生资料 → 个人分', 'ユーザーの出生資料 → 個人スコア', '本体没有个人评分接口（浏览器内计算）；平台没有数据库读权限。未打通。', '本体に個人採点 API がなく（ブラウザ内計算）、プラットフォームに DB 読み取り権限もない。未接続。', M('src/pages/FortuneResult.jsx', /calcMeishiki\(fi\)/)],
    ['① 本体', '② 社内ツール', 'bad', '评分核', '採点コア', '社内ツール 08-17 对齐过一次；本体 08-18/19 又改。互相未合并，同一日柱同一天分数不同。', '社内ツールは 08-17 に一度揃えたが、本体が 08-18/19 に再変更。双方未マージで、同じ日柱・同じ日でもスコアが異なる。', I('src/logic/fortuneCalc.js', /export function scoreDailyCore/)],
    ['② 社内ツール', '① 本体', 'bad', '投稿文链接 /c/<slug>', '投稿文リンク /c/<slug>', '图鉴页只在 internal-tools；本番不存在，点了跳回首页。', '図鑑ページは internal-tools のみ。本番に存在せず、押すとトップに戻る。', I('src/logic/promoPick.js', /panda-fortune\.jp\/c\//)],
    ['① 本体', '② 社内ツール', 'ok', '60 张角色图 public/nikchu/kanshi_XX.webp', '60 枚のキャラ画像 public/nikchu/kanshi_XX.webp', '09-18 实测：逐张 sha256 一致。角色「名称」则只在社内ツール分支。', '09-18 実測：全枚 sha256 一致。キャラ「名称」は社内ツールのブランチにしかない。', M('src/data/gogyoFrames.js', 1)],
    ['① 本体', '② 社内ツール', 'ok', 'Firebase 同一项目（Auth + config/internalStaff）', 'Firebase 同一プロジェクト（Auth + config/internalStaff）', '源码核对：社内ツール用本体的 Firebase 项目登录与读名单；不读写用户数据。', 'ソース確認：社内ツールは本体の Firebase プロジェクトでログインし名簿を読む。ユーザーデータは読み書きしない。', I('src/components/internal/InternalGate.jsx', /internalStaff'/)],
    ['② 社内ツール', '③ 自动化平台', 'ok', '文案规则 promoPick.js + 绘图 promoCard.js 的副本', '文案ルール promoPick.js + 描画 promoCard.js の複製', '对接包原样复制了这两个文件并实际渲染过 PNG。社内ツール以后改版，平台侧副本不会自动跟上。', '連携パッケージはこの 2 ファイルをそのまま複製し PNG を実際に描画済み。社内ツールが今後改版しても、プラットフォーム側の複製は自動では追随しない。', I('src/lib/promoCard.js', 1)],
    ['①②③', '—', 'bad', '三套评分互不相等', '3 系統の採点が互いに一致しない', '个人（本体）/ 公开排名（本体 API）/ 社内卡：卡片分 = 个人分仅 1.5% / 0.8%；两套群体分 60 天内每日 No.1 一致 0 天。', '個人（本体）/ 公開ランキング（本体 API）/ 社内カード：カードスコア = 個人スコアはわずか 1.5% / 0.8%。集団 2 系統の毎日の No.1 は 60 日間で一致 0 日。', M('src/logic/dayPillarVsDayScore.js', /^function calcTotal/)],
    ['③ 自动化平台', 'SNS', 'gap', '审批 → 定时发布', '承認 → 定時投稿', '未实现。', '未実装。', null],
  ]),
};

const data = { checkedAt: new Date().toISOString(), title: 'PANDA FORTUNE 全链路排查图', title_ja: 'PANDA FORTUNE 全体経路 点検図', repo: 'https://github.com/arkai3399-code/Panda-Fortune2', generatedAt: new Date().toISOString(), systems: [panda, internal, gp], links };
writeFileSync(OUT, 'window.AUDIT = ' + JSON.stringify(data) + ';\n');
for (const s of data.systems) console.log(s.short.padEnd(10), 'ops', s.stats.ops, 'apis', s.apis.length, 'issues', s.issues.length, 'ja', s.issues.filter((i) => i.what_ja).length, 'verify', s.verify.length, 'changes', s.changes.length);
console.log('links', links.items.length);
