/* eslint-env node */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extract(startText, endText, name) {
  const start = html.indexOf(startText);
  const end = html.indexOf(endText, start);
  assert.ok(start >= 0 && end >= 0, `${name} was not found in index.html`);
  const box = { module: { exports: {} }, exports: {}, console, Date, Math, JSON, Set, Map, Number, String };
  vm.runInNewContext(html.slice(start, end + endText.length), box, { filename: `index.html#${name}` });
  return box.module.exports;
}

const Calculator = extract(
  'const BookThreeSecondCalculator =',
  "if (typeof module !== 'undefined') module.exports = BookThreeSecondCalculator;",
  'BookThreeSecondCalculator',
);
const Audit = extract(
  'const BookStatisticsAudit =',
  "if(typeof globalThis!=='undefined')globalThis.BookStatisticsAudit=BookStatisticsAudit;",
  'BookStatisticsAudit',
);

const session = { id: 'gross-net-test', code: '600000', day: '2026-01-02', started_at: '2026-01-02T09:30:00+08:00' };
const t = (seconds, millis = 0) => new Date(Date.parse(session.started_at) + seconds * 1000 + millis).toISOString();
const prices = { bid: [100, 99, 98, 97, 96], ask: [101, 102, 103, 104, 105] };

function rows(volumes = {}) {
  return ['bid', 'ask'].flatMap(side => prices[side].map((price, i) => ({
    side, level: i + 1, price, volume: Number(volumes[`${side}:${price}`] ?? 100),
  })));
}
function depth(receivedAt, volumes = {}, extra = {}) {
  return { kind: 'depth', session_id: session.id, code: session.code, segment_id: 'seg-1', received_at: receivedAt, payload: { rows: rows(volumes) }, ...extra };
}
function response(receivedAt, id = `response-${receivedAt}`) {
  return { kind: 'tick_response', session_id: session.id, code: session.code, segment_id: 'seg-1', received_at: receivedAt, id, row_count: 0, payload: { rows: [] }, payload_metadata: { bounds: { mode: 'available-day', day: session.day } } };
}
function tick(receivedAt, tradeTime, volume, id, price = 100) {
  return { id, code: session.code, first_received_at: receivedAt, row: { time: tradeTime, price, volume } };
}
function calculate(events, ticks = [], cutoff = Infinity) {
  return Calculator.calculate(events, ticks, session, cutoff);
}
function windows(result) { return Array.isArray(result?.windows) ? result.windows : []; }
function levels(result) {
  const out = [];
  for (const w of windows(result)) for (const key of ['levels', 'rows', 'details', 'reconciliation']) {
    if (Array.isArray(w[key])) out.push(...w[key]);
  }
  return out.concat(Array.isArray(result?.reconciliation) ? result.reconciliation : []);
}
function level(result, side, price) {
  return levels(result).find(x => x.side === side && Number(x.price) === price);
}
function metric(result, side, field) {
  const source = windows(result).length ? windows(result) : (Array.isArray(result?.timeline) ? result.timeline : []);
  return source.reduce((sum, w) => sum + Number(w?.[side]?.[field] ?? 0), 0);
}
function assertField(value, expected, label) { assert.equal(Number(value), expected, label); }
function assertGrossFields(x, expected, label) {
  for (const [field, value] of Object.entries(expected)) assertField(x?.[field], value, `${label}.${field}`);
}

function canonicalEvents() {
  // One settled update: A=100 lots (10,000 shares), then R=1 lot (100 shares), T=100 lots.
  return [
    depth(t(0)),
    depth(t(1), { 'bid:100': 10100 }),
    depth(t(1, 200), { 'bid:100': 10000 }),
    response(t(2)),
  ];
}

