'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
function loadExport(name) {
  const start = html.indexOf(`const ${name} = (() => {`);
  assert(start >= 0, `${name} not found`);
  const end = html.indexOf(`})();`, start);
  assert(end >= 0, `${name} end not found`);
  const code = html.slice(start, end + 5) + `\nglobalThis.__out = ${name};`;
  const ctx = { console, Date, Math, Number, String, Set, Map, Array, Object, JSON, Infinity };
  vm.createContext(ctx); vm.runInContext(code, ctx, { filename: 'index.html' });
  return ctx.__out;
}
const Calc = loadExport('BookThreeSecondCalculator');
const Audit = loadExport('BookStatisticsAudit');
const sid = 'rt-fixture', code = 'ABC', day = '2026-10-21';
const iso = t => new Date(t).toISOString();
const base = Date.parse(`${day}T01:30:00Z`);
const W0 = Math.floor(base / 3000) * 3000;
const W1 = W0 + 3000;
function rows(bid1=100, ask1=102, bidVol=100, askVol=200) {
  return [1,2,3,4,5].map((level,i)=>({side:'bid',level,price:bid1-i,volume:level===1?bidVol:50}))
    .concat([1,2,3,4,5].map((level,i)=>({side:'ask',level,price:ask1+i,volume:level===1?askVol:60})));
}
function expectedChanges(oldRows, newRows) {
  const out=[];
  for (const side of ['bid','ask']) {
    const b=new Map(oldRows.filter(x=>x.side===side).map(x=>[x.price,x.volume]));
    const a=new Map(newRows.filter(x=>x.side===side).map(x=>[x.price,x.volume]));
    for(const [p,v] of b) {
      if(!a.has(p)) out.push({side,price:p,before_shares:v,after_shares:null,delta_shares:null});
      else if(a.get(p)!==v) out.push({side,price:p,before_shares:v,after_shares:a.get(p),delta_shares:a.get(p)-v});
    }
    for(const [p,v] of a) if(!b.has(p)) out.push({side,price:p,before_shares:null,after_shares:v,delta_shares:null});
  }
  return out;
}
function depth(t, r, prev, extra={}) {
  return {kind:'depth',session_id:sid,segment_id:extra.segment_id||'seg',received_at:iso(t),gap_limit_ms:5000,
    ...(extra.gap_warning ? {gap_warning:true}:{}), payload:{rows:r}, changes:prev?expectedChanges(prev,r):[]};
}
function session(){return {id:sid,code,day,started_at:iso(W0)};}
function tick(t, recv, volume, marker='tick') {
  return {id:marker,code,first_received_at:iso(recv),row:{time:t/1000,price:100,volume,raw_marker:marker}};
}
function pairWindows({late=false}={}) {
  const r0=rows(), r1=rows(100,102,110,195), r2=rows(100,102,106,202), r3=rows(100,102,111,202);
  r2[4].price=95; // 96 leaves and 95 enters: visibility, not common statistic
  const events=[depth(W0+100,r0),depth(W0+2100,r1,r0),depth(W1+100,r2,r1),depth(W1+2100,r3,r2)];
  const ticks=[tick(W0+1000,W0+2200,5,'old'),tick(W1+1000,W1+2200,7,'new')];
  if(late) ticks.push(tick(W0+1500,W1+2300,9,'late-old-window'));
  return {events,ticks};
}

test('未到3秒且无 tick_response：盘口增减/进入移出立即有结果', () => {
  const r0=rows(), r1=rows(100,102,110,195); r1[7].price=107; // one ask price leaves and another enters; all five prices remain unique
  const out=Calc.calculate([depth(W0+100,r0),depth(W0+2100,r1,r0)],[],session());
  assert.equal(out.windows.length,1); assert.equal(out.windows[0].window_open,true);
  assert.equal(out.windows[0].trade_coverage,'awaiting_coverage');
  assert.equal(out.windows[0].bid.added_shares,10);
  assert.ok(out.visibility_changes.some(x=>x.visibility_state==='entered_five'||x.visibility_state==='left_five'));
});

test('第一次成交响应不阻塞盘口窗口', () => {
  const {events}=pairWindows(); events.push({kind:'tick_response',session_id:sid,received_at:iso(W0+2500),payload_metadata:{bounds:{mode:'available-day',day}}});
  const open=Calc.calculate(events,[],session(),W0+2500);
  assert.equal(open.windows.length,1); assert.equal(open.windows[0].trade_coverage,'response_received_not_final');
  const out=Calc.calculate(events,[],session());
  assert.equal(out.windows.length,2); assert.equal(out.windows[0].trade_coverage,'awaiting_coverage');
  assert.equal(out.windows[0].confirmed_at,iso(W1+2100));
});

