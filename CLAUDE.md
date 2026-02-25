# X5 Marketing Expo — AI Instructions

## Project Overview
Expo React Native wrapper for X5 Marketing web app. Loads web UI in WebView, handles native auth (Apple, Google, Email), push notifications, and payments via RevenueCat.

## Two Projects
- **This project** (Expo): `d:\X\Adilkhan\x5-marketing-expo`
- **Web app**: `d:\X\Adilkhan\x5-marketing111\web` (React + Vite + Supabase)
- Both use Supabase (migrated from Firebase, Feb 2026)

## WebView Bridge
- Expo → Web: `injectJavaScript()` sets globals and dispatches CustomEvents
- Web → Expo: `ReactNativeWebView.postMessage(JSON.stringify({type, payload}))`
- Message types: `WEB_READY`, `LOGIN_APPLE`, `LOGIN_GOOGLE`, `LOGIN_EMAIL`, `PAYMENT_REQUEST`
- Auth result events: `nativeAuthResult`, `appleSignInResult`

## Testing
- Apple Sign-In is UNRELIABLE in Expo Go (known limitation). For reliable testing, use EAS dev build.
- For dev testing, start Vite in web project: `cd d:\X\Adilkhan\x5-marketing111\web && npm run dev`
- The `WEB_URL` in `src/app/index.tsx` uses local dev server in `__DEV__` mode

## Supabase
- Project ref: `afwznqjpshybmqhlewmy`
- Management API token stored in MEMORY.md
- Apple provider client_id: `host.exp.Exponent` (for Expo Go)

## Conventions
- Language with user: Russian
- Don't ask repeatedly — save credentials to memory files
- Prefer direct action over confirmation dialogs
