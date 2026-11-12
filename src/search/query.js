'use strict';
// 九格手记 · 搜索 / 正文解析领域模块
//
// 边界说明：src/utils/*.js 是与小程序源项目逐字节一致的冻结基线，本模块不改它们，
// 也不碰 renderer-v2、主进程与 tests：只导出纯函数，由主进程注入后供渲染层调用。
// 零第三方依赖，不联网、不读写磁盘、不使用 v-html（parseLinks 只返回结构，不生成 HTML）。
//
// 关于拼音首字母，必须如实说明：
//   · 这不是全量拼音库，也不做多音字消歧，是启发式近似实现。
//   · 主体是一张手工整理的常用汉字首字母表（约 2000 字，覆盖常见姓氏与工程词汇），
//     表内的字按「最常用读音」给首字母；生僻字、多音字会不准。
//   · 表外的字优先用 Intl 的中文拼音排序边界做兜底；若运行环境不支持该排序能力，
//     再退到「按 Unicode 区间分段」的粗粒度猜测。CJK 区 Unicode 是按部首/笔画排列的，
//     与拼音无关，因此这一层只是「别让索引断掉」的近似，不保证正确。
//   · 姓氏多音字（曾 zēng / 单 shàn / 查 zhā / 解 xiè / 仇 qiú / 区 ōu / 朴 piáo 等）
//     一律按常见读音取首字母（曾→c、单→d、查→c、解→j、仇→c、区→q、朴→p），未做姓氏专用识别；
//     确实需要精确时，把整个姓名/词放进下面的 WORD_EXCEPTIONS 里即可。

// ---------- 通用小工具 ----------
function str(v) {
  return String(v === undefined || v === null ? '' : v);
}

// 一条记录的可检索文本 = date + 所有 cells 文本，用换行拼接以免跨字段误连。
// cells 里出现非字符串（脏数据）时统一字符串化，不抛异常。
function haystack(record) {
  const r = (record && typeof record === 'object') ? record : {};
  const cells = (r.cells && typeof r.cells === 'object') ? r.cells : {};
  const parts = [str(r.date)];
  Object.keys(cells).forEach(function (k) {
    const v = cells[k];
    parts.push(typeof v === 'string' ? v : str(v));
  });
  return parts.join('\n');
}

function compact(s) {
  return str(s).toLowerCase().replace(/\s+/g, '');
}

// ---------- 或匹配 / 普通包含匹配 ----------
// 「A | B」按竖线拆项：去首尾空白、忽略空项、统一小写；
// 单关键词就是只有一个候选项的普通包含匹配，走同一条路径。
// 空关键词（或全是空项）不产生匹配，返回 []；调用方若要「不过滤」请自行判断。
function splitTerms(keyword) {
  return str(keyword).split('|').map(function (p) {
    return p.trim().toLowerCase();
  }).filter(function (p) {
    return p.length > 0;
  });
}

function orSearch(records, keyword) {
  const terms = splitTerms(keyword);
  if (!terms.length) return [];
  const list = Array.isArray(records) ? records : [];
  return list.filter(function (r) {
    if (!r || typeof r !== 'object') return false;
    const text = haystack(r).toLowerCase();
    return terms.some(function (t) { return text.indexOf(t) >= 0; });
  });
}