test('迟到成交回补旧窗口，并更新后续累计', () => {
  const a=pairWindows(), before=Calc.calculate(a.events,a.ticks,session());
  const after=Calc.calculate(a.events,[...a.ticks,tick(W0+1500,W1+2300,9,'late-old-window')],session());
  assert.equal(before.windows[0].source_trade_volume_shares,5);
  assert.equal(after.windows[0].source_trade_volume_shares,14);
  assert.equal(after.timeline[1].source_trade_volume_shares,21);
  assert.equal(after.windows[0].updated_at,after.as_of);
});

test('乱序 events/ticks 与重复 calculate 幂等', () => {
  const a=pairWindows(), ordered=Calc.calculate(a.events,a.ticks,session());
  const shuffled=Calc.calculate([a.events[3],a.events[0],a.events[2],a.events[1]],[a.ticks[1],a.ticks[0]],session());
  assert.deepEqual(shuffled,ordered);
  assert.deepEqual(Calc.calculate(a.events,a.ticks,session()),Calc.calculate(a.events,a.ticks,session()));
});

test('cutoff 历史不泄漏未来盘口/成交', () => {
  const a=pairWindows(); const cutoff=W0+2200;
  const out=Calc.calculate(a.events,a.ticks,session(),cutoff);
  assert.equal(out.windows.length,1);
  assert.equal(out.windows[0].source_trade_volume_shares,5);
  assert.equal(out.windows[0].source_trade_rows,1);
  assert.ok(!JSON.stringify(out).includes('new'));
});

test('零成交率为 null；缺口、无效帧、跨段不强算', () => {
  const a=pairWindows();
  const zero=Calc.calculate(a.events,[],session());
  assert.equal(zero.windows[0].bid.addition_rate_pct,null);
  const gap=pairWindows(); gap.events[2].gap_warning=true;
  assert.equal(Calc.calculate(gap.events,[],session()).windows.length,1);
  const invalid=pairWindows(); invalid.events[1].payload.rows[0].volume=-1;
  assert.equal(Calc.calculate(invalid.events,[],session()).windows.length,1);
  const cross=pairWindows(); cross.events[2].segment_id='other';
  assert.equal(Calc.calculate(cross.events,[],session()).windows.length,1);
  for(const x of [gap,invalid,cross]) assert.ok(Calc.calculate(x.events,[],session()).excluded_intervals>0);
});

test('窗口内价位后来移出：共同价位口径重算，不把外部余量算作降量', () => {
  const a=pairWindows(), out=Calc.calculate(a.events,[],session());
  const w1=out.windows[1];
  assert.equal(w1.bid.observed_reduction_shares,4);
  assert.ok(w1.visibility_counts.left_five>=1 && w1.visibility_counts.entered_five>=1);
  assert.ok(!w1.visibility_details.some(x=>x.price===96 && x.statistics_eligible));
});

test('原始 depth changes 按帧生成，独立审计可通过且可发现漏回补/篡改旧窗口', () => {
  const a=pairWindows({late:true}), result=Calc.calculate(a.events,a.ticks,session());
  const audit=Audit.calculate(a.events,a.ticks,session(),result);
  assert.deepEqual(Array.from(audit.windows, x=>x.status),['pass','pass']);
  const tam=JSON.parse(JSON.stringify(result)); tam.windows[0].source_trade_volume_shares++;
  assert.equal(Audit.calculate(a.events,a.ticks,session(),tam).windows[0].status,'mismatch');
  const bad=JSON.parse(JSON.stringify(a.events)); bad[1].changes[0].delta_shares++;
  assert.equal(Audit.calculate(bad,a.ticks,session(),result).windows[0].status,'mismatch');
  const noLate=Calc.calculate(a.events,a.ticks.filter(x=>x.id!=='late-old-window'),session());
  const oldTampered=JSON.parse(JSON.stringify(result)); oldTampered.windows[0].source_trade_volume_shares=noLate.windows[0].source_trade_volume_shares;
  assert.equal(Audit.calculate(a.events,a.ticks,session(),oldTampered).windows[0].status,'mismatch');
});
