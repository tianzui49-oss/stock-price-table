const assert = require('node:assert/strict');
const CLSAnalyzer = require('./analyzer.js');
const run = (title, content = '', context = {}) => CLSAnalyzer.analyze({title, content}, context);
assert.equal(CLSAnalyzer.version, '1.1.0');

// 1 无选股重大政策：仍置顶
let r = run('央行宣布降准并释放长期流动性', '货币政策正式实施，支持实体经济。');
assert.equal(r.pin, true); assert.ok(r.score >= 35); assert.match(r.scope, /大盘/);
// 2 高影响行业事件
r = run('半导体行业供给侧改革推进，部分产能调整', '行业供需格局发生重大变化。');
assert.equal(r.pin, true); assert.match(r.scope, /行业/);
// 3 普通非关联不置顶
r = run('某公司举办年度活动', '员工交流与品牌宣传，没有经营政策变化。', {name:'宁德时代', code:'300750', industry:['新能源'], tags:['电池']});
assert.equal(r.pin, false);
// 4 直接股票名称关联
r = run('宁德时代签署电池订单', '公司公告获得客户订单。', {name:'宁德时代', code:'300750'});
assert.equal(r.pin, true); assert.ok(r.matched.some(x => x.includes('公司')));
// 5 标签/行业别名（半导体 -> 芯片）
r = run('芯片设备需求回暖', '半导体产业链订单改善。', {name:'某股', code:'600001', industry:['半导体']});
assert.equal(r.pin, true); assert.ok(r.matched.some(x => x.includes('行业')));
// 6 辟谣/否定，不当成利好
r = run('公司辟谣：没有涨价也没有回购计划', '网传消息不实。', {name:'测试公司', code:'600123'});
assert.equal(r.direction, '中性'); assert.ok(r.score < 30); assert.ok(r.logic.some(x => x.includes('否认涨价')));
// 7 空内容
r = run('', '', {}); assert.equal(r.score, 0); assert.equal(r.pin, false); assert.equal(r.scope, '信息不足');
// 8 代码子串不得匹配：300750 不应匹配 13007501
r = run('市场出现代码13007501的普通公告', '无重大事项。', {name:'宁德时代', code:'300750'});
assert.equal(r.pin, false); assert.ok(!r.matched.some(x => x.includes('代码')));
// 9 泛标签（融资融券/沪深股通）不得乱匹配
r = run('融资融券余额小幅变化', '沪深股通日常成交。', {name:'测试', code:'600999', industry:['银行'], tags:['融资融券','沪深股通']});
assert.equal(r.pin, false); assert.equal(r.matched.length, 0);
// 10 普通“政策”和数字本身不应重大置顶
r = run('公司发布日常政策说明', '今年完成3项培训，经营正常。');
assert.equal(r.pin, false); assert.ok(r.score < 45);

// 11 机构名称/宽泛行业词单独出现不得重大
r = run('央行召开金融形势研讨会', '与会专家交流宏观经济看法。');
assert.equal(r.pin, false); assert.ok(!r.pinReasons.length);
r = run('国际油价小幅波动', '市场交投平稳。');
assert.equal(r.pin, false);

// 12 明确主体+实质政策动作及行业供需动作才重大
r = run('工信部发布半导体产业扶持新政', '政策正式实施，支持产业链升级。');
assert.equal(r.pin, true); assert.ok(r.logic.some(x => x.includes('供给/需求')));
r = run('芯片全行业停产', '供应中断导致产业链供给收缩。');
assert.equal(r.pin, true);
r = run('光伏行业限产', '企业按要求调整产能。');
assert.equal(r.pin, true);

// 13 拟议/模拟语境与否认风险不应误判，计划纲要发布本身已落地
r = run('拟实施芯片出口管制', '相关方案尚待审批。');
assert.equal(r.direction, '中性'); assert.ok(r.score < 30);
r = run('计划纲要发布', '有关部门公布产业发展纲要。');
assert.equal(r.direction, '中性'); assert.ok(!r.logic.some(x => x.includes('拟议')));
r = run('公司不存在退市风险', '经营正常，未出现重大风险。');
assert.notEqual(r.direction, '偏空');

// 14 证券行业映射券商，但泛证券标签和地域/交易标签不乱匹配
r = run('券商经纪业务收入改善', '证券业景气回升。', {industry:['证券']});
assert.equal(r.pin, true); assert.ok(r.matched.some(x => x.includes('券商')));
r = run('证券市场日常成交', '沪深股通融资融券余额变化。', {industry:['证券'], tags:['融资融券','沪深股通']});
assert.equal(r.pin, false); assert.equal(r.matched.length, 0);

// 15 无命中逻辑非空，正文缺失实际扣分且组件可见
r = run('普通市场消息', '');
assert.ok(r.logic.length); assert.ok(r.components.some(x => x.name.includes('正文'))); assert.ok(r.score < 8);

// 16 真实样本：权重股等宽泛风格标签不代表银行股票关联
r = run('创业板指跌逾1% 宁德时代跌近11%', '创业板指权重股宁德时代下跌。', {name:'浦发银行', code:'600000', industry:['银行'], tags:['权重股','大盘股','MSCI中国','沪股通']});
assert.equal(r.pin, false); assert.equal(r.matched.length, 0);
// 17 政策利率机制改革可以无选股置顶，但不能读成降息利好
r = run('公开市场隔夜回购利率将成主要政策利率 不宜炒作成降息', '中国人民银行表示调整利率调控机制，此次改革不等于降息。');
assert.equal(r.pin, true); assert.equal(r.direction, '中性');
// 18 逆回购操作不等于公司回购股份
r = run('公开市场隔夜逆回购利率保持不变', '市场资金面平稳。');
assert.notEqual(r.direction, '偏多');
console.log('PASS: 28 analyzer tests');
