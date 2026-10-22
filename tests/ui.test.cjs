'use strict';
const fs=require('fs'),assert=require('node:assert/strict'),{JSDOM}=require('jsdom'),{indexedDB,IDBKeyRange}=require('fake-indexeddb');
const html=fs.readFileSync(__dirname+'/../index.html','utf8'),main=[...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].at(-1)[1],base=Date.parse('2026-10-22T01:31:00Z'),wait=ms=>new Promise(r=>setTimeout(r,ms));
const dom=new JSDOM(html.replace(/<script[\s\S]*?<\/script>/gi,''),{url:'https://test.invalid/',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;
Object.assign(w,{indexedDB,IDBKeyRange,__now:base});w.eval(`const NativeDate=Date;Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[window.__now]));}static now(){return window.__now;}};`);w.setInterval=()=>0;w.clearInterval=()=>{};
const rows=n=>['bid','ask'].flatMap(side=>[1,2,3,4,5].map(level=>({side,level,price:side==='bid'?10-(level-1)/10:10+level/10,volume:side==='bid'&&level===1?1000+n:1000}))),payload=(kind,n=0,ticks=[])=>({source:'THSDK',code:'600000',fetched_at:new w.Date().toISOString(),bounds:{mode:'available-day',day:'2026-10-22'},rows:kind==='depth'?rows(n):ticks});
w.fetch=async url=>({ok:true,json:async()=>payload(String(url).includes('/api/depth')?'depth':'ticks')});
w.eval(main+'\nwindow.api={state,bookRecorder};marketPhase=()=>({open:true,label:"交易时段",day:"2026-10-22"});');
const $=id=>w.document.getElementById(id),text=id=>$(id).textContent;
(async()=>{try{
 w.api.state.code='600000';w.api.state.chartDate='2026-10-22';await w.api.bookRecorder.begin('600000');await wait(80);
 const capture=async(kind,n,ticks=[])=>{w.api.bookRecorder.capture(kind,payload(kind,n,ticks));await wait(50);};
 w.__now=base+1000;await capture('depth',1000);w.__now=base+2000;await capture('depth',200);assert.match(text('bookThreeSummary'),/待下次成交更新结算 2 次/);assert.doesNotMatch(text('bookBidAdditionDetail'),/加单 10 手/);
 w.__now=base+2500;await capture('ticks',0,[{time:(base+1500)/1000,price:10,volume:500}]);
 assert.match(text('bookBidAdditionDetail'),/加单 10 手；撤单 3 手/);assert.match(text('bookBidAdditionDetail'),/净加单 7 手；净加单率 140/);assert.match(text('bookThreeSource'),/共同成交量：5 手/);assert.match(text('bookAuditStatus'),/差异 0 窗/);assert.match(text('bookThreeRows'),/逐档增减与净加单率/);
 w.__now=base+3000;await capture('depth',-800);w.__now=base+3500;await capture('ticks',0,[{time:(base+1500)/1000,price:10,volume:500},{time:(base+3200)/1000,price:10,volume:100}]);assert.match(text('bookBidAdditionDetail'),/加单 10 手；撤单 12 手/);assert.match(text('bookBidAdditionDetail'),/净加单 -2 手；净加单率 -33.33/);assert.match(text('bookThreeSource'),/共同成交量：6 手/);assert.match(text('bookAuditStatus'),/差异 0 窗/);
 w.api.bookRecorder.viewAt('2026-10-22 09:31:02');assert.doesNotMatch(text('bookBidAdditionDetail'),/加单 10 手/);w.api.bookRecorder.viewAt(null);assert.match(text('bookBidAdditionDetail'),/撤单 12 手/);
 assert($('bookSavedHistory'));assert($('bookHistoryExport'));console.log('PASS UI: pending, per-price arithmetic, cumulative denominator, signed net rate, independent audit, historical cutoff, retained history panel');
 }finally{w.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
