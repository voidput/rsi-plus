/**
 * Shared page UI for the grey-market store integrations (The Impound): the RSI price / markup / owned
 * badge, the filter + sort toolbar over a listing grid, and hiding / reordering cards. Each content script is its own
 * bundle, so the module state below is per site: `configureMarket` sets it once.
 */
import { GAPS_FILTER, IMP_SORTS, KIND_LABEL, NO_IMP_FILTER, filterRows, paidLabel, sizedImage, sortRows, type ContentItem, type ImpFilter, type ImpRow, type ImpSort, type SkuKind } from './impound';
import { fmtGrouped } from '@/lib/fmt';

export interface MarketView {
  f: ImpFilter;
  sort: ImpSort;
  /** Cards for things you own: dimmed (true) or left as the store draws them. */
  dimOwned: boolean;
}
export const market = {
  /** Store name in tooltips ("The Impound: $20.99"). */
  store: '',
  view: { f: { ...NO_IMP_FILTER }, sort: 'store', dimOwned: true } as MarketView,
  hasHangar: false,
  save: () => {},
  schedule: () => {},
  /** Toggles this store can't support (no stock data …): left out of the toolbar. */
  hide: [] as (keyof ImpFilter)[],
  /** Opens the every-page table (Enter in the toolbar search); none = the page only. */
  searchAll: null as null | (() => void),
  /** Called after any toolbar / table filter change (the open table re-renders). */
  onChange: new Set<() => void>(),
};
/** A filter, sort or dim changed: save, update every chip, repaint the grid, tell the open table. */
export function viewChanged() {
  market.save();
  syncToolbar();
  market.schedule();
  for (const f of market.onChange) f();
}
export function configureMarket(c: Partial<typeof market>) {
  Object.assign(market, c);
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.className = cls;
  if (text != null) n.textContent = text;
  if (n instanceof HTMLButtonElement) n.type = 'button';
  return n;
}
export const money = (c: number) => `$${fmtGrouped(c / 100, { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
export const signed = (c: number) => `${c < 0 ? '−' : '+'}${money(Math.abs(c))}`;
export const pct = (p: number) => `${p < 0 ? '−' : '+'}${Math.round(Math.abs(p) * 100)}%`;
/** Markup tone: below RSI (good), up to 25 % over, more. */
export const tone = (m: { pct: number } | null) => (!m ? 'na' : m.pct <= 0 ? 'good' : m.pct <= 0.25 ? 'mid' : 'high');

const monthYear = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
/** "Not on RSI now · last Jun 2026, $125 (Warbond CCU)" — or "never seen there" — for cards, the table and product pages. */
export function rsiStatusText(r: Pick<ImpRow, 'status'>, compact = false): { text: string; tip: string } | null {
  const st = r.status;
  if (st.sold !== false) return null;
  const l = st.last;
  if (compact) return { text: 'not on RSI', tip: l ? `Last at RSI ${monthYear(l.at)}, ${money(l.cents)} (${l.what})` : 'RSI+ never saw RSI sell it' };
  return {
    text: l ? `Not on RSI now · last ${monthYear(l.at)}, ${money(l.cents)}` : 'Not on RSI now · never seen there',
    tip: l
      ? `RSI's store doesn't sell it today. Last seen there ${new Date(l.at).toLocaleDateString()} at ${money(l.cents)} (${l.what}${l.archived ? ', from the price archive' : ''}).`
      : "RSI's store doesn't sell it today, and RSI+ never saw it there (its readings start when you installed RSI+; ships also have the price archive).",
  };
}
/** Deal / not-on-RSI / buyback lines (cards, product page). */
export function extras(box: HTMLElement, r: ImpRow, compact = false) {
  if (r.deal) {
    const d = el('span', `rp-imp-deal ${r.deal.tier}`, r.deal.tier === 'best' ? (compact ? '★ deal' : "★ Best deal: under RSI's lowest") : compact ? 'deal' : 'Deal: under RSI today');
    d.title = `${market.store}: ${money(r.variant.price)}, ${r.deal.note}`;
    box.append(d);
  }
  const st = rsiStatusText(r, compact);
  if (st) box.append(Object.assign(el('span', 'rp-imp-gone', st.text), { title: st.tip }));
  if (r.buyback && !compact) {
    const cheaper = r.buyback.cents != null && r.buyback.cents < r.variant.price;
    const b = el('span', `rp-imp-bb ${cheaper ? 'good' : ''}`, `In your buyback${r.buyback.cents != null ? `: ${money(r.buyback.cents)}${cheaper ? ` (${money(r.variant.price - r.buyback.cents)} less)` : ''}` : ''}`);
    b.title = `${r.buyback.name} (#${r.buyback.id}) in your RSI buyback${r.buyback.cents == null ? ' — open it in the RSI+ hub (Buyback) to read its price' : ''}. Buy-backs take store credit; a buy-back token may be needed.`;
    box.append(b);
  }
}

