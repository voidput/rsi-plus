import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Pledge } from '@/lib/hangar';
import { inventory, ownedShipIds, ownedShipsWithPaints, paintStatus } from '@/lib/items';
import { shipMatches } from '@/lib/debug-export';
import { matchInfo, matchShip, shipKey, withExtraShips, type CatalogShip } from '@/lib/store';

const ship = (id: number, name: string, msrp = id * 1000): CatalogShip => ({ id, name, manufacturer: 'Anvil Aerospace', focus: 'Fighter', msrp, flyable: '', link: `https://rsi/${id}`, thumb: `t${id}`, standalone: [], ccu: [] });
const pledge = (id: number, items: [string, string][], ships: string[] = []): Pledge => ({
  id, name: `Pledge ${id}`, value: 10, date: '', type: 'ship', items: items.map(([title, kind]) => ({ title, kind })), ships, upgrade: null,
  lti: false, insurance: '', warbond: false, giftable: false, meltable: true, hasGame: false, upgraded: false, nickname: '',
});
const cat = [ship(1, 'F7C Hornet Mk I', 7500), ship(2, 'C8R Pisces Rescue'), ship(3, 'L-21 Wolf'), ship(4, 'L-22 Alpha Wolf'), ship(5, 'Cutlass Black')];

/** Model codes of a name: "f7a", "c8r", "hm6" (letters then digits). */
const codes = (name: string) => shipKey(name).split(' ').filter((t) => /^[a-z]+\d+[a-z]*$/.test(t));

describe('matchShip: a model code the catalog lacks is its own hull', () => {
  it('stand-in under the hangar name, data borrowed from the near hull', () => {
    const m = matchInfo('F7A Hornet Mk I', cat)!;
    expect(m.how).toBe('near');
    expect(m.ship).toMatchObject({ name: 'F7A Hornet Mk I', msrp: 7500, manufacturer: 'Anvil Aerospace', near: { id: 1, name: 'F7C Hornet Mk I' }, link: '', standalone: [], ccu: [] });
    expect(m.ship.id).toBeLessThan(-1_000_000);
    expect(matchShip('F7A Hornet Mk I', [...cat])?.id).toBe(m.ship.id); // stable across catalogs
    expect(matchShip('F7A Hornet Mk I', cat)).toBe(m.ship); // memoized per catalog
  });
  it('names without a model code still take the catalog hull', () => {
    expect(matchInfo('F7C Hornet Mk I', cat)).toMatchObject({ how: 'exact', ship: { id: 1 } });
    expect(matchInfo('Wolf', cat)).toMatchObject({ how: 'words', ship: { id: 3 } });
    expect(matchInfo('Cutlass Black Pirate', cat)).toMatchObject({ how: 'contains', ship: { id: 5 } });
    expect(matchInfo('Nothing Here', cat)).toBeNull();
  });
  it('a stand-in owns the near hull’s paints, so they never read as “no ship”', () => {
    const rows = inventory([pledge(1, [['F7A Hornet Mk I', 'Ship']]), pledge(2, [['F7C Hornet Mk I - Dark Paint', 'Skin']])], cat);
    const fleet = ownedShipsWithPaints(rows, [], cat);
    expect(fleet.map((f) => f.ship.name)).toEqual(['F7A Hornet Mk I']);
    const paint = rows.find((r) => r.category === 'paint')!;
    if (paint.fits.length) {
      expect(fleet[0]!.paints).toContain(paint);
      expect(paintStatus(paint, ownedShipIds(fleet.map((f) => f.ship)))).toBe('owned-ship');
    }
  });
  it('the debug file lists each hangar hull, worst match first', () => {
    const local = { catalog: { ships: cat }, hangar: { pledges: [pledge(1, [], ['F7A Hornet Mk I', 'Cutlass Black']), pledge(2, [], ['Mystery Hull', 'Cutlass Black'])] } };
    expect(shipMatches(local)).toEqual([
      { title: 'Mystery Hull', how: 'none', ship: null, count: 1 },
      { title: 'F7A Hornet Mk I', how: 'near', ship: 'F7A Hornet Mk I', near: 'F7C Hornet Mk I', count: 1 },
      { title: 'Cutlass Black', how: 'exact', ship: 'Cutlass Black', count: 2 },
    ]);
    expect(shipMatches({})).toEqual([]);
  });
});