test('gross addition does not absorb max(0,T-R); signed adjustment yields net +19,900', () => {
  const events = canonicalEvents();
  const ticks = [tick(t(1, 500), t(1, 400), 10000, 'trade-100-lots')];
  const result = calculate(events, ticks);
  assert.ok(windows(result).length >= 1);
  const w = windows(result)[0];
  assertGrossFields(w.bid, {
    added_shares: 10000,
    cancellation_shares: 0,
    signed_cancellation_shares: -9900,
    cancellation_adjustment_shares: -9900,
    net_change_shares: 19900,
    denominator_trade_shares: 10000,
    addition_rate_pct: 100,
    reduction_rate_pct: 0,
    net_addition_rate_pct: 199,
  }, 'window.bid');
  assertGrossFields(level(result, 'bid', 100), {
    added_shares: 10000,
    cancellation_shares: 0,
    signed_cancellation_shares: -9900,
    cancellation_adjustment_shares: -9900,
    net_change_shares: 19900,
  }, 'level bid@100');
  const timeline = result.timeline?.at(-1);
  assertGrossFields(timeline?.bid, {
    added_shares: 10000,
    cancellation_shares: 0,
    signed_cancellation_shares: -9900,
    cancellation_adjustment_shares: -9900,
    net_change_shares: 19900,
    denominator_trade_shares: 10000,
  }, 'timeline.bid');
});

test('one update and two updates accumulate A/R/T with the same formula', () => {
  const one = calculate([
    depth(t(0)), depth(t(1), { 'bid:100': 10100 }), depth(t(1, 200), { 'bid:100': 10000 }), response(t(2)),
  ], [tick(t(1, 500), t(1, 400), 10000, 'one')]);
  const two = calculate([
    depth(t(0)), depth(t(1), { 'bid:100': 10100 }), response(t(1, 500)),
    depth(t(2), { 'bid:100': 10000 }), response(t(2, 500)),
  ], [tick(t(1, 400), t(1, 300), 10000, 'two-a'), tick(t(2, 400), t(2, 300), 0, 'two-b')]);
  for (const [name, result] of [['one', one], ['two', two]]) {
    assert.equal(metric(result, 'bid', 'added_shares'), 10000, `${name}: A`);
    assert.equal(metric(result, 'bid', 'cancellation_shares'), name === 'two' ? 100 : 0, `${name}: cancel`);
    assert.equal(metric(result, 'bid', 'signed_cancellation_shares'), -9900, `${name}: signed`);
    assert.equal(metric(result, 'bid', 'cancellation_adjustment_shares'), name === 'two' ? -10000 : -9900, `${name}: adjustment`);
    assert.equal(metric(result, 'bid', 'net_change_shares'), 19900, `${name}: net`);
  }
  assert.equal(two.timeline.at(-1).bid.denominator_trade_shares, 10000);
});

test('ordinary R>=T, T=0, all five levels, and both sides stay per-level with no cross-level cancellation', () => {
  const vols1 = {};
  const vols2 = {};
  for (const side of ['bid', 'ask']) for (const price of prices[side]) {
    vols1[`${side}:${price}`] = 100;
    vols2[`${side}:${price}`] = 100;
  }
  // Bid level 1: R=8, T=5. Bid level 2: A=2, T=0. Ask level 1: A=3, T=0.
  vols2['bid:100'] = 92;
  vols2['bid:99'] = 102;
  vols2['ask:101'] = 103;
  const ticks = [
    tick(t(1, 500), t(1, 400), 5, 'bid-trade', 100),
  ];
  const result = calculate([depth(t(0), vols1), depth(t(1), vols2), response(t(2))], ticks);
  assertGrossFields(level(result, 'bid', 100), { added_shares: 0, cancellation_shares: 3, signed_cancellation_shares: 3, cancellation_adjustment_shares: 0, net_change_shares: -3 }, 'bid@100');
  assertGrossFields(level(result, 'bid', 99), { added_shares: 2, cancellation_shares: 0, signed_cancellation_shares: 0, cancellation_adjustment_shares: 0, net_change_shares: 2 }, 'bid@99');
  assertGrossFields(level(result, 'ask', 101), { added_shares: 3, cancellation_shares: 0, signed_cancellation_shares: 0, cancellation_adjustment_shares: 0, net_change_shares: 3 }, 'ask@101');
  for (const side of ['bid', 'ask']) for (const price of prices[side].slice(1)) {
    const x = level(result, side, price);
    assert.ok(x, `${side}@${price} must be represented`);
    assertField(x.cancellation_adjustment_shares, 0, `${side}@${price} adjustment`);
  }
  assert.equal(metric(result, 'bid', 'denominator_trade_shares'), 5);
  assert.equal(metric(result, 'ask', 'denominator_trade_shares'), 5);
});