/* ---------------------------------------------------------------- pictures ---------------------------------------------------------------- */

/**
 * A small picture with a big preview on hover (one shared preview box, positioned by the pointer). `big` defaults to
 * the same URL; Shopify pictures get resized copies (`sizedImage`), RSI's get their `slideshow.jpg` size.
 */
export function thumbEl(src: string | null | undefined, name: string, cls = 'rp-imp-thumb'): HTMLElement {
  if (!src) return el('span', `${cls} none`);
  const shopify = /cdn\.shopify\.com|\/cdn\/shop\//.test(src);
  const img = el('img', cls);
  img.src = shopify ? sizedImage(src, 160) : src;
  img.alt = '';
  img.loading = 'lazy';
  img.dataset.big = shopify ? sizedImage(src, 900) : src.replace(/\/[^/]+\.(jpe?g|png|webp)(\?.*)?$/i, '/slideshow.jpg');
  img.dataset.small = img.src;
  img.dataset.name = name;
  hoverPreview();
  return img;
}
let previewOn = false;
function hoverPreview() {
  if (previewOn) return;
  previewOn = true;
  const box = el('div', 'rp-imp rp-imp-preview');
  const big = el('img', '');
  big.alt = '';
  const cap = el('div', 'rp-imp-muted');
  box.append(big, cap);
  let cur: HTMLImageElement | null = null;
  big.addEventListener('error', () => cur && big.src !== cur.dataset.small && (big.src = cur.dataset.small!));
  const place = (e: PointerEvent) => {
    const w = Math.min(560, innerWidth - 24);
    const left = e.clientX + 20 + w > innerWidth ? Math.max(12, e.clientX - 20 - w) : e.clientX + 20;
    box.style.left = `${left}px`;
    box.style.top = `${Math.max(12, Math.min(e.clientY - 60, innerHeight - box.offsetHeight - 12))}px`;
    box.style.width = `${w}px`;
  };
  document.addEventListener('pointerover', (e) => {
    const t = (e.target as Element | null)?.closest?.<HTMLImageElement>('img.rp-imp-thumb, img.rp-imp-tile-img');
    if (!t || t === cur) return;
    cur = t;
    big.src = t.dataset.big ?? t.src;
    cap.textContent = t.dataset.name ?? '';
    (document.querySelector('.rp-imp-overlay') ?? document.body).append(box);
    place(e as PointerEvent);
  });
  document.addEventListener('pointermove', (e) => cur && place(e));
  document.addEventListener('pointerout', (e) => {
    if (!cur || (e.relatedTarget as Element | null) === cur) return;
    if ((e.target as Element | null) !== cur) return;
    cur = null;
    box.remove();
  });
}

/**
 * What a pack holds, as tiles like the hub's Browse: RSI's picture and price for each piece alone, whether you have it,
 * then *RSI apart* (the pieces RSI prices) against the listing price.
 */
