import type { ThemeName } from '@xiaoq/shared';

export interface Palette {
  background: string; sidebar: string; surface: string; subtle: string; line: string;
  text: string; muted: string; soft: string; accent: string; accentSoft: string;
  inverse: string; success: string; successSoft: string; danger: string; dangerSoft: string;
  wallet: string; walletText: string; walletMuted: string;
}
export const palettes: Record<ThemeName, Palette> = {
  warm: { background: '#F6F4EF', sidebar: '#ECEAE3', surface: '#FFFEFB', subtle: '#F0EEE8', line: '#DEDCD3', text: '#252821', muted: '#73766B', soft: '#96998E', accent: '#B05B3C', accentSoft: '#F4E5DA', inverse: '#FFFFFF', success: '#4F6A4B', successSoft: '#E7EEE1', danger: '#AC4437', dangerSoft: '#FAE9E3', wallet: '#343D2F', walletText: '#F6F4E9', walletMuted: '#BAC4AE' },
  light: { background: '#F9F9F9', sidebar: '#F0F0F0', surface: '#FFFFFF', subtle: '#F3F3F3', line: '#E2E2E2', text: '#202020', muted: '#707070', soft: '#949494', accent: '#242424', accentSoft: '#E9E9E9', inverse: '#FFFFFF', success: '#397453', successSoft: '#E8F3EC', danger: '#B33F37', dangerSoft: '#FCECE9', wallet: '#242424', walletText: '#FFFFFF', walletMuted: '#BCBCBC' },
  dark: { background: '#151615', sidebar: '#1C1E1B', surface: '#20231F', subtle: '#292D27', line: '#353A32', text: '#F1F2EC', muted: '#ADB2A5', soft: '#828A7B', accent: '#E2AD88', accentSoft: '#3D3026', inverse: '#252821', success: '#B3CE9D', successSoft: '#2A3A25', danger: '#FFA99C', dangerSoft: '#462B27', wallet: '#D4DEC8', walletText: '#283323', walletMuted: '#56664B' },
};
