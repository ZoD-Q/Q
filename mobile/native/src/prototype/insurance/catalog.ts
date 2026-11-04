export type Copy = readonly [string, string];
// Regulatory class axis (Insurance Law §95): personal (life & health) vs property insurance.
export const regClasses = { life: ['人身保险', 'Personal insurance'], property: ['财产保险', 'Property insurance'] } as const;
export type RegClass = keyof typeof regClasses;
// Mutually exclusive product-form tag; form entries and riders are never counted as standalone coverage types.
export const formTags = { main: ['主险', 'Main policy'], rider: ['附加险', 'Rider'], 'form-only': ['形态类条目', 'Product form entry'] } as const;
export type FormTag = keyof typeof formTags;
// Regulatory sub-classes (Insurance Law §95 business scope; Health Insurance Measures §2).
export const regSubLabels = {
  'health-medical': ['医疗保险', 'Medical insurance'],
  'health-illness': ['疾病保险', 'Disease insurance'],
  'health-care': ['护理保险', 'Long-term care insurance'],
  accident: ['意外伤害保险', 'Accident insurance'],
  'life-insurance': ['人寿保险', 'Life insurance'],
  annuity: ['年金保险', 'Annuity insurance'],
  'participating-form': ['新型产品形态（分红/万能/投连）', 'Participating / universal / unit-linked form'],
  'property-loss': ['财产损失保险', 'Property loss insurance'],
  liability: ['责任保险', 'Liability insurance'],
  agriculture: ['农业保险', 'Agricultural insurance'],
  credit: ['信用保险', 'Credit insurance'],
  surety: ['保证保险', 'Surety insurance'],
} as const;
export type RegSub = keyof typeof regSubLabels;
// Per-entry content review date; bump an entry's value when its copy is revised.
export const CATALOG_UPDATED_AT = '2026-10-22';
export type Group = { id: string; title: Copy; questions: Copy; claims: Copy; regBasis: string };
export const groups: Group[] = [
  { id: 'health', title: ['健康医疗', 'Health'], questions: ['是否覆盖既往症？等待期、免赔额、医院范围和续保条件是什么？', 'Check pre-existing conditions, waiting period, deductible, hospitals and renewal.'], claims: ['通常需诊断证明、病历、费用明细和发票；给付型还需符合条款的诊断或状态证明。', 'Usually diagnosis, records and itemized receipts; fixed benefits require evidence meeting policy definitions.'], regBasis: '人身保险 · 健康保险（《健康保险管理办法》§2）：8 个入口落入医疗保险、疾病保险、护理保险三类；失能收入损失保险与医疗意外保险暂无入口，为已知空白。' },
  { id: 'accident', title: ['意外出行', 'Accident & travel'], questions: ['职业、运动、目的地与出行天数是否在承保范围？救援是否需事先联系？', 'Check occupation, sports, destination, trip length and assistance authorization.'], claims: ['事故经过、医疗资料和费用凭证；交通事故或延误可能需相关部门证明。', 'Incident details, medical records and receipts; transport incidents may require official reports.'], regBasis: '人身保险为主，交叉地带 · 意外伤害保险：《保险法》§95 允许财产险公司经批准经营短期意外险，一年期产品承保主体可为人身险或财产险公司。' },
  { id: 'life', title: ['人寿养老', 'Life & retirement'], questions: ['保障期限、缴费期、受益人、退保现金价值如何约定？哪些利益保证、哪些不保证？', 'Check term, premiums, beneficiaries, surrender value and guaranteed versus non-guaranteed benefits.'], claims: ['保单、受益关系及保险事故证明；领取年金按合同约定提供生存等材料。', 'Policy, beneficiary relationship and event evidence; annuity payouts follow contract documentation.'], regBasis: '人身保险 · 人寿保险与年金保险；末位条目为新型产品形态（分红/万能/投连），属形态类条目，非独立险种，统计险种数量时应排除。' },
  { id: 'motor', title: ['车险', 'Motor'], questions: ['车辆用途是否准确？保额、免赔和附加险如何约定？新能源专属责任有哪些？', 'Check vehicle use, limits, deductibles, riders and EV-specific coverage.'], claims: ['及时报案，准备事故照片、驾驶及行驶资料、定损与维修凭证，依事故补充责任认定。', 'Report promptly; retain photos, vehicle and driver documents, damage assessment and repair receipts.'], regBasis: '财产保险 · 财产损失保险（车损）＋责任保险（交强、三者、车上人员）；交强险为法定强制险种，附加险依附主险存在。' },
  { id: 'home', title: ['家庭财产', 'Home & property'], questions: ['房屋、物品、责任分别保什么？自然灾害、盗抢、折旧和免赔是否有限制？', 'Check building, contents, liability, disaster exclusions, theft, depreciation and deductibles.'], claims: ['损失照片、财产归属和价值证明、维修清单；必要时提供消防或警方证明。', 'Damage photos, ownership/value evidence and repair estimates; fire or police reports when required.'], regBasis: '财产保险 · 财产损失保险（家财）＋责任保险（家庭/租客责任、宠物责任）；宠物医疗费用部分按医疗保险逻辑组织，承保形态以财产险公司产品居多。' },
  { id: 'business', title: ['企业责任', 'Business & liability'], questions: ['营业范围、人员和场所是否完整申报？事故发生制还是索赔提出制？是否涵盖法律费用？', 'Check declared operations, people, premises, occurrence/claims-made basis and legal costs.'], claims: ['事故记录、责任依据、受损方材料和损失清单；按合同确认和解前是否需保险人同意。', 'Incident records, liability evidence and loss schedules; check insurer consent before settlement.'], regBasis: '财产保险 · 责任保险（雇主、公众、产品、职业）＋财产损失（企财、营业中断）＋意外健康（团体）；团体意外/健康险是板块内唯一人身险条目，雇主责任不替代法定工伤参保。' },
  { id: 'engineering', title: ['工程运输', 'Engineering & cargo'], questions: ['项目、路线、货物和工期是否准确？运输区段、试车期、免赔及除外如何约定？', 'Check project, route, cargo, duration, transit stages, testing periods, deductibles and exclusions.'], claims: ['合同、货运或工程文件、检验报告、事故及损失证明。', 'Contracts, shipping/project documents, survey reports and incident/loss evidence.'], regBasis: '财产保险 · 工程保险、运输工具险、货物运输保险（财产损失类）；船舶/航空涉及专业核保与航行区域限制。' },
  { id: 'agriculture', title: ['农业信用', 'Agriculture & credit'], questions: ['承保标的、地域及触发条件是什么？补贴资格、赔偿比例或追偿义务如何约定？', 'Check insured subject, region, triggers, subsidy eligibility, indemnity share and recovery obligations.'], claims: ['农业需标的及灾损证明；信用保证需交易、履约、欠款与催收等证据。', 'Agriculture needs insured-subject and disaster evidence; credit/surety needs transaction, default and recovery records.'], regBasis: '财产保险 · 农业保险（种植、养殖、森林，《保险法》§184 由法律行政法规另行规定）＋信用保险＋保证保险；信用保证保险涉及追偿安排。' },
];
export const sources = [
 { title: ['中国平安 · 保险产品目录', 'Ping An · insurance directory'] as Copy, url: 'https://www.pingan.com/official/insurance/' },
 { title: ['新华保险 · 产品目录', 'New China Life · products'] as Copy, url: 'https://www.newchinalife.com/spage/cn/266/index.html' },
 { title: ['中国人保 · 子公司与业务介绍', 'PICC · company and business overview'] as Copy, url: 'https://www.picc.com.cn/gyrb/jtjs/zgsjs/' },
];
// Initial per-entry reference sources follow each organisation's public directory scope; override per entry when needed.
const groupSources: Record<string, { title: Copy; url: string }[]> = {
  health: [sources[0], sources[1]], accident: [sources[0], sources[1]], life: [sources[1]],
  motor: [sources[2]], home: [sources[0], sources[2]], business: [sources[0], sources[2]],
  engineering: [sources[2]], agriculture: [sources[2]],
};
// Editorial navigation categories, not a regulatory taxonomy or an inventory of live products. Scene navigation stays primary for users; regClass / regSub / formTag carry the regulatory attribution for filtering, agent answers and maintenance.
type Seed = readonly [string, string, string, string, string, string, string, RegClass, RegSub, FormTag];
const seeds: Seed[] = [
 ['medical','health','百万医疗险','Major medical','住院等大额医疗费用报销','Reimbursement for eligible major medical expenses','免赔额、医保结算与续保','life','health-medical','main'],
 ['outpatient','health','门急诊医疗险','Outpatient medical','约定门急诊费用报销','Eligible outpatient and emergency costs','次限额、指定医院与药品','life','health-medical','main'],
 ['premium-medical','health','中高端医疗险','Premium medical','较广医院网络及约定医疗服务','Broader hospital networks and covered services','直付网络、地域与预授权','life','health-medical','main'],
 ['critical','health','重大疾病保险','Critical illness','达到约定疾病定义或状态时给付','Benefit on a defined diagnosis or condition','疾病定义、等待期与赔付次数','life','health-illness','main'],
 ['cancer','health','防癌保险','Cancer cover','癌症给付或癌症医疗报销，依产品区分','Cancer benefit or medical reimbursement depending on policy','给付型与报销型不能混同','life','health-illness','main'],
 ['city-medical','health','惠民保 / 城市补充医疗','City supplemental medical','当地基本医保之外的补充医疗保障','Local supplemental medical coverage','参保地域、医保资格与年度条款','life','health-medical','main'],
 ['care','health','商业长期护理险','Long-term care','达到约定失能或护理状态的保障','Benefits for defined dependency or care needs','失能评定与给付条件；区别于社会长护险','life','health-care','main'],
 ['special-drug','health','特药医疗险','Specialty drug cover','符合约定的特定药品费用','Eligible named specialty medicines','药品清单、适应症及指定药房','life','health-medical','main'],
 ['personal-accident','accident','综合意外险','Personal accident','意外身故、伤残及可选意外医疗','Accidental death, disability and optional medical cover','职业类别、高风险运动及意外定义','life','accident','main'],
 ['travel','accident','境内旅游险','Domestic travel','旅行意外及可选医疗、救援和行程保障','Travel accident with optional medical, assistance and disruption','目的地、运动项目与出发前投保要求','life','accident','main'],
 ['overseas','accident','境外旅游 / 留学险','Overseas travel & study','境外医疗、救援及约定旅行风险','Overseas medical, assistance and specified travel risks','地区、签证要求、救援限额','life','accident','main'],
 ['transport','accident','交通意外险','Transport accident','乘坐约定交通工具期间的意外保障','Accidents involving specified transport','交通工具范围及保障起止时间','life','accident','main'],
 ['senior-accident','accident','少儿 / 老年意外险','Child & senior accident','面向特定年龄段的意外保障','Age-specific accident protection','年龄、骨折责任与医疗报销范围','life','accident','main'],
 ['term-life','life','定期寿险','Term life','约定期限内的身故及约定全残保障','Death and specified total disability within a fixed term','免责、健康告知与保额限制','life','life-insurance','main'],
 ['whole-life','life','终身寿险','Whole life','终身身故保障，部分产品有现金价值安排','Lifetime death coverage and contractual cash value','现金价值不等于已缴保费','life','life-insurance','main'],
 ['annuity','life','年金保险','Annuity','按合同时间与条件领取生存年金','Scheduled benefits subject to survival and policy terms','领取条件、退保损失与流动性','life','annuity','main'],
 ['pension','life','商业养老年金险','Retirement annuity','养老阶段按约定领取年金','Contractual retirement income','领取年龄、保证领取期与缴费能力','life','annuity','main'],
 ['participating','life','分红 / 万能 / 投连型保险','Participating / universal / unit-linked','不同利益机制的人身保险形态','Life insurance with different benefit mechanisms','不是独立保障险种；分红不保证，投连有投资风险','life','participating-form','form-only'],
 ['compulsory','motor','交强险','Compulsory motor liability','机动车事故中法定范围的第三方损害','Statutory third-party motor accident cover','法定分项限额与责任范围','property','liability','main'],
 ['motor-third','motor','商业第三者责任险','Motor third-party liability','约定范围内第三方人身或财产损失','Covered third-party injury and property damage','与交强险衔接及责任限额','property','liability','main'],
 ['motor-damage','motor','机动车损失险','Own vehicle damage','约定事故造成的本车损失','Covered damage to the insured vehicle','定损、车辆价值与免责','property','property-loss','main'],
 ['motor-occupant','motor','车上人员责任险','Vehicle occupant liability','约定车上人员伤亡责任','Covered liability for vehicle occupants','座位、责任范围与保额','property','liability','main'],
 ['ev','motor','新能源汽车专属保险','Electric vehicle insurance','新能源车专属条款下的车损和责任保障','EV-specific vehicle damage and liability coverage','电池、电机、电控与充电场景按条款核对','property','property-loss','main'],
 ['motor-riders','motor','车险附加险','Motor riders','按需补充主险之外的约定责任','Additional protection attached to motor policies','需依附主险，不能默认全部包含','property','property-loss','rider'],
 ['home-property','home','家庭财产保险','Home property','房屋及约定室内财产损失','Covered building and household contents losses','财产清单、自然灾害与价值限额','property','property-loss','main'],
 ['home-liability','home','家庭责任 / 租客责任险','Household & tenant liability','家庭或租赁场景的约定第三方责任','Specified household or tenancy liability','漏水、高空坠物等责任需逐项核对','property','liability','main'],
 ['pet','home','宠物医疗 / 责任险','Pet medical & liability','宠物医疗费用或约定第三方责任','Eligible pet medical expenses or liability','品种、年龄、指定医院及免赔','property','liability','main'],
 ['employer','business','雇主责任险','Employers liability','雇主依法承担的约定员工伤亡责任','Covered employer liability for employee injury','不替代法定工伤参保义务','property','liability','main'],
 ['group','business','团体意外 / 健康险','Group accident & health','为约定团体成员提供人身保障','Accident or health coverage for enrolled members','人员清单、职业、增减员规则','life','accident','main'],
 ['public-liability','business','公众责任险','Public liability','经营场所或活动中的第三方损害责任','Third-party liability at premises or events','场所、活动范围与除外责任','property','liability','main'],
 ['product-liability','business','产品责任险','Product liability','产品缺陷导致的约定第三方损害责任','Covered injury or damage caused by defective products','销售区域、产品范围与召回除外','property','liability','main'],
 ['professional','business','职业责任险','Professional indemnity','专业服务疏失引起的约定赔偿责任','Covered liability arising from professional errors','追溯期、索赔提出期与执业范围','property','liability','main'],
 ['business-property','business','企业财产 / 营业中断险','Business property & interruption','企业财产损失及约定触发下的营业损失','Property loss and eligible business interruption','营业中断通常需约定物损触发','property','property-loss','main'],
 ['cyber','business','网络安全责任险','Cyber insurance','约定网络事件造成的费用及责任','Specified cyber-event costs and liability','安全措施、等待期和事件除外','property','liability','main'],
 ['construction','engineering','建筑 / 安装工程一切险','Construction & erection risks','工程期间约定物质损失及第三方责任','Covered project damage and third-party liability','一切险也有除外，核对工期和试车期','property','property-loss','main'],
 ['machinery','engineering','机器损坏保险','Machinery breakdown','约定机械设备突发损坏','Specified sudden machinery damage','磨损、维护与停工损失除外','property','property-loss','main'],
 ['cargo','engineering','货物运输保险','Cargo transit','约定运输期间的货物损失','Covered cargo losses during transit','运输区段、包装、货物性质','property','property-loss','main'],
 ['marine','engineering','船舶 / 航空保险','Marine & aviation','船舶航空器及约定运营责任','Marine/aircraft hull and specified operating liability','专业核保、航行区域和用途','property','property-loss','main'],
 ['crop','agriculture','种植业保险','Crop insurance','约定灾害导致的作物损失','Crop losses from specified perils','品种、地区、灾损标准与补贴政策','property','agriculture','main'],
 ['livestock','agriculture','养殖业保险','Livestock insurance','约定牲畜或水产养殖风险','Specified livestock or aquaculture risks','防疫条件、死亡原因与标的识别','property','agriculture','main'],
 ['forest','agriculture','森林保险','Forestry insurance','约定林木灾害损失','Specified forestry disaster losses','林种、面积与灾害责任','property','agriculture','main'],
 ['credit','agriculture','信用保险','Credit insurance','约定买方违约造成的应收账款损失','Covered receivable losses following buyer default','买方信用限额、贸易真实性与免赔','property','credit','main'],
 ['surety','agriculture','保证保险','Surety insurance','约定被保证人不履约引起的损失','Covered loss from specified non-performance','承保不等于免除债务，可能涉及追偿','property','surety','main'],
];
export const insuranceTypes = seeds.map(([id, group, zh, en, coverageZh, coverageEn, caution, regClass, regSub, formTag]) => ({ id, group, title: [zh, en] as Copy, coverage: [coverageZh, coverageEn] as Copy, caution, regClass, regSub, formTag, updatedAt: CATALOG_UPDATED_AT, sources: groupSources[group] ?? [] }));
export type InsuranceType = (typeof insuranceTypes)[number];
// Official application entries per group: enumeration of three insurers active in that direction.
// Never a ranking, recommendation or evidence of partnership; applications happen on these official
// channels only. Q does not place applications or collect premiums.
export type InsurerRef = { name: Copy; host: string; url: string };
export const groupInsurers: Record<string, readonly InsurerRef[]> = {
  health: [
    { name: ['平安保险', 'Ping An'], host: 'baoxian.pingan.com', url: 'https://baoxian.pingan.com/product/' },
    { name: ['中国人寿', 'China Life'], host: 'www.chinalife.com.cn', url: 'https://www.chinalife.com.cn/' },
    { name: ['泰康保险', 'Taikang'], host: 'www.taikang.com', url: 'https://www.taikang.com/' },
  ],
  accident: [
    { name: ['平安保险', 'Ping An'], host: 'baoxian.pingan.com', url: 'https://baoxian.pingan.com/product/' },
    { name: ['中国人保', 'PICC'], host: 'property.picc.com', url: 'https://property.picc.com/piccinternal/' },
    { name: ['众安保险', 'ZhongAn'], host: 'www.zhongan.com', url: 'https://www.zhongan.com/' },
  ],
  life: [
    { name: ['中国人寿', 'China Life'], host: 'www.chinalife.com.cn', url: 'https://www.chinalife.com.cn/' },
    { name: ['新华保险', 'New China Life'], host: 'www.newchinalife.com', url: 'https://www.newchinalife.com/' },
    { name: ['泰康保险', 'Taikang'], host: 'www.taikang.com', url: 'https://www.taikang.com/' },
  ],
  motor: [
    { name: ['中国人保', 'PICC'], host: 'property.picc.com', url: 'https://property.picc.com/piccinternal/' },
    { name: ['平安保险', 'Ping An'], host: 'baoxian.pingan.com', url: 'https://baoxian.pingan.com/product/' },
    { name: ['太平洋保险', 'CPIC'], host: 'www.cpic.com.cn', url: 'https://www.cpic.com.cn/' },
  ],
  home: [
    { name: ['中国人保', 'PICC'], host: 'property.picc.com', url: 'https://property.picc.com/piccinternal/' },
    { name: ['太平洋保险', 'CPIC'], host: 'www.cpic.com.cn', url: 'https://www.cpic.com.cn/' },
    { name: ['平安保险', 'Ping An'], host: 'baoxian.pingan.com', url: 'https://baoxian.pingan.com/product/' },
  ],
  business: [
    { name: ['中国人保', 'PICC'], host: 'property.picc.com', url: 'https://property.picc.com/piccinternal/' },
    { name: ['太平洋保险', 'CPIC'], host: 'www.cpic.com.cn', url: 'https://www.cpic.com.cn/' },
    { name: ['平安保险', 'Ping An'], host: 'baoxian.pingan.com', url: 'https://baoxian.pingan.com/product/' },
  ],
  engineering: [
    { name: ['中国人保', 'PICC'], host: 'property.picc.com', url: 'https://property.picc.com/piccinternal/' },
    { name: ['太平洋保险', 'CPIC'], host: 'www.cpic.com.cn', url: 'https://www.cpic.com.cn/' },
    { name: ['平安保险', 'Ping An'], host: 'baoxian.pingan.com', url: 'https://baoxian.pingan.com/product/' },
  ],
  agriculture: [
    { name: ['中国人保', 'PICC'], host: 'property.picc.com', url: 'https://property.picc.com/piccinternal/' },
    { name: ['太平洋保险', 'CPIC'], host: 'www.cpic.com.cn', url: 'https://www.cpic.com.cn/' },
    { name: ['中华联合保险', 'China United'], host: 'www.chinaco.com.cn', url: 'https://www.chinaco.com.cn/' },
  ],
};
export function trustedOutboundUrl(url: string): boolean {
  if (!url.startsWith('https:')) return false;
  return sources.some(source => source.url === url) || Object.values(groupInsurers).some(refs => refs.some(ref => ref.url === url));
}
export function findInsurance(query: string, group = 'all', regClass: RegClass | 'all' = 'all', formTag: FormTag | 'all' = 'all') {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return insuranceTypes.filter(item => (group === 'all' || item.group === group) && (regClass === 'all' || item.regClass === regClass) && (formTag === 'all' || item.formTag === formTag) && terms.every(term => [...item.title, ...item.coverage, item.caution, ...groups.find(g => g.id === item.group)!.title, ...regClasses[item.regClass], ...regSubLabels[item.regSub]].join(' ').toLowerCase().includes(term)));
}
