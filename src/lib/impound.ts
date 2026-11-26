/**
 * The Impound (theimpound.com, a Shopify grey-market store): what RSI+ reads off its pages and the pure logic on top —
 * RSI price and markup per listing, what you already own, filters and sorting.
 *
 * Listings carry RSI's own ship ids in their variant SKUs (checked 2026-11 against `initShipUpgrade` ids:
 * 10 = 350r, 57 = Cutlass Red, 178 = Corsair, 61 = Herald):
 * - `<from>-<to>.<ins>.<kind>[.…]` — `from` 0: a standalone ship `to` (kind CC = CCU'ed, S = standalone, OC = original
 *   concept); `from` > 0: an upgrade from → to (ins `0M`).
 * - `UNIQUE.<ship>[.<ship>…].<ins>[.P][.n][.GAME]` — a ship or pack of ships (P = with paint, GAME = game package).
 * - `P.…` / `p.…` paints, `F.…` / `f.…` gear, `M.…` / `E.…` modules — no ship id; matched by title.
 * Insurance: `L` = lifetime, `<n>M` = n months (`120M` = 10 years, `0M` = none).
 * Product data comes from Shopify's public JSON (`/products/<handle>.js`, `/collections/<c>/products.json`), which
 * The Impound's own pages read too. RSI+ never touches its cart, checkout or account.
 */
import type { OwnedCcu } from './ccu';
import { line, ownedShipIds, shipsFor, type OwnedShip } from './items';
import { ownedTitleCount, type OwnedTitles } from './owned-counts';
import { cleanName, type BuybackItem } from './hangar';
import { lastSeen, lowestSeen, PRICE_KIND_LABEL, type PriceHistory, type PriceKind } from './price-history';
import { matchShip, paintKey, type CatalogShip, type PaintSeen, type StorePaint } from './store';

export const IMPOUND_ORIGIN = 'https://theimpound.com';
/** Optional host asked for by Settings → Integrations → The Impound (wxt.config.ts `optional_host_permissions`). */
export const IMPOUND_HOSTS = [`${IMPOUND_ORIGIN}/*`];

export interface ImpVariant {
  id: number;
  /** Shopify option title: "350r" (upgrade from), "CCU'ed / LTI", "Default Title". */
  title: string;
  sku: string;
  /** USD cents. */
  price: number;
  /** "Regular price" crossed out on the store (cents), null when not on sale. */
  compareAt: number | null;
  available: boolean;
}
export interface ImpProduct {
  handle: string;
  title: string;
  /** Shopify product type: Upgrade, Paint, Combat, Account, … ('' often for concept / LTI listings). */
  type: string;
  vendor: string;
  tags: string[];
  /** The store's description as plain text, up to "What you're getting" (where pack contents are named). */
  text?: string;
  /** The listing's first picture (absolute `https:` Shopify CDN URL); absent on copies cached before it was kept. */
  image?: string;
  variants: ImpVariant[];
}

/** A product's first picture from either JSON shape: `images: [{ src }]` (products.json) or `featured_image` / `images: [url]` (.js). */
export function imageOf(p: any): string | undefined {
  const first = p?.featured_image ?? p?.image?.src ?? (Array.isArray(p?.images) ? (p.images[0]?.src ?? p.images[0]) : null);
  if (typeof first !== 'string' || !first) return undefined;
  const url = first.startsWith('//') ? `https:${first}` : first;
  return /^https:\/\//.test(url) ? url : undefined;
}
/** Shopify CDN resize: the same picture at `width` px (thumbs 120, preview 800). */
export const sizedImage = (url: string, width: number) => {
  try {
    const u = new URL(url);
    u.searchParams.set('width', String(width));
    return u.href;
  } catch {
    return url;
  }
};

/** Plain text of a description's opening part (HTML → text, boilerplate sections dropped, capped). */
export function descText(html: unknown): string | undefined {
  if (typeof html !== 'string' || !html) return undefined;
  const head = html.split(/<h2[^>]*>/i)[0] ?? html;
  const t = head
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // `&amp;` last: unescaping it first would turn `&amp;quot;` into a quote
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return t ? t.slice(0, 2000) : undefined;
}

/** Shopify money in either shape: "20.99" (products.json) or 2099 (cents, `.js` / page meta). */
function cents(v: unknown, isCents: boolean): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(isCents ? n : n * 100);
}

/** A product from `/products.json` (prices "20.99") or `/products/<h>.js` (prices in cents). null when not a product. */
export function toProduct(p: any, pricesInCents = false): ImpProduct | null {
  if (!p || typeof p !== 'object' || !p.handle || !Array.isArray(p.variants)) return null;
  const tags = Array.isArray(p.tags) ? p.tags : typeof p.tags === 'string' ? p.tags.split(/,\s*/) : [];
  return {
    handle: String(p.handle),
    title: String(p.title ?? ''),
    type: String(p.product_type ?? p.type ?? ''),
    vendor: String(p.vendor ?? ''),
    tags: tags.map(String).filter(Boolean),
    ...(descText(p.body_html ?? p.description) ? { text: descText(p.body_html ?? p.description) } : {}),
    ...(imageOf(p) ? { image: imageOf(p) } : {}),
    variants: p.variants.map((v: any) => ({
      id: Number(v.id),
      title: String(v.title ?? v.public_title ?? ''),
      sku: String(v.sku ?? ''),
      price: cents(v.price, pricesInCents) ?? 0,
      compareAt: cents(v.compare_at_price, pricesInCents),
      available: v.available !== false,
    })),
  };
}

/* ---------------------------------------------------------------- SKUs ---------------------------------------------------------------- */

