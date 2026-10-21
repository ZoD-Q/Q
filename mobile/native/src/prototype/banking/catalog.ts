/** Display-only bank identities. Server-owned demo plugins do not connect to real banks. */
export type DemoBank = Readonly<{
  id: string;
  zh: string;
  en: string;
  short: string;
  color: string;
  aliases: readonly string[];
}>;

export const BANKS: readonly DemoBank[] = [
  { id: 'hsbc', zh: '汇丰银行', en: 'HSBC Hong Kong', short: 'HS', color: '#C52535', aliases: ['汇丰', '滙豐', '匯豐', 'hsbc'] },
  { id: 'hangseng', zh: '恒生银行', en: 'Hang Seng Bank', short: '恒', color: '#187B54', aliases: ['恒生', '恆生', 'hang seng', 'hangseng'] },
  { id: 'bochk', zh: '中银香港', en: 'Bank of China (Hong Kong)', short: '中', color: '#B92D3D', aliases: ['中银香港', '中銀香港', '中国银行', '中國銀行', '中银', '中銀', 'bochk', 'bank of china'] },
  { id: 'scb', zh: '渣打银行', en: 'Standard Chartered Hong Kong', short: 'SC', color: '#167B87', aliases: ['渣打', 'standard chartered', 'scb'] },
  { id: 'bea', zh: '东亚银行', en: 'Bank of East Asia', short: '东', color: '#BE3147', aliases: ['东亚', '東亞', 'bank of east asia', 'bea'] },
  { id: 'dbs', zh: '星展银行（香港）', en: 'DBS Bank (Hong Kong)', short: 'DB', color: '#B72C38', aliases: ['星展', 'dbs'] },
  { id: 'citi', zh: '花旗银行（香港）', en: 'Citibank (Hong Kong)', short: 'Ci', color: '#25559D', aliases: ['花旗', 'citibank', 'citi'] },
  { id: 'icbc', zh: '工银亚洲', en: 'ICBC (Asia)', short: '工', color: '#BA3140', aliases: ['工银亚洲', '工銀亞洲', '工商银行', '工商銀行', '工行', '工银', '工銀', 'icbc'] },
  { id: 'ccb', zh: '建行亚洲', en: 'China Construction Bank (Asia)', short: '建', color: '#245D99', aliases: ['建行亚洲', '建行亞洲', '建设银行', '建設銀行', '建行', 'ccb', 'china construction bank'] },
  { id: 'ncb', zh: '南洋商业银行', en: 'Nanyang Commercial Bank', short: '南', color: '#A33243', aliases: ['南洋商业', '南洋商業', '南商', 'nanyang commercial', 'ncb'] },
  { id: 'citic', zh: '中信银行（国际）', en: 'China CITIC Bank International', short: '信', color: '#AE3444', aliases: ['中信国际', '中信國際', '中信银行', '中信銀行', '中信', 'citic'] },
  { id: 'cmbwinglung', zh: '招商永隆银行', en: 'CMB Wing Lung Bank', short: '永', color: '#B33943', aliases: ['招商永隆', '永隆', 'cmb wing lung', 'wing lung'] },
  { id: 'dahsing', zh: '大新银行', en: 'Dah Sing Bank', short: '大', color: '#2E628D', aliases: ['大新', 'dah sing', 'dahsing'] },
  { id: 'fubon', zh: '富邦银行（香港）', en: 'Fubon Bank (Hong Kong)', short: '富', color: '#2580A4', aliases: ['富邦', 'fubon'] },
  { id: 'chiyu', zh: '集友银行', en: 'Chiyu Banking Corporation', short: '集', color: '#A86E24', aliases: ['集友', 'chiyu'] },
  { id: 'shacombank', zh: '上海商业银行', en: 'Shanghai Commercial Bank', short: '上', color: '#9B3B4A', aliases: ['上海商业', '上海商業', '上海商行', 'shanghai commercial', 'shacombank'] },
  { id: 'bocom', zh: '交通银行（香港）', en: 'Bank of Communications (Hong Kong)', short: '交', color: '#2E5CA2', aliases: ['交通银行', '交通銀行', '交行', 'bocom', 'bank of communications'] },
  { id: 'za', zh: '众安银行', en: 'ZA Bank', short: 'ZA', color: '#668C28', aliases: ['众安', '眾安', 'za bank', 'za'] },
  { id: 'mox', zh: 'Mox Bank', en: 'Mox Bank', short: 'Mx', color: '#7852A4', aliases: ['mox bank', 'mox'] },
  { id: 'livi', zh: '理慧银行', en: 'livi bank', short: 'li', color: '#21827D', aliases: ['理慧', 'livi bank', 'livi'] },
];

export function getBank(id: string): DemoBank {
  const bank = BANKS.find(item => item.id === id);
  if (!bank) throw new Error('INVALID_BANK');
  return bank;
}