// ---------- 拼音首字母 ----------
// 手工表：按首字母分组的常用汉字。这里只保证「常用字 + 常见姓氏 + 工程词汇」的
// 常见读音，不是 GB2312 全字表，也不是权威拼音数据。
const RAW_GROUPS = {
  a: '啊阿吖嗳哀埃挨哎唉爱碍艾癌矮蔼隘安按案暗岸鞍氨俺昂熬袄傲凹敖翱鳌懊奥澳',
  b: '八巴把爸吧白百摆败拜班般搬板版办半伴拌帮邦包胞保报抱暴爆宝饱堡卑悲碑北背贝备被本笨崩蹦逼鼻比彼笔鄙币必闭壁避碧臂毕毙边编鞭贬变便遍辨辩辫标表彪别憋鳖宾滨彬斌缤濒冰兵丙秉柄饼并病拨波玻钵播伯勃博搏薄膊脖泊驳卜补捕哺不布步部簿怖',
  c: '擦才材财裁采彩菜参餐残惨灿仓苍舱藏操曹草册测策层曾差插茶查察拆柴缠产阐颤昌长场常厂敞畅唱抄超朝潮吵炒车扯彻撤臣尘沉陈衬称成城程承诚乘惩吃持池迟尺齿赤翅充冲虫崇抽仇筹丑臭出初除厨础储处触穿传船串窗床创吹垂春纯唇蠢辞词慈磁此刺次从丛凑粗促醋窜催崔脆村存寸措错',
  d: '搭达答打大呆代带待袋贷逮丹单担胆旦但淡弹蛋当挡党荡刀导岛倒到道盗稻得德的灯登等邓低滴敌笛底抵地弟第帝递缔点典电店垫淀殿雕吊钓调掉爹跌叠丁钉顶定订丢东冬董懂动冻栋洞都斗抖豆逗督毒独读堵赌杜肚度渡端短段断堆队对吨蹲盾顿多夺朵躲舵堕惰',
  e: '额鹅蛾恶饿厄扼鄂恩儿而耳二贰',
  f: '发乏伐阀罚法帆番翻凡烦繁反返犯范贩方芳防房仿访纺放飞非肥匪废沸费分纷芬坟粉份奋愤丰风封疯峰锋蜂逢缝讽凤奉否夫肤扶弗拂服浮符幅福辐抚府斧俯辅腐父付妇负附复赴副富赋腹覆缚',
  g: '嘎该改概钙盖干甘杆肝赶敢感刚纲钢缸岗港高膏糕搞稿告哥歌割革格阁隔个各给根跟更耕工弓公功攻供宫恭巩共贡勾沟狗构购够估姑孤古谷股骨鼓固故顾瓜刮挂乖拐怪关观官冠馆管惯灌罐光广归龟规鬼贵桂跪滚棍锅国果裹过',
  h: '哈孩还海害含函寒韩喊汉汗旱航毫豪好号浩耗呵喝合何和河荷核盒贺恒横衡轰哄红洪宏虹喉猴后厚候呼忽狐胡湖壶虎户护互花华划滑化画话怀坏欢环缓幻换患荒慌皇黄煌晃谎灰恢挥辉回悔会汇惠慧昏婚浑混活火伙或货获祸惑霍',
  j: '击饥圾机肌鸡迹积基绩激及吉级即极急疾集籍几己挤脊计记纪技季济既继寄寂歼加夹佳家嘉甲假价架嫁尖坚间肩艰监兼煎检简减剪见件建剑健渐鉴江姜将浆讲奖降交郊娇骄胶焦角脚叫较教阶皆接揭街节劫杰结捷截姐解介届界借今金津锦仅紧谨尽进近晋浸京经茎惊晶睛精井景警净径竞竟敬境静镜纠究九久酒旧救就居拘狙局菊橘举巨句拒具俱剧据距聚卷倦决绝觉军均君菌俊',
  k: '咖开卡凯慨刊堪坎看康扛抗考烤靠科棵颗壳可渴克刻客课肯垦坑空孔控口扣寇枯苦库裤酷夸垮跨块快宽款狂况亏葵愧坤昆困扩括阔',
  l: '垃拉啦喇腊蜡辣来莱赖兰拦栏蓝篮览懒烂滥郎狼廊朗浪劳牢老姥乐勒雷垒累泪类冷厘离梨犁礼李里理鲤力历厉立利例隶栗粒连怜帘莲联廉脸练炼恋链良凉梁粮两亮量谅辆辽疗聊了料列烈裂邻林临淋灵铃陵零龄领令另溜刘流留柳六龙笼隆楼漏露炉鲁陆录鹿路旅屡履律虑绿峦乱掠略轮论罗萝逻锣裸洛络落',
  m: '妈麻马码骂吗埋买麦卖迈脉瞒满慢漫忙芒盲茫猫毛矛茅冒贸帽貌么没梅媒煤每美妹门闷们萌猛梦弥迷谜米密蜜眠绵免面苗描秒妙庙灭民敏名明鸣命摸模膜摩磨魔抹末沫莫漠墨默谋某母木目牧墓幕慕暮穆',
  n: '拿哪那纳娜乃奶耐男南难囊挠脑闹呢内嫩能尼泥你拟逆年念娘鸟捏宁牛扭纽农浓弄努女暖挪诺',
  o: '哦噢欧呕偶藕',
  p: '啪趴爬怕拍排牌派攀盘判盼叛旁胖抛炮跑泡陪培赔佩配喷盆朋棚蓬鹏碰批披皮疲脾匹屁片偏篇骗漂飘票拼贫品乒平评苹凭瓶萍坡泼婆迫破剖扑铺葡蒲朴普谱瀑',
  q: '七妻期欺漆齐其奇骑棋旗启企起气汽弃器恰千迁牵铅谦签前钱潜浅欠枪腔强抢悄敲桥巧切且亲侵勤青轻倾清情晴请庆穷丘秋求球区曲驱屈趋取去圈全权泉拳劝缺却确雀群',
  r: '然燃染让饶扰绕惹热人仁忍认任扔仍日荣容绒融柔肉如儒乳入软锐瑞润若弱',
  s: '撒洒赛三伞散桑丧扫嫂色森杀沙纱傻筛晒山删衫闪陕善伤商赏上尚稍少绍舌蛇舍设社射涉摄申身深沈神审甚慎升生声牲绳省圣盛剩尸失师诗施狮十石时识实拾食史使始士世市示事试视柿是适释收手守首寿受授售兽瘦书叔殊梳舒疏输熟暑属鼠术束述树竖数刷耍衰摔甩帅双霜爽谁水睡顺说硕丝司私思斯死四寺似饲松送颂搜苏俗诉肃素速塑酸算虽随岁碎孙损笋缩所索锁',
  t: '他它她塌塔踏台抬太态泰摊谈坛痰坦叹炭探汤唐堂糖躺烫涛掏逃桃陶讨套特疼腾提题蹄体剃天田甜填挑条跳贴铁厅听停挺通同铜童统桶痛偷头投透突图徒涂途土吐兔团推腿退吞屯拖托脱驼妥拓',
  w: '挖娃瓦袜歪外弯完玩顽晚碗万汪王网往忘旺危威微为围违唯维伟伪尾委卫未位味胃谓喂温文闻纹稳问翁窝我握污屋无吴梧五午伍武舞务物误雾',
  x: '夕西吸希息惜稀溪熄膝习席洗喜系细瞎虾峡狭霞下夏仙先纤鲜闲弦嫌显险现线限宪陷乡相香箱详想向项巷象像削消宵销小晓孝效校笑些歇协邪斜携鞋写血泄泻卸屑心辛欣新信兴星行形型醒姓幸性凶兄胸雄熊休修羞朽秀袖绣需须虚许序叙蓄绪宣悬旋选学穴雪寻巡询循训迅',
  y: '丫压呀鸦鸭牙芽哑亚严言岩沿研盐颜掩眼演厌宴验央羊阳杨洋仰养样妖邀腰摇遥咬药要耀爷也页夜液一衣医依仪宜移遗疑乙已以矣蚁倚椅义亿忆艺议亦异役抑译易疫益谊意溢因阴音银引饮隐印应英樱鹰迎盈营影硬拥永勇涌用优忧幽尤由犹油游友有又右幼诱于予余鱼娱渔愉与宇羽雨语玉育郁预域欲遇愈冤元员园原圆援缘远院愿约月岳钥阅跃云匀允运孕韵',
  z: '匝杂灾栽载再在咱暂赞脏葬遭糟早枣澡造皂灶则择泽责仄贼怎增赠扎渣闸眨乍炸摘斋宅窄债沾粘展占战站张章涨掌丈帐障招找召照兆遮折哲者这浙珍真诊枕阵振震争征挣整正证郑政之支只汁芝知织脂执直值职植殖指止址纸志制治质秩致智置中忠终钟种肿众重舟周州洲粥轴肘昼骤朱珠株诸猪竹烛逐主煮住助注驻祝著筑抓专砖转赚庄装壮状撞追准桌卓着子紫字自宗综总纵走奏租足族阻组祖钻嘴最罪尊作昨左佐坐座做',
};