export type SkuKind = 'ship' | 'ccu' | 'pack' | 'paint' | 'gear' | 'other';
export interface SkuInfo {
  kind: SkuKind;
  /** Ship ids it contains (standalone / pack), or the upgrade's target. */
  ships: number[];
  /** Upgrade source ship id (ccu only). */
  from: number | null;
  /** 'lti', months (120 = 10 years), or null when the SKU doesn't say. */
  insurance: 'lti' | number | null;
}

const INS = /^(?:L|(\d+)M)$/;
const insOf = (s: string): SkuInfo['insurance'] | undefined => {
  const m = INS.exec(s);
  return m ? (m[1] == null ? 'lti' : Number(m[1])) : undefined;
};

export function parseSku(sku: string): SkuInfo {
  const s = sku.trim();
  const ft = /^(\d+)-(\d+)\.([^.]+)\.([A-Z]+)/.exec(s);
  if (ft) {
    const from = Number(ft[1]);
    const to = Number(ft[2]);
    const insurance = insOf(ft[3]!) ?? null;
    return from > 0 ? { kind: 'ccu', ships: [to], from, insurance } : { kind: 'ship', ships: [to], from: null, insurance };
  }
  if (/^UNIQUE\./.test(s)) {
    const parts = s.split('.').slice(1);
    const ships: number[] = [];
    let insurance: SkuInfo['insurance'] = null;
    for (const p of parts) {
      const ins = insOf(p);
      if (ins !== undefined) {
        insurance = ins;
        break;
      }
      if (/^\d+$/.test(p)) ships.push(Number(p));
      else break;
    }
    if (ships.length) return { kind: ships.length === 1 ? 'ship' : 'pack', ships, from: null, insurance };
  }
  if (/^p\./i.test(s)) return { kind: 'paint', ships: [], from: null, insurance: null };
  if (/^f\./i.test(s)) return { kind: 'gear', ships: [], from: null, insurance: null };
  return { kind: 'other', ships: [], from: null, insurance: null };
}

/** Kind of a product from its first SKU, falling back to its type / title. */
export function kindOf(p: ImpProduct): SkuKind {
  const k = parseSku(p.variants[0]?.sku ?? '').kind;
  if (k !== 'other') return k;
  if (/^paint$/i.test(p.type)) return 'paint';
  if (/^upgrade$/i.test(p.type) || /^upgrade to /i.test(p.title)) return 'ccu';
  return 'other';
}

export const KIND_LABEL: Record<SkuKind, string> = { ship: 'Ships', ccu: 'Upgrades', pack: 'Packs', paint: 'Paints', gear: 'Gear', other: 'Other' };

export const insuranceLabel = (i: SkuInfo['insurance']) => (i === 'lti' ? 'LTI' : i == null ? '' : i === 0 ? 'no insurance' : i % 12 === 0 ? `${i / 12} yr` : `${i} mo`);

/* ---------------------------------------------------------------- RSI price ---------------------------------------------------------------- */

export interface RsiPrice {
  /** USD cents RSI charges (or would: MSRP) for the same thing; null when RSI+ can't tell. */
  cents: number | null;
  /** How it was worked out, for the tooltip. */
  basis: string;
  /** RSI sells it right now (store SKU / CCU on sale). */
  onSale: boolean;
}
const NONE: RsiPrice = { cents: null, basis: '', onSale: false };

/** Cheapest price among a ship's on-sale SKUs (cents), null when none. */
const cheapest = (skus: { price: number; available: boolean }[]) => {
  const p = skus.filter((s) => s.available && s.price > 0).map((s) => s.price);
  return p.length ? Math.min(...p) : null;
};

export interface PriceCtx {
  /** The ship catalog (one array, so `shipsFor`'s memo holds across rows). */
  ships: CatalogShip[];
  byId: Map<number, CatalogShip>;
  /** Store paints by `paintKey(name)`. */
  paints: Map<string, StorePaint>;
  /** Single store paints (no packs) by their line ("100 series", "cutlass"), for naming what a pack holds. */
  paintsByLine: Map<string, { name: string; short: string }[]>;
  /** RSI prices over time per hull, archive included (*last at RSI*, *lowest on record*). */
  history: PriceHistory;
  /** Store paints last seen on sale. */
  paintSeen: PaintSeen;
  /** Your RSI buyback, by what it would give back (`buybackIndex`). */
  buyback: Map<string, BuybackHit>;
}
/** Extra context for `priceCtx`: everything optional (tests and a fresh install have none of it). */
export interface PriceExtras {
  history?: PriceHistory;
  paintSeen?: PaintSeen;
  buyback?: BuybackItem[];
}
const PACKISH = /\b(pack|packs|collection|bundle|set)\b/i;
/** RSI paint names are "<Line> - <Name> Paint" ("Dragonfly - Coalfire Paint"): → line, short name ("coalfire"). */
export function paintParts(name: string): { line: string; short: string } | null {
  const m = /^(.+?)\s+-\s+(.+?)$/.exec(name.trim());
  if (!m) return null;
  const short = m[2]!.replace(/\s+(paint|livery|skin)$/i, '').trim();
  return short ? { line: lineKey(m[1]!), short } : null;
}
/** "Drake Cutlass" / "100 Series" / "100i" → a comparable line key. */
const lineKey = (s: string) => {
  const k = s.toLowerCase().replace(/^(drake|anvil|aegis|origin|rsi|misc|crusader|argo|consolidated outland|kruger|tumbril|greycat|banu|esperia|gatac|mirai|aopoa)\s+/, '').trim();
  const n = /^(\d)\d\d[a-z]?\b/.exec(k);
  return n ? `${n[1]}00 series` : k;
};
export const priceCtx = (ships: CatalogShip[], paints: StorePaint[], extra: PriceExtras = {}): PriceCtx => {
  const paintsByLine = new Map<string, { name: string; short: string }[]>();
  for (const p of paints) {
    if (PACKISH.test(p.name)) continue;
    const parts = paintParts(p.name);
    if (!parts) continue;
    const list = paintsByLine.get(parts.line) ?? [];
    if (!list.some((x) => x.short.toLowerCase() === parts.short.toLowerCase())) list.push({ name: p.name, short: parts.short });
    paintsByLine.set(parts.line, list);
  }
  return {
    ships,
    byId: new Map(ships.map((s) => [s.id, s])),
    paints: new Map(paints.map((p) => [paintKey(p.name), p])),
    paintsByLine,
    history: extra.history ?? {},
    paintSeen: extra.paintSeen ?? {},
    buyback: buybackIndex(extra.buyback ?? [], ships),
  };
};