// Ship-match audit: every vehicle name the Star Citizen Wiki knows (tests/fixtures/wiki-ships.json, refresh with
// `node scripts/wiki-ships.mjs`) against RSI's real catalog (tests/fixtures/catalog.json + EXTRA_SHIPS). A hangar name
// must never turn into a catalog hull with a different model code (F7A → F7C): that is a stand-in (`near`) or no match.
// The snapshot shows every name that isn't an exact match: review its diff when a fixture or the matcher changes.
describe('ship-match audit (wiki vehicle names × RSI catalog)', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/catalog.json', import.meta.url), 'utf8')) as { id: number; name: string; manufacturer: string }[];
  const catalog = withExtraShips(fixture.map((c) => ({ ...ship(c.id, c.name), manufacturer: c.manufacturer })));
  const names = JSON.parse(readFileSync(new URL('./fixtures/wiki-ships.json', import.meta.url), 'utf8')) as string[];
  const results = names.map((n) => ({ n, m: matchInfo(n, catalog) }));

  it('no name becomes a hull with another model code', () => {
    expect(names.length).toBeGreaterThan(200);
    const bad = results.filter(({ n, m }) => {
      if (!m || m.how === 'near') return false;
      const mine = codes(n);
      const theirs = codes(m.ship.name);
      return mine.length > 0 && theirs.length > 0 && !mine.some((c) => theirs.includes(c));
    });
    expect(bad.map(({ n, m }) => `${n} → ${m!.ship.name}`)).toEqual([]);
  });
  it('F8C Lightning and its Executive Edition match the F8C extra (no catalog entry of its own)', () => {
    expect(matchInfo('F8C Lightning', catalog)).toMatchObject({ how: 'exact', ship: { id: -9007 } });
    expect(matchInfo('F8C Lightning Executive Edition', catalog)?.ship.id).toBe(-9007);
    expect(matchInfo('F8C Lightning Executive Edition', catalog)?.how).not.toBe('near');
  });
  it('Wikelo / PYAM variants are earned in game: stand-ins of the F8C with no MSRP', () => {
    for (const n of ['F8C Lightning Wikelo War Special', 'F8C Lightning Wikelo Sneak Special', 'F8C Lightning PYAM Exec']) {
      const m = matchInfo(n, catalog)!;
      expect(m).toMatchObject({ how: 'near', ship: { name: n, msrp: 0, inGame: true, near: { id: -9007 } } });
    }
    expect(matchInfo('F8C Lightning Wikelo War Special', catalog)!.ship.id).not.toBe(matchInfo('F8C Lightning PYAM Exec', catalog)!.ship.id);
  });
  it('stand-ins: one id per hull name (two names may land on one game hull: "600i" and "600i 2951 BIS")', () => {
    const byId = new Map<number, Set<string>>();
    for (const { m } of results) if (m?.how === 'near') byId.set(m.ship.id, (byId.get(m.ship.id) ?? new Set()).add(m.ship.name));
    expect([...byId.values()].filter((n) => n.size > 1).map((n) => [...n].join(' / '))).toEqual([]);
  });
  it('the game list fills hulls RSI does not catalog, with no MSRP and earned flags', () => {
    expect(matchInfo('Mustang Omega', catalog)).toMatchObject({ how: 'near', ship: { name: 'Mustang Omega', manufacturer: 'Consolidated Outland', msrp: 0, fromGame: true } });
    // NPC-only Vanduul records (Mauler destroyer, Scythe) are not in the game list: nobody owns one.
    expect(matchInfo('Mauler Destroyer', catalog)).toBeNull();
    expect(matchInfo('Vanduul Scythe', catalog)).toBeNull();
    // Never shadows an RSI hull: a catalog match wins.
    expect(matchInfo('Cutlass Black', catalog)?.ship.fromGame).toBeUndefined();
  });
  it('every non-exact match, for review', () => {
    expect(results.filter(({ m }) => m?.how !== 'exact').map(({ n, m }) => `${m?.how ?? 'none'}\t${n}${m ? `\t→ ${m.ship.near ? `stand-in (from ${m.ship.near.name})` : m.ship.name}` : ''}`)).toMatchSnapshot();
  });
});
