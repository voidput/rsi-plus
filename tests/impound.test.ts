// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import fixture from './fixtures/impound-products.json';
import {
  NO_IMP_FILTER,
  paidByTitle,
  filterRows,
  handleFromUrl,
  kindOf,
  markup,
  matchesQuery,
  buybackIndex,
  imageOf,
  sizedImage,
  dealOf,
  ownership,
  pageOf,
  paintShips,
  rsiStatus,
  parseSku,
  pickVariant,
  priceCtx,
  productFromPage,
  putProducts,
  rowOf,
  rsiPrice,
  sortRows,
  toProduct,
  type ImpProduct,
  type OwnCtx,
} from '@/lib/impound';
import { paintKey as paintKeyOf, type CatalogShip } from '@/lib/store';
import { ownedTitleCounts } from '@/lib/owned-counts';
const ownedTitleCountsFor = (titles: string[]) => ownedTitleCounts(titles.map((t) => ({ name: t, items: [{ title: t, kind: 'skin' }] }) as never));
import type { OwnedShip } from '@/lib/items';

const ship = (id: number, name: string, msrp: number, extra: Partial<CatalogShip> = {}): CatalogShip => ({ id, name, manufacturer: '', focus: '', msrp, flyable: '', link: '', thumb: null, standalone: [], ccu: [], ...extra });
const SHIPS = [ship(10, '350r', 12500), ship(234, 'C1 Spirit', 12500), ship(11, 'F7C Hornet Mk I', 12500), ship(57, 'Cutlass Red', 13500), ship(178, 'Corsair', 25000), ship(61, 'Herald', 8500), ship(217, 'Perseus', 72500), ship(173, 'Arrow', 7500)];
const ctx = priceCtx(SHIPS, [{ id: 1, name: '100 Series - Melrose Paint - Imperator', url: '', price: 500, discounted: 500, available: true, thumb: null }]);
const products = (fixture.products as unknown[]).map((p) => toProduct(p)!) as ImpProduct[];
const by = (h: string) => products.find((p) => p.handle.startsWith(h))!;
const hull = (id: number, count = 1): [number, OwnedShip] => [id, { ship: SHIPS.find((s) => s.id === id)!, count, game: 0, gameHow: [], lti: true, insurance: [], items: [], paints: [] }];
const NOBODY: OwnCtx = { hulls: new Map(), ccus: [], titles: { exact: new Map(), cut: new Map() } };

describe('SKUs', () => {
  it('upgrades, standalone, concept, packs, paints', () => {
    expect(parseSku('10-57.0M.N')).toEqual({ kind: 'ccu', ships: [57], from: 10, insurance: 0 });
    expect(parseSku('0-178.L.CC')).toEqual({ kind: 'ship', ships: [178], from: null, insurance: 'lti' });
    expect(parseSku('0-178.120M.CC').insurance).toBe(120);
    expect(parseSku('UNIQUE.61.L')).toEqual({ kind: 'ship', ships: [61], from: null, insurance: 'lti' });
    expect(parseSku('UNIQUE.217.173.173.L')).toEqual({ kind: 'pack', ships: [217, 173, 173], from: null, insurance: 'lti' });
    expect(parseSku('UNIQUE.223.L.P.1').ships).toEqual([223]);
    expect(parseSku('p.1000').kind).toBe('paint');
    expect(parseSku('F.164').kind).toBe('gear');
    expect(parseSku('MISSING').kind).toBe('other');
  });
  it('reads products.json prices as dollars', () => {
    const c = by('corsair');
    expect(c.variants[0]).toMatchObject({ sku: '0-178.L.CC', price: 23999, compareAt: 25000, available: true });
    expect(kindOf(by('upgrade-to-cutlass-red'))).toBe('ccu');
  });
});