/* ---------------------------------------------------------------- RSI status, deals, buyback ---------------------------------------------------------------- */

/** An entry of your RSI buyback giving back the same thing; `cents` = its buy-back price when its page was read. */
export interface BuybackHit {
  id: number;
  name: string;
  cents: number | null;
  url: string | null;
}
/**
 * Buyback entries by what they give back: `ccu:<from>-<to>` (an upgrade), `ship:<id>` (a pledge of one hull and
 * nothing else that counts), `paint:<paintKey>` (a paint alone). The cheapest known price wins a key.
 */
export function buybackIndex(items: BuybackItem[], ships: CatalogShip[]): Map<string, BuybackHit> {
  const out = new Map<string, BuybackHit>();
  const put = (key: string, b: BuybackItem) => {
    const hit: BuybackHit = { id: b.id, name: cleanName(b.name), cents: b.price ?? null, url: b.url };
    const cur = out.get(key);
    if (!cur || (hit.cents != null && (cur.cents == null || hit.cents < cur.cents))) out.set(key, hit);
  };
  for (const b of items) {
    if (b.upgrade?.fromId != null && b.upgrade.toId != null) put(`ccu:${b.upgrade.fromId}-${b.upgrade.toId}`, b);
    else if (b.type === 'paint') put(`paint:${paintKey(cleanName(b.name))}`, b);
    else if (b.type === 'ship' && ships.length) {
      const hulls = (b.items ?? []).filter((i) => /ship|vehicle/i.test(i.kind));
      if (hulls.length > 1) continue;
      const s = matchShip(hulls[0]?.title ?? cleanName(b.name), ships);
      if (s) put(`ship:${s.id}`, b);
    }
  }
  return out;
}
export function buybackFor(p: ImpProduct, info: SkuInfo, ctx: PriceCtx): BuybackHit | null {
  if (!ctx.buyback.size) return null;
  if (info.kind === 'ccu' && info.from != null) return ctx.buyback.get(`ccu:${info.from}-${info.ships[0]}`) ?? null;
  if (info.kind === 'ship') return ctx.buyback.get(`ship:${info.ships[0]}`) ?? null;
  if (info.kind === 'paint' || /^paint$/i.test(p.type)) return ctx.buyback.get(`paint:${paintKey(bareTitle(p.title))}`) ?? null;
  return null;
}

/** Whether RSI sells it today, and when it last did (with the price then) when it doesn't. */
export interface RsiStatus {
  /** true: on RSI's store today · false: not · null: RSI+ can't tell (gear, other, no catalog yet). */
  sold: boolean | null;
  last?: { at: number; cents: number; what: string; archived: boolean };
}
const liveSku = (k: { available: boolean; stock?: number | null }) => k.available && k.stock !== 0;
const shipSold = (s: CatalogShip) => s.standalone.some(liveSku) || s.ccu.some(liveSku);
const SHIP_KINDS: PriceKind[] = ['ship', 'ship-wb', 'ccu', 'ccu-wb'];
const CCU_KINDS: PriceKind[] = ['ccu', 'ccu-wb'];
const seenAt = (r: { kind: PriceKind; to: number; p: number; src?: string }, cents = r.p) => ({ at: r.to, cents, what: PRICE_KIND_LABEL[r.kind], archived: !!r.src });

export function rsiStatus(p: ImpProduct, info: SkuInfo, ctx: PriceCtx): RsiStatus {
  if (!ctx.ships.length) return { sold: null };
  if (info.kind === 'ccu' && info.from != null) {
    const to = ctx.byId.get(info.ships[0]!);
    const from = ctx.byId.get(info.from);
    if (!to) return { sold: false };
    if (to.ccu.some(liveSku)) return { sold: true };
    const r = lastSeen(ctx.history, to.id, CCU_KINDS);
    // A CCU's price is the target's value: what this upgrade cost then is that minus the from ship's MSRP.
    return { sold: false, ...(r && from?.msrp && r.p > from.msrp ? { last: { ...seenAt(r, r.p - from.msrp), what: `${PRICE_KIND_LABEL[r.kind]} to ${to.name}` } } : {}) };
  }
  if (info.kind === 'ship') {
    const s = ctx.byId.get(info.ships[0]!);
    if (!s) return { sold: false };
    if (shipSold(s)) return { sold: true };
    const r = lastSeen(ctx.history, s.id, SHIP_KINDS);
    return { sold: false, ...(r ? { last: seenAt(r) } : {}) };
  }
  if (info.kind === 'pack') {
    const ships = info.ships.map((id) => ctx.byId.get(id));
    return { sold: ships.every((s) => !!s && shipSold(s)) };
  }
  if (info.kind === 'paint' || /^paint$/i.test(p.type)) {
    if (!ctx.paints.size) return { sold: null };
    const key = paintKey(bareTitle(p.title));
    if (ctx.paints.get(key)?.available) return { sold: true };
    const seen = ctx.paintSeen[key];
    return { sold: false, ...(seen ? { last: { at: seen.at, cents: seen.p, what: 'Store paint', archived: false } } : {}) };
  }
  return { sold: null };
}

