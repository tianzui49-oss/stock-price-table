'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');
const { indexedDB, IDBKeyRange } = require('fake-indexeddb');

const html = fs.readFileSync(__dirname + '/../clear-local.html', 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].at(-1)[1];
const DB = 'thsdk-orderbook-recorder-v1';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const req = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
const txDone = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error); });

function openDb(version = 1, stores = ['events', 'ticks', 'latest']) {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, version);
    r.onupgradeneeded = () => { for (const store of stores) if (!r.result.objectStoreNames.contains(store)) r.result.createObjectStore(store); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function resetDb() {
  await new Promise(resolve => { const r = indexedDB.deleteDatabase(DB); r.onsuccess = r.onerror = r.onblocked = resolve; });
}
async function seedDb(records, extraStores = []) {
  const db = await openDb(1, ['events', 'ticks', 'latest', ...extraStores]);
  const names = [...new Set(Object.keys(records).concat(extraStores))];
  const tx = db.transaction(names, 'readwrite');
  for (const [store, rows] of Object.entries(records)) for (const row of rows) tx.objectStore(store).put(row.value, row.key);
  await txDone(tx); db.close();
}
async function readDb() {
  const db = await openDb(); const out = {};
  const names = [...db.objectStoreNames];
  await Promise.all(names.map(name => new Promise((resolve, reject) => {
    const tx = db.transaction(name, 'readonly'), rows = [], r = tx.objectStore(name).openCursor();
    r.onsuccess = () => { const c = r.result; if (c) { rows.push({ key: c.primaryKey, value: c.value }); c.continue(); } else { out[name] = rows; resolve(); } };
    r.onerror = () => reject(r.error);
  })));
  db.close(); return out;
}
function makeEnv(local = {}) {
  const dom = new JSDOM(html.replace(/<script[\s\S]*?<\/script>/gi, ''), {
    url: 'https://tianzui49-oss.github.io/clear-local.html', runScripts: 'outside-only', pretendToBeVisual: true
  });
  const w = dom.window;
  Object.assign(w, { indexedDB, IDBKeyRange });
  for (const [key, value] of Object.entries(local)) w.localStorage.setItem(key, value);
  w.eval(script);
  return dom;
}
async function ready(dom) {
  for (let i = 0; i < 100; i++) {
    if (dom.window.document.getElementById('status').textContent.includes('只读加载')) return;
    await wait(5);
  }
  throw new Error('page did not finish read-only loading');
}
const el = (w, id) => w.document.getElementById(id);
const checked = (w, name, value) => { const x = [...w.document.querySelectorAll(`input[name="${name}"]`)].find(i => i.value === value); assert.ok(x, `${name}=${value} missing`); x.checked = true; };
const click = (w, id) => el(w, id).click();
const confirm = async w => { checked(w, 'stock', '600000'); checked(w, 'day', '2026-10-22'); click(w, 'previewButton'); await wait(10); checked(w, 'closedPages', ''); };
async function confirmVisible(w) { el(w, 'closedPages').checked = true; el(w, 'closedPages').dispatchEvent(new w.Event('change', { bubbles: true })); click(w, 'confirmButton'); await wait(20); }
function tick(code, time, extra = {}) { return { code, row: { time, price: 10, volume: 1 }, ...extra }; }
function event(code, received_at, kind, extra = {}) { return { code, received_at, kind, ...extra }; }
function latest(code, received_at, extra = {}) { return { code, received_at, rows: [{ side: 'bid', level: 1, price: 10, volume: 1 }], ...extra }; }

 test.beforeEach(resetDb);
 test.afterEach(async () => { await resetDb(); });

test('指定股票指定日期只删除交集，预览和取消均不改数据', async () => {
  await seedDb({
    ticks: [{ key: 'a', value: tick('600000', '20261022093000') }, { key: 'b', value: tick('600000', '20261023093000') }, { key: 'c', value: tick('000001', '20261022093000') }],
    events: [{ key: 'd', value: event('600000', '2026-10-22T01:00:00Z', 'depth') }], latest: []
  });
  const dom = makeEnv({ 'thsdk-last-valid-depth-v1:600000': JSON.stringify({ source: 'THSDK', code: '600000', fetched_at: '2026-10-22T01:00:00Z', rows: [] }) });
  try { const w = dom.window; await ready(dom); checked(w, 'stock', '600000'); checked(w, 'day', '2026-10-22'); click(w, 'previewButton'); await wait(10);
    assert.equal(el(w, 'confirmation').hidden, false); assert.match(el(w, 'summary').textContent, /600000/); assert.match(el(w, 'summary').textContent, /2026-10-22/);
    assert.match(el(w, 'status').textContent, /仅预览/); click(w, 'cancelButton'); await wait(5); assert.match(el(w, 'status').textContent, /已取消/);
    assert.equal(el(w, 'confirmation').hidden, true); assert.equal((await readDb()).ticks.length, 3); assert.ok(w.localStorage.getItem('thsdk-last-valid-depth-v1:600000'));
  } finally { dom.window.close(); }
});

test('同日全部股票、选股全部日期、北京时间当天和一键全部预览', async () => {
  await seedDb({ ticks: [
    { key: 'a', value: tick('600000', '20261022093000') }, { key: 'b', value: tick('000001', '20261022093000') },
    { key: 'c', value: tick('600000', '20261023093000') }, { key: 'd', value: tick('600000', 'bad', { day: '2026-10-22' }) }
  ], events: [], latest: [] });
  const dom = makeEnv();
  try { const w = dom.window; await ready(dom);
    checked(w, 'day', '2026-10-22'); w.document.querySelector('input[name="stockMode"][value="all"]').click(); click(w, 'previewButton'); await wait(10);
    assert.equal(el(w, 'previewRows').querySelectorAll('tr').length, 2); click(w, 'cancelButton');
    checked(w, 'stock', '600000'); w.document.querySelector('input[name="stockMode"][value="selected"]').click(); w.document.querySelector('input[name="dateMode"][value="all"]').click(); click(w, 'previewButton'); await wait(10);
    assert.equal(el(w, 'previewRows').querySelectorAll('tr').length, 2); click(w, 'cancelButton');
  click(w, 'todayButton'); assert.equal(el(w, 'customDay').value, new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10));
    click(w, 'allButton'); await wait(10); assert.equal(el(w, 'confirmation').hidden, false); assert.match(el(w, 'summary').textContent, /全部股票/); assert.match(el(w, 'summary').textContent, /全部日期/); click(w, 'cancelButton');
  } finally { dom.window.close(); }
});

