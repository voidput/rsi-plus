/**
 * The Impound (opt-in: Settings → Integrations → The Impound). Registered at runtime by the background only while the
 * setting is on and theimpound.com is granted (`registration: 'runtime'`: nothing in the manifest, a store install
 * asks for nothing new). Reads the store's own pages and its public Shopify product JSON; never its cart or account.
 *
 * - Every listing (collection / search grids): RSI price, markup, and what you already own.
 * - A toolbar over the grid: search, kind, owned / can apply / in stock / LTI / at most RSI price, and sorting.
 * - *Whole collection*: every listing of the collection in one table with the same filters (reads all its pages).
 * - A product page: each variant (upgrade from …, insurance) with its RSI price, markup and whether you own it.
 */
import { buybackItem, catalogItem, gameShipsItem, getSettings, hangarItem, impoundCacheItem, impoundViewItem, paintCatalogItem, paintSeenItem, priceHistoryItem, settingsItem } from '@/lib/settings';
import { withArchive } from '@/lib/price-history';
import { bg } from '@/lib/messages';
import { ownedCcus } from '@/lib/ccu';
import { ownedHulls, ownedTitleCounts } from '@/lib/owned-counts';
import {
  KIND_LABEL,
  NO_IMP_FILTER,
  collectionOf,
  filterRows,
  fresh,
  handleFromUrl,
  insuranceLabel,
  markup,
  ownershipFull,
  paidByTitle,
  paidLabel,
  pageOf,
  parseSku,
  priceCtx,
  productFromPage,
  putProducts,
  rowOf,
  rsiPrice,
  sortRows,
  toProduct,
  type ImpCache,
  type ImpFilter,
  type ImpProduct,
  type ImpRow,
  type ImpSort,
  type OwnCtx,
  type PriceCtx,
  type SkuKind,
} from '@/lib/impound';
import type { CatalogShip } from '@/lib/store';
import { applyView, badge, capSelect, configureMarket, contentsTiles, el, extras, thumbEl, filterChips, market, money, paintToolbar, pct, signed, sortSelect, syncToolbar, tone, viewChanged } from '@/lib/market-dom';
import css from './style.css?inline';

let ships: CatalogShip[] = [];
let pctx: PriceCtx = priceCtx([], []);
let own: OwnCtx = { hulls: new Map(), ccus: [], titles: { exact: new Map(), cut: new Map() } };
let cache: ImpCache = {};
let schedule = () => {};
/** Bumped on every data load: the product panel redraws when prices, history or buyback change. */
let dataVer = 0;

export default defineContentScript({
  matches: ['https://theimpound.com/*'],
  registration: 'runtime',
  runAt: 'document_idle',
  async main(ctx) {
    if (!(await getSettings()).impound) return;
    const style = document.createElement('style');
    style.id = 'rsiplus-imp-style';
    style.textContent = css;
    (document.head ?? document.documentElement).append(style);

    const saved = await impoundViewItem.getValue();
    configureMarket({
      store: 'The Impound',
      // The search text starts empty on each page: kept, it silently hid most of the next page's results.
      view: { ...market.view, ...(saved ?? {}), f: { ...NO_IMP_FILTER, ...(saved?.f ?? {}), q: '' } },
      save: () => void impoundViewItem.setValue(market.view).catch(() => {}),
      schedule: () => schedule(),
      searchAll: () => openTable(tableScope()),
    });
    cache = await impoundCacheItem.getValue();
    await loadData();
    for (const it of [catalogItem, paintCatalogItem, hangarItem, buybackItem, gameShipsItem, priceHistoryItem, paintSeenItem] as const) it.watch(() => loadData().then(schedule));
    settingsItem.watch(async () => {
      if (!(await getSettings()).impound) document.querySelectorAll('.rp-imp').forEach((n) => n.remove());
    });

    let timer = 0;
    schedule = () => {
      if (timer) return;
      timer = window.setTimeout(() => {
        timer = 0;
        paint().catch((e) => console.warn('[RSI+] impound', e));
      }, 200);
    };
    const mo = new MutationObserver((muts) => {
      if (muts.every((m) => [...m.addedNodes, ...m.removedNodes].every((n) => n instanceof HTMLElement && (n.classList.contains('rp-imp') || !!n.closest('.rp-imp'))))) return;
      schedule();
    });
    mo.observe(document.body, { childList: true, subtree: true });
    ctx.onInvalidated(() => mo.disconnect());
    ctx.addEventListener(window, 'wxt:locationchange', schedule);
    // Variant picked on a product page: the URL gets ?variant=… (history.replaceState) and the select changes.
    ctx.addEventListener(document, 'change', schedule, { capture: true });
    schedule();
  },
});

