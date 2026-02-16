# TestFlight Sandbox IAP Checklist

## 1) Secrets (EAS project/env)
- EXPO_PUBLIC_REVENUECAT_IOS_KEY
- EXPO_PUBLIC_SUPABASE_URL
- EXPO_PUBLIC_SUPABASE_ANON_KEY
- EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID
- EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID

## 2) App Store Connect
- Product IDs exist: x5_pro_monthly, x5_pro_yearly, x5_credits_1000
- In-app purchase metadata is complete and in "Ready to Submit" or approved state
- Sandbox test users are created

## 3) RevenueCat
- Same product IDs attached to offerings/packages
- Entitlement `pro` mapped to monthly/yearly products
- App user mapping uses Supabase user id (Purchases.logIn)

## 4) Build + Submit
- Build: npm run build:ios:testflight
- Submit: npm run submit:ios:testflight

## 5) E2E Validation in TestFlight
- Purchase monthly/yearly/credits succeeds
- Cancel flow does not mutate plan/credits
- Restore purchases re-activates entitlement
- App restart keeps entitlement and user state
