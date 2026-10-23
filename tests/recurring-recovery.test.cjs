'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const body = html.replace(/<script[\s\S]*?<\/script>/gi, '');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].pop()[1];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const tick = n => ({time: 1792651860 + n, price: 10 + n, volume: 100 + n, transaction_count: n + 1});
const depth = () => ['bid','ask'].flatMap(side => [1,2,3,4,5].map(level => ({side, level, price: side === 'bid' ? 9 - level / 10 : 10 + level / 10, volume: 100})));

async function setup(sequence) {
  const dom = new JSDOM(body, {url:'https://test.invalid/', runScripts:'outside-only', pretendToBeVisual:true});
  const w = dom.window;
  let now = Date.parse('2026-10-22T01:31:00Z');
  w.Date = class extends Date { constructor(...args){ super(...(args.length ? args : [now])); } static now(){ return now; } };
  const calls = []; let depthFailures = 0;
  w.fetch = async url => {
    const isDepth = String(url).includes('/api/depth'); calls.push({isDepth, url:String(url)});
    if (isDepth && depthFailures++ === 0) return {ok:false, status:502, headers:{get:()=>null}, json:async()=>({error:'source_rate_limited'})};
    if (isDepth) return {ok:true, status:200, headers:{get:()=>null}, json:async()=>({source:'THSDK', code:'600000', rows:depth(), fetched_at:new Date(now).toISOString()})};
    const item = sequence.shift() || {ok:true, status:200, body:{source:'THSDK', code:'600000', columns:[], rows:[tick(2)]}};
    return {ok:item.ok, status:item.status||200, headers:{get:name => item.retryAfter && name === 'Retry-After' ? String(item.retryAfter) : null}, json:async()=>item.body || {error:item.error || 'source_rate_limited'}};
  };
  w.setInterval = (fn, ms) => ({fn, ms}); w.clearInterval = () => {};
  w.eval(script + '\nwindow.__test={state,tickState,tickSync,tickStart,tickStop,depthSync,thsdkRead}; marketPhase=()=>({open:true,label:"交易时段",day:"2026-10-22"});');
  w.__test.state.code='600000'; w.__test.state.chartDate='2026-10-22';
  return {dom, w, calls, advance(ms){now += ms;}};
}

test('逐笔成功→502→tickSync 保留旧表且退避→恢复，depth 限流不阻 ticks', async () => {
  const sequence = [
    {ok:true, body:{source:'THSDK', code:'600000', columns:[], rows:[tick(1)]}},
    {ok:false, status:502, error:'data_source_unavailable', retryAfter:2},
    {ok:true, body:{source:'THSDK', code:'600000', columns:[], rows:[tick(2)]}}
  ];
  const {dom,w,calls,advance} = await setup(sequence);
  try {
    w.__test.tickStart(true); await wait(160);
    assert.equal(w.document.querySelectorAll('#thsdkTickBody tr').length, 1);
    const old = w.document.querySelector('#thsdkTickBody tr').textContent;
    advance(1000); w.__test.tickSync(true, true); await wait(10);
    assert.match(w.document.getElementById('thsdkStatus').textContent, /暂时无法读取|暂不可用/);
    assert.equal(w.document.querySelector('#thsdkTickBody tr').textContent, old);
    w.__test.tickSync(); await wait(10);
    assert.equal(calls.filter(x=>!x.isDepth).length, 2, 'Retry-After 冷却期间不重复请求');
    assert.match(w.document.getElementById('thsdkStatus').textContent, /暂时无法读取/,'旧缓存不清除失败说明');
    advance(2500); w.__test.tickSync(); await wait(10);
    assert.equal(calls.filter(x=>!x.isDepth).length, 3);
    assert.match(w.document.getElementById('thsdkStatus').textContent, /成功读取|最近成交/);
    assert.ok(w.thsdkDiagnostics.entries.some(e=>e.status===502&&e.sourceCode==='data_source_unavailable'));
    assert.ok(w.thsdkDiagnostics.entries.some(e=>e.status===200&&e.rowCount===1));
    for(let n=0;n<70;n++)await w.__test.thsdkRead('https://example.invalid/check?code=600000');
    assert.equal(w.thsdkDiagnostics.entries.length,60,'诊断有界且不复制原始rows');
    assert.ok(w.thsdkDiagnostics.entries.every(e=>!('rows' in e)));
  } finally { dom.window.close(); }
});

test('资源独立冷却且停止/切股会取消旧逐笔重试', async () => {
  const sequence = [{ok:false,status:429,error:'source_rate_limited',retryAfter:30}];
  const {dom,w,calls} = await setup(sequence);
  try {
    w.__test.tickStart(true); await wait(160);
    const before = calls.length;
    const depthResult = await w.__test.thsdkRead('https://example.invalid/depth', new w.AbortController().signal).catch(e => e);
    assert.ok(depthResult, '独立资源应有自己的失败/冷却结果');
    const beforeStop = calls.length; w.__test.tickStop(); w.__test.state.code='000001'; w.__test.tickSync(true, true); await wait(10);
    assert.equal(calls.length, beforeStop, '停止并切股后不应继续旧股票请求');
  } finally { dom.window.close(); }
});