/**
 * Deal tiers: `best` — under the lowest price RSI ever asked on record (archive + RSI+'s readings; warbond included);
 * `below` — under what RSI charges today. Null: neither, or nothing to compare.
 */
export type DealTier = 'best' | 'below';
export function dealOf(info: SkuInfo, price: number, mk: { cents: number; pct: number } | null, ctx: PriceCtx): { tier: DealTier; note: string } | null {
  let low: { cents: number; what: string; at: number } | null = null;
  if (info.kind === 'ship') {
    const r = lowestSeen(ctx.history, info.ships[0]!, ['ship', 'ship-wb', 'msrp']);
    if (r) low = { cents: r.p, what: PRICE_KIND_LABEL[r.kind], at: r.to };
  } else if (info.kind === 'ccu' && info.from != null) {
    const from = ctx.byId.get(info.from);
    const r = lowestSeen(ctx.history, info.ships[0]!, CCU_KINDS);
    if (r && from?.msrp && r.p > from.msrp) low = { cents: r.p - from.msrp, what: PRICE_KIND_LABEL[r.kind], at: r.to };
  }
  if (low && price < low.cents) return { tier: 'best', note: `under RSI's lowest on record (${usdPlain(low.cents)}, ${low.what}, ${new Date(low.at).getFullYear()})` };
  if (mk && mk.cents < 0) return { tier: 'below', note: `${usdPlain(-mk.cents)} under RSI today` };
  return null;
}

/** Paints for your hulls that RSI doesn't sell, that you don't own: the *Gaps* preset. */
export const GAPS_FILTER: Partial<ImpFilter> = { myPaints: true, hideOwned: true, notOnRsi: true, onlyOwned: false };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * Paints a listing holds, by name: RSI's single paints of the listing's ship line(s) whose name the title or
 * description mentions ("…includes all five 100 Series paints: Flame, Blue Ametrine, …"). Empty when it can't tell.
 */
export function paintsIn(p: ImpProduct, ctx: PriceCtx, lines: string[]): { name: string; short: string }[] {
  const hay = ` ${p.title} ${p.text ?? ''} `.toLowerCase();
  const out: { name: string; short: string }[] = [];
  for (const l of new Set(lines.map(lineKey))) {
    for (const c of ctx.paintsByLine.get(l) ?? []) {
      if (out.some((o) => o.name === c.name)) continue;
      if (new RegExp(`[^a-z0-9]${escapeRe(c.short.toLowerCase())}[^a-z0-9]`).test(hay)) out.push(c);
    }
  }
  return out;
}

/** What's inside a multi-item listing, and how much of it you have: ships of a pack (by id) plus the paints it names. */
/** One piece of a pack: RSI's picture and price for it alone, when RSI sells it (paint) or lists it (hull, MSRP). */
export interface ContentItem {
  name: string;
  have: boolean;
  ship?: true;
  thumb?: string | null;
  /** RSI price alone (cents): store paint price, or the hull's cheapest on-sale SKU else MSRP; null = RSI doesn't price it. */
  cents?: number | null;
  /** RSI sells it alone today. */
  sold?: boolean;
}
export interface Contents {
  items: ContentItem[];
  have: number;
  of: number;
  /** Items the title counts but RSI+ couldn't name (retired paints): never counted as had. */
  unknown?: number;
}
export function contentsOf(p: ImpProduct, v: ImpVariant, ctx: PriceCtx, own: OwnCtx): Contents | null {
  const info = parseSku(v.sku);
  const items: ContentItem[] = [];
  const lines: string[] = [];
  if (info.kind === 'ship' || info.kind === 'pack') {
    for (const id of new Set(info.ships)) {
      const s = ctx.byId.get(id);
      const sale = s ? cheapest(s.standalone) : null;
      items.push({ name: s?.name ?? `ship ${id}`, have: own.hulls.has(id), ship: true, thumb: s?.thumb ?? null, cents: sale ?? (s?.msrp || null), sold: !!s && (s.standalone.some((k) => k.available) || s.ccu.some((k) => k.available)) });
      if (s) lines.push(s.name, s.name.split(' ')[0]!);
    }
  } else if (info.kind === 'paint' || /^paint$/i.test(p.type)) {
    const line = /^(.+?)\s+-\s+/.exec(p.title)?.[1];
    if (line) lines.push(line);
  } else return null;
  // Ship listings name paints only when they come with one ("400i + Meridian and Penumbra Paints").
  if (info.kind !== 'paint' && !/\bpaints?\b/i.test(p.title)) lines.length = 0;
  for (const c of paintsIn(p, ctx, lines)) {
    const sp = ctx.paints.get(paintKey(c.name));
    items.push({ name: c.name, have: ownedTitleCount(own.titles, c.name) > 0, thumb: sp?.thumb ?? null, cents: sp ? sp.discounted || sp.price : null, sold: !!sp?.available });
  }
  // "6 Paint Pack": paints RSI no longer sells can't be named, but still count toward the total.
  const stated = Number(/\b(\d{1,2})[ -](?:paint|livery|skin)s?\b/i.exec(p.title)?.[1] ?? 0);
  const paintsFound = items.filter((i) => !i.ship).length;
  const unknown = stated > paintsFound ? stated - paintsFound : 0;
  if (items.length + unknown < 2 || !items.length) return null;
  const have = items.filter((i) => i.have).length;
  return { items, have, of: items.length + unknown, ...(unknown ? { unknown } : {}) };
}