describe('RSI price and markup', () => {
  it('upgrade = MSRP difference', () => {
    const up = by('upgrade-to-cutlass-red');
    const r = rsiPrice(up, up.variants[0]!, ctx);
    expect(r.cents).toBe(1000);
    expect(markup(up.variants[0]!.price, r)).toEqual({ cents: 1099, pct: 1.099 });
  });
  it('upgrade on sale uses the sale SKU', () => {
    const sale = priceCtx([...SHIPS.filter((s) => s.id !== 57), ship(57, 'Cutlass Red', 13500, { ccu: [{ id: 1, title: 'Warbond', price: 13000, available: true, stock: null }] })], []);
    const up = by('upgrade-to-cutlass-red');
    expect(rsiPrice(up, up.variants[0]!, sale)).toMatchObject({ cents: 500, onSale: true });
  });
  it('standalone: store SKU when on sale, else MSRP', () => {
    const c = by('corsair');
    expect(rsiPrice(c, c.variants[0]!, ctx)).toMatchObject({ cents: 25000, onSale: false });
    const sale = priceCtx([ship(178, 'Corsair', 25000, { standalone: [{ id: 2, title: 'Corsair', price: 24000, available: true, stock: null }] })], []);
    expect(rsiPrice(c, c.variants[0]!, sale)).toMatchObject({ cents: 24000, onSale: true });
  });
  it('pack = sum of MSRP; paint by title', () => {
    const p = by('ambush-pack');
    expect(rsiPrice(p, p.variants[0]!, ctx).cents).toBe(72500 + 7500 + 7500);
    const paint = by('100-series-melrose');
    expect(rsiPrice(paint, paint.variants[0]!, ctx).cents).toBe(500);
  });
  it('unknown ship → no price', () => {
    const h = by('herald');
    expect(rsiPrice(h, h.variants[0]!, priceCtx([], [])).cents).toBeNull();
    expect(markup(100, { cents: null, basis: '', onSale: false })).toBeNull();
  });
});

describe('ownership', () => {
  const own: OwnCtx = { hulls: new Map([hull(10), hull(173, 2)]), ccus: [{ fromId: 234, toId: 57, ref: 1, source: 'hangar', value: 1000, gifted: false }], titles: { exact: new Map(), cut: new Map() } };
  const byId = new Map(SHIPS.map((s) => [s.id, s]));
  it('upgrade: own from ship, own the exact CCU', () => {
    const up = by('upgrade-to-cutlass-red');
    expect(ownership(up, up.variants[0]!, own, byId)).toMatchObject({ owned: false, haveFrom: true });
    expect(ownership(up, up.variants[1]!, own, byId)).toMatchObject({ owned: true, count: 1, haveFrom: false });
  });
  it('pack: partial', () => {
    const p = by('ambush-pack');
    expect(ownership(p, p.variants[0]!, own, byId)).toMatchObject({ owned: false, partial: { have: 1, of: 2 } });
  });
  it('picks the cheapest variant you can apply', () => {
    const up = by('upgrade-to-cutlass-red');
    const allIn = { ...up, variants: up.variants.map((v) => ({ ...v, available: true })) };
    expect(pickVariant(allIn, own)!.title).toBe('350r');
  });
});

describe('filters and sort', () => {
  const own: OwnCtx = { ...NOBODY, hulls: new Map([hull(178)]) };
  const rows = products.map((p) => rowOf(p, ctx, own)!);
  it('kinds, owned, priced, markup cap', () => {
    expect(filterRows(rows, { ...NO_IMP_FILTER, kinds: ['ccu'] }).map((r) => r.product.handle)).toEqual(['upgrade-to-cutlass-red']);
    expect(filterRows(rows, { ...NO_IMP_FILTER, hideOwned: true }).some((r) => r.product.handle.startsWith('corsair'))).toBe(false);
    expect(filterRows(rows, { ...NO_IMP_FILTER, onlyOwned: true }).map((r) => r.product.handle)).toEqual(['corsair-standalone-ship']);
    expect(filterRows(rows, { ...NO_IMP_FILTER, maxMarkup: 0 }).map((r) => r.product.handle)).toEqual(['corsair-standalone-ship']);
  });
  it('query words and -exclusions', () => {
    const c = by('corsair');
    expect(matchesQuery(c, 'drake corsair')).toBe(true);
    expect(matchesQuery(c, 'corsair -drake')).toBe(false);
  });
  it('markup sort puts unpriced last', () => {
    const s = sortRows(rows, 'markup-pct').map((r) => r.product.handle);
    expect(s[0]).toBe('corsair-standalone-ship');
  });
});

