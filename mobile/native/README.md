# 小Q native

Expo / React Native application for iOS and Android. Expo Web is a development preview; the future standalone web interface remains separate.

From the repository’s `mobile/` directory, install workspaces once, then run `npm run dev` for the standalone UI preview. `npm run dev:native` starts Expo Go development. These commands do not start or require the backend. The preserved Rust API can be started separately from `backend/` when API-dependent flows are being verified.

The default API URL is `http://127.0.0.1:8787` for web and iOS Simulator, and `http://10.0.2.2:8787` for Android Emulator. Set `EXPO_PUBLIC_API_URL` to the machine's LAN address for a physical device. Use HTTPS for any remote environment. Restart Metro after changing environment variables.

Native sessions use SecureStore; web preview sessions are memory-only and disappear on reload. Unresolved transfer intentions (sender ID, recipient, amount, note and idempotency key; never a token) are saved separately in SecureStore on native and localStorage on web. Signing back into the same account restores the original request for explicit review and safe retry. Confirmed successful results clear this recovery record. A first attempt rejected with an explicit non-posting business error may also clear it. Once an attempt is unknown or restored, only a successful confirmation (including an idempotent replay) clears it; authentication, rate-limit and conflict errors retain the original key. All balances are simulated QDC units. Demo login shortcuts only fill credentials; the backend must explicitly enable demo seeding.

Routes live in `src/app`, screen bodies in `src/screens`, API and session handling in `src/services`. Bilingual copy and theme tokens live in `src/i18n.ts` and `src/theme.ts`.

The sidebar draws structural inspiration from [Aceternity Sidebar](https://ui.aceternity.com/components/sidebar). This is an independent React Native implementation; no source or web-only dependencies were copied. Expo UI SDK 58 universal controls were assessed; core RN controls are used here to keep the custom three-theme interface consistent in the web preview and native runtimes.

Verification: `npm run typecheck -w @xiaoq/native`, `npm run lint -w @xiaoq/native`, `npm run test:utils -w @xiaoq/native`, `npm run export:web -w @xiaoq/native`.

`TEMPLATE-LICENSE` preserves the upstream Expo template's MIT notice for the template-derived material only. It does not assign an open-source license to the 小Q product or its original application code.