/** `ownership` plus "x/y in your hangar" for multi-item listings (packs, paint packs). */
export function ownershipFull(p: ImpProduct, v: ImpVariant, own: OwnCtx, ctx: PriceCtx): Ownership {
  const o = ownership(p, v, own, ctx.byId);
  // An exact match (the pledge title, this upgrade) is enough; a ship you own isn't, when the listing adds paints.
  if (o.owned && !o.partial && parseSku(v.sku).kind !== 'ship') return o;
  const c = contentsOf(p, v, ctx, own);
  if (!c) return o;
  const owned = c.have === c.of;
  const missing = c.items.filter((i) => !i.have).map((i) => i.name);
  return {
    ...o,
    owned: (o.owned && parseSku(v.sku).kind !== 'ship') || owned,
    partial: { have: c.have, of: c.of },
    contents: c.items,
    label: owned
      ? `you have all ${c.of} in your hangar`
      : c.have
        ? `you have ${c.have}/${c.of} in your hangar · missing ${[...missing, ...(c.unknown ? [`${c.unknown} not identified`] : [])].join(', ')}`
        : '',
  };
}

/**
 * Hulls a paint listing is for. By title first, like RSI's paints ("400i - Meridian Paint", "Paints - 890 Jump -
 * Penumbra Paint", "100 Series - …" = the whole series); else the ship id some paint SKUs carry (`P.223.411.L`, 223 =
 * 400i), widened to its family — that id names one variant (600i paints carry the 600i Touring's). Packs that name no
 * ship ("Paints - Auspicious Red Dragon and Dog Paint Pack") → none.
 */
export function paintShips(p: ImpProduct, ctx: PriceCtx): CatalogShip[] {
  if (!ctx.ships.length) return [];
  const title = bareTitle(p.title).replace(/^paints?\s*[-–—:]\s*/i, '');
  if (/\s[-–—:]\s/.test(title)) {
    const hit = shipsFor(title, ctx.ships);
    if (hit.length) return hit;
  }
  const id = Number(/^p\.(\d+)\.\d+/i.exec(p.variants[0]?.sku ?? '')?.[1] ?? NaN);
  const s = ctx.byId.get(id);
  if (!s) return [];
  const fam = line(s.name, ctx.ships);
  return ctx.ships.filter((x) => line(x.name, ctx.ships) === fam);
}
const ownedIdsMemo = new WeakMap<Map<number, OwnedShip>, Set<number>>();
const ownedIdsOf = (hulls: Map<number, OwnedShip>) => {
  let ids = ownedIdsMemo.get(hulls);
  if (!ids) ownedIdsMemo.set(hulls, (ids = ownedShipIds([...hulls.values()].map((o) => o.ship))));
  return ids;
};
/** A paint listing for a hull you own (pledged or in-game). */
export const paintFitsOwned = (p: ImpProduct, ctx: PriceCtx, own: OwnCtx) => {
  const ids = ownedIdsOf(own.hulls);
  return ids.size > 0 && paintShips(p, ctx).some((s) => ids.has(s.id));
};

/** Strip the store's listing words so a paint title can meet RSI's: "100 Series - Melrose Paint - Imperator" stays, " - LTI" etc. go. */
const bareTitle = (t: string) => t.replace(/\s*-\s*(standalone (ship|vehicle)|original concept lti|lti)\s*$/i, '').trim();

/** What RSI charges for one variant of a listing. */
export function rsiPrice(p: ImpProduct, v: ImpVariant, ctx: PriceCtx): RsiPrice {
  const info = parseSku(v.sku);
  if (info.kind === 'ccu' && info.from != null) {
    const from = ctx.byId.get(info.from);
    const to = ctx.byId.get(info.ships[0]!);
    if (!from?.msrp || !to?.msrp || to.msrp <= from.msrp) return NONE;
    const sale = cheapest(to.ccu);
    const diff = to.msrp - from.msrp;
    if (sale != null && sale - from.msrp > 0 && sale - from.msrp < diff)
      return { cents: sale - from.msrp, basis: `RSI upgrade ${from.name} → ${to.name} on sale now (standard ${usdPlain(diff)})`, onSale: true };
    return { cents: diff, basis: `RSI upgrade ${from.name} → ${to.name}: MSRP ${usdPlain(to.msrp)} − ${usdPlain(from.msrp)}${sale != null ? ', on sale now' : ''}`, onSale: sale != null };
  }
  if (info.kind === 'ship' || info.kind === 'pack') {
    const ships = info.ships.map((id) => ctx.byId.get(id));
    if (ships.some((s) => !s?.msrp)) return NONE;
    if (info.kind === 'ship') {
      const s = ships[0]!;
      const sale = cheapest(s.standalone);
      if (sale != null) return { cents: sale, basis: `RSI standalone ${s.name} on sale now${s.msrp !== sale ? ` (MSRP ${usdPlain(s.msrp)})` : ''}`, onSale: true };
      return { cents: s.msrp, basis: `RSI MSRP ${s.name} (not sold standalone right now)`, onSale: false };
    }
    const sum = ships.reduce((a, s) => a + s!.msrp, 0);
    return { cents: sum, basis: `Sum of RSI MSRP: ${ships.map((s) => `${s!.name} ${usdPlain(s!.msrp)}`).join(' + ')} (extras not counted)`, onSale: false };
  }
  if (info.kind === 'paint' || /^paint$/i.test(p.type)) {
    const sp = ctx.paints.get(paintKey(bareTitle(p.title)));
    if (sp) return { cents: sp.discounted || sp.price, basis: `RSI store: ${sp.name}${sp.available ? '' : ' (not on sale right now)'}`, onSale: sp.available };
  }
  return NONE;
}
const usdPlain = (c: number) => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;

