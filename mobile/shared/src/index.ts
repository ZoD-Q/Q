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
export type VideoConnection = components['schemas']['VideoConnection'];
export type VideoConnectionRequest = components['schemas']['VideoConnectionRequest'];
export type VideoConnectionList = components['schemas']['VideoConnectionList'];
export type VideoJob = components['schemas']['VideoJob'];
export type VideoJobRequest = components['schemas']['VideoJobRequest'];
export type VideoJobList = components['schemas']['VideoJobList'];
export type AiModel = components['schemas']['AiModel'];
export type AiModelInfo = components['schemas']['AiModelInfo'];
export type AiStatus = components['schemas']['AiStatus'];
export type AiHistoryMessage = components['schemas']['AiHistoryMessage'];
export type AiChatRequest = components['schemas']['AiChatRequest'];
export type AiUsage = components['schemas']['AiUsage'];
export type AiFinishReason = components['schemas']['AiFinishReason'];
export type AiDone = components['schemas']['AiDone'];
export type PluginStatus = components['schemas']['PluginStatus'];
export type PluginConnection = components['schemas']['PluginConnection'];
export type PluginTool = components['schemas']['PluginTool'];
export type PluginInvocation = components['schemas']['PluginInvocation'];
export type PluginToolProposal = components['schemas']['PluginToolProposal'];
export type PluginDiscovery = components['schemas']['PluginDiscovery'];
