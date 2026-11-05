#!/usr/bin/env node
// Generates pnl-data.js with made-up trades for the 4 family accounts (PEW and JPW, Angel One and Zerodha).
// The FIFO matcher and charge estimate here are the same logic the daily Lambda will use on real trades.
// Usage: node tools/make-sample-data.js [asOf=2026-11-05]
'use strict';
const fs = require('fs');
const path = require('path');

const AS_OF = process.argv[2] || '2026-11-05';
const START = '2024-04-01';

// ---------- seeded random ----------
let seed = 20261105;
const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = a => a[Math.floor(rnd() * a.length)];
const between = (a, b) => a + rnd() * (b - a);

// ---------- accounts ----------
const people = [
  { id: 'PEW', name: 'PEW' },
  { id: 'JPW', name: 'JPW' },
];
const accounts = [
  { id: 'PEW-ANGEL', person: 'PEW', broker: 'Angel One', label: 'PEW · Angel' },
  { id: 'PEW-ZERODHA', person: 'PEW', broker: 'Zerodha', label: 'PEW · Zerodha' },
  { id: 'JPW-ANGEL', person: 'JPW', broker: 'Angel One', label: 'JPW · Angel' },
  { id: 'JPW-ZERODHA', person: 'JPW', broker: 'Zerodha', label: 'JPW · Zerodha' },
];

// ---------- stocks: symbol, ISIN, starting price ----------
const STOCKS = [
  ['RELIANCE', 'INE002A01018', 2900], ['TCS', 'INE467B01029', 3900], ['HDFCBANK', 'INE040A01034', 1530],
  ['INFY', 'INE009A01021', 1420], ['ICICIBANK', 'INE090A01021', 1080], ['SBIN', 'INE062A01020', 760],
  ['ITC', 'INE154A01025', 430], ['LT', 'INE018A01030', 3600], ['TITAN', 'INE280A01028', 3550],
  ['BAJFINANCE', 'INE296A01024', 6900], ['ASIANPAINT', 'INE021A01026', 2850], ['MARUTI', 'INE585B01010', 12300],
  ['SUNPHARMA', 'INE044A01036', 1530], ['TATAMOTORS', 'INE155A01022', 990], ['NTPC', 'INE733E01010', 360],
  ['POWERGRID', 'INE752E01010', 290], ['COALINDIA', 'INE522F01014', 450], ['HAL', 'INE066F01020', 3900],
  ['BEL', 'INE263A01024', 230], ['IRCTC', 'INE335Y01020', 980], ['DMART', 'INE192R01011', 4700],
  ['ABBOTINDIA', 'INE358A01014', 27000], ['ADANIGREEN', 'INE364U01010', 1800], ['ATLANTAELE', 'INE0RKH01013', 850],
  ['NIFTYBEES', 'INF204KB14I2', 245], ['GOLDBEES', 'INF204KC1402', 58],
];

// ---------- trading days and prices ----------
const iso = d => d.toISOString().slice(0, 10);
const days = [];
for (let d = new Date(START + 'T00:00:00Z'); iso(d) <= AS_OF; d.setUTCDate(d.getUTCDate() + 1)) {
  const wd = d.getUTCDay();
  if (wd !== 0 && wd !== 6) days.push(iso(d));
}
const price = {}; // price[symbol][date] = close
for (const [s, , p0] of STOCKS) {
  let p = p0; const drift = between(-0.0002, 0.0009); price[s] = {};
  for (const d of days) { p *= 1 + drift + (rnd() - 0.5) * 0.034; price[s][d] = p; }
}
const r2 = x => Math.round(x * 100) / 100;
const tradePrice = (s, d) => r2(price[s][d] * between(0.992, 1.008));

