(() => {
  'use strict';
  const API='https://8767-ij8jq9rmvhtw6m9dy95xp-9c8c966c.us2.manus.computer/api/cls-telegraph';
  const el=id=>document.getElementById(id);
  const ui={date:el('clsDate'),recent:el('clsRecent'),refresh:el('clsRefresh'),auto:el('clsAuto'),status:el('clsStatus'),feed:el('clsFeed'),more:el('clsMore'),count:el('clsCount'),coverage:el('clsCoverage'),context:el('clsContext'),sort:el('clsSort')};
  const chinaDate=(ms=Date.now())=>new Date(ms+8*3600000).toISOString().slice(0,10);
  const data={date:chinaDate(),followToday:true,rows:new Map(),cache:new Map(),cursor:null,gaps:[],generation:0,headBusy:false,backBusy:false,controllers:new Set(),today:chinaDate(),loaded:false,complete:false,historyError:'',headError:'',stamp:'',newCount:0,backTimer:null};
  function bounds(){const start=Date.parse((data.date||chinaDate(Date.now()-2*86400000))+'T00:00:00+08:00')/1000;return {start,end:data.date?start+86400:Date.now()/1000+1};}
  function plain(value){const doc=new DOMParser().parseFromString(String(value||'').replace(/<br\s*\/?\s*>/gi,'\n'),'text/html');return (doc.body.textContent||'').trim();}
  function label(){return data.date||'最近三天';}
  function context(){
    // Read the existing page's selected stock only; never guess missing industries.
    const text=el('stockTitle')?.textContent||'',m=text.match(/^(.+?)（(\d{6})）/);
    let selected=null;
    try{if(typeof state!=='undefined')selected=state;}catch(error){/* Main script has not initialized yet. */}
    if(el('result')?.hidden||selected&&!selected.code||!selected&&!m)return {name:'',code:'',industry:[],tags:[]};
    const industry=(el('stockIndustry')?.textContent||'').replace(/^所属行业：/,'').split(/\s*\/\s*/).filter(x=>x&&!/加载|暂无|待查询|未获取/.test(x));
    const tags=[...(el('stockTags')?.querySelectorAll('.tag')||[])].map(x=>x.textContent.trim());
    return {name:selected?selected.name:m[1],code:selected?selected.code:m[2],industry,tags};
  }
  function buttons(){ui.refresh.disabled=data.headBusy;ui.more.disabled=!data.loaded||data.backBusy||data.complete&&!data.gaps.length;ui.more.textContent=data.backBusy?'正在自动补齐…':data.historyError?'重试自动补齐':data.complete&&!data.gaps.length?'所选范围已加载完':'继续补齐电报';}
  function status(){
    ui.status.classList.toggle('error',!!data.headError);
    const live=!data.date||data.date===chinaDate();
    ui.status.textContent=data.headError||((data.stamp?'官方最新数据读取于 '+data.stamp+'（北京时间）':'正在读取官方最新电报…')+(live?(ui.auto.checked?' · 页面打开时每 30 秒更新':' · 自动更新已关闭'):' · 历史日期，不轮询'));
    const n=data.rows.size;
    ui.coverage.textContent=label()+'：已取得 '+n+' 条 / 已分析 '+n+' 条；'+(data.historyError?'补齐暂时失败，将重试；当前并非完整范围。':data.complete&&!data.gaps.length?'已遍历源站返回的所选日期范围。':data.loaded?'最新一批已分析，正在从新到旧自动补齐，当前尚未完整。':'等待首批数据。')+(data.gaps.length?' 正在补齐两次刷新之间的新增电报。':'');
    buttons();
  }
  function analysis(row,ctx,key){
    const fingerprint=JSON.stringify([row.title,row.content,row.important,key,CLSAnalyzer.version]);
    const cached=data.cache.get(row.id);if(cached?.fingerprint===fingerprint)return cached.value;
    const value=CLSAnalyzer.analyze(row,ctx);data.cache.set(row.id,{fingerprint,value});return value;
  }
  function textNode(tag,text,cls){const n=document.createElement(tag);n.textContent=text;if(cls)n.className=cls;return n;}
  function render(){
    const range=bounds(),oldTop=ui.feed.scrollTop,expanded=new Set([...ui.feed.querySelectorAll('details[open]')].map(x=>x.closest('article').dataset.id));
    for(const [id,row]of data.rows)if(row.timestamp<range.start||row.timestamp>=range.end){data.rows.delete(id);data.cache.delete(id);}
    const ctx=context(),key=JSON.stringify(ctx),rows=[...data.rows.values()].map(row=>({row,a:analysis(row,ctx,key)}));
    const latest=(x,y)=>y.row.timestamp-x.row.timestamp||y.row.id-x.row.id;
    rows.sort((x,y)=>ui.sort.value==='latest'?latest(x,y):Number(y.a.pin)-Number(x.a.pin)||latest(x,y));
    ui.context.textContent=ctx.code?'关联股票：'+ctx.name+'（'+ctx.code+'） · '+(ctx.industry.length?'行业：'+ctx.industry.join(' / '):'行业尚未取得')+' · 已取得 '+ctx.tags.length+' 个标签；更换股票后自动重评。':'未选择股票：仍分析全部电报，并独立识别大盘 / 行业重点；选股后再叠加关联判断。';
    const fragment=document.createDocumentFragment();let group='';
    for(const {row,a}of rows){
      const nextGroup=a.pin?'置顶关注':'其他电报';
      if(ui.sort.value!=='latest'&&group!==nextGroup){group=nextGroup;fragment.append(textNode('h3',group+' · 最新在前','cls-group'));}
      const item=document.createElement('article');item.className='cls-item'+(row.important?' cls-important':'')+(a.pin?' cls-pinned':'');item.dataset.id=String(row.id);
      const time=textNode('time',new Date((row.timestamp+8*3600)*1000).toISOString().slice(0,19).replace('T',' ')+' 北京时间');time.dateTime=row.time;item.append(time);
      const badges=document.createElement('div');badges.className='cls-badges';
      for(const t of [a.pin?'自动置顶':'不置顶','关注分 '+a.score+'/100',a.scope,a.direction])badges.append(textNode('span',t,'tag'));
      item.append(badges);const heading=document.createElement('h3'),link=textNode('a',row.title||row.content.slice(0,75)||(row.content?'':'源站未提供标题及正文'));
      link.href='https://www.cls.cn/detail/'+row.id;link.target='_blank';link.rel='noopener noreferrer';heading.append(link);item.append(heading);
      item.append(textNode('p',row.content||'源站未提供可用电报正文；仅能依据已取得的标题做有限筛选，请查看官方原文。'));
      item.append(textNode('div',(a.pin?'置顶原因：'+a.pinReasons.join('；'):'暂不置顶：未达到市场 / 行业高关注条件，或未命中当前股票关联。'),'cls-reason'));
      const details=document.createElement('details');details.open=expanded.has(String(row.id));details.append(textNode('summary','查看逻辑、评分依据与局限（规则研判）'));
      const list=document.createElement('ul');for(const l of a.logic||[])list.append(textNode('li',l));
      for(const c of a.components||[])list.append(textNode('li',typeof c==='string'?c:c.name+'：'+(c.points>0?'+':'')+c.points+' 分'));
      if(a.matched?.length)list.append(textNode('li','关联命中：'+a.matched.join('；')));
      if(a.evidence?.length)list.append(textNode('li','原文命中：'+a.evidence.join('；')));
      details.append(list,textNode('p',a.caveat||'仅按已取得的电报内容作规则分析，不是价格预测。','hint'));item.append(details);fragment.append(item);
    }
    if(!rows.length)fragment.append(textNode('p',data.loaded?'所选日期暂无源站可返回的电报，或已超出官方保留范围。':'正在读取最新一批电报…','empty'));
    ui.feed.replaceChildren(fragment);ui.feed.scrollTop=oldTop;
    ui.count.textContent='已分析 '+rows.length+' 条 · 置顶 '+rows.filter(x=>x.a.pin).length+' 条'+(data.newCount?' · 本轮新增 '+data.newCount+' 条':'');status();
  }
  async function request(cursor,generation){
    const url=new URL(API);const mode=data.date;if(mode)url.searchParams.set('date',mode);if(cursor!==null)url.searchParams.set('cursor',String(cursor));
    const controller=new AbortController();data.controllers.add(controller);const timer=setTimeout(()=>controller.abort(),20000);
    try{
      const response=await fetch(url,{signal:controller.signal,cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer'});if(!response.ok)throw Error('官方服务暂不可用');
      const result=await response.json();if(generation!==data.generation)return null;
      if(result.source!=='财联社'||!Array.isArray(result.items)||(result.date||'')!==mode)throw Error('数据格式异常');
      return result;
    }finally{clearTimeout(timer);data.controllers.delete(controller);}
  }
  function merge(result){
    const range=bounds();let added=0;
    for(const row of result.items)if(Number.isSafeInteger(row.id)&&row.id>0&&Number.isFinite(row.timestamp)&&row.timestamp>=range.start&&row.timestamp<range.end){
      if(!data.rows.has(row.id))added++;data.rows.set(row.id,{...row,title:plain(row.title),content:plain(row.content)});
    }
    return added;
  }
  function nextCursor(result,current=null){const n=result.next_cursor;return Number.isSafeInteger(n)&&(current===null||n<current)&&n>=bounds().start?n:null;}
  function scheduleBackfill(){
    clearTimeout(data.backTimer);
    if(data.loaded&&!data.backBusy&&!document.hidden&&(!data.complete||data.gaps.length))data.backTimer=setTimeout(backfill,250);
  }
  async function load(){
    if(data.headBusy)return;
    const generation=data.generation;data.headBusy=true;status();
    const previousMax=Math.max(0,...[...data.rows.values()].map(r=>r.timestamp));
    try{
      const result=await request(null,generation);if(!result)return;
      data.newCount=merge(result);const next=nextCursor(result),oldest=Math.min(...result.items.map(r=>r.timestamp));
      if(!data.loaded){data.cursor=next;data.complete=next===null;data.loaded=true;}
      else if(previousMax&&Number.isFinite(oldest)&&oldest>previousMax&&next!==null&&!data.gaps.some(g=>g.stop===previousMax))data.gaps.push({cursor:next,stop:previousMax});
      const stamp=new Date(result.fetched_at);data.stamp=Number.isFinite(stamp.getTime())?new Date(stamp.getTime()+8*3600000).toISOString().slice(11,19):'刚刚';data.headError='';render();
    }catch(error){if(generation===data.generation){data.headError='最新电报暂未更新，保留上次内容及分析；下轮重试或查看官方原文。';status();}}
    finally{if(generation===data.generation){data.headBusy=false;status();scheduleBackfill();}}
  }
  async function backfill(){
    if(data.backBusy||!data.loaded)return;
    const gap=data.gaps[0],cursor=gap?gap.cursor:data.cursor;if(cursor===null){data.complete=true;status();return;}
    const generation=data.generation;data.backBusy=true;status();let success=false;
    try{
      const result=await request(cursor,generation);if(!result)return;
      merge(result);const next=nextCursor(result,cursor),oldest=Math.min(...result.items.map(r=>r.timestamp));
      if(gap){if(next===null||oldest<=gap.stop)data.gaps.shift();else gap.cursor=next;}
      else{data.cursor=next;data.complete=next===null;}
      data.historyError='';success=true;render();
    }catch(error){if(generation===data.generation){data.historyError='failed';status();}}
    finally{if(generation===data.generation){data.backBusy=false;status();if(success)scheduleBackfill();}}
  }
  function choose(date,followToday=date===chinaDate()){
    if(date&&(!/^\d{4}-\d{2}-\d{2}$/.test(date)||date>chinaDate())){ui.date.value=data.date;return;}
    for(const c of data.controllers)c.abort();data.controllers.clear();clearTimeout(data.backTimer);data.generation++;
    Object.assign(data,{date,followToday,rows:new Map(),cache:new Map(),cursor:null,gaps:[],headBusy:false,backBusy:false,loaded:false,complete:false,historyError:'',headError:'',stamp:'',newCount:0});
    ui.date.value=date;ui.feed.scrollTop=0;render();load();
  }
  ui.date.max=chinaDate();ui.date.value=data.date;
  ui.date.addEventListener('change',()=>choose(ui.date.value));ui.recent.addEventListener('click',()=>choose('',false));
  ui.refresh.addEventListener('click',()=>load());ui.more.addEventListener('click',()=>{data.historyError='';backfill();});
  ui.sort.addEventListener('change',render);ui.auto.addEventListener('change',()=>{status();if(ui.auto.checked&&(!data.date||data.date===chinaDate()))load();});
  function tick(){
    const today=chinaDate();ui.date.max=today;
    if(today!==data.today){data.today=today;if(data.followToday||!data.date){choose(data.followToday?today:'',data.followToday);return;}}
    if(!document.hidden){if(ui.auto.checked&&(!data.date||data.date===today))load();else scheduleBackfill();}
  }
  let contextTimer;const observer=new MutationObserver(()=>{clearTimeout(contextTimer);contextTimer=setTimeout(render,150);});
  for(const id of ['stockTitle','stockIndustry','stockTags'])if(el(id))observer.observe(el(id),{childList:true,subtree:true,characterData:true});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)tick();});
  setInterval(tick,30000);render();load();
})();
