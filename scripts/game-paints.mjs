// Which hulls each paint fits, from the game's own item ports (sc-gamedata `game-paints.json`: a paint fits a vehicle
// whose `hardpoint_paint` port takes its type, size and tags — the rule is in that file's `_assumptions`). Written to
// src/lib/data/game-paints.json and bundled, so RSI+ never fetches it: `paintKey(name)` → the hulls it fits, named as
// src/lib/data/game-ships.json names them (player hulls only — AI, salvage and NPC copies dropped). `shipsFor` reads it
// before guessing from the paint's title. Run scripts/game-ships.mjs first (same build), then this:
//   node scripts/game-paints.mjs [tag|path/to/game-paints.json] [out.json]
// Default: the dumps repo's latest release (always LIVE).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = 'voidput/sc-gamedata-dumps';
const out = process.argv[3] ?? fileURLToPath(new URL('../src/lib/data/game-paints.json', import.meta.url));
const shipsFile = fileURLToPath(new URL('../src/lib/data/game-ships.json', import.meta.url));
const arg = process.argv[2];
const UA = { 'User-Agent': 'rsi-plus game-paints (github.com/voidput/rsi-plus)' };

async function load() {
  if (arg && arg.endsWith('.json')) return JSON.parse(readFileSync(arg, 'utf8'));
  let tag = arg;
  if (!tag) {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: UA });
    if (!res.ok) throw new Error(`latest release: HTTP ${res.status}`);
    tag = (await res.json()).tag_name;
  }
  const res = await fetch(`https://raw.githubusercontent.com/${REPO}/${tag}/data/game-paints.json`, { headers: UA });
  if (!res.ok) throw new Error(`game-paints.json @ ${tag}: HTTP ${res.status}`);
  return res.json();
}

// Same key as `paintKey` in src/lib/store.ts (kept in step by tests/game-data.test.ts): store "400i - Penumbra Paint"
// and game "400i Penumbra Livery" both → "400i penumbra".
const MAKERS =
  /^(drake( interplanetary)?|anvil( aerospace)?|aegis( dynamics)?|origin( jumpworks)?|roberts space industries|rsi|misc|musashi industrial (and|&) starflight concern|crusader( industries)?|argo( astronautics)?|consolidated outland|cnou|c\.o\.|kruger( intergalactic)?|tumbril( land systems)?|greycat( industrial)?|banu|esperia|gatac( manufacture)?|mirai|aopoa|vanduul|xi'?an|xnaa|kastak( arms)?) /;
const paintKey = (title) =>
  title
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*[-–—:]\s*/g, ' ')
    .replace(/\b(paint|livery|skin)\b/g, ' ')
    .replace(/[^a-z0-9']+/g, ' ')
    .trim()
    .replace(MAKERS, '')
    .replace(/^f7[a-z]? (?=hornet\b)/, '')
    .replace(/'/g, '')
    .trim();

const data = await load();
const ships = JSON.parse(readFileSync(shipsFile, 'utf8'));
if (data._build && ships.build && data._build !== ships.build) console.warn(`note: paints are build ${data._build}, ships ${ships.build}`);
const hullByRec = new Map(ships.ships.map((s) => [s.rec, s.name]));
const fits = {};
let kept = 0;
for (const p of data.paints ?? []) {
  if (p.nameStatus || !p.name) continue;
  const hulls = [...new Set((p.vehicles ?? []).map((v) => hullByRec.get(v.className)).filter(Boolean))].sort();
  if (!hulls.length) continue;
  const key = paintKey(p.name);
  if (!key) continue;
  // Two paints with one key (a re-issue): the hulls of both.
  fits[key] = [...new Set([...(fits[key] ?? []), ...hulls])].sort();
  kept++;
}
const keys = Object.keys(fits).sort();
if (keys.length < 300) throw new Error(`only ${keys.length} paints kept: the dump or the hull list changed`);
const body = { build: data._build ?? null, source: `${REPO} game-paints (${data._schema ?? ''})`, fits: Object.fromEntries(keys.map((k) => [k, fits[k]])) };
writeFileSync(out, JSON.stringify(body).replace(/\],"/g, '],\n"') + '\n');
console.log(`wrote ${keys.length} paint keys (${kept} paints, build ${body.build}) to ${out}`);
