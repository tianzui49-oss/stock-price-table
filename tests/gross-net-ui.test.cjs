'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { indexedDB, IDBKeyRange } = require('fake-indexeddb');

const html = fs.readFileSync(__dirname + '/../index.html', 'utf8');
const body = html.replace(/<script[\s\S]*?<\/script>/gi, '');
let main = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].at(-1)[1];
// Expose the recorder's database helper for the byte-for-byte persistence check.
main = main.replace(
  'return { capture, refresh, compare, begin, pause, heartbeat, viewAt, exportData, syncWatchlist, setPaused,',
  'return { __test: { db, caches, sessions, recompute }, capture, refresh, compare, begin, pause, heartbeat, viewAt, exportData, syncWatchlist, setPaused,'
);

const base = Date.parse('2026-10-22T01:31:00Z');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const rows = (n = 0) => ['bid', 'ask'].flatMap(side => [1, 2, 3, 4, 5].map(level => ({
  side, level, price: side === 'bid' ? 10 - (level - 1) / 10 : 10 + level / 10,
  // Keep the initial visible book comfortably nonzero; all changes stay legal.
  volume: side === 'bid' && level === 1 ? 1000 + n : 1000,
})));

(async () => {
  const dom = new JSDOM(body, { url: 'https://test.invalid/', runScripts: 'outside-only', pretendToBeVisual: true });
  try {
    const w = dom.window;
    Object.assign(w, { indexedDB, IDBKeyRange, __now: base });
    w.eval(`const NativeDate=Date;Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[window.__now]));}static now(){return window.__now;}};`);
    w.setInterval = () => 0; w.clearInterval = () => {};
    const downloads = [];
    w.Blob = class MockBlob { constructor(parts, options) { this.parts = parts; this.type = options?.type; } };
    w.URL.createObjectURL = blob => { const text = blob.parts.map(String).join(''); downloads.push({ text, type: blob.type }); return `blob:test-${downloads.length}`; };
    w.URL.revokeObjectURL = () => {};
    const payload = (kind, n = 0, ticks = []) => ({ source: 'THSDK', code: '600000', fetched_at: new w.Date().toISOString(), bounds: { mode: 'available-day', day: '2026-10-22' }, rows: kind === 'depth' ? rows(n) : ticks });
    w.fetch = async url => ({ ok: true, json: async () => payload(String(url).includes('/api/depth') ? 'depth' : 'ticks') });
    w.eval(main + '\nwindow.api={state,bookRecorder};marketPhase=()=>({open:true,label:"交易时段",day:"2026-10-22"});');
    const { state, bookRecorder } = w.api;
    const $ = id => w.document.getElementById(id);
    const text = id => $(id).textContent;
    state.code = '600000'; state.chartDate = '2026-10-22';
    await bookRecorder.begin('600000'); await wait(50);
    const capture = async (kind, n = 0, ticks = []) => { bookRecorder.capture(kind, payload(kind, n, ticks)); await wait(70); };

    // Baseline 1,000 shares, +10,000, then -100 at the same bid price, followed by 10,000 traded.
    w.__now = base + 1000; await capture('depth', 0);
    w.__now = base + 2000; await capture('depth', 10000);
    w.__now = base + 2500; await capture('depth', 9900);
    w.__now = base + 3000; await capture('ticks', 0, [{ time: (base + 2600) / 1000, price: 10, volume: 10000 }]);

    assert.match(text('bookBidAdditionDetail'), /加单 100 手/);
    assert.match(text('bookBidAdditionDetail'), /撤单 0 手/);
    assert.match(text('bookBidAdditionDetail'), /撤单侧负差额调整 -99 手/);
    assert.match(text('bookBidAdditionDetail'), /净加单 199 手/);
    assert.match(text('bookThreeRows'), /100\.00/);
    assert.match(text('bookThreeRows'), /199\.00/);
    assert.match(text('bookAuditStatus'), /差异 0 窗/);
    assert.match(text('bookThreeRows'), /逐档增减与净加单率/);
    assert.match(text('bookThreeRows'), /100/);

    const H = bookRecorder.__test;
    const db = await H.db();
    const dump = async () => {
      const out = {};
      for (const name of ['events', 'ticks', 'latest']) out[name] = await new Promise((resolve, reject) => {
        const request = db.transaction(name).objectStore(name).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return JSON.stringify(out);
    };
    const beforeDb = await dump();
    const beforeMemory = JSON.stringify({ events: H.caches.get('600000').events, ticks: [...H.caches.get('600000').ticks.values()] });
    const clickExport = async id => { downloads.length = 0; $(id).click(); await wait(30); assert.equal(downloads.length, 1, `${id} should download once`); return downloads[0]; };

    const jsonDownload = await clickExport('bookRecordJSON');
    const json = JSON.parse(jsonDownload.text);
    assert.equal(json.schema_version, 11);
    assert.equal(json.calculation.net_change, 'added_shares - cancellation_shares - cancellation_adjustment_shares');
    assert.equal(json.calculation.net_addition_ratio, 'net_change_shares / denominator_trade_shares * 100');
    const grossWindow = json.statistics.windows.find(window => window.bid.added_shares === 10000);
    assert.ok(grossWindow, 'JSON must retain the settled gross/net window');
    assert.equal(grossWindow.bid.cancellation_shares, 0);
    assert.equal(grossWindow.bid.cancellation_adjustment_shares, -9900);
    assert.equal(grossWindow.bid.net_change_shares, 19900);
    assert.equal(json.events.length, H.caches.get('600000').events.length);
    assert.equal(json.ticks.length, H.caches.get('600000').ticks.size);
    assert.equal(JSON.stringify({ events: json.events, ticks: json.ticks }), beforeMemory);

    const three = await clickExport('bookStatsCSV'); // stats is separately asserted below; button is stats.
    assert.match(three.text, /撤单侧有符号差额股/);
    assert.match(three.text, /撤单侧负差额调整股（仅净量）/);
    assert.match(three.text, /19900/);
    assert.match(three.text, /-9900/);
    // The three-second CSV is exposed through the recorder API (not the stats button).
    downloads.length = 0; await bookRecorder.exportData('three'); await wait(30);
    assert.equal(downloads.length, 1);
    assert.match(downloads[0].text, /买盘净加单率百分比/);
    assert.match(downloads[0].text, /买盘撤单侧负差额调整股（仅净量）/);
    assert.match(downloads[0].text, /19900/);
    assert.match(downloads[0].text, /-9900/);

    const changes = await clickExport('bookRecordCSV');
    assert.match(changes.text, /净变化股/);
    assert.match(changes.text, /10000/);
    assert.match(changes.text, /-100/);

    assert.equal(await dump(), beforeDb, 'exports must not rewrite events/ticks/latest');
    assert.equal(JSON.stringify({ events: H.caches.get('600000').events, ticks: [...H.caches.get('600000').ticks.values()] }), beforeMemory);
    console.log('PASS gross/net UI, audit, per-level detail, schema-11 JSON, three/stats/changes CSV, and raw export/database immutability');
  } finally { dom.window.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
