// Playable vehicles from the game's own files, via the sc-gamedata dumps (github.com/voidput/sc-gamedata-dumps, one
// tag per game build): name, maker, role, size, and whether a variant is only earned in the game (Wikelo trade
// specials, PYAM executive-hangar ships). Written compact to src/lib/data/game-ships.json and bundled: RSI+ uses it
// for hangar hulls RSI's ship catalog has no entry for (`withGameShips` in lib/store.ts) and in the ship-match audit.
//   node scripts/game-ships.mjs [tag|path/to/game-ships.json] [out.json]
// Default: the dumps repo's latest release (always a LIVE build); a local file works too (sc-gamedata's
// data/game-ships.json). Re-run after a patch and commit the diff.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = 'voidput/sc-gamedata-dumps';
const out = process.argv[3] ?? fileURLToPath(new URL('../src/lib/data/game-ships.json', import.meta.url));
const arg = process.argv[2];
const UA = { 'User-Agent': 'rsi-plus game-ships (github.com/voidput/rsi-plus)' };

/** Maker code → name from the same build's game-manufacturers.json (some builds leave the vehicles' maker name blank). */
let makersSrc = null;
async function load() {
  if (arg && arg.endsWith('.json')) {
    try {
      makersSrc = JSON.parse(readFileSync(arg.replace(/game-ships\.json$/, 'game-manufacturers.json'), 'utf8'));
    } catch {}
    return JSON.parse(readFileSync(arg, 'utf8'));
  }
  let tag = arg;
  if (!tag) {
    // The latest release is always LIVE (PTU / EPTU publish as prereleases, HOTFIX is never marked latest); a bare tag
    // list would also offer PTU builds.
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: UA });
    if (!res.ok) throw new Error(`latest release: HTTP ${res.status}`);
    tag = (await res.json()).tag_name;
    if (!tag) throw new Error('no LIVE release found');
  }
  const mres = await fetch(`https://raw.githubusercontent.com/${REPO}/${tag}/data/game-manufacturers.json`, { headers: UA });
  if (mres.ok) makersSrc = await mres.json();
  const res = await fetch(`https://raw.githubusercontent.com/${REPO}/${tag}/data/game-ships.json`, { headers: UA });
  if (!res.ok) throw new Error(`game-ships.json @ ${tag}: HTTP ${res.status}`);
  return res.json();
}

const data = await load();
if (!Array.isArray(data.vehicles)) throw new Error('no vehicles in the dump');

// Record-name parts of copies nobody owns: NPC / AI crews, mission and tutorial hulls, wrecks, test and template records.
const NOT_PLAYER = /_(AI|PU|Unmanned|Template|TEMP|TEST|Derelict|Salvage|ShipBoarded|Boarded|Hijacked|Teach|DefendShip|Tier|Body|Wreck|Tutorial|NPC|Mission|Indust|GS|EA|Advocacy|Xenothreat|QIG|NT|SEC|DEF|CIV|CRIM|Crim|PIR|UEE|VAN|MIS|FF|BMBRCK|NineTails)(_|$)/;
// Event / colour copies of a hull (same ship, another skin): kept out so each name stands for one hull.
const SKIN_COPY = /_(Fleetweek|Fleetweek_\w+)$/;
const earnedOf = (name, rec) => (/\bwikelo\b/i.test(name) || /_Collector_/.test(rec) ? 'wikelo' : /\bpyam\b/i.test(name) ? 'exec' : undefined);

// Game records RSI's ship catalog names differently: written under RSI's name so a paint that fits the game's "600i"
// lands on RSI's 600i Explorer. Find candidates: game hulls the catalog matches to nothing (tests/ship-match audit).
const RSI_NAME = {
  ORIG_600i: '600i Explorer',
  DRAK_Dragonfly: 'Dragonfly Black',
  ANVL_Hornet_F7CM_Heartseeker: 'F7C-M Super Hornet Heartseeker Mk I',
};
// Maker code → name, for records whose maker name is blank (the LIVE 4.10 Mustang Omega).
const makerByCode = new Map([
  ['CNOU', 'Consolidated Outland'],
  ...(makersSrc?.manufacturers ?? []).filter((m) => m.code && m.name && m.name !== m.code).map((m) => [m.code, m.name]),
  ...data.vehicles.filter((v) => v.manufacturerCode && v.manufacturerName).map((v) => [v.manufacturerCode, v.manufacturerName]),
]);
/** The record's own maker first (Blade / Glaive are VNCL_ records made by Esperia), the record-name prefix last. */
const makerOf = (v, rec) => String(v.manufacturerName || makerByCode.get(v.manufacturerCode) || makerByCode.get(String(v.manufacturer ?? '').toUpperCase()) || makerByCode.get(rec.slice(0, 4)) || '').trim();

const byName = new Map();
for (const v of data.vehicles) {
  const rec = String(v.recordName ?? '').replace(/^EntityClassDefinition\./, '');
  const display = String(v.displayName ?? v.name ?? '').replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim();
  // Player hulls are "<maker code>_<name>" records (ANVL_Lightning_F8C); objectives, probes and turrets are not.
  if (!rec || !display || !/^[A-Z]{4}_/.test(rec) || NOT_PLAYER.test(rec) || SKIN_COPY.test(rec) || /_(Command_Module|Turret|Sentry)\b/.test(rec) || v.nameStatus) continue;
  // Vanduul-built records are NPC enemies (Mauler destroyer, Scythe); Esperia's player replicas (Blade, Glaive) share
  // the VNCL_ prefix but name Esperia as the maker.
  const maker = makerOf(v, rec);
  if (/^vanduul$/i.test(maker) || /^Vanduul\b/i.test(display)) continue;
  // RSI's catalog names hulls without the maker ("F8C Lightning", not "Anvil F8C Lightning").
  const short = maker && display.toLowerCase().startsWith(maker.toLowerCase() + ' ') ? display.slice(maker.length + 1) : display.replace(/^(Aegis|Anvil|Argo|Banu|Crusader|Drake|Esperia|Gatac|Greycat|Kruger|MISC|Mirai|Origin|RSI|Tumbril|Consolidated Outland|Aopoa|Musashi|C\.O\.)\s+/i, '');
  const name = RSI_NAME[rec] ?? short;
  if (byName.has(name)) continue;
  const earned = earnedOf(display, rec);
  byName.set(name, {
    name,
    ...(name !== short ? { game: short } : {}),
    rec,
    maker,
    role: String(v.role ?? ''),
    career: String(v.career ?? ''),
    size: typeof v.size === 'number' ? v.size : null,
    ground: v.movementClass === 'ArcadeWheeled' || undefined,
    ...(earned ? { earned } : {}),
  });
}
const list = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, 'en'));
if (list.length < 150) throw new Error(`only ${list.length} playable vehicles: the filter or the dump changed`);
const body = { build: data._build ?? null, source: `${REPO} (${data._source ?? 'game files'})`, ships: list };
writeFileSync(out, JSON.stringify(body, null, 0).replace(/\},\{/g, '},\n{') + '\n');
console.log(`wrote ${list.length} vehicles (build ${body.build}) to ${out}`);
