import type { ConfigContext } from 'expo/config';
import { assertStoreApiConfig } from './scripts/store-config.mjs';

export default function appConfig({ config }: ConfigContext) {
  assertStoreApiConfig(process.env);
  return config;
}
