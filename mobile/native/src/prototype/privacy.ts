import { Linking } from 'react-native';

export const PRIVACY_POLICY_URL = 'https://q.kaicloudpay.com/privacy';
export const SUPPORT_EMAIL = 'xzy070212@qq.com';

export const openPrivacyPolicy = () => Linking.openURL(PRIVACY_POLICY_URL);
export const openSupportEmail = () => Linking.openURL(`mailto:${SUPPORT_EMAIL}`);