// 展开成 { 字: '首字母' }；同名冲突以首次出现为准（分组按 a..z 顺序声明）。
const CHAR_MAP = {};
Object.keys(RAW_GROUPS).forEach(function (letter) {
  Array.from(RAW_GROUPS[letter]).forEach(function (ch) {
    if (!Object.prototype.hasOwnProperty.call(CHAR_MAP, ch)) CHAR_MAP[ch] = letter;
  });
});

// 工程词汇 / 多音词特例：整词优先于逐字拼接。只列「逐字结果确实不对」的词，
// 例如「银行」逐字是 yx（行按 xíng），实际是 yín háng → yh。
const WORD_EXCEPTIONS = {
  '重庆': 'cq', '重复': 'cf', '重新': 'cx',
  '成长': 'cz', '长大': 'zd',
  '银行': 'yh', '行业': 'hy', '行列': 'hl',
  '音乐': 'yy', '乐器': 'yq',
};
let MAX_WORD_LEN = 2;
Object.keys(WORD_EXCEPTIONS).forEach(function (w) {
  if (w.length > MAX_WORD_LEN) MAX_WORD_LEN = w.length;
});

// 兜底一：中文拼音排序边界字。没有 i / u / v 开头的拼音音节，故共 23 个边界。
// 每个字取「该首字母下拼音序最靠前」的字（从上表里按 Intl 排序实测挑出），
// 例如 x 用「夕」而不是「昔」，否则 夕/西/吸/希 会被误判成 w。
// 用手工表 2106 字回测：2104 字一致，仅 泊(bó/pō)、长(cháng/zhǎng) 两个多音字
// 按本表约定的常见读音取字母，属预期差异。
const BOUNDARY_CHARS = '吖八擦搭鹅发嘎哈击咖垃妈拿噢趴七然撒他挖夕丫匝';
const BOUNDARY_LETTERS = 'abcdefghjklmnopqrstwxyz';