test('确认删除指定范围，并保留未选日期、未知 schema、分时图/搜索/自选/未知 local key', async () => {
  await seedDb({
    ticks: [{ key: 'keep', value: tick('600000', '20261023093000') }, { key: 'drop', value: tick('600000', '20261022093000') }, { key: 'unknown', value: { code: '600000', row: { foo: 'bar' } } }],
    events: [{ key: 'drop-event', value: event('600000', '2026-10-22T01:00:00Z', 'depth') }], latest: []
  }, ['unknown-store']);
  const beforeUnknown = { foo: 'keep', nested: [1, 2] }; await seedDb({ 'unknown-store': [{ key: 'u', value: beforeUnknown }] });
  const local = { 'thsdk-chart-history-v1:600000': 'chart', 'stock-search-history-v1': '["x"]', 'stock-watchlist-v1': JSON.stringify([{ code: '600000', name: '浦发银行' }]), 'other': 'unchanged' };
  const dom = makeEnv(local);
  try { const w = dom.window; await ready(dom); checked(w, 'stock', '600000'); checked(w, 'day', '2026-10-22'); click(w, 'previewButton'); await wait(10); await confirmVisible(w);
    assert.match(el(w, 'status').textContent, /清理完成/); const db = await readDb(); assert.deepEqual(db.ticks.map(x => x.key), ['keep', 'unknown']); assert.equal(db.events.length, 0); assert.deepEqual(db['unknown-store'][0].value, beforeUnknown);
    assert.equal(w.localStorage.getItem('thsdk-chart-history-v1:600000'), 'chart'); assert.equal(w.localStorage.getItem('stock-search-history-v1'), '["x"]'); assert.equal(w.localStorage.getItem('stock-watchlist-v1'), local['stock-watchlist-v1']); assert.equal(w.localStorage.getItem('other'), 'unchanged');
  } finally { dom.window.close(); }
});

