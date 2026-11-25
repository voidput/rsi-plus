/**
 * Long-range Star Citizen funding: RSI's `getCrowdfundStats` only returns the last 7 *completed* days / weeks /
 * months, so the Wallet chart and the year-over-year view stand on two more sources:
 *
 * - a bundled per-UTC-day history since Nov 2012 (`data/funding-history.json`, built by `scripts/funding-history.mjs`
 *   from the community funding tracker that logs RSI's counter), and
 * - every point RSI+ has fetched from RSI since (`FundingLog`, kept in `local:fundingLog`), which carries the history
 *   past the bundle's last day.
 *
 * Days come from the bundle up to its `through` day, then from recorded API days. Weeks (ISO, `YYYY-WW` like RSI's) and
 * months are summed from days, except that a period RSI itself reported wins when the days don't fully cover it.
 * The period still running is never in the API: it is RSI's live total minus everything counted up to yesterday,
 * known only while the day history has no hole.
 */
import BUNDLE from './data/funding-history.json';
import { MONTHS } from './dates';
import type { Funding, FundingRange } from './wallet';

export type Grain = 'day' | 'week' | 'month' | 'year';

/** API points RSI+ has seen, USD per period key (`2026-11-24`, `2026-47`, `2026-10`). */
export interface FundingLog {
  day: Record<string, number>;
  week: Record<string, number>;
  month: Record<string, number>;
}
export const emptyLog = (): FundingLog => ({ day: {}, week: {}, month: {} });

export interface History {
  start: string;
  through: string;
  usd: number[];
  source: string;
  url: string;
}
export const bundled: History = BUNDLE as History;

const DAY = 86_400_000;
const dayStr = (t: number) => new Date(t).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => dayStr(Date.parse(d) + n * DAY);

/** Merge one fetch into the log (the API only lists completed periods, so a later read never shrinks one). */
export function recordFunding(log: FundingLog | null | undefined, f: Pick<Funding, 'range' | 'points'>): FundingLog {
  const cur = log ?? emptyLog();
  if (!(f.range in cur)) return cur;
  const r = f.range as keyof FundingLog;
  return { ...cur, [r]: { ...cur[r], ...Object.fromEntries(f.points.map((p) => [p.key, p.usd])) } };
}

/** ISO-8601 week key `YYYY-WW` of a UTC day (RSI's week keys: 2026-11-16 → `2026-47`). */
export function isoWeek(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Monday 0
  const thu = new Date(d.getTime() + (3 - dow) * DAY);
  const jan1 = Date.UTC(thu.getUTCFullYear(), 0, 1);
  const wk = Math.floor((thu.getTime() - jan1) / DAY / 7) + 1;
  return `${thu.getUTCFullYear()}-${String(wk).padStart(2, '0')}`;
}
/** Monday of an ISO week key. */
export function weekStart(key: string): string {
  const [y, w] = key.split('-').map(Number) as [number, number];
  const jan4 = Date.UTC(y, 0, 4);
  const dow = (new Date(jan4).getUTCDay() + 6) % 7;
  return dayStr(jan4 - dow * DAY + (w - 1) * 7 * DAY);
}

export interface Days {
  /** Day → USD, ascending, no gaps from `first` to `contiguous`. */
  map: Map<string, number>;
  first: string;
  /** Last day of the unbroken run from the start (the running-period maths needs no hole). */
  contiguous: string;
  /** Last day known at all. */
  last: string;
  /** Sum of every day up to `contiguous`. */
  total: number;
}

/** Bundle days, then recorded API days after the bundle (the bundle wins where both exist: one consistent source). */
export function dayHistory(log: FundingLog | null | undefined, h: History = bundled): Days {
  const map = new Map<string, number>();
  h.usd.forEach((v, i) => map.set(addDays(h.start, i), v));
  const extra = Object.entries(log?.day ?? {})
    .filter(([k]) => k > h.through)
    .sort(([a], [b]) => a.localeCompare(b));
  for (const [k, v] of extra) map.set(k, v);
  let contiguous = h.through;
  let total = h.usd.reduce((a, b) => a + b, 0);
  for (let d = addDays(h.through, 1); map.has(d); d = addDays(d, 1)) (contiguous = d), (total += map.get(d)!);
  const last = extra.at(-1)?.[0] ?? h.through;
  return { map: new Map([...map].sort(([a], [b]) => a.localeCompare(b))), first: h.start, contiguous, last: last > contiguous ? last : contiguous, total };
}