describe('pages', () => {
  it('urls', () => {
    expect(pageOf('/products/x')).toBe('product');
    expect(pageOf('/collections/drake-interplanetary/products/x')).toBe('product');
    expect(pageOf('/collections/drake-interplanetary')).toBe('collection');
    expect(pageOf('/search')).toBe('search');
    expect(handleFromUrl('https://theimpound.com/collections/a/products/corsair-standalone-ship?variant=1')).toBe('corsair-standalone-ship');
  });
  it('product page: variants from meta, stock from JSON-LD', () => {
    document.body.innerHTML = `<script>window.ShopifyAnalytics = {}; var meta = {"product":{"id":1,"vendor":"Drake","type":"Upgrade","handle":"upgrade-to-cutlass-red","variants":[{"id":5,"price":2099,"name":"Upgrade to Cutlass Red - 350r","public_title":"350r","sku":"10-57.0M.N"},{"id":6,"price":2599,"name":"x","public_title":"C1 Spirit","sku":"234-57.0M.N"}]},"page":{}};
for (var attr in meta) {}</script><script type="application/ld+json">{"@type":"Product","name":"Upgrade to Cutlass Red","offers":[{"sku":"10-57.0M.N","availability":"http://schema.org/OutOfStock"},{"sku":"234-57.0M.N","availability":"http://schema.org/InStock"}]}</script>`;
    const p = productFromPage(document, 'upgrade-to-cutlass-red')!;
    expect(p.title).toBe('Upgrade to Cutlass Red');
    expect(p.variants.map((v) => [v.title, v.price, v.available])).toEqual([
      ['350r', 2099, false],
      ['C1 Spirit', 2599, true],
    ]);
  });
  it('cache cap', () => {
    const c = putProducts({}, products, 1);
    expect(Object.keys(c)).toHaveLength(products.length);
  });
});

describe('contents and paid', () => {
  const paints = ['100 Series - Flame Paint', '100 Series - Blue Ametrine Paint', '100 Series - Slate Camo Paint', '100 Series - Timberline Paint', '100 Series - Frostbite Paint', '100 Series - Invictus Blue and Gold Paint', '100 Series - 5 Paint Pack', 'Cutlass - Skull and Crossbones Paint'].map((name, id) => ({ id, name, url: '', price: 500, discounted: 500, available: true, thumb: null }));
  const pctx = priceCtx(SHIPS, paints);
  const pack = toProduct({ handle: 'p5', title: '100 Series - 5 Paint Pack', product_type: 'Paint', vendor: '', tags: [], body_html: '<p>This pack includes all five 100 Series paints: Flame Blue Ametrine Slate Camo Timberline Frostbite These paints are compatible with all 100 Series variants.</p><h2>What you\'re getting</h2><ul><li>Compatible ship: 100 Series</li></ul>', variants: [{ id: 1, title: 'Default Title', sku: 'P.159.367.A', price: '25.00', available: true }] })!;
  it('description text stops at the boilerplate', () => {
    expect(pack.text).toBe('This pack includes all five 100 Series paints: Flame Blue Ametrine Slate Camo Timberline Frostbite These paints are compatible with all 100 Series variants.');
  });
  it('paint pack: x/y in hangar from the paints it names', () => {
    const real: OwnCtx = { ...NOBODY, titles: ownedTitleCountsFor(['100 Series - Flame Paint', '100 Series - Frostbite Paint']) };
    const r = rowOf(pack, pctx, real)!;
    expect(r.own.partial).toEqual({ have: 2, of: 5 });
    expect(r.own.label).toContain('you have 2/5 in your hangar');
    expect(r.own.contents!.map((c) => c.name)).not.toContain('100 Series - Invictus Blue and Gold Paint');
  });
  it('pack pieces carry RSI pictures and prices', () => {
    const withThumb = priceCtx(SHIPS, paints.map((x) => ({ ...x, thumb: `https://media.example/${x.id}/subscribers_vault_thumbnail.jpg` })));
    const r = rowOf(pack, withThumb, NOBODY)!;
    expect(r.own.contents![0]).toMatchObject({ cents: 500, sold: true, thumb: 'https://media.example/0/subscribers_vault_thumbnail.jpg' });
    const sp = rowOf(toProduct({ handle: 'x', title: 'Cutlass Red + Skull and Crossbones Paint - LTI', product_type: '', vendor: '', tags: [], variants: [{ id: 1, title: 'Default Title', sku: 'UNIQUE.57.L.P', price: '200', available: true }] })!, withThumb, NOBODY)!;
    expect(sp.own.contents!.find((c) => c.ship)).toMatchObject({ name: 'Cutlass Red', cents: 13500, sold: false });
  });
  it('ship pack with paints counts both', () => {
    const p = toProduct({ handle: 'x', title: 'Cutlass Red + Skull and Crossbones Paint - LTI', product_type: '', vendor: '', tags: [], variants: [{ id: 1, title: 'Default Title', sku: 'UNIQUE.57.L.P', price: '200', available: true }] })!;
    const real: OwnCtx = { ...NOBODY, hulls: new Map([hull(57)]), titles: ownedTitleCountsFor([]) };
    const r = rowOf(p, pctx, real)!;
    expect(r.own.partial).toEqual({ have: 1, of: 2 });
  });
  it('paid: cheapest single pledge beats a pack', () => {
    const m = paidByTitle([
      { name: 'Pirate Pack', value: 300, items: [{ title: 'Cutlass Black' }, { title: 'Skull Paint' }], ships: ['Cutlass Black'] },
      { name: 'Skull Paint', value: 8, items: [{ title: 'Skull Paint' }], ships: [] },
      { name: 'Gift', value: 0, items: [{ title: 'Gift' }], ships: [] },
    ]);
    expect(m.get(paintKeyOf('Skull Paint'))).toEqual({ cents: 800, pledge: 'Skull Paint', pack: false });
    expect(m.has(paintKeyOf('Gift'))).toBe(false);
  });
});

