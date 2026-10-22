'use strict';
// Run after `npm install --prefix tests`, then `node tests/realtime-ui.test.cjs`.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');
const {indexedDB, IDBKeyRange} = require('fake-indexeddb');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const body = html.replace(/<script[\s\S]*?<\/script>/gi, '');
const mainScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].pop()[1];
const wait = ms => new Promise(r => setTimeout(r, ms));
const base = Date.parse('2026-10-22T01:31:00Z');
const rows = (n=0) => ['bid','ask'].flatMap(side => [1,2,3,4,5].map(level => ({side, level,
  price: side==='bid' ? 10-(level-1)/10 : 10+level/10,
  volume: level===1 ? 1000+n : 1000})));
(async () => {
  const dom = new JSDOM(body, {url:'https://test.invalid/', runScripts:'outside-only', pretendToBeVisual:true});
  try {
    const w=dom.window;
    Object.assign(w, {indexedDB, IDBKeyRange, __now:base});
    w.eval(`const NativeDate=Date; Date=class extends NativeDate { constructor(...args){super(...(args.length?args:[window.__now]));} static now(){return window.__now;} };`);
    const calls=[];
    const payload=(kind,n=0,ticks=[])=>({source:'THSDK',code:'600000',fetched_at:new w.Date().toISOString(),
      bounds:{mode:'available-day',day:'2026-10-22'},rows:kind==='depth'?rows(n):ticks});
    w.fetch=async url=>{const kind=String(url).includes('/api/depth')?'depth':'ticks';calls.push(kind);return {ok:true,json:async()=>payload(kind)};};
    w.setInterval=(fn,ms)=>({fn,ms}); w.clearInterval=()=>{};
    w.eval(mainScript+'\nwindow.__test={state,bookRecorder,watchlist};marketPhase=()=>({open:true,label:"交易时段",day:"2026-10-22"});');
    const api=w.__test;
    api.state.code='600000';api.state.chartDate='2026-10-22';
    await api.bookRecorder.begin('600000');await wait(40);
    const capture=async(kind,n,ticks=[])=>{api.bookRecorder.capture(kind,payload(kind,n,ticks));await wait(30);};
    const text=id=>w.document.getElementById(id).textContent;
    w.__now=base+500;await capture('depth',100);
    assert.equal(w.document.querySelectorAll('#bookThreeRows tr').length,1,'open bucket must be displayed immediately');
    assert.match(text('bookBidAdditionDetail'),/观察增加 1 手/);
    assert.equal(w.document.querySelector('#bookThreeRows tr').children[2].textContent,'1');
    w.__now=base+700;await capture('depth',300);
    assert.match(text('bookBidAdditionDetail'),/观察增加 3 手/,'no 900ms recompute throttle');
    assert.equal(w.document.querySelector('#bookThreeRows tr').children[2].textContent,'3','same bucket ID must repaint revised quantities');
    w.__now=base+3500;await capture('depth',400);
    w.__now=base+3800;await capture('ticks',0,[{time:(base+400)/1000,price:10,volume:200}]);
    assert.match(text('bookThreeSource'),/共同成交量 2 手/,'late trade must backfill cumulative denominator');
    const oldRow=[...w.document.querySelectorAll('#bookThreeRows tr')].at(-1);
    assert.equal(oldRow.children[1].textContent,'2','old row must repaint late trade');
    assert.match(text('bookAuditStatus'),/差异 0 窗/);
    api.bookRecorder.viewAt('2026-10-22 09:31:01');
    assert.match(text('bookBidAdditionDetail'),/观察增加 3 手/);
    assert.match(text('bookThreeSource'),/共同成交量 0 手/,'historical view must exclude later trade receipt');
    api.bookRecorder.viewAt(null);
    assert.match(text('bookThreeSource'),/共同成交量 2 手/,'return to live must restore backfilled result');
    // Deliberately hidden document: app code must not pause book/tick polling.
    Object.defineProperty(w.document,'hidden',{configurable:true,get:()=>true});
    api.state.code='000001';await api.bookRecorder.begin('000001');await wait(30);
    w.__now=base+10000; const before=calls.length;api.bookRecorder.heartbeat();await wait(30);
    assert.ok(calls.length>before,'background page must continue attempting collection');
    api.bookRecorder.setPaused(true);await wait(20);
    const pausedCalls=calls.length;w.__now+=10000;api.bookRecorder.heartbeat();await wait(20);
    assert.equal(calls.length,pausedCalls,'explicit pause remains respected');
    console.log('PASS: open-window display, <900ms update, same-row repaint, late-trade backfill, audit, history isolation, background attempts, explicit pause');
  } finally { dom.window.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
