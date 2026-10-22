'use strict';
const fs=require('fs'),assert=require('node:assert/strict');
const {JSDOM}=require('jsdom'),{indexedDB,IDBKeyRange}=require('fake-indexeddb');
const html=fs.readFileSync(__dirname+'/../index.html','utf8');
let main=[...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].at(-1)[1];
main=main.replace('return { capture, refresh, compare, begin, pause, heartbeat, viewAt, exportData, syncWatchlist, setPaused,','return { __test: {db,caches,sessions,renderSavedHistory,historyTickTime,recompute}, capture, refresh, compare, begin, pause, heartbeat, viewAt, exportData, syncWatchlist, setPaused,').replace('watchlist.init();','watchlist.render();');
const dom=new JSDOM(html.replace(/<script[\s\S]*?<\/script>/gi,''),{url:'https://tianzui49-oss.github.io/',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;
Object.assign(w,{indexedDB,IDBKeyRange});w.setInterval=()=>0;w.fetch=async()=>({ok:true,json:async()=>({rows:[]})});
main=main.replace(/function download\(name,text,type\)\{[^\n]+\}/,'function download(name,text,type){window.__export={name,text,type};}');
w.eval(main+'\nwindow.api={state,bookRecorder,DerivedRateReset};');
const {state,bookRecorder,DerivedRateReset:R}=w.api,H=bookRecorder.__test,$=id=>w.document.getElementById(id);
const iso=(day,clock)=>`${day}T${clock}+08:00`,code='600000';
const rows=[{side:'bid',price:10,volume:100},{side:'ask',price:11,volume:200}];
const events=[],ticks=[];
for(let i=0;i<65;i++)events.push({id:i+1,code,kind:'depth',session_id:i<33?'old-am':'old-pm',segment_id:i<33?'a':'b',received_at:iso('2026-10-22',`${i<33?'09':'14'}:30:${String(i%33).padStart(2,'0')}`),payload:{rows},changes:[]});
events.push({id:66,code,kind:'depth',session_id:'older',segment_id:'x',received_at:iso('2026-10-21','10:00:00'),payload:{rows}});
for(let i=0;i<45;i++){const t=Date.parse(iso('2026-10-22',`09:30:${String(i).padStart(2,'0')}`));ticks.push({id:'t'+i,code,day:'2026-10-22',first_received_at:new Date(t+3000).toISOString(),row:{time:t/1000,price:10,volume:100}});}
ticks.push({id:'otherday',code,day:'2026-10-21',first_received_at:iso('2026-10-21','10:00:00'),row:{time:Date.parse(iso('2026-10-21','10:00:00'))/1000,price:10,volume:100}});
const c={events,ticks:new Map(ticks.map(t=>[t.id,t])),dirty:true},rawMemory=JSON.stringify({events,ticks});
async function dump(db){const out={};for(const n of ['events','ticks','latest'])out[n]=await new Promise((yes,no)=>{const r=db.transaction(n).objectStore(n).getAll();r.onsuccess=()=>yes(r.result);r.onerror=()=>no(r.error)});return JSON.stringify(out);}
function change(id,value){$(id).value=value;$(id).dispatchEvent(new w.Event('change'));}
(async()=>{try{
assert.equal(H.historyTickTime('20261022093000'),Date.parse('2026-10-22T09:30:00+08:00'));assert.equal(H.historyTickTime('2026-10-22T01:30:00Z'),Date.parse('2026-10-22T09:30:00+08:00'));console.log('PASS 历史逐笔时间兼容秒级、14位北京日期和ISO格式');
const db=await H.db(),tx=db.transaction(['events','ticks','latest'],'readwrite');for(const e of events)tx.objectStore('events').add(e);for(const t of ticks)tx.objectStore('ticks').add(t);
const current={id:'newday',code,day:'2026-10-23',started_at:iso('2026-10-23','09:30:00')};tx.objectStore('latest').put({code:'stats-session:'+code,session:current});await new Promise((r,j)=>{tx.oncomplete=r;tx.onerror=j});
H.sessions.set(code,current);H.caches.set(code,c);state.code=code;const raw=await dump(db),storage=w.localStorage.length;
H.renderSavedHistory(c);assert.equal($('bookHistoryDay').value,'2026-10-22');assert.match($('bookHistorySummary').textContent,/五档 65 帧，逐笔 45 条/);assert.equal($('bookHistoryPeriods').children.length,2);assert.match($('bookHistoryPeriods').textContent,/old-am/);assert.match($('bookHistoryPeriods').textContent,/old-pm/);console.log('PASS 10月23日新会话下默认仍显示10月22日，包含当天两个旧会话/时段');
assert.equal($('bookHistoryRows').children.length,30);$('bookHistoryNext').click();$('bookHistoryNext').click();assert.equal($('bookHistoryRows').children.length,5);assert.match($('bookHistoryPage').textContent,/3\/3/);console.log('PASS 五档完整分页65帧，不限最近60条');
change('bookHistoryKind','ticks');assert.equal($('bookHistoryRows').children.length,30);assert.match($('bookHistoryRows').textContent,/2026\/10\/22/);assert.doesNotMatch($('bookHistoryRows').textContent,/1970/);$('bookHistoryNext').click();assert.equal($('bookHistoryRows').children.length,15);console.log('PASS 45条逐笔完整分页，秒级时间正确显示北京时间');
change('bookHistoryDay','2026-10-21');assert.match($('bookHistorySummary').textContent,/五档 1 帧，逐笔 1 条/);console.log('PASS 日期选择只影响只读视图，无跨日混淆');
change('bookHistoryDay','2026-10-22');R.reset([code],Date.parse(iso('2026-10-23','10:00:00')));H.renderSavedHistory(c);assert.match($('bookHistorySummary').textContent,/五档 65 帧，逐笔 45 条/);assert.equal(H.sessions.get(code),current);console.log('PASS 今日比率重置及当前会话不会挡住历史');
let captured;$('bookHistoryExport').click();captured=JSON.parse(w.__export.text);assert.equal(captured.events.length,65);assert.equal(captured.ticks.length,45);assert.deepEqual(captured.events,events.filter(e=>e.id!==66));console.log('PASS 所选日期JSON包含全部旧会话原始内容，不加入派生或改写记录');
state.code='000001';const empty={events:[],ticks:new Map()};H.caches.set(state.code,empty);H.renderSavedHistory(empty);assert.equal($('bookHistoryRows').children.length,0);assert($('bookHistoryExport').disabled);assert.match($('bookHistorySummary').textContent,/未读到/);state.code=code;H.renderSavedHistory(c);assert.equal($('bookHistoryDay').value,'2026-10-22');console.log('PASS 切换股票不串数据，未读到数据不声称已丢失');
assert.equal(await dump(db),raw);assert.equal(JSON.stringify({events,ticks}),rawMemory);assert.equal(w.localStorage.length,storage+1);console.log('PASS 所有查看、分页、日期/股票切换、导出后 events/ticks/latest 逐字不变');
console.log('ALL HISTORY TESTS PASS');
}finally{w.close()}})().catch(e=>{console.error(e);process.exitCode=1});