describe('stated counts', () => {
  it('"6 Paint Pack" with 5 nameable → x/6', () => {
    const paints = ['Flame', 'Frostbite'].map((n, id) => ({ id, name: `100 Series - ${n} Paint`, url: '', price: 500, discounted: 500, available: true, thumb: null }));
    const pctx = priceCtx(SHIPS, paints);
    const p = toProduct({ handle: 'p6', title: '100 Series - 6 Paint Pack', product_type: 'Paint', vendor: '', tags: [], body_html: '<p>Get Flame and Frostbite and more</p>', variants: [{ id: 1, title: 'Default Title', sku: 'P.1335', price: '30', available: true }] })!;
    const real: OwnCtx = { ...NOBODY, titles: ownedTitleCountsFor(['100 Series - Flame Paint']) };
    const r = rowOf(p, pctx, real)!;
    expect(r.own.partial).toEqual({ have: 1, of: 6 });
    expect(r.own.label).toContain('4 not identified');
  });
});

describe('paints for my ships', () => {
  const fleet = [ship(223, '400i', 25000), ship(140, '600i Touring', 43500), ship(141, '600i Explorer', 47500), ship(900, '890 Jump', 95000), ship(159, '100i', 5000), ship(160, '125a', 6000)];
  const pc = priceCtx(fleet, []);
  const paint = (title: string, sku: string): ImpProduct => ({ handle: title.toLowerCase().replace(/\W+/g, '-'), title, vendor: '', type: 'Paint', tags: [], variants: [{ id: 1, title: 'Default Title', sku, price: 1000, available: true, compareAt: null }] }) as unknown as ImpProduct;
  const names = (p: ImpProduct) => paintShips(p, pc).map((s) => s.name).sort();
  it('reads the hull from the title, the "Paints - " prefix and series names too', () => {
    expect(names(paint('400i - Meridian Paint', 'P.223.411.L'))).toEqual(['400i']);
    expect(names(paint('Paints - 890 Jump - Penumbra Paint', 'P.1141'))).toEqual(['890 Jump']);
    expect(names(paint('100 Series - Slate Camo Paint', 'P.159.383.A'))).toEqual(['100i', '125a']);
  });
  it('falls back to the SKU ship id, widened to the family; packs naming no ship match nothing', () => {
    expect(names(paint('Fortuna Paint', 'P.140.392.L'))).toEqual(['600i Explorer', '600i Touring']);
    expect(names(paint('Paints - Auspicious Red Dragon and Dog Paint Pack', 'P.1332'))).toEqual([]);
  });
  it('the filter keeps paints for hulls you own only', () => {
    const own: OwnCtx = { ...NOBODY, hulls: new Map([[141, { ship: fleet[2]!, count: 1, game: 0, gameHow: [], lti: false, insurance: [], items: [], paints: [] }]]) };
    const rows = [paint('600i - Sterling Paint', 'p.1038'), paint('400i - Meridian Paint', 'P.223.411.L')].map((p) => rowOf(p, pc, own)!);
    expect(filterRows(rows, { ...NO_IMP_FILTER, myPaints: true }).map((r) => r.product.title)).toEqual(['600i - Sterling Paint']);
    expect(rowOf(paint('400i - Meridian Paint', 'P.223.411.L'), pc, NOBODY)!.fitsMine).toBe(false);
  });
});

