/** Public aliases generated from contracts/openapi.json; run npm run api:generate after changing it. */
import type { components } from './generated';
export type { paths, operations } from './generated';
export type ThemeName = components['schemas']['ThemeName'];
export type Locale = components['schemas']['Locale'];
export type AvatarName = components['schemas']['AvatarName'];
export type User = components['schemas']['User'];
export type AuthResponse = components['schemas']['AuthResponse'];
export type ProfilePatch = components['schemas']['ProfilePatch'];
export type Recipient = components['schemas']['Recipient'];
export type Wallet = components['schemas']['Wallet'];
export type LedgerTransaction = components['schemas']['LedgerTransaction'];
export type TransferRequest = components['schemas']['TransferRequest'];
export type TransferResponse = components['schemas']['TransferResponse'];
export type ApiErrorBody = components['schemas']['ApiErrorBody'];
export const DEMO_ACCOUNTS = [
  { handle: 'kai', password: 'Qdemo12345!', display_name: 'Kai' },
  { handle: 'lin', password: 'Qdemo12345!', display_name: '小林' },
] as const;
