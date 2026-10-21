import { Image, View, type ImageSourcePropType } from 'react-native';
import { CreditCard } from 'lucide-react-native';
import { Type, useDesign } from '../design';
import { getBank } from './catalog';

/** Public product reference imagery, never photos of a customer's actual card. Sources: docs/bank-plugins.md. */
const art: Record<string, ImageSourcePropType> = {
  hsbc: require('../../../assets/bank-cards/hsbc.jpg'),
  citic: require('../../../assets/bank-cards/citic.png'),
  bocom: require('../../../assets/bank-cards/bocom.jpg'),
  bochk: require('../../../assets/bank-cards/bochk.png'),
  za: require('../../../assets/bank-cards/za.png'),
  icbc: require('../../../assets/bank-cards/icbc.png'),
  ccb: require('../../../assets/bank-cards/ccb.jpg'),
  dahsing: require('../../../assets/bank-cards/dahsing.jpg'),
  cmbwinglung: require('../../../assets/bank-cards/cmbwinglung.jpg'),
  shacombank: require('../../../assets/bank-cards/shacombank.jpg'),
};
// Native viewport framing keeps the unmodified public source image in the repository.
const framed: Record<string, { source: ImageSourcePropType; width: number; height: number; x: number; y: number; w: number; h: number }> = {
  ncb: { source: require('../../../assets/bank-cards/ncb.png'), width: 1072, height: 674, x: 24, y: 32, w: 672, h: 612 },
  mox: { source: require('../../../assets/bank-cards/mox-reference.jpg'), width: 1800, height: 1803, x: 562, y: 274, w: 618, h: 389 },
  livi: { source: require('../../../assets/bank-cards/livi-reference.jpg'), width: 1223, height: 688, x: 151, y: 364, w: 196, h: 124 },
  citi: { source: require('../../../assets/bank-cards/citi-reference.jpg'), width: 721, height: 213, x: 35, y: 39, w: 218, h: 138 },
  bea: { source: require('../../../assets/bank-cards/bea-reference.jpg'), width: 2480, height: 640, x: 151, y: 74, w: 312, h: 493 },
  hangseng: { source: require('../../../assets/bank-cards/hangseng-reference.jpg'), width: 3840, height: 800, x: 2277, y: 275, w: 292, h: 457 },
  scb: { source: require('../../../assets/bank-cards/scb-reference.png'), width: 1600, height: 490, x: 829, y: 193, w: 263, h: 164 },
  dbs: { source: require('../../../assets/bank-cards/dbs-reference.jpg'), width: 2808, height: 1260, x: 1907, y: 463, w: 183, h: 289 },
};
export function BankCardArt({ bankId, compact = false }: { bankId: string; compact?: boolean }) {
  const { colors, text } = useDesign();
  const bank = getBank(bankId), source = art[bankId];
  const frame = framed[bankId];
  if (frame) {
    const scale = Math.min((compact ? 48 : 160) / frame.h, (compact ? 80 : 210) / frame.w);
    return <View style={{ height: compact ? 48 : 172, alignItems: 'center', justifyContent: 'center' }}><View style={{ width: frame.w * scale, height: frame.h * scale, overflow: 'hidden', borderRadius: 7 }}><Image source={frame.source} accessibilityLabel={text(`${bank.zh}公开产品卡面参考图，非实际绑定银行卡`, `${bank.en} public card reference, not a linked real card`)} resizeMode="stretch" style={{ position: 'absolute', width: frame.width * scale, height: frame.height * scale, left: -frame.x * scale, top: -frame.y * scale }} /></View></View>;
  }
  if (source) return <Image source={source} accessibilityLabel={text(`${bank.zh}公开产品卡面参考图，非实际绑定银行卡`, `${bank.en} public product reference, not a linked real card`)} resizeMode="contain" style={{ width: '100%', height: compact ? 48 : 172 }} />;
  return <View accessible accessibilityLabel={text(`${bank.zh}模拟数字账户卡面`, `${bank.en} simulated digital account card`)} style={{ width: '100%', minHeight: compact ? 48 : 155, borderRadius: compact ? 8 : 15, backgroundColor: colors.soft, borderWidth: 1, borderColor: colors.line, borderTopWidth: 4, borderTopColor: bank.color, padding: compact ? 8 : 18, justifyContent: 'space-between', gap: 14 }}>
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}><Type size={compact ? 11 : 17} weight="600">{compact ? bank.short : text(bank.zh, bank.en)}</Type>{!compact ? <CreditCard size={25} color={colors.muted} strokeWidth={1.2} /> : null}</View>
    {!compact ? <><Type size={12} muted>Q · HKD</Type><Type size={11} muted>{text('模拟数字账户', 'SIMULATED DIGITAL ACCOUNT')}</Type></> : null}
  </View>;
}
export const hasBankCardImage = (bankId: string) => !!art[bankId] || !!framed[bankId];