test('逐笔按源日，日期未知只在全部日期中可删除', async () => {
  await seedDb({ ticks: [
    { key: 'beijing', value: tick('600000', Date.parse('2026-10-21T16:30:00Z') / 1000) },
    { key: 'source', value: tick('600000', '20261022000100') }, { key: 'unknown', value: tick('600000', 'not-a-time') }
  ], events: [], latest: [] });
  const dom = makeEnv();
  try { const w = dom.window; await ready(dom); checked(w, 'stock', '600000'); checked(w, 'day', '2026-10-22'); click(w, 'previewButton'); await wait(10); assert.equal(el(w, 'previewRows').querySelectorAll('tr').length, 1); assert.match(el(w, 'summary').textContent, /2026-10-22/); click(w, 'cancelButton');
    w.document.querySelector('input[name="stockMode"][value="selected"]').click(); w.document.querySelector('input[name="dateMode"][value="all"]').click(); click(w, 'previewButton'); await wait(10); assert.equal(el(w, 'previewRows').querySelectorAll('tr').length, 2); assert.match(el(w, 'summary').textContent, /日期不明/); click(w, 'cancelButton');
  } finally { dom.window.close(); }
});

test('latest 各形式、depth local cache 和 cutoff 只匹配源日条目', async () => {
  await seedDb({ events: [{ key: 'depth-event', value: event('600000', '2026-10-22T01:00:00Z', 'depth') }], ticks: [], latest: [
    { key: 'l1', value: latest('600000', '2026-10-22T01:00:00Z') },
    { key: 'l2', value: latest('600000', '2026-10-23T01:00:00Z') },
    { key: 'stats-session:600000', value: { code: 'stats-session:600000', session: { code: '600000', day: '2026-10-22' } } },
    { key: 'stats-original-session-recovered:600000:2026-10-22', value: { code: 'stats-original-session-recovered:600000:2026-10-22' } },
    { key: 'bad', value: { code: 'stats-session:600000', session: { code: '000001', day: '2026-10-22' } } }
  ]});
  const local = {
    'thsdk-last-valid-depth-v1:600000': JSON.stringify({ source: 'THSDK', code: '600000', fetched_at: '2026-10-22T01:00:00Z', rows: [] }),
    'thsdk-last-valid-depth-v1:000001': JSON.stringify({ source: 'THSDK', code: '000001', fetched_at: '2026-10-22T01:00:00Z', rows: [] }),
    'stock-derived-rate-cutoffs-v1': JSON.stringify({ '2026-10-22': { '600000': '2026-10-22T01:00:00Z', '000001': '2026-10-23T01:00:00Z' }, '2026-10-23': { '600000': '2026-10-23T01:00:00Z' } })
  };
  const dom = makeEnv(local);
  try { const w = dom.window; await ready(dom); checked(w, 'stock', '600000'); checked(w, 'day', '2026-10-22'); click(w, 'previewButton'); await wait(10);
    assert.equal(el(w, 'previewRows').querySelectorAll('tr').length, 1); assert.match(el(w, 'summary').textContent, /共 6 条/); assert.match(el(w, 'previewRows').textContent, /五档实时快照明细/); assert.equal(el(w, 'confirmation').hidden, false); click(w, 'cancelButton');
    assert.ok(w.localStorage.getItem('thsdk-last-valid-depth-v1:000001')); assert.match(w.localStorage.getItem('stock-derived-rate-cutoffs-v1'), /2026-10-23/);
  } finally { dom.window.close(); }
});