async function loadData() {
  let cat = await catalogItem.getValue();
  if (!cat?.ships.length) cat = await bg({ type: 'catalog:get' }).catch(() => null);
  let paints = await paintCatalogItem.getValue();
  if (!paints?.paints.length) paints = await bg({ type: 'paints:get' }).catch(() => null);
  ships = cat?.ships ?? [];
  const [history, paintSeen, buyback] = await Promise.all([priceHistoryItem.getValue().then(withArchive), paintSeenItem.getValue(), buybackItem.getValue()]);
  pctx = priceCtx(ships, paints?.paints ?? [], { history, paintSeen, buyback: buyback?.items ?? [] });
  const hangar = await hangarItem.getValue();
  const game = await gameShipsItem.getValue();
  const pledges = hangar?.pledges ?? [];
  own = { hulls: ownedHulls(pledges, game, ships), ccus: ships.length ? ownedCcus(pledges, [], ships).owned : [], titles: ownedTitleCounts(pledges), paid: paidByTitle(pledges) };
  market.hasHangar = !!hangar?.pledges.length;
  dataVer++;
}

/* ---------------------------------------------------------------- fetching ---------------------------------------------------------------- */

let saving = 0;
function remember(list: ImpProduct[]) {
  if (!list.length) return;
  cache = putProducts(cache, list, Date.now());
  clearTimeout(saving);
  saving = window.setTimeout(() => impoundCacheItem.setValue(cache).catch(() => {}), 800);
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const inflight = new Set<string>();
let backoffUntil = 0;

async function getJson(url: string): Promise<any | null> {
  if (Date.now() < backoffUntil) return null;
  const r = await fetch(url, { credentials: 'omit', headers: { accept: 'application/json' } }).catch(() => null);
  if (r?.status === 429) backoffUntil = Date.now() + 60_000;
  return r?.ok ? r.json().catch(() => null) : null;
}

/**
 * Every product of a collection, or of the whole store (`coll` null: `/products.json`), Shopify's JSON at 250 a page,
 * politely one page at a time. Kept for 10 minutes, so reopening the table or searching again reads nothing.
 */
const lists = new Map<string, { at: number; list: ImpProduct[] }>();
async function listProducts(coll: string | null, onPage?: (n: number) => void): Promise<ImpProduct[]> {
  const key = coll ?? '*';
  const hit = lists.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.list;
  const base = coll ? `/collections/${encodeURIComponent(coll)}/products.json` : '/products.json';
  const out: ImpProduct[] = [];
  for (let page = 1; page <= 20; page++) {
    const j = await getJson(`${base}?limit=250&page=${page}`);
    const list = ((j?.products ?? []) as unknown[]).map((p) => toProduct(p)).filter((p): p is ImpProduct => !!p);
    out.push(...list);
    remember(list);
    onPage?.(out.length);
    if (list.length < 250) break;
    await wait(500);
  }
  if (out.length) lists.set(key, { at: Date.now(), list: out });
  return out;
}

/** Products for the cards on screen that the cache doesn't hold (fresh): the collection's JSON, else one by one. */
async function ensure(handles: string[]) {
  const now = Date.now();
  const missing = handles.filter((h) => !fresh(cache, h, now) && !inflight.has(h));
  if (!missing.length) return false;
  missing.forEach((h) => inflight.add(h));
  try {
    const coll = collectionOf(location.pathname);
    if (coll && pageOf(location.pathname) === 'collection') {
      const want = new Set(missing);
      for (let page = 1; page <= 20 && want.size; page++) {
        const j = await getJson(`/collections/${encodeURIComponent(coll)}/products.json?limit=250&page=${page}`);
        const list = ((j?.products ?? []) as unknown[]).map((p) => toProduct(p)).filter((p): p is ImpProduct => !!p);
        remember(list);
        list.forEach((p) => want.delete(p.handle));
        if (list.length < 250) break;
        await wait(500);
      }
      missing.splice(0, missing.length, ...missing.filter((h) => want.has(h)));
    }
    // Search results, or cards from another collection: one product each (`.js`, prices in cents), 3 at a time.
    const queue = missing.slice(0, 80);
    const worker = async () => {
      for (let h = queue.shift(); h; h = queue.shift()) {
        const p = toProduct(await getJson(`/products/${encodeURIComponent(h)}.js`), true);
        if (p) remember([p]);
        await wait(150);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    return true;
  } finally {
    missing.forEach((h) => inflight.delete(h));
  }
}

/* ---------------------------------------------------------------- painting ---------------------------------------------------------------- */

async function paint() {
  if (!document.body) return;
  const page = pageOf(location.pathname);
  if (page === 'product') paintProduct();
  // Grid cards on collection / search pages only: on a product page they are "related" strips (shown as previews).
  const cards = page === 'product' ? [] : [...document.querySelectorAll<HTMLElement>('.grid-product[data-product-handle]')];
  const minis = miniCards();
  if (page === 'product') for (const c of document.querySelectorAll<HTMLElement>('.grid-product[data-product-handle]')) minis.set(c, c.dataset.productHandle!);
  if (cards.length) {
    paintToolbar(cards, wholeButton());
    paintCards(cards);
  }
  paintMinis(minis);
  const handles = [...new Set([...cards.map((c) => c.dataset.productHandle!), ...minis.values()].filter(Boolean))];
  if (await ensure(handles)) {
    if (cards.length) paintCards([...document.querySelectorAll<HTMLElement>('.grid-product[data-product-handle]')]);
    paintMinis(miniCards());
  }
}

function rowFor(handle: string): ImpRow | null {
  const p = cache[handle]?.p;
  return p ? rowOf(p, pctx, own) : null;
}

/** RSI price line under each card's price, owned marks, then the toolbar's filter and order. */
function paintCards(cards: HTMLElement[]) {
  const rows = new Map<HTMLElement, ImpRow | null>(cards.map((c) => [c, rowFor(c.dataset.productHandle!)]));
  for (const [card, r] of rows) {
    const meta = card.querySelector('.grid-product__meta') ?? card.querySelector('.grid-product__content');
    if (!meta) continue;
    const key = r ? [r.variant.id, r.variant.price, r.rsi.cents, r.own.label, market.view.dimOwned, r.deal?.tier, r.status.sold, r.status.last?.at, r.buyback?.cents, !!r.buyback].join('|') : 'none';
    let box = meta.querySelector<HTMLElement>(':scope > .rp-imp-card');
    card.classList.toggle('rp-imp-owned', !!r?.own.owned && market.view.dimOwned);
    if (box?.dataset.key === key) continue;
    box?.remove();
    box = el('div', 'rp-imp rp-imp-card');
    box.dataset.key = key;
    if (!r) box.append(el('span', 'rp-imp-muted', ships.length ? 'RSI+ …' : 'RSI+: open the RSI+ hub once to load RSI prices'));
    else badge(box, r);
    meta.append(box);
  }
  applyView(rows);
}

/* ---------------------------------------------------------------- small previews ---------------------------------------------------------------- */

/** Product links outside the main grid: menu minis, home page strips, "you may also like", the search drawer. */
const MINI_CARD = '.gm-product-mini, .tise-card, [class*="ai-collection-grid__product"], .predictive-search__item, .predictive__item, li, article';
function miniCards(): Map<HTMLElement, string> {
  const out = new Map<HTMLElement, string>();
  const self = pageOf(location.pathname) === 'product' ? handleFromUrl(location.pathname) : null;
  for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href*="/products/"]')) {
    if (a.closest('.grid-product, .rp-imp, .product-single__meta, form')) continue;
    const h = handleFromUrl(a.getAttribute('href') ?? '');
    if (!h || h === self) continue;
    const card = a.closest<HTMLElement>(MINI_CARD) ?? a.parentElement;
    if (!card || card === document.body || out.has(card)) continue;
    // A container holding several products (a whole list) isn't one card.
    if (new Set([...card.querySelectorAll<HTMLAnchorElement>('a[href*="/products/"]')].map((x) => handleFromUrl(x.getAttribute('href') ?? ''))).size > 1) continue;
    out.set(card, h);
  }
  return out;
}
function paintMinis(cards: Map<HTMLElement, string>) {
  for (const [card, h] of cards) {
    const r = rowFor(h);
    const key = r ? [r.variant.id, r.rsi.cents, r.own.label, r.own.paid?.cents, r.deal?.tier, r.status.sold].join('|') : 'none';
    let box = card.querySelector<HTMLElement>(':scope .rp-imp-mini');
    if (box?.dataset.key === key) continue;
    box?.remove();
    if (!r) continue;
    box = el('span', 'rp-imp rp-imp-mini');
    box.dataset.key = key;
    badge(box, r, true);
    if (!box.childElementCount) continue;
    const price = card.querySelector('.money')?.closest('[class*="price"]') ?? card.querySelector('.money');
    if (price) price.after(box);
    else card.append(box);
  }
}

/* ---------------------------------------------------------------- whole collection ---------------------------------------------------------------- */

/** What *Search all* reads: this collection on a collection page, else the whole store. */
const tableScope = () => (pageOf(location.pathname) === 'collection' ? collectionOf(location.pathname) : null);

function wholeButton(): HTMLElement[] {
  const coll = tableScope();
  const all = el('button', 'rp-imp-btn primary', coll ? 'Whole collection' : 'Whole store');
  all.title = coll ? 'Every listing of this collection (all pages) in one table: search, filter, sort, page through' : 'Every listing of the store in one table: search, filter, sort, page through';
  all.addEventListener('click', () => openTable(coll));
  return [all];
}

const TABLE_PAGE = 100;
/** Packs opened in the table (kept open across re-renders and pages). */
const openPacks = new Set<string>();
function packRowFor(r: ImpRow, span: number): HTMLTableRowElement {
  const tr = el('tr', 'packrow');
  const td = el('td', '');
  td.colSpan = span;
  td.append(contentsTiles(r.own.contents ?? [], r.variant.price, r.own.partial?.of));
  tr.append(td);
  return tr;
}
const notes = (r: ImpRow) => {
  const td = el('td', '');
  extras(td, r);
  return td;
};
let closeTable: (() => void) | null = null;

/** Every page of a collection (or the store) in one table, with its own search, the toolbar's filters, sort and pages. */
async function openTable(coll: string | null) {
  closeTable?.();
  const ov = el('div', 'rp-imp rp-imp-overlay');
  ov.setAttribute('role', 'dialog');
  ov.setAttribute('aria-modal', 'true');
  ov.setAttribute('aria-label', coll ? 'RSI+: whole collection' : 'RSI+: whole store');
  const panel = el('div', 'rp-imp-panel');
  const head = el('div', 'rp-imp-row');
  const name = coll ? document.querySelector('h1')?.textContent?.trim() || coll : 'whole store';
  const status = el('span', 'rp-imp-muted', 'Reading…');
  const close = el('button', 'rp-imp-btn', 'Close');
  head.append(el('strong', '', `RSI+ · ${name}`), status, close);
  // Its own search box (the store's search page: starts from what you searched there).
  const urlQ = pageOf(location.pathname) === 'search' ? (new URLSearchParams(location.search).get('q') ?? '') : '';
  const q = el('input', 'rp-imp-input');
  q.type = 'search';
  q.placeholder = 'Search every page: words, -exclude';
  q.value = market.view.f.q || urlQ;
  const tools = el('div', 'rp-imp-row');
  tools.append(q, capSelect(), sortSelect());
  const pager = el('div', 'rp-imp-row rp-imp-pager');
  const body = el('div', 'rp-imp-tablewrap');
  panel.append(head, tools, filterChips(false), body, pager);
  ov.append(panel);
  let page = 0;
  let list: ImpProduct[] = [];
  const render = () => {
    const rows = sortRows(filterRows(list.map((p) => rowOf(p, pctx, own)).filter((r): r is ImpRow => !!r), { ...market.view.f, q: q.value }), market.view.sort);
    const pages = Math.max(1, Math.ceil(rows.length / TABLE_PAGE));
    page = Math.min(page, pages - 1);
    status.textContent = list.length ? `${rows.length} of ${list.length} listings` : status.textContent;
    const t = el('table', 'rp-imp-table');
    const hr = el('tr', '');
    const cols: [string, ImpSort | null][] = [['Listing', 'title'], ['Kind', null], ['The Impound', 'price'], ['RSI', null], ['Markup', 'markup-pct'], ['Deal · RSI · buyback', null], ['You', null], ['Stock', null]];
    for (const [c, s] of cols) {
      const th = el('th', s ? 'sortable' : '', c);
      if (s) th.addEventListener('click', () => ((market.view.sort = market.view.sort === s && s === 'price' ? 'price-desc' : s), (page = 0), viewChanged()));
      hr.append(th);
    }
    t.append(el('thead', ''));
    t.tHead!.append(hr);
    const tb = el('tbody', '');
    for (const r of rows.slice(page * TABLE_PAGE, (page + 1) * TABLE_PAGE)) {
      const tr = el('tr', r.own.owned ? 'owned' : '');
      const a = el('a', '', r.product.title);
      a.href = `/products/${r.product.handle}${r.product.variants.length > 1 ? `?variant=${r.variant.id}` : ''}`;
      const c0 = el('td', 'listing');
      const txt = el('div', '');
      txt.append(a);
      if (r.product.variants.length > 1) txt.append(el('div', 'rp-imp-muted', `${r.variant.title} · ${r.product.variants.length} options`));
      const inside = r.own.contents ?? [];
      let packRow: HTMLTableRowElement | null = null;
      if (inside.length > 1) {
        const exp = el('button', 'rp-imp-expand', `▸ ${r.own.partial?.of ?? inside.length} inside`);
        exp.setAttribute('aria-expanded', 'false');
        exp.addEventListener('click', () => {
          if (packRow) {
            packRow.remove();
            packRow = null;
            openPacks.delete(r.product.handle);
          } else {
            packRow = packRowFor(r, cols.length);
            tr.after(packRow);
            openPacks.add(r.product.handle);
          }
          exp.textContent = `${packRow ? '▾' : '▸'} ${r.own.partial?.of ?? inside.length} inside`;
          exp.setAttribute('aria-expanded', String(!!packRow));
        });
        txt.append(exp);
        if (openPacks.has(r.product.handle)) queueMicrotask(() => exp.click());
      }
      c0.append(thumbEl(r.product.image, r.product.title), txt);
      const ins = insuranceLabel(r.info.insurance);
      tr.append(
        c0,
        el('td', '', `${KIND_LABEL[r.kind]}${ins ? ` · ${ins}` : ''}`),
        el('td', 'num', money(r.variant.price)),
        Object.assign(el('td', 'num', r.rsi.cents != null ? money(r.rsi.cents) : '—'), { title: r.rsi.basis }),
        el('td', `num ${tone(r.markup)}`, r.markup ? `${signed(r.markup.cents)} (${pct(r.markup.pct)})` : '—'),
        notes(r),
        el('td', r.own.owned || r.fitsMine ? 'own' : '', r.own.label || (r.fitsMine ? 'for a ship you own' : '')),
        el('td', '', r.available ? 'in stock' : 'sold out'),
      );
      tb.append(tr);
    }
    t.append(tb);
    body.replaceChildren(list.length && !rows.length ? el('div', 'rp-imp-muted', 'Nothing matches: loosen the search or filters.') : t);
    body.scrollTop = 0;
    pager.replaceChildren();
    if (pages > 1) {
      const btn = (label: string, to: number, off: boolean) => {
        const b = el('button', 'rp-imp-btn', label);
        b.disabled = off;
        b.addEventListener('click', () => ((page = to), render()));
        return b;
      };
      pager.append(btn('« First', 0, page === 0), btn('‹ Prev', page - 1, page === 0), el('span', 'rp-imp-muted', `Page ${page + 1} of ${pages} · ${page * TABLE_PAGE + 1}–${Math.min(rows.length, (page + 1) * TABLE_PAGE)} of ${rows.length}`), btn('Next ›', page + 1, page >= pages - 1), btn('Last »', pages - 1, page >= pages - 1));
    }
  };
  const onChange = () => ((page = 0), render());
  q.addEventListener('input', onChange);
  q.addEventListener('keydown', (e) => e.stopPropagation());
  market.onChange.add(onChange);
  closeTable = () => {
    market.onChange.delete(onChange);
    ov.remove();
    closeTable = null;
  };
  close.addEventListener('click', () => closeTable?.());
  ov.addEventListener('click', (e) => e.target === ov && closeTable?.());
  ov.addEventListener('keydown', (e) => e.key === 'Escape' && closeTable?.());
  document.body.append(ov);
  syncToolbar();
  q.focus();
  list = await listProducts(coll, (n) => (status.textContent = `Reading… ${n} listings`));
  if (!list.length) status.textContent = 'The store did not answer (or asked to slow down): try again in a minute.';
  render();
}

/* ---------------------------------------------------------------- product page ---------------------------------------------------------------- */

function selectedVariant(): number | null {
  const v = new URLSearchParams(location.search).get('variant');
  if (v) return Number(v);
  const sel = document.querySelector<HTMLSelectElement>('select[name="id"]');
  return sel?.value ? Number(sel.value) : null;
}

function paintProduct() {
  const handle = handleFromUrl(location.pathname);
  if (!handle) return;
  const p = productFromPage(document, handle) ?? cache[handle]?.p ?? null;
  const host = document.querySelector('.product-block--price') ?? document.querySelector('.product-single__meta');
  if (!p || !host) return;
  const sel = selectedVariant() ?? p.variants[0]?.id ?? null;
  const rows = p.variants.map((v) => ({ v, info: parseSku(v.sku), rsi: rsiPrice(p, v, pctx), own: ownershipFull(p, v, own, pctx) }));
  const key = [handle, sel, dataVer, ships.length, own.hulls.size, own.ccus.length, rows.map((r) => r.v.price).join(',')].join('|');
  let box = document.querySelector<HTMLElement>('.rp-imp-product');
  if (box?.dataset.key === key) return;
  box?.remove();
  box = el('div', 'rp-imp rp-imp-product');
  box.dataset.key = key;
  const cur = rows.find((r) => r.v.id === sel) ?? rows[0]!;
  const m = markup(cur.v.price, cur.rsi);
  const head = el('div', 'rp-imp-row');
  head.append(el('span', 'rp-imp-logo', 'RSI+'));
  if (cur.rsi.cents != null && m) {
    const s = el('span', `rp-imp-price big ${tone(m)}`, `RSI ${money(cur.rsi.cents)} · The Impound ${money(cur.v.price)} · ${signed(m.cents)} (${pct(m.pct)})`);
    s.title = cur.rsi.basis;
    head.append(s);
  } else head.append(el('span', 'rp-imp-muted', ships.length ? 'No RSI price to compare for this one' : 'Open the RSI+ hub once to load RSI prices'));
  box.append(head);
  if (cur.rsi.basis) box.append(el('div', 'rp-imp-muted', cur.rsi.basis + (cur.info.kind === 'ship' || cur.info.kind === 'pack' ? '. LTI, original-concept extras and availability are not priced in.' : '')));
  if (cur.own.label) box.append(el('div', `rp-imp-own ${cur.own.owned || cur.own.haveTo ? '' : 'part'}`, `${cur.own.owned || cur.own.haveTo ? '✓' : cur.own.partial ? '◐' : '↑'} ${cur.own.label}`));
  if (cur.own.paid) {
    const pd = el('div', 'rp-imp-muted', `${paidLabel(cur.own.paid, money)[0]!.toUpperCase()}${paidLabel(cur.own.paid, money).slice(1)}: ${cur.own.paid.pledge} (melt value)`);
    box.append(pd);
  }
  if (cur.own.contents?.length) {
    box.append(el('div', 'rp-imp-muted', 'Inside, as RSI+ reads the listing (pictures and prices from RSI):'), contentsTiles(cur.own.contents, cur.v.price, cur.own.partial?.of));
  }
  const curRow = rowOf(p, pctx, own, cur.v);
  if (curRow) {
    const ex = el('div', 'rp-imp-row');
    extras(ex, curRow);
    if (ex.childElementCount) box.append(ex);
  }
  if (!cur.own.label && !market.hasHangar) box.append(el('div', 'rp-imp-muted', 'Owned marks need your hangar: load Pledges in the RSI+ hub once.'));

  if (rows.length > 1) {
    const usable = rows.filter((r) => r.info.kind === 'ccu' && r.own.haveFrom);
    const t = el('table', 'rp-imp-table');
    const hr = el('tr', '');
    for (const c of [rows[0]!.info.kind === 'ccu' ? 'Upgrade from' : 'Option', 'The Impound', 'RSI', 'Markup', 'You', '']) hr.append(el('th', '', c));
    t.append(el('thead', ''));
    t.tHead!.append(hr);
    const tb = el('tbody', '');
    const order = [...rows].sort((a, b) => Number(b.own.haveFrom) - Number(a.own.haveFrom) || Number(b.v.available) - Number(a.v.available) || (markup(a.v.price, a.rsi)?.pct ?? 9) - (markup(b.v.price, b.rsi)?.pct ?? 9));
    for (const r of order) {
      const mk = markup(r.v.price, r.rsi);
      const tr = el('tr', `${r.v.id === sel ? 'sel' : ''} ${r.v.available ? '' : 'out'} ${r.own.haveFrom ? 'usable' : ''}`);
      const pick = el('a', 'rp-imp-link', r.v.id === sel ? 'shown' : 'pick');
      pick.href = `?variant=${r.v.id}`;
      tr.append(
        el('td', '', `${r.v.title}${r.v.available ? '' : ' (sold out)'}`),
        el('td', 'num', money(r.v.price)),
        Object.assign(el('td', 'num', r.rsi.cents != null ? money(r.rsi.cents) : '—'), { title: r.rsi.basis }),
        el('td', `num ${tone(mk)}`, mk ? `${signed(mk.cents)} (${pct(mk.pct)})` : '—'),
        el('td', r.own.owned || r.own.haveFrom ? 'own' : '', r.info.kind === 'ccu' ? (r.own.owned ? 'own this' : r.own.haveFrom ? 'you own the from ship' : '') : r.own.label),
        Object.assign(el('td', ''), {}),
      );
      tr.lastElementChild!.append(pick);
      tb.append(tr);
    }
    t.append(tb);
    const det = el('details', 'rp-imp-variants');
    det.open = rows.length <= 12 || usable.length > 0;
    det.append(el('summary', '', `All ${rows.length} options${usable.length ? ` · ${usable.length} from ships you own (listed first)` : ''}`), t);
    box.append(det);
  }
  host.after(box);
}
