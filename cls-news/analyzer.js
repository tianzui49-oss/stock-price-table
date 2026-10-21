/* CLS news rule analyzer: deterministic rules only, not an LLM or price forecast. */
const CLSAnalyzer = (() => {
  const version = '1.1.0';
  const GENERIC = new Set(['政策','消息','公告','融资融券','沪深股通','沪股通','深股通','港股通','北向资金','南向资金','大盘','市场','指数','股票','证券','行业','公司','个股','A股','板块','资金','权重股','大盘股','大盘价值','百日新高','近期新高','低市净率','长期破净','破净股','标准普尔','富时罗素','MSCI中国','机构重仓','保险重仓','HS300_','上证180_']);
  const ALIASES = {
    银行: ['银行','商业银行','国有大行','城商行','农商行','银行业'],
    半导体: ['半导体','芯片','集成电路','晶圆','封装测试','光刻机','存储芯片'],
    证券: ['证券','券商','投行','经纪业务','证券业'],
    光伏: ['光伏','太阳能组件','硅料','硅片','电池片','逆变器'],
    新能源: ['新能源','锂电','动力电池','储能','新能源汽车','电动车'],
    房地产: ['房地产','地产','楼市','保障房','房企','住房'],
    医药: ['医药','创新药','医疗器械','医院','生物医药'],
    有色金属: ['有色金属','铜','铝','锂','稀土','黄金'],
    军工: ['军工','国防','航空航天','装备制造'],
    AI: ['人工智能','AI','大模型','算力','智能驾驶'],
    消费: ['消费','零售','家电','食品饮料','白酒']
  };
  // MAJOR is deliberately composed of actor/object + substantive action, not authority names alone.
  const MAJOR = [
    ['货币/财政/监管', /(?:央行|人民银行|国务院|财政部|证监会|金融监管总局|监管部门).{0,24}(?:降准|降息|降贷款利率|降存款准备金|存款准备金|公开市场操作|特别国债|超长期国债|重大财税|资本市场改革|系统性风险处置|救市|监管新规|正式实施|发布(?:新政|方案|办法|规定))|主要政策利率|利率调控机制改革/s, 31],
    ['跨市场风险', /(?:全球股市|美股|欧股|港股|原油|国际油价|汇率|人民币|债市).{0,12}(?:暴跌|大跌|暴涨|大幅(?:上涨|下跌|波动)|剧烈波动)|(?:供应中断|大规模减产|停产|禁运|地缘冲突升级).{0,18}(?:原油|能源|全球市场|大宗商品)/, 27],
    ['行业供需/技术', /(?:工信部|国务院|发改委|监管部门).{0,24}(?:发布|出台|实施|推出).{0,20}(?:半导体|芯片|光伏|新能源|医药|房地产|行业|产业).{0,20}(?:新政|扶持|规范|政策|方案)|(?:半导体|芯片|光伏|新能源|医药|房地产|[\u4e00-\u9fa5]{2,8}行业|[\u4e00-\u9fa5]{2,8}产业).{0,12}(?:全行业)?(?:停产|限产|大规模减产|供给侧改革|产能置换|供需失衡|供应中断|出口管制|禁运|重大技术突破|量产落地|价格暴涨|价格暴跌|大幅涨价|大幅降价)/, 24]
  ];
  const NEG = /辟谣|澄清|否认|不实|假消息|传闻|传言|网传|据传|(?:拟|计划|将于|拟于)(?:实施|落地|启动|执行|推出|发布新政|停产|限产|减产|回购|涨价)|(?:或将|可能)(?:实施|落地|启动|停产|限产|涨价|降价)|尚未(?:实施|落地|获批|证实)|未获证实|不代表|(?:没有|未|不存在|未出现)(?:涨价|回购|退市风险|风险)/;
  const POS = /获批|落地|正式实施|签署|公布|发布|突破|量产|涨价|降准|降息|增持|回购|中标|订单|重组|并购|减产|限产/;
  const BAD = /暴跌|大跌|下滑|下降|亏损|违约|减持|处罚|立案|退市|爆雷|风险|事故|封锁|禁令|制裁/;
  const GOOD = /上涨|大涨|利好|增长|盈利|增持|回购|获批|中标|突破|涨价/;
  function textOf(row) { return String((row && row.title) || '') + ' ' + String((row && row.content) || ''); }
  function clean(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  function esc(s) { return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function hasCode(text, code) { const c = clean(code); if (!c || !/^\d{4,8}$/.test(c)) return false; return new RegExp('(?<!\\d)' + esc(c) + '(?!\\d)').test(text); }
  function aliasesFor(value, industryContext = false) {
    const s = clean(value); if (!s) return [];
    // Generic tags never create a false industry hit. “证券” is meaningful only as an industry selector,
    // and then maps to specific brokerage terms rather than matching every occurrence of 证券.
    if (GENERIC.has(s) && !(industryContext && s === '证券')) return [];
    const out = new Set();
    Object.keys(ALIASES).forEach(k => { if (k === s || ALIASES[k].includes(s)) ALIASES[k].forEach(x => out.add(x)); });
    if (s === '证券' && industryContext) out.delete('证券');
    if (!out.size && s.length >= 2) out.add(s);
    return [...out].filter(x => x.length >= 2 && !GENERIC.has(x));
  }
  function analyze(row, context = {name:'', code:'', industry:[], tags:[]}) {
    row = row || {}; const title = clean(row.title), content = clean(row.content), text = clean(title + ' ' + content);
    const evidence = [], logic = [], pinReasons = [], matched = [], components = [];
    if (!title && !content) return {score:0,pin:false,pinReasons:[],scope:'信息不足',direction:'中性',logic:['标题和正文均为空，无法研判'],evidence:[],caveat:'空内容：未进行实质判断。',matched:[],components:[{name:'基础',points:0}],version};
    let score = 8; components.push({name:'基础',points:8});
    const insufficient = !content || text.length < 18;
    if (insufficient) { score -= 8; components.push({name:'正文缺失/过短',points:-8}); evidence.push('正文缺失或摘要过短'); logic.push('仅按可见摘要分析，证据不足，实际影响无法确认'); }
    let major = false;
    for (const [name,re,points] of MAJOR) if (re.test(text)) {
      major = true; score += points; components.push({name,points});
      evidence.push(name + '特征：' + (text.match(re)||[''])[0]);
      if (name === '货币/财政/监管') logic.push('政策主体实施实质动作 → 改变流动性、资金成本或监管约束 → 影响市场估值与风险偏好');
      else if (name === '跨市场风险') logic.push('大幅价格波动或供应事件 → 改变商品/汇率与成本预期 → 传导至通胀、利润和风险偏好');
      else logic.push('行业供需、技术或政策动作 → 改变供给/需求与竞争格局 → 传导至产品价格、利润和产业链预期');
    }
    if (row.important === true || row.important === 1 || row.important === '1') { score += 5; components.push({name:'源站标记加权',points:5}); logic.push('保留财联社源站重要标记的少量加权，不单独认定重大'); }
    const neg = NEG.test(text); const positive = POS.test(text);
    // A negated risk statement is not itself a bearish event.
    const riskNegated = /(?:没有|未|不存在|未出现)(?:明显)?(?:风险|退市风险)/.test(text);
    const directionUncertain = neg || /不(?:等于|宜(?:炒作成)?|代表).{0,8}(?:降息|利好|涨价|回购)|利率调控机制改革|主要政策利率/.test(text);
    const directionalText=text.replace(/(?:公开市场|隔夜|逆|正)?回购(?:利率|操作|期限|市场)/g,'货币操作');
    const bad = BAD.test(directionalText) && !riskNegated; const good = GOOD.test(directionalText) && !directionUncertain;
    if (neg) { score -= 22; components.push({name:'否定/传闻/拟议降权',points:-22}); logic.push('否定、传闻或拟议动作仅表示不确定性，不视为已落地事件'); evidence.push('风险措辞：' + (text.match(NEG)||[''])[0]); }
    if (bad && !neg) { score += 5; components.push({name:'风险方向',points:5}); }
    if (good && !bad && !neg) { score += 3; components.push({name:'事件确认',points:3}); }
    const name = clean(context.name), code = clean(context.code);
    if (name && name.length >= 2 && text.includes(name)) { matched.push('公司：' + name); evidence.push('直接出现股票名称'); }
    if (hasCode(text, code)) { matched.push('代码：' + code); evidence.push('以数字边界匹配股票代码'); }
    for (const v of [].concat(context.industry || [])) for (const a of aliasesFor(v, true)) if (text.includes(a) && !matched.includes('行业：'+a)) matched.push('行业：' + a);
    for (const v of [].concat(context.tags || [])) for (const a of aliasesFor(v, false)) if (text.includes(a) && !matched.includes('行业：'+a)) matched.push('行业：' + a);
    const direct = matched.some(x => x.startsWith('公司：') || x.startsWith('代码：')); const related = matched.some(x => x.startsWith('行业：'));
    if (direct) { score += 18; components.push({name:'直接关联',points:18}); pinReasons.push('出现所选股票名称或边界代码'); logic.push('新闻直接关联所选股票；可解释传导为事件影响公司收入、成本或估值，但方向仍需结合基本面'); }
    else if (related) { score += 10; components.push({name:'行业/标签关联',points:10}); pinReasons.push('命中所选行业或标签别名'); logic.push('新闻命中行业对象 → 通过供需、成本或政策约束影响行业利润预期；不据此猜测具体公司'); }
    if (neg && /(?:否认|没有|未)(?:涨价|回购)/.test(text)) logic.push('否认涨价/回购不按利好处理');
    if (!major && !direct && !related) logic.push('未匹配到重大事件或所选标的；未匹配不等于无价值，仅表示规则未识别出明确传导链');
    score = Math.max(0, Math.min(100, Math.round(score)));
    let direction = '中性'; if (!directionUncertain && bad && !good) direction = '偏空'; else if (!directionUncertain && good && !bad) direction = '偏多'; else if (!directionUncertain && bad && good) direction = '分化';
    // Base 8 + a confirmed trigger (24) is enough to pin; short-body deduction remains visible.
    const pin = Boolean((major && score >= 24) || direct || related);
    if (pin && major) pinReasons.unshift('高影响大盘/行业事件');
    let scope = major ? '大盘/行业' : (direct ? '个股' : (related ? '行业关联' : '一般资讯'));
    if (insufficient) scope = scope === '一般资讯' ? '信息不足' : scope + '（信息不足）';
    const caveat = '规则研判不是大模型；不构成投资建议，也不提供确定股价预测。' + (insufficient ? '正文为空或过短，结论置信度较低。' : '');
    return {score,pin,pinReasons: pin ? pinReasons : [],scope,direction,logic,evidence,caveat,matched,components,version};
  }
  return {analyze, version};
})();
if (typeof module !== 'undefined' && module.exports) module.exports = CLSAnalyzer;