// ---------- charges (estimates, delivery equity; rates as of 2026 — keep in config later) ----------
const RATES = {
  stt: 0.001, sttIntraSell: 0.00025, exch: 0.0000297, sebi: 0.000001,
  stampDelivery: 0.00015, stampIntra: 0.00003, gst: 0.18,
  dp: { Zerodha: 15.34, 'Angel One': 23.6 },          // per scrip per sell day, incl. GST
  brokerage: { Zerodha: () => 0, 'Angel One': v => Math.min(20, v * 0.001) }, // per order
};
function charges(broker, buys, sells) {
  let total = 0;
  const sellSymbols = new Set();
  for (const b of buys) {
    const v = b.q * b.p, br = RATES.brokerage[broker](v), ex = v * (RATES.exch + RATES.sebi);
    total += br + ex + (br + ex) * RATES.gst + v * RATES.stt + v * RATES.stampDelivery;
  }
  for (const s of sells) {
    const v = s.q * s.p, br = RATES.brokerage[broker](v), ex = v * (RATES.exch + RATES.sebi);
    const intra = s.lots.every(l => l.t === 'IN');
    total += br + ex + (br + ex) * RATES.gst + v * (intra ? RATES.sttIntraSell : RATES.stt);
    if (!intra) sellSymbols.add(s.s);
  }
  total += sellSymbols.size * RATES.dp[broker];
  return r2(total);
}

// ---------- FIFO ----------
// Same-day buys are matched first (intraday), then the oldest open lots. A lot is long-term when
// it was held for more than 12 months.
function isLongTerm(buyDate, sellDate) {
  const b = new Date(buyDate + 'T00:00:00Z'); b.setUTCFullYear(b.getUTCFullYear() + 1);
  return sellDate > iso(b);
}
function matchSell(queue, todaysBuys, qty, sellDate) {
  const lots = [];
  let left = qty;
  for (const lot of todaysBuys) {
    if (!left) break;
    const take = Math.min(left, lot.q - lot.used);
    if (take > 0) { lot.used += take; left -= take; lots.push({ d: sellDate, q: take, p: lot.p, t: 'IN' }); }
  }
  while (left > 0 && queue.length) {
    const lot = queue[0];
    const take = Math.min(left, lot.q);
    lots.push({ d: lot.d, q: take, p: lot.p, t: isLongTerm(lot.d, sellDate) ? 'LT' : 'ST' });
    lot.q -= take; left -= take;
    if (!lot.q) queue.shift();
  }
  if (left) throw new Error(`short sell ${qty} on ${sellDate}`);
  return lots;
}

// ---------- simulate ----------
const records = [];
const books = {}; // books[account][symbol] = [{d,q,p}]
for (const a of accounts) {
  books[a.id] = {};
  const universe = STOCKS.filter(() => rnd() < 0.55).map(x => x[0]);
  const activity = between(0.22, 0.32);
  for (const d of days) {
    const forceToday = d === AS_OF && a.id !== 'JPW-ZERODHA';
    if (!forceToday && rnd() > activity) continue;
    const book = books[a.id];
    const buys = [], sells = [];
    const todays = {};
    // buys
    const nBuys = forceToday ? 1 + Math.floor(rnd() * 3) : Math.floor(rnd() * 3);
    for (let i = 0; i < nBuys; i++) {
      const s = pick(universe), p = tradePrice(s, d);
      const q = Math.max(1, Math.round(between(8000, 60000) / p));
      buys.push({ s, q, p });
      (todays[s] = todays[s] || []).push({ q, p, used: 0 });
    }
    // sells: from holdings, sometimes partial; rarely intraday
    const held = Object.keys(book).filter(s => book[s].reduce((x, l) => x + l.q, 0) > 0);
    const nSells = forceToday ? 1 + Math.floor(rnd() * 3) : (rnd() < 0.3 ? 1 + Math.floor(rnd() * 2) : 0);
    const sold = new Set();
    for (let i = 0; i < nSells && held.length; i++) {
      const s = pick(held);
      if (sold.has(s)) continue; sold.add(s);
      const have = book[s].reduce((x, l) => x + l.q, 0);
      const q = rnd() < 0.55 ? have : Math.max(1, Math.round(have * between(0.3, 0.8)));
      const p = tradePrice(s, d);
      sells.push({ s, q, p, lots: matchSell(book[s], todays[s] || [], q, d) });
    }
    if (rnd() < 0.04 && buys.length) { // intraday round trip
      const b = buys[0], p = r2(b.p * between(0.985, 1.02));
      sells.push({ s: b.s, q: b.q, p, lots: matchSell(book[b.s] || [], todays[b.s], b.q, d) });
    }
    // remaining buys become open lots
    for (const [s, list] of Object.entries(todays)) for (const l of list) if (l.q > l.used) (book[s] = book[s] || []).push({ d, q: l.q - l.used, p: l.p });
    if (!buys.length && !sells.length) continue;
    for (const x of sells) x.gross = r2(x.lots.reduce((g, l) => g + (x.p - l.p) * l.q, 0));
    const gross = r2(sells.reduce((g, x) => g + x.gross, 0));
    const ch = charges(a.broker, buys, sells);
    records.push({ date: d, account: a.id, buys, sells, gross, charges: ch, net: r2(gross - ch) });
  }
}
records.sort((x, y) => x.date.localeCompare(y.date) || x.account.localeCompare(y.account));

