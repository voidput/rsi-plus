// Dumps every vehicle name the Star Citizen Wiki API knows (ships, ground vehicles, in-game-only variants) to
// tests/fixtures/wiki-ships.json for the ship-match audit (tests/ship-match.test.ts): each name is run through
// `matchShip` against tests/fixtures/catalog.json, so a hull RSI's catalog lacks (an F7A that became an F7C) shows up in
// a test, not in a bug report. Names only, sorted, so it diffs cleanly. Re-run with `node scripts/dump-catalog.mjs`.
//   node scripts/wiki-ships.mjs [out.json]      (default: tests/fixtures/wiki-ships.json, from any directory)
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const API = 'https://api.star-citizen.wiki/api/v2/vehicles';
const out = process.argv[2] ?? fileURLToPath(new URL('../tests/fixtures/wiki-ships.json', import.meta.url));

const names = new Set();
for (let page = 1; page < 50; page++) {
  const res = await fetch(`${API}?limit=100&page=${page}`, { headers: { 'User-Agent': 'rsi-plus wiki-ships (github.com/voidput/rsi-plus)' } });
  if (!res.ok) throw new Error(`star-citizen.wiki vehicles: HTTP ${res.status}`);
  const { data } = await res.json();
  if (!Array.isArray(data) || !data.length) break;
  for (const v of data) if (typeof v.name === 'string' && v.name.trim()) names.add(v.name.trim());
}
if (names.size < 200) throw new Error(`star-citizen.wiki vehicles: only ${names.size} names`);
const list = [...names].sort((a, b) => a.localeCompare(b, 'en'));
writeFileSync(out, '[\n' + list.map((t) => JSON.stringify(t)).join(',\n') + '\n]\n');
console.log(`wrote ${list.length} names to ${out}`);