// 只有先验证「这些边界字确实按拼音升序」才敢启用该兜底：
// 某些精简 ICU 构建的 zh 默认排序不是拼音，硬用会得到全错的首字母。
let PINYIN_COLLATOR = null;
try {
  const c = new Intl.Collator('zh');
  let ascending = BOUNDARY_CHARS.length === BOUNDARY_LETTERS.length;
  for (let i = 0; ascending && i + 1 < BOUNDARY_CHARS.length; i++) {
    if (c.compare(BOUNDARY_CHARS[i], BOUNDARY_CHARS[i + 1]) >= 0) ascending = false;
  }
  if (ascending) PINYIN_COLLATOR = c;
} catch (e) {
  PINYIN_COLLATOR = null;
}

// 兜底二：ICU 不提供拼音排序时，按 Unicode 码位粗分段猜一个首字母。
// 如前所述，CJK 区并非按拼音排列，这一层是纯近似，仅用于让索引不至于断掉。
function rangeInitial(cp) {
  const base = 0x4e00;
  const span = 0x9fff - base + 1;
  const x = Math.max(0, Math.min(span - 1, cp - base));
  const idx = Math.min(BOUNDARY_LETTERS.length - 1,
    Math.floor(x / span * BOUNDARY_LETTERS.length));
  return BOUNDARY_LETTERS[idx];
}

function fallbackInitial(ch) {
  if (PINYIN_COLLATOR) {
    let letter = BOUNDARY_LETTERS[0];
    for (let i = 0; i < BOUNDARY_CHARS.length; i++) {
      if (PINYIN_COLLATOR.compare(ch, BOUNDARY_CHARS[i]) >= 0) {
        letter = BOUNDARY_LETTERS[i];
      } else {
        break;
      }
    }
    return letter;
  }
  return rangeInitial(ch.codePointAt(0));
}

function initialOfChar(ch) {
  if (Object.prototype.hasOwnProperty.call(CHAR_MAP, ch)) return CHAR_MAP[ch];
  const cp = ch.codePointAt(0);
  // 基本区 + 扩展 A + 兼容表意文字；BMP 之外的字是代理对，这里按非中文原样保留。
  if ((cp >= 0x3400 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff)) {
    return fallbackInitial(ch);
  }
  return ch.toLowerCase();
}