const holdings = [];
for (const a of accounts) for (const [s, lots] of Object.entries(books[a.id])) {
  const open = lots.filter(l => l.q > 0);
  if (open.length) holdings.push({ account: a.id, s, lots: open, ltp: r2(price[s][AS_OF]) });
}

// One login failure on an earlier day (so that day has no data for JPW · Zerodha) and one holdings mismatch today.
const loginDay = days[days.length - 8];
const warnings = [
  { date: AS_OF, account: 'PEW-ZERODHA', level: 'warn', text: 'IRCTC: FIFO says 40 shares, Zerodha holdings say 80. A 1:1 bonus may be missing from Adjustments.' },
  { date: loginDay, account: 'JPW-ZERODHA', level: 'error', text: 'Kite login failed, so this day has no trades for JPW · Zerodha. Tap the login link in that day\'s message to fetch them.' },
];
for (let i = records.length - 1; i >= 0; i--) if (records[i].date === loginDay && records[i].account === 'JPW-ZERODHA') records.splice(i, 1);

// Views shown as the top filter. PEW's accounts are a 50:50 partnership between Anup and DD; JPW's belong to DD.
const views = [
  { id: 'PEW', name: 'PEW', shares: { 'PEW-ANGEL': 1, 'PEW-ZERODHA': 1 } },
  { id: 'JPW', name: 'JPW', shares: { 'JPW-ANGEL': 1, 'JPW-ZERODHA': 1 } },
  { id: 'ANUP', name: 'Anup', shares: { 'PEW-ANGEL': 0.5, 'PEW-ZERODHA': 0.5 } },
  { id: 'DD', name: 'DD', shares: { 'JPW-ANGEL': 1, 'JPW-ZERODHA': 1, 'PEW-ANGEL': 0.5, 'PEW-ZERODHA': 0.5 } },
];
const data = {
  version: 1, sample: true, generatedAt: new Date().toISOString(), asOf: AS_OF,
  people, accounts, views, records, holdings, warnings,
  notes: 'Charges are estimates. Long-term = held more than 12 months. Intraday = bought and sold the same day.',
};
const out = path.join(__dirname, '..', 'pnl-data.js');
fs.writeFileSync(out, '// Generated by tools/make-sample-data.js — SAMPLE DATA, not real trades.\nwindow.PNL_DATA = ' + JSON.stringify(data) + ';\n');
console.log(`${records.length} day-records, ${records.reduce((n, r) => n + r.buys.length + r.sells.length, 0)} trades, ${holdings.length} open positions -> ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
