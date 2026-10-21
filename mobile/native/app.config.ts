import type { ConfigContext } from 'expo/config';
import { resolveBuildVariant } from './scripts/store-config.mjs';

export default function appConfig({ config }: ConfigContext) {
  const variant = resolveBuildVariant(process.env, {
    iosBundleIdentifier: config.ios?.bundleIdentifier,
    androidPackage: config.android?.package,
  });
  return {
    ...config,
    plugins: [...(config.plugins ?? []), './scripts/with-native-api-guard.cjs'],
    ...(variant.localTest ? {
      name: '小Q 本地测试',
      scheme: 'xiaoq-localtest',
      ios: { ...config.ios, bundleIdentifier: variant.iosBundleIdentifier },
      android: { ...config.android, package: variant.androidPackage },
    } : {}),
    extra: {
      ...config.extra,
      apiEnvironment: variant.apiEnvironment,
      ...(variant.configuredApiOrigin ? { configuredApiOrigin: variant.configuredApiOrigin } : {}),
    },
  };
}