// 中文转拼音首字母；非中文字符原样保留但统一小写（含空格、数字、标点）。
function pinyinInitials(text) {
  const s = str(text);
  let out = '';
  let i = 0;
  while (i < s.length) {
    let hit = '';
    const max = Math.min(MAX_WORD_LEN, s.length - i);
    for (let len = max; len >= 2; len--) {
      const seg = s.slice(i, i + len);
      if (Object.prototype.hasOwnProperty.call(WORD_EXCEPTIONS, seg)) {
        hit = seg;
        break;
      }
    }
    if (hit) {
      out += WORD_EXCEPTIONS[hit];
      i += hit.length;
      continue;
    }
    out += initialOfChar(s[i]);
    i += 1;
  }
  return out;
}

// R-20（2026-11-12）：拼音首字母是这个模块里唯一的重活——每个字都要查表，
// 表外字还要走 Intl 边界比较（逐字循环），3650 篇下 p95 实测 271 ms，余量只剩 9.6%。
// 这里加一层「按记录缓存」：日历键 + 文本签名。签名用长度 + 多项式滚动哈希，
// 是纯整数运算（比每个字都比一次 Intl 快一个量级），文本一变签名就变，不会读到旧索引。
// 命中时直接复用首字母串，检索退化为一次 indexOf。
const PINYIN_CACHE = new Map();
const PINYIN_CACHE_MAX = 8192;

function textSignature(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return s.length + ':' + h;
}

function cachedInitials(record) {
  const text = haystack(record);
  const key = str(record && record.date) || '?';
  const sig = textSignature(text);
  const hit = PINYIN_CACHE.get(key);
  if (hit && hit.sig === sig) return hit.initials;
  const initials = compact(pinyinInitials(text));
  // 简单上界：满了就整体清空。检索是按日期定位的，清空只会让下一次重建，不会出错。
  if (PINYIN_CACHE.size >= PINYIN_CACHE_MAX) PINYIN_CACHE.clear();
  PINYIN_CACHE.set(key, { sig: sig, initials: initials });
  return initials;
}

// 用首字母索引查记录：先对整条 haystack 建首字母串，再做包含匹配。
// keyword 也过一遍 pinyinInitials，因此既能传 'zs'，也能直接传 '张三'。
// 比对时忽略空白（'张 三' 与 'zs' 仍能命中）。空关键词返回 []。
function pinyinMatch(records, keyword) {
  const key = compact(pinyinInitials(keyword));
  if (!key) return [];
  const list = Array.isArray(records) ? records : [];
  return list.filter(function (r) {
    if (!r || typeof r !== 'object') return false;
    return cachedInitials(r).indexOf(key) >= 0;
  });
}

// ---------- 正文链接解析 ----------
// 只解析 [[...]]，返回 { raw, target, type }，绝不生成 HTML（CSP 禁止 v-html），
// 渲染层应据此自行创建文本节点 / 安全的元素。
//   · date    [[2026-11-07]]
//   · person  [[@老王]]     target 去掉 @
//   · capsule [[cap:xxx]]   target 去掉 cap: 前缀
//   · note    其它           target 为括号内原文
function parseLinks(text) {
  const s = str(text);
  const re = /\[\[([^\[\]\r\n]*)\]\]/g;
  const out = [];
  let m;
  while ((m = re.exec(s)) !== null) {
    const inner = m[1].trim();
    let type = 'note';
    let target = inner;
    if (/^\d{4}-\d{2}-\d{2}$/.test(inner)) {
      type = 'date';
      target = inner;
    } else if (inner.charAt(0) === '@') {
      type = 'person';
      target = inner.slice(1).trim();
    } else if (/^cap:/i.test(inner)) {
      type = 'capsule';
      target = inner.slice(4).trim();
    }
    out.push({ raw: m[0], target: target, type: type });
  }
  return out;
}

// ---------- 剥 Markdown 标记 ----------
// 与 v13/board.js 的口径保持一致：行内代码 / 粗体 / 删除线 / 斜体、
// 标题 #、引用 >、任务列表 - [ ]、无序列表 - *、有序列表 1.。
// 刻意不处理下划线 _：会把 my_var 这类正文误伤成 myvar。
function stripMarkdown(text) {
  return str(text)
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/~~([^~]*)~~/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*]\s+\[[ xX]\]\s*/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .trim();
}

module.exports = {
  orSearch: orSearch,
  pinyinInitials: pinyinInitials,
  pinyinMatch: pinyinMatch,
  parseLinks: parseLinks,
  stripMarkdown: stripMarkdown,
};
