// 社内ツール（internal-tools 分支）专用扫描：只看「该分支独有」的文件。
//   node analyze_internal.mjs <snapshotDir> <outFile> <onlyFilesJson>
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
const [SNAP, OUT, ONLY] = process.argv.slice(2);
const only = JSON.parse(ONLY).filter((f) => existsSync(path.join(SNAP, f)));
const read = (r) => readFileSync(path.join(SNAP, r), 'utf8');

const EFFECTS = [
  [/buildPromoCard|toBlob|canvas/i, '绘制卡片'], [/createZipBlob|download|URL\.createObjectURL/, '下载文件'], [/clipboard/, '复制到剪贴板'],
  [/pickPromoDayPillar|pickPromoRange|buildPromoText|composeCaption/, '选角 / 组文案'], [/localStorage/, '本地存储'],
  [/signInWith|createUserWith|signOut\(|sendPasswordResetEmail/, 'Firebase Auth'], [/getDoc|doc\(db/, '读 Firestore'],
  [/navigate\(|<Link|href=/, '跳转'], [/set[A-Z][A-Za-z]*\(/, '改界面状态'], [/navigator\.share/, '系统分享'],
];
function labelNear(lines, i) {
  const chunk = lines.slice(i, i + 9).join(' ');
  for (const re of [/\bt\(\s*['"`]([^'"`]{1,40})['"`]/, /aria-label=["'{]+\s*['"`]?([^'"`}]{1,40})/, /title=["']([^"']{1,40})["']/, />\s*([^<>{}\n]*[ぁ-んァ-ヶ一-龠A-Za-z][^<>{}\n]{0,38})\s*</]) { const m = re.exec(chunk); if (m && m[1].trim() && !/^[=>)\s]+$/.test(m[1])) return m[1].trim().replace(/\s+/g, ' '); }
  return '';
}
const handlerOf = (s) => { const m = /on(?:Click|Submit|Change)=\{\s*(?:\(\s*[a-z]*\s*\)\s*=>\s*)?([^}]{1,80})/.exec(s); return m ? m[1].trim() : ''; };
function effectsOf(src, handler) {
  const name = (/^([A-Za-z_][A-Za-z0-9_]*)\b/.exec(handler) || [])[1]; let body = handler;
  if (name && !/^set[A-Z]/.test(name)) { const m = new RegExp(`(?:const|function)\\s+${name}\\b[^\\n]*`).exec(src); if (m) body = src.slice(m.index, m.index + 2600); }
  return EFFECTS.filter(([re]) => re.test(body)).map(([, t]) => t);
}
const GROUPS = [
  { id: 'gate', title: '入口ガード（ログイン / 許可リスト / 開放モード）', test: (f) => /InternalGate/.test(f) },
  { id: 'promo', title: '宣伝カード生成 /internal/promo', test: (f) => /InternalPromoPage/.test(f) },
  { id: 'zukan', title: '日柱キャラ図鑑 /c ・ /c/<slug>', test: (f) => /DayPillarCharacter(Index)?Page|DayPillarArt|DayPillarLangBar/.test(f) },
  { id: 'share', title: 'シェアカード部品（本番未接続）', test: (f) => /ShareCardButton|DayPillarCharacterCard/.test(f) },
  { id: 'logic', title: '選定・文案・描画ロジック（操作点なし）', test: (f) => /\.(js)$/.test(f) },
];
const groups = GROUPS.map((g) => ({ id: g.id, title: g.title, layers: [] }));
for (const f of only.filter((x) => /\.(jsx|js)$/.test(x))) {
  const src = read(f); const lines = src.split('\n'); const ops = [];
  if (f.endsWith('.jsx')) lines.forEach((l, i) => {
    if (/^\s*(\/\/|\*|\{\/\*)/.test(l)) return;
    for (const ev of ['onClick', 'onSubmit', 'onChange']) { if (!l.includes(ev + '=')) continue; const h = handlerOf(l.slice(l.indexOf(ev + '='))); ops.push({ line: i + 1, kind: ev === 'onClick' ? '按钮' : ev === 'onSubmit' ? '表单提交' : '输入', label: labelNear(lines, i), handler: h.slice(0, 70), effects: effectsOf(src, h), apis: [] }); }
    const lk = /<Link\s+to=\{?["'`]([^"'`}]+)/.exec(l) || /<a\s[^>]*href=\{?["'`]([^"'`}]+)/.exec(l);
    if (lk) ops.push({ line: i + 1, kind: '链接', label: labelNear(lines, i) || lk[1], handler: '→ ' + lk[1], effects: ['跳转'], apis: [] });
  });
  const exportsList = [...src.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+([A-Za-z0-9_]+)/g)].map((m) => ({ name: m[1], line: src.slice(0, m.index).split('\n').length }));
  const g = groups.find((x) => GROUPS.find((y) => y.id === x.id).test(f));
  g.layers.push({ file: f, reachable: true, ops, exports: exportsList });
}
for (const g of groups) { g.opCount = g.layers.reduce((s, l) => s + l.ops.length, 0); g.layerCount = g.layers.length; }
const stats = { layers: groups.reduce((s, g) => s + g.layers.length, 0), pages: only.filter((f) => /src\/pages\//.test(f)).length, ops: groups.reduce((s, g) => s + g.opCount, 0) };
writeFileSync(OUT, 'window.AUDIT_SCAN_INTERNAL = ' + JSON.stringify({ stats, groups }) + ';\n');
console.log(JSON.stringify(stats)); for (const g of groups) console.log(String(g.opCount).padStart(4), g.layerCount, g.title);