/** Markup of an Impound price over RSI's: cents and fraction (0.25 = 25 % more), null without an RSI price. */
export function markup(impound: number, rsi: RsiPrice): { cents: number; pct: number } | null {
  if (rsi.cents == null || rsi.cents <= 0) return null;
  return { cents: impound - rsi.cents, pct: (impound - rsi.cents) / rsi.cents };
}

/* ---------------------------------------------------------------- ownership ---------------------------------------------------------------- */

export interface OwnCtx {
  hulls: Map<number, OwnedShip>;
  ccus: OwnedCcu[];
  titles: OwnedTitles;
  /** Pledge title or item title (`paintKey`) → the cheapest pledge holding it (what you paid, USD cents). */
  paid?: Map<string, PaidFor>;
}
export interface PaidFor {
  cents: number;
  /** The pledge it came in. */
  pledge: string;
  /** The pledge holds more than this (a pack): the price is the whole pack's. */
  pack: boolean;
}

/**
 * What you paid per title: every pledge's own name and the titles inside it, keeping the cheapest pledge with a melt
 * value (0 = gifted / earned: skipped). Feeds `ownership().paid` for listings RSI+ can't price against RSI.
 */
export function paidByTitle(pledges: { name: string; value: number; items: { title: string }[]; ships: string[] }[]): Map<string, PaidFor> {
  const out = new Map<string, PaidFor>();
  for (const p of pledges) {
    if (!(p.value > 0)) continue;
    const titles = [p.name, ...p.items.map((i) => i.title)];
    const pack = p.items.length > 1 || p.ships.length > 1;
    for (const t of new Set(titles.map(paintKey))) {
      const cur = out.get(t);
      const c = Math.round(p.value * 100);
      // A pledge of just this item beats a pack; then the cheaper one.
      if (!cur || (cur.pack && !pack) || (cur.pack === pack && c < cur.cents)) out.set(t, { cents: c, pledge: p.name, pack });
    }
  }
  return out;
}
export interface Ownership {
  /** You already have it: the ship(s), this exact upgrade, or a pledge / item with this title. */
  owned: boolean;
  /** Copies (ships: hull copies; upgrades: CCUs from → to; titles: pledges). */
  count: number;
  /** Upgrade only: you own the ship it upgrades from (so you could apply it). */
  haveFrom: boolean;
  /** Upgrade only: you already own the target ship. */
  haveTo: boolean;
  /** Packs: how many of the ships inside you own. */
  partial?: { have: number; of: number };
  label: string;
  /** What you paid for the one you own (hangar melt value), when RSI+ can tell. */
  paid?: PaidFor;
  /** Multi-item listings: each thing inside and whether you have it. */
  contents?: ContentItem[];
}

export function ownership(p: ImpProduct, v: ImpVariant, own: OwnCtx, byId: Map<number, CatalogShip>): Ownership {
  const info = parseSku(v.sku);
  const name = (id: number) => byId.get(id)?.name ?? `ship ${id}`;
  if (info.kind === 'ccu' && info.from != null) {
    const to = info.ships[0]!;
    const mine = own.ccus.filter((c) => c.fromId === info.from && c.toId === to && c.source === 'hangar');
    const n = mine.length;
    const values = mine.map((c) => c.value).filter((v) => v > 0);
    const paid: PaidFor | undefined = values.length ? { cents: Math.min(...values), pledge: `Upgrade - ${name(info.from)} to ${name(to)}`, pack: false } : undefined;
    const haveFrom = own.hulls.has(info.from);
    const haveTo = own.hulls.has(to);
    const bits = [n ? `you own this upgrade${n > 1 ? ` ×${n}` : ''}` : '', haveTo ? `you own the ${name(to)}` : '', haveFrom ? `you have a ${name(info.from)} to apply it to` : ''].filter(Boolean);
    return { owned: n > 0, count: n, haveFrom, haveTo, label: bits.join(' · '), ...(paid ? { paid } : {}) };
  }
  if (info.kind === 'ship' || info.kind === 'pack') {
    const have = info.ships.filter((id) => own.hulls.has(id));
    if (info.kind === 'ship') {
      const o = own.hulls.get(info.ships[0]!);
      const paid = o ? shipPaid(o) : undefined;
      return { owned: !!o, count: o?.count ?? 0, haveFrom: false, haveTo: false, label: o ? `you own ${o.count > 1 ? `${o.count}× ` : ''}${o.ship.name}${o.lti ? ' (LTI)' : ''}` : '', ...(paid ? { paid } : {}) };
    }
    const uniq = [...new Set(info.ships)];
    const haveU = uniq.filter((id) => own.hulls.has(id));
    return {
      owned: haveU.length === uniq.length,
      count: have.length,
      haveFrom: false,
      haveTo: false,
      partial: { have: haveU.length, of: uniq.length },
      label: haveU.length ? `you own ${haveU.length} of ${uniq.length}: ${haveU.map(name).join(', ')}` : '',
    };
  }
  const n = ownedTitleCount(own.titles, bareTitle(p.title)) || ownedTitleCount(own.titles, p.title);
  const paid = n ? (own.paid?.get(paintKey(bareTitle(p.title))) ?? own.paid?.get(paintKey(p.title))) : undefined;
  return { owned: n > 0, count: n, haveFrom: false, haveTo: false, label: n ? `in your hangar${n > 1 ? ` ×${n}` : ''}` : '', ...(paid ? { paid } : {}) };
}

/** What you paid for a hull: a pledge of that ship alone (cheapest), else the cheapest pack holding it. */
function shipPaid(o: OwnedShip): PaidFor | undefined {
  const ps = o.items.flatMap((r) => r.pledges).filter((p) => p.value > 0);
  if (!ps.length) return undefined;
  const solo = ps.filter((p) => p.type === 'ship');
  const best = (solo.length ? solo : ps).reduce((a, b) => (b.value < a.value ? b : a));
  return { cents: Math.round(best.value * 100), pledge: best.name, pack: !solo.length };
}