test('cutoff excludes later settled updates while retaining earlier gross/net history', () => {
  const events = [
    depth(t(0)), depth(t(1), { 'bid:100': 110 }), response(t(1, 500)),
    depth(t(3), { 'bid:100': 105 }), response(t(3, 500)),
  ];
  const ticks = [tick(t(1, 200), t(1), 5, 'early'), tick(t(3, 200), t(3), 5, 'late')];
  const historical = calculate(events, ticks, Date.parse(t(2)));
  assert.equal(metric(historical, 'bid', 'added_shares'), 10);
  assert.equal(metric(historical, 'bid', 'cancellation_shares'), 0);
  assert.equal(metric(historical, 'bid', 'net_change_shares'), 15);
  assert.equal(historical.source_trade_volume_shares, 5);
});

test('prior settled 100-lot gross addition stays 100 after later R=1 lot and T=100 lots', () => {
  const events=[depth(t(0)),depth(t(1),{'bid:100':10100}),response(t(1,500)),depth(t(2),{'bid:100':10000})];
  const result=calculate(events,[tick(t(2,500),t(2),10000,'later-trade')]);
  assertGrossFields(result.timeline[0].bid,{added_shares:10000,net_change_shares:10000},'prior');
  assertGrossFields(result.windows[1].bid,{added_shares:0,cancellation_shares:0,signed_cancellation_shares:-9900,cancellation_adjustment_shares:-9900,net_change_shares:9900},'later');
  assertGrossFields(result.timeline.at(-1).bid,{added_shares:10000,cancellation_shares:0,cancellation_adjustment_shares:-9900,net_change_shares:19900,addition_rate_pct:100,net_addition_rate_pct:199},'cumulative');
});

test('positive cancellations on other prices cannot be offset out of the gross cancellation numerator', () => {
  const result=calculate([depth(t(0)),depth(t(1),{'bid:100':99,'bid:99':92,'ask:101':99,'ask:102':92})],[tick(t(1,500),t(1),100,'bid',100),tick(t(1,500),t(1),100,'ask',101)]);
  for(const side of ['bid','ask'])assertGrossFields(result.windows[0][side],{added_shares:0,cancellation_shares:8,signed_cancellation_shares:-91,cancellation_adjustment_shares:-99,net_change_shares:91,denominator_trade_shares:200},side);
});

test('calculator does not mutate or serialize-drift frozen raw inputs', () => {
  const events = canonicalEvents();
  const ticks = [tick(t(1, 500), t(1, 400), 10000, 'immutable')];
  const before = JSON.stringify({ events, ticks });
  const freeze = value => { if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } return value; };
  freeze(events); freeze(ticks);
  calculate(events, ticks);
  assert.equal(JSON.stringify({ events, ticks }), before);
});

test('independent audit passes and identifies tampered adjustment or net', () => {
  const events = canonicalEvents();
  const ticks = [tick(t(1, 500), t(1, 400), 10000, 'audit')];
  const result = calculate(events, ticks);
  const audit = Audit.calculate(events, ticks, session, result);
  assert.ok(audit.windows.length >= 1);
  assert.equal(audit.windows[0].status, 'pass', JSON.stringify(audit));
  const adjustment = result.windows[0].bid.cancellation_adjustment_shares;
  result.windows[0].bid.cancellation_adjustment_shares = adjustment + 1;
  const alteredAdjustment = Audit.calculate(events, ticks, session, result);
  assert.ok(alteredAdjustment.windows.some(w => w.status === 'mismatch'), JSON.stringify(alteredAdjustment));
  result.windows[0].bid.cancellation_adjustment_shares = adjustment;
  result.windows[0].bid.net_change_shares += 1;
  const alteredNet = Audit.calculate(events, ticks, session, result);
  assert.ok(alteredNet.windows.some(w => w.status === 'mismatch'), JSON.stringify(alteredNet));
});
