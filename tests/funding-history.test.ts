import { describe, expect, it } from 'vitest';
import { bundled, dayHistory, elapsed, emptyLog, isoWeek, monthOverlay, recordFunding, runningPeriod, series, weekStart, yearTable, type History } from '@/lib/funding-history';

/** 2024-12-30 … 2026-01-04 (371 days), $100 a day; Jan 2025 days $200. */
const days = (n: number, start: string, f: (d: string) => number) =>
  Array.from({ length: n }, (_, i) => f(new Date(Date.parse(start) + i * 86_400_000).toISOString().slice(0, 10)));
const H: History = { start: '2024-12-30', through: '2026-01-04', source: 't', url: 'u', usd: days(371, '2024-12-30', (d) => (d.startsWith('2025-01') ? 200 : 100)) };

describe('isoWeek / weekStart', () => {
  it('matches RSI week keys', () => {
    expect(isoWeek('2026-11-16')).toBe('2026-47');
    expect(isoWeek('2026-11-22')).toBe('2026-47');
    expect(isoWeek('2024-12-30')).toBe('2025-01');
    expect(isoWeek('2021-01-03')).toBe('2020-53');
    expect(weekStart('2026-47')).toBe('2026-11-16');
    expect(weekStart('2025-01')).toBe('2024-12-30');
  });
});

describe('recordFunding', () => {
  it('merges points per range, newer wins', () => {
    let log = recordFunding(null, { range: 'day', points: [{ key: '2026-01-05', label: '05', usd: 5 }] });
    log = recordFunding(log, { range: 'day', points: [{ key: '2026-01-05', label: '05', usd: 6 }, { key: '2026-01-06', label: '06', usd: 7 }] });
    expect(log.day).toEqual({ '2026-01-05': 6, '2026-01-06': 7 });
    expect(log.month).toEqual({});
  });
});

describe('dayHistory', () => {
  it('extends the bundle with recorded days and tracks the unbroken run', () => {
    const log = { ...emptyLog(), day: { '2026-01-04': 999, '2026-01-05': 50, '2026-01-06': 60, '2026-01-09': 90 } };
    const d = dayHistory(log, H);
    expect(d.map.get('2026-01-04')).toBe(100); // bundle wins on overlap
    expect(d.contiguous).toBe('2026-01-06');
    expect(d.last).toBe('2026-01-09');
    expect(d.total).toBe(H.usd.reduce((a, b) => a + b, 0) + 110);
  });
});

describe('series', () => {
  const d = dayHistory(null, H);
  it('sums complete months only', () => {
    const m = series(d, 'month');
    expect(m[0]).toMatchObject({ key: '2024-12', usd: 200 }); // starts mid-month: counted from the first day
    expect(m.find((p) => p.key === '2025-01')?.usd).toBe(6200);
    expect(m.at(-1)?.key).toBe('2025-12'); // Jan 2026 not over
  });
  it('fills a month the days do not cover from what RSI reported', () => {
    const log = { ...emptyLog(), month: { '2026-01': 3100 } };
    expect(series(d, 'month', log).at(-1)).toMatchObject({ key: '2026-01', usd: 3100 });
  });
  it('weeks are ISO and complete', () => {
    const w = series(d, 'week');
    expect(w[0]).toMatchObject({ key: '2025-01', usd: 700 + 500 }); // Mon 30 Dec, Tue 31 Dec at 100, then 5 Jan days at 200
    expect(w.at(-1)?.key).toBe('2026-01'); // 2025-12-29 … 2026-01-04
  });
  it('years: the current one is partial and left out', () => {
    expect(series(d, 'year').map((p) => p.key)).toEqual(['2024', '2025']);
  });
});

describe('runningPeriod / elapsed', () => {
  const d = dayHistory(null, H);
  const now = new Date('2026-01-05T12:00:00Z');
  it('live total minus counted days = today so far; month to date adds its days', () => {
    expect(runningPeriod(d, d.total + 40, 'day', now)).toEqual({ key: '2026-01-05', usd: 40, since: '2026-01-05' });
    expect(runningPeriod(d, d.total + 40, 'month', now)?.usd).toBe(440);
  });
  it('null when yesterday is missing', () => {
    expect(runningPeriod(d, d.total + 40, 'day', new Date('2026-01-07T12:00:00Z'))).toBeNull();
  });
  it('elapsed is the share of the period gone', () => {
    expect(elapsed('day', now)).toBeCloseTo(0.5);
  });
});

describe('yearTable', () => {
  it('YoY on full years, year-to-date on the running one', () => {
    const d = dayHistory(null, H);
    const rows = yearTable(d, d.total + 40, new Date('2026-01-05T12:00:00Z'));
    const y25 = rows.find((r) => r.year === 2025)!;
    expect(y25).toMatchObject({ usd: 36500 + 3100, partial: false });
    expect(y25.delta).toBeNull(); // 2024 is partial (starts 30 Dec)
    const y26 = rows.find((r) => r.year === 2026)!;
    expect(y26.partial).toBe(true);
    expect(y26.usd).toBe(440);
    expect(y26.ytd).toMatchObject({ prev: 1000, delta: -560, through: '2026-01-05' });
  });
});

describe('monthOverlay', () => {
  it('one column per year, cumulative optional', () => {
    const d = dayHistory(null, H);
    const flat = monthOverlay(d, [2025, 2026], false);
    expect(flat[0]).toMatchObject({ m: 1, label: 'Jan', y2025: 6200, y2026: 400 });
    expect(flat[1]!.y2026).toBeUndefined();
    const cum = monthOverlay(d, [2025], true);
    expect(cum[1]!.y2025).toBe(6200 + 2800);
    expect(cum[11]!.y2025).toBe(39600);
  });
});

describe('bundled history', () => {
  it('is sane: starts at the tracker start, years add up to ~$1B by 2026', () => {
    expect(bundled.start).toBe('2012-11-13');
    const total = bundled.usd.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(1e9);
    const rows = yearTable(dayHistory(null));
    expect(rows.find((r) => r.year === 2022)?.usd).toBeGreaterThan(100e6);
    expect(rows.find((r) => r.year === 2016)?.pct).toBeGreaterThan(-0.2);
  });
});