test('改范围会取消预览；取消按钮和确认按钮状态符合 UI', async () => {
  await seedDb({ ticks: [{ key: 'a', value: tick('600000', '20261022093000') }], events: [], latest: [] }); const dom = makeEnv();
  try { const w = dom.window; await ready(dom); checked(w, 'stock', '600000'); checked(w, 'day', '2026-10-22'); click(w, 'previewButton'); await wait(10); assert.equal(el(w, 'confirmation').hidden, false); el(w, 'closedPages').dispatchEvent(new w.Event('change'));
    el(w, 'dateChoices').querySelector('input').dispatchEvent(new w.Event('change', { bubbles: true })); assert.equal(el(w, 'confirmation').hidden, true); assert.equal(el(w, 'confirmButton').disabled, true); assert.match(el(w, 'status').textContent, /范围已更改/);
  } finally { dom.window.close(); }
});

test('预览后并发写入导致确认拒绝且不删除', async () => {
  await seedDb({ ticks: [{ key: 'a', value: tick('600000', '20261022093000') }], events: [], latest: [] }); const dom = makeEnv();
  try { const w = dom.window; await ready(dom); checked(w, 'stock', '600000'); checked(w, 'day', '2026-10-22'); click(w, 'previewButton'); await wait(10);
    const db = await openDb(); const tx = db.transaction('ticks', 'readwrite'); tx.objectStore('ticks').put(tick('600000', '20261022093100'), 'concurrent'); await txDone(tx); db.close(); await confirmVisible(w);
    assert.match(el(w, 'status').textContent, /预览后记录已变化/); assert.equal((await readDb()).ticks.length, 2);
  } finally { dom.window.close(); }
});

test('数据库缺失时只读加载不创建数据库', async () => {
  const dom = makeEnv();
  try { const w = dom.window; await ready(dom); assert.match(el(w, 'stockChoices').textContent, /未读到/); assert.equal((await indexedDB.databases()).some(x => x.name === DB), false); }
  finally { dom.window.close(); }
});

