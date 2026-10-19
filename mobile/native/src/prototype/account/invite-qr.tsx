import { useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import makeQr from 'qrcode-generator';
import { useDesign } from '../design';

/** Render only an explicit public app invitation; never encode session or private data. */
export function InviteQr({ handle }: { handle: string }) {
  const { text } = useDesign();
  const qr = useMemo(() => {
    if (!/^[a-z0-9_]{3,24}$/.test(handle)) return null;
    const code = makeQr(0, 'M');
    code.addData('xiaoq://social/add?handle=' + encodeURIComponent(handle));
    code.make();
    const count = code.getModuleCount();
    const paths: string[] = [];
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (code.isDark(row, col)) paths.push('M' + (col + 4) + ',' + (row + 4) + 'h1v1h-1z');
      }
    }
    return { size: count + 8, path: paths.join('') };
  }, [handle]);
  if (!qr) return null;
  return <View style={{ alignSelf: 'flex-start', maxWidth: '100%' }} accessibilityRole="image"
    accessibilityLabel={text(`添加 @${handle} 为好友的二维码`, `QR code to add @${handle} as a friend`)}>
    <Svg width={184} height={184} viewBox={`0 0 ${qr.size} ${qr.size}`}
      {...(process.env.EXPO_OS === 'web' ? { 'aria-hidden': true } : { accessibilityElementsHidden: true })}>
      <Rect x={0} y={0} width={qr.size} height={qr.size} fill="#FFFFFF" />
      <Path d={qr.path} fill="#000000" />
    </Svg>
  </View>;
}
