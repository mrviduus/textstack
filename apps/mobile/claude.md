> TextStack mobile app. Based on [Obytes React Native Template](https://github.com/obytes/react-native-template-obytes).

## Stack

- Expo SDK 54 + React Native 0.81.5
- TypeScript, Expo Router 6 (file-based routing)
- TailwindCSS via Uniwind/NativeWind
- Zustand (state), React Query (server state), MMKV (storage)
- i18next (en/uk), Axios (API client)

## Structure

```
src/
├── app/              # Expo Router routes
├── features/         # Feature modules (auth, feed/books, settings)
├── components/ui/    # UI components
├── lib/              # Utilities (api, auth, i18n, storage)
├── translations/     # en.json, uk.json
└── global.css        # TailwindCSS config
```

## Commands

```bash
pnpm start              # Dev server
pnpm ios / android      # Run on platform
pnpm lint               # ESLint
pnpm type-check         # TypeScript
pnpm test               # Jest tests
```

## API

- Base URL: `EXPO_PUBLIC_API_URL` (default: `http://localhost:8080` for dev, `https://textstack.app/api` for prod)
- Language-prefixed routes: `/{lang}/books`, `/{lang}/search`
- Auth: Google Sign-In → `POST /auth/google` (TODO: wire up expo-auth-session)
- Types in `src/lib/api/types.ts` mirror `apps/web/src/types/api.ts`

## Patterns

- Absolute imports: `@/components/ui/button`
- Feature-based structure: `src/features/[name]/`
- Data fetching: React Query hooks via `react-query-kit`
- MMKV for token storage, not AsyncStorage