/** "paid $40" / "paid $165 (in Pirate Pack)" for a card. */
export const paidLabel = (p: PaidFor, money: (c: number) => string) => `you paid ${money(p.cents)}${p.pack ? ` (in ${p.pledge})` : ''}`;

/* ---------------------------------------------------------------- rows, filters, sort ---------------------------------------------------------------- */

export interface ImpRow {
  product: ImpProduct;
  /** The variant shown: the cheapest in stock (or cheapest at all). */
  variant: ImpVariant;
  kind: SkuKind;
  info: SkuInfo;
  rsi: RsiPrice;
  markup: { cents: number; pct: number } | null;
  own: Ownership;
  available: boolean;
  /** Paint listing for a hull you own (`paintFitsOwned`); false for everything else. */
  fitsMine: boolean;
  status: RsiStatus;
  deal: { tier: DealTier; note: string } | null;
  buyback: BuybackHit | null;
}

/** The variant a row stands for: cheapest in stock, else cheapest. Upgrades: the cheapest you can apply (own the from ship) first. */
export function pickVariant(p: ImpProduct, own?: OwnCtx): ImpVariant | null {
  if (!p.variants.length) return null;
  const by = (list: ImpVariant[]) => [...list].sort((a, b) => a.price - b.price)[0];
  const live = p.variants.filter((v) => v.available);
  if (own) {
    const usable = live.filter((v) => {
      const i = parseSku(v.sku);
      return i.kind === 'ccu' && i.from != null && own.hulls.has(i.from);
    });
    if (usable.length) return by(usable)!;
  }
  return by(live.length ? live : p.variants)!;
}

export function rowOf(p: ImpProduct, ctx: PriceCtx, own: OwnCtx, v = pickVariant(p, own)): ImpRow | null {
  if (!v) return null;
  const rsi = rsiPrice(p, v, ctx);
  const info = parseSku(v.sku);
  const mk = markup(v.price, rsi);
  return {
    product: p,
    variant: v,
    kind: kindOf(p),
    info,
    rsi,
    markup: mk,
    own: ownershipFull(p, v, own, ctx),
    available: p.variants.some((x) => x.available),
    fitsMine: kindOf(p) === 'paint' && paintFitsOwned(p, ctx, own),
    status: rsiStatus(p, info, ctx),
    deal: dealOf(info, v.price, mk, ctx),
    buyback: buybackFor(p, info, ctx),
  };
}

export interface ImpFilter {
  q: string;
  kinds: SkuKind[];
  /** Hide what you already own. */
  hideOwned: boolean;
  /** Only what you own (or own part of / own the from-ship of). */
  onlyOwned: boolean;
  /** Upgrades you can apply: you own the ship it upgrades from. */
  canApply: boolean;
  /** Paints for hulls you own. */
  myPaints: boolean;
  /** Not on RSI's store today (`RsiStatus.sold === false`). */
  notOnRsi: boolean;
  /** Under RSI's price today or its lowest on record (`dealOf`). */
  deals: boolean;
  /** Something your RSI buyback gives back too. */
  inBuyback: boolean;
  inStock: boolean;
  lti: boolean;
  /** Only listings with an RSI price to compare. */
  priced: boolean;
  /** Only listings RSI+ has no RSI price for (the opposite of `priced`). */
  unpriced: boolean;
  /** Markup at most this fraction (0 = at or below RSI); null = any. */
  maxMarkup: number | null;
  minPrice: number | null;
  maxPrice: number | null;
}
export const NO_IMP_FILTER: ImpFilter = { q: '', kinds: [], hideOwned: false, onlyOwned: false, canApply: false, myPaints: false, notOnRsi: false, deals: false, inBuyback: false, unpriced: false, inStock: false, lti: false, priced: false, maxMarkup: null, minPrice: null, maxPrice: null };