for (const mode of ['stock-day', 'stock-all-days', 'all-stocks-day', 'today', 'everything']) {
  test(`实际确认 ${mode}：完整核验目标删除与全部非目标/保护键逐字不变`, async () => {
    const codes=['600000','000001'],days=['2026-10-22','2026-10-23'];
    const records={events:[],ticks:[],latest:[],preferences:[{key:'pref',value:{untouched:true}}]};
    for(const code of codes)for(const day of days){
      const at=day+'T01:30:00Z';
      for(const kind of ['depth','tick_response','stats_start','stats_resume']) records.events.push({key:`${code}:${day}:${kind}`,value:event(code,at,kind,{changes:[{side:'bid',price:10,delta_shares:100}],session_id:code+'|'+day})});
      records.ticks.push({key:`${code}:${day}:tick`,value:tick(code,day.replaceAll('-','')+'093000',{first_received_at:'2026-10-24T01:00:00Z'})});
      records.latest.push({key:`stats-original-session-recovered:${code}:${day}`,value:{code:`stats-original-session-recovered:${code}:${day}`,day}});
    }
    for(const code of codes){records.latest.push({key:code,value:latest(code,'2026-10-23T01:30:00Z')});records.latest.push({key:'stats-session:'+code,value:{code:'stats-session:'+code,session:{code,day:'2026-10-23'}}});}
    records.events.push({key:'unknown',value:{code:'600000',kind:'unknown-kind',received_at:'2026-10-23T01:30:00Z'}});
    await seedDb(records,['preferences']);
    const keep={
      'stock-chart-600000-2026-10-22':' [ {"time":"09:30", "price": 10} ] ',
      'stock-chart-000001-2026-10-23':'[1,2,3] ',
      'stock-input-history-v1':'[ { "query":"浦发", "code":"600000", "name":"浦发银行" } ]',
      'stock-watchlist-v1':'[ { "code":"600000", "name":"浦发银行" }, {"code":"000001","name":"平安银行"} ]',
      'stock-chart-other-malformed':'not JSON', 'theme':'dark', 'other-data':'\n original bytes \n'
    };
    const local={...keep};
    for(const code of codes)local['thsdk-last-valid-depth-v1:'+code]=JSON.stringify({source:'THSDK',code,rows:[],checked_at:'2026-10-23T01:30:00Z',fetched_at:'2026-10-22T01:30:00Z'});
    local['stock-derived-rate-cutoffs-v1']=JSON.stringify(Object.fromEntries(days.map(day=>[day,Object.fromEntries(codes.map(code=>[code,day+'T01:30:00Z']))])));
    const dom=makeEnv(local);
    try {
      const w=dom.window;await ready(dom);const before=await readDb();
      if(mode==='everything')click(w,'allButton');else{
        if(mode==='all-stocks-day')w.document.querySelector('input[name="stockMode"][value="all"]').click();else checked(w,'stock','600000');
        if(mode==='stock-all-days')w.document.querySelector('input[name="dateMode"][value="all"]').click();else if(mode==='today'){w.Date.now=()=>Date.parse('2026-10-22T16:00:01Z');click(w,'todayButton');assert.equal(el(w,'customDay').value,'2026-10-23');}else checked(w,'day','2026-10-22');
        click(w,'previewButton');
      }
      await wait(15);assert.equal(el(w,'confirmation').hidden,false);
      assert.deepEqual(await readDb(),before,'预览不能变更数据库');
      for(const [key,value]of Object.entries(local))assert.equal(w.localStorage.getItem(key),value,'预览不能变更 '+key);
      await confirmVisible(w);assert.match(el(w,'status').textContent,/^清理完成/);
      const targeted=(code,day)=>(mode==='everything'||mode==='all-stocks-day'||code==='600000')&&(mode==='everything'||mode==='stock-all-days'||day===(mode==='today'?'2026-10-23':'2026-10-22'));
      const after=await readDb();
      for(const store of ['events','ticks','latest']){
        const expected=before[store].filter(({value:v})=>{
          if(v.kind==='unknown-kind')return true;
          let code=v.code,day=v.session?.day||v.day||(v.received_at||'').slice(0,10);
          if(store==='ticks')day=v.row.time.slice(0,4)+'-'+v.row.time.slice(4,6)+'-'+v.row.time.slice(6,8);
          if(code.startsWith('stats-session:'))code=code.split(':')[1];
          if(code.startsWith('stats-original-session-recovered:')){const parts=code.split(':');code=parts[1];day=parts[2];}
          return !targeted(code,day);
        });assert.deepEqual(after[store],expected,'范围精确匹配 '+store);
      }
      assert.deepEqual(after.preferences,before.preferences);
      for(const [key,value]of Object.entries(keep))assert.equal(w.localStorage.getItem(key),value,'保护键逐字节保留 '+key);
      for(const code of codes)assert.equal(w.localStorage.getItem('thsdk-last-valid-depth-v1:'+code),targeted(code,'2026-10-23')?null:local['thsdk-last-valid-depth-v1:'+code]);
      const cutoffs=JSON.parse(w.localStorage.getItem('stock-derived-rate-cutoffs-v1'));
      for(const code of codes)for(const day of days)assert.equal(cutoffs[day]?.[code],targeted(code,day)?undefined:day+'T01:30:00Z');
    }finally{dom.window.close();}
  });
}

test('本地缓存写入失败会明确报告数据库已提交，不宣称全部成功',async()=>{
  await seedDb({ticks:[{key:'t',value:tick('600000','20261022093000')}],events:[],latest:[]});
  const dom=makeEnv({'stock-derived-rate-cutoffs-v1':JSON.stringify({'2026-10-22':{'600000':'2026-10-22T01:00:00Z'}})});
  try{const w=dom.window;await ready(dom);checked(w,'stock','600000');checked(w,'day','2026-10-22');click(w,'previewButton');await wait(15);
    const original=w.Storage.prototype.setItem;w.Storage.prototype.setItem=function(key,value){if(key==='stock-derived-rate-cutoffs-v1')throw new w.DOMException('test quota','QuotaExceededError');return original.call(this,key,value);};
    await confirmVisible(w);assert.match(el(w,'status').textContent,/未能确认清理完成.*数据库记录已提交删除/);assert.equal((await readDb()).ticks.length,0);assert.ok(w.localStorage.getItem('stock-derived-rate-cutoffs-v1').includes('600000'));
  }finally{dom.window.close();}
});
