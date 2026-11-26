// Bundled game data (src/lib/data/game-ships.json, game-paints.json — scripts/game-ships.mjs / game-paints.mjs from the
// sc-gamedata dumps) against RSI's real catalog: paints fit the hulls the game's item ports say, by store name.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gamePaintFits, shipsFor } from '@/lib/items';
import { paintKey, withExtraShips, type CatalogShip } from '@/lib/store';
import paints from '@/lib/data/game-paints.json';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/catalog.json', import.meta.url), 'utf8')) as { id: number; name: string; manufacturer: string }[];
const catalog = withExtraShips(fixture.map((c) => ({ id: c.id, name: c.name, manufacturer: c.manufacturer, focus: '', msrp: 1000, flyable: '', link: '', thumb: null, standalone: [], ccu: [] }) as CatalogShip));
const names = (t: string) => shipsFor(t, catalog).map((s) => s.name.trim()).sort();

describe('game paint fits', () => {
  it('store paint names reach the game data', () => {
    expect(names('400i - Penumbra Paint')).toEqual(['400i']);
    expect(names('100 Series - Blue Ametrine Paint')).toEqual(['100i', '125a', '135c']);
    expect(names('890 Jump - Skyline Paint')).toEqual(['890 Jump']);
    expect(names('600i - Sterling Paint')).toEqual(['600i Explorer', '600i Touring']);
  });
  it('Hornet Mk II paints fit the F7A Mk II too (same paint port in the game)', () => {
    expect(names('F7 Hornet Mk II - Bracken Paint')).toContain('F7A Hornet Mk II');
    expect(names('F7 Hornet Mk II - Bracken Paint')).toContain('F7C Hornet Mk II');
  });
  it('the Impound "Paints - " prefix and the hangar title shape both work', () => {
    expect(gamePaintFits('Paints - 890 Jump - Penumbra Paint', catalog)?.map((s) => s.name)).toEqual(['890 Jump']);
    expect(gamePaintFits('400i Penumbra Livery', catalog)?.map((s) => s.name)).toEqual(['400i']);
  });
  it('unknown to the game: the title still decides', () => {
    expect(gamePaintFits('Cutlass - Made Up Paint', catalog)).toBeNull();
    expect(names('Cutlass Black - Made Up Paint')).toEqual(['Cutlass Black']);
  });
  it('keys are already paintKey-normal (the script keeps a copy of paintKey)', () => {
    const keys = Object.keys((paints as { fits: Record<string, string[]> }).fits);
    expect(keys.length).toBeGreaterThan(300);
    expect(keys.filter((k) => paintKey(k) !== k)).toEqual([]);
  });
});