export function contentsTiles(items: ContentItem[], price: number, of = items.length): HTMLElement {
  const wrap = el('div', 'rp-imp rp-imp-pack');
  const priced = items.filter((i) => i.cents != null);
  const apart = priced.reduce((a, i) => a + i.cents!, 0);
  const have = items.filter((i) => i.have).length;
  const head = el('div', 'rp-imp-row rp-imp-muted');
  head.append(el('span', '', `${of} inside · you have ${have}`));
  if (priced.length) {
    const d = apart - price;
    head.append(el('span', '', `RSI apart ${money(apart)}${priced.length < of ? ` (${priced.length} of ${of} priced)` : ''}`), el('span', d > 0 && priced.length === of ? 'good' : '', `${market.store} ${money(price)}${priced.length === of ? (d > 0 ? ` · saves ${money(d)}` : d < 0 ? ` · ${money(-d)} more than apart` : '') : ''}`));
  }
  if (of > items.length) head.append(el('span', '', `${of - items.length} not identified`));
  const grid = el('ul', 'rp-imp-tiles');
  for (const i of items) {
    const li = el('li', `rp-imp-tile ${i.have ? 'have' : ''}`);
    li.append(thumbEl(i.thumb, i.name, 'rp-imp-tile-img'));
    const txt = el('div', '');
    txt.append(el('div', 'rp-imp-tile-name', `${i.have ? '✓ ' : ''}${i.name}`));
    txt.append(el('div', 'rp-imp-muted', i.cents != null ? `RSI ${money(i.cents)}${i.sold ? '' : i.ship ? ' MSRP · not sold now' : ' · not sold now'}` : 'not sold alone at RSI'));
    li.append(txt);
    grid.append(li);
  }
  wrap.append(head, grid);
  return wrap;
}

/** The RSI price / markup line and the owned line for one listing (grid cards and small previews). */
export function badge(box: HTMLElement, r: ImpRow, compact = false) {
  const paid = r.own.paid ? paidLabel(r.own.paid, money) : '';
  if (r.rsi.cents != null && r.markup) {
    const line = el('span', `rp-imp-price ${tone(r.markup)}`, compact ? `RSI ${money(r.rsi.cents)} · ${pct(r.markup.pct)}` : `RSI ${money(r.rsi.cents)} · ${signed(r.markup.cents)} (${pct(r.markup.pct)})`);
    line.title = `${r.rsi.basis}\n${market.store}: ${money(r.variant.price)}${r.variant.title && r.variant.title !== 'Default Title' ? ` (${r.variant.title})` : ''}${paid ? `\n${paid}` : ''}`;
    box.append(line);
  } else if (r.own.owned && r.own.paid) {
    // Nothing at RSI to compare with: what you paid for yours is the useful number.
    const line = el('span', 'rp-imp-price paid', compact ? `paid ${money(r.own.paid.cents)}` : paid);
    line.title = `No RSI price to compare. From your hangar: ${r.own.paid.pledge} (melt value)`;
    box.append(line);
  } else if (!compact) box.append(el('span', 'rp-imp-muted', 'no RSI price to compare'));
  const tip = r.own.contents?.map((c) => `${c.have ? '✓' : '·'} ${c.name}`).join('\n') ?? '';
  let own: HTMLElement | null = null;
  if (r.own.owned) own = el('span', 'rp-imp-own', `✓ ${compact ? (r.own.partial ? `have all ${r.own.partial.of}` : 'owned') : r.own.label || 'owned'}`);
  else if (r.own.partial?.have) own = el('span', 'rp-imp-own part', `◐ ${compact ? `have ${r.own.partial.have}/${r.own.partial.of}` : r.own.label}`);
  else if (r.kind === 'ccu' && (r.own.haveFrom || r.own.haveTo)) own = el('span', `rp-imp-own ${r.own.haveTo ? '' : 'part'}`, r.own.haveTo ? `✓ ${compact ? 'own target' : r.own.label}` : `↑ ${compact ? 'can apply' : r.own.label}`);
  if (own) {
    if (tip) own.title = tip;
    else if (compact && r.own.label) own.title = r.own.label;
    box.append(own);
  }
  extras(box, r, compact);
}

