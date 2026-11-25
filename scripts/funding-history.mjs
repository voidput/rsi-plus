// Builds src/lib/data/funding-history.json: Star Citizen's pledged USD per UTC day since the campaign began, so the
// Wallet funding chart can go past the 7 periods RSI's `getCrowdfundStats` returns and compare years. Source: the
// community funding tracker spreadsheet 3.0 (ccugame.app), which logs RSI's public counter (hourly since 2023, daily
// before). Each day = the day's last running total − the previous logged day's; a day the tracker missed is 0 and its
// money lands on the next logged day. The first day holds everything raised before the tracker started (Oct 2012 on).
// RSI+ fetches nothing from the sheet at run time; days after `through` come from RSI's own API (recorded as seen).
//   node scripts/funding-history.mjs [out.json]    (default: src/lib/data/funding-history.json, from any directory)
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SHEET = '1n96sotjICGR8pw7SL74KTwrCHO6hoqRuAc2Y_fbIJaA';
const URL_CSV = `https://docs.google.com/spreadsheets/d/${SHEET}/export?format=csv&gid=0`;
const out = process.argv[2] ?? fileURLToPath(new URL('../src/lib/data/funding-history.json', import.meta.url));

/** Minimal RFC 4180 reader (quoted fields with commas). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let f = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') (f += '"'), i++;
      else if (c === '"') q = false;
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') row.push(f), (f = '');
    else if (c === '\n') row.push(f), rows.push(row), (row = []), (f = '');
    else if (c !== '\r') f += c;
  }
  if (f || row.length) row.push(f), rows.push(row);
  return rows;
}
/** `$1.085.906.419` (German grouping) → 1085906419; anything else → null. */
const dollars = (s) => {
  const t = (s ?? '').replace(/[$\s]/g, '').split(',')[0].replace(/\./g, '');
  return /^\d+$/.test(t) ? Number(t) : null;
};

const res = await fetch(URL_CSV, { headers: { 'User-Agent': 'rsi-plus funding-history (github.com/voidput/rsi-plus)' } });
if (!res.ok) throw new Error(`funding sheet: HTTP ${res.status}`);
const rows = parseCsv(await res.text());
if (!/datetime/i.test(rows[0]?.[0] ?? '')) throw new Error(`funding sheet: unexpected header ${JSON.stringify(rows[0]?.slice(0, 3))}`);

/** UTC day → last running total logged that day (the "Data Correction" column wins when filled). */
const last = new Map();
let skipped = 0;
let swapped = 0;
/** Rows are in time order, but many 2013–14 dates have day and month swapped (`2013-01-12` for 1 Dec). Each row
 *  takes whichever reading (as written or swapped) lands nearest on or after the previous row. */
let prevDay = '';
const gap = (d) => (Number.isNaN(Date.parse(d)) ? Infinity : d < prevDay ? Infinity : Date.parse(d) - Date.parse(prevDay || d));
for (const r of rows.slice(1)) {
  let day = r[0]?.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? '')) continue;
  const alt = `${day.slice(0, 4)}-${day.slice(8, 10)}-${day.slice(5, 7)}`;
  if (prevDay && alt !== day && gap(alt) < gap(day)) (day = alt), swapped++;
  if (prevDay && day < prevDay) {
    skipped++; // neither reading fits the order
    continue;
  }
  prevDay = day;
  const v = dollars(r[6]) ?? dollars(r[1]);
  if (v == null) {
    skipped++;
    continue;
  }
  last.set(day, v);
}
const days = [...last.keys()].sort();
if (days.length < 3000) throw new Error(`funding sheet: only ${days.length} days`);

const DAY = 86_400_000;
const start = days[0];
const end = days.at(-1);
const n = Math.round((Date.parse(end) - Date.parse(start)) / DAY) + 1;
const usd = new Array(n).fill(0);
let prev = 0;
for (const d of days) {
  const v = last.get(d);
  usd[Math.round((Date.parse(d) - Date.parse(start)) / DAY)] = v - prev;
  prev = v;
}
// The last day is usually still running when the sheet is read: leave it to RSI's API.
const through = new Date(Date.parse(end) - DAY).toISOString().slice(0, 10);
usd.pop();
const body = { source: 'Star Citizen funding tracker 3.0 (ccugame.app)', url: `https://docs.google.com/spreadsheets/d/${SHEET}`, start, through, total: usd.reduce((a, b) => a + b, 0), usd };
writeFileSync(out, JSON.stringify(body).replace('"usd":[', '"usd":[\n') + '\n');
console.log(`wrote ${usd.length} days ${start} → ${through} (${skipped} unparsable rows skipped, ${swapped} day/month swaps fixed) to ${out}`);
