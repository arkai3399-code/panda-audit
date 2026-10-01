#!/usr/bin/env node
// 使い方（結果はすべて JSON）:
//   ── ローカル計算（線上に出ない）──
//   node growthpilot/cli.mjs context   2026-09-15
//   node growthpilot/cli.mjs board     2026-09-15 [--no-factors]
//   node growthpilot/cli.mjs rankings  2026-09-15 love [rankingApi|promoCard] [top]
//   node growthpilot/cli.mjs promo     2026-09-15 total jp          ← 社内ツールと同じ（promoCard 系）
//   node growthpilot/cli.mjs character 壬寅
//   node growthpilot/cli.mjs birthdays 壬寅 1995        （または 1990-2000）
//   node growthpilot/cli.mjs personal  '{"year":1990,"month":5,"day":20,"hour":14,"gender":"f","placeName":"東京都"}' 2026-09-15
//   node growthpilot/cli.mjs birthpillar '{"year":1990,"month":5,"day":20,"hour":23,"minute":10,"longitude":141.35}'
//   ── 線上（本番公開 API）に接続 ──
//   node growthpilot/cli.mjs live-check 2026-09-15                    線上の点数 vs ローカル複製の一致確認
//   node growthpilot/cli.mjs live-board 2026-09-15 [--no-factors]
//   node growthpilot/cli.mjs live-promo 2026-09-15 total jp
//   node growthpilot/cli.mjs live-all   2026-09-15 jp [--out out/2026-09-15.json] [--fallback-local]
//   環境変数 PANDA_API_BASE で接続先を変えられる（既定 https://www.panda-fortune.jp）
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import * as gp from './index.mjs';
import * as live from './live.mjs';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--') && !a.includes('=')));
const outIdx = argv.indexOf('--out');
const outFile = outIdx >= 0 ? argv[outIdx + 1] : null;
const a = argv.filter((x, i) => !x.startsWith('--') && !(outIdx >= 0 && i === outIdx + 1));
const [cmd, ...rest] = a;
const out = (o) => {
  const s = JSON.stringify(o, null, 2);
  if (outFile) { mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true }); writeFileSync(outFile, s + '\n'); process.stdout.write(`written: ${outFile}\n`); }
  else process.stdout.write(s + '\n');
};
try {
  switch (cmd) {
    case 'context': out(gp.getDayContext(rest[0])); break;
    case 'board': out(gp.getDailyBoard(rest[0], { factors: !flags.has('--no-factors') })); break;
    case 'rankings': out(gp.getRankings(rest[0], rest[1] || 'total', { engine: rest[2] || 'rankingApi', top: Number(rest[3] || 10) })); break;
    case 'promo': out(gp.getPromoPick(rest[0], rest[1] || 'total', rest[2] || 'jp')); break;
    case 'character': out(gp.getCharacter(rest[0])); break;
    case 'birthdays': {
      const y = /^(\d{4})-(\d{4})$/.exec(rest[1] || '');
      out(gp.getBirthDates(rest[0], y ? [Number(y[1]), Number(y[2])] : Number(rest[1])));
      break;
    }
    case 'personal': out(gp.getPersonalDaily(JSON.parse(rest[0]), rest[1])); break;
    case 'birthpillar': out(gp.dayPillarForBirth(JSON.parse(rest[0]))); break;
    case 'live-check': {
      const b = await live.fetchLiveBoard(rest[0]);
      const p = live.parityCheck(b);
      out({ date: b.date, baseUrl: b.baseUrl, logic_version: b.logic_version, fetchedAt: b.fetchedAt, cache: b.cache, pillarsReturned: b.count, ...p });
      if (!p.ok) process.exitCode = 3;
      break;
    }
    case 'live-board': out(await live.getLiveBoard(rest[0], { factors: !flags.has('--no-factors') })); break;
    case 'live-promo': out(await live.getLivePromoPick(rest[0], rest[1] || 'total', rest[2] || 'jp')); break;
    case 'live-all': out(await live.getLiveAll(rest[0], rest[1] || 'jp', { fallbackLocal: flags.has('--fallback-local') })); break;
    default:
      console.error('commands: context | board | rankings | promo | character | birthdays | personal | birthpillar | live-check | live-board | live-promo | live-all');
      process.exit(2);
  }
} catch (e) {
  console.error('ERROR:', e.message);
  process.exit(1);
}