/** Hide cards the filter drops and put the rest in the chosen order (cards RSI+ hasn't read yet stay where they are). */
export function applyView(rows: Map<HTMLElement, ImpRow | null>) {
  const known = [...rows].filter((e): e is [HTMLElement, ImpRow] => !!e[1]);
  const keep = new Set(filterRows(known.map(([, r]) => r), market.view.f));
  let shown = 0;
  for (const [card, r] of rows) {
    const hide = !!r && !keep.has(r);
    card.classList.toggle('rp-imp-hidden', hide);
    if (!hide) shown++;
  }
  const bar = document.querySelector<HTMLElement>('.rp-imp-bar .rp-imp-count');
  if (bar) {
    bar.textContent = `${shown} of ${rows.size} on this page`;
    bar.title = 'Search, filters and sort work on the cards of this page. Search all lists every page in one table.';
  }
  if (market.view.sort === 'store') return restoreOrder([...rows.keys()]);
  const sorted = sortRows(known.map(([, r]) => r), market.view.sort);
  const byHandle = new Map(known.map(([c, r]) => [r.product.handle, c]));
  const parent = known[0]?.[0].parentElement;
  if (!parent) return;
  rememberOrder([...rows.keys()]);
  const want = sorted.map((r) => byHandle.get(r.product.handle)!).filter(Boolean);
  const cur = [...parent.children].filter((c) => want.includes(c as HTMLElement));
  if (cur.every((c, i) => c === want[i])) return;
  placeInOrder(parent, cur[0], want);
}
/**
 * Move `cards` (in order) to where `first` is now. Anchored on a marker, not on `first`: `first` is one of the cards,
 * and inserting it before itself leaves it in place, so it would end up last.
 */
function placeInOrder(parent: Element, first: Element | undefined, cards: HTMLElement[]) {
  const mark = document.createComment('rp-imp');
  parent.insertBefore(mark, first ?? null);
  for (const c of cards) parent.insertBefore(c, mark);
  mark.remove();
}
/**
 * The store's own order, so *Store order* can put the cards back. Numbered on first sight (a running count, not the
 * card's index now): cards a "load more" adds after a sort land at the end, so their index would be wrong.
 */
let seen = 0;
function rememberOrder(cards: HTMLElement[]) {
  for (const c of cards) c.dataset.rpOrder ??= String(seen++);
}
function restoreOrder(cards: HTMLElement[]) {
  const withOrder = cards.filter((c) => c.dataset.rpOrder != null);
  if (!withOrder.length) return;
  const parent = withOrder[0]!.parentElement;
  if (!parent) return;
  const sorted = [...withOrder].sort((a, b) => Number(a.dataset.rpOrder) - Number(b.dataset.rpOrder));
  const cur = [...parent.children].filter((c) => withOrder.includes(c as HTMLElement));
  if (cur.every((c, i) => c === sorted[i])) return;
  placeInOrder(parent, cur[0], sorted);
}