export interface SeriesPoint {
  key: string;
  label: string;
  /** Period start (UTC midnight), for a time axis. */
  date: Date;
  usd: number;
}

const periodKey = (day: string, g: Exclude<Grain, 'day'>) => (g === 'week' ? isoWeek(day) : g === 'month' ? day.slice(0, 7) : day.slice(0, 4));
const periodStart = (key: string, g: Grain) => (g === 'day' ? key : g === 'week' ? weekStart(key) : g === 'month' ? `${key}-01` : `${key}-01-01`);
const periodEnd = (key: string, g: Grain): string => {
  if (g === 'day') return key;
  if (g === 'week') return addDays(weekStart(key), 6);
  if (g === 'month') {
    const [y, m] = key.split('-').map(Number) as [number, number];
    return dayStr(Date.UTC(y, m, 0));
  }
  return `${key}-12-31`;
};
export function periodLabel(key: string, g: Grain): string {
  if (g === 'day') return key.slice(5);
  if (g === 'week') return `W${key.slice(5)} ’${key.slice(2, 4)}`;
  if (g === 'month') return `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
  return key;
}

/**
 * Completed periods, oldest first, through the last fully known one. The first period (Nov 2012, the tracker's start)
 * holds everything raised before it, so it reads high.
 */
export function series(days: Days, g: Grain, log?: FundingLog | null): SeriesPoint[] {
  const sums = new Map<string, { usd: number; n: number }>();
  for (const [d, v] of days.map) {
    const k = g === 'day' ? d : periodKey(d, g);
    const s = sums.get(k) ?? { usd: 0, n: 0 };
    s.usd += v;
    s.n++;
    sums.set(k, s);
  }
  const api = g === 'week' || g === 'month' ? (log?.[g] ?? {}) : {};
  for (const k of Object.keys(api)) if (!sums.has(k)) sums.set(k, { usd: 0, n: 0 });
  const out: SeriesPoint[] = [];
  for (const [k, s] of [...sums].sort(([a], [b]) => a.localeCompare(b))) {
    const from = periodStart(k, g) < days.first ? days.first : periodStart(k, g);
    const end = periodEnd(k, g);
    const want = Math.round((Date.parse(end) - Date.parse(from)) / DAY) + 1;
    const full = s.n >= want;
    const usd = full ? s.usd : api[k];
    if (usd == null) continue; // still running, or a hole in the recorded days RSI never reported as a whole
    out.push({ key: k, label: periodLabel(k, g), date: new Date(`${periodStart(k, g)}T00:00:00Z`), usd: Math.round(usd) });
  }
  return out;
}

/** The period running now, to date: completed days in it + RSI's live total − every day counted. Null on a hole. */
export function runningPeriod(days: Days, funds: number, g: Grain, now = new Date()): { key: string; usd: number; since: string } | null {
  const today = dayStr(now.getTime());
  if (!funds || addDays(days.contiguous, 1) < today) return null; // yesterday missing → can't split the live total
  const key = g === 'day' ? today : periodKey(today, g);
  const from = periodStart(key, g);
  let usd = funds - days.total;
  for (const [d, v] of days.map) if (d >= from && d <= days.contiguous) usd += v;
  return { key, usd: Math.round(usd), since: from };
}

/** Fraction of a period elapsed at `now` (UTC), for an "on pace for" projection. */
export function elapsed(g: Grain, now = new Date()): number {
  const t = now.getTime();
  const today = dayStr(t);
  const key = g === 'day' ? today : periodKey(today, g);
  const from = Date.parse(periodStart(key, g));
  const to = Date.parse(periodEnd(key, g)) + DAY;
  return Math.max(0.01, Math.min(1, (t - from) / (to - from)));
}

// ---- year over year ----

export interface YearRow {
  year: number;
  usd: number;
  /** Year not over (the current one), or started mid-year (2012). */
  partial: boolean;
  /** vs the previous year's full total (null for the first, and for a partial year: see `ytd`). */
  delta: number | null;
  pct: number | null;
  /** Year-to-date comparison for the running year: same calendar span the year before. */
  ytd?: { prev: number; delta: number; pct: number | null; through: string };
}

/** One row per year. `funds` adds the running day to the current year when the history has no hole. */
export function yearTable(days: Days, funds = 0, now = new Date()): YearRow[] {
  const run = runningPeriod(days, funds, 'day', now);
  const by = new Map<number, number>();
  for (const [d, v] of days.map) by.set(Number(d.slice(0, 4)), (by.get(Number(d.slice(0, 4))) ?? 0) + v);
  if (run) by.set(Number(run.key.slice(0, 4)), (by.get(Number(run.key.slice(0, 4))) ?? 0) + run.usd);
  const lastDay = run?.key ?? days.last;
  const curYear = Number(lastDay.slice(0, 4));
  const firstYear = Number(days.first.slice(0, 4));
  const rows: YearRow[] = [];
  for (const [year, usd] of [...by].sort(([a], [b]) => a - b)) {
    const partial = year === firstYear || (year === curYear && lastDay < `${year}-12-31`);
    const prev = rows.at(-1);
    const row: YearRow = { year, usd: Math.round(usd), partial, delta: null, pct: null };
    if (prev && !partial && !prev.partial) {
      row.delta = row.usd - prev.usd;
      row.pct = prev.usd ? row.delta / prev.usd : null;
    }
    if (partial && year === curYear && prev) {
      const md = lastDay.slice(4); // -MM-DD
      let p = 0;
      for (const [d, v] of days.map) if (d.startsWith(`${year - 1}-`) && d.slice(4) <= md) p += v;
      const pr = Math.round(p);
      row.ytd = { prev: pr, delta: row.usd - pr, pct: pr ? (row.usd - pr) / pr : null, through: lastDay };
    }
    rows.push(row);
  }
  return rows;
}

export interface OverlayRow {
  /** 1–12 */
  m: number;
  label: string;
  /** year → USD for that month (or running total by that month's end when cumulative); missing = no data yet. */
  [year: `y${number}`]: number | undefined;
}

/** Jan–Dec rows with one column per year (`y2025`), for a multi-line chart. The running month counts to date. */
export function monthOverlay(days: Days, years: number[], cumulative: boolean, funds = 0, now = new Date()): OverlayRow[] {
  const run = runningPeriod(days, funds, 'day', now);
  const sums = new Map<string, number>();
  for (const [d, v] of days.map) sums.set(d.slice(0, 7), (sums.get(d.slice(0, 7)) ?? 0) + v);
  if (run) sums.set(run.key.slice(0, 7), (sums.get(run.key.slice(0, 7)) ?? 0) + run.usd);
  const lastMonth = (run?.key ?? days.last).slice(0, 7);
  const rows: OverlayRow[] = MONTHS.map((label, i) => ({ m: i + 1, label }));
  for (const y of years) {
    let acc = 0;
    rows.forEach((r, i) => {
      const k = `${y}-${String(i + 1).padStart(2, '0')}`;
      if (k > lastMonth || !sums.has(k)) return;
      acc += sums.get(k)!;
      r[`y${y}`] = Math.round(cumulative ? acc : sums.get(k)!);
    });
  }
  return rows;
}

/** Window sizes offered per grain (count of periods; 0 = everything). */
export const SPANS: Record<Grain, { n: number; label: string }[]> = {
  day: [
    { n: 30, label: '30 d' },
    { n: 90, label: '90 d' },
    { n: 365, label: '1 y' },
  ],
  week: [
    { n: 26, label: '6 mo' },
    { n: 52, label: '1 y' },
    { n: 156, label: '3 y' },
  ],
  month: [
    { n: 12, label: '1 y' },
    { n: 36, label: '3 y' },
    { n: 0, label: 'All' },
  ],
  year: [{ n: 0, label: 'All' }],
};

/** API range for a grain (years have none: they come from history only). */
export const apiRange = (g: Grain): FundingRange | null => (g === 'year' ? null : g);