describe('not on RSI, last at RSI, deals, buyback', () => {
  const YEAR = Date.UTC(2025, 5, 1);
  const sold = { id: 1, title: 'Standard', price: 9000, available: true, stock: null };
  const fleet = [ship(10, '350r', 12500), ship(57, 'Cutlass Red', 13500, { ccu: [sold] }), ship(178, 'Corsair', 25000)];
  const history = { 178: { 'ship-wb': [{ p: 21000, from: YEAR - 86_400_000, to: YEAR }], msrp: [{ p: 25000, from: YEAR, to: YEAR }] }, 57: { 'ccu-wb': [{ p: 13000, from: YEAR, to: YEAR }] } };
  const paints = [{ id: 5, name: 'Corsair - Ghoulish Green Paint', url: '', price: 1000, discounted: 1000, available: false, thumb: null }];
  const pc = priceCtx(fleet, paints, {
    history,
    paintSeen: { [paintKeyOf('Corsair - Ghoulish Green Paint')]: { p: 1000, at: YEAR } },
    buyback: [
      { id: 7, name: 'Upgrade - 350r to Cutlass Red', date: '', contained: '', type: 'upgrade', upgrade: { fromId: 10, fromName: '350r', toId: 57, toName: 'Cutlass Red' }, url: '/x', price: 800 },
      { id: 8, name: 'Standalone Ships - Corsair', date: '', contained: '', type: 'ship', upgrade: null, url: null, items: [{ title: 'Corsair', kind: 'Ship' }] },
    ] as never,
  });
  const prod = (title: string, sku: string, type = ''): ImpProduct => ({ handle: 'h', title, vendor: '', type, tags: [], variants: [{ id: 1, title: 'Default Title', sku, price: 1, available: true, compareAt: null }] }) as unknown as ImpProduct;
  it('ship not sold today: last seen with its price; sold ship: true', () => {
    const st = rsiStatus(prod('Corsair', '0-178.L.S'), parseSku('0-178.L.S'), pc);
    expect(st).toMatchObject({ sold: false, last: { at: YEAR, cents: 21000, what: 'Warbond standalone' } });
    expect(rsiStatus(prod('Cutlass Red', '0-57.L.S'), parseSku('0-57.L.S'), pc).sold).toBe(true);
  });
  it('paint: sold out at RSI → last seen from the paint memory; gear → unknown', () => {
    const st = rsiStatus(prod('Corsair - Ghoulish Green Paint', 'P.1'), parseSku('P.1'), pc);
    expect(st).toMatchObject({ sold: false, last: { cents: 1000, what: 'Store paint' } });
    expect(rsiStatus(prod('Helmet', 'F.1'), parseSku('F.1'), pc).sold).toBeNull();
    expect(rsiStatus(prod('Corsair', '0-178.L.S'), parseSku('0-178.L.S'), priceCtx([], [])).sold).toBeNull();
  });
  it('deal tiers: under the lowest on record beats under today', () => {
    expect(dealOf(parseSku('0-178.L.S'), 20000, { cents: -5000, pct: -0.2 }, pc)).toMatchObject({ tier: 'best' });
    expect(dealOf(parseSku('0-178.L.S'), 22000, { cents: -3000, pct: -0.12 }, pc)).toMatchObject({ tier: 'below' });
    expect(dealOf(parseSku('0-178.L.S'), 26000, { cents: 1000, pct: 0.04 }, pc)).toBeNull();
    // upgrade 350r → Cutlass Red: lowest on record $130 warbond − $125 = $5
    expect(dealOf(parseSku('10-57.0M.CCU'), 400, null, pc)).toMatchObject({ tier: 'best' });
  });
  it('buyback: upgrades by from/to, single-hull ships by name', () => {
    const ix = buybackIndex(pc.buyback.size ? [] : [], fleet);
    expect(ix.size).toBe(0);
    expect(pc.buyback.get('ccu:10-57')).toMatchObject({ id: 7, cents: 800 });
    expect(pc.buyback.get('ship:178')).toMatchObject({ id: 8, cents: null });
  });
});

describe('pictures', () => {
  it('first image from either Shopify shape, protocol-relative made https', () => {
    expect(imageOf({ images: [{ src: 'https://cdn.shopify.com/s/files/1/a.png?v=1' }] })).toBe('https://cdn.shopify.com/s/files/1/a.png?v=1');
    expect(imageOf({ featured_image: '//theimpound.com/cdn/shop/files/b.jpg?v=2', images: ['//x/c.jpg'] })).toBe('https://theimpound.com/cdn/shop/files/b.jpg?v=2');
    expect(imageOf({ images: ['//x.com/c.jpg'] })).toBe('https://x.com/c.jpg');
    expect(imageOf({ images: [] })).toBeUndefined();
    expect(imageOf({ featured_image: 'javascript:alert(1)' })).toBeUndefined();
    expect(toProduct({ handle: 'h', title: 't', variants: [], images: [{ src: 'https://cdn.shopify.com/a.png' }] })!.image).toBe('https://cdn.shopify.com/a.png');
  });
  it('sizedImage sets the width, keeps the version', () => {
    expect(sizedImage('https://cdn.shopify.com/a.png?v=1', 160)).toBe('https://cdn.shopify.com/a.png?v=1&width=160');
  });
});