const KINDS: SkuKind[] = ['ship', 'ccu', 'pack', 'paint', 'gear', 'other'];
const TOGGLES: { k: keyof ImpFilter; label: string; tip: string }[] = [
  { k: 'hideOwned', label: 'Hide owned', tip: 'Hide what you already own (ships, upgrades, pledge titles in your RSI+ hangar)' },
  { k: 'onlyOwned', label: 'Owned only', tip: 'Only what you own, own part of, or (upgrades) own the ship it upgrades from' },
  { k: 'canApply', label: 'Upgrades I can apply', tip: 'Upgrades from a ship you own' },
  { k: 'myPaints', label: 'Paints for my ships', tip: 'Paints for a hull you own (pledged or in-game), by the ship the listing names' },
  { k: 'notOnRsi', label: 'Not on RSI', tip: "Listings RSI's store doesn't sell today (with when it last did)" },
  { k: 'deals', label: 'Deals', tip: "Under RSI's price today, or (★) under the lowest price RSI ever asked on record" },
  { k: 'inBuyback', label: 'In my buyback', tip: 'Your RSI buyback gives the same back: compare before buying here' },
  { k: 'inStock', label: 'In stock', tip: 'Hide sold-out listings' },
  { k: 'lti', label: 'LTI', tip: 'Listings with lifetime insurance' },
  { k: 'priced', label: 'Has RSI price', tip: 'Only listings RSI+ can compare with an RSI price' },
  { k: 'unpriced', label: 'No RSI price', tip: "Only listings RSI+ has no RSI price for: accounts, bundles RSI never sold, gear RSI+ can't match" },
];

/** Kind chips + toggles (toolbar and the whole-collection table share them; `syncToolbar` keeps every copy in step). */
export function filterChips(withDim = true): HTMLElement {
  const chips = el('div', 'rp-imp-row rp-imp-chips');
  for (const k of KINDS) {
    const b = el('button', 'rp-imp-chip', KIND_LABEL[k]);
    b.dataset.kind = k;
    b.addEventListener('click', () => ((market.view.f.kinds = market.view.f.kinds.includes(k) ? market.view.f.kinds.filter((x) => x !== k) : [...market.view.f.kinds, k]), viewChanged()));
    chips.append(b);
  }
  chips.append(el('span', 'rp-imp-sep'));
  for (const t of TOGGLES.filter((x) => !market.hide.includes(x.k))) {
    const b = el('button', 'rp-imp-chip', t.label);
    b.dataset.toggle = t.k;
    b.title = t.k === 'myPaints' && !market.hasHangar ? `${t.tip}. Needs your hangar: load Pledges in the RSI+ hub once.` : t.tip;
    b.addEventListener('click', () => {
      (market.view.f as unknown as Record<string, boolean>)[t.k] = !market.view.f[t.k];
      if (t.k === 'hideOwned' && market.view.f.hideOwned) market.view.f.onlyOwned = false;
      if (t.k === 'onlyOwned' && market.view.f.onlyOwned) market.view.f.hideOwned = false;
      if (t.k === 'priced' && market.view.f.priced) market.view.f.unpriced = false;
      if (t.k === 'unpriced' && market.view.f.unpriced) market.view.f.priced = false;
      viewChanged();
    });
    chips.append(b);
  }
  const gaps = el('button', 'rp-imp-btn primary', 'Gaps');
  gaps.title = "Paints for your ships that RSI doesn't sell and you don't have";
  gaps.addEventListener('click', () => ((market.view.f = { ...NO_IMP_FILTER, ...GAPS_FILTER, q: market.view.f.q }), viewChanged()));
  chips.append(gaps);
  if (withDim) {
    const dim = el('button', 'rp-imp-chip', 'Dim owned');
    dim.dataset.dim = '1';
    dim.title = 'Fade the cards of things you already own';
    dim.addEventListener('click', () => ((market.view.dimOwned = !market.view.dimOwned), viewChanged()));
    chips.append(dim);
  }
  return chips;
}

/** Markup cap and sort selects (toolbar and table). */
export function capSelect(): HTMLSelectElement {
  const cap = el('select', 'rp-imp-select');
  cap.dataset.k = 'cap';
  cap.title = 'Markup over the RSI price';
  for (const [v, t] of [['', 'Any markup'], ['0', 'At or below RSI'], ['0.1', 'Up to +10%'], ['0.25', 'Up to +25%'], ['0.5', 'Up to +50%']])
    cap.append(Object.assign(document.createElement('option'), { value: v, textContent: t }));
  cap.value = market.view.f.maxMarkup == null ? '' : String(market.view.f.maxMarkup);
  cap.addEventListener('change', (e) => (e.stopPropagation(), (market.view.f.maxMarkup = cap.value === '' ? null : Number(cap.value)), viewChanged()));
  return cap;
}
export function sortSelect(): HTMLSelectElement {
  const sort = el('select', 'rp-imp-select');
  sort.dataset.k = 'sort';
  for (const s of IMP_SORTS) sort.append(Object.assign(document.createElement('option'), { value: s.id, textContent: s.label }));
  sort.value = market.view.sort;
  sort.addEventListener('change', (e) => (e.stopPropagation(), (market.view.sort = sort.value as ImpSort), viewChanged()));
  return sort;
}