/** Search words: every word must be in the title, vendor, type or tags; `-word` excludes. */
export function matchesQuery(p: ImpProduct, q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${p.title} ${p.vendor} ${p.type} ${p.tags.join(' ')}`.toLowerCase();
  return words.every((w) => (w.startsWith('-') && w.length > 1 ? !hay.includes(w.slice(1)) : hay.includes(w)));
}

export function filterRows(rows: ImpRow[], f: ImpFilter): ImpRow[] {
  return rows.filter(
    (r) =>
      matchesQuery(r.product, f.q) &&
      (!f.kinds.length || f.kinds.includes(r.kind)) &&
      (!f.hideOwned || !r.own.owned) &&
      (!f.onlyOwned || r.own.owned || !!r.own.partial?.have || r.own.haveFrom) &&
      (!f.canApply || (r.kind === 'ccu' && r.own.haveFrom)) &&
      (!f.myPaints || r.fitsMine) &&
      (!f.notOnRsi || r.status.sold === false) &&
      (!f.deals || !!r.deal) &&
      (!f.inBuyback || !!r.buyback) &&
      (!f.inStock || r.available) &&
      (!f.lti || r.product.variants.some((v) => parseSku(v.sku).insurance === 'lti') || /\bLTI\b/.test(r.product.title)) &&
      (!f.priced || r.rsi.cents != null) &&
      (!f.unpriced || r.rsi.cents == null) &&
      (f.maxMarkup == null || (r.markup != null && r.markup.pct <= f.maxMarkup)) &&
      (f.minPrice == null || r.variant.price >= f.minPrice) &&
      (f.maxPrice == null || r.variant.price <= f.maxPrice),
  );
}

export type ImpSort = 'store' | 'price' | 'price-desc' | 'markup' | 'markup-desc' | 'markup-pct' | 'title';
export const IMP_SORTS: { id: ImpSort; label: string }[] = [
  { id: 'store', label: 'Store order' },
  { id: 'price', label: 'Price, low to high' },
  { id: 'price-desc', label: 'Price, high to low' },
  { id: 'markup-pct', label: 'Markup %, lowest first' },
  { id: 'markup', label: 'Markup $, lowest first' },
  { id: 'markup-desc', label: 'Markup $, highest first' },
  { id: 'title', label: 'Name' },
];
/** Sorted copy; rows without an RSI price go last for the markup sorts. */
export function sortRows(rows: ImpRow[], s: ImpSort): ImpRow[] {
  if (s === 'store') return rows;
  const mk = (r: ImpRow, k: 'cents' | 'pct', dir: 1 | -1) => (r.markup ? r.markup[k] * dir : Infinity);
  const cmp: Record<Exclude<ImpSort, 'store'>, (a: ImpRow, b: ImpRow) => number> = {
    price: (a, b) => a.variant.price - b.variant.price,
    'price-desc': (a, b) => b.variant.price - a.variant.price,
    markup: (a, b) => mk(a, 'cents', 1) - mk(b, 'cents', 1),
    'markup-desc': (a, b) => mk(a, 'cents', -1) - mk(b, 'cents', -1),
    'markup-pct': (a, b) => mk(a, 'pct', 1) - mk(b, 'pct', 1),
    title: (a, b) => a.product.title.localeCompare(b.product.title),
  };
  return [...rows].sort((a, b) => cmp[s](a, b) || a.product.title.localeCompare(b.product.title));
}

/* ---------------------------------------------------------------- page parsing ---------------------------------------------------------------- */

/** `/products/x`, `/collections/c/products/x` → handle; null elsewhere. */
export function handleFromUrl(href: string): string | null {
  const m = /\/products\/([^/?#]+)/.exec(href);
  return m ? decodeURIComponent(m[1]!) : null;
}
export type ImpPage = 'product' | 'collection' | 'search' | 'other';
export function pageOf(pathname: string): ImpPage {
  if (/\/products\/[^/]+\/?$/.test(pathname)) return 'product';
  if (/^\/collections\/[^/]+\/?$/.test(pathname)) return 'collection';
  if (/^\/search\/?$/.test(pathname)) return 'search';
  return 'other';
}
export const collectionOf = (pathname: string) => /^\/collections\/([^/]+)/.exec(pathname)?.[1] ?? null;

/**
 * A product page's own data, from Shopify's analytics `var meta = {…}` (variants with SKU and price in cents) and the
 * JSON-LD offers (stock per SKU). No request: both are inline scripts of the page.
 */
export function productFromPage(doc: Document, handle: string): ImpProduct | null {
  let meta: any = null;
  for (const s of doc.querySelectorAll('script:not([src])')) {
    const t = s.textContent ?? '';
    const i = t.indexOf('var meta = ');
    if (i < 0) continue;
    const start = i + 'var meta = '.length;
    const end = t.indexOf('};', start);
    try {
      meta = JSON.parse(t.slice(start, end + 1));
    } catch {}
    break;
  }
  const mp = meta?.product;
  if (!mp?.variants?.length) return null;
  const stock = new Map<string, boolean>();
  let name = '';
  let ldDesc = '';
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const j = JSON.parse(s.textContent ?? '');
      if (j?.['@type'] !== 'Product') continue;
      name = j.name ?? name;
      ldDesc = typeof j.description === 'string' ? j.description : ldDesc;
      for (const o of j.offers ?? []) if (o?.sku) stock.set(String(o.sku), !/OutOfStock|SoldOut/i.test(String(o.availability)));
    } catch {}
  }
  const title = name || doc.querySelector('.product-single__title')?.textContent?.trim() || mp.variants[0]?.name?.split(' - ')[0] || handle;
  const desc = doc.querySelector('.product-single__description, .product__description, [class*="product-description"]');
  const text = descText(desc?.innerHTML ?? ldDesc);
  const og = doc.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.content;
  const image = imageOf({ featured_image: og });
  return {
    handle: mp.handle ?? handle,
    title,
    ...(image ? { image } : {}),
    type: String(mp.type ?? ''),
    vendor: String(mp.vendor ?? ''),
    tags: [],
    ...(text ? { text } : {}),
    variants: mp.variants.map((v: any) => ({
      id: Number(v.id),
      title: String(v.public_title ?? v.name ?? ''),
      sku: String(v.sku ?? ''),
      price: Number(v.price) || 0,
      compareAt: null,
      available: stock.get(String(v.sku)) ?? true,
    })),
  };
}

/* ---------------------------------------------------------------- cache ---------------------------------------------------------------- */

/** Products seen (public data), by handle, with when they were read; old entries are refetched. */
export interface ImpCache {
  [handle: string]: { at: number; p: ImpProduct };
}
export const IMP_TTL = 6 * 3600_000;
export const IMP_MAX = 4000;
export function putProducts(cache: ImpCache, list: ImpProduct[], now: number): ImpCache {
  const next = { ...cache };
  for (const p of list) next[p.handle] = { at: now, p };
  const keys = Object.keys(next);
  if (keys.length > IMP_MAX) for (const k of keys.sort((a, b) => next[a]!.at - next[b]!.at).slice(0, keys.length - IMP_MAX)) delete next[k];
  return next;
}
export const fresh = (cache: ImpCache, handle: string, now: number) => {
  const e = cache[handle];
  return e && now - e.at < IMP_TTL ? e.p : null;
};