/** Toolbar above the grid: search, kinds, toggles, markup cap, sort, *Whole collection*. Built once per grid. */
export function paintToolbar(cards: HTMLElement[], extra: HTMLElement[] = [], grid = cards[0]!.parentElement) {
  if (!grid || grid.previousElementSibling?.classList.contains('rp-imp-bar')) return syncToolbar();
  document.querySelectorAll('.rp-imp-bar').forEach((n) => n.remove());
  const bar = el('div', 'rp-imp rp-imp-bar');
  const top = el('div', 'rp-imp-row');
  top.append(el('span', 'rp-imp-logo', 'RSI+'));
  const q = el('input', 'rp-imp-input');
  q.type = 'search';
  q.placeholder = market.searchAll ? 'Filter this page: words, -exclude · Enter: all pages' : 'Filter this page: words, -exclude';
  q.value = market.view.f.q;
  q.dataset.k = 'q';
  q.addEventListener('input', () => ((market.view.f.q = q.value), viewChanged()));
  // The store's own key handlers (search drawer, Esc) must not see typing in RSI+'s box.
  q.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && market.searchAll) (e.preventDefault(), market.searchAll());
  });
  top.append(q, capSelect(), sortSelect(), ...extra, el('span', 'rp-imp-muted rp-imp-count'));
  const chips = filterChips();
  const reset = el('button', 'rp-imp-btn', 'Reset');
  reset.addEventListener('click', () => {
    market.view = { f: { ...NO_IMP_FILTER }, sort: 'store', dimOwned: market.view.dimOwned };
    viewChanged();
  });
  chips.append(reset);
  bar.append(top, chips);
  if (!market.hasHangar) bar.append(el('div', 'rp-imp-muted', 'Owned marks need your hangar: load Pledges in the RSI+ hub once.'));
  grid.before(bar);
  syncToolbar();
}
/** Every toolbar / table control back in step with `market.view` (the one being typed in is left alone). */
export function syncToolbar() {
  const f = market.view.f;
  for (const q of document.querySelectorAll<HTMLInputElement>('.rp-imp [data-k="q"]')) if (q.value !== f.q && document.activeElement !== q) q.value = f.q;
  for (const c of document.querySelectorAll<HTMLSelectElement>('.rp-imp [data-k="cap"]')) c.value = f.maxMarkup == null ? '' : String(f.maxMarkup);
  for (const c of document.querySelectorAll<HTMLSelectElement>('.rp-imp [data-k="sort"]')) c.value = market.view.sort;
  for (const b of document.querySelectorAll<HTMLElement>('.rp-imp-chips [data-kind]')) b.classList.toggle('on', f.kinds.includes(b.dataset.kind as SkuKind));
  for (const b of document.querySelectorAll<HTMLElement>('.rp-imp-chips [data-toggle]')) b.classList.toggle('on', !!f[b.dataset.toggle as keyof ImpFilter]);
  for (const b of document.querySelectorAll<HTMLElement>('.rp-imp-chips [data-dim]')) b.classList.toggle('on', market.view.dimOwned);
  for (const b of document.querySelectorAll<HTMLElement>('.rp-imp-chips [data-kind], .rp-imp-chips [data-toggle], .rp-imp-chips [data-dim]')) b.setAttribute('aria-pressed', String(b.classList.contains('on')));
}
